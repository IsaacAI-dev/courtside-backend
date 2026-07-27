import { describe, it, expect } from 'vitest';
import { parseBetanoFixtures } from '../adapters/betano/adapter';

/**
 * Regression test for the CONFIRMED-WORKING fixtures shape (22 Jul 2026):
 * /api/sport/basketball/usa/wnba/440g/?req=la,s,stnf,c,mb returns a
 * data.blocks[] array; the WNBA block (id "17089") has events[] where each
 * event has NO `participants` array (unlike the danae-webapi match-odds
 * shape) — team names live only in `name`/`shortName` as a dash-separated
 * pair, and `startTime` is a direct numeric epoch-ms field. Field values
 * below are taken verbatim from a real captured response; this locks in
 * behaviour verified end-to-end against the actual file, not just reasoning
 * about the shape.
 *
 * This is also what finally surfaced the root cause of an entire debugging
 * session's worth of empty/wrong fixtures: the OLD fixturesUrl used league
 * code sl=441g (NBA), not sl=440g (WNBA) — both basketball, both regionId
 * 11326, trivially easy to conflate. That's why "Division Winner - Atlantic/
 * Central/Southeast" (real NBA divisions) ever appeared at all.
 */
const realWnbaBlock = {
  data: {
    blocks: [
      {
        name: 'USA - WNBA (W)',
        shortName: 'WNBA (W)',
        id: '17089',
        url: '/sport/basketball/usa/wnba-w/17089/',
        events: [
          {
            sportId: 'BASK',
            shortName: 'Washington Mystics (W) - Connecticut Sun (W)',
            totalMarketsAvailable: 248,
            betRadarId: 68095972,
            regionName: 'USA',
            regionId: '11326',
            leagueDescription: 'WNBA (W)',
            leagueId: '17089',
            leagueName: 'WNBA',
            id: '89034718',
            name: 'Washington Mystics (W) - Connecticut Sun (W)',
            startTime: 1785281400000,
            url: '/match-odds/washington-mystics-w-connecticut-sun-w/89034718/',
            markets: [
              {
                id: '2856068545',
                name: 'Winner',
                type: 'H2HT',
                typeId: 155,
                handicap: 0.0,
                marketCloseTimeMillis: 1785281400000,
                selections: [
                  { id: '9995007922', name: 'Washington Mystics (W)', price: 1.44 },
                  { id: '9995007923', name: 'Connecticut Sun (W)', price: 2.77 },
                ],
              },
            ],
          },
          {
            sportId: 'BASK',
            id: '89034743',
            name: 'Minnesota Lynx (W) - Toronto Tempo (W)',
            leagueId: '17089',
            startTime: 1785283200000,
            markets: [],
          },
        ],
      },
      // A second, non-WNBA block must not contaminate results.
      {
        name: 'USA - NBA Summer League',
        id: '99999',
        events: [
          { sportId: 'BASK', id: '77777', name: 'Some Team - Other Team', startTime: 1785290000000, markets: [] },
        ],
      },
    ],
  },
};

describe('parseBetanoFixtures against the confirmed-working blocks[].events[] shape', () => {
  const fixtures = parseBetanoFixtures(realWnbaBlock);

  it('extracts every event across every block (3 total)', () => {
    expect(fixtures).toHaveLength(3);
  });

  it('splits team names correctly from the dash-separated name field', () => {
    const first = fixtures.find((f) => f.externalId === '89034718')!;
    expect(first.homeName).toBe('Washington Mystics (W)');
    expect(first.awayName).toBe('Connecticut Sun (W)');
  });

  it('reads startTime as a direct epoch-ms number', () => {
    const first = fixtures.find((f) => f.externalId === '89034718')!;
    expect(first.startsAt.toISOString()).toBe('2026-07-28T23:30:00.000Z');
  });

  it('does not require a participants array (this shape never has one)', () => {
    // If this test suite ever needs a participants array to pass, that's a
    // sign the parser regressed toward the OTHER (danae-webapi) shape only.
    const second = fixtures.find((f) => f.externalId === '89034743')!;
    expect(second.homeName).toBe('Minnesota Lynx (W)');
    expect(second.awayName).toBe('Toronto Tempo (W)');
  });

  it('does not mistake a nested market object for a second fixture', () => {
    // The "Winner" market on the first event has its own id/name/selections —
    // must never surface as an independent fixture.
    expect(fixtures.some((f) => f.homeName === 'Winner' || f.awayName === 'Winner')).toBe(false);
    expect(fixtures.some((f) => f.externalId === '2856068545')).toBe(false);
  });
});
