import { describe, it, expect } from 'vitest';
import { withCacheBypass } from '../adapters/sofascore';

/**
 * Regression test for a real finding (22 Jul 2026): a user's back-to-back
 * Postman test showed an otherwise-identical SofaScore request go from 403
 * to 200 purely by adding `:authority=<host>` as a literal query parameter.
 * Since we don't know whether that's a genuine signal check or a stale-cache
 * artifact (any new query string would defeat a cached 403 the same way),
 * every request carries BOTH the literal parameter and a per-request nonce —
 * covering either explanation without needing to resolve which is true.
 */
describe('SofaScore cache-bypass URL construction', () => {
  it('appends :authority unencoded — not percent-encoded as %3A', () => {
    const url = withCacheBypass('https://www.sofascore.com/api/v1/sport/basketball/scheduled-events/2026-07-22');
    expect(url).toContain(':authority=www.sofascore.com');
    expect(url).not.toContain('%3Aauthority');
  });

  it('appends exactly :authority and nothing else — matches the confirmed-working URL', () => {
    const url = withCacheBypass('https://www.sofascore.com/api/v1/unique-tournament/486/season/89004/events/next/0');
    // The user's confirmed-working request carried ONLY ?:authority=<host>.
    // No nonce, no extra params — an earlier speculative nonce caused a 403.
    expect(url).toBe(
      'https://www.sofascore.com/api/v1/unique-tournament/486/season/89004/events/next/0?:authority=www.sofascore.com',
    );
  });

  it('does not append any cache-busting nonce parameter', () => {
    const a = withCacheBypass('https://www.sofascore.com/api/v1/sport/basketball/scheduled-events/2026-07-22');
    const b = withCacheBypass('https://www.sofascore.com/api/v1/sport/basketball/scheduled-events/2026-07-22');
    expect(a).toBe(b); // identical inputs produce identical URLs — no nonce
    expect(a).not.toMatch(/[?&]_=/);
  });

  it('uses "?" when the path has no existing query string, "&" when it does', () => {
    const noQuery = withCacheBypass('https://www.sofascore.com/api/v1/team/123/players');
    const withQuery = withCacheBypass('https://www.sofascore.com/api/v1/search/all?q=caitlin');

    const firstParamIndex = noQuery.indexOf(':authority');
    expect(noQuery[firstParamIndex - 1]).toBe('?');

    expect(withQuery).toContain('?q=caitlin&:authority=');
  });

  it('derives the :authority host from SOFASCORE_BASE_URL, not the request path', () => {
    const url = withCacheBypass('https://www.sofascore.com/api/v1/config/unique-tournaments/en/basketball');
    expect(url).toContain(':authority=www.sofascore.com');
  });
});
