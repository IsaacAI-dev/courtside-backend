/**
 * One-off helper: look up the current SofaScore season ID for a league, for
 * pasting into .env when NBA_/WNBA_SOFASCORE_SEASON_EXPIRES has passed
 * (spec §5.3.4). Deliberately does NOT call assertSofaScoreConfigFresh — this
 * is the tool you run precisely when that check has failed, so it can't
 * refuse to run for the same reason it's needed. Also does not call
 * resolveTournamentIds — that endpoint was never confirmed working; the
 * tournament ID is already known (WNBA = 486, confirmed) and is read from
 * static config or passed explicitly, never looked up live.
 *
 *   npm run sofascore:resolve-season -- --league WNBA
 *   npm run sofascore:resolve-season -- --league NBA --tournament <id>
 */
import { env } from '../env';
import { resolveCurrentSeasonId } from '../adapters/sofascore';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const league = (args[args.indexOf('--league') + 1] || 'WNBA').toUpperCase() as 'NBA' | 'WNBA';
  const explicitTournament = args[args.indexOf('--tournament') + 1];

  const tournamentId = explicitTournament
    ? Number(explicitTournament)
    : league === 'WNBA'
      ? (env.WNBA_SOFASCORE_TOURNAMENT_ID ?? 486) // confirmed 22 Jul 2026
      : env.NBA_SOFASCORE_TOURNAMENT_ID;

  if (!tournamentId) {
    console.error(
      `\nNo tournament ID known for ${league}. Pass one explicitly:\n\n` +
        `  npm run sofascore:resolve-season -- --league ${league} --tournament <id>\n`,
    );
    process.exit(1);
  }
  console.log(`\nusing tournament ID ${tournamentId} for ${league}...`);

  const seasonId = await resolveCurrentSeasonId(tournamentId);

  // A season doesn't have a published end date via this API — pick a date
  // safely past when this league's season realistically ends, so the check
  // fires with room to notice rather than exactly on the last possible day.
  const suggestedExpiry = new Date();
  suggestedExpiry.setMonth(suggestedExpiry.getMonth() + 10);

  console.log(`\n${league} current season ID: ${seasonId}`);
  console.log(`\nPaste into .env:\n`);
  console.log(`  ${league}_SOFASCORE_TOURNAMENT_ID=${tournamentId}`);
  console.log(`  ${league}_SOFASCORE_SEASON_ID=${seasonId}`);
  console.log(`  ${league}_SOFASCORE_SEASON_EXPIRES=${suggestedExpiry.toISOString().slice(0, 10)}`);
  console.log(`\n(adjust the expiry date to whenever you're confident the ${league} season will have rolled over)\n`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
