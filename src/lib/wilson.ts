/**
 * Wilson score lower bound for a binomial proportion (spec §4.6.1).
 * At n=5 this is deliberately pessimistic: 4/5 raw = 0.80, wilson ≈ 0.52 at z=1.2816.
 * It converges toward the raw rate as n grows — which is exactly the honesty we want
 * about five-game samples.
 */
export function wilsonLower(hits: number, n: number, z = 1.2816): number {
  if (n <= 0) return 0;
  const p = hits / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return Math.max(0, (centre - margin) / denom);
}
