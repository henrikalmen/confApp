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

## PostgreSQL Date/Time via node-postgres

- **`timestamptz` loses microseconds through node-postgres** – oid 1184 parses to a JS `Date` (ms only). Format in SQL instead; see `instantExpression` in `api/src/sessions/wall-clock-time.ts`.
- **pg `date` (oid 1082) parses to *local* midnight** – shifts the day east of UTC; `time` (1083) is a string today. Pin type parsers for both in `api/src/db.ts`.
- **`now()` is transaction-start time, not statement time** – two writes in one tx get identical stamps. Use `clock_timestamp()` + `GREATEST(…, OLD.col + interval '1 microsecond')`.
- **A timezone guarantee needs a real process, not a mock** – Node reads `TZ` once at start-up; spawn `api/test/wall-clock-probe.ts` per TZ and assert the raw response body.

## CSS / Responsive Layout

- **`auto-fit` is wrong for "sidebar + main that stacks"** – it keeps filling the row with tracks, crushing content at wide widths. Use `flex-wrap` with a flex-basis on the main pane instead.
- **`flex-shrink: 0` + a rem `min-width` overflows under OS font scaling** – fine at 16px root, off-screen at 24px on a 375px phone; Capacitor inherits the OS scale. Use `min-width: min(Xrem, 100%)`.

## Testing

- **Counting queries at the repository seam cannot catch an N+1** – a one-statement repo call says nothing about a handler looping per day; count across a whole request via a recording Database.
- **A regression test written beside its fix usually passes without the fix** – revert the fix and re-run before believing the guard; six S09 tests were green against the very defect they named.
- **A file-list grep is only as good as its longest omission** – S09's "no timezone conversion in the refresh path" guard listed four files and missed `schedule-view-model.ts`, which formats every Session time an Attendee reads. A `toLocaleTimeString` there passed it. Pair any file-list assertion with one behavioural assertion that does not know the list.
- **Never wait on the value you are about to assert** – a `waitFor` on the expected output fails inside the helper when the defect is present, so the reading is never captured and the comparison that was the point of the test never runs. Wait on something the defect cannot touch.
- **Assert cache contents, not the requests issued** – S10's guard dispatched exactly the right navigation and then asserted only that a fetch happened; it was green while the cache key was wrong.
- **A structure test that skips when its marker is missing tests nothing** – S09's read-order guard silently no-opped on one of the two routes it named for a whole pass, because the second read lived in a different function than the slice it searched. Assert the marker is found; never `if (found > -1)`.

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
