# Join Code Access – Mixed Review (code, gap)

**Date**: 2026-08-17
**Review mode used**: mixed
**Resolved chain**: `code` → `gap`
**Requirements baseline (review target)**: `docs/specs/conference-setup-and-schedule/s05-join-code-access.md`
**Implementation root (`CODE DIRECTORY`)**: `C:/git/confApp`
**Source Trust**: trusted-local
**SOURCE_RUN**: `exec-spec/S05/20260817-135307`
**Reconciliation Ledger**: none – no `docs/specs/conference-setup-and-schedule/s05-join-code-access.reconciliation-ledger.md` exists, so every finding below is unmatched and routes normally.
**Report location**: tier 2 spec-directory match (the requirements baseline lives in this directory).

**Scope note**: the change set is committed as `fc97fa7` (message mislabelled "checkin files for S04"); `web/test/JoinConferencePanel.test.tsx`, `web/test/JoinCodePanel.test.tsx` and `visual/join-code.spec.ts` are still untracked. Diff reviewed as `ffd48bf..HEAD` plus the three untracked files. 19 changed + 3 untracked files, ~2 700 added lines.

**Intent Context**
- FIS `s05-join-code-access.md` – Intent, OC01–OC04, ten Structural Criteria, nine Acceptance Scenarios, six Work Areas, seven "What We're NOT Doing" items.
- PRD `prd.md#fr3-conference-access-via-join-code` – acceptance criteria, the "code is not a security boundary" stance, the exact refusal sentence, the `sub`-not-IP and server-side-counter constraints, and "rate-limited to deter enumeration, **without locking a legitimate employee out on the morning of day one**".
- `AGENTS.md` → Do Not / Never; `docs/guidelines/CRITICAL-RULES-AND-GUARDRAILS.md`; ADR-002, ADR-003, ADR-004.

**Caller-declared accepted items, excluded from findings**: `JoinConferencePanel` rendering for every signed-in employee (S06 owns navigation); `plan.json` recording S03 as `spec-ready`.

---

## Executive Summary

The API half of S05 is strong work and the four binding constraints hold under inspection and under test: the limiter is keyed on `caller.sub` with no request-address read anywhere in the path, its counter lives in a PostgreSQL table proven shared by a **separate OS process**, recording is a single append-plus-prune statement with no counter to read-modify-write, and join-code uniqueness is a predicate-free unique index proven by a raw `INSERT` against an archived row. The FIS-sanctioned in-place extension of S03's joinability predicate is a genuine refactor, not a second rule, and S03's pre-existing `isJoinable` tests still guard it.

One HIGH defect sits on the client. After a rate-limit refusal `JoinConferencePanel` disables its submit control permanently – for the life of the mounted component – with no timer, no reset on edit, and no other path that clears the refusal. The server's own message tells the employee to try again in N minutes and the UI then makes that impossible until the app is relaunched, which contradicts OC04's self-healing allowance and FR3's explicit "without locking a legitimate employee out on the morning of day one". Two assertions in the new test suite lock that behaviour in, so the suite currently protects the defect.

Four LOW findings follow. Nothing else of substance surfaced in either lens.

## Verdict

| Dimension     | Score | Threshold | Status |
|---------------|-------|-----------|--------|
| Functionality | 6/10  | >= 7      | FAIL |
| Completeness  | 9/10  | >= 9      | PASS |
| Wiring        | 9/10  | >= 8      | PASS |

**Overall: FAIL**

CONVERGED: no
Auto-Remediation: PENDING

**Code-lens readiness**: Needs Fixes (1 HIGH, 0 CRITICAL, 0 MEDIUM, 4 LOW)
**Mixed overall readiness**: FAIL (worst on the precedence ladder)

Functionality is scored below threshold on one ground only: F1 is a `code-defect` that contradicts a stated Expected Outcome (OC04) and the PRD's named non-goal for the limiter, on the exact day-one path the requirement was written for. Completeness and Wiring are genuinely clean – no stubs, no TODOs, no unwired component.

---

## Guardrails Coverage

**Guardrails Coverage: 11 checked, 0 findings**

| Rule (source) | Evidence | Result |
|---|---|---|
| Never ship a fixed-width or desktop-only layout (`AGENTS.md#do-not--never`) | `web/src/styles.css` `.join-form` flex-wrap + `flex: 1 1 12rem`, `clamp()` font sizing, `overflow-wrap: anywhere` on `.join-code`; `visual/join-code.spec.ts` asserts zero horizontal overflow and in-viewport boxes at 375/768/1280 | pass |
| Never tie the schema to a managed provider's features (ADR-003) | `gen_random_uuid()` (core since PG 13), `make_interval`, `clock_timestamp()` only; `join-code-structure.test.ts:177-180` greps for `create extension`, pgcrypto, azure, citus, timescale, pg_cron | pass |
| Never rely on in-process state between requests (ADR-004) | limiter state is `failed_join_attempt`; `join-attempt-probe.ts` runs a **child process** and reads total 4 after 3 in-process attempts (`join-code.integration.test.ts:695-729`, asserts `probe.pid !== process.pid`) | pass |
| Never attribute a vote to a voter | n/a – no voting surface in S05 | n/a |
| Never key a user on their email address (ADR-002) | `membership.user_sub`, `failed_join_attempt.user_sub`; `information_schema` assertion pins the column set to `attempted_at, id, user_sub` (`:732-738`); join response asserted not to contain `@` (`:242`) | pass |
| Never trust the `hd` request parameter | `withAuth` verifies the `hd` **claim** via S02's verifier before any handler runs (`api/src/auth/with-auth.ts:72-87`); S05 adds no domain logic | pass |
| Never derive confApp roles from directory groups | `createConferenceAuthorization` reads `role_assignment` + `membership` per call | pass |
| Never run the OIDC flow in an embedded WebView | n/a – S05 adds no auth flow | pass |
| Never widen offline support beyond schedule reads and post-it queueing | no queue, no service worker, no local persistence; a transport failure surfaces as a refusal that keeps the typed value | pass |
| Never use web push | n/a | pass |
| En dashes not em dashes; no AI attribution (`CRITICAL-RULES-AND-GUARDRAILS.md`) | grep across all 13 new/changed S05 files: 0 em dashes, 0 attribution strings | pass |

---

## Coverage Matrix

### Expected Outcomes

| surface | evidence read | positive proof | falsifier attempted | result |
|---|---|---|---|---|
| OC01 join once, re-join is a no-op | `routes/join-code.ts:124-163`, `conference-repository.ts:330-336` | `on conflict (conference_id, user_sub) do nothing`; integration `:272-308` | submitted the same code twice **concurrently** (`:298-308`) – one row, both 200; creator with an S03-seeded Membership submits own code (`:286-295`) – still 1 row | covered |
| OC02 refusal names the reason and leaves a retry | `lifecycle.ts:132-173`, `JoinConferencePanel.tsx` | four distinct codes + messages (`join-code.test.ts:117-159`, integration `:381-411`); retry proven in `JoinConferencePanel.test.tsx:182-204` | asked whether **every** refusal leaves a usable retry – the rate-limit one does not, permanently | **finding F1** |
| OC03 view/regenerate, old code dead, no Attendee lost | `routes/join-code.ts:165-196`, `conference-repository.ts:310-318` | integration `:550-589`: 23 attendees join on `K7RM4P`, regenerate to `Q4XT8B`, old code returns `JOIN_CODE_UNKNOWN`, membership count unchanged | checked the SQL for any `delete`; `update … set join_code` only, no history table so the old value is unrecoverable | covered |
| OC04 throttle per employee, correct under concurrency, ~100 unaffected | `failed-join-attempts.ts`, migration | integration `:634-661` (20 subs on one address unaffected while one is throttled), `:749-770` (10 concurrent → exactly 10) | fired the threshold concurrently; verified `pg.Pool` default max 10 so the batch is genuinely parallel, not serialized by a size-1 pool. Overshoot of the *decision* is unguarded → **finding F3**. Client-side the throttle never expires → **F1** | partial |

### Acceptance Scenarios

| surface | evidence read | positive proof | falsifier attempted | result |
|---|---|---|---|---|
| S01 lowercase + whitespace join | integration `:224-266` | ` k7rm4p ` → 200, membership row is `{user_sub: NADIA}`, response names Kickoff 2026 | four spellings incl. `K7RM-4P` each resolve to the same id (`:258-266`); asserted **no Role Assignment** written (`:246-256`) | covered |
| S02 re-entry is a no-op | integration `:272-321` | two sequential + two concurrent submissions, count stays 1 | asserted a success/repeat records **zero** failed attempts (`:311-321`) – a success must not consume the allowance | covered |
| S03 unknown code, exact sentence | integration `:326-344` | exact-string `'No conference found with that code.'`, 404, `JOIN_CODE_UNKNOWN` | pre-asserted no conference holds `ZZZ999`; post-asserted membership count 0 for that sub | covered |
| S04 three non-joinable states, own reasons, one predicate | integration `:348-434`, `join-code.test.ts:86-163` | three distinct codes + messages in one database; "Summer Jam" asserted still `published` yet refused `JOIN_CONFERENCE_ENDED` (`:414-423`) | inclusive boundary probed both ways (`:426-434` joins on the end date, `join-code.test.ts:97` null on the end date); grep proves no second rule (`join-code-structure.test.ts:79-92`); membership count pinned at the 3 creator seeds only | covered |
| S05 archived code never reused | integration `:440-518` | raw `INSERT` bypassing all application code rejected with `{code: '23505', constraint: 'conference_join_code_unique'}` (`:451-457`); 12 further publishes with the **real** generator never mint `EF45GH` | asked whether the guard is application-level – it is the DB constraint, hit directly; also asserted the code is absent from the general conference payload (`:507-518`) | covered |
| S06 regenerate keeps Attendees | integration `:550-589` | old code 404 on the very next request, new code joins, count unchanged | non-Admin regenerate refused and the code verified **unchanged** in the row (`:608-623`); draft regenerate refused and `join_code` still null (`:591-606`) | covered |
| S07 per-`sub`, survives replicas | integration `:634-738` | 30 failures from one shared inject address; only `OSCAR` throttled; the other 20 join with the correct code | **separate OS process** probe proves the total is read from PostgreSQL, not module memory (`:695-729`); `information_schema` proves no address column exists (`:732-738`); a rate-limited request asserted **not** to record another attempt (`:675-688`) so the window can drain | covered |
| S08 concurrent attempts, window boundary | integration `:749-803` | 10 parallel injects → exactly 10 rows, asserted twice (raw `count(*)` **and** through `limiter.window`), 11th is 429 | boundary crossed by rewriting timestamps: 6 aged out → window reads 0, 6 fresh → reads 6 (not 12), and the correct code then joins (`:777-803`) | covered |
| S09 refused employee retries immediately | `JoinConferencePanel.test.tsx:160-318`, `visual/join-code.spec.ts:135-174` | typed value survives, input and submit enabled, refusal replaced not stacked, corrected resubmission joins; affordances verified as *rendered* at all three widths | asked the second clause – "the message tells her when she may try again" – and found the message present but the retry unreachable forever | **finding F1** |

### Structural Criteria

| surface | evidence read | positive proof | falsifier attempted | result |
|---|---|---|---|---|
| 1. Uniqueness across every row, no predicate | migration `:37` | `CREATE UNIQUE INDEX conference_join_code_unique ON conference (join_code)` | structure test extracts the statement and asserts it contains neither `where` nor `lifecycle_state` (`:187-194`); behaviourally hit at the DB | covered |
| 2. Authorization only via the provisional helper | `routes/join-code.ts:100-116` | one `requireConferenceRole(caller, conferenceId, 'Admin')` serving both Organizer endpoints | greps for `createdBySub ===`, `=== caller.sub`, `.role ===`, `role_assignment`, raw `insert into`/`select … from` in the route module (`:100-116`) | covered |
| 3. Exactly one joinability definition | `lifecycle.ts:117-173`, diff of that file | `isJoinable` **rewritten** to `joinRefusalReason(...) === null` – the old body was removed, not duplicated | S03's pre-existing `conference-lifecycle.test.ts:115-139` and `conference-structure.test.ts:76-111` still assert `isJoinable` and still pass, so the in-place rewrite is regression-guarded by tests written before it | covered – FIS-sanctioned, honoured |
| 4. No Membership migration | migration, structure test `:212-217` | `create table` matches list equals exactly `['failed_join_attempt']` | split on `-- Down Migration` so a `create table` in the down half cannot satisfy the up-half assertion | covered |
| 5. One atomic statement per attempt | `failed-join-attempts.ts:57-63` | single `with pruned as (delete …) insert into failed_join_attempt` | grepped for `update failed_join_attempt` and `count = count +` (`:141-145`); the *counter* is atomic, but the *decision* (count → insert) is check-then-act → **F3** | partial |
| 6. Store pruned by the system, no manual step | `failed-join-attempts.ts:57-63` | prune rides the write; integration `:809-859` – aged rows gone, in-window rows kept **and still counting** | asserted both halves of the FIS's own warning: pruned-because-aged *and* not-pruned-too-eagerly (Nadia's 3 survive and she still joins) | covered |
| 7. Shared envelope, distinct machine code | `errors.ts:63-79`, structure test `:232-257` | five new `ERROR_CODES`; greps forbid `reply.status/code/send` and hand-rolled `error: {` in S05 modules | `new Set(messages).size === 3` and no message matching `/invalid\|not allowed/` (`join-code.test.ts:157-158`); found one code carrying two meanings → **F5** | partial |
| 8. Plain PostgreSQL only | migration, structure test `:177-180`, `:154-156` | no extension, no cache library, PG 18 in `docker-compose.yml` | greps for redis/memcached/valkey/elasticache/azure-cache and for pgcrypto/citus/timescale/pg_cron | covered |
| 9. No in-process join or rate-limit state | structure test `:118-169`; `app.ts:131-139` | column-0 `let`/`var` and `new Map/Set/WeakMap` forbidden in all three S05 modules | the grep is heuristic (would miss `const c: Record<string,number> = {}`), but the criterion's load-bearing proof is behavioural – the child-process probe – so the grep is redundant reinforcement rather than the only evidence | covered |
| 10. Legible, no horizontal scroll at 3 widths | `visual/join-code.spec.ts` | `scrollWidth - clientWidth <= 0`; every named element's box within `viewport + 1`; 40px minimum tap targets; a **refusal on screen** in the capture, and a deliberately long conference name | 6 tests × 3 widths reported green by the caller; asserts layout facts, not screenshot equality, so it cannot pass on a stale baseline | covered |

### Work Areas and changed proof artifacts

| surface | evidence read | positive proof | falsifier attempted | result |
|---|---|---|---|---|
| Conference schema + constraint | migration `:18-37` | nullable column, CHECK pinning the alphabet **and** length, predicate-free unique index | reversibility exercised end-to-end: `migrate down N` then `up`, with `to_regclass` and `information_schema` both asserted (`:864-886`) | covered |
| Generation hooked into the S03 publish transition | `conference-repository.ts:287-295`, `routes/conferences.ts:172-179` | transition and mint are **one** statement, so "published without a code" is unrepresentable; `and lifecycle_state = 'draft'` guards a concurrent republish from reissuing a live code | `withMintedCode` retries the DB uniqueness violation (8 draws) rather than pre-checking with a `select`; the retry is not inside a transaction, so an aborted-transaction retry loop is not possible | covered |
| Join endpoint: normalize → lookup → predicate → Membership | `routes/join-code.ts:124-163` | ordering documented and matched; refusal records, success does not | whitespace-only and non-alphabet input normalize to a value that matches nothing and refuses as unknown (`join-code.test.ts:78-83`); `toUpperCase` not `toLocaleUpperCase`, so no Turkish-locale `i` hazard | covered |
| Organizer view/regenerate through the helper | `routes/join-code.ts:165-196` | authorization runs **before** the row is loaded, so a non-holder learns neither existence nor code | asserted the 403 body does not contain the code (`:546`) | covered |
| Failed-attempt store, limiter, retention | `failed-join-attempts.ts`, migration `:65-77` | window arithmetic runs in SQL against **one** clock (two replicas with skewed clocks still agree); two purpose-built indexes | `clock_timestamp()` not `now()` – several attempts in one transaction would otherwise share a timestamp; verified the unreferenced data-modifying CTE still executes (it does, and the retention test proves it empirically) | covered |
| Attendee entry UI + Organizer panel | both components + both suites | 22 web tests green; API driven at the `fetch` boundary so the real client module is exercised | FK hazard checked: `withAuth` upserts `app_user` before every handler, so a brand-new employee's first-ever request being a *failed* join cannot violate `failed_join_attempt.user_sub` – no 500 on day one | covered |
| Stale-code hazard in `JoinCodePanel` | `ConferencesPanel.tsx:96-108` | `state` is not reset when `conferenceId` changes, but `onBack` sets `selectedId` to `null`, so `ConferenceDetail` always unmounts between selections | tried to reach a render showing conference A's code under conference B's heading – unreachable via the only navigation path | not a finding |

---

## CODE LENS – Findings

### HIGH

#### F1. A rate-limit refusal disables the join control permanently, so the employee can never act on the retry time the message gives them

- **Reviewer**: code lens + Critic
- **Severity**: HIGH · **Confidence**: 95 · **Scope relation**: primary
- **Class**: `code-defect` · **Routing**: **Fix** – bounded, single-file behavioural correction plus the two assertions that encode the defect; the FIS pins both constraints the fix must satisfy.
- **Location**: `web/src/components/JoinConferencePanel.tsx:47-66`, `:123`; tests `web/test/JoinConferencePanel.test.tsx:276-287`, `:309-318`

**Finding.** `rateLimited` is derived purely from the identity of the current refusal (`refusal?.code === RATE_LIMITED`, line 47) and `canSubmit` is false whenever it is true (line 49). `refusal` is written in exactly two places: cleared at the top of `submit()` (line 54) and set in its `catch` (line 62). `submit()` is reachable only through the submit button (`disabled={!canSubmit}`, line 123) or the form's `onSubmit`, which is itself guarded by `if (canSubmit)` (line 85). Editing the field does not clear it – `onChange` only calls `setCode` (line 107). There is no `setTimeout`, no expiry, no other reset. Therefore, once a `JOIN_ATTEMPTS_RATE_LIMITED` refusal lands, the component can never submit again for the lifetime of the mount, and `JoinConferencePanel` is mounted for as long as the employee stays signed in (`web/src/App.tsx:80`).

**Threatened assumption or invariant.** OC04 and the implementation's own rationale (`failed-join-attempts.ts:32-40`: *"a rolling window means the allowance returns by itself – there is no unlock step"*). Also FR3 → Error Handling: *"rate-limited to deter enumeration, **without locking a legitimate employee out on the morning of day one**"*, and OC02's *"the employee left able to correct it and try again on the spot"*.

**Concrete failure scenario (inputs/state → wrong output).**
1. 2026-09-14, 08:55. Priya has created "Kickoff 2026" but has not published it yet. The code is already on the slide.
2. Nadia submits it. The server resolves the Conference, `assertJoinable` refuses `JOIN_CONFERENCE_NOT_PUBLISHED` with *"Ask the organizer to publish it, then try again."*, and – per TI06, correctly – `failedAttempts.record(NADIA)` appends a row.
3. She does what the message says, ten times over the next five minutes. Attempts 1–10 each return 409 and each records a row.
4. Attempt 11: `assertWithinLimit` sees `attempts = 10 >= limit` and throws 429 with *"…try again in about 6 minutes."*
5. `setRefusal({code: 'JOIN_ATTEMPTS_RATE_LIMITED', …})` → `rateLimited` true → `canSubmit` false → **Join disabled**.
6. 09:05. Priya publishes. 09:06, the server's rolling window has drained and `POST /api/join` with the correct code would return 200.
7. Nadia's screen still shows a greyed-out Join button and a six-minute-old message. Editing the code does not re-enable it. **Expected**: she can submit and join. **Actual**: no path forward except killing and relaunching the app – and on the Capacitor Android/iOS shell there is no address bar to reload from.

**Evidence.** The repository's own suite states the defect as intended behaviour:
- `JoinConferencePanel.test.tsx:286` – `expect(submitButton().disabled).toBe(true);`
- `JoinConferencePanel.test.tsx:309-318` – *"issues no request while paused"* clicks submit a second time and asserts `harness.calls` is still length 1.

These are the design-echoing assertions the review was asked to hunt for: they assert the implementation's chosen shape (a terminally disabled control) rather than the requirement (S09: *"the message tells her when she may try again"*). A correct fix **fails** the current suite. No test anywhere asserts recovery after the window, so the gap is invisible to `npm test`.

**Impact.** The only entry point into the product is unreachable for a legitimate employee at exactly the moment FR3 names, on a device where reloading is not an available gesture. Trigger cost is 11 refusals – and step 2 shows those refusals can all be *legitimate* (a conference not yet published), so this does not require a malicious or careless user.

**Suggested fix.** Make the pause expire instead of being an identity. Minimal, single-file: clear the refusal when the field is edited, so the control re-arms on the employee's next natural action while still not being offered at the instant of refusal –

```tsx
onChange={(event) => {
  setCode(event.target.value);
  if (rateLimited) setRefusal(null);
}}
```

Then replace the two assertions above with ones that prove the requirement: after a rate-limit refusal the message states when to retry **and** a subsequent edit re-enables submit, and a resubmission after the pause joins. If a time-based re-enable is preferred instead, note that the envelope currently carries the retry time only as prose – `rateLimited()` builds it into the sentence and adds no machine-readable field – so that route needs `retryAfterSeconds` added to the error `details` first, which is a wider change than this fix.

**Verification needed.** A new web test: refuse with `JOIN_ATTEMPTS_RATE_LIMITED`, assert submit disabled and the message present; then type into the field and assert submit enabled; then stub a 200 and assert the join completes without remounting.

### MEDIUM

None.

### LOW

#### F2. `retryAfterSeconds` can never be `null`, so its type, its doc comment and its fallback are all wrong

- **Severity**: LOW · **Confidence**: 100 · **Scope relation**: primary · **Class**: `code-defect` · **Routing**: Note (two equally valid corrections – tighten the type or change the SQL – so not uniquely determined)
- **Location**: `api/src/conferences/failed-join-attempts.ts:73-107`

PostgreSQL's `greatest()` **ignores** NULL arguments, returning NULL only when every argument is NULL. With an empty window `min(attempted_at)` is NULL, so `ceil(extract(...))` is NULL, and `greatest(0, NULL)` returns `0` – not NULL. Verified against the project's own test database:

```
select count(*)::int as attempts,
       greatest(0, ceil(extract(epoch from (min(attempted_at) + make_interval(mins => 10) - clock_timestamp()))))::int as retry
  from failed_join_attempt where user_sub = 'nobody-at-all';
→ {"attempts":0,"retry":0}
```

So `FailedAttemptWindow.retryAfterSeconds: number | null` and its comment *"or `null` when there are none"* (line 89) are both false, and `whenToRetry`'s `?? FAILED_ATTEMPT_WINDOW_MINUTES * 60` (line 104) is dead code that no test reaches. **Impact**: none at runtime – the field is only read from `assertWithinLimit` where `attempts >= limit` guarantees a non-null `min()`. It is a false statement in a module whose comments are otherwise load-bearing, and a future caller who trusts the signature will write an unreachable branch. **Fix**: either drop the nullable type and the fallback, or wrap the expression in `case when count(*) = 0 then null else … end` so the declared type is true.

#### F3. The limiter's decision is check-then-act, so a concurrent burst overshoots the threshold before it engages

- **Severity**: LOW · **Confidence**: 90 · **Scope relation**: primary · **Class**: `code-defect` · **Routing**: Note (needs a design call; the FIS does not require decision atomicity)
- **Location**: `api/src/routes/join-code.ts:129-137`, `api/src/conferences/failed-join-attempts.ts:144-148`

`assertWithinLimit` issues a `SELECT count(*)` and `record` issues a separate `INSERT`, with nothing serializing the pair. Binding constraint (c) is satisfied – the *counter* is atomic and loses no increment – but the *gate* reads a count taken before the concurrent batch's inserts land.

**Scenario**: one `sub` dispatches 40 wrong codes as a single batch. Each request's `assertWithinLimit` reads a count from before most siblings inserted, so all 40 pass the gate, all 40 are matched against `conference`, and 40 rows are recorded. Only the 41st request is refused. Overshoot is bounded by in-flight concurrency (`pg.Pool` default `max` 10 per replica × replica count), so roughly 10–20 extra guesses per burst rather than an unbounded bypass – but the enumeration deterrent FR3 asks for is weaker than the threshold suggests.

No test covers it: `join-code.integration.test.ts:749` fires exactly `FAILED_ATTEMPT_LIMIT` concurrent attempts, which the gate admits *by design*, so the overshoot is structurally invisible. **Fix if wanted**: record first and decide on the post-insert count, or gate with one statement – `insert … select … where (select count(*) …) < $limit returning id` – and refuse when no row returns. Either keeps "one atomic statement per attempt".

#### F4. `JOIN_CONFERENCE_NOT_PUBLISHED` carries two different meanings

- **Severity**: LOW · **Confidence**: 85 · **Scope relation**: primary · **Class**: `code-defect` · **Routing**: Note (renaming a code is a client-visible contract change)
- **Location**: `api/src/routes/join-code.ts:185-192` vs `api/src/conferences/lifecycle.ts:137-143`

The same machine code answers two unrelated situations with two different messages: *"that code is for a draft conference"* (an employee joining) and *"your draft has no code to regenerate"* (an Organizer). `errors.ts:63-69` states the namespace rule as *"One code per **reason**, not one per endpoint"*, and Structural Criterion 7 asks for a distinct code per refusal. **Scenario**: a client branching on `error.code` to decide what to show cannot distinguish the two without also tracking which endpoint it called – the exact coupling the code list exists to remove. Impact is small because the endpoints are distinct. **Fix**: give the regenerate case its own code, e.g. `CONFERENCE_JOIN_CODE_ABSENT`.

#### F5. Every proof surface in the FIS is still unchecked after the work landed

- **Severity**: LOW · **Confidence**: 100 · **Scope relation**: primary · **Class**: `spec-stale` · **Routing**: Note (`andthen:ops update-fis` owns these writes)
- **Location**: `docs/specs/conference-setup-and-schedule/s05-join-code-access.md:39-107`, `:165-207`, `:223-227`

All nine Acceptance Scenarios, all ten Structural Criteria and all eleven Implementation Tasks remain `[ ]`, and Implementation Observations still reads *"No observations recorded yet."*, although the code has shipped and its suite is green. A reader of the FIS cannot tell which requirements are proven, and a later gap review has no record of what a prior run established. Distinct from the S03 `plan.json` drift the caller excluded – this is S05's own bookkeeping.

### Cleanup Required

- Dead fallback branch: `failed-join-attempts.ts:104` (`?? FAILED_ATTEMPT_WINDOW_MINUTES * 60`) – see F2.
- `conferenceParamsSchema` is now defined identically in `routes/conferences.ts:48`, `routes/sessions.ts:55` and `routes/join-code.ts:56`. Pre-existing pattern S05 followed rather than introduced; a shared definition would be the DRY move if a fourth appears. Not a defect – noted, not flagged.
- No obsolete files, no dead code, no temporary artifacts. `api/test/join-attempt-probe.ts` is not a stray script: it is the child process the cross-replica test spawns.

### Compliance

- **Guidelines adherence**: pass. Scope discipline held – the only file outside S05's own surface that changed is `lifecycle.ts`, which the FIS explicitly directs ("extend it in place"), plus the one-line `publish()` swap in `routes/conferences.ts`. No S06/S07/S08 reach-in: the structure test even asserts no membership-revocation endpoint was added (`:281-290`).
- **Architecture patterns**: pass. Repository seam respected – no SQL in a handler, asserted by grep. Authorization expressed only through the provisional S03 primitive, so S07 replaces one call-site pattern as intended. Stateless handlers throughout.
- **Domain language**: pass against `docs/UBIQUITOUS_LANGUAGE.md`. Admin/Organizer used consistently; the Attendee role *is* Membership with no Role Assignment, and a test pins that (`:246-256`).
- **Security awareness (thin pass)**: no hardcoded secrets; every query parameterized; no string-concatenated SQL; the new endpoints are all `withAuth`-wrapped and the startup route audit refuses to boot otherwise; refusals disclose the conference name deliberately per an explicit PRD decision, and the 403 path is verified not to leak the code. **This surface (authn/authz-adjacent, network-exposed handlers, a rate limiter) would normally auto-route the security lens; `--mode code,gap` explicitly omits it, so per the code lens's own rule I record that here rather than attempting OWASP-depth analysis.** Nothing found in the thin pass warrants escalation on its own, but `--mode security` would be a reasonable follow-up for the limiter and the disclosure stance.
- **UI/UX**: one HIGH (F1). Otherwise good: `role="alert"` on refusals, `role="status"` on success, `aria-invalid`/`aria-describedby` wired, labels bound by `htmlFor`, 40px minimum tap targets verified, `autoComplete="off"` with `autoCapitalize="characters"`, and the regenerate consequence stated *before* the action.

---

## GAP LENS – Findings

The gap lens ran against the coverage matrix above and produced no findings of its own beyond F1 (which surfaced in both lenses and is kept in the code section) and F5. Specifically:

- **Functionality**: every Acceptance Scenario S01–S09 has a test that binds the required behaviour, and in each case I identified the bad state that would still pass and confirmed a falsifier exists for it. The three the FIS singles out as easy to fake are all proven the hard way: uniqueness at the **database constraint** via a raw `INSERT` bypassing application code; atomicity by a **genuinely parallel** batch (verified the pool is not size 1, which would have silently serialized it); and shared state by a **separate OS process** whose pid is asserted different. S09's second clause is the one requirement whose implementation defeats it (F1).
- **Forward coverage**: all six Work Areas have implementing code, a test, and a matrix row. None unreferenced.
- **Integration/wiring**: three routes registered and audited; both panels mounted and reachable; the minter injected through `buildApp`; the limiter constructed from `db`; the migration applied, reverted and re-applied inside the suite. No component exists unwired.
- **Requirement mismatch**: the exact PRD sentence *"No conference found with that code."* is asserted by string equality, not by regex. Messages are the server's own in every rendering path – neither component rewords one.
- **Spec/design drift**: the caller's item 3 checks out and is **not** a defect. `lifecycle.ts` was extended in place: `isJoinable`'s old body was *removed* and replaced with `joinRefusalReason(...) === null`, so there is one rule with two views rather than two rules. Behavioural equivalence is guarded by S03's own pre-existing tests (`conference-lifecycle.test.ts:115-139`), which were written before the rewrite and still pass – the strongest available evidence that the refactor changed no decision. Structural Criterion 3 is satisfied.
- **Verification depth**: two weak spots, both non-load-bearing because a behavioural proof stands behind them, so neither is recorded as a finding — (a) `join-code-structure.test.ts:94-97` is a bare `toContain('assertJoinable')`, a design echo, but the rule is really proven by three distinct refusals from a real database; (b) the "no module-level mutable state" greps catch `let`/`var`/`new Map` but would miss `const cache: Record<string, number> = {}`, and the criterion's real proof is the child-process probe. The one place a weak assertion **is** load-bearing – and actively harmful – is F1's pair.
- **Holistic outcome & observability**: the API side achieves OC01–OC03 end-to-end and fails silently nowhere: every refusal is a displayable sentence plus a machine code, unexpected throws are logged server-side with no driver text reaching the caller, and the client surfaces the code alongside the message so a refusal can be reported without quoting prose. OC04's operator-facing property (the allowance returns by itself, no unlock step) holds on the server and is broken on the client – F1.

---

## Critic Coverage

Run inline against the whole change set. Assumptions and unhappy paths attacked, with the result of each:

| Attack | Result |
|---|---|
| Does the unreferenced data-modifying CTE in `RECORD_AND_PRUNE` actually run? | Yes – PostgreSQL executes `WITH` data-modifying statements exactly once to completion regardless of whether the primary query reads their output; the retention test proves it empirically. |
| Is the S08 concurrency test real, or serialized by a size-1 connection pool? | Real. `createDatabase` uses `new pg.Pool({connectionString})` with the default `max: 10`, and the batch size is exactly 10. |
| Did the integration suite actually execute, or was it skipped by `describe.skipIf(!reachable)`? | Executed. Spot-ran `api/test/join-code.integration.test.ts` – **29 tests passed in 4.46s** against PostgreSQL 18 on `127.0.0.1:5434`. The 430-test claim is backed by real database evidence, not skips. |
| Can a brand-new employee's first-ever request be a failed join and blow the `user_sub` foreign key into a 500? | No. `withAuth` calls `users.upsertFromClaims` before every handler body, so `app_user` always exists. |
| Can `withMintedCode`'s retry loop spin, or retry inside an aborted transaction? | No. `publish`/`regenerateJoinCode` call `db.query` directly, never inside `db.transaction`, so a unique violation does not poison a surrounding transaction; the loop is bounded at 8 and any non-collision error (including its own "vanished row" throw) propagates on the first pass. |
| Does a rate-limited request record yet another attempt, making the window never drain? | No – `assertWithinLimit` throws before `record`. Asserted at `:675-688`. |
| Can `findByJoinCode('')` match anything after whitespace-only input normalizes to empty? | No. The CHECK constraint requires exactly six alphabet characters, so `''` is unstorable. |
| Can the panel show conference A's code under conference B's heading (stale `state` across `conferenceId`)? | Unreachable – `ConferenceDetail` unmounts via `onBack` before another conference can be selected. |
| Locale hazard in normalization (`toUpperCase` vs `toLocaleUpperCase`)? | Safe – `toUpperCase` is locale-invariant, and `I` is not in the alphabet anyway. |
| Does `format: 'uuid'` on the params schema actually assert, or silently no-op? | Asserts – Fastify's bundled `@fastify/ajv-compiler` enables `ajv-formats`. Same pattern as S03/S04, unchanged. |
| Does the visual spec prove anything, or is it a screenshot rubber-stamp? | Proves layout facts – `scrollWidth - clientWidth <= 0`, per-element bounding boxes inside the viewport, 40px minimum tap targets, with a refusal deliberately on screen. It cannot pass on a stale baseline. |
| Is the client's rate-limit pause recoverable by any path at all? | **No** – finding F1. |

---

## Verification Evidence

- **Commands run**
  - `npx vitest run --project api api/test/join-code.integration.test.ts` → **1 file, 29 tests passed** (4.46s), against real PostgreSQL. Confirms the suite is not silently skipping.
  - `npx vitest run --project web web/test/JoinConferencePanel.test.tsx web/test/JoinCodePanel.test.tsx` → **2 files, 22 tests passed**.
  - TCP reachability probe of `TEST_DATABASE_URL` → open on `127.0.0.1:5434`; `docker-compose.yml` pins `postgres:18-alpine`.
  - Ad-hoc SQL probe of the empty-window `greatest(...)` expression → returned `retry: 0`, establishing F2 as fact rather than inference.
  - `git diff ffd48bf..HEAD` per file; `git show --stat fc97fa7`; em-dash and AI-attribution greps across all 13 new/changed S05 files.
- **Commands reused (not rerun, per caller)**: full `npm test` (28 files, 430 tests), `npm run typecheck`, `npm run lint`, `npx prettier --check`, `visual/join-code.spec.ts` (6 passed at 375/768/1280px).
- **Commands skipped**: the Playwright visual run – it needs a dev server the caller instructed me not to start. The spec was read line by line instead and its assertions judged on content.
- No load-bearing check failed.

---

## Remediation Plan

**Critical**: none.

**High**
1. **F1** – make the rate-limit pause expire (`web/src/components/JoinConferencePanel.tsx`). Clear the refusal on field edit, or add `retryAfterSeconds` to the error envelope and re-enable on a timer. Then rewrite `JoinConferencePanel.test.tsx:276-287` and `:309-318` so they assert recovery instead of a terminal disabled state. *Acceptance*: after a `JOIN_ATTEMPTS_RATE_LIMITED` refusal the message states when to retry, a subsequent edit re-enables submit, and a resubmission joins – all without remounting. Do F1 before F3; F3's fix touches the same refusal's wire shape if the envelope route is chosen.

**Medium**: none.

**Low** (any order, all independent of F1 except as noted)
2. **F2** – drop the impossible `null` from `FailedAttemptWindow.retryAfterSeconds`, its comment, and `whenToRetry`'s fallback; or make the SQL return NULL explicitly.
3. **F3** – decide whether burst overshoot is acceptable. If not, fold the gate into the recording statement and add a test that fires *more* than the threshold concurrently.
4. **F4** – give the regenerate refusal its own error code; update `errors.ts`, the route, and the integration assertion at `:602`.
5. **F5** – check off S05's Acceptance Scenarios, Structural Criteria and Implementation Tasks, and record Implementation Observations, via `andthen:ops update-fis`.

**Learnings candidate**: "a client that derives a disabled state from the *identity* of the last error, rather than from an expiry, turns a temporary server-side pause into a permanent client-side lockout – and a test asserting `disabled === true` then protects it." A lint rule cannot catch this; the check that would is a standing review question for every throttle UI: *what re-enables this control, and which test proves it?*
