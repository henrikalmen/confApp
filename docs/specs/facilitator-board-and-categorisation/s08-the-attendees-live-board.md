# S08 – The Attendee's live Board

**Plan**: docs/specs/facilitator-board-and-categorisation/plan.json
**Story-ID**: S08

## Feature Overview and Goal

**Intent**: Someone at the back of the room cannot read the projector, so the sorting that decides which of their colleagues' ideas the Report carries happens where they cannot follow it – this story puts the same Board, in the same arrangement, on their own phone, without giving them a single lever on it.

**Expected Outcomes**

- [OC01] A Member of the Conference reads the Board organised into the same Categories, in the same order, as every other surface, and it re-renders within the near-live window as placements, Category changes, Discards, restores and permanent removals happen – through the one Board read and the one shipped activity cursor, with no second shape and no second cadence.
- [OC02] The Attendee's Board is read-only with respect to placement **at the API and not only in the UI**: a Member without sorting authority cannot place, move or discard any Post-it, their own included; the surface offers no such control, carries no Vote data, and a non-Member is refused the read outright.
- [OC03] Contribution keeps working alongside while the Round is open, and a Post-it that arrives late – drained from the device after sorting began, or after the Round closed – lands in **Uncategorised** and is never auto-placed.
- [OC04] Losing the connection leaves the last-read Board on screen with an honest age beside it and resumes on reconnect, with nothing from this surface queued, deferred or reconciled.


## Required Context

- `docs/specs/facilitator-board-and-categorisation/prd.md#fr9-the-attendees-live-board` – the six acceptance criteria, the validation rules (Membership required, no Vote data, no Discard controls) and the two error-handling rules (connectivity loss with a staleness indicator; Membership revoked mid-Session) this FIS implements in full.
- `docs/specs/facilitator-board-and-categorisation/prd.md#user-stories` – **US08** (my phone shows the Board taking shape, because the projector is unreadable from the back) and **US09** (a late-syncing Post-it arrives somewhere visible and is never silently absorbed) are this story's two user-facing claims.
- `docs/specs/facilitator-board-and-categorisation/prd.md#edge-cases` – the rows this story owns on the Attendee's surface: a queued Post-it syncing after sorting finished and after its Round closed *(lands in Uncategorised, never auto-placed)*; an author opening their Board to find their Post-it Discarded *(simply absent – no marker, no notification)*; an Admin's permanent removal *(leaves every surface with no trace)*; a restored Post-it returning to Uncategorised; and an Attendee's Membership revoked mid-Session *(their Post-its remain on the Board and remain attributed)*.
- `docs/specs/facilitator-board-and-categorisation/prd.md#non-functional-requirements` – the rows this story is measured by: the ~5s propagation window to Attendee phones, one read per Board with no per-Category request, the design ceiling of ~200 Post-its across ~20 Categories, no horizontal body scroll at 375 / 768 / 1280 px on the Attendee's Board, and **Binding Constraint FR8**, applied unnarrowed: *"Vote anonymity is untouched | No surface added here reads, joins to, or exposes Vote data; the ADR-006 guarantee is unaffected because this feature handles only Post-its"*.
- `docs/specs/facilitator-board-and-categorisation/prd.md#constraints` – **Binding Constraint FR3**, the defining one here, applied unnarrowed: *"Offline support is not widened. Sorting, discarding and the projected view all require connectivity. Offline stays schedule reads plus Post-it queueing (`docs/PRODUCT.md` -> Anti-Goals)."* Also binding: (FR1) *"Plain PostgreSQL only (ADR-003), and no in-process state between requests"* – this story adds neither schema nor server state and must keep it that way.
- `docs/specs/facilitator-board-and-categorisation/plan.json#sharedDecisions` – four decisions **consumed, never re-derived**: S02's *Board read projection contract* (`categories` in the Facilitator's order with their Post-its and counts, `uncategorised` always present carrying no `id`, `name` or `position` – this surface reads that shape and adds no Attendee-specific one); S02's *sorting-authority gate* (which is what makes this surface read-only at the API); S05's *Discard state stored outside the post_it row* and its read-exclusion rule; and *Board writes advance the activity watermark* (this surface rides that cursor and adds no second polling mechanism).
- `docs/specs/facilitator-board-and-categorisation/s02-categories-uncategorised-and-sorting-authority.md#technical-overview` – the authoritative statement of the wire shape this surface renders and of the watermark advance it rides. Read it for the concrete field names before touching the Board component; do not restate or extend the contract here.
- `docs/specs/facilitator-board-and-categorisation/s05-discard-and-restore.md#technical-overview` – the authoritative read-exclusion rule: a Post-it with a Discard trace is excluded **by anti-join in the statement itself**, from every read that returns Post-its, *including its own author's*. This story renders the result and adds no client-side filtering that would be a second, weaker copy of it.
- `docs/specs/facilitator-board-and-categorisation/s03-placing-post-its-into-categories.md#architecture-decision` – the placement route this surface must be refused by (`PATCH …/rounds/:roundId/post-its/:postItId/placement` under S02's authority gate), and how it is deliberately *separate* from the shipped `PATCH …/post-its/:postItId` text edit that an author does hold. That separation is exactly what makes "read-only with respect to placement, their own included" expressible.
- `web/src/activities/SessionActivitiesPanel.tsx#Board` – the shipped Attendee-facing Board this story extends, and the three disciplines it already holds: authority is the server's answer (`canRun`, `mine`) and is never re-derived on the client; the payload is replaced wholesale, never merged; refusals and typed text live in the panel above the subtree a board refresh replaces.
- `web/src/poll/use-watermark-poll.ts` – the one cadence in this application. An Attendee is already on its compare-then-refetch branch; this story adds call sites at most, and no interval, timer or cursor of its own.
- `web/src/offline/post-it-queue.ts` and `web/src/offline/use-post-it-queue.ts#mayStillBeDelivered` – the shipped contribution queue, which is the **whole** of this surface's offline scope. Read them to know exactly what must stay reachable (contribution) and what must stay unreachable (everything else).
- `docs/wireframes/facilitator-board-and-categorisation/attendee-board.html` – produced by **S01**, which the plan's shared decisions make the source of the interaction model for this story too. The Attendee Board wireframes at 375, 768 and 1280 px settle how Categories, their counts and Uncategorised are arranged on a phone, and where a pending Post-it sits. Take the layout from there; do not invent one.
- `docs/UBIQUITOUS_LANGUAGE.md` – **Board**, **Category**, **Uncategorised**, **Attendee**, **Discard**. "Inbox", "unsorted category", "default column", "backlog", "column", "bucket" and "swimlane" are named synonyms to avoid in component names, testids, CSS classes and copy.


## Deeper Context

- `web/src/attendee/staleness.ts#stalenessLabel` and `web/src/offline/cached-age.ts#cachedScheduleLabel` – the shipped age vocabulary ("Updated just now", "Updated 4 minutes ago") and the reasoning this story reuses: an elapsed age is always a difference of two readings of the *same* clock, so no timezone and no instant conversion appears anywhere in it.
- `web/src/tick/foreground-tick.ts#onForegroundTick` – how a second consumer hangs off the one loop's tick without owning a timer. The staleness label needs a periodic re-render precisely when no read is succeeding, which is when nothing else re-renders.
- `api/src/routes/rounds.ts#registerRoundRoutes` – the Session read's `requireMembership` gate (asserted here, not changed), `authorizeWrite` (the gate that refuses this surface), and `toPostItWire`, which publishes `authorName` and `mine` and never an author `sub`.
- `visual/session-activities.spec.ts` – the shipped three-width pattern, including the existing "the attendee's read-only round list stays legible at …" capture and its `horizontalOverflow` / `assertWithinViewport` helpers.
- `web/test/PostItBoard.test.tsx` – the shipped board tests: keep-on-failure, the 403 that replaces the board, own-vs-others' controls, and the fake-timer poll harness.
- `docs/LEARNINGS.md` – **Testing** (a regression test written beside its fix usually passes without the fix; never wait on the value you are about to assert; a file-list grep is only as good as its longest omission), **React State & Refusals** (a refusal rendered inside a subtree its own handler unmounts is lost), **CSS / Responsive Layout** (measure an element's own `scrollWidth`, not the page's), and **Offline** (`navigator.onLine` reports the link, not reachability).
- `docs/adrs/ADR-006-vote-anonymity-holds-against-application-paths-not-database-credentials.md` – the guarantee this surface must leave untouched. It renders Post-its only.


## Acceptance Scenarios

- [x] **S01 [OC01] [TI01,TI02] Bo's phone shows the same Categories in the same order as the room's screen, and follows the sorting without a reload**
  - **Given** Bo is a Member with no Session Assignment and no Admin, reading a Post-it Round's Board with Categories "Tooling", "Handovers" and "Onboarding" in that order, four Post-its placed and six still in Uncategorised
  - **When** the Facilitator places two of the Uncategorised Post-its into "Handovers" and reorders "Onboarding" above "Handovers"
  - **Then** within one poll interval Bo's Board shows the three Categories in the Facilitator's new order, each Post-it under its author's name, "Handovers" reporting the server's count and Uncategorised reporting four – and Bo's device issued no request beyond the shared loop's own tick and the one Board read that tick prompted

- [x] **S02 [OC02] [TI02,TI03] Bo cannot place, move or discard anything – Bo's own Post-it included – and was offered no way to try**
  - **Given** Bo is a Member with no sorting authority, and one of the Post-its on the Board is Bo's own, sitting in "Tooling", on an open Round
  - **When** Bo's Board is rendered, and Bo then issues a placement and a Discard directly at the API against that Post-it
  - **Then** no placement, move, Discard or restore control is rendered anywhere on Bo's Board – on Bo's own Post-it or on anyone else's – and both API calls are refused naming the authority required, with the stored placement and Discard state unchanged after each; the shipped **Correct** and **Remove** controls on Bo's own Post-it while the Round is open are unaffected, because an author's text edit and deletion are not placement

- [x] **S03 [OC01] [TI04] Ada's own Discarded Post-it is simply absent from Ada's Board, and so is a permanently removed one**
  - **Given** Ada is a Member reading the Board on her phone, and her Post-it "we need a staging box" sits in "Tooling"
  - **When** the Facilitator Discards it, and separately an Admin permanently removes a second Post-it of Ada's
  - **Then** within one poll interval both are gone from Ada's Board with no "set aside" marker, no notification and no placeholder, "Tooling" reports one fewer, and nothing on the payload Ada received says either Post-it ever existed
  - **And** when the Facilitator restores the Discarded one it reappears on Ada's Board in **Uncategorised**, not in "Tooling"

- [x] **S04 [OC03] [TI01,TI05] A Post-it typed on a dead connection drains into Uncategorised long after sorting began, and is never auto-placed**
  - **Given** Cleo typed a Post-it while the venue wifi was dead, so it is held on her device and rendered pending under her name, and the Facilitator has since sorted every other Post-it out of Uncategorised into Categories
  - **When** the connection returns and the shipped queue drains it – whether the Round is still open or has since closed
  - **Then** it appears on every Board in **Uncategorised** and in no Category, Uncategorised's count rises by one, no Category's count changes, and the pending copy leaves Cleo's device; while it was still pending it was rendered inside Uncategorised, which is where it was always going to land

- [x] **S05 [OC04] [TI06,TI08] The connection drops mid-sort: the Board Bo is reading stays, ages honestly, and resumes – with nothing queued**
  - **Given** Bo's Board has just re-read successfully and the room is still sorting
  - **When** Bo's connection dies for four minutes and then returns
  - **Then** the Board Bo was reading stays on screen throughout – never replaced by an error box – with an age beside it advancing from "Updated just now" to "Updated 4 minutes ago" while nothing is arriving; on reconnect the next poll replaces the Board with the current arrangement and the age returns to "Updated just now"; and the device's queue store holds exactly what it held before, because nothing on this surface was queued, deferred or reconciled

- [x] **S06 [OC02] [TI07] Membership ends access and nothing else; a non-Member never had it**
  - **Given** Ada is reading the Board with two of her own Post-its on it, one in "Tooling" and one in Uncategorised
  - **When** an Admin revokes Ada's Membership of the Conference while she has the Session open, and separately a signed-in employee who never joined the Conference requests the same Session read
  - **Then** Ada's next poll is refused and the Board is replaced by that refusal rather than left rendering as live data; her two Post-its stay exactly where they are on every other Member's Board, still under her name; and the non-Member's read is refused with the shipped Membership sentence, disclosing nothing about whether that Conference or Session exists


## Structural Criteria

- [x] No response reachable from the Attendee's Board, and no module on its path, reads, joins to or exposes Vote data; the ADR-006 guarantee is untouched.
- [x] The Attendee's Board consumes S02's `categories` / `uncategorised` projection and adds no second shape: nothing under `web/` groups, sorts, counts or re-derives placement from a flat list, and no Attendee-specific Board read, route or payload key exists.
- [x] Discarded and permanently removed Post-its are excluded by the server's own statement; there is no client-side filter, no `discarded` flag on the Post-it wire shape, and no Attendee-visible field from which a Post-it's removal could be inferred.
- [x] `web/src/poll/use-watermark-poll.ts` remains the only cadence in the application: this story adds no interval, no timer, no second cursor and no second poll loop, and the staleness label re-renders off the shared foreground tick.
- [x] Offline scope is unwidened: the only thing this surface defers is a Post-it contribution through the shipped queue. No placement, Discard, restore, Category or Board-arrangement state is written to the queue store, to the shipped schedule cache, or to any new outbox or replay buffer.
- [x] The shipped `requireMembership` gate on the Session read and the shipped `authorizeWrite` gate on every Board write are unchanged and unweakened; this story adds no authority path and no Attendee-specific bypass.
- [x] The Attendee's Board renders without horizontal overflow at ~375, ~768 and ~1280 px at the design ceiling of ~200 Post-its across ~20 Categories, measured on each element's own `scrollWidth` rather than the page's.


## Scope & Boundaries

### Work Areas

- `web/src/activities/SessionActivitiesPanel.tsx` – the Attendee rendering of the grouped Board, pending Post-its rendered inside Uncategorised, the control gating that offers nothing without the server's `canRun`, and the staleness indicator.
- `web/src/attendee/staleness.ts` and `web/src/tick/foreground-tick.ts` – the shipped age vocabulary and the shipped tick seam, reused rather than reimplemented.
- `api/src/routes/rounds.ts` – asserted rather than changed: the Membership gate on the Session read and the sorting-authority gate on every Board write.
- `web/test/PostItBoard.test.tsx` and `web/test/SessionActivitiesPanel.test.tsx` – the Attendee-side behaviour: grouping, near-live re-render, absent Post-its, pending placement, staleness, revocation.
- `api/test/post-it-structure.test.ts` and `api/test/post-it.integration.test.ts` – the read-only, offline-scope and Vote-anonymity guards, and the real-PostgreSQL refusals.
- `visual/session-activities.spec.ts` – the shipped attendee three-width capture, extended to the grouped Board at the design ceiling.

### What We're NOT Doing

- **The projected Board View** – S07's, including its Display Link, its fourth viewport class and its no-cursor polling. Both surfaces read the same Board; only this one is Membership-gated and rides the activity watermark.
- **Every sorting control** – Category create, rename, reorder and remove (S02), placement (S03), Discard and restore (S05) and permanent removal (S06) are built and gated by those stories. This story proves an Attendee reaches none of them and builds none of them.
- **Any change to the Board read, its exclusion rule or the authority gate** – S02 and S05 own those and are the authoritative statement of them. A change that seems needed here is a defect in this story's reading of them, not a second opinion.
- **Widening offline beyond the shipped Post-it queue** – no Board arrangement is cached for offline reading and no placement is deferred. Reading the Board requires connectivity; only the last successful read stays on screen (Binding Constraint FR3).
- **A notification, digest or "your Post-it was set aside" signal of any kind** – the PRD decided a Discard is silent to its author, and adding one here would be a second, contradictory answer.


## Architecture Decision

**Approach**: The Attendee's Board is the *same* component reading the *same* single Board projection as the Facilitator's – what differs is only what the server already answers (`canRun` for the sorting controls, `mine` for the author's own text edit), so read-only-with-respect-to-placement is enforced by S02's `authorizeWrite` gate on routes an Attendee simply never reaches, and this story's job is to prove that rather than to add a check. The one thing genuinely built here is the staleness indicator, anchored on the device's own reading of when the server **last answered about this Session** – the watermark poll counts, not only the Board read it sometimes provokes – and refreshed off the shared foreground tick.
**Why this over alternatives**: An Attendee-specific read or Board component would be a second definition of what the Board holds, and the first sorting change would be the one it got wrong; and the activity watermark cannot anchor the age because it is a deliberately opaque counter, not an instant (ADR-007) – the only honest age available on the device is the difference between two readings of its own clock, which is exactly what `web/src/offline/cached-age.ts` already established.


## Code Patterns & External References

```
# type | path#anchor                                              | why needed (intent)
file   | web/src/activities/SessionActivitiesPanel.tsx#Board       | The surface being extended – board rendering, held-item list, canRun/mine gating, refusal placement
file   | web/src/activities/SessionActivitiesPanel.tsx#load        | The shipped access-answered vs keep-on-failure split the staleness work must not blur
file   | web/src/offline/cached-age.ts#cachedScheduleLabel         | Exact shape for a device-elapsed age: two readings of one clock, no instant conversion, clamped
file   | web/src/tick/foreground-tick.ts#onForegroundTick          | How a second consumer gets a periodic nudge without owning a timer or a cadence
file   | api/src/routes/rounds.ts#registerRoundRoutes              | The Session read's Membership gate and `authorizeWrite` – both asserted here, neither changed
file   | api/test/post-it-structure.test.ts                        | Structural-guard shape, and the shipped "widens offline support by nothing at all" block
file   | api/test/post-it.integration.test.ts                      | Real-PostgreSQL harness and the assert-the-stored-row discipline the refusal tests need
file   | visual/session-activities.spec.ts                         | The three-width capture pattern, its attendee stub and its overflow helpers
wire   | docs/wireframes/facilitator-board-and-categorisation/attendee-board.html | S01's Attendee Board layout at 375, 768 and 1280 px – take it from there, do not invent one
```


## Constraints & Gotchas

- **Critical**: the pending-Post-it list currently renders *below* the whole board, outside any grouping. Under the grouped shape it must render **inside Uncategorised**, because that is where the item lands – but it stays device-local and must never be counted into the server's `postItCount`, which would make the count a client-side derivation and disagree with every other surface.
- **Avoid**: rendering the staleness label only once a poll has failed – Instead: derive it from the timestamp of the last *successful exchange with the server about this Session* – the watermark poll as much as the Board read – so there is one fact behind it and no failure-tracking state to drift out of step. `navigator.onLine` decides nothing here; whether a request succeeded is the only signal (`docs/LEARNINGS.md#offline`).
- **Critical**: the anchor is the **exchange**, not the payload replacement (owner decision, 2026-09-02). An Attendee's tick is a two-scalar watermark poll and the Board is re-read only when that cursor has moved, so an anchor on the read makes a quiet room age exactly as an outage does and the indicator cries outage during normal operation. Advancing it whenever the poll answers adds no request and no second cadence, and makes the age mean what a reader takes it to mean: *we are still in touch with the server*.
- **Critical**: the label ages while nothing is arriving, which is exactly when nothing re-renders the panel. Subscribe to `web/src/tick/foreground-tick.ts#onForegroundTick` – never a `setInterval`, which would be the second cadence the shared decision forbids.
- **Constraint**: `SessionActivitiesPanel` already distinguishes a 403/404 (the server answering about *this caller's access*, which replaces the Board) from any other failure (which keeps it). Membership revocation must land on the first path and a dead connection on the second – that distinction is shipped and must not be blurred by the staleness work.
- **Avoid**: gating a sorting control on anything the client computes – Instead: `canRun` off the payload, exactly as the shipped run controls do. A second client-side opinion about authority is the failure mode `SessionActivitiesPanel`'s own module note names.
- **Constraint**: terminology follows `docs/UBIQUITOUS_LANGUAGE.md` in component names, testids, CSS classes and copy – the Uncategorised region is never "inbox", "backlog", "unsorted" or "default column", on this surface or in its tests.


## Implementation Plan

### Implementation Tasks

- [x] **TI01** The Attendee's Board renders S02's grouped projection, with a pending Post-it shown inside Uncategorised
  - `web/src/activities/SessionActivitiesPanel.tsx#Board` consumes `categories` and `uncategorised` from the payload; counts come from the payload and never from `postIts.length`; Uncategorised renders even when empty and when the Board has no Categories; a held item from `web/src/offline/use-post-it-queue.ts` renders inside the Uncategorised region and is excluded from the server's count.
  - **Verify**: `Test: a Board payload with two Categories and one Uncategorised Post-it renders both Categories in payload order with their server-supplied counts, one Uncategorised region, and a pending held item inside that region without changing its reported count`

- [x] **TI02** No placement, move, Discard or restore control is reachable on a Board the server did not answer `canRun` for
  - Gated on the payload's `canRun`, as the shipped run controls are – never on `mine`, a role guess or a client-side comparison. The author's shipped **Correct** and **Remove** controls on their own Post-it while the Round is open are untouched: they are not placement.
  - **Verify**: `Test: with canRun false the rendered Board offers no placement, move, discard or restore control on any Post-it including the viewer's own, while Correct and Remove still appear on the viewer's own Post-it on an open Round`

- [x] **TI03** A Member without sorting authority is refused every Board write at the API, on their own Post-it as much as anyone else's
  - Asserted against the shipped gate (`api/src/routes/rounds.ts#authorizeWrite`) that S03's placement route and S05's Discard and restore routes reuse – no new check and no Attendee-specific branch. Real PostgreSQL, following `api/test/post-it.integration.test.ts`, asserting the stored row and never the envelope alone.
  - **Verify**: `Test: a Member with neither a Session Assignment nor Admin is refused placement, Discard and restore against a Post-it they authored themselves, each refusal names the authority required, and that Post-it's stored placement and Discard state are unchanged after all three`

- [x] **TI04** A Discarded or permanently removed Post-it is absent from the Attendee's Board, its own author's included, with nothing left in its place
  - The exclusion is S05's anti-join in the read statement; this task proves it reaches this surface and adds no client-side filter. A restore returns the Post-it to Uncategorised, which follows from S02's absence-is-Uncategorised rule rather than from anything remembered here.
  - **Verify**: `Test: after a Discard the author's own Session read carries no entry for that Post-it under any Category or Uncategorised and no marker, flag or placeholder for it; after a restore it appears under Uncategorised; after a permanent removal it is absent with no trace on any later read`

- [x] **TI05** A late-arriving Post-it lands in Uncategorised and is never auto-placed
  - The shipped contribution path writes no placement, so Uncategorised follows structurally (S02); this task proves it for a queued item draining after sorting began and for one arriving after its Round closed, and that the shipped `arrivedAfterClose` marker still renders. Depends on TI01 for where a pending item is shown.
  - **Verify**: `Test: a queued Post-it drained after every other Post-it has been placed appears in Uncategorised and in no Category, Uncategorised's count rises by one, no Category count changes, and the same holds when the Round closed before the drain`

- [x] **TI06** The Attendee's Board carries an honest age that advances while nothing is arriving and resets on the next successful exchange
  - Anchored on the device's `Date.now()` at the last successful **exchange with the server about this Session** – the watermark poll and the Board read alike – and rendered through `web/src/attendee/staleness.ts#stalenessLabel`; re-rendered by subscribing to `web/src/tick/foreground-tick.ts#onForegroundTick`, never a timer of its own. The watermark's *value* is an opaque counter and is not the anchor; what anchors the age is that the poll for it was answered.
  - **Verify**: `Test: with reads failing, the Board stays rendered and its age advances from "Updated just now" through "Updated 4 minutes ago" on the shared tick; the next successful read returns it to "Updated just now"; a healthy connection whose watermark keeps answering while the cursor never moves stays at "Updated just now"; and this surface creates no setInterval or setTimeout`

- [x] **TI07** Membership revocation ends access to the Board and touches neither the Attendee's Post-its nor their attribution
  - The shipped 403/404-replaces-the-board branch in `web/src/activities/SessionActivitiesPanel.tsx#load` is the path; a dead connection must keep taking the other one. Depends on TI06 – the staleness work must not blur that distinction.
  - **Verify**: `Test: a poll refused with 403 replaces the Board with the refusal, while a network failure leaves the last Board and its age on screen; the revoked Member's Post-its remain on another Member's Board under their author's name`

- [x] **TI08** Structural guards hold the read-only, offline-scope and Vote-anonymity boundaries this surface must not cross
  - Extends the shipped guard style in `api/test/post-it-structure.test.ts` and its offline-scope block. Pair every file-list assertion with one behavioural assertion that does not know the list (`docs/LEARNINGS.md#testing`).
  - **Verify**: `Test: no module on the Attendee Board path reads or joins Vote data; no Attendee-specific Board read or payload key exists; nothing but a Post-it contribution is written to the queue store; and no second polling interval, timer or cursor is introduced`

- [x] **TI09** The Attendee's Board is captured clean at 375, 768 and 1280 px at the design ceiling
  - Extends the shipped attendee capture in `visual/session-activities.spec.ts`, reusing its `horizontalOverflow` and `assertWithinViewport` helpers and its unbroken-token fixture; the stub payload carries ~200 Post-its across ~20 Categories.
  - **Verify**: `Test: at each of 375, 768 and 1280 px the attendee Board shows every Category and Uncategorised with no horizontal body scroll and no element whose own scrollWidth exceeds its clientWidth`

### Testing Strategy

- The near-live scenario (S01) asserts Bo's **rendered Board content** and waits on something the defect cannot touch – never on the value being asserted (`docs/LEARNINGS.md#testing`). [TI01,TI02]
- The connectivity guard (S05) asserts the queue store's contents after the loss. Seeding it first and proving it *unchanged* is stronger than proving it empty, but only with the cache-ownership claim in place. [TI06,TI08]
- The API refusals (S02, S06) run against real PostgreSQL rather than the fake Database: the point is that the stored row did not move, which an envelope assertion cannot show. [TI03,TI07]

### Execution Contract

- TI01 lands before TI05 and TI09: both depend on where the grouped Board puts a pending Post-it and on the Uncategorised region existing.
- TI06 lands before TI07: the staleness anchor and the shipped access-answered / keep-on-failure split are the same code path, and TI07 is what proves the split survived.


## Implementation Observations

> _Managed by exec-spec post-implementation – append-only. Spec authors: leave this section empty._

### Run: 2026-08-30 21:14 UTC – discovered-requirements

#### DISCOVERED REQUIREMENTS

_Propagated by the exec-plan wave triage from S02 (2026-08-30) – not authored with this story._

- **Do not inherit the SPA's absent-Board default.** `web/src/api/client.ts` defaults a missing Board with `round.uncategorised ?? { postIts: [], postItCount: 0 }`, which renders the Uncategorised region with a count of 0 and the "this round collected no post-its" copy for a payload that never claimed a Board – a positive assertion the API deliberately declines to make by omitting the keys. It is unreachable through `fetchSessionActivities`, which always supplies the Board for a Post-it Round, but this story reads the same type from a different endpoint where an absent Board is reachable. Distinguish "no Board in this payload" from "a Board with nothing on it"; do not copy the `??` fallback.
- **The unlisted-Category fallback holds for every Board read.** A Post-it whose Category is absent from the same Board read renders in **Uncategorised**, never dropped. The Session read takes Categories and Post-its as two statements inside one `Promise.all` with no transaction between them, so a Category removed between the two leaves the Post-it snapshot naming a Category the Category snapshot no longer lists. Grouping strictly by id puts such a Post-it in *neither* bucket, contradicting `prd.md#fr2-the-uncategorised-holding-area`'s invariant that a non-discarded Post-it is in exactly one Category or in Uncategorised, never neither. Established and proved by S02 (`api/test/category.integration.test.ts`, "renders a post-it in uncategorised when its category is removed mid-read"). Any read this story adds over the Board must preserve it.

### Run: 2026-09-01 21:45 UTC – observations

#### ASSUMPTIONS

- ~~**The real-PostgreSQL and Playwright halves of this story were authored but could not be executed in this environment.** No Docker daemon and no reachable `TEST_DATABASE_URL` (`postgres://…:5434/confapp_test` refuses the connection), so `api/test/post-it.integration.test.ts` reports `skipped` and `visual/session-activities.spec.ts` cannot reach the composed stack. The new integration tests were type-checked against `tsconfig.base.json` with a one-off project and the new Playwright test was verified to parse and register (`playwright test --list` lists all three widths); neither was *run*. TI03, TI04, TI07 (server half), TI09 and Structural Criterion 7 therefore rest on authored-and-typechecked evidence rather than on a green run.~~ Every other task is proved by a test that runs and that was confirmed to fail when its subject was reverted.

  **This assumption is retired: 2026-09-02, executed and green.** What had broken was WSL2 localhost forwarding, not Docker – the database answered on the WSL interface. With `TEST_DATABASE_URL="postgres://confapp:local-dev-only@172.23.72.231:5434/confapp_test"` the full suite runs **92 files / 1552 tests passed**, `api/test/post-it.integration.test.ts` among them; and both Playwright specs run against the composed stack – `visual/session-activities.spec.ts` **18 passed** (including the attendee-ceiling assertions at 375 / 768 / 1280 px) and `visual/display-board.spec.ts` **14 passed**. TI03, TI04, TI07's server half, TI09 and Structural Criterion 7 therefore rest on a green run, and quick-review C16 – which left those boxes ticked with the plan owner on the unrun-evidence basis – is closed for all of them. The ledger entry `gates-reported-unrunnable` records the same closure.

  **What remains genuinely unproved is one fixture, and only that.** The three-width capture seeds no **held item**, so the single element this story *relocated* – a pending Post-it drawn inside Uncategorised rather than in a separate list below the Board – is measured at no viewport width. The relocation is proved by component tests; what is unproved is that it holds at 375 px, the standing responsiveness bar. That is the OPEN ledger entry `held-item-not-captured`, and it needs a fixture rather than a decision.
- **"Each refusal names the authority required" (Acceptance Scenario S02) is read as the error *code*, not the sentence.** `CONFERENCE_ROLE_REQUIRED` names the authority; the message deliberately does not, because distinguishing "you hold no role here" from "this is not one of your sessions" would tell a caller which Sessions of a Conference they cannot see exist (`api/src/conferences/authorization.ts`). The test asserts the code, the shipped non-disclosing sentence, and that the sentence says nothing about the Post-it or its placement.

#### NOTICED BUT NOT TOUCHING

- `web/src/activities/SessionActivitiesPanel.tsx` (Board component) still carries S02's absent-Board default `round.uncategorised ?? { postIts: [], postItCount: 0 }` – the line this story's propagated Discovered Requirement names (it located it in `api/client.ts`; it is here). It is unreachable through `fetchSessionActivities`, which always supplies the Board for a Post-it Round, and the Board read and its shape are S02's to change ("Scope & Boundaries -> What We're NOT Doing"). This story added no new `??` fallback of its own, which is what the requirement asked of it.
- Pre-existing Prettier drift on four files this story never touched: `web/src/components/JoinCodePanel.tsx`, `api/test/display-link.integration.test.ts`, `api/test/join-code.test.ts`, `visual/conferences.spec.ts`. **Corrected 2026-09-02 (gap review G10):** only **three** of those files are long-standing – `api/test/join-code.test.ts`, `visual/conferences.spec.ts` and `web/src/components/JoinCodePanel.tsx`, named as pre-existing by S01 before this bundle wrote any code. `api/test/display-link.integration.test.ts` was **created by S04 in this bundle** and was never pre-existing; each story's per-story "not mine" rule was individually true and collectively wrong, with no bundle-scope backstop. It has been formatted, and `npm run format:check` now reports the three long-standing files only.
- `docs/wireframes/facilitator-board-and-categorisation/attendee-board.html` draws no staleness indicator; S01 settled the wording only for the projected surface (`design-decisions.md` -> "a statement, not a retry button"). The Attendee's age reuses `attendee/staleness.ts` verbatim and is rendered under the panel heading as `activities-age`; the wireframe was not updated, since wireframe authorship is S01's.

### Run: 2026-09-01 22:13 UTC – observations

#### QUICK-REVIEW REMEDIATION

Critic review report: `.agent_temp/reviews/s08-quick-review.md` (16 findings: 0 CRITICAL, 0 HIGH, 7 MEDIUM, 9 LOW).

**Fixed in this run** (all bounded and mechanically determined):

- **C02 (MEDIUM)** – moving the held-Post-it list inside Uncategorised took *refused* items with it, so a Post-it that is never arriving was drawn in the region for ones on their way, carrying a button worded **Discard it** on the read-only Attendee surface (`docs/UBIQUITOUS_LANGUAGE.md` reserves Discard for the Facilitator sorting act). Only pending items now render inside the region; returned-to-author ones render below the Board as `board-returned-<roundId>`. New guard: `web/test/PostItQueueing.test.tsx` -> "keeps a refused post-it below the board rather than inside uncategorised", revert-verified.
- **C03 (MEDIUM)** – the staleness test left its reconnect to the shipped 5s `setInterval` rather than to a dispatched tick (5059ms). Route array trimmed to three entries against three dispatched ticks; the test now runs in 138ms.
- **C04 (MEDIUM)** – no test made `postItCount` disagree with `postIts.length`, so every count assertion passed against a client-side re-derivation. Two fixtures now state divergent counts (9 against 3 cards; 5 against 2). Revert-verified: swapping `countLabel(category.postItCount)` for `postIts.length` fails both files.
- **C08 (LOW)** – deleted the second vote-guard loop, whose regex was strictly subsumed by the first.
- **C10 / C11 (LOW)** – `Date.now()` was read during render, making the component impure and detaching the label from the tick. The sentence is now held in state, computed in a `useLayoutEffect` seeded at commit and refreshed on the shared tick, and written only when the string actually differs, so eleven of twelve ticks no longer reconcile the ceiling tree.
- **C12 (LOW)** – two drains waited on the text they then asserted; they now wait on the re-read the delivered drain triggers.
- **C13 (LOW)** – "no second request" was asserted with a `Set`, which discards multiplicity. Exact per-endpoint answer counts and a total call count were added. Revert-verified with a planted extra watermark read.
- **C14 (LOW)** – `board-held-<roundId>` had no positive assertion; the relocation test now asserts the container by that testid.
- **C15 (LOW)** – em dash in this section replaced with an en dash (`CRITICAL-RULES-AND-GUARDRAILS.md` -> Operational Rules).
- Incidental: the new no-second-cursor guard matched `setAge` through `/etag/i`. Narrowed to a case-sensitive list plus the `If-None-Match` header.

**Left as Notes for the plan owner** (each needs a decision or crosses this story's file boundary):

- **C01 (MEDIUM)** – `readAt` advances only when the Session read runs, and for an Attendee that happens only when the activity cursor moves. On a healthy connection with nobody sorting, the age climbs exactly as it would during an outage. The FIS pins the anchor ("derive it from the timestamp of the last **successful read**"), so re-anchoring on the watermark exchange is a spec change rather than a defect fix. Real, and worth deciding before this ships.
- **C05 (MEDIUM)** – the vote-data guard exempts `api/src/routes/rounds.ts`, which is where `tally` is attached to the same Session read. Narrowing the regex to that file's Post-it branch, or adding a behavioural per-voter-field assertion, is the fix; both touch S02/S03 surface.
- **C06 (MEDIUM)** – the count/sort sweep omits `web/src/display/**`, which holds its own `countWord`. Adding it is one line in the guard, but a failure there could only be fixed inside `web/src/display/`, which another worker owns concurrently.
- **C07 (MEDIUM)** – the new three-width capture seeds no held item, so the one element this story relocated is not measured at any width. Needs a queue-store seed in the Playwright fixture and a browser stack to run against.
- **C09 (LOW)** – the age renders on a Session with no Post-it Round. Comment reworded to state it is a panel-level fact; whether to gate it on a Post-it Round being present is a product call.
- **C16 (LOW)** – Structural Criterion 7 and TI03/TI04/TI09 are ticked while the ASSUMPTIONS block above records that no run verified them. The plan owner decides whether a ticked box survives that disclosure.

### Run: 2026-09-02 – observations

#### DECISIONS

- **C01 – the staleness age anchors on the watermark exchange, not on the last Board read** (owner decision, **2026-09-02**). This is a **spec change, not a defect fix**: the FIS pinned the anchor to "the last successful read", and the wording is amended with it – Architecture Decision, Constraints & Gotchas (a new Critical bullet), and TI06's task line and Verify clause. The reason is that an Attendee's tick is a two-scalar watermark poll and the Board is re-read only when the cursor has actually moved, so on a healthy connection with nobody sorting the age climbed exactly as it does during an outage: a quiet Board read "Updated 4 minutes ago" while everything was fine, and an indicator that cries outage during normal operation is one people learn to ignore. Anchored on the exchange, the age means "we are still in touch with the server", which is what a reader takes it to mean. The poll already runs on the shipped cadence, so this adds **no request and no second cadence** – Structural Criterion 4 is untouched.
  - Implementation: `contactAtRef` in `web/src/activities/SessionActivitiesPanel.tsx`, advanced by `noteContact()` from two places – a successful `fetchActivityWatermark` (whether or not the cursor moved) and a successful Session read. It is a **ref** rather than state on purpose: advancing an anchor in state every five seconds would reconcile the two-hundred-Post-it ceiling tree twelve times a minute to produce a sentence that changes once a minute, which is the cost the previous run's C10/C11 fix removed. The rendered sentence stays in state and is still written only when the string differs. `readAt` has left the `ready` state, which had no other reader.
  - Red first: `web/test/PostItBoard.test.tsx` -> "holds the age at "just now" while the watermark keeps answering and the cursor never moves". Against the shipped anchor it failed with `AssertionError: expected 'Updated 1 minute ago' to be 'Updated just now' // Object.is equality` at `PostItBoard.test.tsx:1051`, ninety seconds into a quiet room. The test also asserts the Board was read exactly once, so it cannot be satisfied by a second read appearing.

#### FIXED

- **A named flake, diagnosed and fixed: `web/test/OrganizerLiveEditing.test.tsx` -> "refetches when the watermark moves and nothing is being edited".** It is a **test-harness timing assumption**, not a product race, and S08's `useLayoutEffect` is **not** on its path – `SessionActivitiesPanel` is never mounted in that file (`SchedulePanel` renders it only when a Session's activities are open, and no test there opens any).
  - Mechanism, measured rather than argued. `findBy*` resolves as soon as the node exists, which is a microtask after the commit, but `useEffect` bodies are flushed on a later task – and `poll/use-watermark-poll.ts` registers its `focus` listener in one of them. A `focus` dispatched in that window reaches nothing; the loop's next chance is its own five-second interval; and `vi.waitFor`'s **one-second default** expires four seconds short. That default is not the 15 s in `web/test/setup.ts`, which `configure({ asyncUtilTimeout })` applies to Testing Library's `waitFor` and to nothing else – so the exact failure mode that file documents leaked back in through the other `waitFor`.
  - Evidence: a 250-iteration replica of the test, instrumented to record the focus-listener count and the watermark reads at dispatch time, run on a loaded machine. Bare dispatch: 1 failure in 250, `listeners=0 watermarkReads=0`, `TIMEOUT after 1010ms`. `act`-wrapped dispatch (the pattern the other four tick harnesses use): also 1 in 250, same signature – because `act` runs its callback *before* it flushes anything. With an effect flush in front: 250 of 250 `listeners=1 watermarkReads=1`, satisfied in about 60 ms.
  - Fix: `settleEffects()` (`await act(async () => {})`) before the dispatch, and a `tick()` helper matching the other suites. Applied to both tests in that describe – the second asserts that *nothing* was requested, which without a registered listener would have passed for the wrong reason. The wait budget is deliberately left under the shipped five-second cadence so a tick going astray fails loudly instead of being rescued by the interval (the discipline C03 established).
  - `docs/STATE.local.md`'s earlier unexplained single-run failure in this suite is very likely the same thing: this describe held the only two bare `focus` dispatches in `web/test/`.

- **C05 – the vote-data guard's name was broader than what it checked.** Both halves, and the choice is stated: `api/src/routes/rounds.ts` stays **out** of the module list, because it legitimately serves the Poll surface end to end and asserting the whole file names no vote word would be a guard that could never go green – but leaving it out entirely was the gap. So (a) the structural guard now also extracts the **Post-it branch** of `toRoundWire` (everything from `: board === undefined`) and asserts no vote-shaped identifier in it, with the extraction itself asserted found and non-trivial; and (b) the assembly point – where `tally` is decided for the whole payload, outside `toRoundWire` – is covered **behaviourally, by a test that knows no file list**: `api/test/post-it.integration.test.ts` -> "names no vote data anywhere on an attendee's session read" walks every key at every depth of a real Attendee's real Session read. Keys and not the serialized text, so a Member writing "we should vote on this" cannot turn it red.
  - Proved on both: `hasVoted: false` added to `toRoundWire`'s Post-it branch fails the structural guard (`the post-it branch of toRoundWire: expected … not to match /\bvote|ballot|tally|hasVoted|option_…/i`); `voterMarker: caller.sub` added at the assembly point leaves the file-list guard **green** and fails the behavioural sweep (`expected [ 'voterMarker' ] to deeply equal []`). That pair is exactly the defect C05 named.

- **C06 – the count/sort sweep now covers `web/src/display/**`.** The block's own doc comment named three surfaces and swept two. Both loops now include the projected wall, the count-argument rule covers `countWord` as well as `countLabel`, and the argument is judged after one level of same-file `const` is resolved – which is what lets the rule be the strict one: **no `.length` may reach a count sentence, at one remove or none**. The resolution is deliberately one level and returns the expression unchanged when no binding is found, so a failed lookup fails the assertion instead of passing on an absence.
  - Proved twice: `countWord(postIts.length)` in `web/src/display/DisplayBoardView.tsx` – previously outside the sweep entirely – now fails (`expected 'postIts.length' to match /postItCount/`); and `countLabel(uncategorised.postItCount + held.length)`, the derivation this story's own Constraints & Gotchas call Critical, now fails on the length rule where the old `toMatch(/postItCount/)` passed it.

#### STILL OPEN

- **C07** (the relocated held-item card is seeded at no viewport width) and **C09** (whether the age should be gated on a Post-it Round being present) are untouched by this run and stay with the plan owner.

### Run: 2026-09-01 23:07 UTC – observations

#### OWNER DECISIONS

Recorded by the exec-plan orchestrator at the close of the run. The decision detail and the flake mechanism are set out in the `#### DECISIONS` and `#### FIXED` blocks of the preceding run; this block records the owner's ratification, the gate execution that run could not perform, and what is deliberately left open.

- **The staleness anchor moved to the watermark exchange, by owner decision of 2026-09-02 – and the spec moved with it.** The age had anchored on the last successful Session read, which for an Attendee runs only when the activity cursor moves, so on a healthy connection with nobody sorting the age climbed exactly as it would during an outage. Rather than let the code diverge from a spec that still said otherwise, the FIS's **Architecture Decision**, **Constraints & Gotchas** and **TI06** were amended to match. Ledger: `s08-the-attendees-live-board.reconciliation-ledger.md` -> `design-changed:staleness-anchor`, CLOSED.

- **The five gates this story reported unrunnable were executed, and the report of unrunnability was wrong.** The story recorded "no Docker daemon and no reachable `TEST_DATABASE_URL`" and left TI03, TI04, TI07's server half, TI09 and Structural Criterion 7 ticked with no executed proof. Docker was in fact running and the confApp stack was up; what had broken was **WSL2 localhost forwarding**, so PostgreSQL answered on the WSL interface address but not on `127.0.0.1`. Pointed at the interface IP, the orchestrator ran every one of those gates: the four new integration tests pass against real PostgreSQL, `visual/session-activities.spec.ts` passes 18, and the full suite is **92 files / 1552 tests** green across two clean runs. Those checkboxes are now earned rather than asserted, which retires the C16 disclosure in the 22:13 UTC block above. This was a near-repeat of a trap already recorded in `docs/LEARNINGS.md`; the interface-IP workaround is now recorded there too. Ledger: `ambiguous-intent:gates-reported-unrunnable`, CLOSED.

- **The named flake was diagnosed by measurement, and S08 was cleared as its cause.** `web/test/OrganizerLiveEditing.test.tsx` -> "refetches when the watermark moves" failed once in three full runs. The obvious suspect – S08's new layout effect – was **ruled out rather than assumed**: `SessionActivitiesPanel` is never mounted in that file, so the effect is not on its path. The actual mechanism is `findBy*` resolving before `useEffect` bodies flush, leaving a window in which a dispatched `focus` reaches no registered listener, compounded by `vi.waitFor`'s **1 s default** being mistaken for the 15 s Testing Library timeout that `web/test/setup.ts` configures via `configure({ asyncUtilTimeout })` – which applies to Testing Library's `waitFor` and to nothing else. Both facts are now in `docs/LEARNINGS.md`. Independently confirmed: the test passes six consecutive isolated runs.

- **C07 and C09 are left open on purpose, and are recorded rather than closed.** C07 – the three-width capture seeds no held item, so the one element this story relocated is measured at no viewport width – is an **OPEN** ledger entry (`design-changed:held-item-not-captured`); it needs a fixture, not a decision, and it is the standing 375px responsiveness bar that is unproved, not the relocation itself, which component tests prove. C09 – whether the age should be gated on a Post-it Round being present – is a product call and stays with the plan owner. Neither is closed by the agent that would benefit from closing it.
