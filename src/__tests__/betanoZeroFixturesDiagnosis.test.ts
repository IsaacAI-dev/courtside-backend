import { describe, it, expect } from 'vitest';
import { debugBetanoFixtureCount } from '../adapters/betano/adapter';

/**
 * Verifies debugBetanoFixtureCount actually distinguishes three DIFFERENT
 * reasons parseBetanoFixtures can return zero — which otherwise look
 * identical from the outside (added 22 Jul 2026, once the market
 * false-positive fix started correctly returning 0 for a payload that
 * turned out to contain no real basketball events at all on that pass).
 */
describe('debugBetanoFixtureCount distinguishes why zero fixtures came back', () => {
  it('reports no store found at all, for a payload with no Kaizen shape', () => {
    const result = debugBetanoFixtureCount({ something: 'unrelated', nested: { other: 1 } });
    expect(result.storeFound).toBe(false);
    expect(result.topLevelKeys).toEqual(['something', 'nested']);
  });

  it('reports a store found but zero basketball events, with the real sport breakdown', () => {
    const store = {
      events: {
        '1': { id: 1, sportId: 'FOOT', participants: [{}, {}], startTime: 123 },
        '2': { id: 2, sportId: 'TENN', participants: [{}, {}], startTime: 123 },
      },
      markets: {},
      selections: {},
    };
    const result = debugBetanoFixtureCount(store);
    expect(result.storeFound).toBe(true);
    expect(result.totalEvents).toBe(2);
    expect(result.basketballEvents).toBe(0);
    expect(result.sportIdBreakdown).toEqual({ FOOT: 1, TENN: 1 });
  });

  it('reports basketball events present but missing required fields', () => {
    const store = {
      events: {
        '1': { id: 1, sportId: 'BASK', participants: [{ name: 'Only One Team' }], startTime: 123 },
        '2': { id: 2, sportId: 'BASK', participants: [{}, {}] }, // no startTime at all
      },
      markets: {},
      selections: {},
    };
    const result = debugBetanoFixtureCount(store);
    expect(result.storeFound).toBe(true);
    expect(result.basketballEvents).toBe(2);
    expect(result.basketballMissingParticipants).toBe(1);
    expect(result.basketballMissingStart).toBe(1);
  });

  it('reports zero problems for genuinely healthy basketball events', () => {
    const store = {
      events: {
        '1': { id: 1, sportId: 'BASK', participants: [{ isHome: true }, { isHome: false }], startTime: 1784599200000 },
      },
      markets: {},
      selections: {},
    };
    const result = debugBetanoFixtureCount(store);
    expect(result.basketballEvents).toBe(1);
    expect(result.basketballMissingParticipants).toBe(0);
    expect(result.basketballMissingStart).toBe(0);
  });
});
