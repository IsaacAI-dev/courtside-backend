import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { fetchSofaTopPlayersSquad as FetchSquadFn, resolveCurrentSeasonId as ResolveSeasonFn } from '../adapters/sofascore';

// withScrapeLog persists to the real database — irrelevant to what this test
// verifies (the squad-union parsing logic), and not configured in this run.
vi.mock('../adapters/scrapeLog', () => ({
  withScrapeLog: async (_source: string, _op: string, _tier: string, fn: () => Promise<unknown>) => fn(),
}));

/**
 * Fixture mirrors the real shape confirmed 22 Jul 2026 (Minnesota Lynx
 * top-players/regularSeason): the 12 "full roster" categories each list every
 * player who logged minutes, spread across different sort orders, while the
 * percentage-based categories (fieldGoalsPercentage etc.) are genuinely
 * partial — qualified/limited lists that must NOT be relied on for squad
 * membership. Real player ids/names from the capture; distributed across
 * categories so the union — not any single array — is what proves complete.
 */
const players = {
  miles: { id: 1194939, name: 'Olivia Miles', position: 'G' },
  howard: { id: 1202839, name: 'Natasha Howard', position: 'F' },
  mcbride: { id: 1202795, name: 'Kayla McBride', position: 'G' },
  williams: { id: 1215227, name: 'Courtney Williams', position: 'G' },
  coffey: { id: 1202948, name: 'Nia Coffey', position: 'F' },
  juhasz: { id: 1563875, name: 'Dorka Juhasz', position: 'F' },
  kosu: { id: 2122568, name: 'Anastasiia Olairi Kosu', position: 'F' },
  hamzova: { id: 1501201, name: 'Eliska Hamzova', position: 'G' },
  caldwell: { id: 1202954, name: 'Maya Caldwell', position: 'G' },
  delaere: { id: 1409252, name: 'Antonia Delaere', position: 'F' },
  cechova: { id: 1501199, name: 'Emma Cechova', position: 'F' },
  mccowan: { id: 1202895, name: 'Teaira McCowan', position: 'C' },
  king: { id: 1208611, name: 'Liatu King', position: 'F' },
  hof: { id: 1563804, name: 'Emese Hof', position: 'FC' },
};

const entry = (p: { id: number; name: string; position: string }, value: number) => ({
  statistics: { [Object.keys({ value })[0]]: value },
  player: { id: p.id, name: p.name, position: p.position },
});

// Each full category deliberately holds a different subset — the union of
// all 12 must still recover the complete 14-player roster.
const topPlayers = {
  points: Object.values(players).slice(0, 10).map((p) => entry(p, 1)),
  rebounds: Object.values(players).slice(2, 12).map((p) => entry(p, 1)),
  assists: Object.values(players).slice(4, 14).map((p) => entry(p, 1)),
  secondsPlayed: [players.mccowan, players.king, players.hof].map((p) => entry(p, 1)),
  steals: [players.miles].map((p) => entry(p, 1)),
  blocks: [players.howard].map((p) => entry(p, 1)),
  turnovers: [players.mcbride].map((p) => entry(p, 1)),
  plusMinus: [players.williams].map((p) => entry(p, 1)),
  defensiveRebounds: [players.coffey].map((p) => entry(p, 1)),
  offensiveRebounds: [players.juhasz].map((p) => entry(p, 1)),
  rating: [players.kosu].map((p) => entry(p, 1)),
  assistTurnoverRatio: [players.hamzova].map((p) => entry(p, 1)),
  // Genuinely partial — must be ignored. Contains a player who does NOT
  // appear anywhere above, proving that name is correctly excluded.
  fieldGoalsPercentage: [
    entry(players.cechova, 1),
    entry({ id: 9999999, name: 'Ghost Player', position: 'G' }, 1),
  ],
  doubleDoubles: [entry(players.howard, 1)],
};

let server: Server;
let baseUrl: string;
let fetchSofaTopPlayersSquad: typeof FetchSquadFn;
let resolveCurrentSeasonId: typeof ResolveSeasonFn;

function startServer(): Promise<void> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      if (req.url?.includes('/top-players/regularSeason')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ topPlayers }));
      } else if (req.url?.includes('/seasons')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            seasons: [
              { id: 89004, name: 'WNBA 2026', year: '2026' },
              { id: 79001, name: 'WNBA 2025', year: '2025' },
            ],
          }),
        );
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

// env.ts parses process.env exactly once, at import time. Setting
// SOFASCORE_BASE_URL after a static import would be too late — the module
// must not be imported until the fixture server's real port is known and the
// env var is set, hence the dynamic import in beforeAll rather than a static
// one at the top of the file.
beforeAll(async () => {
  await startServer();
  process.env.SOFASCORE_BASE_URL = `${baseUrl}/api/v1`;
  const mod = await import('../adapters/sofascore');
  fetchSofaTopPlayersSquad = mod.fetchSofaTopPlayersSquad;
  resolveCurrentSeasonId = mod.resolveCurrentSeasonId;
});

describe('SofaScore top-players squad union', () => {
  it('resolves the current (first-listed) season, not a hardcoded one', async () => {
    const seasonId = await resolveCurrentSeasonId(486);
    expect(seasonId).toBe(89004);
  });

  it('unions the 12 full-roster categories into the complete 14-player squad', async () => {
    const squad = await fetchSofaTopPlayersSquad('3440', 486, 89004);
    expect(squad).toHaveLength(14);
    const ids = new Set(squad.map((p) => p.externalId));
    for (const p of Object.values(players)) {
      expect(ids.has(String(p.id))).toBe(true);
    }
  });

  it('never includes a player who only appears in a percentage-only category', async () => {
    const squad = await fetchSofaTopPlayersSquad('3440', 486, 89004);
    expect(squad.some((p) => p.externalId === '9999999')).toBe(false);
  });

  it('deduplicates a player who appears in multiple categories', async () => {
    const squad = await fetchSofaTopPlayersSquad('3440', 486, 89004);
    const howardEntries = squad.filter((p) => p.externalId === String(players.howard.id));
    expect(howardEntries).toHaveLength(1);
    expect(howardEntries[0].name).toBe('Natasha Howard');
    expect(howardEntries[0].position).toBe('F');
  });

  it('cleans up the fixture server', () => {
    server?.close();
  });
});
