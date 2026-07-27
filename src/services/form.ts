/**
 * Form analysis (spec §4.4) — pure functions over game logs.
 * DNP rows are excluded from form maths but counted by the availability gate.
 */
import { wilsonLower } from '../lib/wilson';
import { MARKET_TO_LOG_FIELD, type Market, type Side } from '../lib/types';

export interface LogLike {
  didNotPlay: boolean;
  minutes: number;
  points: number;
  assists: number;
  rebounds: number;
  threesMade: number;
  gameDate: Date;
}

/** Most-recent-first values for a market, excluding DNPs. */
export function marketValues(logs: LogLike[], market: Market): number[] {
  const field = MARKET_TO_LOG_FIELD[market];
  return logs.filter((g) => !g.didNotPlay).map((g) => g[field] as number);
}

/** Exponential recency weighting: weight λ^i, most recent first (§4.4.2). λ=1 → plain mean. */
export function weightedMean(values: number[], lambda: number): number {
  if (!values.length) return 0;
  let num = 0;
  let den = 0;
  values.forEach((v, i) => {
    const w = Math.pow(lambda, i);
    num += v * w;
    den += w;
  });
  return num / den;
}

export const simpleMean = (values: number[]): number =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;

export function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mu = simpleMean(values);
  const variance = values.reduce((a, v) => a + (v - mu) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export const coefficientOfVariation = (values: number[]): number => {
  const mu = simpleMean(values);
  return mu > 0 ? stdDev(values) / mu : 0;
};

export interface HitRatePoint {
  line: number;
  hits: number;
  pushes: number;
  n: number;
  /** hits / (n − pushes); a push is neither win nor loss (§4.4.3). */
  rate: number;
}

/**
 * Hit-rate at each ladder rung. Exact landings on whole-number lines are pushes:
 * excluded from the denominator, never counted as hits. Half-point lines cannot push.
 */
export function hitRateCurve(values: number[], lines: number[], side: Side = 'OVER'): HitRatePoint[] {
  return lines.map((line) => {
    const wholeNumber = Number.isInteger(line);
    let hits = 0;
    let pushes = 0;
    for (const v of values) {
      if (wholeNumber && v === line) pushes++;
      else if (side === 'OVER' ? v > line : v < line) hits++;
    }
    const denom = values.length - pushes;
    return { line, hits, pushes, n: values.length, rate: denom > 0 ? hits / denom : 0 };
  });
}

/** Least-squares slope of minutes over time — the earliest role-change warning (§11.3.3). */
export function minutesTrendSlope(logs: LogLike[]): number {
  const mins = logs.filter((g) => !g.didNotPlay).map((g) => g.minutes);
  const n = mins.length;
  if (n < 3) return 0;
  // x = 0 (oldest) … n-1 (newest); logs arrive most-recent-first, so reverse.
  const ys = [...mins].reverse();
  const xMean = (n - 1) / 2;
  const yMean = simpleMean(ys);
  let num = 0;
  let den = 0;
  ys.forEach((y, x) => {
    num += (x - xMean) * (y - yMean);
    den += (x - xMean) ** 2;
  });
  return den > 0 ? num / den : 0;
}

export interface WindowForm {
  window: number;
  games: number;
  meanWeighted: number;
  meanSimple: number;
  stdDev: number;
  cv: number;
  minutesMean: number;
  minutesCv: number;
  minutesSlope: number;
}

export function computeWindowForm(
  logs: LogLike[],
  market: Market,
  window: number,
  lambda: number,
): WindowForm {
  const played = logs.filter((g) => !g.didNotPlay).slice(0, window);
  const values = marketValues(played, market);
  const mins = played.map((g) => g.minutes);
  return {
    window,
    games: values.length,
    meanWeighted: weightedMean(values, lambda),
    meanSimple: simpleMean(values),
    stdDev: stdDev(values),
    cv: coefficientOfVariation(values),
    minutesMean: simpleMean(mins),
    minutesCv: coefficientOfVariation(mins),
    minutesSlope: minutesTrendSlope(played),
  };
}

/** Wilson blend across L5 / L10 / season windows (§4.6.1). */
export function blendedHitProbability(
  l5: HitRatePoint,
  l10: HitRatePoint,
  seasonRate: number | null,
  zScore: number,
  blend: { l5: number; l10: number; season: number },
): number {
  const w5 = wilsonLower(l5.hits, l5.n - l5.pushes, zScore);
  const w10 = wilsonLower(l10.hits, l10.n - l10.pushes, zScore);
  const season = seasonRate ?? w10; // no season sample → lean on L10
  return blend.l5 * w5 + blend.l10 * w10 + blend.season * season;
}
