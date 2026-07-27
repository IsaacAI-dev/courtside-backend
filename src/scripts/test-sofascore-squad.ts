/**
 * Test the top-players squad union against a real team (spec §6.7).
 *
 *   npm run test:squad -- --team 1041936              (Golden State Valkyries)
 *   npm run test:squad -- --team 3440 --tournament 486  (explicit WNBA tournament)
 *
 * Resolves the current season live rather than hardcoding it, exercising the
 * same path production code uses.
 */
import { resolveCurrentSeasonId, fetchSofaTopPlayersSquad } from '../adapters/sofascore';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const teamId = args[args.indexOf('--team') + 1];
  const tournamentId = Number(args[args.indexOf('--tournament') + 1] || 486); // 486 = WNBA

  if (!teamId) {
    console.error('\nusage: npm run test:squad -- --team <sofascoreTeamId> [--tournament <id>]\n');
    process.exit(1);
  }

  console.log(`\nresolving current season for tournament ${tournamentId}...`);
  const seasonId = await resolveCurrentSeasonId(tournamentId);
  console.log(`  season: ${seasonId}`);

  console.log(`\nfetching squad for team ${teamId}...`);
  const squad = await fetchSofaTopPlayersSquad(teamId, tournamentId, seasonId);

  console.log(`\n${squad.length} player(s) found:\n`);
  for (const p of squad) {
    console.log(`  ${p.externalId.padStart(9)}  ${(p.position ?? '?').padEnd(3)}  ${p.name}`);
  }
  console.log();
}

main().catch((err) => {
  console.error('\nFAILED:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
