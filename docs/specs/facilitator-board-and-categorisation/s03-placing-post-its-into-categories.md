# S03 – Placing Post-its into Categories

**Plan**: docs/specs/facilitator-board-and-categorisation/plan.json
**Story-ID**: S03

## Feature Overview and Goal

**Intent**: Categories are inert until something goes in them – sorting is the act that turns a chronological wall of ideas into the categorised, attributed output the Report carries, and it has to be doable from the Facilitator's own phone while the room watches the big screen, not from the room machine and not with a mouse.

**Expected Outcomes** (scenarios anchor to these via `[OC<NN>]`):

- [OC01] A Facilitator places a Post-it from Uncategorised into a Category, moves it between Categories, and moves it back to Uncategorised, from their own device at 375, 768 and 1280 px – **with the keyboard alone and with assistive technology**, and with no pointer drag anywhere on the path.
- [OC02] Every placement reaches the other people looking at the same Board within the near-live window, through the one Board read and the one activity cursor that already exist; Uncategorised's count falls as sorting progresses, so the room can be told how much is left.
- [OC03] Placement is permitted while the Round is open, after it has closed, and survives a reopen; the server – not the UI – refuses a caller without sorting authority, a write against an Archived Conference and a destination on another Board, and a placement into the Category a Post-it already sits in simply succeeds.
- [OC04] A placement that could not be delivered is **surfaced, never deferred**: the Post-it is visibly where it was, the message says so, and the device holds nothing – sorting is online-only.


## Required Context

- `docs/specs/facilitator-board-and-categorisation/prd.md#fr3-placing-post-its-into-categories` – the contract this FIS implements: seven acceptance criteria, the inputs/outputs (Post-it id; destination = a Category on the same Board **or** Uncategorised; actor from the bearer credential), the four validation rules and the three error-handling rules. Read it there; do not work from a restatement.
- `docs/specs/facilitator-board-and-categorisation/prd.md#constraints` – **Binding Constraints, applied unnarrowed.** Two are load-bearing for this story: (FR3) *"Sorting must not require drag-and-drop. A pointer-only interaction excludes keyboard and assistive-technology users and does not survive the 375px case. Drag may be offered as an additional affordance on wide viewports; it can never be the only way."* and (FR3) *"Offline support is not widened. Sorting, discarding and the projected view all require connectivity. Offline stays schedule reads plus Post-it queueing."* The same section carries (FR1) *"Plain PostgreSQL only (ADR-003), and no in-process state between requests"*, which applies to the placement write like every other, and (FR4) the rule that Discard never reuses the author-deletion path – relevant here only because a discarded Post-it cannot be placed (see **Constraints & Gotchas**).
- `docs/specs/facilitator-board-and-categorisation/prd.md#fr6-sorting-authority` – the authority this story's writes go through. **Binding Constraint (FR6)**: *"Actor identity is always taken from the credential and never accepted from a request body."* The gate itself is S02's and is consumed unchanged, not re-derived.
- `docs/specs/facilitator-board-and-categorisation/prd.md#user-stories` – rows **US03** (sort from my own phone, at 375px, without drag-and-drop), **US06** (a live Uncategorised count that falls as placement progresses) and **US10** (Categories and placements persist across Round close, reopen and Session end) are this story's acceptance rows.
- `docs/specs/facilitator-board-and-categorisation/prd.md#non-functional-requirements` – the rows this story is measured by: propagation visible within ~5 s; **one read per Board**, never one per Category or Post-it; the design ceiling of ~200 Post-its across ~20 Categories stays legible and responsive; two or three concurrent sorters with last-write-wins per Post-it and **no conflict UI**; *"a failed write leaves the Post-it visibly where it was"* with zero accepted-then-dropped writes; sorting authority enforced server-side, never UI-only; *"Sorting is operable without drag-and-drop – fully keyboard-operable and usable with assistive technology"*; no horizontal body scroll at 375 / 768 / 1280 px with primary sorting controls reachable one-handed at 375 px; plain PostgreSQL; no in-process state. **Binding Constraint (FR8/Privacy)**: *"Vote anonymity is untouched – no surface added here reads, joins to, or exposes Vote data."*
- `docs/specs/facilitator-board-and-categorisation/prd.md#edge-cases` – the rows this story owns: placing into the Category a Post-it is already in *(silently succeeds)*; placing into a Category on a different Board *(refused)*; a placement failing on a network blip *(the Post-it returns to where it was, `Couldn't move that – check your connection.`, **nothing is queued**)*; sorting attempted without authority *(refused server-side, naming the authority required; the controls were not offered in the first place)*; a Round reopened after sorting *(Categories and placements survive untouched; new Post-its arrive in Uncategorised)*; two Facilitators sorting simultaneously *(last write wins per Post-it, no conflict UI)*.
- `docs/specs/facilitator-board-and-categorisation/prd.md#user-flows` – flow 1 steps 6-7 (place from your own device, Uncategorised empties as the visible measure of what is left), flow 2 (sorting while the Round is still open, contribution continuing into Uncategorised alongside) and flow 5 (reopening a sorted Round).
- `docs/specs/facilitator-board-and-categorisation/plan.json#sharedDecisions` – four decisions are **consumed, never re-derived**: the **Board read projection contract** and *"Uncategorised is the absence of a placement"* (S02 owns the single read that returns Categories in order with their Post-its and every count together – this story reads through it and invents no second shape); the **sorting-authority gate** (Session Assignment on the Round's Session, or conference-wide Admin, resolved per request against `api/src/conferences/authorization.ts`, with actor identity from the credential); **Board writes advance the activity watermark** (a placement rides the cursor S02 confirms and extends – there is no second cursor and no second cadence); and **wireframes are the source of the interaction model** (S01 settles the non-drag placement interaction at 375 px; this story implements it and does not re-decide it).
- `docs/wireframes/facilitator-board-and-categorisation/design-decisions.md#the-non-drag-placement-interaction-model` – S01 TI08's first settled decision, recorded at a stable heading anchor precisely so this story can cite the artifact rather than the spec that produces it: **the non-drag placement interaction model**, stated as a decision with its reasoning and naming the wireframe that demonstrates it. The wireframe is the Facilitator sorting surface in the same directory – `docs/wireframes/facilitator-board-and-categorisation/facilitator-sorting.html`, resolved through `docs/wireframes/facilitator-board-and-categorisation/index.html` in that directory if the page slug differs – rendered at 375 / 768 / 1280 px, and **375 px is the case the model has to survive**. **The interaction model comes from these two artifacts.** It is an accessibility requirement, not a styling choice, and inventing a second one in this story is the failure this reference exists to prevent. Until S01 lands, the `plan.json#sharedDecisions` entry above is the contract.
- `docs/specs/facilitator-board-and-categorisation/s02-categories-uncategorised-and-sorting-authority.md` – the sibling FIS this story builds directly on: the Category storage, the placement field whose absence *is* Uncategorised, the single Board read and its counts, and the authority gate. Read its Implementation Tasks for the concrete column, route and payload names this story attaches to.
- `web/src/activities/SessionActivitiesPanel.tsx` – the shipped surface this story extends, and specifically `writeToBoard`: one path for every board write, the server's own sentence held in **panel-level** state so the re-read the handler itself causes cannot take the refusal off the screen, and the board re-read on both the success and the failure branch. Placement is a fourth caller of this seam. Read the module note's four load-bearing rules – authority is the server's answer, the payload is replaced wholesale, the poll loop is the shared one, and only an undeliverable *contribution* is ever held.
- `docs/LEARNINGS.md#react-state--refusals` – *"A refusal rendered only inside a component its own handler unmounts is lost."* A placement refusal rendered inside the Post-it or Category subtree that the following board re-read replaces is a refusal nobody sees.
- `docs/LEARNINGS.md#testing` – four entries decide how this story's guards are written: assert **cache/store contents, not the requests issued**; never `waitFor` on the value you are about to assert; a regression test written beside its fix usually passes without the fix, so revert and re-run before believing a guard; and a structure guard that silently matches nothing is a false green – assert the marker is found, never `if (found > -1)`.
- `docs/LEARNINGS.md#css--responsive-layout` – `flex-shrink: 0` plus a rem `min-width` goes off-screen under OS font scaling on a 375 px phone (use `min-width: min(Xrem, 100%)`), and page-level `scrollWidth - clientWidth` misses text overflowing its own box – compare the **element's** own `scrollWidth` with its `clientWidth`.
- `docs/UBIQUITOUS_LANGUAGE.md#session-activities` – **Category**, **Uncategorised**, **Board**, **Post-it**. *"Column"* describes how a Category is drawn on a wide Board, and is not the term; Uncategorised is **not a Category** and a Post-it left in it is a valid terminal state. This story introduces no new domain vocabulary.
- `AGENTS.md` – the Do Not / Never list, in particular *"Never ship a fixed-width or desktop-only layout"*, *"Never rely on in-process state between requests"*, *"Never widen offline support beyond schedule reads and post-it queueing"*, *"Never attribute a vote to a voter"* and *"Never key a user on their email address – use the OIDC `sub`"*.


## Deeper Context

- `api/src/routes/rounds.ts` – `authorizeWrite` (Session Assignment narrowing, then `assertEditable` for the Archived refusal, authorization **first** so a caller with no authority learns nothing further) versus `authorizeContribution` (Membership). Placement is a **run-it** write and takes the first shape, not the second. Also `holdsAssignment` / `mayRun`: the client consumes the server's flag and never re-derives authority.
- `api/src/rounds/post-it-repository.ts` – the guarded-write idiom to follow: every condition lives in the `UPDATE`'s own predicate rather than in a read taken first, and the outcome union (`written` / `missing` / `not-author` / `round-closed`) is *returned* so the error envelope stays in the route. Also `COLUMNS`: one projection so no caller can invent a different shape.
- `web/src/poll/use-watermark-poll.ts` – the one poll loop in the application, and the module note explaining why there are to be *"no more mechanisms – only more call sites"*. Placement adds neither.
- `web/src/offline/post-it-queue.ts` and `web/src/offline/use-post-it-queue.ts#mayStillBeDelivered` – the queueing path that **must not be reachable from placement**. Read them to know exactly what not to call.
- `api/test/post-it-structure.test.ts` – the structural-guard idiom, including the `'this story widens offline support by nothing at all'` block and the `'reaches the post_it table only from the rounds modules'` block. This story's guards follow the same shape.
- `visual/session-activities.spec.ts` – the shipped three-width pattern: the `VIEWPORTS` table, the fixture-served API, the `UNBROKEN` token that actually pushes a 375 px phone sideways (a hyphenated fixture proves nothing), `assertWithinViewport`, and the per-element overflow check.
- `docs/adrs/ADR-007-vote-arrivals-do-not-advance-the-member-visible-cursor.md` – why the activity watermark is an opaque counter that Post-it writes advance and ballots do not. A placement is a Post-it write and advances it; nothing here changes that rule in either direction.
- `docs/adrs/ADR-003-postgresql-containerized-development.md` – why the placement write uses plain PostgreSQL and no provider-specific feature.


## Acceptance Scenarios

- [x] **S01 [OC01] [TI01,TI02,TI04,TI05] A Facilitator places a Post-it from Uncategorised into a Category using the keyboard alone, at 375 px, with no pointer event anywhere on the path**
  - **Given** the Post-it Round "What slowed us down this quarter?" has the Categories "Handovers" and "Tooling" on its Board, Ada holds a Session Assignment on that Session, and "Waiting three days for test data" sits in Uncategorised
  - **When** Ada reaches that Post-it's placement control by keyboard from the page, chooses "Handovers", and confirms – using only `Tab`, arrow keys, `Enter` and `Space`
  - **Then** the Board shows the Post-it under "Handovers", Uncategorised's count has fallen by one and "Handovers"' has risen by one
  - **And** the whole path is traversed without a single `pointerdown`, `mousedown`, `dragstart` or `drop`, and the control carries an accessible name that says which Post-it it moves and where it can go

- [x] **S02 [OC01,OC02] [TI01,TI03,TI04,TI05] The same Post-it moves on to a second Category and back to Uncategorised, and every count on the Board is right after each move**
  - **Given** "Waiting three days for test data" now sits in "Handovers"
  - **When** Ada places it into "Tooling", and then places it back into Uncategorised
  - **Then** after each move the Board shows it in exactly one place, "Handovers", "Tooling" and Uncategorised each carry the count that matches what is drawn, and Uncategorised holds it at the end
  - **And** each move is answered from **one Board read**, not one request per Category and not one per Post-it

- [x] **S03 [OC02] [TI03,TI06] Bo's already-open Board re-renders into the new arrangement within one poll interval, with no reload**
  - **Given** Ada and Bo both have the same Session's Activities view open, and the Board shows three Post-its in Uncategorised
  - **When** Ada places one of them into "Handovers"
  - **Then** Bo's view – untouched, never reloaded – shows that Post-it under "Handovers" with the counts updated, within one poll interval of the shared loop
  - **And** the assertion is made against the **rendered Board content on Bo's view**, never against the fact that a request was issued (`docs/LEARNINGS.md#testing`)

- [x] **S04 [OC03] [TI01,TI02] Sorting works before the Round closes, after it closes, and survives a reopen**
  - **Given** the Round is open and two Post-its are already placed into "Handovers"
  - **When** Ada places a third Post-it while the Round is still open, the Round is then closed and she places a fourth, and the Round is then reopened
  - **Then** every placement is accepted in all three states, all four Post-its are still in "Handovers" after the reopen, and the Categories themselves are untouched by the transition
  - **And** a Post-it contributed after the reopen arrives in **Uncategorised** and is never auto-placed

- [x] **S05 [OC03] [TI01,TI02,TI06] The server refuses the three placements it must, and each refusal writes nothing**
  - **Given** Cleo is a Conference Member with **no** Session Assignment on that Session and no conference-wide Admin, and a second Post-it Round on another Session has a Category of its own
  - **When** Cleo issues a placement directly at the API; and Ada issues a placement naming that other Round's Category as the destination; and Ada issues a placement after the Conference has been archived
  - **Then** each is refused at the API with a distinct code naming its own reason, the Board is byte-for-byte unchanged after all three, and Cleo was never offered a placement control in the first place
  - **And** a placement naming a Post-it or a destination that has since gone re-reads the Board and says it changed, rather than reporting a bare failure
  - **And** a request body carrying an `actorSub`, a `facilitatorSub` or an `email` changes nothing about who the write is attributed to or whether it is allowed

- [x] **S06 [OC03] [TI01] The end state requested is the one that holds: a repeat placement succeeds silently, and two concurrent sorters both succeed with the last write winning**
  - **Given** "Waiting three days for test data" already sits in "Handovers", and Ada and Dev both hold authority on the same Session
  - **When** Ada places it into "Handovers" again; and then Ada and Dev place that same Post-it into "Handovers" and "Tooling" respectively, from two devices at the same time
  - **Then** the repeat succeeds with the Post-it still in "Handovers" and nothing else changed; and both concurrent placements succeed with the Post-it ending in exactly one Category, whichever write landed last
  - **And** neither sorter is shown a conflict, a merge prompt or a "somebody else changed this" interstitial, and each sees the other's result near-live

- [x] **S07 [OC04] [TI06,TI07] A placement that cannot be delivered is surfaced and nothing is queued**
  - **Given** Ada is sorting and "Waiting three days for test data" is drawn under "Handovers"
  - **When** the placement request fails to reach the API – a dead connection, not a refusal
  - **Then** the Post-it is still drawn under "Handovers", the surface says `Couldn't move that – check your connection.`, and the message is still on screen after the Board re-read that follows
  - **And** the device's Post-it queue store holds **nothing** afterwards – asserted against the store's contents, not against which functions were called (`docs/LEARNINGS.md#testing`)


## Structural Criteria

- [x] No placement path – route, repository, client function or component handler – reaches any module under `web/src/offline/`. Sorting is online-only, and the queueing seam is unreachable from it by construction rather than by discipline.
- [x] `web/src/poll/use-watermark-poll.ts` remains the only polling cadence in the application: this story adds no interval, no timer and no second cursor, and a placement advances the activity watermark through the writer S02 already established for the placement field.
- [x] Nothing on the placement path reads, joins to or returns Vote data. The placement route and its repository function touch no ballot or vote table, and the ADR-006 guarantee is untouched.
- [x] The shipped author paths are unchanged: contributing, correcting and deleting one's own Post-it keep their Membership gate, their open-Round condition and their no-trace deletion. Placement neither reuses nor relaxes them.
- [x] Every refusal this story adds is declared through the shared error envelope in `api/src/errors.ts`, one code per reason, and no refusal message carries a count or discloses anything about a Board the caller has no authority over.
- [x] The placement write uses plain PostgreSQL only, holds no state between requests, and takes actor identity from the credential – never from a request body.
- [x] The Facilitator's sorting surface holds at the design ceiling: a Board of ~200 Post-its across ~20 Categories renders with no horizontal body scroll at 375, 768 and 1280 px, and the primary placement control stays reachable one-handed at 375 px.
- [x] Existing `api`, `web` and `visual` suites pass unchanged.


## Scope & Boundaries

### Work Areas

- `api/src/rounds/post-it-repository.ts` – the guarded placement write and its outcome union.
- `api/src/routes/rounds.ts` – the placement route, under S02's sorting-authority gate and the Archived refusal.
- `web/src/api/client.ts` – the placement call and its request/response types.
- `web/src/activities/SessionActivitiesPanel.tsx` – the Facilitator's sorting surface: the non-drag placement control, the panel-level refusal, and the board re-read.
- `api/test/` and `web/test/` – the behavioural tests and the structural guards (offline boundary, no second cadence, no Vote reach, server-side authority).
- `visual/session-activities.spec.ts` – placement coverage at the three standing widths, including a ceiling-sized Board.

### What We're NOT Doing

- **Creating, renaming, reordering or removing Categories, and the Uncategorised holding area itself** – S02 owns the Category model, the Board read and its counts. This story places Post-its through that contract and defines no part of it.
- **Discard, restore and permanent removal** – S05 and S06. FR3's *"a discarded Post-it cannot be placed; restore it first"* rule is stated here and wired in S05, which is the story that first makes a Post-it discardable (see **Constraints & Gotchas**).
- **The Display Link, the projected Board View and the Attendee's live Board** – S04, S07 and S08. This story changes no read-only surface; the near-live propagation it relies on is the cursor those surfaces already consume.
- **Drag-and-drop as an additional wide-viewport affordance** – permitted by the constraint, deliberately not built. It is a second interaction to maintain and test for a case the keyboard path already covers; raise it as its own item if the room asks for it.
- **Any widening of offline support** – no outbox, no queued placement, no replay buffer, and no change to what `web/src/offline/` holds.


## Architecture Decision

**Approach**: Placement is one guarded `UPDATE` of the Post-it's placement field, exposed as its own route (`PATCH …/rounds/:roundId/post-its/:postItId/placement`, body `{ categoryId: string | null }`) under S02's sorting-authority gate – separate from the shipped `PATCH …/post-its/:postItId` text edit, which is the *author's* write under a Membership gate.
That predicate is written as a **flat conjunction of independently-named placement conditions** – the Post-it's identity, the destination Category belonging to this Round's Board, and the Post-it still being placeable – so a later story adds a refusal by appending one conjunct, with no restructuring of the statement and no second guard site. It is the single extension point for refusal conditions: S05 appends the not-discarded condition here (see **Constraints & Gotchas**).
**Why this over alternatives**: overloading one route would put two different authority gates on one path, which is how a Facilitator ends up able to edit somebody's words or an author ends up able to sort. Every condition – destination on this Board, Post-it still there – lives in the write statement's own predicate rather than a read taken first, which is the shipped repository's idiom and removes the window two replicas would each pass. There is deliberately **no** version predicate: the PRD requires last-write-wins with no conflict UI, so optimistic concurrency is the wrong tool here even though `docs/LEARNINGS.md#concurrency` is right about where it would belong if it were needed.


## Code Patterns & External References

```
# type | path#anchor                                              | why needed (intent)
file   | api/src/rounds/post-it-repository.ts#COLUMNS             | One projection, one guarded-write idiom – conditions in the predicate, outcomes returned
file   | api/src/routes/rounds.ts#authorizeWrite                  | The run-it authority shape: authority resolved first, then the archived refusal
file   | web/src/activities/SessionActivitiesPanel.tsx#writeToBoard | The board-write seam: panel-level refusal, re-read on both branches, no deferred path
file   | web/src/api/client.ts#updatePostIt                       | Request/response envelope and ApiError mapping for a Post-it-scoped write
file   | api/test/post-it-structure.test.ts                       | Structural-guard idiom, including the offline-widens-nothing block
file   | visual/session-activities.spec.ts#VIEWPORTS              | The shipped three-width pattern, fixtures and per-element overflow check
wire   | docs/wireframes/facilitator-board-and-categorisation/design-decisions.md#the-non-drag-placement-interaction-model | S01's settled non-drag placement model – consume the decision, do not re-decide it
wire   | docs/wireframes/facilitator-board-and-categorisation/facilitator-sorting.html | The sorting surface drawn at 375/768/1280px – implement the 375px placement path from it
```


## Constraints & Gotchas

- **Critical**: *"A placement is never queued offline"* is a **binding constraint**, not a preference. `contribute` in `SessionActivitiesPanel.tsx` is the one write on that surface with a deferred path, and it is the wrong model to copy – placement follows `writeToBoard` instead. Must handle by: never calling `hold` / `holdPostIt` / `mayStillBeDelivered` from the placement path, and proving the queue store is empty after a failed placement.
- **Critical**: the no-op placement must not be expressed as a predicate. A statement conditioned on *"currently somewhere else"* matches zero rows when a Post-it is placed where it already is, which is indistinguishable from *"the Post-it is gone"* – and FR3 says the repeat **succeeds**. Must handle by: keeping only identity, same-Board and still-placeable conditions in the predicate, so a no-op still matches its own row.
- **Avoid**: a placement refusal rendered inside the Post-it card or the Category block it concerns. The board re-read that follows every write replaces that subtree and takes the message with it (`docs/LEARNINGS.md#react-state--refusals`). **Instead**: hold it in panel-level state exactly as `boardError` already is.
- **Constraint**: the discarded-Post-it refusal (`FR3` → Validation) cannot be *proved* in this story – nothing is discardable until S05 lands. **Explicit narrowing note, not a silent one, and it now has a named receiver**: the condition and its proving scenario are accepted by `docs/specs/facilitator-board-and-categorisation/s05-discard-and-restore.md` – in its **TI03** (the discard/restore repository seam, amended to carry it) and in the S05 scenario that exercises a placement against a discarded Post-it. The contract, stated the same way in both FIS files: *the placement statement's predicate in the placement route (S03's Architecture Decision) is the single place refusal conditions are added. S05 amends that predicate with the not-discarded condition – an anti-join or `NOT EXISTS` against `post_it_discard`, consistent with the read-exclusion mechanism S05 established – rather than adding a second guard elsewhere or a pre-check read.* S03's obligation is therefore to leave TI01's predicate as that single extension point and to state the rule; this is the only part of the story's scope S03 does not close.
- **Note, not a defect** – `api/test/post-it-structure.test.ts:517`, the `'registers the board’s three writes and the activity watermark poll, all through withAuth'` guard, asserts that **every** registered route whose url matches `/post-its|activities\/watermark/` is authenticated. The placement route's url extends into that matcher, so this shipped guard begins running against the new route the moment TI02 registers it. The route is authenticated under `authorizeWrite`, so nothing here needs changing – but an executor should know the guard widens by itself, and should add the placement url to the same block's explicit url list so registration is asserted too, not only authentication.
- **Constraint**: `Couldn't move that – check your connection.` is a literal contract value from `prd.md#edge-cases`, en dash included. It is the client's sentence for a transport failure only; every *server* refusal shows the server's own message verbatim, as the shipped board writes already do.
- **Avoid**: adding a second read to keep counts current. The counts come from S02's single Board read (`prd.md#non-functional-requirements` → *"One read per Board"*); a per-Category count request is the N+1 this project has already been bitten by.


## Implementation Plan

### Implementation Tasks

- [x] **TI01** A Post-it's placement is settled by one guarded statement in `api/src/rounds/post-it-repository.ts`, whose predicate carries every condition
  - Follow the existing `edit` / `remove` idiom in that module: conditions inside the `UPDATE`, outcomes returned as a union rather than thrown, `COLUMNS` reused so no second projection exists. The destination is a Category on **this Round's** Board or `null` for Uncategorised, checked in the statement itself; a placement into the current Category still matches its row.
  - **Verify**: `Test: placing into a Category belonging to another Round is refused and changes no row; placing into the Category the Post-it already occupies returns the written outcome with the Post-it unmoved; placing to null leaves it in Uncategorised`

- [x] **TI02** A placement route exists under the sorting-authority gate, refusing anyone without it and any write against an Archived Conference
  - `PATCH …/rounds/:roundId/post-its/:postItId/placement` in `api/src/routes/rounds.ts`, taking the `authorizeWrite` shape (authority resolved **first**, then `assertEditable`) rather than `authorizeContribution`. Actor from `caller.sub` only. Consumes TI01's outcome union and maps each to its own `ERROR_CODES` entry.
  - **Verify**: `Test: a Member with no Session Assignment and no conference-wide Admin is refused at the API with CONFERENCE_ROLE_REQUIRED and writes nothing; the same request on an archived Conference is refused naming the archived state; a body carrying actorSub/email changes neither attribution nor the decision`

- [x] **TI03** A placement is visible to every other open Board within the near-live window, through the cursor and the read that already exist
  - Depends on TI01. The placement write advances the Session's activity watermark through the writer S02 established for the placement field – no new trigger, no per-Round cursor, no second cadence. The updated arrangement and counts arrive on S02's single Board read.
  - **Verify**: `Test: after a placement the Session's activityWatermark differs from the value read before it, and one Board read returns the Post-it under its new Category with per-Category and Uncategorised counts matching`

- [x] **TI04** The web client can place a Post-it, and carries no opinion about who may
  - A `placePostIt` function in `web/src/api/client.ts` alongside `updatePostIt` / `deletePostIt`, sending `{ categoryId: string | null }` and nothing else. Follow the existing envelope and `ApiError` mapping.
  - **Verify**: `Test: the request body carries only categoryId, null for Uncategorised, and no author, actor or authority field; a refusal surfaces as ApiError with the server's code and message intact`

- [x] **TI05** The Facilitator's sorting surface places a Post-it with the keyboard alone, at every standing width
  - Depends on TI04. Implements S01's wireframed interaction in `web/src/activities/SessionActivitiesPanel.tsx`; routed through the existing `writeToBoard` seam so the refusal is panel-level and the Board is re-read either way. No `draggable`, no drag handler, no pointer-only affordance anywhere on the path. The control names the Post-it it moves and the destinations open to it.
  - **Verify**: `Test: a keyboard-only interaction (Tab/arrows/Enter/Space, no pointer events dispatched) moves a Post-it from Uncategorised into a named Category and the Board re-renders with it there; the placement path renders no draggable attribute and registers no dragstart/drop handler`

- [x] **TI06** A failed placement leaves the Post-it visibly where it was, with the reason on screen and nothing deferred
  - Depends on TI05. A transport failure shows `Couldn't move that – check your connection.`; a server refusal shows the server's own sentence. Neither is rendered inside the subtree the following Board re-read replaces. Nothing on this path touches `web/src/offline/`.
  - **Verify**: `Test: with the placement request failing at transport, the Post-it is still rendered under its original Category, the connection message is on screen after the subsequent board re-read, and the IndexedDB post-it queue store is empty`

- [x] **TI07** Structural guards prove the boundaries this story must not cross
  - Follow `api/test/post-it-structure.test.ts` for shape. Guards: no import path from the placement surface into `web/src/offline/`; no new interval/timer or cursor under `web/src/`; the placement route and repository reference no vote or ballot table; author write paths unchanged. Each guard asserts its marker was **found** – never `if (found > -1)` (`docs/LEARNINGS.md#testing`).
  - **Verify**: `Test: each guard fails when its rule is deliberately violated (revert-and-rerun confirms it is not vacuously green), and each asserts the marker it searches for was located`

- [x] **TI08** The sorting surface is captured and asserted at 375, 768 and 1280 px, including a ceiling-sized Board
  - Extend `visual/session-activities.spec.ts` using its `VIEWPORTS` table, fixture-served API and `UNBROKEN` token. One fixture at the design ceiling (~200 Post-its across ~20 Categories) alongside the ordinary case. Compare the element's own `scrollWidth` with its `clientWidth`, not the page's (`docs/LEARNINGS.md#css--responsive-layout`).
  - **Verify**: `Test: at each of the three widths, no element of the sorting surface overflows its own box and nothing is clipped horizontally, for both the ordinary Board and the ceiling-sized one; screenshots are written for each`

### Testing Strategy

- The concurrency scenario (S06) needs two real writers against a real PostgreSQL, not two sequential calls – sequential writes cannot distinguish last-write-wins from any other policy. Follow the `api/test/schedule-concurrency.integration.test.ts` precedent, and note `docs/LEARNINGS.md#concurrency`: an unfiltered `pg_locks` wait proves nothing, and a blocked write waits on a `tuple` lock. [TI01]
- The near-live scenario (S03) asserts Bo's **rendered board content**, and waits on something the defect cannot touch – never on the value being asserted. [TI03,TI06]
- The offline guard (S07) asserts the queue store's contents after the failed placement. Seeding it first and proving it is *unchanged* is stronger than asserting it is empty, but only with the cache-ownership claim in place (`docs/LEARNINGS.md#testing`). [TI06,TI07]

### Execution Contract

- **S03 lands first on the two files W3 shares; S04 rebases onto the result.** S03 and S04 are both in W3 and both list `web/src/activities/SessionActivitiesPanel.tsx` and `web/src/api/client.ts` in **Work Areas** – across this bundle six of the eight stories modify that panel and five modify `client.ts`. The plan resolves this at plan level rather than leaving it to merge luck: **S04 is no longer marked parallel, and W3 runs S03 then S04 sequentially** (`plan.json#executionNotes`, which also records that any pair run concurrently on that panel needs worktree isolation and an explicit integration step). So S03 takes those two files first, in a tree S04 has not touched, and S04 starts from S03's landed state. Do not run the two concurrently against one shared tree.
- **The shipped route-authentication guard widens onto this story's route by itself.** `api/test/post-it-structure.test.ts:517` matches every route url containing `post-its`, which the placement route's url does. Expect it to run green against TI02's route from the moment it is registered, and treat a failure there as an authority defect in this story rather than an unrelated break (see **Constraints & Gotchas**).


## Implementation Observations

> _Managed by exec-spec post-implementation – append-only._

### Run: 2026-08-30 21:14 UTC – discovered-requirements

#### DISCOVERED REQUIREMENTS

_Propagated by the exec-plan wave triage from S02 (2026-08-30) – not authored with this story._

- **The accessibility debt on the Board markup is inherited, not cleared.** S02's review raised an accessibility cluster on the Category controls that was surfaced as Notes and not remediated: no control carries an accessible name identifying *which* Category it acts on (M5); nothing is announced after a successful write and focus is dropped to `<body>` on removal (M6); the region heading levels skip h3 to h5 (L10). S02's own Implementation Observations name this as "the one worth taking before S03 builds more controls onto the same markup". This story adds per-Post-it controls to that same markup – give every control it adds an accessible name naming its target, and do not compound the existing gap.
- **No TypeScript parameter properties in API source.** A parameter property (`constructor(readonly categoryId: string)`) type-checks, lints and passes `vitest`, and is refused outright by Node's strip-only type removal – which is how `npm run dev:api`, `api/test/join-attempt-probe.ts` and `api/test/wall-clock-probe.ts` load API source. It broke every out-of-process path during S02 and neither `tsc` nor `eslint` caught it. Declare and assign fields explicitly in any class added under `api/src/`.
- **The unlisted-Category fallback holds for every Board read.** A Post-it whose Category is absent from the same Board read renders in **Uncategorised**, never dropped. The Session read takes Categories and Post-its as two statements inside one `Promise.all` with no transaction between them, so a Category removed between the two leaves the Post-it snapshot naming a Category the Category snapshot no longer lists. Grouping strictly by id puts such a Post-it in *neither* bucket, contradicting `prd.md#fr2-the-uncategorised-holding-area`'s invariant that a non-discarded Post-it is in exactly one Category or in Uncategorised, never neither. Established and proved by S02 (`api/test/category.integration.test.ts`, "renders a post-it in uncategorised when its category is removed mid-read"). Any read this story adds over the Board must preserve it.

### Run: 2026-08-31 07:53 UTC – observations

#### OWNER DECISIONS

- **The first worker was terminated by a session limit** after implementing but before ticking the FIS or reviewing. The tail was re-delegated; the implementation was not redone.
- **Four Fix-routed findings were remediated by the orchestrator.**
  - **F1** – a remembered placement destination is honoured only while it still names a Category on this Board. The original finding's stated *symptom* was wrong and the correction matters: React's controlled-`select` reconciliation selects the first non-disabled option when the value matches none, so the control reads *Uncategorised* while the remembered dead id is what **Move** commits. Displayed and committed destinations disagree and nothing looks wrong. A native `select.value` assignment would give `selectedIndex = -1`; React does not. Pinned by `commits the destination it is showing after the chosen category is removed`, proved red at `expected { categoryId: 'cat-tooling' } to deeply equal { categoryId: null }`.
  - **F2** – the open/closed guard was vacuous: one non-array route, and a watermark equal to the payload's own, so no second read ever happened. Now two reads are asserted on the `round-state` badge.
  - **F3** – the cross-Board case passed a Category id as a Post-it id; it now contributes a real Post-it on the other Board.
  - **F4** – an orphaned JSDoc was moved onto `hydrate`.
- **The remediation re-review** confirmed F1, F2 and F4 close, verified the React model two ways including reading React 19's `updateOptions`, and found one further Fix: the fix's own comment still asserted the disproven "renders blank" model. That comment and the matching test comment were corrected.
- **N2 was closed at its root by documentation rather than restructuring.** `place`'s extension-point contract now states that the predicate is one of **two** sites: `diagnosePlacement` answers `destination-missing` for every case where the `post_it` row is found, so appending the not-discarded conjunct to the predicate alone would refuse a discarded Post-it with `CATEGORY_NOT_FOUND`, and `PlacementOutcome` carries no member for the discarded case. Documenting was chosen over re-deriving the destination check because it removes the hazard without foreclosing S05's choice.

#### NOTICED BUT NOT TOUCHING

Surfaced, not fixed.

- **N1 (HIGH) – every successful move drops keyboard focus to `<body>`.** `disabled={busy}` blurs the control and the card re-parents. This contradicts OC01 and compounds the S02 accessibility debt S03 was explicitly told not to compound. Left for an owner because *where* focus should land is a design decision.
- **N3** nothing announces a successful move. **N4** the 23503 branch is never executed by the test named for it. **N5** the concurrency test parks at the application layer rather than on a tuple lock. **N6** the label-overflow guard cannot fail for the reason it exists. **N7** a refusal renders at the foot of a 200-card Board. **N8** no test completes a placement in a real browser. **N9** the ceiling fixture's Uncategorised is always empty though its comment says otherwise. **N10** accessible names derive from Post-it text alone, so duplicates collide. **N11** two stated schema defences are untested. **N12** the integration file evaluates to zero tests without a database (pre-existing). **N13** `void tooling;`. **N14** pre-existing em dashes, none introduced by S03.
- **From the re-review** – **R2**: F3's fix still does not isolate `r.session_id`; the stray Post-it differs on two conjuncts at once, and neutralising `session_id` in both `place` and `diagnosePlacement` leaves all 11 integration tests passing, with only `placement-structure.test.ts:119`'s string match catching it. **R3**: the new F1 test uses `user.selectOptions` / `user.click` without `watchForPointerEvents()`, against the file docblock's blanket claim. **R4**: `placements` still accumulates dead entries – masked, not pruned (confirmed unable to leak).

### Run: 2026-08-31 07:59 UTC – observations

#### OWNER DECISIONS

- **N1 is resolved: focus returns to the moved Post-it.** The owner was given four options – return focus to the moved Post-it's destination control; stop disabling the control and rely on `writeToBoard`'s existing `writing(key)` early return; advance to the next Post-it in Uncategorised; or accept the regression – and chose the first.
- **Implementation**: a `focusAfterMove` slot beside `placements` is set on a successful placement, and an effect restores focus to that Post-it's `move-to-<id>` control once `state.kind === 'ready'` – i.e. once the Board carrying the card in its new region has rendered. It is keyed on the **Post-it** rather than a position, so focus follows the card wherever it was sent. The attempt is abandoned as soon as a Board renders without that control: the Post-it may have been deleted by its author, or the viewer may have lost the run controls mid-move, and neither should hold a pending focus.
- **Why it was not a nicety**: a successful move disables the button under the keyboard and re-parents the card, so the focused element is unmounted and focus falls to `<body>`. A Facilitator sorting a pile would tab from the top of the page after **every single move**, on the surface whose whole interaction model exists to be keyboard-operable (S01 → OC02). The defect was in *repetition*, which is why the existing single-placement keyboard scenario passed over it.
- **Proved red before green**: `returns focus to the moved post-it once the board carrying it has rendered` in `web/test/PostItPlacement.test.tsx` asserts `document.activeElement` is that control by test id, so landing on any other control fails too. With the `focus()` call neutralised it fails with `expected <body><div>…</div></body> to be <select …>`. Full suite after the fix: **79 files / 1314 tests**.
- **For the record**: this leaves S02's M5/M6 accessibility cluster still open – no control carries an accessible name identifying *which* Category it acts on, and nothing is announced after a successful write. Those were not part of this decision.
