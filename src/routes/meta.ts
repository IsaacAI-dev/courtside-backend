import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/client';
import { asyncRoute } from '../middleware/errorHandler';
import { validateBody } from '../middleware/validate';
import { getStaticSofaTournamentId } from '../adapters/sofascore';
import { ok } from './helpers';
import { sourceHealthReport } from '../services/sourceHealth';
import { getScoringConfig, updateScoringConfig, snapshotScoringVersion } from '../services/scoringConfig';

export const metaRouter = Router();

// GET /health — no auth (spec §9.2)
metaRouter.get(
  '/health',
  asyncRoute(async (req, res) => {
    let database = 'error';
    try {
      await prisma.$queryRawUnsafe('SELECT 1');
      database = 'ok';
    } catch {
      database = 'error';
    }
    ok(req, res, {
      status: database === 'ok' ? 'ok' : 'degraded',
      database,
      uptimeSeconds: Math.round(process.uptime()),
      version: '1.0.0',
      now: new Date().toISOString(),
    });
  }),
);

// GET /leagues
metaRouter.get(
  '/leagues',
  asyncRoute(async (req, res) => {
    const leagues = await prisma.leagueConfig.findMany({ orderBy: { id: 'asc' } });
    const withRuns = await Promise.all(
      leagues.map(async (l) => {
        const lastRun = await prisma.analysisRun.findFirst({
          where: { leagueId: l.id, status: { in: ['COMPLETED', 'DEGRADED'] } },
          orderBy: { startedAt: 'desc' },
          select: { id: true, startedAt: true, status: true, recommendationsEmitted: true },
        });
        const teamCount = await prisma.team.count({ where: { leagueId: l.id } });
        // Reported from static config (§5.3.4), not the DB column — nothing
        // writes sofaTournamentId anymore since reconciliation reads it
        // directly, and a stale/null DB value would be misleading here.
        let sofaTournamentId: number | null = null;
        try {
          sofaTournamentId = getStaticSofaTournamentId(l.id as 'NBA' | 'WNBA');
        } catch {
          /* not configured for this league — reported as null below */
        }
        return {
          id: l.id,
          displayName: l.displayName,
          currentSeason: l.currentSeason,
          isActive: l.isActive,
          teamCount,
          sofaTournamentId,
          lastSuccessfulRun: lastRun,
        };
      }),
    );
    ok(req, res, withRuns);
  }),
);

// GET /sources/health
metaRouter.get(
  '/sources/health',
  asyncRoute(async (req, res) => {
    const report = await sourceHealthReport();
    ok(
      req,
      res,
      report.map((r) => ({ ...r, shapeChanged: r.shapeDriftDetected })),
    );
  }),
);

// GET /config/scoring
metaRouter.get(
  '/config/scoring',
  asyncRoute(async (req, res) => {
    ok(req, res, getScoringConfig());
  }),
);

const patchSchema = z.object({
  weights: z
    .object({
      hitrate: z.number().min(0).max(1),
      cushion: z.number().min(0).max(1),
      consistency: z.number().min(0).max(1),
      minutes: z.number().min(0).max(1),
      matchup: z.number().min(0).max(1),
    })
    .partial()
    .optional(),
  tiers: z.object({ A: z.number(), B: z.number(), C: z.number() }).partial().optional(),
  multipliers: z.record(z.number()).optional(),
});

// PATCH /config/scoring — bumps the version; released versions are never edited in place.
metaRouter.patch(
  '/config/scoring',
  validateBody(patchSchema),
  asyncRoute(async (req, res) => {
    const next = updateScoringConfig(req.body as never);
    await snapshotScoringVersion();
    ok(req, res, next);
  }),
);
