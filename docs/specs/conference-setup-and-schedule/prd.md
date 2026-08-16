# Product Requirements Document: Conference Setup & Schedule

> **Source Trust**: trusted-local
> **Context**: Roadmap theme "Conference setup & schedule" (`docs/ROADMAP.md`, Phase 3 MVP). Requirements REQ-007, REQ-008, REQ-009, REQ-025, REQ-026, REQ-027, REQ-029, REQ-033 (`docs/PRODUCT-BACKLOG.md`).
> **Related Assets**: ADR-001 (Capacitor packaging), ADR-002 (Google Workspace OIDC, per-conference roles), ADR-003 (PostgreSQL). Domain terms per `docs/UBIQUITOUS_LANGUAGE.md`.


## Executive Summary

- **Problem**: The company runs internal conferences with no tooling. Attendees have no reliable answer to "where am I supposed to be right now", and organizers have no way to communicate a schedule that changes during the event. Everything depends on printed agendas and word of mouth.
- **Vision**: An organizer builds a conference and its schedule in confApp, publishes it, and every employee carries an accurate, current schedule on their phone – including when it changes mid-event.
- **Target Users**: Organizer (Admin), Presenter/Facilitator, Attendee.
- **Success Metrics**:
  - ≥95% of participating employees successfully join the conference before the first session ends.
  - Every material post-publish schedule change reaches the conference's attendees – as a push on the mobile shells, and in-app on the web build and after an offline period.
  - Schedule view renders in under 1 second at p95 on venue wifi.
  - An organizer completes setup unaided – zero developer involvement.

### Capabilities at a Glance

- **FR1: Conference Creation & Lifecycle** _(Must / P0)_ – create a conference of 1–4 days and move it through draft → published → archived.
- **FR2: Schedule Composition** _(Must / P0)_ – add, edit, and remove sessions with time, location, and kind.
- **FR3: Conference Access via Join Code** _(Must / P0)_ – employees join a published conference by entering its code.
- **FR4: Attendee Schedule View** _(Must / P0)_ – attendees see the schedule for each conference day.
- **FR5: Per-Conference Role Assignment** _(Must / P0)_ – the organizer assigns Admin and Presenter/Facilitator roles within a conference.
- **FR6: Conference Membership Management** _(Should / P1)_ – an attendee can leave a conference, and an Admin can remove one.
- **FR7: Live Schedule Changes & Notification** _(Should / P1)_ – the organizer edits a published schedule; the conference's attendees are notified.
- **FR8: Offline Schedule Access** _(Should / P1)_ – a previously loaded schedule remains readable without a network connection.
- **FR9: Conference Archive** _(Could / P2)_ – past conferences remain viewable after the event.

### Scope Highlights
- **In scope**: conference lifecycle, schedule composition with locations, join-by-code access, attendee schedule view, membership leave/removal, per-conference roles, live edits with notification, offline schedule reads.
- **Out of scope**: post-it rounds and voting rounds; workshop group formation and self-selection; the projected Board View; report generation. Each is a separate roadmap theme.
- **MVP boundary**: an organizer can build and publish a conference schedule, and every attendee can join by code and see what is happening, when, and where.

### Key Constraints, Assumptions & Dependencies
- *Constraint*: Sign-in is Google Workspace OIDC restricted to the company domain (ADR-002), so the join code selects a conference rather than authenticating a person.
- *Constraint*: The conference is a fixed-date event at an offsite venue with unreliable wifi; the schedule must survive a degraded network.
- *Assumption*: Workshop sessions appear on the schedule in this release, but splitting them into groups is delivered by the Workshop groups theme.
- *Dependency*: Push notification infrastructure (REQ-005) must exist before FR7 can notify attendees.


## Problem Definition

### Problem Statement

The company runs internal conferences of one to four days with no supporting tooling at all. The schedule lives in a document, a slide, or a printout. Four failures follow:

- **Attendees don't reliably know where to be.** With sessions in different rooms – and workshops splitting into parallel groups – a static printout is stale the moment anything moves.
- **Changes cannot be communicated.** Sessions overrun, speakers drop out, rooms get switched. Today the only channel is someone standing up and announcing it, which reaches whoever is in that room at that moment.
- **Every conference leaves no record.** Once the event is over the schedule is gone, so there is nothing to refer back to and nothing to build the next conference on.
- **The organizer becomes the bottleneck.** With no way to delegate, every question and every change routes through one person on a day when they are already running an event.

If nothing changes, confApp's later capabilities have nothing to attach to: post-it rounds, voting, and the leadership report all hang off a session that must first exist on a schedule.

### Evidence & Context

- The company has no incumbent tool; the alternative today is email, slides, and memory (`docs/PRODUCT.md`).
- Under 100 employees participate, so the scale problem is trivial and the reliability problem is not – the event happens on a fixed date that cannot move.
- This theme is the foundation of the Phase 3 MVP thin slice: every other theme depends on a Session existing.


## Scope

### In Scope

- Creating a conference with a name and a span of 1–4 consecutive days.
- Conference lifecycle: draft (organizer-only) → published (attendee-visible) → archived.
- Composing a schedule: sessions with title, description, kind, day, start and end time, and location.
- Marking a session as a Presentation or a Workshop.
- Optional Parallel Tracks – two or more Sessions scheduled at overlapping times.
- Generating a join code per conference; employees join by entering it.
- Attendee schedule view, per conference day.
- Leaving a conference, and Admin removal of a member.
- Assigning Admin and Presenter/Facilitator roles within a conference.
- Editing a published schedule and notifying attendees of material changes.
- Reading a previously loaded schedule offline.
- Viewing past conferences after they end.

### Out of Scope

- **Post-it Rounds and Voting Rounds** – the Session activities theme. Sessions exist here; what happens inside them does not.
- **Workshop Group formation and self-selection** – the Workshop groups theme.
- **The projected Board View** – the Facilitator & room experience theme.
- **Report generation** – the Insight & reporting theme.
- **The cross-conference archive experience** – the Multi-conference archive theme (Phase 4). The boundary: *archiving* a conference belongs here, because FR1's lifecycle requires an archived state and FR9 makes an archived conference's own schedule readable. Browsing **across** conferences, and reaching past **reports**, is Phase 4's and is not built here.
- **Session capacity limits and waitlists** – no evidence they are needed for an internal event where sessions are mostly sequential.
- **Room/resource booking** – a location is free text describing where to go, not a managed resource with availability.
- **Calendar integration** (Google Calendar export/sync) – plausible and deferred, not rejected.
- **Conference templating and cloning** (starting a new conference from a previous one's schedule) – the archive (FR9) preserves the record; reusing it as a template is deferred.
- **Attendee-to-attendee messaging or networking features.**

### MVP Boundary

The smallest release that solves the problem: an organizer creates a conference, adds sessions with times and locations, and publishes it; employees join with the code and see an accurate schedule on their phones. Offline reads, live-change notifications, and membership removal are the next increment – valuable, but the problem is already materially solved without them.


## Functional Requirements

### User Stories

| ID | Story | Acceptance Criteria | Priority |
|----|-------|---------------------|----------|
| US01 | As an Organizer, I want to create a conference spanning 1–4 days, so that there is a container for the schedule. | A conference exists with a name and a valid date span; spans outside 1–4 days are rejected. | Must / P0 |
| US02 | As an Organizer, I want to build the schedule before anyone sees it, so that attendees aren't confused by a half-finished schedule. | A draft conference is invisible to attendees; publishing makes it visible. | Must / P0 |
| US03 | As an Organizer, I want to add sessions with a time and a location, so that attendees know where to be. | A session records kind, day, start/end time, and location, and appears on the schedule in time order. | Must / P0 |
| US04 | As an Attendee, I want to join the conference with a code, so that I can see the schedule without being added by an admin. | Entering a valid code for a published conference grants access; invalid or draft codes are refused with a clear message. | Must / P0 |
| US05 | As an Attendee, I want to see what is happening on each day, so that I can be in the right place. | The schedule lists all sessions per day with time and location, ordered by start time. | Must / P0 |
| US06 | As an Organizer, I want to appoint presenters and facilitators, so that they can run their own sessions without full admin rights. | A role assigned to a user applies only within that conference. | Must / P0 |
| US07 | As an Attendee, I want to leave a conference I joined by mistake, so that I'm not left looking at the wrong schedule. | Leaving revokes access to that conference; the attendee can re-join with the code. | Should / P1 |
| US11 | As an Admin, I want to remove an attendee from my conference, so that someone who joined in error or shouldn't be there loses access. | An Admin removes a member; their access ends and their historical records remain. | Should / P1 |
| US08 | As an Organizer, I want to change a published schedule, so that the app stays accurate when the day slips. | An edit to a published session updates the attendee view and notifies the conference's attendees. | Should / P1 |
| US09 | As an Attendee, I want the schedule to work when the venue wifi fails, so that I can still find my next session. | A previously loaded schedule renders with no network, marked with its last-updated time. | Should / P1 |
| US10 | As Leadership, I want past conferences to remain viewable, so that I can refer back to what was run. | An archived conference remains readable and is visually distinguished from an active one. | Could / P2 |

### Feature Specifications

#### FR1: Conference Creation & Lifecycle

**Description**: An Organizer creates a conference and moves it through a defined lifecycle. States are **draft** (visible only to Organizers), **published** (joinable and visible to Attendees), and **archived** (read-only).

**Acceptance Criteria**:
- [ ] An Organizer can create a conference with a name and a start and end date.
- [ ] The span is between 1 and 4 consecutive days inclusive; anything else is rejected.
- [ ] A new conference begins in draft.
- [ ] Publishing requires at least one session to exist.
- [ ] A published conference can be edited – sessions, name, and date span (see FR7) – but cannot return to draft.
- [ ] A conference can be archived after its end date.
- [ ] Multiple conferences may exist; at most one is expected to be active at a time, but this is not enforced.

**Inputs / Outputs**:
- **Inputs**: conference name, start date, end date, lifecycle transitions.
- **Outputs**: a persisted Conference; a generated join code on publish (FR3).

**Validation**:
- Name is non-empty, trimmed, at most 120 characters.
- End date is on or after start date; span is 1–4 days.
- Publish is refused when the conference has zero sessions.

**Error Handling**:
- Invalid date span → the field is rejected inline with the permitted range stated.
- Publish attempt with no sessions → refused, explaining that a schedule is required.
- Archive before the end date → refused, with the earliest permitted date stated.

**Priority**: Must / P0

#### FR2: Schedule Composition

**Description**: An Organizer adds, edits, and removes Sessions within a conference's days. Session order is derived from start time, not set by hand.

**Acceptance Criteria**:
- [ ] A session records: title, optional description, kind (Presentation or Workshop), conference day, start time, end time, location, and zero or more assigned Presenters/Facilitators (FR5).
- [ ] Location is free text (e.g. "Main Hall", "Room 2") – not a managed bookable resource.
- [ ] A session must fall within a day belonging to its conference.
- [ ] End time is after start time.
- [ ] Sessions may overlap in time; overlap is permitted but surfaced to the Organizer as a warning, not an error, since parallel tracks are a supported option (REQ-029).
- [ ] Sessions render in start-time order within each day.
- [ ] Overlaps are shown as a persistent, recomputed indicator on the Organizer's schedule view, not only as a save-time warning – the pre-publish "review overlap warnings" step depends on it.
- [ ] Deleting the last remaining session of a published conference is refused; a published conference always has at least one session, mirroring the publish gate in FR1.
- [ ] Deleting a session in a published conference removes it from the attendee view immediately; the accompanying notification arrives with FR7.

**Inputs / Outputs**:
- **Inputs**: session fields; create, edit, delete actions.
- **Outputs**: persisted Sessions; an ordered schedule per conference day.

**Validation**:
- Title non-empty, at most 200 characters; location non-empty, at most 100 characters.
- Start and end times fall on the session's conference day. A session may not span midnight.
- Kind is exactly one of Presentation or Workshop.

**Error Handling**:
- End before start → rejected inline.
- Session outside the conference date span → rejected, naming the valid days.
- Overlapping session → saved, with a non-blocking warning naming the sessions it overlaps.

**Priority**: Must / P0

#### FR3: Conference Access via Join Code

**Description**: Each published conference has a join code. A signed-in employee enters the code to join as an Attendee.

**Acceptance Criteria**:
- [ ] A unique join code is generated when a conference is published.
- [ ] An authenticated employee entering a valid code joins the conference as an Attendee.
- [ ] A code for a draft or archived conference is refused, as is a code for any conference whose end date has passed – joinability ends with the conference, not with the (manual) archiving step.
- [ ] Codes are case-insensitive and avoid visually ambiguous characters.
- [ ] Re-entering a code for a conference already joined is a no-op, not an error.
- [ ] The Organizer can view and regenerate the code; regenerating does not remove existing Attendees.
- [ ] Regenerating invalidates the previous code immediately; it is refused like an unknown code thereafter.

**Inputs / Outputs**:
- **Inputs**: join code, authenticated user identity (`sub` claim).
- **Outputs**: an Attendee membership linking the user to the conference.

**Validation**:
- The code is not a security boundary. Sign-in already restricts access to the company Google Workspace domain (ADR-002); the code only selects *which* conference to join.
- Codes are unique across all conferences, including archived ones. A code circulated for a past conference must fail rather than silently resolve to a different one.

**Error Handling**:
- Unknown code → "No conference found with that code."
- Draft, archived, or ended conference → refused, naming the reason. Non-disclosure is deliberately *not* attempted: the code is not a security boundary (see Validation), and an unhelpful refusal on the morning of day one costs more than it protects.
- Repeated failed attempts → rate-limited to deter enumeration, without locking a legitimate employee out on the morning of day one. The limiter is keyed on the authenticated `sub`, never on client IP: the venue presents ~100 employees behind one NAT egress address at exactly the moment of peak joining, so an IP-keyed limiter would lock out the scenario this rule exists to protect. The counter is server-side state, not in-process (`AGENTS.md`).

**Priority**: Must / P0

#### FR4: Attendee Schedule View

**Description**: An Attendee sees the schedule of a conference they have joined, organized by day.

**Acceptance Criteria**:
- [ ] The schedule lists every session of the published conference for the selected day, in start-time order. Sessions have no publish state of their own; publication is a conference-level state (FR1).
- [ ] Where the Attendee has joined more than one conference, they select which conference's schedule to view; the conference currently running (or, failing that, the most recently joined) is the default.
- [ ] Each entry shows title, start and end time, location, and kind.
- [ ] Days are navigable; the current day is selected by default during the conference. Before the conference starts or after it ends, day 1 is selected.
- [ ] Sessions that overlap in time are visually marked as concurrent rather than stacked as a sequence, so an attendee can see that two things are happening at once. They are **not** presented as a choice to record – sessions are open (FR6).
- [ ] The currently running session is highlighted. Server time is authoritative while online; offline the device clock is used, corrected by the server–device offset recorded at the last successful sync.
- [ ] The view is legible on a phone held one-handed and rescales to tablet and desktop.

**Inputs / Outputs**:
- **Inputs**: conference membership, selected conference, selected day, current time.
- **Outputs**: rendered schedule.

**Validation**:
- Sessions are returned only for a joined conference that is published or archived.

**Error Handling**:
- Conference with no sessions on a day → an explicit empty state, not a blank screen.
- Fetch failure with cached data → an error state offering retry until FR8 lands; from FR8 onward, fall back to the cached schedule.
- Fetch failure with no cached data → an error state offering retry.

**Priority**: Must / P0

#### FR5: Per-Conference Role Assignment

**Description**: The Organizer assigns roles within a conference. Roles are confApp's own data, scoped to a single conference, and are never derived from directory groups (ADR-002).

**Acceptance Criteria**:
- [ ] Roles are Admin, Presenter/Facilitator, and Attendee. **Presenter/Facilitator is one role**, not two – per REQ-025, ADR-002, and `docs/UBIQUITOUS_LANGUAGE.md`. The two words describe what the holder is doing, not different permissions.
- [ ] A role assignment applies only to the conference it was granted in.
- [ ] A user may hold different roles in different conferences.
- [ ] An Admin assigns a Presenter/Facilitator to one or more specific Sessions in the conference; a Session may have zero or more of them.
- [ ] A Presenter/Facilitator may edit only the sessions assigned to them, not the conference or other sessions.
- [ ] Everyone who joins is an Attendee; other roles are additive.
- [ ] Any authenticated employee may create a conference, and the creator becomes its first Admin. There is no instance-level permission to hold or seed.
- [ ] An Admin may grant Admin or Presenter/Facilitator to any member of their conference, and may revoke either.
- [ ] A conference always has at least one Admin; removing the last one is refused.
- [ ] A role assignment can be revoked, subject to the last-Admin rule.
- [ ] Assignment is keyed on the user's stable `sub` claim, not email.

**Inputs / Outputs**:
- **Inputs**: target user, role, conference, optional session scope (for Presenter/Facilitator), assign or revoke action.
- **Outputs**: a role assignment record; session assignments for Presenters/Facilitators.

**Validation**:
- The target user must have signed in at least once to be assignable.
- Roles cannot be assigned on an archived conference.

**Error Handling**:
- Removing the last Admin → refused, explaining why.
- Assigning a user who has never signed in → refused, explaining that they must sign in first.

**Priority**: Must / P0

#### FR6: Conference Membership Management

**Description**: An Attendee can leave a conference they joined, and an Admin can remove an Attendee from one. Membership is otherwise created by FR3 and never expires.

> **Note**: attendees do **not** choose between concurrently scheduled Sessions. Sessions are open – an attendee simply attends or does not, and nothing is recorded. The only participation choice in confApp is selecting a **Group** within a Workshop, which belongs to the Workshop groups theme. There is consequently no personal agenda, no session selection, and no overlap-grouping rule at this level.

**Acceptance Criteria**:
- [ ] An Attendee can leave a conference they have joined.
- [ ] An Admin can remove any Attendee from their conference.
- [ ] Leaving or being removed revokes access to that conference's schedule; the user may re-join with the code unless the conference is archived.
- [ ] Removal does not delete historical records of what the user did in the conference – only their membership and access.
- [ ] An Admin cannot remove themselves while they are the last Admin (FR5's last-Admin rule).
- [ ] Leaving is confirmed before it takes effect, so it is not triggered by a mis-tap during a session.

**Inputs / Outputs**:
- **Inputs**: conference, acting user, target user (for Admin removal).
- **Outputs**: the membership record is revoked.

**Validation**:
- Only an Admin of that conference may remove another user.
- Membership cannot be changed on an archived conference.

**Error Handling**:
- Last Admin attempting to leave → refused, explaining that another Admin must be appointed first.
- Removing a user who is not a member → treated as a no-op, not an error.

**Priority**: Should / P1

#### FR7: Live Schedule Changes & Notification

**Description**: An Organizer edits a published schedule; the conference's Attendees are notified of material changes.

**Acceptance Criteria**:
- [ ] All session fields – title, description, kind, conference day, start/end time, location, presenter assignment – may be changed after publish, and sessions may be added or deleted. (The earlier narrower list was inconsistent with this FR's own rule that a session cannot be *moved* outside the conference date span, which presupposes the day is editable.)
- [ ] The conference name and date span are also editable after publish; shortening the span is refused while sessions fall outside it.
- [ ] A change to a session notifies **every Attendee of that conference**. Because sessions are open and nothing records who intends to attend which (FR6), there is no smaller "affected" set to target at this level.
- [ ] Because every change reaches everyone, notification volume is a real risk: changes are debounced per session (below), and trivial edits (description or typo corrections) do not notify at all. Only time, location, day, title, and deletion do.
- [ ] Push reaches the Android and iOS shells via native APNs/FCM (ADR-001); web push is never used, so browser-only attendees see the change in-app rather than as a push.
- [ ] The notification names the session and what changed.
- [ ] The attendee schedule view reflects changes within the near-live window (a few seconds).
- [ ] Changes are recorded with a timestamp so the view can show when it last updated.
- [ ] Bulk or rapid successive edits do not produce a notification per keystroke – notifications are debounced per session.

**Inputs / Outputs**:
- **Inputs**: session edits, and conference name/date-span edits, on a published conference.
- **Outputs**: updated sessions; push notifications to the conference's attendees.

**Validation**:
- Same validation as FR2.
- A session cannot be moved outside the conference date span.

**Error Handling**:
- Push delivery failure → the schedule change still persists; delivery is retried and never blocks the edit.
- An attendee with notifications disabled → the change is still visible in-app; no error is surfaced.

**Priority**: Should / P1

**Dependency**: requires push notification infrastructure (REQ-005) – which is *not* on the Phase 3 success criteria in `docs/ROADMAP.md` and whose delivery service is still open in `docs/DECISIONS.md` → Pending. Both must be closed before FR7 can be planned. The schedule edit itself has no such dependency and can ship without notification.

#### FR8: Offline Schedule Access

**Description**: A schedule previously loaded on a device remains readable without a network connection.

**Acceptance Criteria**:
- [ ] The most recently loaded schedule renders with no connectivity.
- [ ] The schedule is cached at join time, so joining online is sufficient to make the conference available offline – an attendee never has to remember to open the schedule while connected.
- [ ] On reconnect, changes since the cached timestamp are surfaced in-app as a "what changed" summary. This is the only channel that reaches an attendee who was offline while the schedule moved – push (FR7) was undeliverable to them.
- [ ] Cached data is cleared on sign-out and when a different user signs in on the same device.
- [ ] The view states that it is showing cached data and when it was last updated.
- [ ] The cache refreshes automatically when connectivity returns.
- [ ] Offline scope is read-only – no schedule editing, joining, or leaving offline.
- [ ] An attendee who has never loaded the conference online sees an explicit "not available offline" state.

**Inputs / Outputs**:
- **Inputs**: cached schedule data, connectivity state.
- **Outputs**: rendered schedule with a staleness indicator.

**Validation**:
- Cached data is scoped per conference and per user.

**Error Handling**:
- Cache miss offline → explicit empty state explaining a connection is needed once.
- Stale cache → shown with its age rather than withheld.

**Priority**: Should / P1

#### FR9: Conference Archive

**Description**: An archived conference's own schedule remains readable after the event. This is the lifecycle consequence of FR1's archived state, not the cross-conference archive experience – browsing across conferences and reaching past reports belongs to the Multi-conference archive theme (Phase 4). Scope boundary: this covers **one conference's own schedule** staying readable. Browsing across conferences over time, and the archive of Reports, belong to the separate Multi-conference archive theme (`docs/PRODUCT.md`, `docs/ROADMAP.md` Phase 4).

**Acceptance Criteria**:
- [ ] An archived conference's schedule remains viewable by those who joined it.
- [ ] Archived conferences are visually distinguished from active ones.
- [ ] Archived conferences cannot be edited or joined.
- [ ] Archiving does not delete any data.

**Inputs / Outputs**:
- **Inputs**: conference, archive action.
- **Outputs**: read-only conference view.

**Validation**:
- Only **published** conferences past their end date may be archived – a draft never became visible to anyone, so archiving one would produce a record with no join code and no viewers.

**Error Handling**:
- Edit attempt on an archived conference → refused with a clear explanation.

**Priority**: Could / P2

### User Flows

1. **Organizer builds a conference**: create conference → add days' sessions with times and locations → assign presenters/facilitators → review overlap warnings → publish → share the join code.
2. **Attendee joins and orients**: sign in with company Google account → enter join code → see the schedule for day 1 → navigate days to see what is on.
3. **Schedule slips mid-conference**: Organizer moves a session → the conference's attendees receive a push notification → the schedule reflects the new time within seconds.
4. **Venue wifi fails**: attendee opens the app → cached schedule renders with a last-updated timestamp → connectivity returns → cache refreshes silently.
5. **Failure – bad code**: attendee enters an unknown or draft-conference code → refused with a clear message and the option to retry.

### Data Requirements

- **Conference** – name, start date, end date, lifecycle state, join code (absent until published, FR3).
- **Conference Day** – derived from the conference date span; the anchor sessions attach to.
- **Session** – title, description, kind (Presentation | Workshop), day, start time, end time, location, last-updated timestamp (FR7; also the basis for detecting a concurrent overwrite).
- **Membership** – links a user (`sub` claim) to a conference; the fact of joining.
- **Role Assignment** – user, conference, role. Scoped per conference, never derived from a directory.
- **Session Assignment** – links a Presenter/Facilitator role assignment to the Sessions they may run and edit.
- No entity records which Sessions an Attendee attended. Sessions are open and attendance is not tracked (FR6).
- Data is retained after a conference is archived; archiving deletes nothing. Leaving or being removed (FR6) revokes Membership without deleting historical records.


## Non-Functional Requirements

| Category | Requirement | Threshold / Target |
|----------|-------------|--------------------|
| Performance | Schedule view renders on a phone over venue wifi | p95 < 1s, **excluding serverless cold start** |
| Performance | API is warm during conference hours | No attendee-facing request pays a cold start across the conference date span (pre-warm or equivalent) |
| Performance | Published schedule changes reach attendee devices | Within ~5s (near-live per `docs/DECISIONS.md`) |
| Capacity | Concurrent attendees during a session boundary | 100 concurrent, still meeting the p95 < 1s render target |
| Reliability | Schedule readable when the venue network is unavailable | A schedule loaded at least once always renders (FR8; a never-loaded conference is explicitly out) |
| Reliability | Availability during conference hours | No planned downtime across the conference date span |
| Security | Access restricted to the company Google Workspace domain | `hd` claim verified server-side on every request (ADR-002) |
| Security | Join code resists enumeration | Rate-limited attempts; code is not the security boundary |
| Usability | Schedule legible one-handed on a phone | Readable at 375px width without horizontal scroll |
| Usability | Responsive across targets | Verified at 375px / 768px / 1280px per `AGENTS.md` |
| Portability | Database features used | Plain PostgreSQL only, no provider-specific extensions (ADR-003) |

Rows sourced from a P1 requirement (the ~5s propagation row and the offline-readability row) apply from the increment that delivers FR7/FR8, not to the P0 MVP – the MVP boundary defers both.


## Edge Cases

| Scenario | Expected Behavior | Recovery Path |
|----------|-------------------|---------------|
| Organizer publishes a conference with no sessions | Publish is refused | Add at least one session, then publish |
| Conference dates shortened after publish, orphaning sessions | Refused while sessions fall outside the new span | Move or delete the affected sessions first |
| Session deleted after publish | Removed from the schedule; attendees notified (FR7) | None – the schedule is the single source of truth |
| Attendee leaves, then re-enters the join code | Re-joins normally; no trace of having left | None needed |
| Admin removes an attendee who is mid-session | Access ends at the next request; no live eviction | Attendee re-joins with the code if it was a mistake |
| Last Admin tries to leave the conference | Refused | Appoint another Admin, then leave |
| Two sessions accidentally overlap when sequential was intended | Saved with a non-blocking overlap warning to the Organizer | Organizer adjusts times; overlap warning clears |
| Attendee enters a code for a draft conference | Refused | Wait for publication, or contact the organizer |
| Attendee opens the app offline having never loaded the conference | Explicit "not available offline" state | Connect once; the schedule then caches |
| Attendee joins mid-conference on day 3 | Full schedule visible, current day selected by default | None needed |
| Employee leaves the company mid-conference | Google sign-in fails at next token refresh; access ends | None – deprovisioning in Workspace is authoritative |
| Last Admin removes their own Admin role | Refused | Appoint another Admin first |
| Two conferences published simultaneously | Both joinable; attendee selects by code | None – permitted, if unusual |
| Push notification fails to deliver a schedule change | Change persists and is visible in-app | Delivery retried; the in-app view as of its last successful sync is the source of truth |
| Device timezone differs from the venue's | Times still display as authored – naive wall clock, no conversion – so the app agrees with the printed schedule | None needed |
| Device clock is wrong around a session boundary | "Currently running" is computed against the same naive wall-clock frame; a badly wrong device clock mis-highlights the current session but never changes the times shown | None needed – the displayed times remain correct |
| Two Admins edit the same session at once | The second save is refused when the session's last-updated timestamp has moved; the editor is shown the newer version | Re-apply the edit on top of the current version |
| One Admin archives or publishes while another is mid-edit | The lifecycle transition wins; the in-flight edit is refused with the new state named | Re-open the conference in its current state |
| Attendee is offline for the whole window in which a session moves | Push is undeliverable; on reconnect the change appears in the "what changed" summary (FR8) | None needed – the summary is the fallback channel |


## Constraints & Assumptions

### Constraints

- Sign-in is Google Workspace OIDC restricted to the company domain (ADR-002). Attendee identity is the `sub` claim; email is display data only.
- Roles are confApp's own per-conference data and are never derived from directory groups (ADR-002).
- The client is a React SPA packaged with Capacitor for Android and iOS (ADR-001); all three surfaces share one codebase.
- Persistence is plain PostgreSQL with no provider-specific features, because production hosting is a deferred phase-2 decision (ADR-003).
- Updates are near-live – a few seconds of latency is acceptable, and hard real-time infrastructure is out of scope (`docs/DECISIONS.md`).
- The conference is a fixed-date offsite event; venue wifi is assumed unreliable.
- Employee data falls under GDPR (`docs/PRODUCT.md` → Strategic Constraints). This theme's personal data is limited to Membership and Role Assignment – who joined a conference and what they were allowed to do in it. Because attendance is not tracked (FR6), no record exists of which sessions an individual attended, which keeps this theme's privacy surface small.
- **No retention limit is set.** Conference records are kept indefinitely; nothing expires or is auto-deleted. This is a deliberate decision – the archive's value is that it does not decay. Note that this governs *automatic* deletion only: GDPR erasure rights are unaffected, so the data must still be deletable on request even though nothing deletes it on a schedule.
- Session times are **naive wall-clock values** – stored and displayed without timezone conversion. A session at 09:00 reads as 09:00 on every device regardless of its timezone setting.

### Assumptions

- Under 100 employees participate, so scale is not a design driver; reliability on the day is.
- Sessions are mostly sequential; parallel tracks are the exception and are a display concern only, since attendees are not asked to choose between them.
- Everyone is physically at the same venue, which is what makes naive wall-clock times safe: there is one clock in the room and the app agrees with it. This assumption breaks if confApp is ever used for a remote or multi-site conference.
- A location is a human-readable label ("Main Hall"), not a bookable resource with availability.
- Sessions do not span midnight – a 1–4 day internal conference has no overnight sessions.
- Workshop sessions appear on the schedule here; splitting them into Groups arrives with the Workshop groups theme, and this PRD does not constrain how that will work beyond a Session existing.
- Every participant has a company Google account and a smartphone.

### Dependencies

| Dependency | Why It Matters |
|------------|----------------|
| Push notification infrastructure (REQ-005) | FR7 cannot notify attendees of schedule changes without it |
| Google Workspace OIDC sign-in (ADR-002) | Every requirement here assumes an authenticated, domain-verified employee |
| PostgreSQL schema and access layer (ADR-003) | All entities in Data Requirements persist through it |
| Workshop groups theme | Consumes the Session created here; not required for this PRD to ship |


## Decisions Log

| Decision | Rationale | Alternatives Considered |
|----------|-----------|-------------------------|
| Sessions carry a location | "Where am I supposed to be" is the core attendee question, and parallel workshop groups make it unanswerable without one | Single-venue assumption; optional free-text note |
| Location is free text, not a managed resource | An internal conference of under 100 people does not need room booking or availability | Bookable room entities with capacity |
| Draft → published lifecycle | Prevents attendees seeing half-built schedules and asking about sessions that get deleted | Always-visible as built; per-day publishing |
| Publish requires at least one session | An empty published conference is never intentional | Allow publishing empty conferences |
| Join by conference code | Chosen by the user over automatic access. Low overhead, and the code selects a conference rather than granting authority | Automatic access for any company account; explicit invitation lists |
| The join code is not a security boundary | Google Workspace sign-in already restricts to company employees, so the code need only be unguessable enough to deter idle enumeration. **Consequence, stated deliberately**: there is no confidentiality between conferences within the company – any employee holding any code can join any conference, so a leadership-only or department-only conference cannot be kept private under this model | Treating the code as a secret with expiry and revocation |
| Attendees do not choose between concurrent sessions | Sessions are open – people attend or don't, and nothing is recorded. The only participation choice in confApp is the Workshop Group, which belongs to another theme. Removes the personal agenda, session selection, and any overlap-grouping rule from this PRD | A personal agenda built from per-session selection; grouping overlapping sessions as mutually exclusive alternatives |
| Session times are naive wall-clock, with no timezone conversion | Everyone is physically at one venue, so the app should agree with the printed sign on the door rather than with each device's timezone setting | Storing UTC and converting to device time; storing a venue timezone per conference |
| Schedule-change notifications go to every attendee | With no record of who intends to attend what, there is no smaller affected set. Volume is controlled by debouncing and by not notifying on trivial edits | Targeting attendees by agenda membership – impossible once attendance is untracked |
| Any employee may create a conference and becomes its first Admin | Under 100 people, internal, and drafts are invisible until published, so a stray conference harms nobody. Avoids inventing an instance-level permission that would itself need seeding | An app-level Organizer group; creation rights inherited from holding Admin elsewhere |
| An Admin may promote members to Admin or Presenter/Facilitator | Keeps the organizer from being a bottleneck without introducing any authority above the conference | Only the creator may assign roles |
| Attendees may leave and Admins may remove members | Two conferences can be joinable at once, so joining the wrong one is reachable; without removal it was a permanent dead end | Attendee self-service only; deferring removal entirely |
| The p95 render target excludes serverless cold start, with the API kept warm during the conference | The first attendee each morning would otherwise absorb a cold Function and see the app as slow at the worst moment | Counting cold start in the p95; accepting cold starts unmitigated |
| No data retention limit | The archive is meant to persist; an expiry would erode the record confApp exists to create. Personal data here is only membership and role, and erasure on request remains available regardless | A fixed retention window with automatic deletion |
| Live edits permitted, with attendees notified | Conferences slip; a schedule that cannot change is wrong by mid-morning of day one | Frozen after publish; live edits without notification |
| Notification volume is controlled by debouncing and by ignoring trivial edits, not by targeting | Every attendee is notified since attendance is untracked, so restraint has to come from *what* triggers a notification rather than *who* receives it | Targeting by agenda membership; notifying on every field change |
| Overlap is a warning, not an error | Parallel tracks are a supported option, so overlap cannot be prohibited – but accidental overlap is the more common case | Prohibit overlap; allow silently |
| Parallel tracks are a display concern, not a capability | Since attendees make no session choice, supporting parallel tracks means showing concurrency clearly – there is nothing further to build | Treating parallel tracks as a selection feature |
| Offline is read-only | Offline editing would require conflict resolution, an explicit anti-goal in `docs/PRODUCT.md` | Offline edits with sync reconciliation |
| Calendar integration excluded | No evidence of need; adds an external integration to an MVP that does not require it | Google Calendar export or two-way sync |
