/**
 * SofaScore adapter (spec §5.3). Undocumented, unsupported, increasingly 403-prone
 * on plain REST. Direct tier first; if a 403 comes back and a browser is enabled,
 * fall back to a Playwright-context fetch (spec §5.3.2).
 *
 * Tournament IDs are resolved at runtime from the catalogue and cached on
 * LeagueConfig — never hard-coded (§5.3.3). An ID that silently changes produces
 * an empty fixture list, which looks exactly like "no games today".
 */
import { env } from '../env';
import { fetchJson, HttpError } from '../lib/http';
import { withScrapeLog } from './scrapeLog';
import { browserFetchJson, pageFetchJson } from './betano/browser';
import { logger } from '../lib/logger';
import type { LeagueId } from '../lib/types';

const HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://www.sofascore.com/',
  Origin: 'https://www.sofascore.com',
  'Cache-Control': 'no-cache',
};

export class SofaScoreSessionExpiredError extends Error {
  constructor(
    url: string,
    public readonly originalStatus?: number,
    public readonly originalBody?: string,
  ) {
    super(
      `SofaScore request rejected (403) using the configured session cookie — it has likely expired. ` +
        `Re-capture SOFASCORE_SESSION_COOKIE and SOFASCORE_SESSION_USER_AGENT from a fresh manual ` +
        `browser session and update .env. URL: ${url}` +
        (originalBody ? `\nResponse body: ${originalBody}` : ''),
    );
  }
}

/** Manually-captured session cookie/UA, same rationale as the Betano adapter. */
function headersWithSession(): Record<string, string> {
  const headers = { ...HEADERS };
  if (env.SOFASCORE_SESSION_COOKIE) headers.Cookie = env.SOFASCORE_SESSION_COOKIE;
  if (env.SOFASCORE_SESSION_USER_AGENT) headers['User-Agent'] = env.SOFASCORE_SESSION_USER_AGENT;
  return headers;
}

/**
 * Confirmed 22 Jul 2026 (user's own back-to-back Postman test): appending
 * `:authority=<host>` as a literal query parameter turns a 403 into a 200 on
 * an otherwise-identical request. That exact parameter — and ONLY that
 * parameter — is what the working request carried.
 *
 * An earlier version of this function also appended a per-request `_=<nonce>`
 * cache-buster, on the theory that a stale CDN cache might be involved. That
 * theory was wrong: the nonce is NOT part of the confirmed-working URL, and
 * adding it caused the request to 403 again. Removed. If a stale-cache
 * problem is ever actually observed, revisit — but do not add speculative
 * parameters to a request that is confirmed working without them.
 *
 * Built by hand rather than via URLSearchParams, which would percent-encode
 * the colon into %3A — the working request used the literal character.
 */
export function withCacheBypass(url: string): string {
  const authorityHost = new URL(env.SOFASCORE_BASE_URL).hostname;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}:authority=${authorityHost}`;
}

async function sofaGet<T>(path: string, op: string): Promise<T> {
  const url = withCacheBypass(`${env.SOFASCORE_BASE_URL}${path}`);
  const hasSession = Boolean(env.SOFASCORE_SESSION_COOKIE);
  try {
    return await withScrapeLog('SOFASCORE', op, 'DIRECT', () =>
      fetchJson<T>(url, { headers: headersWithSession(), retries: 1, forceIPv4: true }),
    );
  } catch (err) {
    const is403 = err instanceof HttpError && err.status === 403;

    // Confirmed 22 Jul 2026: the SAME cookie + SAME URL succeeds in Postman
    // (Electron/Chromium-based networking) but 403s from this app (Node's
    // undici) — the exact symptom that turned out, for Betano, to be a TLS
    // fingerprint mismatch rather than an expired or wrong cookie. Node's TLS
    // handshake doesn't look like a real browser's even when every header
    // matches byte-for-byte. Try the same fix: fetch from inside a real
    // Chromium page, which carries an actual browser TLS handshake, before
    // concluding the session itself is bad.
    if (hasSession) {
      if (is403) {
        try {
          logger.warn({ url, op }, 'SofaScore direct tier 403 with a session cookie — trying real-browser in-page fetch');
          return await withScrapeLog('SOFASCORE', op, 'BROWSER', () =>
            pageFetchJson<T>(url, {
              cookieHeader: env.SOFASCORE_SESSION_COOKIE!,
              userAgent: env.SOFASCORE_SESSION_USER_AGENT || HEADERS['User-Agent'],
              domain: 'www.sofascore.com',
              extraHeaders: { Accept: HEADERS.Accept },
            }),
          );
        } catch (pageErr) {
          logger.warn({ url, err: String(pageErr) }, 'in-page fetch tier also failed');
          // Only a matching 403 here actually indicates session expiry —
          // same fix applied to the Betano adapter (spec §5.2.6). A 404 here
          // (confirmed 22 Jul 2026, on /event/{id}/lineups for games several
          // days out) most plausibly means lineups simply aren't published
          // yet for a future game, not that the session is bad.
          const pageIs403 = pageErr instanceof Error && /HTTP 403/.test(pageErr.message);
          if (pageIs403) {
            const httpErr = err as HttpError;
            throw new SofaScoreSessionExpiredError(url, httpErr.status, httpErr.bodySnippet);
          }
          throw pageErr;
        }
      }
      throw err;
    }

    if (is403 && env.BETANO_USE_BROWSER) {
      logger.warn({ path }, 'SofaScore 403 on plain REST — falling back to browser tier (§5.3.2)');
      return withScrapeLog('SOFASCORE', op, 'BROWSER', () => browserFetchJson<T>(url, HEADERS));
    }
    throw err;
  }
}

export interface SofaEvent {
  externalId: string;
  tournamentSlug: string;
  uniqueTournamentId: number;
  homeName: string;
  awayName: string;
  homeExternalId: string;
  awayExternalId: string;
  startsAt: Date;
  statusType: string;
}

export async function fetchSofaScheduledEvents(isoDateStr: string): Promise<SofaEvent[]> {
  const body = await sofaGet<any>(`/sport/basketball/scheduled-events/${isoDateStr}`, 'scheduled-events');
  return (body.events ?? []).map((e: any) => ({
    externalId: String(e.id),
    tournamentSlug: String(e.tournament?.uniqueTournament?.slug ?? ''),
    uniqueTournamentId: Number(e.tournament?.uniqueTournament?.id ?? 0),
    homeName: String(e.homeTeam?.name ?? ''),
    awayName: String(e.awayTeam?.name ?? ''),
    homeExternalId: String(e.homeTeam?.id ?? ''),
    awayExternalId: String(e.awayTeam?.id ?? ''),
    startsAt: new Date(Number(e.startTimestamp) * 1000),
    statusType: String(e.status?.type ?? 'notstarted'),
  }));
}

/**
 * Confirmed 22 Jul 2026: `/sport/basketball/scheduled-events/{date}` 403s even
 * with a valid session cookie (application-level rejection, not a Cloudflare
 * gate — the cookie itself was accepted for other calls seconds apart). The
 * tournament-scoped equivalent below returned real data with the identical
 * session and no special handling. This is now the production fixture-
 * discovery path; `fetchSofaScheduledEvents` above is kept only because
 * `withCacheBypass` is tested against a URL of that shape — nothing calls it.
 *
 * `/events/next/0` is page 0 of a paginated, chronologically-sorted list —
 * fine here because reconciliation only looks a `windowHours` (≤ 48h) ahead
 * and discards anything beyond that; pagination was never needed for that
 * range in testing.
 */
export async function fetchSofaUpcomingEvents(uniqueTournamentId: number, seasonId: number): Promise<SofaEvent[]> {
  const body = await sofaGet<any>(
    `/unique-tournament/${uniqueTournamentId}/season/${seasonId}/events/next/0`,
    'upcoming-events',
  );
  return (body.events ?? []).map((e: any) => ({
    externalId: String(e.id),
    tournamentSlug: String(e.tournament?.uniqueTournament?.slug ?? ''),
    uniqueTournamentId: Number(e.tournament?.uniqueTournament?.id ?? uniqueTournamentId),
    homeName: String(e.homeTeam?.name ?? ''),
    awayName: String(e.awayTeam?.name ?? ''),
    homeExternalId: String(e.homeTeam?.id ?? ''),
    awayExternalId: String(e.awayTeam?.id ?? ''),
    startsAt: new Date(Number(e.startTimestamp) * 1000),
    statusType: String(e.status?.type ?? 'notstarted'),
  }));
}

/**
 * Static per-league tournament ID (spec §5.3.4, per explicit user decision,
 * 22 Jul 2026) — replaces resolveTournamentIds() in every real execution
 * path. That endpoint (`/config/unique-tournaments/en/basketball`) was never
 * one of the endpoints confirmed working; it 403s under the exact same
 * session that succeeds on every endpoint that was actually tested.
 */
export function getStaticSofaTournamentId(leagueId: LeagueId): number {
  const id = leagueId === 'NBA' ? env.NBA_SOFASCORE_TOURNAMENT_ID : env.WNBA_SOFASCORE_TOURNAMENT_ID;
  if (id == null || id === 0) {
    // Should have been caught by assertSofaScoreConfigFresh() at startup —
    // this is a backstop, not the primary check. 0 is never a real
    // SofaScore ID; treat it as unset (see the optionalId comment in env.ts).
    throw new Error(`${leagueId}_SOFASCORE_TOURNAMENT_ID is not set`);
  }
  return id;
}

/**
 * Static per-league season ID (spec §5.3.4, per explicit user decision,
 * 22 Jul 2026) — the production path now uses this instead of
 * resolveCurrentSeasonId, which added an extra API call per reconciliation
 * run that could fail independently. Staleness is caught at startup by
 * assertSofaScoreConfigFresh() in env.ts, not by re-resolving on every call.
 */
export function getStaticSofaSeasonId(leagueId: LeagueId): number {
  const id = leagueId === 'NBA' ? env.NBA_SOFASCORE_SEASON_ID : env.WNBA_SOFASCORE_SEASON_ID;
  if (id == null || id === 0) {
    // Should have been caught by assertSofaScoreConfigFresh() at startup —
    // this is a backstop, not the primary check. 0 is never a real
    // SofaScore ID; treat it as unset (see the optionalId comment in env.ts).
    throw new Error(`${leagueId}_SOFASCORE_SEASON_ID is not set`);
  }
  return id;
}

/** Resolve NBA/WNBA uniqueTournament IDs from the catalogue at startup (§5.3.3). */
export async function resolveTournamentIds(): Promise<Partial<Record<LeagueId, number>>> {
  const body = await sofaGet<any>('/config/unique-tournaments/en/basketball', 'tournament-catalogue');
  const out: Partial<Record<LeagueId, number>> = {};
  for (const t of body.uniqueTournaments ?? []) {
    const slug = String(t.slug ?? '').toLowerCase();
    if (slug === 'nba') out.NBA = Number(t.id);
    if (slug === 'wnba') out.WNBA = Number(t.id);
  }
  return out;
}

export interface SofaLineupPlayer {
  externalId: string;
  name: string;
  missingReason: string | null; // non-null = listed absent
}

export async function fetchSofaLineups(eventExternalId: string): Promise<SofaLineupPlayer[]> {
  const body = await sofaGet<any>(`/event/${eventExternalId}/lineups`, 'lineups');
  const out: SofaLineupPlayer[] = [];
  for (const side of ['home', 'away'] as const) {
    for (const p of body[side]?.players ?? []) {
      out.push({
        externalId: String(p.player?.id ?? ''),
        name: String(p.player?.name ?? ''),
        missingReason: p.missingReason != null ? String(p.missingReason) : null,
      });
    }
    for (const m of body[side]?.missingPlayers ?? []) {
      out.push({
        externalId: String(m.player?.id ?? ''),
        name: String(m.player?.name ?? ''),
        missingReason: String(m.reason ?? m.type ?? 'missing'),
      });
    }
  }
  return out.filter((p) => p.externalId);
}

export interface SofaSquadPlayer {
  externalId: string;
  name: string;
  position: string | null;
  jerseyNumber: string | null;
}

/** Squad list — crosswalk seed (spec §6.7). */
export async function fetchSofaTeamPlayers(teamExternalId: string): Promise<SofaSquadPlayer[]> {
  const body = await sofaGet<any>(`/team/${teamExternalId}/players`, 'team-players');
  return (body.players ?? []).map((p: any) => ({
    externalId: String(p.player?.id ?? ''),
    name: String(p.player?.name ?? ''),
    position: p.player?.position ?? null,
    jerseyNumber: p.player?.jerseyNumber ?? null,
  }));
}

/**
 * Resolve the current season ID for a tournament at runtime — never hard-coded.
 * Confirmed 22 Jul 2026: this rolls over every year (e.g. "WNBA 2026" → 89004),
 * and a stale hardcoded value doesn't fail loudly — it silently keeps returning
 * last season's completed data, which looks identical to a healthy response.
 * `/unique-tournament/{id}/seasons` lists seasons with the current one first.
 */
export async function resolveCurrentSeasonId(uniqueTournamentId: number): Promise<number> {
  const body = await sofaGet<any>(`/unique-tournament/${uniqueTournamentId}/seasons`, 'tournament-seasons');
  const seasons: any[] = body.seasons ?? [];
  if (!seasons.length) {
    throw new Error(`No seasons returned for tournament ${uniqueTournamentId} — cannot resolve current season`);
  }
  return Number(seasons[0].id);
}

/**
 * Stat categories confirmed to carry the FULL roster (one entry per player who
 * logged any minutes at all), as opposed to the percentage-based categories
 * (fieldGoalsPercentage, freeThrowsPercentage, threePointsPercentage,
 * doubleDoubles), which are qualified/partial lists and add no one the full
 * categories don't already have. Unioning just these is enough to build the
 * squad for a basketball roster (11-12 active players).
 */
const FULL_ROSTER_CATEGORIES = [
  'points',
  'rebounds',
  'assists',
  'secondsPlayed',
  'steals',
  'blocks',
  'turnovers',
  'plusMinus',
  'defensiveRebounds',
  'offensiveRebounds',
  'rating',
  'assistTurnoverRatio',
] as const;

/**
 * Squad list built by unioning `top-players/regularSeason` categories, for use
 * when the direct `/team/{id}/players` endpoint is unavailable (spec §6.7,
 * added 22 Jul 2026). This is season-aggregate data, not a live roster — two
 * known, accepted gaps:
 *   1. A player with too few games this season to appear in ANY category
 *      (a very recent call-up or trade) is invisible here, not just flagged
 *      absent — there is nothing to catch this at the squad-building layer.
 *   2. This has no "active tonight" signal — that remains the availability
 *      gate's job (spec §4.3), not this function's.
 * Both are accepted as out of scope; missed players are simply not seeded.
 */
export async function fetchSofaTopPlayersSquad(
  teamExternalId: string,
  uniqueTournamentId: number,
  seasonId: number,
): Promise<SofaSquadPlayer[]> {
  const body = await sofaGet<any>(
    `/team/${teamExternalId}/unique-tournament/${uniqueTournamentId}/season/${seasonId}/top-players/regularSeason`,
    'top-players-squad',
  );
  const topPlayers = body.topPlayers ?? {};

  const squad = new Map<string, SofaSquadPlayer>();
  for (const category of FULL_ROSTER_CATEGORIES) {
    for (const entry of topPlayers[category] ?? []) {
      const id = String(entry.player?.id ?? '');
      if (!id || squad.has(id)) continue;
      squad.set(id, {
        externalId: id,
        name: String(entry.player?.name ?? ''),
        position: entry.player?.position ?? null,
        jerseyNumber: null, // not present in this payload shape
      });
    }
  }
  return [...squad.values()];
}

/** Drives the "played in the previous match" check when the league feed is down. */
export async function fetchSofaTeamLastEvents(teamExternalId: string): Promise<SofaEvent[]> {
  const body = await sofaGet<any>(`/team/${teamExternalId}/events/last/0`, 'team-last-events');
  return (body.events ?? []).map((e: any) => ({
    externalId: String(e.id),
    tournamentSlug: String(e.tournament?.uniqueTournament?.slug ?? ''),
    uniqueTournamentId: Number(e.tournament?.uniqueTournament?.id ?? 0),
    homeName: String(e.homeTeam?.name ?? ''),
    awayName: String(e.awayTeam?.name ?? ''),
    homeExternalId: String(e.homeTeam?.id ?? ''),
    awayExternalId: String(e.awayTeam?.id ?? ''),
    startsAt: new Date(Number(e.startTimestamp) * 1000),
    statusType: String(e.status?.type ?? ''),
  }));
}

export interface SofaPlayerGameStats {
  eventExternalId: string;
  playerExternalId: string;
  minutes: number;
  points: number;
  assists: number;
  rebounds: number;
  threesMade: number;
  didNotPlay: boolean;
}

/** One player's box score for one game — confirmed shape from a real capture. */
export async function fetchSofaPlayerEventStatistics(
  eventExternalId: string,
  playerExternalId: string,
): Promise<SofaPlayerGameStats | null> {
  try {
    const body = await sofaGet<any>(`/event/${eventExternalId}/player/${playerExternalId}/statistics`, 'player-event-stats');
    const s = body.statistics ?? {};
    const seconds = Number(s.secondsPlayed ?? 0);
    return {
      eventExternalId,
      playerExternalId,
      minutes: Math.round((seconds / 60) * 10) / 10,
      points: Number(s.points ?? 0),
      assists: Number(s.assists ?? 0),
      rebounds: Number(s.rebounds ?? 0),
      threesMade: Number(s.threePointsMade ?? 0),
      didNotPlay: seconds === 0,
    };
  } catch (err) {
    // A player who was on the roster but didn't dress for a given game
    // legitimately 404s here — treat as "no stats for this game", not a
    // failure that should abort fetching the rest of the squad.
    if (err instanceof HttpError && err.status === 404) return null;
    throw err;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch per-game statistics for every player in a squad, paced to avoid
 * looking like a scripted burst: after every 3-5 calls (randomised each
 * time), pause 2-5 seconds (also randomised) before continuing. SofaScore is
 * undocumented and its real rate-limit behaviour is unknown — this is a
 * precaution, not a response to an observed block, added 22 Jul 2026 per
 * request. One player's fetch failing does not abort the rest of the squad;
 * it's logged and skipped.
 */
export async function fetchSofaPlayerStatsForSquad(
  eventExternalId: string,
  squad: SofaSquadPlayer[],
): Promise<SofaPlayerGameStats[]> {
  const out: SofaPlayerGameStats[] = [];
  let sinceLastPause = 0;
  let nextPauseAt = 3 + Math.floor(Math.random() * 3); // 3, 4, or 5

  for (const player of squad) {
    try {
      const stats = await fetchSofaPlayerEventStatistics(eventExternalId, player.externalId);
      if (stats) out.push(stats);
    } catch (err) {
      logger.warn(
        { eventExternalId, playerExternalId: player.externalId, err: String(err) },
        'skipping player after a failed stats fetch',
      );
    }

    sinceLastPause++;
    if (sinceLastPause >= nextPauseAt) {
      const pauseMs = 2000 + Math.floor(Math.random() * 3000); // 2-5s
      logger.debug({ eventExternalId, pauseMs, done: out.length, total: squad.length }, 'pacing pause between SofaScore calls');
      await sleep(pauseMs);
      sinceLastPause = 0;
      nextPauseAt = 3 + Math.floor(Math.random() * 3);
    }
  }
  return out;
}

/** Last-resort entity search for the crosswalk resolver (§6.5 tier 5). */
export async function sofaSearch(q: string): Promise<Array<{ externalId: string; name: string; type: string }>> {
  const body = await sofaGet<any>(`/search/all?q=${encodeURIComponent(q)}`, 'search');
  return (body.results ?? [])
    .filter((r: any) => r.type === 'player' || r.entity?.name)
    .map((r: any) => ({
      externalId: String(r.entity?.id ?? ''),
      name: String(r.entity?.name ?? ''),
      type: String(r.type ?? ''),
    }));
}
