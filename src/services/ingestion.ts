/**
 * Ingestion stages (spec §4.1 stages 1-3): pull from adapters, resolve entities,
 * persist. Each function is independently callable (jobs) and pipeline-callable.
 */
import { prisma } from '../db/client';
import { env } from '../env';
import { logger } from '../lib/logger';
import { HOUR_MS } from '../lib/dates';
import { normaliseName } from '../lib/normalise';
import { resolvePlayer } from './entityResolver';
import { fetchBetanoPlayerProps } from '../adapters/betano/adapter';
import {
  fetchPlayerGameLogs,
  fetchPlayerIndex,
  fetchTeamAdvanced,
  type LeagueStatsConfig,
} from '../adapters/leagueStats';
import { fetchEspnTeams, fetchEspnTeamInjuries } from '../adapters/espn';
import { fetchSofaLineups } from '../adapters/sofascore';
import type { LeagueId } from '../lib/types';

export function statsConfigFor(league: { statsHost: string; statsLeagueId: string; statsReferer: string; currentSeason: string }): LeagueStatsConfig {
  return {
    host: league.statsHost,
    leagueIdParam: league.statsLeagueId,
    referer: league.statsReferer,
    season: league.currentSeason,
  };
}

/**
 * Extract an HTTP status from either error shape this codebase throws:
 * `HttpError` (src/lib/http.ts) carries `.status` as a real field, and
 * `pageFetchJson` (src/adapters/betano/browser.ts) attaches `.status` to a
 * plain Error. The message-regex fallback is a last resort for anything
 * wrapped on the way up.
 */
function httpStatusOf(err: unknown): number | null {
  const s = (err as { status?: unknown } | null | undefined)?.status;
  if (typeof s === 'number') return s;
  const m = /\bHTTP (\d{3})\b/.exec(String(err));
  return m ? Number(m[1]) : null;
}

/**
 * How close to tip-off a fixture must be before it is worth asking SofaScore
 * for lineups at all.
 *
 * Lineups are not published for a game several days out — the endpoint 404s,
 * which is a correct answer to a premature question, not a failure. Asking
 * anyway costs a full direct-tier 403 plus a Chromium in-page escalation
 * (~4s per fixture) to be told nothing, and produces a WARN that looks
 * identical to a real source outage.
 *
 * 6 hours is a deliberately conservative guess — the actual publication time
 * has not been confirmed. Widen it if absences start arriving too late to be
 * useful; the only cost of a larger window is the wasted request this
 * constant exists to avoid.
 */
const LINEUP_PUBLISH_WINDOW_HOURS = 6;

export interface HarvestResult {
  /** PropLine rows actually written (resolved to a known Player). */
  lines: number;
  /** Props returned by Betano that could not be resolved to a Player. */
  unresolved: number;
  /** Props returned by Betano, before resolution. `lines + unresolved`. */
  fetched: number;
  /** True when the harvest was skipped because no players are seeded. */
  crosswalkEmpty?: boolean;
}

/** Stage 2 — harvest the Betano board for one fixture into PropLine snapshots. */
export async function harvestBoard(fixtureId: string): Promise<HarvestResult> {
  const fixture = await prisma.fixture.findUniqueOrThrow({
    where: { id: fixtureId },
    include: { sourceLinks: true },
  });
  const link = fixture.sourceLinks.find((l) => l.source === 'BETANO');
  if (!link) return { lines: 0, unresolved: 0, fetched: 0 };

  // The real event path (e.g. "/match-odds/team-a-team-b/12345/") was
  // captured at reconciliation time into rawPayload — Betano's match-odds
  // URL needs the full path with slug, which can't be reliably reconstructed
  // from the bare numeric externalId or team names alone.
  let eventPath: string | undefined;
  try {
    const raw = link.rawPayload ? JSON.parse(link.rawPayload) : null;
    eventPath = raw?.url ? String(raw.url) : undefined;
  } catch {
    eventPath = undefined;
  }
  if (!eventPath) {
    logger.warn({ fixtureId, externalId: link.externalId }, 'no event path captured for this Betano fixture — cannot fetch player props');
    return { lines: 0, unresolved: 0, fetched: 0 };
  }

  // ── Precondition: the crosswalk must be seeded ──────────────────────────
  // With zero Player rows, every prop falls through all six resolution tiers
  // into the review queue — hundreds of PENDING items with empty candidate
  // lists, none of which is a real entity-resolution problem. The board fetch
  // itself is also pure waste in that state (a Chromium escalation per
  // fixture to produce nothing), so bail before it rather than after.
  //
  // The pipeline checks this once per run before the fixture loop; this guard
  // covers the paths that don't go through the pipeline — the scheduler's
  // BOARD_HARVEST job and POST /ingestion/refresh with scope=LINES.
  const seededPlayers = await prisma.player.count({ where: { leagueId: fixture.leagueId } });
  if (seededPlayers === 0) {
    logger.error(
      { fixtureId, leagueId: fixture.leagueId, fix: `npm run bootstrap -- --league ${fixture.leagueId}` },
      'player crosswalk is EMPTY for this league — board harvest skipped; nothing can resolve until it is seeded',
    );
    return { lines: 0, unresolved: 0, fetched: 0, crosswalkEmpty: true };
  }

  const props = await fetchBetanoPlayerProps(eventPath);
  let unresolved = 0;
  let written = 0;
  const failedRawNames: string[] = [];

  for (const prop of props) {
    // Betano's playerExternalId is an exact crosswalk key (spec §6.5 tier 1)
    // — was previously never passed here, meaning Tier 1 IDENTITY resolution
    // was unreachable for every Betano prop, forever, regardless of whether
    // a name-based tier had ever successfully linked it before.
    const resolved = await resolvePlayer('BETANO', prop.playerRawName, {
      externalId: prop.playerExternalId ?? undefined,
      leagueId: fixture.leagueId,
      fixtureId,
    });
    if (!resolved.playerId) {
      unresolved++;
      if (failedRawNames.length < 8) failedRawNames.push(prop.playerRawName);
      continue; // exclusion is recorded at analysis time with the raw name
    }
    await prisma.propLine.create({
      data: {
        fixtureId,
        playerId: resolved.playerId,
        market: prop.market,
        line: prop.line,
        overOdds: prop.overOdds,
        underOdds: prop.underOdds,
        rawMarketName: prop.rawMarketName,
      },
    });
    written++;
  }

  // Diagnostic (22 Jul 2026): when EVERY prop for a fixture fails resolution,
  // that's suspicious enough to warrant real data rather than a guess — the
  // same principle that found the team-name gender-qualifier bug earlier.
  // Show actual failed raw names next to a real sample of what's seeded for
  // this league, so a systematic mismatch (format, case, suffix handling)
  // is visible directly rather than inferred from a bare count.
  //
  // The empty-crosswalk case — which is what this diagnostic actually caught
  // the first time it ran — now short-circuits above, so reaching here means
  // there IS a seeded population and the sample below is a real comparison.
  if (written === 0 && unresolved > 0) {
    const seededSample = await prisma.player.findMany({
      where: { leagueId: fixture.leagueId },
      select: { fullName: true, normalised: true },
      take: 8,
    });
    logger.warn(
      {
        fixtureId,
        failedRawNames,
        failedRawNamesNormalised: failedRawNames.map((n) => normaliseName(n)),
        seededSample,
        seededTotalForLeague: seededPlayers,
      },
      'ALL player props failed resolution for this fixture — real names vs real seed, side by side',
    );
  }

  // Flag main lines: per player+market, the line closest to the latest capture's median.
  logger.info({ fixtureId, fetched: props.length, written, unresolved }, 'board harvested');
  return { lines: written, unresolved, fetched: props.length };
}

/** Stage 3a — refresh L15 game logs for every player carrying lines on a fixture. */
export async function refreshStatsForFixture(fixtureId: string): Promise<number> {
  const fixture = await prisma.fixture.findUniqueOrThrow({ where: { id: fixtureId }, include: { league: true } });
  const cfg = statsConfigFor(fixture.league);
  const playerIds = (
    await prisma.propLine.findMany({ where: { fixtureId }, select: { playerId: true }, distinct: ['playerId'] })
  ).map((p) => p.playerId);

  let refreshed = 0;
  for (const playerId of playerIds) {
    const identity = await prisma.sourceIdentity.findFirst({
      where: { playerId, source: 'LEAGUE', entityType: 'PLAYER' },
    });
    if (!identity) continue;
    try {
      const logs = await fetchPlayerGameLogs(cfg, identity.externalId, 15);
      for (const log of logs) {
        await prisma.playerGameLog.upsert({
          where: { playerId_gameDate_source: { playerId, gameDate: log.gameDate, source: 'LEAGUE' } },
          create: {
            playerId,
            gameDate: log.gameDate,
            opponentAbbr: log.opponentAbbr,
            isHome: log.isHome,
            won: log.won,
            minutes: log.minutes,
            points: log.points,
            assists: log.assists,
            rebounds: log.rebounds,
            threesMade: log.threesMade,
            threesAtt: log.threesAtt,
            fgm: log.fgm,
            fga: log.fga,
            steals: log.steals,
            blocks: log.blocks,
            turnovers: log.turnovers,
            plusMinus: log.plusMinus,
            didNotPlay: log.minutes === 0,
            source: 'LEAGUE',
          },
          update: { minutes: log.minutes, points: log.points, assists: log.assists, rebounds: log.rebounds, threesMade: log.threesMade },
        });
      }
      refreshed++;
    } catch (err) {
      logger.warn({ playerId, err: String(err) }, 'game log refresh failed');
    }
  }
  return refreshed;
}

/** Stage 3b — injuries: ESPN team endpoints + SofaScore lineup absences. */
export async function sweepInjuries(leagueId: LeagueId): Promise<number> {
  let updates = 0;
  try {
    const espnTeams = await fetchEspnTeams(leagueId);
    for (const team of espnTeams) {
      let injuries;
      try {
        injuries = await fetchEspnTeamInjuries(leagueId, team.externalId);
      } catch {
        continue;
      }
      for (const inj of injuries) {
        const resolved = await resolvePlayer('ESPN', inj.athleteName, {
          externalId: inj.athleteExternalId,
          leagueId,
        });
        if (!resolved.playerId) continue;
        await recordInjury(resolved.playerId, inj.status, inj.detail, 'ESPN', inj.reportedAt);
        updates++;
      }
    }
  } catch (err) {
    logger.warn({ err: String(err) }, 'ESPN injury sweep failed');
  }
  return updates;
}

/**
 * Lineup absence sweep for imminent fixtures (SofaScore missingPlayers).
 *
 * Three distinct outcomes, previously collapsed into one swallowed WARN:
 *
 *   1. Fixture is days away → skipped without a request. Lineups don't exist
 *      yet; asking costs ~4s and answers nothing.
 *   2. 404 from the endpoint → lineups genuinely not published. Logged at
 *      info, returns 0. NOT a source failure.
 *   3. Anything else (403, 5xx, transport, session expiry) → RETHROWN, so the
 *      caller can mark the run DEGRADED.
 *
 * Case 3 is the behaviour change that matters. This function used to catch
 * everything internally and return 0, so the `catch` in pipeline.ts that sets
 * `degraded = true` could never fire — a run in which this source failed on
 * every single fixture still reported COMPLETED.
 */
export async function sweepLineupAbsences(fixtureId: string): Promise<number> {
  const fixture = await prisma.fixture.findUniqueOrThrow({
    where: { id: fixtureId },
    include: { sourceLinks: true },
  });
  const link = fixture.sourceLinks.find((l) => l.source === 'SOFASCORE');
  if (!link) return 0;

  const hoursToTip = (fixture.startsAt.getTime() - Date.now()) / HOUR_MS;
  if (hoursToTip > LINEUP_PUBLISH_WINDOW_HOURS) {
    logger.info(
      { fixtureId, hoursToTip: Math.round(hoursToTip * 10) / 10, windowHours: LINEUP_PUBLISH_WINDOW_HOURS },
      'lineup sweep skipped — fixture too far out for lineups to be published',
    );
    return 0;
  }

  let lineups;
  try {
    lineups = await fetchSofaLineups(link.externalId);
  } catch (err) {
    if (httpStatusOf(err) === 404) {
      logger.info(
        { fixtureId, eventExternalId: link.externalId },
        'lineups not published for this fixture yet — not a source failure',
      );
      return 0;
    }
    throw err; // real failure — the caller decides what it means for the run
  }

  let updates = 0;
  for (const entry of lineups.filter((p) => p.missingReason != null)) {
    const resolved = await resolvePlayer('SOFASCORE', entry.name, {
      externalId: entry.externalId,
      leagueId: fixture.leagueId,
      fixtureId,
    });
    if (!resolved.playerId) continue;
    await recordInjury(resolved.playerId, 'OUT', `SofaScore lineup absence: ${entry.missingReason}`, 'SOFASCORE', new Date());
    updates++;
  }
  return updates;
}

export async function recordInjury(
  playerId: string,
  status: string,
  detail: string | null,
  source: string,
  reportedAt: Date,
): Promise<void> {
  const current = await prisma.injuryStatus.findFirst({
    where: { playerId, source, isCurrent: true },
    orderBy: { capturedAt: 'desc' },
  });
  if (current && current.status === status) return; // unchanged — keep history compact
  await prisma.$transaction([
    prisma.injuryStatus.updateMany({ where: { playerId, source, isCurrent: true }, data: { isCurrent: false } }),
    prisma.injuryStatus.create({ data: { playerId, status, detail, source, reportedAt } }),
  ]);
}

/** Season bootstrap: league player index → Player rows + LEAGUE identities (spec §6.7). */
export async function bootstrapPlayerIndex(leagueId: LeagueId): Promise<number> {
  const league = await prisma.leagueConfig.findUniqueOrThrow({ where: { id: leagueId } });
  const rows = await fetchPlayerIndex(statsConfigFor(league));

  // An empty index is not a success. It means the endpoint answered but the
  // first resultSet had no rows — a season string the feed doesn't recognise,
  // or a shape change — and the caller would otherwise print "players
  // created: 0" as though it had done its job.
  if (rows.length === 0) {
    logger.error(
      { leagueId, season: league.currentSeason, statsHost: league.statsHost },
      'player index returned ZERO rows — the request succeeded but the first resultSet was empty; check the season string against the feed',
    );
    return 0;
  }

  let created = 0;
  for (const row of rows) {
    const normalised = normaliseName(row.fullName);
    const team = row.teamAbbr
      ? await prisma.team.findUnique({ where: { leagueId_abbreviation: { leagueId, abbreviation: row.teamAbbr } } })
      : null;
    const existingIdentity = await prisma.sourceIdentity.findUnique({
      where: { source_externalId_entityType: { source: 'LEAGUE', externalId: row.externalId, entityType: 'PLAYER' } },
    });
    if (existingIdentity?.playerId) {
      await prisma.player.update({
        where: { id: existingIdentity.playerId },
        data: { teamId: team?.id ?? null, position: row.position, jerseyNumber: row.jerseyNumber },
      });
      continue;
    }
    const player = await prisma.player.create({
      data: {
        leagueId,
        teamId: team?.id ?? null,
        fullName: row.fullName,
        firstName: row.firstName,
        lastName: row.lastName,
        normalised,
        position: row.position,
        jerseyNumber: row.jerseyNumber,
      },
    });
    await prisma.sourceIdentity.create({
      data: {
        entityType: 'PLAYER',
        source: 'LEAGUE',
        externalId: row.externalId,
        rawName: row.fullName,
        playerId: player.id,
        matchMethod: 'IDENTITY',
        matchConfidence: 1.0,
        verifiedAt: new Date(),
      },
    });
    created++;
  }
  logger.info({ leagueId, created, total: rows.length }, 'player index bootstrapped');
  return created;
}

/** Team pace / ratings refresh — matchup factor inputs. */
export async function refreshTeamRatings(leagueId: LeagueId): Promise<number> {
  const league = await prisma.leagueConfig.findUniqueOrThrow({ where: { id: leagueId } });
  const rows = await fetchTeamAdvanced(statsConfigFor(league));
  let updated = 0;
  for (const row of rows) {
    const teams = await prisma.team.findMany({ where: { leagueId } });
    const team = teams.find((t) => normaliseName(t.name) === normaliseName(row.teamName));
    if (!team) continue;
    await prisma.team.update({
      where: { id: team.id },
      data: { paceRating: row.pace, offRating: row.offRating, defRating: row.defRating, ratingsAsOf: new Date() },
    });
    updated++;
  }
  return updated;
}