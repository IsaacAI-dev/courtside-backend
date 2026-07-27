/**
 * Settlement (spec §14.3): T+4h, grade every ACTIVE recommendation against the
 * league box score. WIN / LOSS / PUSH / VOID (player didn't play).
 */
import { prisma } from '../db/client';
import { logger } from '../lib/logger';
import { fetchBoxScore, fetchScoreboard } from '../adapters/leagueStats';
import { statsConfigFor } from './ingestion';
import { slashDate } from '../lib/dates';
import { MARKET_TO_LOG_FIELD, type Market } from '../lib/types';

export async function settleFixture(fixtureId: string): Promise<{ settled: number; skipped: number }> {
  const fixture = await prisma.fixture.findUniqueOrThrow({
    where: { id: fixtureId },
    include: { league: true, sourceLinks: true },
  });
  const recs = await prisma.recommendation.findMany({
    where: { fixtureId, status: 'ACTIVE' },
    include: { player: { include: { identities: true } } },
  });
  if (!recs.length) return { settled: 0, skipped: 0 };

  const cfg = statsConfigFor(fixture.league);

  // Find the league game id: stored link, or scoreboard lookup by date.
  let leagueGameId = fixture.sourceLinks.find((l) => l.source === 'LEAGUE')?.externalId ?? null;
  if (!leagueGameId) {
    const board = await fetchScoreboard(cfg, slashDate(fixture.startsAt));
    // match on home team league identity
    const homeIdentity = await prisma.sourceIdentity.findFirst({
      where: { teamId: fixture.homeTeamId, source: 'LEAGUE', entityType: 'TEAM' },
    });
    const game = homeIdentity ? board.find((g) => g.homeTeamId === homeIdentity.externalId) : board[0];
    if (game) {
      leagueGameId = game.externalGameId;
      await prisma.fixtureSourceLink.upsert({
        where: { source_externalId: { source: 'LEAGUE', externalId: leagueGameId } },
        create: { fixtureId, source: 'LEAGUE', externalId: leagueGameId },
        update: { fixtureId },
      });
    }
  }
  if (!leagueGameId) {
    logger.warn({ fixtureId }, 'no league game id — settlement deferred');
    return { settled: 0, skipped: recs.length };
  }

  const box = await fetchBoxScore(cfg, leagueGameId);
  const byLeagueId = new Map(box.map((b) => [b.leaguePlayerId, b]));

  let settled = 0;
  let skipped = 0;
  for (const rec of recs) {
    const leagueIdentity = rec.player.identities.find((i) => i.source === 'LEAGUE');
    const line = leagueIdentity ? byLeagueId.get(leagueIdentity.externalId) : undefined;
    if (!line) {
      skipped++;
      continue; // box may not be final yet — the T+4h job retries
    }
    const field = MARKET_TO_LOG_FIELD[rec.market as Market];
    const actual =
      field === 'points' ? line.points : field === 'assists' ? line.assists : field === 'rebounds' ? line.rebounds : line.threesMade;

    let outcome: 'WIN' | 'LOSS' | 'PUSH' | 'VOID';
    if (line.minutes === 0) outcome = 'VOID';
    else if (actual === rec.recommendedLine) outcome = 'PUSH';
    else if (rec.side === 'OVER') outcome = actual > rec.recommendedLine ? 'WIN' : 'LOSS';
    else outcome = actual < rec.recommendedLine ? 'WIN' : 'LOSS';

    await prisma.$transaction([
      prisma.settlementResult.upsert({
        where: { recommendationId: rec.id },
        create: { recommendationId: rec.id, actualValue: actual, outcome, minutesPlayed: line.minutes },
        update: { actualValue: actual, outcome, minutesPlayed: line.minutes },
      }),
      prisma.recommendation.update({ where: { id: rec.id }, data: { status: 'SETTLED' } }),
    ]);
    settled++;
  }
  if (settled) {
    await prisma.fixture.update({ where: { id: fixtureId }, data: { status: 'FINAL' } });
  }
  logger.info({ fixtureId, settled, skipped }, 'settlement pass complete');
  return { settled, skipped };
}
