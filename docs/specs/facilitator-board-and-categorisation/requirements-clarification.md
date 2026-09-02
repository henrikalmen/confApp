# Requirements Clarification: Facilitator Board View and Post-it Categorisation

> **Source Trust**: trusted-local

## Summary

The Insight half of a Post-it Round: the Facilitator projects a Board to the room and sorts its
named Post-its into Categories in front of everyone. It consumes what the shipped
`session-activities` slice collects and produces the categorised, attributed output the Report will
carry. It resolves a standing contradiction between REQ-015 (an Organizer sorting after collection)
and REQ-031/REQ-038 (Categories defined on the Board during the Session) by establishing that these
are one continuous activity on one Board, not two phases on two surfaces.

Covers REQ-015, REQ-016, REQ-022, REQ-031 and REQ-038. Closes the open question standing in
`docs/PRODUCT.md` since 2026-08-16: *"Are post-it categories defined during conference setup, or
created ad hoc by the organizer while sorting?"*

> **Amended 2026-08-30 (second pass).** A doc review of the derived PRD found that several
> requirements were falsifiable against shipped code this clarification had not consulted – the
> near-live cursor's scope and gating, the `isDraft` gate every other read sits behind, the hard
> author-delete path, and the absence of any time bound on the display link. D14–D20 resolve those,
> and Admin-only permanent removal enters scope so REQ-016's "delete **or** discard" is genuinely
> closed. D1–D13 are unchanged.

## Scope

### In Scope

- **Categories on a Board** – named buckets belonging to one Post-it Round, created, renamed,
  reordered and removed by the Facilitator during or after the Round.
- **Placing Post-its into Categories** – the sorting activity itself, performed on the
  Facilitator's own device at any viewport width.
- **The Uncategorised holding area** – where every Post-it arrives and where stragglers stay
  visible.
- **Discard and restore** (REQ-016) – removing a Post-it from consideration without erasing that
  it existed.
- **Admin hard-removal** (REQ-016) – an Admin permanently removing a Post-it, leaving no trace and
  no restore. The moderation path Discard deliberately is not; added 2026-08-30 so REQ-016's
  "delete **or** discard" is genuinely closed rather than half-delivered.
- **The projected Board View** (REQ-022) – a read-only big-screen surface reached by an
  unauthenticated, unguessable, revocable, **day-bounded** per-Round display link, which polls the
  Board rather than riding the Member-facing near-live cursor.
- **The Attendee's live view of the same Board**, re-rendering into Categories as sorting happens.

### Out of Scope

- **The Report** (REQ-023, REQ-024) – this feature produces categorised output; assembling and
  delivering the leadership document is the next slice and consumes it.
- **Prioritization and Rating** Voting Round purposes (REQ-020, REQ-021) – still deferred with
  their own slices. Voting on categorised Post-its is a Voting Round concern, not a Board concern.
- **Workshop Groups** (REQ-011, REQ-012) – a Workshop's Rounds remain conference-wide, unchanged
  from the `session-activities` slice. A per-Group Board is not introduced here.
- **Cross-conference Category reuse or analytics** – Phase 4 Archive territory.
- **Editing a Post-it's text** – authorship and text belong to the contributor and the
  `session-activities` slice; this feature moves and discards Post-its, it does not rewrite them.
- **Widening offline support** – sorting, discarding and the projected view all require
  connectivity. Offline remains schedule reads plus Post-it queueing (`docs/PRODUCT.md` →
  Anti-Goals).

### MVP Boundary

One Facilitator, running one Post-it Round in a real Session, can project its Board to the room,
create Categories after seeing the ideas, sort every Post-it into one, discard the noise, and leave
behind a structure the Report can read. Proved at 375px, 768px and 1280px, plus the projected
surface.

### Not Doing (for now)

- **Conference-level default Category sets** – rejected as a concept, not deferred. It creates a
  second place Categories are defined and an inheritance question (do later edits propagate?) for
  the sake of saving a facilitator from typing three words. Per-Board definition is the whole story.
- **Seeding a Board's Categories by copying another Board's** – same reasoning applied to the
  milder version; revisit only if facilitators are observed retyping the same sets.
- **Attendees choosing a Category when contributing** – considered and declined. Pre-existing
  buckets anchor thinking during a brainstorm, and sorting is deliberately the group activity, not
  a contribution-time chore. This also removed the original justification for REQ-038's
  empty-Board layout lock (see Resolved Decisions D3).
- **Auto-clustering or suggested Categories** – no ML or heuristic grouping. The sorting
  conversation is the value; automating it would remove the reason it happens in the room.
- **Pointer input on the projected screen** – the big screen is a mirror, never a control surface.
- **Nested or multi-Category placement** – a Post-it is in exactly one Category or in
  Uncategorised. Sub-categories and cross-tagging are whiteboard features
  (`docs/PRODUCT.md` → Anti-Goals: *not a general-purpose whiteboard*).

## Functional Requirements

### User Stories

- As a **Facilitator**, I want to project the Board to the room, so that sorting is something we do
  together rather than something I do alone afterwards.
- As a **Facilitator**, I want to create Categories after I have seen the ideas, so that the buckets
  fit what people actually wrote instead of what I guessed beforehand.
- As a **Facilitator**, I want to sort Post-its from my own phone or laptop, so that I am not tied
  to the room machine while the room watches the result.
- As a **Facilitator**, I want to discard noise without destroying it, so that a misdrag in front of
  the room is recoverable.
- As an **Attendee**, I want my phone to show the Board taking shape, so that I can follow the
  sorting from the back of the room where the projector is unreadable.
- As an **Attendee** whose Post-it synced late, I want it to arrive somewhere visible, so that my
  idea is not silently absorbed or lost after sorting has begun.
- As an **Organizer**, I want the categorised, attributed output to survive the Session, so that the
  Report has something to carry.
- As an **Admin**, I want to permanently remove a Post-it that should never have been written, so
  that something abusive or accidentally confidential does not sit in storage under a colleague's
  name waiting for any Facilitator to restore it.

### Core Flows

1. **Project and sort.**
   1. The Facilitator opens the Board for a Post-it Round they hold a Session Assignment on.
   2. They generate a display link and open it on the room machine; the Board appears on the big
      screen, read-only.
   3. Post-its arrive in **Uncategorised** as Attendees contribute.
   4. The Facilitator closes the Round when contribution is done (existing `session-activities`
      behaviour).
   5. They create Categories, naming each one.
   6. They place Post-its into Categories from their own device. Every placement propagates
      near-live to the projected view and to every Attendee's phone.
   7. Uncategorised empties as sorting progresses; its count is the visible measure of what is left.

2. **Discard.**
   1. The Facilitator discards a Post-it from the Board.
   2. It leaves the Board and the projected view – including its own author's view (D16) – and stops
      counting toward any Category.
   3. It remains restorable until the Conference is archived, unless its author's delete reaches it
      first (D17) or an Admin removes it permanently (D19).

### Alternate Flows

- **Sorting before the Round closes.** Categories may be created and Post-its placed while the
  Round is still open. Contribution continues into Uncategorised alongside.
- **A late offline Post-it.** A Post-it queued on a phone and synced after sorting has begun – or
  after the Round closed – lands in Uncategorised, visible, and is sorted like any other.
- **Reopening a sorted Round.** The existing reopen control still applies; Categories and
  placements survive it untouched.
- **Restoring a discarded Post-it.** It returns to Uncategorised, not to whatever Category it was
  in – the discard decision is undone, the sorting decision is not assumed.
- **Removing an occupied Category.** Refused until the Facilitator says where its Post-its go;
  moving them to Uncategorised is the default offer.
- **Revoking a display link.** The room screen stops showing the Board at its next poll. A new link
  can be issued immediately.
- **No projector in the room.** The Board is fully usable without ever generating a display link;
  the projection is an addition, never a prerequisite.
- **Permanent removal.** An Admin removes a Post-it outright after confirming an act that names its
  author and states it cannot be undone. It leaves every surface, leaves no trace, and no restore is
  offered. Available whether the Post-it was on the Board or already Discarded.
- **Setting the room up before the Conference is Published.** The Facilitator issues a display link
  and opens it on the room machine while the Conference is still Draft; the screen shows the neutral
  unavailable page and begins showing the Board the moment the Conference is Published.
- **A link outliving its day.** The morning after a Session, its display link no longer resolves. A
  Facilitator sorting a still-unfinished Board issues a fresh one; sorting itself is unaffected,
  since it runs on the Facilitator's own signed-in device.

### UI Wireframes

Not yet produced. Three surfaces need them, and they are genuinely different rather than one layout
rescaled – route through the `andthen:ui-ux-design` skill in `--mode wireframes` before
implementation:

- **The Facilitator's sorting surface** at 375px, 768px and 1280px. The 375px case is the hard one
  and the one that decides the interaction model.
- **The projected Board View** – a fourth viewport class, read at distance, with no input.
- **The Attendee's Board** at 375px, showing Categories forming live.

## Design Decisions

### Design Space Decomposition

```
Facilitator Board & Categorisation
├── D1 When categorisation happens
│     ← One continuous activity on the Board
│     · Two distinct phases (contribute, then a separate sorting pass)
│     · Sorting only after close
├── D2 Who places a Post-it
│     ← Facilitator/Organizer only
│     · Contributor chooses at compose time ✗ (pruned – anchors thinking; see Not Doing)
│     · Both, contributor suggests and facilitator overrides ✗ (pruned)
├── D3 Layout-change lock
│     ← Per-Category occupancy; rename and reorder always free
│     · Board-level lock as REQ-038 stated ✗ (pruned – would forbid affinity mapping)
│     · No lock at all
│     · Define Categories before opening the Round ✗ (pruned – forfeits affinity mapping)
├── D4 Sorting surface across viewports
│     ← Facilitator's own device drives; projection mirrors
│     · Drag on desktop/tablet, picker on phone
│     · Laptop-class task, phone read-only ✗ (pruned – needs an AGENTS.md exception)
├── D5 Uncategorised
│     ← Implicit holding area, not a Category
│     · Every Post-it in a real Category
│     · Nullable category, no holding area
├── D6 Category ownership scope
│     ← Per-Board only
│     · Conference-level defaults with per-Board override ✗ (pruned – see Not Doing)
│     · Per-Board plus copy-from-another-Board ✗ (pruned – see Not Doing)
├── D7 Discard semantics
│     ← In scope, leaves a trace, restorable
│     · In scope, hard removal ✗ (pruned – irreversible misdrag on a named colleague's idea)
│     · Out of scope, defer to the Report slice
├── D8 Projection identity
│     ← Unauthenticated, unguessable, revocable per-Round display link
│     · Facilitator signs in on the room machine ✗ (pruned – shared-device risk)
│     · Mirror the Facilitator's own device
├── D9 Board View session-kind scope
│     ← Any Post-it Round, Presentation or Workshop
│     · Workshops only, per the current glossary wording
│     · Any Post-it Round plus revealed Poll tallies ✗ (pruned – widens into S03)
├── D10 Discard undo window
│     ← Until the Conference is archived
│     · Immediate undo only
│     · Permanently restorable ✗ (pruned – archived Conference stops being immutable)
├── D11 Domain term
│     ← Category is the term; "column" describes the layout only
│     · Rename to Column throughout ✗ (pruned – breaks the Report's vocabulary)
│     · Both, deliberately distinguished ✗ (pruned – a synonym pair is what the glossary prevents)
├── D12 Display-link lifetime  **(superseded by D15)**
│     ← Valid while its Round exists; revocable and reissuable at any time
│     · Expires when the Session ends  ← closest to what D15 settled on
│     · Single-use, bound to first device ✗ (pruned – a reload locks the room out)
├── D13 What Attendees see during sorting
│     ← The same Board, re-rendering into Categories near-live
│     · A flat chronological list ✗ (pruned – two truths about one Board)
│     · Categories only after the Round closes
├── D14 How the projected surface learns the Board changed
│     ← Poll the whole Board on an interval; no cursor
│     · Anonymous Round-scoped watermark ✗ (pruned – reinstates the per-Round cursor
│       `rounds.ts` deliberately removed)
│     · Reuse the Session-scoped Member cursor ✗ (pruned – needs sign-in, reverses D8)
├── D15 Display-link time bound
│     ← Dead once the Round's Session day has passed; revocable earlier, reissuable
│     · No expiry at all ✗ (pruned – the only unbounded credential in confApp; ADR-005)
│     · Rolling 18h window from issue
│     · Calendar day in a stored conference timezone ✗ (pruned – confApp stores no
│       timezone by deliberate design)
├── D16 A Discarded Post-it's visibility to its own author
│     ← Hidden from everyone, author included
│     · Visible to its author, marked set-aside ✗ (pruned)
│     · Visible to the author only after the Round closes ✗ (pruned)
├── D17 Author delete racing a Discard
│     ← Author deletion wins; the row and the trace both go
│     · Refuse the author's delete ✗ (pruned)
├── D18 Display link in a Draft Conference
│     ← Issuable; renders "not available" until Published
│     · Refuse issuing until Published
│     · Render the Board in Draft ✗ (pruned – anonymous read of an unannounced event)
├── D19 Hard removal for moderation
│     ← Admin-only permanent removal, no trace, no restore
│     · Out of scope, recorded as a gap
│     · Treat Discard as sufficient ✗ (pruned – confidential content stays stored and
│       restorable by any Facilitator)
└── D20 Concurrent Category writes
      ← Cap enforced server-side; reorder is last-write-wins
      · Serialize Category writes per Board ✗ (pruned – introduces a blocking concept
        the feature otherwise avoids)
      · Leave it to the spec stage ✗ (pruned – the cap is user-visible)
```

### Cross-Consistency Notes

- **D2 (Facilitator-only) + D3 (per-Category lock) – the load-bearing interaction.** Choosing D2
  removed the reason REQ-038's Board-level lock existed. A lock keyed on *Board* occupancy only
  makes sense if Categories must pre-exist contribution, which is true only under
  contributor-chooses. Under Facilitator-only sorting, a Board-level lock would forbid creating any
  Category at all once the first Post-it landed – making the intended affinity-mapping flow
  impossible. The lock is therefore re-keyed to *Category* occupancy. **REQ-038's clause "the
  Board's layout is editable during a Session only while the Board holds no Post-its" is superseded
  by this clarification.**
- **D1 (continuous activity) + D5 (Uncategorised) + S04 (offline queueing).** Because sorting may
  begin before a Round closes, and because a queued Post-it may sync after sorting has finished,
  there must be a destination that always exists and is never "done". Uncategorised is that
  destination. Without D5, D1 plus the shipped late-arrival behaviour has no defined outcome.
- **D8 (unauthenticated link) + the standing rule that Post-its are always named.** The projection
  deliberately displays author names – that is its purpose – so the link is a credential. It is
  unguessable and revocable (D12) rather than public, and read-only so that holding it grants no
  authority over the Conference.
- **D8 + `shared-device-session-lifetime`.** That clarification bounds sessions on the assumption
  that devices are personal phones. A room machine violates the assumption; the display link avoids
  creating a Workspace session on shared hardware rather than extending that spec to cover it.
- **D4 + D13.** Both follow from one Board model: the Facilitator's device is the only control
  surface, and every other surface – projector, Attendee phone – is a near-live read of the same
  state.
- **D11 + D6.** Keeping "Category" while binding it per-Board widens the glossary's existing
  Category entry from the Insight context into Participation. The term does not change; the context
  binding does.
- **D14 + D8 + D12 – polling is what makes revocation real.** The only shipped near-live cursor
  (`api/src/routes/rounds.ts:804`) is Session-scoped and Membership-gated, so an anonymous Display
  Link holder cannot reach it; and `rounds.ts:43-48` records that a *per-Round* cursor was
  deliberately removed. Choosing to poll the whole Board keeps that decision intact and makes
  revocation fall out for free – the poll simply stops resolving. The Attendee's Board (D13) is
  Member-gated and continues to use the existing Session cursor; only the anonymous surface polls.
- **D16 + D17 – the collision is resolved by visibility, not by a rule.** D16 hides a Discarded
  Post-it from its author, so the delete control is never reachable and the race normally cannot
  occur. D17 exists only for the in-flight case – a delete already on the wire when the Discard
  lands – and is stated so the API has a defined outcome rather than an accident. Practically,
  an author who regrets a deletion writes a new Post-it; deletion stays irreversible as shipped.
- **D19 + D7 – two removals with opposite requirements, deliberately kept apart.** Discard leaves a
  trace and is restorable; Admin hard-removal leaves none and is not. They are not the same act
  behind a permission check, and reusing one path for both would collapse the distinction the
  glossary draws. Note this makes three removal concepts on one Post-it – author delete (no trace,
  Round open only), Facilitator Discard (trace, restorable), Admin removal (no trace, permanent).
- **D15 + the wall-clock schedule.** `conference.start_date`/`end_date` are `date` and Session times
  are `time without time zone` by deliberate design – confApp stores no timezone anywhere. An expiry
  instant therefore cannot be derived from a calendar day, so the bound is expressed against the
  Round's Session `day`: once the server's date is past it, the link is dead. Up to a day of drift
  by server locale is accepted as the cost of not widening the schedule's design.

### Resolved Decisions

| Dimension | Choice | Rationale |
|-----------|--------|-----------|
| D1 When categorisation happens | One continuous activity on the Board | `docs/PRODUCT.md` already recorded (2026-08-16) that *"sorting post-its into categories is a group activity visible to the room"*. REQ-015 describes the same Board at a later moment, not a second surface. |
| D2 Who places a Post-it | Facilitator/Organizer only | Pre-existing buckets anchor contributors' thinking mid-brainstorm; sorting is deliberately the group conversation. |
| D3 Layout-change lock | Per-Category occupancy; rename and reorder always free | Adding an empty Category disrupts nothing, so it is always allowed – this is what makes affinity mapping possible. Removing an occupied one needs a destination. A typo in a Category name must be fixable in front of the room. |
| D4 Sorting surface | Facilitator's own device drives; projection mirrors | Satisfies the 375px rule without requiring drag-and-drop on a phone, and needs no pointer input on a TV. |
| D5 Uncategorised | Implicit holding area, not a Category | Cannot be renamed, reordered or deleted. Guarantees a late offline arrival lands somewhere visible; its count is the Facilitator's progress indicator. |
| D6 Category ownership | Per-Board only | Closes `docs/PRODUCT.md`'s 2026-08-16 open question. No second definition site, no inheritance semantics, no propagation question. |
| D7 Discard semantics | In scope; leaves a trace; restorable | The glossary already defines Discard as *"distinct from it never having existed"*. Note this requires a tombstone the shipped `post_it` table deliberately lacks – see Dependencies. |
| D8 Projection identity | Unauthenticated, unguessable, revocable per-Round display link | Keeps a personal Google Workspace session off shared room hardware, and grants no authority beyond reading one Board. |
| D9 Board View scope | Any Post-it Round, either Session kind | REQ-010 puts Post-it Rounds in both kinds; a presenter collecting reactions wants the room to see them too. The glossary's "Workshop" wording is corrected. |
| D10 Discard undo window | Until the Conference is archived – subject to D17 and D19 | Uses the lifecycle that already exists rather than inventing a timer; a mistake found the next morning is still fixable. Two acts end the window early: the author deleting their own Post-it (D17) and an Admin removing it permanently (D19). |
| D11 Domain term | Category is the term; "column" is layout only | Preserves the glossary's `Avoid` entry and PRODUCT.md's "categorized output" vocabulary. |
| D12 Display-link lifetime | ~~Valid while its Round exists~~ **superseded by D15** – revocable and reissuable still hold | The original reasoning (an expiry timer would go dark mid-activity) survives only for a *rolling* timer. Binding expiry to the Session's own day cannot fire mid-activity, and leaving the link otherwise unbounded made it the only credential in confApp with no time bound at all – the failure ADR-005 exists to prevent. |
| D13 Attendee view during sorting | Same Board, re-rendering near-live | Someone at the back who cannot read the projector follows on their phone. One Board, one truth. |
| D14 Projected near-live mechanism | Poll the whole Board on an interval; no cursor | The shipped cursor is Session-scoped and Membership-gated, so an anonymous holder cannot use it, and a per-Round cursor is one `rounds.ts` deliberately removed. One room machine polling a small payload needs no cursor, and revocation lands for free on the next poll. |
| D15 Display-link time bound | Dead once the Round's Session day has passed; revocable earlier, reissuable | ADR-005 bounds ended access by time rather than trusting that someone revokes. Binding to the Session's own `day` needs no timezone, which confApp deliberately does not store. |
| D16 Discarded Post-it's visibility to its author | Hidden from everyone, author included | One rule for the Board on every surface. An author who regrets a removal writes a new Post-it; that is already how author deletion behaves. |
| D17 Author delete racing a Discard | Author deletion wins; row and trace both go | The author's control over their own words is the stronger claim, and the window is narrow (Round open, sorting already begun). Stated so the API has a defined outcome, not so the UI offers it. |
| D18 Display link in a Draft Conference | Issuable; renders "not available" until Published | Lets a Facilitator set the room up ahead of time without an anonymous read of an unannounced internal event – the exposure ADR-005 names. |
| D19 Hard removal for moderation | Admin-only permanent removal, no trace, no restore | Closes REQ-016's "delete **or** discard" rather than half-delivering it. Discard cannot serve as the moderation path: it keeps confidential content stored and restorable by any Facilitator. |
| D20 Concurrent Category writes | Cap enforced server-side; reorder is last-write-wins | The 20-Category cap is a user-visible invariant, so concurrent creates must not bypass it. Reorder reuses the placement concurrency story rather than inventing a second one. |

### Open Design Questions

- None requiring trade-off analysis. D8's link-generation mechanism (how unguessability is achieved
  and how revocation propagates to a polling client) is an implementation concern for the
  `andthen:spec` skill, not a requirements-level trade-off.

## Edge Cases

| Scenario | Expected Behavior |
|----------|-------------------|
| A queued Post-it syncs after sorting has finished | Lands in Uncategorised, visible on every surface. Never auto-placed. |
| A queued Post-it syncs after its Round closed | Same as above – the shipped late-arrival behaviour is unchanged by this feature. |
| Facilitator removes a Category holding Post-its | Refused until a destination is chosen; moving them to Uncategorised is the default offer. |
| Facilitator removes an empty Category | Allowed with no prompt. |
| Facilitator renames a Category holding Post-its | Allowed. Renaming is cosmetic and never moves anything. |
| Two Categories given the same name | Allowed but warned. Names are labels, not identifiers; the Report groups by identity, not by string. |
| A Category is created while the Round is still open | Allowed. Contribution continues into Uncategorised alongside. |
| Round is reopened after sorting | Categories and placements survive untouched. New Post-its arrive in Uncategorised. |
| A discarded Post-it is restored | Returns to **Uncategorised**, not to its former Category. The discard is undone; the sorting decision is not assumed. |
| A Post-it is discarded while sitting in a Category | Leaves the Board and the Category; the Category's count drops. Restorable per D10. |
| The Conference is archived with Post-its still in Uncategorised | Permitted. Uncategorised is a valid terminal state and the Report must be able to represent it. |
| Two Facilitators sort the same Board simultaneously | Last write wins per Post-it; both see the other's placements near-live. Placement is a small, independent, idempotent change – no conflict UI. |
| Display link opened after its Round is deleted | Refused. Nothing is disclosed about whether the Round ever existed. |
| Display link revoked while the room screen is open | The screen stops showing the Board at its next poll, within the near-live window. |
| Board projected with zero Post-its | Shows the empty Board and its Categories – a legitimate pre-Round state on the big screen. |
| An Attendee's Membership is revoked mid-Session | Their Post-its remain on the Board and remain attributed. Revocation ends access, not the record (existing Membership semantics). |
| A Category name is blank or whitespace | Refused with a field-level message. |
| An author opens their Board and their Post-it has been Discarded | It is simply absent, as it is for everyone (D16). No "set aside" marker, no notification. Writing a new Post-it is the way back. |
| An author's delete arrives while the same Post-it is being Discarded | The delete wins: the row goes and the Discard trace goes with it (D17). Only reachable as an in-flight race; the control is never offered against a Discarded Post-it. |
| An Admin permanently removes a Post-it | It leaves every surface with no trace and cannot be restored by anyone. Distinct from Discard, which is restorable, and from author deletion, which requires an open Round. |
| A Facilitator tries to permanently remove a Post-it | Refused – hard removal is Admin-only. Discard is the Facilitator's tool. |
| An Admin permanently removes a Post-it that was already Discarded | Allowed. The Post-it and its Discard trace both go; the restore that was pending is no longer offered. |
| A Display Link is issued while the Conference is Draft | The link is created and can be opened, but renders the neutral "not available" until the Conference is Published (D18). |
| A Display Link is opened the day after its Round's Session | Refused – the link is dead once the server's date is past the Session's `day` (D15). The Facilitator issues a new one. |
| A Display Link is issued for a Session several days out | Valid immediately, and still bounded – it dies once that Session's day has passed, not on a rolling timer from issue. |
| The projected view polls while the room network is flapping | The last-rendered Board stays on screen with a staleness indicator and resumes on the next successful poll. Nothing is written from this surface. |
| Two Facilitators create Categories concurrently at the cap | The cap holds – the server refuses whichever create would exceed 20, naming the current count. Neither client can bypass it by racing (D20). |
| Two Facilitators reorder Categories concurrently | Last write wins for the ordering as a whole; both see the result near-live. No conflict UI, consistent with placement. |

## Error Handling

| Error | User Message | Recovery |
|-------|--------------|----------|
| Removing an occupied Category | "This category holds N post-its. Move them to Uncategorised, or choose another category." | Choose a destination, or cancel. |
| Blank Category name | "A category needs a name." | Type one; the field keeps what was typed. |
| Category name too long | "Category names are at most N characters." | Shorten it; the field keeps what was typed. |
| Placement fails on a network blip | The Post-it returns to where it was, with "Couldn't move that – check your connection." | Retry. No queueing: sorting is explicitly online-only. |
| Sorting attempted without a Session Assignment | "You don't have permission to sort this board." | None – the controls are not offered in the first place; this is the backstop. |
| Display link is revoked or invalid | A neutral "This board is no longer available." | The Facilitator issues a new link. |
| Discarding an already-discarded Post-it | Silently succeeds – the end state is the one requested. | None needed. |
| Restoring a Post-it whose Conference is archived | "This conference is archived and can no longer be changed." | None. |
| Display link opened before its Conference is Published | The same neutral "This board is no longer available." – Draft state is not disclosed. | Wait for the Conference to be Published; the link starts working on its own. |
| Display link opened after its Session's day | The same neutral message; expiry and revocation are indistinguishable to the holder. | The Facilitator issues a new link. |
| Facilitator attempts a permanent removal | "Only an admin can permanently remove a post-it. You can discard it instead." | Discard it, or ask an Admin. |
| Admin confirms a permanent removal | A confirmation naming the author and stating that it cannot be undone. | None after confirming – that is the point of the act. |
| Category create would exceed the cap | "A board can hold at most 20 categories. This one has 20." | Remove or merge a category first. |

## Non-Functional Requirements

- **Performance**: Placement propagates to the projected view and to Attendee phones within the
  standing near-live window (a few seconds); no hard real-time path is introduced. The Board View
  must remain legible with a realistic full Board – assume up to ~200 Post-its across ~10
  Categories for one Round.
- **Security**: The display link is a bearer credential granting read-only access to one Board's
  named Post-its. It must be unguessable, revocable, **time-bounded** (dead once the Round's Session
  day has passed, D15), scoped to a single Round, and must confer no authority over the Conference.
  It must not render at all while its Conference is Draft (D18), and it must not expose Vote data of
  any kind – the anonymity guarantee is untouched by this feature, which handles only Post-its.
  Sorting and discarding require a Session Assignment on the Round's Session **or conference-wide
  Admin**, enforced server-side. Permanent removal (D19) requires Admin and nothing less.
- **Accessibility**: Sorting must be operable without drag-and-drop – a pointer-only interaction
  would exclude keyboard and assistive-technology users, and would not survive the 375px case
  anyway. The projected view is read at distance: type size, contrast and Category boundaries must
  hold at several metres.
- **Responsiveness**: The standing three-width bar (375 / 768 / 1280) applies to the Facilitator's
  sorting surface and the Attendee's Board. The projected view is a **fourth** viewport class and
  must be validated separately – it is not the 1280px layout with a bigger font.

## Success Criteria

- [ ] A Facilitator can create, rename, reorder and remove Categories on a Post-it Round's Board.
- [ ] A Category holding Post-its cannot be removed without choosing a destination for them.
- [ ] A Category can be renamed at any time, including while it holds Post-its.
- [ ] A new Category can be created while the Board already holds Post-its.
- [ ] Every Post-it arrives in Uncategorised, including one that syncs after its Round closed.
- [ ] Uncategorised cannot be renamed, reordered or deleted.
- [ ] A Post-it can be placed into a Category, and moved between Categories, from a 375px viewport.
- [ ] Sorting is fully operable without drag-and-drop.
- [ ] A placement is visible on the projected view and on an Attendee's phone within the near-live
      window.
- [ ] A discarded Post-it leaves the Board – including its author's view – is excluded from the
      categorised output, and remains restorable until the Conference is archived, except where its
      author deleted it (D17) or an Admin removed it permanently (D19).
- [ ] A restored Post-it returns to Uncategorised.
- [ ] A display link renders the Board read-only, with author names, without a signed-in session.
- [ ] A revoked display link stops rendering the Board within the near-live window.
- [ ] A display link grants no ability to sort, discard, or read anything outside its own Board.
- [ ] A holder of a Session Assignment on the Round's Session can sort and discard; a Member
      without one cannot, enforced server-side and not merely hidden in the UI. (The
      Admin-without-assignment case is deliberately unspecified here – see Open Questions.)
- [ ] The Board View works for a Post-it Round in a Presentation as well as in a Workshop.
- [ ] The Facilitator's surface and the Attendee's Board are validated at 375 / 768 / 1280; the
      projected view is validated separately at projection scale.
- [ ] No Vote data is reachable through any surface this feature adds.
- [ ] A Discarded Post-it is absent from its own author's view, not merely from the shared Board.
- [ ] An Admin can permanently remove a Post-it; it leaves no trace and cannot be restored.
- [ ] A Facilitator without Admin cannot permanently remove a Post-it, enforced server-side.
- [ ] A Display Link stops rendering once the server's date is past its Round's Session day.
- [ ] A Display Link issued while the Conference is Draft renders the neutral unavailable page, and
      begins rendering the Board once the Conference is Published.
- [ ] Expiry, revocation and Draft state are indistinguishable to a link holder – one neutral
      message for all three.
- [ ] The projected surface reaches the Board with no Membership and no cursor, and a revoked or
      expired link stops resolving on its next poll.
- [ ] Concurrent Category creates cannot push a Board past 20 Categories.

## Dependencies

| Dependency | Purpose | Risk |
|------------|---------|------|
| Shipped `session-activities` slice (S01–S05) | Supplies the Post-it Round, the Board, and the named Post-its this feature sorts | Low – done, verified, committed. |
| `post_it` table has no Category, position, or tombstone column | All categorisation and Discard storage is new | Low as schema work, but D7's restorable Discard **contradicts a deliberate shipped decision** – the migration comment states there is intentionally "no tombstone, soft-delete flag or `deleted_at`" because removal must leave no trace. That decision was made for contributor-initiated removal; D7 introduces Facilitator-initiated Discard as a distinct concept. The spec must keep the two apart rather than reuse one path. **Worth an ADR.** |
| Shipped late-arrival behaviour (`20260830090000000_post-it-late-arrival.sql`) | Determines what happens to a Post-it syncing after close | Low – D5 was chosen to accommodate it. |
| `activity_watermark` near-live cursor | Propagates placements to **Attendee phones** (Member-gated surfaces only) | Low – the mechanism exists and already covers Post-it writes. Confirm a Category or placement change advances it. **It does not serve the projected view**: the poll at `api/src/routes/rounds.ts:804` is Session-scoped and Membership-gated, and `rounds.ts:43-48` records that a per-Round cursor was deliberately removed. D14 keeps that decision by having the anonymous surface poll the Board itself. |
| Shipped author-delete path (`api/src/rounds/post-it-repository.ts:537`) | Hard `delete from post_it`, gated on `author_sub` and `r.state = 'open'` | Medium – it has no Discard-awareness. D17 accepts that a delete racing a Discard wins and takes the trace; the spec must confirm the Discard trace's FK cascades rather than orphaning. |
| Conference lifecycle `isDraft` gating (`api/src/routes/rounds.ts:594`, `:688`) | Every shipped Session/contribution read re-gates Draft content behind a `PresenterFacilitator` role | Medium – an anonymous Display Link holds no role, so D18's "renders nothing until Published" is a **new** gate on a new route, not a reuse of the existing helper. |
| `conference.start_date` / `sessions.day` are wall-clock `date`; no timezone is stored anywhere | D15's expiry is expressed against the Session's `day` | Low, but the drift is real – the boundary moves with server locale. Accepted deliberately rather than adding a timezone column to the schedule's wall-clock design. |
| ADR-005 (bound ended access by time, not by a refusal code) | The reasoning D15 follows – a credential whose only end is someone remembering to revoke it does not end | Low – the ADR exists and is directly on point; cite it rather than re-deriving. |
| Admin role (`role_assignment`, `ROLE_RANK.Admin`) | Gates D19's permanent removal | Low – the role and its rank check already exist. |
| Session Assignment (S01) | Authorises sorting and discarding | Low – the read/run split this feature needs already exists. |
| Conference archival (S03 lifecycle) | Bounds the Discard undo window (D10) | Low – the state exists. |
| `docs/UBIQUITOUS_LANGUAGE.md` | `Category` must widen from Insight into Participation; `Board View` must stop being Workshop-only | Low, but must be done or the glossary contradicts the feature. |
| The Report slice (REQ-023, REQ-024) | Consumes this feature's output | None inbound – but the categorised shape decided here constrains what the Report can say. |

## Open Questions

- Should the Report distinguish "discarded" from "never contributed", given D7 preserves the trace?
  The trace exists either way; whether Leadership sees a discarded count is a Report decision. Note
  D19's Admin removal leaves no trace, so it is invisible to the Report by construction – only
  Discard is distinguishable.
- Area to revisit: what the projected Board View does when a Round has many more Post-its than fit
  one screen – paging, scaling down, or Facilitator-driven focus. Sharpened by wireframing the
  projected surface at realistic volume, and by one observation of a real workshop's Post-it count.
- Area to revisit: how often the projected surface polls under D14, and whether one interval suits
  both an active sorting pass and an idle pre-Round screen. Sharpened by measuring a realistic Board
  payload once the read model exists.

### Closed since the first pass _(2026-08-30)_

- *Does a Category carry any attribute beyond name and order?* **No** – name and order only for this
  release. Colour or description is additive later, to both the sorting UI and the Report.
- *Is there an upper bound on Categories per Board and on name length?* **Yes** – at most 20
  Categories, name at most 60 characters (below the shipped 120-character Poll-option limit, because
  the name is a column header read at projection distance).
- *May an Admin without a Session Assignment sort another person's Session?* **Yes** – the shipped
  authority helper already resolves it: an Admin passes session-run authority unconditionally on
  conference-wide authority (`api/src/conferences/authorization.ts`). This feature follows that
  precedent rather than inventing a narrower rule for Boards. Whether Admin *should* override Session
  Assignment generally remains a larger, still-unstated project question.

## Decisions Log

| Decision | Rationale | Date |
|----------|-----------|------|
| Categorisation is one continuous activity on the Board, not two phases | `docs/PRODUCT.md` already framed sorting as a group activity visible to the room; REQ-015 and REQ-038 describe the same Board at different moments | 2026-08-30 |
| **REQ-038's empty-Board layout lock is superseded** | It was load-bearing only under contributor-chooses placement, which was declined. Kept as stated it would forbid creating any Category once the first Post-it landed, making affinity mapping impossible | 2026-08-30 |
| Only the Facilitator/Organizer places Post-its | Pre-existing buckets anchor contributors' thinking; sorting is deliberately the group conversation | 2026-08-30 |
| The lock is keyed on Category occupancy, not Board occupancy | Adding an empty Category disrupts nothing; removing an occupied one needs a destination | 2026-08-30 |
| Rename and reorder are always permitted | A typo in a Category name must be fixable in front of the room | 2026-08-30 |
| Uncategorised is an implicit holding area, not a Category | Guarantees a destination for late offline arrivals that always exists and is never "done" | 2026-08-30 |
| Categories belong to one Board; no conference-level set | Closes `docs/PRODUCT.md`'s 2026-08-16 open question; avoids a second definition site and inheritance semantics | 2026-08-30 |
| Discard is in scope, leaves a trace, and is restorable until archival | The glossary already defines Discard as distinct from never having existed; an irreversible misdrag in front of the room destroys a named colleague's idea | 2026-08-30 |
| The projection uses an unauthenticated, unguessable, revocable per-Round link | Keeps a personal Workspace session off shared room hardware – the case `shared-device-session-lifetime` assumed away | 2026-08-30 |
| The projected view is read-only; the Facilitator's own device is the only control surface | Satisfies the 375px rule without phone drag-and-drop, and needs no pointer input on a TV | 2026-08-30 |
| Board View covers any Post-it Round, in either Session kind | REQ-010 puts Post-it Rounds in both kinds; the glossary's "Workshop" wording is corrected | 2026-08-30 |
| "Category" remains the domain term; "column" describes layout only | Preserves the glossary's `Avoid` entry and PRODUCT.md's "categorized output" vocabulary | 2026-08-30 |
| Attendees see the same Board re-rendering into Categories, near-live | Someone at the back who cannot read the projector follows on their phone; one Board, one truth | 2026-08-30 |
| Sorting is online-only; offline support is not widened | `docs/PRODUCT.md` → Anti-Goals; offline stays schedule reads plus Post-it queueing | 2026-08-30 |
| The projected surface polls the whole Board; no cursor is added for it | The shipped cursor is Session-scoped and Membership-gated, unreachable anonymously, and a per-Round cursor is one `rounds.ts` deliberately removed. Polling keeps that decision and makes revocation land for free | 2026-08-30 |
| The Display Link is time-bounded – dead once the Round's Session day has passed | ADR-005: bound ended access by time rather than trusting that someone revokes. Binding to the Session's `day` needs no timezone, which confApp deliberately does not store | 2026-08-30 |
| A Discarded Post-it is hidden from its author too | One rule for the Board on every surface. An author who regrets a removal writes a new one – already how author deletion behaves | 2026-08-30 |
| An author delete racing a Discard wins, taking the trace | The author's control over their own words is the stronger claim, and the window is narrow. Stated so the API has a defined outcome, not so the UI offers it | 2026-08-30 |
| A Display Link is issuable in Draft but renders nothing until Published | Lets a Facilitator set up the room ahead of time without an anonymous read of an unannounced internal event | 2026-08-30 |
| **Admin-only permanent removal is added to scope** | Closes REQ-016's "delete **or** discard". Discard cannot serve as moderation: it keeps confidential content stored and restorable by any Facilitator | 2026-08-30 |
| The Category cap is a server-side invariant; reorder is last-write-wins | The cap is user-visible, so racing creates must not bypass it; reorder reuses the placement concurrency story rather than inventing a second one | 2026-08-30 |
