import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/client';
import { asyncRoute } from '../middleware/errorHandler';
import { validateQuery, validateBody, q } from '../middleware/validate';
import { ok } from './helpers';
import { settleFixture } from '../services/settlement';
import { backtestByTier, calibrationTable } from '../services/backtest';
import { HOUR_MS } from '../lib/dates';

export const settlementRouter = Router();

const runSchema = z.object({
  league: z.enum(['NBA', 'WNBA']).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  fixtureId: z.string().optional(),
});

settlementRouter.post(
  '/settlement/run',
  validateBody(runSchema),
  asyncRoute(async (req, res) => {
    const body = req.body as z.infer<typeof runSchema>;
    const start = body.date ? new Date(`${body.date}T00:00:00.000Z`) : new Date(Date.now() - 24 * HOUR_MS);
    const end = new Date(start.getTime() + 24 * HOUR_MS);
    const fixtures = body.fixtureId
      ? await prisma.fixture.findMany({ where: { id: body.fixtureId } })
      : await prisma.fixture.findMany({
          where: {
            ...(body.league ? { leagueId: body.league } : {}),
            startsAt: { gte: start, lte: end },
            status: { in: ['SCHEDULED', 'LIVE', 'FINAL'] },
          },
        });

    const results = [];
    for (const fixture of fixtures) {
      try {
        results.push({ fixtureId: fixture.id, ...(await settleFixture(fixture.id)) });
      } catch (err) {
        results.push({ fixtureId: fixture.id, settled: 0, skipped: 0, error: String(err) });
      }
    }
    ok(req, res, {
      fixtures: results,
      totalSettled: results.reduce((a, r) => a + (r.settled ?? 0), 0),
    });
  }),
);

const backtestSchema = z.object({
  league: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  groupBy: z.enum(['tier']).default('tier'),
});

settlementRouter.get(
  '/backtest',
  validateQuery(backtestSchema),
  asyncRoute(async (req, res) => {
    const query = q<z.infer<typeof backtestSchema>>(req);
    const groups = await backtestByTier(query.league);
    ok(req, res, {
      groups: groups.map((g) => ({
        key: g.tier,
        n: g.n,
        wins: g.wins,
        losses: g.losses,
        pushes: g.pushes,
        voids: g.voids,
        strikeRate: g.strikeRate,
        avgOdds: g.avgOdds,
        breakEvenRate: g.breakEvenRate,
        roi: g.roiVisible ? g.roi : null,
        roiSuppressed: !g.roiVisible,
      })),
      note: 'ROI is withheld below n=50 decided bets — small-sample ROI is noise with a percentage sign (§14.4).',
    });
  }),
);

settlementRouter.get(
  '/backtest/calibration',
  validateQuery(z.object({ league: z.string().optional(), bucketSize: z.coerce.number().default(5) })),
  asyncRoute(async (req, res) => {
    const query = q<{ league?: string }>(req);
    const table = await calibrationTable(query.league);
    ok(req, res, {
      buckets: table.buckets.map((b) => ({
        label: b.bucket,
        n: b.n,
        predicted: b.impliedByConfidence,
        observed: b.actualStrikeRate,
      })),
      brier: table.brier,
      note: 'The ideal is the diagonal. A curve sagging below it is systematic overconfidence (§14.3).',
    });
  }),
);
