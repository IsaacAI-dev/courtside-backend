/** Manual analysis run: `npm run analyse -- --league WNBA [--skip-scrape] [--window 48h]` */
import { executeAnalysisRun } from '../services/pipeline';
import { prisma, initDb } from '../db/client';
import { logger } from '../lib/logger';
import { assertSofaScoreConfigFresh } from '../env';
import type { LeagueId } from '../lib/types';

async function main(): Promise<void> {
  assertSofaScoreConfigFresh();
  const args = process.argv.slice(2);
  const leagueArg = (args[args.indexOf('--league') + 1] ?? 'WNBA').toUpperCase() as LeagueId;
  const skipScrape = args.includes('--skip-scrape');
  const windowArg = args[args.indexOf('--window') + 1]; // e.g. "48h"
  const windowHours = windowArg ? parseInt(windowArg.replace(/[^\d]/g, ''), 10) : undefined;

  await initDb();
  logger.info({ league: leagueArg, skipScrape, windowHours: windowHours ?? '(default)' }, 'starting manual analysis run');
  const runId = await executeAnalysisRun({ leagueId: leagueArg, trigger: 'MANUAL', skipScrape, windowHours });

  const run = await prisma.analysisRun.findUnique({ where: { id: runId } });
  const byReason = await prisma.playerExclusion.groupBy({
    by: ['reason'],
    where: { runId },
    _count: { reason: true },
  });

  console.log('\n─── run summary ───');
  console.log(`id:              ${runId}`);
  console.log(`status:          ${run?.status}`);
  console.log(`fixtures:        ${run?.fixturesConsidered}`);
  console.log(`players:         ${run?.playersConsidered}`);
  console.log(`excluded:        ${run?.playersExcluded}`);
  console.log(`recommendations: ${run?.recommendationsEmitted}`);
  console.log(`duration:        ${run?.durationMs}ms`);
  if (byReason.length) {
    console.log('\nexclusions by reason:');
    for (const r of byReason) console.log(`  ${r.reason.padEnd(26)} ${r._count.reason}`);
  }
  await prisma.$disconnect();
}

main().catch((err) => {
  logger.error({ err: String(err) }, 'analyse script failed');
  process.exit(1);
});
