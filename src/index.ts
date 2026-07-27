import { createApp } from './app';
import { env, assertServerEnv, assertSofaScoreConfigFresh } from './env';
import { logger } from './lib/logger';
import { prisma, initDb } from './db/client';
import { snapshotScoringVersion } from './services/scoringConfig';
import { startScheduler } from './jobs/scheduler';
import { closeBrowser } from './adapters/betano/browser';

async function bootstrap(): Promise<void> {
  // Never bring up an unprotected API (spec §9.1).
  assertServerEnv();
  assertSofaScoreConfigFresh();

  await initDb();
  await snapshotScoringVersion();

  // Tournament and season IDs are static config (§5.3.4), read directly by
  // reconciliation and the /meta/leagues endpoint — no DB caching step here
  // anymore. That indirection was a real bug: any standalone script run
  // (bootstrap, analyse) without the server ever having started left this
  // silently unpopulated, with no clear cause visible in the failure.

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(`Courtside API listening on :${env.PORT} (${env.NODE_ENV})`);
  });

  if (process.env.RUN_SCHEDULER !== 'false') startScheduler();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    server.close();
    await closeBrowser().catch(() => undefined);
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

bootstrap().catch((err) => {
  logger.error({ err: String(err) }, 'fatal bootstrap error');
  process.exit(1);
});
