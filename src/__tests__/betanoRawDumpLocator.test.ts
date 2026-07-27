import { describe, it, expect } from 'vitest';
import { findAllStoreShapes, outline, summariseBlocks } from '../scripts/dump-betano-raw';

/**
 * Verifies findAllStoreShapes actually locates a Kaizen store regardless of
 * how deep it's nested — needed because the real Betano fixtures payload's
 * top level (confirmed 22 Jul 2026: ["data", "structureComponents", "user",
 * "languages", "companyId", "regions"]) is a bigger app-bootstrap shape than
 * the danae-webapi payload the parser was originally built against, and the
 * real store's location within it is not yet known.
 */
describe('findAllStoreShapes locates a Kaizen store at any depth', () => {
  it('finds a full store nested several levels under "data", matching the real top-level shape', () => {
    const payload = {
      data: {
        someWidget: {
          basketballBoard: {
            events: { '1': { id: 1, sportId: 'BASK' } },
            markets: { '10': { id: 10 } },
            selections: { '100': { id: 100 } },
          },
        },
      },
      structureComponents: {},
      user: {},
      languages: {},
      companyId: 'abc',
      regions: [],
    };
    const found = findAllStoreShapes(payload);
    expect(found.some((f) => f.includes('FULL store') && f.includes('basketballBoard'))).toBe(true);
  });

  it('finds a partial store when selections is missing (plausible for a schedule-only page)', () => {
    const payload = {
      data: {
        events: { '1': { id: 1 } },
        markets: { '10': { id: 10 } },
      },
    };
    const found = findAllStoreShapes(payload);
    expect(found.some((f) => f.includes('PARTIAL store') && f.includes('has: events, markets'))).toBe(true);
  });

  it('reports nothing found for a payload with no store-shaped object anywhere', () => {
    const payload = { user: { id: 1 }, languages: ['en'], companyId: 'xyz' };
    const found = findAllStoreShapes(payload);
    expect(found).toEqual([]);
  });

  it('finds multiple stores if more than one exists at different paths', () => {
    const payload = {
      data: {
        widgetA: { events: { '1': {} }, markets: { '2': {} }, selections: { '3': {} } },
        widgetB: { events: { '4': {} }, markets: { '5': {} }, selections: { '6': {} } },
      },
    };
    const found = findAllStoreShapes(payload);
    expect(found.filter((f) => f.includes('FULL store'))).toHaveLength(2);
  });
});

describe('summariseBlocks shows every block, not just the first', () => {
  // Mirrors the real confirmed shape: an Outrights block first, plus other
  // blocks that could contain real per-game listings the old first-item-only
  // sampling made invisible.
  const blocks = [
    { name: 'USA - NBA - Outright Winner - Long term markets', outright: true, events: [{ id: 1 }] },
    { name: 'USA - WNBA - Today', outright: false, events: [{ id: 2, startTime: 123, participants: [] }] },
    { name: 'USA - WNBA - This Week', outright: false, events: [] },
  ];

  it('includes all three blocks in the summary, not just the first', () => {
    const lines = summariseBlocks(blocks);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('Outright Winner');
    expect(lines[1]).toContain('WNBA - Today');
    expect(lines[2]).toContain('WNBA - This Week');
  });

  it('reports event counts and outright flag per block', () => {
    const lines = summariseBlocks(blocks);
    expect(lines[0]).toContain('outright=true');
    expect(lines[1]).toContain('outright=false');
    expect(lines[1]).toContain('events=1');
    expect(lines[2]).toContain('events=0');
  });

  it('shows the first event\'s keys for a non-empty block, to spot real fixture fields at a glance', () => {
    const lines = summariseBlocks(blocks);
    expect(lines[1]).toContain('first event keys: id, startTime, participants');
  });

  it('handles a non-array input gracefully', () => {
    expect(summariseBlocks(null)).toEqual(['  (not an array)']);
  });
});

describe('outline reports structure without dumping full content', () => {
  it('summarises object keys and array lengths rather than printing every value', () => {
    const payload = { a: 1, b: 'hello world this is a long string that should be truncated in samples', c: [1, 2, 3] };
    const lines = outline(payload);
    const joined = lines.join('\n');
    expect(joined).toContain('3 keys');
    expect(joined).toContain('[] (3 items)');
  });

  it('respects maxDepth rather than recursing forever on deeply nested objects', () => {
    const deep = { a: { b: { c: { d: { e: { f: 'too deep' } } } } } };
    const lines = outline(deep, 0, 2);
    expect(lines.some((l) => l.includes('…'))).toBe(true);
  });
});
