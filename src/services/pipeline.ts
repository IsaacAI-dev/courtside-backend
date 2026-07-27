/**
 * The analysis pipeline (spec §4.1) — seven stages:
 *
 *   1 fixture reconciliation   → 2 board harvest   → 3 stats/injury refresh
 *   4 availability gate        → 5 form analysis   → 6 line selection + scoring
 *   7 persist + publish
 *
 * Failure policy (§4.1): Betano unreachable → FAILED (no board, nothing to
 * recommend); any other source failing → DEGRADED, noted on the run.
 * Every player that enters stage 4 leaves as either a Recommendation or a
 * PlayerExclusion — nobody silently disappears (§4.7).
 */
import { prisma } from '../db/client';
import { env } from '../env';
import { logger } from '../lib/logger';
import { HOUR_MS, minutesBetween } from '../lib/dates';
import type { LeagueId, Market, Side } from '../lib/types';
import { MARKETS } from '../lib/types';
import { reconcileFixtures } from './reconciler';
import { harvestBoard, refreshStatsForFixture, sweepInjuries, sweepLineupAbsences, refreshTeamRatings } from './ingestion';

/**
 * Stringify an error INCLUDING any wrapped `.cause` (e.g. PipelineFatal) —
 * otherwise the real underlying failure is invisible behind a generic
 * wrapper message. Confirmed 22 Jul 2026: a reconciliation failure showed
 * only "fixture reconciliation failed (Betano unreachable?)" in every log,
 * even though Betano and SofaScore were both proven reachable seconds
 * earlier via `npm run test:session` — the actual cause was captured in
 * `.cause` but every call site used plain `String(err)`, which never reads it.
 */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    return cause ? `${err.message} | cause: ${describeError(cause)}` : err.message;
  }
  return String(err);
}
import { evaluateAvailability } from './availability';
import { computeWindowForm, hitRateCurve, marketValues, simpleMean } from './form';
import { selectLine } from './lineSelector';
import { scoreRecommendation, type ScoreContext } from './scorer';
import { getScoringConfig, snapshotScoringVersion } from './scoringConfig';
import { runBus } from './sse';

export interface RunOptions {
  leagueId: LeagueId;
  trigger: string; // SCHEDULED_T90 | SCHEDULED_T30 | MANUAL | BACKFILL
  windowHours?: number;
  fixtureId?: string; // restrict to one fixture (late check)
  skipScrape?: boolean; // analyse existing data only
}

export async function executeAnalysisRun(opts: RunOptions): Promise<string> {
  const windowHours = opts.windowHours ?? env.ANALYSIS_WINDOW_HOURS;
  const now = new Date();
  const windowEnd = new Date(now.getTime() + windowHours * HOUR_MS);

  await snapshotScoringVersion();
  const scoring = getScoringConfig();

  const run = await prisma.analysisRun.create({
    data: {
      leagueId: opts.leagueId,
      trigger: opts.trigger,
      windowStart: now,
      windowEnd,
      scoringVersion: scoring.version,
    },
  });
  const runId = run.id;
  const log = logger.child({ runId, leagueId: opts.leagueId });
  const stage = (name: string, detail?: unknown) => {
    log.info({ stage: name, detail }, 'pipeline stage');
    runBus.emitRun({ runId, type: 'stage', payload: { stage: name, detail } });
  };

  const sourceErrors: Array<{ source: string; error: string }> = [];
  let degraded = false;

  try {
    // ── Stages 1-3: ingestion (skippable for re-analysis of existing data) ──
    if (!opts.skipScrape) {
      stage('reconcile_fixtures');
      try {
        await reconcileFixtures(opts.leagueId, windowHours);
      } catch (err) {
        // The real cause was previously invisible — only the generic wrapper
        // message below ever reached a log. Print it immediately.
        logger.error({ err: describeError(err) }, 'reconcileFixtures threw — this is the real cause');
        sourceErrors.push({ source: 'BETANO', error: describeError(err) });
        throw new PipelineFatal('fixture reconciliation failed (Betano unreachable?)', err);
      }

      try {
        await refreshTeamRatings(opts.leagueId);
      } catch (err) {
        degraded = true;
        sourceErrors.push({ source: 'LEAGUE', error: `team ratings: ${err}` });
      }

      try {
        await sweepInjuries(opts.leagueId);
      } catch (err) {
        degraded = true;
        sourceErrors.push({ source: 'ESPN', error: `injury sweep: ${err}` });
      }
    }

    const fixtures = await prisma.fixture.findMany({
      where: {
        leagueId: opts.leagueId,
        startsAt: { gte: now, lte: windowEnd },
        status: 'SCHEDULED',
        ...(opts.fixtureId ? { id: opts.fixtureId } : {}),
        // Only fixtures Betano actually lists can carry a board.
        reconciliationStatus: { in: ['MATCHED', 'FUZZY', 'TIME_DISCREPANCY', 'UNMATCHED_BETANO_ONLY'] },
      },
      include: { homeTeam: true, awayTeam: true },
      orderBy: { startsAt: 'asc' },
    });
    stage('fixtures_selected', { count: fixtures.length });

    // ── Precondition: the player crosswalk must be seeded ───────────────────
    // Checked once, before any board is fetched. With zero Player rows every
    // prop fails all six resolution tiers and lands in the review queue, and
    // the run then reports COMPLETED with nothing in it — the exact failure
    // mode observed on 27 Jul 2026 (959 props fetched, 0 written, status
    // COMPLETED). Nothing downstream can succeed in that state, so fail the
    // run loudly with the command that fixes it rather than burning a
    // Chromium escalation per fixture to produce an empty board.
    if (fixtures.length > 0) {
      const seededPlayers = await prisma.player.count({ where: { leagueId: opts.leagueId } });
      if (seededPlayers === 0) {
        const msg =
          `player crosswalk is empty for ${opts.leagueId} — run \`npm run bootstrap -- --league ${opts.leagueId}\` before analysing`;
        log.error({ leagueId: opts.leagueId }, msg);
        sourceErrors.push({ source: 'LEAGUE', error: msg });
        throw new PipelineFatal(msg, null);
      }
    }

    let playersConsidered = 0;
    let playersExcluded = 0;
    let recommendationsEmitted = 0;
    let boardHadLines = false;
    // Props Betano actually returned this run, and how many of them failed
    // entity resolution. `boardHadLines` alone can't see these: it is derived
    // from PropLine rows WRITTEN, so a total resolution failure looks
    // identical to Betano offering no board at all.
    let propsFetched = 0;
    let propsUnresolved = 0;

    // League pace/def distributions for matchup z-scores.
    const leagueTeams = await prisma.team.findMany({ where: { leagueId: opts.leagueId } });
    const paces = leagueTeams.map((t) => t.paceRating).filter((x): x is number => x != null);
    const defs = leagueTeams.map((t) => t.defRating).filter((x): x is number => x != null);
    const zOf = (v: number | null, pool: number[]): number | null => {
      if (v == null || pool.length < 4) return null;
      const mu = simpleMean(pool);
      const sd = Math.sqrt(pool.reduce((a, x) => a + (x - mu) ** 2, 0) / (pool.length - 1)) || 1;
      return (v - mu) / sd;
    };

    for (const fixture of fixtures) {
      // ── Stage 2-3 per fixture ──
      if (!opts.skipScrape) {
        stage('harvest_board', { fixtureId: fixture.id });
        try {
          const harvest = await harvestBoard(fixture.id);
          propsFetched += harvest.fetched;
          propsUnresolved += harvest.unresolved;
        } catch (err) {
          sourceErrors.push({ source: 'BETANO', error: `board ${fixture.id}: ${err}` });
          throw new PipelineFatal(`board harvest failed for fixture ${fixture.id}`, err);
        }
        stage('refresh_stats', { fixtureId: fixture.id });
        try {
          await refreshStatsForFixture(fixture.id);
        } catch (err) {
          degraded = true;
          sourceErrors.push({ source: 'LEAGUE', error: `stats ${fixture.id}: ${err}` });
        }
        try {
          // sweepLineupAbsences now rethrows anything that isn't "lineups not
          // published yet", so this catch can finally do its job — it used to
          // be unreachable because the callee swallowed every error itself.
          await sweepLineupAbsences(fixture.id);
        } catch (err) {
          degraded = true;
          sourceErrors.push({ source: 'SOFASCORE', error: `lineups ${fixture.id}: ${describeError(err)}` });
          log.warn({ fixtureId: fixture.id, err: describeError(err) }, 'lineup sweep failed — run marked DEGRADED');
        }
      }

      // ── The board: latest capture batch per player+market ──
      const allLines = await prisma.propLine.findMany({
        where: { fixtureId: fixture.id },
        orderBy: { capturedAt: 'desc' },
      });
      if (allLines.length) boardHadLines = true;

      // Latest capture wins: group by player+market, keep only rows from the newest capturedAt cluster (±5 min).
      const boardByPlayer = new Map<string, Map<Market, typeof allLines>>();
      for (const line of allLines) {
        const perPlayer = boardByPlayer.get(line.playerId) ?? new Map<Market, typeof allLines>();
        const perMarket = perPlayer.get(line.market as Market) ?? [];
        const newest = perMarket[0]?.capturedAt ?? line.capturedAt;
        if (Math.abs(minutesBetween(newest, line.capturedAt)) <= 5) {
          perMarket.push(line);
          perPlayer.set(line.market as Market, perMarket);
          boardByPlayer.set(line.playerId, perPlayer);
        }
      }

      // Spread from fixture, back-to-back flags from reconciliation.
      for (const [playerId, markets] of boardByPlayer) {
        playersConsidered++;
        const player = await prisma.player.findUnique({ where: { id: playerId } });
        if (!player) continue;

        const exclude = async (reason: string, detail: string | null) => {
          playersExcluded++;
          await prisma.playerExclusion.create({
            data: { runId, fixtureId: fixture.id, playerId, rawName: player.fullName, reason, detail },
          });
          runBus.emitRun({ runId, type: 'exclusion', payload: { player: player.fullName, reason, detail } });
        };

        // ── Stage 4: availability gate ──
        const availability = await evaluateAvailability(playerId, opts.leagueId, fixture.startsAt);
        if (availability.verdict === 'FAIL') {
          await exclude(availability.failReason ?? 'INSUFFICIENT_DATA', availability.failDetail);
          continue;
        }

        // ── Stage 5-6 per market ──
        const logs = await prisma.playerGameLog.findMany({
          where: { playerId, gameDate: { lt: fixture.startsAt }, source: 'LEAGUE' },
          orderBy: { gameDate: 'desc' },
          take: 40,
        });
        const playedLogs = logs.filter((g) => !g.didNotPlay);
        if (playedLogs.length < env.MIN_GAMES_REQUIRED) {
          await exclude('INSUFFICIENT_DATA', `${playedLogs.length} playable game logs (< ${env.MIN_GAMES_REQUIRED})`);
          continue;
        }

        const isHome = (await prisma.team.findFirst({ where: { id: fixture.homeTeamId, players: { some: { id: playerId } } } })) != null;
        const opponent = isHome ? fixture.awayTeam : fixture.homeTeam;
        const isBackToBack = isHome ? fixture.isBackToBackHome : fixture.isBackToBackAway;
        const firstGameBack =
          availability.daysSinceLastAppearance != null && availability.daysSinceLastAppearance >= 7;

        let emittedForPlayer = 0;
        for (const market of MARKETS) {
          const lines = markets.get(market);
          if (!lines?.length) continue;

          const ladder = [...new Set(lines.map((l) => l.line))].sort((a, b) => a - b);
          const formL5 = computeWindowForm(logs, market, env.PRIMARY_WINDOW, env.RECENCY_LAMBDA);
          const formL10 = computeWindowForm(logs, market, 10, env.RECENCY_LAMBDA);
          const valuesL5 = marketValues(playedLogs.slice(0, env.PRIMARY_WINDOW), market);
          const valuesL10 = marketValues(playedLogs.slice(0, 10), market);
          const valuesSeason = marketValues(playedLogs, market);

          const sides: Side[] = env.COMPUTE_UNDER_SIDE ? ['OVER', 'UNDER'] : ['OVER'];
          for (const side of sides) {
            const curveL5 = hitRateCurve(valuesL5, ladder, side);
            const curveL10 = hitRateCurve(valuesL10, ladder, side);
            const selection = selectLine({
              ladder,
              curveL5,
              muWeighted: formL5.meanWeighted,
              sigma: formL5.stdDev,
              threshold: env.HIT_RATE_THRESHOLD,
              mode: env.SELECTION_MODE,
              side,
            });
            if (!selection.ok) {
              // Only record the display-default side's misses — mirroring both
              // sides would double every exclusion for no analytical gain.
              if (side === env.DISPLAY_SIDE_DEFAULT) {
                await exclude(selection.reason, `${market}: ${selection.detail}`);
              }
              continue;
            }

            const pointL5 = curveL5.find((p) => p.line === selection.line)!;
            const pointL10 = curveL10.find((p) => p.line === selection.line)!;
            const seasonCurve = hitRateCurve(valuesSeason, [selection.line], side)[0];
            const seasonRate = seasonCurve.n - seasonCurve.pushes > 0 ? seasonCurve.rate : null;

            const chosen = lines
              .filter((l) => l.line === selection.line)
              .sort((a, b) => b.capturedAt.getTime() - a.capturedAt.getTime())[0];
            const lineAge = chosen ? minutesBetween(new Date(), chosen.capturedAt) : null;

            const identity = await prisma.sourceIdentity.findFirst({
              where: { playerId, source: 'BETANO', entityType: 'PLAYER' },
            });

            const ctx: ScoreContext = {
              market,
              line: selection.line,
              formL5,
              formL10,
              curvePointL5: pointL5,
              curvePointL10: pointL10,
              seasonHitRate: seasonRate,
              gamesAvailable: valuesSeason.length,
              oppPaceZ: zOf(opponent.paceRating, paces),
              oppDefZ: zOf(opponent.defRating, defs), // higher defRating = worse defence = good for the OVER
              isBackToBack,
              isThirdInFour: false, // needs 4-day schedule scan; wired in jobs later
              isFirstGameBack: firstGameBack,
              spread: fixture.spread,
              fuzzyEntityMatch: identity?.matchMethod === 'FUZZY',
              lineAgeMinutes: lineAge,
            };
            const score = scoreRecommendation(ctx, env.CONFIDENCE_FLOOR);
            if (score.tier === null) {
              if (side === env.DISPLAY_SIDE_DEFAULT) {
                await exclude('BELOW_CONFIDENCE_FLOOR', `${market} ${side} ${selection.line}: confidence ${score.confidence} < ${env.CONFIDENCE_FLOOR}`);
              }
              continue;
            }

            const rec = await prisma.recommendation.create({
              data: {
                runId,
                fixtureId: fixture.id,
                playerId,
                market,
                side,
                recommendedLine: selection.line,
                betanoMinLine: Math.min(...ladder),
                betanoMaxLine: Math.max(...ladder),
                offeredOdds: side === 'OVER' ? chosen?.overOdds : chosen?.underOdds,
                selectionMode: env.SELECTION_MODE,
                meanWeighted: formL5.meanWeighted,
                meanSimple: formL5.meanSimple,
                stdDev: formL5.stdDev,
                hitsL5: pointL5.hits,
                gamesL5: pointL5.n,
                pushesL5: pointL5.pushes,
                hitsL10: pointL10.hits,
                gamesL10: pointL10.n,
                hitRateL5: pointL5.rate,
                hitRateL10: pointL10.rate,
                seasonMean: simpleMean(valuesSeason),
                confidence: score.confidence,
                tier: score.tier,
                scoringVersion: score.scoringVersion,
                factors: {
                  create: score.factors.map((f) => ({
                    kind: f.kind,
                    name: f.name,
                    value: f.value,
                    weight: f.weight,
                    contribution: f.contribution,
                    note: f.note,
                  })),
                },
              },
            });
            recommendationsEmitted++;
            emittedForPlayer++;
            runBus.emitRun({
              runId,
              type: 'recommendation',
              payload: { id: rec.id, player: player.fullName, market, side, line: selection.line, confidence: score.confidence, tier: score.tier },
            });
          }
        }
        if (!emittedForPlayer && availability.verdict === 'PASS') {
          // Player passed the gate but no market produced anything; the per-market
          // exclusions above already say why. Nothing extra to record.
        }
      }
    }

    // ── Stage 7: finalise ──
    // Alarm condition (§11.4), in two parts.
    //
    // (a) Betano returned a board and NONE of it resolved. This is the case
    //     the original alarm below could not see: it keys off PropLine rows
    //     written, so a total resolution failure and an empty board are
    //     indistinguishable to it — both leave `boardHadLines` false. A book
    //     that answered with hundreds of props while the pipeline persisted
    //     none of them is broken, not quiet.
    if (propsFetched > 0 && propsUnresolved === propsFetched) {
      degraded = true;
      const msg = `${propsFetched} props fetched from Betano, 0 resolved to a known player — entity resolution fault, not an empty board`;
      log.error({ propsFetched, propsUnresolved }, `ALARM: ${msg}`);
      sourceErrors.push({ source: 'RESOLUTION', error: msg });
    }

    // (b) The original: a non-empty board that produces zero output and zero
    //     exclusions means the pipeline is broken, not that there's no value.
    if ((boardHadLines || propsFetched > 0) && recommendationsEmitted === 0 && playersExcluded === 0) {
      log.error(
        { boardHadLines, propsFetched, propsUnresolved },
        'ALARM: non-empty board produced zero recommendations AND zero exclusions — pipeline fault',
      );
    }

    const finished = new Date();
    await prisma.analysisRun.update({
      where: { id: runId },
      data: {
        status: degraded ? 'DEGRADED' : 'COMPLETED',
        fixturesConsidered: fixtures.length,
        playersConsidered,
        playersExcluded,
        recommendationsEmitted,
        sourceErrors: sourceErrors.length ? JSON.stringify(sourceErrors) : null,
        finishedAt: finished,
        durationMs: finished.getTime() - run.startedAt.getTime(),
      },
    });
    runBus.emitRun({
      runId,
      type: 'complete',
      payload: { status: degraded ? 'DEGRADED' : 'COMPLETED', recommendationsEmitted, playersExcluded },
    });
    return runId;
  } catch (err) {
    const finished = new Date();
    await prisma.analysisRun.update({
      where: { id: runId },
      data: {
        status: 'FAILED',
        sourceErrors: JSON.stringify([...sourceErrors, { source: 'PIPELINE', error: describeError(err) }]),
        finishedAt: finished,
        durationMs: finished.getTime() - run.startedAt.getTime(),
      },
    });
    runBus.emitRun({ runId, type: 'error', payload: { error: describeError(err) } });
    log.error({ err: describeError(err) }, 'analysis run failed');
    return runId;
  }
}

class PipelineFatal extends Error {
  constructor(message: string, public cause: unknown) {
    super(message);
  }
}

/** Late check (§10.2): T−30 re-verification. Voids, never re-scores upward. */
export async function lateCheck(fixtureId: string): Promise<{ voided: number }> {
  const fixture = await prisma.fixture.findUniqueOrThrow({ where: { id: fixtureId } });
  const recs = await prisma.recommendation.findMany({
    where: { fixtureId, status: 'ACTIVE' },
    include: { player: true },
  });
  if (!recs.length) return { voided: 0 };

  // Fresh injury + lineup data, then re-run the gate per recommended player.
  try {
    await sweepLineupAbsences(fixtureId);
  } catch {
    /* degraded — proceed on stored data */
  }

  let voided = 0;
  for (const rec of recs) {
    const availability = await evaluateAvailability(rec.playerId, fixture.leagueId, fixture.startsAt);
    if (availability.verdict === 'FAIL') {
      await prisma.recommendation.update({
        where: { id: rec.id },
        data: { status: 'VOIDED_LATE_SCRATCH', voidReason: `${availability.failReason}: ${availability.failDetail}` },
      });
      voided++;
      runBus.emitRun({
        runId: rec.runId,
        type: 'recommendation',
        payload: { id: rec.id, voided: true, reason: availability.failDetail },
      });
      continue;
    }
    // Line-moved check: has the minimum offered line moved above our recommendation?
    const latest = await prisma.propLine.findMany({
      where: { fixtureId, playerId: rec.playerId, market: rec.market },
      orderBy: { capturedAt: 'desc' },
      take: 20,
    });
    if (latest.length) {
      const newestBatch = latest.filter(
        (l) => Math.abs(minutesBetween(latest[0].capturedAt, l.capturedAt)) <= 5,
      );
      const minNow = Math.min(...newestBatch.map((l) => l.line));
      if (rec.side === 'OVER' && rec.recommendedLine < minNow) {
        await prisma.recommendation.update({
          where: { id: rec.id },
          data: { status: 'VOIDED_LINE_MOVED', voidReason: `Betano minimum moved to ${minNow}, above recommended ${rec.recommendedLine}` },
        });
        voided++;
      }
    }
  }
  return { voided };
}