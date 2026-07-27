import { describe, it, expect } from 'vitest';
import { normaliseName } from '../lib/normalise';

/**
 * Regression test for a real bug (22 Jul 2026): Betano tags every WNBA team
 * name with a gender qualifier — "Golden State Valkyries (W)". The old
 * normaliser stripped the PARENTHESES characters but left the letter behind
 * as a stray trailing word ("...valkyries w"), which never exact-matched the
 * plain seeded team name ("...valkyries"). Every one of 9 real Betano
 * fixtures was silently dropped from reconciliation as a result — not
 * flagged as an error, just uncounted, with only a WARN log easy to miss
 * among session-diagnostic noise.
 */
describe('normaliseName strips gender-qualifier parentheticals entirely', () => {
  const cases: Array<[string, string]> = [
    ['Golden State Valkyries (W)', 'Golden State Valkyries'],
    ['Washington Mystics (W)', 'Washington Mystics'],
    ['Toronto Tempo (W)', 'Toronto Tempo'],
    ['Las Vegas Aces (W)', 'Las Vegas Aces'],
    ['Some Team (M)', 'Some Team'],
    ['Some Team (Women)', 'Some Team'],
    ['Some Team (Men)', 'Some Team'],
  ];

  it.each(cases)('"%s" normalises identically to "%s"', (withQualifier, plain) => {
    expect(normaliseName(withQualifier)).toBe(normaliseName(plain));
  });

  it('leaves no stray trailing letter from the qualifier', () => {
    expect(normaliseName('Golden State Valkyries (W)')).not.toMatch(/\bw\b$/);
  });

  it('does not touch multi-letter esports/streamer handles in parens', () => {
    // "(TAAPZ)" is an arbitrary handle, not a gender qualifier — must survive.
    expect(normaliseName('Denver Nuggets (TAAPZ)')).toContain('taapz');
  });

  it('does not affect ordinary player names', () => {
    expect(normaliseName('Caitlin Clark')).toBe('caitlin clark');
    expect(normaliseName('Sonia Citron')).toBe('sonia citron');
  });

  it('still handles generational suffixes unrelated to this fix', () => {
    expect(normaliseName('Michael Jordan Jr')).toBe('michael jordan jr');
  });
});
