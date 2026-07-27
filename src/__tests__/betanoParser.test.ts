import { describe, it, expect } from 'vitest';
import {
  findKaizenStore,
  parseBetanoFixtures,
  parseBetanoPlayerProps,
} from '../adapters/betano/adapter';

/**
 * Store shaped exactly like the real danae-webapi capture of 20 Jul 2026:
 * flat events/markets/selections maps joined by ID lists, handicap on the
 * SELECTION, market types as short codes.
 */
const store = {
  events: {
    '89400001': {
      id: 89400001,
      zoneId: 189456,
      leagueId: 206500,
      sportId: 'BASK',
      ardSportId: 2,
      marketIdList: [3000000001, 3000000002, 3000000003],
      totalMarketsAvailable: 3,
      url: '/indiana-fever-new-york-liberty/89400001/',
      participants: [
        { name: 'Indiana Fever', isHome: true, teamId: 555001 },
        { name: 'New York Liberty', isHome: false, teamId: 555002 },
      ],
      willGoLive: true,
      startTime: 1784580000000, // epoch ms
      displayOrder: 1,
    },
    // A football event that must be ignored entirely
    '89400002': {
      id: 89400002,
      sportId: 'FOOT',
      ardSportId: 1,
      marketIdList: [3000000009],
      participants: [{ name: 'Arsenal', isHome: true }, { name: 'Chelsea', isHome: false }],
      startTime: 1784580000000,
    },
  },
  markets: {
    '3000000001': {
      id: 3000000001,
      selectionIdList: [4000000001, 4000000002, 4000000003, 4000000004],
      type: 'PLPT',
      typeId: 5001,
      name: 'Caitlin Clark Player Points (Incl. Overtime)',
      displayOrder: 500,
    },
    '3000000002': {
      id: 3000000002,
      selectionIdList: [4000000005, 4000000006],
      type: 'PLAS',
      typeId: 5002,
      name: 'Caitlin Clark Player Assists',
      displayOrder: 510,
    },
    '3000000003': {
      id: 3000000003,
      selectionIdList: [4000000007, 4000000008],
      type: 'MRES',
      typeId: 1,
      name: 'Match Result',
      displayOrder: 0,
    },
    '3000000009': {
      id: 3000000009,
      selectionIdList: [4000000009],
      type: 'MRES',
      typeId: 1,
      name: 'Match Result',
    },
  },
  selections: {
    // Player Points — alternate ladder, handicap ON THE SELECTION
    '4000000001': { id: 4000000001, price: 1.9, handicap: 18.5, name: 'Over 18.5', fullName: 'Over', typeId: 41 },
    '4000000002': { id: 4000000002, price: 1.86, handicap: 18.5, name: 'Under 18.5', fullName: 'Under', typeId: 42 },
    '4000000003': { id: 4000000003, price: 2.35, handicap: 20.5, name: 'Over 20.5', fullName: 'Over', typeId: 41 },
    '4000000004': { id: 4000000004, price: 1.55, handicap: 20.5, name: 'Under 20.5', fullName: 'Under', typeId: 42 },
    // Player Assists — single line
    '4000000005': { id: 4000000005, price: 1.83, handicap: 6.5, name: 'Over 6.5', fullName: 'Over', typeId: 41 },
    '4000000006': { id: 4000000006, price: 1.93, handicap: 6.5, name: 'Under 6.5', fullName: 'Under', typeId: 42 },
    // Match Result — no handicap, must not become a prop line
    '4000000007': { id: 4000000007, price: 1.62, name: '1', fullName: 'Indiana Fever', typeId: 1 },
    '4000000008': { id: 4000000008, price: 2.3, name: '2', fullName: 'New York Liberty', typeId: 3 },
    '4000000009': { id: 4000000009, price: 2.0, name: '1', fullName: 'Arsenal', typeId: 1 },
  },
};

const MARKET_MAP = [
  { pattern: 'player points', market: 'POINTS' as const },
  { pattern: 'player assists', market: 'ASSISTS' as const },
  { pattern: 'player rebounds', market: 'REBOUNDS' as const },
  { pattern: 'player 3[- ]point(ers)?( field goals)?( made)?', market: 'THREES' as const },
];

describe('Kaizen normalized store (danae-webapi shape)', () => {
  it('finds the store even when nested inside a wrapper object', () => {
    expect(findKaizenStore(store)).not.toBeNull();
    expect(findKaizenStore({ data: { payload: store } })).not.toBeNull();
    expect(findKaizenStore({ events: [], markets: {}, selections: {} })).toBeNull();
  });

  it('extracts only basketball fixtures, with epoch-ms start times', () => {
    const fixtures = parseBetanoFixtures(store);
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0].homeName).toBe('Indiana Fever');
    expect(fixtures[0].awayName).toBe('New York Liberty');
    expect(fixtures[0].externalId).toBe('89400001');
    expect(fixtures[0].startsAt.toISOString()).toBe('2026-07-20T20:40:00.000Z');
  });

  it('joins events → markets → selections and reads the handicap off the selection', () => {
    const props = parseBetanoPlayerProps(store, MARKET_MAP);
    const points = props.filter((p) => p.market === 'POINTS');
    const assists = props.filter((p) => p.market === 'ASSISTS');

    expect(points.map((p) => p.line).sort((a, b) => a - b)).toEqual([18.5, 20.5]);
    expect(assists).toHaveLength(1);
    expect(assists[0].line).toBe(6.5);
    expect(assists[0].overOdds).toBe(1.83);
    expect(assists[0].underOdds).toBe(1.93);
  });

  it('infers the player name by stripping the market phrase', () => {
    const props = parseBetanoPlayerProps(store, MARKET_MAP);
    for (const p of props) {
      expect(p.playerRawName.toLowerCase()).toContain('caitlin clark');
    }
  });

  it('never turns Match Result into a prop line', () => {
    const props = parseBetanoPlayerProps(store, MARKET_MAP);
    expect(props.some((p) => p.rawMarketName === 'Match Result')).toBe(false);
  });

  it('ignores non-basketball events entirely', () => {
    const props = parseBetanoPlayerProps(store, MARKET_MAP);
    expect(props.some((p) => p.rawMarketName.includes('Arsenal'))).toBe(false);
  });
});
