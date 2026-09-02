# Product Requirements Document: Facilitator Board View and Post-it Categorisation

> **Source Trust**: trusted-local
> **Context**: `docs/ROADMAP.md` → Phase 3 MVP, milestone "Facilitator board view". Backlog items REQ-015, REQ-016, REQ-022, REQ-031, REQ-038. Closes the open question `docs/PRODUCT.md` has carried since 2026-08-16 – *"Are post-it categories defined during conference setup, or created ad hoc by the organizer while sorting?"*
> **Related Assets**: `docs/UBIQUITOUS_LANGUAGE.md` (Board, Board View, Category, Uncategorised, Display Link, Discard, Session Assignment – canonical terms and the synonyms to avoid); `docs/OUT-OF-SCOPE.md` (conference-level default Category sets; Attendees choosing a Category when contributing – both rejected concepts, not deferrals); `docs/adrs/ADR-003-postgresql-containerized-development.md` (portable PostgreSQL); `docs/adrs/ADR-006-vote-anonymity-holds-against-application-paths-not-database-credentials.md` (the anonymity guarantee this feature must leave untouched); `docs/adrs/ADR-007-vote-arrivals-do-not-advance-the-member-visible-cursor.md` (what the Session activity watermark may carry).

## Executive Summary

- **Problem**: The shipped `session-activities` slice collects named Post-its onto a Board and stops there. A Board is a flat chronological list – the room never sees its own ideas organised, the sorting conversation that `docs/PRODUCT.md` names as the point of a projected Board never happens in the product, and the Report has nothing but an undifferentiated pile to carry. Three backlog items describing the same activity (REQ-015, REQ-031, REQ-038) contradict each other on when and where it happens, so nothing downstream can be specified.
- **Vision**: The Facilitator projects the Board to the room and sorts it in front of everyone – creating Categories that fit what people actually wrote, placing every Post-it from their own phone or laptop, discarding noise recoverably – and leaves behind a categorised, attributed structure the Report can read.
- **Target Users**: Presenter/Facilitator and Admin/Organizer (sort, discard, project); Attendee (follows the Board taking shape on their own phone); Leadership (consumes the categorised output, downstream of this release).
- **Success Metrics**:
  - Share of Post-it Rounds whose Board is sorted during or immediately after its Session rather than days later.
  - Share of Post-it Rounds ending the Conference with zero Post-its left in Uncategorised.
  - Share of Sessions holding a Post-it Round where a Display Link was actually opened on a room machine.
  - Post-its lost irrecoverably to a Discard: zero, up to Conference archival – excluding the two acts that are irreversible by design, an author deleting their own Post-it and an Admin removing one permanently.
  - Placement-to-visible latency on the projected view and on Attendee phones: within the standing near-live window.

### Capabilities at a Glance

- **FR1: Categories on a Board** _(Must / P0)_ – the Facilitator creates, renames, reorders and removes named buckets belonging to one Post-it Round's Board.
- **FR2: The Uncategorised holding area** _(Must / P0)_ – the implicit destination every Post-it arrives in and a late one returns to, which can never be renamed, reordered or removed.
- **FR3: Placing Post-its into Categories** _(Must / P0)_ – the sorting activity itself, fully operable from a 375px viewport and without drag-and-drop.
- **FR4: Discard and restore** _(Must / P0)_ – removing a Post-it from consideration in a way that leaves a trace and stays restorable until the Conference is archived.
- **FR5: Admin permanent removal** _(Must / P0)_ – an Admin removes a Post-it outright, leaving no trace and no restore; the moderation path Discard deliberately is not.
- **FR6: Sorting authority** _(Must / P0)_ – sorting and discarding require a Session Assignment on the Round's Session, or conference-wide Admin, enforced server-side.
- **FR7: Display Link issuance and revocation** _(Must / P0)_ – an unguessable, revocable, day-bounded read-only link scoped to one Round, issued and withdrawn by the Facilitator.
- **FR8: The projected Board View** _(Must / P0)_ – a read-only big-screen surface reached by that link without signing in, legible at projection distance, never a control surface.
- **FR9: The Attendee's live Board** _(Must / P0)_ – the same Board on a phone, re-rendering into Categories near-live as sorting happens.

### Scope Highlights

- **In scope**: Categories owned by one Board; the Uncategorised holding area; sorting from the Facilitator's own device at any width; Discard with restore; Admin-only permanent removal; the projected Board View behind a revocable, day-bounded Display Link; the Attendee's live view of the same Board.
- **Out of scope**: the leadership Report; the Prioritization and Rating Voting Round purposes; Workshop Groups; editing a Post-it's text; cross-conference Category reuse; widening offline support.
- **MVP boundary**: One Facilitator, running one Post-it Round in a real Session, can project its Board, create Categories after seeing the ideas, sort every Post-it into one, discard the noise, and leave a structure the Report can read.

### Key Constraints, Assumptions & Dependencies

- **Constraint**: Sorting must be fully operable without drag-and-drop and without pointer input on the projected screen – a pointer-only interaction excludes assistive-technology users and does not survive 375px.
- **Constraint**: A Display Link is a bearer credential over named Post-its. It must be unguessable, revocable, scoped to one Round, read-only, and must reach no Vote data of any kind.
- **Constraint**: The shipped `post_it` table deliberately carries no tombstone or soft-delete column, because *author* deletion must leave no trace. Facilitator Discard is a different concept and must be stored separately rather than by relaxing that decision – worth an ADR (see Dependencies).
- **Dependency**: `activity_watermark` propagates placements to **Member-gated surfaces** – a Category or placement change must advance it, and ADR-007's rule that Vote arrivals must not is unaffected. It does **not** serve the projected view: that cursor is Session-scoped and Membership-gated (`api/src/routes/rounds.ts:804`), so the anonymous surface polls the Board instead.
- **Constraint**: A Display Link is time-bounded – dead once the Round's Session day has passed – per ADR-005's rule that ended access is bounded by time rather than by someone remembering to revoke.

## Problem Definition

### Problem Statement

confApp can now collect named ideas: an Attendee types a Post-it, it appears on the Board with their
name on it, and it survives a dead spot in the venue wifi. What it cannot do is anything *with* them.
A Board is a chronological list. The room stares at a wall of unsorted notes and then talks about
them without the app; whatever structure the conversation produces lives on someone's laptop, or
nowhere. Leadership receives the same undifferentiated pile the physical wall used to produce – the
photograph problem, digitised.

Three backlog items describe this activity and disagree about it. REQ-015 has an Organizer sorting
post-its after collection; REQ-031 and REQ-038 have Categories defined on the Board during the
Session, with the Board's layout frozen once it holds a Post-it. Read together they describe two
surfaces and two phases, and the freeze clause makes the intended flow – *see the ideas, then name
the buckets* – impossible. `docs/PRODUCT.md` has also carried an open question since 2026-08-16 about
whether Categories come from conference setup or are made up while sorting. Nothing downstream can be
built on a contradiction: the Report (REQ-023, REQ-024) consumes categorised output, and there is no
agreed shape for it to consume.

If this does not change, the Phase 3 success criterion *"The facilitator can project the board and
sort post-its into categories"* stays unmet, the Report milestone cannot start, and confApp remains a
capture tool whose output is as hard to act on as the paper it replaced.

### Evidence & Context

- `docs/PRODUCT.md` (2026-08-16): *"sorting post-its into categories is a group activity visible to
  the room."* The projected Board View exists for that reason – sorting done privately afterwards
  removes the reason to project anything.
- `docs/PRODUCT.md` → Problem: *"Workshop output is lost."* Collection alone does not fix this; an
  unsorted digital pile is lost in the same way a photographed wall is.
- `docs/ROADMAP.md` → Phase 3 lists "Facilitator board view" as its own milestone, between "Session
  activities" (done) and "Report generation" (blocked on this).
- The shipped `session-activities` slice ends at collection: `post_it` rows carry text, author and
  round, and nothing about placement, order or removal-with-a-trace.
- The glossary already defines **Discard** as *"distinct from it never having existed"* – the concept
  is agreed and unimplemented, and the shipped `post_it` migration explicitly refuses the storage it
  needs, for a reason that applies to author deletion and not to this.

## Scope

### In Scope

- **Categories on a Board** – named buckets belonging to one Post-it Round, created, renamed,
  reordered and removed by the Facilitator during or after the Round.
- **Placing Post-its into Categories** – the sorting activity itself, performed on the Facilitator's
  own device at any viewport width.
- **The Uncategorised holding area** – where every Post-it arrives and where stragglers stay visible.
- **Discard and restore** (REQ-016) – removing a Post-it from consideration without erasing that it
  existed.
- **The projected Board View** (REQ-022) – a read-only big-screen surface reached by an
  unauthenticated, unguessable, revocable per-Round Display Link.
- **The Attendee's live view of the same Board**, re-rendering into Categories as sorting happens.

### Out of Scope

- **The Report** (REQ-023, REQ-024) – this feature produces categorised output; assembling and
  delivering the leadership document is the next slice and consumes it.
- **The Prioritization and Rating Voting Round purposes** (REQ-020, REQ-021) – still deferred with
  their own slices. Voting on categorised Post-its is a Voting Round concern, not a Board concern.
- **Workshop Groups** (REQ-011, REQ-012) – a Workshop's Rounds remain conference-wide, unchanged from
  the `session-activities` slice. A per-Group Board is not introduced here.
- **Cross-conference Category reuse or analytics** – Phase 4 Archive territory.
- **Editing a Post-it's text** – authorship and text belong to the contributor and to the
  `session-activities` slice; this feature moves and discards Post-its, it does not rewrite them.
- **Widening offline support** – sorting, discarding and the projected view all require connectivity.
  Offline remains schedule reads plus Post-it queueing (`docs/PRODUCT.md` → Anti-Goals).
- **Conference-level default Category sets** – rejected as a concept, not deferred
  (`docs/OUT-OF-SCOPE.md`). A Category belongs to one Board and nowhere else.
- **Attendees choosing a Category when contributing** – rejected as a concept, not deferred
  (`docs/OUT-OF-SCOPE.md`). Post-its arrive Uncategorised; only the Facilitator places them.
- **Seeding a Board's Categories by copying another Board's** – a deferral, not a rejection. Revisit
  only if facilitators are observed retyping the same sets.
- **Auto-clustering or suggested Categories** – no ML or heuristic grouping. The sorting conversation
  is the value; automating it removes the reason it happens in the room.
- **Pointer input on the projected screen** – the big screen is a mirror, never a control surface.
- **Nested or multi-Category placement** – a Post-it is in exactly one Category or in Uncategorised.
  Sub-categories and cross-tagging are whiteboard features (`docs/PRODUCT.md` → Anti-Goals).

### MVP Boundary

One Facilitator, running one Post-it Round in a real Session, can project its Board to the room,
create Categories after seeing the ideas, sort every Post-it into one, discard the noise, and leave
behind a structure the Report can read. Proved at 375px, 768px and 1280px, plus the projected surface
validated separately at projection scale.

## Functional Requirements

### User Stories

| ID | Story | Acceptance Criteria | Priority |
|----|-------|---------------------|----------|
| US01 | As a Facilitator, I want to project the Board to the room, so that sorting is something we do together rather than something I do alone afterwards | A Display Link opened on a room machine renders the Board read-only, with author names, without a signed-in session | Must / P0 |
| US02 | As a Facilitator, I want to create Categories after I have seen the ideas, so that the buckets fit what people actually wrote instead of what I guessed beforehand | A Category can be created on a Board that already holds Post-its, at any Round state | Must / P0 |
| US03 | As a Facilitator, I want to sort Post-its from my own phone or laptop, so that I am not tied to the room machine while the room watches the result | Every Post-it on a Board can be placed and re-placed from a 375px viewport, without drag-and-drop | Must / P0 |
| US04 | As a Facilitator, I want to fix a Category name in front of the room, so that a typo on the big screen is not permanent | Rename is permitted at any time, including while the Category holds Post-its, and moves nothing | Must / P0 |
| US05 | As a Facilitator, I want to discard noise without destroying it, so that a misdrag in front of the room is recoverable | A discarded Post-it leaves the Board and the categorised output, and is restorable until the Conference is archived | Must / P0 |
| US06 | As a Facilitator, I want to know how much is left to sort, so that I can tell the room when we are done | Uncategorised shows a live count that falls as placement progresses | Must / P0 |
| US07 | As a Facilitator, I want to withdraw the room screen's access when the Session ends, so that a Board is not left readable on a link I cannot take back | Revoking a Display Link stops the projected view rendering within the near-live window; a new link can be issued immediately | Must / P0 |
| US08 | As an Attendee, I want my phone to show the Board taking shape, so that I can follow the sorting from the back of the room where the projector is unreadable | An Attendee's Board re-renders into Categories near-live as placements happen | Must / P0 |
| US09 | As an Attendee whose Post-it synced late, I want it to arrive somewhere visible, so that my idea is not silently absorbed or lost after sorting has begun | A Post-it syncing after sorting began – or after its Round closed – appears in Uncategorised on every surface, never auto-placed | Must / P0 |
| US10 | As an Organizer, I want the categorised, attributed output to survive the Session, so that the Report has something to carry | Categories, placements and Discards persist across Round close, Round reopen, and Session end | Must / P0 |
| US11 | As an Organizer, I want sorting authority enforced by the server, so that a Board is not editable by anyone who can reach its URL | A Member without a Session Assignment and without conference-wide Admin is refused at the API, not merely denied the controls | Must / P0 |

### Feature Specifications

#### FR1: Categories on a Board

**Description**: A Category is a named bucket belonging to exactly one Post-it Round's Board. The
Facilitator creates, renames, reorders and removes them, during or after the Round. There is no
conference-level set and no second place a Category can be defined.

**Acceptance Criteria**:
- [ ] A Category can be created on a Board at any Round state – open, closed, or reopened – and
      whether or not the Board already holds Post-its.
- [ ] A Category can be renamed at any time, including while it holds Post-its. Renaming moves
      nothing.
- [ ] Categories carry an explicit order that the Facilitator controls, and every surface renders
      them in that order.
- [ ] An empty Category can be removed with no prompt.
- [ ] A Category holding Post-its cannot be removed until a destination for them is chosen; moving
      them to Uncategorised is the offered default.
- [ ] A Category belongs to one Board; it is not visible from, reusable in, or affected by any other
      Board.
- [ ] Every Category change reaches the projected view and Attendee phones within the near-live
      window.

**Inputs / Outputs**:
- **Inputs**: Category name; target position for a reorder; destination choice when removing an
  occupied Category. Actor identity from the bearer credential.
- **Outputs**: The Board's Category list with names, order and per-Category Post-it counts; an
  advanced activity watermark so other surfaces re-read.

**Validation**:
- Name must be non-blank after trimming and at most 60 characters, **counted in Unicode code points
  and measured after the trim** – the same unit `char_length` counts, so the API and the schema state
  one limit rather than two (see Assumptions, and the shipped Post-it precedent in
  `db/migrations/20260828120000000_post-it.sql`).
- At most 20 Categories per Board.
- Two Categories on one Board may share a name; the Facilitator is warned but not refused. Names are
  labels, not identifiers – the Report groups by identity.
- Reorder positions are contiguous after any reorder; a client-supplied position outside the current
  range is clamped rather than refused.

**Error Handling**:
- Blank name: "A category needs a name." The field keeps what was typed.
- Name over the limit: "Category names are at most 60 characters." The field keeps what was typed.
- Removing an occupied Category: "This category holds N post-its. Move them to Uncategorised, or
  choose another category." Choose a destination, or cancel.
- Category limit reached: the create control states the limit and refuses, naming the current count.
- Any write against an Archived Conference: "This conference is archived and can no longer be
  changed."

**Priority**: Must / P0

#### FR2: The Uncategorised holding area

**Description**: Uncategorised is the implicit holding area on every Board. It is where a Post-it
arrives, where a late-syncing one lands, and where a restored one returns. It is **not** a Category:
it cannot be renamed, reordered or removed, and it exists whether or not any Category does.

**Acceptance Criteria**:
- [ ] Every Post-it arrives in Uncategorised and stays there until a Facilitator places it.
- [ ] Uncategorised exposes no rename, reorder or remove control, and the API refuses any such
      request against it.
- [ ] Uncategorised is present on all three surfaces – Facilitator, projected, Attendee – including
      when it is empty and when the Board has no Categories at all.
- [ ] Uncategorised shows a live count of what remains unsorted.
- [ ] A Conference can be archived with Post-its still in Uncategorised; that is a valid terminal
      state, and the categorised output must be able to represent it.

**Inputs / Outputs**:
- **Inputs**: None directly – Uncategorised is a consequence of Post-it arrival, placement, removal
  of an occupied Category, and Discard restoration.
- **Outputs**: The unsorted Post-it collection and its count, on every Board read.

**Validation**:
- Uncategorised is never addressable as a Category identifier for rename, reorder or delete.
- A **non-discarded** Post-it is in exactly one Category or in Uncategorised – never both, never
  neither, never two. A discarded Post-it is in neither, and is outside this invariant (FR4).

**Error Handling**:
- A request to rename, reorder or remove Uncategorised is refused at the API with the reason named.
  The UI does not offer the control; this is the backstop.

**Priority**: Must / P0

#### FR3: Placing Post-its into Categories

**Description**: The sorting activity. The Facilitator places a Post-it from Uncategorised into a
Category, and moves it between Categories, from their own device at any viewport width. This is the
only control surface; every other surface is a read.

**Acceptance Criteria**:
- [ ] A Post-it can be placed from Uncategorised into a Category, moved between Categories, and moved
      back to Uncategorised.
- [ ] Placement is fully operable without drag-and-drop, and reachable by keyboard and by assistive
      technology.
- [ ] Placement is operable at 375px, 768px and 1280px; the 375px case decides the interaction model.
- [ ] Placement is permitted while the Round is open and after it has closed, and survives a reopen.
- [ ] Each placement propagates to the projected view and to every Attendee's phone within the
      near-live window.
- [ ] Two Facilitators sorting the same Board concurrently both succeed; per Post-it, the last write
      wins, and each sees the other's placements near-live. No conflict UI is presented.
- [ ] A placement is never queued offline – the failure is surfaced, not deferred.

**Inputs / Outputs**:
- **Inputs**: Post-it identifier; destination (a Category on the same Board, or Uncategorised). Actor
  identity from the bearer credential.
- **Outputs**: The Post-it's new placement; updated per-Category and Uncategorised counts; an
  advanced activity watermark.

**Validation**:
- The destination Category must belong to the same Board as the Post-it; a cross-Board destination is
  refused.
- Placing a Post-it where it already is succeeds silently – the requested end state is the one that
  holds.
- A discarded Post-it cannot be placed; restore it first.
- Placement against an Archived Conference is refused.

**Error Handling**:
- Network failure mid-placement: the Post-it returns to where it was, with "Couldn't move that –
  check your connection." Retry. Sorting is explicitly online-only; nothing is queued.
- Post-it or destination no longer exists: the surface re-reads the Board and states that it changed,
  rather than reporting a bare failure.
- Actor lacks authority: see FR6.

**Priority**: Must / P0

#### FR4: Discard and restore

**Description**: A Facilitator removes a Post-it from consideration. It leaves the Board, the
projected view and the categorised output, but **leaves a trace** – it is distinct from the Post-it
never having existed – and remains restorable until the Conference is archived. This is a different
act from an author deleting their own Post-it, which leaves no trace at all and is unchanged.

**Acceptance Criteria**:
- [ ] A Facilitator can discard a Post-it from Uncategorised or from any Category.
- [ ] A discarded Post-it disappears from the Facilitator's Board, the projected view and every
      Attendee's Board, and stops counting toward any Category or toward Uncategorised.
- [ ] A discarded Post-it is excluded from the categorised output the Report will consume, while the
      fact of its Discard remains available to that slice.
- [ ] A discarded Post-it can be restored at any time until its Conference is archived.
- [ ] A restored Post-it returns to **Uncategorised**, never to the Category it was in.
- [ ] The Facilitator can reach this Board's discarded Post-its on their own device, and restores one
      from there. Discarded Post-its are absent from every other surface, so this is the only place a
      Discard can be reversed; the undo window runs to archival, so it cannot be an ephemeral undo
      affordance. Which shape the surface takes is settled at wireframing.
- [ ] Discarding an already-discarded Post-it succeeds silently, and restoring a Post-it that is not
      discarded succeeds silently – the requested end state is the one that holds.
- [ ] Discard storage is distinct from the author-deletion path; author deletion continues to leave
      no trace.
- [ ] A Discarded Post-it is hidden from its own author too, so the author-delete control is never
      offered against one.
- [ ] Where an author's delete does reach a Discarded Post-it – an in-flight race while the Round is
      open – the delete succeeds and the Discard trace goes with it. The API has a defined outcome
      rather than an accidental one.
- [ ] Discard and restore propagate to every surface within the near-live window.

**Inputs / Outputs**:
- **Inputs**: Post-it identifier; the discard or restore intent. Actor identity from the bearer
  credential.
- **Outputs**: The Post-it's discarded state and the trace of who discarded it and when; updated
  counts; an advanced activity watermark.

**Validation**:
- Only a holder of sorting authority (FR6) may discard or restore.
- Neither discard nor restore is permitted once the Conference is Archived.
- A restore always targets Uncategorised; a destination Category may not be supplied.

**Error Handling**:
- Restore against an Archived Conference: "This conference is archived and can no longer be changed."
  No recovery.
- Discard of an already-discarded Post-it: silent success. No message needed.
- Network failure: the Post-it stays where it was and the failure is stated; nothing is queued.

**Priority**: Must / P0

#### FR5: Admin permanent removal

**Description**: An Admin removes a Post-it outright. It leaves every surface, leaves no trace, and
cannot be restored by anyone. This is the moderation path Discard deliberately is not – the answer to
something abusive or accidentally confidential written under a real name and projected to the
company. It is the third and last removal concept on a Post-it, alongside author deletion (no trace,
Round open only) and Facilitator Discard (trace, restorable).

**Acceptance Criteria**:
- [ ] An Admin of the Conference can permanently remove any Post-it in it.
- [ ] Removal is available whether the Post-it is on the Board, in a Category, or already Discarded.
- [ ] A removed Post-it leaves the Facilitator's surface, the projected view, every Attendee's Board,
      the restore list and the categorised output, leaving no trace on any of them.
- [ ] A removed Post-it cannot be restored – not by an Admin, not by a Facilitator, not by anyone.
- [ ] Removing an already-Discarded Post-it takes its Discard trace with it; the pending restore is
      no longer offered.
- [ ] A Presenter/Facilitator without Admin cannot remove permanently, enforced server-side and not
      merely hidden in the UI.
- [ ] The act is confirmed before it takes effect, and the confirmation names the author and states
      that it cannot be undone.
- [ ] Removal propagates to every surface within the near-live window.

**Inputs / Outputs**:
- **Inputs**: Post-it identifier; explicit confirmation. Actor identity from the bearer credential.
- **Outputs**: The Post-it's absence everywhere; updated Category and Uncategorised counts; an
  advanced activity watermark.

**Validation**:
- Requires the Admin role in the Conference; a Session Assignment does not confer it.
- Not permitted once the Conference is Archived – archival is where the Conference stops changing.
- Idempotent: removing a Post-it that is already gone succeeds silently.

**Error Handling**:
- Facilitator attempts removal: "Only an admin can permanently remove a post-it. You can discard it
  instead." Discard it, or ask an Admin.
- Removal against an Archived Conference: "This conference is archived and can no longer be changed."
  No recovery.
- Confirmation dismissed: nothing happens; the Post-it stands.

**Priority**: Must / P0

#### FR6: Sorting authority

**Description**: Creating, renaming, reordering and removing Categories, placing Post-its, and
discarding or restoring them all require authority over the Round's Session. That authority is a
Session Assignment on that Session, or conference-wide Admin, and it is enforced server-side.

**Acceptance Criteria**:
- [ ] A holder of a Session Assignment on the Round's Session can perform every write in FR1, FR3 and
      FR4.
- [ ] An Admin of the Conference can perform them on any Session, with or without a Session
      Assignment, consistent with the shipped conference-wide authority rule.
- [ ] A Member holding neither is refused at the API, not merely denied the controls in the UI.
- [ ] A non-Member is refused, and is told nothing about whether the Board exists.
- [ ] A Display Link holder can perform none of them (see FR7).
- [ ] Actor identity is always taken from the credential and never accepted from a request body.

**Inputs / Outputs**:
- **Inputs**: The bearer credential and the target Round.
- **Outputs**: Permission to write, or a refusal naming the authority required.

**Validation**:
- Authority is resolved per request against the Round's Session and Conference; no in-process state
  carries it between requests.
- An Attendee whose Membership is revoked loses write authority immediately; their existing Post-its
  remain on the Board and remain attributed.

**Error Handling**:
- Member without authority: "You don't have permission to sort this board." No recovery path in the
  UI; the controls are not offered in the first place. Ask an Admin for a Session Assignment.
- Non-Member or unknown credential: a neutral refusal that discloses nothing about the Board.

**Priority**: Must / P0

#### FR7: Display Link issuance and revocation

**Description**: The Facilitator issues an unguessable, read-only link scoped to one Post-it Round's
Board, so a room machine can show the Board without anyone signing in on shared hardware. The link is
revocable and reissuable at any time, and dies on its own once the Round's Session day has passed.

**Acceptance Criteria**:
- [ ] A holder of sorting authority can issue a Display Link for a Post-it Round.
- [ ] The link is unguessable – not derivable from a Round, Session or Conference identifier.
- [ ] The link is scoped to one Round: it grants read access to that Board and to nothing else in the
      Conference.
- [ ] The link is read-only: it confers no ability to sort, discard, create Categories, or write
      anything.
- [ ] The link reaches no Vote data of any kind, in any response it can produce.
- [ ] The link can be revoked at any time; the projected view stops rendering the Board at its next
      poll, within the near-live window.
- [ ] A new link can be issued immediately after a revocation, and is a different, equally
      unguessable value.
- [ ] A Round holds at most one live Display Link. Issuing a new one revokes the current one, so
      "revoke" never needs to name which link it means.
- [ ] The link stops resolving once the server's date is past its Round's Session `day`. Because the
      bound is the Session's own day rather than a rolling timer from issue, it cannot fire
      mid-activity.
- [ ] A link issued for a Session several days out is valid immediately and still bounded – it dies
      after that Session's day, not on a countdown from issue.
- [ ] A link issued while the Conference is Draft resolves to the neutral unavailable page, and
      begins rendering the Board once the Conference is Published.
- [ ] Expiry, revocation and Draft state are indistinguishable to a link holder – one neutral
      message covers all three, disclosing nothing about which applies.
- [ ] A Board is fully usable with no Display Link ever issued; projection is an addition, never a
      prerequisite.

**Inputs / Outputs**:
- **Inputs**: Target Round; issue or revoke intent; actor identity from the bearer credential.
- **Outputs**: The link value, presented for copying or opening; its current issued/revoked state.

**Validation**:
- Only a holder of sorting authority may issue or revoke.
- A revoked link value is never reissued.
- Link state lives in PostgreSQL; no in-process state carries it between requests.

**Error Handling**:
- A revoked or unknown link: a neutral "This board is no longer available." The Facilitator issues a
  new link.
- A link whose Round has been deleted: refused, disclosing nothing about whether the Round ever
  existed.
- Issue attempted without authority: refused server-side; the control is not offered.

**Priority**: Must / P0

#### FR8: The projected Board View

**Description**: The big-screen read of one Board, opened on a room machine by its Display Link
without a signed-in session. It shows Categories, their Post-its and their authors' names, updating
near-live as the Facilitator sorts. It is a mirror, never a control surface.

**Acceptance Criteria**:
- [ ] The Board renders read-only from the Display Link alone, with no sign-in and no Workspace
      session created on the room machine.
- [ ] Post-its display their authors' names – that is the surface's purpose.
- [ ] Categories render in the Facilitator's chosen order, each with its Post-its; Uncategorised
      renders alongside them.
- [ ] Placements, Category changes, Discards and restores appear within the near-live window without
      anyone touching the room machine.
- [ ] The surface reaches the Board by polling it on an interval, holding no Membership and using no
      activity cursor – so a revoked or expired link simply stops resolving on the next poll.
- [ ] The surface offers no input at all: no sorting, and no pointer target that changes Board state.
- [ ] A Board with zero Post-its renders as an empty Board with its Categories – a legitimate
      pre-Round state on the big screen.
- [ ] The view works for a Post-it Round in a Presentation as well as in a Workshop.
- [ ] Type size, contrast and Category boundaries are legible at several metres.
- [ ] The view is validated as a distinct fourth viewport class, not as the 1280px layout with a
      larger font.

**Inputs / Outputs**:
- **Inputs**: The Display Link value only.
- **Outputs**: A rendered, self-updating Board – Categories, Uncategorised, Post-its, author names,
  counts.

**Validation**:
- No response reachable from a Display Link contains Vote data, Member data beyond Post-it author
  names, or anything belonging to another Round.
- Discarded Post-its are absent from every projected response.

**Error Handling**:
- Link revoked or invalidated while the screen is open: the Board is replaced by the neutral "This
  board is no longer available." within the near-live window.
- Connectivity lost at the room machine: the last-rendered Board stays on screen with a visible
  staleness indicator, and resumes updating on reconnect. Nothing is written from this surface, so
  there is nothing to reconcile.

**Priority**: Must / P0

#### FR9: The Attendee's live Board

**Description**: The Attendee's own view of the same Board on their phone, re-rendering into
Categories as sorting happens – so someone at the back who cannot read the projector still follows.
One Board, one truth, three renderings.

**Acceptance Criteria**:
- [ ] A Member of the Conference sees the Board organised into the same Categories, in the same
      order, as the projected view.
- [ ] The Attendee's Board re-renders near-live as placements, Category changes and Discards happen.
- [ ] Discarded Post-its disappear from the Attendee's Board, including the Attendee's own – there is
      no "set aside" marker and no notification. An author who wants the idea back writes a new
      Post-it, exactly as they would after deleting one themselves.
- [ ] The Attendee's Board is read-only with respect to placement: no Attendee can place, move or
      discard any Post-it, their own included.
- [ ] The Attendee's Board is validated at 375px, 768px and 1280px with no horizontal body scroll.
- [ ] Contribution, where the Round is still open, continues to work alongside – new Post-its land in
      Uncategorised.

**Inputs / Outputs**:
- **Inputs**: The Attendee's credential and the target Round.
- **Outputs**: The same Board projection – Categories in order, Uncategorised, Post-its with author
  names, counts.

**Validation**:
- Membership is required; a non-Member is refused.
- The response carries no Vote data and no Discard controls.

**Error Handling**:
- Connectivity lost: the last-read Board remains readable with a staleness indicator, consistent with
  the shipped near-live behaviour, and resumes on reconnect. Sorting state is never queued or
  reconciled from this surface.
- Membership revoked mid-Session: access ends; the Attendee's own Post-its remain on the Board and
  remain attributed.

**Priority**: Must / P0

### User Flows

1. **Project and sort** (primary)
   1. The Facilitator opens the Board for a Post-it Round they hold authority on.
   2. They issue a Display Link and open it on the room machine; the Board appears on the big screen,
      read-only.
   3. Post-its arrive in Uncategorised as Attendees contribute.
   4. The Facilitator closes the Round when contribution is done (existing behaviour).
   5. They create Categories, naming each one after what people actually wrote.
   6. They place Post-its into Categories from their own device. Every placement propagates near-live
      to the projected view and to every Attendee's phone.
   7. Uncategorised empties as sorting progresses; its count is the visible measure of what is left.

2. **Sorting before the Round closes** (alternate)
   - Categories are created and Post-its placed while the Round is still open. Contribution continues
     into Uncategorised alongside; both proceed without interfering.

3. **Discard** (alternate)
   1. The Facilitator discards a Post-it from the Board.
   2. It leaves the Board and the projected view and stops counting toward any Category.
   3. It remains restorable until the Conference is archived.

4. **A late offline Post-it** (alternate)
   - A Post-it queued on a phone and synced after sorting has begun – or after the Round closed –
     lands in Uncategorised, visible on every surface, and is sorted like any other. Never
     auto-placed.

5. **Reopening a sorted Round** (alternate)
   - The existing reopen control still applies. Categories and placements survive it untouched; new
     Post-its arrive in Uncategorised.

6. **Restoring a discarded Post-it** (recovery)
   - It returns to Uncategorised, not to whatever Category it was in. The discard decision is undone;
     the sorting decision is not assumed.

7. **Removing an occupied Category** (recovery)
   - Refused until the Facilitator says where its Post-its go; moving them to Uncategorised is the
     default offer.

8. **Revoking a Display Link** (recovery)
   - The room screen stops showing the Board at its next poll. A new link can be issued immediately.

9. **No projector in the room** (degraded)
   - The Board is fully usable without ever issuing a Display Link. Sorting and the Attendee view are
     unaffected; only the big screen is missing.

### UI Wireframes

Not yet produced. Three surfaces need them, and they are genuinely different rather than one layout
rescaled. Route through the `andthen:ui-ux-design` skill in `--mode wireframes` before
implementation:

- **The Facilitator's sorting surface** at 375px, 768px and 1280px. The 375px case is the hard one
  and the one that decides the interaction model.
- **The projected Board View** – a fourth viewport class, read at distance, with no input.
  Wireframing it at the design ceiling (~200 Post-its across ~20 Categories – the Scalability NFR's
  bound, not the ~10 a typical Board holds) is what settles the overflow behaviour left open below.
- **The Attendee's Board** at 375px, showing Categories forming live.
- **The Facilitator's discarded-Post-its surface**, from which a Discard is reversed. Which shape it
  takes – a drawer on the sorting surface, a filter, a separate view – is settled here; that it
  exists is required by FR4.

### Data Requirements

- **Category** – belongs to exactly one Post-it Round's Board. Carries a name and an explicit order,
  and nothing else in this release (see Assumptions). Cascades with its Round.
- **Placement** – a Post-it's Category, or its absence, which *is* Uncategorised. Uncategorised is
  not stored as a Category row; it is the state of having no placement.
- **Discard** – a Facilitator-initiated removal that leaves a trace: who discarded it and when,
  reversible until archival. Stored separately from the author-deletion path, which continues to
  leave no trace (see Dependencies – worth an ADR).
- **Display Link** – an unguessable value scoped to one Round, with issued and revoked state, and an
  effective validity that ends once the Round's Session `day` has passed. Never
  reissued once revoked. Persisted, not held in process.
- **Retention** – Categories, placements and Discard traces live as long as their Conference,
  including after archival, because the Report reads them.
- **Reporting** – the categorised output the Report consumes is: Categories in order, each with its
  Post-its and their authors; plus what remains in Uncategorised; excluding discarded Post-its, whose
  trace remains available to the Report slice to decide on.

## Non-Functional Requirements

| Category | Requirement | Threshold / Target |
|----------|-------------|--------------------|
| Performance | A placement, Category change, Discard or restore reaches the projected view and Attendee phones | Visible within ~5s under normal venue conditions – the standing near-live window; no hard real-time path introduced |
| Performance | A Board read returns its Categories, placements and counts together | One read per Board; no per-Category or per-Post-it request |
| Scalability | A full Board at the design ceiling stays legible and responsive on every surface | Up to ~200 Post-its across ~20 Categories in one Round |
| Scalability | Concurrent sorters on one Board | Two or three, not tens – last write wins per Post-it, no conflict UI |
| Reliability | An accepted placement or Discard is never silently lost | Zero accepted-then-dropped writes; a failed write leaves the Post-it visibly where it was |
| Security | Sorting authority is enforced server-side | Session Assignment on the Round's Session, or conference-wide Admin; never UI-only |
| Security | A Display Link is unguessable | Not derivable from any Conference, Session, Round or Post-it identifier |
| Security | A Display Link is scoped and powerless | Read access to one Board only; no write of any kind; no Vote data reachable; no authority over the Conference |
| Security | Revocation takes effect without user action on the room machine | Within the near-live window, at the next poll |
| Security | A Display Link is time-bounded | Stops resolving once the server's date is past its Round's Session `day` – no link outlives its conference day (ADR-005) |
| Security | A Display Link discloses nothing about why it failed | Revoked, expired, Draft and never-existed all return one neutral message |
| Security | Permanent removal is Admin-only | Enforced server-side; a Session Assignment does not confer it |
| Reliability | The Category cap cannot be raced past | Concurrent creates cannot take a Board beyond 20 Categories |
| Privacy | Vote anonymity is untouched | No surface added here reads, joins to, or exposes Vote data; the ADR-006 guarantee is unaffected because this feature handles only Post-its |
| Accessibility | Sorting is operable without drag-and-drop | Fully keyboard-operable and usable with assistive technology; drag, where offered, is an additional affordance only |
| Accessibility | The projected view is readable at distance | Type size, contrast and Category boundaries hold at several metres |
| Usability | Responsive across the standing three widths | No horizontal body scroll at 375 / 768 / 1280 px on the Facilitator's surface and the Attendee's Board; primary sorting controls reachable one-handed at 375 px |
| Usability | The projected view is validated as its own viewport class | Validated separately at projection scale – not the 1280 px layout with a larger font |
| Portability | Schema uses plain PostgreSQL | No provider-proprietary features (ADR-003) |
| Statelessness | No in-process state between requests | Categories, placements, Discard state and Display Link state all live in PostgreSQL |

## Edge Cases

| Scenario | Expected Behavior | Recovery Path |
|----------|-------------------|---------------|
| A queued Post-it syncs after sorting has finished | Lands in Uncategorised, visible on every surface. Never auto-placed | The Facilitator places it like any other |
| A queued Post-it syncs after its Round closed | Same – the shipped late-arrival behaviour is unchanged by this feature | As above |
| Facilitator removes a Category holding Post-its | Refused until a destination is chosen; moving them to Uncategorised is the default offer | Choose a destination, or cancel |
| Facilitator removes an empty Category | Allowed with no prompt | Recreate it if removed in error |
| Facilitator renames a Category holding Post-its | Allowed. Renaming is cosmetic and never moves anything | Rename again |
| Two Categories given the same name | Allowed but warned. Names are labels, not identifiers; the Report groups by identity | Rename one if the room is confused |
| A Category is created while the Round is still open | Allowed. Contribution continues into Uncategorised alongside | None needed |
| Round is reopened after sorting | Categories and placements survive untouched. New Post-its arrive in Uncategorised | None needed |
| A discarded Post-it is restored | Returns to **Uncategorised**, not to its former Category | Place it again |
| A Post-it is discarded while sitting in a Category | Leaves the Board and the Category; the Category's count drops | Restore it; it returns to Uncategorised |
| The Conference is archived with Post-its still in Uncategorised | Permitted. Uncategorised is a valid terminal state and the categorised output must represent it | None needed |
| A restore is attempted after the Conference is archived | Refused, naming the archived state | None – archival is the boundary |
| Two Facilitators sort the same Board simultaneously | Last write wins per Post-it; both see the other's placements near-live. Placement is small, independent and idempotent – no conflict UI | Re-place if a move was overwritten |
| Display Link opened after its Round is deleted | Refused. Nothing is disclosed about whether the Round ever existed | The Facilitator issues a link for a Round that exists |
| Display Link revoked while the room screen is open | The screen stops showing the Board at its next poll, within the near-live window | Issue a new link and reopen it |
| Board projected with zero Post-its | Shows the empty Board and its Categories – a legitimate pre-Round state | None needed |
| Board projected with more Post-its than fit one screen | **Settled 2026-09-01 (owner decision, during S07); this row is the pre-amendment statement and is superseded in one respect.** Every Category, its name and its count stay visible, the surface never requires input to reveal content, and Post-it detail is still the only thing that degrades. What is no longer true is "before any Post-it becomes unreachable": there is now a **legibility floor** of 0.7 rem, and a region that cannot draw *all* of its Post-its at or above it draws **none** of them and states what it holds instead (`80 post-its – too many to show at this size`). Below the floor the Post-its are absent, not merely small – deliberately, because at ~0.2 px they were unreadable anyway and the tile read as a rendering fault. The binding statement is `docs/wireframes/facilitator-board-and-categorisation/design-decisions.md` → "The projected view's overflow behaviour" → *Amendment – 2026-09-01: the legibility floor* | None – the projection is a read; the Facilitator's own surface always shows everything |
| An Attendee's Membership is revoked mid-Session | Their Post-its remain on the Board and remain attributed. Revocation ends access, not the record | None needed – existing Membership semantics |
| A Category name is blank or whitespace | Refused with a field-level message; the field keeps what was typed | Type a name |
| Placement fails on a network blip | The Post-it returns to where it was, with "Couldn't move that – check your connection." Nothing is queued – sorting is online-only | Retry when the connection returns |
| Sorting attempted without authority | Refused server-side, naming the authority required; the controls were not offered in the first place | Ask an Admin for a Session Assignment |
| Discarding an already-discarded Post-it | Silently succeeds – the end state is the one requested | None needed |
| Placing a Post-it into the Category it is already in | Silently succeeds | None needed |
| Placing a Post-it into a Category on a different Board | Refused | Place it into a Category on its own Board |
| An author deletes their own Post-it while it sits in a Category | Permitted only while the Round is open, per shipped behaviour; it leaves the Category and leaves no trace at all – unlike a Discard | None – author deletion is deliberately irreversible |
| An author opens their Board and their Post-it has been Discarded | It is simply absent, as it is for everyone. No marker, no notification | Write a new Post-it while the Round is open |
| An author's delete arrives while the same Post-it is being Discarded | The delete wins: the row goes and the Discard trace with it. Only reachable as an in-flight race | None – both acts were intended by the people who made them |
| An Admin permanently removes a Post-it | It leaves every surface with no trace and cannot be restored by anyone | None – irreversibility is the point |
| A Facilitator attempts a permanent removal | Refused, naming Admin as the required authority and offering Discard instead | Discard it, or ask an Admin |
| An Admin permanently removes an already-Discarded Post-it | Allowed; the Post-it and its Discard trace both go, and the pending restore disappears | None |
| A Display Link is issued while the Conference is Draft | The link is created and openable, but renders the neutral unavailable page until the Conference is Published | Publish the Conference; the screen starts working on its own |
| A Display Link is opened the day after its Round's Session | Refused with the same neutral message as a revoked link | The Facilitator issues a new link |
| A Display Link is issued for a Session several days out | Valid immediately, and dies after that Session's day rather than on a countdown from issue | None needed |
| Two Facilitators create Categories concurrently at the cap | The server refuses whichever create would exceed 20, naming the current count; the cap cannot be raced past | Remove or merge a Category first |
| Two Facilitators reorder Categories concurrently | Last write wins for the ordering as a whole; both see the result near-live, no conflict UI | Reorder again |

## Constraints & Assumptions

### Constraints

- **Sorting must not require drag-and-drop.** A pointer-only interaction excludes keyboard and
  assistive-technology users and does not survive the 375px case. Drag may be offered as an
  additional affordance on wide viewports; it can never be the only way.
- **The projected screen takes no pointer input.** It is a mirror of Board state, never a control
  surface. Nothing on it may change what the Board holds.
- **A Display Link is a bearer credential over named Post-its.** Because the projection's purpose is
  to display author names, the link discloses attributed content. It must therefore be unguessable,
  revocable, read-only, and scoped to a single Round rather than public.
- **No Workspace session on shared hardware.** The `shared-device-session-lifetime` clarification
  bounds sessions on the assumption that devices are personal phones. A room machine breaks that
  assumption; the Display Link avoids creating a session there rather than extending that spec.
- **Vote anonymity is untouched.** This feature handles Post-its only. No surface it adds may read or
  expose Vote data, and the ADR-006 guarantee is not weakened, restated or relied upon here.
- **Offline support is not widened.** Sorting, discarding and the projected view all require
  connectivity. Offline stays schedule reads plus Post-it queueing (`docs/PRODUCT.md` → Anti-Goals).
- **Facilitator-initiated Discard must not reuse the author-deletion path.** The shipped `post_it`
  migration deliberately carries no tombstone, soft-delete flag or `deleted_at`, because author
  deletion must leave no trace. Discard is a different concept with the opposite requirement; the two
  must stay apart in storage.
- **Plain PostgreSQL only** (ADR-003), and **no in-process state between requests** – both standing
  project rules apply to Category, placement, Discard and Display Link state.
- **REQ-038's clause "the Board's layout is editable during a Session only while the Board holds no
  Post-its" is superseded.** The lock is re-keyed to Category occupancy; see the Decisions Log.
- **Responsiveness is a four-class problem here**, not three: the standing 375 / 768 / 1280 bar
  covers the Facilitator's surface and the Attendee's Board, and the projected view is validated
  separately.

### Assumptions

- **A Category is a name and an order, and nothing else in this release.** No colour, description or
  icon. This is the conservative MVP reading of an open question the clarification left standing;
  adding an attribute later is additive to both the sorting UI and the Report, so nothing is
  foreclosed.
- **A Category name is at most 60 characters**, and a Board holds at most 20 Categories. The
  clarification left both unbounded. 60 is shorter than the shipped Poll-option label limit of 120
  because a Category name is a column header that must stay legible at projection distance; 20 is
  generous headroom over the ~10 the clarification calls realistic, and keeps the projected layout
  bounded. Both are stated so the schema and the UI agree rather than each inventing one.
- **Conference-wide Admin confers sorting authority without a Session Assignment.** The clarification
  left this open; the shipped authority helper already resolves it – an Admin passes session-run
  authority unconditionally on conference-wide authority
  (`api/src/conferences/authorization.ts`). This feature follows that established rule rather than
  inventing a narrower one for Boards.
- **A Board's Post-it volume for one Round is at most a few hundred.** The company is under 100
  employees; ~200 Post-its across ~20 Categories is the design ceiling, not thousands.
- **Concurrent sorting is rare and low-stakes.** Two or three Facilitators at most, each placing
  different Post-its. Last-write-wins per Post-it is sufficient; a conflict UI would cost more than
  it prevents.
- **The room machine has connectivity.** The projected view polls; a room with no network has no
  projection, and the Board remains fully usable on the Facilitator's own device.
- **Whether the Report distinguishes "discarded" from "never contributed" is a Report decision.**
  This feature preserves the trace either way; what Leadership sees is settled by the next slice.

### Open Questions

Neither blocked planning; both were routed rather than assumed. The first is now **closed** – struck through below, with the decision that closed it named rather than the question silently deleted.

- ~~**Projected-view overflow at realistic volume** – paging, scaling down, or Facilitator-driven
  focus. The requirement is stated in Edge Cases (nothing unreachable, no input required, counts
  always visible); the mechanism is settled by wireframing the projected surface at ~200 Post-its,
  which this PRD already routes through `andthen:ui-ux-design --mode wireframes` before
  implementation.~~
  **CLOSED.** Settled by wireframing on 2026-08-30 as routed
  (`docs/wireframes/facilitator-board-and-categorisation/design-decisions.md` → "The projected view's
  overflow behaviour": no overflow mechanism at all – the Category grid is sized to the number of
  regions and Post-it detail alone degrades, across three tiers), then **amended by owner decision on
  2026-09-01** with a 0.7 rem legibility floor under the tiers, after S07 found an in-ceiling but
  skewed Board drawing Post-its at about a fifth of a pixel. Paging, auto-cycling and
  Facilitator-driven focus were all considered and refused, with reasons recorded at the same anchor.
  See also the amended Edge Cases row above.
- **Whether conference-wide Admin should override Session Assignment generally** – a project-wide
  question larger than this feature. This PRD follows the shipped precedent rather than deciding it.

### Dependencies

| Dependency | Why It Matters |
|------------|----------------|
| Shipped `session-activities` slice (S01–S05) | Supplies the Post-it Round, the Board, and the named Post-its this feature sorts. Done, verified, committed |
| `post_it` table has no Category, position, or tombstone column | All categorisation and Discard storage is new. The restorable Discard **contradicts a deliberate shipped decision** – the migration comment states there is intentionally "no tombstone, soft-delete flag or `deleted_at`" because removal must leave no trace. That decision was made for contributor-initiated removal; Facilitator Discard is a distinct concept, and the spec must keep the two paths apart rather than relax the shipped one. **Worth an ADR** |
| Shipped late-arrival behaviour (`20260830090000000_post-it-late-arrival.sql`) | Determines what happens to a Post-it syncing after close; Uncategorised was chosen to accommodate it |
| `activity_watermark` near-live cursor | Propagates placements, Category changes, Discards and removals to **Member-gated surfaces** – the Facilitator's own surface and the Attendee's Board. The mechanism exists and already covers Post-it writes; confirm a Category or placement change advances it, and that ADR-007's Vote-arrival rule is unaffected. It does **not** serve the projected view: `api/src/routes/rounds.ts:804` is Session-scoped and Membership-gated, and `rounds.ts:43-48` records that a per-Round cursor was deliberately removed |
| Shipped author-delete path (`api/src/rounds/post-it-repository.ts:537`) | A hard `delete from post_it`, gated on `author_sub` and `r.state = 'open'`, with no Discard-awareness. The spec must confirm the Discard trace's foreign key cascades rather than orphaning when a delete wins the race |
| Conference lifecycle `isDraft` gating (`api/src/routes/rounds.ts:594`, `:688`) | Every shipped Session and contribution read re-gates Draft content behind a `PresenterFacilitator` role. An anonymous Display Link holds no role, so the Draft rule is a **new** gate on a new route, not a reuse of the existing helper |
| `sessions.day` is a wall-clock `date`; no timezone is stored anywhere | The Display Link's expiry is expressed against it. The boundary drifts by up to a day with server locale – accepted deliberately rather than adding a timezone column to the schedule's wall-clock design |
| `docs/adrs/ADR-005-bound-access-by-time-not-by-refusal-code.md` | The reasoning the link's time bound follows: access that ends only when somebody remembers to revoke it does not end. Cite it rather than re-deriving |
| Admin role (`role_assignment`, `ROLE_RANK.Admin`) | Gates permanent removal. The role and its rank check already exist |
| Session Assignment (S01) and the shipped authority helper | Authorises sorting and discarding, including the Admin-passes-unconditionally rule this PRD adopts |
| Conference archival (S03 lifecycle) | Bounds the Discard undo window and the writability of every surface here |
| `post_it_delivery` (`20260901090000000_post-it-delivery-record.sql`) | **The shipped precedent for the storage question above.** That table keeps a fact *about* a Post-it outside the `post_it` row expressly so it "outlives" the row. Facilitator Discard needs the same shape, so the ADR has an accepted pattern to reason from rather than a blank page |
| S05 contribution-safe Session deletion (`post-it-repository.ts#countPostItsForSession`) | Counts every Post-it row for a Session with no state condition. Whether a discarded Post-it still counts as a contribution – and so still blocks Session deletion – must be decided here; the delivery-record story chose the opposite for withdrawal |
| `docs/UBIQUITOUS_LANGUAGE.md` | Already updated 2026-08-30 – `Category` widened into Participation → Insight and bound to one Board; `Board View` no longer Workshop-only; `Uncategorised` and `Display Link` registered; `Discard` sharpened. The vocabulary this PRD uses is the registered one |
| `andthen:ui-ux-design --mode wireframes` | Three genuinely different surfaces need wireframes before implementation; the projected surface at realistic volume settles the overflow question |
| The Report slice (REQ-023, REQ-024) | Consumes this feature's output. Nothing inbound – but the categorised shape decided here constrains what the Report can say |

## Decisions Log

| Decision | Rationale | Alternatives Considered |
|----------|-----------|-------------------------|
| Categorisation is one continuous activity on one Board, not two phases on two surfaces | `docs/PRODUCT.md` already recorded (2026-08-16) that sorting is a group activity visible to the room. REQ-015 describes the same Board at a later moment, not a second surface. Resolves the REQ-015 vs REQ-031/REQ-038 contradiction | Two distinct phases – contribute, then a separate sorting pass; sorting permitted only after the Round closes |
| Only the Facilitator/Organizer places a Post-it | Pre-existing buckets anchor contributors' thinking mid-brainstorm, and sorting is deliberately the group conversation. Rejected as a concept, recorded in `docs/OUT-OF-SCOPE.md` | Contributor chooses at compose time; both, with the contributor suggesting and the Facilitator overriding |
| **REQ-038's empty-Board layout lock is superseded**; the lock is keyed on Category occupancy, not Board occupancy | The Board-level lock was load-bearing only under contributor-chooses placement, which was declined. Kept as written it would forbid creating any Category once the first Post-it landed – making the intended affinity-mapping flow impossible | Keep the Board-level lock as REQ-038 stated; no lock at all; require Categories to be defined before the Round opens |
| Rename and reorder are always permitted, including on an occupied Category | A typo in a Category name must be fixable in front of the room. Renaming moves nothing, so it disrupts nothing | Freeze names once a Category holds Post-its |
| Uncategorised is an implicit holding area, not a Category | Guarantees a destination that always exists and is never "done" – required because sorting may start before the Round closes and a queued Post-it may sync after it finishes. Its count is the Facilitator's progress indicator | Every Post-it must be in a real Category; a nullable category with no holding area rendered |
| Categories belong to one Board; there is no conference-level set | Closes `docs/PRODUCT.md`'s 2026-08-16 open question. No second definition site, no inheritance semantics, no propagation question | Conference-level defaults with per-Board override (**rejected**, `docs/OUT-OF-SCOPE.md`); per-Board plus copy-from-another-Board (**deferred**) |
| Discard is in scope, leaves a trace, and is restorable until archival | The glossary already defines Discard as distinct from never having existed. An irreversible misdrag in front of the room destroys a named colleague's idea | Hard removal; deferring Discard entirely to the Report slice |
| A restored Post-it returns to Uncategorised, not to its former Category | The discard decision is undone; the sorting decision is not assumed on the Facilitator's behalf | Restore to the Category it was in |
| The undo window runs until the Conference is archived | Uses a lifecycle state that already exists rather than inventing a timer; a mistake found the next morning is still fixable. Archival is where the Conference stops changing | Immediate undo only; permanently restorable (would make an archived Conference mutable) |
| The projection uses an unauthenticated, unguessable, revocable per-Round Display Link | Keeps a personal Google Workspace session off shared room hardware – the case `shared-device-session-lifetime` assumed away – while granting no authority beyond reading one Board | Facilitator signs in on the room machine; mirroring the Facilitator's own device |
| The Display Link dies once the Round's Session day has passed; revocable earlier, reissuable | ADR-005 bounds ended access by time rather than trusting that someone revokes – otherwise this is the only unbounded credential in confApp, and its secret sits in the address bar of a machine facing a room. Binding to the Session's own `day` cannot fire mid-activity, unlike a rolling timer | No expiry at all (the original position); a rolling 18h window from issue; a calendar day in a stored conference timezone – rejected because confApp deliberately stores no timezone (`sessions.day` is wall-clock `date`), and adding one widens the schedule's design |
| The projected surface polls the whole Board; no cursor is added for it | The shipped cursor (`rounds.ts:804`) is Session-scoped and Membership-gated, so an anonymous holder cannot reach it, and `rounds.ts:43-48` records that a per-Round cursor was deliberately removed. Polling keeps that decision intact and makes revocation land for free – the poll simply stops resolving | An anonymous Round-scoped watermark endpoint; requiring the room machine to sign in and reuse the Member cursor (reverses D8) |
| A Discarded Post-it is hidden from its author too | One rule for the Board on every surface. An author who regrets a removal writes a new Post-it – already how author deletion behaves | Visible to its author marked "set aside"; visible to the author only after the Round closes |
| An author delete racing a Discard wins, taking the Discard trace with it | The author's control over their own words is the stronger claim, and the window is narrow – it needs the Round open and sorting already begun. Stated so the API has a defined outcome, not so the UI offers it | Refusing the author's delete once a Post-it is Discarded |
| A Display Link is issuable while the Conference is Draft, but renders nothing until Published | Lets a Facilitator set the room up ahead of time without an anonymous read of an unannounced internal event – the exposure ADR-005 names in its own context section | Refusing issuance until Published; rendering the Board in Draft |
| Admin-only permanent removal is in scope | Closes REQ-016's "delete **or** discard" rather than half-delivering it. Discard cannot serve as the moderation path: it keeps abusive or confidential content stored and restorable by any Facilitator, indefinitely | Leaving hard removal out of scope and recording it as a known gap; treating Discard as sufficient for REQ-016 |
| The Category cap is a server-side invariant; reorder is last-write-wins | The 20-Category cap is user-visible, so racing creates must not bypass it. Reorder reuses the placement concurrency story rather than inventing a second one | Serializing Category writes per Board; leaving concurrency entirely to the spec stage |
| The projected view is read-only; the Facilitator's own device is the only control surface | Satisfies the 375px rule without phone drag-and-drop, and needs no pointer input on a TV | Drag on desktop/tablet with a picker on phone; treating sorting as a laptop-class task with phone read-only (would need an `AGENTS.md` exception) |
| Attendees see the same Board re-rendering into Categories, near-live | Someone at the back who cannot read the projector follows on their phone. One Board, one truth | A flat chronological list for Attendees (two truths about one Board); Categories revealed only after the Round closes |
| Board View covers any Post-it Round, in either Session kind | REQ-010 puts Post-it Rounds in both kinds; a presenter collecting reactions wants the room to see them too. The glossary's Workshop-only wording was corrected | Workshops only; any Post-it Round plus revealed Poll tallies (widens into Voting Round scope) |
| "Category" remains the domain term; "column" describes layout only | Preserves the glossary's `Avoid` entry and PRODUCT.md's "categorized output" vocabulary, which the Report will inherit | Rename to Column throughout; keep both as deliberately distinguished terms (a synonym pair is exactly what the glossary prevents) |
| Sorting is online-only; a failed placement is surfaced, not queued | `docs/PRODUCT.md` → Anti-Goals. Offline stays schedule reads plus Post-it queueing; a queued placement would need conflict resolution this project has ruled out | Queue placements offline and reconcile on reconnect |
| Concurrent sorting is last-write-wins per Post-it, with no conflict UI | Placement is a small, independent, idempotent change, and both Facilitators see each other near-live. A conflict UI would cost more than the collisions it prevents | Locking a Post-it during placement; presenting a merge prompt |
| A Category carries a name and an order only | Conservative MVP reading of an open question the clarification left standing. Colour or description is additive later, to both the sorting UI and the Report, so nothing is foreclosed | Colour-coded Categories; Categories with descriptions |
| Category name at most 60 characters; at most 20 Categories per Board | Both were unbounded. 60 is below the shipped Poll-option limit of 120 because the name is a column header read at projection distance; 20 gives headroom over the ~10 called realistic while keeping the projected layout bounded | Leave unbounded; reuse the 120-character label limit |
| Conference-wide Admin confers sorting authority without a Session Assignment | Follows the shipped authority rule rather than inventing a narrower one for Boards. Whether Admin should override Session Assignment generally is a larger, still-open project question | Require a Session Assignment of everyone, Admins included |
