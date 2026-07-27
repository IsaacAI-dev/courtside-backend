/** Settlement pass: `npm run settle -- --date 2026-07-18 [--league WNBA]` */
import { prisma, initDb } from '../db/client';
import { settleFixture } from '../services/settlement';
import { backtestByTier } from '../services/backtest';
import { HOUR_MS } from '../lib/dates';
import { logger } from '../lib/logger';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dateArg = args[args.indexOf('--date') + 1];
  const leagueArg = args.includes('--league') ? args[args.indexOf('--league') + 1] : undefined;

  await initDb();
  const start = dateArg ? new Date(`${dateArg}T00:00:00.000Z`) : new Date(Date.now() - 24 * HOUR_MS);
  const end = new Date(start.getTime() + 24 * HOUR_MS);

  const fixtures = await prisma.fixture.findMany({
    where: { ...(leagueArg ? { leagueId: leagueArg } : {}), startsAt: { gte: start, lte: end } },
  });
  let settled = 0;
  for (const fixture of fixtures) {
    try {
      const r = await settleFixture(fixture.id);
      settled += r.settled;
    } catch (err) {
      logger.warn({ fixtureId: fixture.id, err: String(err) }, 'settlement failed');
    }
  }
  console.log(`\nsettled ${settled} recommendations across ${fixtures.length} fixtures\n`);

  const tiers = await backtestByTier(leagueArg);
  console.log('tier   n    W-L-P      strike    breakeven   roi');
  for (const t of tiers) {
    const strike = t.strikeRate != null ? `${(t.strikeRate * 100).toFixed(1)}%` : '—';
    const be = t.breakEvenRate != null ? `${(t.breakEvenRate * 100).toFixed(1)}%` : '—';
    const roi = t.roiVisible && t.roi != null ? `${(t.roi * 100).toFixed(1)}%` : `n<50`;
    console.log(`  ${t.tier}  ${String(t.n).padStart(4)}  ${t.wins}-${t.losses}-${t.pushes}`.padEnd(24) + `${strike.padEnd(10)}${be.padEnd(12)}${roi}`);
  }
  await prisma.$disconnect();
}

main().catch((err) => {
  logger.error({ err: String(err) }, 'settle script failed');
  process.exit(1);
});
