# S05: Join Code Access

**Plan**: docs/specs/conference-setup-and-schedule/plan.json
**Story-ID**: S05

## Feature Overview and Goal

**Intent**: An Organizer should not have to pre-provision an attendee list – a signed-in employee types a short code read off a slide and lands in the right conference, on the morning of day one, without help.

**Expected Outcomes**:

- [OC01] A signed-in employee entering the code of a joinable Conference becomes an Attendee of exactly that Conference; entering it again changes nothing and is not an error.
- [OC02] A code that must not work is refused with the actual reason stated and the employee left able to correct it and try again on the spot; it never silently resolves to a different Conference than the one it was issued for.
- [OC03] An Organizer can see and regenerate their Conference's code; the previous code stops working immediately and no existing Attendee loses their Membership.
- [OC04] Repeated failed attempts are throttled per signed-in employee – counted correctly even when they arrive concurrently – so ~100 employees joining simultaneously from one venue network are unaffected.


## Required Context

- `docs/specs/conference-setup-and-schedule/prd.md#fr3-conference-access-via-join-code` – the feature contract: acceptance criteria, the "code is not a security boundary" validation stance, the exact refusal messages, and the **binding constraints** that the limiter is keyed on the authenticated `sub` and never on client IP with a server-side (not in-process) counter, and that codes are unique across *all* Conferences including archived ones.
- `docs/specs/conference-setup-and-schedule/prd.md#data-requirements` – the Conference (join code absent until published), Membership (links a user's `sub` claim to a conference), and Role Assignment shapes this story writes and reads. **The Membership table is created by S03's migration**, which also seeds a Membership plus an Admin Role Assignment for the Conference's creator; S05 is a *writer* of Membership rows, not the owner of the table.
- `docs/specs/conference-setup-and-schedule/prd.md#user-flows` → Flow 5 – the bad-code path ends "refused with a clear message **and the option to retry**"; the refusal is not a dead end.
- `docs/specs/conference-setup-and-schedule/prd.md#non-functional-requirements` – **binding constraints**: `hd` claim verified server-side on every request (ADR-002); plain PostgreSQL only, no provider-specific extensions (ADR-003); responsive behaviour verified at 375px / 768px / 1280px.
- `docs/specs/conference-setup-and-schedule/plan.json#sharedDecisions` – three decisions bind this story unchanged: the S01 route/error-envelope conventions (refusals carry a displayable message *and* a machine code), the S02 authenticated-caller context (validated `sub`, verified `hd`), and the **per-conference authorization primitive** – S03 established one provisional helper and S05 must express every authorization check through it, never as an inline conditional, so S07 generalizes one call-site pattern.
- `docs/adrs/ADR-002-authenticate-with-google-workspace-oidc.md#decision` – why the join code is not a security boundary (sign-in already restricts to the Workspace domain) and why identity is the `sub` claim, never email.
- `AGENTS.md#do-not--never` – the standing prohibitions this story is most exposed to: never rely on in-process state between requests, never key a user on email, never trust the `hd` request parameter.
- `docs/UBIQUITOUS_LANGUAGE.md#roles` – Admin (also *Organizer*) and Attendee as used here; Presenter/Facilitator is one role, not two.


## Deeper Context

- `docs/adrs/ADR-003-postgresql-containerized-development.md` – why the schema and the limiter store must stay portable plain PostgreSQL; read before reaching for an extension or a managed cache.
- `docs/adrs/ADR-004-containerized-api-and-spa.md#decision` – the API is a long-running container, not Azure Functions. The "handlers hold no state between requests" rule survives unchanged; the reason is now horizontal scaling across replicas rather than transient Function instances, and the ADR names this story's rate limiter as the worked example.
- `docs/guidelines/CRITICAL-RULES-AND-GUARDRAILS.md#scope-discipline` – scope boundary discipline; S05 sits between S03/S04 upstream and S06/S07/S08 downstream and must not reach into them.


## Acceptance Scenarios

- [x] **S01 [OC01] [TI02,TI03,TI04] An employee joins a running published Conference by typing its code in lowercase**
  - **Given** Conference "Kickoff 2026" is published, runs 2026-09-14 to 2026-09-16, and its generated join code is `K7RM4P`
  - **And** Nadia is signed in with a verified company Google Workspace account and is not yet a member of any Conference
  - **When** Nadia submits ` k7rm4p ` (lowercase, with surrounding whitespace)
  - **Then** an Attendee Membership linking Nadia's `sub` to "Kickoff 2026" exists, and the response identifies "Kickoff 2026" as the conference joined

- [x] **S02 [OC01] [TI04] Re-entering an already-joined code is a no-op, not an error**
  - **Given** Nadia is already an Attendee of "Kickoff 2026" via code `K7RM4P`
  - **When** Nadia submits `K7RM4P` again
  - **Then** the request succeeds and identifies "Kickoff 2026", and Nadia still has exactly one Membership for that Conference – no duplicate row, no refusal

- [x] **S03 [OC02] [TI05] An unknown code is refused with the message naming that no conference matched**
  - **Given** no Conference in the database holds the code `ZZZ999`
  - **When** a signed-in employee submits `ZZZ999`
  - **Then** the request is refused through the shared error envelope with the user-facing message "No conference found with that code." and no Membership is created

- [x] **S04 [OC02] [TI05] Each non-joinable Conference state refuses the join and names its own reason**
  - **Given** three Conferences exist: "Draft Days" in `draft` with code `AB23CD`; "Retro 2025" `archived` with code `EF45GH`; and "Summer Jam" still in `published` state but whose end date was yesterday, with code `JK67MN`
  - **When** a signed-in employee submits each of `AB23CD`, `EF45GH` and `JK67MN` in turn
  - **Then** each is refused with a distinct machine code and a user-facing message naming its own reason – not yet published, archived, and already ended respectively – and no Membership is created in any of the three cases
  - **And** "Summer Jam" is refused despite never having been archived: joinability ends with the Conference's end date, not with the manual archiving step
  - **And** all three refusals are decided by S03's exported joinability predicate – the join endpoint carries no second implementation of the rule

- [x] **S05 [OC02] [TI01,TI02] A code issued for an archived Conference is never reused and never resolves to a different Conference**
  - **Given** archived Conference "Retro 2025" holds code `EF45GH`
  - **When** further Conferences are published and generate codes
  - **Then** no newly published Conference is ever assigned `EF45GH` – the uniqueness constraint spans archived rows – and an employee submitting `EF45GH` is refused as archived rather than joined to any other Conference

- [x] **S06 [OC03] [TI07,TI08] Regenerating the code invalidates the old one immediately and keeps every existing Attendee**
  - **Given** "Kickoff 2026" has code `K7RM4P` and 40 Attendees, and Priya is an Admin of it
  - **When** Priya views the code and then regenerates it, yielding `Q4XT8B`
  - **Then** the very next submission of `K7RM4P` is refused as an unknown code, a submission of `Q4XT8B` joins successfully, and all 40 existing Memberships are intact

- [x] **S07 [OC04] [TI06] Failed attempts throttle the individual employee, not the venue, and the counter survives across API replicas**
  - **Given** ~100 signed-in employees are on the venue network, so every request arrives from one shared NAT egress IP address
  - **And** each of the 100 employees makes one failed attempt with a mistyped code
  - **When** an employee whose distinct `sub` has made only that one failed attempt submits the correct code
  - **Then** the join succeeds – no employee is throttled on the basis of the shared client address
  - **And** when one single `sub` exceeds the failed-attempt threshold within the window, that `sub` alone is refused as rate-limited while the other 99 continue to join normally
  - **And** that `sub`'s accumulated attempts are counted from shared server-side storage: attempts served by a different API replica, or after a process restart, still add to the same total rather than resetting

- [x] **S08 [OC04] [TI06] Concurrent failed attempts by one `sub` are all counted – none is lost to a lost update**
  - **Given** the threshold is 10 failed attempts per `sub` per rolling window and one `sub` has made none
  - **When** that same `sub` issues 10 failed attempts concurrently rather than one after another
  - **Then** the recorded attempt total for that `sub` is exactly 10 – no increment is lost to a read-modify-write race – and the 11th attempt is refused as rate-limited
  - **And** attempts landing either side of a window boundary are attributed to their own window, with none double-counted and none dropped

- [x] **S09 [OC02] [TI10] A refused employee can correct the code and retry immediately**
  - **Given** Nadia mistypes the code and receives the "No conference found with that code." refusal on the join screen
  - **When** she corrects the code and submits again without reloading the app or signing out
  - **Then** the retry is accepted and she joins – the refusal left the entry field usable, the submit control enabled, and the previously typed value available to edit rather than silently cleared
  - **And** when the refusal is the rate-limit one instead, the message tells her when she may try again rather than presenting a retry that is certain to fail


## Structural Criteria

- [x] Join-code uniqueness is enforced by the database across every Conference row, archived included – the constraint carries no lifecycle-state predicate that would exclude archived or ended Conferences.
- [x] Every authorization check this story introduces resolves through the single provisional per-conference authorization helper S03 established; no join-code endpoint contains an inline role comparison.
- [x] Joinability has exactly one definition in the codebase – S03's exported predicate. This story calls it and defines no second lifecycle-state or end-date test of its own.
- [x] This story adds no migration creating the Membership table; S03 owns that table's creation and the creator's seed row. S05's migrations touch only the Conference join code and the failed-attempt store.
- [x] The failed-attempt counter is updated by a single atomic statement per attempt – no read-then-write sequence over a counter row anywhere in the path.
- [x] The failed-attempt store does not grow without bound – rows outside the rolling window are pruned by the system itself, with no manual operational step.
- [x] Every refusal in this story is emitted through the shared JSON error envelope with both a user-facing message and a distinct machine code – no endpoint-local error shape.
- [x] Schema and limiter store use plain PostgreSQL only – no provider-specific extension and no managed cache service is introduced (ADR-003).
- [x] No handler retains join-attempt or rate-limit state in module, global, or other in-process scope between requests.
- [x] The join-code entry screen and the Organizer code panel are legible with no horizontal body scroll at 375px, 768px and 1280px.


## Scope & Boundaries

### Work Areas

- Conference schema: the `join_code` column and its all-rows uniqueness constraint.
- Join-code generation, hooked into the S03 publish transition.
- The join endpoint – code normalization, lookup, S03's joinability predicate, and writing an Attendee Membership row into the table S03 created, idempotently.
- Organizer join-code view and regenerate endpoints, routed through the provisional authorization helper.
- Failed-attempt store (schema, atomic recording, windowed count, retention) and the limiter check on the join endpoint.
- Attendee join-code entry UI including the retry affordance after a refusal, and the Organizer code panel UI.

### What We're NOT Doing

- The Membership table itself -- S03 creates it in its migration and seeds a Membership plus an Admin Role Assignment for the Conference's creator, so the creator is a member of their own Conference from the moment it exists. S05 writes Attendee Membership rows into that table and must not duplicate the migration.
- A second definition of joinability -- S03's exported predicate is the single definition and already carries the end-date rule; S05 consumes it. Two implementations of one invariant is the pattern S07's authorization retrofit exists to prevent.
- Leaving a Conference and Admin removal of a member -- S08 owns Membership revocation; S05 only creates Memberships.
- What the Attendee sees after joining -- the schedule view is S06; this story ends at the Membership existing.
- The canonical per-conference role check -- S07 generalizes the provisional helper; S05 consumes the provisional signature and adds no role model of its own.
- Non-disclosing or enumeration-proof refusals -- deliberately rejected by the PRD: sign-in already restricts access to the company domain, so an unhelpful refusal on the morning of day one costs more than it protects.
- Code expiry, invite links, and QR codes -- not in FR3; the code is the only join mechanism in this release.


## Architecture Decision

**Approach**: Failed join attempts are recorded in a plain PostgreSQL table as **one appended row per failed attempt**, keyed on the authenticated `sub` with an attempt timestamp; the limiter decides by a windowed `COUNT(*)` over the rolling window, and a retention sweep prunes rows older than the window.
**Why this over alternatives**: An in-process counter is disqualified outright – ADR-004 replaced Azure Functions with a long-running container API, but the rule survives with a new reason: the API scales horizontally across replicas, so a module-level or static counter is per-replica and enforces nothing. A managed cache is undecided infrastructure (`docs/DECISIONS.md` → Pending) for a write rate of at most a few hundred attempts over a conference, so the database this story already writes to is sufficient and stays portable per ADR-003. Append-per-attempt is chosen over a single mutable counter row because it is atomic by construction – no read-modify-write to lose increments when one `sub` fails several times concurrently – and because it makes window rollover trivially correct: the window is a predicate on the timestamp, not a field that must be reset. `INSERT ... ON CONFLICT DO UPDATE SET count = count + 1` on a `(sub, window)` row is the acceptable alternative if row volume ever justifies it; a plain `SELECT` then `UPDATE` is not.


## Code Patterns & External References

```
# type | path#anchor or url                                                     | why needed (intent)
doc    | docs/specs/conference-setup-and-schedule/plan.json#sharedDecisions      | Error envelope, authenticated-caller context, and the provisional authorization helper – consume unchanged
doc    | docs/specs/conference-setup-and-schedule/plan.json#stories              | S03 lifecycle states and publish transition, S04 Session/`lastUpdatedAt` surface this story extends
fis    | docs/specs/conference-setup-and-schedule/s03-conference-lifecycle.md    | The Membership table and creator seed, and the exported joinability predicate this story consumes rather than re-implements
adr    | docs/adrs/ADR-004-containerized-api-and-spa.md                          | Container API, not Functions; why the no-in-process-state rule still binds the rate limiter
url    | https://www.crockford.com/base32.html                                   | Rationale for excluding I, L, O and U from a human-transcribed alphabet
```


## Constraints & Gotchas

- **Critical**: the limiter's identity is the authenticated `sub`, never the client IP -- the venue fronts ~100 employees behind one NAT egress address at exactly the moment of peak joining, so an IP-keyed limiter locks out the very scenario the rule exists to protect. Must handle by: reading the `sub` from the S02 caller context and never touching a request-address header.
- **Critical**: the attempt counter is shared server-side state -- the API is a long-running container (ADR-004), but it scales horizontally, so process memory is per-replica and enforces nothing (`AGENTS.md` → never rely on in-process state). Must handle by: persisting every attempt; a module-level map, a static field, or a per-instance cache is a defect even if tests pass locally against a single replica.
- **Critical**: the limiter must be correct under concurrency -- the PRD's peak-joining scenario is ~100 employees joining at once, so concurrent failed attempts by one `sub` are the expected case, not the exotic one. Must handle by: one atomic statement per attempt – an appended row, or `INSERT ... ON CONFLICT DO UPDATE SET count = count + 1`. A `SELECT` followed by an `UPDATE` loses increments, and a separate "window start" field that a handler resets races on rollover.
- **Constraint**: attempt rows accumulate and nothing prunes them by default -- Workaround: retention is part of this story. Delete attempt rows older than the rolling window (a sweep on write, or a scheduled prune inside the API container); the store never grows beyond roughly one window's worth of failures. Retention must not be a manual operational task.
- **Constraint**: join-code uniqueness spans archived and ended Conferences -- a code circulated for a past conference must fail rather than silently resolve to a different one. Workaround: never scope the unique constraint or the lookup to active lifecycle states.
- **Constraint**: joinability ends at the Conference's end date, independent of the manual archive step -- a Conference still in `published` state whose end date has passed refuses joins. Workaround: this rule lives in S03's exported joinability predicate (S03 TI02/TI10), which absorbs it; S05 calls that predicate from the join, re-join and refusal paths and writes no lifecycle-state or end-date test of its own. If the predicate as landed does not yet carry the end-date rule, extend it in place – do not add a local check alongside it.
- **Avoid**: inline role conditionals at the code-view and regenerate endpoints -- Instead: route every check through the provisional per-conference authorization helper from S03, so S07 replaces one call-site pattern.
- **Avoid**: non-disclosing refusals ("invalid code") for draft, archived, or ended Conferences -- Instead: name the reason. The code is not a security boundary; Google Workspace sign-in already restricts to employees.
- **Assumption** (recorded, PRD does not specify): the code alphabet is `23456789ABCDEFGHJKMNPQRSTVWXYZ` – digits 0/1 and letters I, L, O, U excluded as visually ambiguous – at length 6, giving ~7.3e8 codes.
- **Assumption** (recorded, PRD names no number): the limiter permits 10 failed attempts per `sub` per rolling 10 minutes, then refuses further attempts for the remainder of the window. Successful joins do not consume the allowance. The rate-limit refusal message states when the employee may try again – PRD Flow 5's "option to retry" would otherwise be a control certain to fail.


## Implementation Plan

### Implementation Tasks

- [x] **TI01** Conference carries a join code that is unique across every Conference row, archived ones included
  - Nullable `join_code` column (absent until published, per `prd.md#data-requirements`) storing the canonical uppercase form, with a database-level unique constraint carrying **no** lifecycle-state predicate. Plain PostgreSQL only (ADR-003); migration is reversible per the S01 tooling.
  - **Verify**: `Test: inserting a second Conference whose join_code equals an archived Conference's join_code is rejected by the database constraint, not only by application code`

- [x] **TI02** Publishing a Conference generates its join code from the ambiguity-free alphabet
  - Hooks into the S03 draft → published transition; draws from `23456789ABCDEFGHJKMNPQRSTVWXYZ` at length 6 and retries generation on the TI01 uniqueness violation. Republishing is not a code-changing event – regeneration is TI08.
  - **Verify**: `Test: publishing many Conferences yields codes composed only of that alphabet (no 0, 1, I, L, O, U), all distinct, and each Conference has no code before publish`

- [x] **TI03** Code lookup resolves regardless of the case and incidental formatting the employee typed
  - Normalize submitted input – trim, strip internal whitespace and hyphens, uppercase – before comparing against the canonical stored form from TI01. One normalization function shared by the join, re-join and refusal paths.
  - **Verify**: `Test: " k7rm4p ", "k7rm4p", "K7RM-4P" and "K7RM4P" all resolve to the same Conference`

- [x] **TI04** A signed-in employee joining a joinable Conference gains exactly one Attendee Membership, keyed on `sub`
  - Writes into the Membership table **created by S03's migration** – S05 adds no migration for it and does not redefine its shape. Membership links the caller's validated `sub` from the S02 caller context to the Conference – never the email address. Re-submitting a code for a Conference the caller already belongs to succeeds without creating a second Membership, including for a caller who already holds a Membership from another path (the creator's seed from S03, an Admin opening the attendee view of their own Conference). Uses the TI03 normalization and the TI05 refusal path.
  - **Verify**: `Test: a valid join creates one Membership row for that sub and conference; an immediately repeated call returns success and leaves the row count unchanged; a Conference creator (who already holds a Membership seeded by S03) submitting their own code succeeds as a no-op and gains no second Membership; this story's migrations contain no CREATE TABLE for Membership`

- [x] **TI05** Non-joinable and unknown codes are refused with the reason named, decided by S03's joinability predicate
  - Joinability is **not** defined here: the join endpoint calls the predicate S03 exports (S03 TI02/TI10), which is the single definition and carries both the lifecycle-state rule and the end-date rule. Distinct machine codes and user-facing messages for unknown ("No conference found with that code."), draft, archived, and ended; all emitted through the S01 error envelope (`plan.json#sharedDecisions`). No Membership is written on any refusal.
  - **Verify**: `Test: the unknown, draft, archived and past-end-date cases each return their own machine code and a message naming that reason – no two return the same envelope, and none is a generic refusal; a grep of this story's modules finds no lifecycle-state or end-date comparison outside the call to S03's predicate`

- [x] **TI06** Failed join attempts are throttled per authenticated `sub` from a shared, atomically-updated server-side store
  - Plain PostgreSQL store recording failed attempts against `sub`. Recording is **one atomic statement per attempt** – an appended row carrying `sub` and an attempt timestamp, with the limiter deciding by `COUNT(*)` over the rolling window; `INSERT ... ON CONFLICT DO UPDATE SET count = count + 1` on a `(sub, window)` row is the permitted alternative. A `SELECT` then `UPDATE`, or a handler-reset window field, is a defect. Recorded only on refusal (TI05), never on success. The client address is not read at any point in this path, and no attempt state is held in module, global, or static scope – the API scales across replicas (ADR-004, `AGENTS.md`).
  - **Verify**: `Test: one sub exceeding the threshold is refused as rate-limited while other subs on the same client address join normally; N concurrent failed attempts by a single sub record exactly N attempts with none lost, and the (N+1)th is refused; the accumulated total is readable from the database and attempts recorded by a separate API process add to the same total rather than restarting it`

- [x] **TI07** An Admin of a Conference can view its current join code
  - Authorization goes through the provisional per-conference authorization helper S03 established (`plan.json#sharedDecisions` → Per-conference authorization primitive) – no inline role comparison at this or any other join-code endpoint.
  - **Verify**: `Test: an Admin of the Conference receives the code; a member without Admin and a non-member are each refused through the shared error envelope – and the join-code endpoints contain no role check that bypasses the provisional helper`

- [x] **TI08** Regenerating a Conference's code replaces it immediately and removes no Attendee
  - Same generation rules and uniqueness constraint as TI01/TI02, same authorization path as TI07. The previous code is not retained anywhere, so it thereafter refuses exactly like an unknown code. Existing Memberships are untouched.
  - **Verify**: `Test: after regeneration the previous code is refused as unknown on the next request, the new code joins successfully, and the Conference's Membership count is unchanged`

- [x] **TI09** The join-code entry screen and the Organizer code panel are legible across the three target widths
  - Fluid layout per `AGENTS.md`; the code input, the current code, the regenerate control and the refusal message all remain fully visible and non-clipped.
  - **Verify**: `Screenshots at 375px, 768px and 1280px show the code input, the displayed code and a refusal message fully visible with no horizontal body scroll`

- [x] **TI10** A refused join leaves the employee able to retry without leaving the screen
  - Per PRD User Flow 5 ("refused with a clear message **and the option to retry**"): after any refusal the entry field stays enabled with the submitted value available to correct, the submit control is re-enabled, and the refusal message is replaced rather than stacked on the next attempt. The rate-limit refusal is the one case that does not invite an immediate retry – it states when the employee may try again instead of offering a control that is certain to fail.
  - **Verify**: `Test: after an unknown-code refusal the input and submit control are enabled and retain the typed value, and a corrected resubmission from the same screen joins successfully; after a rate-limit refusal the message states when to retry`

- [x] **TI11** Failed-attempt rows do not accumulate without bound
  - Attempts older than the rolling window are pruned automatically – a sweep performed alongside recording, or a scheduled prune running inside the API container. Pruning never removes attempts still inside a live window, and never depends on a manual operational step.
  - **Verify**: `Test: after attempts age past the window the store no longer retains their rows, while attempts inside the current window survive the prune and still count toward the threshold`

### Testing Strategy

- TI06 needs the limiter tested against *shared* storage rather than a single warm process: exercise it through at least two distinct API processes (or an explicitly reset in-process environment) so an accidental in-process counter fails the test instead of passing it.
- TI06 also needs an explicit **concurrency** test, not only a sequential one: fire the threshold's worth of failed attempts for a single `sub` in parallel against the real database and assert the recorded total equals the number of attempts. A sequential loop passes against a read-modify-write counter that loses increments in production, so the sequential test alone proves nothing about atomicity. Include a case where attempts straddle a window boundary.
- TI11's retention test must distinguish pruned-because-aged from pruned-too-eagerly – assert both that old rows are gone and that in-window rows still count toward the threshold after a prune has run.
- TI01's uniqueness assertion must hit the real database constraint, not an application-level pre-check – an application-only guard passes a mocked test while still allowing a duplicate under concurrent publishes.
- TI05 is proved partly by inspection: the absence of a second joinability implementation is a grep-level assertion, since a duplicated rule passes every behavioural test until the two copies drift.

### Execution Contract

- Requires S03 (lifecycle states, publish transition, provisional authorization helper, **the Membership table and its creator seed**, and **the exported joinability predicate including the end-date rule**) and S04 (Sessions, since publish requires at least one Session) to have landed – the publish hook in TI02 has no anchor otherwise, and TI04/TI05 have nothing to write to or call.
- TI01 precedes TI02 and TI08 (both depend on the uniqueness constraint); TI03 and TI05 precede TI04 (join consumes normalization and the refusal path); TI05 precedes TI06 (the limiter records on its refusals); TI06 precedes TI11 (retention prunes what TI06 records); TI05 and TI06 precede TI10 (the retry affordance renders both refusal shapes).


## Implementation Observations

> _Managed by exec-spec post-implementation – append-only._

### Run: 2026-08-17 16:11 UTC – observations

#### NOTICED BUT NOT TOUCHING
- `docs/specs/conference-setup-and-schedule/plan.json` records S03 as `spec-ready` although S03's code has landed (membership table, `isJoinable`, `createConferenceAuthorization` all present and consumed by S04/S05) and S04 is `done`. Plan-status drift only; left untouched as outside S05's scope. Will mislead the next exec-plan run.
- Commit `fc97fa7` carries all 19 S05 implementation files under the message "checkin files for S04", duplicating the previous commit's subject. Made outside the exec-spec run; no remote exists, so a reword would fix it. Not amended without authorisation.
- `docs/LEARNINGS.md` retains template placeholder bullets (`- ...`) under `## [Topic Area 1]` and `## Process & Tooling`. The ops `add` form is not authorised to prune them.
- Review finding F3 (LOW, accepted): the limiter's *decision* is check-then-act, so a burst of concurrent attempts can overshoot the threshold by roughly the connection-pool concurrency before the pause engages. The counter itself is atomic (Structural Criterion 5 holds). Inherent to the design the FIS's Architecture Decision specifies (`the limiter decides by a windowed COUNT(*)`, i.e. a read) combined with the required check-before-lookup ordering. The Join Code is not a security boundary, so a deterrent that overshoots slightly is acceptable; tightening it would need the check and the record merged into one statement, which the required ordering forbids.
- Review finding F4 (LOW, accepted): `JOIN_CONFERENCE_NOT_PUBLISHED` carries two meanings - a join refused because the conference is a draft, and a regenerate refused because no code has been minted yet. Status code plus endpoint disambiguate them; a dedicated code would be a contract addition the FIS did not ask for.
- Visual validation on this machine cannot use `npm run screenshots` against the composed stack after a source change: the SPA container serves a stale build and `docker` is not on PATH (WSL-only). Run `npm run dev:web` and pass `WEB_URL` instead - and note Vite binds IPv6-only here, so the URL must be `http://[::1]:<port>`, not `127.0.0.1`.
