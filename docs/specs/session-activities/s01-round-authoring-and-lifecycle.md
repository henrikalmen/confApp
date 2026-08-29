# S01 – Round Authoring and Lifecycle

**Plan**: docs/specs/session-activities/plan.json
**Story-ID**: S01

## Feature Overview and Goal

> **Superseded terminology, 2026-08-29 (ADR-007).** Every `round.activity_watermark_at` and `activityWatermarkAt` below refers to what is now **`round.activity_watermark`** - a `bigint` defaulted from one global sequence, not a timestamp. It was retyped by `db/migrations/20260829120000000_activity-watermark-counter.sql`, because the microsecond instant let any Conference Member read when each Vote was cast while an Attendee is deliberately refused the tally; and then narrowed by `db/migrations/20260831090000000_vote-advances-no-cursor.sql`, because a Session-scoped cursor that moves on every ballot is a vote-arrival oracle whatever the value says. **The wording below is left as the record of what this story specified and built.** Where it disagrees with the schema, the schema and ADR-007 are current.

**Intent**: A Session is currently only a slot on a schedule; until it can hold an Activity that a Presenter/Facilitator prepares in advance and starts in front of the room, confApp collects nothing from the people sitting in it.

**Expected Outcomes** (scenarios anchor to these via `[OC<NN>]`):

- [OC01] A Presenter/Facilitator or Admin authors Post-it Rounds and Polls on a Session they hold a Session Assignment for, ahead of the Session and without typing in front of the room, and is refused on a Session they do not hold one for.
- [OC02] Every Conference Member opening a Session reads its Rounds and each Round's own open/closed state in one request, and a state change made by the Facilitator reaches their screen within seconds with no manual reload.
- [OC03] The run controls do exactly what the room needs: open, close, and reopen a Post-it Round; a Poll that has already run cannot be reopened and the refusal says why.
- [OC04] A Post-it Round's prompt stays editable at any time, while a Poll's question and options are frozen from the moment its first Vote exists – so a closed tally always answers the question it was cast against.


## Required Context

- `docs/specs/session-activities/prd.md#fr1-round-authoring` – the authoring acceptance criteria, the input/output shape, the field validation rules (non-empty trimmed text within a length cap; ≥2 distinct option labels; Round kind enforced **at the storage layer as well as the API**), and the three refusal paths. Implement these; do not restate them elsewhere.
- `docs/specs/session-activities/prd.md#fr2-round-lifecycle-control` – the permitted transitions (closed → open, open → closed, closed → open **again for Post-it Rounds only**), the rule that more than one Round in a Session may be open at once, the authority rule (Session Assignment holder only), and the mandated refusal sentence for reopening a Poll.
- `docs/specs/session-activities/prd.md#user-stories` – US01 (author the prompt ahead of the Session; the Round exists **closed** until opened) and US02 (opening admits contribution, closing refuses it **at the API, not only in the UI**) are this story's two anchors. US03–US11 belong to later stories.
- `docs/specs/session-activities/prd.md#data-requirements` – the Round entity: belongs to one Session; kind; prompt or question; open/closed state; for a Poll an **ordered** set of options; retained for the life of the Conference. TI01's schema is this row, and nothing more of the Post-it/Vote rows below it.
- `docs/specs/session-activities/prd.md#constraints` – Binding Constraints FR1, FR2, FR4 and FR6 all land here: **plain PostgreSQL only** (ADR-003, no extension or provider-specific feature); **no in-process state between requests** (the API runs as several replicas with no affinity – Round state is read from the database per request, never cached in a module); **vote anonymity is a storage-level guarantee** (this story creates no ballot storage and must leave S03 free to store one with no voter reference – see TI04); **offline support must not widen** beyond schedule reads and Post-it queueing (Rounds are deliberately kept out of the cached schedule envelope – see *Architecture Decision*). Also binding from the same anchor: responsive from 375 px, and identity is the OIDC `sub`, never the email.
- `docs/specs/session-activities/prd.md#fr3-named-post-it-contribution` – Binding Constraint FR3: *"Author identity is taken from the authenticated credential, never from the request body."* No contribution ships in this story, but the same rule binds every endpoint here: the acting `sub` comes from `withAuth`, and no request body field may name or influence who is acting.
- `docs/specs/session-activities/plan.json#sharedDecisions` – three entries bind here. Two are **produced** by this story and consumed by four later ones: *the Round entity and its open/closed state model* (S02–S05 read it before accepting a write and must not introduce a second notion of "is this Activity running"), and *the authorization split – Membership contributes, Session Assignment runs* (established here, applied by S02 and S03 to their own write paths). The third is **consumed, not produced**: *near-live propagation: one cursor, `round.activity_watermark_at`* – S02 owns the cursor, its triggers, its two-scalar poll endpoint and the one shared client poll loop, so this story adds no cursor column, no cursor field on any payload and no poll loop of its own (see *Architecture Decision*).
- `docs/UBIQUITOUS_LANGUAGE.md#session-activities` – canonical terms: **Activity**, **Post-it Round**, **Post-it**, **Voting Round**, **Vote**, **Poll**. Use them in table names, types, API fields and UI copy; avoid the listed synonyms. Note the standing warning: the Activity inside a Session is a **Round**, never a "post-it session" or "voting session".
- `docs/specs/conference-setup-and-schedule/s04-schedule-composition.md` – the Session model, the `sessions` table, the wall-clock wire format, and the three deliberately-dissimilar timestamp columns. Read before adding any column or trigger: `conference.schedule_watermark_at` is the whole-schedule cursor the offline cache and the live-editing poll both compare, and this story must not move it (Structural Criteria).
- `docs/specs/conference-setup-and-schedule/s07-per-conference-roles.md` – the role model and the Session Assignment narrowing this story authorizes through. **Presenter/Facilitator is one role**, and a Session's `kind` plays no part in any authority decision.
- `docs/guidelines/CRITICAL-RULES-AND-GUARDRAILS.md` and `AGENTS.md` – always-on rules; in particular no in-process state between requests, plain PostgreSQL, no fixed-width layout, and canonical domain vocabulary.


## Deeper Context

- `docs/specs/conference-setup-and-schedule/s09-live-schedule-editing.md` – the near-live pattern the Session view follows: replace the payload **wholesale**, never merge a delta, and keep the refresh at the view boundary rather than inside the rendered tree. The cheap-cursor half of that pattern arrives with S02, which owns `round.activity_watermark_at` and its two-scalar poll; this story ships the interim refresh described in TI11 and S02 migrates its call site onto the shared loop.
- `docs/specs/session-activities/s02-named-post-it-contribution.md#implementation-tasks` – the sibling FIS that owns propagation: TI02 (the `round.activity_watermark_at` column and its triggers), TI07 (the two-scalar poll) and TI08 (the single shared client poll loop extracted from `web/src/attendee/AttendeeSchedulePanel.tsx`, which TI10 and this story's view then both call). Read it before adding anything cursor-shaped here.
- `web/src/attendee/AttendeeSchedulePanel.tsx` – the existing poll loop and the four decisions it already encodes (cadence, one request in flight, immediate ticks on visibility/focus/online, abort-on-unmount). TI11 reuses this loop as it stands; it is the implementation S02 extracts, not one to copy.
- `docs/specs/conference-setup-and-schedule/s10-offline-schedule-access.md` – what the offline cache holds today. It caches S06's schedule envelope verbatim; anything added to that envelope becomes offline scope by construction, which is why Rounds are read from their own endpoint.
- `docs/LEARNINGS.md#react-state--refusals` – a refusal rendered only inside a component its own handler unmounts is lost. The authoring form and the run controls both refuse; render those refusals outside the subtree the handler replaces.
- `docs/LEARNINGS.md#testing` – four traps that bear directly on proving this story: a regression test written beside its fix usually passes without the fix (revert and re-run); a structure test that skips when its marker is missing tests nothing; a file-list grep is only as good as its longest omission (pair it with a behavioural assertion); never `waitFor` on the value you are about to assert.
- `docs/specs/session-activities/prd.md#ui-wireframes` – records that no wireframe exists yet for the Round authoring form or the Facilitator run controls. See *Constraints & Gotchas* for the assumption taken instead.
- `docs/adrs/ADR-003-postgresql-containerized-development.md` – why portability, not a provider's feature set, decides the schema.


## Acceptance Scenarios

- [x] **S01 [OC01] [TI01,TI02,TI03,TI05,TI07,TI09,TI10] A Facilitator authors a Post-it Round and a Poll on their assigned Session days ahead, and both exist closed**
  - **Given** Ida holds a Session Assignment for the Workshop "Ways of Working" in the published Conference "Autumn Offsite", and the Session has no Rounds
  - **When** she adds a Post-it Round with the prompt "What slows us down most?" and a Poll asking "Where should we start?" with the options "Tooling", "Meetings" and "Handovers", in that order
  - **Then** both Rounds are listed on the Session, in the order she authored them, each showing **closed**; the Poll's three options read back in the order she entered them; the two Rounds read back as the two Activity kinds the domain names – a Post-it Round, and a Voting Round whose purpose is Poll – and neither Round is running

- [x] **S02 [OC01] [TI05,TI07] Authoring on a Session the actor is not assigned to is refused, and the Session stays readable**
  - **Given** Ida holds a Session Assignment for "Ways of Working" and none for the Presentation "Opening Keynote" in the same Conference
  - **When** she attempts to add a Post-it Round to "Opening Keynote"
  - **Then** the attempt is refused with a displayable message naming the authority required, no Round is persisted on that Session, and Ida can still read "Opening Keynote" and any Rounds it already holds
  - **And** Björn, an Attendee with Membership but no Role Assignment, is refused the same write on "Ways of Working"

- [x] **S03 [OC02,OC03] [TI03,TI06,TI07,TI09,TI11] Opening a Round reaches every Member's open Session view within seconds, and closing it does the same**
  - **Given** Björn (a Conference Member with no Role Assignment) has "Ways of Working" open on his phone, showing the Post-it Round "What slows us down most?" as **closed**, and a second Round in the same Session that is already open
  - **When** Ida opens the Post-it Round and Björn touches nothing
  - **Then** within a few seconds Björn's view shows that Round as **open** with no manual reload and no navigation, the other Round stays open (two Rounds open at once is permitted), and Björn is shown no run controls and no authoring form anywhere on the Session
  - **And** when Ida then closes it, Björn's view returns to **closed** within the same window

- [x] **S04 [OC03] [TI03,TI06] A closed Post-it Round is reopened and runs again**
  - **Given** the Post-it Round "What slows us down most?" has been opened and then closed by Ida
  - **When** Ida opens it again
  - **Then** the Round is open again, and the transition is permitted no matter how many times it has run before

- [x] **S05 [OC03] [TI03,TI06] A Poll that has already run refuses to reopen, in the sentence the room needs**
  - **Given** the Poll "Where should we start?" was opened by Ida and then closed
  - **When** Ida attempts to open it again
  - **Then** the attempt is refused with the message *"A poll cannot be reopened once its results are shown."*, the Poll stays closed, and the refusal carries a machine code distinct from the "not authorized" one
  - **And** a **different** Poll in the same Session that was authored and never opened is still opened normally – "created closed" is not "already run"

- [x] **S06 [OC04] [TI03,TI04,TI05] A Post-it Round's prompt is edited mid-round; a Poll's question and options are edited while no Vote exists**
  - **Given** the Post-it Round "What slows us down most?" is open and the Poll "Where should we start?" is closed with no Vote cast against it
  - **When** Ida clarifies the prompt to "What slows us down most, day to day?" and separately renames the Poll's option "Tooling" to "Tooling and CI" and adds a fourth option
  - **Then** both edits are saved and read back on the Session, the Post-it Round stays open across its edit, and the Poll's options keep their authored order with the new one last

- [x] **S07 [OC01,OC04] [TI02,TI04,TI05] Once a Vote exists a Poll's question and options are refused; a bad option list is refused field-level with the typed values kept**
  - **Given** the Poll "Where should we start?" has one Vote recorded against it (asserted through the ballot-existence port of TI04, which S03's TI08 later binds to real Vote storage)
  - **When** Ida edits the Poll's question text, and separately edits its option labels
  - **Then** both edits are refused with a displayable message naming the reason – the ballots point at these options and the question is what they answer – and the stored question and options are unchanged, while the Post-it Round in the same Session is still freely editable
  - **And** authoring a Poll with a single option, with two identically-labelled options, or with an over-length question is refused **field-level** naming the limit or the rule, with nothing persisted and the values Ida typed still in the form


## Structural Criteria

> Each criterion is proved by a task Verify line, not a scenario.

- [x] The `round` and `round_option` tables are **plain PostgreSQL** – no `CREATE EXTENSION`, no provider-specific type or function – and the migration's down step removes every table, constraint and index its up step creates (Binding Constraint FR1, ADR-003).
- [x] A Round is reachable only inside its own Conference: the table carries a composite foreign key on `(session_id, conference_id)` against `sessions_id_conference_unique`, not a bare `session_id`, and both tables cascade from their Session – the same idiom as `db/migrations/20260817210000000_session-assignment.sql`.
- [x] Round kind, Voting Round purpose and Round state are constrained **at the storage layer as well as in the API** – a kind outside `PostItRound` / `VotingRound`, a purpose outside `Poll`, a purpose on a Post-it Round, a Voting Round with no purpose, or a third state is unwritable through any path, not merely refused by a handler (FR1 → Validation). The two-level model is the one in `docs/UBIQUITOUS_LANGUAGE.md#session-activities`: **kind** distinguishes the two Activities, **purpose** distinguishes what a Voting Round is for, and adding the deferred Prioritization and Rating purposes must be an addition to the purpose constraint rather than a rewrite of the kind constraint.
- [x] This story adds **no cursor**: no row-version or watermark column on `round`, no trigger stamping one, no cursor field on any payload, and no polling loop, interval or cadence constant under `web/src` beyond the one that already exists. Near-live propagation is `round.activity_watermark_at` and the shared loop, both owned by S02 (`plan.json#sharedDecisions` → *Near-live propagation: one cursor*).
- [x] No Round write advances `conference.schedule_watermark_at`, and this story adds no trigger, column or write path that touches it – so the attendee schedule envelope, the live-editing poll and the offline cache diff are all left exactly as S09 and S10 left them.
- [x] The attendee schedule envelope (`api/src/sessions/schedule-envelope.ts`) carries no Round field, and nothing about a Round is written to the offline cache (`web/src/offline/schedule-cache.ts`) – offline support does not widen beyond schedule reads (Binding Constraint FR6).
- [x] Every endpoint added here resolves its caller through `withAuth` and its authority through `authorization.requireConferenceRole` – never an inline role, membership or assignment comparison in a handler body – with reads gated on **Membership** and every transition and authoring write gated on `PresenterFacilitator` narrowed by `{ sessionId }`. No request body field names or influences the acting identity (Binding Constraint FR3).
- [x] Round state is read from the database on every request. No module-level, static or process-global cache of Round state, Round lists or authority decisions exists anywhere in the API (Binding Constraint FR2, ADR-004).
- [x] Exactly **one** ballot-existence seam exists – a single port asking "does this Round have a Vote yet", bound in this story to an implementation that truthfully answers `false` because no Vote storage exists – and exactly one guard consumes it. No second freeze rule, constant, or feature flag is written anywhere in the Poll edit path, so S03's TI08 discharges the binding by replacing one function body.
- [x] The Round list, the authoring form and the run controls are legible with no horizontal scroll at 375 px, 768 px and 1280 px.


## Scope & Boundaries

### Work Areas
- `db/migrations/` – one new migration creating `round` and `round_option`.
- `api/src/rounds/` – Round validation, the Round repository, and the ballot-existence port plus the Poll-freeze guard.
- `api/src/routes/rounds.ts` (new) registered in `api/src/app.ts` – authoring, edit, open/close, and the one-request Session-with-Rounds read.
- `api/src/errors.ts` – the Round refusal codes, one per reason.
- `web/src/api/client.ts` – Round types and the four calls.
- `web/src/activities/` (new) – the Session Activities panel: the Round list with each Round's state, the run controls for a holder, and the authoring/edit form; reached from `web/src/schedule/SchedulePanel.tsx` and `web/src/attendee/ScheduleView.tsx`.
- `api/test/`, `web/test/`, `visual/` – behavioural tests, the structure test carrying the criteria above, and the three-width check.

### What We're NOT Doing
- **Contributions of any kind – Post-its and Votes** -- S02 and S03. This story ships no contribution endpoint and no ballot storage, so "an open Round admits contributions" is proved *there*; here an open Round is observable only as state. TI04's port is the single seam that keeps S03 from inventing a second freeze rule.
- **Round deletion and reordering** -- neither appears in FR1 or FR2. A Round is retained for the life of the Conference (PRD → Data Requirements); removing one is S05's Session-level concern, and reordering is not a stated need.
- **Adding Rounds to the attendee schedule envelope or the offline cache** -- the envelope is cached verbatim by S10, so a Round field there would silently widen offline support past the Binding Constraint. Rounds are read from their own endpoint, online only.
- **A dedicated Presenter/Facilitator composition surface for a draft Conference** -- the web reaches the Session Activities panel from the Organizer schedule (Admin, any lifecycle state) and from the attendee schedule (any Member, published or archived). A Presenter/Facilitator authors Rounds once the Conference is published, which US01's "ahead of the Session" needs; building them a draft-stage composition view is its own story.
- **The Prioritization and Rating Voting Round purposes** -- out of the PRD's MVP boundary; only the Poll purpose ships. They are **deferred, not rejected** ("each is its own later slice"), which is why `purpose` is a constrained column rather than a second kind – adding one later widens a CHECK on the purpose column and touches nothing else.
- **A Round cursor, a cursor field on the Session payload, and a client poll loop of this story's own** -- **superseded** by `plan.json#sharedDecisions` → *Near-live propagation: one cursor* in favour of S02's `round.activity_watermark_at`. All three were specified in an earlier revision of this FIS; none is to be rebuilt. See *Architecture Decision* for why, and TI11 for what ships instead.


## Architecture Decision

**Approach**: Rounds hang off `sessions` through a composite `(session_id, conference_id)` foreign key and are served by a **new per-Session read** (`GET /api/conferences/:conferenceId/sessions/:sessionId`) rather than being folded into the attendee schedule envelope. The read carries no cursor of its own: near-live propagation is `round.activity_watermark_at`, owned by S02.
**Why this over alternatives**: S10 caches that envelope verbatim, so any Round field added to it becomes offline scope by construction – which the Binding Constraint forbids – and every Round state change would advance the schedule watermark and fire S09's "what changed" banner with nothing schedule-shaped to report. A separate read keeps Round churn off the schedule cursor and leaves both mechanisms untouched.
**Superseded**: this story previously carried its own cursor – `roundsLastUpdatedAt`, a max Round row version computed on read, backed by a `last_updated_at` column and trigger on `round`, polled by a loop in TI11. That is **withdrawn** by `plan.json#sharedDecisions` → *Near-live propagation: one cursor*, because S02 independently specified `round.activity_watermark_at` with a trigger on the same UPDATE: two columns of identical semantics, two triggers, two cursors and two loops, each story believing it followed one mechanism. S02's wins – it matches S09's two-scalar poll shape, its `AFTER INSERT OR UPDATE OR DELETE` trigger makes a **delete** observable, and a tick costs two scalars instead of a whole Session payload. The cost is ordering: S02 lands after this story, so TI11 ships an interim refresh and S02's TI08 migrates the call site onto the shared loop.


## Technical Overview

Four API surfaces, one payload. `GET …/sessions/:sessionId` answers Membership-gated with the Session, its Rounds in authored order (each with kind, purpose where the kind is `VotingRound`, prompt-or-question, state, and for a Poll its ordered options) and a `canRun` flag stating whether *this* caller may operate the controls. **The payload carries no cursor.** The view refreshes by replacing that payload wholesale – S09's discipline, never a delta merge – and S02 turns the refresh into a cursor-gated one when `round.activity_watermark_at` and its two-scalar poll arrive.

**The two-level Activity model reaches the schema.** `docs/UBIQUITOUS_LANGUAGE.md#session-activities` names **Activity** as the umbrella, **Post-it Round** and **Voting Round** as its two kinds, and **Poll**, **Prioritization** and **Rating** as *purposes of a Voting Round*. The `round` row says the same thing: `kind ∈ {PostItRound, VotingRound}`, and a nullable `purpose ∈ {Poll}` that is present exactly when the kind is `VotingRound`. Flattening the two levels into a single `kind ∈ {PostItRound, Poll}` would put a purpose where a kind belongs and make each deferred purpose an alteration of a shipped kind constraint; the two-column shape enforces just as strongly and makes Prioritization and Rating additive. Everything this story ships is a Post-it Round or a Voting Round of the Poll purpose – "a Poll" throughout this FIS means exactly that row.


## Code Patterns & External References

```
# type | path#anchor or url                                        | why needed (intent)
file   | db/migrations/20260817210000000_session-assignment.sql    | Composite-FK + cascade idiom, and the ADR-003 comment header every migration carries
file   | db/migrations/20260817150000000_session.sql               | Check-constraint idiom (kind, non-empty trimmed text with a length cap) and the reversible down step
file   | api/src/conferences/schedule-gate.ts#createScheduleGate    | The port-with-a-truthful-stub pattern TI04 copies exactly – S03 introduced it, S04 discharged it
file   | api/src/routes/sessions.ts#registerSessionRoutes          | Route shape: authorize, then lifecycle, then write; JSON schema for shape only, business rules in a validation module
file   | api/src/conferences/authorization.ts#requireConferenceRole | The single authority check, and `options.sessionId` – the Session Assignment narrowing every write here uses
file   | api/src/sessions/session-validation.ts#validateSessionDetails | Field-level refusal shape: one `AppError` carrying per-field messages the form attaches to controls
file   | api/src/sessions/session-repository.ts#createSessionRepository | Repository seam: one projection, guards inside the UPDATE predicate, transactions where two statements must not be separable
file   | api/test/session-structure.test.ts                        | How this project asserts structural criteria against source and SQL on disk
file   | web/src/schedule/SessionForm.tsx#SessionForm              | Form + field-level refusal rendering the authoring form mirrors
file   | web/src/attendee/AttendeeSchedulePanel.tsx#AttendeeSchedulePanel | The existing poll loop TI11 hangs its call site on – view boundary, wholesale payload swap, failed-attempt resilience. Reuse it; S02 extracts it into the one shared loop
file   | docs/specs/session-activities/s02-named-post-it-contribution.md#implementation-tasks | The propagation this story defers to: TI02 (activity_watermark_at), TI07 (two-scalar poll), TI08 (shared loop, migrates TI11's call site)
file   | web/src/api/client.ts#ApiError                            | Error envelope mapping, `messageFor(field)` for inline field refusals
```


## Constraints & Gotchas

- **Constraint**: A Poll refuses reopening only once it has *run* – created-closed and closed-after-open are different states, and the schema must tell them apart. -- Workaround: record when a Round was closed (a nullable instant) and make the guard part of the open statement's own predicate, not a read-then-write in the route.
- **Avoid**: Enforcing the Poll freeze with a `TODO`, a constant, or a check against a table S03 has not created. -- Instead: one port, one guard, bound to an implementation that truthfully answers "no Vote exists" for the same reason `createScheduleGate` truthfully answered `false` before Sessions existed. S03's TI08 replaces one function body and re-runs S07 unmodified.
- **Critical**: No wireframe exists for either new surface (PRD → UI Wireframes). -- Must handle by: mirroring the existing organizer surfaces – `SessionForm` for the authoring form, `SchedulePanel`'s list/refusal idiom for the Round list and controls – and validating at all three widths. **ASSUMPTION**, recorded rather than assumed silently: shipping against the existing design idiom is preferable to blocking S01, and a later wireframe pass restyles without changing this contract.
- **Critical**: a Poll's *question text* freezes on the same trigger as its options — the existence of its first Vote. **CONFIRMED** by preflight on 2026-08-28 (see the DECISION NOTE for `poll-question-freeze-scope`); this is no longer an assumption and needs no further confirmation before execution. Implement the frozen question exactly as specified below: one guard, refusing an edit to a Poll's question **or** its options when the ballot-existence port answers `true`. An unvoted Poll stays fully editable — the trigger is that a Vote exists, not that the Poll was authored.
- **Constraint**: Reversing that assumption is **not** a one-line change, and this FIS previously said it was. -- Workaround: a reversal touches four places, all named here so the reverser can find them – Expected Outcome **OC04** (its second clause), scenario **S06** (the Poll question edit it permits only while no Vote exists), scenario **S07** (the question-edit refusal it requires), and **TI04**'s guard (the one place the rule is *implemented*). Only the last is a code change; the other three are contract statements that would otherwise contradict the code.
- **Avoid**: Advancing `conference.schedule_watermark_at` from a Round write "so attendees see it", or adding a cursor column or trigger to `round` to compensate. -- Instead: nothing here, and the interim refresh in TI11 until S02's `round.activity_watermark_at` arrives. Moving the schedule watermark fires S09's change banner and S10's reconnect summary for a schedule that did not change; adding a second Round cursor is exactly what `plan.json#sharedDecisions` withdrew.
- **Constraint**: A refusal from the authoring form or the run controls must survive the re-render its own handler causes (`docs/LEARNINGS.md#react-state--refusals`). -- Workaround: render the refusal outside the subtree the handler replaces, and keep the typed values in the form.


## Implementation Plan

### Implementation Tasks

- [x] **TI01** The `round` and `round_option` tables exist, scoped to their Session's Conference and reversible
  - One migration named after the existing timestamp convention, later than `20260817210000000`. `round`: id, `(session_id, conference_id)` composite FK to `sessions (id, conference_id)` with `ON DELETE CASCADE`, `kind` checked against exactly `PostItRound` and `VotingRound`, a nullable `purpose` checked against exactly `Poll` **and** against the two-level rule – `purpose IS NOT NULL` exactly when `kind = 'VotingRound'` – `prompt` (the Post-it prompt or the Poll question) non-empty-trimmed with a length cap, `state` checked against exactly `open` and `closed` defaulting to `closed`, an authored-order position, and a nullable `closed_at` instant. **No row-version or watermark column and no stamping trigger**: `round.activity_watermark_at` and its triggers are S02's (`plan.json#sharedDecisions`), and a second timestamp on the same row with the same semantics is the duplication that decision removed. `round_option`: id, round FK cascading, position, label non-empty-trimmed and capped, unique per round on both position and label. Copy the ADR-003 header comment and the down-step discipline from `db/migrations/20260817150000000_session.sql`, and carry a comment on `purpose` saying that Prioritization and Rating are deferred purposes that widen this CHECK rather than the `kind` one.
  - **Verify**: `npm run migrate:up` then `npm run migrate:down` leaves no `round` or `round_option` relation; an insert with `kind = 'Prioritization'`, with `kind = 'Poll'`, with `purpose = 'Rating'`, with a purpose on a `PostItRound`, with a `VotingRound` carrying no purpose, with `state = 'paused'`, with a blank prompt, or with two identically-labelled options in one round is rejected by the database with no API involved; deleting a Session removes its Rounds and their options; the migration source contains no `create extension`, no provider-specific identifier, and no timestamp column or trigger other than `closed_at`.

- [x] **TI02** Round field rules and their field-level refusals have one implementation
  - `api/src/rounds/round-validation.ts`, following `api/src/sessions/session-validation.ts#validateSessionDetails`: kind is one of two (`PostItRound`, `VotingRound`); a purpose is required and must be `Poll` when the kind is `VotingRound`, and is refused outright on a `PostItRound`; prompt/question trimmed, non-empty, within a stated cap; a Poll carries ≥2 options with trimmed, non-empty, capped labels that are distinct within the Round; order is preserved as given. Each refusal names the rule and the limit and carries per-field messages. Add the Round refusal codes to `api/src/errors.ts#ERROR_CODES` – one per *reason*, following the existing comment convention: invalid kind-or-purpose, invalid prompt/question, invalid option list, Round not found, transition not permitted, Poll content frozen.
  - **Verify**: `Test: a Poll with one option, with two options labelled "Tooling", with a blank question, and with an over-length question each produce a 400 whose envelope names the offending field; a VotingRound with no purpose, a VotingRound with purpose "Rating", and a PostItRound carrying a purpose are each refused naming the field; a Post-it Round needs no options; each refusal carries a code distinct from the others and from CONFERENCE_ROLE_REQUIRED`

- [x] **TI03** The Round repository owns the table and puts every state guard in the write statement
  - `api/src/rounds/round-repository.ts`, following `api/src/sessions/session-repository.ts#createSessionRepository`: one column projection – kind, purpose, prompt, state, position, `closed_at`, and **no row-version expression**, since this story adds no such column (TI01); create (Round and its options in one transaction, so a Poll can never be persisted without its options); list by Session in authored order with options in position order; find one; edit prompt/question and, for a Poll, replace the option set; open and close. **The reopen rule lives in the open statement's own predicate** – a Poll whose `closed_at` is set does not match it – so no read-then-write window exists. Closing sets `closed_at`.
  - **Verify**: `Test: opening a Poll that has been closed affects zero rows and the repository reports the refusal, while opening a Post-it Round in the same state succeeds; a create whose option insert fails leaves no Round row behind; a Poll created and never opened opens successfully`

- [x] **TI04** A single ballot-existence port answers "does this Round have a Vote yet", and a single guard consumes it
  - `api/src/rounds/ballot-gate.ts`, copying `api/src/conferences/schedule-gate.ts#createScheduleGate` including its comment discipline: the interface asks one question; the bound implementation answers `false` truthfully because no Vote storage exists yet. **The discharging task is named on both sides**: `docs/specs/session-activities/s03-anonymous-poll-voting-and-result-reveal.md` → **TI08** rebinds this port to the ballot storage S03 creates, and the file comment here must name that story and task ("discharged by S03 TI08") so the obligation is legible from the code as well as from both FIS files. Until it lands, the port answering `false` is the truth, not a stub. One exported guard refuses an edit to a Poll's question **or** its options when the port answers `true`, with the TI02 frozen-content code; a Post-it Round's prompt never consults it. Injected through `buildApp` the way `scheduleGate` is, so a test can bind a port that answers `true`.
  - **Verify**: `Test: with a port answering true, editing a Poll's question and editing its options are both refused with the frozen-content code and nothing is persisted, while the same Session's Post-it Round prompt edit succeeds; with the shipped port, both Poll edits succeed. Structure: exactly one file declares the port and exactly one guard consumes it`

- [x] **TI05** Authoring and editing a Round is available to the Session's holder and refused to everyone else
  - `api/src/routes/rounds.ts`, registered in `api/src/app.ts` beside `registerSessionRoutes`: `POST /api/conferences/:conferenceId/sessions/:sessionId/rounds` and `PATCH …/rounds/:roundId`. Same three steps and same order as `api/src/routes/sessions.ts#registerSessionRoutes`: `withAuth`, then `authorization.requireConferenceRole(caller, conferenceId, 'PresenterFacilitator', { sessionId })`, then `assertEditable` on the Conference, then TI02 validation, then TI04's guard on a Poll edit, then the TI03 write. JSON schema pins shape only. The acting identity comes from the caller context; no body field may name a user.
  - **Verify**: `Test: a Session Assignment holder creates a Post-it Round and a Poll and both read back closed with options in authored order; the same call on a Session the holder is not assigned to, and by a Member with no Role Assignment, is refused with CONFERENCE_ROLE_REQUIRED and persists nothing; an Admin succeeds on any Session in their Conference; a write on an archived Conference is refused`

- [x] **TI06** Opening, closing and reopening a Round is a named transition with the Poll rule stated in the refusal
  - `POST …/rounds/:roundId/open` and `POST …/rounds/:roundId/close`, following the named-transition shape of `POST /api/conferences/:conferenceId/publish` in `api/src/routes/conferences.ts`. Same authority as TI05, and the same `assertEditable` step on the Conference – a transition is a write, so an archived Conference refuses one (PRD FR2 → Error Handling). Reopen is `open` again; a Poll that has run is refused with the exact message **"A poll cannot be reopened once its results are shown."** and the TI02 transition code. Several Rounds in one Session may be open simultaneously – nothing closes another Round as a side effect.
  - **Verify**: `Test: open → close → open succeeds on a Post-it Round; on a Poll the second open is refused with that exact sentence and the Round stays closed; opening a second Round leaves the first open; a transition attempted by a non-assigned caller is refused with CONFERENCE_ROLE_REQUIRED; an open and a close attempted on a Round in an archived Conference are each refused by assertEditable with the Round's state unchanged (PRD FR2 → Error Handling)`

- [x] **TI07** One request returns a Session with its Rounds, their state, and the caller's authority over them
  - `GET /api/conferences/:conferenceId/sessions/:sessionId`, gated on **Membership** (`authorization.requireMembership`) so every Conference Member reads it; a draft Conference is readable only by a Role Assignment holder, consistent with the existing Draft rule. Payload: the Session as `toWire` shapes it, `rounds` in authored order each with kind, `purpose` (present exactly on a `VotingRound`), prompt-or-question, state and – for a Poll – ordered options, plus `canRun` (true for an Admin, or for a Session Assignment holder on this Session). **No cursor field of any name** – S02 adds the cheap two-scalar poll beside this read (`plan.json#sharedDecisions`), and a cursor here would be the second one that decision removed. **The attendee schedule envelope is not touched.**
  - **Verify**: `Test: a Member with no Role Assignment reads the Session, sees both Rounds with their kind and purpose, their states and the Poll's ordered options, and receives canRun false; the assigned Facilitator receives canRun true; a non-member is refused; the response body carries no timestamp, version or cursor field for the Round set; opening a Round leaves conference.lastUpdatedAt from GET /schedule/watermark unchanged; the schedule envelope's fields are byte-identical to before this story`

- [x] **TI08** The structural decisions are guarded against a later story undoing them by writing working code
  - `api/test/round-structure.test.ts`, following `api/test/session-structure.test.ts`: read the migration and the API sources on disk and assert the Structural Criteria above – plain PostgreSQL and a reversible down step; the composite FK rather than a bare `session_id`; kind, purpose (including the `purpose IS NOT NULL` ⇔ `VotingRound` rule) and state constrained in SQL; the migration declaring no timestamp column beyond `closed_at` and no stamping trigger, and no new cadence constant, interval or poll loop existing under `web/src`, so the single-cursor decision cannot be undone by a later edit; no Round source writes `schedule_watermark_at` and no new trigger references it; no Round field in `api/src/sessions/schedule-envelope.ts`; every Round route reaching authority through `requireConferenceRole` / `requireMembership` with no inline comparison; no module-level mutable Round state. Per `docs/LEARNINGS.md#testing`, assert each marker was **found** rather than skipping when absent, and pair the file-list assertions with the behavioural checks in TI07's Verify.
  - **Verify**: `Test: each structure assertion fails when its guarded property is deliberately reverted in a scratch copy – confirmed by reverting one property per assertion and re-running, not by reading the test`

- [x] **TI09** The web client speaks Rounds
  - `web/src/api/client.ts`: `Round`, `RoundKind` (`PostItRound` | `VotingRound`), `RoundPurpose` (`Poll`, optional and present only on a `VotingRound`), `RoundState`, `RoundOption`, `SessionWithRounds` types and the calls for read, create, edit, open and close, mapping refusals through the existing `ApiError` including `details` so the form can attach field messages. No cursor type and no watermark call – S02 adds those alongside its poll endpoint.
  - **Verify**: `Test: a field-level refusal from the create call surfaces as an ApiError whose messageFor('options') returns the server's message; a transition refusal surfaces its code and displayable message`

- [x] **TI10** A Session Activities panel shows every Member the Session's Rounds and their state, and shows a holder the controls
  - `web/src/activities/SessionActivitiesPanel.tsx` plus a `RoundForm` mirroring `web/src/schedule/SessionForm.tsx`: the Round list with each Round's kind, prompt-or-question, state and (for a Poll) its options; run controls and the authoring/edit form rendered **only** when `canRun` is true. Reached from `web/src/schedule/SchedulePanel.tsx` (Admin) and `web/src/attendee/ScheduleView.tsx` (any Member). Per `docs/LEARNINGS.md#react-state--refusals`, refusals render outside the subtree the submitting handler replaces, and typed values survive a refusal. Uses TI09's calls; consumes `canRun` from the payload rather than re-deriving authority on the client.
  - **Verify**: `Test: a payload with canRun false renders both Rounds with their states and renders no open/close control and no authoring form; with canRun true the controls appear; a refused create leaves the entered prompt and options in the form with the server's field message beside the offending control and the panel still mounted`

- [x] **TI11** An open Session view follows the Round state without a reload, using the loop that already exists rather than a new one
  - **Scope note, load-bearing**: this task builds **no polling loop, no cadence constant, no in-flight guard and no cursor comparison**. `plan.json#sharedDecisions` → *Near-live propagation: one cursor* gives all of that to S02, which owns `round.activity_watermark_at`, the cheap two-scalar poll and the one shared client loop it extracts from `web/src/attendee/AttendeeSchedulePanel.tsx`. What this task ships is a **call site**: the panel refreshes by re-reading TI07 on the cadence that existing loop already runs at, and replaces the payload **wholesale** – no delta merge, and the refresh lives at the view boundary, not inside the rendered tree, so S02's TI08 can migrate this call site onto the shared loop without touching the rendered tree. A failed attempt leaves the last successful payload on screen. Until S02 lands, a tick costs one Session read; that is the accepted interim price of shipping the enabler first, and S02 replaces it with a two-scalar compare. Per `docs/LEARNINGS.md#testing`, assert the rendered state rather than that a request was issued, and do not `waitFor` on the value under assertion.
  - **Verify**: `Test: with the second read reporting the Round open, the rendered state changes from closed to open with no user interaction and no remount; a failed read leaves the previously rendered Rounds and their states on screen unchanged. Structure: this story adds no new interval, cadence constant or in-flight guard under web/src – the count of each is unchanged from before the story`

- [x] **TI12** The new surfaces hold at every supported width
  - A `visual/session-activities.spec.ts` following `visual/live-editing.spec.ts` – fixture-served API, the three-viewport list, one capture per width – covering the Round list, the run controls and the authoring form, with a long prompt and a long option label so the text-heavy failure is the one being captured.
  - **Verify**: `Screenshot: the Round list, the run controls and the authoring form are captured at 375 px, 768 px and 1280 px with no horizontal scrolling at any width, including with an over-long prompt and option label on screen`

### Execution Contract
- TI04 must land before TI05's Poll-edit path – the guard is the only place the freeze rule may live.
- TI03's open/close predicates must land before TI06; the route must not re-implement the reopen rule it calls.
- TI07 must land before TI10 and TI11 – both consume `canRun` from that payload rather than deriving authority on the client, and TI11 re-reads that same payload.
- Nothing in this story may wait on S02. TI11's call site is deliberately shaped so S02's TI08 can migrate it; S02 does not need to have landed for this story to be complete.


## Final Validation Checklist
- [x] `GET /api/conferences/:id/schedule` returns a payload with no Round field, and nothing under `web/src/offline/` reads, writes or caches a Round – offline support is exactly as wide as it was (Binding Constraint FR6).
- [x] No file added or changed by this story contains a ballot, vote, voter or `sub`-carrying column in a Round context – S03 must inherit an unconstrained anonymity design (Binding Constraint FR4).
- [x] A Round write leaves `conference.schedule_watermark_at` untouched, confirmed against the live watermark endpoint, not only against the source.
- [x] Exactly one propagation mechanism is left standing for S02 to complete: `round` carries no timestamp column but `closed_at`, no stamping trigger, the Session read returns no cursor field, and `web/src` gained no second poll loop, interval or cadence constant (`plan.json#sharedDecisions` → *Near-live propagation: one cursor*).
- [x] The shipped vocabulary matches `docs/UBIQUITOUS_LANGUAGE.md#session-activities` at both levels – `kind` names the Activity (`PostItRound` / `VotingRound`) and `purpose` names what a Voting Round is for (`Poll`) – in the schema, the API payloads, the web types and the UI copy, with no column, field or type where `Poll` is used as a kind.


## Implementation Observations

> _Managed by exec-spec post-implementation – append-only. Spec authors: leave this section empty._

#### DECISION NOTE: poll-question-freeze-scope

Decision-Key: poll-question-freeze-scope
Altitude: fis-local
Affected surface: `## Constraints & Gotchas` – the **Critical** bullet on the Poll question freeze (the sole prose amended; OC04, the Poll-edit Acceptance Scenario, the ballot-existence Structural Criterion, TI04 and TI05's Poll-edit path already state the frozen question and need no amendment).
Decision: A Poll's question text freezes on the same trigger as its options – the existence of its first Vote. An unvoted Poll stays fully editable; the trigger is that a Vote exists, not that the Poll was authored.
Rationale: A ballot is an answer to the question, so a question edited after voting began makes a closed tally unverifiable. The source decision named options explicitly and was silent on the question; this ratifies extending it to the question.
Evidence: Confirmed by the user during an `andthen:preflight` run on the `docs/specs/session-activities` bundle, 2026-08-28; settles the interpretation flagged in `prd.md` → Assumptions and in `plan.json#executionNotes`.

Old:
```text
- **Critical**: PRD → Assumptions flags "a Poll's *question text* is frozen on the same trigger as its options" as an **interpretation to confirm**; FR1's acceptance criteria state it outright, and `plan.json#executionNotes` says it "should be confirmed rather than silently implemented" before S01 executes. -- Must handle by: **routing it to preflight, not to the executor's judgement**. Run the `andthen:preflight` skill on this FIS and settle the question there; an unattended `andthen:exec-spec` run started with this decision still open is starting one decision early. If preflight confirms, implement the frozen question exactly as specified below. **ASSUMPTION**, pending that confirmation: the question freezes with its options.
```

New:
```text
- **Critical**: a Poll's *question text* freezes on the same trigger as its options — the existence of its first Vote. **CONFIRMED** by preflight on 2026-08-28 (see the DECISION NOTE for `poll-question-freeze-scope`); this is no longer an assumption and needs no further confirmation before execution. Implement the frozen question exactly as specified below: one guard, refusing an edit to a Poll's question **or** its options when the ballot-existence port answers `true`. An unvoted Poll stays fully editable — the trigger is that a Vote exists, not that the Poll was authored.
```

### Run: 2026-08-28 22:24 UTC – discovered-requirements

#### DISCOVERED REQUIREMENTS

- **A Round's kind and purpose are immutable after creation** (TI05, `PATCH …/rounds/:roundId`). The FIS specifies the edit as "prompt/question and, for a Poll, replace the option set", and the request body carries `kind` (and `purpose`) because it is validated by the same TI02 rules the create path uses. It is silent on a body whose kind disagrees with the stored Round. Left unstated, the repository would have applied the prompt and ignored the kind — a Poll edited as a `PostItRound` would keep its options while the client was told the change landed, and any Post-it or Vote later pointing at it would be pointing at something it never was. Conservative interpretation implemented: the edit is **refused** with `ROUND_KIND_INVALID` (409) and a field-level message on `kind` when the sent kind or purpose differs from the stored Round's. `RoundForm` already disables both controls while editing, so the refusal is reachable only through the API. Covered by `api/test/round.integration.test.ts` → "refuses an edit that would change a round's kind or purpose".

### Run: 2026-08-28 22:26 UTC – observations

#### NOTICED BUT NOT TOUCHING

- `npm run format:check` fails on three files this story never touched: `api/test/join-code.test.ts`, `visual/conferences.spec.ts`, `web/src/components/JoinCodePanel.tsx`. Pre-existing on the working tree before this run; deliberately left unformatted so the story's diff stays its own.
- The development database (`DATABASE_URL`) was one migration behind the repository before this run — `20260817210000000_session-assignment` had never been applied to it. `npm run migrate:up` applied it alongside this story's `20260828090000000_round`. Nothing in the schema changed as a result; noted because a stale dev database silently changes what the running stack can do.

#### AMENDED TESTS OWNED BY EARLIER STORIES

Two existing structure tests pinned a fact that any later story adding to the codebase would break, and both were amended to keep their guard rather than to relax it:

- `api/test/membership-structure.test.ts` → *is unchanged by this story* asserted an **exact** listing of `db/migrations`. Its intent is that S08's revocation grew no table of its own, not that no migration may ever be added. Now asserts that S08's six migrations are still the head of the timestamp-ordered list, and that nothing appended since is a revocation/tombstone/audit record.
- `web/test/AttendeeSchedulePanel.test.tsx` → *offers no control to pick, attend, star or add a Session* asserted that the attendee session list contains **no buttons at all**. Now names the one permitted control explicitly (`attendee-activities-<id>`, one per Session) so the next control added to a Session card still has to argue for itself here; the checkbox, vocabulary and no-write assertions are unchanged.

#### ASSUMPTIONS

- **No wireframe exists for either new surface** (PRD → UI Wireframes; recorded in this FIS's Constraints & Gotchas). Shipped against the existing organizer idiom — `SessionForm` for the authoring form, `SchedulePanel`'s list/refusal idiom for the Round list and run controls — and validated at 375 / 768 / 1280 px. A later wireframe pass restyles without changing this contract.
- **The Activities panel is reached from a control on each Session card**, on the Organizer schedule (any lifecycle state) and on the attendee schedule (live views only). The FIS names both entry points but no interaction; a per-card toggle rendering one panel below the list was chosen because at 375 px a Round list, its run controls and an authoring form have nowhere to go inside a card that is already a wrapping flex row. The attendee entry point is withheld while the view is served from the offline cache, since Rounds are deliberately not cached (Binding Constraint FR6).

### Run: 2026-08-28 22:50 UTC – observations

#### POST-REVIEW REMEDIATION (fresh-context critic pass)

Nineteen findings were raised. Thirteen were accepted and fixed in this run; the rest are recorded below as deliberate non-changes.

**Fixed — behaviour**

- `canRun` now means *these controls will work*, not *you hold the authority*: `mayRun` returns false on an archived Conference. Previously a holder reading an archived Session was offered Open / Close / Edit / Add, every one of which `assertEditable` refused with a 409.
- `SessionActivitiesPanel` drops its open editor, save error and refusal when `sessionId` changes. The panel is never remounted (both call sites toggle by id at the same element position), so an editor left open across a Session switch would have PATCHed the previous Session's round id under the new Session's path.
- The re-reads that follow a **successful** create/edit/open/close now pass `keepOnFailure`. A blip on that extra read used to replace the whole Round list with an error box — at the exact moment a Facilitator has just opened a Round in front of the room.
- `SchedulePanel` clears `activitiesFor` when the Conference Day changes, so the panel closes explicitly instead of being filtered out of the render and silently discarding a half-typed Round.
- An edit that would change a Round's kind or purpose now refuses with its own code, `ROUND_KIND_IMMUTABLE` (409), and the check runs **before** the field rules — a caller trying to turn a Post-it Round into a Poll was being told to add a second option. An unknown kind is still `ROUND_KIND_INVALID` (400).
- Prompt and option-label lengths are measured in code points (`[...value].length`), matching PostgreSQL's `char_length`. The two layers were stating different 500s and 120s for non-BMP text.
- Every Round read orders by `position, id`. `create` takes `max(position) + 1` without an exclusion, so two concurrent creates can tie; the tiebreaker keeps the list order total and stable rather than plan-dependent. The comment claiming the transaction prevented the tie has been corrected.
- `.round-card__prompt` / `.round-card__options` no longer restate `overflow-wrap`. `body` already declares `break-word` and it inherits; the local copies were inert while reading as load-bearing.

**Fixed — proof**

- `visual/session-activities.spec.ts` gained an attendee-surface capture at all three widths (`canRun: false`, no controls), a genuinely unbroken fixture token (the first one was hyphenated, and a hyphen is a break opportunity even at `overflow-wrap: normal`), and `assertWrapsInsideItsBox`, which compares `scrollWidth` with `clientWidth`. Verified by flipping the inherited wrap rule to `normal`: both 375 px tests fail, and pass again when it is restored.
- `web/test/SessionActivitiesPanel.test.tsx` now synchronises on **answered** requests rather than issued ones. Counting requests let the failed-refresh guard pass before the response had been handled at all — vacuous in exactly the way `docs/LEARNINGS.md#testing` describes. Three new/repaired cases were each confirmed red against a deliberate revert of the code they guard.
- `api/test/round-structure.test.ts`'s Session-narrowing assertion now slices each function's own body and inspects the `requireConferenceRole` **call**. The previous file-wide regex stayed green when `{ sessionId }` was deleted from `authorizeWrite`, because `mayRun` still carried one and `sessionId` appears throughout both bodies as a route parameter.
- New integration cases: `canRun` on an archived Conference; a draft Session read by a role holder and refused to a plain member (that branch previously shipped unexercised); and the `create` transaction rollback, driven at the repository because the route's own validation refuses a duplicate label before any write.

**Accepted, deliberately not changed**

- **The freeze is a read-then-write across two statements.** Harmless while the port answers a constant, but it pre-commits S03. `ballot-gate.ts` now says so outright: S03 TI08 must either bind the port to a predicate the write statement carries or take the option replacement into the same transaction under a row lock. It is not a straight body swap.
- **Two `load()` calls can race** (a tick read and an action's re-read) with no ordering guard, so a stale response can briefly flip a badge back. Fixing it needs a sequence-number ref, and whether that counts as the in-flight guard the Structural Criteria forbid is a decision this FIS does not pin down.
- **A refresh keeps the last payload on a 403/404 too**, so a deleted Session or a revoked role reads as live data indefinitely. Distinguishing *the server answered* from *the request did not get through* is the rule `AttendeeSchedulePanel` already applies, and applying it here is a behaviour decision at a new surface rather than a mechanical correction.
- **The organizer-side panel never refreshes.** `SchedulePanel` has no loop to hang a tick on and TI11 forbids adding one. Recorded at the call site; wiring it to S02's shared loop is a line at that point.
- **`round` has no `UNIQUE (session_id, position)`.** Adding one needs a retry path, and reordering is out of scope; the `position, id` tiebreaker is where this story stops.
- **The amended `membership-structure` guard is narrower than the listing it replaced** — it catches revocation-shaped names rather than any new migration. Tightening a guard owned by S08 is that story's call.
- **`isDraft` is not yet the single draft rule.** `routes/attendee.ts` still compares inline, and the two refuse differently on purpose (`CONFERENCE_NOT_READABLE` vs `CONFERENCE_ROLE_REQUIRED`). The comment now says so instead of claiming a unification that does not exist.
