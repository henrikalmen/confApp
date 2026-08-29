# S05 – Contribution-safe Session Deletion

**Plan**: docs/specs/session-activities/plan.json
**Story-ID**: S05

## Feature Overview and Goal

**Intent**: A Session that has run holds the only copy of a Board of named ideas and a Poll's ballots – the raw input to categorization and the Report – and one confirmation on a Delete button must not be able to destroy it.

**Expected Outcomes** (scenarios anchor to these via `[OC<NN>]`):

- [OC01] Deleting a Session that holds any Post-it or Vote is refused by the API itself, and the refusal names what would be lost and what to do instead.
- [OC02] Deleting a Session that has Rounds but no contributions still succeeds and takes its Rounds with it – the guard costs nothing when nothing was collected.
- [OC03] Deleting a whole Conference stays permitted and still cascades to its Sessions, Rounds, Post-its and Votes. The guard is Session-level **by decision**, with archiving the intended "we are finished with this" path; deletion remains available for a Conference created in error.
- [OC04] The guard establishes that Votes exist for a Session without introducing any application-level path – column, constraint, index or query – from a ballot to the Member who cast it.


## Required Context

- `docs/specs/session-activities/prd.md#fr7-contribution-safe-session-deletion` – the four acceptance criteria this story implements, the refusal sentence ("This session has collected post-its or votes and cannot be deleted." with the edit and reschedule paths offered), the validation rule (*any* contribution under *any* Round of the Session blocks deletion), and the explicit statement that the Conference-level cascade is retained on purpose.
- `docs/specs/session-activities/prd.md#user-stories` – row **US10**: an Organizer wants a Session holding collected output to resist deletion, "so that a Board of named ideas cannot vanish on one confirmation". Its acceptance criterion is that the refusal *names what would be lost*, which is why the message carries counts and not only a category.
- `docs/specs/session-activities/prd.md#constraints` – three Binding Constraints apply to this story. **Vote anonymity is a hard constraint, scoped by ADR-006** – read the amended wording, not the earlier maximal claim: a Vote must be unlinkable to its voter "through **every application path** – no API response, screen, export or report may associate them, and no declared column, constraint, index or query available to the application may relate them", while the guarantee explicitly does *not* extend to a holder of direct database credentials. The guard's own count is one of those application queries, so it is fully inside the part of the constraint that still binds; the accepted residual buys it nothing. **Plain PostgreSQL only** – production hosting is undecided and portability is the reason (ADR-003), so the count, the locking and the cascade assertions use core PostgreSQL and nothing else. **No in-process state between requests** – the API scales across replicas with no sticky sessions, so the contribution count is a database read taken per request inside the delete's own transaction, never a cached or remembered number.
- `docs/specs/session-activities/prd.md#data-requirements` – a **Vote** belongs to one Round and one option and "carries no voter reference of any kind"; the **has-voted fact** is recorded separately "so that single-use can be enforced without any path from it to a ballot"; Post-its and Votes "must outlive the Session's own editing; see FR7". This is the shape the guard counts against.
- `docs/adrs/ADR-006-vote-anonymity-holds-against-application-paths-not-database-credentials.md` – **Accepted 2026-08-28**; it fixes the exact reach of the anonymity guarantee this guard must not weaken. Two things follow for S05. First, the part that binds here is unchanged: no application-level path from a ballot to a Member, so the count still reaches Votes through the Round alone. Second, **no comment, message or document this story adds may claim that correlating a ballot with a voter requires raw table access, superuser rights or filesystem access** – ordinary `SELECT` over MVCC system columns suffices, and a wrong reassurance is worse than none (ADR-006 → Decision, point 4). Do not restate the residual as something the guard mitigates; the guard is an application path and says nothing about database credentials.
- `docs/specs/session-activities/plan.json#sharedDecisions` – two entries bind S05. *"Anonymity storage split: ballot and has-voted are separate and unjoinable"* – S05 must count contributions for its deletion guard **without reintroducing a join**. *"Round entity and its open/closed state model"* – S01 owns the Round and its open/closed state; the guard reaches contributions through the Round and introduces no second notion of whether an Activity is running, and no rule about it: a Round's state is irrelevant to whether its contributions exist.
- `api/src/conferences/lifecycle.ts#joinRefusalReason` and `#assertJoinable` – **the refusal idiom to follow, not to re-invent**. A pure `…RefusalReason` predicate names *why*, a `JOIN_REFUSALS`-style record maps each reason to the sentence a person reads, and `assert…` throws or returns. The module holds no state and is a pure function of rows the caller has just read. S05 adds the Session-deletion equivalent beside it, not a second way of expressing a refusal.
- `api/src/sessions/session-repository.ts#remove` – the existing guarded delete: one transaction, the Conference row locked `for update` first so every delete against that Conference queues behind it, then existence, then the row-version comparison, then the last-Session-in-a-published-Conference count, then the delete. The contribution check joins this sequence; read the comments on ordering before choosing where.
- `api/src/routes/sessions.ts` – the `DELETE /api/conferences/:conferenceId/sessions/:sessionId` handler: `Admin` required, the write base carried in the query string, `assertLifecyclePreconditions` then `requireSaved(await sessions.remove(...))`. The new refusal travels out through the existing envelope; the handler grows no second refusal path.
- `api/src/errors.ts#ERROR_CODES` – one stable SCREAMING_SNAKE code per *reason*, with a complete displayable sentence in `message`. The `// schedule composition (S04)` block is where the Session codes live.
- `db/migrations/20260817120000000_conference.sql` and `db/migrations/20260817150000000_session.sql` – this project's constraint and cascade idiom, and the two `ON DELETE CASCADE` links (`membership`/`role_assignment` → `conference`, `sessions` → `conference`) that the retained Conference cascade starts from.
- `docs/UBIQUITOUS_LANGUAGE.md#session-activities` – canonical terms: Activity, Post-it Round, Post-it, Voting Round, Vote, Poll. **Discard** is defined here and means removing a Post-it from consideration *during sorting* – it is not this story and the word must not appear in this story's code, copy or codes.
- `docs/guidelines/CRITICAL-RULES-AND-GUARDRAILS.md` and `AGENTS.md` – always-on rules; in particular **never attribute a vote to a voter**, and never persist or query a link between voter identity and ballot "just in case".


## Deeper Context

- `docs/DECISIONS.md` – "Conference scope: confApp hosts many conferences over time, not one. Past conferences and reports remain as an archive" is the standing decision archiving rests on, and the reason a Session-level guard plus an available Conference deletion is coherent rather than inconsistent.
- `docs/LEARNINGS.md` – four entries bear on this story: *"Deleting and editing one Session deadlock"* (delete locks conference then session; the edit path reaches conference via the watermark trigger – any new lock must extend that order, not cross it); *"A structure test that skips when its marker is missing tests nothing"* (assert the marker is found, never `if (found > -1)`); *"A file-list grep is only as good as its longest omission"* (pair any source-scanning assertion with a behavioural one that does not know the list); *"A regression test written beside its fix usually passes without the fix"* (revert and re-run before believing the guard).
- `api/test/session.integration.test.ts` – the existing delete coverage, including `describe('deleting the last remaining session of a published conference')`. Its refusals must still fire on their own paths.
- `api/test/session-structure.test.ts` – the shape for a source-level Structural Criterion: read the file on disk, strip comments so the test cannot assert its own prose, then assert.
- `api/test/schedule-concurrency.integration.test.ts` – the shape for a two-connection race test with a held row lock.


## Acceptance Scenarios

- [x] **S01 [OC01] [TI01,TI02,TI04,TI07] A Session holding a Board of Post-its refuses deletion and loses nothing**
  - **Given** the Session "Team Retrospective" in the published Conference "Autumn Offsite" has a closed Post-it Round holding 12 Post-its, and the Conference has other Sessions besides it
  - **When** an Admin deletes that Session with a current base version
  - **Then** the delete is refused with a displayable sentence naming the 12 collected post-its and offering editing or rescheduling instead, and afterwards the Session, its Round and all 12 Post-its are still readable

- [x] **S02 [OC01,OC04] [TI01,TI02,TI05] A Session whose only contribution is anonymous Votes refuses deletion just as firmly**
  - **Given** the Session "Sentiment Check" holds one closed Poll with 8 Votes and no Post-its at all, cast by 8 Members whose has-voted facts are recorded
  - **When** an Admin deletes that Session
  - **Then** the delete is refused with a sentence naming the 8 collected votes, the 8 Votes survive, and the refusal is reached without reading the has-voted record or any column identifying a Member – the guard knows *that* ballots exist and nothing about *whose* they are

- [x] **S03 [OC02] [TI02] A Session with authored Rounds but nothing contributed deletes, taking its Rounds with it**
  - **Given** the Session "Lightning Talks" has one Post-it Round and one Poll, both authored ahead and neither yet contributed to
  - **When** an Admin deletes that Session
  - **Then** the delete succeeds, the Session and both Rounds are gone, and the schedule watermark has advanced so an open Attendee view drops the Session

- [x] **S04 [OC03] [TI06] Deleting the whole Conference is still permitted and still takes everything with it**
  - **Given** the Conference "Autumn Offsite" holds three Sessions, five Rounds between them, 40 Post-its and 25 Votes
  - **When** the Conference itself is deleted
  - **Then** the deletion succeeds – no contribution guard fires – and no Session, Round, Post-it or Vote of that Conference remains; the guard is Session-level by decision and this is the retained behaviour, not an oversight

- [x] **S05 [OC01] [TI04] The contribution refusal is the one an Organizer is told about, not the last-Session refusal**
  - **Given** the published Conference "Spring Kickoff" has exactly one Session, "Opening Workshop", and that Session holds 3 Post-its
  - **When** an Admin deletes it
  - **Then** the refusal is the contribution one naming the collected post-its – not "a published conference must keep at least one session" – because adding a second Session would not make this delete possible, while the sole-Session refusal would send the Organizer to do exactly that; a delete naming an unknown Session id still answers that the Session was not found, and a delete carrying a stale base version is still refused as a version conflict

- [x] **S06 [OC01] [TI03] A Post-it arriving into an existing Round while the delete is in flight is never cascaded away unnoticed**
  - **Given** the Session "Ideas Round" has one open Post-it Round and no contributions yet
  - **When** an Attendee's Post-it insert and an Admin's delete of that Session overlap, the insert attempting to commit after the delete's contribution count has been taken
  - **Then** the outcome is never "the delete succeeded and a committed Post-it disappeared with it": either the delete is refused because the contribution is there, or the contribution write fails because the Round it named is gone – and whichever happens, the Post-it is either readable or was never accepted

- [x] **S07 [OC01] [TI03] A Round authored while the delete is in flight cannot smuggle a Post-it past the count**
  - **Given** the Session "Ideas Round" is being deleted, and a Facilitator authors a *new* Post-it Round on that same Session through S01's authoring path – which takes no Conference lock and so does not queue behind the delete's first lock
  - **When** a Post-it is contributed to that newly-authored Round while the delete is still open
  - **Then** the same invariant holds as in S06: the delete never succeeds while a committed Post-it of that Session is destroyed. Either the new Round was authored before the delete took hold, in which case it is inside the counted set and the delete is refused; or the authoring write waits behind the delete and resolves after it – succeeding normally if the delete was refused, and failing because its Session is gone if the delete went through. There is no ordering in which the Round exists, holds a committed Post-it, and is absent from the count


## Structural Criteria

- [x] The deletion guard's SQL and module reference no member, user or has-voted table and no `user_sub` / `app_user` / `membership` column: Votes are counted through the Round alone, so satisfying the guard introduces no *application-level* path from a ballot to a Member – the part of the anonymity constraint ADR-006 leaves fully binding (`prd.md#constraints`; `plan.json#sharedDecisions` – anonymity storage split).
- [x] The refusal is expressed through the existing `AppError` + `ERROR_CODES` envelope and a `…RefusalReason` / `assert…` pair in the shape of `api/src/conferences/lifecycle.ts#joinRefusalReason`; no second refusal shape and no per-endpoint error format is introduced.
- [x] The existing delete refusals still fire on their own paths and their existing coverage still passes: `SESSION_NOT_FOUND`, `EDIT_VERSION_CONFLICT`, `CONFERENCE_STATE_CHANGED`, `CONFERENCE_NOT_EDITABLE` and `SESSION_LAST_IN_PUBLISHED_CONFERENCE`.
- [x] The `conference → sessions → rounds → {post-its, votes}` cascade chain is asserted at the database level, so a later migration cannot quietly break the retained Conference cascade (`prd.md#fr7-contribution-safe-session-deletion`, fourth criterion).
- [x] No in-process state: the contribution count is read from the database inside the request that refuses, never cached or remembered between requests (`prd.md#constraints`).
- [x] Plain PostgreSQL only – no extension, no provider-specific type or function, in anything this story adds (ADR-003 via `prd.md#constraints`).


## Scope & Boundaries

### Work Areas

- `api/src/sessions/` – a new pure deletion-guard module holding the refusal reason, its sentence and the `assert…` entry point.
- `api/src/sessions/session-repository.ts#remove` – the contribution count, and the Session-row and Round-row locks that precede it, inside the transaction that already holds the Conference row lock.
- `api/src/errors.ts` – one new reason code in the Session block.
- `api/src/routes/sessions.ts` – the `DELETE` handler, which surfaces the new refusal through the envelope it already uses.
- `api/test/` – integration coverage for both contribution kinds and the empty-Rounds case, the check-order and race tests, the source-level anonymity guard, and the Conference-cascade regression test.
- `web/src/schedule/SchedulePanel.tsx#remove` – already renders the server's refusal sentence verbatim into the `schedule-refusal` alert; this story proves that holds for the new code rather than adding client refusal handling.

### What We're NOT Doing

- **No change to the Conference lifecycle, and no Conference-deletion endpoint** – none exists today and none is added; the retained cascade is a schema property this story asserts, not an API surface it builds. Archiving stays the intended path for a finished Conference.
- **No soft delete, tombstone or restore path for a Session** – FR7 asks for a refusal, and the Organizer's stated alternative is to edit or reschedule. A recoverable-deletion model is a larger decision that belongs to the categorization and Report work that consumes this data.
- **No confirmation dialog naming what will be lost before the request** – a client-side confirmation is not the guarantee; the refusal is enforced server-side and is reproducible by calling the endpoint directly. The PRD records a Conference-deletion confirmation as *assumed by convention, not decided*, so it is deliberately left alone here.
- **No new UI surface, and therefore no new three-width visual capture** – the refusal reuses the existing `schedule-refusal` alert, whose responsive behaviour was validated in S09.
- **No work on ADR-006's accepted residual** – the MVCC correlation available to a holder of direct database credentials is out of this story's reach and was accepted deliberately; the permissions posture that would close it is named in the ADR as additive future work. S05 neither mitigates it nor may describe itself as mitigating it.
- **No handling of an S04 queued Post-it whose Session was deleted while empty** – see *Constraints & Gotchas*; the late-arrival sync path is S04's and this story neither widens nor blocks it.


## Architecture Decision

**Approach**: A pure `sessionDeletionRefusalReason` / `assertSessionDeletable` pair beside the conference lifecycle guards, fed by one contribution count read through S01's Round inside the delete's existing transaction, under a lock sequence extended from the Conference row down through the Session to its Rounds – so "may this be deleted now" is answered in one place, in the idiom the codebase already uses for "may this be joined now".
**Why this over alternatives**: A `NOT EXISTS` check inline in the delete statement would refuse without being able to say what was lost, and a database trigger would refuse in a language with no displayable sentence and no code a client can branch on; both would also put the anonymity-sensitive count somewhere no structure test is watching.


## Code Patterns & External References

```
# type | path#anchor                                        | why needed (intent)
file   | api/src/conferences/lifecycle.ts#joinRefusalReason  | Refusal idiom – reason predicate, message record, assert entry point
file   | api/src/sessions/session-repository.ts#remove       | The guarded delete transaction – the lock order and check order to extend
file   | api/src/errors.ts#ERROR_CODES                       | One stable code per reason, message a complete displayable sentence
file   | api/test/session-structure.test.ts                  | Source-level structural guard – read on disk, strip comments, then assert
file   | api/test/schedule-concurrency.integration.test.ts   | Two-connection race with a held row lock
file   | web/src/schedule/SchedulePanel.tsx#remove           | The verbatim-refusal path this story proves needs no change
file   | db/migrations/20260817150000000_session.sql         | Cascade and constraint idiom; plain PostgreSQL only
```


## Constraints & Gotchas

- **Count ballots, never voters** – the Vote row is the only thing to count. Counting through the has-voted fact would produce a number that looks the same and would put a Member reference in the guard's query, which is the exact defect the anonymity constraint names. It would also be wrong the moment the two ever diverge. Applies to the repository query (TI02) and to the structure guard that polices it (TI05).
- **The contribution refusal is more permanent than the sole-Session refusal, so it is answered first** – "add another session first" is advice that cannot help someone whose Session can never be deleted. This extends the ordering rationale already written into `session-repository.ts#remove`, where existence is answered before the sole-Session rule for the same reason.
- **Lock ordering, stated as a sequence** – the whole guard is one order and the order is the mechanism, so it is written once here and referenced by TI03 and TI04: **Conference row `for update` → the Session row `for update` → that Session's Round rows `for update` → the contribution count → the sole-Session count → the delete.** Every lock is taken *before* the count it protects – a count taken first would be a number about a past that a later insert can invalidate, which is precisely the window S06 and S07 name. `docs/LEARNINGS.md` already records the delete's order as "conference then session row", so pulling the Session lock forward from the closing `DELETE` to the existence read extends that order rather than crossing it; the recorded delete/edit deadlock pair and its SQLSTATE `40P01` retry in `api/src/db.ts` are unchanged by the move, and the retry still covers it.
- **`for update`, not `for no key update`, on the Session and Round rows** – a child insert takes `FOR KEY SHARE` on its parent row to satisfy the foreign key. `FOR UPDATE` conflicts with `FOR KEY SHARE`; `FOR NO KEY UPDATE` does not. The weaker mode would leave both windows open while looking like a lock. Applies to the Session row (TI03, blocking S01's Round authoring) and to the Round rows (TI03, blocking S02's and S03's contribution inserts).
- **Avoid**: proving the guard with an API test alone. A handler that never displays a voter proves nothing about whether the rows *could* be joined – the anonymity criterion is a property of the query text and the schema, so it needs the source-level assertion as well as the behavioural one.
- **NOTICED (out of scope, flagged not solved)**: a Post-it queued offline (S04) whose Session was deleted while empty has no Round left to land in on sync. This story's guard cannot help – at delete time there was nothing to protect – and the resolution belongs to S04's late-arrival path. Named here so it is not read as covered.


## Implementation Plan

### Implementation Tasks

- [x] **TI01** A Session-deletion refusal is expressible in the same idiom the Conference join refusal already uses
  - New pure module under `api/src/sessions/`, shaped after `api/src/conferences/lifecycle.ts#joinRefusalReason` / `#assertJoinable`: a reason predicate over a contribution-count value, a record mapping the reason to its displayable sentence, and an `assert…` that throws an `AppError`. One new `ERROR_CODES` entry (409) in the Session block of `api/src/errors.ts`, documented as one code per reason. The sentence carries the PRD's wording *and* the counts, because FR7 demands both a fixed message and that the refusal names what would be lost.
  - **Verify**: `Unit test: zero post-its and zero votes yields no refusal; 12 post-its yields an AppError whose code is the new Session code, status 409, message naming 12 post-its and offering the edit and reschedule paths; 8 votes alone names the votes; both present names both.`

- [x] **TI02** The delete refuses a Session holding any contribution, counting through S01's Round only
  - Extend the transaction in `api/src/sessions/session-repository.ts#remove` – which already holds the Conference row lock – with one count over the contribution tables S02 and S03 create, reached by `round.session_id`. Consume those tables by the names those stories land; the count joins Post-it → Round and Vote → Round, and nothing else. Pass the counts to TI01's `assert…`.
  - **Verify**: `Integration test: a Session with post-its is refused and survives with its post-its; a Session whose only contribution is votes is refused and its votes survive; a Session with two authored Rounds and no contributions is deleted, both Rounds go with it, and the conference schedule watermark advances.`

- [x] **TI03** No contribution and no Round can enter the Session between the count and the delete
  - Inside the delete's existing transaction, and in the full sequence written in *Constraints & Gotchas* → "Lock ordering, stated as a sequence": after the Conference lock, the Session row is locked `for update` at the existence read, then that Session's Round rows are locked `for update`, and **only then** is the contribution count taken. The Round lock stops a contribution insert into an existing Round (it needs `FOR KEY SHARE` on that Round row for its foreign key); the Session lock stops S01's authoring path creating a *new* Round to contribute into (it needs `FOR KEY SHARE` on the Session row for the same reason) – S01 takes no Conference lock, so without the Session lock a Round authored mid-delete would sit outside the counted set and carry a committed Post-it into the cascade. Plain PostgreSQL row locking only; no advisory lock, no `SERIALIZABLE` escalation.
  - **Verify**: `Integration test in the shape of api/test/schedule-concurrency.integration.test.ts, one case per race: (a) a Post-it insert into an existing Round overlapping the delete, and (b) a Round authored on the Session mid-delete and then contributed to. Neither run ends with the delete having succeeded while a committed Post-it of that Session is gone - the delete is refused, or the conflicting write fails because its parent no longer exists. Assert the losing write actually blocked rather than racing through, and that the guard reads the Session and Round locks as FOR UPDATE.`

- [x] **TI04** The Organizer is told the refusal that is true of their Session, in the right order
  - The contribution check sits after existence and the row-version comparison and before the sole-Session-in-a-published-Conference count, at the position fixed by the sequence in *Constraints & Gotchas* and for the permanence reason recorded there. Handler-side, the refusal travels out through the existing envelope in `api/src/routes/sessions.ts`; no new branch.
  - **Verify**: `Integration test: deleting the sole Session of a published Conference that holds post-its answers the contribution code, not SESSION_LAST_IN_PUBLISHED_CONFERENCE; an unknown session id still answers SESSION_NOT_FOUND; a stale base version still answers EDIT_VERSION_CONFLICT; the existing session delete tests still pass.`

- [x] **TI05** No path from a ballot to a Member can be added to the guard without a test failing
  - Source-level guard in the shape of `api/test/session-structure.test.ts`: read the guard module and the repository's delete on disk, strip comments so the test cannot assert its own prose, and assert the count references no has-voted table and no `user_sub`, `app_user` or `membership`. Assert the searched region is actually found – `docs/LEARNINGS.md` records a structure test that silently no-opped when its marker moved – and pair it with S02's behavioural assertion, which does not know the list.
  - **Verify**: `Test: the guard fails when the count is rewritten to reach a Vote through the has-voted record or any user-identifying column, and the assertion that the searched region was located fails if the region cannot be found.`

- [x] **TI06** The retained Conference cascade is proven, and reads as a decision rather than an oversight
  - Database-level integration test over a seeded Conference with Sessions, Rounds, Post-its and Votes: deleting the Conference row removes all four, with no guard firing. Its comment states that the Session-level-only scope is deliberate and archiving is the intended path for a finished Conference, citing `prd.md#fr7-contribution-safe-session-deletion`. If any `ON DELETE CASCADE` link in the chain proves missing, that is a defect in the owning migration (S01/S02/S03) and is fixed there, not worked around here.
  - **Verify**: `Integration test: after deleting the conference row, no session, round, post-it or vote of that conference remains, and the same seeded fixture's Session-level delete is still refused – the two behaviours are asserted side by side.`

- [x] **TI07** The Organizer sees the server's sentence with no new client refusal handling
  - `web/src/schedule/SchedulePanel.tsx#remove` already sets the refusal from `refused.message` verbatim into the `schedule-refusal` alert; this task proves the new code needs nothing more. The alert renders outside the subtree a failed re-read would replace – `docs/LEARNINGS.md`, "a refusal rendered only inside a component its own handler unmounts is lost" – so do not move it.
  - **Verify**: `Component test in web/test/SchedulePanel.test.tsx: a delete rejected with the contribution code renders the server's sentence verbatim in the schedule-refusal alert and leaves the Session in the list; no code-specific branch is added to remove().`

### Execution Contract

- TI01 lands before TI02 (the repository calls its `assert…`), and TI02 before TI03 and TI04 (both extend the same transaction and its check order).
- TI02, TI03 and TI06 need the contribution tables from S02 and S03. Both are complete before this story runs (`plan.json` → `stories[S05].dependsOn`); consume their table and column names as landed rather than assuming a shape.
- TI03's Session-row lock depends on S01's Round table carrying a real foreign key to `sessions`, since the lock works through FK enforcement rather than through anything S05 writes. Confirm that key exists as landed before relying on it; if it does not, that is a defect in S01's migration and is fixed there (as TI06 says of the cascade links), not compensated for here.


## Final Validation Checklist

- [x] Read the delete transaction top to bottom and confirm the locks appear in the order *Constraints & Gotchas* fixes, each one before the count it protects, with `for update` on the Session and Round rows – the sequence is the guard, and a suite can pass with the statements reordered if the race test's timing happens not to hit the window.
- [x] `git diff` shows no column, constraint, index or query added anywhere in the change that could pair a ballot with a Member, confirmed by reading the guard module and the delete end to end rather than by the structure test being green (Binding Constraint FR4; ADR-006 records that the residual it accepts is invisible to tests, which makes the readable surface the thing to check).
- [x] No comment, refusal message or test prose added by this story claims that correlating a ballot with a voter requires raw table access or elevated rights (ADR-006 → Decision, point 4), and the word **Discard** appears nowhere in this story's code, copy or error codes (`docs/UBIQUITOUS_LANGUAGE.md#session-activities` reserves it for sorting).


## Implementation Observations

> _Managed by exec-spec post-implementation – append-only. Spec authors: leave this section empty._

### Run: 2026-08-29 10:26 UTC – discovered-requirements

#### DISCOVERED REQUIREMENTS

Propagated from S03's review by exec-plan wave-discovery triage, 2026-08-29. Ledger entry `db/migrations/20260829090000000_vote.sql:code-defect:the-round-option-delete-trigger-fires-during-cascade-deletion-and-is-untested-there` in `s03-anonymous-poll-voting-and-result-reveal.reconciliation-ledger.md` names this FIS as its stale target.

**S03 added an `AFTER INSERT OR UPDATE OR DELETE` trigger on `round_option`, and this story is the one that deletes Rounds.** The trigger advances the Round's activity watermark. During a cascade delete it fires per option row while the Round it would advance is itself being deleted in the same transaction. It has the same shape as S02's already-shipped `post_it` delete trigger, so it is expected to no-op harmlessly, but that expectation is untested and this story is exactly where it gets exercised: deleting a Session with authored Rounds cascades to `round`, then `round_option`. Cover it - a Session with a multi-option Poll and no contributions must delete cleanly, with the cascade reaching `round_option` and the trigger not raising.

Related and worth knowing while writing that test: a six-option Poll bumps the cursor six times in one transaction on an ordinary option edit. That is a wasted-work observation, not a correctness problem, and it is not this story's to fix.

**Also note the near-live cursor changed shape after your FIS was written.** `round.activity_watermark_at timestamptz` became `round.activity_watermark bigint`, defaulted from one global sequence, in `db/migrations/20260829120000000_activity-watermark-counter.sql`. This was a security design change. It does not alter this story's contract - your Acceptance Scenarios reference the *schedule* watermark (`conference.schedule_watermark_at`), which is a different mechanism and is deliberately untouched - but do not confuse the two when writing the deletion tests, and do not assume the activity watermark is a timestamp.

### Run: 2026-08-29 11:45 UTC – discovered-requirements

#### DISCOVERED REQUIREMENTS

**S02's and S03's landed structure guards make the count's SQL unwritable in `session-repository.ts`.** `api/test/post-it-structure.test.ts` ("reaches the post_it table only from the rounds modules"), `api/test/round-structure.test.ts` ("reaches the round tables only from the rounds modules") and `api/test/vote-structure.test.ts` ("reaches the ballot and has-voted tables only from the votes module") each fail on any file outside the owning directory whose SQL names their table. TI02 and TI03 read as if `post_it`, `vote` and `round` statements would be written into `api/src/sessions/session-repository.ts#remove`; those three guards forbid it.

Resolution, preserving TI02 and TI03 exactly: the **transaction, the lock sequence and the check order stay in `session-repository.ts#remove`**, and each statement is issued by the module that owns its table, against the `Queryable` that transaction already holds - the same seam `sessionExistsInConference` opens in the other direction. Three narrow exports: `lockRoundsOfSession` (`api/src/rounds/round-repository.ts`), `countPostItsForSession` (`api/src/rounds/post-it-repository.ts`) and `countVotesForSession` (`api/src/votes/vote-repository.ts`). The Architecture Decision is unchanged - one contribution count reached through S01's Round, inside the delete's own transaction, under the lock order Constraints & Gotchas fixes.

**Consequence: S03's ballot-read allow-list admits one more shape.** `vote-structure.test.ts` -> "reads the ballot table only as a grouped count or an exists boolean" enumerates the exact shapes a statement matching `from vote` may take. S05's per-Session ballot count is a third legitimate shape and is added to that allow-list, held to the same properties as the other two: it names no identity-bearing table, carries no `sub`, and selects no ballot column. The list is widened; nothing is removed from it.

**The refusal names a Vote count, and that discloses nothing the caller could not already read.** The Session delete requires `Admin`, and `POLL_RESULTS_NOT_YET_AVAILABLE` withholds a live tally only from somebody who does not run the Session - so the person who reads this sentence could already read the tally. The count is a per-Session total across every Round of the Session, never a per-option figure, so it is not a tally in the sense S03 protects.

### Run: 2026-08-29 12:35 UTC – observations

#### NOTICED BUT NOT TOUCHING

- **A Post-it racing a Session delete fails as a 500, not as a refusal** - `api/src/rounds/post-it-repository.ts#contribute` (S02's). When a Round is deleted while a contribution's INSERT is already waiting on that Round's row lock, the insert's source query has already read the Round, so only the deferred key check sees it go and the write surfaces a raw `post_it_round_in_conference` foreign-key violation rather than S02's `{ outcome: 'missing' }`. Through the route that is `INTERNAL_ERROR` on an ordinary schedule race. S05's invariant is unaffected - the Post-it is never accepted and then destroyed - and the real behaviour is pinned in `api/test/session-deletion.integration.test.ts` -> "refuses a contribution once the round it named has been locked and deleted". S02's error mapping to fix; when it is fixed, that assertion is the one to loosen.

- **The delete now holds the Conference row `for update` across a potentially unbounded wait on Round locks** - `api/src/sessions/session-repository.ts#remove`, the Conference lock at the top through `lockRoundsOfSession`. That wait can queue behind `round-repository#updateContent` or `vote-repository#cast`, both of which take `for update` on a Round row; meanwhile the held Conference row blocks every `insert into sessions` (which needs `FOR KEY SHARE` on it) and the `UPDATE conference` that `sessions_advance_conference_watermark` issues on every Session write. So one Admin deleting one empty Session, parked behind one Facilitator's Poll edit, can stall schedule writes across the whole Conference. Not a deadlock, so `api/src/db.ts`'s SQLSTATE 40P01 retry does not cover it, and no `lock_timeout` or `statement_timeout` is set anywhere in `api/src`, `db/` or `docker-compose.yml`. Bounded in practice by one request's transaction length. The fix would be `set local lock_timeout` on this transaction plus a retryable refusal on SQLSTATE 55P03 - plain PostgreSQL, so ADR-003 is unaffected - but it is a new operational decision rather than something FR7 asked for, and it is not made here.

- **Only the structure test discriminates the Round lock's *mode*** - `api/test/session-deletion-structure.test.ts` -> "takes the session and round locks in a mode that conflicts with FOR KEY SHARE". Downgrading `lockRoundsOfSession` to `for no key update` leaves the whole race suite green, because a contribution insert also fires `advance_round_activity_watermark`, whose `UPDATE round` leaves the contributor holding `FOR NO KEY UPDATE` - which conflicts with a requested `FOR NO KEY UPDATE` too. The text assertion is therefore not redundant with the behavioural cases; it is the only thing standing between the correct mode and one that merely looks like a lock. Recorded so a later tidy-up does not delete it as duplicated coverage. Both the code comment and the race case's comment now say this explicitly.

- **Every behavioural proof of this story sits behind `describe.skipIf(!reachable)`** - `api/test/session-deletion.integration.test.ts`. With no `TEST_DATABASE_URL` the whole file warns and passes, and Acceptance Scenarios S01-S07 and TI02/TI03/TI04/TI06 have no non-integration behavioural evidence. This matches every other integration suite in the repository and is not this story's convention to change, but it means S05's completion evidence is only meaningful when it cites a run with a reachable database. The run recorded for this story did: 728/728 API tests with PostgreSQL up, no skips in this file.

- **The API integration suites share one `TEST_DATABASE_URL` and each truncates `conference` in `beforeEach`; several run `migrate up`/`down`.** `fileParallelism: false` (`api/vitest.config.ts`) keeps them apart within one run, but two concurrent runs against the same database corrupt each other - observed during this story's run as up to 100 spurious failures, `relation "round" does not exist`, and `Another migration is already running. Advisory lock mode is set to 'fail'.` Confirmed as contention rather than defect by re-running the whole API project against a private database: 728/728 green. A per-run database name would remove the class entirely.
