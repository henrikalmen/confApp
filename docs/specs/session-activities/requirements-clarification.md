# Requirements Clarification: Session Activities – Post-it Rounds and Polls

> **Source Trust**: trusted-local

## Summary

The participation core: a Session becomes a container that actually runs something. A
Presenter/Facilitator authors Post-it Rounds and Poll-purpose Voting Rounds alongside the Session,
opens and closes them live, and Attendees contribute named Post-its and cast anonymous Votes from
their phones. This is the slice where confApp's load-bearing rule stops being a statement in
`AGENTS.md` and becomes storage: Post-its carry their author's name, Votes are unlinkable to their
voter.

## Scope

### In Scope

- **Post-it Round** as an Activity on a Session: authored ahead, opened and closed live, collecting
  named Post-its.
- **Voting Round** with the **Poll** purpose only: a question with 2–N authored options, one
  anonymous single-choice Vote per Member.
- Live contribution from an Attendee's phone, with Post-its visible to everyone as they arrive.
- Offline queueing of a typed Post-it (REQ-028), including one that syncs after its Round closed.
- The Presenter/Facilitator's in-session controls: open, close, and reopen a Post-it Round.
- Poll tallies: live to the Facilitator, revealed to Attendees when the Round closes.

### Out of Scope

- **Prioritization and Rating** Voting Round purposes – deferred with their own slices.
- **Workshop Groups** (REQ-011, REQ-012) – a Workshop's Rounds are conference-wide in this slice.
- **Categorization and Discard** (REQ-015, REQ-016) – the Insight context; the Organizer's sorting
  pass is a separate feature that consumes what this one collects.
- **Board View** (REQ-022) – the projected surface is its own slice with its own client concerns.
- **The Report** (REQ-023, REQ-024) – downstream of categorization.
- **Push notifications** for a Round opening – REQ-005 is unbuilt and near-live in-app propagation
  is the primary channel.

### MVP Boundary

Post-it Rounds and Poll Rounds, both authored ahead and run live in a real Session at a real
conference. It proves the whole loop – author, open, contribute, close, see the result – for both
Activity kinds, and therefore proves the named/anonymous split end to end. Nothing downstream of
collection is included.

### Not Doing (for now)

- **Free-text Poll answers** – rejected on the anonymity guarantee, not deferred. A typed answer is
  self-identifying in a room of under a hundred colleagues (content, writing style, who is present),
  so it would quietly undo the storage-level unlinkability that is the whole point of Votes. Named
  free text already has a home: the Post-it Round.
- **Editing a Post-it after its Round closes** – it becomes part of the record at that point.
  Removing it afterwards is the Organizer's **Discard**, which the glossary already defines and the
  categorization slice owns.
- **Reopening a closed Poll** – see Resolved Decisions; a revealed tally cannot be un-revealed.
- **A per-attendee cap on Post-its** – works directly against the "share of attendees contributing"
  metric in `docs/PRODUCT.md`.
- **Session attendance tracking** – deliberately absent from the domain and not introduced here.

## Functional Requirements

### User Stories

- As a **Facilitator**, I want to author a Post-it Round's prompt before the Session, so that I am
  not typing in front of a room.
- As a **Facilitator**, I want to open and close a Round live, so that contribution happens when the
  activity happens and not before or after.
- As an **Attendee**, I want to add Post-its under my own name and see everyone else's appear, so
  that ideas build on each other the way they do on a physical wall.
- As an **Attendee**, I want to answer a Poll without anyone – including the facilitator – being
  able to trace the answer to me, so that I answer honestly.
- As an **Attendee**, I want a Post-it I typed with no signal to reach the wall when my connection
  returns, so that a dead spot does not cost me my idea.
- As **Leadership**, I want the sentiment signal to be trustworthy by construction, so that a
  positive result means something.

### Core Flows

1. **Authoring** – a Presenter/Facilitator with a Session Assignment adds Rounds to their Session:
   a Post-it Round with a prompt, or a Poll Round with a question and 2–N options. Rounds are
   created closed.
2. **Running a Post-it Round** – the Facilitator opens it. Any Conference Member may add Post-its;
   every Post-it shows its author's name and appears for everyone near-live. The Facilitator closes
   it when the activity ends, and may reopen it.
3. **Running a Poll** – the Facilitator opens it. Each Member casts one single-choice Vote. The
   Facilitator watches the tally build; Attendees see only that they have voted. On close the tally
   is revealed to everyone and the Round cannot be reopened.

### Alternate Flows

- **Offline contribution** – a Post-it typed without a connection queues on the device and syncs
  when connectivity returns, landing on the wall even if the Round has since closed, flagged as
  arriving late.
- **Correcting a Post-it** – while the Round is open its author may edit or delete it; after close
  neither is available to them.
- **Reopening a Post-it Round** – the Facilitator reopens; contribution resumes and late-syncing
  Post-its behave as normal ones.
- **Joining late** – a Member who opens the app mid-Session can contribute to any currently open
  Round; nothing about earlier absence blocks them.

### UI Wireframes

Not produced here. Three surfaces are implied and should be wireframed before implementation: the
Attendee's Round view (contribute + live wall, and the Poll's option list), the Facilitator's Round
controls (open/close/reopen, live tally), and the Round authoring form alongside the existing
Session editor. All must satisfy the standing 375 / 768 / 1280 criterion, and the Attendee surfaces
are phone-first – one-handed, in a room.

## Design Decisions

### Design Space Decomposition

```
Session Activities (post-its and polls)
├── Slice size
│   ├── Post-it Rounds + Poll Rounds                    ← chosen
│   ├── + Prioritization
│   ├── + Board View
│   └── Whole theme at once                             ✗ (pruned)
├── Vote correction
│   ├── One cast, final                                 ← chosen
│   ├── Changeable until close                          ✗ (pruned – needs a link or a device token)
│   └── Withdraw and recast
├── Round lifecycle
│   ├── Authored ahead, opened/closed live              ← chosen
│   ├── Created live, ad hoc
│   └── Both
├── Post-it visibility while open
│   ├── Live to everyone                                ← chosen
│   ├── Hidden until close
│   └── Per-round facilitator setting
├── Poll answer shape
│   ├── Single choice from authored options             ← chosen
│   ├── Single or multi choice
│   ├── Choice or rating scale                          ✗ (pruned – Rating is its own purpose)
│   └── Free text                                       ✗ (pruned – self-identifying)
├── Eligibility to contribute
│   ├── Any Conference Member                           ← chosen
│   ├── Session-scoped presence                         ✗ (pruned – invents attendance)
│   └── Track or group scoped
├── Poll result visibility
│   ├── Facilitator live, Attendees on close            ← chosen
│   ├── Live to everyone                                ✗ (pruned – anchors later voters)
│   └── Facilitator and Report only
├── Late offline Post-it
│   ├── Accept into the Round, flagged late             ← chosen
│   ├── Refuse but preserve the text
│   └── Grace window
├── Reopening
│   ├── Post-it Rounds yes, Polls no                    ← chosen
│   ├── Both
│   └── Neither
└── Session deletion with collected output
    ├── Refuse the delete                               ← chosen
    ├── Allow with warning
    └── Delete session, orphan the output
```

### Cross-Consistency Notes

- **Close-then-reveal + no Poll reopening – one decision in two places.** Revealing the tally at
  close is what stops early results anchoring later voters; allowing a reopen would hand exactly
  that advantage to whoever votes second. Reopening Post-it Rounds carries no such cost because a
  wall has no tally to game.
- **One cast final + anonymous storage – mutually reinforcing.** Because a Vote is never revised,
  confApp never needs to find "your" ballot, which is the only reason it would need a link between
  voter and ballot. The two chosen options make each other cheap; changing either reopens the other.
- **Accept-late Post-its + reopenable Post-it Rounds – consistent, and both follow from "a wall is a
  record, not a race".** A Round that can reopen makes a late arrival unremarkable rather than an
  exception.
- **Any-Member eligibility + attendance not tracked.** The open Round *is* the gate. Introducing
  session-scoped eligibility would require inventing attendance, which the glossary rejects, and
  would strand late joiners and reinstalls.
- **Refusing deletion of a Session with output + the existing cascade.** `conference → sessions`
  cascades on delete today; this decision constrains the Session-level path only. Whether deleting a
  whole Conference may still destroy collected output is an open question below.

### Resolved Decisions

| Dimension | Choice | Rationale |
|---|---|---|
| Slice size | Post-it Rounds + Poll Voting Rounds | Proves the named/anonymous contrast end to end at one real conference; `docs/PRODUCT.md` makes a thin end-to-end slice the MVP principle |
| Vote correction | One cast, final until close | Lets "has voted" be recorded entirely separately from the ballot, giving one-person-one-vote and unlinkability at once |
| Round lifecycle | Authored ahead, opened and closed live | Matches the existing Session Assignment authority model; authoring a prompt in front of a room is friction at the worst moment |
| Post-it visibility | Live to everyone while open | It is the shared wall confApp replaces; ideas building on each other is the point, and the Board View later assumes it |
| Poll answer shape | Single choice from 2–N authored options | Simplest thing satisfying "a live question posed to the room"; a ballot is a Round id plus an option id, which is trivially anonymous |
| Free-text Poll answers | Rejected | Self-identifying in a company of under a hundred; would undo the storage-level guarantee. Named free text is what a Post-it Round is for |
| Eligibility | Any Conference Member, while the Round is open | Introduces no new concept and honours "attendance is not tracked"; the open Round is the gate |
| Poll result visibility | Facilitator live; Attendees on close | Preserves the reveal moment without letting a partial tally steer the undecided |
| Late offline Post-it | Accepted into the Round, flagged late | REQ-028 promises a typed Post-it is not lost; dropping it breaks the one guarantee offline support exists to give |
| Own Post-it | Editable and deletable while the Round is open | Covers typos and second thoughts; after close it is record, and removal becomes the Organizer's Discard |
| Reopening | Post-it Rounds yes, Polls no | A wall can always take another idea; a revealed tally cannot be un-revealed |
| Session deletion with output | Refused | The product exists so workshop output stops evaporating; a cascade that destroys a wall of named ideas contradicts that |
| Post-it limits | Length cap, no count cap | Capping ideas per person works against the contribution metric in `docs/PRODUCT.md` |

### Open Design Questions

None at requirements level. How "has voted" is recorded without a link to the ballot, how near-live
propagation reaches the wall, and how the late flag is represented are implementation decisions for
the `andthen:spec` skill – though the first is close enough to the anonymity guarantee that it is
worth an explicit Structural Criterion rather than being left to the executor.

## Edge Cases

| Scenario | Expected Behavior |
|---|---|
| Member opens a Round that is not open | Prompt or question visible, contribution refused with the Round's state named |
| Post-it added, then its Round closes | Post-it stands; its author can no longer edit or delete it |
| Offline Post-it syncs after close | Accepted into the Round, flagged as late, appears on the wall and in later output |
| Offline Post-it syncs after the Round reopened | Treated as an ordinary contribution; no late flag needed |
| Member votes twice in one Poll | Second Vote refused – the Round already records that this Member has voted |
| Member votes, then reinstalls the app | Still recorded as having voted; the marker is server-side, not on the device |
| Poll closed with zero Votes | Closes normally; the tally reads zero rather than erroring |
| Poll closed, Facilitator tries to reopen | Refused, with the reason – the tally is already public |
| Post-it Round reopened after Attendees saw it closed | Contribution resumes for everyone; no special state for those who already contributed |
| Facilitator opens a second Round while one is open | Permitted – a Session may run more than one Activity at a time |
| Attendee deletes their only Post-it | Wall simply has one fewer; no trace is kept of it having existed |
| Session with collected Post-its or Votes is deleted | Refused, naming what would be lost |
| Session with Rounds but no contributions is deleted | Permitted – its Rounds go with it |
| Member leaves the Conference after contributing | Post-its keep their author's name; Votes are unaffected, being unlinkable already |
| Non-assigned Facilitator tries to open a Round | Refused – authority follows Session Assignment |
| Two Facilitators assigned to one Session both act | Both may open and close; last action wins, near-live |

## Error Handling

| Error | User Message | Recovery |
|---|---|---|
| Contributing to a closed Round | "This round is closed." | The prompt and existing Post-its stay readable |
| Voting twice | "You have already voted in this round." | The Attendee's own state shows they have voted; no tally is revealed |
| Post-it over the length cap | Field-level refusal naming the limit, before submission | The typed text is preserved |
| Poll authored with fewer than two options | "A poll needs at least two options." | The authoring form keeps what was entered |
| Opening a Round without a Session Assignment | "You can only run rounds in sessions assigned to you." | Read-only view of the Session |
| Deleting a Session holding contributions | "This session has collected post-its or votes and cannot be deleted." | Offer to edit or reschedule instead |
| Reopening a closed Poll | "A poll cannot be reopened once its results are shown." | Author a new Poll if the question needs asking again |
| Contribution fails with no connection | Queued silently; the Post-it shows as pending on the device | Syncs on reconnect (REQ-028) |

## Non-Functional Requirements

- **Performance**: near-live propagation – a Post-it should reach other devices within a few
  seconds. No hard real-time infrastructure; polling or lightweight push is sufficient.
- **Security**: contribution authority is checked server-side per Round – Membership to contribute,
  Session Assignment to open, close or reopen. A closed Round refuses writes at the API, not merely
  in the UI.
- **Privacy**: **Vote anonymity is a storage-level guarantee.** No schema may permit joining a Vote
  to the Member who cast it, including through timestamps precise enough to correlate with the
  has-voted marker. This is a hard GDPR constraint (`docs/PRODUCT.md` → Strategic Constraints), and
  a schema that *could* deanonymize is a defect even with no screen that does.
- **Accessibility**: contribution surfaces legible with no horizontal body scroll at 375 / 768 /
  1280 px, and usable one-handed on a phone.
- **Scalability**: sized for a company of under a hundred – a Round may see tens of concurrent
  contributors, not thousands.
- **Statelessness**: no in-process state between requests; Round state and has-voted markers live in
  PostgreSQL (`AGENTS.md`).

## Success Criteria

- [ ] A Facilitator can author a Post-it Round and a Poll on a Session they are assigned to, and
      cannot on one they are not.
- [ ] Opening a Round makes it contributable to every Conference Member; closing it stops
      contribution at the API.
- [ ] A Post-it displays its author's name everywhere it appears.
- [ ] No query joining a Vote to a Member exists, and the schema makes one impossible – asserted
      directly, since this is the product's load-bearing guarantee.
- [ ] A Member may cast exactly one Vote per Poll, and a second attempt is refused.
- [ ] A Poll tally is visible to the Facilitator while open and to Attendees only after close.
- [ ] A Post-it typed offline reaches the wall on reconnect, including when the Round closed first.
- [ ] An author can edit and delete their own Post-it while the Round is open, and neither after.
- [ ] A Post-it Round can be reopened; a Poll cannot.
- [ ] Deleting a Session holding contributions is refused, naming what would be lost.
- [ ] Contribution surfaces pass at 375 / 768 / 1280 px with no horizontal body scroll.
- [ ] S02–S10's existing acceptance scenarios still pass unchanged.

## Dependencies

| Dependency | Purpose | Risk |
|---|---|---|
| `sessions` table and S04 schedule composition | Rounds attach to a Session | Low – the table exists; this adds children |
| Session Assignment (S07/S08) | Decides who may open, close and reopen a Round | Low – already built and enforced |
| Membership (S05 join code) | Decides who may contribute | Low – already built |
| S09 live editing and its watermark polling | The propagation pattern near-live contribution should follow rather than reinvent | Medium – reuse is the intent; a second polling mechanism would be a smell |
| S10 offline cache and its queueing constraint | Post-it queueing rides the existing offline boundary and must not widen it | Medium – `AGENTS.md` forbids widening offline scope beyond schedule reads and post-it queueing |
| `docs/UBIQUITOUS_LANGUAGE.md` | Fixes Activity, Round, Post-it, Vote, Poll and their synonyms-to-avoid | Low – already written; this feature should not invent terms |

## Open Questions

- Does deleting or archiving a whole **Conference** destroy collected Post-its and Votes? The
  Session-level answer is settled (refuse), but `conference → sessions` cascades today, so the same
  question one level up is currently answered by the schema rather than by a decision.
- Can a Facilitator edit a Round's prompt or a Poll's options after contributions exist? Editing a
  question after votes are cast changes what the tally means.
- Should an Attendee see *which* Rounds in a Session they have already contributed to when
  returning to it later, or only the currently open one?
- Area to revisit: how a Round reaches an Attendee's attention when they are not already looking at
  the Session – what would sharpen it is the REQ-005 push decision, which is unbuilt and whose
  delivery service is unchosen.

## Decisions Log

| Decision | Rationale | Date |
|---|---|---|
| First slice is Post-it Rounds plus Poll-purpose Voting Rounds | Proves the named/anonymous contrast end to end; PRODUCT.md makes a thin end-to-end slice the MVP principle | 2026-08-28 |
| A Vote is final once cast, until the Round closes | Lets the has-voted marker be stored with no link to the ballot – one-person-one-vote and unlinkability at once | 2026-08-28 |
| Rounds are authored ahead of the Session and opened/closed live | Matches Session Assignment authority; avoids authoring in front of a room | 2026-08-28 |
| Post-its are visible to everyone while the Round is open | It is the shared wall confApp replaces; the Board View later assumes it | 2026-08-28 |
| A Poll is a single choice among 2–N authored options | Simplest shape satisfying "a live question posed to the room"; trivially anonymous to store | 2026-08-28 |
| Free-text Poll answers rejected outright | Self-identifying in a company under a hundred; would undo the storage-level anonymity guarantee | 2026-08-28 |
| Any Conference Member may contribute to an open Round | Introduces no new concept and honours "attendance is not tracked" | 2026-08-28 |
| Poll tally live to the Facilitator, revealed to Attendees on close | Keeps the reveal moment without a partial tally anchoring undecided voters | 2026-08-28 |
| A Post-it syncing after its Round closed is accepted and flagged late | REQ-028 promises a typed Post-it is not lost; a wall is a record, not a race | 2026-08-28 |
| An author may edit and delete their own Post-it only while the Round is open | Covers typos; after close it is record, and removal becomes the Organizer's Discard | 2026-08-28 |
| Post-it Rounds may be reopened; Polls may not | A wall can take another idea; a revealed tally cannot be un-revealed | 2026-08-28 |
| Deleting a Session holding contributions is refused | The product exists so workshop output stops evaporating | 2026-08-28 |
| Post-its have a length cap and no per-attendee count cap | Capping ideas per person works against the contribution metric | 2026-08-28 |
