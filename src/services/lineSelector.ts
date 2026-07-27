/**
 * Line selection and the suppression rule (spec §4.5) — stated precisely and
 * implemented exactly as documented, including the structurally-redundant
 * step 4, which becomes load-bearing the moment non-ladder lines are allowed.
 */
import { logger } from '../lib/logger';
import type { HitRatePoint } from './form';
import type { Side } from '../lib/types';

export type SelectionMode = 'AGGRESSIVE' | 'BALANCED' | 'CONSERVATIVE';

export interface LineSelectionInput {
  ladder: number[]; // ascending Betano lines for this player+market
  curveL5: HitRatePoint[]; // aligned to ladder
  muWeighted: number;
  sigma: number;
  threshold: number; // 3 or 4 (of 5)
  mode: SelectionMode;
  side: Side;
}

export type LineSelectionResult =
  | { ok: true; line: number; side: Side }
  | { ok: false; reason: 'NO_LINE_MEETS_RULE' | 'BELOW_BETANO_MINIMUM'; detail: string };

export function selectLine(input: LineSelectionInput): LineSelectionResult {
  const { ladder, curveL5, muWeighted, sigma, threshold, mode, side } = input;
  if (!ladder.length) {
    return { ok: false, reason: 'NO_LINE_MEETS_RULE', detail: 'empty ladder' };
  }
  const curveByLine = new Map(curveL5.map((p) => [p.line, p]));

  // 1. Candidate set: rungs the player clears often enough, sitting on the
  //    favourable side of the weighted mean.
  const candidates = ladder.filter((L) => {
    const p = curveByLine.get(L);
    if (!p) return false;
    const enoughHits = p.hits >= threshold;
    const meanOnRightSide = side === 'OVER' ? muWeighted >= L : muWeighted <= L;
    return enoughHits && meanOnRightSide;
  });

  // 2. No candidate → no recommendation for this player+market.
  if (!candidates.length) {
    return {
      ok: false,
      reason: 'NO_LINE_MEETS_RULE',
      detail: `no rung with ≥${threshold}/5 hits and μw on the ${side} side (μw=${muWeighted.toFixed(1)})`,
    };
  }

  // 3. Pick per mode. For OVER, "highest" maximises cushion taken; UNDER inverts.
  const sorted = [...candidates].sort((a, b) => (side === 'OVER' ? a - b : b - a));
  let recommended: number;
  switch (mode) {
    case 'AGGRESSIVE':
      recommended = sorted[sorted.length - 1];
      break;
    case 'CONSERVATIVE':
      recommended = sorted[0];
      break;
    case 'BALANCED': {
      // Highest rung that still leaves ≥ 0.5σ of cushion.
      const cushioned = sorted.filter((L) =>
        side === 'OVER' ? muWeighted - L >= 0.5 * sigma : L - muWeighted >= 0.5 * sigma,
      );
      recommended = cushioned.length ? cushioned[cushioned.length - 1] : sorted[0];
      break;
    }
  }

  // 4. THE SUPPRESSION RULE FROM THE BRIEF. Structurally redundant while
  //    candidates ⊆ ladder — retained and logged (§4.5, "Note on step 4").
  const minBetano = Math.min(...ladder);
  if (side === 'OVER' && recommended < minBetano) {
    logger.error({ recommended, minBetano }, 'suppression step 4 fired — this should be impossible while candidates come from the ladder');
    return {
      ok: false,
      reason: 'BELOW_BETANO_MINIMUM',
      detail: `recommended ${recommended} below Betano minimum ${minBetano}`,
    };
  }

  // 5. Emit.
  return { ok: true, line: recommended, side };
}
