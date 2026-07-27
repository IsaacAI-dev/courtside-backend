import { describe, it, expect } from 'vitest';
import { wilsonLower } from '../lib/wilson';
import { normaliseName, splitSuffix, diceSimilarity, lastNameOf } from '../lib/normalise';
import { parseMinutes } from '../lib/dates';
import {
  weightedMean,
  simpleMean,
  stdDev,
  coefficientOfVariation,
  hitRateCurve,
  minutesTrendSlope,
  computeWindowForm,
  type LogLike,
} from '../services/form';
import { selectLine } from '../services/lineSelector';
import { scoreRecommendation, type ScoreContext } from '../services/scorer';

const mkLog = (over: Partial<LogLike> & { points: number; minutes: number }): LogLike => ({
  didNotPlay: false,
  assists: 0,
  rebounds: 0,
  threesMade: 0,
  gameDate: new Date(),
  ...over,
});

describe('wilson lower bound', () => {
  it('is deliberately pessimistic on five-game samples', () => {
    const w = wilsonLower(4, 5, 1.2816);
    expect(w).toBeGreaterThan(0.45);
    expect(w).toBeLessThan(0.60); // raw rate is 0.80 — the gap IS the point
  });
  it('converges toward the raw rate as n grows', () => {
    expect(wilsonLower(80, 100)).toBeGreaterThan(wilsonLower(8, 10));
    expect(wilsonLower(80, 100)).toBeLessThan(0.8);
  });
  it('returns 0 for an empty sample', () => {
    expect(wilsonLower(0, 0)).toBe(0);
  });
});

describe('name normalisation', () => {
  it('strips diacritics, punctuation and hyphens consistently', () => {
    expect(normaliseName('Nikola Jokić')).toBe('nikola jokic');
    expect(normaliseName("Shai Gilgeous-Alexander")).toBe('shai gilgeous alexander');
    expect(normaliseName("De'Aaron Fox")).toBe('deaaron fox');
    expect(normaliseName('  A’ja  Wilson ')).toBe('aja wilson');
  });
  it('keeps generational suffixes separable, never folded away', () => {
    expect(splitSuffix(normaliseName('Tim Hardaway Jr.'))).toEqual({ base: 'tim hardaway', suffix: 'jr' });
    expect(splitSuffix(normaliseName('Tim Hardaway'))).toEqual({ base: 'tim hardaway', suffix: null });
    expect(lastNameOf(normaliseName('Gary Payton II'))).toBe('payton');
  });
  it('scores similarity high for spelling variants and low for different people', () => {
    // A one-letter substitution in a first name lands ≈0.83 — BELOW the 0.85 fuzzy
    // threshold. That is not a bug: it is precisely why the structural tier
    // (last name + first initial, roster-constrained) runs BEFORE fuzzy matching.
    // "Caitlyn Clark" resolves at tier 4 against the Indiana roster and never
    // reaches tier 5. Anything that does reach tier 5 and scores below 0.85
    // goes to human review rather than being guessed at.
    const variant = diceSimilarity(normaliseName('Caitlin Clark'), normaliseName('Caitlyn Clark'));
    expect(variant).toBeGreaterThan(0.8);
    expect(variant).toBeLessThan(0.9);
    expect(diceSimilarity(normaliseName('Caitlin Clark'), normaliseName('Kelsey Mitchell'))).toBeLessThan(0.3);
  });
});

describe('minutes parsing', () => {
  it('handles the league feed’s MM:SS strings', () => {
    expect(parseMinutes('34:12')).toBeCloseTo(34.2, 1);
    expect(parseMinutes('28')).toBe(28);
    expect(parseMinutes('')).toBe(0);
    expect(parseMinutes(31.5)).toBe(31.5);
  });
});

describe('form maths', () => {
  it('weights recent games more heavily', () => {
    const rising = [30, 20, 15, 10, 5]; // most recent first
    expect(weightedMean(rising, 0.85)).toBeGreaterThan(simpleMean(rising));
    expect(weightedMean(rising, 1)).toBeCloseTo(simpleMean(rising), 6);
  });
  it('computes sample standard deviation and CV', () => {
    expect(stdDev([10, 10, 10, 10])).toBe(0);
    expect(coefficientOfVariation([10, 10, 10, 10])).toBe(0);
    expect(stdDev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 2);
  });
  it('detects a rising minutes trend', () => {
    const logs = [36, 34, 30, 26, 22].map((m) => mkLog({ points: 10, minutes: m }));
    expect(minutesTrendSlope(logs)).toBeGreaterThan(0); // most-recent-first ⇒ rising
  });
});

describe('hit rate curve and push handling', () => {
  const values = [20, 18, 22, 17, 25];
  it('counts strict exceedance for OVER', () => {
    const [p] = hitRateCurve(values, [19.5], 'OVER');
    expect(p.hits).toBe(3); // 20, 22, 25
    expect(p.pushes).toBe(0);
    expect(p.rate).toBeCloseTo(0.6);
  });
  it('treats an exact landing on a whole-number line as a push, not a loss', () => {
    const [p] = hitRateCurve([20, 18, 22, 17, 25], [20], 'OVER');
    expect(p.pushes).toBe(1);
    expect(p.hits).toBe(2); // 22, 25
    expect(p.rate).toBeCloseTo(2 / 4); // denominator excludes the push
  });
  it('inverts correctly for UNDER', () => {
    const [p] = hitRateCurve(values, [19.5], 'UNDER');
    expect(p.hits).toBe(2); // 18, 17
  });
});

describe('line selection (§4.5)', () => {
  const ladder = [15.5, 17.5, 19.5, 21.5];
  const values = [24, 22, 20, 18, 23]; // μ ≈ 21.4
  const curve = hitRateCurve(values, ladder, 'OVER');

  it('rejects when no rung meets the hit-rate threshold', () => {
    const cold = hitRateCurve([8, 9, 7, 10, 6], ladder, 'OVER');
    const r = selectLine({ ladder, curveL5: cold, muWeighted: 8, sigma: 1.5, threshold: 4, mode: 'BALANCED', side: 'OVER' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('NO_LINE_MEETS_RULE');
  });

  it('AGGRESSIVE takes the highest qualifying rung', () => {
    const r = selectLine({ ladder, curveL5: curve, muWeighted: 21.4, sigma: 2.4, threshold: 4, mode: 'AGGRESSIVE', side: 'OVER' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.line).toBe(19.5);
  });

  it('CONSERVATIVE takes the lowest qualifying rung', () => {
    const r = selectLine({ ladder, curveL5: curve, muWeighted: 21.4, sigma: 2.4, threshold: 4, mode: 'CONSERVATIVE', side: 'OVER' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.line).toBe(15.5);
  });

  it('BALANCED requires at least half a sigma of cushion', () => {
    const r = selectLine({ ladder, curveL5: curve, muWeighted: 21.4, sigma: 2.4, threshold: 4, mode: 'BALANCED', side: 'OVER' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.line).toBeLessThanOrEqual(19.5); // 21.4 − 19.5 = 1.9 ≥ 0.5σ (1.2)
  });

  it('never returns a line below Betano’s minimum offered line', () => {
    const r = selectLine({ ladder, curveL5: curve, muWeighted: 21.4, sigma: 2.4, threshold: 3, mode: 'CONSERVATIVE', side: 'OVER' });
    if (r.ok) expect(r.line).toBeGreaterThanOrEqual(Math.min(...ladder));
  });

  it('handles an empty ladder without throwing', () => {
    const r = selectLine({ ladder: [], curveL5: [], muWeighted: 10, sigma: 1, threshold: 4, mode: 'BALANCED', side: 'OVER' });
    expect(r.ok).toBe(false);
  });
});

describe('confidence scoring (§4.6)', () => {
  const logs: LogLike[] = [24, 22, 20, 18, 23, 21, 19, 25, 20, 22].map((p) =>
    mkLog({ points: p, minutes: 33 }),
  );
  const base = (over: Partial<ScoreContext> = {}): ScoreContext => {
    const formL5 = computeWindowForm(logs, 'POINTS', 5, 0.85);
    const formL10 = computeWindowForm(logs, 'POINTS', 10, 0.85);
    const values5 = logs.slice(0, 5).map((l) => l.points);
    const values10 = logs.slice(0, 10).map((l) => l.points);
    return {
      market: 'POINTS',
      line: 17.5,
      formL5,
      formL10,
      curvePointL5: hitRateCurve(values5, [17.5], 'OVER')[0],
      curvePointL10: hitRateCurve(values10, [17.5], 'OVER')[0],
      seasonHitRate: 0.8,
      gamesAvailable: 24,
      oppPaceZ: 0.5,
      oppDefZ: 0.3,
      isBackToBack: false,
      isThirdInFour: false,
      isFirstGameBack: false,
      spread: 4,
      fuzzyEntityMatch: false,
      lineAgeMinutes: 10,
      ...over,
    };
  };

  it('produces a tiered score with a full audit trail', () => {
    const r = scoreRecommendation(base(), 55);
    expect(r.confidence).toBeGreaterThan(55);
    expect(['A', 'B', 'C']).toContain(r.tier);
    expect(r.factors.filter((f) => f.kind === 'FACTOR')).toHaveLength(5);
    const contributions = r.factors.filter((f) => f.kind === 'FACTOR').reduce((s, f) => s + (f.contribution ?? 0), 0);
    expect(contributions).toBeGreaterThan(0);
  });

  it('penalises a back-to-back', () => {
    const normal = scoreRecommendation(base(), 55).confidence;
    const b2b = scoreRecommendation(base({ isBackToBack: true }), 55).confidence;
    expect(b2b).toBeLessThan(normal);
  });

  it('applies a heavy discount to a first game back', () => {
    const normal = scoreRecommendation(base(), 55).confidence;
    const back = scoreRecommendation(base({ isFirstGameBack: true }), 55).confidence;
    expect(back).toBeLessThan(normal * 0.7);
  });

  it('caps confidence hard on thin data — five games can never reach tier A', () => {
    const r = scoreRecommendation(base({ gamesAvailable: 5 }), 55);
    expect(r.confidence).toBeLessThanOrEqual(68);
    expect(r.tier).not.toBe('A');
    expect(r.factors.some((f) => f.kind === 'CAP')).toBe(true);
  });

  it('discounts fuzzy identity matches', () => {
    const clean = scoreRecommendation(base(), 55).confidence;
    const fuzzy = scoreRecommendation(base({ fuzzyEntityMatch: true }), 55).confidence;
    expect(fuzzy).toBeLessThan(clean);
  });

  it('returns tier null below the confidence floor', () => {
    const weak = scoreRecommendation(base({ line: 30, seasonHitRate: 0.05, oppPaceZ: -2, oppDefZ: -2 }), 55);
    expect(weak.tier).toBeNull();
  });
});
