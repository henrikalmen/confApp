# S02 – Named Post-it Contribution

**Plan**: docs/specs/session-activities/plan.json
**Story-ID**: S02

## Feature Overview and Goal

> **Superseded terminology, 2026-08-29 (ADR-007).** Every `round.activity_watermark_at` and `activityWatermarkAt` below refers to what is now **`round.activity_watermark`** - a `bigint` defaulted from one global sequence, not a timestamp (`db/migrations/20260829120000000_activity-watermark-counter.sql`). Two further facts this story's text predates: the cursor's writers are now the `post_it` trigger, the `round` trigger and S03's `round_option` trigger - **the ballot table is deliberately not one**, per ADR-007 - and the `round` trigger's `WHEN` clause is no longer a column allow-list but its inversion, `WHEN (OLD.activity_watermark IS NOT DISTINCT FROM NEW.activity_watermark)`, so a column added later is inside the rule by construction (`db/migrations/20260901120000000_round-watermark-when-inversion.sql`). **The wording below is left as the record of what this story specified and built.**

**Intent**: A Post-it Round is only worth running if the ideas land on a shared board while the room is still talking – so a Conference Member must be able to put a named idea up from their phone and watch everyone else's arrive, and correct their own typo without asking anyone.

**Expected Outcomes** (scenarios anchor to these via `[OC<NN>]`):

- [OC01] A Conference Member contributes a Post-it to an **open** Post-it Round and it appears on every other participant's open Session view within a few seconds, with **no manual reload**, carrying the author's name – which is taken from the authenticated credential and from nowhere else.
- [OC02] The author, and only the author, can correct or remove their own Post-it while the Round is open; after it closes neither is offered nor accepted, someone else's Post-it is never editable, and a Facilitator clarifying the Round's prompt – permitted at any time, contributions present or not – leaves every existing Post-it exactly as its author wrote it.
- [OC03] A live contribution to a closed Round is refused **at the API**, naming the state, and every refusal – closed, over-length, blank – leaves the typed text on screen and nothing in the database.
- [OC04] A Member returning to the Session later reads the whole board of a closed Round, every Post-it still under its author's name.


## Required Context

- `docs/specs/session-activities/prd.md#fr3-named-post-it-contribution` – the contract this FIS implements: six acceptance criteria, the inputs/outputs, the validation rules and the four error-handling rules. **Binding Constraint (FR3)**: "Author identity is taken from the authenticated credential, never from the request body." This is the load-bearing rule of the story – read it there, do not work from a restatement.
- `docs/specs/session-activities/prd.md#constraints` – **Binding Constraints**, applied unnarrowed: (FR1) "**Plain PostgreSQL only** – production hosting is undecided and portability is the reason (ADR-003)"; (FR2) "**No in-process state between requests** – the API scales across replicas with no sticky sessions"; (FR6) "**Offline support must not widen** beyond schedule reads and Post-it queueing (`AGENTS.md`)" – S04 owns the queueing half, so this story widens nothing at all. The same section carries "**Post-its always carry the author's name**" and, for its sibling story, "Vote anonymity is a hard, storage-level constraint" – the named and the anonymous path are never blurred, and nothing built here may be reused as a template for S03's ballot.
- `docs/specs/session-activities/prd.md#fr1-round-authoring` – one criterion of FR1 lands in *this* story and nowhere else: "A **Post-it Round's prompt stays editable at any time**, including after contributions exist". S01 owns the edit route but ships no Post-its, so the "contributions exist" half is unprovable there. The matching `#edge-cases` row ("Facilitator edits a Post-it prompt mid-round → Permitted at any time; existing Post-its stand") is the observable this story must assert.
- `docs/specs/session-activities/prd.md#user-stories` – rows **US03** (add under my own name and see everyone else's appear), **US04** (fix my own Post-it) and **US11** (come back later and still read what the Session produced) are this story's acceptance rows.
- `docs/specs/session-activities/prd.md#non-functional-requirements` – the four rows this story is measured by: propagation "visible to others within ~5s"; "**No per-Round request** – one read returns a Session and its Rounds"; contribution authority enforced server-side (Membership to contribute; a closed Round refuses writes at the API); and "no horizontal body scroll at 375 / 768 / 1280 px; primary controls reachable one-handed at 375 px".
- `docs/specs/session-activities/prd.md#edge-cases` – four rows bind here: a Post-it added then its Round closes **stands** and stops being editable; an Attendee deleting their only Post-it leaves **no trace that it existed**; a reopened Round resumes contribution for everyone with no special state for prior contributors; a Member returning days later sees every Round with its own state and boards still readable.
- `docs/specs/session-activities/plan.json#sharedDecisions` – three decisions are **consumed, never re-derived**: the **Round entity and its open/closed state model** (S01 owns it; this story introduces no second notion of whether an Activity is running); the **authorization split** – Conference Membership contributes, Session Assignment opens/closes/reopens – applied to this story's own write paths rather than invented per Activity; and **near-live propagation: one cursor, `round.activity_watermark_at`** – settled 2026-08-28 in this story's favour, so the bundle has exactly one propagation mechanism. S01 drops `roundsLastUpdatedAt` and its column; this story owns the cursor, the two-scalar poll endpoint and the one client loop, and **migrates S01's own loop onto it as a second call site rather than leaving a third**; S03's tally rides the same cursor and advances it on ballot insert. The shape is S09's, unchanged.
- `docs/specs/conference-setup-and-schedule/s09-live-schedule-editing.md#implementation-tasks` – the watermark-poll pattern this story must reuse rather than reinvent: a two-scalar poll endpoint, a client that compares the scalar against the payload it is already rendering and refetches only on movement, and a single poll loop living at the view boundary. A second polling mechanism here is the smell the PRD's dependency table names.
- `api/src/routes/attendee.ts` – `GET /api/conferences/:conferenceId/schedule/watermark` and its comment block: why the poll returns two scalars and nothing else, why the watermark is read **before** the data beside it, and why nothing is remembered between polls (ADR-004). The activity watermark endpoint is the same shape for the same reasons.
- `web/src/attendee/AttendeeSchedulePanel.tsx` – the existing poll loop: `POLL_INTERVAL_MS`, the one-in-flight `pollingRef` guard, the `visibilitychange` / `focus` / `online` immediate ticks, and the abort-on-unmount cleanup that deliberately does **not** clear the in-flight flag. This is the implementation to extract and share, not to copy.
- `db/migrations/20260817150000000_session.sql` – the watermark idiom to follow exactly: `clock_timestamp()` never `now()`, `GREATEST(clock_timestamp(), col + interval '1 microsecond')` for strict per-row monotonicity, an `AFTER INSERT OR UPDATE OR DELETE` row trigger so a **delete** advances the cursor too, and a `WHEN` clause keeping the parent trigger off the watermark-only write.
- `db/migrations/20260817210000000_session-assignment.sql` – the composite-foreign-key idiom (`sessions_id_conference_unique` plus `FOREIGN KEY (session_id, conference_id)`) that makes a cross-parent row **unwritable** rather than merely discouraged, and the standing rule that identity is `user_sub` and never email.
- `docs/LEARNINGS.md#testing` – four entries decide how this story's guards are written: a guard that asserts on the **request issued** rather than the resulting state stays green while the payload is wrong; a regression test written beside its fix usually passes without the fix; never `waitFor` on the value you are about to assert; a file-list grep is only as good as its longest omission, so pair any file-list assertion with a behavioural one.
- `AGENTS.md` – the Do Not / Never list, in particular "post-its always carry the author's name", "Never key a user on their email address – use the OIDC `sub`", "Never rely on in-process state between requests", "Never widen offline support beyond schedule reads and post-it queueing", and "Never ship a fixed-width or desktop-only layout".
- `docs/UBIQUITOUS_LANGUAGE.md#session-activities` – **Post-it Round**, **Post-it**, **Activity**, and under Roles **Membership** and **Session Assignment**. This feature introduces no new domain vocabulary; "sticky", "card", "note" and "brainstorm session" are the synonyms to avoid, and *Session* never means the Activity inside it.


## Deeper Context

- `docs/specs/session-activities/s01-round-authoring-and-lifecycle.md` – the sibling FIS authored in the same bundle and executed before this one. It owns the Round table, the open/closed transitions, the run controls and the one read that returns a Session with its Rounds. Read it for the concrete Round column and route names this story attaches to; until it lands, the plan's `sharedDecisions` entry is the contract. Read **TI07** (the Session-with-Rounds read and its projection), **TI10** (`web/src/activities/SessionActivitiesPanel.tsx`) and **TI11** (the poll loop inside it) closely – this story extends all three, and retires TI11's loop. The Execution Contract names the full shared seam.
- `docs/specs/conference-setup-and-schedule/s10-offline-schedule-access.md#structural-criteria` – the offline boundary this story must not cross. S10's cache holds the Schedule envelope and nothing else; no outbox, sync queue or replay buffer exists, and S04 – not this story – is what adds Post-it queueing inside that boundary.
- `docs/LEARNINGS.md#react-state--refusals` – a refusal rendered only inside a component its own handler unmounts is lost. The compose box's refusal must survive the board refresh that follows it.
- `docs/LEARNINGS.md#concurrency` – optimistic concurrency belongs in the UPDATE predicate, not in an earlier round trip; and the sessions/conference deadlock precedent behind the existing SQLSTATE `40P01` retry in `api/src/db.ts`.
- `docs/adrs/ADR-004-containerized-api-and-spa.md` – why no handler may hold a board, a watermark or a per-author counter between requests.


## Acceptance Scenarios

- [x] **S01 [OC01] [TI01,TI02,TI04,TI06,TI07,TI08,TI10] A Post-it contributed by Ada appears on Bo's already-open board within one poll interval, under Ada's name, with no reload**
  - **Given** the Post-it Round "What slowed us down this quarter?" is open in a Session both Ada and Bo are Conference Members of, and both have that Session's Round view open showing an empty board
  - **When** Ada contributes "Waiting three days for test data"
  - **Then** Ada's board shows the Post-it, and Bo's board – untouched, never reloaded – shows the same text labelled with Ada's display name within one poll interval
  - **And** the assertion is made against the **rendered board content on Bo's view**, never against the fact that a request was issued (`docs/LEARNINGS.md#testing`)

- [x] **S02 [OC01] [TI03,TI04] The author is the credential's `sub`, and a request body claiming a different author changes nothing**
  - **Given** Ada is signed in and is a Member of the Conference
  - **When** she contributes a Post-it whose request body also carries `authorSub` and `authorName` naming Bo
  - **Then** the persisted Post-it is attributed to Ada's `sub`, the board shows Ada's name, and no field of the body influenced the author
  - **And** the same request from a signed-in user holding no Membership in that Conference is refused, and nothing is persisted

- [x] **S03 [OC02] [TI03,TI05,TI09,TI10] The author corrects and removes her own Post-its while the Round is open, and both changes reach the room**
  - **Given** Ada's Post-it reads "Waitng three days for test data" and the Round is open
  - **When** she corrects the spelling, then deletes a second Post-it of her own
  - **Then** her board and Bo's board both show the corrected text and no trace of the deleted Post-it – not a tombstone, not a placeholder
  - **And** the deletion reaches Bo through the same propagation path as the contribution, not only after a manual refresh

- [x] **S04 [OC02] [TI03,TI05] Bo cannot edit or delete Ada's Post-it**
  - **Given** Ada's Post-it is on the board of an open Round and Bo is a Member of the same Conference
  - **When** Bo issues an edit and then a delete naming Ada's Post-it id
  - **Then** both are refused, and Ada's Post-it is unchanged and still present – asserted by re-reading the stored row, not from the response alone

- [x] **S05 [OC02,OC03] [TI04,TI05,TI09] A closed Round refuses live contribution, editing and deletion at the API, and stays readable**
  - **Given** the Round has been closed by its Facilitator and Ada's Post-it is on its board
  - **When** Ada attempts to contribute a new Post-it, then to edit and delete her existing one, with the requests issued directly to the API rather than through the disabled controls
  - **Then** each is refused – the contribution naming that the round is closed, the edit and delete naming that the round has ended – and the Round's prompt and every existing Post-it remain readable with their authors' names

- [x] **S06 [OC03] [TI01,TI04,TI09] A refused contribution persists nothing and keeps the typed text**
  - **Given** the Round is open, and Ada has typed text that is over the length cap and, separately, text that is only whitespace
  - **When** each is submitted
  - **Then** each is refused at field level – the over-length one naming the limit – the typed text is still in the compose box, the board is unchanged, and no row exists for either attempt

- [x] **S07 [OC04] [TI06,TI09] A Member returning days later reads the closed Round's board in full**
  - **Given** a Post-it Round that closed two days ago holding Post-its from Ada, Bo and Cleo
  - **When** Cleo opens that Session again
  - **Then** the Round is listed with its closed state, every Post-it is readable under its author's name, and no compose, edit or delete control is offered
  - **And** the board arrives with the Session read – no additional per-Round request is made

- [x] **S08 [OC02] [TI02,TI04,TI06,TI10] A Facilitator clarifies the prompt of a Round that already holds Post-its, and the board is untouched**
  - **Given** the Post-it Round "What slowed us down?" is open and already holds Post-its from Ada and Bo, and Cleo holds a Session Assignment for that Session
  - **When** Cleo edits the prompt to "What slowed us down this quarter?" through S01's Round edit route
  - **Then** the edit succeeds – it is not refused for having contributions – and re-reading the Session returns the new prompt with every existing Post-it byte-identical in text, author and order, none marked edited
  - **And** the change reaches Ada's open view through the same watermark as a contribution does, with no reload


## Structural Criteria

> Non-behavioral invariants and regression guards. Each is proved by a task Verify line.

- [x] A Post-it row identifies its author by the OIDC `sub` (a foreign key to `app_user.sub`) and by nothing else; no column on the Post-it table stores or keys on an email address, and the displayed author name is joined from `app_user.display_name` at read time rather than copied, so a rename is reflected everywhere the Post-it appears.
- [x] A Post-it against a Round that is not a Post-it Round, or against a Round belonging to a different Conference than the route names, is **unwritable at the schema level** – a composite foreign key following the `sessions_id_conference_unique` idiom, not an application check.
- [x] The author check and the Round-is-open check live in the **write statement's predicate** for edit and delete, so a Round closing between a check and a write cannot admit the write.
- [x] Exactly one watermark-poll implementation exists in `web/src` – one cadence constant, one in-flight guard, one set of visibility/focus/online triggers – and **both existing call sites are migrated onto it**: `web/src/attendee/AttendeeSchedulePanel.tsx` (the Schedule view, the source of the extraction) and `web/src/activities/SessionActivitiesPanel.tsx` (the Session/Round view, whose own loop S01 TI11 built and which this story retires rather than leaves beside the shared one). No third loop is added for the board. Paired with a behavioural assertion that both views' near-live refresh still works, so the guard cannot pass by file list alone (`docs/LEARNINGS.md#testing`).
- [x] The Post-it text length cap has exactly one authoritative definition – an exported constant on the API's Post-it validation module, following `api/src/sessions/session-validation.ts#TITLE_MAX_LENGTH`. The client never carries the number: it renders the limit from the value the Session read hands it. The migration's `CHECK` is the storage backstop and its rejection boundary is asserted equal to the constant, so the two cannot drift. No literal cap value appears under `web/`.
- [x] The activity watermark advances on every Post-it insert, update **and delete**, and on every Round write, strictly monotonically per row via `GREATEST(clock_timestamp(), … + interval '1 microsecond')` – never `now()`.
- [x] No Post-it write advances `conference.schedule_watermark_at` or `sessions.last_updated_at`: a contribution must not make every attendee's Schedule refetch, nor move an Organizer's optimistic-concurrency base for that Session.
- [x] No handler, module or singleton holds a board, a watermark, a poll cursor or a per-author count between requests (ADR-004).
- [x] Nothing this story adds is written to S10's offline cache, and no outbox, queue, replay buffer or pending-contribution store is introduced – S04 owns that, inside S10's existing boundary.
- [x] The migration uses plain PostgreSQL only – no `CREATE EXTENSION`, no provider-specific type or function – and has a working down migration.
- [x] The compose box, the board and the author controls are legible with no horizontal body scroll at 375 / 768 / 1280 px, with the primary contribute control reachable one-handed at 375 px.


## Scope & Boundaries

### Work Areas

- **Database** – the Post-it table (author `sub`, text, created/edited instants, composite FK to its Round-and-Conference), and the per-Round activity watermark column with its triggers.
- **API contribution routes** – contribute, edit and delete a Post-it under the Conference-scoped route tree, with Membership authority and credential-derived authorship.
- **API activities read** – the Session-with-Rounds read S01 delivers, extended so each Post-it Round arrives with its board and its authors' display names in the same response.
- **API activity watermark poll** – the two-scalar endpoint the Round view polls, shaped exactly like the schedule watermark poll.
- **Client poll loop** – the watermark-poll loop extracted out of `AttendeeSchedulePanel` into one shared implementation, with **both** existing call sites migrated onto it: the Schedule view and S01 TI11's loop inside `SessionActivitiesPanel`.
- **Client Round view surface** – compose box, the named board, own-Post-it edit and delete affordances, and the refusal states, on the Round view S01 delivers.
- **Error codes** – the refusal codes for a closed Round, a non-author write and an invalid Post-it text.

### What We're NOT Doing

- **Offline queueing of a typed Post-it** -- S04 owns it, and this story must not widen offline support in the meantime (Binding Constraint FR6). No pending state, no outbox and no late-arrival marker is introduced here; the late-arrival column and the closed-Round exception arrive with S04.
- **Authoring a Round: creating it, writing its prompt, the authoring form, the open/closed transitions and the run controls** -- S01 owns all of it (`plan.json#sharedDecisions`). This story adds no prompt editor and no second notion of whether an Activity is running. It does **prove** one FR1 criterion S01 cannot: that S01's prompt edit still succeeds, and leaves the board untouched, once Post-its exist (S08). Editability is required by the PRD, not excluded here – only its authoring surface is.
- **Anything on the anonymous path – Votes, tallies, has-voted facts** -- S03's, and deliberately built by a separate pass so the named and the anonymous paths are not shaped by the same reflex. Nothing here is a template for a ballot.
- **Organizer-side sorting, Categories, Discard and the Board View** -- downstream Insight-context features. The board this story builds is the raw input they consume; discarding a Post-it is not deleting it, and neither concept exists yet.
- **A server-side change feed or per-Post-it delta endpoint** -- the poll compares one scalar and refetches the Session's activities whole, which is the pattern S09 established and the reason there is no delta format to merge.
- **A push or websocket channel** -- near-live is a few seconds by the PRD's own threshold, and web push is banned outright (`AGENTS.md`).


## Architecture Decision

**Approach**: Propagation reuses S09's watermark poll verbatim in shape – a per-Round `activity_watermark_at` advanced by database triggers on any Round or Post-it write, exposed as a two-scalar poll for the Session, with the client's existing poll loop extracted from `AttendeeSchedulePanel` into one shared implementation both views call.
**Why this over alternatives**: A second polling path is the smell the PRD's dependency table names, and hanging the watermark on `sessions` or `conference` instead would either fire S09's row-version trigger – handing an Organizer a spurious concurrency conflict every time a Post-it lands – or make every attendee's Schedule refetch on every contribution.


## Technical Overview

Three seams, and only the middle one is new thinking.

**Storage**: `post_it` hangs off S01's Round with a composite foreign key carrying the Round's kind and its Conference, so a Post-it on a Poll, or on a Round in another Conference, cannot be written at all. Authorship is `author_sub` referencing `app_user.sub`; the display name is joined at read time rather than copied, so the board never shows a stale name.

**Propagation**: the watermark lives on the Round row, advanced by an `AFTER INSERT OR UPDATE OR DELETE` trigger on `post_it` plus a `BEFORE UPDATE` trigger on the Round itself, so S01's open/close transitions move it without S01 knowing this story exists. The Session's poll value is the maximum across its Rounds – one scalar, one comparison – and a deletion is observable because the trigger fires on it.

**Client**: the loop in `AttendeeSchedulePanel` already encodes four decisions worth keeping – five-second cadence, at most one request in flight, immediate ticks on visibility/focus/online, and abort-on-unmount that leaves the in-flight flag to the aborted poll's own `finally`. It moves out as-is into a shared module, and the loop S01 TI11 wrote inside `SessionActivitiesPanel` is retired onto it in the same pass – the bundle ends with one implementation and two call sites, which is what makes S03's tally a third consumer rather than a third mechanism. The Schedule view's existing tests are the parity evidence that the move changed nothing.


## Code Patterns & External References

```
# type | path#anchor                                            | why needed (intent)
file   | api/src/routes/attendee.ts                              | Watermark poll handler: two scalars, watermark read before the data, nothing cached
file   | api/src/routes/sessions.ts                              | Conference-scoped route registration, refusal envelopes, read-order comments
file   | api/src/conferences/authorization.ts#requireMembership   | The Membership check – the authority split's "contributes" half
file   | api/src/auth/with-auth.ts#AuthenticatedCaller            | Where `sub` and `displayName` come from – the only permitted source of authorship
file   | api/src/sessions/session-repository.ts#createSessionRepository | Repository shape; guarded writes with the predicate inside the UPDATE
file   | api/src/errors.ts#ERROR_CODES                            | One code per reason, displayable `message`, field-level `details`
file   | api/src/sessions/session-validation.ts#TITLE_MAX_LENGTH  | The single-source length-cap idiom: one exported constant, interpolated into the refusal message
file   | db/migrations/20260817150000000_session.sql              | Watermark trigger idiom: clock_timestamp + GREATEST, fires on delete too
file   | db/migrations/20260817210000000_session-assignment.sql   | Composite-FK idiom that makes a cross-parent row unwritable
file   | web/src/attendee/AttendeeSchedulePanel.tsx               | The poll loop to extract – cadence, in-flight guard, visibility/focus/online ticks
file   | web/src/api/client.ts#fetchScheduleWatermark             | Client fetch shape for a watermark poll
file   | web/test/AttendeeScheduleRefresh.test.tsx                | Parity target for the poll-loop extraction; also the near-live test idiom
file   | visual/live-editing.spec.ts                              | Responsive/visual validation pattern at 375 / 768 / 1280 px
```


## Constraints & Gotchas

- **Critical**: The Post-it length cap is specified only as "the low hundreds of characters" (`prd.md#fr3-named-post-it-contribution`). **280 characters**, CONFIRMED by preflight on 2026-08-28 (see the DECISION NOTE for post-it-length-cap) rather than assumed – it is a Post-it, and the refusal must name the limit it enforces. The number lives in **one** place: an exported constant on the API's Post-it validation module (TI01), which TI04 validates against, TI06 carries to the client, and TI09 renders. `web/` cannot import from `api/src` (its `rootDir` is `src`), so a mirrored client constant is not a single source – the payload is. The migration's `CHECK` is the one unavoidable second copy and is pinned to the constant by test, not by comment.
- **Critical**: Author identity comes from `caller.sub` on every write path (Binding Constraint FR3). A route that accepts an author field "for testing", or trusts one when present, is the defect – the body's author fields must be *inert*, not merely unused.
- **Avoid**: proving near-live propagation by asserting that a poll request was issued, or by counting requests -- Instead: assert the other participant's **rendered board**, and for a refusal the **stored row**. A guard on the request stays green while the payload is wrong (`docs/LEARNINGS.md#testing`).
- **Avoid**: a `waitFor` on the very text you are about to assert -- Instead: wait on something the defect cannot touch, or the reading is never captured and the comparison never runs.
- **Constraint**: `web/` has no jest-dom -- Workaround: assert plain DOM properties (`.disabled`, `.value`, `queryByTestId() === null`), never `.toBeInTheDocument()`.
- **Constraint**: the codes for a closed Round and a missing Round may already be registered by S01 -- Workaround: reuse the existing name; never add a synonym for a reason that already has a code.
- **Avoid**: rendering the compose box's refusal inside a subtree that a successful board refresh replaces -- Instead: keep the refusal outside that subtree (`docs/LEARNINGS.md#react-state--refusals`).
- **Constraint**: a Post-it write updates its Round row through a trigger while a Facilitator may be updating that same row directly -- Workaround: route the writes through the existing SQLSTATE `40P01` retry in `api/src/db.ts`; do not add a second retry policy.


## Implementation Plan

### Implementation Tasks

- [x] **TI01** A `post_it` table exists holding one named contribution, with an author that can only be an OIDC `sub` and a parent that can only be a Post-it Round of the route's Conference
  - Columns: id, round_id, conference_id, `author_sub` → `app_user(sub)`, text, created_at, edited_at (null until edited). Composite FK carrying the Round's kind and Conference, following `db/migrations/20260817210000000_session-assignment.sql`; CHECKs for `btrim(text) <> ''` and a length bound. The bound's **authoritative definition is the exported constant** introduced with it on the API's Post-it validation module, shaped after `api/src/sessions/session-validation.ts#TITLE_MAX_LENGTH`; the SQL literal is the storage backstop, pinned to that constant by the Verify below rather than by a comment. No per-author count column and no per-Round count constraint exists – the PRD states "No per-Member count limit". No email column; plain PostgreSQL only; working down migration.
  - **Verify**: `Test: inserting a post_it whose round is a Poll, or whose conference_id differs from its round's, is rejected by a constraint rather than by application code; a blank-after-trim text is rejected; a text of exactly the exported cap is accepted and one character longer is rejected, with the boundary read from the constant so a change to either side alone fails the test; the migration applies and rolls back cleanly; no column in the table holds an email`

- [x] **TI02** Each Round carries an activity watermark that advances on any Round or Post-it write, including a delete
  - `round.activity_watermark_at timestamptz`, advanced by an `AFTER INSERT OR UPDATE OR DELETE` row trigger on `post_it` and a `BEFORE UPDATE` trigger on the Round itself (so S01's open/close and its prompt edit move it), using `GREATEST(clock_timestamp(), … + interval '1 microsecond')` per `db/migrations/20260817150000000_session.sql`. Must not touch `conference.schedule_watermark_at` or `sessions.last_updated_at`.
  - This cursor is the bundle's only propagation mechanism, so the trigger set has **three** writers, not two: this story's two plus an `AFTER INSERT OR UPDATE OR DELETE` on S03's `round_option` table, added by S03 (`plan.json#sharedDecisions` → one cursor). **Amended 2026-08-29 by ADR-007**: the ballot table is deliberately **not** a writer. S03 originally attached an `AFTER INSERT` trigger to it, and because this cursor is read as `max(...)` scoped to a single Session, that made its change event a noiseless vote-arrival oracle for any Member - while an Attendee is refused the running tally precisely so that absence carries no information. `db/migrations/20260831090000000_vote-advances-no-cursor.sql` drops it; a Session Assignment holder's tally now refetches on the shared tick instead of riding a change signal. Give the advancing logic one named home – a single trigger function the later writer attaches to – so S03 adds a trigger rather than a second copy of the `GREATEST` expression.
  - **Verify**: `Test: contribute, edit, then delete a Post-it and assert the Round's watermark is strictly greater after each – the delete included; assert conference.schedule_watermark_at and sessions.last_updated_at are unchanged across all three; two writes in one transaction produce two distinct values`

- [x] **TI03** A Post-it repository writes contributions, and guards edits and deletes inside the write statement rather than before it
  - On the seam of `api/src/sessions/session-repository.ts#createSessionRepository`. The edit and delete statements carry `author_sub = $caller` **and** the Round-is-open condition in their own `where` clause, reporting whether a row was affected so the route can name the reason.
  - **Verify**: `Test: an edit issued with a non-author sub, and an edit issued while the Round is closed, each affect zero rows and leave the stored text byte-identical – asserted by re-reading the row, not from the return value alone`

- [x] **TI04** Contributing to an open Post-it Round is a Membership-authorized write whose author is the credential
  - `POST` under the Conference-scoped route tree, registered in `api/src/routes/rounds.ts` beside S01's Round routes, authorized with `requireMembership` from `api/src/conferences/authorization.ts`. Author is `caller.sub`; any author-ish body field is ignored entirely. Refusals: closed Round (displayable "This round is closed."), blank text, over-length naming the limit as a field-level detail – the limit interpolated from **TI01's exported constant**, never a literal in the route or the message string – per `api/src/errors.ts#ERROR_CODES`. No per-author or per-Round contribution count is computed or enforced (`prd.md#fr3-named-post-it-contribution`: "A Member may contribute any number of Post-its to one Round"). Nothing is retained between requests.
  - **Verify**: `Test: a body carrying authorSub/authorName for another user persists the caller's sub and returns the caller's display name; a non-member is refused and no row is written; a contribution to a closed Round is refused with the round-closed code while the Round's prompt and existing Post-its still read back; one author contributing many Post-its in succession to a single open Round has every one accepted and every one on the board, with no refusal at any count and no cap named in any response`

- [x] **TI05** An author can correct or remove only their own Post-it, and only while its Round is open
  - Edit and delete routes over TI03's guarded writes; Membership authorized, author enforced by the write predicate, refusals distinguishing "not yours" from "the round has ended". A delete removes the row – no tombstone, no soft-delete flag (`prd.md#edge-cases`: no trace that it existed).
  - **Verify**: `Test: the author edits and deletes successfully while open; a second Member's edit and delete are refused and the row is unchanged; after close, the author's own edit and delete are refused naming that the round has ended; after a successful delete neither a row nor a tombstone remains`

- [x] **TI06** The Session read returns each Post-it Round's whole board with its authors' names, in the same response as its Rounds
  - Extends the Session-with-Rounds read S01 delivers at **S01 TI07**, and its projection (`plan.json#sharedDecisions` → Round entity); display names joined from `app_user.display_name`, never copied onto the Post-it row. Each Post-it Round also carries the text cap from **TI01's exported constant**, so TI09 has no number of its own. One request for a Session and everything in it (`prd.md#non-functional-requirements`).
  - **Verify**: `Test: one request returns a Session, its Rounds with their own states, and every Post-it under its author's display name; the payload carries the text cap and its value equals the exported constant; renaming a user in app_user changes the name shown on their existing Post-its; a closed Round's board is returned in full; editing an open Round's prompt through S01's route while Post-its exist succeeds and the next read returns the new prompt with every Post-it's text, author, order and edited-marker unchanged (S08)`

- [x] **TI07** A Session's activity watermark is pollable as two scalars and nothing else
  - `GET` alongside the schedule watermark poll, shaped after `api/src/routes/attendee.ts` – the maximum `activity_watermark_at` across the Session's Rounds, read before anything beside it, Membership authorized, nothing remembered between polls (ADR-004). No Round or Post-it content in the response.
  - **Verify**: `Test: the response body carries only the watermark scalar and the state beside it – no round or post-it content; the value moves after a contribution, an edit and a delete; two sequential polls with no write between them return the same value`

- [x] **TI08** One watermark-poll implementation serves every polling view, and the two loops that exist today are call sites of it
  - Extract the loop from `web/src/attendee/AttendeeSchedulePanel.tsx` – `POLL_INTERVAL_MS`, the one-in-flight ref, the `visibilitychange`/`focus`/`online` immediate ticks, the abort-on-unmount cleanup that leaves the flag to the aborted poll's `finally` – into a shared module. **Two** call sites migrate onto it, not one: the Schedule view it came from, and `web/src/activities/SessionActivitiesPanel.tsx`, where **S01 TI11** built a second loop of its own. S01's loop is retired in the same task – left in place it violates this story's single-implementation criterion, and the board would be the third. Behaviour-preserving for both; TI10 consumes the shared module rather than adding a loop.
  - **Verify**: `Test: web/test/AttendeeScheduleRefresh.test.tsx passes unchanged (parity), AND behavioural assertions that an open Schedule and an open Session Activities view each still refresh when their server watermark moves – paired so the guard cannot pass by file inventory alone; only one cadence constant, one in-flight guard and one visibility/focus/online registration exist under web/src, and SessionActivitiesPanel declares no interval of its own`

- [x] **TI09** The Round view offers contribution, the named board, and own-Post-it correction, and states every refusal without losing typed text
  - On the Round view S01 delivers (`web/src/activities/SessionActivitiesPanel.tsx`, S01 TI10). Compose box surfacing the text limit before submission, **read from the value TI06 puts in the payload** – no cap literal is written under `web/`; every Post-it labelled with its author; edit and delete offered only on the viewer's own Post-its and only while the Round is open; refusals rendered outside the subtree a board refresh replaces (`docs/LEARNINGS.md#react-state--refusals`). Responsive at 375 / 768 / 1280 px, primary control one-handed at 375 px.
  - **Verify**: `Test: a refused over-length submission leaves the typed text in the box and the board unchanged; the limit the compose box shows changes when the payload's cap changes, proving it is not hardcoded; a closed Round renders its prompt and board with no compose, edit or delete control; another Member's Post-it offers neither control; screenshots at 375/768/1280 px show no horizontal body scroll`

- [x] **TI10** An open Round view converges on the server's board through TI08's shared poll, with no manual reload
  - The Round view compares TI07's scalar against the one it is rendering and refetches TI06's read when it moves – the same compare-then-refetch rule as the Schedule, and no delta format. Uses TI08's shared loop; no second interval, cadence or in-flight guard is introduced.
  - **Verify**: `Test: with a second participant's Post-it contributed, then edited, then deleted server-side, the open view's rendered board converges on each change without a reload – asserted on rendered board content, never on requests issued; a failed poll leaves the board as it was`

### Testing Strategy

- Refusal and authority tests assert the **stored row** after the refusal, not only the response envelope – a route that returns a refusal and writes anyway passes a response-only test.
- Near-live tests assert the second participant's **rendered board**, never a request count or a fetch spy (`docs/LEARNINGS.md#testing`).
- Structural criteria naming files or columns are paired with one behavioural assertion that does not know the list.
- Each new guard is run once against the code **without** its fix before being believed – six S09 tests were green against the very defect they named.
- The sibling story's anonymity guarantee is not this story's to prove; do not add a Vote fixture here.

### Execution Contract

- **Ordering**: S01 lands first (this story extends its artifacts); this story lands second; **S03 lands third** (`plan.json` → S03 `dependsOn: ["S01","S02"]`, `parallel: false`). This story therefore edits the shared artifacts on a clean base and S03 merges on top – never the reverse.
- **Shared merge seam with S03**. Four artifacts are extended by both stories, and this FIS is the earlier writer of each. Leave each one extensible rather than shaped around Post-its alone, and do not fold Post-it specifics into a name or signature S03 must widen:
  - **S01 TI07's Session-with-Rounds read and its projection** – this story adds the board and the text cap per Post-it Round (TI06); S03 adds the tally and the has-voted fact per Poll. One read, one projection, two additive extensions.
  - **`web/src/activities/SessionActivitiesPanel.tsx`** (S01 TI10) – this story adds the compose box, the board and the author controls (TI09) and retires S01's loop in favour of the shared one (TI08); S03 adds the option list, the voted state and the tally to the same component and reuses that same loop.
  - **`api/src/routes/rounds.ts`** – this story registers the contribute/edit/delete routes (TI04, TI05); S03 registers the vote and tally routes beside them.
  - **`api/src/errors.ts#ERROR_CODES`** – this story adds codes for a closed Round refusal (if S01 has not), a non-author write and invalid Post-it text; S03 adds already-voted, unknown-option and tally-not-yet-visible. One code per *reason*, no synonyms.
- **TI08 retires S01 TI11's loop.** It is not optional cleanup: the Structural Criterion "exactly one watermark-poll implementation" is unachievable while that loop stands, and S03 is specified against the shared one.


## Implementation Observations

#### DECISION NOTE: post-it-length-cap

Decision-Key: post-it-length-cap
Altitude: fis-local
Affected surface: Constraints & Gotchas -- the bullet beginning "- **Critical**: The Post-it length cap is specified only as" (amended below). The cap's downstream carriers keep their existing wording and are unchanged by this note: TI01's exported constant on the API's Post-it validation module (the single source), TI04's validation and the refusal message that names the limit, TI06's payload carrying it to the client, TI09's render of it, and the migration's `CHECK` pinned to the constant by test.
Decision: The Post-it text length cap is 280 characters.
Rationale: `prd.md#fr3-named-post-it-contribution` specifies only "a length cap in the low hundreds of characters"; 280 keeps a projected board scannable and a Post-it a single idea, and it is the value this FIS already assumed, so no rework follows.
Evidence: Confirmed by the user during an `andthen:preflight` run on the `docs/specs/session-activities` bundle, 2026-08-28.

Old:
```
**280 characters** is assumed here
```

New:
```
**280 characters**, CONFIRMED by preflight on 2026-08-28 (see the DECISION NOTE for post-it-length-cap) rather than assumed
```

#### DECISION NOTE: board-is-the-canonical-collection-noun

Decision-Key: board-is-the-canonical-collection-noun
Altitude: project-decision
Affected surface: The collection noun throughout S02's code and FIS (component, testids, CSS classes, repository methods, routes, and the FIS prose), plus docs/UBIQUITOUS_LANGUAGE.md where Board is now registered. Already renamed; this note is provenance only.
Decision: Board is the canonical noun for the collection of Post-its contributed to a Post-it Round. "Wall" is a synonym to avoid. Board is registered in docs/UBIQUITOUS_LANGUAGE.md and Board View now reads as the projected big-screen view of a Workshop's Post-it Board.
Rationale: S02's Required Context claimed the story introduced no new domain vocabulary, but it introduced "wall" across component names, testids, CSS, repository methods and routes for a collection the glossary already described as a Post-it board. Two nouns for one concept is exactly the synonym blurring the Ubiquitous Language document exists to prevent, and the owner's forthcoming board-columns capability (REQ-038) attaches its layout to the board, making Board the noun that carries structure.
Evidence: Raised as an ambiguous-intent finding by S02's fresh-context quick-review, escalated by the orchestrator because an accepted ambiguous-intent finding contains a story from completion, and decided by the user during exec-plan on 2026-08-29. Rename verified behaviour-preserving: 1038/1038 tests across 63 files, typecheck and lint clean, wall-clock-time.ts and all 82 wall-clock references deliberately untouched.

### Run: 2026-08-28 23:38 UTC – observations

#### NOTICED BUT NOT TOUCHING

- `web/src/schedule/SchedulePanel.tsx` – the ORGANIZER schedule itself still has no watermark poll, so a colleague editing the schedule is invisible on that surface until reload. Deliberately out of this story: TI08 names two call sites and this is not one of them; tracked as an open ledger entry from S01 review. Note the *Activities* panel embedded there now does refresh, because TI08 made the panel itself the call site rather than a prop consumer – the schedule around it is unchanged.
- `npm run format:check` fails on three files this story never touched – `api/test/join-code.test.ts`, `visual/conferences.spec.ts`, `web/src/components/JoinCodePanel.tsx`. Pre-existing drift, deliberately not folded into this diff.
- `api/test/round-structure.test.ts:307` – the S01 guard "takes the acting identity only from the verified caller" matches `/body[\s\S]{0,80}(userSub|sub|email|author)/` across the whole of `routes/rounds.ts`. It still passes, but it is a coarse proximity regex on a file three stories now extend; S03 adding vote routes beside the post-it ones is where it is most likely to false-positive. `api/test/post-it-structure.test.ts` states the same property precisely (`postIts.*(caller.sub)`, plus the body-schema property list), so the intent is covered twice.

#### AMENDED S01 GUARDS (TI06, TI08)

Three S01 assertions pinned shapes this story is specified to retire. Each was restated to the property that survives, never relaxed, and each gained a stronger assertion in the process:

- `api/test/round-structure.test.ts` "adds no interval, cadence constant or poll loop under web/src" → "has exactly one cadence constant and one poll interval under web/src". It pinned the loop to `AttendeeSchedulePanel.tsx`; TI08 extracted it. The count is still pinned, and the cadence regex now also catches `export const` (which is what the shared constant is).
- `api/test/round-structure.test.ts` "gives the session activities panel no timer, cursor or in-flight guard" → "...no timer, cadence or in-flight guard **of its own**", plus a new positive assertion that the panel genuinely calls `useWatermarkPoll` and a new assertion that it registers no visibility/focus/online listener itself. S02 gave the panel a cursor to compare, which is the whole of TI10.
- `api/test/round.integration.test.ts` "returns no timestamp, version or cursor field for the round set" → "puts no timestamp, version or cursor field on any round, and exactly one on the session". S01 asserted zero cursors because S02 had not built the one yet. The per-Round property is now asserted key-by-key against a regex rather than by an exact key list alone, and both Round kinds are exercised.

#### IMPLEMENTATION NOTES

- The Post-it body schema is deliberately **not** `additionalProperties: false`, unlike S01's round body schema. Binding Constraint FR3 is that the body's author fields are *inert*; a route that refused them and a route that trusted them both pass "does not accept an author field", and only one is correct. `post-it.integration.test.ts` sends `authorSub`/`authorName`/`author` naming Bo and asserts the stored row carries Ada's `sub`.
- The wire carries `edited: boolean` rather than `editedAt`. Putting the instant on the wire would hand the client a timestamp it could only render by converting a timezone the product does not carry – the trap S09's `AttendeeScheduleRefresh` guard exists for. `post_it.edited_at` is the stored fact.
- `useWatermarkPoll` swallows a rejected poll before releasing the in-flight flag. The call sites already swallow their own failures; catching in the loop as well means a call site that one day forgets cannot turn a dropped connection into an unhandled rejection in a Capacitor shell with nothing to report it to.
- `post-it.integration.test.ts` uses a local `namedVerifier` rather than the shared `subjectVerifier`. The shared one answers `displayName: sub`, and `withAuth` upserts the caller's `app_user` row on every request – so a name seeded in `beforeEach` is overwritten the moment its owner makes a request, and every board assertion would be comparing an author name against the `sub` beside it. A route emitting `author_sub` where the joined `display_name` belongs would have passed unnoticed.

### Run: 2026-08-29 – review remediation (six Fix-routed findings)

Applied against the implemented story; no checkbox state changed and no scenario was re-implemented.

- **Contributing to an open Poll answered 500, not a refusal.** `post-it-repository.ts#contribute` guarded `state = 'open'` but not `kind`, so an open Poll matched the insert's source query, `round_kind` fell to its column default, and the composite foreign key refused with SQLSTATE 23503 – which the error handler maps to `INTERNAL_ERROR`. Only the *closed*-Poll path reached the intended 404. `r.kind = 'PostItRound'` is now part of the insert's own source predicate, and the comment that rationalised its absence was rewritten: the constraint is still the guarantee, the predicate is what keeps it off the request path. The route-level gap that let this ship green is closed – `post-it.integration.test.ts` now contributes to a Poll **open and closed** and asserts 404 `ROUND_NOT_FOUND` for both. The new test was confirmed red first (500 on the open Poll, 404 already correct on the closed one).
- **An open correction editor survived its Round closing.** In `SessionActivitiesPanel.tsx` the `Board`'s editor branch rendered on `editor?.postItId === postIt.id` alone, so a box opened while the Round was running kept a live Save after the close arrived – every other affordance was gated on `open`, and OC02 says neither correction nor removal is offered after a Round closes. The branch is now `open && editor?.postItId === postIt.id`. `PostItBoard.test.tsx`'s closed-round test renders a Round already closed in its first payload, so it never opened an editor and passed vacuously; the paired test now opens the editor and closes the Round underneath it. Confirmed red first (the textarea was still on screen).
- **Create / edit / open / close no longer claim `postIts: []`.** Those four responses never load a board, so asserting an empty one described a Round that has a board as having none. `toRoundWire`'s board parameter is now optional and last (`round, viewerSub, board?`), and both `postIts` and `textMaxLength` are omitted when no board was loaded – the wire type already declares them optional, and the Session read is unchanged. This is the seam the Execution Contract asks to leave extensible for S03.
- **`edited_at` is no longer stamped on a no-op correction.** Saving unchanged text marked `(edited)` on every board in the room. The update now reads `edited_at = case when p.text = $6 then p.edited_at else clock_timestamp() end`, which sees the OLD value in the SET expression (verified directly against PostgreSQL). The Round's activity cursor still advances, because the AFTER trigger fires on any UPDATE – that costs one refetch which finds the board unchanged, the same self-correcting direction as the read's stale-low watermark, and it is deliberately left alone.
- **The compose counter now measures what the server measures.** `validatePostItText` trims before measuring, so cap-length text with trailing spaces read "285 / 280" beside an API that accepts it. The counter is `[...draft.trim()].length`.
- **Five em dashes in this file's previous observations block** were replaced with en dashes, per `docs/guidelines/CRITICAL-RULES-AND-GUARDRAILS.md`. No source or test file held one.

Verification after the six: `npm run typecheck` clean, `npm run lint` clean, `npm test` 1038 passed / 1038 across 63 files (1036 before, plus the two new tests). `npm run format:check` still fails on exactly the same three untouched files noted above. Every `*.integration.test.ts` executed against the real PostgreSQL – 629 api tests passed with none skipped and no `[integration] SKIPPED` warning.

### Run: 2026-08-29 15:43 UTC – design-change

#### DESIGN CHANGE

S02 TI02 enumerated the cursor's writers as this story's two plus an `AFTER INSERT` on S03's ballot table. ADR-007 removes the ballot trigger, so that enumeration is false as written. The count stays **three**; the third writer is S03's `round_option` trigger, not the ballot. Task checkbox state, task/scenario IDs, tags and Proof identity are unchanged.

#### ADR

`docs/adrs/ADR-007-vote-arrivals-do-not-advance-the-member-visible-cursor.md` – Status: Accepted, 2026-08-29. Vote arrivals do not advance the Member-visible activity cursor.

#### AMENDMENT

Old:
```
This cursor is the bundle's only propagation mechanism, so the trigger set has **three** writers, not two: this story's two plus an `AFTER INSERT` on S03's ballot table, added by S03 (`plan.json#sharedDecisions` → one cursor).
```

New:
```
This cursor is the bundle's only propagation mechanism, so the trigger set has **three** writers, not two: this story's two plus an `AFTER INSERT OR UPDATE OR DELETE` on S03's `round_option` table, added by S03 (`plan.json#sharedDecisions` → one cursor). **Amended 2026-08-29 by ADR-007**: the ballot table is deliberately **not** a writer. S03 originally attached an `AFTER INSERT` trigger to it, and because this cursor is read as `max(...)` scoped to a single Session, that made its change event a noiseless vote-arrival oracle for any Member - while an Attendee is refused the running tally precisely so that absence carries no information. `db/migrations/20260831090000000_vote-advances-no-cursor.sql` drops it; a Session Assignment holder's tally now refetches on the shared tick instead of riding a change signal.
```
