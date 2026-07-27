import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/client';
import { asyncRoute } from '../middleware/errorHandler';
import { validateQuery, q } from '../middleware/validate';
import { ok } from './helpers';
import { notFound } from '../lib/errors';
import { HOUR_MS, minutesBetween } from '../lib/dates';
import { evaluateAvailability } from '../services/availability';
import { computeWindowForm, hitRateCurve, marketValues } from '../services/form';
import { env } from '../env';
import { MARKETS, type Market } from '../lib/types';

export const fixturesRouter = Router();

const listSchema = z.object({
  league: z.string().optional(),
  window: z.enum(['12h', '24h', '48h']).default('24h'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  status: z.string().optional(),
  reconciliation: z.string().optional(),
});

fixturesRouter.get(
  '/fixtures',
  validateQuery(listSchema),
  asyncRoute(async (req, res) => {
    const query = q<z.infer<typeof listSchema>>(req);
    const now = new Date();
    let range: { gte: Date; lte: Date };
    if (query.date) {
      const start = new Date(`${query.date}T00:00:00.000Z`);
      range = { gte: start, lte: new Date(start.getTime() + 24 * HOUR_MS) };
    } else {
      const hours = parseInt(query.window, 10);
      range = { gte: now, lte: new Date(now.getTime() + hours * HOUR_MS) };
    }
    const fixtures = await prisma.fixture.findMany({
      where: {
        ...(query.league ? { leagueId: query.league } : {}),
        startsAt: range,
        ...(query.status ? { status: { in: query.status.split(',') } } : {}),
        ...(query.reconciliation ? { reconciliationStatus: { in: query.reconciliation.split(',') } } : {}),
      },
      include: { homeTeam: true, awayTeam: true, _count: { select: { propLines: true, recommendations: true } } },
      orderBy: { startsAt: 'asc' },
    });
    ok(
      req,
      res,
      fixtures.map((f) => ({
        id: f.id,
        leagueId: f.leagueId,
        startsAt: f.startsAt,
        status: f.status,
        venue: f.venue,
        reconciliationStatus: f.reconciliationStatus,
        timeDeltaMinutes: f.timeDeltaMinutes,
        isBackToBackHome: f.isBackToBackHome,
        isBackToBackAway: f.isBackToBackAway,
        spread: f.spread,
        total: f.total,
        homeTeam: { id: f.homeTeam.id, name: f.homeTeam.name, abbreviation: f.homeTeam.abbreviation, logoUrl: f.homeTeam.logoUrl },
        awayTeam: { id: f.awayTeam.id, name: f.awayTeam.name, abbreviation: f.awayTeam.abbreviation, logoUrl: f.awayTeam.logoUrl },
        counts: { propLines: f._count.propLines, recommendations: f._count.recommendations },
      })),
    );
  }),
);

fixturesRouter.get(
  '/fixtures/:id',
  asyncRoute(async (req, res) => {
    const fixture = await prisma.fixture.findUnique({
      where: { id: req.params.id },
      include: { homeTeam: true, awayTeam: true, sourceLinks: true },
    });
    if (!fixture) throw notFound('FIXTURE_NOT_FOUND', `No fixture ${req.params.id}`);
    ok(req, res, {
      ...fixture,
      sourceLinks: fixture.sourceLinks.map((l) => ({ source: l.source, externalId: l.externalId, capturedAt: l.capturedAt })),
    });
  }),
);

/** THE key endpoint (§9.4): every player Betano lists, with ladder, gate verdict and form. */
fixturesRouter.get(
  '/fixtures/:id/players',
  asyncRoute(async (req, res) => {
    const fixture = await prisma.fixture.findUnique({ where: { id: req.params.id } });
    if (!fixture) throw notFound('FIXTURE_NOT_FOUND', `No fixture ${req.params.id}`);

    const lines = await prisma.propLine.findMany({
      where: { fixtureId: fixture.id },
      orderBy: { capturedAt: 'desc' },
      include: { player: { include: { team: true } } },
    });

    const byPlayer = new Map<string, typeof lines>();
    for (const line of lines) {
      const arr = byPlayer.get(line.playerId) ?? [];
      arr.push(line);
      byPlayer.set(line.playerId, arr);
    }

    const out = [];
    for (const [playerId, playerLines] of byPlayer) {
      const player = playerLines[0].player;
      const availability = await evaluateAvailability(playerId, fixture.leagueId, fixture.startsAt);
      const logs = await prisma.playerGameLog.findMany({
        where: { playerId, gameDate: { lt: fixture.startsAt } },
        orderBy: { gameDate: 'desc' },
        take: 20,
      });
      const played = logs.filter((g) => !g.didNotPlay);

      const markets: Record<string, unknown> = {};
      for (const market of MARKETS) {
        const marketLines = playerLines.filter((l) => l.market === market);
        if (!marketLines.length) continue;
        const newest = marketLines[0].capturedAt;
        const current = marketLines.filter((l) => Math.abs(minutesBetween(newest, l.capturedAt)) <= 5);
        const ladder = [...new Set(current.map((l) => l.line))].sort((a, b) => a - b);
        const form = computeWindowForm(logs, market as Market, env.PRIMARY_WINDOW, env.RECENCY_LAMBDA);
        const curve = hitRateCurve(marketValues(played.slice(0, env.PRIMARY_WINDOW), market as Market), ladder, 'OVER');
        markets[market] = {
          ladder: current.map((l) => ({ line: l.line, overOdds: l.overOdds, underOdds: l.underOdds, capturedAt: l.capturedAt })),
          lines: ladder,
          minLine: ladder.length ? Math.min(...ladder) : null,
          maxLine: ladder.length ? Math.max(...ladder) : null,
          form: {
            meanWeighted: round(form.meanWeighted),
            meanSimple: round(form.meanSimple),
            stdDev: round(form.stdDev),
            cv: round(form.cv),
            games: form.games,
          },
          hitRateCurve: curve,
          lastFive: marketValues(played.slice(0, 5), market as Market),
        };
      }

      out.push({
        player: {
          id: player.id,
          fullName: player.fullName,
          position: player.position,
          jerseyNumber: player.jerseyNumber,
          headshotUrl: player.headshotUrl,
          team: player.team ? { id: player.team.id, abbreviation: player.team.abbreviation, name: player.team.name } : null,
        },
        availability,
        minutes: {
          mean: round(computeWindowForm(logs, 'POINTS', env.PRIMARY_WINDOW, env.RECENCY_LAMBDA).minutesMean),
          slope: round(computeWindowForm(logs, 'POINTS', env.PRIMARY_WINDOW, env.RECENCY_LAMBDA).minutesSlope),
        },
        markets,
      });
    }
    ok(req, res, out, { fixtureId: fixture.id, playerCount: out.length });
  }),
);

const linesSchema = z.object({ history: z.enum(['true', 'false']).default('false'), market: z.string().optional() });

fixturesRouter.get(
  '/fixtures/:id/lines',
  validateQuery(linesSchema),
  asyncRoute(async (req, res) => {
    const query = q<z.infer<typeof linesSchema>>(req);
    const all = await prisma.propLine.findMany({
      where: { fixtureId: req.params.id, ...(query.market ? { market: query.market } : {}) },
      orderBy: { capturedAt: 'desc' },
      include: { player: { select: { id: true, fullName: true } } },
    });
    if (query.history === 'true') {
      ok(req, res, all, { count: all.length, note: 'every capture — the sequence is the movement history' });
      return;
    }
    // Latest snapshot per player+market+line
    const seen = new Set<string>();
    const latest = all.filter((l) => {
      const key = `${l.playerId}|${l.market}|${l.line}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    ok(req, res, latest, { count: latest.length });
  }),
);

fixturesRouter.get(
  '/fixtures/:id/exclusions',
  asyncRoute(async (req, res) => {
    const exclusions = await prisma.playerExclusion.findMany({
      where: { fixtureId: req.params.id },
      orderBy: { createdAt: 'desc' },
      include: { player: { select: { id: true, fullName: true } }, run: { select: { id: true, startedAt: true } } },
    });
    const byReason = exclusions.reduce<Record<string, number>>((acc, e) => {
      acc[e.reason] = (acc[e.reason] ?? 0) + 1;
      return acc;
    }, {});
    ok(req, res, exclusions, { byReason });
  }),
);

const round = (v: number) => Math.round(v * 100) / 100;
