/**
 * Betano endpoint discovery (spec §5.2.2) — Phase 0's central tool.
 *
 * Opens a real, visible browser and records EVERYTHING while you navigate
 * basketball → a fixture → the Players tab:
 *
 *   1. REST      any response whose body parses as JSON, whatever its content-type
 *   2. WEBSOCKET every frame in both directions — sportsbook platforms very often
 *                push odds over a socket rather than serving them over XHR
 *   3. EMBEDDED  JSON baked into the delivered HTML (__NEXT_DATA__, __NUXT__,
 *                __INITIAL_STATE__, <script type="application/json">)
 *
 * Capturing only category 1 is how you conclude "there is no API" when in fact
 * the board arrived by socket on page load.
 *
 *   npm run discover:betano            # always opens a visible window
 *   npm run discover:betano -- --fresh # wipe the saved browser profile first
 */
import { writeFileSync, rmSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { env } from '../env';

const OUT = 'betano-discovery.json';
const HTML_OUT = 'betano-page.html';
const MAX_SAMPLE = 6000;

interface Capture {
  kind: 'REST' | 'WEBSOCKET' | 'EMBEDDED';
  label: string; // url, socket url, or the embedded blob's origin
  method?: string;
  status?: number;
  direction?: 'sent' | 'received';
  contentType?: string;
  bytes: number;
  looksLike: string[];
  sample: string;
}

/**
 * Shape tags. These are what you actually scan the output for — the sizes alone
 * will not tell you which payload is the player board.
 */
function classify(text: string): string[] {
  const tags: string[] = [];
  const has = (re: RegExp) => re.test(text);

  if (has(/participants|competitors|homeTeam|"teams"/i) && has(/startTime|startsAt|beginTime|kickoff|"date"/i)) {
    tags.push('FIXTURE_LIST_CANDIDATE');
  }
  if (has(/handicap|specialBetValue|"line"|"hcp"/i) && has(/selections|outcomes|"odds"|"price"/i)) {
    tags.push('MARKETS_CANDIDATE');
  }
  if (has(/player\s*(points|assists|rebounds)|3[- ]point|player\s*props/i)) {
    tags.push('PLAYER_PROPS_CANDIDATE');
  }
  if (has(/basketball|nba|wnba/i)) tags.push('basketball-mentioned');
  return tags;
}

const truncate = (s: string) => (s.length > MAX_SAMPLE ? `${s.slice(0, MAX_SAMPLE)}…[truncated ${s.length} bytes]` : s);

/** Does this text parse as JSON, regardless of what the server claimed it was? */
function asJson(text: string): boolean {
  const t = text.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  let chromium: any;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    console.error('\nplaywright is not installed:\n\n  npm i playwright && npx playwright install chromium\n');
    process.exit(1);
  }

  if (process.argv.includes('--fresh') && existsSync(env.PLAYWRIGHT_USER_DATA_DIR)) {
    rmSync(env.PLAYWRIGHT_USER_DATA_DIR, { recursive: true, force: true });
    console.log('cleared saved browser profile');
  }

  const captures: Capture[] = [];
  let restSeen = 0;
  let wsSeen = 0;
  const progress = () => {
    process.stdout.write(`\r  captured: ${restSeen} REST · ${wsSeen} socket frames   `);
  };

  const ctx = await chromium.launchPersistentContext(env.PLAYWRIGHT_USER_DATA_DIR, {
    // ALWAYS headed. You navigate by hand while this records; a headless
    // discovery run is meaningless, and Cloudflare wants a human anyway.
    headless: false,
    viewport: { width: 1440, height: 900 },
    locale: 'en-NG',
    timezoneId: 'Africa/Lagos',
    args: ['--disable-blink-features=AutomationControlled'],
  });

  // ── 1. REST: try to parse EVERY response body as JSON ──
  ctx.on('response', async (res: any) => {
    try {
      const req = res.request();
      const type = req.resourceType();
      if (type === 'image' || type === 'font' || type === 'media' || type === 'stylesheet') return;

      const text = await res.text().catch(() => '');
      if (!text || !asJson(text)) return;

      restSeen++;
      captures.push({
        kind: 'REST',
        label: res.url(),
        method: req.method(),
        status: res.status(),
        contentType: res.headers()['content-type'] ?? '',
        bytes: text.length,
        looksLike: classify(text),
        sample: truncate(text),
      });
      progress();
    } catch {
      /* body already consumed, redirect, or aborted — nothing to record */
    }
  });

  // ── 3. EMBEDDED: JSON delivered inside the HTML itself ──
  // Scanned on EVERY page load, not once at the end: if you finish by closing
  // the browser (a documented way to stop), a final-only scan reads from a dead
  // page and silently reports nothing. Snapshotting as you go also captures the
  // fixture page's state, which is where the interesting blob usually lives.
  let lastHtml = '';
  const embeddedSeen = new Set<string>();

  const scanEmbedded = async (target: any): Promise<void> => {
    try {
      if (!target || (typeof target.isClosed === 'function' && target.isClosed())) return;
      const html = await target.content();
      if (html) lastHtml = html;

      const blobs: Array<{ label: string; text: string }> = await target.evaluate(() => {
        const out: Array<{ label: string; text: string }> = [];
        document.querySelectorAll('script').forEach((el, i) => {
          const type = el.getAttribute('type') ?? '';
          const id = el.getAttribute('id') ?? '';
          const body = el.textContent ?? '';
          if (!body || body.length < 120) return;
          if (type.includes('json') || id) {
            out.push({ label: `script#${id || i}[${type || 'inline'}]`, text: body });
            return;
          }
          const m = body.match(
            /(?:window\.)?(__NEXT_DATA__|__NUXT__|__INITIAL_STATE__|__APOLLO_STATE__|__PRELOADED_STATE__)\s*=\s*/,
          );
          if (m) out.push({ label: m[1], text: body.slice(body.indexOf(m[0]) + m[0].length) });
        });
        return out;
      });

      for (const blob of blobs) {
        const trimmed = blob.text.trim().replace(/;?\s*$/, '');
        const key = `${blob.label}:${trimmed.length}`;
        if (embeddedSeen.has(key)) continue;
        embeddedSeen.add(key);
        captures.push({
          kind: 'EMBEDDED',
          label: blob.label,
          bytes: trimmed.length,
          looksLike: classify(trimmed),
          sample: truncate(trimmed),
        });
        progress();
      }
    } catch {
      /* navigated away or closed mid-scan — the next load will catch it */
    }
  };

  const attachEmbeddedCapture = (target: any): void => {
    target.on('load', () => void scanEmbedded(target));
  };
  // NOTE: Playwright emits 'websocket' on Page, NOT on BrowserContext. Attaching
  // to the context silently captures nothing — which would look exactly like
  // "this book doesn't use sockets" and send you down the wrong path entirely.
  // ── 2. WEBSOCKET: the pattern that makes a book look like it has no API ──
  const wsAttached = new WeakSet<object>();
  const attachWebsocketCapture = (target: any): void => {
    if (!target || wsAttached.has(target)) return;
    wsAttached.add(target);
    target.on('websocket', (ws: any) => {
      const url = ws.url();
      console.log(`\n  <-> websocket opened: ${url.slice(0, 120)}`);
      const record = (payload: string, direction: 'sent' | 'received') => {
        if (!payload || payload.length < 40) return; // heartbeats and acks
        wsSeen++;
        captures.push({
          kind: 'WEBSOCKET',
          label: url,
          direction,
          bytes: payload.length,
          looksLike: classify(payload),
          sample: truncate(payload),
        });
        progress();
      };
      ws.on('framereceived', (f: any) => record(String(f.payload ?? ''), 'received'));
      ws.on('framesent', (f: any) => record(String(f.payload ?? ''), 'sent'));
    });
  };

  // Cover pages opened later too — clicking a fixture often spawns a new tab.
  const attachAll = (target: any): void => {
    attachWebsocketCapture(target);
    attachEmbeddedCapture(target);
  };
  ctx.on('page', attachAll);
  ctx.pages().forEach(attachAll);

  const page = await ctx.newPage();
  attachAll(page);
  console.log(`\nOpening ${env.BETANO_BASE_URL}/sport/basketball/ in a visible browser window.\n`);
  console.log('  1. Clear any Cloudflare check if one appears.');
  console.log('  2. Click into a basketball fixture that is already taking bets.');
  console.log('  3. Open its "Players" tab and let the prop markets finish loading.');
  console.log('  4. Come back here and press Enter (or just close the browser).\n');
  console.log('No window appeared? On WSL you need WSLg (Windows 11) or an X server —');
  console.log('discovery cannot run without a browser you can actually see and click.\n');

  try {
    await page.goto(`${env.BETANO_BASE_URL}/sport/basketball/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  } catch (err) {
    console.error(`\n  navigation problem: ${String(err).slice(0, 160)}`);
    console.error('  the browser is still open — navigate manually, then press Enter.\n');
  }
  progress();

  // Wait for Enter OR the browser being closed, whichever comes first.
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        rl.close();
      } catch {
        /* already closed */
      }
      resolve();
    };
    rl.question('', finish);
    ctx.on('close', finish);
    page.on('close', finish);
  });

  // Final pass — only if the page survived; the per-load scans already ran.
  console.log('\n\nfinalising...');
  await scanEmbedded(page);
  if (lastHtml) {
    writeFileSync(HTML_OUT, lastHtml);
    console.log(`  page HTML saved to ${HTML_OUT}`);
  } else {
    console.log('  no HTML could be read - the browser may have closed early');
  }

  // ── Report ──
  captures.sort((a, b) => b.bytes - a.bytes);
  writeFileSync(
    OUT,
    JSON.stringify(
      { capturedAt: new Date().toISOString(), baseUrl: env.BETANO_BASE_URL, totals: summarise(captures), captures },
      null,
      2,
    ),
  );

  const rest = captures.filter((c) => c.kind === 'REST');
  const ws = captures.filter((c) => c.kind === 'WEBSOCKET');
  const embedded = captures.filter((c) => c.kind === 'EMBEDDED');
  const props = captures.filter((c) => c.looksLike.includes('PLAYER_PROPS_CANDIDATE'));
  const markets = captures.filter((c) => c.looksLike.includes('MARKETS_CANDIDATE'));

  console.log(`\n--- ${captures.length} payloads captured -> ${OUT} ---`);
  console.log(`  REST ${rest.length} · websocket frames ${ws.length} · embedded blobs ${embedded.length}\n`);

  if (captures.length) {
    // Tagged candidates first, repeats collapsed — a websocket pushing an update
    // every 700ms will otherwise produce hundreds of identical rows and bury the
    // one payload you are looking for.
    const key = (c: Capture) => `${c.kind}|${c.label.split('?')[0]}|${c.looksLike.join(',')}`;
    const counts = new Map<string, number>();
    for (const c of captures) counts.set(key(c), (counts.get(key(c)) ?? 0) + 1);

    const shown = new Set<string>();
    const dedup = captures.filter((c) => {
      const k = key(c);
      if (shown.has(k)) return false;
      shown.add(k);
      return true;
    });
    const tagged = dedup.filter((c) => c.looksLike.some((t) => t.endsWith('_CANDIDATE')));
    const untagged = dedup.filter((c) => !c.looksLike.some((t) => t.endsWith('_CANDIDATE')));

    console.log('candidates first, then everything else (repeats collapsed):\n');
    for (const c of [...tagged, ...untagged].slice(0, 25)) {
      const count = counts.get(key(c)) ?? 1;
      const repeat = count > 1 ? ` x${count}` : '';
      const tags = c.looksLike.join(',') || '-';
      console.log(
        `  ${c.kind.padEnd(10)} ${String(c.bytes).padStart(8)}B${repeat.padEnd(6)} ${tags.padEnd(46)}  ${c.label.slice(0, 88)}`,
      );
    }
  }

  console.log('\n--- diagnosis ---');
  if (props.length) {
    console.log(`  ${props.length} payload(s) tagged PLAYER_PROPS_CANDIDATE - this is the board.`);
    console.log(`  Kinds: ${[...new Set(props.map((p) => p.kind))].join(', ')}`);
    console.log('  Copy the matching URL/template into src/config/betano.json.');
    if (props.every((p) => p.kind === 'WEBSOCKET')) {
      console.log('\n  NOTE: props arrived ONLY over websocket. The adapter needs a socket');
      console.log('  client rather than the REST tiers - that is a known, solvable rework.');
    }
  } else if (markets.length) {
    console.log(`  ${markets.length} market-shaped payload(s), but none matched the player-prop patterns.`);
    console.log('  Either the Players tab did not load, or the market names differ from the');
    console.log('  defaults. Search betano-discovery.json for the market names Betano uses.');
  } else if (!captures.length) {
    console.log('  NOTHING captured. Most likely causes, in order:');
    console.log('    1. The browser never rendered the real site (Cloudflare interstitial).');
    console.log('    2. Enter was pressed before the page finished loading.');
    console.log('    3. No window appeared at all (WSL without WSLg / X server).');
    console.log(`  Check ${HTML_OUT} - if it is a challenge page, that confirms cause 1.`);
    console.log('  Retry with:  npm run discover:betano -- --fresh');
  } else {
    console.log('  Traffic captured, but nothing looks like a betting board.');
    console.log('  Did you open a fixture and its Players tab before pressing Enter?');
  }
  console.log();

  await ctx.close().catch(() => undefined);
  process.exit(0);
}

function summarise(captures: Capture[]) {
  return {
    total: captures.length,
    rest: captures.filter((c) => c.kind === 'REST').length,
    websocket: captures.filter((c) => c.kind === 'WEBSOCKET').length,
    embedded: captures.filter((c) => c.kind === 'EMBEDDED').length,
    playerPropCandidates: captures.filter((c) => c.looksLike.includes('PLAYER_PROPS_CANDIDATE')).length,
    marketCandidates: captures.filter((c) => c.looksLike.includes('MARKETS_CANDIDATE')).length,
    fixtureCandidates: captures.filter((c) => c.looksLike.includes('FIXTURE_LIST_CANDIDATE')).length,
  };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
