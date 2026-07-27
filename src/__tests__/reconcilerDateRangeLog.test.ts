import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logDateRange } from '../services/reconciler';
import { logger } from '../lib/logger';

/**
 * Regression coverage for a real diagnostic gap (22 Jul 2026): a reconciliation
 * run with matched/betanoOnly/sofaOnly all at 0 was indistinguishable between
 * two completely different situations — "nothing parsed at all" vs "9 fixtures
 * parsed, all outside the requested window" vs "in window, but something else
 * dropped them". This test locks in that the three cases now log distinctly.
 */
describe('logDateRange distinguishes empty vs out-of-window vs in-window data', () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => logger as any);
  });

  const now = new Date('2026-07-22T00:00:00Z');
  const windowEnd = new Date('2026-07-24T00:00:00Z'); // 48h

  it('reports "nothing to filter" when nothing was parsed at all', () => {
    logDateRange('Betano', [], 0, now, windowEnd);
    const [, msg] = infoSpy.mock.calls[0] as [unknown, string];
    expect(msg).toMatch(/0 fixtures\/events parsed — nothing to filter/);
  });

  it('flags fixtures that parsed successfully but ALL fall outside the window', () => {
    const raw = [{ startsAt: new Date('2026-07-27T20:00:00Z') }, { startsAt: new Date('2026-07-28T20:00:00Z') }];
    logDateRange('Betano', raw, 0, now, windowEnd);
    const [detail, msg] = infoSpy.mock.calls[0] as [Record<string, unknown>, string];
    expect(msg).toMatch(/9? ?parsed, but NONE fall within the requested window/);
    expect(detail.rawCount).toBe(2);
    expect(detail.inWindowCount).toBe(0);
    expect(detail.earliestStart).toBe('2026-07-27T20:00:00.000Z');
    expect(detail.latestStart).toBe('2026-07-28T20:00:00.000Z');
  });

  it('reports a normal in-window count without the warning phrasing', () => {
    const raw = [{ startsAt: new Date('2026-07-23T20:00:00Z') }, { startsAt: new Date('2026-07-30T20:00:00Z') }];
    logDateRange('SofaScore', raw, 1, now, windowEnd);
    const [detail, msg] = infoSpy.mock.calls[0] as [Record<string, unknown>, string];
    expect(msg).toBe('SofaScore: 1/2 within window');
    expect(detail.rawCount).toBe(2);
    expect(detail.inWindowCount).toBe(1);
  });

  it('correctly finds min/max across an unsorted list', () => {
    const raw = [
      { startsAt: new Date('2026-07-29T00:00:00Z') },
      { startsAt: new Date('2026-07-25T00:00:00Z') },
      { startsAt: new Date('2026-07-31T00:00:00Z') },
    ];
    logDateRange('Betano', raw, 0, now, windowEnd);
    const [detail] = infoSpy.mock.calls[0] as [Record<string, unknown>];
    expect(detail.earliestStart).toBe('2026-07-25T00:00:00.000Z');
    expect(detail.latestStart).toBe('2026-07-31T00:00:00.000Z');
  });
});
