/**
 * Betano `match-odds` parser — the Players tab (spec §5.2, confirmed 21 Jul 2026).
 *
 * Endpoint, captured live:
 *   /api/match-odds/{slug}/{eventId}/?bt=1&isPlayersToggle=true&req=la,s,stnf,c,mb,mbl
 *
 * This is a THIRD payload shape, distinct from the danae normalized store:
 *   data.event.markets is a flat ARRAY, each market owning its selections inline,
 *   and — critically — each market carries `playerId` and `teamId` directly.
 *
 * ── The milestone problem ────────────────────────────────────────────────
 * Betano does NOT price these as Over/Under. Selections are milestones:
 * "12+", "13+", "14+" … meaning "12 or more". There is no Under side and no
 * price for one.
 *
 * Since points, assists, rebounds and threes are all integers, a milestone is
 * exactly equivalent to a half-point Over:
 *
 *     "12+"  ⟺  value >= 12  ⟺  value > 11.5  ⟺  Over 11.5
 *
 * So every milestone is stored as line = n − 0.5. That conversion is lossless
 * for integer stats and leaves every downstream calculation — hit-rate curves,
 * cushion z-scores, line selection, settlement — correct and untouched. It also
 * removes pushes entirely: a half-point line cannot be pushed. The original
 * label ("12+") is preserved for display and audit, because that is what the
 * user actually clicks on the site.
 */
import type { Market } from '../../lib/types';

/** Confirmed Kaizen market type codes for basketball player props. */
export const BETANO_MARKET_TYPES: Record<string, Market> = {
  PLNP: 'POINTS', // typeId 1856 — "{Player} Total Points"
  PALA: 'ASSISTS', // typeId 1853 — "{Player} Total Assists"
  PLTR: 'REBOUNDS', // typeId 1858 — "{Player} Total Rebounds"
  P3PG: 'THREES', // typeId 1852 — "{Player} Total Three Point Shots Scored"
};

export const BETANO_MARKET_TYPE_IDS: Record<number, Market> = {
  1856: 'POINTS',
  1853: 'ASSISTS',
  1858: 'REBOUNDS',
  1852: 'THREES',
};

/**
 * Priced player markets Betano also offers that sit outside the four Courtside
 * analyses. Recorded so the board is auditable and so expansion is a config
 * change rather than a rediscovery exercise.
 */
export const BETANO_OTHER_PLAYER_TYPES: Record<string, string> = {
  BPRA: 'Points+Rebounds+Assists (typeId 3096)',
  BBRA: 'Rebounds+Assists (typeId 3095)',
  X035: 'Double-Double (typeId 1797)',
  X043: 'Top Points Scorer (typeId 2021)',
  X046: 'Top Rebounder (typeId 2020)',
  X238: 'Top Three Point Scorer (typeId 1979)',
  '4748': 'Points H2H (typeId 4748)',
  '4930': 'Rebounds H2H (typeId 4930)',
  '4935': 'Three Point Shots H2H (typeId 4935)',
};

export interface BetanoRosterPlayer {
  playerId: string;
  name: string;
  shortName: string | null;
  teamId: string;
  teamName: string;
  isHome: boolean;
}

export interface BetanoMatchOddsProp {
  /** Betano's own player id — an exact crosswalk key, no name matching needed. */
  playerId: string;
  playerName: string;
  teamId: string | null;
  market: Market;
  marketType: string;
  marketTypeId: number;
  rawMarketName: string;
  /** Half-point equivalent line. "12+" is stored as 11.5. */
  line: number;
  /** The label Betano shows, e.g. "12+". Null for genuine Over/Under markets. */
  milestoneLabel: string | null;
  selectionId: string;
  overOdds: number | null;
  underOdds: number | null;
  isMilestone: boolean;
}

export interface BetanoMatchOdds {
  eventId: string;
  /** e.g. /match-odds/golden-state-valkyries-w-washington-mystics-w/88623579/ */
  eventPath: string | null;
  name: string;
  startsAt: Date | null;
  marketCloseAt: Date | null;
  leagueName: string | null;
  leagueId: string | null;
  regionId: string | null;
  betRadarId: number | null;
  totalMarketsAvailable: number;
  homeTeam: { id: string; name: string } | null;
  awayTeam: { id: string; name: string } | null;
  roster: BetanoRosterPlayer[];
  props: BetanoMatchOddsProp[];
  /** Priced player markets we saw but do not model — for auditing and expansion. */
  otherPlayerMarkets: Array<{ type: string; typeId: number; name: string }>;
}

/** Is this the match-odds Players payload? */
export function isMatchOddsPayload(payload: unknown): boolean {
  const event = (payload as any)?.data?.event;
  return !!event && Array.isArray(event.markets) && event.id != null;
}

const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
};

const MILESTONE_RE = /^(\d+(?:\.\d+)?)\s*\+$/;
const OVER_RE = /^over\b/i;
const UNDER_RE = /^under\b/i;

/**
 * Convert a selection into a half-point line.
 * Milestone "12+" → 11.5. Over/Under "Over 18.5" → 18.5.
 */
export function selectionToLine(
  selectionName: string,
  handicap: number | null,
): { line: number; milestoneLabel: string | null; side: 'OVER' | 'UNDER' } | null {
  const name = selectionName.trim();

  const milestone = name.match(MILESTONE_RE);
  if (milestone) {
    const threshold = handicap ?? Number(milestone[1]);
    if (!Number.isFinite(threshold)) return null;
    // "n or more" ⟺ "> n − 0.5" for integer-valued stats.
    return { line: threshold - 0.5, milestoneLabel: name, side: 'OVER' };
  }

  if (OVER_RE.test(name)) {
    const line = handicap ?? num(name.replace(/^over\s*/i, ''));
    return line == null ? null : { line, milestoneLabel: null, side: 'OVER' };
  }
  if (UNDER_RE.test(name)) {
    const line = handicap ?? num(name.replace(/^under\s*/i, ''));
    return line == null ? null : { line, milestoneLabel: null, side: 'UNDER' };
  }
  return null;
}

function extractRoster(payload: any): BetanoRosterPlayer[] {
  const roster = payload?.data?.playersTabFilters?.roster;
  if (!roster) return [];
  const out: BetanoRosterPlayer[] = [];
  for (const [key, isHome] of [
    ['homeRoster', true],
    ['awayRoster', false],
  ] as const) {
    const side = roster[key];
    if (!side?.players) continue;
    const teamId = String(side.id ?? '');
    const teamName = String(side.name ?? '');
    for (const p of Object.values<any>(side.players)) {
      if (p?.id == null) continue;
      out.push({
        playerId: String(p.id),
        name: String(p.name ?? ''),
        shortName: p.shortName ? String(p.shortName) : null,
        teamId,
        teamName,
        isHome,
      });
    }
  }
  return out;
}

export function parseBetanoMatchOdds(payload: unknown): BetanoMatchOdds | null {
  if (!isMatchOddsPayload(payload)) return null;
  const root = payload as any;
  const event = root.data.event;

  const roster = extractRoster(root);
  const rosterById = new Map(roster.map((r) => [r.playerId, r]));

  // Home/away comes from the roster, which states it explicitly. The
  // participants array does not carry an isHome flag, and inferring it from
  // the "A - B" name ordering would be a guess.
  const homeRoster = roster.find((r) => r.isHome);
  const awayRoster = roster.find((r) => !r.isHome);
  const participants: any[] = Array.isArray(event.participants) ? event.participants : [];
  const byId = new Map(participants.map((p) => [String(p.id), String(p.name ?? '')]));

  const homeTeam = homeRoster
    ? { id: homeRoster.teamId, name: byId.get(homeRoster.teamId) ?? homeRoster.teamName }
    : participants[0]
      ? { id: String(participants[0].id), name: String(participants[0].name ?? '') }
      : null;
  const awayTeam = awayRoster
    ? { id: awayRoster.teamId, name: byId.get(awayRoster.teamId) ?? awayRoster.teamName }
    : participants[1]
      ? { id: String(participants[1].id), name: String(participants[1].name ?? '') }
      : null;

  const props: BetanoMatchOddsProp[] = [];
  const otherPlayerMarkets: Array<{ type: string; typeId: number; name: string }> = [];

  for (const market of event.markets as any[]) {
    const type = String(market?.type ?? '');
    const typeId = Number(market?.typeId ?? 0);
    const rawMarketName = String(market?.name ?? '');
    const mapped = BETANO_MARKET_TYPES[type] ?? BETANO_MARKET_TYPE_IDS[typeId] ?? null;

    if (!mapped) {
      if (BETANO_OTHER_PLAYER_TYPES[type] || market?.playerId != null) {
        otherPlayerMarkets.push({ type, typeId, name: rawMarketName });
      }
      continue;
    }

    // playerId on the market is the crosswalk key — far stronger than parsing
    // the player's name out of "Sonia Citron Total Points".
    const playerId = market?.playerId != null ? String(market.playerId) : '';
    if (!playerId) continue;
    const rosterEntry = rosterById.get(playerId);
    const playerName =
      rosterEntry?.name ??
      rawMarketName.replace(/\s*Total\s+.*$/i, '').trim() ??
      '';

    // Group selections by line so both sides of an Over/Under land together.
    const byLine = new Map<
      number,
      { over?: number; under?: number; label: string | null; selectionId: string; milestone: boolean }
    >();

    for (const sel of (market?.selections ?? []) as any[]) {
      const selName = String(sel?.name ?? '');
      const handicap = num(sel?.handicap);
      const price = num(sel?.price);
      if (price == null) continue;

      const parsed = selectionToLine(selName, handicap);
      if (!parsed) continue;

      const bucket = byLine.get(parsed.line) ?? {
        label: parsed.milestoneLabel,
        selectionId: String(sel?.id ?? ''),
        milestone: parsed.milestoneLabel != null,
      };
      if (parsed.side === 'OVER') bucket.over = price;
      else bucket.under = price;
      if (parsed.milestoneLabel) bucket.label = parsed.milestoneLabel;
      if (!bucket.selectionId) bucket.selectionId = String(sel?.id ?? '');
      byLine.set(parsed.line, bucket);
    }

    for (const [line, bucket] of byLine) {
      props.push({
        playerId,
        playerName,
        teamId: market?.teamId != null ? String(market.teamId) : (rosterEntry?.teamId ?? null),
        market: mapped,
        marketType: type,
        marketTypeId: typeId,
        rawMarketName,
        line,
        milestoneLabel: bucket.label,
        selectionId: bucket.selectionId,
        overOdds: bucket.over ?? null,
        underOdds: bucket.under ?? null,
        isMilestone: bucket.milestone,
      });
    }
  }

  return {
    eventId: String(event.id),
    eventPath: event.url ? String(event.url) : null,
    name: String(event.name ?? event.shortName ?? ''),
    startsAt: event.startTime ? new Date(Number(event.startTime)) : null,
    marketCloseAt: event.markets?.[0]?.marketCloseTimeMillis
      ? new Date(Number(event.markets[0].marketCloseTimeMillis))
      : null,
    leagueName: event.leagueName ? String(event.leagueName) : null,
    leagueId: event.leagueId ? String(event.leagueId) : null,
    regionId: event.regionId ? String(event.regionId) : null,
    betRadarId: event.betRadarId != null ? Number(event.betRadarId) : null,
    totalMarketsAvailable: Number(event.totalMarketsAvailable ?? 0),
    homeTeam,
    awayTeam,
    roster,
    props,
    otherPlayerMarkets,
  };
}

/**
 * Build the Players-tab URL for an event. The path comes from the event record
 * (`/match-odds/{slug}/{id}/` pre-match, `/live/{slug}/{id}/` in-play), so the
 * slug never has to be reconstructed from team names.
 */
export function buildPlayersUrl(baseUrl: string, eventPath: string): string {
  const path = eventPath.startsWith('/') ? eventPath : `/${eventPath}`;
  return `${baseUrl.replace(/\/$/, '')}/api${path}?bt=1&isPlayersToggle=true&req=la,s,stnf,c,mb,mbl`;
}
