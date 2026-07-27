/**
 * End-to-end demo (spec §13, Phase 0 acceptance).
 *
 * Seeds one fixture, four players with realistic game logs, and a Betano-shaped
 * prop board — then runs the full pipeline with skipScrape so no external source
 * is touched. Proves the availability gate, form maths, line selection,
 * suppression rule, scoring and persistence all work end to end.
 *
 *   npm run demo
 */
import { prisma, initDb } from '../db/client';
import { executeAnalysisRun } from '../services/pipeline';
import { normaliseName } from '../lib/normalise';
import { HOUR_MS } from '../lib/dates';
import type { Market } from '../lib/types';

interface PlayerSpec {
  fullName: string;
  teamAbbr: string;
  points: number[]; // most recent first
  minutes: number[];
  assists?: number[];
  status?: string;
  dnpLast?: boolean;
  ladders: Partial<Record<Market, number[]>>;
}

const SPECS: PlayerSpec[] = [
  {
    // Strong, consistent, plenty of minutes → should produce a confident OVER
    fullName: 'Demo Guard Alpha',
    teamAbbr: 'IND',
    points: [24, 22, 25, 21, 23, 20, 26, 22, 24, 21, 23, 22, 25, 20, 24],
    minutes: [34, 33, 35, 32, 34, 33, 36, 34, 33, 35, 34, 33, 34, 32, 35],
    assists: [8, 7, 9, 6, 8, 7, 9, 8, 7, 8, 7, 9, 8, 7, 8],
    ladders: { POINTS: [17.5, 19.5, 21.5, 23.5], ASSISTS: [5.5, 6.5, 7.5] },
  },
  {
    // Volatile scorer — hits the low rungs but the CV should hurt confidence
    fullName: 'Demo Wing Beta',
    teamAbbr: 'IND',
    points: [31, 8, 27, 9, 24, 6, 29, 11, 26, 7, 30, 9, 25, 8, 28],
    minutes: [30, 18, 31, 19, 29, 16, 32, 20, 30, 17, 31, 19, 28, 18, 30],
    ladders: { POINTS: [13.5, 15.5, 17.5, 19.5] },
  },
  {
    // Ruled OUT → must be excluded by the availability gate, never scored
    fullName: 'Demo Centre Gamma',
    teamAbbr: 'NYL',
    points: [18, 20, 17, 19, 21, 18, 20, 19, 17, 20, 18, 19, 21, 18, 20],
    minutes: [30, 31, 29, 30, 32, 30, 31, 29, 30, 31, 30, 29, 32, 30, 31],
    status: 'OUT',
    ladders: { POINTS: [15.5, 17.5, 19.5] },
  },
  {
    // DNP in the most recent game → excluded by the "played previous match" check
    fullName: 'Demo Forward Delta',
    teamAbbr: 'NYL',
    points: [0, 16, 18, 15, 17, 16, 18, 15, 17, 16, 18, 15, 17, 16, 18],
    minutes: [0, 28, 29, 27, 28, 29, 28, 27, 29, 28, 27, 29, 28, 27, 28],
    dnpLast: true,
    ladders: { POINTS: [13.5, 15.5, 17.5] },
  },
];

async function main(): Promise<void> {
  await initDb();
  const leagueId = 'WNBA';
  const now = new Date();
  const tipOff = new Date(now.getTime() + 6 * HOUR_MS);

  console.log('\n─── seeding synthetic fixture ───');
  const home = await prisma.team.findFirstOrThrow({ where: { leagueId, abbreviation: 'IND' } });
  const away = await prisma.team.findFirstOrThrow({ where: { leagueId, abbreviation: 'NYL' } });

  // Team ratings so the matchup factor has something to work with.
  await prisma.team.update({ where: { id: home.id }, data: { paceRating: 96.4, offRating: 106.1, defRating: 101.2 } });
  await prisma.team.update({ where: { id: away.id }, data: { paceRating: 99.8, offRating: 108.3, defRating: 104.7 } });
  for (const abbr of ['ATL', 'CHI', 'CON', 'DAL', 'MIN', 'SEA']) {
    const t = await prisma.team.findFirst({ where: { leagueId, abbreviation: abbr } });
    if (t) {
      await prisma.team.update({
        where: { id: t.id },
        data: { paceRating: 94 + Math.random() * 6, offRating: 100 + Math.random() * 8, defRating: 99 + Math.random() * 8 },
      });
    }
  }

  const existing = await prisma.fixture.findFirst({
    where: { leagueId, homeTeamId: home.id, awayTeamId: away.id, startsAt: { gte: now } },
  });
  const fixture =
    existing ??
    (await prisma.fixture.create({
      data: {
        leagueId,
        homeTeamId: home.id,
        awayTeamId: away.id,
        startsAt: tipOff,
        season: '2026',
        reconciliationStatus: 'MATCHED',
        reconciliationScore: 1,
        spread: -4.5,
        total: 165.5,
      },
    }));
  console.log(`  fixture ${away.abbreviation} @ ${home.abbreviation} at ${tipOff.toISOString()}`);

  for (const spec of SPECS) {
    const team = spec.teamAbbr === 'IND' ? home : away;
    const [firstName, ...rest] = spec.fullName.split(' ');
    const player =
      (await prisma.player.findFirst({ where: { leagueId, normalised: normaliseName(spec.fullName) } })) ??
      (await prisma.player.create({
        data: {
          leagueId,
          teamId: team.id,
          fullName: spec.fullName,
          firstName,
          lastName: rest.join(' '),
          normalised: normaliseName(spec.fullName),
          position: 'G',
        },
      }));

    // Game logs, one every two days going back.
    for (let i = 0; i < spec.points.length; i++) {
      const gameDate = new Date(tipOff.getTime() - (i + 1) * 2 * 24 * HOUR_MS);
      const didNotPlay = i === 0 && spec.dnpLast === true;
      await prisma.playerGameLog.upsert({
        where: { playerId_gameDate_source: { playerId: player.id, gameDate, source: 'LEAGUE' } },
        create: {
          playerId: player.id,
          gameDate,
          opponentAbbr: i % 2 === 0 ? 'CHI' : 'ATL',
          isHome: i % 2 === 0,
          won: i % 3 !== 0,
          minutes: spec.minutes[i] ?? 0,
          points: spec.points[i] ?? 0,
          assists: spec.assists?.[i] ?? 3,
          rebounds: 5,
          threesMade: 2,
          didNotPlay,
          dnpReason: didNotPlay ? 'Coach decision' : null,
          source: 'LEAGUE',
        },
        update: {},
      });
    }

    if (spec.status) {
      await prisma.injuryStatus.updateMany({ where: { playerId: player.id, isCurrent: true }, data: { isCurrent: false } });
      await prisma.injuryStatus.create({
        data: { playerId: player.id, status: spec.status, detail: 'Demo injury', source: 'ESPN', reportedAt: new Date() },
      });
    }

    // Betano-shaped prop board.
    for (const [market, ladder] of Object.entries(spec.ladders)) {
      for (const line of ladder as number[]) {
        await prisma.propLine.create({
          data: {
            fixtureId: fixture.id,
            playerId: player.id,
            market,
            line,
            overOdds: 1.75 + Math.random() * 0.5,
            underOdds: 1.75 + Math.random() * 0.5,
            rawMarketName: `${spec.fullName} - Player ${market[0]}${market.slice(1).toLowerCase()}`,
          },
        });
      }
    }
    console.log(`  ${spec.fullName.padEnd(20)} ${spec.points.length} logs · ${Object.keys(spec.ladders).length} market(s)`);
  }

  console.log('\n─── running pipeline (skipScrape: no external calls) ───');
  const runId = await executeAnalysisRun({ leagueId, trigger: 'MANUAL', windowHours: 24, skipScrape: true });

  const run = await prisma.analysisRun.findUniqueOrThrow({ where: { id: runId } });
  console.log(`\nstatus=${run.status}  fixtures=${run.fixturesConsidered}  players=${run.playersConsidered}  excluded=${run.playersExcluded}  recs=${run.recommendationsEmitted}  ${run.durationMs}ms`);

  const exclusions = await prisma.playerExclusion.findMany({ where: { runId }, include: { player: true } });
  if (exclusions.length) {
    console.log('\n─── exclusions (every player accounted for) ───');
    for (const e of exclusions) {
      console.log(`  ${(e.player?.fullName ?? e.rawName).padEnd(20)} ${e.reason.padEnd(24)} ${e.detail ?? ''}`);
    }
  }

  const recs = await prisma.recommendation.findMany({
    where: { runId },
    include: { player: true, factors: true },
    orderBy: { confidence: 'desc' },
  });
  console.log('\n─── recommendations ───');
  for (const r of recs) {
    console.log(
      `  [${r.tier}] ${String(r.confidence).padStart(5)}  ${r.player.fullName.padEnd(20)} ${r.market.padEnd(8)} ${r.side} ${r.recommendedLine}  @${r.offeredOdds?.toFixed(2)}  L5 ${r.hitsL5}/${r.gamesL5}  μw=${r.meanWeighted.toFixed(1)} σ=${r.stdDev.toFixed(1)}`,
    );
  }

  const top = recs[0];
  if (top) {
    console.log(`\n─── factor breakdown: ${top.player.fullName} ${top.market} ${top.side} ${top.recommendedLine} ───`);
    for (const f of top.factors.filter((x) => x.kind === 'FACTOR')) {
      console.log(`  ${f.name.padEnd(14)} ${String(f.value).padStart(6)} × ${f.weight} = ${String(f.contribution).padStart(6)}   ${f.note ?? ''}`);
    }
    for (const f of top.factors.filter((x) => x.kind === 'MULTIPLIER')) {
      console.log(`  × ${f.name.padEnd(20)} ${f.value}   ${f.note ?? ''}`);
    }
    for (const f of top.factors.filter((x) => x.kind === 'CAP')) {
      console.log(`  cap ${f.name.padEnd(18)} ${f.value}   ${f.note ?? ''}`);
    }
  }
  console.log();
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
