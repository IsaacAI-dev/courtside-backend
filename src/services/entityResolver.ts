/**
 * Entity resolution — the crosswalk (spec §6). Matching runs down tiers,
 * stopping at the first success; nothing below EXACT auto-verifies:
 *
 *   1 IDENTITY    known SourceIdentity            conf 1.00
 *   2 ALIAS       curated alias table             conf 0.98
 *   3 EXACT       normalised full-name equality   conf 0.95
 *   4 STRUCTURAL  last name + first initial,      conf 0.85   (roster-constrained)
 *   5 FUZZY       dice ≥ 0.85 within roster       conf = sim  (score multiplier ×0.85)
 *   → review queue; the player is EXCLUDED (UNRESOLVED_ENTITY), never guessed.
 *
 * Suffix discipline (§6.4): base-name collisions with differing suffixes go
 * straight to review — Tim Hardaway Jr must never match Tim Hardaway.
 */
import { prisma } from '../db/client';
import { normaliseName, splitSuffix, lastNameOf, firstInitialOf, diceSimilarity } from '../lib/normalise';
import type { MatchMethod } from '../lib/types';

export interface ResolveResult {
  playerId: string | null;
  method: MatchMethod | null;
  confidence: number;
  reviewItemId?: string;
}

export async function resolvePlayer(
  source: string,
  rawName: string,
  opts: { externalId?: string; leagueId: string; teamId?: string | null; fixtureId?: string | null },
): Promise<ResolveResult> {
  const normalised = normaliseName(rawName);
  const { base, suffix } = splitSuffix(normalised);

  // Tier 1 — IDENTITY
  if (opts.externalId) {
    const identity = await prisma.sourceIdentity.findUnique({
      where: { source_externalId_entityType: { source, externalId: opts.externalId, entityType: 'PLAYER' } },
    });
    if (identity?.playerId) {
      return { playerId: identity.playerId, method: 'IDENTITY', confidence: identity.matchConfidence };
    }
  }

  // Tier 2 — ALIAS (source-scoped first, then universal)
  const alias = await prisma.playerAlias.findFirst({
    where: { normalised, OR: [{ source }, { source: null }] },
    orderBy: { source: 'desc' }, // source-specific rows first
  });
  if (alias) {
    await persistIdentity(source, opts.externalId, rawName, alias.playerId, 'ALIAS', 0.98);
    return { playerId: alias.playerId, method: 'ALIAS', confidence: 0.98 };
  }

  // Tier 3 — EXACT normalised full name (suffix-aware)
  const exact = await prisma.player.findMany({
    where: { leagueId: opts.leagueId, normalised },
  });
  if (exact.length === 1) {
    await persistIdentity(source, opts.externalId, rawName, exact[0].id, 'EXACT', 0.95);
    return { playerId: exact[0].id, method: 'EXACT', confidence: 0.95 };
  }
  if (exact.length > 1) return queueReview(source, rawName, opts, exact.map((p) => p.id), 'ambiguous exact match');

  // Suffix collision check: same base name, different/absent suffix → review, never match.
  const baseCollisions = await prisma.player.findMany({
    where: { leagueId: opts.leagueId, normalised: { startsWith: base } },
  });
  const differingSuffix = baseCollisions.filter((p) => {
    const ps = splitSuffix(p.normalised);
    return ps.base === base && ps.suffix !== suffix;
  });
  if (differingSuffix.length) {
    return queueReview(source, rawName, opts, differingSuffix.map((p) => p.id), 'generational suffix mismatch (§6.4)');
  }

  // Tiers 4–5 need a candidate pool: the roster if known, else the league.
  const pool = await prisma.player.findMany({
    where: { leagueId: opts.leagueId, ...(opts.teamId ? { teamId: opts.teamId } : {}), isActive: true },
  });

  // Tier 4 — STRUCTURAL: unique last name + first initial within the pool
  const last = lastNameOf(normalised);
  const initial = firstInitialOf(normalised);
  const structural = pool.filter(
    (p) => lastNameOf(p.normalised) === last && firstInitialOf(p.normalised) === initial,
  );
  if (structural.length === 1 && opts.teamId) {
    await persistIdentity(source, opts.externalId, rawName, structural[0].id, 'STRUCTURAL', 0.85);
    return { playerId: structural[0].id, method: 'STRUCTURAL', confidence: 0.85 };
  }

  // Tier 5 — FUZZY: dice over the pool, best ≥ 0.85 with a clear gap to second place
  const scored = pool
    .map((p) => ({ p, sim: diceSimilarity(normalised, p.normalised) }))
    .sort((a, b) => b.sim - a.sim);
  const bestMatch = scored[0];
  const second = scored[1];
  if (bestMatch && bestMatch.sim >= 0.85 && (!second || bestMatch.sim - second.sim >= 0.08)) {
    await persistIdentity(source, opts.externalId, rawName, bestMatch.p.id, 'FUZZY', bestMatch.sim);
    return { playerId: bestMatch.p.id, method: 'FUZZY', confidence: bestMatch.sim };
  }

  // Fell through — review queue, exclude for now.
  return queueReview(
    source,
    rawName,
    opts,
    scored.slice(0, 5).filter((s) => s.sim > 0.5).map((s) => s.p.id),
    'no tier matched',
  );
}

async function persistIdentity(
  source: string,
  externalId: string | undefined,
  rawName: string,
  playerId: string,
  method: MatchMethod,
  confidence: number,
): Promise<void> {
  if (!externalId) return; // nothing durable to key on
  await prisma.sourceIdentity.upsert({
    where: { source_externalId_entityType: { source, externalId, entityType: 'PLAYER' } },
    create: { entityType: 'PLAYER', source, externalId, rawName, playerId, matchMethod: method, matchConfidence: confidence },
    update: { rawName, playerId, matchMethod: method, matchConfidence: confidence },
  });
}

async function queueReview(
  source: string,
  rawName: string,
  opts: { teamId?: string | null; fixtureId?: string | null },
  candidateIds: string[],
  note: string,
): Promise<ResolveResult> {
  const existing = await prisma.entityReviewItem.findFirst({
    where: { source, rawName, status: 'PENDING' },
  });
  const item =
    existing ??
    (await prisma.entityReviewItem.create({
      data: {
        source,
        rawName,
        fixtureId: opts.fixtureId ?? null,
        candidates: JSON.stringify({ candidateIds, note }),
      },
    }));
  return { playerId: null, method: null, confidence: 0, reviewItemId: item.id };
}

/** Resolve a team name to a Team row via alias table → exact → contains. */
export async function resolveTeam(leagueId: string, rawName: string): Promise<string | null> {
  const normalised = normaliseName(rawName);
  const alias = await prisma.teamAlias.findFirst({ where: { normalised } });
  if (alias) return alias.teamId;
  const teams = await prisma.team.findMany({ where: { leagueId } });
  const exact = teams.find((t) => normaliseName(t.name) === normalised || normaliseName(t.shortName) === normalised || t.abbreviation.toLowerCase() === normalised);
  if (exact) return exact.id;
  const contains = teams.filter(
    (t) => normalised.includes(normaliseName(t.shortName)) || normaliseName(t.name).includes(normalised),
  );
  return contains.length === 1 ? contains[0].id : null;
}
