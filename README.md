# Courtside — Backend

NBA & WNBA player-props analysis engine. Node + Express + TypeScript + Prisma.

Implements *Courtside — Technical Specification v1.0* (19 July 2026). Section references throughout the code point back to it.

---

## What this does

Reads the player-props board that Betano.ng offers for upcoming NBA/WNBA fixtures, cross-checks the fixture list against SofaScore, pulls official game logs from the league stats feeds, applies an availability gate and a form model, and emits ranked recommendations with a written confidence score and a complete factor breakdown.

**Read-only against the book, always.** Nothing here authenticates to a betting account or places a wager.

---

## Before you write any more code: read this

There is **no public Betano API**. The site is a client-rendered SPA behind Cloudflare with browser fingerprinting. Every commercial reseller of Betano prices is scraping or licensing it themselves.

The entire product rests on an assumption nobody has yet tested: *that you can reliably pull a player-prop board off Betano.ng from your machine.* Spec §13 puts a 2–3 day feasibility spike ahead of everything else for that reason.

```bash
npm install
npx playwright install chromium      # discovery needs a real browser
cp .env.example .env                 # discovery reads BETANO_BASE_URL from here
npm run discover:betano              # always opens a visible browser
```

Discovery records three separate things, because a sportsbook can deliver its board by any of them:

| Kind | What it is |
|---|---|
| `REST` | Any response whose body parses as JSON — *regardless of content-type* |
| `WEBSOCKET` | Every frame in both directions; many books push odds over a socket |
| `EMBEDDED` | JSON baked into the HTML (`__NEXT_DATA__`, `__NUXT__`, `__INITIAL_STATE__`) |

Only looking at the first is how you wrongly conclude "there is no API" when the board actually arrived over a socket on page load.

### If a browser window won't open (WSL, headless servers)

Driving a browser is not the only way to run discovery, and it is the harder way on WSL. Your own browser has already cleared Cloudflare, already has the right IP, and already records everything — you just have to export it.

1. Open `betano.ng` in Chrome or Edge on Windows, as you normally would
2. `F12` → **Network** tab → tick **Preserve log**
3. Click into a basketball fixture and open its **Players** tab
4. Right-click in the request list → **Save all as HAR with content**
   (newer Chrome: **Export HAR (with sensitive data)** — the sanitized option strips response bodies and the parser will tell you so)
5. Parse it:

```bash
npm run discover:har -- --file /mnt/c/Users/<you>/Downloads/betano.har
```

Output is identical to live discovery — same shape tags, same `betano-discovery.json`, same diagnosis. It reads REST bodies (including base64-encoded ones and anything mislabelled as `text/plain`) and WebSocket frames from `_webSocketMessages`.

**A HAR contains your session cookies and auth headers.** Keep it on your machine, don't commit it, don't paste it into a chat. This script reads it locally and writes only shape summaries.

### Fixed: 500 from leaguedashteamstats (missing filter parameters)

Confirmed 22 Jul 2026, once the IPv4/gzip fixes below got requests through
cleanly: `leaguedashteamstats` returned a bare HTTP 500 with only the 5
parameters that logically matter (`LeagueID`/`Season`/`SeasonType`/
`MeasureType`/`PerMode`) supplied. This endpoint's backend does not default
missing filter parameters — it throws building the query rather than
returning a 400 with a useful message. Fixed by sending the full documented
filter set (`Conference`, `Division`, `LastNGames`, `Month`, `Outcome`, etc.),
blank where not needed. If another `leaguedash*`-family endpoint 500s the
same way, this is the pattern to apply again.

### Fixed: gzip response bodies were being parsed as plain text

`Accept-Encoding: gzip, deflate, br` was added to look more browser-like, but
undici's low-level `request()` — unlike `fetch()` — does NOT auto-decompress
response bodies. Akamai reasonably honours that header, so `fetchJson` was
receiving real, valid gzip-compressed JSON and trying to parse the raw
compressed bytes as UTF-8 text. The failure looks exactly like a malformed or
blocked response (`SyntaxError: Unexpected token ...`), but the garbled prefix
is literally the gzip magic number (`1F 8B 08 00 ...`) escaped into the
string. Fixed in `src/lib/http.ts`: the body is now decompressed per
`Content-Encoding` (gzip/deflate/br) before parsing. Covered by
`src/__tests__/httpDecoding.test.ts` against a real local server for all three
encodings plus plain text.

### Semi-manual session replay (Cloudflare automation detection)

Confirmed 22 Jul 2026: Cloudflare fingerprints Playwright/CDP automation
itself — a scripted browser gets 403'd the same way a bare HTTP client does.
The Betano `match-odds` endpoint was only ever confirmed reachable from a
real, human-driven browser (the HAR capture). The fix: capture that session
once and replay it as plain HTTP.

**What to grab, from your own browser, right after it loads normally:**
1. Open the site, browse to a fixture, open the Players tab (Betano) or just
   load the page (SofaScore)
2. DevTools → Network → click any XHR request to the domain → Request Headers
3. Copy the **entire `Cookie` value** — don't cherry-pick individual cookies
4. Copy the **exact `User-Agent`** from the *same* request (Cloudflare ties
   the clearance cookie to the User-Agent that solved the challenge)

Paste into `.env`:

```
BETANO_SESSION_COOKIE=...
BETANO_SESSION_USER_AGENT=...
SOFASCORE_SESSION_COOKIE=...
SOFASCORE_SESSION_USER_AGENT=...
```

Check whether a captured session still works, in seconds, without running the
full pipeline:

```bash
npm run test:session
```

When a session is configured, the adapters skip the Playwright browser-tier
fallback entirely on a 403 — it fails the same way and only wastes time — and
raise a clear `SESSION_EXPIRED` error (HTTP 401 from the API) telling you to
recapture. **Expect to refresh more often than once a day**: Cloudflare's
`__cf_bm` cookie is normally kept alive by JavaScript in a live tab, and a
static replay has no JS engine renewing it — real lifetime varies, often
30 minutes to a few hours.

### SofaScore: 403 → 200 with a `:authority` query parameter (unresolved mechanism, covered anyway)

Confirmed via a fair back-to-back test (22 Jul 2026, same cookie, seconds
apart): an otherwise-identical request goes from 403 to 200 purely by adding
`?:authority=www.sofascore.com` as a literal query parameter. Two possible
explanations, and it wasn't worth guessing which:

- SofaScore's edge genuinely reads that parameter as a signal, or
- A CDN is caching the first 403 against the exact URL, and *any* new query
  string forces a cache miss past the stale entry — the specific text being
  incidental.

Every SofaScore request now carries **both** the literal `:authority=<host>`
parameter and a per-request nonce (`_=<timestamp><random>`), covering either
explanation without needing to resolve which is true — and the nonce means a
fixed `:authority` value getting cached as a 403 in the future can't recreate
this problem. See `withCacheBypass()` in `src/adapters/sofascore.ts`, built
by hand rather than via `URLSearchParams` (which would percent-encode the
colon into `%3A`, unlike the literal character that worked in testing).

### SofaScore: use www.sofascore.com, not api.sofascore.com

Confirmed 22 Jul 2026: `api.sofascore.com` 403'd even with a fresh, valid
session cookie; `www.sofascore.com/api/v1/...` — the same API, served from
the main site's own domain — worked immediately with the identical cookie.
`.env.example`'s default now reflects this. If your `.env` still has the old
`api.sofascore.com` value, update `SOFASCORE_BASE_URL` manually.

(One clarification on header capture: `:authority` is an HTTP/2 pseudo-header,
generated automatically from the URL — it is not something to set manually,
and our client doesn't need special handling for it.)

### Betano: the in-page fetch tier (when session replay alone isn't enough)

Confirmed 22 Jul 2026: raw cookie replay through Node/undici was rejected
immediately, even with a session captured seconds earlier — strong evidence
Cloudflare is binding the clearance token to the TLS handshake itself
(JA3/JA4 fingerprint), not just headers. No amount of header tuning fixes
that; the mismatch happens before headers are even read.

`pageFetchJson()` in `src/adapters/betano/browser.ts` is the fix: it launches
a **fresh** (non-persistent) Chromium context with the User-Agent set to
*exactly* match the captured session (Cloudflare ties clearance to that
exact string), injects the captured cookies via the browser's own cookie
jar (`context.addCookies`, not a manual header), and issues the request as a
real `fetch()` **from inside the page** — so it goes through Chromium's
actual TLS stack, not Playwright's separate `APIRequestContext` client
(`browserFetchJson`, the older tier) and not Node's undici. Verified against
a local HTTPS server checking both cookie and exact User-Agent match.

The adapter now tries this automatically: direct tier with your session →
403 → in-page fetch tier → only then `SESSION_EXPIRED`.

### Hardening: SofaScore direct tier now also forces IPv4

Added 22 Jul 2026 for symmetry with `leagueStats.ts`, which already forces
IPv4 after an earlier `AggregateError` diagnosis (Node races IPv4/IPv6 —
"Happy Eyeballs" — and a flaky IPv6 path can throw even when plain IPv4
works). `sofascore.ts`'s direct tier never got the same treatment. This is a
precaution, not a fix for a specific reproduced failure — a run that hit
`AggregateError` on SofaScore *and* `EAI_AGAIN` (DNS resolution failure) on
Betano *and* ESPN in the same pass looks like a genuine, temporary network
interruption on the host machine, not a per-site problem. Nothing in that
pattern points at IPv6 specifically, but there's no downside to closing the
asymmetry either way.

### Fixed: every Betano WNBA fixture was silently dropped from reconciliation

Confirmed 22 Jul 2026: `matched: 0, betanoOnly: 0` despite Betano successfully
parsing 9 real fixtures — all 9 were silently discarded because their team
names couldn't be resolved against the seeded crosswalk. Root cause was in
`normaliseName()` (`src/lib/normalise.ts`), used everywhere names are
compared: Betano tags every WNBA team with a gender qualifier —
`"Golden State Valkyries (W)"` — and the normaliser stripped the parentheses
*characters* but left the letter behind as a stray trailing word
(`"...valkyries w"`), which never exact-matched the plain seeded name
(`"...valkyries"`). Not an error — just a silently uncounted fixture, with
only a `WARN` log easy to miss among session-diagnostic noise.

Fixed by stripping the whole gender-qualifier parenthetical
(`(W)`/`(M)`/`(Women)`/`(Men)`, case-insensitive), not just its punctuation.
Verified this doesn't over-strip: multi-letter esports/streamer handles like
`"(TAAPZ)"` are untouched (different pattern — arbitrary handle, not a
gender qualifier), and ordinary player names are unaffected. 11 new tests
cover the real team names, the esports-handle non-regression, and the
player-name non-regression.

### Fixed: player-props fetch used a broken placeholder, misreported as session expiry

Confirmed 22 Jul 2026, the run right after fixture reconciliation was fully
working for the first time (`matched: 7, betanoOnly: 0, sofaOnly: 3`):
`fetchBetanoPlayerProps` built its URL via
`cfg.playerPropsUrlTemplate.replace('{eventId}', eventExternalId)` — but the
config's actual placeholder is `{eventPath}`, which doesn't appear in that
call at all. `.replace()` matched nothing, and the literal placeholder text
(`https://www.betano.ng/api{eventPath}?bt=1&...`) passed straight through
into a real request. The resulting 404 was then misreported as an expired
session — actively misleading, since the session was fine.

It was also the wrong *kind* of value regardless: Betano's match-odds URL
needs the full path with slug (`/match-odds/team-a-team-b/12345/`), not a
bare numeric ID — the slug can't be reliably reconstructed from team names
alone. That real path was already being captured into
`FixtureSourceLink.rawPayload` at reconciliation time (no schema change
needed); `harvestBoard` now reads it from there and passes it to
`fetchBetanoPlayerProps`, which uses the already-tested `buildPlayersUrl()`
instead of the broken template.

Also fixed: the error handler no longer assumes any in-page-fetch failure
means "session expired" — only a matching 403 does. A 404 or other status
now surfaces honestly rather than being misattributed. Verified with 3 new
tests using the real captured event path
(`/match-odds/washington-mystics-w-connecticut-sun-w/89034718/`), confirming
no unsubstituted placeholder ever reaches the server and the real slug/ID
arrive intact.

### Player-props parsing now fully works end-to-end (770 real props across 7 real games)

Confirmed 22 Jul 2026: the fixture-path fix above worked completely against
all 7 real fixtures — 55 to 163 real prop lines parsed per game via their
real event paths and slugs. That's the last real barrier to real data flowing
through the pipeline.

Two follow-on issues found and fixed from that same run:

1. **SofaScore had the identical session-expiry misattribution bug fixed for
   Betano last round** — a 404 on `/event/{id}/lineups` (most plausibly:
   lineups genuinely not yet published for a game several days out — not a
   session problem) was being reported as `SofaScoreSessionExpiredError`.
   Fixed with the same targeted change: only a matching 403 from the
   in-page tier means session expiry now; anything else surfaces honestly.
2. **`harvestBoard` never passed Betano's `playerExternalId`** — the exact
   crosswalk key specifically built into `BetanoPropLine` earlier this
   session (spec §6.5 tier 1) — into `resolvePlayer`, meaning the
   fast/guaranteed IDENTITY resolution tier was unreachable for every single
   Betano prop, permanently. Fixed to pass it through. (This alone won't
   resolve names on a completely fresh crosswalk — IDENTITY requires a
   pre-existing link — but every subsequent run now benefits from it once a
   name-based tier makes the first successful match.)

### Open: 100% player-name resolution failure (770/770 unresolved)

Every single prop line across all 7 real fixtures failed name-based
resolution on this run (`written: 0` for every fixture) — not partial,
total. `fetchPlayerIndex`'s `fullName` construction
(`` `${firstName} ${lastName}` ``) matches Betano's natural name order, so
the classic "Last, First" mismatch isn't the cause. Rather than guess
further, `harvestBoard` now logs real failed names alongside a real sample
of the seeded `Player` table whenever a fixture resolves zero props, so the
actual mismatch pattern (case, punctuation, accents, suffix handling, or
something else entirely) is visible on the very next run instead of guessed
at.

### RESOLVED: root cause of every empty/wrong Betano fixture this entire session

Confirmed 22 Jul 2026, end-to-end against a real captured payload. Two
compounding issues, now both fixed:

1. **Wrong league code.** `fixturesUrl` used `sl=441g` — which is **NBA**,
   not WNBA. `sl=440g` is WNBA. Both are basketball, both `regionId 11326`
   (USA), trivially easy to conflate, and this is exactly why "Division
   Winner - Atlantic/Central/Southeast" (real NBA divisions) ever appeared —
   not a parsing bug, just the wrong league's page entirely.
2. **A different, previously unhandled shape.** The corrected endpoint,
   `/api/sport/basketball/usa/wnba/440g/?req=la,s,stnf,c,mb`, returns
   `data.blocks[]` — each block's `events[]` are real per-game objects with
   **no `participants` array** (unlike the danae-webapi match-odds shape
   validated earlier). Team names live only in `name`/`shortName` as a
   dash-separated pair (`"Washington Mystics (W) - Connecticut Sun (W)"`),
   and `startTime` is a direct numeric epoch-ms field. The existing generic
   heuristic walker in `parseBetanoFixtures` already handles this correctly
   — no parser changes were needed once the market false-positive guard
   (previous fix) was in place and the URL was corrected.

Verified by running the actual real captured file through
`parseBetanoFixtures` directly: all 7 real WNBA games extracted correctly,
real team names, correct near-term dates, zero false positives. One of those
dates (`2026-07-28T23:30:00Z`) matched SofaScore's independently-reported
earliest event to the second — strong cross-source confirmation the data is
right. Locked in with a permanent regression test
(`betanoRealWnbaBlockShape.test.ts`) built from real field values, covering
multi-block extraction, name-splitting, direct epoch-ms parsing, and
non-contamination from nested market/selection objects.

`fixturesUrl` now points at this confirmed-working endpoint directly, rather
than the old `/competitions/usa/11326/?sl=...` URL with just the league code
patched — that URL was never directly verified to return the same shape.

### Fixed: standalone scripts (bootstrap, analyse) never populated the tournament ID

Confirmed 22 Jul 2026: `reconcileFixtures` read the tournament ID from
`LeagueConfig.sofaTournamentId` in the database, which was only ever written
by the **server's** boot sequence (`index.ts`). Running `npm run analyse` or
`npm run bootstrap` directly — without the server ever having started —
left that field `null`, silently skipping SofaScore reconciliation entirely
(`no sofaTournamentId cached for league`), with no indication that a whole
data source had gone missing.

Now that tournament ID is static config (`WNBA_SOFASCORE_TOURNAMENT_ID`,
per the earlier fix), this DB round-trip serves no purpose — `reconciler.ts`
reads `getStaticSofaTournamentId()` directly, the same as it already did for
the season ID. The `/meta/leagues` endpoint, which also read this DB column,
now reports the live static value instead, so it can't show stale or null
data after a restart either. The DB column itself is left in the schema but
nothing reads or writes it anymore — confirmed via grep across all three
call sites.

### Fixed: an unset season ID silently became 0, not "missing"

Confirmed 22 Jul 2026: `WNBA_SOFASCORE_SEASON_ID=` (present in `.env` with
nothing after the `=`) is an empty string in `process.env` — and
`z.coerce.number()` turns `Number('')` into `0`, not `undefined`. That `0`
then passed every `== null` check meant to catch "not configured," producing
a real request to `.../season/0/events/next/0` (which naturally 404s) while
every validation layer believed the config was present and correct.

Fixed at the root — empty strings are now converted to `undefined` before
number coercion (`optionalId` in `env.ts`) — and hardened at every downstream
check as defense-in-depth (`getStaticSofaSeasonId`, `getStaticSofaTournamentId`,
`assertSofaScoreConfigFresh` all now also reject `0` explicitly, since it's
never a real SofaScore ID). Reproduced the user's exact scenario end to end
to confirm the fix, and added a permanent regression test.

### Fixed: SofaScore never got the real-browser tier that fixed the identical symptom for Betano

Confirmed 22 Jul 2026: the exact same session cookie and exact same URL
succeeded in Postman but 403'd from this app — the identical symptom that,
for Betano, turned out to be a TLS-fingerprint mismatch (Node's undici
doesn't present a real browser's handshake even with byte-identical headers),
not an expired or wrong cookie. The Betano fix (`pageFetchJson` — a real
Chromium page, session cookies injected via the browser's own cookie jar,
request run as `fetch()` from inside the page) had never been wired into
`sofaGet`; only Betano had it. It now escalates the same way: direct tier →
403 with a session configured → real in-page fetch → only then
`SofaScoreSessionExpiredError`.

Verified the escalation logic itself (not re-verifying `pageFetchJson`,
already proven separately): a mocked 403 correctly triggers a call to
`pageFetchJson` with the exact configured session cookie, the exact
configured User-Agent, and `www.sofascore.com` as the domain; its result is
used on success; and a real error still surfaces if both tiers fail.

### SofaScore tournament + season IDs are static config, not resolved live

Changed 22 Jul 2026: `/config/unique-tournaments/en/basketball` (tournament
catalogue) and `/unique-tournament/{id}/seasons` (season list) were both
scaffolding calls made before the confirmed-working flow was found — neither
was ever on the tested-and-working endpoint list, and both 403 under the
exact same session that succeeds on every endpoint that was actually tested.
Both IDs are static config now, for a **loud, hard failure** instead:

```
WNBA_SOFASCORE_TOURNAMENT_ID=486    # confirmed 22 Jul 2026
NBA_SOFASCORE_TOURNAMENT_ID=
NBA_SOFASCORE_SEASON_ID=
NBA_SOFASCORE_SEASON_EXPIRES=      # ISO date, e.g. 2027-02-01
WNBA_SOFASCORE_SEASON_ID=
WNBA_SOFASCORE_SEASON_EXPIRES=
```

`assertSofaScoreConfigFresh()` in `src/env.ts` is called at the top of the
server (`index.ts`), `bootstrap`, and `analyse` — anywhere the real pipeline
runs. If a season ID is missing, an expiry date is missing/invalid, or the
expiry date has passed, **the process exits immediately** with the exact
problem and the command to fix it. Verified all three cases (missing,
expired, valid) actually behave this way, not just typecheck.

When it fires, get a fresh ID and a suggested new expiry date:

```bash
npm run sofascore:resolve-season -- --league WNBA
```

This script is deliberately **exempt** from the same check — it's the tool
you run precisely when the check has failed, so it can't refuse to run for
the reason it exists. `npm run test:session` also doesn't crash on stale
season config; it reports the problem as a diagnostic result instead, since
enforcing the check isn't its job.

### Fixed: reconciliation was still calling the 403-prone scheduled-events endpoint

Confirmed 22 Jul 2026: `reconciler.ts` — the real production fixture-discovery
path, not just a test script — was calling `/sport/basketball/scheduled-events/
{date}`, which 403s even with a valid session (an application-level rejection,
confirmed by the same cookie working seconds apart on other calls). Replaced
with `fetchSofaUpcomingEvents()` against `/unique-tournament/{id}/season/{id}/
events/next/0`, the endpoint confirmed working. The season ID is resolved live
on every reconciliation run (`resolveCurrentSeasonId`), not cached on
`LeagueConfig` — it rolls over yearly and a stale cached value would silently
return last season's completed schedule. `test-session.ts` now checks this
same path, so its health check actually reflects what production calls.

`fetchSofaScheduledEvents` remains in `sofascore.ts` only because
`withCacheBypass` is unit-tested against a URL of that shape — nothing calls
it anymore.

### SofaScore per-player stat fetching is paced

Added 22 Jul 2026, per request: `fetchSofaPlayerStatsForSquad()` pauses
2-5 seconds (randomised) after every 3-5 calls (also randomised) to avoid a
scripted-looking burst — SofaScore is undocumented and its rate-limit
behaviour is unknown, so this is precautionary rather than a response to an
observed block. One player's fetch failing (404 for "didn't dress", or any
other error) is logged and skipped; it does not abort the rest of the squad.

### SofaScore: squad list via top-players union (no lineups endpoint found)

Added 22 Jul 2026. No working lineups/roster endpoint was found for SofaScore,
so `fetchSofaTopPlayersSquad()` in `src/adapters/sofascore.ts` builds a squad
by unioning the 12 categories in `/team/{id}/unique-tournament/{t}/season/{s}/
top-players/regularSeason` that carry the **full roster** — `points`,
`rebounds`, `assists`, `secondsPlayed`, `steals`, `blocks`, `turnovers`,
`plusMinus`, `defensiveRebounds`, `offensiveRebounds`, `rating`,
`assistTurnoverRatio`. The percentage-based categories
(`fieldGoalsPercentage`, `freeThrowsPercentage`, `threePointsPercentage`,
`doubleDoubles`) are genuinely partial/qualified lists and are deliberately
**not** used — a player only appearing there and nowhere else is excluded on
purpose (tested).

**Two accepted gaps**, not fixed by this approach and not intended to be:
- A player with too few games this season to appear in *any* category (a very
  recent call-up or trade) is invisible here, not just unflagged.
- No "active tonight" signal — that remains the availability gate's job.

Both are season-aggregate limitations, not bugs; "ignore anyone missed" was
the deliberate call given no lineups endpoint exists.

**Tournament and season IDs are both resolved at runtime, never hardcoded:**
`resolveTournamentIds()` (pre-existing) reads NBA/WNBA IDs from the
tournament catalogue; `resolveCurrentSeasonId()` (added) reads the current
season from `/unique-tournament/{id}/seasons` — the first entry, confirmed to
be the most recent. A season ID rolls over every year, and a stale hardcoded
value doesn't fail loudly — it silently keeps returning last season's
completed data, indistinguishable from a healthy response.

### League stats hangs or AggregateErrors (stats.nba.com / stats.wnba.com)

Revised 22 Jul 2026, after a Chromium browser-tier fallback was tried and
dropped as unproven and fragile. `src/adapters/leagueStats.ts` is now
**direct-only**: it forces IPv4 (undici otherwise races IPv4/IPv6 — "Happy
Eyeballs" — and a flaky IPv6 path, common on WSL2's virtual adapter, can throw
an `AggregateError` even though plain IPv4 works fine) and sends a fuller,
realistic Chrome-shaped header set (`Sec-Fetch-*`, `Sec-Ch-Ua`,
`Accept-Encoding`) rather than just the two documented custom headers.

If you still see a failure after this:
- **`AggregateError`** — every resolved address failed to connect. Forcing
  IPv4 should rule out the common dual-stack cause; if it persists, test
  reachability directly: `curl -v https://stats.wnba.com/stats/playerindex?LeagueID=10&Season=2026`
- **A clean hang** (connects, then genuinely nothing comes back, no error) —
  this is the stronger signal of Akamai bot-fingerprinting. The next step is
  the same HAR-capture approach already proven out for Betano: load
  `stats.wnba.com/stats/players` in your own browser, export a HAR, and adapt
  the parser from there.

### CONFIRMED: the Players-tab endpoint (21 Jul 2026)

```
/api/match-odds/{slug}/{eventId}/?bt=1&isPlayersToggle=true&req=la,s,stnf,c,mb,mbl
```

Already filled into `src/config/betano.json`. Three things about the response matter:

**Betano prices milestones, not Over/Under.** Selections read `12+`, `13+`, `14+` — "12 or more" — and there is no Under side or Under price. Since points, assists, rebounds and threes are integers, a milestone is exactly a half-point Over:

```
"12+"  <=>  value >= 12  <=>  value > 11.5  <=>  Over 11.5
```

Lines are therefore stored as `n - 0.5`. The conversion is lossless, leaves every downstream calculation untouched, and eliminates pushes entirely — a half-point line cannot be pushed. The original label is kept for display, because `12+` is what you actually click on the site.

**Markets carry `playerId` and `teamId` directly**, and the payload includes both full rosters (`playersTabFilters.roster`) as id → name maps. Betano's player id is an exact crosswalk key, so entity resolution never needs to fall to fuzzy matching for this source. The roster also states home/away explicitly — the participants array does not.

**Confirmed market type codes** (codes are stable, display names are localised):

| Code | typeId | Courtside market |
|---|---|---|
| `PLNP` | 1856 | POINTS |
| `PALA` | 1853 | ASSISTS |
| `PLTR` | 1858 | REBOUNDS |
| `P3PG` | 1852 | THREES |

Also priced and recorded but not modelled: `BPRA` (P+R+A), `BBRA` (R+A), `X035` (double-double), `X043`/`X046`/`X238` (top scorer/rebounder/threes), and `4748`/`4930`/`4935` (player-vs-player H2H).

### Run it from a Nigerian residential connection

Verified 19 July 2026: requesting `betano.ng` from a **datacenter IP** returns a 2 KB *"Betano Splash Screen"* — an iframe to `landingpages.kaizengaming.com` plus a Cloudflare challenge script. Not the sportsbook. No fixtures, no markets, nothing to discover.

This confirms two things. Betano.ng runs on **Kaizen Gaming's** platform, and access is IP-gated. Practically: discovery and ongoing collection must run from a Nigerian residential connection. If you later deploy this to AWS or DigitalOcean, you will get the splash screen instead of the board, and the honest fix is a residential proxy — not more retries.

Navigate basketball → a fixture → the Players tab, press Enter, and read `betano-discovery.json`. If you cannot find a JSON response containing player prop markets, **stop and rethink the data source** before building anything on top of it. Everything else in this repo works; this is the one open question.

---

## Setup

```bash
npm install
cp .env.example .env          # then set API_KEY to a long random string
npx prisma migrate dev        # creates courtside.db
npm run db:seed               # 2 leagues, 45 teams, 198 aliases, FIBA break
npm run bootstrap -- --league WNBA   # seeds the player crosswalk from the league feed
npm run dev                   # http://localhost:4000/api/v1/health
```

Verify the whole analytical chain without touching any external source:

```bash
npm run demo
```

That seeds a synthetic fixture with four players — one consistent, one volatile, one ruled out, one who sat the last game — and runs the full pipeline. Expect two recommendations and three exclusions, each with a reason.

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | API + scheduler, watch mode |
| `npm run build && npm start` | Production build and run |
| `npm run worker` | Scheduler only, separate process |
| `npm run analyse -- --league WNBA` | One analysis run, prints a summary |
| `npm run analyse -- --league WNBA --skip-scrape` | Re-score cached data — use when tuning weights |
| `npm run settle -- --date 2026-07-18` | Grade completed fixtures, print strike rate by tier |
| `npm run bootstrap -- --league WNBA` | Seed/refresh the player crosswalk |
| `npm run discover:betano` | Betano endpoint discovery (headed browser) |
| `npm run discover:har -- --file x.har` | Same discovery, from a browser HAR export |
| `npm run discover:har -- --file x.har --inspect <url-substring>` | Print a payload's STRUCTURE (keys/types/array lengths) so you can write the parser without pasting the body |
| `npm run discover:har -- --file x.har --census` | Join the Kaizen events/markets/selections store and print a compact basketball market-type census — the paste-safe summary that identifies the player-prop type codes |
| `npm run demo` | End-to-end pipeline test on synthetic data |
| `npm test` | 25 unit tests over the analytical core |
| `npm run typecheck` | `tsc --noEmit` across src + prisma |
| `npm run db:studio` | Prisma Studio |

---

## Architecture

```
src/
  adapters/          one module per external source, all wrapped in withScrapeLog
    betano/          two-tier: direct GET → Playwright context; heuristic shape parsing
    leagueStats.ts   PRIMARY stats source; serialised queue, column-oriented responses
    sofascore.ts     fixtures + lineups; 403 → browser fallback
    espn.ts          corroboration + the practical WNBA injury source
  services/
    entityResolver   6-tier crosswalk: IDENTITY→ALIAS→EXACT→STRUCTURAL→FUZZY→review
    reconciler       Betano vs SofaScore fixture diff, back-to-back detection
    availability     the deny-first gate (§4.3)
    form             weighted means, CV, hit-rate curves, push handling
    lineSelector     ladder selection + the suppression rule (§4.5)
    scorer           5 weighted factors → multipliers → data-sufficiency cap
    pipeline         the 7-stage run
    settlement       box score → WIN/LOSS/PUSH/VOID
    backtest         strike rate, break-even, Brier, calibration
  routes/            every endpoint in spec §9, envelope { data, meta }
  jobs/scheduler     5-min tick: T−24h, T−12h, T−6h, T−3h, T−90m, T−30m, T+4h
```

### The pipeline

1. **Reconcile fixtures** — Betano board vs SofaScore schedule, matched on team pair + start time within 90 minutes
2. **Harvest the board** — Betano Players tab defines the universe of bettable players
3. **Refresh stats and injuries** — league game logs, ESPN injuries, SofaScore lineup absences
4. **Availability gate** — deny-first; fails on OUT/DOUBTFUL/QUESTIONABLE, DNP last game, <8 min last game, >14 day layoff, >4 DNPs in 15
5. **Form analysis** — weighted mean, σ, CV, hit-rate curve at every rung of the ladder
6. **Line selection and scoring** — 4-of-5 rule, mode-based rung choice, confidence
7. **Persist and publish** — Recommendation + every factor, or PlayerExclusion with a reason

Every player entering stage 4 leaves as either a recommendation or an exclusion. Nobody silently disappears — that is what makes "where is player X?" answerable.

### Failure policy

Betano unreachable → run status `FAILED`, because there is no board and therefore nothing to recommend. Any other source failing → `DEGRADED`, with the errors recorded on the run. A non-empty board that produces zero recommendations *and* zero exclusions logs an alarm: that combination means the pipeline is broken, not that there is no value on the board.

---

## Configuration

`src/config/scoring.json` holds every weight, multiplier and threshold. `PATCH /config/scoring` bumps the version automatically — never edit a released version in place, because the backtest depends on version stamping to reconstruct historical scores.

Key knobs in `.env`:

| Variable | Default | Notes |
|---|---|---|
| `HIT_RATE_THRESHOLD` | `4` | Of 5. Set to 3 for a looser board |
| `SELECTION_MODE` | `BALANCED` | Highest rung with ≥0.5σ cushion |
| `RECENCY_LAMBDA` | `0.85` | 1.0 = plain average |
| `EXCLUDE_QUESTIONABLE` | `true` | The WNBA has no formal injury report — keep this on |
| `CONFIDENCE_FLOOR` | `55` | Below this, nothing is emitted |
| `COMPUTE_UNDER_SIDE` | `true` | Engine computes both; UI shows OVER by default |

---

## SQLite → PostgreSQL

```bash
# 1. change provider in prisma/schema.prisma to "postgresql"
# 2. set DATABASE_URL to the Postgres connection string
npx prisma migrate deploy
npx tsx src/scripts/migrate-to-postgres.ts --from ./courtside.db
```

The schema avoids enums, `Json` columns and scalar lists precisely so this stays a one-command move.

---

## Things worth knowing

**The confidence score is not a win probability.** It is a relative ranking of how well a bet satisfies this model's criteria. It only acquires meaning once `GET /backtest/calibration` has enough settled bets to show whether 75-confidence picks actually land 75% of the time. Below n=50 per tier, the ROI figure is deliberately withheld.

**The Wilson lower bound is pessimistic on purpose.** A 4-of-5 hit rate reads as 0.80 raw and ≈0.52 after Wilson at z=1.2816. That gap is the honest statement of what five games can tell you.

**Strike rate is not profit.** As specified, the model optimises for how often a line is cleared — but a 60% strike rate loses money at 1.55 odds. Spec §15.2 describes the fix, and every input is already in `PropLine`: de-vig both sides (`fairProb = impliedProb / (1 + margin)`), compare the model's probability to the book's, rank by edge rather than confidence. Roughly a day's work, and it changes the question from *"which players are consistent?"* to *"which prices are wrong?"*

**Entity resolution gets monotonically better.** Every review-queue resolution writes a `PlayerAlias`, so the same name never reaches the queue twice. Seed team aliases exhaustively by hand — there are only 45 teams, and it eliminates an entire class of bug permanently.

**One surprise from the test suite worth remembering:** a single-letter first-name variant ("Caitlyn" vs "Caitlin") scores ≈0.83 on Dice similarity — *below* the 0.85 fuzzy threshold. That is why the structural tier (last name + first initial, constrained to the roster) runs before fuzzy matching. Anything reaching the fuzzy tier below threshold goes to human review rather than being guessed at.

---

## Legal

Read Betano.ng's terms of service before running automated collection. Collection is read-only and unauthenticated: never log in, never touch account endpoints, never place a bet. SofaScore state that they do not supply data to bookmakers and that their site should not be used to verify bets — treat those numbers as indicative, not settlement-grade. Gambling is regulated in Nigeria by the NLRC; this is an analysis tool, not advice.
