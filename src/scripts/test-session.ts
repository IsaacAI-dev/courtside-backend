/**
 * Fast check of the manually-captured session cookies (spec §5.2.6).
 * Hits one real endpoint per source and reports pass/fail in a few seconds —
 * no need to run the full pipeline just to find out a copied cookie is stale.
 *
 *   npm run test:session
 */
import { env } from '../env';
import { fetchBetanoFixtures } from '../adapters/betano/adapter';
import { fetchSofaUpcomingEvents, getStaticSofaTournamentId, getStaticSofaSeasonId } from '../adapters/sofascore';

async function main(): Promise<void> {
  console.log('\n─── session check ───\n');

  // Betano
  if (!env.BETANO_SESSION_COOKIE) {
    console.log('BETANO   [skip]  BETANO_SESSION_COOKIE not set in .env');
  } else {
    try {
      const fixtures = await fetchBetanoFixtures();
      console.log(`BETANO   [ OK ]  ${fixtures.length} fixture(s) returned`);
    } catch (err) {
      console.log('BETANO   [FAIL]');
      console.log(err instanceof Error ? err.message : String(err));
    }
  }

  // SofaScore
  if (!env.SOFASCORE_SESSION_COOKIE) {
    console.log('SOFASCORE[skip]  SOFASCORE_SESSION_COOKIE not set in .env');
  } else {
    try {
      const wnbaId = getStaticSofaTournamentId('WNBA');
      const seasonId = getStaticSofaSeasonId('WNBA');
      const events = await fetchSofaUpcomingEvents(wnbaId, seasonId);
      console.log(`SOFASCORE[ OK ]  ${events.length} upcoming event(s) (tournament ${wnbaId}, season ${seasonId})`);
    } catch (err) {
      console.log('SOFASCORE[FAIL]');
      console.log(err instanceof Error ? err.message : String(err));
      if (!env.WNBA_SOFASCORE_TOURNAMENT_ID || !env.WNBA_SOFASCORE_SEASON_ID || !env.WNBA_SOFASCORE_SEASON_EXPIRES) {
        console.log(
          '\n(WNBA_SOFASCORE_TOURNAMENT_ID / SEASON_ID / _EXPIRES not fully set — run: ' +
            'npm run sofascore:resolve-season -- --league WNBA)',
        );
      }
    }
  }

  console.log();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
