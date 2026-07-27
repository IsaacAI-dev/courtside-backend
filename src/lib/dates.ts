export const HOUR_MS = 3600_000;
export const MINUTE_MS = 60_000;

export const isoDate = (d: Date) => d.toISOString().slice(0, 10); // 2026-07-19
export const compactDate = (d: Date) => isoDate(d).replace(/-/g, ''); // 20260719
export const slashDate = (d: Date) => {
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${mm}/${dd}/${d.getUTCFullYear()}`; // 07/19/2026 (stats scoreboardv2)
};

export const minutesBetween = (a: Date, b: Date) => Math.round((a.getTime() - b.getTime()) / MINUTE_MS);
export const daysBetween = (a: Date, b: Date) => Math.floor((a.getTime() - b.getTime()) / (24 * HOUR_MS));

/** Parse league-feed "MIN" strings like "34:12" or "34" into decimal minutes. */
export function parseMinutes(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string' || !v.trim()) return 0;
  const m = v.match(/^(\d+):(\d+)$/);
  if (m) return parseInt(m[1], 10) + parseInt(m[2], 10) / 60;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}
