import { describe, it, expect, beforeAll } from 'vitest';
import type { env as EnvType, assertSofaScoreConfigFresh as AssertFn } from '../env';
import type { getStaticSofaSeasonId as GetSeasonFn } from '../adapters/sofascore';

/**
 * Regression test for a real bug (22 Jul 2026): `WNBA_SOFASCORE_SEASON_ID=`
 * (present in .env but with nothing after the =) is `""` in process.env, and
 * `z.coerce.number()` turns `Number('')` into `0` — NOT undefined. That 0
 * then passed every "is this set?" check that used `== null`, producing a
 * real request to `.../season/0/events/next/0`, which 404s, while every
 * validation layer believed the config was present. Both the coercion itself
 * and the downstream checks needed fixing; this test guards both.
 */
describe('empty-string env vars for numeric IDs are treated as unset, not 0', () => {
  let env: typeof EnvType;
  let assertSofaScoreConfigFresh: typeof AssertFn;
  let getStaticSofaSeasonId: typeof GetSeasonFn;

  beforeAll(async () => {
    process.env.LEAGUES_ENABLED = 'WNBA';
    process.env.WNBA_SOFASCORE_TOURNAMENT_ID = '486';
    process.env.WNBA_SOFASCORE_SEASON_ID = ''; // exactly what an empty .env line produces
    process.env.WNBA_SOFASCORE_SEASON_EXPIRES = '2027-06-01';

    const envMod = await import('../env');
    const sofaMod = await import('../adapters/sofascore');
    env = envMod.env;
    assertSofaScoreConfigFresh = envMod.assertSofaScoreConfigFresh;
    getStaticSofaSeasonId = sofaMod.getStaticSofaSeasonId;
  });

  it('parses an empty string to undefined, not 0', () => {
    expect(env.WNBA_SOFASCORE_SEASON_ID).toBeUndefined();
  });

  it('getStaticSofaSeasonId throws rather than returning 0', () => {
    expect(() => getStaticSofaSeasonId('WNBA')).toThrow(/WNBA_SOFASCORE_SEASON_ID is not set/);
  });

  it('assertSofaScoreConfigFresh exits rather than treating 0 as valid config', () => {
    const originalExit = process.exit;
    const exitCalls: number[] = [];
    // @ts-ignore — stubbing process.exit for the test
    process.exit = (code?: number) => {
      exitCalls.push(code ?? 0);
      throw new Error('process.exit called'); // stop execution like a real exit would
    };
    try {
      expect(() => assertSofaScoreConfigFresh()).toThrow();
      expect(exitCalls).toEqual([1]);
    } finally {
      process.exit = originalExit;
    }
  });
});
