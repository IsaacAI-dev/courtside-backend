import { request, Agent } from 'undici';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
import { logger } from './logger';

export interface FetchJsonOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  /**
   * Force IPv4-only connections. Node/undici otherwise races IPv4 and IPv6
   * addresses (Happy Eyeballs); on a network with broken or slow IPv6 routing
   * (common on WSL2's virtual adapter, some ISPs) that race can throw an
   * AggregateError even though a plain IPv4 connection works fine. This is a
   * distinct failure mode from a bot gate silently withholding a response —
   * ruling it out first is cheap and avoids chasing the wrong problem.
   */
  forceIPv4?: boolean;
}

let ipv4Agent: Agent | null = null;
function getIPv4Agent(): Agent {
  if (!ipv4Agent) {
    // undici's TS types require `port` on connect options even though it
    // supplies the real port per-connection at runtime — cast rather than
    // fabricate a value that could otherwise be taken literally.
    ipv4Agent = new Agent({ connect: { family: 4 } as unknown as Agent.Options['connect'] });
  }
  return ipv4Agent;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public url: string,
    public bodySnippet: string,
  ) {
    super(`HTTP ${status} for ${url}`);
  }
}

/**
 * undici's low-level `request()` (unlike the WHATWG `fetch()` it also ships)
 * does NOT auto-decompress the body — it hands back exactly what the server
 * sent. Any server honouring `Accept-Encoding: gzip, ...` (Akamai does) will
 * return compressed bytes, and treating them as UTF-8 text produces garbage
 * that fails JSON.parse in a way that looks identical to a malformed response.
 * The tell is the gzip magic number: bytes 1F 8B 08 00 ... — exactly what a
 * failed parse will show escaped as \u001f\b\u0000\u0000....
 */
function decodeBody(raw: Buffer, contentEncoding: string): string {
  const enc = contentEncoding.toLowerCase();
  try {
    if (enc.includes('br')) return brotliDecompressSync(raw).toString('utf-8');
    if (enc.includes('gzip')) return gunzipSync(raw).toString('utf-8');
    if (enc.includes('deflate')) return inflateSync(raw).toString('utf-8');
  } catch {
    // Fall through — some servers mislabel encoding; try raw text rather than throw here.
  }
  return raw.toString('utf-8');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchJson<T = unknown>(url: string, opts: FetchJsonOptions = {}): Promise<T> {
  const { headers = {}, timeoutMs = 20_000, retries = 2, retryDelayMs = 1500, forceIPv4 = false } = opts;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await request(url, {
        method: 'GET',
        headers,
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
        ...(forceIPv4 ? { dispatcher: getIPv4Agent() } : {}),
      });
      const raw = Buffer.from(await res.body.arrayBuffer());
      const text = decodeBody(raw, String(res.headers['content-encoding'] ?? ''));
      if (res.statusCode >= 400) {
        throw new HttpError(res.statusCode, url, text.slice(0, 200));
      }
      return JSON.parse(text) as T;
    } catch (err) {
      lastErr = err;
      const status = err instanceof HttpError ? err.status : 0;
      const isAggregate = err instanceof AggregateError;
      // 403/429 are gate/rate signals — retrying makes them worse, not better.
      // An AggregateError (every resolved address failed to connect) is a
      // transport-level problem, not a rate/gate signal — worth one retry,
      // since a dual-stack race can be flaky rather than fully broken.
      if ((status === 403 || status === 429) && attempt < retries) break;
      if (attempt === retries) break;
      logger.debug(
        { url, attempt, isAggregate, err: isAggregate ? (err as AggregateError).errors?.map(String) : String(err) },
        'fetchJson retry',
      );
      await sleep(retryDelayMs * (attempt + 1));
    }
  }
  throw lastErr;
}

/** Serialised queue with jittered delay — the league stats feeds must not be parallelised. */
export class SerialQueue {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private minDelayMs: number,
    private maxDelayMs: number,
  ) {}

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(async () => {
      const delay = this.minDelayMs + Math.random() * (this.maxDelayMs - this.minDelayMs);
      await sleep(delay);
      return fn();
    });
    this.chain = next.catch(() => undefined);
    return next as Promise<T>;
  }
}
