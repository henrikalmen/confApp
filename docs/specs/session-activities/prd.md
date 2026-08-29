# Product Requirements Document: Session Activities – Post-it Rounds and Polls

> **Source Trust**: trusted-local
> **Context**: `docs/ROADMAP.md` → Phase 3 MVP, milestone "Session activities (post-its, voting)". Backlog items REQ-010, REQ-013, REQ-014, REQ-017, REQ-018, REQ-019, REQ-028.
> **Related Assets**: `docs/UBIQUITOUS_LANGUAGE.md` (Activity, Post-it Round, Post-it, Voting Round, Vote, Poll, Board View – canonical terms and the synonyms to avoid); `docs/adrs/ADR-002-authenticate-with-google-workspace-oidc.md` (identity is the OIDC `sub`); `docs/adrs/ADR-003-postgresql-containerized-development.md` (portable PostgreSQL).

## Executive Summary

- **Problem**: A confApp Session is currently a schedule entry and nothing more. Workshop output still happens on physical post-its that get photographed and forgotten, and room sentiment is either unmeasured or gathered by show of hands – which is attributed, and therefore optimistic.
- **Vision**: A Session becomes a container that runs something. Facilitators author activities ahead of time and run them live; attendees contribute named ideas and cast genuinely anonymous votes from their phones; nothing typed is lost to venue wifi.
- **Target Users**: Presenter/Facilitator (runs the activity), Attendee (contributes), Admin/Organizer (authors activities on sessions they own). Leadership consumes the result later, downstream of this release.
- **Success Metrics**:
  - Share of attendees contributing at least one Post-it in a Workshop they attend.
  - Poll response rate per Session.
  - Share of Sessions running at least one Activity rather than being schedule-only.
  - Post-its lost to connectivity: zero.

### Capabilities at a Glance

- **FR1: Round authoring** _(Must / P0)_ – a Presenter/Facilitator adds Post-it Rounds and Poll Rounds to a Session they are assigned to.
- **FR2: Round lifecycle control** _(Must / P0)_ – opening, closing, and reopening a Round live, with reopening allowed for Post-it Rounds and refused for Polls.
- **FR3: Named Post-it contribution** _(Must / P0)_ – Attendees add Post-its that always show their author and appear for everyone near-live.
- **FR4: Anonymous Poll voting** _(Must / P0)_ – one final single-choice Vote per Member per Poll, unlinkable to the voter in storage.
- **FR5: Poll result reveal** _(Must / P0)_ – tally live to the Facilitator, revealed to Attendees when the Round closes.
- **FR6: Offline Post-it queueing** _(Should / P1)_ – a Post-it typed without a connection reaches the wall on reconnect, including after its Round closed.
- **FR7: Contribution-safe Session deletion** _(Must / P0)_ – deleting a Session that holds Post-its or Votes is refused.

### Scope Highlights

- **In scope**: Post-it Rounds; Voting Rounds of the Poll purpose only; live contribution from a phone; offline Post-it queueing; Facilitator run controls.
- **Out of scope**: Prioritization and Rating purposes; Workshop Groups; Post-it categorization and Discard; the projected Board View; the leadership Report; push notifications when a Round opens.
- **MVP boundary**: Both Activity kinds authored ahead, run live in a real Session at a real conference – author, open, contribute, close, see the result. Nothing downstream of collection.

### Key Constraints, Assumptions & Dependencies

- **Constraint**: Vote anonymity holds against every application path – no screen, response, export or report can associate a Vote with its voter, and a ballot carries no voter reference. It does **not** hold against direct database credentials (ADR-006).
- **Constraint**: Offline support must not widen beyond schedule reads and Post-it queueing (`AGENTS.md` → Do Not / Never).
- **Assumption**: Session attendance is deliberately not tracked, so an open Round is itself the gate on who may contribute.
- **Dependency**: Session Assignment (built) decides who may run a Round; Membership (built) decides who may contribute.

## Problem Definition

### Problem Statement

confApp can today put an Attendee in the right room at the right time, and nothing more. The
conference's actual output – the ideas a workshop generates and the sentiment a room holds – is
still produced on paper and in show-of-hands votes, then lost. A photographed post-it wall rarely
survives contact with the following week, and an attributed vote in front of colleagues skews
positive, so leadership receives either nothing or a flattering distortion. If this does not change,
confApp is a schedule viewer and the north star it was built for – a structured record leadership
can act on – is unreachable, because there is no structured record to produce.

### Evidence & Context

- `docs/PRODUCT.md` → Problem: "Workshop output is lost. Brainstorming happens on physical
  post-its. Someone photographs the wall, and the ideas rarely survive contact with the following
  week."
- `docs/PRODUCT.md` → Value: "Leadership gets an honest sentiment signal, because voting is
  anonymous by construction rather than by policy." Anonymity is the mechanism, not a nicety.
- The three themes downstream of this one – Facilitator board view, categorization, and the Report –
  all consume Post-its and Vote results. None can start until something collects them.
- Conference venue wifi is unreliable, which is why partial offline support exists at all. A lost
  idea is unrecoverable in a way a delayed one is not.

## Scope

### In Scope

- Post-it Rounds as an Activity on a Session: authored ahead, opened and closed live, collecting
  named Post-its.
- Voting Rounds of the **Poll** purpose: a question with 2–N authored options, one anonymous
  single-choice Vote per Member.
- Live contribution from a phone, with Post-its visible to all participants as they arrive.
- Offline queueing of a typed Post-it, including one that syncs after its Round has closed.
- Facilitator in-session controls: open, close, and reopen.
- Poll tallies: live to the Facilitator, revealed to Attendees on close.
- Refusing deletion of a Session that already holds contributions.

### Out of Scope

- **Prioritization and Rating** Voting Round purposes – each is its own later slice.
- **Workshop Groups** – a Workshop's Rounds are conference-wide in this release.
- **Post-it categorization and Discard** – the Organizer's sorting pass consumes what this release
  collects and is specified separately.
- **The projected Board View** – a third client surface with its own concerns.
- **The leadership Report** – downstream of categorization.
- **Push notification when a Round opens** – REQ-005 is unbuilt and its delivery service unchosen;
  near-live in-app propagation is the primary channel.
- **Free-text answers on a Voting Round** – rejected outright rather than deferred; see Decisions
  Log and `docs/OUT-OF-SCOPE.md`.

### MVP Boundary

Post-it Rounds and Poll Rounds, both authored ahead and run live in a real Session at a real
conference. It proves the whole loop for both Activity kinds and therefore proves confApp's
load-bearing distinction – named ideas, anonymous sentiment – end to end. Everything downstream of
collection is excluded.

## Functional Requirements

### User Stories

| ID | Story | Acceptance Criteria | Priority |
|----|-------|---------------------|----------|
| US01 | As a Facilitator, I want to author a Round's prompt before the Session, so that I am not typing in front of a room | A Round can be created on an assigned Session ahead of time and exists closed until opened | Must / P0 |
| US02 | As a Facilitator, I want to open and close a Round live, so that contribution happens when the activity happens | Opening admits contributions; closing refuses them at the API, not only in the UI | Must / P0 |
| US03 | As an Attendee, I want to add Post-its under my own name and see everyone else's appear, so that ideas build on each other | A contributed Post-it shows its author everywhere it appears and reaches other devices within seconds | Must / P0 |
| US04 | As an Attendee, I want to fix my own Post-it, so that a typo under my name does not put me off contributing | The author can edit and delete their own Post-it while the Round is open, and neither after it closes | Must / P0 |
| US05 | As an Attendee, I want to answer a Poll without anyone tracing the answer to me, so that I answer honestly | No stored data joins a Vote to the Member who cast it, and no application query can reconstruct the link (scoped by ADR-006) | Must / P0 |
| US06 | As an Attendee, I want to know my vote registered, so that I do not vote twice or assume it failed | After voting, the Attendee's own view says so; a second attempt is refused without revealing the tally | Must / P0 |
| US07 | As a Facilitator, I want to watch the tally while the Poll runs, so that I know when the room has finished | The tally updates for the Facilitator while the Round is open and is not visible to Attendees until close | Must / P0 |
| US08 | As an Attendee, I want to see the result once voting ends, so that the poll feels worth answering | On close, the tally becomes visible to every Member | Must / P0 |
| US09 | As an Attendee, I want a Post-it I typed with no signal to reach the wall when my connection returns, so that a dead spot does not cost me my idea | A queued Post-it syncs on reconnect and is accepted even if its Round has since closed | Should / P1 |
| US10 | As an Organizer, I want a Session holding collected output to resist deletion, so that a wall of named ideas cannot vanish on one confirmation | Deleting such a Session is refused, naming what would be lost | Must / P0 |
| US11 | As an Attendee, I want to come back to a Session later and still read what it produced, so that the ideas outlive the twenty minutes the activity ran | Every Round in the Session is listed with its own state; walls stay readable and closed Polls show their result | Must / P0 |

### Feature Specifications

#### FR1: Round authoring

**Description**: A Presenter/Facilitator or Admin adds Activities to a Session: a Post-it Round with
a prompt, or a Poll Round with a question and 2–N answer options. Rounds are created in the closed
state and belong to exactly one Session.

**Acceptance Criteria**:

- [ ] A Round can be created on a Session the actor holds a Session Assignment for, and is refused
      on one they do not.
- [ ] A Post-it Round carries a prompt; a Poll Round carries a question and at least two options.
- [ ] A newly created Round is closed and accepts no contributions.
- [ ] A Session may hold zero or more Rounds of each kind, in either order.
- [ ] A **Post-it Round's prompt stays editable at any time**, including after contributions exist –
      Post-its are free text and stand on their own, so clarifying the prompt mid-round does not
      change what has already been said.
- [ ] A **Poll's options are frozen once the first Vote is cast**, because ballots point at them.
      Before that first Vote they are freely editable.
- [ ] A Poll's question text is frozen on the same trigger as its options, since it is what a ballot
      is an answer to and the tally would otherwise become unverifiable after the fact.

**Inputs / Outputs**:

- **Inputs**: Session id; Round kind; prompt or question text; for a Poll, an ordered list of 2–N
  option labels.
- **Outputs**: A persisted Round in the closed state, visible on the Session to its Facilitator and,
  once the Conference is published, listed for Members without its contributions.

**Validation**:

- Prompt/question non-empty, trimmed, within a length cap.
- A Poll requires ≥2 options; option labels non-empty, trimmed, capped, and distinct within a Round.
- Round kind is one of exactly two known values, enforced at the storage layer as well as the API.

**Error Handling**:

- No Session Assignment → refusal naming the authority required; the Session stays readable.
- Fewer than two Poll options → field-level refusal; entered values preserved.
- Over-length text → field-level refusal naming the limit, before submission.

**Priority**: Must / P0

#### FR2: Round lifecycle control

**Description**: The Session's Presenter/Facilitator opens a Round when the activity starts and
closes it when it ends. A closed Post-it Round may be reopened; a closed Poll may not.

**Acceptance Criteria**:

- [ ] Opening a Round admits contributions from every Conference Member.
- [ ] Closing a Round refuses further contributions at the API, not only in the UI.
- [ ] A closed Post-it Round can be reopened and admits contributions again.
- [ ] A closed Poll cannot be reopened; the attempt is refused with the reason.
- [ ] More than one Round in a Session may be open at the same time.
- [ ] Only a holder of a Session Assignment for that Session may open, close, or reopen.

**Inputs / Outputs**:

- **Inputs**: Round id; the requested transition.
- **Outputs**: The Round's new state, propagated to participants near-live.

**Validation**:

- Transitions permitted: closed → open; open → closed; closed → open again for Post-it Rounds only.
- Authority checked server-side per transition.

**Error Handling**:

- Reopening a Poll → "A poll cannot be reopened once its results are shown."
- Transition by a non-assigned actor → refusal naming the authority required.
- Transition on a Round of an archived Conference → refused, consistent with the existing lifecycle.

**Priority**: Must / P0

#### FR3: Named Post-it contribution

**Description**: While a Post-it Round is open, any Conference Member may contribute Post-its. Every
Post-it carries its author's name wherever it appears. Contributions are visible to all participants
near-live. An author may edit or delete their own Post-it while the Round is open.

**Acceptance Criteria**:

- [ ] A contributed Post-it displays its author's name in every view that shows it.
- [ ] A Post-it reaches other participants' devices within seconds of being added.
- [ ] The author can edit and delete their own Post-it while the Round is open.
- [ ] After the Round closes, the author can do neither.
- [ ] A Member may contribute any number of Post-its to one Round.
- [ ] A contribution submitted live to a closed Round is refused. This is scoped to live
      submission: a Post-it composed while the Round was open and delayed by connectivity is
      accepted under FR6, which is the one deliberate exception.

**Inputs / Outputs**:

- **Inputs**: Round id; Post-it text; the author's identity from the session credential.
- **Outputs**: A persisted Post-it attributed to its author; the updated wall for all participants.

**Validation**:

- Text non-empty after trimming and within a length cap in the low hundreds of characters.
- No per-Member count limit.
- Author identity is taken from the authenticated credential, never from the request body.

**Error Handling**:

- Round closed → "This round is closed."; the prompt and existing Post-its stay readable.
- Over-length text → field-level refusal naming the limit; the typed text is preserved.
- Edit or delete attempted by anyone but the author → refused.
- Edit or delete after close → refused, naming that the round has ended.

**Priority**: Must / P0

#### FR4: Anonymous Poll voting

**Description**: While a Poll is open, each Conference Member may cast exactly one single-choice
Vote. The Vote is final. No stored data links a Vote to the Member who cast it.

**Acceptance Criteria**:

- [ ] A Member may cast exactly one Vote per Poll; a second attempt is refused.
- [ ] No **declared** column, constraint, index or application query path joins a Vote to its voter –
      asserted directly against the schema, not only against the screens.
- [ ] The has-voted fact and the ballot are recorded such that no application-reachable value
      relates them, including by any declared ordering or timestamp column.
- [ ] **Scoped by ADR-006**: the guarantee is bounded to application paths. PostgreSQL's MVCC system
      columns (`xmin`, `ctid`) correlate the two rows for a holder of direct database credentials,
      because they are written in one transaction. That residual is accepted and must be stated in
      the migration comment; no code, comment or document may claim it requires raw table access or
      elevated rights, because ordinary `SELECT` reaches it.
- [ ] A cast Vote cannot be changed or withdrawn while the Round is open.
- [ ] Voting in a closed Poll is refused.
- [ ] A Member who reinstalls the app is still recorded as having voted.

**Inputs / Outputs**:

- **Inputs**: Round id; the chosen option; the voter's identity, used only to establish eligibility
  and single-use, never stored against the ballot.
- **Outputs**: An anonymous ballot; an updated has-voted fact for that Member and Round.

**Validation**:

- Chosen option must belong to that Poll.
- Membership in the Conference is required; Session Assignment is not.
- Round must be open at the moment the Vote is received.

**Error Handling**:

- Already voted → "You have already voted in this round." No tally is revealed by the refusal.
- Round closed → refusal naming the state.
- Unknown option → refused.

**Priority**: Must / P0

#### FR5: Poll result reveal

**Description**: The Facilitator sees the tally build while the Poll is open. Attendees see nothing
of it until the Round closes, at which point it becomes visible to every Member.

**Acceptance Criteria**:

- [ ] While open, the tally is visible to a holder of the Session Assignment and to nobody else.
- [ ] An Attendee's view while open shows only whether they themselves have voted.
- [ ] On close, the tally becomes visible to every Conference Member.
- [ ] A Poll closed with zero Votes closes normally and reads zero rather than erroring.
- [ ] The tally is a count per option; it exposes no per-voter detail at any point.
- [ ] Returning to a Session later, a Member sees **every** Round it holds with that Round's own
      state – open or closed, contributed-to or not – with Post-it walls readable and closed Polls
      showing their result. The Session is a record of what happened in it, not only of what is
      happening now, and every Member sees the same list.

**Inputs / Outputs**:

- **Inputs**: Round id; the requesting actor's authority.
- **Outputs**: Counts per option, gated by Round state and actor.

**Validation**:

- Result requests for an open Poll from a non-assigned actor are refused rather than returning an
  empty tally, so absence is not itself a signal.

**Error Handling**:

- Attendee requests an open Poll's tally → refused, naming that results appear when voting ends.

**Priority**: Must / P0

#### FR6: Offline Post-it queueing

**Description**: A Post-it typed without a connection is held on the device and sent when
connectivity returns. It is accepted into its Round even if the Round closed in the meantime, and is
distinguishable as having arrived after close.

**Acceptance Criteria**:

- [ ] A Post-it composed offline is queued locally and shown as pending on that device.
- [ ] On reconnect it is sent and appears on the wall for everyone.
- [ ] It is accepted even when its Round has closed, and is marked as having arrived late – the
      deliberate exception to FR3's refusal of contributions to a closed Round, distinguished by
      having been composed offline while the Round was open.
- [ ] If the Round was reopened before it syncs, it is an ordinary contribution with no late marking.
- [ ] Nothing beyond schedule reads and Post-it queueing is made to work offline.
- [ ] **A retried send produces one Post-it, not two.** A queued item carries a submission identity
      generated when it was composed, and the API treats a repeat of the same identity as the same
      contribution. Without this, the retry loop below turns one ambiguous response into two
      identical Post-its on the wall under the same person's name.

**Inputs / Outputs**:

- **Inputs**: Post-it text composed while offline; the Round it was composed against.
- **Outputs**: A persisted Post-it, flagged late when applicable; the device's pending state cleared.

**Validation**:

- The same text validation as an online contribution, applied on arrival at the API.
- Queued items belong to the Member who composed them and are discarded on sign-out or user switch,
  consistent with the existing cache purge.

**Error Handling**:

- Send fails again → the item stays queued and pending; no data is discarded.
- Send outcome is ambiguous (request left the device, no response arrived) → the item is retried,
  and the repeat is recognised as the same contribution rather than a second one.
- The Round or Session no longer exists on arrival → the contribution is refused and the text
  surfaced to its author rather than silently dropped.

**Priority**: Should / P1

#### FR7: Contribution-safe Session deletion

**Description**: A Session that already holds Post-its or Votes cannot be deleted. The Organizer
edits or reschedules it instead.

**Acceptance Criteria**:

- [ ] Deleting a Session holding any Post-it or Vote is refused, naming what would be lost.
- [ ] Deleting a Session that has Rounds but no contributions succeeds, taking its Rounds with it.
- [ ] The refusal is enforced server-side, not only in the UI.
- [ ] **Deleting a whole Conference is *not* blocked** and still cascades to its Sessions, Rounds
      and contributions. Archiving is the intended "we are finished with this" path; deletion stays
      available for a Conference created in error. The guard is deliberately at Session level only.

**Inputs / Outputs**:

- **Inputs**: Session id.
- **Outputs**: Deletion, or a refusal naming the collected output.

**Validation**:

- Presence of any contribution under any Round of the Session blocks deletion.

**Error Handling**:

- Refusal message: names **what this Session actually holds** and cannot be deleted, with the edit
  and reschedule paths offered. The counts are part of the sentence, not decoration: US10's
  acceptance criterion is that the refusal names what would be lost, and a Session holding only
  ballots must not be told it has collected post-its.

  _Amended 2026-08-29._ This clause previously fixed one literal string - "This session has collected
  post-its or votes and cannot be deleted." - which cannot satisfy US10 for a Session whose only
  contributions are Votes. The shipped refusal in `api/src/sessions/session-deletion.ts` is
  parameterised for that reason; the code was right and this clause was stale. Recorded as
  `spec-stale` in `s05-contribution-safe-session-deletion.reconciliation-ledger.md` and amended on
  the owner's decision.

**Priority**: Must / P0

### User Flows

1. **Authoring** – a Facilitator opens a Session they are assigned to, adds a Post-it Round with a
   prompt and a Poll with a question and options. Both sit closed until the Session runs.
2. **Running a Post-it Round** – the Facilitator opens it; Members add Post-its that appear for
   everyone with their authors' names; the Facilitator closes it when the activity ends and may
   reopen it if the room has more to say.
3. **Running a Poll** – the Facilitator opens it; each Member casts one final Vote; the Facilitator
   watches the tally; on close the result is revealed to everyone and the Round is terminal.
4. **Offline contribution** – an Attendee types a Post-it in a dead spot; it queues; on reconnect it
   reaches the wall, marked late if the Round closed meanwhile.
5. **Refused deletion** – an Organizer tries to delete a Session that ran a workshop; the refusal
   names the collected output and offers editing instead.

### UI Wireframes

Not yet produced. Three surfaces need wireframing before implementation: the Attendee Round view
(contribute plus the live wall; the Poll's option list and voted state), the Facilitator run
controls (open/close/reopen and the live tally), and the Round authoring form beside the existing
Session editor. All must hold at 375 / 768 / 1280 px; the Attendee surfaces are phone-first and
one-handed.

### Data Requirements

- **Round** – belongs to one Session; kind (Post-it or Poll); prompt or question; open/closed state;
  for a Poll, an ordered set of options. Retained for the life of the Conference.
- **Post-it** – belongs to one Round; text; author identity (the OIDC `sub`, never the email);
  created and last-edited times; a late-arrival marker.
- **Vote** – belongs to one Round and one option. **Carries no voter reference of any kind.**
- **Has-voted fact** – that a Member has voted in a Round, recorded so that single-use can be
  enforced without any path from it to a ballot.
- Post-its and Votes are the input to the categorization and Report features and must outlive the
  Session's own editing; see FR7.

## Non-Functional Requirements

| Category | Requirement | Threshold / Target |
|----------|-------------|--------------------|
| Performance | A contribution reaches other participants' devices near-live | Visible to others within ~5s under normal venue conditions |
| Performance | A Session's Rounds arrive with the Session read | No per-Round request; one read returns a Session and its Rounds |
| Scalability | Concurrent contributors in one Round | Tens, not thousands – the company is under 100 employees |
| Reliability | A Post-it accepted by the API is never lost | Zero accepted-then-dropped contributions |
| Reliability | A Post-it typed offline survives app restart before sync | Survives process kill and relaunch |
| Security | Contribution authority is enforced server-side | Membership to contribute; Session Assignment to open/close/reopen; a closed Round refuses writes at the API |
| Security | Author identity is taken from the credential | Never accepted from the request body |
| Privacy | Vote anonymity holds against application paths | No declared column, constraint, index or application query relates a Vote to a Member; asserted against the schema, not the UI. The MVCC residual is accepted and stated (ADR-006), not tested for |
| Usability | Contribution surfaces are legible and one-handed | No horizontal body scroll at 375 / 768 / 1280 px; primary controls reachable one-handed at 375 px |
| Portability | Schema uses plain PostgreSQL | No provider-proprietary features (ADR-003) |
| Statelessness | No in-process state between requests | Round state and has-voted facts live in PostgreSQL |

## Edge Cases

| Scenario | Expected Behavior | Recovery Path |
|----------|-------------------|---------------|
| Member opens a Round that is not open | Prompt or question readable; contribution refused with the state named | Wait for the Facilitator to open it |
| Post-it added, then its Round closes | The Post-it stands; its author can no longer edit or delete it | Ask the Organizer to Discard it during sorting |
| Offline Post-it syncs after close | Accepted, flagged late, appears on the wall | None needed – the promise is kept |
| Offline Post-it syncs after the Round reopened | Ordinary contribution, no late flag | None needed |
| Member votes twice | Second Vote refused without revealing the tally | Their own view already shows they voted |
| Member votes, then reinstalls the app | Still recorded as having voted | None – the fact is server-side |
| Poll closed with zero Votes | Closes normally; tally reads zero | Author a new Poll if the question still needs asking |
| Facilitator tries to reopen a closed Poll | Refused, with the reason | Author a new Poll |
| Post-it Round reopened after Attendees saw it closed | Contribution resumes for everyone; no special state for prior contributors | None needed |
| Two Rounds open at once in one Session | Both accept contributions independently | None needed |
| Attendee deletes their only Post-it | The wall has one fewer; no trace that it existed | Retype it while the Round is open |
| Session holding contributions is deleted | Refused, naming what would be lost | Edit or reschedule the Session |
| Conference holding contributions is deleted | Permitted; cascades to every Session, Round and contribution | Archive instead when the intent is "finished with this" |
| Facilitator edits a Post-it prompt mid-round | Permitted at any time; existing Post-its stand | None needed |
| Facilitator edits Poll options after the first Vote | Refused; the ballots already point at them | Close the Poll and author a new one |
| Member returns to a Session days later | Sees every Round with its own state; closed Polls show results, walls stay readable | None needed |
| Session with Rounds but no contributions is deleted | Permitted; its Rounds go with it | None needed |
| Member leaves the Conference after contributing | Post-its keep their author's name; Votes are unaffected, being unlinkable | None needed |
| Non-assigned Facilitator tries to open a Round | Refused, naming the authority required | Ask an Admin for a Session Assignment |
| Two assigned Facilitators act on one Round | Both may act; last action wins, propagated near-live | Reopen if a close was premature (Post-it Rounds only) |

## Constraints & Assumptions

### Constraints

- **Vote anonymity is a hard constraint, scoped by ADR-006.** A Vote must be unlinkable to its voter
  through **every application path** – no API response, screen, export or report may associate them,
  and no declared column, constraint, index or query available to the application may relate them. A
  ballot carries no voter reference (`AGENTS.md`). The guarantee explicitly does **not** extend to a
  holder of direct database credentials: PostgreSQL's MVCC system columns correlate the ballot with
  the has-voted record written in the same transaction, and no schema design removes that while
  keeping the write atomic. See
  `docs/adrs/ADR-006-vote-anonymity-holds-against-application-paths-not-database-credentials.md`.
  **No document may claim that correlation requires raw table access or elevated rights** – ordinary
  `SELECT` suffices.
- **Post-its always carry the author's name.** The named/anonymous split is never blurred.
- **Offline support must not widen** beyond schedule reads and Post-it queueing (`AGENTS.md`).
- **No in-process state between requests** – the API scales across replicas with no sticky sessions.
- **Plain PostgreSQL only** – production hosting is undecided and portability is the reason
  (ADR-003).
- **Identity is the OIDC `sub`, never the email** (ADR-002).
- **Responsive from 375 px** – a fixed or desktop-only layout is a defect, not a follow-up.
- **Near-live is sufficient** – a few seconds of latency is acceptable; hard real-time is not
  warranted.

### Assumptions

- Session attendance is deliberately not tracked, so an open Round is itself the gate on who may
  contribute. Any Conference Member may contribute to any open Round.
- A company of under 100 employees bounds concurrency; a Round sees tens of contributors at most.
- Facilitators have their Session Assignments before the Session runs; assignment during the
  conference is already supported and needs nothing new here.
- Near-live propagation reuses the existing watermark-polling pattern rather than introducing a
  second mechanism.
- Rounds are authored while the Conference is in draft or published; no new lifecycle state is
  introduced for Activities beyond open/closed.
- **Assumed by convention, not decided**: deleting a Conference that holds contributions asks for
  confirmation naming what will be lost. The decision was that deletion stays *available*, not that
  it should be silent; a confirmation is the standard treatment for a destructive cascade and is
  cheap to drop if unwanted.
- **Interpretation to confirm**: a Poll's *question text* is frozen on the same trigger as its
  options. The decision named options explicitly; the question was not mentioned, and it is frozen
  here because a ballot is an answer to it and an edited question makes a closed tally
  unverifiable.

### Dependencies

| Dependency | Why It Matters |
|------------|----------------|
| `sessions` table and schedule composition (built) | Rounds attach to a Session; this adds children to an existing entity |
| Session Assignment (built) | Decides who may open, close, and reopen a Round |
| Membership via join code (built) | Decides who may contribute |
| Live schedule editing and its watermark polling (built) | The near-live propagation pattern this feature should reuse rather than reinvent |
| Offline schedule cache (built) | Post-it queueing rides the existing offline boundary and must not widen it |
| `docs/UBIQUITOUS_LANGUAGE.md` | Fixes the canonical terms; this feature introduces no new domain vocabulary |
| Categorization, Board View, Report (not built) | All consume what this release collects; their needs shape the data kept, not this release's behavior |

## Decisions Log

| Decision | Rationale | Alternatives Considered |
|----------|-----------|-------------------------|
| First slice is Post-it Rounds plus Poll-purpose Voting Rounds | Proves the named/anonymous contrast end to end; a thin end-to-end slice is the stated MVP principle | Adding Prioritization (couples to Post-its, doubles the surface); adding the Board View (a third client surface); the whole theme at once (long time to first real use) |
| A Vote is final once cast | Lets the has-voted fact be stored with no link to the ballot, giving one-person-one-vote and unlinkability from one decision | Changeable until close (needs a link or a device-held token that reinstall loses); withdraw-and-recast (a withdrawn ballot cannot be identified for removal) |
| Rounds are authored ahead and opened/closed live | Matches the existing Session Assignment authority model; authoring in front of a room is friction at the worst moment | Ad-hoc creation during the Session; supporting both creation paths |
| Post-its are visible to everyone while the Round is open | It is the shared wall confApp replaces; the Board View later assumes it | Hidden until close (avoids anchoring, loses the shared-wall feel); a per-round Facilitator setting (a mode every downstream surface must honour) |
| A Poll is a single choice among 2–N authored options | Simplest shape satisfying "a live question posed to the room"; a ballot is a Round plus an option, trivially anonymous | Multi-select; a rating scale (Rating is its own deferred purpose) |
| Free-text Poll answers rejected outright | Self-identifying in a company under 100 by content and writing style; would undo the storage-level guarantee. Named free text is what a Post-it Round is for | Allowing an optional comment alongside a choice – same defect, recorded in `docs/OUT-OF-SCOPE.md` |
| Any Conference Member may contribute to an open Round | Introduces no new concept and honours "attendance is not tracked"; the open Round is the gate | Session-scoped presence (invents attendance, strands late joiners); track or group scoping (depends on deferred work) |
| Poll tally live to the Facilitator, revealed to Attendees on close | Keeps the reveal moment without a partial tally anchoring undecided voters | Live to everyone (visible anchoring); Facilitator and Report only (no reason for an Attendee to believe their vote registered) |
| A queued Post-it carries a submission identity so a retry cannot duplicate it | A retry loop without one turns a lost response into the same named Post-it appearing twice; the offline promise is that a typed Post-it arrives, not that it may arrive more than once | Retrying without an identity (duplicates under a real name); giving up after one failure (breaks the no-loss promise) |
| A Post-it syncing after its Round closed is accepted, flagged late | The offline promise is that a typed Post-it is not lost; a wall is a record, not a race | Refuse but preserve the text (idea still misses the report); a grace window (an underivable duration plus a second refusal path) |
| An author may edit and delete their own Post-it only while the Round is open | Covers typos without letting the wall rewrite itself afterwards; after close removal is the Organizer's Discard | Delete-only while open; fully immutable once posted |
| Post-it Rounds may be reopened; Polls may not | A wall can always take another idea; a revealed tally cannot be un-revealed without advantaging later voters | Both reopenable (reintroduces anchoring); neither (a premature close is unrecoverable) |
| Deleting a Session holding contributions is refused | The product exists so workshop output stops evaporating; a cascade destroying named ideas contradicts that | Allow with a warning (irreversible loss one dialog away during a live event); delete the Session but orphan the output |
| Deleting a Conference is permitted and still cascades | Archiving is the intended path for a finished Conference; deletion stays available for one created in error. The contribution guard is deliberately at Session level only | Refusing deletion of a Conference holding output (consistent with the Session rule, but blocks a genuine mistake); permitting deletion only while in draft |
| A Post-it Round's prompt stays editable; a Poll's options freeze at the first Vote | Post-its are free text and stand on their own, so a clarified prompt changes nothing already said. Ballots point at options, so editing them after voting starts would make the tally mean something else | Freezing both once any contribution exists; leaving both editable always (a closed tally becomes unverifiable) |
| A Member sees every Round in a Session with its own state | The Session becomes a record of what happened in it, which is what the report later summarises; every Member sees the same list | Showing only the currently open Round (hides the session's history); showing open Rounds plus ones they joined (two attendees' views of one Session differ) |
| Post-its have a length cap and no per-attendee count cap | Capping ideas per person works against the contribution metric | A count cap; a Facilitator-set per-round maximum |
