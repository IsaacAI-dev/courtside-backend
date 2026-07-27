import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type {
  fetchSofaPlayerStatsForSquad as FetchStatsFn,
  fetchSofaUpcomingEvents as FetchUpcomingFn,
} from '../adapters/sofascore';
import type { SofaSquadPlayer } from '../adapters/sofascore';

vi.mock('../adapters/scrapeLog', () => ({
  withScrapeLog: async (_s: string, _o: string, _t: string, fn: () => Promise<unknown>) => fn(),
}));

let server: Server;
let baseUrl: string;
let callTimestamps: number[] = [];
let fetchSofaPlayerStatsForSquad: typeof FetchStatsFn;
let fetchSofaUpcomingEvents: typeof FetchUpcomingFn;

const squad: SofaSquadPlayer[] = Array.from({ length: 7 }, (_, i) => ({
  externalId: String(1000 + i),
  name: `Player ${i}`,
  position: 'G',
  jerseyNumber: null,
}));

function startServer(): Promise<void> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      if (req.url?.includes('/player/')) {
        callTimestamps.push(Date.now());
        const playerId = req.url.match(/\/player\/(\d+)/)?.[1];
        // Player 1003 simulates a genuine failure — the batch must continue
        // past it rather than aborting.
        if (playerId === '1003') {
          res.writeHead(500);
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            statistics: { secondsPlayed: 1200, points: 10, assists: 2, rebounds: 4, threePointsMade: 1 },
          }),
        );
        return;
      }
      if (req.url?.includes('/events/next/0')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ events: [] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

beforeAll(async () => {
  await startServer();
  process.env.SOFASCORE_BASE_URL = `${baseUrl}/api/v1`;
  const mod = await import('../adapters/sofascore');
  fetchSofaPlayerStatsForSquad = mod.fetchSofaPlayerStatsForSquad;
  fetchSofaUpcomingEvents = mod.fetchSofaUpcomingEvents;
});

describe('SofaScore player-stats pacing', () => {
  it('pauses at least once for every 3-5 calls, never firing all calls back-to-back', async () => {
    callTimestamps = [];
    const results = await fetchSofaPlayerStatsForSquad('99999', squad);

    // 6 successful players out of 7 (one simulated failure) — failure must
    // not abort the batch.
    expect(results).toHaveLength(6);

    // With 7 calls and a pause every 3-5, there must be at least one gap.
    const gaps = callTimestamps.slice(1).map((t, i) => t - callTimestamps[i]);
    const pausedGaps = gaps.filter((g) => g >= 1900); // pause is randomised 2000-5000ms
    expect(pausedGaps.length).toBeGreaterThanOrEqual(1);
  }, 20_000);

  it('skips a failing player without aborting the rest of the squad', async () => {
    const results = await fetchSofaPlayerStatsForSquad('99999', squad);
    const ids = results.map((r) => r.playerExternalId);
    expect(ids).not.toContain('1003');
    expect(ids).toContain('1006'); // players after the failure still fetched
  }, 20_000);

  it('parses returned statistics into the expected shape', async () => {
    const results = await fetchSofaPlayerStatsForSquad('99999', squad.slice(0, 1));
    expect(results[0]).toMatchObject({
      minutes: 20,
      points: 10,
      assists: 2,
      rebounds: 4,
      threesMade: 1,
      didNotPlay: false,
    });
  }, 20_000);

  it('an empty upcoming-events response parses to an empty array, not an error', async () => {
    const events = await fetchSofaUpcomingEvents(486, 89004);
    expect(events).toEqual([]);
  });

  it('cleans up', () => {
    server?.close();
  });
});
