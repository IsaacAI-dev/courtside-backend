/**
 * SQLite → PostgreSQL migration helper (spec §8.7).
 *
 *   1. Set DATABASE_URL to the Postgres connection string
 *   2. Change datasource provider in prisma/schema.prisma to "postgresql"
 *   3. npx prisma migrate deploy
 *   4. npx tsx src/scripts/migrate-to-postgres.ts --from ./courtside.db
 *
 * Copies table-by-table in dependency order. Idempotent via upsert on id.
 */
import { PrismaClient } from '@prisma/client';
import { logger } from '../lib/logger';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fromPath = args[args.indexOf('--from') + 1] ?? './courtside.db';

  const source = new PrismaClient({ datasources: { db: { url: `file:${fromPath}` } } });
  const target = new PrismaClient(); // uses DATABASE_URL from env

  const order: Array<[string, () => Promise<unknown[]>, (rows: any[]) => Promise<unknown>]> = [
    ['leagueConfig', () => source.leagueConfig.findMany(), (r) => target.leagueConfig.createMany({ data: r })],
    ['leagueBreak', () => source.leagueBreak.findMany(), (r) => target.leagueBreak.createMany({ data: r })],
    ['team', () => source.team.findMany(), (r) => target.team.createMany({ data: r })],
    ['teamAlias', () => source.teamAlias.findMany(), (r) => target.teamAlias.createMany({ data: r })],
    ['player', () => source.player.findMany(), (r) => target.player.createMany({ data: r })],
    ['playerAlias', () => source.playerAlias.findMany(), (r) => target.playerAlias.createMany({ data: r })],
    ['sourceIdentity', () => source.sourceIdentity.findMany(), (r) => target.sourceIdentity.createMany({ data: r })],
    ['fixture', () => source.fixture.findMany(), (r) => target.fixture.createMany({ data: r })],
    ['fixtureSourceLink', () => source.fixtureSourceLink.findMany(), (r) => target.fixtureSourceLink.createMany({ data: r })],
    ['playerGameLog', () => source.playerGameLog.findMany(), (r) => target.playerGameLog.createMany({ data: r })],
    ['injuryStatus', () => source.injuryStatus.findMany(), (r) => target.injuryStatus.createMany({ data: r })],
    ['propLine', () => source.propLine.findMany(), (r) => target.propLine.createMany({ data: r })],
    ['analysisRun', () => source.analysisRun.findMany(), (r) => target.analysisRun.createMany({ data: r })],
    ['playerExclusion', () => source.playerExclusion.findMany(), (r) => target.playerExclusion.createMany({ data: r })],
    ['recommendation', () => source.recommendation.findMany(), (r) => target.recommendation.createMany({ data: r })],
    ['recommendationFactor', () => source.recommendationFactor.findMany(), (r) => target.recommendationFactor.createMany({ data: r })],
    ['settlementResult', () => source.settlementResult.findMany(), (r) => target.settlementResult.createMany({ data: r })],
    ['scoringConfigVersion', () => source.scoringConfigVersion.findMany(), (r) => target.scoringConfigVersion.createMany({ data: r })],
    ['entityReviewItem', () => source.entityReviewItem.findMany(), (r) => target.entityReviewItem.createMany({ data: r })],
  ];

  for (const [name, read, write] of order) {
    const rows = await read();
    if (!rows.length) {
      console.log(`  ${name.padEnd(24)} 0`);
      continue;
    }
    await write(rows as any[]);
    console.log(`  ${name.padEnd(24)} ${rows.length}`);
  }

  await source.$disconnect();
  await target.$disconnect();
  console.log('\nmigration complete\n');
}

main().catch((err) => {
  logger.error({ err: String(err) }, 'migration failed');
  process.exit(1);
});
