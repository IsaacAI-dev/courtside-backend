// Shared vocabulary — the string unions that stand in for enums on SQLite (spec §8.7).

export const MARKETS = ['POINTS', 'ASSISTS', 'REBOUNDS', 'THREES'] as const;
export type Market = (typeof MARKETS)[number];

export const MARKET_TO_LOG_FIELD: Record<Market, 'points' | 'assists' | 'rebounds' | 'threesMade'> = {
  POINTS: 'points',
  ASSISTS: 'assists',
  REBOUNDS: 'rebounds',
  THREES: 'threesMade',
};

export const SIDES = ['OVER', 'UNDER'] as const;
export type Side = (typeof SIDES)[number];

export const SOURCES = ['BETANO', 'SOFASCORE', 'LEAGUE', 'ESPN', 'MANUAL', 'NBA_OFFICIAL'] as const;
export type Source = (typeof SOURCES)[number];

export const INJURY_STATUSES = [
  'ACTIVE',
  'PROBABLE',
  'QUESTIONABLE',
  'DOUBTFUL',
  'OUT',
  'INACTIVE',
  'SUSPENDED',
  'NOT_WITH_TEAM',
] as const;
export type InjuryStatusCode = (typeof INJURY_STATUSES)[number];

/** Higher = worse. Cross-source resolution takes the maximum (most pessimistic, §4.3). */
export const INJURY_SEVERITY: Record<InjuryStatusCode, number> = {
  ACTIVE: 0,
  PROBABLE: 1,
  QUESTIONABLE: 2,
  DOUBTFUL: 3,
  OUT: 4,
  INACTIVE: 4,
  SUSPENDED: 4,
  NOT_WITH_TEAM: 4,
};

export const EXCLUSION_REASONS = [
  'EXCLUDED_OUT',
  'EXCLUDED_DOUBTFUL',
  'EXCLUDED_DNP_PREVIOUS',
  'EXCLUDED_RETURNING',
  'UNRESOLVED_ENTITY',
  'INSUFFICIENT_DATA',
  'NO_LINE_MEETS_RULE',
  'BELOW_BETANO_MINIMUM',
  'BELOW_CONFIDENCE_FLOOR',
] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

export const RUN_STATUSES = ['RUNNING', 'COMPLETED', 'DEGRADED', 'FAILED'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const REC_STATUSES = ['ACTIVE', 'VOIDED_LATE_SCRATCH', 'VOIDED_LINE_MOVED', 'SETTLED'] as const;
export type RecStatus = (typeof REC_STATUSES)[number];

export const MATCH_METHODS = ['IDENTITY', 'ALIAS', 'EXACT', 'STRUCTURAL', 'FUZZY', 'MANUAL'] as const;
export type MatchMethod = (typeof MATCH_METHODS)[number];

export type LeagueId = 'NBA' | 'WNBA';
