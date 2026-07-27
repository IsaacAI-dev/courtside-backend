/**
 * Name normalisation — the single normaliser used everywhere (spec §6.3).
 * Diacritics stripped, punctuation removed, hyphens to spaces, case folded.
 * The SAME function must process both sides of every comparison.
 */

const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

export function normaliseName(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/\s*\((?:w|m|women|men)\)\s*/gi, ' ') // gender-qualifier parentheticals,
    // e.g. Betano's "Golden State Valkyries (W)" — must be removed WHOLE, not
    // just the parens around them. Stripping only punctuation left a stray
    // "w" token behind ("...valkyries w"), which broke every exact-match team
    // lookup for a WNBA team name sourced from Betano (confirmed 22 Jul 2026:
    // 9/9 Betano fixtures silently dropped from reconciliation as a result).
    .replace(/[\u2018\u2019'`".()]/g, '') // punctuation
    .replace(/[-\u2013\u2014]/g, ' ') // hyphens/dashes → space
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split a trailing generational suffix off a normalised name. Never fold it away (§6.4). */
export function splitSuffix(normalised: string): { base: string; suffix: string | null } {
  const parts = normalised.split(' ');
  const last = parts[parts.length - 1];
  if (parts.length > 1 && SUFFIXES.has(last)) {
    return { base: parts.slice(0, -1).join(' '), suffix: last };
  }
  return { base: normalised, suffix: null };
}

export function lastNameOf(normalised: string): string {
  const { base } = splitSuffix(normalised);
  const parts = base.split(' ');
  return parts[parts.length - 1] ?? '';
}

export function firstInitialOf(normalised: string): string {
  return normalised.charAt(0);
}

/** Sørensen–Dice coefficient over character bigrams — the fuzzy tier's similarity metric. */
export function diceSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.slice(i, i + 2);
      m.set(bg, (m.get(bg) ?? 0) + 1);
    }
    return m;
  };
  const ma = bigrams(a);
  const mb = bigrams(b);
  let overlap = 0;
  for (const [bg, ca] of ma) overlap += Math.min(ca, mb.get(bg) ?? 0);
  return (2 * overlap) / (a.length - 1 + (b.length - 1));
}
