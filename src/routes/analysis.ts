import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/client';
import { asyncRoute } from '../middleware/errorHandler';
import { validateQuery, validateBody, q } from '../middleware/validate';
import { ok, accepted } from './helpers';
import { conflict, notFound } from '../lib/errors';
import { parseJsonField } from '../db/client';
import { executeAnalysisRun } from '../services/pipeline';
import { harvestBoard, refreshStatsForFixture, sweepInjuries } from '../services/ingestion';
import { reconcileFixtures } from '../services/reconciler';
import { runBus } from '../services/sse';
import { logger } from '../lib/logger';
import type { LeagueId } from '../lib/types';

export const analysisRouter = Router();

const runSchema = z.object({
  league: z.enum(['NBA', 'WNBA']),
  window: z.enum(['12h', '24h', '48h']).default('24h'),
  fixtureId: z.string().optional(),
  skipScrape: z.boolean().default(false),
});

analysisRouter.post(
  '/analysis/run',
  validateBody(runSchema),
  asyncRoute(async (req, res) => {
    const body = req.body as z.infer<typeof runSchema>;
    const inFlight = await prisma.analysisRun.findFirst({
      where: { leagueId: body.league, status: 'RUNNING' },
    });
    if (inFlight) {
      throw conflict('RUN_IN_FLIGHT', `A run is already in flight for ${body.league} (${inFlight.id})`);
    }
    const windowHours = parseInt(body.window, 10);

    // Kick off asynchronously; the client polls Run detail or subscribes to SSE.
    const runPromise = executeAnalysisRun({
      leagueId: body.league as LeagueId,
      trigger: 'MANUAL',
      windowHours,
      fixtureId: body.fixtureId,
      skipScrape: body.skipScrape,
    });
    runPromise.catch((err) => logger.error({ err: String(err) }, 'background run rejected'));

    // Give the run a moment to create its row so we can return the id.
    const runId = await Promise.race([
      runPromise,
      new Promise<string | null>((resolve) => setTimeout(() => resolve(null), 400)),
    ]);
    const row = runId
      ? await prisma.analysisRun.findUnique({ where: { id: runId } })
      : await prisma.analysisRun.findFirst({ where: { leagueId: body.league }, orderBy: { startedAt: 'desc' } });

    accepted(req, res, {
      runId: row?.id ?? null,
      status: row?.status ?? 'RUNNING',
      league: body.league,
      window: body.window,
      pollUrl: row ? `/api/v1/analysis/runs/${row.id}` : null,
      streamUrl: row ? `/api/v1/stream/analysis/${row.id}` : null,
    });
  }),
);

const runsSchema = z.object({ league: z.string().optional(), limit: z.coerce.number().min(1).max(100).default(20) });

analysisRouter.get(
  '/analysis/runs',
  validateQuery(runsSchema),
  asyncRoute(async (req, res) => {
    const query = q<z.infer<typeof runsSchema>>(req);
    const runs = await prisma.analysisRun.findMany({
      where: query.league ? { leagueId: query.league } : {},
      orderBy: { startedAt: 'desc' },
      take: query.limit,
    });
    ok(
      req,
      res,
      runs.map((r) => ({ ...r, sourceErrors: parseJsonField(r.sourceErrors, [] as unknown[]) })),
    );
  }),
);

analysisRouter.get(
  '/analysis/runs/:id',
  asyncRoute(async (req, res) => {
    const run = await prisma.analysisRun.findUnique({ where: { id: req.params.id } });
    if (!run) throw notFound('RUN_NOT_FOUND', `No run ${req.params.id}`);
    const exclusions = await prisma.playerExclusion.groupBy({
      by: ['reason'],
      where: { runId: run.id },
      _count: { reason: true },
    });
    const tiers = await prisma.recommendation.groupBy({
      by: ['tier'],
      where: { runId: run.id },
      _count: { tier: true },
    });
    ok(req, res, {
      ...run,
      sourceErrors: parseJsonField(run.sourceErrors, [] as unknown[]),
      exclusionBreakdown: Object.fromEntries(exclusions.map((e) => [e.reason, e._count.reason])),
      tierBreakdown: Object.fromEntries(tiers.map((t) => [t.tier, t._count.tier])),
    });
  }),
);

const refreshSchema = z.object({
  source: z.enum(['BETANO', 'SOFASCORE', 'LEAGUE', 'ESPN']),
  scope: z.enum(['FIXTURES', 'LINES', 'STATS', 'INJURIES']),
  league: z.enum(['NBA', 'WNBA']).optional(),
  fixtureId: z.string().optional(),
});

analysisRouter.post(
  '/ingestion/refresh',
  validateBody(refreshSchema),
  asyncRoute(async (req, res) => {
    const body = req.body as z.infer<typeof refreshSchema>;
    let result: unknown;
    switch (body.scope) {
      case 'FIXTURES':
        result = await reconcileFixtures((body.league ?? 'WNBA') as LeagueId, 24);
        break;
      case 'LINES':
        if (!body.fixtureId) throw notFound('FIXTURE_REQUIRED', 'fixtureId is required for scope=LINES');
        result = await harvestBoard(body.fixtureId);
        break;
      case 'STATS':
        if (!body.fixtureId) throw notFound('FIXTURE_REQUIRED', 'fixtureId is required for scope=STATS');
        result = { playersRefreshed: await refreshStatsForFixture(body.fixtureId) };
        break;
      case 'INJURIES':
        result = { updates: await sweepInjuries((body.league ?? 'WNBA') as LeagueId) };
        break;
    }
    ok(req, res, { source: body.source, scope: body.scope, result });
  }),
);

/** SSE stream of pipeline progress (§9.11). */
analysisRouter.get('/stream/analysis/:runId', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`: connected to run ${req.params.runId}\n\n`);

  const unsubscribe = runBus.onRun(req.params.runId, (event) => {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`);
    if (event.type === 'complete' || event.type === 'error') res.end();
  });
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});
