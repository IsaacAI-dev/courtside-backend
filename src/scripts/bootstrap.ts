/**
 * Season bootstrap (spec §6.7): seed the player crosswalk from the league index,
 * then pull team pace/ratings. Run once per season and after transaction windows.
 *
 *   npm run bootstrap -- --league WNBA
 */
import { initDb, prisma } from '../db/client';
import { bootstrapPlayerIndex, refreshTeamRatings } from '../services/ingestion';
import { logger } from '../lib/logger';
import { assertSofaScoreConfigFresh } from '../env';
import type { LeagueId } from '../lib/types';

async function main(): Promise<void> {
  assertSofaScoreConfigFresh();
  const args = process.argv.slice(2);
  const league = ((args[args.indexOf('--league') + 1] ?? 'WNBA').toUpperCase()) as LeagueId;
  await initDb();

  console.log(`\nBootstrapping ${league}…`);
  const created = await bootstrapPlayerIndex(league);
  console.log(`  players created: ${created}`);
  const rated = await refreshTeamRatings(league);
  console.log(`  team ratings updated: ${rated}`);

  const counts = {
    players: await prisma.player.count({ where: { leagueId: league } }),
    teams: await prisma.team.count({ where: { leagueId: league } }),
    identities: await prisma.sourceIdentity.count({ where: { source: 'LEAGUE' } }),
  };
  console.log(`\ntotals → players ${counts.players} · teams ${counts.teams} · league identities ${counts.identities}\n`);
  await prisma.$disconnect();
}

main().catch((err) => {
  const msg = String(err);
  const isAggregate = err instanceof AggregateError;
  const isTimeout = /headers timeout/i.test(msg);

  if (isAggregate || isTimeout) {
    console.error(`
league stats request failed (${isAggregate ? 'connect failure on every address' : 'silent hang waiting for headers'}).

As of 22 Jul 2026 this adapter is DIRECT-ONLY and forces IPv4 (spec §5.4) —
no browser fallback. If you are still seeing this:

  ${isAggregate ? `AggregateError means every resolved address (IPv4 and IPv6) failed to
  connect. forceIPv4 should already rule out an IPv6 routing problem — if it
  still happens, the network path itself is down or blocking this host
  entirely. Try: curl -v https://stats.wnba.com/stats/playerindex?LeagueID=10&Season=2026
  from the same machine and see whether it connects at all.` : `A clean hang (TLS connects, then no response ever comes) with the full
  realistic header set now in use is stronger evidence of Akamai bot
  fingerprinting than before. The next step is the HAR-capture approach
  already proven for Betano: load stats.wnba.com/stats/players in your own
  browser, export a HAR, and we adapt from there.`}

Raw error: ${msg.slice(0, 300)}
`);
  } else {
    logger.error({ err: msg }, 'bootstrap failed');
  }
  process.exit(1);
});
