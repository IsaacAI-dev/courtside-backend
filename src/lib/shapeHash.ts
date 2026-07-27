import { createHash } from 'node:crypto';

/**
 * Structural fingerprint of a JSON payload (spec §5.2.5).
 * Keys and value TYPES, not values — so a price change hashes identically
 * but a renamed field or a restructured array does not.
 */
export function shapeHash(value: unknown): string {
  return createHash('sha1').update(JSON.stringify(shapeOf(value, 0))).digest('hex').slice(0, 16);
}

function shapeOf(v: unknown, depth: number): unknown {
  if (depth > 6) return '…';
  if (Array.isArray(v)) return v.length ? [shapeOf(v[0], depth + 1)] : [];
  if (v === null) return 'null';
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = shapeOf((v as Record<string, unknown>)[k], depth + 1);
    }
    return out;
  }
  return typeof v;
}
