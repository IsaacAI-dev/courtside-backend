import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { fetchBetanoPlayerProps as FetchPropsFn } from '../adapters/betano/adapter';

vi.mock('../adapters/scrapeLog', () => ({
  withScrapeLog: async (_s: string, _o: string, _t: string, fn: () => Promise<unknown>) => fn(),
}));

/**
 * Regression test for a real bug (22 Jul 2026): fetchBetanoPlayerProps used
 * to build its URL via `cfg.playerPropsUrlTemplate.replace('{eventId}', id)`
 * — but the config's actual placeholder is `{eventPath}`, which doesn't
 * appear in that call at all, so .replace() matched nothing and the literal
 * placeholder text passed straight through into a real request, producing a
 * 404 that the error handler then misreported as an expired session. Fixed
 * by using the real event path (e.g. "/match-odds/washington-mystics-w-
 * connecticut-sun-w/89034718/", taken verbatim from a real captured event)
 * via the already-tested buildPlayersUrl(), which correctly needs the full
 * path with slug — not a bare numeric ID, which Betano's URL can't be built
 * from alone.
 */
let server: Server;
let baseUrl: string;
let requestedUrls: string[] = [];
let fetchBetanoPlayerProps: typeof FetchPropsFn;

const realEventPath = '/match-odds/washington-mystics-w-connecticut-sun-w/89034718/';

function startServer(): Promise<void> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      requestedUrls.push(req.url ?? '');
      if (req.url?.includes('{eventPath}') || req.url?.includes('{eventId}')) {
        // A literal, unsubstituted placeholder reaching the server at all
        // reproduces the exact real bug — respond 404 like the real API did.
        res.writeHead(404);
        res.end();
        return;
      }
      if (req.url?.startsWith('/api' + realEventPath)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: { event: { id: '89034718', markets: [] } } }));
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
  process.env.BETANO_BASE_URL = baseUrl;
  const mod = await import('../adapters/betano/adapter');
  fetchBetanoPlayerProps = mod.fetchBetanoPlayerProps;
});

describe('fetchBetanoPlayerProps builds the URL from a real event path, not a broken template', () => {
  it('never sends a literal unsubstituted placeholder to the server', async () => {
    requestedUrls = [];
    await fetchBetanoPlayerProps(realEventPath);
    expect(requestedUrls.some((u) => u.includes('{eventPath}') || u.includes('{eventId}'))).toBe(false);
  });

  it('requests the exact real event path with the slug intact', async () => {
    requestedUrls = [];
    await fetchBetanoPlayerProps(realEventPath);
    expect(requestedUrls.some((u) => u.includes('washington-mystics-w-connecticut-sun-w'))).toBe(true);
    expect(requestedUrls.some((u) => u.includes('89034718'))).toBe(true);
  });

  it('cleans up', () => {
    server?.close();
  });
});
