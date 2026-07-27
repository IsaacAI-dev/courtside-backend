import { describe, it, expect } from 'vitest';
import {
  parseBetanoMatchOdds,
  selectionToLine,
  buildPlayersUrl,
  isMatchOddsPayload,
} from '../adapters/betano/matchOdds';
import { hitRateCurve } from '../services/form';

/**
 * Trimmed from the real Betano.ng capture of 21 Jul 2026:
 *   /api/match-odds/golden-state-valkyries-w-washington-mystics-w/88623579/
 *   ?bt=1&isPlayersToggle=true&req=la,s,stnf,c,mb,mbl
 * Values are verbatim from that response.
 */
const payload = {
  data: {
    event: {
      sportId: 'BASK',
      shortName: 'Golden State Valkyries (W) - Washington Mystics (W)',
      totalMarketsAvailable: 282,
      betRadarId: 68096138,
      regionId: '11326',
      leagueDescription: 'WNBA (W)',
      leagueId: '17089',
      leagueName: 'WNBA',
      id: '88623579',
      name: 'Golden State Valkyries (W) - Washington Mystics (W)',
      startTime: 1784599200000,
      url: '/match-odds/golden-state-valkyries-w-washington-mystics-w/88623579/',
      markets: [
        {
          id: '2864190499',
          name: 'Sonia Citron Total Points',
          type: 'PLNP',
          typeId: 1856,
          handicap: 0.0,
          marketCloseTimeMillis: 1784599200000,
          selections: [
            { id: '10028179060', name: '12+', price: 1.42, handicap: 12.0, typeId: 4983 },
            { id: '10028168557', name: '13+', price: 1.6, handicap: 13.0, typeId: 4983 },
            { id: '10028179061', name: '14+', price: 1.8, handicap: 14.0, typeId: 4983 },
            { id: '10028168558', name: '15+', price: 2.07, handicap: 15.0, typeId: 4983 },
            { id: '10028179062', name: '16+', price: 2.42, handicap: 16.0, typeId: 4983 },
          ],
          teamId: '1923185',
          playerId: '19297499',
        },
        {
          id: '2864190498',
          name: 'Kiki Iriafen Total Assists',
          type: 'PALA',
          typeId: 1853,
          selections: [
            { id: '10028168554', name: '2+', price: 1.57, handicap: 2.0, typeId: 4980 },
            { id: '10028168555', name: '3+', price: 2.72, handicap: 3.0, typeId: 4980 },
            { id: '10028168556', name: '4+', price: 5.4, handicap: 4.0, typeId: 4980 },
          ],
          teamId: '1923185',
          playerId: '19297502',
        },
        {
          id: '2864190495',
          name: 'Kiki Iriafen Total Rebounds',
          type: 'PLTR',
          typeId: 1858,
          selections: [
            { id: '10028179069', name: '8+', price: 1.35, handicap: 8.0, typeId: 4985 },
            { id: '10028168530', name: '9+', price: 1.65, handicap: 9.0, typeId: 4985 },
            { id: '10028168531', name: '10+', price: 2.12, handicap: 10.0, typeId: 4985 },
          ],
          teamId: '1923185',
          playerId: '19297502',
        },
        {
          id: '2864190501',
          name: 'Sonia Citron Total Three Point Shots Scored',
          type: 'P3PG',
          typeId: 1852,
          selections: [
            { id: '10028168575', name: '1+', price: 1.32, handicap: 1.0, typeId: 4979 },
            { id: '10028168576', name: '2+', price: 2.55, handicap: 2.0, typeId: 4979 },
          ],
          teamId: '1923185',
          playerId: '19297499',
        },
        // Not one of the four Courtside markets — must be recorded, not parsed as a prop
        {
          id: '2864190444',
          name: 'Double-double [Kiki Iriafen]',
          type: 'X035',
          typeId: 1797,
          selections: [
            { id: '10028168377', name: 'Yes', price: 2.37, handicap: 0.0, typeId: 4841 },
            { id: '10028168378', name: 'No', price: 1.5, handicap: 0.0, typeId: 4842 },
          ],
          teamId: '1923185',
          playerId: '19297502',
        },
        // Outright with player-named selections — must NOT become prop lines
        {
          id: '2844389618',
          name: 'Top Points Scorer in the Game',
          type: 'X043',
          typeId: 2021,
          selections: [
            { id: '10028196739', name: 'Gabby Williams', price: 3.05, handicap: 0.0, typeId: 5284, playerId: '19172991' },
            { id: '10028196741', name: 'Sonia Citron', price: 3.55, handicap: 0.0, typeId: 5284, playerId: '19297499' },
          ],
        },
      ],
      participants: [
        { name: 'Golden State Valkyries (W)', id: '2061569' },
        { name: 'Washington Mystics (W)', id: '1923185' },
      ],
    },
    playersTabFilters: {
      roster: {
        homeRoster: {
          id: 2061569,
          name: 'Golden State Valkyries (W)',
          players: {
            '19203942': { id: 19203942, name: 'Veronica Burton', shortName: 'V. Burton' },
            '19172991': { id: 19172991, name: 'Gabby Williams', shortName: 'G. Williams' },
            '19234970': { id: 19234970, name: 'Janelle Salaun', shortName: 'J. Salaun' },
          },
        },
        awayRoster: {
          id: 1923185,
          name: 'Washington Mystics (W)',
          players: {
            '19297499': { id: 19297499, name: 'Sonia Citron', shortName: 'S. Citron' },
            '19297502': { id: 19297502, name: 'Kiki Iriafen', shortName: 'K. Iriafen' },
            '19203433': { id: 19203433, name: 'Shakira Austin', shortName: 'S. Austin' },
          },
        },
      },
    },
  },
};

describe('milestone → half-point line conversion', () => {
  it('converts "n+" to n − 0.5, which is exactly equivalent for integer stats', () => {
    expect(selectionToLine('12+', 12)).toEqual({ line: 11.5, milestoneLabel: '12+', side: 'OVER' });
    expect(selectionToLine('1+', 1)).toEqual({ line: 0.5, milestoneLabel: '1+', side: 'OVER' });
  });

  it('falls back to the label when handicap is absent', () => {
    expect(selectionToLine('9+', null)?.line).toBe(8.5);
  });

  it('still handles genuine Over/Under selections', () => {
    expect(selectionToLine('Over 18.5', 18.5)).toEqual({ line: 18.5, milestoneLabel: null, side: 'OVER' });
    expect(selectionToLine('Under 18.5', 18.5)).toEqual({ line: 18.5, milestoneLabel: null, side: 'UNDER' });
  });

  it('ignores selections that are neither', () => {
    expect(selectionToLine('Yes', 0)).toBeNull();
    expect(selectionToLine('Gabby Williams', 0)).toBeNull();
  });

  it('makes "12+" and "Over 11.5" score identically on real values', () => {
    const values = [14, 11, 12, 18, 9]; // 12+ hits on 14, 12, 18 → 3
    const [asOver] = hitRateCurve(values, [11.5], 'OVER');
    expect(asOver.hits).toBe(3);
    expect(asOver.pushes).toBe(0); // a half-point line cannot push
    expect(asOver.rate).toBeCloseTo(0.6);
  });
});

describe('Betano match-odds Players payload', () => {
  const parsed = parseBetanoMatchOdds(payload)!;

  it('recognises the payload shape', () => {
    expect(isMatchOddsPayload(payload)).toBe(true);
    expect(isMatchOddsPayload({ data: {} })).toBe(false);
  });

  it('reads event metadata, including the Sportradar id', () => {
    expect(parsed.eventId).toBe('88623579');
    expect(parsed.leagueName).toBe('WNBA');
    expect(parsed.betRadarId).toBe(68096138);
    expect(parsed.totalMarketsAvailable).toBe(282);
    expect(parsed.startsAt?.toISOString()).toBe('2026-07-21T02:00:00.000Z');
    expect(parsed.eventPath).toBe('/match-odds/golden-state-valkyries-w-washington-mystics-w/88623579/');
  });

  it('takes home/away from the roster rather than guessing from name order', () => {
    expect(parsed.homeTeam).toEqual({ id: '2061569', name: 'Golden State Valkyries (W)' });
    expect(parsed.awayTeam).toEqual({ id: '1923185', name: 'Washington Mystics (W)' });
  });

  it('extracts both rosters with Betano player ids', () => {
    expect(parsed.roster).toHaveLength(6);
    const citron = parsed.roster.find((r) => r.playerId === '19297499');
    expect(citron?.name).toBe('Sonia Citron');
    expect(citron?.isHome).toBe(false);
    expect(citron?.teamId).toBe('1923185');
  });

  it('maps all four Courtside markets from their type codes', () => {
    const markets = new Set(parsed.props.map((p) => p.market));
    expect(markets).toEqual(new Set(['POINTS', 'ASSISTS', 'REBOUNDS', 'THREES']));
  });

  it('converts the points ladder to half-point lines', () => {
    const points = parsed.props.filter((p) => p.market === 'POINTS').sort((a, b) => a.line - b.line);
    expect(points.map((p) => p.line)).toEqual([11.5, 12.5, 13.5, 14.5, 15.5]);
    expect(points[0].milestoneLabel).toBe('12+');
    expect(points[0].overOdds).toBe(1.42);
    expect(points[0].underOdds).toBeNull(); // milestones have no Under side
    expect(points[0].isMilestone).toBe(true);
  });

  it('carries Betano player ids so no name matching is needed', () => {
    const assists = parsed.props.filter((p) => p.market === 'ASSISTS');
    expect(assists[0].playerId).toBe('19297502');
    expect(assists[0].playerName).toBe('Kiki Iriafen');
    expect(assists[0].teamId).toBe('1923185');
  });

  it('records unmodelled player markets instead of dropping them silently', () => {
    const types = parsed.otherPlayerMarkets.map((m) => m.type);
    expect(types).toContain('X035'); // Double-double
    expect(types).toContain('X043'); // Top Points Scorer
  });

  it('never turns outright selections named after players into prop lines', () => {
    expect(parsed.props.some((p) => p.rawMarketName.includes('Top Points Scorer'))).toBe(false);
    expect(parsed.props.some((p) => p.rawMarketName.includes('Double-double'))).toBe(false);
  });

  it('builds the Players-tab URL from the event path', () => {
    expect(buildPlayersUrl('https://www.betano.ng', parsed.eventPath!)).toBe(
      'https://www.betano.ng/api/match-odds/golden-state-valkyries-w-washington-mystics-w/88623579/?bt=1&isPlayersToggle=true&req=la,s,stnf,c,mb,mbl',
    );
  });
});

describe('milestone lines flow end-to-end through the analytics', () => {
  it('selects a line and scores it using a real Betano ladder', async () => {
    const { selectLine } = await import('../services/lineSelector');
    const { computeWindowForm, hitRateCurve, marketValues } = await import('../services/form');
    const { scoreRecommendation } = await import('../services/scorer');

    const parsed = parseBetanoMatchOdds(payload)!;
    const ladder = parsed.props
      .filter((p) => p.market === 'POINTS')
      .map((p) => p.line)
      .sort((a, b) => a - b);
    expect(ladder).toEqual([11.5, 12.5, 13.5, 14.5, 15.5]); // from "12+".."16+"

    // Sonia Citron-shaped last-10: consistent mid-teens scorer
    const logs = [16, 14, 18, 13, 17, 15, 19, 12, 16, 14].map((points) => ({
      didNotPlay: false,
      minutes: 31,
      points,
      assists: 3,
      rebounds: 5,
      threesMade: 2,
      gameDate: new Date(),
    }));

    const formL5 = computeWindowForm(logs, 'POINTS', 5, 0.85);
    const formL10 = computeWindowForm(logs, 'POINTS', 10, 0.85);
    const valuesL5 = marketValues(logs.slice(0, 5), 'POINTS');
    const curveL5 = hitRateCurve(valuesL5, ladder, 'OVER');

    // No rung can push — every line is a half-point by construction
    expect(curveL5.every((p) => p.pushes === 0)).toBe(true);

    const selection = selectLine({
      ladder,
      curveL5,
      muWeighted: formL5.meanWeighted,
      sigma: formL5.stdDev,
      threshold: 4,
      mode: 'BALANCED',
      side: 'OVER',
    });
    expect(selection.ok).toBe(true);
    if (!selection.ok) return;

    // Never below Betano's lowest offered rung (§4.5 step 4)
    expect(selection.line).toBeGreaterThanOrEqual(Math.min(...ladder));

    const pointL5 = curveL5.find((p) => p.line === selection.line)!;
    const curveL10 = hitRateCurve(marketValues(logs, 'POINTS'), ladder, 'OVER');
    const score = scoreRecommendation(
      {
        market: 'POINTS',
        line: selection.line,
        formL5,
        formL10,
        curvePointL5: pointL5,
        curvePointL10: curveL10.find((p) => p.line === selection.line)!,
        seasonHitRate: null,
        gamesAvailable: 10,
        oppPaceZ: 0.3,
        oppDefZ: 0.2,
        isBackToBack: false,
        isThirdInFour: false,
        isFirstGameBack: false,
        spread: -3.5,
        fuzzyEntityMatch: false, // Betano gives us playerId — never fuzzy here
        lineAgeMinutes: 5,
      },
      55,
    );

    expect(score.confidence).toBeGreaterThan(0);
    // 10 games caps below tier A (§4.6.4)
    expect(score.confidence).toBeLessThanOrEqual(82);

    // The recommendation is displayable in Betano's own language
    const chosen = parsed.props.find((p) => p.market === 'POINTS' && p.line === selection.line)!;
    expect(chosen.milestoneLabel).toBe(`${selection.line + 0.5}+`);
    expect(chosen.overOdds).toBeGreaterThan(1);
  });
});
