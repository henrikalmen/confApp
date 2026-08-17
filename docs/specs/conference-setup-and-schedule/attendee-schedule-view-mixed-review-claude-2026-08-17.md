# S06 Attendee Schedule View – Mixed Review (code, gap)

**Date**: 2026-08-17
**Reviewer**: claude (Opus 5)
**Review mode used**: mixed
**Resolved chain**: `code` → `gap`
**Source run**: `exec-spec-S06-20260817T2032`
**Source Trust**: trusted-local
**Implementation root**: `C:/git/confApp`
**Requirements baseline**: `docs/specs/conference-setup-and-schedule/s06-attendee-schedule-view.md` (+ `prd.md#fr4-attendee-schedule-view`, `plan.json#sharedDecisions`)
**Reconciliation Ledger**: none present for this feature directory

**Intent Context**: FIS *Feature Overview and Goal* – the Attendee's first sight of the Schedule; what it says about *when* things happen must be true on every device regardless of that device's clock or timezone. Expected Outcomes OC01–OC04.

---

## Executive Summary

The story is substantially and carefully implemented. The hard parts – the dual-frame `serverNow`, the four-scalar rehydratable clock anchor, integer civil-date arithmetic instead of `Date`, the single overlap implementation reused from S04, and the genuinely separate `/me/conferences` and `/conferences` endpoints – are all correct and are backed by tests that would actually fail if the behaviour were removed. I attacked each of the five properties the request named and four of them hold under falsification.

One real product defect survives: **the `/me/conferences` fetch failure is a dead end with no retry control**, which is exactly the network-outage path FIS Acceptance Scenario S07 and OC03 commissioned. Alongside it, three proof artifacts do not constrain what they claim – the "one query" test never touches the endpoint, the two new pure server modules have no unit test outside a PostgreSQL-gated suite, and no test drives the conference-list request to failure.

## Verdict

| Dimension     | Score | Threshold | Status |
|---------------|-------|-----------|--------|
| Functionality | 6/10  | >= 7      | FAIL |
| Completeness  | 9/10  | >= 9      | PASS |
| Wiring        | 9/10  | >= 8      | PASS |

**Overall: FAIL**

CONVERGED: no (one new `code-defect` at HIGH)
Auto-Remediation: PENDING

**Code-lens readiness**: Needs Fixes (1 HIGH, 3 MEDIUM)

Functionality scored 6 because OC03 names three non-result paths and requires the failed fetch to offer retry; one of the two fetches in this view offers none, and it is the one that fails first when the venue network drops. The fix is mechanical and bounded.

**Findings Filter stats**: 17 findings submitted to an independent Devil's-Advocate pass → 10 validated, 2 downgraded, 3 withdrawn with concrete falsifiers, 1 disputed (kept at LOW with corrected framing). One further finding (G1) came from the guardrails pass after the filter was dispatched and was not filtered. Filter raised no severity.

---

## Guardrails Coverage

`Guardrails Coverage: 15 checked, 1 finding`

Checked against `AGENTS.md#do-not--never` and `docs/guidelines/CRITICAL-RULES-AND-GUARDRAILS.md`, diff-verifiable only:

| Rule | Source | Result |
|---|---|---|
| Never ship a fixed-width or desktop-only layout | AGENTS.md | pass – flex/wrap, `flex: 0 1 20rem; max-width:100%`; screenshots verified at 375/768/1280 |
| Never tie the schema to a provider's proprietary features | AGENTS.md (ADR-003) | pass – no migration added; reuses S03's plain `timestamptz` |
| Never rely on in-process state between requests | AGENTS.md (ADR-004) | pass – `buildScheduleEnvelope` is pure; clock and grants read per call |
| Never attribute a vote to a voter | AGENTS.md | n/a – no vote surface in S06 |
| Never key a user on their email address | AGENTS.md (ADR-002) | pass – `listJoinedAndReadable(sub)`, `requireMembership` join `user_sub`; SQL text asserted at `api/test/attendee-schedule.integration.test.ts:393-413` |
| Never trust the `hd` request parameter | AGENTS.md | n/a – S02, unchanged |
| Never derive confApp roles from directory groups | AGENTS.md | pass – membership read from the `membership` table |
| Never run OIDC in an embedded WebView | AGENTS.md | n/a |
| Never widen offline support beyond schedule reads / post-it queueing | AGENTS.md | pass – no `localStorage`/`indexedDB`/`caches` in `web/src/attendee` or `web/src/clock` |
| Never use web push | AGENTS.md | n/a |
| Never commit `.env` files or credentials | AGENTS.md | pass – `.env` gitignored; `visual/attendee-schedule.spec.ts` seeds a literal fixture token, not a credential |
| **En dashes (–), not em dashes** | CRITICAL-RULES § Operational | **FAIL – G1 below** |
| No AI attribution anywhere | CRITICAL-RULES | pass – scanned all new files |
| Temp files in `.agent_temp/` | CRITICAL-RULES | pass – screenshots are gitignored build output |
| Code is the source of truth; fix or delete stale comments | CRITICAL-RULES | marginal – see L2 |

### G1 (LOW) – Em dash in shipped UI copy

- **Location**: `web/src/attendee/ScheduleView.tsx:123`
- **Finding**: `Parallel track — runs at the same time as …` uses U+2014 (em dash). `CRITICAL-RULES-AND-GUARDRAILS.md` § Operational Rules mandates en dashes. It is user-visible – confirmed in `screenshots/attendee-schedule-phone-375.png` and `-desktop-1280.png`.
- **Evidence**: the only new em dash in the change set; the two others in `web/src/styles.css:515,520` are pre-existing and outside the added lines. The sibling module even documents the rule (`schedule-view-model.ts:74` – "An en dash, because it is a range").
- **Class**: `code-defect` · **Routing**: **Fix** (mechanical, single character)

---

## Coverage Matrix

| Surface | Evidence read | Positive proof | Falsifier attempted | Result |
|---|---|---|---|---|
| **AS S01** – lands on today's Sessions in start-time order | `routes/attendee.ts:114-149`, `schedule-envelope.ts:139-170`, `session-repository.ts:116-127` | integration `:485-516`, panel test `:178-211` | Sessions seeded out of order; ordering comes from the repo `ORDER BY`, not a re-sort | covered |
| **AS S02** – default conference: running, else most recently joined | `attendee-conferences.ts:37-44`, `conference-repository.ts:289-313` | integration `:268-315` (3 cases incl. two running at once) | clock moved to 2026-09-20 so nothing runs; asserted Product Days. Reversing the repo `ORDER BY` breaks `:283-313` | covered |
| **AS S03** – days navigable, day 1 outside span, empty day named | `schedule-view-model.ts:26-29`, `ScheduleView.tsx:44-62` | panel test `:228-271`, integration `:485-494` | rendered with `serverNow.day` = 2026-09-01 (before) | **partial – L8**: the "after it ends" half of the scenario is never exercised |
| **AS S04** – concurrency marked, nothing to choose | `schedule-envelope.ts:168`, `overlap.ts:38-41`, `ScheduleView.tsx:117-125` | integration `:519-550`, panel test `:277-326` | 09:00–10:00 vs 10:00–11:00 asserted **not** concurrent; `queryAllByRole('button')` empty inside the list; fetch call count = 2, all GET | covered |
| **AS S05** – +3h device clock, right highlight, untouched times | `effective-clock.ts:207-257`, `schedule-view-model.ts:39-51` | `effective-clock.test.ts:90-129`, panel test `:332-396`, contract `:166-183` | device clock genuinely skewed via `vi.setSystemTime`, then jumped +3h post-sync; asserted highlight moved AND `09:00–10:30` byte-identical | covered |
| **AS S06** – refusals name the reason, disclose nothing | `routes/attendee.ts:119-134`, `authorization.ts:102-144` | integration `:627-748` | unknown uuid returns the identical `NOT_A_MEMBER` as a non-member; response bodies asserted free of Session titles | covered (status code unpinned on one case – L7) |
| **AS S07** – failed fetch → explicit state + working retry | `AttendeeSchedulePanel.tsx:70-89`, `:93-126`, `:223-238` | panel test `:425-449` (schedule fetch only) | **`/me/conferences` failure path never driven** | **FINDING – H1, M3** |
| **AS S08** – legible at 375/768/1280 | `visual/attendee-schedule.spec.ts`, `styles.css:609-684` | 6 specs pass; screenshots inspected at 375 and 1280 | `horizontalOverflow <= 0`; per-element bounding boxes within viewport; tap targets ≥ 40px | covered |
| **SC** – one self-contained envelope, no further call | `schedule-envelope.ts:106-174` | contract `:134-159` renders with `fetch` stubbed to throw | source scan bans `fetch`/`apiRequest`/`useEffect` in the tree (`contract:246-254`) | covered |
| **SC** – tree is pure `(envelope, now)` | `ScheduleView.tsx`, `schedule-view-model.ts` | contract `:246-254` | greps for `Date.now`, `fetch`, `useEffect` in both files | covered |
| **SC** – anchor is four scalars, rehydrates with no fetch | `effective-clock.ts:57-62, 207-233` | `effective-clock.test.ts:135-185` | JSON round trip; partial anchor asserted to produce a *visibly wrong* clock | covered |
| **SC** – `serverNow` carries instant **and** naive wall clock | `calendar-date.ts:76-131` | integration `:552-557` | asserted `day`/`time` literal values and the instant's µs shape | covered |
| **SC** – no Session time through `new Date`/`Intl`/`toLocale*` | `wall-clock-contract.test.ts:358-390`, `schedule-envelope-contract.test.tsx:188-240` | source scans of `api/src/sessions`, `api/src/routes/attendee.ts`, `web/src/attendee`, `web/src/clock`; plus a `Date.\w+` allow-list of `Date.now` only | raw response body asserted to contain exactly 2 ISO instants (`integration:581-598`) | covered |
| **SC** – `concurrentWith` calls S04's single implementation | `schedule-envelope.ts:4,168` | grep: `a.startTime < b.endTime && a.endTime > b.startTime` exists **only** at `overlap.ts:40`; `schedule-envelope.ts` imports `overlapsWith` | boundary case asserted end-to-end at the endpoint, so changing S04's rule breaks this endpoint's test (`integration:546-549`) | covered |
| **SC** – `/me/conferences` and `/conferences` genuinely separate | `routes/attendee.ts:78`, `routes/conferences.ts` | `conference-structure.test.ts:200-227` asserts both exist and exactly one `GET /api/conferences`; `integration:322-347` asserts the same draft is absent from one and present in the other for the same caller | attempted: no query-parameter switch exists on either route | covered |
| **SC** – `withAuth` + S03 authz helper, no inline comparison | `routes/attendee.ts:80,116,119`, `authorization.ts:134-144` | `installRouteAudit` (`with-auth.ts:169-187`) **throws** at registration for any unwrapped non-anonymous route; `integration:750-760` asserts 401 on both | attempted: no `createdBySub ===` or `membership` comparison in any handler body | covered |
| **SC** – every refusal through S01's envelope | `errors.ts:100-108`, `routes/attendee.ts:58-65` | integration `:627-718` reads `error.code` / `error.message` | 409 matches the repo's existing lifecycle-conflict convention (`lifecycle.ts`) | covered |
| **SC** – `lastUpdatedAt` carried unmodified, full precision | `schedule-envelope.ts:136`, `session-repository.ts:129-136` | integration `:564-575` compares against `to_char(… 'US')` from the DB | asserts `new Date(value).toISOString() !== value`, i.e. µs really survived | covered |
| **SC** – membership migration reversible, plain PostgreSQL | S03's `20260817120000000_conference` | integration `:188-215` (revert + re-apply, column shape) | dropped `membership` and re-applied | covered |
| **SC** – one query per schedule request for the Sessions | `routes/attendee.ts:141` | integration `:601-621` | **the test never invokes the endpoint** | **FINDING – M1** |
| **TI12** contract suite pins the envelope | `web/test/schedule-envelope-contract.test.tsx:78-125` | render + source-scan halves are genuine | envelope-shape half asserts a literal declared in the same file | **FINDING – L1** |
| New pure server modules (`attendee-conferences.ts`, `schedule-envelope.ts`) | – | integration only | whole suite is `describe.skipIf(!reachable)` | **FINDING – M2** |
| Work Area: client clock module | `effective-clock.ts` + `effective-clock.test.ts` | 11 tests incl. midnight roll forward/back, leap day | negative elapsed uses `Math.floor`, asserted | covered |
| Work Area: conference picker / switching | `AttendeeSchedulePanel.tsx:189-209` | panel test `:464-512` | single-conference case asserts the picker is absent | covered |

---

## Findings

### HIGH

#### H1 – A `/me/conferences` fetch failure is a dead end: no retry control, and no code path can re-issue the request

- **Reviewer**: code + gap (Critic) · filter: **VALIDATED, confidence 100**
- **Severity**: HIGH · **Confidence**: 95 · **Scope relation**: primary
- **Location**: `web/src/attendee/AttendeeSchedulePanel.tsx:70-89`, `:93-126`, `:172-177`, `:223-238`
- **Threatened requirement**: OC03 ("Every non-result path is explicit … and the failed fetch offers retry"), Acceptance Scenario S07, TI09 ("A failed fetch renders an error state with a **working retry control**")
- **Finding**: when `fetchMyConferences` fails, the catch at `:78-82` sets `conferencesFailure` and `setConferences([])`, leaving `conferenceId === null`. The schedule effect returns immediately (`:94`), so `phase` stays `{kind:'loading'}` forever. The retry button is rendered **only** under `phase.kind === 'failed'` (`:223`), so it never appears. Two aggravations:
  1. `loadConferences` is a `useCallback(…, [])` and its effect's deps are `[loadConferences]` (`:83`, `:89`), so the conference list *cannot* be re-fetched for the life of the component – there is no state a retry control could bump.
  2. The `attempt` counter (`:60`, `:126`, `:232`) is a dependency of the **schedule** effect only, so even a retry button placed beside the conferences alert would do nothing without a second counter.
- **Evidence / trigger path**: this is precisely Acceptance Scenario S07's Given ("the venue network drops the connection"). A dropped connection fails **both** requests; `/me/conferences` is issued first, so the user lands in the unrecoverable branch, not the recoverable one that `web/test/AttendeeSchedulePanel.test.tsx:425-449` exercises (that test routes `/me/conferences` to 200 and fails only the schedule call).
- **Impact**: on the one screen the whole conference is consumed through, held in a corridor on venue wifi, a transient outage strands the attendee with an alert and no action. On the Capacitor shells (S11) there is not even a browser reload affordance.
- **Suggested fix**: add a `conferencesAttempt` state to the conference-list effect's deps and render a retry control on `conferencesFailure` that bumps it. Keep the server's message.
- **Verification needed**: see M3 – a panel test routing `/me/conferences` to 503, asserting a retry control exists, that activating it re-issues the list request, and that the Schedule then renders.
- **Class**: `code-defect` · **Routing**: **Fix** (primary, mechanical, uniquely determined, does not expand past Intent)

### MEDIUM

#### M1 – The "one query for the Sessions" test never exercises the endpoint

- **Filter: VALIDATED, confidence 100**
- **Severity**: MEDIUM · **Confidence**: 95 · **Scope relation**: primary
- **Location**: `api/test/attendee-schedule.integration.test.ts:601-621`
- **Threatened requirement**: TI03 ("One query for the Sessions – no per-day or per-Session round trip"); Structural Criterion "A Conference Day's Sessions are fetched in one query per schedule request"; the NFR that this story must not put S12's p95 out of reach.
- **Finding**: the test constructs its own `createSessionRepository(recording)` and calls `listForConference(id)` directly. The recording `Database` is never handed to `buildApp` and no `inject` occurs. `listForConference` is a single `db.query` by construction (`session-repository.ts:117`), so the assertion reduces to `1 === 1`. Nothing anywhere counts queries through `GET /api/conferences/:id/schedule`.
- **Falsifier**: change `routes/attendee.ts:141` to `for (const day of days) await sessions.listForConference(…)`. Every test in the file still passes.
- **Suggested fix**: build the app over the recording `Database`, `inject` the schedule request for a three-day conference, and assert exactly one `from sessions where conference_id` statement in the captured SQL.
- **Class**: `code-defect` · **Routing**: Note (a new test, not a mechanical edit)

#### M2 – The two new pure server modules have no unit tests; all S06 API proof sits behind a skippable DB gate

- **Filter: VALIDATED, confidence 100**
- **Severity**: MEDIUM · **Confidence**: 90 · **Scope relation**: primary
- **Location**: `api/src/conferences/attendee-conferences.ts`, `api/src/sessions/schedule-envelope.ts`; absent files under `api/test/`
- **Finding**: both modules are pure functions with no direct test. Their only coverage is `api/test/attendee-schedule.integration.test.ts`, whose entire body is `describe.skipIf(!reachable)` (`:73`). Without PostgreSQL the file emits a console warning and the suite reports **green** with zero server-side S06 coverage – default-conference selection, day-span expansion, empty days, `dayNumber`, and the concurrency mapping all unverified.
- **Convention drift**: S04 shipped `api/test/overlap.test.ts` and `api/test/session-validation.test.ts` for exactly this class of pure logic. S06 did not. (The DB gate itself is repo-wide convention and is not the finding; the absent unit tests are, which is what holds this at MEDIUM rather than HIGH.)
- **Falsifier**: unset `TEST_DATABASE_URL` and rerun – `chooseDefaultConference` and `buildScheduleEnvelope` become entirely unproven while the suite still passes.
- **Suggested fix**: add `api/test/attendee-conferences.test.ts` and `api/test/schedule-envelope.test.ts` covering running vs. most-recently-joined selection, empty list → `null`, span expansion including empty days, `dayNumber` numbering, out-of-span Sessions dropped, and symmetric `concurrentWith`.
- **Class**: `code-defect` · **Routing**: Note

#### M3 – No web test drives a `/me/conferences` failure (H1's missing regression test)

- **Filter: VALIDATED, confidence 100 – "fold into H1's fix as its regression test"**
- **Severity**: MEDIUM · **Confidence**: 95 · **Scope relation**: primary
- **Location**: `web/test/AttendeeSchedulePanel.test.tsx` – every `/me/conferences` stub is `{status: 200}` (lines 180, 194, 216, 230, 247, 261, 279, 293, 309, 335, 356, 387, 404, 428, 453, 466, 500)
- **Finding**: the conference-list request has no failure test at any status. This is the missing falsifier that let H1 ship green, and it also leaves `failureOf`'s `NETWORK_UNREACHABLE` branch (`AttendeeSchedulePanel.tsx:38-45`) and the `attendee-conferences-error` element (`:173`) entirely unexercised.
- **Class**: `code-defect` · **Routing**: Note (ship with H1's fix)

### LOW

- **G1** – Em dash in shipped UI copy (`web/src/attendee/ScheduleView.tsx:123`). See Guardrails Coverage. **Routing: Fix.**
- **L1** *(downgraded from MEDIUM by the filter)* – TI12's envelope-shape assertions test a fixture the test file wrote itself. `web/test/schedule-envelope-contract.test.tsx:78-125` runs regexes over `ENVELOPE`, a literal declared at `:34-74` in the same file; nothing produced by `api/src/sessions/schedule-envelope.ts` is involved, so that half of TI12 is decorative. **Two things keep it LOW**: `api/test/attendee-schedule.integration.test.ts:552-557` does assert `serverNow.day/time/instant` off the real endpoint response, and the file's two later blocks (render with `fetch` stubbed to throw; the `Date`/`Intl` source scan) are genuine. Note the TypeScript mitigation does **not** apply – `AttendeeSchedule` is hand-declared in `web/src/api/client.ts`, not generated from the server type, so a server-side field removal never reaches the literal. Fix: anchor these assertions to a server-produced payload, or move them API-side where they bite.
- **L2** *(downgraded from MEDIUM by the filter)* – `AttendeeConference.joinedAt` is dead data and its comment is imprecise. `conference-repository.ts:54` declares it, `:310` maps it via a `Date.toISOString()` per row, and nothing reads it (`chooseDefaultConference` selects by list position). The JSDoc at `:44-46` says "`joinedAt` … orders the list and picks the default" – true of the **column** in the `ORDER BY` at `:296`, false of the mapped **field**. Fix: drop the field and reword the sentence to name the column.
- **L3** – `wallClockPlusMillis` throws on a malformed day/time (`effective-clock.ts:133-134` via `parts`) and is reached from **render** at `AttendeeSchedulePanel.tsx:149`, outside any try/catch; there is no React error boundary anywhere in `web/src`. Note the asymmetry: a malformed `serverNow.instant` **is** caught, because `rehydrateClock` parses it eagerly at `:211` inside `clockFromSync` at `:114`, which sits in the try block – but `day`/`time` are validated lazily at first render and escape. Requires a server contract break to fire, hence LOW.
- **L4** – `api/src/routes/attendee.ts` reads the same `conference` row twice: `conferences.findById` (`:121`) and `sessions.scheduleWatermark` (`:142`, `select … from conference where id = $1`). Three round trips per schedule request where two would do. Not a Structural Criterion breach – the FIS pins one query for the *Sessions*, which holds.
- **L5** – `isRunningOn` (`attendee-conferences.ts:18`) is exported but referenced only at `:41`; no test imports it. Drop the `export`.
- **L6** *(disputed by the filter – reframed)* – `web/test/AttendeeSchedulePanel.test.tsx:318` asserts `not.toMatch(/attend|going|star|add to|my agenda|select/i)` over the whole subtree's `textContent`. My original framing that it scans *server-provided* text was wrong: the text comes from the file-local `schedule()` fixture, so no real session title can trip it. The residue is still a smell – a broad negative regex where the sibling assertions at `:316-317` (`queryAllByRole('button'|'checkbox')` empty) already carry the load. Scope the regex to control elements.
- **L7** – `api/test/attendee-schedule.integration.test.ts:658-683` ("refuses a draft Conference even to its own Admin") asserts `error.code`, `error.message` and the absence of Session content, but never `statusCode` – unlike its sibling at `:625`. A regression to 200-with-an-error-body would pass. One line.
- **L8** – FIS Acceptance Scenario S03 states day 1 is selected **both** before the Conference starts and after it ends; only the "before" case is tested (`web/test/AttendeeSchedulePanel.test.tsx:240-256`; no `2026-10-*` date appears in the file). Single `defaultDay` branch, so low risk – but the scenario claims both directions.
- **L9** – Attendees see raw ISO dates: `dayLabel` renders "Day 2 · 2026-09-15" (`schedule-view-model.ts:68-70`) and the empty state reads "Nothing is scheduled on 2026-09-16" (`ScheduleView.tsx:59-62`). This is **not** forced by the `Intl`/`Date` ban as I first assumed – a weekday is `(daysFromCivil(y,m,d) + 4) mod 7`, and `daysFromCivil` already exists at `effective-clock.ts:98` constructing no `Date`. No scenario or TI asks for a human form, so this is a UX suggestion, not a spec breach.
- **L10** – Ledger hygiene: every checkbox in the FIS (Acceptance Scenarios, Structural Criteria, TI01–TI12) is still `[ ]`, *Implementation Observations* reads "No observations recorded yet", and `plan.json` has S06 at `"status": "in-progress"` while every other landed story reads `done`. Expected state for a story still under review; a close-out item for the `andthen:ops` skill, not a defect in the change set.

### Withdrawn by the Findings Filter (recorded for audit)

| Candidate | Falsifier that withdrew it |
|---|---|
| `chooseDefaultConference` depends on unpinned caller ordering | `integration:283-292` and `:294-313` both fail end-to-end if the repository's `order by m.joined_at desc, c.id` is dropped or reversed. The coupling is pinned behaviourally and documented at `attendee-conferences.ts:33-35`. |
| TI03's "grep finds no second overlap implementation" is unautomated | The Verify text names a grep as its method and the grep is clean – the predicate is stated once, at `overlap.ts:40`. Its second half *is* automated by the boundary assertions at `integration:546-549`. |
| Two Fastify registration styles in one file | Repo-wide convention, not S06 drift: `routes/conferences.ts:134` (2-arg) sits directly above `:142` (`{schema, handler}`); `routes/me.ts:16` matches. The options object appears where and only where there is a `schema`. |

---

## Cleanup Required

- `AttendeeConference.joinedAt` field + mapping (`conference-repository.ts:54,310`) – dead data (L2)
- `isRunningOn` export narrowing (`attendee-conferences.ts:18`) – L5
- No obsolete files, no dead code, no leftover temp artifacts in the change set

---

## Compliance

- **Guidelines adherence**: strong. Comments explain *why* throughout and are unusually load-bearing; one is imprecise (L2) and one guardrail is breached (G1). Scope discipline is clean – no drive-by edits, and the two inverted assertions in `conference-structure.test.ts` / `session-structure.test.ts` invert exactly the guards those tests were placed to invert, strengthening rather than weakening them.
- **Architecture patterns**: correct. The view-boundary / pure-tree split is real and enforced at the source level, not merely asserted. `withAuth` + the S03 authorization module are used with no inline comparison, and `installRouteAudit` makes that structural rather than conventional – an unwrapped route throws at registration. Statelessness holds (ADR-004): the envelope builder is pure, the clock is read per request, grants are read per call.
- **Domain language**: consistent with `docs/UBIQUITOUS_LANGUAGE.md` – "Parallel Track" is used in code, copy and comments; no Personal Agenda or attendance affordance exists, and its absence is asserted.
- **Security awareness**: good. Membership is decided before lifecycle state, so an unknown uuid and a non-joined Conference are indistinguishable; refusal bodies are asserted free of Session content; both endpoints are 401 without a credential and structurally cannot be registered unauthenticated. `sub` is the join key everywhere, asserted at the SQL-text level. The surface warrants only the thin pass – no `--mode security` escalation is indicated.
- **UI/UX**: responsive verified at all three widths by script and by direct inspection of the 375px and 1280px captures. Legible, no horizontal scroll, tap targets ≥ 40px, concurrency and running state conveyed in words as well as colour, `role="status"` on the Now badge.

---

## Critic Coverage

Run inline against the whole change set; an independent Devil's-Advocate pass then filtered every finding.

Attacked and **found clean**: timezone conversion sneaking in through `serverNow` (the server's local getters are the deployment wall clock by design; no Session value passes through them); a second overlap predicate (grep-verified – only `overlap.ts:40`); `concurrentWith` leaking cross-day or out-of-span Sessions (`overlaps` short-circuits on `day`, and out-of-span Sessions share no day with any span day); route consolidation via a query parameter (neither route accepts one; the structure tests assert exactly one `GET /api/conferences`); the anchor holding a live object or closure (four scalars, JSON round trip asserted); mid-flight request races on conference switch and retry (`AbortController` + `signal.aborted` guards on both paths); `deviceClockAtReceipt` read too late (taken immediately after `await`, before the abort check); negative elapsed time truncating to zero instead of rolling into the previous day (`Math.floor`, asserted); microsecond truncation of `lastUpdatedAt` (asserted against the DB's own `to_char`); membership-by-implication through an Admin role (`requireMembership` queries `membership` only, and is deliberately not `requireConferenceRole(…,'Attendee')`).

Attacked and **found defective**: the failure branch of the *first* of the two fetches (H1); three proof artifacts that do not constrain what they claim (M1, M2, M3).

---

## Verification Evidence

- **Tests**: `npx vitest run` → **32 files, 501 passed, 0 failed, 0 skipped**. Confirmed the PostgreSQL-gated integration suites genuinely ran (0 skipped; `TEST_DATABASE_URL` resolves through `api/test/setup.ts`'s `.env` loader).
- **Types**: `npx tsc --build` → clean, no output.
- **Lint**: `npx eslint .` → clean, no output.
- **Format**: `npx prettier --check .` → 4 files flagged: `api/test/join-code-structure.test.ts`, `api/test/join-code.test.ts`, `visual/conferences.spec.ts`, `web/src/components/JoinCodePanel.tsx`. All four are pre-existing S05 files, none in this change set – claim confirmed, not an S06 finding.
- **Visual**: 6 Playwright specs across 375/768/1280 reported passing by the executor; `screenshots/attendee-schedule-{phone-375,desktop-1280}.png` and `attendee-empty-day-*` present and inspected directly at 375px and 1280px.
- **Skipped**: `npm run screenshots` not re-run (Docker unavailable in this shell); relied on the committed captures and the executor's report. Security scanners not run – `--mode code,security` was not requested and the surface warrants only the thin pass.

---

## Remediation Plan

**Fix-routed (mechanical, bounded):**
1. **H1** – add a `conferencesAttempt` counter to the conference-list effect's deps and render a retry control on `conferencesFailure` that bumps it. `web/src/attendee/AttendeeSchedulePanel.tsx`.
2. **G1** – replace the em dash with an en dash. `web/src/attendee/ScheduleView.tsx:123`.

**Note-routed (need judgement or a new test):**
3. **M3** – ship with 1: a panel test routing `/me/conferences` to 503, asserting the retry control appears, re-issues the list request, and renders the Schedule.
4. **M1** – rewrite the one-query test to `inject` the schedule request against a recording `Database`.
5. **M2** – add `api/test/attendee-conferences.test.ts` and `api/test/schedule-envelope.test.ts`.
6. **L2 + L5** – drop `joinedAt` and its mapping, reword the comment to name the column, narrow the `isRunningOn` export.
7. **L1** – anchor the TI12 envelope assertions to a server-produced payload.
8. **L3, L4, L6–L9** – opportunistic.
9. **L10** – close the FIS checkboxes, record Implementation Observations, and set the plan status via the `andthen:ops` skill.

**Sequencing**: 1 + 3 together (same behaviour, same file pair). 2 standalone. 4, 5, 6, 7 independent of each other. 9 last.

**Acceptance for the FAIL → PASS transition**: item 1 shipped with item 3's test. Items 4–7 lift verification depth but do not gate the verdict.
