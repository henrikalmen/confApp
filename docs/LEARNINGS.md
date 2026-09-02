# Project Learnings

<!-- Traps only, one bullet each: `- **{title}** – …` under 200 chars, trap + pointer; postmortem
     depth lives in the spec archive or an ADR. Bar: "Would a competent developer with code and
     git access still get bitten?" Skills read this index whole – keep it lean; shards load per
     touched topic, and a repeat-check touches its topic. Maintain via the
     `andthen:ops` skill (`update-learnings` forms), which owns the 150-line ceiling and
     `learnings/` shard graduation. Delete entries once encoded as checks or stale. -->

## [Topic Area 1]
<!-- e.g. "Language Traps", "Framework Patterns", "API Quirks", "Deployment", etc. -->

- _No learnings recorded yet._

## Google OIDC / Auth

- **Google's token endpoint needs `client_secret` even with PKCE** – Web-app clients get no PKCE exception, so browser-only code exchange is impossible; broker it via `POST /api/auth/token`.
- **Validate `aud` against an allow-list, never one client ID** – Google issues one per platform, so a single-value check refuses every mobile sign-in, failing in S11 not where it was written.

## JWKS / Key Rotation

- **jose `createRemoteJWKSet` 30s cooldown blocks rotation refetch** – `set.reload()` on an unknown `kid`, rate-limited by your own interval; test N unknown kids cause under 3 fetches.

## Browser Testing / jsdom

- **jsdom 30 has `crypto.subtle` but no Web Storage** – `localStorage`/`sessionStorage` are `undefined`; polyfill a minimal `Storage` in `web/test/setup.ts`, don't design it out.
- **StrictMode double-mount races a one-shot OIDC redirect handler** – guard with a `useRef`; make the liveness flag a ref too, as cleanup clears a `let active` before the first call resolves.
- **No jest-dom in the web workspace** – `.toBeDisabled()`/`.toBeInTheDocument()` throw "not a function"; assert plain DOM props (`.disabled`, `.value`, `queryByTestId() === null`).
- **A `waitFor` on synchronously-set state resolves too early** – an `online` event dispatched on it hits a window where the poll listener is down. Wait on content only the settled phase renders.
- **`findBy*` resolves before `useEffect` bodies have run, and wrapping the dispatch in `act` does not fix it** – `findBy*` returns on the microtask that follows the commit, while passive effects flush on a later task, so an event dispatched right after it can reach a listener that is not registered yet; `act` runs its callback *before* it flushes anything, so the house `await act(async () => { dispatch })` pattern has the same hole. Put an empty `await act(async () => {})` in front to flush the commit that already happened. Measured on a 250-iteration replica of `OrganizerLiveEditing` -> "refetches when the watermark moves": bare and `act`-wrapped dispatch each failed 1 in 250 with **zero** focus listeners registered and no request ever issued; with the flush, 250 of 250 registered, in ~60 ms.

## PostgreSQL Date/Time via node-postgres

- **`timestamptz` loses microseconds through node-postgres** – oid 1184 parses to a JS `Date` (ms only). Format in SQL instead; see `instantExpression` in `api/src/sessions/wall-clock-time.ts`.
- **pg `date` (oid 1082) parses to *local* midnight** – shifts the day east of UTC; `time` (1083) is a string today. Pin type parsers for both in `api/src/db.ts`.
- **`now()` is transaction-start time, not statement time** – two writes in one tx get identical stamps. Use `clock_timestamp()` + `GREATEST(…, OLD.col + interval '1 microsecond')`.
- **A timezone guarantee needs a real process, not a mock** – Node reads `TZ` once at start-up; spawn `api/test/wall-clock-probe.ts` per TZ and assert the raw response body.

## CSS / Responsive Layout

- **`auto-fit` is wrong for "sidebar + main that stacks"** – it keeps filling the row with tracks, crushing content at wide widths. Use `flex-wrap` with a flex-basis on the main pane instead.
- **`flex-shrink: 0` + a rem `min-width` overflows under OS font scaling** – fine at 16px root, off-screen at 24px on a 375px phone; Capacitor inherits the OS scale. Use `min-width: min(Xrem, 100%)`.
- **A hyphenated token is not an unbroken token** – hyphens break even at `overflow-wrap: normal`, so a `long-fixture-like-this` proves nothing. Use a camelCase or digit run.
- **Page-level `scrollWidth - clientWidth` misses text overflowing its own box** – an ancestor absorbs the scroll. Compare the element's own `scrollWidth` with its `clientWidth`.
- **`body` declares `overflow-wrap: break-word` and it inherits** – restating it on a new text block changes nothing while reading as load-bearing. Prove a wrap rule is needed before adding one.

## Testing

- **Counting queries at the repository seam cannot catch an N+1** – a one-statement repo call says nothing about a handler looping per day; count across a whole request via a recording Database.
- **A regression test written beside its fix usually passes without the fix** – revert the fix and re-run before believing the guard; six S09 tests were green against the very defect they named.
- **A file-list grep is only as good as its longest omission** – S09's "no timezone conversion in the refresh path" guard listed four files and missed `schedule-view-model.ts`, which formats every Session time an Attendee reads. A `toLocaleTimeString` there passed it. Pair any file-list assertion with one behavioural assertion that does not know the list.
- **Never wait on the value you are about to assert** – a `waitFor` on the expected output fails inside the helper when the defect is present, so the reading is never captured and the comparison that was the point of the test never runs. Wait on something the defect cannot touch.
- **Assert cache contents, not the requests issued** – S10's guard dispatched exactly the right navigation and then asserted only that a fetch happened; it was green while the cache key was wrong.
- **A structure test that skips when its marker is missing tests nothing** – S09's read-order guard silently no-opped on one of the two routes it named for a whole pass, because the second read lived in a different function than the slice it searched. Assert the marker is found; never `if (found > -1)`.
- **Piping Playwright through `tail` masks the exit code and eats the `N failed` line** – a failing run reads as exit 0 and looks interrupted. Redirect to a file, or read `${PIPESTATUS[0]}`.
- **Moving a test beside the code it covers can silently delete integration coverage** – S02's renewal tests kept their assertions at the new seam; nothing asserted it was still called.
- **Seeding the offline cache without claiming ownership purges it** – `adoptCacheOwner` fails closed, so an entry written before launch is deleted and every later "cache is empty" assertion passes vacuously. Adopt, write, then assert it is present.
- **`page.goto` resolves long before the app's IndexedDB claim lands** – `adoptCacheOwner` is fired and not awaited, so seeding storage right after a navigation loses the entry to the purge that precedes the owner write. Wait for the owner marker; see `waitForCacheClaimed`.
- **A harness fix made in one spec is not a fix** – `offline-session-expiry.spec.ts` diagnosed the claim race and fixed it locally on 2026-08-25; the same pattern in `offline-schedule.spec.ts` went unfixed and started failing when launch timing shifted. Grep for the pattern, not just the failing file.
- **A new required field on a persisted type breaks fixtures with no compile error** – `web/test/` is outside `tsconfig`'s `include`, so a stale `StoredSession` literal fails as a 15s timeout instead. Grep every fixture when adding one.
- **Counting requests, not responses, makes a keep-on-failure guard vacuous** – a fetch mock recording on entry lets `waitFor(reads === 2)` resolve before the response is handled. Record on build.
- **A file-wide grep for an argument matches any function that has one** – S01's `{ sessionId }` guard survived the write path losing it; another function had one. Inspect the call, not the file.
- **A structure guard sees only what its parser matches** – S03's column regex assumed two-space indent, so a four-space `ballot_no` cleared all 21 vote-anonymity assertions. Anchor on `^\s*`.
- **A SQL-scanning guard must read all three quote styles** – Prettier's `singleQuote` leaves strings containing `'open'` in double quotes, so a per-author count hid there and passed S05's guard.
- **An unfiltered `pg_locks` wait proves nothing** – and a `relation` filter hangs forever: a blocked `FOR UPDATE` waits on a `transactionid` lock whose relation is null. Wait on its `tuple` lock.
- **A revert that silently matches nothing is a false green in the one step whose job is doubt.** A `perl -pe` strip matched nothing; the suite passed and read as proof. Check the guard count fell.
- **A guard on a decision's tabulated approximation passes while its stated rule breaks** – S07's tier table was green as a skewed Board pushed 39 Post-its off-tile. Test the rule, not the table.
- **A jsdom "geometry" fixture measures nothing, and a sized one under the cliff proves nothing** – S01's 20-per-region capture had no boxes; the sized run stopped at 11, the overflow cliff was ~13.
- **`vi.waitFor` is not Testing Library's `waitFor`, and `configure({ asyncUtilTimeout })` does not reach it** – `web/test/setup.ts` raises RTL's budget to 15 s precisely so a wait can outlast a skipped tick of the 5 s poll, but `vi.waitFor` keeps its own 1 s default and expires four seconds short. Any wait that might have to survive a missed tick has to be RTL's; a wait that must *not* be rescued by the shipped interval has to stay under it, deliberately, and say so.

## React State & Refusals

- **A refusal rendered only inside a component its own handler unmounts is lost** – three consecutive S09 fixes hit this: lifting an archived Conference unmounts the edit form (the only place `saveError` showed), and a recovery re-read that fails swaps the panel for an error box (taking the open editor with it). Before handling a refusal by changing what renders, ask what the refusal was being displayed *inside*. Render it outside that subtree, or keep the subtree.
- **A recovery re-read must not be able to fail the component** – an extra request made after a refusal is not the component's own load. Give it a `keepOnFailure` path so a network blip leaves the refusal and the typed values on screen instead of replacing them with a generic error.

## Concurrency

- **Optimistic concurrency belongs in the UPDATE predicate** – a version compared in an earlier round trip lets two saves both pass and both write; put the version check in the write statement.
- **Deleting and editing one Session deadlock** – delete locks conference then session row, edit locks session row then conference via the watermark trigger. Retry SQLSTATE 40P01 once.
- **`now()` moves a row version backwards under lock contention** – it is transaction-*start* time, captured before the statement waits for a row lock, so a waiter stamps a value from before the write it waited on. Use `GREATEST(clock_timestamp(), col + interval '1 microsecond')` on every writer of a version column, not just the guarded one.
- **A monotonicity test needs a held row lock, not concurrency** – sequential writes cannot distinguish `now()` from `clock_timestamp()`, and concurrent writes under a version predicate let only one through, which proves no ordering. Take the lock in a second connection, start the write, commit a later value, then release.

## Service Workers / Cache Storage

- **A navigate-mode cache branch caches the query string** – the OIDC `?code=…` lands in Cache Storage, outside IndexedDB purges and `activate`'s name-keyed cleanup.
- **Re-keying does not shed a URL** – a `Response` keeps its own `url`, so `caches.match(key).url` still holds `?code=…`. Rebuild it: `new Response(body)` has an empty url. See `storeShell` in `web/public/sw.js`.
- **`request.mode === 'navigate'` does not mean the response is HTML** – `try_files $uri` serves real files, so a top-level hit on `/config.js` can be filed as the app shell. Check `content-type` before storing.

## Capacitor Mobile Shells

- **`cap sync` copies the SPA bundle and `sw.js` into the native projects** – ESLint/Prettier lint the copies (2088 errors). Ignore `web/android/**` + `web/ios/**` in both configs.
- **Capacitor 8 scaffolds iOS on Windows** – it emits a SwiftPM `Package.swift` instead of `pod install`, so `cap add ios` and asset sync need no macOS; only compiling and signing do.

## Docker / Container Dev Loop

- **`docker compose up -d --force-recreate` never rebuilds the image** – it recreates from the existing image, so a clean tree serves weeks-old code. Use `docker compose build` / `up --build`.
- **Container env is fixed at creation – `compose restart` keeps stale `.env`** – only recreation re-reads it; `GOOGLE_WEB_CLIENT_ID` feeds both `api` and the `web` `config.js` the browser gets.

## Environment / WSL

- **`docker: command not found` on the Windows side does not mean Docker is absent** – the engine lives in the `Ubuntu` distro, not on the Windows PATH and not in `docker-desktop` (which sits Stopped). Reach it with `wsl -d Ubuntu -e bash -lc 'cd /mnt/c/git/confApp && docker compose …'`; the published ports forward to Windows, so `127.0.0.1:8082` works from either side. This has now cost twice: an erroneous S13 execution hold (2026-08-20, corrected 08-21) and a visual suite left unrun (2026-08-29). Probe the distro before recording a Docker blocker.
- **WSL OOM can surface as `Wsl/CallMsi/Install/REGDB_E_CLASSNOTREG`** – it looks like a broken install; freeing host memory fixed it. First sign: the distro shuts down mid-session, taking dockerd.
- **`127.0.0.1:5434` refusing does not mean the database is down** – WSL2's localhost forwarding to Windows breaks periodically while the container is perfectly healthy on the distro's own interface. Get the address with `wsl -d Ubuntu -e bash -lc "hostname -I"` (first entry) and use `TEST_DATABASE_URL="postgres://confapp:local-dev-only@<that-ip>:5434/confapp_test"`. This cost S08 a whole run's integration and visual coverage on 2026-09-01, recorded as "no Docker daemon and no reachable TEST_DATABASE_URL" while both were up. Probe the interface IP before recording a database blocker, exactly as the Docker entry above says to probe the distro.

## Remediation Sequences

- **Two individually-correct remediations can compose into a regression neither review can see** – each falsified alone; together nothing ends a session. Re-run pass 1's proof on the end state.

## Offline

- **`navigator.onLine` reports the link, not reachability** – on captive-portal or dead wifi it never drops, so S04's `online`-triggered queue drain never retried. Drive it off an existing tick.

## Architecture

- **A guard can block an unrelated fix by filename alone** – a shared-tick seam under `web/src/poll/` trips the `\bpoll\b` anonymity sweep of `web/src/offline`. Relocate the code, don't exempt it.
- **Making a leaked value opaque hides its magnitude, not its change event** – the Session-scoped watermark no longer reads as a clock, but every move still means "a Vote arrived".

## Error Patterns
<!-- Log recurring errors. Deterministic errors (bad schema, wrong type) → conclude immediately.
     Infrastructure errors (timeout, rate limit) → log, no conclusion until pattern emerges.
     Conclusions are promoted into the relevant topic section (or its shard). -->

| Error | Type | Conclusion |
|-------|------|------------|
| ...   | Deterministic / Infrastructure | ... |

## Process & Tooling
<!-- Non-code knowledge: deploy steps, test prerequisites, CI quirks, agent workflow patterns. -->

- ...
- **Git Bash mangles `/api` env values into Windows paths** – `API_BASE_URL=/api` becomes `C:/Program Files/Git/api`, so fetches fail as `file:///…`. Set `MSYS_NO_PATHCONV=1` or drop the override.
- **A test helper named `join` shadows `node:path`'s `join`** – surfaces as `app.inject is not a function` far from the cause. Name domain helpers `submit`/`post` in modules importing node:path.
- **A deferred FIS ends with `## Deferred Decisions`, below `## Implementation Observations`** – append later observations inside Observations, not at EOF. S13 is in this state.
- **Disjoint files is not disjoint resources** – two agents with no common file shared one test PostgreSQL; migrations failed the advisory lock and reddened 80+ tests. Check DBs and ports too.
- **A comment claiming behaviour the code does not have is worse than no comment.** A `lock_timeout` note said the route mapped 55P03 to a refusal; unmapped it was a 500. Grep what a comment asserts.
