# S05 – Discard and restore

**Plan**: docs/specs/facilitator-board-and-categorisation/plan.json
**Story-ID**: S05

## Feature Overview and Goal

**Intent**: A misdrag in front of the room must not destroy a named colleague's idea, so a Facilitator needs a removal that takes noise off the Board and can still be taken back – built without weakening the shipped guarantee that an author removing their own Post-it leaves nothing behind.

**Expected Outcomes**

- [OC01] A Facilitator removes a Post-it from consideration and it stops appearing and stops counting on every surface, including its own author's – the Board reads as though it were not there.
- [OC02] Every Discard is reversible until the Conference is archived, from a surface the Facilitator reaches on their own device, and a restored Post-it comes back to Uncategorised rather than to where it was.
- [OC03] Author deletion still leaves no trace of any kind, and an author's delete that races a Discard wins and takes the Discard trace with it.
- [OC04] The categorised output excludes discarded Post-its while keeping the fact of the Discard, and whether a discarded Post-it still blocks Session deletion is a stated decision rather than an inherited accident.

## Required Context

- `docs/specs/facilitator-board-and-categorisation/prd.md#fr4-discard-and-restore` – the acceptance criteria, validation and error handling this FIS implements in full.
- `docs/specs/facilitator-board-and-categorisation/prd.md#user-stories` – US05 (recoverable Discard) and US10 (Categories, placements and Discards survive Round close, reopen and Session end) are this story's two user-facing claims.
- `docs/specs/facilitator-board-and-categorisation/prd.md#constraints` – **Binding Constraint FR4**, the defining one here: "Facilitator-initiated Discard must not reuse the author-deletion path. The shipped `post_it` migration deliberately carries no tombstone, soft-delete flag or `deleted_at`, because author deletion must leave no trace. Discard is a different concept with the opposite requirement; the two must stay apart in storage." Also binding: plain PostgreSQL only and no in-process state between requests (FR1), offline support is not widened (FR3), and no surface added here reads, joins to, or exposes Vote data (FR8).
- `docs/specs/facilitator-board-and-categorisation/prd.md#data-requirements` – what a Discard stores (who and when), the retention rule (as long as the Conference, including after archival, because the Report reads it), and the Reporting shape that excludes discarded Post-its while keeping their trace available to that slice.
- `docs/specs/facilitator-board-and-categorisation/prd.md#edge-cases` – the six rows this story owns: discard while in a Category, restore to Uncategorised, restore after archival, idempotent discard, the author-delete race, and an author finding their Post-it simply absent.
- `docs/specs/facilitator-board-and-categorisation/prd.md#dependencies` – names `post_it_delivery` as the shipped precedent, `post-it-repository.ts` as the author-delete path whose cascade must be confirmed, and `countPostItsForSession` as the Session-deletion count this story must decide on.
- `docs/specs/facilitator-board-and-categorisation/prd.md#decisions-log` – the four settled decisions this story implements without re-litigating: trace-and-restorable, restore-to-Uncategorised, the undo window ending at archival, and a Discarded Post-it being hidden from its author too.
- `docs/specs/facilitator-board-and-categorisation/plan.json#sharedDecisions` – S05 is the **producer** of "Discard state is stored outside the post_it row"; S06, S07 and S08 consume it. Also consumed here: S02's single Board read contract with Uncategorised as the absence of a placement, S02's sorting-authority gate, and the rule that Board writes advance the Member-visible activity watermark.
- `docs/specs/facilitator-board-and-categorisation/s03-placing-post-its-into-categories.md#architecture-decision` – the placement route (`PATCH …/rounds/:roundId/post-its/:postItId/placement`) and its one guarded statement in `post-it-repository.ts`, **whose predicate is the single place refusal conditions are added**. S03's `## Constraints & Gotchas` narrows FR3's *"A discarded Post-it cannot be placed; restore it first."* out of its own scope and hands it here: S05 amends that predicate with the not-discarded condition – never a second placement path, a second guard elsewhere, or a read-then-write pre-check. S03's TI01 owns the statement; its TI02 maps the outcome union to refusal codes.
- `docs/specs/facilitator-board-and-categorisation/prd.md#fr3-placing-post-its-into-categories` – Validation carries the rule this story is the receiver of: a discarded Post-it cannot be placed. Its Error Handling also fixes what a stale client sees when a Post-it is no longer on the Board.
- `db/migrations/20260828120000000_post-it.sql` – the shipped decision this story must not relax. Read its "What is deliberately absent" comment and the `advance_round_activity_watermark()` function, which is a named home to attach a trigger to rather than an expression to copy.
- `db/migrations/20260901090000000_post-it-delivery-record.sql` – the accepted precedent: a fact *about* a Post-it kept outside the `post_it` row expressly so it outlives that row, with a cascade and an explicit "what it deliberately is not" note. The Discard trace follows this shape and this documentation register.
- `api/src/rounds/post-it-repository.ts#remove` – the hard author-delete, gated on `author_sub` and `r.state = 'open'`, with no Discard awareness. It stays that way; the race outcome is the schema's cascade, not a predicate added here.
- `api/src/rounds/post-it-repository.ts#countPostItsForSession` – counts every `post_it` row for a Session with no state condition; `api/src/sessions/session-deletion.ts#sessionDeletionRefusalReason` consumes it.
- `api/src/routes/rounds.ts#authorizeWrite` – the sorting-authority gate (Session Assignment narrowing, Admin unconditional, then `assertEditable`) that discard and restore reuse unchanged.
- `api/test/post-it-structure.test.ts` – the guards that must stay green *unweakened*: "declares no count, tombstone, pending marker or email column", "deletes rather than flags, and keeps no per-author or per-round count" (which also caps `post-it-repository.ts` at exactly one `count(`), and "reaches the post_it table only from the rounds modules".
- `docs/wireframes/facilitator-board-and-categorisation/design-decisions.md#the-discarded-post-its-surface` – S01's second settled decision (its TI03/TI08): the shape of the reversal surface, that it is a place the Facilitator navigates back to rather than a toast or timed undo, that it carries a per-Post-it restore with who discarded it and when, and that a restore returns the Post-it to Uncategorised. The decision names the wireframe file that demonstrates it – read that file for the layout, including at 375px, and do not invent one. TI09 builds this surface.
- `docs/wireframes/facilitator-board-and-categorisation/design-decisions.md#the-non-drag-placement-interaction-model` – S01's first settled decision (its TI02/TI08) and the Facilitator sorting-surface wireframes it names at 375, 768 and 1280px: that surface is where the **per-Post-it Discard control** sits, next to the placement controls, keyboard-reachable and never pointer-only. TI08 adds the Discard control to it. `docs/wireframes/facilitator-board-and-categorisation/index.html` is the hub that resolves both decisions' wireframe filenames.

## Deeper Context

- `api/src/conferences/lifecycle.ts#assertEditable` – the one archived-Conference refusal (`CONFERENCE_NOT_EDITABLE`, 409) and its exact sentence.
- `api/src/conferences/authorization.ts#createConferenceAuthorization` – how the Session Assignment narrowing and the Admin-passes-unconditionally rule are resolved per request.
- `docs/adrs/ADR-006-vote-anonymity-holds-against-application-paths-not-database-credentials.md` – the guarantee this story must leave untouched; it handles Post-its only.
- `docs/DECISIONS.md` – the Current ADRs index this story adds a row to; ADR-007 is the highest number in use.
- `web/src/activities/SessionActivitiesPanel.tsx#writeToBoard` – the shipped one-path board write: the refusal is the server's own sentence, stored at panel level so the re-read cannot take it off screen, and the board is re-read either way.
- `docs/LEARNINGS.md` – Concurrency (`clock_timestamp()` over `now()`), Testing (a guard written beside its fix usually passes without the fix; a SQL-scanning guard must read all three quote styles), and CSS / Responsive Layout (measure an element's own `scrollWidth`).

## Acceptance Scenarios

- [x] **S01 [OC01] [TI02,TI03,TI04,TI05,TI08] A Post-it discarded out of a Category leaves the Board and that Category's count falls**
  - **Given** a Post-it Round whose Board has a Category "Tooling" holding three Post-its, one of them Ada's "we need a staging box"
  - **When** a Facilitator holding a Session Assignment on that Round's Session discards Ada's Post-it
  - **Then** the Board read no longer returns it under "Tooling" or under Uncategorised, "Tooling" reports two, the Uncategorised count is unchanged, and the Round's activity watermark has advanced so the rest of the room sees the same Board on their next poll

- [x] **S02 [OC01] [TI05,TI08] A discarded Post-it is absent from its own author's Board, with no marker and no delete control**
  - **Given** Ada's Post-it has been discarded while its Round is still open
  - **When** Ada opens that Session's activities on her own phone
  - **Then** her Post-it is simply not on the Board – no "set aside" marker, no notification – and no delete control is rendered against it

- [x] **S03 [OC02] [TI03,TI09] A restore returns the Post-it to Uncategorised, never to the Category it came from**
  - **Given** Ada's Post-it was discarded out of "Tooling" the previous afternoon, and the Conference is published rather than archived
  - **When** the Facilitator opens this Board's discarded Post-its on their own device and restores it
  - **Then** it reappears on the Board in **Uncategorised**, the Uncategorised count rises by one, "Tooling" is unchanged, and it is gone from the discarded list

- [x] **S04 [OC02] [TI03,TI04] Discard and restore are idempotent – the requested end state is the one that holds**
  - **Given** Ada's Post-it is already discarded and Bo's Post-it has never been discarded
  - **When** a Facilitator discards Ada's Post-it a second time, and separately restores Bo's Post-it
  - **Then** both requests succeed with no message, Ada's Post-it stays discarded with its original discarder and instant intact and no second trace row, and Bo's Post-it stays exactly where it was on the Board

- [x] **S05 [OC02] [TI04,TI09] A restore after the Conference is archived is refused, naming the archived state**
  - **Given** the Conference holding that Board has been archived, and Ada's Post-it is discarded
  - **When** a Facilitator attempts to restore it
  - **Then** the API refuses with `CONFERENCE_NOT_EDITABLE` and the sentence "This conference has been archived, so it is read-only and can no longer be changed.", the Post-it stays discarded, and the same refusal answers an attempt to discard on an archived Conference

- [x] **S06 [OC03] [TI02,TI06] An author's delete racing a Discard wins and takes the Discard trace with it**
  - **Given** Ada's Post-it has been discarded while its Round is still open, and Ada's device still holds a delete already in flight against it
  - **When** that delete reaches the API
  - **Then** the delete succeeds, the `post_it` row goes, the Discard trace goes with it through the schema's own cascade rather than through anything the delete path knows about Discard, no trace remains for that id, and nothing anywhere records that the Post-it existed

- [x] **S07 [OC04] [TI07] A Session whose only Post-it is discarded still refuses deletion as holding contributions**
  - **Given** a Session with one Post-it Round holding exactly one Post-it, which a Facilitator has discarded
  - **When** an Organizer attempts to delete that Session
  - **Then** deletion is refused with `SESSION_HOLDS_CONTRIBUTIONS`, the message counts that Post-it, and the Session survives – because its text is still stored and still restorable, unlike a withdrawn submission whose row is already gone

- [x] **S08 [OC01,OC02] [TI03,TI05] A placement against a discarded Post-it is refused, and a later restore still returns it to Uncategorised**
  - **Given** Ada's Post-it was discarded out of "Tooling", and a second Facilitator's Board was read just before the Discard so their client still shows it sitting there
  - **When** that stale client places Ada's Post-it into "Hiring"
  - **Then** the placement is refused by the placement statement's own predicate rather than by any read taken first – Ada's Post-it holds no placement, "Hiring"'s count is unchanged, and the surface re-reads the Board and states it changed – **and** when a Facilitator afterwards restores Ada's Post-it it comes back under **Uncategorised**, not under "Hiring" and not under "Tooling"

## Structural Criteria

- [x] ADR-008 exists as an Accepted ADR recording why the two removal paths stay apart in storage, is indexed in `docs/DECISIONS.md`, and was authored before the migration that appears to contradict the shipped comment.
- [x] `db/migrations/20260828120000000_post-it.sql` is unmodified, and `api/test/post-it-structure.test.ts`'s tombstone, "deletes rather than flags" and post_it-table-reach guards stay green with no assertion relaxed, re-scoped or deleted.
- [x] `post-it-repository.ts#remove` carries no Discard predicate and no Discard-aware branch; the trace's removal on author delete is the foreign key's `ON DELETE CASCADE`, provable from the schema alone.
- [x] Discard, restore and the discarded-list read go through `routes/rounds.ts#authorizeWrite`'s existing gate; there is no second authority path, and the discarder identity comes only from the verified credential, never from a request body or query.
- [x] Discard state is plain PostgreSQL – no extension, no provider-specific type or function – persisted, with no module-level mutable state and no new offline queue item kind, cache entry or replay buffer.
- [x] No Discard path – migration, repository, route or web surface – reads, joins to, or exposes Vote data.
- [x] The Facilitator's Board and the discarded-Post-its surface render without horizontal overflow at ~375px, ~768px and ~1280px.

## Scope & Boundaries

### Work Areas

- `docs/adrs/ADR-008-*.md` and the `docs/DECISIONS.md` Current ADRs row.
- A new migration under `db/migrations/`, timestamped after S02's Category and placement migration, creating the Discard trace table, its cascade and its watermark trigger.
- A new module under `api/src/rounds/` owning the discard, restore and discarded-list statements plus the exclusion predicate the Board reads apply.
- `api/src/routes/rounds.ts` – the discard, restore and discarded-list endpoints behind the shipped authority and archived gates.
- `api/src/rounds/post-it-repository.ts` – S03's placement statement (its TI01): its existing predicate gains the not-discarded condition. That one clause is the whole of this story's change to the placement path; the route, its body and its authority gate are untouched.
- `api/src/rounds/post-it-repository.ts#countPostItsForSession` and `api/src/sessions/session-deletion.ts` – the counting decision, asserted rather than changed.
- `web/src/activities/SessionActivitiesPanel.tsx` and `web/src/api/client.ts` – the Facilitator's discard control, the discarded-Post-its surface with restore, and the online-only failure path.
- `api/test/`, `web/test/` and `visual/` – the structure guards, integration coverage and three-width capture.

### What We're NOT Doing

- **Admin permanent removal** – S06's, including what happens when one lands on an already-discarded Post-it. This story only guarantees the trace is removable with the row.
- **The projected Board View and the Attendee's live Board** – S07 and S08. Both consume this story's read-exclusion rule; neither surface is built here.
- **A Report that reads Discard traces** – REQ-023 / REQ-024. This story stores and retains the trace and keeps it out of the categorised output; nothing renders it.
- **Any change to author deletion** – the shipped path, its open-Round condition and its no-trace guarantee are untouched, which is the whole point of keeping the two apart.
- **Offline discard or restore** – both require connectivity. The shipped queue takes Post-it contributions only and gains nothing here.

## Architecture Decision

**Approach**: One row per discarded Post-it in a new table keyed on the Post-it and cascading from it – its presence *is* the Discard and its absence *is* not-discarded – so restore is the removal of that row and an author's hard delete takes the trace with it structurally. See ADR: `docs/adrs/ADR-008-facilitator-discard-is-stored-outside-the-post-it-row.md`.
**Why this over alternatives**: A column on `post_it` is the one shape the shipped migration deliberately refuses, and it would make "no trace" and "a trace" the same storage decision; `post_it_delivery` already established that a fact about a Post-it kept outside its row is how this schema expresses exactly this.

## Technical Overview

**The storage shape.** A table – `post_it_discard` – with `post_it_id` as its primary key referencing `post_it (id) ON DELETE CASCADE`; `round_id` carried and pinned to the Post-it's own Round by composite foreign key (the `round_id_kind_conference_unique` idiom); `discarded_by_sub` referencing `app_user (sub)`; and `discarded_at timestamptz NOT NULL DEFAULT clock_timestamp()`. The discarder's display name is joined at read time, never copied. `round_id` is carried so an `AFTER INSERT OR DELETE` trigger can attach to the shipped `advance_round_activity_watermark()` – which keys on `NEW.round_id` / `OLD.round_id` – rather than copying its `GREATEST` expression a second time.

**The cascade.** Deleting a `post_it` row removes its trace; deleting a Round, Session or Conference removes it through the Post-it's own cascade. No path leaves an orphan trace, so the author-delete race has a defined outcome without `remove()` learning anything about Discard.

**The read-exclusion rule** (consumed by S06, S07 and S08). A Post-it with a `post_it_discard` row is excluded – by anti-join in the statement itself, never by post-filtering in a handler – from every read that returns Post-its: S02's Board read projection and its per-Category and Uncategorised counts, the shipped `listForSession`, and every surface downstream of them. Exactly two reads select *on* the presence of the row: the Facilitator's discarded-Post-its list, and the future Report slice.

**Discard clears the placement in the same statement**, so restore is only the removal of the trace and "returns to Uncategorised" follows from S02's rule that Uncategorised is the absence of a placement – a structural consequence rather than a rule the restore path has to remember. That consequence holds only because the placement statement itself refuses a discarded Post-it (TI03): without the not-discarded condition in S03's predicate a Post-it could be placed while invisible, and the restore would hand it back to that Category – which FR4 and OC02 forbid.

**The Session-deletion decision, stated: a discarded Post-it still counts as a contribution and still blocks Session deletion.** `countPostItsForSession` keeps no state condition and is unchanged. The guard protects rows that still hold a named colleague's text, and a Discard leaves that text intact and restorable until archival, so deleting the Session would destroy something recoverable with no way back. The delivery-record story chose the opposite for a withdrawal because there the `post_it` row is already gone and nothing remained to protect; both are the same rule applied to different facts.

## Code Patterns & External References

```
# type | path#anchor                                                  | why needed (intent)
file   | db/migrations/20260901090000000_post-it-delivery-record.sql  | Precedent and comment register: a fact about a Post-it, outside its row, cascading, with an explicit "what it deliberately is not"
file   | db/migrations/20260828120000000_post-it.sql                  | advance_round_activity_watermark() – attach a trigger to it, never copy the GREATEST expression
file   | api/src/rounds/post-it-repository.ts#remove                   | Guard-in-the-predicate idiom, and the diagnose-after-the-fact pattern for a write that matched nothing
file   | api/src/routes/rounds.ts#authorizeWrite                       | Authority then archived guard, in that order, with actor identity from the credential
file   | api/src/conferences/lifecycle.ts#assertEditable               | The exact archived refusal code and sentence
file   | web/src/activities/SessionActivitiesPanel.tsx#writeToBoard    | The one board-write path: server's own sentence, panel-level error, board re-read either way
file   | api/test/post-it-structure.test.ts                            | The shape a structure guard takes here, and the guards that must stay green
wire   | docs/wireframes/facilitator-board-and-categorisation/design-decisions.md#the-discarded-post-its-surface | S01's settled shape for the reversal surface and the wireframe file it names – TI09's layout, including 375px
wire   | docs/wireframes/facilitator-board-and-categorisation/design-decisions.md#the-non-drag-placement-interaction-model | The Facilitator sorting-surface wireframes that decision names – where TI08's per-Post-it Discard control sits, keyboard-reachable
```

## Constraints & Gotchas

- **Critical**: `api/test/post-it-structure.test.ts` asserts `post-it-repository.ts` matches no `deleted_at|is_deleted|tombstone|soft` and contains exactly **one** `count(`. Discard statements therefore belong in a new module under `api/src/rounds/`, not in that file -- Workaround: none is needed; the guard is the module boundary, and weakening it to make room is out of bounds.
- **Critical**: `advance_round_activity_watermark()` reads `round_id` off the changed row. A trace table without `round_id` cannot attach to it -- Must handle by: carrying `round_id` on the trace and pinning it to the Post-it's Round by composite foreign key, rather than writing a second copy of the `GREATEST` expression.
- **Avoid**: `now()` in any trigger or default – it is transaction-start time, so two writes in one transaction stamp identically and a poll never sees the second -- Instead: `clock_timestamp()`, per `docs/LEARNINGS.md` (PostgreSQL Date/Time via node-postgres).
- **Avoid**: `assertWritePreconditions` for the archived guard – sorting is last-write-wins with no base version -- Instead: `assertEditable` alone, asserted after authority so a caller without authority learns nothing about the Conference's state.
- **Constraint**: Discard carries **no Round open/closed condition** – sorting may begin before a Round closes and continues after it – unlike author deletion, which keeps its `r.state = 'open'` guard -- Workaround: do not copy that predicate across when following the write-path idiom.
- **Constraint**: a failed discard or restore is surfaced and never queued; the shipped offline queue takes contributions only -- Workaround: route both through `writeToBoard`, which already states the server's refusal and re-reads the board.
- **Avoid**: a structure guard written beside its fix that would pass without it, and a SQL-scanning guard that reads only one quote style -- Instead: revert the guarded property and confirm the guard actually falls, and collect backtick, single- and double-quoted strings.

## Implementation Plan

### Implementation Tasks

- [x] **TI01** An Accepted ADR records why Facilitator Discard is stored outside the `post_it` row, and `docs/DECISIONS.md` indexes it
  - `docs/adrs/ADR-008-facilitator-discard-is-stored-outside-the-post-it-row.md`, following `docs/adrs/ADR-007-*.md`'s shape. It names the shipped comment it appears to contradict, shows the contradiction is only apparent because the two acts differ, and cites `post_it_delivery` as the accepted precedent. Written **before** TI02.
  - **Verify**: `The ADR exists with status Accepted, cites db/migrations/20260828120000000_post-it.sql and db/migrations/20260901090000000_post-it-delivery-record.sql by path, and docs/DECISIONS.md's Current ADRs table carries an ADR-008 row linking to it`

- [x] **TI02** A Discard trace is persisted outside `post_it`, cascades with it, and advances the Round's activity watermark
  - New migration; shape per **Technical Overview**, with a reversible down step, commented in the register of the delivery-record migration including what it deliberately is not (not a tombstone for author deletion, not a soft delete on `post_it`).
  - **Verify**: `Test against real PostgreSQL: a trace records its discarder and its instant and survives Round close, Round reopen and Conference archival; inserting one advances the Round's activity_watermark (the bigint cursor from activity_watermark_seq); deleting the post_it row removes the trace leaving no orphan; a trace naming a different round_id than its Post-it's is refused by the foreign key; the migration text contains no CREATE EXTENSION and no now()`

- [x] **TI03** Discard, restore and the discarded-list read exist behind one repository seam, idempotent, with discard clearing the placement and a discarded Post-it no longer placeable
  - New module under `api/src/rounds/`, guards in the write statement's own predicate per `post-it-repository.ts`. Discard inserts, does nothing on conflict, and clears the Post-it's placement in the same transaction; restore deletes the trace and matching nothing is success. The list joins the Post-it, its author's display name and the discarder's, and is the only read selecting on the trace's presence.
  - **Also delivered here – FR3's not-discarded rule, handed over by S03**: S03's placement statement (`s03-placing-post-its-into-categories.md#architecture-decision`, its TI01) gains the not-discarded condition **inside its existing predicate** – an anti-join or `NOT EXISTS` against `post_it_discard`, the same mechanism as TI05's read exclusion. That predicate is the single place refusal conditions are added: no second guard in the route or the surface, no pre-check read, and no change to the placement route's shape or body. A refused placement resolves through S03's existing matched-nothing outcome for a Post-it no longer on the Board.
  - **Verify**: `Test: a second discard leaves discarded_by_sub and discarded_at unchanged and creates no second row; a restore of a never-discarded Post-it reports success and moves nothing; a Post-it discarded out of a Category has no placement afterwards; the discarded list returns text, author name, discarder name and instant; placing a discarded Post-it is refused, leaves its placement null and the destination Category's count unchanged, and restoring it afterwards returns it to Uncategorised rather than to that destination; the placement path issues no read before its write and carries no discard check outside the statement's predicate`

- [x] **TI04** Discard, restore and the discarded list are reachable only to sorting authority and only on a Conference that is not archived
  - Endpoints on `api/src/routes/rounds.ts` as sub-resources of the Post-it, following the `/open` and `/close` idiom, all three through `authorizeWrite`; statements come from TI03's seam. Authority is asserted before the lifecycle check so a caller without it learns nothing further.
  - **Verify**: `Test: a Member holding Membership only is refused CONFERENCE_ROLE_REQUIRED at the discard route; a conference-wide Admin with no Session Assignment succeeds; on an archived Conference both discard and restore return CONFERENCE_NOT_EDITABLE with the archived sentence; no route reads a discarder from a body or query`

- [x] **TI05** No read returns a discarded Post-it except the Facilitator's discarded list
  - Apply TI03's exclusion predicate to S02's Board read projection and its counts, and to `post-it-repository.ts#listForSession`, as an anti-join in the statement. This is the shared decision S06, S07 and S08 read through; do not add a second filtering site.
  - **Verify**: `Test: after a discard, the Board read omits the Post-it and both the owning Category's count and the Uncategorised count reflect its absence; the Session activities read omits it for its own author as well as for everyone else; no handler filters a discarded Post-it out of a result set in TypeScript`

- [x] **TI06** The author-delete path is unchanged and its race with a Discard has a proved outcome
  - `post-it-repository.ts#remove` gains nothing; this task consumes TI02's cascade and proves the behaviour rather than implementing it.
  - **Verify**: `Test: deleting one's own discarded Post-it while the Round is open succeeds, removes the post_it row, leaves no post_it_discard row for that id, and leaves the Round's watermark advanced; post-it-repository.ts still matches no deleted_at|is_deleted|tombstone|soft`

- [x] **TI07** A discarded Post-it still counts as a contribution blocking Session deletion, by decision rather than by accident
  - `countPostItsForSession` keeps no state condition and `session-deletion.ts` is unchanged. Record the decision in a comment at `countPostItsForSession` naming the delivery-record contrast, and pin it with a test so a later state condition cannot be added silently.
  - **Verify**: `Test: a Session whose only Post-it is discarded is refused deletion with SESSION_HOLDS_CONTRIBUTIONS and the message counts that Post-it; a Session whose only submission was withdrawn before delivery stays deletable`

- [x] **TI08** A Facilitator discards a Post-it from the Board on their own device, from Uncategorised or from any Category
  - Control on each Post-it on the Facilitator's Board per S01's wireframes; the write goes through `SessionActivitiesPanel.tsx#writeToBoard` so a network failure states the server's sentence, leaves the Post-it where it was and queues nothing. Consumes TI04's endpoints.
  - **Verify**: `Test: discarding removes the Post-it from the rendered Board and drops its Category's count after the re-read; a failed request leaves the Post-it rendered with a stated failure and writes nothing to the offline queue`

- [x] **TI09** The Facilitator reaches this Board's discarded Post-its and restores one from there
  - Surface per S01's wireframes – it is the only place a Discard can be reversed and the undo window runs to archival, so it is not an ephemeral undo affordance. Shows who discarded it and when; restore uses TI04's endpoint through `writeToBoard`.
  - **Verify**: `Test: the surface lists a discarded Post-it with its author and its discarder; restoring it removes it from the list and returns it to Uncategorised on the Board; on an archived Conference the restore's refusal is rendered and the item stays listed`

- [x] **TI10** Structure guards hold the two removal paths apart and keep the Discard surface off Vote data
  - New guards beside `api/test/post-it-structure.test.ts`, in its register: the shipped `post_it` migration and its guards unmodified; the new migration free of extensions and provider-specific features; no Discard source naming `vote` or `ballot`; no module-level mutable state; no new offline queue item kind. Scan SQL strings in all three quote styles.
  - **Verify**: `Test: reverting each guarded property in turn makes exactly that guard fail, and the guard count falls; the shipped post-it-structure assertions run unchanged and green`

- [x] **TI11** The Facilitator's Board and the discarded-Post-its surface hold at all three widths
  - Extend `visual/session-activities.spec.ts` per `docs/KEY_DEVELOPMENT_COMMANDS.md`. Compare an element's own `scrollWidth` against its `clientWidth`, not the page's.
  - **Verify**: `npm run screenshots captures ~375, ~768 and ~1280 with no horizontal overflow on either surface, including a Post-it whose text is an unbroken non-hyphenated run`

### Execution Contract

- TI01 completes before TI02: the ADR records a decision the migration then implements, and writing it afterwards makes it a rationalisation rather than a decision.
- TI02 precedes TI03 and TI06; TI03 precedes TI04, TI05 and TI08; TI04 precedes TI08 and TI09.
- This story's migration is timestamped after S02's Category and placement migration, and TI03's placement clearing depends on S02's placement storage existing.
- TI03's amendment to S03's placement predicate depends on S03 having landed (this story `dependsOn` S03) and is the **receiver of S03's explicit narrowing note**: FR3's *"A discarded Post-it cannot be placed; restore it first."* is implemented and proved here – by TI03 and scenario S08 – and nowhere else in the bundle. Leaving it out would leave a P0 PRD validation rule unimplemented across every story.

## Implementation Observations

> _Managed by exec-spec post-implementation – append-only. Spec authors: leave this section empty._

### Run: 2026-08-30 21:14 UTC – discovered-requirements

#### DISCOVERED REQUIREMENTS

_Propagated by the exec-plan wave triage from S02 (2026-08-30) – not authored with this story._

- **The unlisted-Category fallback holds for every Board read.** A Post-it whose Category is absent from the same Board read renders in **Uncategorised**, never dropped. The Session read takes Categories and Post-its as two statements inside one `Promise.all` with no transaction between them, so a Category removed between the two leaves the Post-it snapshot naming a Category the Category snapshot no longer lists. Grouping strictly by id puts such a Post-it in *neither* bucket, contradicting `prd.md#fr2-the-uncategorised-holding-area`'s invariant that a non-discarded Post-it is in exactly one Category or in Uncategorised, never neither. Established and proved by S02 (`api/test/category.integration.test.ts`, "renders a post-it in uncategorised when its category is removed mid-read"). Any read this story adds over the Board must preserve it.

### Run: 2026-08-31 07:53 UTC – discovered-requirements

#### DISCOVERED REQUIREMENTS

_Propagated by the exec-plan wave triage from S03 (2026-08-31) – not authored with this story._

- **Placement refusal has two sites, not one.** S03's `place` predicate in `api/src/rounds/post-it-repository.ts` is a flat conjunction, and its docblock invites this story to append the not-discarded conjunct there. **That alone is not sufficient.** `diagnosePlacement`, in the same module, answers `destination-missing` for **every** case in which the `post_it` row is still found – so a discarded Post-it matches zero rows in the `UPDATE` while the diagnosis `SELECT` finds it, and the caller is refused with `CATEGORY_NOT_FOUND` (*"that category is not on this board"*) about a destination that was perfectly valid. `PlacementOutcome` also carries no member for the discarded case, so the union widens too. Neither `tsc`, `eslint` nor the structure guards catch this: the structure test asserts only the predicate's conjuncts. **Change both sites together, and add a test that names the discarded case explicitly.** Recorded as CLOSED in `s03-placing-post-its-into-categories.reconciliation-ledger.md`; S03 closed it by documentation rather than restructuring, deliberately leaving the choice of correction to this story.

### Run: 2026-08-31 10:13 UTC – observations

#### NOTICED BUT NOT TOUCHING

- Pre-existing Prettier drift in files this story did not change: `web/src/components/JoinCodePanel.tsx`, `api/test/join-code.test.ts`, `visual/conferences.spec.ts`, and the untracked `api/test/display-link.integration.test.ts` (S04). `npx prettier --check .` reports them; none is on this story path. **Corrected 2026-09-02 (gap review G10):** only **three** of those files are long-standing – `api/test/join-code.test.ts`, `visual/conferences.spec.ts` and `web/src/components/JoinCodePanel.tsx`, named as pre-existing by S01 before this bundle wrote any code. `api/test/display-link.integration.test.ts` was **created by S04 in this bundle** and was never pre-existing; each story's per-story "not mine" rule was individually true and collectively wrong, with no bundle-scope backstop. It has been formatted, and `npm run format:check` now reports the three long-standing files only.
- `visual/shell.spec.ts`s three signed-in cases need a live API. They pass against the composed stack (`http://127.0.0.1:8082`) and fail against `npm run dev:web`, whose `/api` proxy targets port 8080 while the composed API publishes 8081. Environment artifact, not a regression.
- `visual/session-activities.spec.ts`s main organizer test does not stub `**/rounds/round-post-it/display-link`, so the Display Link control renders a 404 alert inside those captures (pre-existing since S04). The new discarded-post-its route is stubbed, so this storys surface renders fully.

#### ASSUMPTIONS

- **The Discard instant is formatted server-side** as `YYYY-MM-DD HH:MM UTC` and reaches the wire as a display string. `board-wire.ts` already refuses to put an instant on the wire (`edited` carries no `edited_at`) because the product stores no venue timezone and `web/src/schedule/wall-clock-time.ts` forbids constructing a `Date`; formatting in the seam keeps that discipline while still showing "when". The format is numeric rather than `DD Mon YYYY` so it does not depend on the servers `lc_time`.
- **A refused placement against a discarded Post-it gets its own code**, `POST_IT_DISCARDED` (409). Neither existing code fits: `POST_IT_NOT_FOUND` would be false (the Post-it is stored and restorable) and `CATEGORY_NOT_FOUND` names a destination that was valid. The next action - restore it first - is what earns the code under `errors.ts` one-code-per-reason rule.
- **The reversal surface is an always-present control on the Board rather than a URL.** S01s decision calls for a page with an address; the SPA has no client-side router (S04 recorded the same constraint), so permanence and return-to-it-later are implemented by a toolbar entry point that is drawn whether or not anything is discarded. It is not a toast and not a timed undo.
- **Two shipped tests were extended rather than relaxed.** `api/test/display-link-structure.test.ts` gains `post_it_discard` in its written table allow-list, because the projected Board read now anti-joins the trace to exclude discarded Post-its; the table carries no Vote data. `web/test/PostItPlacement.test.tsx` gains an explicit count assertion for the cursor-keyed discarded-list read, so S03s "no per-move request" property stays pinned rather than widened.

### Run: 2026-08-31 10:34 UTC – discovered-requirements

#### DISCOVERED REQUIREMENTS

_Found by S05 during implementation and its fresh-context critic review (2026-08-31). S06, S07 and S08 consume the Discard shared decision and inherit these._

- **The discarded-Post-its list is refused once the Conference is archived, and that is a consequence of Structural Criterion 4 rather than a decision anyone took.** `GET .../rounds/:roundId/discarded-post-its` goes through `routes/rounds.ts#authorizeWrite`, which ends in `assertEditable` – the FIS requires exactly that ("Discard, restore and the discarded-list read go through `authorizeWrite`'s existing gate; there is no second authority path"). So after archival the surface answers `CONFERENCE_NOT_EDITABLE` for a request that changes nothing, while `post_it_discard` still holds every trace, retained "as long as the Conference, including after archival, because the Report reads it" (`prd.md#data-requirements`). Nothing is lost – the trace is intact and TI09's "the item stays listed" still holds, because the client keeps the list it already read – but a Facilitator opening the surface fresh after archival reads the archived sentence instead of the list. **The Report slice (REQ-023 / REQ-024) is the story that must settle this**, and the shipped precedent for the fix already exists: S04's Display Link read deliberately splits authority from editability for exactly this reason (`routes/rounds.ts`, the gate above `DISPLAY_LINK_URL`). Changing it here would have added the second authority path Structural Criterion 4 forbids.

- **`post-it-repository.ts#edit` carries no not-discarded condition, and the omission is unstated.** S05 amended `place` deliberately and left `remove` alone deliberately, both documented and both tested. `edit` was neither. Its predicate is `p.author_sub = $5 and r.state = 'open'`, so an author whose client read the Board before the Discard can still commit a correction to a discarded Post-it's text: the text changes, `edited_at` is stamped, the watermark advances, and the API returns a Post-it that no Board read will return. The text the Facilitator sees in the discarded list – and the text a restore puts back in front of the room – can therefore change under them. Whether that should be refused (like a placement) or allowed (like the author's delete, which wins its race) is a **product decision this story did not have**, so it is recorded rather than guessed.

- **A discarded Post-it never carries a `category_id`, and three `category-repository.ts` statements depend on it.** `heldBy`, the occupied-Category reassignment, and the Category-delete occupancy guard all read `post_it.category_id` with no Discard awareness, so each is correct only while that invariant holds. It now holds three times over – the Discard clears the placement, `place` refuses a discarded Post-it, and `restore` clears it again to close the EvalPlanQual window where `place`'s `NOT EXISTS` sub-select is re-checked against the command's original snapshot. The dependency is written down in `api/test/discard-structure.test.ts`'s exception list, which fails on any new statement naming `post_it` that neither excludes discarded rows nor is classified there. Any story adding a read over `post_it` must classify it in that list.

- **The Board read and the discarded-list read are two snapshots, so one Post-it can appear on both for one poll tick.** `DiscardedPostIts` re-reads when the Session's `activityWatermark` moves, and the list request is issued after the Session payload lands – so a Discard taken on another device between the two leaves the Post-it drawn on the Board (with a Discard control) and in the discarded list (with a Restore control) until the next tick. Both controls are idempotent so nothing breaks, and the next tick agrees. It is the same two-statement skew S02 recorded for the Categories/Post-its pair, and it would need a single combined read to remove.

### Run: 2026-08-31 11:30 UTC – observations

#### OWNER DECISIONS

- **The `edit` omission is now a decision, not an oversight.** The owner was asked whether an author may correct a discarded Post-it and chose **allow, like author deletion**: `edit` follows `remove` rather than `place`, because an author owns their words whether or not a Facilitator has set the Post-it aside – the same rule that already lets an author's deletion win its race against a Discard. The consequence is accepted rather than hidden: an author whose client read the Board before the Discard can still commit a correction, so the text in the Facilitator's discarded list, and the text a restore puts back in front of the room, can change under them. The rejected alternative was refusing the edit for consistency with `place`. Recorded in `post-it-repository.ts#edit`'s docblock and pinned by a new integration test, `lets the author correct a discarded post-it, and the discarded list shows the new text`, which also asserts the correction does not restore it and that no Board read returns it. Suite after: 87 files / 1456 tests.

- **The review's HIGH correctness finding was real and is fixed.** `place`'s not-discarded conjunct is a `NOT EXISTS` sub-select, and under READ COMMITTED EvalPlanQual re-checks only the target relation – so a placement blocked on the Discard's row lock could still commit a `category_id` onto a discarded Post-it, and a later restore would hand it back to that Category. `restore` now clears the placement in its own statement, removing the dependence rather than narrowing the window.

- **Process note for the record.** This story's review produced **no report file** under `.agent_temp/reviews/` – its findings were recorded inline on this FIS instead. The findings themselves are specific and their remediations verified, so this is a traceability gap rather than a correctness one, but it means there is no independent artifact to re-read for S05.
