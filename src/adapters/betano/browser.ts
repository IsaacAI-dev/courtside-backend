/**
 * Browser tier (spec §5.2.3). A persistent Playwright context whose page.request
 * carries the Cloudflare clearance cookie a bare HTTP client can never have.
 * Playwright is an optional dependency — everything degrades cleanly without it.
 */
import { env } from '../../env';
import { logger } from '../../lib/logger';

type BrowserContext = any; // typed loosely so the package stays optional

let contextPromise: Promise<BrowserContext> | null = null;

async function getContext(): Promise<BrowserContext> {
  if (!contextPromise) {
    contextPromise = (async () => {
      let chromium: any;
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        ({ chromium } = require('playwright'));
      } catch {
        throw new Error(
          'playwright is not installed. Run `npm i playwright && npx playwright install chromium` to enable the browser tier.',
        );
      }
      const ctx = await chromium.launchPersistentContext(env.PLAYWRIGHT_USER_DATA_DIR, {
        headless: env.PLAYWRIGHT_HEADLESS,
        viewport: { width: 1366, height: 860 },
        locale: 'en-NG',
        timezoneId: 'Africa/Lagos',
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      });
      logger.info('Playwright persistent context launched');
      return ctx;
    })();
    contextPromise.catch(() => {
      contextPromise = null;
    });
  }
  return contextPromise;
}

/**
 * Warm the Cloudflare clearance by visiting the site once per process.
 * Idempotent; call before the first Betano request of a run.
 */
let warmed = false;
export async function warmBetanoSession(): Promise<void> {
  if (warmed) return;
  const ctx = await getContext();
  const page = await ctx.newPage();
  try {
    await page.goto(`${env.BETANO_BASE_URL}/sport/basketball/`, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });
    await page.waitForTimeout(3000 + Math.random() * 2000);
    warmed = true;
  } finally {
    await page.close();
  }
}

/**
 * Fetch JSON through the browser context's APIRequestContext.
 *
 * IMPORTANT CAVEAT, confirmed 22 Jul 2026: `ctx.request` is Playwright's own
 * convenience HTTP client bolted onto the browser process — it does NOT
 * route through Chromium's real network stack, so it does NOT carry a real
 * browser's TLS fingerprint either. It inherits cookies from the context,
 * but nothing more. If Cloudflare is binding a clearance token to the TLS
 * handshake itself (not just headers), this tier fails the same way a bare
 * HTTP client does. See pageFetchJson() below for the tier that actually
 * uses the real browser network stack.
 */
export async function browserFetchJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const ctx = await getContext();
  const res = await ctx.request.get(url, { headers, timeout: 30_000 });
  if (!res.ok()) {
    const err = new Error(`browser fetch ${res.status()} for ${url}`) as Error & { status: number };
    err.status = res.status();
    throw err;
  }
  return (await res.json()) as T;
}

function parseCookieHeader(cookieHeader: string): Array<{ name: string; value: string }> {
  return cookieHeader
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.indexOf('=');
      return { name: pair.slice(0, idx).trim(), value: pair.slice(idx + 1).trim() };
    })
    .filter((c) => c.name);
}

export interface PageFetchOptions {
  cookieHeader: string;
  userAgent: string;
  /** Cookie domain, e.g. "www.betano.ng" — cookies are scoped by domain+path. */
  domain: string;
  extraHeaders?: Record<string, string>;
  /**
   * Skip TLS certificate validation. Default false and MUST stay false against
   * real targets — this exists only so a local test server with a self-signed
   * cert can exercise this code path without weakening production behaviour.
   */
  insecure?: boolean;
}

/**
 * Fetch JSON from INSIDE a real Chromium page (spec §5.2.6, added 22 Jul 2026).
 *
 * This is the tier that actually carries a real browser's TLS fingerprint:
 * a fresh, non-persistent context is created with the EXACT User-Agent the
 * captured cookie was issued under (Cloudflare ties clearance to it — a
 * mismatch invalidates the cookie even over the correct TLS stack), the
 * captured session cookies are injected via the browser's own cookie jar,
 * and the request itself runs as `fetch()` inside the page — i.e. through
 * Chromium's real network stack, not Playwright's separate APIRequestContext
 * client (see the caveat on browserFetchJson above) and not Node's undici.
 *
 * A fresh context per call, not the shared persistent one, because the
 * User-Agent must match the captured session exactly and can only be set at
 * context-creation time in Playwright.
 */
export async function pageFetchJson<T>(url: string, opts: PageFetchOptions): Promise<T> {
  let chromium: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ({ chromium } = require('playwright'));
  } catch {
    throw new Error(
      'playwright is not installed. Run `npm i playwright && npx playwright install chromium` to enable the in-page fetch tier.',
    );
  }

  const browser = await chromium.launch({
    headless: env.PLAYWRIGHT_HEADLESS,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  try {
    const context = await browser.newContext({
      userAgent: opts.userAgent,
      locale: 'en-NG',
      timezoneId: 'Africa/Lagos',
      viewport: { width: 1366, height: 860 },
      ignoreHTTPSErrors: opts.insecure ?? false,
    });

    const cookies = parseCookieHeader(opts.cookieHeader).map((c) => ({
      name: c.name,
      value: c.value,
      domain: opts.domain,
      path: '/',
    }));
    await context.addCookies(cookies);

    const page = await context.newPage();
    // Land on the real domain first so the request is same-origin in every
    // sense the browser can check, not just a bare fetch to an unvisited host.
    try {
      await page.goto(`https://${opts.domain.replace(/^\./, '')}/`, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
    } catch (err) {
      logger.warn({ domain: opts.domain, err: String(err) }, 'pageFetchJson: warm-up navigation failed, continuing anyway');
      // A failed/aborted navigation can leave the page mid-transition, which
      // destroys the JS execution context evaluate() needs next. Settle onto
      // a stable blank page before proceeding rather than risk that race.
      await page.goto('about:blank').catch(() => undefined);
    }

    const result: { ok: boolean; status?: number; text?: string; error?: string } = await page.evaluate(
      async ({ u, headers }: { u: string; headers: Record<string, string> }) => {
        try {
          const res = await fetch(u, { headers, credentials: 'include' });
          const text = await res.text();
          return { ok: true, status: res.status, text };
        } catch (e: unknown) {
          return { ok: false, error: String(e) };
        }
      },
      { u: url, headers: opts.extraHeaders ?? {} },
    );

    if (!result.ok) throw new Error(`pageFetchJson: in-page fetch threw: ${result.error}`);
    if ((result.status ?? 0) >= 400) {
      const err = new Error(`pageFetchJson: HTTP ${result.status} for ${url}`) as Error & { status: number };
      err.status = result.status!;
      throw err;
    }
    return JSON.parse(result.text ?? '') as T;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

export async function closeBrowser(): Promise<void> {
  if (contextPromise) {
    const ctx = await contextPromise.catch(() => null);
    if (ctx) await ctx.close();
    contextPromise = null;
    warmed = false;
  }
}
