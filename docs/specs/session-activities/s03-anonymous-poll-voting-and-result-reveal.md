# S03 – Anonymous Poll voting and result reveal

**Plan**: docs/specs/session-activities/plan.json
**Story-ID**: S03

## Feature Overview and Goal

> **Superseded terminology, 2026-08-29 (ADR-007).** Every `round.activity_watermark_at` below refers to what is now **`round.activity_watermark`** - a `bigint` defaulted from one global sequence, not a timestamp. More importantly for this story: **TI02's ballot trigger no longer exists.** A cast Vote advances no cursor at all, and a Session Assignment holder's tally reaches them by refetching on the existing tick instead. The amendments are recorded in full under `## Implementation Observations`, whose `Old:` fences quote the superseded wording verbatim and are the audit trail - **those quotations are deliberately not updated**, and neither is the body above them, which stays the record of what this story specified and built.

**Intent**: Leadership only gets an honest read on employee sentiment if a person can answer a question in a room full of colleagues knowing the answer cannot reach a colleague, a facilitator, the report or leadership – so this story makes that unlinkability a property of what is stored and of every path the application can take, not a promise the interface makes.

**Expected Outcomes**:

- [OC01] A Conference Member casts exactly one, final Vote in an open Poll and can see that it registered; a second attempt is refused without revealing anything about the tally.
- [OC02] The tally is visible to a Session Assignment holder while the Poll runs and to every Member once it closes – including on a return to the Session days later – and a Poll closed with no Votes reads zero rather than erroring.
- [OC03] No surface anywhere returns per-voter detail: the only Vote-shaped output the API can produce, at any point and for any actor, is a count per option.

## Required Context

- `docs/adrs/ADR-006-vote-anonymity-holds-against-application-paths-not-database-credentials.md` – **Accepted, and the authority on this story's central guarantee. Read it in full before writing the migration.** It settles exactly how far anonymity reaches: unlinkable through every application path; *not* unlinkable against a holder of direct database credentials, because the ballot row and the has-voted row are written in one transaction and therefore share an `xmin`, a system column any role with ordinary `SELECT` can join on. The residual is **accepted**. The single transaction stays; splitting the writes, `SECURITY DEFINER` machinery and per-option counters were each considered and **not chosen** – do not re-open them here. The ADR also forbids any document claiming that correlation needs raw table access, superuser rights or filesystem access: it needs ordinary `SELECT`, and a wrong reassurance in a schema comment is worse than no comment.
- `docs/specs/session-activities/prd.md#fr4-anonymous-poll-voting` – the story's primary behavioural contract: one Vote per Member per Poll, final once cast, the has-voted fact recorded server-side, and the refusal reasons in its Validation and Error Handling blocks. Read its two anonymity criteria **through ADR-006**: "no query can reconstruct the link" and "including by ordering or timestamp correlation" bind over declared columns and application query paths, which is the scope `prd.md#constraints` and `plan.json#bindingConstraints[FR4]` now state. See the `NOTICED:` entry in Constraints & Gotchas.
- `docs/specs/session-activities/prd.md#constraints` – the amended Binding Constraint FR4, which is the wording to cite: *"A Vote must be unlinkable to its voter through **every application path** … The guarantee explicitly does **not** extend to a holder of direct database credentials … No document may claim that correlation requires raw table access or elevated rights – ordinary `SELECT` suffices."* Three further Binding Constraints land here unnarrowed: plain PostgreSQL only (ADR-003); no in-process state between requests; offline support does not widen beyond schedule reads and Post-it queueing.
- `docs/specs/session-activities/prd.md#fr5-poll-result-reveal` – who may read the tally and when: Session Assignment holder while open, every Member on close, an Attendee's own view showing only whether *they* have voted. Note the explicit rule that an open-Poll tally request from a non-assigned actor is **refused rather than returned empty**, so absence is not itself a signal.
- `docs/specs/session-activities/prd.md#fr3-named-post-it-contribution` – Binding Constraint reused here in its identity form: *author identity is taken from the authenticated credential, never from the request body*. For a Vote the credential establishes eligibility and single-use only, and is never carried onto the ballot.
- `docs/specs/session-activities/prd.md#fr1-round-authoring` – the freeze rule this story makes real: a Poll's question and options are frozen from the moment its first Vote exists, and the edge case *"Facilitator edits Poll options after the first Vote → Refused"*. S01 built the guard against a port that answers `false`; nothing freezes until this story discharges it (see TI08).
- `docs/specs/session-activities/prd.md#user-stories` – US05 (answer untraceably), US06 (know it registered, second attempt refused without revealing the tally), US07 (Facilitator watches the tally build), US08 (result on close), US11 (a Member returning later still sees each Round's own state, closed Polls showing their result).
- `docs/specs/session-activities/prd.md#data-requirements` – the entity shapes this story writes: **Vote** belongs to one Round and one option and *carries no voter reference of any kind*; the **has-voted fact** is recorded so single-use can be enforced with no declared path from it to a ballot.
- `docs/specs/session-activities/plan.json#sharedDecisions` – four decisions bind this story. S01 owns the Round entity and its open/closed state (do not introduce a second notion of whether an Activity is running, and do not restate S01's scope). Authority splits as *Membership contributes, Session Assignment runs*. **Near-live propagation is one cursor for the whole bundle: S02's `round.activity_watermark_at` plus its cheap two-scalar poll endpoint** – S01 drops `roundsLastUpdatedAt` and its column, and this story's tally rides that same cursor and must advance it on ballot insert. The anonymity storage split – ballot and has-voted separate, unjoinable through declared columns – is pinned here and consumed by S05.
- `docs/specs/session-activities/plan.json#stories` – S03 depends on **both** S01 and S02 (`dependsOn: ["S01","S02"]`, `parallel: false`). S02 is not a sibling running beside this story; it has landed, and four of its artifacts are extended here rather than created (see *Scope & Boundaries → Integration seam with S02*).
- `db/migrations/20260817150000000_session.sql` – **two idioms to follow.** First, storage-level guarantees expressed as `CHECK` constraints and column-type choices with a comment saying *why the wrong value is unrepresentable rather than merely discouraged*. Second, the watermark idiom TI02 copies exactly: `clock_timestamp()` never `now()`, and `GREATEST(clock_timestamp(), col + interval '1 microsecond')` for strict per-row monotonicity. Plain PostgreSQL only; no `CREATE EXTENSION`.
- `db/migrations/20260817210000000_session-assignment.sql` – the identity idiom: rows key on `user_sub`, the OIDC `sub`, and on nothing else; no column keys, joins on, or uniquely identifies a person by email (ADR-002, `AGENTS.md`). Also the composite-FK idiom that makes a cross-scope row unwritable.
- `api/test/session-structure.test.ts` – the established shape for Structural Criteria asserted against the files on disk: read the migration, strip comments so the test cannot assert its own prose, and pin the load-bearing negatives. This story's anonymity criteria are written in this file's idiom, and are scoped to **declared** columns for the reason ADR-006 gives.
- `api/src/conferences/authorization.ts` – the single per-Conference authority seam, and its two entry points. **Contributing uses `requireMembership`**; the module documents that `requireConferenceRole(..., 'Attendee')` is *not* the check for "is this caller in this Conference" – its refusal is `CONFERENCE_ROLE_REQUIRED`, a sentence about permission to act, where a non-member must be told they have not joined, and Membership must be a row rather than something a grant implies. `requireConferenceRole` at `'PresenterFacilitator'` **with the `sessionId` narrowing** is the separate check for "holds a Session Assignment for this Session" (TI06). Never write an inline role comparison.
- `api/src/auth/with-auth.ts#AuthenticatedCaller` – the pre-existing verified-caller shape every route reads identity from. `caller.sub` is the OIDC `sub`; it is where the voter's identity comes from and the only place it may come from.
- `api/src/conferences/schedule-gate.ts#createScheduleGate` – the port-with-a-truthful-stub pattern and, more importantly, **its discharge**: the comment block records that an earlier story bound the port to a truthful `false` and that a named later story replaced one function body, leaving the state machine, the authorization check, the endpoint and the refusal message untouched. TI08 is the same move for `api/src/rounds/ballot-gate.ts`, and must carry the same comment discipline.

## Deeper Context

- `docs/specs/session-activities/s01-round-authoring-and-lifecycle.md#implementation-tasks` – TI04 creates `api/src/rounds/ballot-gate.ts` and its single freeze guard; TI07 is the Session-with-Rounds read this story extends; TI10 is `web/src/activities/SessionActivitiesPanel.tsx`, the panel the Poll card lives inside. S01 Structural Criterion "exactly one ballot-existence seam exists" is the criterion TI08 must leave true.
- `docs/specs/session-activities/s02-named-post-it-contribution.md#implementation-tasks` – the concrete propagation artifacts this story binds to: TI02's `round.activity_watermark_at` column and its trigger idiom, TI07's two-scalar Session watermark poll, TI08's single extracted client poll loop under `web/src`. Also TI06, the Session read this story extends alongside S02's Post-it Boards.
- `docs/adrs/ADR-002-authenticate-with-google-workspace-oidc.md` – why identity is the OIDC `sub` and never the email, and why confApp roles are its own per-Conference data.
- `docs/adrs/ADR-003-postgresql-containerized-development.md` – why portability, and therefore plain PostgreSQL, constrains the migration.
- `docs/adrs/ADR-004-containerized-api-and-spa.md` – why no handler may hold a tally, a watermark or a per-voter fact between requests.
- `docs/UBIQUITOUS_LANGUAGE.md#session-activities` – canonical terms: **Voting Round**, **Vote** ("a single anonymous ballot… never linkable to its voter"), **Poll**. This feature introduces no new domain vocabulary.
- `docs/specs/conference-setup-and-schedule/s09-live-schedule-editing.md` – the original watermark-poll pattern S02 generalised; read only if S02's surface leaves the tally seam unclear.
- `docs/specs/session-activities/prd.md#non-functional-requirements` – the ~5s propagation target, the "no per-Round request" rule for the Session read, and the 375/768/1280 px responsiveness bar.
- `docs/specs/session-activities/prd.md#edge-cases` – the voting rows: votes twice, reinstalls, Poll closed with zero Votes, options edited after the first Vote, Member leaves the Conference after contributing.
- `docs/LEARNINGS.md#testing` – two traps this story will otherwise hit: a regression test written beside its fix usually passes without the fix (revert and re-run before believing a guard), and a file-list assertion is only as good as its longest omission (pair one with a behavioural assertion that does not know the list).

## Acceptance Scenarios

- [x] **S01 [OC01] [TI04,TI05,TI09] A Member casts one Vote in an open Poll and their own view says so**
  - **Given** a Poll Round on a Session is open with options "Yes", "No" and "Not sure", and Ada holds a Conference Membership but no Session Assignment
  - **When** Ada chooses "Not sure" and submits
  - **Then** the Vote is accepted, and Ada's view of that Round shows that she has voted and offers no way to change or withdraw it

- [x] **S02 [OC01,OC03] [TI05,TI09] A second attempt is refused and the refusal reveals nothing about the tally**
  - **Given** Ada has already voted in the open Poll and eleven other Members have voted
  - **When** Ada submits a Vote for "Yes"
  - **Then** the request is refused with a displayable sentence saying she has already voted, no second ballot exists, and the refusal body carries no counts, no per-option data and no total

- [x] **S03 [OC01] [TI04,TI05] A Member who reinstalls the app is still recorded as having voted**
  - **Given** Ada has voted in the open Poll, and every trace of the app's local state on her device is cleared and she signs in again
  - **When** she opens the Session and submits a Vote for "Yes"
  - **Then** the request is refused as already voted – the fact is server-side and survives the device losing everything it held

- [x] **S04 [OC02,OC03] [TI02,TI06,TI07,TI09,TI10] While the Poll is open the tally builds for the Facilitator alone, and an Attendee is refused rather than shown an empty one**
  - **Given** the Poll is open with three Votes cast, Grace holds a Session Assignment for that Session and Ada holds only a Membership
  - **When** Grace reads the Round, a fourth Member votes while Grace's screen is open, and then Ada reads the same Round
  - **Then** Grace's tally moves from three to four without her touching anything, and Ada's request for the tally is refused with a sentence saying results appear when voting ends – not an empty or zeroed tally, so absence is not itself a signal

- [x] **S05 [OC02] [TI06,TI07,TI09] On close the tally becomes visible to every Member, and a Poll closed with no Votes reads zero**
  - **Given** one Poll closed after three Votes and a second Poll closed with none cast
  - **When** Ada, holding only a Membership, reads both Rounds
  - **Then** the first shows a count per option totalling three and the second shows zero against every option, rendering normally rather than erroring

- [x] **S06 [OC02] [TI07,TI09] Returning to the Session days later, a closed Poll still shows its result**
  - **Given** Ada has not opened the app since the Session ran, and that Session holds one closed Poll and one Poll never opened
  - **When** she opens the Session
  - **Then** both Rounds are listed with their own state in the same read that returns the Session – no per-Round request – and the closed Poll shows its counts

- [x] **S07 [OC01,OC03] [TI05] A Vote into a closed Poll, and a Vote for an option that is not on the ballot, are each refused by name**
  - **Given** one Poll that has been closed and one open Poll whose options are "Yes" and "No"
  - **When** Ada submits a Vote into the closed Poll, and then submits into the open Poll an option id belonging to a different Poll
  - **Then** the first is refused naming the Round's state using S01's existing closed-Round refusal, the second is refused as an unknown option, and neither writes a ballot or a has-voted fact

- [x] **S08 [OC01] [TI08] Once a real Vote exists, the Poll's question and options are frozen against a live Facilitator edit**
  - **Given** Grace holds a Session Assignment for the Session, her Poll "Where should we start?" is open, and Ada has cast one Vote through TI05 – a real ballot row, not a test-injected port
  - **When** Grace edits the Poll's option list, and then edits its question text
  - **Then** both are refused with S01's existing frozen-content code, the stored question and options are byte-identical afterwards, and the Post-it Round on the same Session still accepts a prompt edit – so a closed tally always answers the question it was cast against
  - **Proof**: S01's Acceptance Scenario S07, re-run **unmodified** against the discharged port

## Structural Criteria

> The story's load-bearing acceptance. A screen that never displays a voter proves nothing about whether the rows could be joined, so each of these is asserted against the schema and the source and is proved by a task Verify line.
>
> **Read the scope statement before the criteria.** ADR-006 is Accepted and governs: these criteria assert over **declared** columns, constraints, indexes, triggers and application query paths – the surface `prd.md#constraints` names and the only surface any application, export or report can reach. They do **not** assert over PostgreSQL's MVCC system columns (`xmin`, `ctid`, `tableoid`, `cmin`, `cmax`), which are present on every table and which a holder of direct database credentials can join on to obtain an exact voter→ballot pairing. That residual is accepted, is bounded operationally by who holds those credentials, and is invisible to every test below. A green suite here proves that **no application path relates a Vote to its voter** – it does not prove correlation is impossible.

- [x] The ballot table declares a reference to its Round and a reference to its chosen option **and nothing else**: no declared column of any kind references, contains, hashes, encrypts, derives from or is defaulted from a user identity – no `user_sub`, no `app_user` foreign key, no email, no device, client or auth-session identifier – asserted against the migration file itself.
- [x] Neither the ballot table nor the has-voted table **declares** a timestamp column, a `serial`/`bigserial`/identity/sequence-defaulted column, or any other declared column whose value orders rows by when they were written; primary keys on both are random (`gen_random_uuid()`). *Scoped as stated above*: `xmin` is assigned monotonically and does order rows by write time, which no declaration can prevent – this criterion is the assertion that nothing **declared** adds a second such ordering, not a claim that none exists.
- [x] Among **declared** columns, `round_id` is the only one the two tables have in common, and no declared value is unique-per-Vote across both – so every query the application can issue over declared columns yields the set of ballots and the set of voters for a Round, never a pairing. *Scoped as stated above*: the two tables also share the system columns `xmin`, `ctid`, `tableoid`, `cmin`, `cmax`, and a join on `round_id` and `xmin` does pair them exactly. This criterion does not claim otherwise (ADR-006).
- [x] No declared index, unique constraint, foreign key, trigger or view in any migration relates the ballot table to `app_user`, to the has-voted table, or to any membership, role-assignment or session-assignment table beyond that shared `round_id`.
- [x] **Superseded 2026-08-29 by ADR-007, by explicit owner override of the design-change form's Structural-Criteria prohibition. The ballot table now carries NO trigger, and any trigger attached to it is a defect.** As shipped, this criterion permitted exactly one `AFTER INSERT` trigger there, advancing the Round's activity watermark and doing nothing else, on the reasoning recorded below. ADR-007 removed it: because the cursor is read as `max(...)` scoped to a single Session, its change event was a noiseless vote-arrival oracle for any Conference Member on an unthrottled endpoint, and no property of the *value* could fix a leak carried by the *event*. What this story ships now is an `AFTER INSERT OR UPDATE OR DELETE` trigger on `round_option`, attached to S02's single advance function; the ballot table has none, which is strictly stronger than this criterion originally permitted. **Do not restore the ballot trigger to satisfy the text below** - `db/migrations/20260831090000000_vote-advances-no-cursor.sql` drops it deliberately, and `api/test/vote-structure.test.ts` asserts its absence. The reasoning that follows is retained as the record of what was believed at execution time, and is superseded in its conclusion, not in its analysis. **What it reveals, stated for each reader rather than in general**: to a Session Assignment holder, no more than the moving tally they are already watching – which is the migration's own careful wording in `20260829090000000_vote.sql` and the whole of the justification. It does *not* hold for an Attendee, who is deliberately refused a running Poll's tally so that not voting carries no signal (`prd.md#fr5-poll-result-reveal`) and who may nonetheless poll the Session's cursor for as long as the Poll runs. That is why the watermark is an opaque counter and not the microsecond instant this story shipped against: the instant handed every Conference Member the timing of each individual ballot. See `db/migrations/20260829120000000_activity-watermark-counter.sql`, which also records the residual the counter leaves – a global sequence, so that a difference between two polls is a floor on write volume and not a count of Votes, except in a deployment quiet enough that nothing else is writing.
- [x] No query in `api/src/` selects ballot rows individually, returns a ballot row to a caller, or joins the ballot table to any identity-bearing table: every read of it is an aggregate count grouped by option or an `exists` check that returns a boolean, and the tally response shape carries counts per option only.
- [x] Single-use is enforced by a database uniqueness constraint on the has-voted table, never by in-process state – the API runs across replicas with no request affinity.
- [x] Exactly one ballot-existence seam exists in the shipped source – S01's `api/src/rounds/ballot-gate.ts` port, now bound to an implementation that counts real ballot rows. No stub, constant, feature flag or second freeze rule remains anywhere in the Poll edit path, and S01's guard, refusal code, route and state machine are unchanged (S01 Structural Criteria).
- [x] The new migration uses plain PostgreSQL only – no `CREATE EXTENSION`, no provider-specific type or function – and is reversible: everything its up step creates, its down step drops.
- [x] Nothing in this story is cached offline or queued for later send: Votes and tallies are online-only, leaving the offline boundary exactly where S10 and S04 put it.
- [x] No comment, doc-block or schema comment added by this story claims that correlating a ballot with a voter requires raw table access, superuser rights, filesystem access or a backup. ADR-006 § Decision item 4 forbids it: ordinary `SELECT` suffices, and a wrong reassurance is worse than none.

## Scope & Boundaries

### Work Areas

- `db/migrations/` – one new migration adding the anonymous ballot table, the has-voted table, and an `AFTER INSERT OR UPDATE OR DELETE` trigger on `round_option` that advances the Round's activity watermark (the Round and option tables are S01's; the watermark column is S02's). **Amended 2026-08-29 by ADR-007**: the ballot-insert trigger this line originally named is dropped by a later migration - a Vote advances no cursor.
- `api/src/votes/` – new module: the vote repository (cast, has-voted lookup, aggregate tally, ballot-existence count) and its authority-and-state gate.
- `api/src/rounds/ballot-gate.ts` – **existing, S01's**: the ballot-existence port's implementation body is replaced with a real check over the ballot table, discharging S01's binding obligation. The interface, the guard that consumes it, and every call site stay exactly where they are.
- `api/src/routes/rounds.ts` – **existing, S01's, also extended by S02**: the cast endpoint and the tally read, registered on S01's Round surface.
- `api/src/errors.ts` – **existing, extended by S01 and S02**: refusal codes for this story's distinguishable reasons, one code per reason in the established idiom, reusing any existing code rather than adding a synonym.
- `web/src/activities/SessionActivitiesPanel.tsx` and a new Poll card beneath it – **the panel is S01's, also extended by S02**: option list, single choice, the voted state, the refusal, and the result.
- `api/test/vote-structure.test.ts` – new: the anonymity Structural Criteria asserted against the migration and the API source, in `session-structure.test.ts`'s idiom.

### Integration seam with S02

S03 depends on S01 **and** S02 (`plan.json` → `dependsOn: ["S01","S02"]`, `parallel: false`). S02 has landed before this story starts, so four artifacts arrive already extended by it. Each is **extended, never replaced**, and S02's behaviour must still hold afterwards:

1. **S01's Session-with-Rounds read handler and its projection** – S02 TI06 added the Post-it Boards; TI07 here adds each Poll's state, has-voted flag and permitted tally to the same single response.
2. **`web/src/activities/SessionActivitiesPanel.tsx`** (S01 TI10) – S02 TI09 added the compose box and named Board; TI09 here adds the Poll card beside them. One panel, one poll loop.
3. **`api/src/routes/rounds.ts`** – S01's authoring/lifecycle routes plus S02's contribution routes; TI05 and TI06 register beside them in the same `withAuth` → authority → state → write order.
4. **`api/src/errors.ts`** – reuse the existing name for any reason S01 or S02 already coded (closed Round, Round not found, frozen content); add codes only for already-voted, unknown-option and results-not-yet-available.

Propagation is a **binding**, not a fifth extension: S02's `round.activity_watermark_at`, its two-scalar Session watermark poll (S02 TI07) and its single extracted client poll loop (S02 TI08) are what TI02 and TI10 attach to. S01's `roundsLastUpdatedAt` no longer exists – do not reference it.

### What We're NOT Doing

- **The Round entity, its options, and its open/closed lifecycle** -- S01 owns all of it; this story consumes the state, the closed-Round refusal and the freeze guard rather than restating or re-deriving them (`plan.json#sharedDecisions`).
- **The Prioritization and Rating Voting Round purposes** -- explicitly out of this story's scope; only the Poll purpose ships here.
- **Changing or withdrawing a cast Vote** -- a Vote is final by decision, and it is *because* it is final that the has-voted fact can be stored with no declared link to the ballot (`prd.md#decisions-log`). Supporting a change would need exactly the link this story exists to prevent.
- **Hardening the MVCC residual** -- splitting the two writes across transactions, `SECURITY DEFINER` tally functions with `SELECT` revoked from the API role, per-option counters in place of ballot rows, and a `VACUUM FREEZE` on Round close were each weighed and **not chosen** (ADR-006 § What was considered). Do not implement any of them here, and do not re-argue the trade-off in this story's code or comments. ADR-006 records the revisit triggers.
- **Offline voting or a queued Vote** -- offline support does not widen beyond schedule reads and Post-it queueing (Binding Constraint FR6); a queued ballot would also need device-held state that a reinstall loses, breaking single-use.
- **A second near-live mechanism for tally refresh** -- the bundle has exactly one cursor, S02's `round.activity_watermark_at`; a new polling path, endpoint or socket here is the smell the PRD's dependency table names.

## Architecture Decision

**Approach**: A ballot is a row of *(Round, option)* with no voter column, no declared timestamp and a random UUID key; the has-voted fact is a separate row unique on *(Round, Member `sub`)*, likewise with no declared timestamp or sequence; the two are written in **one transaction** with the has-voted row claimed first so its uniqueness constraint is the single-use gate. See ADR: `docs/adrs/ADR-006-vote-anonymity-holds-against-application-paths-not-database-credentials.md`.
**Why this over alternatives**: keeping the two facts in separate tables with only `round_id` declared in common is what makes deanonymization unreachable from any application path – no declared column to join on, so no API response, screen, export or report can associate a Vote with its voter – and the single transaction is what stops a crash between the two writes from either double-counting a Member or silently swallowing their Vote. ADR-006 records the price: both rows carry the same `xmin`, so a holder of direct database credentials can pair them exactly with an ordinary `SELECT`. That residual is accepted rather than traded for a lost Vote with no retry path, and the control for it is who holds those credentials.

## Technical Overview

Three surfaces, one guarantee, honestly bounded. The **migration** carries the guarantee structurally: two tables, one declared column in common, no declared timestamps, random keys, `CHECK` constraints and comments in `20260817150000000_session.sql`'s idiom saying why each shape makes the wrong state unrepresentable – plus, per ADR-006, a comment stating the MVCC residual in the ADR's own terms and citing it, and claiming nothing about elevated rights. It also carries one `AFTER INSERT OR UPDATE OR DELETE` trigger on `round_option` advancing the Round's activity watermark, so an option edit reaches the room. **Amended 2026-08-29 by ADR-007**: a cast Vote deliberately has **no** producer for the near-live cursor; a Session Assignment holder's tally refreshes by refetching on the shared tick instead. The **API** casts a Vote through one transaction – claim the has-voted row (unique violation means already voted), then insert the ballot – with the voter's `sub` taken from `api/src/auth/with-auth.ts#AuthenticatedCaller` and never carried past the claim; the ballot table is read only as a count grouped by option or as an `exists` boolean, the latter being what discharges S01's ballot-existence port and finally makes the Poll freeze real. The **web** Poll card renders one of three states – not yet voted, voted, result – chosen by S01's Round state and the caller's authority, and refreshes its tally through S02's existing watermark poll.

## Code Patterns & External References

```
# type | path#anchor or url                                        | why needed (intent)
adr    | docs/adrs/ADR-006-vote-anonymity-holds-against-application-paths-not-database-credentials.md | The accepted anonymity posture – what the migration comment must say and must not say
file   | db/migrations/20260817150000000_session.sql               | Migration idiom – CHECK constraints + why-comments; the clock_timestamp()/GREATEST watermark idiom; plain PG only; reversible down step
file   | db/migrations/20260817210000000_session-assignment.sql    | Identity idiom – key on user_sub only, never email; composite FK making a cross-scope row unwritable
file   | api/test/session-structure.test.ts                        | Structural-criteria idiom – read the file on disk, strip comments, pin the load-bearing negatives
file   | api/test/migration-depth.ts#stepsToRevertThrough          | Reversibility test helper – never hard-code a migration count
file   | api/src/conferences/authorization.ts#requireMembership    | The contribute-side authority check (cast + Member tally read)
file   | api/src/conferences/authorization.ts#requireConferenceRole| The run-side check, with the sessionId narrowing, for the open-Poll tally
file   | api/src/conferences/schedule-gate.ts#createScheduleGate   | Port discharge pattern and comment discipline TI08 copies – body replaced, seam and call sites untouched
file   | api/src/auth/with-auth.ts#AuthenticatedCaller             | Where caller.sub comes from – the only source of voter identity
file   | api/src/errors.ts#ERROR_CODES                             | Refusal-code idiom – one code per reason, message a displayable sentence
file   | api/src/routes/rounds.ts                                  | S01's Round route surface, already extended by S02 – register beside, in the same order
file   | api/src/routes/attendee.ts                                | Member-facing read shape, the two-scalar watermark poll, and the read-order comments to mirror
file   | api/src/sessions/session-repository.ts#createSessionRepository | Repository seam shape
file   | api/src/db.ts                                             | The Queryable type and the SQLSTATE 40P01 retry the ballot trigger's Round update must ride
```

## Constraints & Gotchas

- **Critical**: the anonymity claim this story ships must match ADR-006 exactly -- Must handle by: never writing anywhere – comment, doc-block, schema comment or test name – that correlating a ballot with a voter needs raw table access, superuser rights, filesystem access or a backup. It needs ordinary `SELECT` on `xmin`. State the reach positively instead (every application path), state the residual, and cite the ADR by path. ADR-006 § Consequences names why a wrong reassurance is the worse failure – the next reader builds on it.
- **Critical**: the voter's `sub` must reach the has-voted claim and stop there -- Must handle by: taking it from `api/src/auth/with-auth.ts#AuthenticatedCaller` (never the request body, per Binding Constraint FR3) and passing it to no function that touches the ballot insert, the ballot-existence count or the tally read. Anything that would make a ballot writer *able* to see a `sub` is the defect, even if today it ignores it.
- **Critical**: a tally must never be reachable through a refusal -- Must handle by: refusing an Attendee's open-Poll tally request and a duplicate-vote attempt with a body that carries no counts, no totals and no per-option data. `prd.md#fr5-poll-result-reveal` refuses rather than returning an empty tally precisely so that absence carries no information; a "helpful" zeroed tally on the refusal path reintroduces the signal.
- **Constraint**: the ballot-insert trigger writes the Round row while a Facilitator may be updating that same row directly -- Workaround: route it through the existing SQLSTATE `40P01` retry in `api/src/db.ts`, exactly as S02's Post-it trigger does; do not add a second retry policy. It must not touch `conference.schedule_watermark_at` or `sessions.last_updated_at`.
- **Avoid**: writing a "just in case" audit or telemetry row alongside a Vote -- Instead: nothing beyond the two rows and the Round's watermark bump is written on the cast path. An audit trail recording who voted when, beside a ballot table recording what was voted when, is a join waiting for a reader – and unlike the MVCC residual it would be a declared one.
- **Avoid**: enforcing single-use with a pre-read ("has this member voted?") followed by an insert -- Instead: attempt the has-voted insert and treat the unique violation as the refusal. Two concurrent submissions from one Member both pass a pre-read (`docs/LEARNINGS.md#concurrency` – the same defect as a version compared in an earlier round trip).
- **Constraint**: 375 px is the design floor and the layout must rescale to 768 and 1280 -- Workaround: option rows and result bars use relative units; see `docs/LEARNINGS.md#css--responsive-layout` on `min-width: min(Xrem, 100%)` under OS font scaling.
- **NOTICED:** `prd.md#constraints` and `plan.json#bindingConstraints[FR4]` carry ADR-006's scoped wording, but two acceptance criteria under `prd.md#fr4-anonymous-poll-voting` still read maximally – *"no query can reconstruct the link"* and *"including by ordering or timestamp correlation"*. ADR-006 is Accepted and governs, so this FIS reads both as bounded to declared columns and application query paths. Reconciling the FR4 criteria text is the PRD owner's, not this story's; flagged so an executor does not implement the maximal reading by re-opening a rejected alternative.

## Implementation Plan

### Implementation Tasks

- [x] **TI01** A migration exists whose declared shape makes a voter-to-ballot link unreachable from any application path, and whose comment states the residual honestly
  - Two tables: the ballot, declaring only a Round reference and an option reference (with the composite-FK idiom of `db/migrations/20260817210000000_session-assignment.sql` so an option from another Poll is unwritable), and the has-voted fact, unique on *(round, `user_sub`)* with `user_sub` referencing `app_user`. Random `gen_random_uuid()` keys, no declared timestamp and no sequence on either. Comments explain *why* in `db/migrations/20260817150000000_session.sql`'s voice, and one comment records the MVCC residual **in ADR-006's terms**: both rows are written in one transaction and therefore share an `xmin`; `xmin` is a system column any role with ordinary `SELECT` can join on; the guarantee holds against every application path and not against a holder of direct database credentials; cite `docs/adrs/ADR-006-vote-anonymity-holds-against-application-paths-not-database-credentials.md`. **The comment must not claim raw table access, superuser rights or a backup is needed.** Plain PostgreSQL only; reversible down step.
  - **Verify**: `Test: the ballot table declares exactly a round reference and an option reference; neither new table declares a timestamp, serial, identity or sequence-defaulted column; no CREATE EXTENSION or provider-specific type or function appears; every table, index, constraint and trigger the up step creates the down step drops. Structure: the migration's comments contain none of the strings "raw table access", "superuser", "filesystem" or "backup" as a condition on correlating a ballot with a voter, and do contain a citation of ADR-006`

- [x] **TI02** A cast Vote advances **no** cursor (ADR-007); an option write advances the Round's activity watermark
  - **Amended 2026-08-29 by ADR-007 – this task is inverted. No trigger is attached to the ballot table.** As originally executed it added one `AFTER INSERT` row trigger there so a cast Vote advanced the Round's cursor. Because the cursor is read as `max(...)` scoped to a single Session, that made its change event a noiseless vote-arrival oracle for any Conference Member, on an unthrottled endpoint - while an Attendee is refused the running tally precisely so that absence carries no information. `db/migrations/20260831090000000_vote-advances-no-cursor.sql` drops it, reversibly, without editing the applied migration that created it. What this story does ship is an `AFTER INSERT OR UPDATE OR DELETE` trigger on `round_option`, attached to S02's single `advance_round_activity_watermark()` home, so an option edit still reaches the room. Acceptance Scenario S04 and the ~5s NFR are still satisfied, by a different route: a Session Assignment holder's client refetches the Session on each tick of the existing poll loop rather than waiting on a change signal, and the tally already rides the Session read payload. Round-level discipline is unchanged for the trigger that remains - it reads no identity, writes to no identity-bearing table, does not relate the ballot table to the has-voted table, and must not touch `conference.schedule_watermark_at` or `sessions.last_updated_at`.
  - **Verify**: `Test: casting a Vote leaves the Round's activity watermark **unchanged** and the Session's two-scalar poll value unmoved (ADR-007); an option write does advance it; closing the Poll advances it, so reveal-on-close still reaches an Attendee near-live; a Session Assignment holder's **rendered** tally still moves within the ~5s target on the shared tick with no user action; conference.schedule_watermark_at and sessions.last_updated_at are unchanged across both; S02's own post-it watermark tests pass unmodified. Structure: **no** trigger is declared on the ballot table (ADR-007 - a Vote advances no cursor), and exactly one is declared on `round_option``

- [x] **TI03** The anonymity guarantee fails the build if a later story adds an application path to it
  - New `api/test/vote-structure.test.ts` in `api/test/session-structure.test.ts`'s idiom, asserting the Structural Criteria against the migration and against every file under `api/src/`: no identity-bearing declared column or FK on the ballot table; `round_id` the only **declared** column shared with the has-voted table; no declared index, constraint, trigger or view relating the ballot table to `app_user`, to the has-voted table or to any membership, role-assignment or session-assignment table, with the single TI02 watermark trigger allow-listed **by name and shape**, not by a blanket exemption; no query selecting ballot rows individually or joining the ballot table to an identity-bearing table; and the ADR-006 comment-wording check from TI01. The suite's own header comment must state, in ADR-006's terms, what a green run does and does not prove – no assertion here inspects system columns, and none can. Per `docs/LEARNINGS.md#testing`, pair the file-list assertions with one that does not know the list, and assert each marker is found rather than skipping when absent.
  - **Verify**: `Test: adding a user_sub column to the ballot table, adding a created_at to either new table, adding a second trigger on the ballot table, and adding a query joining the ballot table to the has-voted table each turn this suite red; the suite is green against the shipped schema including TI02's trigger`

- [x] **TI04** Casting a Vote writes exactly two rows in one transaction, with the has-voted row as the single-use gate
  - New `api/src/votes/` repository. One transaction – kept as one, per ADR-006: splitting it was considered and rejected because it loses atomicity and only degrades the correlation rather than removing it. Insert the has-voted row first (a unique violation on *(round, sub)* **is** the already-voted refusal – never a pre-read, per Constraints & Gotchas), then insert the ballot. The `sub` is a parameter of the claim and reaches no other function here. The ballot table is exposed two ways only: a count grouped by option (returning zero for every option of a Poll with no Votes), and a boolean `exists` per Round for TI08. Follow `api/src/sessions/session-repository.ts#createSessionRepository` for the repository seam and `api/src/db.ts` for the `Queryable` type.
  - **Verify**: `Test: a successful cast leaves one ballot row and one has-voted row; a second cast by the same sub adds neither; two concurrent casts by one sub yield exactly one ballot; the tally of a Poll with no Votes returns every option at zero; the existence check returns false for a Round with no Votes and true after one`

- [x] **TI05** The cast endpoint admits a Member to an open Poll once, and refuses every other case by name
  - Registered on S01's Round surface in `api/src/routes/rounds.ts`, beside S02's contribution routes. Authority is Conference **Membership** via `api/src/conferences/authorization.ts#requireMembership` – **not** `requireConferenceRole(..., 'Attendee')`, which that module documents as the wrong check for this question (see Required Context), and **not** a Session Assignment (`plan.json#sharedDecisions` → authority split). S02 TI04 uses `requireMembership` for the same reason; match it. Voter identity is `caller.sub` from `api/src/auth/with-auth.ts#AuthenticatedCaller`, never the body. Checks in fixed order: authority, S01's Round-open state (reuse S01's existing closed-Round refusal code – do not add a second), option belongs to this Poll, then TI04's claim. New codes in `api/src/errors.ts#ERROR_CODES` for already-voted and unknown-option, each a displayable sentence, reusing any existing code for a reason S01 or S02 already registered. No refusal body carries counts.
  - **Verify**: `Test: a Member's first cast succeeds; a second is refused as already voted with a body containing no counts or totals; a cast into a closed Poll is refused naming the state; an option id from another Poll is refused as unknown; a caller holding a role_assignment but no membership row is refused; a voter id supplied in the request body has no effect on which Member is recorded`

- [x] **TI06** The tally read is gated by Round state and actor, and refuses rather than returning an empty tally
  - While the Round is open, only a holder of a Session Assignment for that Session may read it – `requireConferenceRole` at `'PresenterFacilitator'` with the `sessionId` narrowing, which an Admin passes on conference-wide authority. Once closed, every Conference Member may, gated with `requireMembership`. An Attendee asking for an open Poll's tally is refused with a new code whose message says results appear when voting ends. The response shape is counts per option and nothing else, at every point and for every actor.
  - **Verify**: `Test: an assigned Facilitator reads an open Poll's tally; an Attendee's request for the same is refused with the results-appear-later message and no counts in the body; after close the same Attendee reads the tally; a non-member is refused after close too; the response carries no field other than per-option counts`

- [x] **TI07** The Session read carries each Poll's own state, the reader's has-voted fact, and the tally where permitted
  - Extends the Session-with-Rounds read S01 delivers and S02 TI06 already extended with Post-it Boards – one handler, one projection, no new request, because the NFR is one read for a Session and its Rounds (`docs/specs/session-activities/prd.md#non-functional-requirements`). For each Poll it carries the Round state, whether **this** caller has voted, and the tally only where TI06's gate permits it; for an Attendee on an open Poll it carries the has-voted flag and no tally. A closed Poll carries its counts whenever the Session is read, however long afterwards. Mirror the member-facing read shape in `api/src/routes/attendee.ts`. S02's Board fields must be unchanged in the same payload.
  - **Verify**: `Test: one request returns the Session with every Round and no per-Round request follows; an Attendee's payload for an open Poll carries the has-voted flag and no counts; a closed Poll carries counts for an Attendee reading days later; a Round never opened is listed with its own state; S02's post-it Board assertions on this same read pass unmodified`

- [x] **TI08** S01's ballot-existence port answers from real Vote storage, so a Poll's question and options actually freeze
  - `api/src/rounds/ballot-gate.ts` is S01's, bound there to an implementation truthfully answering `false` because no Vote storage existed. **This task discharges that binding obligation**: replace the implementation body with TI04's `exists` check over the ballot table for the Round, following `api/src/conferences/schedule-gate.ts#createScheduleGate` including its comment discipline – the comment records which story introduced the port, that this story discharged it, and that the guard, the refusal code, the routes and the state machine are untouched. Beyond that body the one permitted widening is the transactional envelope the DECISION NOTE for `poll-freeze-toctou-discharge` requires: the freeze check and the Poll content UPDATE run in one transaction with the Round row locked `FOR UPDATE` before the check, closing the read-then-write race S01's review found. Change nothing else: no second freeze rule, constant or feature flag anywhere in the Poll edit path, and the injection through `buildApp` stays as S01 wired it so a test can still bind a port answering `true`. Without this task PRD FR1's freeze criteria and its *"Facilitator edits Poll options after the first Vote → Refused"* edge case fail in production while S01's scenario S07 stays green against its test injection.
  - **Verify**: `Test: S01's Acceptance Scenario S07 re-runs unmodified and passes against the discharged port; with a real Vote cast through TI05, editing the Poll's options and editing its question are each refused with S01's existing frozen-content code and the stored values are byte-identical afterwards, while a Post-it Round's prompt edit on the same Session still succeeds; with no Vote cast, both Poll edits succeed; and a concurrent case in which a Vote is cast between the freeze check and the content UPDATE ends with the edit refused and the stored question and options byte-identical, proving the check and the write are one transaction and not two statements. Structure: exactly one file declares the port, exactly one guard consumes it, and no stub or constant answering false remains under api/src/`

- [x] **TI09** The Poll card lets a Member vote once and shows the state their authority and the Round state allow
  - One card per Poll inside `web/src/activities/SessionActivitiesPanel.tsx`, beside S02's compose box and named Board: options as a single-choice list with a submit while open and unvoted; a settled "you have voted" state with no change or withdraw affordance; TI05's refusal rendered without a tally; the result as counts per option once TI07 supplies them. Render the refusal outside any subtree the submit handler unmounts (`docs/LEARNINGS.md#react-state--refusals`). Consumes TI07's payload and adds no request of its own beyond the cast. Responsive at 375/768/1280 px with no horizontal body scroll.
  - **Verify**: `Test: choosing an option and submitting moves the card to the voted state with no way to change it; a duplicate-vote refusal stays on screen with the card intact and shows no counts; a Facilitator sees the tally while open and an Attendee does not; a closed Poll renders its counts, including all-zero; S02's post-it Board in the same panel still renders and composes; no vote, has-voted or tally value is written to the offline cache, IndexedDB or a service-worker route. Screenshots at 375/768/1280 px show no horizontal body scroll`

- [x] **TI10** A running Poll's tally reaches the Facilitator's screen near-live through S02's one cursor
  - Binds to the concrete artifacts, not to a pattern: TI02 advances `round.activity_watermark_at` on ballot insert, S02 TI07's two-scalar Session watermark poll exposes it, and S02 TI08's single extracted client loop under `web/src` drives the compare-then-refetch of TI07's read. No second polling path, cadence constant, in-flight guard, endpoint, socket or per-client server state is introduced, and `roundsLastUpdatedAt` no longer exists (`plan.json#sharedDecisions` → one cursor). Assert the resulting rendered tally, not the requests issued – `docs/LEARNINGS.md#testing` records a guard that watched the request and stayed green while the payload was wrong.
  - **Verify**: `Test: a Vote cast on one client appears in the tally rendered on an assigned Facilitator's client without user action, within the ~5s propagation target; the Session watermark poll value moves on that cast; this story's source adds no polling timer, cadence constant, in-flight guard, endpoint or subscription beyond S02 TI07/TI08's, and S02's own near-live Board test passes unmodified`

### Testing Strategy

- The Structural Criteria are proved by TI03's file-reading suite, not by any request-level test. Before believing it, apply `docs/LEARNINGS.md#testing`'s rule to each assertion in turn: add the column, FK, trigger or join it forbids and confirm the suite goes red – a guard written beside its subject usually passes without it.
- **The MVCC residual is deliberately untested.** No structure test can fail on it, because the correlator is a system column no schema assertion inspects (ADR-006 § Consequences). Do not write a test that appears to cover it; a green assertion over `xmin` would be a false assurance, which is the exact failure ADR-006 exists to stop.
- Single-use under concurrency needs two real connections against the containerized PostgreSQL, in the idiom of `api/test/schedule-concurrency.integration.test.ts`; sequential casts cannot distinguish the unique constraint from a pre-read.
- TI08's discharge is only believable if S01's scenario S07 is re-run **unmodified**. Changing that test to suit the new binding would hide the very regression the port exists to prevent.
- `web/` has no jest-dom – assert plain DOM properties (`.disabled`, `.value`, `queryByTestId() === null`), never `.toBeInTheDocument()`.

### Execution Contract

- S03 runs **after** both S01 and S02 (`plan.json` → `dependsOn: ["S01","S02"]`, `parallel: false`). Four S01/S02 artifacts are extended in place – the Session-with-Rounds read handler and its projection, `web/src/activities/SessionActivitiesPanel.tsx`, `api/src/routes/rounds.ts`, `api/src/errors.ts`. Extend, never replace; S01's and S02's existing tests over each must pass unmodified at the end of every task that touches one.
- TI01 must land before TI02 – the trigger is declared in the same migration as the table it fires on.
- TI04 must land before TI08 – the port's new body is TI04's `exists` check, and TI08 adds no query of its own.
- TI08 is **not** a pure body replacement – surfaced by S01's review and decided 2026-08-29 (see the DECISION NOTE for `poll-freeze-toctou-discharge`). S01's guard reads the port and issues the UPDATE as a separate statement, which is safe only while the port answers a constant; once TI08 binds it to real ballot storage that gap is a race in which a Vote landing mid-edit lets a Poll edit through after the freeze should have applied. TI08 must therefore take the freeze check and the Poll content UPDATE into **one transaction**, locking the Round row `FOR UPDATE` before the check. Still preserved and not to be widened: S01's Structural Criterion "exactly one ballot-existence seam exists" – one file declares the port, one guard consumes it – plus S01's frozen-content refusal code, its route and its state machine. If discharging it appears to require changing any of those, stop and surface it.
- TI02 must land before TI10 – without the ballot-insert trigger there is no producer for the cursor TI10 consumes, and TI10's test would pass only by coincidence of another write.
- TI07 must land before TI09 and TI10 – both consume the has-voted flag and the permitted tally from that payload rather than deriving either on the client.

## Final Validation Checklist

- [x] `git diff` shows no declared column, constraint, index or query added anywhere in the change that could pair a ballot with a Member – confirmed by reading the migration and the vote module end to end, not only by the suite being green.
- [x] No text added by this change – comment, doc-block, schema comment, test name or FIS observation – states or implies that correlating a ballot with a voter requires raw table access, superuser rights, filesystem access or a backup (ADR-006 § Decision item 4).
- [x] The migration comment names the residual, names the reach of the guarantee, and cites ADR-006 by path.
- [x] `api/src/rounds/ballot-gate.ts` contains no stub, constant or `false` literal standing in for Vote storage, and S01's Poll-freeze scenario passes with the file unchanged since this story touched it.
- [x] No file under `web/src/offline/` and no service-worker route is touched: Votes and tallies are online-only.
- [x] No second polling cadence, in-flight guard or watermark endpoint exists under `web/src` or `api/src` after this story – one cursor, S02's.

## Implementation Observations

> _Managed by exec-spec post-implementation – append-only. Spec authors: leave this section empty._

#### DECISION NOTE: poll-freeze-toctou-discharge

Decision-Key: poll-freeze-toctou-discharge
Altitude: fis-local
Affected surface: TI08's task body and its Verify line, and the TI08 ordering constraint in the task-ordering list - all three amended below. S01's ballot-existence port and single freeze guard are NOT amended and keep their shape.
Decision: TI08 is not a pure body replacement. It must take the freeze check and the Poll content UPDATE into one transaction, locking the Round row FOR UPDATE before the check. S01's Structural Criterion "exactly one ballot-existence seam exists", its frozen-content refusal code, its route and its state machine are all still preserved and must not be widened.
Rationale: S01's fresh-context review found the freeze guard reads the ballot-existence port and issues the UPDATE as a separate statement. That is harmless only while the port answers a constant false. Once TI08 binds it to real ballot storage the gap becomes a genuine race in which a Vote landing between the check and the write lets a Poll edit through after the freeze should have applied, leaving a closed tally answering a question it was not cast against. The row lock closes it while keeping one seam and one guard, and matches the lock-sequence idiom S05 already plans.
Evidence: Surfaced by S01's quick-review as ledger entry api/src/rounds/ballot-gate.ts:spec-stale:the-poll-freeze-is-a-read-then-write-across-two-statements in s01-round-authoring-and-lifecycle.reconciliation-ledger.md, which names this FIS as its stale target; escalated per TI08's own "stop and surface it" instruction and decided by the user during exec-plan wave-discovery triage on 2026-08-29.

**PAIR 1 – the TI08 ordering constraint line, in the Implementation Plan Execution Contract task-ordering list**

Old:

```text
- TI08 must be executed as a **body replacement only**. If discharging it appears to require a change to S01's guard, refusal code, route, state machine or `buildApp` wiring, stop and surface it rather than widening the change – S01's Structural Criterion "exactly one ballot-existence seam exists" is the thing being preserved.
```

New:

```text
- TI08 is **not** a pure body replacement – surfaced by S01's review and decided 2026-08-29 (see the DECISION NOTE for `poll-freeze-toctou-discharge`). S01's guard reads the port and issues the UPDATE as a separate statement, which is safe only while the port answers a constant; once TI08 binds it to real ballot storage that gap is a race in which a Vote landing mid-edit lets a Poll edit through after the freeze should have applied. TI08 must therefore take the freeze check and the Poll content UPDATE into **one transaction**, locking the Round row `FOR UPDATE` before the check. Still preserved and not to be widened: S01's Structural Criterion "exactly one ballot-existence seam exists" – one file declares the port, one guard consumes it – plus S01's frozen-content refusal code, its route and its state machine. If discharging it appears to require changing any of those, stop and surface it.
```

**PAIR 2 – inside TI08's task body, in the Implementation Plan Implementation Tasks list**

Old:

```text
Change nothing else: no second freeze rule, constant or feature flag anywhere in the Poll edit path, and the injection through `buildApp` stays as S01 wired it so a test can still bind a port answering `true`.
```

New:

```text
Beyond that body the one permitted widening is the transactional envelope the DECISION NOTE for `poll-freeze-toctou-discharge` requires: the freeze check and the Poll content UPDATE run in one transaction with the Round row locked `FOR UPDATE` before the check, closing the read-then-write race S01's review found. Change nothing else: no second freeze rule, constant or feature flag anywhere in the Poll edit path, and the injection through `buildApp` stays as S01 wired it so a test can still bind a port answering `true`.
```

**PAIR 3 – TI08's Verify line, in the Implementation Plan Implementation Tasks list**

Old:

```text
with no Vote cast, both Poll edits succeed. Structure: exactly one file declares the port, exactly one guard consumes it, and no stub or constant answering false remains under api/src/
```

New:

```text
with no Vote cast, both Poll edits succeed; and a concurrent case in which a Vote is cast between the freeze check and the content UPDATE ends with the edit refused and the stored question and options byte-identical, proving the check and the write are one transaction and not two statements. Structure: exactly one file declares the port, exactly one guard consumes it, and no stub or constant answering false remains under api/src/
```

### Run: 2026-08-29 08:25 UTC – discovered-requirements

#### DISCOVERED REQUIREMENTS

Propagated from S02's review by exec-plan wave-discovery triage, 2026-08-29. Ledger entry `db/migrations/20260828120000000_post-it.sql:spec-stale:editing-a-polls-options-advances-no-cursor` in `s02-named-post-it-contribution.reconciliation-ledger.md` names this FIS as its stale target.

**Editing a Poll's options currently advances no near-live cursor.** `round_option` carries no trigger, and `round`'s trigger has a `WHEN` clause that stays false when the prompt is unchanged — so an option edit is invisible to every polling client. S02's TI02 enumerated a closed set of three cursor writers (post_it, round, this story's ballot) and its code matches that enumeration exactly, so this is a gap in the enumeration rather than a defect in S02.

This lands on S03 because S03 is the story that makes options load-bearing: a ballot points at an option, and a room reading stale option labels while voting is the failure mode. TI02 must therefore advance `round.activity_watermark_at` on an option write as well as on ballot insert, so an option edit made before the first Vote reaches every open client the same way a Vote does. This is additive to TI02's existing obligation and changes no interface — after the first Vote the freeze makes the case unreachable anyway, which is precisely why the window that matters is the pre-Vote one.

Note the related mechanism recorded as S02 ledger entry `the-round-triggers-when-clause-is-a-hand-maintained-column-allow-list`: the `WHEN` clause is an allow-list of columns, so any column added later is silently outside the cursor. Inverting it to `WHEN (OLD.activity_watermark_at IS NOT DISTINCT FROM NEW.activity_watermark_at)` would close both this and that entry, but that is S02's migration to change and is not required here — do not widen into it without surfacing.

### Run: 2026-08-29 08:36 UTC – discovered-requirements

#### DISCOVERED REQUIREMENTS

**A closed Poll refusing a Vote needs its own refusal code — a fourth beyond the three TI05 enumerates.**

TI05 and the *Integration seam with S02* section both instruct: reuse an existing code for "closed Round", and "add codes only for already-voted, unknown-option and results-not-yet-available". That instruction assumes a general closed-Round code already exists. It does not. The only one S01 or S02 registered is S02's `POST_IT_ROUND_CLOSED`, and it is Post-it-specific in three ways that make reusing it for a Vote a lie a client would branch on:

- its name says `POST_IT`, and `code` is precisely the field a client is told it may branch on without parsing prose (`api/src/errors.ts` module note);
- S02 documents its meaning as "a Member whose Round closed while they were typing, and their next move is different - the text is still in the box, and it goes back up if the Round reopens". A Poll that has closed can never reopen (S01's `open` predicate refuses a `VotingRound` carrying a `closed_at`), so that next move is unavailable and the sentence is false for a voter;
- S01's `ROUND_TRANSITION_NOT_PERMITTED` is not a candidate either — S02 explicitly records that it answers a Facilitator working the run controls, not a Member refused a contribution.

Resolution: add `VOTING_ROUND_CLOSED` to `ERROR_CODES` alongside the three TI05 names. This is not a synonym under the module's own stated convention — one code per *reason*, where the reasons differ by what the person does next — it is the fourth distinguishable reason on this path. Everything else in TI05 stands unchanged: `ROUND_NOT_FOUND` and `POLL_CONTENT_FROZEN` are reused as written, and no code is added for any reason S01 or S02 already covers.

### Run: 2026-08-29 09:11 UTC – observations

#### NOTICED BUT NOT TOUCHING

- `db/migrations/20260828120000000_post-it.sql` (comment above `CREATE INDEX post_it_by_round`) still says "The wall read asks for one Round's Post-its oldest first". **Board** is the canonical noun and "wall" is a registered synonym to avoid (`docs/UBIQUITOUS_LANGUAGE.md`). S02's migration; not touched. No occurrence of "wall" was introduced by S03.
- `api/test/round-structure.test.ts` (the `refuses a poll edit exactly when the port says a vote exists` case) calls `assertPollContentEditable(gate, poll)` with two arguments now that the guard takes a third (`tx: Queryable`). It still proves exactly what it claims — the stub ignores the parameter, and `api/tsconfig.json` includes only `src/**/*.ts`, so tests are not type-checked. S01's test; left unmodified.
- S02 ledger entry `the-round-triggers-when-clause-is-a-hand-maintained-column-allow-list`: inverting `round_change_advances_activity_watermark`'s `WHEN` clause to `WHEN (OLD.activity_watermark_at IS NOT DISTINCT FROM NEW.activity_watermark_at)` would close both that entry and the option-write gap globally. S03 closed the option-write gap additively with its own `round_option` trigger instead; the inversion is S02's migration to change and was deliberately not widened into.
- Port 8080 on this machine is held by an unrelated process, and `docker` is not on PATH, so `visual/shell.spec.ts` (3 cases) cannot obtain a live `/api/health` value and fails on `schema-version`. Environmental; that spec references nothing S03 touched. All 6 `visual/session-activities.spec.ts` cases pass at 375/768/1280 px.

#### ASSUMPTIONS

- **TI08's port signature widened, as the transactional envelope entails.** `BallotGate.hasAnyVote(roundId, tx: Queryable)` gained the transaction parameter, `createBallotGate()` no longer takes a database at construction, and `RoundRepository.updateContent` gained an `assertEditable(round, tx)` callback. The DECISION NOTE `poll-freeze-toctou-discharge` authorises "the freeze check and the Poll content UPDATE run in one transaction with the Round row locked FOR UPDATE before the check"; running the check inside that transaction requires the gate to query on the transaction's client, so the parameter is entailed rather than additional. **Preserved exactly**: one file declares the port, one guard consumes it, `POLL_CONTENT_FROZEN` and its message are S01's verbatim, the PATCH route and the Round state machine are unchanged, and `buildApp` still accepts an injected `BallotGate` object — S01's Acceptance Scenario S07 re-runs unmodified and passes.
- **Structural Criterion 3 is literally unsatisfiable alongside Criterion 2, and is asserted at its substance.** Criterion 2 requires "primary keys on both are random (`gen_random_uuid()`)", so both `vote` and `round_voter` carry an `id` column — meaning `round_id` is not literally the only shared *declared column name*. The criterion's substance — that no declared value pairs a ballot with a voter — holds and is asserted two ways: `vote-structure.test.ts` pins the shared set at exactly `['id', 'round_id']` and that both keys are independently `gen_random_uuid()`-defaulted, and `vote.integration.test.ts` proves against a real Round that joining on `id` yields 0 rows while joining on `round_id` yields the full 4x4 cross product.
- **Three S01/S02 test files were amended, each where the assertion described a state this story is specified to change.** `api/test/round-structure.test.ts`: the ballot-gate binding assertion now pins the discharged `exists` query instead of "answers false today", and the authority-narrowing loop names `holdsAssignment` (the extracted single asker) instead of `mayRun`, which now derives from it plus editability; the round-table allow-list admits `/votes/` by exact directory. `api/test/round.integration.test.ts`: the exhaustive Poll wire-key list gained `hasVoted` and `tally` (TI07 adds them by design); the load-bearing "nothing instant-shaped on a Round" loop is untouched. `api/test/post-it.integration.test.ts`: its reversibility case reverted a fixed one step, which asserted "post-it is the last migration"; it now uses `migration-depth.ts#stepsToRevertThrough`, the helper that exists for exactly this. No behavioural S01/S02 assertion was weakened or removed.

### Run: 2026-08-29 11:45 UTC – review remediation (five Fix-routed findings)

Applied by a remediation worker against the fresh-context quick-review of S03. Scope was exactly the five findings routed **Fix**; the five routed **Note** were left untouched. No checkbox state was changed and no story behaviour was re-implemented.

- **F3 – the TOCTOU guard's `pg_locks` predicate was cluster-wide.** `waitForWaiter` in `api/test/vote.integration.test.ts` counted `pg_locks where not granted` with no filter at all, so any blocked backend anywhere on the server satisfied it. It now takes the voter connection's backend pid and requires, of the *same* backend: an ungranted lock request, a granted `tuple` lock on `'round'::regclass`, a pid that is neither the observer's nor the voter's, and the voter's pid among `pg_blocking_pids`. The relation is asserted through the tuple lock rather than on the ungranted row because PostgreSQL records a row-lock wait as a `transactionid` lock whose `relation` is null — verified empirically against this project's PostgreSQL before writing the predicate. **Red-then-green**: with the strengthened predicate in place, `for update` was removed from `updateContent`'s locked read and the case failed (`expected 200 to be 409`, with the rewritten prompt visibly stored); `for update` was restored and it passed again.
- **F4 – `assertEditable` named two rules in one call chain.** The freeze callback on `RoundRepository.updateContent` is now `assertNotFrozen` (interface, implementation, call and the two comments naming it). `assertEditable` is left meaning only the archived-Conference guard from `conferences/lifecycle.ts`. Mechanical; the PATCH route passes an inline lambda, so no call site changed.
- **F7 – `declaredColumns` only saw two-space indentation.** The parser in `api/test/vote-structure.test.ts` anchors on `^\s*` rather than `^\s{2}`, and the missing `information_schema` backstop for `round_voter` was added beside the existing one for `vote` in `vote.integration.test.ts`. **Both proved**: a `ballot_no integer` column indented four spaces was added to the `vote` table in the migration — the strengthened parser failed Structural Criterion 1, and with the parser reverted to `^\s{2}` the same sneaked column passed all 21 cases, which is the blindness the finding describes. Separately, `alter table round_voter add column voted_seq bigserial` on the live test database failed the new backstop and nothing else.
- **F8 – the ballot/identity statement guard was case-sensitive.** `/\bvote\b/` gained the `i` flag, and the identity-table regex it feeds gained one too, since `from vote v join APP_USER` is the same hole in the other direction. Proved by writing `select 1 FROM VOTE v JOIN app_user u ON true` into `api/src/votes/vote-repository.ts`: the fixed guard fails on it, and `/\bvote\b/` without the flag does not even select the statement for checking. The concatenated-string-literal evasion the review also mentions was deliberately left alone — it is a Note, not this fix.
- **F6 – no in-flight guard on the Vote submit.** `SessionActivitiesPanel` holds `voteInFlight` (the Round id whose cast is out, `null` otherwise), set before `castVote` and cleared after the re-read; the submit is disabled and reads "Sending…" while its own cast is out, and the handler returns early if re-entered for the same Poll. Per-Round rather than one boolean so a slow cast in one Poll does not disable another's submit. Nothing here decides whether the person has voted — that is still the server's `hasVoted` on the re-read. New case in `web/test/PollCard.test.tsx` holds the POST open, taps twice, and asserts one cast and no refusal beside "Your vote is in"; with the guard removed it goes red with two POSTs.
- **The `inFlight` denylist was narrowed, not removed — in all three places that carried it.** The finding named `vote-structure.test.ts`; `api/test/round-structure.test.ts` (S01) and `web/test/watermark-poll.test.tsx` (S02) carried the same term and would have failed identically. Each now matches the exact identifier `\binFlight\b` case-sensitively (JavaScript identifiers are case-sensitive, so the compound `voteInFlight` is a different identifier) plus `pollingRef`, and S03's own assertion became the positive form "exactly one module under `web/src` holds a loop overlap latch, and it is `/poll/use-watermark-poll.ts`". The purpose survives: a second polling loop still cannot keep a latch under either name, and cannot avoid one without tripping the `setInterval`/`setTimeout`/cadence/`visibilitychange`/`focus`/socket assertions that sit beside each of these three checks.

Verification: `npm run typecheck` clean, `npm run lint` clean, `npm test` **1088 passed / 1088 across 66 files** (baseline 1087, plus the one new double-tap case). `npm run format:check` still fails on exactly the three pre-existing unrelated files (`api/test/join-code.test.ts`, `visual/conferences.spec.ts`, `web/src/components/JoinCodePanel.tsx`), which were not touched.

---

#### ADR-007 IMPLEMENTATION NOTE: a Vote advances no cursor

Implemented 2026-08-29 against `docs/adrs/ADR-007-vote-arrivals-do-not-advance-the-member-visible-cursor.md` (accepted the same day). Recorded here for the reader of TI02; the FIS amendments themselves are the orchestrator's, and no checkbox in this document was touched.

- **Forward migration** `db/migrations/20260831090000000_vote-advances-no-cursor.sql` drops `vote_advances_activity_watermark`, with a down step that recreates it in its original `AFTER INSERT … EXECUTE FUNCTION advance_round_activity_watermark()` shape. `20260829090000000_vote.sql` was **not** edited. The other three triggers on the cursor – `post_it`, `round_option` and the `round` BEFORE-UPDATE one – are untouched, which is what keeps Attendee Board propagation and reveal-on-close near-live.
- **Client**: `SessionActivitiesPanel`'s poll callback branches on a `canRunRef` mirror of the server's `canRun`. A Session Assignment holder re-reads the Session on every tick of `useWatermarkPoll`'s existing loop (one request per tick, not two – the two-scalar poll would only be a scalar that branch then ignores); everybody else keeps compare-then-refetch. No new cadence constant, timer, listener or subscription, and `foreground-tick.ts` was deliberately not used: this panel is already a call site of the loop, so a second subscription path would have been machinery for nothing.
- **Assertions inverted**, not relaxed: `vote.integration.test.ts` now proves a cast Vote leaves `max(round.activity_watermark)` for the Session exactly where it was (through the route, and through a raw `insert into vote` inside one transaction), that `pg_trigger` shows no trigger on `vote` at all, that an option write and a Poll **close** still advance it, and that the migration is reversible in both directions. The counter-is-not-a-clock reading moved from a Vote to a Post-it contribution, because a delta of zero would have made that assertion vacuous.
- **`web/test/PollCard.test.tsx`** proves the replacement behaviour on **rendered state**: a holder's tally moves from `3 0 0` to `3 1 0` after one `POLL_INTERVAL_MS` tick with the watermark answering the *same* value throughout and no user action; a non-holder still does not refetch on an unmoved cursor; and a closed Poll's result still reaches a non-holder when the cursor moves.
- **Prove-It**: removing the holder branch turns the tally test red on the rendered counts (`['3','0','0']` vs `['3','1','0']`); recreating the trigger by hand on the test database turns five integration assertions red, including both inversions.

### Run: 2026-08-29 15:43 UTC – design-change

#### DESIGN CHANGE

ADR-007 inverts TI02's contract: a cast Vote must advance no cursor, because a `max(...)`-scoped Session watermark makes a vote-arrival a noiseless oracle for any Member. The task title asserted the removed behaviour and the Verify line asserted its test, so both were the opposite of the shipped contract. The task's checked-checkbox prefix, the task ID **TI02**, all tags, and every other Proof line are byte-identical.

#### ADR

`docs/adrs/ADR-007-vote-arrivals-do-not-advance-the-member-visible-cursor.md` – Status: Accepted, 2026-08-29. Vote arrivals do not advance the Member-visible activity cursor.

#### AMENDMENT

Old:
```
**TI02** A cast Vote advances its Round's activity watermark, so a building tally has a producer
```

New:
```
**TI02** A cast Vote advances **no** cursor (ADR-007); an option write advances the Round's activity watermark
```

Old:
```
Test: casting a Vote leaves the Round's activity_watermark_at strictly greater than before, and moves the Session's two-scalar watermark poll value; two Votes in one transaction produce two distinct values;
```

New:
```
Test: casting a Vote leaves the Round's activity watermark **unchanged** and the Session's two-scalar poll value unmoved (ADR-007); an option write does advance it; closing the Poll advances it, so reveal-on-close still reaches an Attendee near-live; a Session Assignment holder's **rendered** tally still moves within the ~5s target on the shared tick with no user action;
```

### Run: 2026-08-29 15:47 UTC – design-change

#### DESIGN CHANGE

Completing the ADR-007 inversion begun in the 15:43 UTC amendment. That run inverted TI02's title and Verify line but left three spans still describing the ballot-insert trigger as a shipped artifact, so TI02's body contradicted its own amended title. These three pairs finish the job: TI02's detail bullet (the build instruction for the removed trigger), the `db/migrations/` Work Areas line under Scope & Boundaries, and the Technical Overview sentence. No checkbox state, task ID, scenario ID, tag or Proof line was touched; the document remains 35/35 checked.

#### ADR

`docs/adrs/ADR-007-vote-arrivals-do-not-advance-the-member-visible-cursor.md` – Status: Accepted, 2026-08-29. Vote arrivals do not advance the Member-visible activity cursor.

#### AMENDMENT

Old:
```
Exactly one `AFTER INSERT` row trigger on the ballot table, advancing `round.activity_watermark_at` (S02 TI02's column) with `GREATEST(clock_timestamp(), activity_watermark_at + interval '1 microsecond')` per `db/migrations/20260817150000000_session.sql` – never `now()`. Round-level only: it reads no identity, writes to no identity-bearing table and does not relate the ballot table to the has-voted table (see the permitting Structural Criterion). It must not touch `conference.schedule_watermark_at` or `sessions.last_updated_at`. Ships in TI01's migration and rides `api/src/db.ts`'s existing `40P01` retry. Without this task S02's trigger – which fires on `post_it` writes and `round` updates only – never sees a ballot insert, and Acceptance Scenario S04 and the ~5s NFR are unsatisfiable.
```

New:
```
**Amended 2026-08-29 by ADR-007 – this task is inverted. No trigger is attached to the ballot table.** As originally executed it added one `AFTER INSERT` row trigger there so a cast Vote advanced the Round's cursor. Because the cursor is read as `max(...)` scoped to a single Session, that made its change event a noiseless vote-arrival oracle for any Conference Member, on an unthrottled endpoint - while an Attendee is refused the running tally precisely so that absence carries no information. `db/migrations/20260831090000000_vote-advances-no-cursor.sql` drops it, reversibly, without editing the applied migration that created it. What this story does ship is an `AFTER INSERT OR UPDATE OR DELETE` trigger on `round_option`, attached to S02's single `advance_round_activity_watermark()` home, so an option edit still reaches the room. Acceptance Scenario S04 and the ~5s NFR are still satisfied, by a different route: a Session Assignment holder's client refetches the Session on each tick of the existing poll loop rather than waiting on a change signal, and the tally already rides the Session read payload. Round-level discipline is unchanged for the trigger that remains - it reads no identity, writes to no identity-bearing table, does not relate the ballot table to the has-voted table, and must not touch `conference.schedule_watermark_at` or `sessions.last_updated_at`.
```

Old:
```
one new migration adding the anonymous ballot table, the has-voted table, and the ballot-insert trigger that advances the Round's `activity_watermark_at` (the Round and option tables are S01's; the watermark column is S02's).
```

New:
```
one new migration adding the anonymous ballot table, the has-voted table, and an `AFTER INSERT OR UPDATE OR DELETE` trigger on `round_option` that advances the Round's activity watermark (the Round and option tables are S01's; the watermark column is S02's). **Amended 2026-08-29 by ADR-007**: the ballot-insert trigger this line originally named is dropped by a later migration - a Vote advances no cursor.
```

Old:
```
It also carries one `AFTER INSERT` trigger advancing the Round's `activity_watermark_at` so a cast Vote has a producer for the near-live cursor.
```

New:
```
It also carries one `AFTER INSERT OR UPDATE OR DELETE` trigger on `round_option` advancing the Round's activity watermark, so an option edit reaches the room. **Amended 2026-08-29 by ADR-007**: a cast Vote deliberately has **no** producer for the near-live cursor; a Session Assignment holder's tally refreshes by refetching on the shared tick instead.
```

### Run: 2026-08-29 15:49 UTC – design-change

#### DESIGN CHANGE

TI02's **Verify** tail still asserted `Structure: exactly one trigger is declared on the ballot table`. It survived the 15:43 UTC amendment because that run's New span stopped short of it, and it now contradicts both the inverted TI02 title from that run and the amended TI02 detail bullet from the 15:47 UTC run - the shipped contract attaches no trigger to the ballot table and exactly one to `round_option`. This fourth pair finishes the ADR-007 inversion by correcting the Structure clause to what shipped. No checkbox state, task ID, scenario ID, tag, or Proof path/selector/state was touched; the document remains 35/35 checked.

#### ADR

`docs/adrs/ADR-007-vote-arrivals-do-not-advance-the-member-visible-cursor.md` - Status: Accepted, 2026-08-29. Vote arrivals do not advance the Member-visible activity cursor.

#### AMENDMENT

Old:
```
Structure: exactly one trigger is declared on the ballot table
```

New:
```
Structure: **no** trigger is declared on the ballot table (ADR-007 - a Vote advances no cursor), and exactly one is declared on `round_option`
```

### Run: 2026-08-29 15:53 UTC – design-change

#### DESIGN CHANGE

**EXPLICIT OWNER OVERRIDE - this amendment edits a Structural Criterion, which the `design-change` form forbids. It is NOT an ordinary amendment.** The form's prohibition on editing Structural Criteria was read, understood and deliberately set aside for this single criterion by the product owner; it is recorded here so no future reader mistakes this edit for a sanctioned use of the form.

**Override authority, and exactly how it was given.** The product owner was asked directly whether to override. The question stated that the `design-change` form forbids editing Structural Criteria, that the prohibition is sound because a Structural Criterion is the proof record of what was verified at execution time rather than editable prose, and offered three options: override and amend while recording the override; leave the criterion untouched and rely on the reconciliation-ledger entry as the record; or leave it untouched and add an executable fitness function so a future attempt to satisfy it fails the build. **The owner chose to override and amend, and asked that the override be recorded.** That selection is the entirety of the authorization.

**The reasoning below was written by the assistant to record that decision. It is not a quotation of the product owner and must not be read as one.** The prohibition is sound - a Structural Criterion is the proof record of what was verified at execution time, not editable prose. It is overridden here because the criterion is CHECKED and now REQUIRES something that must not exist: ADR-007 removed the ballot trigger, so a future reader satisfying this criterion literally would reintroduce the vote-arrival oracle, guided by a green checkbox. The shipped code is strictly stronger than the criterion permits - zero triggers on the ballot table rather than exactly one. Leaving a green checkbox that instructs a reader to restore a removed side channel was judged the larger risk. This override applies to this one criterion only and sets no precedent for editing Structural Criteria generally.

**Correction, same day:** this block first presented the paragraph above as the owner's own verbatim words under a blockquote. It was not - the owner's input was the single choice described above. The attribution was corrected as soon as it was noticed, because an audit record that inflates a one-click decision into an authored statement is worse than no record.

**Scope of the override, stated so it cannot be read as precedent:** Structural Criterion 5 of this FIS only - the criterion that permitted and required the `AFTER INSERT` trigger on the ballot table. No other Structural Criterion in this or any other FIS is touched, and this override does not license editing Structural Criteria generally. The criterion's leading checked-checkbox marker is preserved byte-identically and no checkbox state changes: the document remains 35/35 checked, 0 unchecked. The criterion's `**What it reveals, stated for each reader rather than in general**:` remainder is left byte-identical - it is the honest per-reader analysis that led to ADR-007 and is retained as the record of what was believed at execution time. No task ID, scenario ID, tag, Proof path/selector/state, or plan provenance is touched.

**Why the criterion could not simply be left alone:** it is a CHECKED proof record whose text now requires a trigger that ADR-007 deliberately dropped. A reader who satisfied it literally would recreate `vote_advances_activity_watermark` and with it the noiseless vote-arrival oracle, believing a green checkbox was telling them to. The amended text therefore leads with the supersession, states what the ballot table now carries (nothing), names the dropping migration and the test that asserts absence, and instructs the reader explicitly not to restore the trigger to satisfy the retained analysis below it.

#### ADR

`docs/adrs/ADR-007-vote-arrivals-do-not-advance-the-member-visible-cursor.md` - Status: Accepted, 2026-08-29. Vote arrivals do not advance the Member-visible activity cursor. The trigger this criterion permitted was dropped by `db/migrations/20260831090000000_vote-advances-no-cursor.sql`; `api/test/vote-structure.test.ts` asserts its absence, and `api/test/round-structure.test.ts` asserts the surviving `round_option` trigger. This amendment brings the criterion's conclusion into line with that Accepted decision and with the shipped schema.

#### AMENDMENT

**PAIR 1 - Structural Criterion 5, the whole of its text after its leading checked-checkbox marker, up to and including "Any wider trigger on the ballot table is a defect." That marker and the `**What it reveals ...**` remainder are outside the span and unchanged.**

Old:

```text
**Permitted and required, so it does not read as a breach of the criterion above**: exactly one `AFTER INSERT` trigger on the ballot table, which advances its Round's activity watermark and does nothing else. It touches Round-level data only, reads no identity, writes to no identity-bearing table, and does not relate the ballot table to the has-voted table. Any wider trigger on the ballot table is a defect.
```

New:

```text
**Superseded 2026-08-29 by ADR-007, by explicit owner override of the design-change form's Structural-Criteria prohibition. The ballot table now carries NO trigger, and any trigger attached to it is a defect.** As shipped, this criterion permitted exactly one `AFTER INSERT` trigger there, advancing the Round's activity watermark and doing nothing else, on the reasoning recorded below. ADR-007 removed it: because the cursor is read as `max(...)` scoped to a single Session, its change event was a noiseless vote-arrival oracle for any Conference Member on an unthrottled endpoint, and no property of the *value* could fix a leak carried by the *event*. What this story ships now is an `AFTER INSERT OR UPDATE OR DELETE` trigger on `round_option`, attached to S02's single advance function; the ballot table has none, which is strictly stronger than this criterion originally permitted. **Do not restore the ballot trigger to satisfy the text below** - `db/migrations/20260831090000000_vote-advances-no-cursor.sql` drops it deliberately, and `api/test/vote-structure.test.ts` asserts its absence. The reasoning that follows is retained as the record of what was believed at execution time, and is superseded in its conclusion, not in its analysis.
```
