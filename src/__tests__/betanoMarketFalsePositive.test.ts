import { describe, it, expect } from 'vitest';
import { parseBetanoFixtures } from '../adapters/betano/adapter';

/**
 * Regression test for a real bug (22 Jul 2026): the generic fixture-heuristic
 * walker in parseBetanoFixtures matched an outright/futures betting MARKET
 * ("Division Winner Regular season") from another sport, bundled onto the
 * same competitions page, as if it were a real fixture:
 *   - obj.name ("...Regular season - Atlantic") satisfied the "Team A - Team
 *     B" name-splitting heuristic, producing fake home/away team names.
 *   - obj.marketCloseTimeMillis (a betting deadline, not a kickoff time)
 *     satisfied the broad /time/i key match in extractStart, producing a
 *     "fixture" dated ~10 months in the future.
 * All 9 real Betano fixtures in that response were of this shape, and every
 * one silently fell outside any reasonable reconciliation window — with no
 * error, just a fixture count of 9 that never became a matched/betanoOnly
 * count. This is the exact object shape captured from the real payload.
 */
const realMarketObject = {
  id: 2811341158,
  uniqueId: 'uniq-abc',
  name: 'Division Winner Regular season - Atlantic',
  type: 'X999',
  typeId: 9001,
  handicap: 0,
  displayOrder: 5,
  marketCloseTimeMillis: 1809555600000, // ~2027-05-01, a real betting deadline
  renderingLayout: 'default',
  selections: [
    { id: 1, name: 'Atlantic', price: 3.5 },
    { id: 2, name: 'Central', price: 4.2 },
  ],
  scorerSelections: [],
  exactScoreSelections: [],
};

const realFixtureObject = {
  id: 88623579,
  participants: [{ name: 'Golden State Valkyries (W)' }, { name: 'Washington Mystics (W)' }],
  startTime: 1784599200000, // real, confirmed epoch-ms kickoff time
};

describe('parseBetanoFixtures rejects market objects bundled onto the same page', () => {
  it('never parses an outright/futures market as a fixture', () => {
    const fixtures = parseBetanoFixtures({ someWrapper: { data: [realMarketObject] } });
    expect(fixtures).toHaveLength(0);
  });

  it('does not mistake the market close deadline for a kickoff time even if reached', () => {
    // Even via the raw heuristic path (no Kaizen store present), the object
    // must never surface with a startsAt derived from marketCloseTimeMillis.
    const fixtures = parseBetanoFixtures([realMarketObject]);
    expect(fixtures.some((f) => f.startsAt.getFullYear() === 2027)).toBe(false);
  });

  it('still parses a real fixture object correctly, unaffected by the guard', () => {
    const fixtures = parseBetanoFixtures([realFixtureObject]);
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0].homeName).toBe('Golden State Valkyries (W)');
    expect(fixtures[0].awayName).toBe('Washington Mystics (W)');
    expect(fixtures[0].startsAt.toISOString()).toBe('2026-07-21T02:00:00.000Z');
  });

  it('rejects the market even when mixed alongside a real fixture in the same payload', () => {
    const fixtures = parseBetanoFixtures([realMarketObject, realFixtureObject]);
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0].externalId).toBe('88623579');
  });

  it('still finds a real fixture nested inside a market-shaped wrapper', () => {
    // The guard descends into a market object rather than stopping cold, in
    // case a real fixture is unusually nested underneath one.
    const nested = { ...realMarketObject, unexpectedNestedFixture: realFixtureObject };
    const fixtures = parseBetanoFixtures([nested]);
    expect(fixtures.some((f) => f.externalId === '88623579')).toBe(true);
  });
});
