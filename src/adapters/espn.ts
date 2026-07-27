/**
 * ESPN adapter (spec §5.5) — the corroborating layer, and the most practical
 * structured WNBA injury source, since the league publishes no injury report (§3.2.3).
 * Public, no auth. Unofficial: paths can shift, so injury extraction is defensive.
 */
import { env } from '../env';
import { fetchJson } from '../lib/http';
import { withScrapeLog } from './scrapeLog';
import type { InjuryStatusCode, LeagueId } from '../lib/types';

const seg = (league: LeagueId) => (league === 'NBA' ? 'nba' : 'wnba');

export interface EspnEvent {
  externalId: string;
  shortName: string; // "NYL @ IND"
  date: Date;
  homeAbbr: string;
  awayAbbr: string;
  status: string;
  completed: boolean;
}

export async function fetchEspnScoreboard(league: LeagueId, compactDateStr: string): Promise<EspnEvent[]> {
  const url = `${env.ESPN_BASE_URL}/${seg(league)}/scoreboard?dates=${compactDateStr}`;
  const body = await withScrapeLog('ESPN', `scoreboard:${league}`, 'DIRECT', () => fetchJson<any>(url));
  return (body.events ?? []).map((e: any) => {
    const comp = e.competitions?.[0];
    const home = comp?.competitors?.find((c: any) => c.homeAway === 'home');
    const away = comp?.competitors?.find((c: any) => c.homeAway === 'away');
    return {
      externalId: String(e.id),
      shortName: String(e.shortName ?? ''),
      date: new Date(e.date),
      homeAbbr: String(home?.team?.abbreviation ?? ''),
      awayAbbr: String(away?.team?.abbreviation ?? ''),
      status: String(e.status?.type?.name ?? ''),
      completed: Boolean(e.status?.type?.completed),
    };
  });
}

export interface EspnTeam {
  externalId: string;
  displayName: string;
  abbreviation: string;
  logoUrl: string | null;
}

export async function fetchEspnTeams(league: LeagueId): Promise<EspnTeam[]> {
  const url = `${env.ESPN_BASE_URL}/${seg(league)}/teams`;
  const body = await withScrapeLog('ESPN', `teams:${league}`, 'DIRECT', () => fetchJson<any>(url));
  const teams = body.sports?.[0]?.leagues?.[0]?.teams ?? [];
  return teams.map((t: any) => ({
    externalId: String(t.team.id),
    displayName: String(t.team.displayName),
    abbreviation: String(t.team.abbreviation),
    logoUrl: t.team.logos?.[0]?.href ?? null,
  }));
}

export interface EspnRosterAthlete {
  externalId: string;
  fullName: string;
  position: string | null;
  jersey: string | null;
  headshotUrl: string | null;
}

export async function fetchEspnRoster(league: LeagueId, espnTeamId: string): Promise<EspnRosterAthlete[]> {
  const url = `${env.ESPN_BASE_URL}/${seg(league)}/teams/${espnTeamId}/roster`;
  const body = await withScrapeLog('ESPN', `roster:${league}`, 'DIRECT', () => fetchJson<any>(url));
  const athletes = body.athletes ?? [];
  return athletes.map((a: any) => ({
    externalId: String(a.id),
    fullName: String(a.fullName ?? a.displayName ?? ''),
    position: a.position?.abbreviation ?? null,
    jersey: a.jersey ?? null,
    headshotUrl: a.headshot?.href ?? null,
  }));
}

export interface EspnInjury {
  athleteExternalId: string;
  athleteName: string;
  status: InjuryStatusCode;
  detail: string | null;
  reportedAt: Date;
}

const STATUS_MAP: Record<string, InjuryStatusCode> = {
  out: 'OUT',
  'injured reserve': 'OUT',
  doubtful: 'DOUBTFUL',
  questionable: 'QUESTIONABLE',
  probable: 'PROBABLE',
  'day-to-day': 'QUESTIONABLE',
  active: 'ACTIVE',
  suspension: 'SUSPENDED',
};

function mapStatus(raw: string): InjuryStatusCode {
  return STATUS_MAP[raw.trim().toLowerCase()] ?? 'QUESTIONABLE';
}

/**
 * Injury probe (spec §5.5): ESPN moves this data around, so we fetch team detail
 * and walk the tree for any `injuries` arrays rather than trusting one fixed path.
 */
export async function fetchEspnTeamInjuries(league: LeagueId, espnTeamId: string): Promise<EspnInjury[]> {
  const url = `${env.ESPN_BASE_URL}/${seg(league)}/teams/${espnTeamId}`;
  const body = await withScrapeLog('ESPN', `injuries:${league}`, 'DIRECT', () => fetchJson<any>(url));
  const found: EspnInjury[] = [];

  const walk = (node: any): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.injuries)) {
      for (const inj of node.injuries) {
        const athlete = inj.athlete ?? node.athlete ?? {};
        const statusRaw = inj.status ?? inj.type?.description ?? '';
        if (!athlete.id && !inj.athlete) continue;
        found.push({
          athleteExternalId: String(athlete.id ?? ''),
          athleteName: String(athlete.displayName ?? athlete.fullName ?? ''),
          status: mapStatus(String(statusRaw)),
          detail: inj.details?.type ?? inj.shortComment ?? inj.longComment ?? null,
          reportedAt: inj.date ? new Date(inj.date) : new Date(),
        });
      }
    }
    for (const v of Object.values(node)) {
      if (v && typeof v === 'object') walk(v);
    }
  };
  walk(body);
  return found.filter((i) => i.athleteExternalId);
}

export interface EspnBoxLine {
  athleteExternalId: string;
  athleteName: string;
  minutes: number;
  points: number;
  assists: number;
  rebounds: number;
  threesMade: number;
}

/** Settlement fallback — note the different host (site.web.api). */
export async function fetchEspnSummary(league: LeagueId, espnEventId: string): Promise<EspnBoxLine[]> {
  const url = `${env.ESPN_SUMMARY_BASE_URL}/${seg(league)}/summary?event=${espnEventId}`;
  const body = await withScrapeLog('ESPN', `summary:${league}`, 'DIRECT', () => fetchJson<any>(url));
  const out: EspnBoxLine[] = [];
  const players = body.boxscore?.players ?? [];
  for (const teamBlock of players) {
    for (const stat of teamBlock.statistics ?? []) {
      const labels: string[] = stat.labels ?? [];
      const idx = (label: string) => labels.findIndex((l) => l.toUpperCase() === label);
      const iMin = idx('MIN');
      const iPts = idx('PTS');
      const iAst = idx('AST');
      const iReb = idx('REB');
      const i3pt = idx('3PT');
      for (const a of stat.athletes ?? []) {
        const s: string[] = a.stats ?? [];
        if (!s.length) continue;
        const three = i3pt >= 0 ? s[i3pt] : '0-0';
        out.push({
          athleteExternalId: String(a.athlete?.id ?? ''),
          athleteName: String(a.athlete?.displayName ?? ''),
          minutes: parseFloat(s[iMin] ?? '0') || 0,
          points: parseInt(s[iPts] ?? '0', 10) || 0,
          assists: parseInt(s[iAst] ?? '0', 10) || 0,
          rebounds: parseInt(s[iReb] ?? '0', 10) || 0,
          threesMade: parseInt(String(three).split('-')[0] ?? '0', 10) || 0,
        });
      }
    }
  }
  return out;
}
