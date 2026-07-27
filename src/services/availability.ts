/**
 * The availability gate (spec §4.3). Deny-first: a player passes only when
 * every check passes. Cross-source status resolution is MOST PESSIMISTIC.
 * LeagueBreak windows suppress the layoff flag (§3.2.1) so the post-World-Cup
 * resumption doesn't mark the entire league "returning from absence".
 */
import { env } from '../env';
import { prisma } from '../db/client';
import { INJURY_SEVERITY, type InjuryStatusCode, type ExclusionReason } from '../lib/types';
import { daysBetween } from '../lib/dates';

export interface AvailabilityChecks {
  notOut: boolean;
  notDoubtful: boolean;
  playedLast: boolean;
  noLayoff: boolean;
  minutesOk: boolean;
  gamesMissedOk: boolean;
}

export interface AvailabilityVerdict {
  verdict: 'PASS' | 'FAIL';
  status: InjuryStatusCode;
  statusSource: string | null;
  playedPreviousGame: boolean;
  previousGameMinutes: number | null;
  daysSinceLastAppearance: number | null;
  gamesMissedInLast15: number;
  checks: AvailabilityChecks;
  failReason: ExclusionReason | null;
  failDetail: string | null;
}

const HARD_OUT: InjuryStatusCode[] = ['OUT', 'INACTIVE', 'SUSPENDED', 'NOT_WITH_TEAM'];

export async function evaluateAvailability(playerId: string, leagueId: string, asOf: Date): Promise<AvailabilityVerdict> {
  // ── Resolve current status: most pessimistic across all current rows ──
  const current = await prisma.injuryStatus.findMany({
    where: { playerId, isCurrent: true },
    orderBy: { capturedAt: 'desc' },
  });
  let status: InjuryStatusCode = 'ACTIVE';
  let statusSource: string | null = null;
  for (const row of current) {
    const s = row.status as InjuryStatusCode;
    if ((INJURY_SEVERITY[s] ?? 0) >= (INJURY_SEVERITY[status] ?? 0)) {
      // MANUAL wins ties at equal severity — the operator knows something the feeds don't (§9.5).
      if ((INJURY_SEVERITY[s] ?? 0) > (INJURY_SEVERITY[status] ?? 0) || row.source === 'MANUAL') {
        status = s;
        statusSource = row.source;
      }
    }
  }

  // ── Game-log checks ──
  const logs = await prisma.playerGameLog.findMany({
    where: { playerId, gameDate: { lt: asOf } },
    orderBy: { gameDate: 'desc' },
    take: 15,
  });
  const lastLog = logs[0] ?? null;
  const lastPlayed = logs.find((g) => !g.didNotPlay) ?? null;

  const playedPreviousGame = lastLog != null && !lastLog.didNotPlay;
  const previousGameMinutes = lastPlayed?.minutes ?? null;
  const daysSince = lastPlayed ? daysBetween(asOf, lastPlayed.gameDate) : null;
  const gamesMissedInLast15 = logs.filter((g) => g.didNotPlay).length;

  // ── Layoff, break-aware ──
  let layoffFlag = daysSince != null && daysSince > env.LAYOFF_DAYS;
  if (layoffFlag && lastPlayed) {
    const spanningBreak = await prisma.leagueBreak.findFirst({
      where: {
        leagueId,
        suppressLayoffFlag: true,
        startsAt: { gte: lastPlayed.gameDate },
        endsAt: { lte: asOf },
      },
    });
    if (spanningBreak) layoffFlag = false; // the gap is the league's, not the player's (§3.2.1)
  }
  if (daysSince == null) layoffFlag = logs.length > 0; // has logs but never played → treat as layoff

  const excludeDoubtful = ['DOUBTFUL', ...(env.EXCLUDE_QUESTIONABLE ? ['QUESTIONABLE'] : []), ...(env.EXCLUDE_PROBABLE ? ['PROBABLE'] : [])];

  const checks: AvailabilityChecks = {
    notOut: !HARD_OUT.includes(status),
    notDoubtful: !excludeDoubtful.includes(status),
    playedLast: playedPreviousGame,
    noLayoff: !layoffFlag,
    minutesOk: previousGameMinutes == null ? false : previousGameMinutes >= env.MIN_MINUTES_THRESHOLD,
    gamesMissedOk: gamesMissedInLast15 <= env.MAX_GAMES_MISSED_L15,
  };

  // No logs at all: entity may be newly resolved. Insufficient data, not injury.
  if (!logs.length) {
    return {
      verdict: 'FAIL',
      status,
      statusSource,
      playedPreviousGame: false,
      previousGameMinutes: null,
      daysSinceLastAppearance: null,
      gamesMissedInLast15: 0,
      checks: { ...checks, playedLast: false, minutesOk: false },
      failReason: 'INSUFFICIENT_DATA',
      failDetail: 'no game logs ingested for this player',
    };
  }

  let failReason: ExclusionReason | null = null;
  let failDetail: string | null = null;
  if (!checks.notOut) {
    failReason = 'EXCLUDED_OUT';
    failDetail = `status ${status} (${statusSource ?? 'unknown source'})`;
  } else if (!checks.notDoubtful) {
    failReason = 'EXCLUDED_DOUBTFUL';
    failDetail = `status ${status} (${statusSource ?? 'unknown source'})`;
  } else if (!checks.playedLast || !checks.minutesOk) {
    failReason = 'EXCLUDED_DNP_PREVIOUS';
    failDetail = checks.playedLast
      ? `played only ${previousGameMinutes?.toFixed(1)} min last game (< ${env.MIN_MINUTES_THRESHOLD})`
      : `DNP in most recent game${lastLog?.dnpReason ? `: ${lastLog.dnpReason}` : ''}`;
  } else if (!checks.noLayoff) {
    failReason = 'EXCLUDED_RETURNING';
    failDetail = `${daysSince} days since last appearance (> ${env.LAYOFF_DAYS})`;
  } else if (!checks.gamesMissedOk) {
    failReason = 'EXCLUDED_RETURNING';
    failDetail = `${gamesMissedInLast15} DNPs in last 15 (> ${env.MAX_GAMES_MISSED_L15})`;
  }

  return {
    verdict: failReason ? 'FAIL' : 'PASS',
    status,
    statusSource,
    playedPreviousGame,
    previousGameMinutes,
    daysSinceLastAppearance: daysSince,
    gamesMissedInLast15,
    checks,
    failReason,
    failDetail,
  };
}
