/**
 * Ingestion stages (spec §4.1 stages 1-3): pull from adapters, resolve entities,
 * persist. Each function is independently callable (jobs) and pipeline-callable.
 */
import { prisma } from '../db/client';
import { env } from '../env';
import { logger } from '../lib/logger';
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

/** Stage 2 — harvest the Betano board for one fixture into PropLine snapshots. */
export async function harvestBoard(fixtureId: string): Promise<{ lines: number; unresolved: number }> {
  const fixture = await prisma.fixture.findUniqueOrThrow({
    where: { id: fixtureId },
    include: { sourceLinks: true },
  });
  const link = fixture.sourceLinks.find((l) => l.source === 'BETANO');
  if (!link) return { lines: 0, unresolved: 0 };

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
    return { lines: 0, unresolved: 0 };
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
        seededTotalForLeague: await prisma.player.count({ where: { leagueId: fixture.leagueId } }),
      },
      'ALL player props failed resolution for this fixture — real names vs real seed, side by side',
    );
  }

  // Flag main lines: per player+market, the line closest to the latest capture's median.
  logger.info({ fixtureId, written, unresolved }, 'board harvested');
  return { lines: written, unresolved };
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

/** Lineup absence sweep for imminent fixtures (SofaScore missingPlayers). */
export async function sweepLineupAbsences(fixtureId: string): Promise<number> {
  const fixture = await prisma.fixture.findUniqueOrThrow({
    where: { id: fixtureId },
    include: { sourceLinks: true },
  });
  const link = fixture.sourceLinks.find((l) => l.source === 'SOFASCORE');
  if (!link) return 0;
  let updates = 0;
  try {
    const lineups = await fetchSofaLineups(link.externalId);
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
  } catch (err) {
    logger.warn({ fixtureId, err: String(err) }, 'lineup sweep failed');
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
