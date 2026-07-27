import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { fetchSofaUpcomingEvents as FetchUpcomingFn } from '../adapters/sofascore';

vi.mock('../adapters/scrapeLog', () => ({
  withScrapeLog: async (_s: string, _o: string, _t: string, fn: () => Promise<unknown>) => fn(),
}));

// Mock the in-page fetch tier itself (already verified separately, in
// src/__tests__ history, against a real local HTTPS server). What THIS test
// verifies is different: that sofaGet's catch block actually calls it, with
// the right session cookie/UA/domain, when the direct tier 403s — and that
// it falls back correctly if the in-page tier also fails.
const pageFetchJsonMock = vi.fn();
vi.mock('../adapters/betano/browser', () => ({
  browserFetchJson: vi.fn(),
  pageFetchJson: (...args: unknown[]) => pageFetchJsonMock(...args),
}));

let server: Server;
let baseUrl: string;
let fetchSofaUpcomingEvents: typeof FetchUpcomingFn;

function startServer(): Promise<void> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      // The direct (undici) tier always 403s — reproducing exactly what was
      // observed: a session that's valid in Postman but rejected here.
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 403, reason: 'Forbidden' } }));
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
  process.env.SOFASCORE_SESSION_COOKIE = 'sessionToken=abc123; other=xyz';
  process.env.SOFASCORE_SESSION_USER_AGENT = 'Mozilla/5.0 (TestAgent/9.9)';
  const mod = await import('../adapters/sofascore');
  fetchSofaUpcomingEvents = mod.fetchSofaUpcomingEvents;
});

describe('SofaScore escalates to the real in-page fetch tier on 403', () => {
  it('calls pageFetchJson with the configured session cookie, UA, and the right domain', async () => {
    pageFetchJsonMock.mockResolvedValueOnce({ events: [] });
    await fetchSofaUpcomingEvents(486, 89004);

    expect(pageFetchJsonMock).toHaveBeenCalledTimes(1);
    const [, opts] = pageFetchJsonMock.mock.calls[0];
    expect(opts.cookieHeader).toBe('sessionToken=abc123; other=xyz');
    expect(opts.userAgent).toBe('Mozilla/5.0 (TestAgent/9.9)');
    expect(opts.domain).toBe('www.sofascore.com');
  });

  it('returns the in-page fetch result when it succeeds', async () => {
    pageFetchJsonMock.mockResolvedValueOnce({ events: [{ id: 1 }] });
    const events = await fetchSofaUpcomingEvents(486, 89004);
    // fetchSofaUpcomingEvents maps the raw events array; presence of one
    // mapped entry proves the in-page tier's result was actually used.
    expect(events).toHaveLength(1);
  });

  it('throws SofaScoreSessionExpiredError when the in-page tier ALSO gets a matching 403', async () => {
    pageFetchJsonMock.mockRejectedValueOnce(new Error('pageFetchJson: HTTP 403 for https://example.com'));
    await expect(fetchSofaUpcomingEvents(486, 89004)).rejects.toThrow(/session cookie/);
  });

  it('does NOT claim session expiry for a non-403 failure — surfaces the real error instead', async () => {
    // Confirmed 22 Jul 2026: a real bug had ANY in-page-fetch failure
    // reported as "session expired", which was actively misleading when the
    // real failure was e.g. a 404 (lineups not yet published for a future
    // game) — nothing to do with the session at all.
    pageFetchJsonMock.mockRejectedValueOnce(new Error('pageFetchJson: HTTP 404 for https://example.com'));
    let caught: unknown;
    try {
      await fetchSofaUpcomingEvents(486, 89004);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/HTTP 404/);
    expect((caught as Error).message).not.toMatch(/session cookie/);
  });

  it('cleans up', () => {
    server?.close();
  });
});
