# S02 – Categories, Uncategorised and Sorting Authority

**Plan**: docs/specs/facilitator-board-and-categorisation/plan.json
**Story-ID**: S02

## Feature Overview and Goal

**Intent**: A Post-it Round's Board is a flat chronological list today, so a Facilitator has nowhere to put the structure the room is asking for – this story gives the Board named buckets, a holding area for everything not yet sorted, and one server-enforced answer to who may change either.

**Expected Outcomes**:

- [OC01] A Facilitator holding authority on the Round's Session creates, renames, reorders and removes named Categories on that Round's Board from their own device at 375, 768 and 1280 px, at any Round state and whether or not the Board already holds Post-its.
- [OC02] Every surface reads one Board projection in one request: Categories in the Facilitator's order with their Post-its and per-Category counts, plus the Uncategorised holding area with its live count – present whether or not any Category or any Post-it exists.
- [OC03] Every Board write is refused server-side unless the caller holds a Session Assignment on the Round's Session or conference-wide Admin, with the acting identity taken from the credential; an Archived Conference refuses all of them.
- [OC04] A Category change reaches other Members' surfaces inside the near-live window through the one shipped activity cursor, with no second cursor, no second poll loop, and no per-Category request.


## Required Context

- `docs/specs/facilitator-board-and-categorisation/prd.md#fr1-categories-on-a-board` – the Category rules this story implements: creation at any Round state, rename that moves nothing, explicit order, empty-vs-occupied removal, the 60-character name limit counted in Unicode code points after trimming, the 20-per-Board cap, the duplicate-name warning that does not refuse, position clamping and contiguity, and every refusal sentence.
- `docs/specs/facilitator-board-and-categorisation/prd.md#fr2-the-uncategorised-holding-area` – why Uncategorised is not a Category, that it exists on every surface including when empty and when no Category exists, and the invariant that a non-discarded Post-it is in exactly one Category or in Uncategorised.
- `docs/specs/facilitator-board-and-categorisation/prd.md#fr6-sorting-authority` – the authority gate this story establishes for every Board write, including Binding Constraint FR6: *"Actor identity is always taken from the credential and never accepted from a request body."*
- `docs/specs/facilitator-board-and-categorisation/prd.md#data-requirements` – Category belongs to exactly one Round's Board and cascades with it; **Placement is a Post-it's Category or its absence, which *is* Uncategorised – Uncategorised is not stored as a Category row**; retention outlives archival because the Report reads it.
- `docs/specs/facilitator-board-and-categorisation/prd.md#non-functional-requirements` – the rows this story is measured by: one read per Board with no per-Category request, the near-live propagation window, the cap that cannot be raced past, server-side sorting authority, plain PostgreSQL, no in-process state, no horizontal body scroll at 375/768/1280 px, and Binding Constraint FR8: *"Vote anonymity is untouched | No surface added here reads, joins to, or exposes Vote data."*
- `docs/specs/facilitator-board-and-categorisation/prd.md#constraints` – four Binding Constraints apply here verbatim: plain PostgreSQL and no in-process state for Category and placement state (FR1); sorting must not require drag-and-drop, which governs **Category reorder** as much as placement (FR3); offline support is not widened, so no Category write is queued on a device (FR3); and Facilitator-initiated Discard must not reuse the author-deletion path, so this story adds a placement column to `post_it` and **no tombstone, soft-delete flag or `deleted_at`** (FR4).
- `docs/wireframes/facilitator-board-and-categorisation/design-decisions.md#the-non-drag-placement-interaction-model` – produced by **S01 TI08**, this story's dependency, and the settled decision this story's Category controls obey. It governs **Category reorder** as much as Post-it placement (`prd.md#non-functional-requirements` Accessibility row: *"Sorting is operable without drag-and-drop"*), and it names the wireframe file that demonstrates it. Do not invent a second interaction model here. If the heading slug has moved by execution time, take the decision from the Facilitator sorting-surface wireframe and `validation-report.md` in the same directory – but do not re-decide it.
- `docs/wireframes/facilitator-board-and-categorisation/facilitator-sorting.html` – the Facilitator sorting-surface wireframe named by that decision (locate it through `index.html` / `page-inventory.md` in the same directory): the **Category management controls – create, rename, keyboard-operable reorder, remove – at 375 px**, and the placement of Uncategorised alongside the Categories with its count. This is the layout TI08 implements; do not invent one here.
- `db/migrations/20260828120000000_post-it.sql` – the shipped `post_it` table and the `advance_round_activity_watermark()` trigger function this story attaches a new trigger to. Read the "what is deliberately absent" note before touching the row, and the `post_it_text_present` CHECK as the precedent for a length limit counted in code points with the API holding the authoritative constant.
- `db/migrations/20260829120000000_activity-watermark-counter.sql` – the cursor is `round.activity_watermark`, a `bigint` from one global sequence, opaque and never an instant. Every trigger advances it by calling `nextval` through the same function.
- `api/src/conferences/authorization.ts#createConferenceAuthorization` – `requireConferenceRole(caller, conferenceId, 'PresenterFacilitator', { sessionId })` is the Session-Assignment-or-Admin gate. Nothing is cached; the rows are re-read per request.
- `api/src/routes/rounds.ts#registerRoundRoutes` – `authorizeWrite` already composes that gate with `assertEditable` (the archived refusal) and returns the Conference and Session. Every Category route runs through it unchanged.
- `api/src/rounds/post-it-validation.ts#POST_IT_MAX_LENGTH` – the exact idiom for a length cap: one exported constant, code-point counting via `[...value].length`, trim before measure, a field-level refusal naming the limit and the offending value, and the migration `CHECK` as the one second copy pinned by test.
- `docs/UBIQUITOUS_LANGUAGE.md` – **Category**, **Board**, **Uncategorised**. "Column", "bucket", "tag", "swimlane", "inbox", "backlog" and "unsorted category" are named synonyms to avoid in code, testids, CSS classes and copy.


## Deeper Context

- `api/src/rounds/post-it-repository.ts` – the Board read (`listForSession`), the author-name join, and the discipline that every guard lives in the write statement's own predicate rather than in an earlier round trip.
- `api/src/rounds/round-repository.ts#activityWatermark` – how the Session's cursor is derived (`max(activity_watermark)` across the Session's Rounds).
- `web/src/activities/SessionActivitiesPanel.tsx` – the shipped Facilitator surface and its `Board` component; where the board renders, where refusals are held, and where `textMaxLength` comes from.
- `web/src/poll/use-watermark-poll.ts` – the one poll loop. Category changes reach clients through it; there is to be no second mechanism, only more call sites.
- `api/test/post-it-structure.test.ts` – the shape of this project's structural guards, and why every file-list assertion is paid for behaviourally elsewhere.
- `api/test/post-it.integration.test.ts` – the real-PostgreSQL harness, migrate-down depth handling, and the "assert the stored row, never the envelope alone" discipline.
- `docs/LEARNINGS.md#concurrency` – optimistic concurrency belongs in the write predicate; the delete/edit deadlock and the single 40P01 retry policy.
- `docs/LEARNINGS.md#testing` – a file-list guard is only as good as its longest omission; a regression test written beside its fix usually passes without the fix.
- `docs/LEARNINGS.md#react-state--refusals` – a refusal rendered inside a subtree its own handler unmounts is lost.
- `docs/specs/session-activities/s02-named-post-it-contribution.md` – the shipped slice this story extends, and the FIS shape this project writes.
- `docs/adrs/ADR-003-postgresql-containerized-development.md` and `docs/adrs/ADR-007-vote-arrivals-do-not-advance-the-member-visible-cursor.md` – plain PostgreSQL, and the rule that no vote-derived value may reappear on the Member-visible cursor.


## Acceptance Scenarios

- [x] **S01 [OC01,OC02] [TI01,TI03,TI04,TI05,TI06,TI07] A Category is created on a Board that already holds Post-its, on a closed Round**
  - **Given** a Post-it Round that ran and closed, whose Board holds 5 Post-its, all in Uncategorised
  - **When** a Facilitator holding a Session Assignment on that Session creates a Category named "Tooling"
  - **Then** the next Board read returns "Tooling" in the Category list holding 0 Post-its, all 5 Post-its still in Uncategorised, and the Uncategorised count still 5 – nothing is auto-placed, and the closed Round refuses nothing

- [x] **S02 [OC01,OC02] [TI03,TI05,TI06,TI08] Renaming moves nothing; a reorder outside the range is clamped and leaves the order contiguous**
  - **Given** a Board with Categories "Tooling", "Process" and "People" at positions 1, 2 and 3, and "Tooling" holding 3 Post-its
  - **When** the Facilitator renames "Tooling" to "Tooling & CI", then moves it to position 99
  - **Then** the Board read returns the new name with the same 3 Post-its still in it, and the order is "Process", "People", "Tooling & CI" at positions 1, 2, 3 – the request is clamped rather than refused, and no position is skipped or repeated

- [x] **S03 [OC02] [TI01,TI04,TI05,TI07] Uncategorised is present with no Categories at all, and a late-syncing Post-it lands in it**
  - **Given** a Post-it Round whose Board has no Categories and no Post-its
  - **When** the Facilitator opens the Board, and a Post-it composed offline by an Attendee then syncs after that Round closed
  - **Then** Uncategorised is rendered on the empty Board with a count of 0, and after the sync the same surface shows the Post-it in Uncategorised with a count of 1 – never auto-placed
  - **And** nothing can rename, reorder or remove Uncategorised: no identifier addresses it, and a Category endpoint called with any other id answers that there is no such category on this Round

- [x] **S04 [OC01,OC02] [TI03,TI06,TI08] An occupied Category cannot be removed until a destination is chosen; Uncategorised is the offered default**
  - **Given** a Board whose Category "Process" holds 4 Post-its and whose Category "People" holds none
  - **When** the Facilitator removes "People", then tries to remove "Process" with no destination, then removes it choosing Uncategorised
  - **Then** "People" goes with no prompt; the second request is refused with a message naming the count ("This category holds 4 post-its…") and "Process" and all 4 Post-its are still stored; the third succeeds and all 4 Post-its are in Uncategorised with its count risen by 4

- [x] **S05 [OC03] [TI06,TI11] Authority is decided at the API, not in the UI**
  - **Given** one Conference Member holding neither a Session Assignment on the Round's Session nor conference-wide Admin, and one Admin holding no Session Assignment for that Session
  - **When** each calls the create-Category endpoint directly with a valid body
  - **Then** the Member is refused 403 and no Category row is written; the Admin succeeds on conference-wide authority
  - **And** a request body carrying an `authorSub`, `actorSub` or `userSub` field is accepted and those fields are never read – the acting identity is the verified credential's `sub`

- [x] **S06 [OC02,OC03] [TI04,TI06,TI11] Every Board write against an Archived Conference is refused, but archival with Uncategorised occupied is a valid terminal state**
  - **Given** an archived Conference whose Session holds a Post-it Round with two Categories
  - **When** a Facilitator who does hold a Session Assignment creates, renames, reorders and removes a Category
  - **Then** all four are refused with the archived sentence and the stored Categories are unchanged
  - **And** given a Conference archived while 4 Post-its were still in Uncategorised, archival itself is permitted – nothing forces the Board empty first – and the Board read after archival still returns both Categories in order **and** `uncategorised` holding those 4 Post-its with a count of 4, so the categorised output can represent the terminal state (`prd.md#fr2-the-uncategorised-holding-area`)

- [x] **S07 [OC01,OC02] [TI01,TI03,TI06,TI11] The 20-Category cap cannot be raced past, and concurrent reorders settle on one whole ordering**
  - **Given** a Board holding 19 Categories
  - **When** two creates for that Board are issued concurrently against real PostgreSQL, both passing any application-level count
  - **Then** exactly one is stored, the Board holds 20 Categories, and the loser is refused with a message naming the limit and the current count – the cap is a storage constraint, not a check a second replica can pass, and the loser's refusal is the counted sentence rather than an unmapped internal error, even though the deferred unique constraint raises it at COMMIT
  - **And** given a Board with Categories "Tooling", "Process" and "People" at positions 1, 2 and 3, when two Facilitators reorder concurrently against real PostgreSQL – one moving "People" to position 1, the other moving "Tooling" to position 3 – then the Board read afterwards returns **one** of the two intended orderings whole, never a blend of them, with positions still contiguous 1..3 and no Category duplicated or missing; the losing Facilitator sees the winner's order through the one cursor and is offered no conflict prompt, because last write wins for the ordering as a whole (`prd.md#edge-cases`)

- [x] **S08 [OC01] [TI02,TI06] Name validation is code-point counted after trimming, and a duplicate name warns without refusing**
  - **Given** a Board with a Category already named "Tooling"
  - **When** the Facilitator submits "   " (whitespace only), then a 61-emoji name, then a 60-emoji name, then a second "Tooling"
  - **Then** the first two are refused with field-level messages naming the 60-character limit, and the field keeps what was typed; the 60-emoji name is accepted (60 code points, not 120 UTF-16 units); and the second "Tooling" is **stored**, with a duplicate-name warning on the response that the surface shows

- [x] **S09 [OC04] [TI01,TI09] Category writes advance the one activity cursor; a cast Vote still advances nothing**
  - **Given** two Members with the Session open, one polling `…/activities/watermark`
  - **When** the Facilitator creates a Category, renames it, reorders it and removes it
  - **Then** the polled cursor differs after each of the four, and the poller's next Session read shows the change – inside the near-live window and with no request per Category
  - **And** a Vote cast on a Poll in the same Session advances the cursor by nothing (ADR-007), and no new cursor column, endpoint or poll loop exists


## Structural Criteria

- [x] `CATEGORY_NAME_MAX_LENGTH = 60` has exactly one authoritative definition (`api/src/rounds/category-validation.ts`); the migration's `CHECK` is the one permitted second copy and is pinned to the constant by test, exactly as `POST_IT_MAX_LENGTH` is. No copy exists under `web/`.
- [x] There is no sentinel, reserved or magic identifier for Uncategorised anywhere – schema, API or SPA. Absence of a placement (`post_it.category_id IS NULL`) is its only representation.
- [x] No second near-live mechanism: no new watermark column, no new watermark endpoint, no second poll loop. `web/src/poll/use-watermark-poll.ts` gains call sites only.
- [x] The Board read stays one request for a Session and everything on it: no per-Category or per-Post-it endpoint, and no handler that loops per Category. Proved by counting statements across a whole request with a recording `Database`, not at the repository seam.
- [x] No code added by this story reads, joins to, or exposes any vote table, ballot, or per-voter fact (Binding Constraint FR8).
- [x] The `post_it` row gains a placement column and nothing else – no tombstone, soft-delete flag or `deleted_at` – so author deletion still leaves no trace (Binding Constraint FR4).
- [x] Plain PostgreSQL only: no `CREATE EXTENSION` and no provider-proprietary type or function in the new migration, and it reverses cleanly (`migrate:down` then `migrate:up`) leaving the shipped schema intact (ADR-003).
- [x] Nothing is retained between requests: authority, the Category list and every count are read from the database on each request (ADR-004).
- [x] No Category write reaches the shipped offline Post-it queue (`web/src/offline/post-it-queue.ts`), and no Category state is written to the offline cache (Binding Constraint FR3).
- [x] Category reorder is fully operable by keyboard and assistive technology; no interaction in this story is drag-only (Binding Constraint FR3).
- [x] The shipped session-activities suites still pass unchanged in intent – including Session and Round deletion with placed Post-its, and the shipped author contribute / correct / remove paths.
- [x] No horizontal body scroll at 375, 768 and 1280 px on the Facilitator's Board surface with Categories present and Uncategorised occupied.


## Scope & Boundaries

### Work Areas

- `db/migrations/` – one new migration creating `category` and the `post_it` placement column, with the cap, ordering, Round scoping and cursor advance all expressed as constraints and triggers.
- `api/src/rounds/` – `category-validation.ts` (the name rule), `category-repository.ts` (the write seam), and the Board projection the Session read serves.
- `api/src/routes/rounds.ts` and `api/src/errors.ts` – the three Category endpoints behind the shipped `authorizeWrite` gate, and the refusal codes they need.
- `web/src/api/client.ts` and `web/src/activities/SessionActivitiesPanel.tsx` – the grouped Board wire type, Categories rendered in order, Uncategorised always present with its count, and the Facilitator's non-drag Category controls.
- `api/test/`, `web/test/` and `visual/` – structural guards, real-PostgreSQL integration including the cap race and the deletion paths, component behaviour, and the three-width capture.

### What We're NOT Doing

- **Placing or re-placing Post-its into Categories** – S03 owns the placement interaction and its concurrency rule. This story delivers the field whose absence is Uncategorised and the Board read that renders it, and moves Post-its only as the side effect of removing an occupied Category.
- **Discard, restore and Admin permanent removal** – S05 and S06. No tombstone, `discarded_at` or removal trace is added to any table here.
- **The Display Link, the projected Board View and the Attendee's live Board** – S04, S07 and S08. No unauthenticated route and no second SPA entry point appears in this story.
- **Drag-and-drop as an additional wide-viewport affordance** – permitted by the PRD but never required; deferred so the keyboard path is the one that ships and gets proved.
- **Any widening of offline support** – Category state is online-only; sorting requires connectivity (`docs/PRODUCT.md` → Anti-Goals).


## Architecture Decision

**Approach**: Uncategorised is the *absence* of a placement (`post_it.category_id IS NULL`) and never a row; Category order and the 20-per-Board cap are storage constraints – `CHECK (position BETWEEN 1 AND 20)` plus a `DEFERRABLE INITIALLY DEFERRED UNIQUE (round_id, position)` – so concurrent creates cannot race past either; and every Board write reuses the shipped `authorizeWrite` gate and the shipped `advance_round_activity_watermark()` trigger function rather than growing a second one.
**Why this over alternatives**: an Uncategorised row would be addressable, so every rename, reorder and delete path would need a refusal for a row that should not exist; and an application-level count-then-insert cap is precisely the check two replicas both pass, which is the failure the PRD's "cannot be raced past" row names.


## Technical Overview

### The three shared decisions this story produces

Five later stories read and write through these. They are stated here so no sibling has to re-derive them.

1. **The Board read projection contract.** One read – the shipped `GET /api/conferences/:conferenceId/sessions/:sessionId` – answers a Session and everything on its Boards. For a Post-it Round whose board is loaded, the Round's wire shape carries: `categories`, an array **in the Facilitator's order**, each entry `{ id, name, postIts, postItCount }`; `uncategorised`, `{ postIts, postItCount }`, **always present, even when empty and even when `categories` is empty**; and `textMaxLength`, unchanged. The flat `postIts` array is retired from the Round wire in favour of this grouped shape, so a Post-it appears exactly once in the payload and no surface groups client-side. Counts are computed server-side and consumed, never re-derived by a client. `uncategorised` is not a Category: it carries no `id`, no `name` and no `position`. S03, S05, S06, S07 and S08 read this shape and add no second one.
2. **The sorting-authority gate.** Every Board write – Category create, rename, reorder and remove, and everything S03, S04 and S05 add – runs `authorizeWrite` in `api/src/routes/rounds.ts`, which resolves `requireConferenceRole(caller, conferenceId, 'PresenterFacilitator', { sessionId })` against the Round's Session and then `assertEditable` against the Conference, **per request, from the database, with nothing carried between requests**. The acting identity is `caller.sub` from the verified credential; no body field on any Category route names or influences who is acting, and a body carrying one is accepted and ignored, matching the shipped Post-it and Vote body schemas. S03, S04 and S05 reuse this gate unchanged; S06 layers an Admin-only check *on top of* it rather than replacing it.
3. **The activity-watermark advance on Board writes.** `category` gets an `AFTER INSERT OR UPDATE OR DELETE … FOR EACH ROW` trigger **attached to** the existing `advance_round_activity_watermark()` function – attached, never copied – which already keys on `NEW.round_id` / `OLD.round_id` and calls `nextval('activity_watermark_seq')`. A placement change is an `UPDATE` on `post_it`, which the shipped `post_it_advances_activity_watermark` trigger already covers; this story confirms that by test rather than adding a second trigger. Member-gated surfaces therefore see Category, placement, Discard, restore and permanent-removal writes through the one cursor and the one poll loop. ADR-007 is untouched: a Vote arrival advances nothing, and no vote-derived value reappears here. S07 deliberately consumes none of this – the cursor is Session-scoped and Membership-gated.

### Schema shape

`category` carries `id`, `round_id`, `conference_id`, `round_kind` (defaulted and `CHECK`ed to `'PostItRound'`), `name` and `position`. It hangs off the shipped `round_id_kind_conference_unique` composite key with `ON DELETE CASCADE`, exactly as `post_it` does – so a Category on a Poll is a foreign-key violation rather than a rule a handler remembers. A `UNIQUE (id, round_id)` lets `post_it (category_id, round_id)` reference it, which makes "a Post-it placed in a Category of some other Round" unwritable through any path.


## Code Patterns & External References

```
# type | path#anchor                                                    | why needed (intent)
file   | db/migrations/20260828120000000_post-it.sql                    | Composite-FK scoping idiom, the trigger function to attach to, the CHECK-as-backstop precedent
file   | db/migrations/20260829120000000_activity-watermark-counter.sql | What the cursor is now and how every trigger advances it
file   | api/src/rounds/post-it-validation.ts#POST_IT_MAX_LENGTH        | Exact shape for a code-point-counted, trim-first length cap with a field-level refusal
file   | api/src/routes/rounds.ts#registerRoundRoutes                   | `authorizeWrite`, the route/schema idiom, and the ignore-don't-refuse body-schema rule
file   | api/src/rounds/post-it-repository.ts                           | Guards live in the write predicate; one statement per Session, never one per child
file   | api/src/conferences/authorization.ts                           | The Session-Assignment-or-Admin narrowing and its neutral refusal
file   | web/src/activities/SessionActivitiesPanel.tsx                  | The surface being extended – Board rendering, refusal placement, write-in-flight discipline
file   | api/test/post-it.integration.test.ts                           | Real-PostgreSQL harness, migrate-down depth, assert-the-stored-row discipline
file   | api/test/post-it-structure.test.ts                             | Structural-guard shape, and pinning a migration CHECK to the API constant
wire   | docs/wireframes/facilitator-board-and-categorisation/design-decisions.md#the-non-drag-placement-interaction-model | S01's settled non-drag interaction model – governs Category reorder too; names the wireframe that demonstrates it
wire   | docs/wireframes/facilitator-board-and-categorisation/facilitator-sorting.html | The Facilitator sorting-surface wireframe it names – Category management controls at 375 px, Uncategorised alongside
```


## Constraints & Gotchas

- **Critical**: the cap and the ordering are storage constraints, not handler logic. A `select count(*)` followed by an `insert` is exactly the application-level check the PRD's "cannot be raced past" row rules out, and two replicas both pass it – Must be handled by: `CHECK (position BETWEEN 1 AND 20)` plus `UNIQUE (round_id, position)`, with the create taking `coalesce(max(position), 0) + 1` inside the insert's own source query.
- **Critical**: the `post_it → category` foreign key must be `NO ACTION` (the default), **not** `RESTRICT`. Deleting a Round cascades to both `post_it` and `category` in one statement; `RESTRICT` fires immediately and would break Round and Session deletion, while `NO ACTION` is checked at end of statement and passes. `NO ACTION` is also what makes "an occupied Category cannot be removed" a storage guarantee rather than a handler's promise.
- **Constraint**: contiguous renumbering after a reorder or a removal must happen inside one statement against a `DEFERRABLE INITIALLY DEFERRED` unique constraint – Workaround: an immediately-checked unique index makes any renumbering pass collide with itself mid-update.
- **Critical**: a `DEFERRABLE INITIALLY DEFERRED` constraint raises at **COMMIT, not at the failing statement**. The losing create in the cap race, and any colliding concurrent renumber, therefore surfaces a 23505 *outside* the statement window that `api/src/rounds/post-it-repository.ts:250`'s `insertOrDiagnose` wraps – an executor who copies that idiom verbatim gets an unmapped error reaching the handler as `INTERNAL_ERROR`, and TI06's Verify ("names the limit and the current count") cannot be satisfied. Must be handled by: TI03 owning the transaction boundary for every `category` write and catching 23505 on the **commit** call as well as on the statement, then routing it through the same count-and-diagnose path the empty-result branch uses, so the refusal TI06 asserts is produced from a fresh count regardless of which of the two raised it. A concurrent reorder that loses this way is retried once and then reports the winner's ordering – it is last-write-wins, not a refusal the Facilitator must act on.
- **Constraint**: concurrent reorder is settled by `prd.md#edge-cases` and `prd.md#decisions-log` as **last write wins for the ordering as a whole** – no per-Category merge, no version token on a Category, and no conflict UI. Do not add optimistic concurrency to the reorder path; the whole ordering is the unit, and both Facilitators converge through the one activity cursor.
- **Avoid**: measuring the name with JavaScript's `.length` – Instead: `[...value].length` and `char_length`, both after `trim` / `btrim`, so the API and the schema state the same limit (a 60-emoji name is 120 UTF-16 units and 60 code points).
- **Constraint**: the archived refusal is the shipped `assertEditable` sentence ("This conference has been archived, so it is read-only and can no longer be changed."), not a second copy of the PRD's paraphrase – one rule, one sentence.
- **Avoid**: rendering a Category refusal inside the subtree a board refresh replaces – Instead: hold it in the panel above the Board, as the shipped board error already is (`docs/LEARNINGS.md#react-state--refusals`).
- **Constraint**: in the Session read the watermark is still read **before** the board and its Categories. Stale-low costs one wasted refetch and self-corrects; stale-high silently strands every later poll.
- **Avoid**: any Category write touching the offline queue or the schedule cache – Instead: a Category write fails loudly and visibly online, leaving the Board as it was (Binding Constraint FR3).


## Implementation Plan

### Implementation Tasks

- [x] **TI01** A migration creates `category` and the `post_it` placement column, with the cap, order, Round scoping and cursor advance all expressed as constraints
  - Follow `db/migrations/20260828120000000_post-it.sql` for the composite-FK idiom and comment density; attach an `AFTER INSERT OR UPDATE OR DELETE` trigger on `category` to the **existing** `advance_round_activity_watermark()` – do not copy the body. Placement is `post_it.category_id uuid` with `FOREIGN KEY (category_id, round_id) REFERENCES category (id, round_id)` and no `ON DELETE` action.
  - **Verify**: `Test: against real PostgreSQL, a 21st Category on one Board is refused; a Category naming a Poll Round is refused; a Post-it placed in another Round's Category is refused; deleting the Round removes both tables' rows; migrate:down then migrate:up leaves the shipped schema intact`

- [x] **TI02** The Category name rule has one authoritative definition, counted in code points after trimming
  - New `api/src/rounds/category-validation.ts` exporting `CATEGORY_NAME_MAX_LENGTH = 60` and its validator, shaped exactly after `api/src/rounds/post-it-validation.ts#validatePostItText` – a field-level refusal naming the limit and the offending length.
  - **Verify**: `Test: "   " is refused as blank; a 61-code-point name is refused with a message naming 60 and 61; a 60-emoji name is accepted; the migration CHECK's literal is asserted equal to the exported constant`

- [x] **TI03** A Category repository is the only seam that writes `category`, with every guard in the write statement's predicate
  - New `api/src/rounds/category-repository.ts` – create (position from `coalesce(max(position),0)+1` in the insert's own source, scoped to an existing Post-it Round of this Session and Conference), rename, reorder (clamped to the current range, contiguous afterwards), remove (empty, or with a destination `categoryId | null` applied to the Post-its in one transaction before the delete). Duplicate-name detection is reported as a warning alongside a successful write, never as a refusal. Nothing cached; follow `api/src/rounds/post-it-repository.ts` for the outcome-union shape and diagnose-after-the-fact – but this repository owns its own transaction boundary, because the deferred `UNIQUE (round_id, position)` raises at COMMIT rather than at the statement (see Constraints & Gotchas), so 23505 must be caught around the commit as well and mapped to the same counted refusal.
  - **Verify**: `Test: a reorder to position 99 lands last with contiguous positions; removing an occupied Category without a destination writes nothing and reports the Post-it count; with Uncategorised as destination the Post-its' category_id is null and the Category row is gone; a 23505 raised at COMMIT rather than at the statement is mapped to the counted refusal outcome and never escapes as an unmapped error`

- [x] **TI04** The Board projection returns a Session's Categories with their Post-its and every count in one statement set
  - Extend the read seam so a Session read yields, per Round, the ordered Categories and the Post-its grouped by placement – `category_id IS NULL` is Uncategorised. One statement for the whole Session, never one per Round or per Category; follow `api/src/rounds/post-it-repository.ts#listForSession`.
  - **Verify**: `Test: a recording Database counts statements across a whole Session read and the count does not grow with the number of Categories or Post-its; a Session read on an Archived Conference still returns the ordered Categories and uncategorised with its Post-its and count – archival stops writes, it does not empty or hide the Board`

- [x] **TI05** The Round wire shape carries the Board projection contract, and the flat `postIts` array is retired
  - `categories: [{ id, name, postIts, postItCount }]` in Facilitator order, `uncategorised: { postIts, postItCount }` always present, `textMaxLength` unchanged; the Post-it wire shape itself is unchanged (`api/src/routes/rounds.ts#toPostItWire`). `uncategorised` carries no id, name or position. `web/src/api/client.ts` types follow. The producing site is `api/src/routes/rounds.ts:297` (`postIts: board.map(...)`).
  - **Blast radius – four shipped test files pin the retired key and must move in the same commit**: `api/test/round.integration.test.ts:854` pins the exact wire key set (`PostItRound: ['id', 'kind', 'postIts', 'prompt', 'state', 'textMaxLength']`, asserted with `expect(Object.keys(wire).sort()).toEqual(...)`) – adding `categories`/`uncategorised` and removing `postIts` fails it outright; `api/test/post-it.integration.test.ts` carries six direct `postIts` assertions (lines 156, 416, 654, 765, 771, 818), including the board-read shape helper and its `WirePostIt` type; plus `web/test/PostItBoard.test.tsx` and `web/test/SessionActivitiesPanel.test.tsx`. Update each to the grouped shape rather than deleting the assertion – `round.integration.test.ts`'s key set is the guard that keeps instant-shaped fields off a Round, and `post-it.integration.test.ts:818` is the author-removal no-op proof.
  - **Verify**: `Test: a Session read on a Round with no Categories and no Post-its returns categories: [] and uncategorised with postIts: [] and postItCount: 0; a Post-it appears exactly once in the payload; the PostItRound key-set assertion in api/test/round.integration.test.ts names categories and uncategorised and no longer names postIts, and both api/ and web/ suites are green in the same commit`

- [x] **TI06** Three Category endpoints exist under the Round, each behind the shipped authority gate
  - `POST|PATCH|DELETE /api/conferences/:conferenceId/sessions/:sessionId/rounds/:roundId/categories[/:categoryId]`, each opening with `authorizeWrite` from `api/src/routes/rounds.ts#registerRoundRoutes`. Body schemas name only their own fields and are **not** `additionalProperties: false`, matching `postItBodySchema` – an actor field is accepted and never read. Consumes TI02's validator and TI03's repository. Add refusal codes to `api/src/errors.ts` beside the S02 Post-it block, one per distinct next action (name invalid, limit reached, category holds post-its, category not found).
  - **Verify**: `Test: a Member with neither a Session Assignment nor Admin gets 403 and writes nothing; an Admin without an assignment succeeds; a body carrying actorSub is accepted and the row is attributed to the credential's sub; the create refusal at 20 names the limit and the current count`

- [x] **TI07** The Facilitator's Board renders Categories in order and Uncategorised always, with server-supplied counts
  - `web/src/activities/SessionActivitiesPanel.tsx#Board` consumes TI05's shape; Uncategorised renders even when the Board has no Categories and no Post-its, and its count comes from the payload rather than `postIts.length`. Terminology follows `docs/UBIQUITOUS_LANGUAGE.md` in component names, testids, CSS classes and copy – "column", "bucket", "inbox" and "backlog" appear nowhere.
  - **Verify**: `Test: a Round payload with zero Categories renders an Uncategorised region with a count of 0; a payload with two Categories renders them in payload order with their own counts`

- [x] **TI08** The Facilitator's Category controls are complete and operable without a pointer
  - Create, rename, reorder (move up / move down or an explicit position control) and remove, offered only where the payload says the viewer may run the Session, and reachable one-handed at 375 px per S01's wireframes. Uncategorised offers none of them. The occupied-removal flow asks for a destination with Uncategorised pre-selected. Refusals render in the panel above the Board, not inside the subtree a refresh replaces; one write in flight at a time per control, following the shipped `writeInFlight` discipline.
  - **Verify**: `Test: every control is reachable and operable by keyboard alone; Uncategorised exposes no rename, reorder or remove control; the removal dialog defaults to Uncategorised and names the count`

- [x] **TI09** Category writes reach other Members through the one shipped cursor
  - Depends on TI01's trigger. No new endpoint, column or loop – `web/src/poll/use-watermark-poll.ts` gains no second instance, and the Session read's watermark-before-board order is preserved.
  - **Verify**: `Test: against real PostgreSQL, each of create, rename, reorder and remove advances the value at …/activities/watermark; a cast Vote advances it by nothing`

- [x] **TI10** Structural guards hold the decisions a later story could undo with working code
  - New `api/test/category-structure.test.ts`, shaped after `api/test/post-it-structure.test.ts`: one length-cap definition, no Uncategorised sentinel identifier, no second watermark mechanism, no vote table referenced by anything added here, no tombstone column on `post_it`, plain PostgreSQL in the migration, no Category write reaching the offline queue. Pair every file-list assertion with a behavioural one that does not know the list (`docs/LEARNINGS.md#testing`).
  - **Verify**: `Test: each guard fails when its decision is reverted in a scratch edit – assert the marker is found, never silently skip when a pattern is absent`

- [x] **TI11** Real-PostgreSQL integration proves the properties a fake cannot
  - New `api/test/category.integration.test.ts` following `api/test/post-it.integration.test.ts`: the concurrent-create cap race driven from two connections; the concurrent-reorder race on the same two connections; authority refusal asserted against the stored rows; the archived refusal on all four writes and the Board read still serving Uncategorised afterwards; Session and Round deletion with placed Post-its; and the shipped author contribute / correct / remove paths still green with a placement column present.
  - **Verify**: `Test: with 19 Categories stored, two concurrent creates leave exactly 20 rows and one refusal naming the limit, with the refusal produced from the COMMIT-time violation rather than an unmapped error; two concurrent reorders of a 3-Category Board leave one of the two intended orderings whole with positions contiguous 1..3, no duplicate and no missing Category`

- [x] **TI12** The Facilitator Board is captured and clean at all three widths
  - Extend `visual/session-activities.spec.ts` with a Board carrying several Categories and an occupied Uncategorised; rebuild the SPA image first or drive the Vite dev server (`docs/KEY_DEVELOPMENT_COMMANDS.md` → Visual Validation).
  - **Verify**: `Test: no horizontal body scroll at 375, 768 and 1280 px, and the Category controls are visible and reachable at 375 px`

### Testing Strategy

- **[TI11] The cap race needs two real connections, not two sequential calls.** Hold a transaction open on one connection past its insert, start the second, then commit – sequential inserts cannot distinguish a storage constraint from an application-level count.
- **[TI10] Revert before believing a guard.** A regression test written beside its fix usually passes without the fix; check the guard count actually falls when the decision it protects is undone.
- **[TI01] Migration reversal is depth-sensitive.** Use `api/test/migration-depth.ts#stepsToRevertThrough` rather than a fixed step count.

### Execution Contract

- TI01 → TI02 → TI03 → TI04 → TI05 land in that order; TI06 consumes TI03 and TI05, TI07 and TI08 consume TI05, TI09 consumes TI01.
- TI05 retires the Round wire's flat `postIts` array. Land TI05, TI07 and **all four** affected test files together – `api/test/round.integration.test.ts` (the `PostItRound` key-set assertion at :854), `api/test/post-it.integration.test.ts` (six `postIts` assertions at :156, :416, :654, :765, :771, :818 and its board-read shape helper), `web/test/PostItBoard.test.tsx` and `web/test/SessionActivitiesPanel.test.tsx`. A half-landed contract leaves the shipped Facilitator surface blank **and the API suite red** – the two API files are not optional follow-ups.


## Implementation Observations

> _Managed by exec-spec post-implementation – append-only. Spec authors: leave this section empty._

### Run: 2026-08-30 18:34 UTC – discovered-requirements

#### DISCOVERED REQUIREMENTS

- **A Post-it whose Category is absent from the same Board read is rendered in Uncategorised, never dropped.** The Session read takes the Categories and the Post-its as two statements inside one `Promise.all`, with no transaction between them (the shipped discipline: watermark first, then the board, each self-correcting). A Category removed between the two reads therefore leaves the Post-it snapshot naming a Category the Category snapshot no longer lists. Grouping strictly by id put such a Post-it in **neither** bucket - it vanished from the payload for one read, which contradicts `prd.md#fr2-the-uncategorised-holding-area`'s invariant that a non-discarded Post-it is in exactly one Category or in Uncategorised, never neither. Uncategorised is the correct fallback: it is the absence of a placement, and the removal path the race runs against is itself moving those Post-its to Uncategorised. Proved by `api/test/category.integration.test.ts` driving the removal between the two reads through a recording `Database`.

### Run: 2026-08-30 20:16 UTC – observations

#### NOTICED BUT NOT TOUCHING

- **Repository-wide Prettier drift predates this story.** `npm run format:check` reports 14 files; 9 of them are untouched by S02 (for example `api/test/join-code.test.ts`, `visual/conferences.spec.ts`, `web/src/components/JoinCodePanel.tsx`). Every file this story wrote or changed is `prettier --check` clean; the rest is left as found.
- **The API integration suites are order- and load-sensitive against a shared `confapp_test`.** Under machine contention (several agents and a Docker/WSL database competing for disk) whole files fail with unmapped 500s and per-test durations rise from milliseconds to seconds, in files this story does not touch (`wall-clock-contract`, `session.integration`, `session-deletion.integration`). Each passes alone, and the full suite is green on a quiet machine (76 files / 1270 tests). `api/vitest.config.ts` sets `fileParallelism: false`, so the cause is contention rather than interleaving - but every DB-backed file wipes `conference` and `app_user` in its own `beforeEach`, so a future move to parallel files would break them all. Pre-existing; not touched here.
- **`api/test/post-it-structure.test.ts`'s count guard was widened, not weakened.** It forbade `postItCount` outright as a proxy for the per-Member contribution limit FR3 says does not exist. The Board projection needs a per-Category count, so the ban became a shape: `contributionCount`, `perAuthor`, `postItQuota` and `authorCount` still fail, and every `postItCount` in the routes module must be produced by `toBoardWire`. Same treatment the shipped `count(` ban already carried.
- **Review findings surfaced and left as Notes.** The fresh-context review (`.agent_temp/reviews/facilitator-board-and-categorisation-s02-mixed-review-claude-2026-08-30.md`, gap PASS 7/9/9) raised 34 findings. Both HIGH, all five Fix-routed items, and seven further Notes were remediated in this run. The remainder are recorded there rather than here, and the accessibility cluster (M5 - no accessible name identifying which Category a control acts on; M6; L10 - the region heading level skips h3 to h5) is the one worth taking before S03 builds more controls onto the same markup.
- **A per-Category merge on reorder turned out to be unreachable through the shipped path.** The review's M2/M12 predicted that renumbering only the rows whose position changed lets two concurrent reorders compose. Driven deterministically against real PostgreSQL it does not: the discarded filter compared each row against its *live* value, which after the rival committed differed for every row. The whole-ordering write was made anyway - it converts an emergent property into a structural one and takes a row lock on every row in the ordering - and `category-structure.test.ts` pins it, because the behavioural test cannot tell the two implementations apart.

### Run: 2026-08-30 20:50 UTC – observations

#### NOTICED BUT NOT TOUCHING

- **Contiguous positions are not guaranteed when a removal races a removal or a reorder.** `orderingFor` takes no row lock, so a renumber assigns ordinals from an array that may still name a Category a rival has since deleted; that id matches nothing, its ordinal is skipped, and the surviving rows are left with a hole. Because `create` takes its position from `coalesce(max(position),0)+1`, every hole permanently costs the Board one slot against the 20-cap. Reorder-vs-reorder is unaffected (both write every row, so the loser blocks and overwrites whole), which is why the shipped race tests pass. **Left as a decision rather than a fix**: `for update` on the ordering read serialises Board writes and yields the *composition* of two concurrent reorders, while joining the ordinals to the live rows preserves last-write-wins-for-the-whole-ordering - and choosing between them settles the reorder semantics S03, S05, S07 and S08 inherit. Worth taking before S03.
- **A combined rename-and-reorder is two transactions.** `PATCH` with both `name` and `position` runs `rename` and `reorder` through separate `db.transaction` calls, so a second half that answers `missing` returns 404 over a rename that has already committed. API-surface only: the SPA sends one field or the other, never both.
- **The SPA defaults an absent Board to an empty one.** `round.uncategorised ?? { postIts: [], postItCount: 0 }` renders the Uncategorised region with a count of 0 and the "this round collected no post-its" copy for a payload that never claimed a Board - the inversion the wire contract avoids by omitting the keys, and the opposite of the `textMaxLength` discipline eleven lines above in the same function. Not reachable through `fetchSessionActivities`, which always supplies the Board for a Post-it Round; S04, S07 and S08 read the same type from other endpoints.
- **The Ubiquitous-Language synonym guard reads only `web/`.** Its file list is the panel, the client and the stylesheet, so "bucket" in an API route comment or a migration comment cannot be caught. The two route headings were reworded; the migration's definitional line quotes `prd.md#fr1-categories-on-a-board` verbatim and was left alone. Either widen the guard to the API's user-facing strings or narrow its docblock to say it covers the SPA.

#### ASSUMPTIONS

- **A parameter property broke every out-of-process path and the tests caught it, not the type-checker.** `class StillOccupied { constructor(readonly categoryId: string) }` type-checks, lints and passes `vitest` - and is refused outright by Node's strip-only type removal, which is how `api/test/join-attempt-probe.ts`, `api/test/wall-clock-probe.ts` and `npm run dev:api` load this source. The field is now declared and assigned. Nothing in the repository states the rule; the two probes are what enforce it, from two suites that have nothing to do with the module that broke.

### Run: 2026-08-30 21:40 UTC – observations

#### OWNER DECISIONS

- **The reorder-race decision recorded in the 20:50 UTC run is settled: contiguity is fixed, reorder semantics are unchanged.** The owner was given both options and chose to fix only the hole. Rationale on the record: the whole-ordering write made in the 20:16 UTC run already delivers last-write-wins-for-the-whole-ordering, so Acceptance Scenario S07's "never a blend" and TI11's Verify are already true of the shipped code and needed no rewording; taking `for update` on the *ordering read* instead would have made the loser recompute from the winner's committed state and produce the composition of two reorders – the blend those artifacts forbid – while invalidating the passing gated test that pins the current behaviour.
- **The fix**: `renumber` now ranks ordinals over the rows that still exist rather than over the array as handed in. A `live` CTE locks this Round's Categories (ordered by id, so two renumbers take them in the same order) and the join drops any id a rival removal has already taken before `row_number()` assigns anything. The lock is taken in the write, deliberately not on the earlier ordering read, which is what closes the hole while leaving reorder-vs-reorder semantics untouched.
- **Why it mattered**: `create` takes its position from `max(position) + 1`, so every hole permanently cost the Board one of its twenty Category slots.
- **Proved red before green**: `api/test/category.integration.test.ts` → "leaves no hole in the ordering when a removal races a removal" parks a removal on its DELETE, lets a rival removal commit, then resumes. Against the pre-fix statement it fails with `expected [ 1, 3 ] to deeply equal [ 1, 2 ]` – the hole itself. Full suite after the fix: 76 files / 1274 tests, with the pre-existing "overwrites a concurrent reorder whole" test still passing.
- **Also normalised**: `db/migrations/20260902090000000_category-and-placement.sql` was the only migration in the repository with CRLF line endings – residue from a sibling agent's stash/pop probe, not from authoring. Converted to LF to match its four siblings. `node-pg-migrate` records only the migration name in `pgmigrations`, no checksum, so this is safe on an already-applied migration.
