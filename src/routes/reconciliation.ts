import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/client';
import { asyncRoute } from '../middleware/errorHandler';
import { validateQuery, q } from '../middleware/validate';
import { ok } from './helpers';
import { HOUR_MS } from '../lib/dates';

export const reconciliationRouter = Router();

const schema = z.object({ league: z.string().optional(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

reconciliationRouter.get(
  '/reconciliation',
  validateQuery(schema),
  asyncRoute(async (req, res) => {
    const query = q<z.infer<typeof schema>>(req);
    const start = query.date ? new Date(`${query.date}T00:00:00.000Z`) : new Date();
    const end = new Date(start.getTime() + 48 * HOUR_MS);
    const fixtures = await prisma.fixture.findMany({
      where: { ...(query.league ? { leagueId: query.league } : {}), startsAt: { gte: start, lte: end } },
      include: { homeTeam: true, awayTeam: true, sourceLinks: true },
      orderBy: { startsAt: 'asc' },
    });

    const shape = (f: (typeof fixtures)[number]) => ({
      id: f.id,
      matchup: `${f.awayTeam.abbreviation} @ ${f.homeTeam.abbreviation}`,
      startsAt: f.startsAt,
      reconciliationStatus: f.reconciliationStatus,
      timeDeltaMinutes: f.timeDeltaMinutes,
      sources: f.sourceLinks.map((l) => l.source),
    });

    ok(req, res, {
      matched: fixtures.filter((f) => f.reconciliationStatus === 'MATCHED').map(shape),
      fuzzy: fixtures.filter((f) => f.reconciliationStatus === 'FUZZY').map(shape),
      unmatchedBetanoOnly: fixtures.filter((f) => f.reconciliationStatus === 'UNMATCHED_BETANO_ONLY').map(shape),
      unmatchedSofascoreOnly: fixtures.filter((f) => f.reconciliationStatus === 'UNMATCHED_SOFASCORE_ONLY').map(shape),
      timeDiscrepancies: fixtures.filter((f) => f.reconciliationStatus === 'TIME_DISCREPANCY').map(shape),
    });
  }),
);
