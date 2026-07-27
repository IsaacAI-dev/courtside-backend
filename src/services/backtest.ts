/**
 * Backtest metrics (spec §14): strike rate by tier, break-even vs offered odds,
 * Brier score and a 10-bucket calibration table. Profitability numbers are
 * hidden below n=50 — small-sample ROI is a lie with a percentage sign (§14.4).
 */
import { prisma } from '../db/client';

export interface TierStats {
  tier: string;
  n: number;
  wins: number;
  losses: number;
  pushes: number;
  voids: number;
  strikeRate: number | null; // wins / (wins+losses)
  avgOdds: number | null;
  breakEvenRate: number | null; // 1 / avgOdds
  roiVisible: boolean; // n >= 50
  roi: number | null; // flat-stake, pushes returned
}

export async function backtestByTier(leagueId?: string): Promise<TierStats[]> {
  const settled = await prisma.recommendation.findMany({
    where: { status: 'SETTLED', ...(leagueId ? { fixture: { leagueId } } : {}) },
    include: { result: true },
  });
  const tiers = ['A', 'B', 'C'];
  return tiers.map((tier) => {
    const rows = settled.filter((r) => r.tier === tier && r.result);
    const wins = rows.filter((r) => r.result!.outcome === 'WIN').length;
    const losses = rows.filter((r) => r.result!.outcome === 'LOSS').length;
    const pushes = rows.filter((r) => r.result!.outcome === 'PUSH').length;
    const voids = rows.filter((r) => r.result!.outcome === 'VOID').length;
    const decided = wins + losses;
    const withOdds = rows.filter((r) => r.offeredOdds != null && r.result!.outcome !== 'VOID');
    const avgOdds = withOdds.length
      ? withOdds.reduce((a, r) => a + (r.offeredOdds ?? 0), 0) / withOdds.length
      : null;
    const roiVisible = decided >= 50;
    let roi: number | null = null;
    if (roiVisible && withOdds.length) {
      const staked = withOdds.filter((r) => r.result!.outcome !== 'PUSH').length;
      const returned = withOdds.reduce((a, r) => {
        if (r.result!.outcome === 'WIN') return a + (r.offeredOdds ?? 0);
        if (r.result!.outcome === 'PUSH') return a; // stake excluded from `staked` too
        return a;
      }, 0);
      roi = staked ? (returned - staked) / staked : null;
    }
    return {
      tier,
      n: rows.length,
      wins,
      losses,
      pushes,
      voids,
      strikeRate: decided ? wins / decided : null,
      avgOdds,
      breakEvenRate: avgOdds ? 1 / avgOdds : null,
      roiVisible,
      roi,
    };
  });
}

export interface CalibrationBucket {
  bucket: string; // "55-60"
  n: number;
  impliedByConfidence: number; // bucket midpoint / 100
  actualStrikeRate: number | null;
  brierContribution: number | null;
}

export async function calibrationTable(leagueId?: string): Promise<{ buckets: CalibrationBucket[]; brier: number | null }> {
  const settled = await prisma.recommendation.findMany({
    where: { status: 'SETTLED', ...(leagueId ? { fixture: { leagueId } } : {}) },
    include: { result: true },
  });
  const decided = settled.filter((r) => r.result && (r.result.outcome === 'WIN' || r.result.outcome === 'LOSS'));
  const edges = [55, 60, 65, 70, 75, 80, 85, 90, 95, 100];
  let brierSum = 0;
  const buckets: CalibrationBucket[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const [lo, hi] = [edges[i], edges[i + 1]];
    const rows = decided.filter((r) => r.confidence >= lo && r.confidence < hi);
    const wins = rows.filter((r) => r.result!.outcome === 'WIN').length;
    const mid = (lo + hi) / 2 / 100;
    const actual = rows.length ? wins / rows.length : null;
    let brierContribution: number | null = null;
    if (rows.length) {
      brierContribution = rows.reduce((a, r) => {
        const p = r.confidence / 100;
        const y = r.result!.outcome === 'WIN' ? 1 : 0;
        return a + (p - y) ** 2;
      }, 0);
      brierSum += brierContribution;
    }
    buckets.push({ bucket: `${lo}-${hi}`, n: rows.length, impliedByConfidence: mid, actualStrikeRate: actual, brierContribution });
  }
  return { buckets, brier: decided.length ? brierSum / decided.length : null };
}
