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
