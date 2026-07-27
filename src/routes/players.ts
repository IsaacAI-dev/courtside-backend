import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/client';
import { asyncRoute } from '../middleware/errorHandler';
import { validateQuery, q } from '../middleware/validate';
import { ok } from './helpers';
import { notFound } from '../lib/errors';
import { normaliseName } from '../lib/normalise';
import { computeWindowForm, hitRateCurve, marketValues, simpleMean, stdDev } from '../services/form';
import { env } from '../env';
import { MARKETS, type Market } from '../lib/types';

export const playersRouter = Router();

const searchSchema = z.object({
  league: z.string().optional(),
  q: z.string().optional(),
  teamId: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).default(50),
});

playersRouter.get(
  '/players',
  validateQuery(searchSchema),
  asyncRoute(async (req, res) => {
    const query = q<z.infer<typeof searchSchema>>(req);
    // `q` runs through the same normaliser as entity resolution (§6.3).
    const needle = query.q ? normaliseName(query.q) : null;
    const players = await prisma.player.findMany({
      where: {
        ...(query.league ? { leagueId: query.league } : {}),
        ...(query.teamId ? { teamId: query.teamId } : {}),
        ...(needle ? { normalised: { contains: needle } } : {}),
      },
      include: { team: { select: { id: true, abbreviation: true, name: true } } },
      orderBy: { fullName: 'asc' },
      take: query.limit,
    });
    ok(req, res, players);
  }),
);

playersRouter.get(
  '/players/:id',
  asyncRoute(async (req, res) => {
    const player = await prisma.player.findUnique({
      where: { id: req.params.id },
      include: {
        team: true,
        identities: true,
        aliases: true,
        injuries: { where: { isCurrent: true }, orderBy: { capturedAt: 'desc' } },
      },
    });
    if (!player) throw notFound('PLAYER_NOT_FOUND', `No player ${req.params.id}`);
    ok(req, res, {
      ...player,
      identities: player.identities.map((i) => ({
        source: i.source,
        externalId: i.externalId,
        rawName: i.rawName,
        matchMethod: i.matchMethod,
        matchConfidence: i.matchConfidence,
        verifiedAt: i.verifiedAt,
      })),
    });
  }),
);

const logsSchema = z.object({ last: z.coerce.number().min(1).max(82).default(15) });

playersRouter.get(
  '/players/:id/gamelogs',
  validateQuery(logsSchema),
  asyncRoute(async (req, res) => {
    const query = q<z.infer<typeof logsSchema>>(req);
    const logs = await prisma.playerGameLog.findMany({
      where: { playerId: req.params.id },
      orderBy: { gameDate: 'desc' },
      take: query.last,
    });
    ok(req, res, logs, { played: logs.filter((g) => !g.didNotPlay).length, total: logs.length });
  }),
);

const formSchema = z.object({
  market: z.enum(MARKETS).default('POINTS'),
  windows: z.string().default('5,10,15'),
});

playersRouter.get(
  '/players/:id/form',
  validateQuery(formSchema),
  asyncRoute(async (req, res) => {
    const query = q<z.infer<typeof formSchema>>(req);
    const windows = query.windows.split(',').map((w) => parseInt(w.trim(), 10)).filter((n) => n > 0);
    const logs = await prisma.playerGameLog.findMany({
      where: { playerId: req.params.id },
      orderBy: { gameDate: 'desc' },
      take: Math.max(...windows, 15),
    });
    const played = logs.filter((g) => !g.didNotPlay);

    // A plausible ladder for the curve: half-points around the season mean.
    const seasonValues = marketValues(played, query.market as Market);
    const mu = simpleMean(seasonValues);
    const ladder = [-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2].map((d) => Math.max(0.5, Math.round((mu + d) * 2) / 2));

    const out: Record<string, unknown> = {};
    for (const w of windows) {
      const form = computeWindowForm(logs, query.market as Market, w, env.RECENCY_LAMBDA);
      out[String(w)] = {
        ...form,
        meanWeighted: round(form.meanWeighted),
        meanSimple: round(form.meanSimple),
        stdDev: round(form.stdDev),
        cv: round(form.cv),
        minutesMean: round(form.minutesMean),
        minutesCv: round(form.minutesCv),
        minutesSlope: round(form.minutesSlope),
        hitRateCurve: hitRateCurve(marketValues(played.slice(0, w), query.market as Market), [...new Set(ladder)], 'OVER'),
        values: marketValues(played.slice(0, w), query.market as Market),
      };
    }
    ok(req, res, { market: query.market, windows: out });
  }),
);

const splitsSchema = z.object({ market: z.enum(MARKETS).default('POINTS') });

playersRouter.get(
  '/players/:id/splits',
  validateQuery(splitsSchema),
  asyncRoute(async (req, res) => {
    const query = q<z.infer<typeof splitsSchema>>(req);
    const logs = await prisma.playerGameLog.findMany({
      where: { playerId: req.params.id, didNotPlay: false },
      orderBy: { gameDate: 'desc' },
      take: 60,
    });
    const field = query.market;
    const val = (g: (typeof logs)[number]) =>
      field === 'POINTS' ? g.points : field === 'ASSISTS' ? g.assists : field === 'REBOUNDS' ? g.rebounds : g.threesMade;

    const home = logs.filter((g) => g.isHome).map(val);
    const away = logs.filter((g) => !g.isHome).map(val);

    // Rest-day split: days since the previous logged game.
    const restBuckets: Record<string, number[]> = { b2b: [], oneDay: [], twoPlus: [] };
    for (let i = 0; i < logs.length - 1; i++) {
      const gap = Math.round((logs[i].gameDate.getTime() - logs[i + 1].gameDate.getTime()) / 86_400_000);
      const bucket = gap <= 1 ? 'b2b' : gap === 2 ? 'oneDay' : 'twoPlus';
      restBuckets[bucket].push(val(logs[i]));
    }

    const summarise = (values: number[]) => ({
      n: values.length,
      mean: values.length ? round(simpleMean(values)) : null,
      stdDev: values.length > 1 ? round(stdDev(values)) : null,
    });

    const homeStats = summarise(home);
    const awayStats = summarise(away);
    // Only material where the split exceeds 12% on 15+ games (§4.6.5).
    const material =
      homeStats.mean != null &&
      awayStats.mean != null &&
      home.length + away.length >= 15 &&
      Math.abs(homeStats.mean - awayStats.mean) / Math.max(homeStats.mean, awayStats.mean) > 0.12;

    ok(req, res, {
      market: query.market,
      home: homeStats,
      away: awayStats,
      homeAwayMaterial: material,
      rest: {
        backToBack: summarise(restBuckets.b2b),
        oneDayRest: summarise(restBuckets.oneDay),
        twoPlusDaysRest: summarise(restBuckets.twoPlus),
      },
    });
  }),
);

const round = (v: number) => Math.round(v * 100) / 100;
