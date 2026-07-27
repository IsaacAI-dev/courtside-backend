/**
 * Fixture reconciliation (spec §4.2 / §7): Betano board vs SofaScore schedule.
 * Match on (team pair via alias resolution) + (start within 90 minutes).
 * Betano-only fixtures still flow through — Betano is the board of record —
 * but flagged UNMATCHED_BETANO_ONLY with degraded trust.
 */
import { prisma } from '../db/client';
import { resolveTeam } from './entityResolver';
import { fetchBetanoFixtures, type BetanoFixture } from '../adapters/betano/adapter';
import { fetchSofaUpcomingEvents, getStaticSofaSeasonId, getStaticSofaTournamentId, type SofaEvent } from '../adapters/sofascore';
import { minutesBetween, HOUR_MS } from '../lib/dates';
import { logger } from '../lib/logger';
import type { LeagueId } from '../lib/types';

const TIME_TOLERANCE_MIN = 90;

/**
 * Log raw vs post-window-filter counts and the actual start-time range of
 * what came back. Confirmed 22 Jul 2026: a run with matched/betanoOnly/
 * sofaOnly all at 0 was indistinguishable from a real resolution failure —
 * it turned out to just mean every fixture's start time fell outside the
 * requested window. Once logged, "no games in the next 48h" vs "9 fixtures
 * parsed but every team name failed to resolve" are two completely different
 * lines instead of the same silent zero.
 */
export function logDateRange(
  source: string,
  raw: Array<{ startsAt: Date }>,
  postFilterCount: number,
  windowStart: Date,
  windowEnd: Date,
): void {
  if (!raw.length) {
    logger.info({ source }, `${source}: 0 fixtures/events parsed — nothing to filter`);
    return;
  }
  const starts = raw.map((r) => r.startsAt.getTime()).sort((a, b) => a - b);
  logger.info(
    {
      source,
      rawCount: raw.length,
      inWindowCount: postFilterCount,
      earliestStart: new Date(starts[0]).toISOString(),
      latestStart: new Date(starts[starts.length - 1]).toISOString(),
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
    },
    postFilterCount === 0 && raw.length > 0
      ? `${source}: ${raw.length} parsed, but NONE fall within the requested window — widen --window if this is unexpected`
      : `${source}: ${postFilterCount}/${raw.length} within window`,
  );
}

export interface ReconcileSummary {
  matched: number;
  betanoOnly: number;
  sofaOnly: number;
  timeDiscrepancies: number;
}

export async function reconcileFixtures(leagueId: LeagueId, windowHours: number): Promise<ReconcileSummary> {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + windowHours * HOUR_MS);
  const league = await prisma.leagueConfig.findUniqueOrThrow({ where: { id: leagueId } });

  // Both tournament and season ID are static config (checked at startup by
  // assertSofaScoreConfigFresh in env.ts), read directly — not cached on
  // LeagueConfig via a prior server-boot resolution step. That indirection
  // was a real bug (22 Jul 2026): any standalone script run (bootstrap,
  // analyse) without the server ever having started left this DB field
  // null, silently skipping SofaScore reconciliation with no clear cause.
  let sofaTournamentId: number | null = null;
  let sofaEventsRaw: SofaEvent[] = [];
  try {
    sofaTournamentId = getStaticSofaTournamentId(leagueId);
    const seasonId = getStaticSofaSeasonId(leagueId);
    sofaEventsRaw = await fetchSofaUpcomingEvents(sofaTournamentId, seasonId);
  } catch (err) {
    logger.warn({ leagueId, err: String(err) }, 'SofaScore upcoming-events fetch failed');
  }
  const sofaEvents = sofaEventsRaw.filter(
    (e) =>
      e.uniqueTournamentId === sofaTournamentId &&
      e.startsAt >= now &&
      e.startsAt <= windowEnd,
  );
  logDateRange('SofaScore', sofaEventsRaw, sofaEvents.length, now, windowEnd);

  let betanoFixturesRaw: BetanoFixture[] = [];
  let betanoFixtures: BetanoFixture[] = [];
  try {
    betanoFixturesRaw = await fetchBetanoFixtures();
    betanoFixtures = betanoFixturesRaw.filter((f) => f.startsAt >= now && f.startsAt <= windowEnd);
    logDateRange('Betano', betanoFixturesRaw, betanoFixtures.length, now, windowEnd);
  } catch (err) {
    logger.warn({ err: String(err) }, 'Betano fixtures unavailable — reconciliation degraded to SofaScore-only');
  }

  const summary: ReconcileSummary = { matched: 0, betanoOnly: 0, sofaOnly: 0, timeDiscrepancies: 0 };
  const usedSofa = new Set<string>();

  const upsertFixture = async (
    homeTeamId: string,
    awayTeamId: string,
    startsAt: Date,
    recon: { status: string; score: number | null; delta: number | null },
    links: Array<{ source: string; externalId: string; raw?: unknown }>,
  ) => {
    // Idempotency: one fixture per (league, home, away, ±3h of start).
    const existing = await prisma.fixture.findFirst({
      where: {
        leagueId,
        homeTeamId,
        awayTeamId,
        startsAt: { gte: new Date(startsAt.getTime() - 3 * HOUR_MS), lte: new Date(startsAt.getTime() + 3 * HOUR_MS) },
      },
    });
    const fixture = existing
      ? await prisma.fixture.update({
          where: { id: existing.id },
          data: { startsAt, reconciliationStatus: recon.status, reconciliationScore: recon.score, timeDeltaMinutes: recon.delta },
        })
      : await prisma.fixture.create({
          data: {
            leagueId,
            homeTeamId,
            awayTeamId,
            startsAt,
            season: league.currentSeason,
            reconciliationStatus: recon.status,
            reconciliationScore: recon.score,
            timeDeltaMinutes: recon.delta,
          },
        });
    for (const link of links) {
      await prisma.fixtureSourceLink.upsert({
        where: { source_externalId: { source: link.source, externalId: link.externalId } },
        create: {
          fixtureId: fixture.id,
          source: link.source,
          externalId: link.externalId,
          rawPayload: link.raw ? JSON.stringify(link.raw).slice(0, 20_000) : null,
        },
        update: { fixtureId: fixture.id, capturedAt: new Date() },
      });
    }
    return fixture;
  };

  // Pass 1 — Betano fixtures, matched against SofaScore where possible.
  for (const bf of betanoFixtures) {
    const homeId = await resolveTeam(leagueId, bf.homeName);
    const awayId = await resolveTeam(leagueId, bf.awayName);
    if (!homeId || !awayId) {
      logger.warn({ home: bf.homeName, away: bf.awayName }, 'Betano fixture teams unresolvable — skipped');
      continue;
    }
    let match: SofaEvent | null = null;
    for (const se of sofaEvents) {
      if (usedSofa.has(se.externalId)) continue;
      const seHome = await resolveTeam(leagueId, se.homeName);
      const seAway = await resolveTeam(leagueId, se.awayName);
      const samePair =
        (seHome === homeId && seAway === awayId) || (seHome === awayId && seAway === homeId);
      if (samePair && Math.abs(minutesBetween(se.startsAt, bf.startsAt)) <= TIME_TOLERANCE_MIN) {
        match = se;
        break;
      }
    }
    if (match) {
      usedSofa.add(match.externalId);
      const delta = Math.abs(minutesBetween(match.startsAt, bf.startsAt));
      const status = delta > 15 ? 'TIME_DISCREPANCY' : 'MATCHED';
      if (status === 'TIME_DISCREPANCY') summary.timeDiscrepancies++;
      else summary.matched++;
      // SofaScore start time wins on discrepancy — it tracks official schedules more closely.
      await upsertFixture(homeId, awayId, match.startsAt, { status, score: 1, delta }, [
        { source: 'BETANO', externalId: bf.externalId, raw: bf.raw },
        { source: 'SOFASCORE', externalId: match.externalId },
      ]);
    } else {
      summary.betanoOnly++;
      await upsertFixture(homeId, awayId, bf.startsAt, { status: 'UNMATCHED_BETANO_ONLY', score: null, delta: null }, [
        { source: 'BETANO', externalId: bf.externalId, raw: bf.raw },
      ]);
    }
  }

  // Pass 2 — SofaScore fixtures Betano doesn't list. Recorded for stats
  // pipelines; they carry no board, so no recommendations can arise.
  for (const se of sofaEvents) {
    if (usedSofa.has(se.externalId)) continue;
    const homeId = await resolveTeam(leagueId, se.homeName);
    const awayId = await resolveTeam(leagueId, se.awayName);
    if (!homeId || !awayId) continue;
    summary.sofaOnly++;
    await upsertFixture(homeId, awayId, se.startsAt, { status: 'UNMATCHED_SOFASCORE_ONLY', score: null, delta: null }, [
      { source: 'SOFASCORE', externalId: se.externalId },
    ]);
  }

  // Back-to-back flags (§4.6 multipliers): a team with a fixture yesterday.
  const windowFixtures = await prisma.fixture.findMany({
    where: { leagueId, startsAt: { gte: now, lte: windowEnd } },
  });
  for (const f of windowFixtures) {
    for (const [teamId, flag] of [
      [f.homeTeamId, 'isBackToBackHome'],
      [f.awayTeamId, 'isBackToBackAway'],
    ] as const) {
      const prevGame = await prisma.fixture.findFirst({
        where: {
          leagueId,
          OR: [{ homeTeamId: teamId }, { awayTeamId: teamId }],
          startsAt: { gte: new Date(f.startsAt.getTime() - 30 * HOUR_MS), lt: new Date(f.startsAt.getTime() - 6 * HOUR_MS) },
        },
      });
      if (prevGame) await prisma.fixture.update({ where: { id: f.id }, data: { [flag]: true } });
    }
  }

  logger.info({ leagueId, ...summary }, 'fixture reconciliation complete');
  return summary;
}
