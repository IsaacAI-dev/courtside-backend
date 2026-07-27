import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/client';
import { asyncRoute } from '../middleware/errorHandler';
import { validateQuery, validateBody, q } from '../middleware/validate';
import { ok } from './helpers';
import { notFound } from '../lib/errors';
import { env } from '../env';
import { MARKETS, SIDES } from '../lib/types';

export const recommendationsRouter = Router();

const listSchema = z.object({
  league: z.string().optional(),
  runId: z.string().optional(), // "latest" resolves to the newest completed run
  fixtureId: z.string().optional(),
  market: z.string().optional(),
  side: z.enum(SIDES).optional(),
  tier: z.string().optional(),
  status: z.string().default('ACTIVE'),
  minConfidence: z.coerce.number().min(0).max(100).optional(),
  sort: z.enum(['confidence', 'tipoff', 'line']).default('confidence'),
  order: z.enum(['asc', 'desc']).default('desc'),
  limit: z.coerce.number().min(1).max(500).default(200),
});

async function resolveRunId(leagueId: string | undefined, runId: string | undefined): Promise<string | undefined> {
  if (!runId || runId !== 'latest') return runId;
  const latest = await prisma.analysisRun.findFirst({
    where: { ...(leagueId ? { leagueId } : {}), status: { in: ['COMPLETED', 'DEGRADED'] } },
    orderBy: { startedAt: 'desc' },
    select: { id: true },
  });
  return latest?.id;
}

const shapeRec = (r: any) => ({
  id: r.id,
  runId: r.runId,
  tier: r.tier,
  confidence: r.confidence,
  market: r.market,
  side: r.side,
  recommendedLine: r.recommendedLine,
  offeredOdds: r.offeredOdds,
  selectionMode: r.selectionMode,
  status: r.status,
  voidReason: r.voidReason,
  scoringVersion: r.scoringVersion,
  player: {
    id: r.player.id,
    fullName: r.player.fullName,
    position: r.player.position,
    headshotUrl: r.player.headshotUrl,
    team: r.player.team ? { abbreviation: r.player.team.abbreviation, name: r.player.team.name } : null,
  },
  fixture: {
    id: r.fixture.id,
    startsAt: r.fixture.startsAt,
    matchup: `${r.fixture.awayTeam.abbreviation} @ ${r.fixture.homeTeam.abbreviation}`,
    homeTeam: r.fixture.homeTeam.abbreviation,
    awayTeam: r.fixture.awayTeam.abbreviation,
  },
  betano: { minLine: r.betanoMinLine, maxLine: r.betanoMaxLine, ladder: [r.betanoMinLine, r.betanoMaxLine] },
  form: {
    meanWeighted: r.meanWeighted,
    meanSimple: r.meanSimple,
    stdDev: r.stdDev,
    hitsL5: r.hitsL5,
    gamesL5: r.gamesL5,
    pushesL5: r.pushesL5,
    hitsL10: r.hitsL10,
    gamesL10: r.gamesL10,
    hitRateL5: r.hitRateL5,
    hitRateL10: r.hitRateL10,
    seasonMean: r.seasonMean,
  },
  createdAt: r.createdAt,
});

const include = {
  player: { include: { team: true } },
  fixture: { include: { homeTeam: true, awayTeam: true } },
};

recommendationsRouter.get(
  '/recommendations',
  validateQuery(listSchema),
  asyncRoute(async (req, res) => {
    const query = q<z.infer<typeof listSchema>>(req);
    const runId = await resolveRunId(query.league, query.runId);
    const recs = await prisma.recommendation.findMany({
      where: {
        ...(runId ? { runId } : {}),
        ...(query.fixtureId ? { fixtureId: query.fixtureId } : {}),
        ...(query.market ? { market: { in: query.market.split(',') } } : {}),
        ...(query.side ? { side: query.side } : {}),
        ...(query.tier ? { tier: { in: query.tier.split(',') } } : {}),
        ...(query.status ? { status: { in: query.status.split(',') } } : {}),
        ...(query.minConfidence != null ? { confidence: { gte: query.minConfidence } } : {}),
        ...(query.league ? { fixture: { leagueId: query.league } } : {}),
      },
      include,
      take: query.limit,
      orderBy:
        query.sort === 'confidence'
          ? { confidence: query.order }
          : query.sort === 'line'
            ? { recommendedLine: query.order }
            : { fixture: { startsAt: query.order } },
    });
    ok(req, res, recs.map(shapeRec), { count: recs.length, runId: runId ?? null });
  }),
);

/** Convenience endpoint the dashboard calls on load (§9.9): latest run, tiers A+B. */
recommendationsRouter.get(
  '/recommendations/board',
  validateQuery(z.object({ league: z.string().optional(), tier: z.string().default('A,B') })),
  asyncRoute(async (req, res) => {
    const query = q<{ league?: string; tier: string }>(req);
    const runId = await resolveRunId(query.league, 'latest');
    if (!runId) {
      ok(req, res, [], { runId: null, note: 'no completed run yet' });
      return;
    }
    const recs = await prisma.recommendation.findMany({
      where: {
        runId,
        status: 'ACTIVE',
        side: env.DISPLAY_SIDE_DEFAULT,
        tier: { in: query.tier.split(',') },
      },
      include,
      orderBy: [{ fixture: { startsAt: 'asc' } }, { confidence: 'desc' }],
    });
    ok(req, res, recs.map(shapeRec), { runId, count: recs.length, displaySide: env.DISPLAY_SIDE_DEFAULT });
  }),
);

recommendationsRouter.get(
  '/recommendations/:id',
  asyncRoute(async (req, res) => {
    const rec = await prisma.recommendation.findUnique({
      where: { id: req.params.id },
      include: { ...include, factors: true, result: true, run: { select: { id: true, startedAt: true, trigger: true } } },
    });
    if (!rec) throw notFound('RECOMMENDATION_NOT_FOUND', `No recommendation ${req.params.id}`);

    const lines = await prisma.propLine.findMany({
      where: { fixtureId: rec.fixtureId, playerId: rec.playerId, market: rec.market },
      orderBy: { capturedAt: 'desc' },
      take: 50,
    });

    ok(req, res, {
      ...shapeRec(rec),
      factors: rec.factors.filter((f) => f.kind === 'FACTOR'),
      multipliers: rec.factors.filter((f) => f.kind === 'MULTIPLIER'),
      caps: rec.factors.filter((f) => f.kind === 'CAP'),
      settlement: rec.result,
      run: rec.run,
      lineHistory: lines.map((l) => ({ line: l.line, overOdds: l.overOdds, underOdds: l.underOdds, capturedAt: l.capturedAt })),
    });
  }),
);

const voidSchema = z.object({ reason: z.string().min(1), detail: z.string().optional() });

/** Manual retraction (§11.3.4). The row survives — the UI shows voids, never silently drops cards. */
recommendationsRouter.post(
  '/recommendations/:id/void',
  validateBody(voidSchema),
  asyncRoute(async (req, res) => {
    const body = req.body as z.infer<typeof voidSchema>;
    const status = body.reason.startsWith('VOIDED_') ? body.reason : 'VOIDED_LATE_SCRATCH';
    const updated = await prisma.recommendation.update({
      where: { id: req.params.id },
      data: { status, voidReason: body.detail ?? body.reason },
    });
    ok(req, res, updated);
  }),
);
