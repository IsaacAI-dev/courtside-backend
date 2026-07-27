/**
 * Confidence scoring (spec §4.6). Five weighted factors → base score,
 * gate multipliers applied, capped by data sufficiency. Every component is
 * returned for persistence into RecommendationFactor so any historical score
 * can be reconstructed and re-litigated (§8.1).
 *
 * Honesty note carried over from §16.3: the output is a relative ranking of
 * how well a bet satisfies THIS model's criteria — not a win probability.
 * Calibration (§14.3) is what eventually gives the number meaning.
 */
import { getScoringConfig, type ScoringConfig } from './scoringConfig';
import { blendedHitProbability, type HitRatePoint, type WindowForm } from './form';
import type { Market } from '../lib/types';

export interface FactorRow {
  kind: 'FACTOR' | 'MULTIPLIER' | 'CAP';
  name: string;
  value: number;
  weight?: number;
  contribution?: number;
  note?: string;
}

export interface ScoreContext {
  market: Market;
  line: number;
  formL5: WindowForm;
  formL10: WindowForm;
  curvePointL5: HitRatePoint;
  curvePointL10: HitRatePoint;
  seasonHitRate: number | null;
  gamesAvailable: number;
  // matchup inputs (opponent), null when unknown
  oppPaceZ: number | null; // z-score vs league
  oppDefZ: number | null; // positive = worse defence faced (more points allowed)
  // context multipliers
  isBackToBack: boolean;
  isThirdInFour: boolean;
  isFirstGameBack: boolean;
  spread: number | null;
  fuzzyEntityMatch: boolean;
  lineAgeMinutes: number | null;
}

export interface ScoreResult {
  confidence: number;
  tier: 'A' | 'B' | 'C' | null; // null = below floor
  factors: FactorRow[];
  scoringVersion: string;
}

const clamp = (v: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, v));

export function scoreRecommendation(ctx: ScoreContext, confidenceFloor: number): ScoreResult {
  const cfg = getScoringConfig();
  const factors: FactorRow[] = [];

  // ── Factor 1 · hitrate (Wilson blend, §4.6.1) ──
  const blended = blendedHitProbability(
    ctx.curvePointL5,
    ctx.curvePointL10,
    ctx.seasonHitRate,
    cfg.wilson.z,
    cfg.wilson.windowBlend,
  );
  const hitrateValue = clamp(blended * 100);
  factors.push(factor('hitrate', hitrateValue, cfg.weights.hitrate));

  // ── Factor 2 · cushion (§4.6.2): z of the mean above the line ──
  const sigma = Math.max(ctx.formL5.stdDev, cfg.cushion.sigmaFloor);
  const z = (ctx.formL5.meanWeighted - ctx.line) / sigma;
  const cushionValue = clamp(50 + z * cfg.cushion.scale);
  factors.push(factor('cushion', cushionValue, cfg.weights.cushion, `z=${z.toFixed(2)}σ`));

  // ── Factor 3 · consistency (§4.6.3): CV against a per-market reference ──
  const cvRef = cfg.consistency.cvRef[ctx.market] ?? 0.5;
  const consistencyValue = clamp(100 * (1 - ctx.formL5.cv / cvRef));
  factors.push(factor('consistency', consistencyValue, cfg.weights.consistency, `cv=${ctx.formL5.cv.toFixed(2)} ref=${cvRef}`));

  // ── Factor 4 · minutes security ──
  const m = cfg.minutes;
  const span = Math.max(1, m.targetMinutes - m.hardFloorMinutes);
  const minutesBase = clamp(((ctx.formL5.minutesMean - m.hardFloorMinutes) / span) * 100);
  const volatility = ctx.formL5.minutesCv * m.volatilityPenalty;
  const trend = ctx.formL5.minutesSlope > 0 ? m.trendBonus : 0;
  const minutesValue = clamp(minutesBase - volatility + trend);
  factors.push(
    factor('minutes', minutesValue, cfg.weights.minutes, `μmin=${ctx.formL5.minutesMean.toFixed(1)} cv=${ctx.formL5.minutesCv.toFixed(2)} slope=${ctx.formL5.minutesSlope.toFixed(2)}`),
  );

  // ── Factor 5 · matchup (§4.6.3): pace first, defence second. Neutral 50 when unknown. ──
  const paceComponent = ctx.oppPaceZ != null ? ctx.oppPaceZ * 10 * cfg.matchup.paceWeight : 0;
  const defComponent = ctx.oppDefZ != null ? ctx.oppDefZ * 10 * cfg.matchup.defWeight : 0;
  const matchupValue = clamp(50 + paceComponent + defComponent);
  factors.push(
    factor(
      'matchup',
      matchupValue,
      cfg.weights.matchup,
      ctx.oppPaceZ == null && ctx.oppDefZ == null ? 'no opponent data — neutral' : `paceZ=${ctx.oppPaceZ?.toFixed(2) ?? '·'} defZ=${ctx.oppDefZ?.toFixed(2) ?? '·'}`,
    ),
  );

  const base = factors.reduce((s, f) => s + (f.contribution ?? 0), 0);

  // ── Gate multipliers ──
  const mult = cfg.multipliers;
  const multipliers: FactorRow[] = [];
  const pushMult = (name: string, value: number, note?: string) =>
    multipliers.push({ kind: 'MULTIPLIER', name, value, note });

  pushMult('backToBack', ctx.isBackToBack ? mult.backToBack : 1.0, ctx.isBackToBack ? 'second night' : 'n/a');
  if (ctx.isThirdInFour) pushMult('thirdInFour', mult.thirdInFour, 'schedule density');
  if (ctx.isFirstGameBack) pushMult('firstGameBack', mult.firstGameBack, 'first game back from absence');
  const blowout = ctx.spread != null && Math.abs(ctx.spread) >= mult.blowoutSpreadThreshold;
  pushMult('blowoutRisk', blowout ? mult.blowoutRisk : 1.0, `spread ${ctx.spread ?? 'unknown'}${blowout ? '' : ', below threshold'}`);
  if (ctx.fuzzyEntityMatch) pushMult('fuzzyEntityMatch', mult.fuzzyEntityMatch, 'identity matched fuzzily (§6.5)');
  const stale = ctx.lineAgeMinutes != null && ctx.lineAgeMinutes > mult.staleLineMinutes;
  if (stale) pushMult('staleLines', mult.staleLines, `lines ${ctx.lineAgeMinutes}m old`);

  const multProduct = multipliers.reduce((p, m2) => p * m2.value, 1);
  let confidence = base * multProduct;

  // ── Data-sufficiency cap (§4.6.4): five games cannot yield tier A, ever. ──
  const caps = [...cfg.dataSufficiencyCaps].sort((a, b) => b.minGames - a.minGames);
  const cap = caps.find((c) => ctx.gamesAvailable >= c.minGames)?.cap ?? 0;
  const capped = confidence > cap;
  if (capped) {
    factors.push({ kind: 'CAP', name: 'dataSufficiency', value: cap, note: `${ctx.gamesAvailable} games → cap ${cap}` });
    confidence = cap;
  }

  confidence = Math.round(confidence * 10) / 10;

  const tier: ScoreResult['tier'] =
    confidence >= cfg.tiers.A ? 'A' : confidence >= cfg.tiers.B ? 'B' : confidence >= confidenceFloor ? 'C' : null;

  return { confidence, tier, factors: [...factors, ...multipliers], scoringVersion: cfg.version };
}

function factor(name: string, value: number, weight: number, note?: string): FactorRow {
  return { kind: 'FACTOR', name, value: round1(value), weight, contribution: round2(value * weight), note };
}
const round1 = (v: number) => Math.round(v * 10) / 10;
const round2 = (v: number) => Math.round(v * 100) / 100;
