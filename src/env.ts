import 'dotenv/config';
import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

// z.coerce.number() on an empty string produces 0, not undefined — Number('')
// is 0 in JS. That's exactly wrong for an "optional ID" field: an unset env
// var (WNBA_SOFASCORE_SEASON_ID= with nothing after the =) would silently
// become a "valid" ID of 0 rather than being treated as missing. Confirmed
// 22 Jul 2026: this let an empty season ID produce a real request to
// `season/0/...`, which 404s, while every validation check believed the
// value was present. Strip empty strings to undefined BEFORE coercion.
const optionalId = z.preprocess((v) => (v === '' || v === undefined ? undefined : v), z.coerce.number().optional());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  // Optional at parse time on purpose: this key guards the HTTP API, and the CLI
  // scripts (discover:betano, analyse, settle, bootstrap, demo) never serve HTTP.
  // The server asserts it at boot instead — see assertServerEnv() below.
  API_KEY: z.string().optional(),
  LOG_LEVEL: z.string().default('info'),

  DATABASE_URL: z.string().default('file:./courtside.db'),

  ANALYSIS_WINDOW_HOURS: z.coerce.number().default(24),
  LEAGUES_ENABLED: z
    .string()
    .default('WNBA,NBA')
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)),

  MIN_MINUTES_THRESHOLD: z.coerce.number().default(8),
  LAYOFF_DAYS: z.coerce.number().default(14),
  MAX_GAMES_MISSED_L15: z.coerce.number().default(4),
  EXCLUDE_PROBABLE: bool,

  // ── Static SofaScore tournament + season IDs (per user decision, 22 Jul 2026) ──
  // /config/unique-tournaments/en/basketball was never one of the confirmed-
  // working endpoints — it's scaffolding from before the working flow (via
  // unique-tournament/{t}/season/{s}/...) was found, and it 403s under the
  // same session that succeeds on every confirmed endpoint. Tournament ID is
  // static now too, for the same reason season ID is: one less live call to
  // an endpoint that was never actually tested and confirmed working.
  NBA_SOFASCORE_TOURNAMENT_ID: optionalId,
  WNBA_SOFASCORE_TOURNAMENT_ID: optionalId,
  NBA_SOFASCORE_SEASON_ID: optionalId,
  NBA_SOFASCORE_SEASON_EXPIRES: z.string().optional(), // ISO date, e.g. "2027-02-01"
  WNBA_SOFASCORE_SEASON_ID: optionalId,
  WNBA_SOFASCORE_SEASON_EXPIRES: z.string().optional(),
  EXCLUDE_QUESTIONABLE: bool.default('true'),

  PRIMARY_WINDOW: z.coerce.number().default(5),
  HIT_RATE_THRESHOLD: z.coerce.number().min(1).max(5).default(4),
  RECENCY_LAMBDA: z.coerce.number().min(0.5).max(1).default(0.85),
  SELECTION_MODE: z.enum(['AGGRESSIVE', 'BALANCED', 'CONSERVATIVE']).default('BALANCED'),
  MIN_GAMES_REQUIRED: z.coerce.number().default(5),
  COMPUTE_UNDER_SIDE: bool.default('true'),
  DISPLAY_SIDE_DEFAULT: z.enum(['OVER', 'UNDER']).default('OVER'),

  CONFIDENCE_FLOOR: z.coerce.number().default(55),
  SCORING_CONFIG_PATH: z.string().default('./src/config/scoring.json'),

  BETANO_BASE_URL: z.string().default('https://www.betano.ng'),
  BETANO_CONFIG_PATH: z.string().default('./src/config/betano.json'),
  BETANO_MIN_DELAY_MS: z.coerce.number().default(2000),
  BETANO_MAX_DELAY_MS: z.coerce.number().default(5000),
  BETANO_USE_BROWSER: bool.default('true'),
  PLAYWRIGHT_USER_DATA_DIR: z.string().default('./.pw-profile'),
  PLAYWRIGHT_HEADLESS: bool.default('true'),

  // ── Semi-manual Cloudflare session replay (spec §5.2.6, added 22 Jul 2026) ──
  // Confirmed: Cloudflare fingerprints Playwright/CDP automation itself, not
  // just "is this a browser". A human-driven session clears the challenge;
  // an automated one gets 403'd even through a real Chromium. The practical
  // fix: copy the Cookie header and User-Agent from one manually-loaded
  // request in your own browser, paste them here, and the DIRECT tier
  // replays them as plain HTTP — no automation involved. Refresh when the
  // direct tier starts failing again (cf_clearance/​__cf_bm are time-limited;
  // exact lifetime varies, expect anywhere from ~30 minutes to several hours).
  BETANO_SESSION_COOKIE: z.string().optional(),
  BETANO_SESSION_USER_AGENT: z.string().optional(),
  SOFASCORE_SESSION_COOKIE: z.string().optional(),
  SOFASCORE_SESSION_USER_AGENT: z.string().optional(),

  // www.sofascore.com serves the same API and is confirmed reachable with a
  // captured session (22 Jul 2026); api.sofascore.com returned 403 even with
  // a valid, fresh cookie. Same-origin as the site the cookie was captured
  // from is very likely why — worth using regardless of the exact mechanism.
  SOFASCORE_BASE_URL: z.string().default('https://www.sofascore.com/api/v1'),
  ESPN_BASE_URL: z.string().default('https://site.api.espn.com/apis/site/v2/sports/basketball'),
  ESPN_SUMMARY_BASE_URL: z
    .string()
    .default('https://site.web.api.espn.com/apis/site/v2/sports/basketball'),

  ALERT_WEBHOOK_URL: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const fields = parsed.error.flatten().fieldErrors;
  // eslint-disable-next-line no-console
  console.error('\nInvalid environment:\n');
  for (const [key, errors] of Object.entries(fields)) {
    // eslint-disable-next-line no-console
    console.error(`  ${key}: ${(errors ?? []).join(', ')}`);
  }
  // eslint-disable-next-line no-console
  console.error('\nIf you have not created a .env yet:\n\n  cp .env.example .env\n');
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;

/**
 * Server-only requirements. Called from src/index.ts before the listener binds,
 * so an unprotected API can never come up — while CLI scripts that touch no
 * network surface run without needing a key at all.
 */
export function assertServerEnv(): void {
  if (!env.API_KEY || env.API_KEY.length < 8) {
    // eslint-disable-next-line no-console
    console.error(
      '\nAPI_KEY is required to start the server and must be at least 8 characters.\n\n' +
        '  cp .env.example .env      # then set API_KEY to a long random string\n\n' +
        'Generate one with:\n\n  node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'hex\'))"\n',
    );
    process.exit(1);
  }
  if (env.NODE_ENV === 'production' && env.API_KEY === 'change-me-to-a-long-random-string') {
    // eslint-disable-next-line no-console
    console.error('\nRefusing to start in production with the placeholder API_KEY from .env.example.\n');
    process.exit(1);
  }
}

/**
 * Hard failure on missing or stale SofaScore config — both tournament ID and
 * season ID (spec §5.3.4, added 22 Jul 2026 per explicit user decision to
 * prefer a loud crash over any live resolution call, since the resolution
 * endpoint itself was never confirmed working — it 403s under the same
 * session that succeeds on every endpoint the user actually tested).
 * Deliberately NOT run automatically on import — unlike assertServerEnv, this
 * must be callable from diagnostic tools (test:session, sofascore:resolve-season)
 * precisely when config IS stale/missing, without those tools refusing to run
 * and blocking the fix. Call explicitly from real pipeline entry points: the
 * server, bootstrap, and analyse.
 */
export function assertSofaScoreConfigFresh(): void {
  const checks: Array<{ league: string; tournamentId?: number; seasonId?: number; expires?: string }> = [];
  if (env.LEAGUES_ENABLED.includes('NBA')) {
    checks.push({
      league: 'NBA',
      tournamentId: env.NBA_SOFASCORE_TOURNAMENT_ID,
      seasonId: env.NBA_SOFASCORE_SEASON_ID,
      expires: env.NBA_SOFASCORE_SEASON_EXPIRES,
    });
  }
  if (env.LEAGUES_ENABLED.includes('WNBA')) {
    checks.push({
      league: 'WNBA',
      tournamentId: env.WNBA_SOFASCORE_TOURNAMENT_ID,
      seasonId: env.WNBA_SOFASCORE_SEASON_ID,
      expires: env.WNBA_SOFASCORE_SEASON_EXPIRES,
    });
  }

  const problems: string[] = [];
  for (const { league, tournamentId, seasonId, expires } of checks) {
    if (tournamentId == null || tournamentId === 0) {
      problems.push(`${league}_SOFASCORE_TOURNAMENT_ID is not set`);
    }
    if (seasonId == null || seasonId === 0) {
      problems.push(`${league}_SOFASCORE_SEASON_ID is not set`);
      continue; // nothing to check an expiry against without a season id
    }
    if (!expires) {
      problems.push(`${league}_SOFASCORE_SEASON_EXPIRES is not set`);
      continue;
    }
    const expiresAt = new Date(expires);
    if (Number.isNaN(expiresAt.getTime())) {
      problems.push(`${league}_SOFASCORE_SEASON_EXPIRES ("${expires}") is not a valid date`);
      continue;
    }
    if (expiresAt.getTime() <= Date.now()) {
      problems.push(
        `${league}_SOFASCORE_SEASON_EXPIRES (${expires}) has passed — the ${league} season has likely rolled over. ` +
          `Run \`npm run sofascore:resolve-season -- --league ${league}\` to get the new season ID.`,
      );
    }
  }

  if (problems.length) {
    // eslint-disable-next-line no-console
    console.error('\n✖ SofaScore configuration is missing or stale:\n');
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
      '\nRefusing to start with stale/missing config. Update .env, then restart:\n\n' +
        '  npm run sofascore:resolve-season -- --league WNBA\n',
    );
    process.exit(1);
  }
}
