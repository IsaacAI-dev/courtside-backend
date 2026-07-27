/**
 * Betano discovery from a browser HAR export (spec §5.2.2, alternate path).
 *
 * Driving a browser is not the only way to run discovery, and on WSL or any
 * machine where a visible window is awkward it is the harder way. Your own
 * browser has already solved Cloudflare, already has the right IP, and already
 * records everything you need — you just have to export it.
 *
 *   1. Open betano.ng in Chrome or Edge on Windows, as you normally would
 *   2. F12 → Network tab → tick "Preserve log"
 *   3. Click into a basketball fixture and open its Players tab
 *   4. Right-click anywhere in the request list → "Save all as HAR with content"
 *      (on newer Chrome: "Export HAR (with sensitive data)")
 *   5. npm run discover:har -- --file /mnt/c/Users/you/Downloads/betano.har
 *
 * PRIVACY: a HAR contains your session cookies and auth headers. Keep it local,
 * do not paste it into a chat or commit it. This script reads it on your machine
 * and writes only shape summaries into betano-discovery.json.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const OUT = 'betano-discovery.json';
const MAX_SAMPLE = 6000;

interface Capture {
  kind: 'REST' | 'WEBSOCKET';
  label: string;
  method?: string;
  status?: number;
  direction?: 'sent' | 'received';
  contentType?: string;
  bytes: number;
  looksLike: string[];
  sample: string;
}

/** Identical tagging to the live discovery script, so output is interchangeable. */
function classify(text: string, url = ''): string[] {
  const tags: string[] = [];
  const has = (re: RegExp) => re.test(text);

  // A payload carrying live prices looks different from one that merely lists
  // market TYPES. Config blobs name every market the platform supports, which
  // is why a naive stat-word match tags them as the board. Prices are the tell.
  const hasOdds = has(/"(?:price|odds|decimalOdds|oddsDecimal|value)"\s*:\s*\d+\.\d+/i);
  const hasLine = has(/"(?:handicap|line|specialBetValue|hcp|argument)"\s*:\s*-?\d/i);
  const hasSelections = has(/"(?:selections|outcomes|results|betItems)"\s*:\s*\[/i);
  const configLike = /config|structurerequirement|kb-config|settings|translation/i.test(url);

  if (has(/participants|competitors|homeTeam|"teams"/i) && has(/startTime|startsAt|beginTime|kickoff|"date"/i)) {
    tags.push('FIXTURE_LIST_CANDIDATE');
  }
  if ((hasLine || hasSelections) && hasOdds) tags.push('MARKETS_CANDIDATE');

  const statWords = /player\s*(points|assists|rebounds)|3[- ]point|player\s*props|points|assists|rebounds/i.test(text);
  if (statWords && hasOdds && (hasLine || hasSelections)) {
    tags.push('PLAYER_PROPS_CANDIDATE');
  } else if (statWords && !hasOdds) {
    // Names the markets but carries no prices — a catalogue, not a board.
    tags.push('MARKET_VOCABULARY_ONLY');
  }

  if (configLike) tags.push('config-endpoint');
  if (has(/basketball|nba|wnba/i)) tags.push('basketball-mentioned');
  return tags;
}

const truncate = (s: string) => (s.length > MAX_SAMPLE ? `${s.slice(0, MAX_SAMPLE)}…[truncated ${s.length} bytes]` : s);

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

function decodeBody(content: { text?: string; encoding?: string } | undefined): string {
  if (!content?.text) return '';
  if (content.encoding === 'base64') {
    try {
      return Buffer.from(content.text, 'base64').toString('utf-8');
    } catch {
      return '';
    }
  }
  return content.text;
}

/**
 * Print the STRUCTURE of a payload — keys, types, array lengths, a sample leaf
 * value — rather than its contents. This is what you need to write a parser,
 * and it means nobody has to paste a 129 KB body anywhere.
 */
function outline(value: unknown, depth = 0, maxDepth = 5, prefix = ''): string[] {
  const pad = '  '.repeat(depth);
  const lines: string[] = [];
  if (depth > maxDepth) return [`${pad}${prefix}…`];

  if (Array.isArray(value)) {
    lines.push(`${pad}${prefix}[] (${value.length} items)`);
    if (value.length) lines.push(...outline(value[0], depth + 1, maxDepth, '↳ first: '));
    return lines;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    lines.push(`${pad}${prefix}{} (${keys.length} keys)`);
    for (const k of keys.slice(0, 24)) {
      const v = (value as Record<string, unknown>)[k];
      if (v && typeof v === 'object') {
        lines.push(...outline(v, depth + 1, maxDepth, `${k}: `));
      } else {
        const sample = typeof v === 'string' ? `"${String(v).slice(0, 48)}"` : String(v);
        lines.push(`${'  '.repeat(depth + 1)}${k}: ${typeof v} = ${sample}`);
      }
    }
    if (keys.length > 24) lines.push(`${'  '.repeat(depth + 1)}… ${keys.length - 24} more keys`);
    return lines;
  }
  const sample = typeof value === 'string' ? `"${String(value).slice(0, 48)}"` : String(value);
  return [`${pad}${prefix}${typeof value} = ${sample}`];
}

/** Find every object that looks like a priced market, anywhere in the tree. */
function findMarketObjects(root: unknown, limit = 3): unknown[] {
  const found: unknown[] = [];
  const walk = (node: unknown): void => {
    if (found.length >= limit || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const obj = node as Record<string, unknown>;
    const keys = Object.keys(obj).map((k) => k.toLowerCase());
    const hasSelections = keys.some((k) => /selection|outcome|result|betitem/.test(k));
    const hasName = keys.some((k) => /name|caption|title|type/.test(k));
    if (hasSelections && hasName) {
      found.push(obj);
      return;
    }
    Object.values(obj).forEach(walk);
  };
  walk(root);
  return found;
}

/**
 * Census mode: find every Kaizen {events, markets, selections} store in the HAR,
 * join the maps, keep basketball events only, and print a compact market-type
 * census. This is the paste-safe summary that identifies the player-prop
 * type codes without anyone reading a 129 KB body.
 */
function isIdMap(v: unknown): v is Record<string, any> {
  return (
    !!v &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    Object.values(v as Record<string, unknown>).every((x) => x && typeof x === 'object')
  );
}

function findStore(payload: unknown, depth = 0): { events: any; markets: any; selections: any } | null {
  if (!payload || typeof payload !== 'object' || depth > 4) return null;
  const obj = payload as Record<string, unknown>;
  if (isIdMap(obj.events) && isIdMap(obj.markets) && isIdMap(obj.selections)) {
    return obj as any;
  }
  for (const v of Object.values(obj)) {
    const found = findStore(v, depth + 1);
    if (found) return found;
  }
  return null;
}

function runCensus(bodies: Array<{ url: string; parsed: unknown }>, sportFilter: string): void {
  interface Group {
    type: string;
    typeId: string;
    names: Map<string, number>;
    marketCount: number;
    eventCount: Set<string>;
    sampleSelections: Array<{ name: string; fullName: string; handicap: unknown; price: unknown }>;
    personNameSeen: boolean;
  }
  const groups = new Map<string, Group>();
  const basketballEvents: Array<{ name: string; start: string; live: boolean; markets: number; hydrated: number; url: string }> = [];
  let storesFound = 0;
  const storeUrls: string[] = [];

  const CENSUS_STOPWORDS = new Set(['total','points','handicap','winner','over','under','match','result','double','chance','head','score','half','time','quarter','draw','both','teams','correct','next','team','goal','game','set','odd','even','yes','no']);
  const personLike = (s: string): boolean => {
    const t = s.trim();
    if (!/^[A-Z][a-zA-Z'’.-]+(?:\s+[A-Z][a-zA-Z'’.-]+)+$/.test(t)) return false;
    if (/\([A-Z0-9]+\)/.test(t)) return false;
    return !t.toLowerCase().split(/\s+/).some((w) => CENSUS_STOPWORDS.has(w.replace(/[.'’-]/g, '')));
  };

  for (const { parsed } of bodies) {
    const store = findStore(parsed);
    if (!store) continue;
    storesFound++;
    if (storeUrls.length < 6) storeUrls.push(bodies.find((b) => b.parsed === parsed)?.url ?? '');

    for (const event of Object.values<any>(store.events)) {
      const sportId = String(event?.sportId ?? '').toUpperCase();
      const isBasketball = sportId.startsWith('BASK') || event?.ardSportId === 2;
      if (sportFilter === 'basketball' && !isBasketball) continue;

      const participants: any[] = Array.isArray(event?.participants) ? event.participants : [];
      const teamNames = new Set(participants.map((p) => String(p?.name ?? '')));
      const eventName = [...teamNames].join(' vs ') || String(event?.url ?? event?.id ?? '?');
      const marketIds: unknown[] = Array.isArray(event?.marketIdList) ? event.marketIdList : [];
      if (isBasketball) {
        basketballEvents.push({
          name: eventName,
          start: event?.startTime ? new Date(Number(event.startTime)).toISOString() : '?',
          live: event?.isLive === true,
          markets: Number(event?.totalMarketsAvailable ?? 0),
          hydrated: marketIds.length,
          url: String(event?.url ?? ''),
        });
      }

      for (const marketId of marketIds) {
        const market = store.markets[String(marketId)];
        if (!market) continue;
        const key = `${market.type ?? '?'}|${market.typeId ?? '?'}`;
        const group =
          groups.get(key) ??
          ({
            type: String(market.type ?? '?'),
            typeId: String(market.typeId ?? '?'),
            names: new Map(),
            marketCount: 0,
            eventCount: new Set(),
            sampleSelections: [],
            personNameSeen: false,
          } as Group);
        group.marketCount++;
        group.eventCount.add(String(event.id));
        const marketName = String(market.name ?? '?');
        group.names.set(marketName, (group.names.get(marketName) ?? 0) + 1);

        const selectionIds: unknown[] = Array.isArray(market.selectionIdList) ? market.selectionIdList : [];
        for (const selId of selectionIds.slice(0, 4)) {
          const sel = store.selections[String(selId)];
          if (!sel) continue;
          if (group.sampleSelections.length < 4) {
            group.sampleSelections.push({
              name: String(sel.name ?? ''),
              fullName: String(sel.fullName ?? ''),
              handicap: sel.handicap,
              price: sel.price,
            });
          }
          const full = String(sel.fullName ?? '');
          if (personLike(full) && !teamNames.has(full)) group.personNameSeen = true;
        }
        groups.set(key, group);
      }
    }
  }

  console.log(`\n=== market-type census (${sportFilter}) — ${storesFound} store payload(s) joined ===`);
  if (storeUrls.length) {
    console.log('\nstore payloads came from:');
    for (const u of storeUrls) console.log(`  ${u.slice(0, 116)}`);
  }

  if (basketballEvents.length) {
    console.log(`\nbasketball events found (${basketballEvents.length}):`);
    for (const e of basketballEvents.slice(0, 15)) {
      const coverage = e.markets > 0 ? `${e.hydrated}/${e.markets}` : String(e.hydrated);
      console.log(
        `  ${e.live ? 'LIVE ' : '     '}${e.name.slice(0, 46).padEnd(46)} ${e.start}  markets ${coverage.padStart(8)}`,
      );
    }

    // The tell: totalMarketsAvailable far exceeds what marketIdList hydrates.
    // A coupon/list payload carries only headline markets; player props sit
    // behind a separate per-event request fired when you open the event page.
    const shortfall = basketballEvents.filter((e) => e.markets > e.hydrated * 2 && e.markets > 20);
    if (shortfall.length) {
      const worst = shortfall.sort((a, b) => b.markets - a.markets)[0];
      console.log('\n  ** INCOMPLETE MARKET COVERAGE **');
      console.log(`  "${worst.name}" advertises ${worst.markets} markets but only ${worst.hydrated} are in this payload.`);
      console.log('  This is a coupon/list response. Player props are NOT in it.');
      console.log('  Re-capture with the EVENT PAGE open and its Players tab loaded:');
      if (worst.url) console.log(`    ${worst.url}`);
    }
  } else if (storesFound) {
    console.log('\n  no basketball events in any store — re-run with `--sport all` to see everything.');
  }

  if (!storesFound) {
    console.log('\n  no {events, markets, selections} store found in this HAR.');
    console.log('  That is expected for a per-event endpoint, which may answer in a');
    console.log('  different shape. Scanning by content instead...');
    contentScanForProps(bodies);
    return;
  }

  const ranked = [...groups.values()].sort((a, b) => b.marketCount - a.marketCount);
  console.log(`\nmarket types (${ranked.length}):\n`);
  console.log('  type  typeId  markets events person?  names (top)                              sample selection');
  for (const g of ranked) {
    const topNames = [...g.names.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([n]) => n)
      .join(' | ');
    const s = g.sampleSelections[0];
    const sample = s ? `"${s.name}" hcp=${s.handicap ?? '-'} @${s.price ?? '-'}` : '-';
    console.log(
      `  ${g.type.padEnd(5)} ${g.typeId.padStart(6)}  ${String(g.marketCount).padStart(6)} ${String(g.eventCount.size).padStart(6)} ${
        g.personNameSeen ? '  YES  ' : '   -   '
      } ${topNames.slice(0, 40).padEnd(40)}  ${sample}`,
    );
  }
  // "Total Points" is a GAME total and contains "points" — a bare stat word is
  // not evidence of a player prop. Require a person's name on a selection, or a
  // market name that explicitly scopes the stat to a player.
  const PLAYER_SCOPED = /\bplayer\b|\b(points|assists|rebounds|threes)\b\s*(by|for)\b|^[A-Z][a-z]+ [A-Z][a-z]+ .*(points|assists|rebounds)/i;
  const propTypes = ranked.filter(
    (g) => g.personNameSeen || [...g.names.keys()].some((n) => PLAYER_SCOPED.test(n)),
  );
  if (propTypes.length) {
    console.log('\nLIKELY PLAYER-PROP TYPES: ' + propTypes.map((g) => `${g.type}/${g.typeId}`).join(', '));
    console.log('Paste this table — those codes are what betano.json needs.\n');
  } else {
    console.log('\nNo player-prop market types in the joined store. Falling back to a');
    console.log('content scan that ignores payload shape entirely...');
    contentScanForProps(bodies);
  }
}

/**
 * Shape-agnostic hunt for player props. The store-join assumes Kaizen's
 * three-map layout; a per-event endpoint may answer in some other shape
 * entirely. This walks every payload looking for the CONTENT signature of a
 * player prop — an Over/Under selection carrying a handicap and a price,
 * sitting near a person's name — so structure never has to be guessed.
 */
function contentScanForProps(bodies: Array<{ url: string; parsed: unknown }>): void {
  // "Total Points" and "Match Result" are Capitalised Two-Word Phrases too, so a
  // capitalisation test alone is useless here. Reject betting vocabulary first.
  const BETTING_WORDS = new Set(
    [
      'total','points','handicap','winner','over','under','match','result','double','chance','head','to','score',
      'half','time','quarter','first','second','third','fourth','odd','even','yes','no','draw','both','teams',
      'correct','next','team','goal','game','set','map','round','period','margin','victory','race','alternative',
      'incl','including','overtime','ot','line','spread','moneyline','money','win','lose','tie','and','or','the',
      'highest','scoring','lowest','most','least','player','players','home','away','away','combined','multi',
    ].map((w) => w.toLowerCase()),
  );
  const personLike = (s: string): boolean => {
    const t = s.trim();
    if (!/^[A-Z][a-zA-Z'’.-]+(?:\s+[A-Z][a-zA-Z'’.-]+)+$/.test(t)) return false;
    if (/\([A-Z0-9]+\)/.test(t)) return false; // esports handle
    const words = t.toLowerCase().split(/\s+/);
    // A real player name contains no betting vocabulary at all.
    return !words.some((w) => BETTING_WORDS.has(w.replace(/[.'’-]/g, '')));
  };
  const statWord = /point|assist|rebound|three|3[- ]?p|steal|block|double|made/i;

  interface Hit {
    url: string;
    path: string;
    marketName: string;
    person: string;
    line: unknown;
    price: unknown;
  }
  const hits: Hit[] = [];
  const urlsWithOverUnder = new Set<string>();

  for (const { url, parsed } of bodies) {
    // Carry the nearest ancestor's person / market name down the tree: in real
    // payloads the player is named on the MARKET, while the Over/Under and the
    // handicap live on its child selections.
    const walk = (node: unknown, path: string, depth: number, ctxPerson: string, ctxMarket: string): void => {
      if (hits.length > 40 || !node || typeof node !== 'object' || depth > 12) return;
      if (Array.isArray(node)) {
        node.slice(0, 400).forEach((v, i) => walk(v, `${path}[${i}]`, depth + 1, ctxPerson, ctxMarket));
        return;
      }
      const obj = node as Record<string, unknown>;

      // Refresh context from this level before descending.
      const ownNames = [obj.participant, obj.playerName, obj.player, obj.competitor]
        .map((x) => String(x ?? ''))
        .filter(Boolean);
      const ownMarket = String(obj.marketName ?? obj.name ?? obj.caption ?? obj.title ?? '');
      const nextPerson = ownNames.find((n) => personLike(n)) ?? ctxPerson;
      const nextMarket = statWord.test(ownMarket) ? ownMarket : ctxMarket;

      // A market name may itself embed the player, e.g. "Caitlin Clark Player Points"
      let embedded = '';
      if (ownMarket && statWord.test(ownMarket)) {
        const words = ownMarket.split(/\s+/);
        for (let i = 0; i < words.length - 1; i++) {
          if (personLike(`${words[i]} ${words[i + 1]}`)) {
            embedded = `${words[i]} ${words[i + 1]}`;
            break;
          }
        }
      }

      const nameish = String(obj.name ?? obj.fullName ?? obj.caption ?? '');
      const isOverUnder = /^(over|under)\b/i.test(nameish.trim());
      const line = obj.handicap ?? obj.line ?? obj.specialBetValue ?? obj.argument;
      const price = obj.price ?? obj.odds ?? obj.decimalOdds;

      if (isOverUnder && line != null && price != null) {
        urlsWithOverUnder.add(url);
        const person = nextPerson || embedded;
        const marketName = nextMarket || ctxMarket;
        if (person) hits.push({ url, path, marketName, person, line, price });
      }

      if (embedded) {
        hits.push({
          url,
          path,
          marketName: ownMarket,
          person: embedded,
          line: obj.handicap ?? '(on selections)',
          price: '(on selections)',
        });
      }

      for (const [k, v] of Object.entries(obj)) {
        if (v && typeof v === 'object') walk(v, `${path}.${k}`, depth + 1, nextPerson || embedded, nextMarket);
      }
    };
    walk(parsed, '$', 0, '', '');
  }

  console.log('\n=== shape-agnostic content scan for player props ===');
  if (hits.length) {
    console.log(`\n  ${hits.length} player-prop-shaped item(s) found:\n`);
    const seen = new Set<string>();
    for (const h of hits.slice(0, 20)) {
      const key = `${h.url}|${h.marketName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      console.log(`  ${h.person || '?'} — ${h.marketName || '?'}  line=${h.line} @${h.price}`);
      console.log(`    at ${h.path.slice(0, 70)}`);
      console.log(`    in ${h.url.slice(0, 100)}\n`);
    }
    console.log('  Run --inspect on that URL to get its structure.');
    return;
  }

  console.log('\n  No player-prop content anywhere in this HAR, in any shape.');
  if (urlsWithOverUnder.size) {
    console.log(`\n  ${urlsWithOverUnder.size} payload(s) DO contain priced Over/Under selections,`);
    console.log('  but none sit near a person name — these are game totals, not player props.');
  }

  // Show what was actually requested, so a missing request is visible.
  const paths = new Map<string, number>();
  for (const { url } of bodies) {
    try {
      const u = new URL(url);
      const key = `${u.host}${u.pathname.replace(/\/\d{6,}/g, '/{id}')}`;
      paths.set(key, (paths.get(key) ?? 0) + 1);
    } catch {
      /* ignore */
    }
  }
  console.log(`\n  JSON endpoints captured (${paths.size} distinct):\n`);
  for (const [p, n] of [...paths.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
    console.log(`    ${String(n).padStart(3)}x  ${p.slice(0, 104)}`);
  }
  console.log('\n  If no per-event/market endpoint appears above, the props request was');
  console.log('  never made or never recorded — the Players tab did not load while capturing.\n');
}

function main(): void {
  const args = process.argv.slice(2);
  const fileIdx = args.indexOf('--file');
  const file = fileIdx >= 0 ? args[fileIdx + 1] : args.find((a) => a.endsWith('.har'));
  const inspectIdx = args.indexOf('--inspect');
  const inspectFilter = inspectIdx >= 0 ? String(args[inspectIdx + 1] ?? '').toLowerCase() : null;
  const censusMode = args.includes('--census');
  const sportIdx = args.indexOf('--sport');
  const sportFilter = sportIdx >= 0 ? String(args[sportIdx + 1] ?? 'basketball').toLowerCase() : 'basketball';

  if (!file) {
    console.error('\nusage: npm run discover:har -- --file <path-to.har>\n');
    console.error('From WSL, your Windows Downloads folder is at /mnt/c/Users/<you>/Downloads/\n');
    process.exit(1);
  }
  if (!existsSync(file)) {
    console.error(`\nno file at ${file}\n`);
    process.exit(1);
  }

  let har: any;
  try {
    har = JSON.parse(readFileSync(file, 'utf-8'));
  } catch (err) {
    console.error(`\ncould not parse ${file} as JSON: ${String(err).slice(0, 120)}\n`);
    process.exit(1);
  }

  const entries: any[] = har?.log?.entries ?? [];
  if (!entries.length) {
    console.error('\nthat HAR contains no entries — was the Network tab recording?\n');
    process.exit(1);
  }

  const captures: Capture[] = [];
  let bodiesMissing = 0;

  // Betano's own market vocabulary. The default marketMap patterns are educated
  // guesses; these are the strings the book actually uses, which is what you
  // need to write betano.json correctly. Collected from FULL bodies, before
  // sample truncation.
  const nameCounts = new Map<string, number>();
  const inspectHits: Array<{ url: string; parsed: unknown; bytes: number }> = [];
  const censusBodies: Array<{ url: string; parsed: unknown }> = [];
  const NAME_KEYS = /"(?:name|marketName|marketType|title|caption|description)"\s*:\s*"([^"]{3,70})"/g;
  const harvestNames = (text: string): void => {
    NAME_KEYS.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = NAME_KEYS.exec(text)) !== null) {
      const name = m[1].trim();
      if (!name) continue;
      nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    }
  };

  for (const entry of entries) {
    const url = String(entry?.request?.url ?? '');
    const mimeType = String(entry?.response?.content?.mimeType ?? '');

    // ── WebSocket frames: Chrome stores these on the entry, not in content ──
    const frames: any[] = entry?._webSocketMessages ?? [];
    for (const frame of frames) {
      const payload = String(frame?.data ?? '');
      if (!payload || payload.length < 40) continue;
      harvestNames(payload);
      captures.push({
        kind: 'WEBSOCKET',
        label: url,
        direction: frame?.type === 'send' ? 'sent' : 'received',
        bytes: payload.length,
        looksLike: classify(payload, url),
        sample: truncate(payload),
      });
    }
    if (frames.length) continue;

    // ── REST: parse every body as JSON regardless of declared mime type ──
    const body = decodeBody(entry?.response?.content);
    if (!body) {
      const size = Number(entry?.response?.content?.size ?? 0);
      if (size > 0 && !/image|font|video|audio|css/i.test(mimeType)) bodiesMissing++;
      continue;
    }
    if (!asJson(body)) continue;
    harvestNames(body);
    if (censusMode) {
      try {
        censusBodies.push({ url, parsed: JSON.parse(body) });
      } catch {
        /* skip */
      }
    }
    if (inspectFilter && url.toLowerCase().includes(inspectFilter) && inspectHits.length < 3) {
      try {
        inspectHits.push({ url, parsed: JSON.parse(body), bytes: body.length });
      } catch {
        /* unparseable despite asJson — skip */
      }
    }

    captures.push({
      kind: 'REST',
      label: url,
      method: String(entry?.request?.method ?? 'GET'),
      status: Number(entry?.response?.status ?? 0),
      contentType: mimeType,
      bytes: body.length,
      looksLike: classify(body, url),
      sample: truncate(body),
    });
  }

  if (censusMode) {
    runCensus(censusBodies, sportFilter);
    return;
  }

  if (inspectFilter) {
    console.log(`\n=== structure of payloads matching "${inspectFilter}" ===`);
    if (!inspectHits.length) {
      console.log('\n  no captured payload URL contained that string.');
      console.log('  run without --inspect first to see the available URLs.\n');
      return;
    }
    for (const hit of inspectHits) {
      console.log(`\n--- ${hit.url.slice(0, 120)}  (${hit.bytes} bytes) ---\n`);
      console.log(outline(hit.parsed).join('\n'));

      const markets = findMarketObjects(hit.parsed);
      if (markets.length) {
        console.log('\n  --- objects that look like priced markets ---\n');
        for (const m of markets) {
          console.log(
            outline(m, 1, 3)
              .join('\n')
              .split('\n')
              .map((l) => `  ${l}`)
              .join('\n'),
          );
          console.log('');
        }
      } else {
        console.log('\n  no market-shaped objects (name + selections) found in this payload.');
      }
    }
    console.log('');
    return;
  }

  captures.sort((a, b) => b.bytes - a.bytes);

  const rest = captures.filter((c) => c.kind === 'REST');
  const ws = captures.filter((c) => c.kind === 'WEBSOCKET');
  const props = captures.filter((c) => c.looksLike.includes('PLAYER_PROPS_CANDIDATE'));
  const markets = captures.filter((c) => c.looksLike.includes('MARKETS_CANDIDATE'));

  writeFileSync(
    OUT,
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        source: `HAR: ${file}`,
        totals: {
          total: captures.length,
          rest: rest.length,
          websocket: ws.length,
          playerPropCandidates: props.length,
          marketCandidates: markets.length,
          fixtureCandidates: captures.filter((c) => c.looksLike.includes('FIXTURE_LIST_CANDIDATE')).length,
        },
        marketVocabulary: [...nameCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 200)
          .map(([name, count]) => ({ name, count })),
        captures,
      },
      null,
      2,
    ),
  );

  console.log(`\n--- ${entries.length} HAR entries read, ${captures.length} JSON payloads captured -> ${OUT} ---`);
  console.log(`  REST ${rest.length} · websocket frames ${ws.length}\n`);

  if (captures.length) {
    // Tagged candidates first — the point is to surface the board, not to rank
    // by size. Repeated identical endpoints (analytics beacons and the like)
    // are collapsed so they cannot bury the one payload that matters.
    const seenEndpoint = new Map<string, number>();
    const key = (c: Capture) => `${c.kind}|${c.label.split('?')[0]}|${c.looksLike.join(',')}`;
    for (const c of captures) seenEndpoint.set(key(c), (seenEndpoint.get(key(c)) ?? 0) + 1);

    const shown = new Set<string>();
    const dedup = captures.filter((c) => {
      const k = key(c);
      if (shown.has(k)) return false;
      shown.add(k);
      return true;
    });
    const tagged = dedup.filter((c) => c.looksLike.some((t) => t.endsWith('_CANDIDATE')));
    const untagged = dedup.filter((c) => !c.looksLike.some((t) => t.endsWith('_CANDIDATE')));
    const display = [...tagged, ...untagged].slice(0, 25);

    console.log('candidates first, then everything else (repeats collapsed):\n');
    for (const c of display) {
      const count = seenEndpoint.get(key(c)) ?? 1;
      const repeat = count > 1 ? ` x${count}` : '';
      const tags = c.looksLike.join(',') || '-';
      console.log(
        `  ${c.kind.padEnd(10)} ${String(c.bytes).padStart(8)}B${repeat.padEnd(6)} ${tags.padEnd(46)}  ${c.label.slice(0, 88)}`,
      );
    }
  }

  // ── Market vocabulary: what Betano actually calls things ──
  const STAT_WORDS = /point|assist|rebound|three|3[- ]?p|steal|block|double|made|turnover|score/i;
  const ranked = [...nameCounts.entries()].sort((a, b) => b[1] - a[1]);
  const statNames = ranked.filter(([n]) => STAT_WORDS.test(n)).slice(0, 40);

  if (statNames.length) {
    console.log('\n--- market names containing stat words (candidates for marketMap) ---\n');
    for (const [name, count] of statNames) {
      console.log(`  ${String(count).padStart(5)}x  ${name}`);
    }
  } else if (ranked.length) {
    console.log('\n--- most common "name" values seen (no stat words matched) ---\n');
    for (const [name, count] of ranked.slice(0, 25)) {
      console.log(`  ${String(count).padStart(5)}x  ${name}`);
    }
  }

  console.log('\n--- diagnosis ---');
  if (props.length) {
    console.log(`  ${props.length} payload(s) tagged PLAYER_PROPS_CANDIDATE - this is the board.`);
    console.log(`  Kinds: ${[...new Set(props.map((p) => p.kind))].join(', ')}`);
    console.log('  Copy the matching URL into src/config/betano.json.');
    if (props.every((p) => p.kind === 'WEBSOCKET')) {
      console.log('\n  NOTE: props arrived ONLY over websocket. The adapter needs a socket');
      console.log('  client rather than the REST tiers - a known, contained rework.');
    }
  } else if (markets.length) {
    console.log(`  ${markets.length} market-shaped payload(s), but none matched the player-prop patterns.`);
    console.log('  Search betano-discovery.json for the exact market names Betano uses,');
    console.log('  then widen the marketMap patterns in src/config/betano.json.');
  } else if (bodiesMissing > 20) {
    console.log(`  ${bodiesMissing} responses had no body recorded.`);
    console.log('  The HAR was exported WITHOUT content. Re-export using');
    console.log('  "Save all as HAR with content" / "Export HAR (with sensitive data)".');
  } else {
    console.log('  No betting-board payloads found.');
    console.log('  Did you open a fixture and its Players tab while Network was recording,');
    console.log('  with "Preserve log" ticked?');
  }
  console.log();
}

main();
