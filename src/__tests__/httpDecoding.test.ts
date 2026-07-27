import { describe, it, expect, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { fetchJson } from '../lib/http';

/**
 * Regression test for a real bug: undici's low-level request() does not
 * auto-decompress response bodies the way fetch() does. Sending
 * Accept-Encoding: gzip and then treating the raw bytes as UTF-8 text
 * produces the gzip magic number (0x1F 0x8B ...) escaped into the string,
 * which fails JSON.parse in a way that is easy to mistake for a malformed
 * or blocked response. This was diagnosed from a real Betano/stats.wnba.com
 * capture on 22 Jul 2026.
 */

const payload = { resultSets: [{ headers: ['PLAYER_ID'], rowSet: [[123]] }] };
const body = Buffer.from(JSON.stringify(payload));

let server: Server;
let baseUrl: string;

function startServer(): Promise<void> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      if (req.url === '/gzip') {
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
        res.end(gzipSync(body));
      } else if (req.url === '/deflate') {
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'deflate' });
        res.end(deflateSync(body));
      } else if (req.url === '/br') {
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'br' });
        res.end(brotliCompressSync(body));
      } else if (req.url === '/plain') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(body);
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

afterAll(() => {
  server?.close();
});

describe('fetchJson decompresses response bodies', () => {
  it('starts the fixture server', async () => {
    await startServer();
    expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('decodes a gzip-encoded body correctly', async () => {
    const result = await fetchJson<typeof payload>(`${baseUrl}/gzip`, { retries: 0 });
    expect(result).toEqual(payload);
  });

  it('decodes a deflate-encoded body correctly', async () => {
    const result = await fetchJson<typeof payload>(`${baseUrl}/deflate`, { retries: 0 });
    expect(result).toEqual(payload);
  });

  it('decodes a brotli-encoded body correctly', async () => {
    const result = await fetchJson<typeof payload>(`${baseUrl}/br`, { retries: 0 });
    expect(result).toEqual(payload);
  });

  it('still handles a plain uncompressed body', async () => {
    const result = await fetchJson<typeof payload>(`${baseUrl}/plain`, { retries: 0 });
    expect(result).toEqual(payload);
  });
});
