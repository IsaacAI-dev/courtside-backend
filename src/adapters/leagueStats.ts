/**
 * NBA / WNBA official stats feed adapter (spec §5.4) — the PRIMARY statistical source.
 *
 * The two hard-won facts encoded here:
 *   1. Requests without x-nba-stats-origin + x-nba-stats-token are rejected.
 *   2. Responses are column-oriented (resultSets[].headers + rowSet) and slow (2-8s).
 *      All calls run through a serial queue; never parallelise this feed.
 */
import { fetchJson, HttpError, SerialQueue } from '../lib/http';
import { parseMinutes } from '../lib/dates';
import { withScrapeLog } from './scrapeLog';
import { logger } from '../lib/logger';
import type { LeagueId } from '../lib/types';

const queue = new SerialQueue(1200, 2500);

interface ResultSets {
  resultSets: Array<{ name?: string; headers: string[]; rowSet: unknown[][] }>;
}

export interface LeagueStatsConfig {
  host: string; // stats.nba.com | stats.wnba.com
  leagueIdParam: string; // "00" | "10"
  referer: string; // https://www.nba.com/ | https://www.wnba.com/
  season: string; // "2026-27" | "2026"
}

/**
 * Full, realistic Chrome-shaped header set. The two custom headers
 * (x-nba-stats-origin/token) are documented as required; the rest — Sec-Fetch-*,
 * Sec-Ch-Ua, Accept-Encoding — are what a real browser sends by default and a
 * bare script does not. Missing them is a cheap, common bot-heuristic signal,
 * and costs nothing to include even if they turn out not to matter here.
 */
const headersFor = (cfg: LeagueStatsConfig): Record<string, string> => ({
  Host: cfg.host,
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'x-nba-stats-origin': 'stats',
  'x-nba-stats-token': 'true',
  Connection: 'keep-alive',
  Origin: `https://${cfg.host}`,
  Referer: cfg.referer,
  'Sec-Ch-Ua': '"Not)A;Brand";v="99", "Google Chrome";v="126", "Chromium";v="126"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-site',
  Pragma: 'no-cache',
  'Cache-Control': 'no-cache',
});

/** Zip column-oriented rows into keyed objects. */
function zip(rs: { headers: string[]; rowSet: unknown[][] }): Record<string, unknown>[] {
  return rs.rowSet.map((row) => Object.fromEntries(rs.headers.map((h, i) => [h, row[i]])));
}

/**
 * DIRECT-ONLY, IPv4-forced (spec §5.4, revised 22 Jul 2026).
 *
 * A Chromium fallback was tried and dropped: it timed out on its own terms
 * without confirmed benefit, and it obscures rather than fixes the underlying
 * problem. The failure actually observed — an AggregateError, meaning every
 * resolved address (IPv4 and IPv6 both) failed to even connect — is a
 * transport-level symptom, not evidence of TLS/bot fingerprinting. Akamai's
 * dual-stack DNS plus a flaky IPv6 path (common on WSL2's virtual adapter) is
 * a simpler and more likely explanation, and forcing IPv4 rules it out for
 * free. If requests still hang cleanly (not aggregate-error, genuinely no
 * response) after this, THAT is the point to revisit browser automation or a
 * HAR-based capture — not before.
 */
async function statsGet(cfg: LeagueStatsConfig, path: string, params: Record<string, string>, op: string) {
  const qs = new URLSearchParams(params).toString();
  const url = `https://${cfg.host}/stats/${path}?${qs}`;
  try {
    return await withScrapeLog('LEAGUE', op, 'DIRECT', () =>
      queue.run(() =>
        fetchJson<ResultSets>(url, {
          headers: headersFor(cfg),
          timeoutMs: 20_000,
          retries: 2,
          retryDelayMs: 2000,
          forceIPv4: true,
        }),
      ),
    );
  } catch (err) {
    const is403 = err instanceof HttpError && err.status === 403;
    const isAggregate = err instanceof AggregateError;
    const isTimeout = err instanceof Error && /headers timeout/i.test(err.message);
    logger.warn(
      {
        url,
        kind: is403 ? '403' : isAggregate ? 'connect failure (all addresses)' : isTimeout ? 'silent hang' : 'other',
      },
      'league stats request failed',
    );
    throw err;
  }
}

export interface LeagueGameLogRow {
  externalGameId: string;
  gameDate: Date;
  matchup: string; // "IND vs. NYL" | "IND @ NYL"
  isHome: boolean;
  opponentAbbr: string;
  won: boolean | null;
  minutes: number;
  points: number;
  assists: number;
  rebounds: number;
  threesMade: number;
  threesAtt: number | null;
  fgm: number | null;
  fga: number | null;
  steals: number | null;
  blocks: number | null;
  turnovers: number | null;
  plusMinus: number | null;
}

const num = (v: unknown): number => (typeof v === 'number' ? v : parseFloat(String(v)) || 0);
const numOrNull = (v: unknown): number | null =>
  v === null || v === undefined || v === '' ? null : num(v);

export async function fetchPlayerGameLogs(
  cfg: LeagueStatsConfig,
  leaguePlayerId: string,
  lastN = 15,
): Promise<LeagueGameLogRow[]> {
  const body = await statsGet(
    cfg,
    'playergamelogs',
    {
      LeagueID: cfg.leagueIdParam,
      Season: cfg.season,
      SeasonType: 'Regular Season',
      PlayerID: leaguePlayerId,
      LastNGames: String(lastN),
    },
    'playergamelogs',
  );
  const rs = body.resultSets?.[0];
  if (!rs) return [];
  return zip(rs).map((r) => {
    const matchup = String(r.MATCHUP ?? '');
    const isHome = matchup.includes(' vs');
    const opponentAbbr = matchup.split(/\s+(?:vs\.?|@)\s+/)[1] ?? '';
    return {
      externalGameId: String(r.GAME_ID ?? ''),
      gameDate: new Date(String(r.GAME_DATE ?? '')),
      matchup,
      isHome,
      opponentAbbr,
      won: r.WL === 'W' ? true : r.WL === 'L' ? false : null,
      minutes: parseMinutes(r.MIN),
      points: num(r.PTS),
      assists: num(r.AST),
      rebounds: num(r.REB),
      threesMade: num(r.FG3M),
      threesAtt: numOrNull(r.FG3A),
      fgm: numOrNull(r.FGM),
      fga: numOrNull(r.FGA),
      steals: numOrNull(r.STL),
      blocks: numOrNull(r.BLK),
      turnovers: numOrNull(r.TOV),
      plusMinus: numOrNull(r.PLUS_MINUS),
    };
  });
}

export interface LeaguePlayerIndexRow {
  externalId: string;
  fullName: string;
  firstName: string;
  lastName: string;
  teamAbbr: string | null;
  position: string | null;
  jerseyNumber: string | null;
}

/** Full player directory — the crosswalk seed (spec §6.7 step 1). Run once per season. */
export async function fetchPlayerIndex(cfg: LeagueStatsConfig): Promise<LeaguePlayerIndexRow[]> {
  const body = await statsGet(
    cfg,
    'playerindex',
    { LeagueID: cfg.leagueIdParam, Season: cfg.season },
    'playerindex',
  );
  const rs = body.resultSets?.[0];
  if (!rs) return [];
  return zip(rs).map((r) => ({
    externalId: String(r.PERSON_ID ?? ''),
    firstName: String(r.PLAYER_FIRST_NAME ?? ''),
    lastName: String(r.PLAYER_LAST_NAME ?? ''),
    fullName: `${r.PLAYER_FIRST_NAME ?? ''} ${r.PLAYER_LAST_NAME ?? ''}`.trim(),
    teamAbbr: r.TEAM_ABBREVIATION ? String(r.TEAM_ABBREVIATION) : null,
    position: r.POSITION ? String(r.POSITION) : null,
    jerseyNumber: r.JERSEY_NUMBER ? String(r.JERSEY_NUMBER) : null,
  }));
}

export interface TeamAdvancedRow {
  externalTeamId: string;
  teamName: string;
  pace: number | null;
  offRating: number | null;
  defRating: number | null;
}

/**
 * PACE / OFF_RATING / DEF_RATING — the matchup factor inputs (§4.6.3).
 *
 * This endpoint's backend does not default missing filter parameters — it
 * throws building the underlying query and returns a bare HTTP 500 rather
 * than a 400 with a useful message. Confirmed 22 Jul 2026: the 5 parameters
 * that matter (LeagueID/Season/SeasonType/MeasureType/PerMode) are not
 * sufficient on their own; the full documented filter set must be present,
 * blank or not.
 */
export async function fetchTeamAdvanced(cfg: LeagueStatsConfig): Promise<TeamAdvancedRow[]> {
  const body = await statsGet(
    cfg,
    'leaguedashteamstats',
    {
      LeagueID: cfg.leagueIdParam,
      Season: cfg.season,
      SeasonType: 'Regular Season',
      MeasureType: 'Advanced',
      PerMode: 'PerGame',
      Conference: '',
      Division: '',
      DateFrom: '',
      DateTo: '',
      GameScope: '',
      GameSegment: '',
      LastNGames: '0',
      Location: '',
      Month: '0',
      OpponentTeamID: '0',
      Outcome: '',
      PORound: '0',
      PaceAdjust: 'N',
      Period: '0',
      PlayerExperience: '',
      PlayerPosition: '',
      PlusMinus: 'N',
      Rank: 'N',
      SeasonSegment: '',
      ShotClockRange: '',
      StarterBench: '',
      TeamID: '0',
      TwoWay: '0',
      VsConference: '',
      VsDivision: '',
    },
    'leaguedashteamstats',
  );
  const rs = body.resultSets?.[0];
  if (!rs) return [];
  return zip(rs).map((r) => ({
    externalTeamId: String(r.TEAM_ID ?? ''),
    teamName: String(r.TEAM_NAME ?? ''),
    pace: numOrNull(r.PACE),
    offRating: numOrNull(r.OFF_RATING),
    defRating: numOrNull(r.DEF_RATING),
  }));
}

export interface ScoreboardGameRow {
  externalGameId: string;
  gameDateEst: string;
  homeTeamId: string;
  awayTeamId: string;
  statusText: string;
}

export async function fetchScoreboard(cfg: LeagueStatsConfig, slashDateStr: string): Promise<ScoreboardGameRow[]> {
  const body = await statsGet(
    cfg,
    'scoreboardv2',
    { GameDate: slashDateStr, LeagueID: cfg.leagueIdParam, DayOffset: '0' },
    'scoreboardv2',
  );
  const rs = body.resultSets?.find((x) => x.name === 'GameHeader') ?? body.resultSets?.[0];
  if (!rs) return [];
  return zip(rs).map((r) => ({
    externalGameId: String(r.GAME_ID ?? ''),
    gameDateEst: String(r.GAME_DATE_EST ?? ''),
    homeTeamId: String(r.HOME_TEAM_ID ?? ''),
    awayTeamId: String(r.VISITOR_TEAM_ID ?? ''),
    statusText: String(r.GAME_STATUS_TEXT ?? ''),
  }));
}

/** Box score for settlement (spec §14.3): per-player final lines for a finished game. */
export async function fetchBoxScore(
  cfg: LeagueStatsConfig,
  externalGameId: string,
): Promise<Array<{ leaguePlayerId: string; playerName: string; minutes: number; points: number; assists: number; rebounds: number; threesMade: number }>> {
  const body = await statsGet(
    cfg,
    'boxscoretraditionalv2',
    { GameID: externalGameId, StartPeriod: '0', EndPeriod: '10', StartRange: '0', EndRange: '0', RangeType: '0' },
    'boxscoretraditionalv2',
  );
  const rs = body.resultSets?.find((x) => x.name === 'PlayerStats') ?? body.resultSets?.[0];
  if (!rs) return [];
  return zip(rs).map((r) => ({
    leaguePlayerId: String(r.PLAYER_ID ?? ''),
    playerName: String(r.PLAYER_NAME ?? ''),
    minutes: parseMinutes(r.MIN),
    points: num(r.PTS),
    assists: num(r.AST),
    rebounds: num(r.REB),
    threesMade: num(r.FG3M),
  }));
}
