# S06 – Admin permanent removal

**Plan**: docs/specs/facilitator-board-and-categorisation/plan.json
**Story-ID**: S06

## Feature Overview and Goal

**Intent**: Something abusive or accidentally confidential can be written under a real name and projected to the whole company, and neither of the two removals confApp already has answers it – so an Admin needs one act that takes a Post-it off every surface for good, which Discard deliberately is not because it keeps the text stored and restorable by any Facilitator.

**Expected Outcomes**

- [OC01] An Admin of the Conference removes any Post-it in it – sitting in Uncategorised, sitting in a Category, or already Discarded – after a confirmation that names the author and states it cannot be undone, and it is gone from the Facilitator's Board, from every Attendee's Board, from the restore list and from the categorised output within the near-live window.
- [OC02] Nobody without conference-wide Admin can remove permanently, whatever they hold and whatever a client sends: a Session Assignment is refused by the API with a sentence that offers Discard instead, and the control is not offered to them in the first place.
- [OC03] The two answers a removal that is not a straightforward removal must give are defined rather than incidental: one against a Post-it that is already gone succeeds silently, and one against an Archived Conference is refused naming the archived state.
- [OC04] The removal is a real removal – the `post_it` row goes, any Discard trace goes with it structurally so no pending restore is offered, the Category and Uncategorised counts fall, and the Session's contribution count falls with it.

## Required Context

- `docs/specs/facilitator-board-and-categorisation/prd.md#fr5-admin-permanent-removal` – the acceptance criteria, validation and error handling this FIS implements in full, and **Binding Constraint FR5**, the defining one here: *"A Presenter/Facilitator without Admin cannot remove permanently, enforced server-side and not merely hidden in the UI."*
- `docs/specs/facilitator-board-and-categorisation/prd.md#edge-cases` – the three rows this story owns ("An Admin permanently removes a Post-it", "A Facilitator attempts a permanent removal", "An Admin permanently removes an already-Discarded Post-it"), and the two neighbouring rows it must leave alone (the author's own delete, and the author-delete-races-a-Discard race).
- `docs/specs/facilitator-board-and-categorisation/prd.md#non-functional-requirements` – the rows this story is measured by: "Permanent removal is Admin-only | Enforced server-side; a Session Assignment does not confer it"; the near-live propagation window; the three-width responsiveness rule on the Facilitator's surface; plain PostgreSQL and no in-process state; and **Binding Constraint FR8**: *"Vote anonymity is untouched | No surface added here reads, joins to, or exposes Vote data; the ADR-006 guarantee is unaffected because this feature handles only Post-its."*
- `docs/specs/facilitator-board-and-categorisation/prd.md#decisions-log` – "Admin-only permanent removal is in scope" and why Discard cannot serve as the moderation path. Settled; this story implements it and does not re-litigate it.
- `docs/specs/facilitator-board-and-categorisation/prd.md#constraints` – also binding here: plain PostgreSQL only and no in-process state between requests (FR1); offline support is not widened, so a removal is online-only and queues nothing (FR3); and Facilitator-initiated Discard must not reuse the author-deletion path (FR4) – which this story honours by staying a real delete and adding no tombstone, flag or `deleted_at` anywhere.
- `docs/specs/facilitator-board-and-categorisation/prd.md#fr6-sorting-authority` – **Binding Constraint FR6**: *"Actor identity is always taken from the credential and never accepted from a request body."*
- `docs/specs/facilitator-board-and-categorisation/s05-discard-and-restore.md` – the authoritative statement of the storage shape this story consumes: one `post_it_discard` row keyed on `post_it_id` referencing `post_it (id) ON DELETE CASCADE`, carrying `round_id`, `discarded_by_sub` and `discarded_at`; **presence of the row is the Discard and absence is not-discarded**; exclusion from reads is by anti-join. Also its stated decision that a discarded Post-it still counts as a contribution and blocks Session deletion, which this story is the counter-case to. Do not re-derive or contradict it.
- `docs/specs/facilitator-board-and-categorisation/s02-categories-uncategorised-and-sorting-authority.md` – the three shared decisions this story reads and writes through, stated in its **Technical Overview**: the single Board read projection contract (`categories[]` with `postItCount`, `uncategorised` always present, Uncategorised being the absence of a placement); the sorting-authority gate in `api/src/routes/rounds.ts#authorizeWrite`, on top of which this story layers an Admin-only check rather than replacing it; and the rule that Board writes advance the one shipped activity watermark. No second read shape, no second authority path, no second cursor.
- `api/src/conferences/authorization.ts#createConferenceAuthorization` – `requireConferenceRole(caller, conferenceId, 'Admin')` is the conference-wide check, resolved per request from the rows with nothing cached, and `ROLE_RANK` is why a Session Assignment cannot satisfy it (a Session Assignment narrows a `PresenterFacilitator` check; it never raises rank). Read `refusal()` for the neutral non-disclosing sentence and why it is the same for every reason.
- `api/src/routes/rounds.ts#authorizeWrite` – the shipped composition this story decomposes: `requireConferenceRole(..., 'PresenterFacilitator', { sessionId })` then `assertEditable`. The two primitives are reused unchanged; only their order relative to the new Admin check differs (see **Technical Overview**).
- `api/src/rounds/post-it-repository.ts#remove` – the author-delete path, gated on `p.author_sub = $5` and `r.state = 'open'`, refusing through `diagnose(...)` when it matches nothing. Permanent removal is a different path with different gating and the opposite idempotency answer; this file is not modified.
- `api/test/post-it-structure.test.ts` – the shipped guards that constrain where this story's code may live. In particular `reaches the post_it table only from the rounds modules`, `carries the author and the round-is-open condition inside the update and the delete` (a first-match regex on `delete from post_it p`), and `deletes rather than flags, and keeps no per-author or per-round count` (which caps `post-it-repository.ts` at exactly one `count(`). See **Constraints & Gotchas**.

## Deeper Context

- `api/src/conferences/lifecycle.ts#assertEditable` – the one archived refusal: `CONFERENCE_NOT_EDITABLE`, 409, and the exact sentence "This conference has been archived, so it is read-only and can no longer be changed." The PRD's paraphrase is not a second sentence.
- `api/src/routes/rounds.ts#mayRun` – the pattern for a server-supplied capability flag: asked through the same canonical check the write goes through, folding editability in so the flag means "this control will work", and consumed by the client rather than re-derived.
- `api/src/rounds/post-it-repository.ts#countPostItsForSession` and `api/src/sessions/session-deletion.ts` – the Session-deletion guard whose count this story genuinely decrements. Neither is modified; the change in behaviour is a consequence of the row being gone.
- `web/src/activities/SessionActivitiesPanel.tsx#writeToBoard` – the one board-write path: the refusal is the server's own sentence, held at panel level so the re-read cannot take it off screen, and the board is re-read either way.
- `api/src/errors.ts` – the post-it refusal block (S02) and its "one code per distinct next action" rule.
- `docs/UBIQUITOUS_LANGUAGE.md` – **Permanent Removal** and **Discard**. "delete", "discard", "purge", "hard delete" and "moderate" are named synonyms to avoid for this act in code, testids, CSS classes and copy.
- `docs/LEARNINGS.md#testing` – a regression guard written beside its fix usually passes without the fix; a SQL-scanning guard must read all three quote styles; a file-list assertion needs a behavioural one beside it.
- `api/test/post-it.integration.test.ts` and `api/test/role-authorization.integration.test.ts` – the real-PostgreSQL harness, migrate-down depth handling, and the assert-the-stored-row discipline.

## Acceptance Scenarios

- [x] **S01 [OC01] [TI01,TI03,TI05] An Admin removes a Post-it out of a Category and it is gone from the Board for everyone**
  - **Given** a published Conference whose Post-it Round's Board has a Category "Tooling" holding three Post-its, one of them Ada's "we need a staging box", and an Attendee polling the Session's activity watermark
  - **When** an Admin of that Conference confirms a permanent removal of Ada's Post-it
  - **Then** the Board read no longer returns it under "Tooling" or under Uncategorised, "Tooling" reports two, no `post_it` row exists for that id, and the polled watermark has moved so the Attendee's next read shows the same Board

- [x] **S02 [OC01,OC04] [TI01,TI02] Removing an already-Discarded Post-it takes its Discard trace with it and the pending restore disappears**
  - **Given** Ada's Post-it was discarded out of "Tooling" yesterday and is sitting in the Facilitator's discarded-Post-its list awaiting a possible restore
  - **When** an Admin permanently removes it
  - **Then** the discarded list no longer offers it, no `post_it_discard` row remains for that id, a restore attempted against that id afterwards succeeds silently and brings nothing back – and the trace went through the foreign key's cascade, not through a second delete statement issued by this story

- [x] **S03 [OC02] [TI03,TI04] A Facilitator holding a Session Assignment is refused at the API, and was never offered the control**
  - **Given** a Presenter/Facilitator holding a Session Assignment on that Round's Session but no Admin Role Assignment in the Conference
  - **When** they call the permanent-removal endpoint directly with a valid Post-it id, and separately open the Session's activities
  - **Then** the API refuses with 403 and the sentence "Only an admin can permanently remove a post-it. You can discard it instead.", the `post_it` row is still stored, and the Session read hands them a capability flag that is false so no permanent-removal control renders
  - **And** a request body naming an `actorSub`, `userSub` or `adminSub` is accepted and never read – the acting identity is the verified credential's `sub`

- [x] **S04 [OC03] [TI01,TI03] Removing a Post-it that is already gone succeeds silently**
  - **Given** Ada's Post-it has already been permanently removed, and Bo deleted his own Post-it from his phone a moment ago
  - **When** an Admin issues a permanent removal for each of those two ids
  - **Then** both requests succeed with no refusal and no message, nothing is written, and the Round's Board is unchanged – the requested end state is the one that already holds

- [x] **S05 [OC03] [TI03] A permanent removal against an Archived Conference is refused, naming the archived state**
  - **Given** the Conference holding that Board has been archived
  - **When** an Admin attempts a permanent removal
  - **Then** the API refuses with `CONFERENCE_NOT_EDITABLE` and the sentence "This conference has been archived, so it is read-only and can no longer be changed.", and the Post-it is still stored

- [x] **S06 [OC01] [TI05] The confirmation names the author and says it cannot be undone; dismissing it changes nothing**
  - **Given** an Admin looking at Ada's Post-it "we need a staging box" on the Facilitator's Board
  - **When** they choose permanent removal and read the confirmation, then dismiss it
  - **Then** the confirmation named Ada as the author and stated that the removal cannot be undone, and after dismissing it no request was sent and the Post-it is still on the Board

- [x] **S07 [OC04] [TI06] A Session whose only Post-it was permanently removed becomes deletable again**
  - **Given** a Session with one Post-it Round that collected exactly one Post-it
  - **When** an Admin permanently removes it and an Organizer then deletes the Session
  - **Then** the deletion succeeds rather than being refused with `SESSION_HOLDS_CONTRIBUTIONS` – unlike the same Session whose Post-it was only Discarded, which still refuses, because a Discard leaves the text stored and restorable and a permanent removal leaves nothing to protect

## Structural Criteria

- [x] Permanent removal's delete statement lives in its own module under `api/src/rounds/`, not in `post-it-repository.ts`: the shipped `carries the author and the round-is-open condition inside the update and the delete` guard still matches the *author* delete, and `post-it-repository.ts` still contains exactly one `count(` and still matches no `deleted_at|is_deleted|tombstone|soft`.
- [x] No source added by this story names `post_it_discard` on the removal path – the trace's disappearance is provable from S05's schema alone, and there is no second deletion path for it.
- [x] This story adds no migration: no new table, column, trigger or constraint is needed for it, and `db/migrations/` is unchanged.
- [x] There is no second authority path: the removal route reuses `requireConferenceRole` and `assertEditable` and nothing else decides who may remove; no role, rank or Admin test exists anywhere under `web/`.
- [x] The client renders the permanent-removal control from the server-supplied `canRemovePermanently` flag, consumed and never re-derived, on every surface that offers it. On the Board that flag is the only gate; on the discarded-Post-its surface it applies within a surface that is itself behind `canRun`, because that surface is a Facilitator surface.
- [x] Nothing is retained between requests: authority and the Post-it's existence are read from the database on each request; no module-level `let`, `Map` or `Set` is added (ADR-004).
- [x] No code added by this story reads, joins to, or exposes any vote table, ballot or per-voter fact (Binding Constraint FR8).
- [x] No permanent-removal write reaches the shipped offline Post-it queue (`web/src/offline/post-it-queue.ts`) or the offline cache; a failed removal is stated, never held (Binding Constraint FR3).
- [x] `api/src/rounds/post-it-repository.ts#remove`, `#countPostItsForSession` and `api/src/sessions/session-deletion.ts` are unmodified; the Session-deletion behaviour change is a consequence of the row being gone, asserted rather than coded.
- [x] The Facilitator's Board with the permanent-removal control and its confirmation shows no horizontal overflow at ~375, ~768 and ~1280 px.

## Scope & Boundaries

### Work Areas

- A new module under `api/src/rounds/` owning the permanent-removal statement – the seam that keeps the `post_it` table reachable only from the rounds modules while leaving the author-delete path's guards intact.
- `api/src/routes/rounds.ts` and `api/src/errors.ts` – the removal endpoint behind the layered Admin check and the archived refusal, its refusal code and sentence, and the capability flag on the Session read beside `canRun`.
- `web/src/api/client.ts` – the removal call, its request/response types, and the capability flag on the Session wire type.
- `web/src/activities/SessionActivitiesPanel.tsx` – the Admin-only control on each Post-it, the confirmation naming the author, and the write through `writeToBoard`.
- `api/test/`, `web/test/` and `visual/` – the structural guards, real-PostgreSQL integration (authority, idempotency, archived, cascade, Session deletion), component behaviour and the three-width capture.

### What We're NOT Doing

- **Any change to author deletion or to Facilitator Discard** – both keep their own gating, their own idempotency answer and their own trace behaviour. Three removal concepts stay three; this story adds the third and touches neither of the other two.
- **A second deletion path for the Discard trace** – S05's `ON DELETE CASCADE` already removes it with the row. Adding a delete against `post_it_discard` here would make the same fact true two ways and could drift.
- **The projected Board View and the Attendee's live Board** – S07 and S08. Both read through S02's Board projection, so a removed Post-it leaves them for free; neither surface is built or modified here.
- **Any audit trail, moderation log or "removed by" record** – FR5's whole point is that a permanently removed Post-it leaves *no trace on any surface*. Recording who removed what is a separate product decision nobody has asked for.
- **Widening removal beyond one Post-it at a time** – no bulk removal, no "remove all discarded". FR5 names one Post-it and one confirmation.

## Architecture Decision

**Approach**: Permanent removal is an ordinary hard `DELETE` of the `post_it` row from a new seam under `api/src/rounds/`, reachable only after the shipped sorting-authority gate and an added `requireConferenceRole(..., 'Admin')` check, with matching nothing treated as success rather than as a refusal.
**Why this over alternatives**: everything the story has to guarantee already falls out of the schema – the Discard trace goes by S05's cascade, the counts fall because S02's Board read groups live rows, the near-live advance fires on the shipped `post_it` DELETE trigger – so any state added here would be a second source of truth for facts the row's absence already states.

## Technical Overview

**The check order, and why it is not `authorizeWrite` verbatim.** `authorizeWrite` composes `requireConferenceRole(..., 'PresenterFacilitator', { sessionId })` then `assertEditable`. This route runs the same first call, then `requireConferenceRole(..., 'Admin')`, then `assertEditable` – the shipped gate with an Admin layer inserted, per S02's shared decision that S06 layers on top rather than replacing. The order is what makes each actor get the right sentence: someone with no standing in the Conference gets `authorization.ts#refusal()`'s neutral answer and learns nothing about it; a Presenter/Facilitator gets the Admin refusal that offers Discard; only an Admin reaches the archived refusal. A Session Assignment cannot satisfy the second call because `ROLE_RANK` narrows a `PresenterFacilitator` requirement by Session and never raises rank – it is the same primitive asked a second question, not a new one.

**Idempotency inverts the author path's answer.** `post-it-repository.ts#remove` calls `diagnose(...)` when its `DELETE` matches nothing, because a caller who is not the author or whose Round has closed must be told which. Here the only reason a match can fail is that the Post-it is already gone, and FR5 says that succeeds silently – so no `diagnose`, no `POST_IT_NOT_FOUND`, and the removal reports success on zero rows.

**The capability flag.** `canRun` is true for an assigned Facilitator and for an Admin alike, so it cannot gate this control. The Session read gains a second flag beside it, derived from the same `requireConferenceRole(..., 'Admin')` question `mayRun` derives `canRun` from and folding editability in the same way, so the flag means "this control will work" rather than "you would be allowed if anything here were writable". Binding Constraint FR5 is still enforced server-side; the flag only decides what is offered.

## Code Patterns & External References

```
# type | path#anchor                                                   | why needed (intent)
file   | api/src/routes/rounds.ts#authorizeWrite                        | The gate being layered on: the two primitives, in the shipped order, before the Admin check is inserted
file   | api/src/routes/rounds.ts#mayRun                                | Server-supplied capability flag: same canonical check as the write, editability folded in, consumed not re-derived
file   | api/src/rounds/post-it-repository.ts#remove                    | The write-statement-carries-its-own-guards idiom, and the diagnose-on-no-match answer this path deliberately inverts
file   | api/src/conferences/authorization.ts#createConferenceAuthorization | The Admin check, ROLE_RANK, and the neutral non-disclosing refusal
file   | api/src/conferences/lifecycle.ts#assertEditable                | The exact archived refusal code and sentence
file   | api/src/errors.ts                                              | The post-it refusal block and its one-code-per-next-action rule
file   | web/src/activities/SessionActivitiesPanel.tsx#writeToBoard     | The one board-write path: server's own sentence, panel-level error, board re-read either way
file   | api/test/post-it-structure.test.ts                             | The guards that must stay green unweakened, and the register a new guard is written in
file   | docs/specs/facilitator-board-and-categorisation/s05-discard-and-restore.md | The Discard storage shape and cascade this story consumes rather than re-derives
```

## Constraints & Gotchas

- **Critical**: `api/test/post-it-structure.test.ts` matches the author delete with a first-match regex, `/delete from post_it p[\s\S]*?returning p\.id/`, and asserts it carries `p.author_sub = $5` and `r.state = 'open'`. A second `delete from post_it` placed above it in the same file would be matched instead and would fail a guard that is describing a different statement -- Must be handled by: the permanent-removal statement living in its own module under `api/src/rounds/`, which also satisfies the `reaches the post_it table only from the rounds modules` guard.
- **Critical**: the same file's guard collects every SQL string in `post-it-repository.ts` in all three quote styles and asserts exactly **one** `count(`. Any counting this story needs belongs in the new module -- Workaround: none is needed; the guard is the module boundary, and relaxing it to make room is out of bounds.
- **Constraint**: `routes.matchAll(/postIts\.(contribute|edit|remove)\(/)` is asserted to find exactly three call sites. A new call named `postIts.remove…` on that object would be caught by it -- Workaround: the removal is called on the new seam, not on `postIts`.
- **Constraint**: permanent removal carries **no Round open/closed condition** and **no author condition** – it reaches any Post-it in the Conference at any Round state, unlike the author delete -- Workaround: do not copy `r.state = 'open'` or `p.author_sub = $5` across when following the write-path idiom.
- **Avoid**: `assertWritePreconditions` for the archived guard – there is no base version and nothing to conflict with -- Instead: `assertEditable` alone, after both authority checks, so a caller without authority learns nothing about the Conference's state.
- **Avoid**: rendering the removal refusal inside the Post-it or dialog its own handler unmounts -- Instead: hold it at panel level as `writeToBoard` already does (`docs/LEARNINGS.md#react-state--refusals`).
- **Avoid**: a structure guard written beside its fix that would pass without it, and a SQL-scanning guard that reads only one quote style -- Instead: revert the guarded property, confirm the guard count actually falls, and collect backtick, single- and double-quoted strings.

## Implementation Plan

### Implementation Tasks

- [x] **TI01** A permanent removal deletes the `post_it` row outright from its own seam, and matching nothing is success
  - New module under `api/src/rounds/` – the only place this statement lives, per **Constraints & Gotchas**. One `DELETE` scoped by conference, session, round and post-it id, with no author and no Round-state condition; zero rows deleted returns the same success as one. Follow `api/src/rounds/post-it-repository.ts#remove` for the statement shape and the outcome-union style, not for its `diagnose` answer.
  - **Verify**: `Test against real PostgreSQL: removing a stored Post-it leaves no post_it row for that id and advances the Round's activity watermark through the shipped delete trigger; removing an id that is already gone reports success, writes nothing and raises nothing; a Post-it on another Round of the same Session is not touched`

- [x] **TI02** A permanently removed Post-it takes its Discard trace with it through the schema's cascade, with no second deletion path
  - Consumes S05's `post_it_discard … ON DELETE CASCADE`; this task proves the behaviour rather than implementing it. No source on this path names `post_it_discard`.
  - **Verify**: `Test: after removing a discarded Post-it, no post_it_discard row exists for that id, the Facilitator's discarded list no longer returns it, and a subsequent restore for that id succeeds silently and returns nothing to the Board; a grep of this story's sources finds no delete against post_it_discard`

- [x] **TI03** Permanent removal is reachable only to a conference-wide Admin, only on a Conference that is not archived, and each actor gets its own sentence
  - `POST /api/conferences/:conferenceId/sessions/:sessionId/rounds/:roundId/post-its/:postItId/permanent-removal`, following the `/open`, `/close`, `/discard` sub-resource idiom and deliberately not overloading the author's `DELETE …/post-its/:postItId`. Check order per **Technical Overview**: shipped sorting-authority gate, then `requireConferenceRole(..., 'Admin')`, then `assertEditable`, then TI01's statement. New code in `api/src/errors.ts` beside the S02 post-it block for the Admin refusal, whose message is exactly `Only an admin can permanently remove a post-it. You can discard it instead.` The body schema names no actor field and, matching `postItBodySchema`, is not `additionalProperties: false`.
  - **Verify**: `Test: a Member with Membership only is refused with the neutral CONFERENCE_ROLE_REQUIRED sentence; a Presenter/Facilitator holding a Session Assignment is refused 403 with the admin/discard sentence and the row is still stored; an Admin holding no Session Assignment succeeds; on an archived Conference an Admin gets CONFERENCE_NOT_EDITABLE with the shipped archived sentence and the row is still stored; a body carrying actorSub is accepted and never read`

- [x] **TI04** The Session read tells each caller whether they may remove permanently, and the client holds no second opinion
  - A capability flag beside `canRun` in the Session read envelope (`api/src/routes/rounds.ts`), derived from the same `requireConferenceRole(..., 'Admin')` question TI03 enforces with and folding editability in as `mayRun` does; `web/src/api/client.ts` types follow. No role name, rank comparison or Admin test appears under `web/`.
  - **Verify**: `Test: the Session read returns the flag true for an Admin on a published Conference, false for an assigned Facilitator, and false for an Admin on an archived Conference; no source under web/ matches /\bAdmin\b/ in an authority decision`

- [x] **TI05** An Admin removes a Post-it from the Board after a confirmation that names its author and states the act cannot be undone – **SUPERSEDED 2026-08-31 (owner decision, in favour of OC01): the scope "the Board only" is no longer current. The control is also rendered per discarded Post-it on the discarded-Post-its surface, gated on the same `canRemovePermanently` flag, through the same `writeToBoard` seam, with the same confirmation component and wording. Everything else in this task stands as written. See Implementation Observations → Run: 2026-08-31 12:34 UTC, the amended Structural Criterion 5 above, `docs/wireframes/facilitator-board-and-categorisation/design-decisions.md` → "The discarded Post-its surface" → *Amendment – 2026-08-31*, and the ledger entry `c1-removal-unreachable-from-the-discarded-post-its-surface`.**
  - Control rendered per Post-it on the Facilitator's Board only when TI04's flag is true, in every region the Board has – Uncategorised and each Category. The confirmation carries the author's display name from the Board payload and states irreversibility; dismissing it sends nothing. The write goes through `web/src/activities/SessionActivitiesPanel.tsx#writeToBoard` so a refusal shows the server's sentence at panel level, the board is re-read either way, and nothing is queued. Consumes TI03's endpoint via `web/src/api/client.ts`. Copy and testids follow `docs/UBIQUITOUS_LANGUAGE.md`'s **Permanent Removal**.
  - **Verify**: `Test: with the flag false no removal control renders anywhere on the Board; with it true, opening the confirmation shows the author's name and an irreversibility statement, dismissing it issues no request and leaves the Post-it rendered, and confirming removes it from the Board after the re-read; a failed request leaves the Post-it rendered with the server's sentence and writes nothing to the offline queue`

- [x] **TI06** A permanently removed Post-it no longer counts as a Session contribution, by consequence rather than by a new condition
  - `countPostItsForSession` and `api/src/sessions/session-deletion.ts` are unmodified – the count falls because the row is gone. Record the contrast with S05's decision in a comment beside the count, and pin both halves with tests so neither can drift.
  - **Verify**: `Test: a Session whose only Post-it has been permanently removed is deleted successfully; the same Session whose only Post-it was merely discarded is still refused with SESSION_HOLDS_CONTRIBUTIONS`

- [x] **TI07** Structure guards hold the decisions working code could quietly undo
  - New guards beside `api/test/post-it-structure.test.ts`, in its register: the removal statement is outside `post-it-repository.ts` and that file's shipped assertions run unchanged and green; no source on this path names `post_it_discard`; no `web/` source decides Admin authority; no vote table, ballot or per-voter fact is named; no module-level mutable state; no new offline queue item kind or cache entry; `db/migrations/` gained nothing. Scan SQL strings in all three quote styles and pair every file-list assertion with a behavioural one.
  - **Verify**: `Test: reverting each guarded property in turn makes exactly that guard fail and the guard count falls; the shipped post-it-structure assertions all still pass unmodified`

- [x] **TI08** The Facilitator's Board with the removal control and its confirmation holds at all three widths
  - Extend `visual/session-activities.spec.ts` per `docs/KEY_DEVELOPMENT_COMMANDS.md`. Compare an element's own `scrollWidth` against its `clientWidth`, not the page's.
  - **Verify**: `npm run screenshots captures ~375, ~768 and ~1280 with no horizontal overflow on the Board or the open confirmation, including a Post-it whose text is an unbroken non-hyphenated run`

### Execution Contract

- TI01 precedes TI02, TI03 and TI06; TI03 precedes TI04 and TI05; TI04 precedes TI05.
- This story depends on S05 having landed: TI02 proves a cascade S05 creates, and TI06's second half asserts S05's opposite decision. It also depends on S02's Board read projection, which is what makes the counts fall without this story computing one.

## Implementation Observations

> _Managed by exec-spec post-implementation – append-only. Spec authors: leave this section empty._

### Run: 2026-08-30 21:14 UTC – discovered-requirements

#### DISCOVERED REQUIREMENTS

_Propagated by the exec-plan wave triage from S02 (2026-08-30) – not authored with this story._

- **The unlisted-Category fallback holds for every Board read.** A Post-it whose Category is absent from the same Board read renders in **Uncategorised**, never dropped. The Session read takes Categories and Post-its as two statements inside one `Promise.all` with no transaction between them, so a Category removed between the two leaves the Post-it snapshot naming a Category the Category snapshot no longer lists. Grouping strictly by id puts such a Post-it in *neither* bucket, contradicting `prd.md#fr2-the-uncategorised-holding-area`'s invariant that a non-discarded Post-it is in exactly one Category or in Uncategorised, never neither. Established and proved by S02 (`api/test/category.integration.test.ts`, "renders a post-it in uncategorised when its category is removed mid-read"). Any read this story adds over the Board must preserve it.

### Run: 2026-08-31 11:55 UTC – observations

#### NOTICED BUT NOT TOUCHING

- Pre-existing Prettier drift on four files this story does not touch: `api/test/display-link.integration.test.ts`, `api/test/join-code.test.ts`, `visual/conferences.spec.ts`, `web/src/components/JoinCodePanel.tsx`. `npm run format:check` reported them before and after; left alone rather than bundled into this story's diff. **Corrected 2026-09-02 (gap review G10):** only **three** of those files are long-standing – `api/test/join-code.test.ts`, `visual/conferences.spec.ts` and `web/src/components/JoinCodePanel.tsx`, named as pre-existing by S01 before this bundle wrote any code. `api/test/display-link.integration.test.ts` was **created by S04 in this bundle** and was never pre-existing; each story's per-story "not mine" rule was individually true and collectively wrong, with no bundle-scope backstop. It has been formatted, and `npm run format:check` now reports the three long-standing files only.
- Visual validation ran against the Vite dev server (`npm run dev:web`) rather than the composed stack, because `docker` is not on PATH in this environment. That is the fallback `docs/KEY_DEVELOPMENT_COMMANDS.md` documents for exactly this case; all three widths were captured and asserted.

#### ASSUMPTIONS

- **TI06 vs Structural Criterion 9.** TI06 asks for "the contrast with S05's decision in a comment beside the count", while the Structural Criterion says `countPostItsForSession` is "unmodified". Read as: the code is unmodified. One documentation paragraph was added above `countPostItsForSession` in `api/src/rounds/post-it-repository.ts`; no statement, condition or signature changed, and `permanent-removal-structure.test.ts` pins the count as still unconditional.
- **Two shipped guards were widened, not weakened.** `api/test/round-structure.test.ts` asserted that `PresenterFacilitator` was the only role ever asked for in `routes/rounds.ts`; S06 legitimately adds the `Admin` question, so the set is now `{PresenterFacilitator, Admin}` plus two assertions that did not exist before - the Admin check is asked in exactly one function (`holdsConferenceAdmin`), and that function is named as one of only two places a conference-wide check is correct. `api/test/round.integration.test.ts`'s Session-payload key list gained `canRemovePermanently`.
- **Seven web test payload builders** gained `canRemovePermanently: false` so they still satisfy the now-required field on `SessionWithRounds`; no behaviour in those suites depends on it.
- **`.button--danger`'s comment in `web/src/styles.css`** said it was "the only control in the app that is styled as destructive". Permanent Removal now wears it too, so the comment was corrected to name both acts and to say why Discard deliberately does not.

### Run: 2026-08-31 12:34 UTC – discovered-requirements

#### DISCOVERED REQUIREMENTS

- **The permanent-removal control belongs on the discarded Post-its surface too, not only on the Board's regions.** OC01 names three places a Post-it can be sitting when an Admin has to remove it: "sitting in Uncategorised, sitting in a Category, **or already Discarded**", and Acceptance Scenario S02 is written against a Post-it "sitting in the Facilitator's discarded-Post-its list awaiting a possible restore". TI05 was narrower than the outcome it serves: it scoped the control to "every region the Board has – Uncategorised and each Category", and S05 had already moved discarded Post-its off the Board entirely, so following TI05 literally left the third place with no control at all. The API half was built and proved; the client half was not, and S02's checkbox was carried on API evidence alone.

  The cost of the gap is the operational path FR5 exists for. The Post-its most likely to need permanent removal are exactly the ones a Facilitator has already discarded to get them off the wall, and an Admin's only route to one was to **restore** it first – republishing the abusive or confidential text to every Attendee's Board and the projected room screen on the next tick – and only then remove it.

  **The owner resolved the inconsistency in favour of OC01 on 2026-08-31**: the control is rendered on each discarded item, gated on the same `canRemovePermanently` flag the Board's control uses, writing through the same `writeToBoard` seam, with the same confirmation component and the same wording. TI05 as written is therefore exceeded, deliberately and by decision, rather than by drift.

  The concern `DiscardedPostIts.tsx` recorded – "a Facilitator on this surface must not find the irreversible act sitting beside the reversible one" – stays valid and is satisfied by the flag rather than by the control's absence: a Facilitator without conference-wide Admin is answered `false` and sees the restore control alone, which is now asserted on the same fixture that offers the control to an Admin (`web/test/PostItPermanentRemoval.test.tsx` → "offers a facilitator the restore and nothing else on the discarded surface"). The file's docblock was rewritten to say what is now true and why; no forward reference to S06 remains.

#### NOTICED BUT NOT TOUCHING

- **The armed confirmation still survives its Post-it leaving the surface it was opened on.** `permanentRemoval` is cleared on Cancel, at the end of `removePermanently` and on a Session switch, and by nothing else – so opening the confirmation on a Post-it that is then Discarded by somebody else leaves the state armed, and it renders again when the Post-it reappears. Rendering the confirmation from the pinned record rather than from live Board props (which is now what happens) does not close this: the two are different problems, one about *what* is quoted and one about *when* the dialog is armed. Recorded, not fixed. Note that the control now living on the discarded surface changes the symptom's shape: the confirmation can follow the Post-it from the Board to the discarded list rather than simply vanishing.
- **No visual capture of the removal control on the discarded Post-its surface.** `visual/session-activities.spec.ts` covers the Board's control and confirmation at all three widths (TI08); the discarded surface's copy of the same two components is not captured. The components are shared, so the markup and classes are identical, but the enclosing `discarded__item` layout is not the Board's and has not been measured.

### Run: 2026-08-31 12:34 UTC – review remediation

#### NOTICED BUT NOT TOUCHING

- **Review findings addressed in this run**, from `.agent_temp/reviews/facilitator-board-and-categorisation-s06-quick-review-claude-2026-08-31.md`:
  - **C1** – the discovered requirement above.
  - **C2** – `PermanentRemoval.authorName`/`.text` were dead: the confirmation rendered from the live Board props while two comments claimed the opposite protection. The confirmation is now rendered from the pinned record and from nothing on the surface around it, so the stated safety property exists. `confirmingRemoval` is the record rather than a boolean, which is what carries it.
  - **C4** – the removal module asserted "the only reason the statement can match nothing is that the Post-it is already gone", which the story's own integration test falsifies (a wrong-Round id answers `200 {removed:true}` with the row still stored). The behaviour is within spec and unchanged; the module note, the inline note and the route's two comments now state what the statement actually guarantees – *nothing is stored at the address the caller named* – and name the case that is not covered.
  - **C6** – `web/test/PostItPermanentRemoval.test.tsx`'s "confirmation is per post-it" assertion never opened a confirmation and could not fail. It now opens one and asserts the other two are absent; keying the dialog to a constant makes it fail.
  - **C7 (test half)** – a closed-Round client fixture was added, asserting the control renders and the write goes on a Round whose author-owned controls are gone. The correction-editor interaction the finding also names is untouched.
  - **C5, C8, C9** – Note-routed and left alone.
- **The confirmation and the control moved into `web/src/activities/PermanentRemoval.tsx`**, shared by the Board and the discarded surface, along with `shortened` (which the Board's Move and Discard labels also use). Testids, copy and classes are unchanged, so `visual/session-activities.spec.ts` and every shipped assertion are untouched by the move.

### Run: 2026-08-31 13:10 UTC – observations

#### OWNER DECISIONS

- **C1, the blocking finding, is resolved by adding the control.** An Admin could not permanently remove an already-Discarded Post-it from any UI surface: the API delivered it and was tested, but no client offered it. The only route was to **restore** the Post-it first – republishing it to every Attendee's Board and the projected room screen – then remove it, which for the abusive-content case this story exists for means putting the content back in front of the room in order to take it away. Root cause was a FIS-internal contradiction, not a coding miss: OC01 names "already Discarded" as one of three places removal must be available, while TI05 scoped the control to the Board. The worker implemented TI05 as written, and Acceptance Scenario S02 was honestly `[x]`, because its *Then* clauses are all API-level and were genuinely satisfied – no single checkbox was positioned to notice. The owner resolved it in favour of OC01.
- **Structural Criterion 5 was amended rather than the gating restructured** (owner, 2026-08-31). The added control sits inside the discarded surface's `canRun` block, so it is gated on sorting authority as well as Admin; the criterion as written said "only from a server-supplied capability flag" and was therefore literally false. Nobody's access changes – `canRun` is true for an assigned Facilitator or a conference-wide Admin, so every Admin passes it – and the discarded surface belongs behind `canRun` because it is a Facilitator surface. The rationale is also recorded in `DiscardedPostIts.tsx`'s docblock so a reader of the code finds it without the FIS.
- **Six further findings from the follow-up review were remediated by the orchestrator**, three of them the same species: a claimed property with no test that could fail.
  - **F2** – the confirmation-quotes-what-was-clicked safety property had no falsifiable test; every fixture gave the pinned and live values identically, so reverting to live props stayed green. Now pinned by `keeps the confirmation on what was clicked when the board changes underneath it`, proved red at `expected 'Permanently remove Bo Nilsson's post-…' to contain 'Ada Lovelace'` – the defect stated exactly: a dialog naming the wrong author for an irreversible act.
  - **F4** – an armed irreversible confirmation survived the surface being hidden and re-rendered on two clicks with no network, and `restore` awaited the panel's Board re-read before its own, so a `permanent-removal-<id>` testid could transiently match two nodes. Collapsing now disarms a confirmation this surface armed, and restore is refused while one is armed; both halves proved red independently.
  - **F5** – two structure guards read only `SessionActivitiesPanel.tsx` although the flag is now consumed in three files and a second `removePermanently` handler exists; both now sweep `sourcesUnder(activities)`, and the widened flag guard was proved to catch a `canRemovePermanently ?? …` re-derivation in `DiscardedPostIts.tsx` that would previously have shipped green.
  - **F3** – a comment claimed the refusal sentence renders above the list; it renders in `board-error-<roundId>` below the whole Board, and the comment now says so.
  - **F6** – an assertion that could not fail was removed rather than propped up; the zero-restore-calls assertion above it is the real guard.
  - **F10.1** – the stale closing paragraph corrected.
- **The visual gap the worker flagged is closed.** It had reported not running the captures after changing the discarded item's shape. Run: `visual/session-activities.spec.ts` 15/15 at 375/768/1280 against a live dev server, the three `session-activities-discarded-*` captures regenerated, and the 375px one inspected – the removal control and the restore control sit side by side and the layout holds.
