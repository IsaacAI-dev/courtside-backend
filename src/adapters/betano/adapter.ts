/**
 * Betano.ng adapter (spec §5.2). There is no public API; endpoints come from the
 * discovery protocol (`npm run discover:betano`) and live in config/betano.json.
 *
 * Two tiers: direct undici GET with captured headers, then the Playwright context.
 * Parsing is heuristic-by-shape rather than path-exact, because the payload
 * structure has a shelf life of weeks; the shape-hash log flags drift (§5.2.5).
 *
 * READ-ONLY, UNAUTHENTICATED, ALWAYS. No login, no account endpoints, no wagers.
 */
import { readFileSync, existsSync } from 'node:fs';
import { env } from '../../env';
import { fetchJson, HttpError } from '../../lib/http';
import { withScrapeLog } from '../scrapeLog';
import { warmBetanoSession, browserFetchJson, pageFetchJson } from './browser';
import { logger } from '../../lib/logger';
import type { Market } from '../../lib/types';
import { parseBetanoMatchOdds, isMatchOddsPayload, buildPlayersUrl } from './matchOdds';

export interface BetanoConfig {
  fixturesUrl: string;
  eventUrlTemplate: string; // "{eventId}" placeholder
  playerPropsUrlTemplate: string; // "{eventId}" placeholder
  headers: Record<string, string>;
  marketMap: Array<{ pattern: string; market: Market }>;
}

let cached: BetanoConfig | null = null;

export function loadBetanoConfig(): BetanoConfig | null {
  if (cached) return cached;
  if (!existsSync(env.BETANO_CONFIG_PATH)) return null;
  try {
    cached = JSON.parse(readFileSync(env.BETANO_CONFIG_PATH, 'utf-8')) as BetanoConfig;
    return cached;
  } catch (err) {
    logger.error({ err: String(err) }, 'betano.json is present but unparseable');
    return null;
  }
}

export class BetanoNotConfiguredError extends Error {
  constructor() {
    super(
      `No Betano endpoint config at ${env.BETANO_CONFIG_PATH}. Run \`npm run discover:betano\` first (spec §5.2.2).`,
    );
  }
}

export class BetanoSessionExpiredError extends Error {
  constructor(url: string) {
    super(
      `Betano request rejected (403) using the configured session cookie — it has likely expired. ` +
        `Re-capture BETANO_SESSION_COOKIE and BETANO_SESSION_USER_AGENT from a fresh manual browser ` +
        `session (spec §5.2.6) and update .env. URL: ${url}`,
    );
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const politeDelay = () =>
  sleep(env.BETANO_MIN_DELAY_MS + Math.random() * (env.BETANO_MAX_DELAY_MS - env.BETANO_MIN_DELAY_MS));

/**
 * Merge the manually-captured Cloudflare session on top of the static config
 * headers. The Cookie and User-Agent must come from the SAME browser request
 * — Cloudflare ties the clearance cookie to the exact User-Agent that solved
 * the challenge.
 */
function headersWithSession(cfg: BetanoConfig): Record<string, string> {
  const headers = { ...cfg.headers };
  if (env.BETANO_SESSION_COOKIE) headers.Cookie = env.BETANO_SESSION_COOKIE;
  if (env.BETANO_SESSION_USER_AGENT) headers['User-Agent'] = env.BETANO_SESSION_USER_AGENT;
  return headers;
}

async function betanoGet<T>(url: string, op: string): Promise<T> {
  const cfg = loadBetanoConfig();
  if (!cfg) throw new BetanoNotConfiguredError();
  await politeDelay();
  const hasSession = Boolean(env.BETANO_SESSION_COOKIE);
  try {
    return await withScrapeLog('BETANO', op, 'DIRECT', () =>
      fetchJson<T>(url, { headers: headersWithSession(cfg), retries: 0 }),
    );
  } catch (err) {
    const is403 = err instanceof HttpError && err.status === 403;

    // Confirmed 22 Jul 2026: Cloudflare fingerprints Playwright/CDP automation
    // itself, not just "is this a real browser" — the browser tier 403s the
    // same way the direct tier does. When a manual session is configured,
    // escalating to it wastes ~10s to fail identically. Fail fast and clearly.
    // Confirmed 22 Jul 2026: Cloudflare fingerprints Playwright/CDP automation
    // itself, so escalating to the OLD browser tier (browserFetchJson, which
    // uses Playwright's APIRequestContext — not the real Chromium network
    // stack either) wastes time failing the same way. The one genuinely
    // different mechanism left is fetching from INSIDE a real page, which
    // carries Chrome's actual TLS handshake. Try that once before giving up.
    if (hasSession) {
      if (is403) {
        try {
          logger.warn({ url, op }, 'Betano direct tier 403 with a session cookie — trying real-browser in-page fetch');
          return await withScrapeLog('BETANO', op, 'BROWSER', () =>
            pageFetchJson<T>(url, {
              cookieHeader: env.BETANO_SESSION_COOKIE!,
              userAgent: env.BETANO_SESSION_USER_AGENT || cfg.headers['User-Agent'] || '',
              domain: 'www.betano.ng',
              extraHeaders: { Accept: cfg.headers.Accept ?? 'application/json, text/plain, */*' },
            }),
          );
        } catch (pageErr) {
          logger.warn({ url, err: String(pageErr) }, 'in-page fetch tier also failed');
          // Only a matching 403 here actually indicates session expiry.
          // Confirmed 22 Jul 2026: a real bug (a template placeholder
          // mismatch producing a malformed URL) surfaced as a 404 through
          // this exact path, and blindly reporting "session expired" for
          // any failure here was actively misleading — the session was
          // fine, the URL was wrong. Surface the real error instead.
          const pageIs403 = pageErr instanceof Error && /HTTP 403/.test(pageErr.message);
          if (pageIs403) throw new BetanoSessionExpiredError(url);
          throw pageErr;
        }
      }
      throw err;
    }

    if (!env.BETANO_USE_BROWSER) throw err;
    logger.warn({ url, op }, 'Betano direct tier failed — escalating to browser tier');
    await warmBetanoSession();
    return withScrapeLog('BETANO', op, 'BROWSER', () => browserFetchJson<T>(url, cfg.headers));
  }
}

// ── Heuristic extraction ──────────────────────────────────────────────
// Signatures from spec §5.2.2 "Reading the output":
//   fixtures:      objects with two participant names + a start time
//   player props:  markets whose names match the marketMap, each with a
//                  handicap/line/specialBetValue and two selections

export interface BetanoFixture {
  externalId: string;
  homeName: string;
  awayName: string;
  startsAt: Date;
  raw: unknown;
}

export interface BetanoPropLine {
  playerRawName: string;
  /** Betano's own player id where available — an exact crosswalk key (§6.5 tier 1). */
  playerExternalId?: string | null;
  teamExternalId?: string | null;
  market: Market;
  rawMarketName: string;
  /** Half-point line. Milestones ("12+") are stored as 11.5 — see matchOdds.ts. */
  line: number;
  /** Betano's own label for the selection, e.g. "12+". Null for Over/Under. */
  milestoneLabel?: string | null;
  overOdds: number | null;
  underOdds: number | null;
}

const looksLikeEpoch = (n: number) => n > 1_500_000_000 && n < 4_102_444_800; // 2017..2100 (s)
const looksLikeEpochMs = (n: number) => n > 1_500_000_000_000 && n < 4_102_444_800_000;

function extractStart(obj: Record<string, unknown>): Date | null {
  for (const [k, v] of Object.entries(obj)) {
    if (!/start|time|date|kick/i.test(k)) continue;
    if (typeof v === 'number') {
      if (looksLikeEpochMs(v)) return new Date(v);
      if (looksLikeEpoch(v)) return new Date(v * 1000);
    }
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return new Date(v);
  }
  return null;
}

function extractParticipants(obj: Record<string, unknown>): { home: string; away: string } | null {
  const p = obj.participants ?? obj.competitors ?? obj.teams;
  if (Array.isArray(p) && p.length >= 2) {
    const name = (x: unknown) =>
      typeof x === 'string' ? x : String((x as Record<string, unknown>)?.name ?? '');
    const [a, b] = [name(p[0]), name(p[1])];
    if (a && b) return { home: a, away: b };
  }
  if (typeof obj.homeTeam === 'object' && typeof obj.awayTeam === 'object') {
    return {
      home: String((obj.homeTeam as Record<string, unknown>).name ?? ''),
      away: String((obj.awayTeam as Record<string, unknown>).name ?? ''),
    };
  }
  if (typeof obj.name === 'string' && / [-–] | vs\.? /i.test(obj.name)) {
    const parts = obj.name.split(/ [-–] | vs\.? /i);
    if (parts.length === 2) return { home: parts[0].trim(), away: parts[1].trim() };
  }
  return null;
}

// ── Kaizen normalized store (danae-webapi) ──────────────────────────
// Confirmed against a real capture, 20 Jul 2026: Betano.ng's platform API
// returns three flat ID-keyed maps — events, markets, selections — joined by
// marketIdList / selectionIdList. The handicap lives ON THE SELECTION
// ("Over 1.5", handicap: 1.5), not the market. A nested-walk parser sees
// nothing in this shape, so the store is detected and joined explicitly,
// with the nested heuristics kept as fallback for any other endpoint shape.

export interface KaizenStore {
  events: Record<string, any>;
  markets: Record<string, any>;
  selections: Record<string, any>;
}

const isIdMap = (v: unknown): v is Record<string, any> =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.values(v as Record<string, unknown>).every((x) => x && typeof x === 'object');

/** Find an {events, markets, selections} store anywhere in the payload. */
export function findKaizenStore(payload: unknown, depth = 0): KaizenStore | null {
  if (!payload || typeof payload !== 'object' || depth > 4) return null;
  const obj = payload as Record<string, unknown>;
  if (isIdMap(obj.events) && isIdMap(obj.markets) && isIdMap(obj.selections)) {
    return obj as unknown as KaizenStore;
  }
  for (const v of Object.values(obj)) {
    const found = findKaizenStore(v, depth + 1);
    if (found) return found;
  }
  return null;
}

const BASKETBALL_SPORT_IDS = new Set(['BASK']);

function kaizenEventIsBasketball(event: any): boolean {
  return BASKETBALL_SPORT_IDS.has(String(event?.sportId ?? '').toUpperCase()) || event?.ardSportId === 2;
}

function kaizenFixturesFromStore(store: KaizenStore): BetanoFixture[] {
  const out: BetanoFixture[] = [];
  for (const event of Object.values(store.events)) {
    if (!kaizenEventIsBasketball(event)) continue;
    const participants: any[] = Array.isArray(event.participants) ? event.participants : [];
    if (participants.length < 2) continue;
    const home = participants.find((p) => p?.isHome === true) ?? participants[0];
    const away = participants.find((p) => p?.isHome === false) ?? participants[1];
    const startsAt =
      typeof event.startTime === 'number'
        ? new Date(event.startTime > 1e12 ? event.startTime : event.startTime * 1000)
        : null;
    if (!home?.name || !away?.name || !startsAt || event.id == null) continue;
    out.push({
      externalId: String(event.id),
      homeName: String(home.name),
      awayName: String(away.name),
      startsAt,
      raw: event,
    });
  }
  return out;
}

function kaizenPropsFromStore(store: KaizenStore, marketMap: BetanoConfig['marketMap']): BetanoPropLine[] {
  const out: BetanoPropLine[] = [];
  for (const event of Object.values(store.events)) {
    if (!kaizenEventIsBasketball(event)) continue;
    const marketIds: unknown[] = Array.isArray(event.marketIdList) ? event.marketIdList : [];
    for (const marketId of marketIds) {
      const market = store.markets[String(marketId)];
      if (!market) continue;
      const rawMarketName = String(market.name ?? '');
      const matched = rawMarketName ? matchMarket(rawMarketName, marketMap) : null;
      if (!matched) continue;

      // Player name: explicit field if the platform provides one, else the
      // market name with the matched market phrase stripped off.
      const participant = String(market.participant ?? market.playerName ?? '');
      const inferred =
        participant ||
        rawMarketName
          .replace(new RegExp(marketMap.find((m) => m.market === matched)?.pattern ?? '', 'i'), '')
          .replace(/[-–—:]\s*$/, '')
          .replace(/^\s*[-–—:]/, '')
          .trim();

      const selectionIds: unknown[] = Array.isArray(market.selectionIdList) ? market.selectionIdList : [];
      const byLine = new Map<number, { over?: number; under?: number }>();
      for (const selId of selectionIds) {
        const sel = store.selections[String(selId)];
        if (!sel) continue;
        const line =
          typeof sel.handicap === 'number'
            ? sel.handicap
            : typeof market.handicap === 'number'
              ? market.handicap
              : null;
        if (line == null) continue;
        const price = typeof sel.price === 'number' ? sel.price : null;
        const label = `${sel.fullName ?? ''} ${sel.name ?? ''}`.toLowerCase();
        const bucket = byLine.get(Math.abs(line)) ?? {};
        if (/over|más|mais/.test(label)) bucket.over = price ?? undefined;
        else if (/under|menos/.test(label)) bucket.under = price ?? undefined;
        byLine.set(Math.abs(line), bucket);
      }
      for (const [line, prices] of byLine) {
        out.push({
          playerRawName: inferred,
          market: matched,
          rawMarketName,
          line,
          overOdds: prices.over ?? null,
          underOdds: prices.under ?? null,
        });
      }
    }
  }
  return out.filter((l) => l.playerRawName && Number.isFinite(l.line));
}

/** Walk any JSON payload and pull out things shaped like basketball fixtures. */
/**
 * True if this object is shaped like a betting MARKET (carries `selections`,
 * a market type code, or a market-close deadline) rather than a game/event.
 * Confirmed 22 Jul 2026: the generic fixture-heuristic walker matched a
 * "Division Winner Regular season" outright market from a bundled non-WNBA
 * competitions page — its `name` field ("...Regular season - Atlantic")
 * satisfied extractParticipants' "Team A - Team B" split, and its
 * `marketCloseTimeMillis` (a betting deadline, not a kickoff time) satisfied
 * extractStart's broad `/time/i` key match, producing a fixture dated ~10
 * months in the future. Markets carry `selections` directly; real
 * fixtures/events never do — that's a clean structural signal to reject on,
 * rather than patching individual field names or the name-splitting regex.
 */
function looksLikeMarket(obj: Record<string, unknown>): boolean {
  return (
    Array.isArray(obj.selections) ||
    typeof obj.marketCloseTimeMillis !== 'undefined' ||
    (typeof obj.typeId !== 'undefined' && typeof obj.handicap !== 'undefined')
  );
}

export function parseBetanoFixtures(payload: unknown): BetanoFixture[] {
  const store = findKaizenStore(payload);
  if (store) {
    const fromStore = kaizenFixturesFromStore(store);
    if (fromStore.length) return fromStore;
  }
  const out: BetanoFixture[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if (looksLikeMarket(obj)) {
      // Not a fixture — but still descend into it, in case (unusually) a
      // real nested fixture object sits somewhere underneath.
      Object.values(obj).forEach(walk);
      return;
    }
    const parts = extractParticipants(obj);
    const start = extractStart(obj);
    const id = obj.id ?? obj.eventId ?? obj.betRadarId;
    if (parts && start && id != null) {
      const key = String(id);
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ externalId: key, homeName: parts.home, awayName: parts.away, startsAt: start, raw: obj });
      }
      return; // don't descend into a matched fixture
    }
    Object.values(obj).forEach(walk);
  };
  walk(payload);
  return out;
}

function matchMarket(rawName: string, marketMap: BetanoConfig['marketMap']): Market | null {
  const lower = rawName.toLowerCase();
  for (const { pattern, market } of marketMap) {
    if (new RegExp(pattern, 'i').test(lower)) return market;
  }
  return null;
}

const pickNumber = (obj: Record<string, unknown>, keys: string[]): number | null => {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() && Number.isFinite(parseFloat(v))) return parseFloat(v);
  }
  return null;
};

/**
 * Parse the Players-tab payload. Market objects carry a name matching the map,
 * a line (handicap / line / specialBetValue), and selections with prices.
 * The player name is usually on the market name or a participant field.
 */
export function parseBetanoPlayerProps(payload: unknown, marketMap: BetanoConfig['marketMap']): BetanoPropLine[] {
  // Confirmed real shape first: the match-odds Players response (§5.2).
  if (isMatchOddsPayload(payload)) {
    const parsed = parseBetanoMatchOdds(payload);
    if (parsed?.props.length) {
      return parsed.props.map((p) => ({
        playerRawName: p.playerName,
        playerExternalId: p.playerId,
        teamExternalId: p.teamId,
        market: p.market,
        rawMarketName: p.rawMarketName,
        line: p.line,
        milestoneLabel: p.milestoneLabel,
        overOdds: p.overOdds,
        underOdds: p.underOdds,
      }));
    }
  }
  const store = findKaizenStore(payload);
  if (store) {
    const fromStore = kaizenPropsFromStore(store, marketMap);
    if (fromStore.length) return fromStore;
  }
  const out: BetanoPropLine[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    const rawMarketName = String(obj.name ?? obj.marketName ?? obj.title ?? '');
    const market = rawMarketName ? matchMarket(rawMarketName, marketMap) : null;
    const selections = (obj.selections ?? obj.outcomes ?? obj.results) as unknown[] | undefined;

    if (market && Array.isArray(selections) && selections.length >= 1) {
      // player name: explicit participant field, or "Caitlin Clark Player Points" style prefix
      const participant = String(obj.participant ?? obj.playerName ?? obj.player ?? '');
      const inferred = participant || rawMarketName.replace(/player.*$/i, '').replace(/[-–—]\s*$/, '').trim();

      const marketLine = pickNumber(obj, ['handicap', 'line', 'specialBetValue', 'hcp']);

      // Selections may each carry their own line (alternate ladders) or share the market's.
      const byLine = new Map<number, { over?: number; under?: number }>();
      for (const s of selections) {
        const sel = s as Record<string, unknown>;
        const selLine = pickNumber(sel, ['handicap', 'line', 'specialBetValue', 'hcp']) ?? marketLine;
        if (selLine == null) continue;
        const price = pickNumber(sel, ['price', 'odds', 'decimal', 'value']);
        const selName = String(sel.name ?? sel.type ?? '').toLowerCase();
        const bucket = byLine.get(selLine) ?? {};
        if (/over|más|mais|\+/.test(selName)) bucket.over = price ?? undefined;
        else if (/under|menos|-/.test(selName)) bucket.under = price ?? undefined;
        byLine.set(selLine, bucket);
      }
      for (const [line, prices] of byLine) {
        out.push({
          playerRawName: inferred,
          market,
          rawMarketName,
          line,
          overOdds: prices.over ?? null,
          underOdds: prices.under ?? null,
        });
      }
      return;
    }
    Object.values(obj).forEach(walk);
  };
  walk(payload);
  return out.filter((l) => l.playerRawName && Number.isFinite(l.line));
}

// ── Public surface ──────────────────────────────────────────────

/**
 * Diagnose WHY parseBetanoFixtures returned nothing, without guessing.
 * Reports whether a Kaizen store was even found, how many total events it
 * contains, how many pass the basketball filter, and — for basketball events
 * specifically — how many are missing the participants or start-time fields
 * kaizenFixturesFromStore requires. Confirmed 22 Jul 2026 as the natural next
 * question once phantom "market" fixtures were correctly rejected: 0 parsed
 * could mean "no store found", "store found but zero basketball events", or
 * "basketball events present but malformed" — three very different problems
 * that looked identical from the outside.
 */
export function debugBetanoFixtureCount(payload: unknown): Record<string, unknown> {
  const store = findKaizenStore(payload);
  if (!store) {
    const topLevelKeys = payload && typeof payload === 'object' ? Object.keys(payload as object) : [];
    return { storeFound: false, topLevelKeys };
  }
  const events = Object.values(store.events);
  const sportIdCounts = new Map<string, number>();
  let basketballCount = 0;
  let basketballMissingParticipants = 0;
  let basketballMissingStart = 0;

  for (const event of events) {
    const sportId = String((event as any)?.sportId ?? '(none)');
    sportIdCounts.set(sportId, (sportIdCounts.get(sportId) ?? 0) + 1);
    if (!kaizenEventIsBasketball(event)) continue;
    basketballCount++;
    const participants: any[] = Array.isArray((event as any).participants) ? (event as any).participants : [];
    if (participants.length < 2) basketballMissingParticipants++;
    if (typeof (event as any).startTime !== 'number') basketballMissingStart++;
  }

  return {
    storeFound: true,
    totalEvents: events.length,
    basketballEvents: basketballCount,
    basketballMissingParticipants,
    basketballMissingStart,
    sportIdBreakdown: Object.fromEntries(sportIdCounts),
  };
}

/**
 * Fetch the raw fixtures payload with no parsing at all (spec §5.2.7, added
 * 22 Jul 2026). Reuses the exact same confirmed-working session and fetch
 * path as fetchBetanoFixtures — fetching was never the problem here, only
 * parsing was, so no new manual capture is needed to see the real shape.
 */
export async function fetchBetanoRawFixturesPayload(): Promise<unknown> {
  const cfg = loadBetanoConfig();
  if (!cfg?.fixturesUrl) throw new BetanoNotConfiguredError();
  return betanoGet<unknown>(cfg.fixturesUrl, 'fixtures-raw-dump');
}

export async function fetchBetanoFixtures(): Promise<BetanoFixture[]> {
  const cfg = loadBetanoConfig();
  if (!cfg?.fixturesUrl) throw new BetanoNotConfiguredError();
  const payload = await betanoGet<unknown>(cfg.fixturesUrl, 'fixtures');
  const fixtures = parseBetanoFixtures(payload);
  logger.info({ count: fixtures.length }, 'Betano fixtures parsed');

  if (fixtures.length === 0) {
    logger.warn(debugBetanoFixtureCount(payload), 'Betano fixtures parsed as ZERO — diagnostic breakdown');
  }

  // Diagnostic (22 Jul 2026): parsed dates were ~10 months in the future,
  // suggesting either the wrong field is being read as startTime on this
  // specific competitions-list endpoint, or its scale/unit differs from the
  // single-event match-odds payload this logic was originally confirmed
  // against. Log the RAW pre-transform value alongside the parsed result so
  // the actual cause is visible rather than guessed at.
  for (const f of fixtures.slice(0, 3)) {
    const raw = f.raw as Record<string, unknown> | undefined;
    logger.info(
      {
        externalId: f.externalId,
        home: f.homeName,
        away: f.awayName,
        parsedStartsAt: f.startsAt.toISOString(),
        rawStartTime: raw?.startTime,
        rawStartTimeType: typeof raw?.startTime,
        rawKeys: raw ? Object.keys(raw) : [],
      },
      'Betano fixture raw-vs-parsed start time',
    );
  }

  return fixtures;
}

/**
 * Confirmed 22 Jul 2026: this previously used
 * `cfg.playerPropsUrlTemplate.replace('{eventId}', eventExternalId)` — but
 * the config template's actual placeholder is `{eventPath}`, not
 * `{eventId}`, so the replace matched nothing and the literal placeholder
 * text passed straight through into the request URL (a 404, misread by the
 * caller as an expired session). It was also the wrong KIND of value: Betano's
 * match-odds URL requires the full path with slug
 * (`/match-odds/team-a-team-b/12345/`), not a bare numeric ID — the slug
 * can't be reliably reconstructed from team names alone. Use the real path,
 * via the already-tested buildPlayersUrl() (confirmed working against a real
 * capture — see matchOdds.ts and its tests).
 */
export async function fetchBetanoPlayerProps(eventPath: string): Promise<BetanoPropLine[]> {
  const cfg = loadBetanoConfig();
  if (!cfg) throw new BetanoNotConfiguredError();
  const url = buildPlayersUrl(env.BETANO_BASE_URL, eventPath);
  const payload = await betanoGet<unknown>(url, 'player-props');
  const lines = parseBetanoPlayerProps(payload, cfg.marketMap);
  logger.info({ eventPath, count: lines.length }, 'Betano player props parsed');
  return lines;
}
