/**
 * See the REAL shape of the Betano fixtures payload, using the exact same
 * session/fetch path that already works (spec §5.2.7).
 *
 * Confirmed 22 Jul 2026: fetching this endpoint succeeds every time — the
 * in-page fetch tier gets real data back. Parsing is what's failing, because
 * findKaizenStore() couldn't locate an {events, markets, selections} store
 * at any nesting level it checked. The top-level keys turned out to be
 * ["data", "structureComponents", "user", "languages", "companyId", "regions"]
 * — a bigger app-bootstrap-style payload than the danae-webapi shape this
 * parser was originally built against. This script writes the raw JSON to
 * disk and prints a structural outline (keys/types/array lengths, not full
 * content) so the real location of the store can be found without guessing.
 *
 *   npm run debug:betano-raw
 */
import { writeFileSync } from 'node:fs';
import { fetchBetanoRawFixturesPayload } from '../adapters/betano/adapter';

const OUT_FILE = 'betano-fixtures-raw.json';

/** Structure only — keys, types, array lengths, one sample leaf value. No full content dumped. */
export function outline(value: unknown, depth = 0, maxDepth = 6, prefix = ''): string[] {
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
    lines.push(`${pad}${prefix}{} (${keys.length} keys: ${keys.slice(0, 15).join(', ')}${keys.length > 15 ? ', …' : ''})`);
    for (const k of keys.slice(0, 20)) {
      const v = (value as Record<string, unknown>)[k];
      if (v && typeof v === 'object') {
        lines.push(...outline(v, depth + 1, maxDepth, `${k}: `));
      } else {
        const sample = typeof v === 'string' ? `"${String(v).slice(0, 60)}"` : String(v);
        lines.push(`${'  '.repeat(depth + 1)}${k}: ${typeof v} = ${sample}`);
      }
    }
    return lines;
  }
  const sample = typeof value === 'string' ? `"${String(value).slice(0, 60)}"` : String(value);
  return [`${pad}${prefix}${typeof value} = ${sample}`];
}

/** Find every {events, markets, selections}-shaped object anywhere in the tree, regardless of depth. */
export function findAllStoreShapes(value: unknown, path = '$', found: string[] = []): string[] {
  if (!value || typeof value !== 'object') return found;
  const obj = value as Record<string, unknown>;
  const hasIdMap = (v: unknown) =>
    !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v as object).every((x) => x && typeof x === 'object');
  if (hasIdMap(obj.events) && hasIdMap(obj.markets) && hasIdMap(obj.selections)) {
    found.push(`${path} — FULL store (events+markets+selections)`);
  } else {
    const hasAny = ['events', 'markets', 'selections'].filter((k) => hasIdMap(obj[k]));
    if (hasAny.length) found.push(`${path} — PARTIAL store (has: ${hasAny.join(', ')})`);
  }
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object') findAllStoreShapes(v, `${path}.${k}`, found);
  }
  return found;
}

/**
 * blocks[] specifically deserves full visibility, not just a first-item
 * sample: confirmed 22 Jul 2026 that blocks[0] on this payload shape was an
 * "Outrights" (futures) block, and the outline's default first-item-only
 * sampling meant blocks[1..N] — where real per-game listings most plausibly
 * live — were invisible. This prints every block's identifying fields and
 * event count so a real-games block can't hide behind an outrights block
 * sitting first in the array.
 */
export function summariseBlocks(blocks: unknown): string[] {
  if (!Array.isArray(blocks)) return ['  (not an array)'];
  return blocks.map((b, i) => {
    const block = b as Record<string, unknown>;
    const events = Array.isArray(block.events) ? block.events : [];
    const firstEvent = events[0] as Record<string, unknown> | undefined;
    return (
      `  [${i}] name="${block.name}" outright=${block.outright} events=${events.length}` +
      (firstEvent ? ` | first event keys: ${Object.keys(firstEvent).join(', ')}` : '')
    );
  });
}

async function main(): Promise<void> {
  console.log('\nfetching the real Betano fixtures payload (reusing the working session)...\n');
  const payload = await fetchBetanoRawFixturesPayload();

  writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2));
  console.log(`full raw payload written to ${OUT_FILE} (keep this local — do not paste the whole file into chat)\n`);

  console.log('=== top-level structure ===\n');
  console.log(outline(payload, 0, 2).join('\n'));

  console.log('\n=== searching for a Kaizen store shape at ANY depth (full or partial) ===\n');
  const shapes = findAllStoreShapes(payload);
  if (shapes.length) {
    for (const s of shapes) console.log(`  ${s}`);
  } else {
    console.log('  none found — this payload may use a genuinely different shape entirely.');
  }

  console.log('\n=== structure under "data" specifically (most likely location) ===\n');
  const data = (payload as Record<string, unknown>)?.data;
  if (data) {
    console.log(outline(data, 0, 3).join('\n'));

    const blocks = (data as Record<string, unknown>).blocks;
    if (blocks) {
      console.log('\n=== every blocks[] entry (not just the first) ===\n');
      console.log(summariseBlocks(blocks).join('\n'));
    }
  } else {
    console.log('  no top-level "data" key present.');
  }

  console.log(`\nPaste the three sections above (NOT the raw JSON file) back for the next step.\n`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
