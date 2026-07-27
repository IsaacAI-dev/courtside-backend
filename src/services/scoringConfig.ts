import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { env } from '../env';
import { prisma } from '../db/client';

const scoringSchema = z.object({
  version: z.string(),
  weights: z.object({
    hitrate: z.number(),
    cushion: z.number(),
    consistency: z.number(),
    minutes: z.number(),
    matchup: z.number(),
  }),
  cushion: z.object({ scale: z.number(), sigmaFloor: z.number() }),
  consistency: z.object({ cvRef: z.record(z.number()) }),
  minutes: z.object({
    volatilityPenalty: z.number(),
    trendBonus: z.number(),
    hardFloorMinutes: z.number(),
    targetMinutes: z.number(),
  }),
  matchup: z.object({ paceWeight: z.number(), defWeight: z.number(), positionalWeight: z.number() }),
  wilson: z.object({
    z: z.number(),
    windowBlend: z.object({ l5: z.number(), l10: z.number(), season: z.number() }),
  }),
  multipliers: z.object({
    backToBack: z.number(),
    thirdInFour: z.number(),
    firstGameBack: z.number(),
    blowoutRisk: z.number(),
    blowoutSpreadThreshold: z.number(),
    teammateReturning: z.number(),
    teammateOut: z.number(),
    roadNegativeSplit: z.number(),
    fuzzyEntityMatch: z.number(),
    staleLines: z.number(),
    staleLineMinutes: z.number(),
  }),
  dataSufficiencyCaps: z.array(z.object({ minGames: z.number(), cap: z.number() })),
  tiers: z.object({ A: z.number(), B: z.number(), C: z.number() }),
});

export type ScoringConfig = z.infer<typeof scoringSchema>;

let cached: ScoringConfig | null = null;

export function getScoringConfig(): ScoringConfig {
  if (!cached) {
    cached = scoringSchema.parse(JSON.parse(readFileSync(env.SCORING_CONFIG_PATH, 'utf-8')));
  }
  return cached;
}

/** Persist the active config as a version snapshot so backtests can reconstruct scores (§12.2). */
export async function snapshotScoringVersion(): Promise<void> {
  const cfg = getScoringConfig();
  await prisma.scoringConfigVersion.upsert({
    where: { version: cfg.version },
    create: { version: cfg.version, config: JSON.stringify(cfg) },
    update: {},
  });
}

/** Apply a PATCH (weights/tiers/…), bump the version, snapshot. */
export function updateScoringConfig(patch: Partial<ScoringConfig>): ScoringConfig {
  const current = getScoringConfig();
  const [maj, min, pat] = current.version.split('.').map(Number);
  const next: ScoringConfig = scoringSchema.parse({
    ...current,
    ...patch,
    weights: { ...current.weights, ...(patch.weights ?? {}) },
    tiers: { ...current.tiers, ...(patch.tiers ?? {}) },
    multipliers: { ...current.multipliers, ...(patch.multipliers ?? {}) },
    version: `${maj}.${min}.${(pat ?? 0) + 1}`,
  });
  cached = next;
  return next;
}
