/**
 * Job orchestration (spec §10). A 5-minute cron tick computes, for every fixture
 * in the forward window, which offsets have come due since the last tick.
 * JobExecution rows make the check idempotent: a restart never double-runs a job
 * and never skips one it missed.
 *
 *   T−24h  FIXTURE_DISCOVERY   reconcile the board against the schedule
 *   T−12h  BOARD_HARVEST       first prop capture
 *   T−6h   STATS_REFRESH       game logs, team ratings
 *   T−3h   INJURY_SWEEP        ESPN + lineups
 *   T−90m  ANALYSIS_PRIMARY    the run that produces the board
 *   T−30m  LATE_CHECK          re-verify availability, void scratches
 *   T+4h   SETTLEMENT          grade against the box score
 */
import cron from 'node-cron';
import { prisma } from '../db/client';
import { env } from '../env';
import { logger } from '../lib/logger';
import { HOUR_MS, minutesBetween } from '../lib/dates';
import { executeAnalysisRun, lateCheck } from '../services/pipeline';
import { reconcileFixtures } from '../services/reconciler';
import { harvestBoard, refreshStatsForFixture, sweepInjuries, refreshTeamRatings } from '../services/ingestion';
import { settleFixture } from '../services/settlement';
import type { LeagueId } from '../lib/types';

interface JobSpec {
  name: string;
  offsetMinutes: number; // minutes BEFORE tip-off (negative = after)
  toleranceMinutes: number;
  run: (fixtureId: string, leagueId: LeagueId) => Promise<unknown>;
}

const JOBS: JobSpec[] = [
  {
    name: 'FIXTURE_DISCOVERY',
    offsetMinutes: 1440,
    toleranceMinutes: 60,
    run: (_f, league) => reconcileFixtures(league, 48),
  },
  { name: 'BOARD_HARVEST', offsetMinutes: 720, toleranceMinutes: 60, run: (f) => harvestBoard(f) },
  {
    name: 'STATS_REFRESH',
    offsetMinutes: 360,
    toleranceMinutes: 45,
    run: async (f, league) => {
      await refreshStatsForFixture(f);
      await refreshTeamRatings(league);
    },
  },
  { name: 'INJURY_SWEEP', offsetMinutes: 180, toleranceMinutes: 30, run: (_f, league) => sweepInjuries(league) },
  {
    name: 'ANALYSIS_PRIMARY',
    offsetMinutes: 90,
    toleranceMinutes: 20,
    run: (f, league) =>
      executeAnalysisRun({ leagueId: league, trigger: 'SCHEDULED_T90', fixtureId: f, windowHours: 24 }),
  },
  { name: 'LATE_CHECK', offsetMinutes: 30, toleranceMinutes: 12, run: (f) => lateCheck(f) },
  { name: 'SETTLEMENT', offsetMinutes: -240, toleranceMinutes: 90, run: (f) => settleFixture(f) },
];

async function alreadyRan(jobName: string, fixtureId: string): Promise<boolean> {
  const existing = await prisma.jobExecution.findFirst({
    where: { jobName, fixtureId, status: { in: ['RUNNING', 'COMPLETED'] } },
  });
  return existing != null;
}

async function tick(): Promise<void> {
  const now = new Date();
  const fixtures = await prisma.fixture.findMany({
    where: {
      startsAt: { gte: new Date(now.getTime() - 12 * HOUR_MS), lte: new Date(now.getTime() + 48 * HOUR_MS) },
      status: { in: ['SCHEDULED', 'LIVE', 'FINAL'] },
      league: { isActive: true },
    },
    select: { id: true, leagueId: true, startsAt: true },
  });

  for (const fixture of fixtures) {
    const minutesToTip = minutesBetween(fixture.startsAt, now);
    for (const job of JOBS) {
      const due = Math.abs(minutesToTip - job.offsetMinutes) <= job.toleranceMinutes;
      if (!due) continue;
      if (await alreadyRan(job.name, fixture.id)) continue;

      const execution = await prisma.jobExecution.create({
        data: { jobName: job.name, fixtureId: fixture.id, leagueId: fixture.leagueId },
      });
      logger.info({ job: job.name, fixtureId: fixture.id, minutesToTip }, 'job due — running');
      try {
        await job.run(fixture.id, fixture.leagueId as LeagueId);
        await prisma.jobExecution.update({
          where: { id: execution.id },
          data: { status: 'COMPLETED', finishedAt: new Date() },
        });
      } catch (err) {
        logger.error({ job: job.name, fixtureId: fixture.id, err: String(err) }, 'job failed');
        await prisma.jobExecution.update({
          where: { id: execution.id },
          data: { status: 'FAILED', finishedAt: new Date(), error: String(err).slice(0, 500) },
        });
      }
    }
  }
}

export function startScheduler(): void {
  // Every 5 minutes. Offsets are matched with tolerance, so a missed tick self-heals.
  cron.schedule('*/5 * * * *', () => {
    tick().catch((err) => logger.error({ err: String(err) }, 'scheduler tick failed'));
  });

  // Daily discovery sweep at 06:00 local for leagues with no fixture rows yet.
  cron.schedule('0 6 * * *', () => {
    void (async () => {
      for (const leagueId of env.LEAGUES_ENABLED) {
        try {
          await reconcileFixtures(leagueId as LeagueId, 48);
        } catch (err) {
          logger.warn({ leagueId, err: String(err) }, 'daily discovery failed');
        }
      }
    })();
  });

  logger.info('scheduler started (5-minute tick, daily 06:00 discovery)');
}

if (require.main === module) {
  startScheduler();
  logger.info('scheduler running standalone — Ctrl-C to stop');
}
