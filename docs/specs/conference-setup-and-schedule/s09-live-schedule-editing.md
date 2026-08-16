# S09 – Live Schedule Editing

**Plan**: docs/specs/conference-setup-and-schedule/plan.json
**Story-ID**: S09

## Feature Overview and Goal

**Intent**: A conference schedule moves while the conference is running – a room changes, a speaker is late, a Session is dropped – and an Organizer must be able to make that change on a published Conference and have the room's phones agree with it seconds later, without two Admins quietly overwriting each other.

**Expected Outcomes** (scenarios anchor to these via `[OC<NN>]`):

- [OC01] An Organizer changes any Session field – including its Conference Day – and adds or deletes Sessions on a **published** Conference, and each change is persisted with a recorded change timestamp.
- [OC02] An Attendee with the Schedule already open sees those changes within a few seconds **without a manual reload**, and the view states how recently the Schedule updated.
- [OC03] A concurrent save never silently wins: a second save whose base version has moved is refused and the editor is shown the newer version to re-apply onto, and an edit racing a publish or archive is refused with the Conference's new lifecycle state named.
- [OC04] The Conference name and date span are editable after publish, with shortening refused while Sessions fall outside the new span and a Session move outside the span refused – both naming what is permitted.
- [OC05] An Attendee who was online throughout the change is **told in the app which Session changed and what changed about it** – the change is never a silent swap under their eyes – and that same "what changed" derivation is the one S10 later reuses for its reconnect summary.


## Required Context

- `docs/specs/conference-setup-and-schedule/prd.md#fr7-live-schedule-changes--notification` – the acceptance criteria this story implements **minus push fan-out**: every Session field editable after publish, add/delete after publish, Conference name and date span editable with shortening refused, recorded change timestamps, near-live reflection in the attendee view, "same validation as FR2 plus a Session cannot be moved outside the conference date span", and **"the notification names the session and what changed"** – that last criterion needs no push infrastructure, so it ships here through the in-app channel (TI03's banner) rather than deferring with the fan-out. FR7's *delivery* criteria, its debounce rule and its trivial-edit exemption are deferred – see *What We're NOT Doing*.
- `docs/specs/conference-setup-and-schedule/prd.md#executive-summary` – the success metric expects every material change to reach attendees, "as a push on the mobile shells, and **in-app** on the web build and after an offline period". The in-app half is this story's; the push half is deferred. Owner-confirmed: attendees are expected to be online, so in-app is the primary channel this release.
- `docs/specs/conference-setup-and-schedule/prd.md#edge-cases` – four rows are load-bearing here: two Admins editing the same Session, one Admin archiving or publishing mid-edit, a shortened date span orphaning Sessions, and a Session deleted after publish. The push-delivery-failure row supplies the fallback rule this story's refresh path must honour: the in-app view as of its **last successful sync** is the source of truth.
- `docs/specs/conference-setup-and-schedule/prd.md#non-functional-requirements` – the ~5s propagation row is this story's near-live bar, satisfied in-app. Binding Constraints (NFR): `hd` claim verified server-side on every request (ADR-002); plain PostgreSQL only, no provider-specific extensions (ADR-003); responsive behaviour verified at 375px / 768px / 1280px per `AGENTS.md`.
- `docs/specs/conference-setup-and-schedule/prd.md#constraints` – Binding Constraints: Session times are **naive wall-clock values**, stored and displayed without timezone conversion – the refresh path must not reintroduce a `Date` round trip S04 removed; and roles are confApp's own per-conference data, never derived from directory groups (ADR-002).
- `docs/specs/conference-setup-and-schedule/s04-schedule-composition.md` – **read before writing any endpoint here**. Owns the Session model, all field/range/day-containment validation (reused unchanged – do not restate or re-implement it), the wall-clock wire format, and two of the three timestamp fields. **Three distinct fields, deliberately dissimilar column names** (S04 *Constraints & Gotchas*): `session.last_updated_at`, the per-Session row version used as this story's Session-edit concurrency base; `conference.schedule_watermark_at`, the whole-schedule watermark advanced by Conference field changes *and* by any Session insert, update **or delete** (which is what makes deletions observable to a polling client), serialized as S06's `conference.lastUpdatedAt`; and `conference.updated_at`, the Conference row's own version, owned by S03. S04's Structural Criteria pin that `updated_at` advances **only** on a Conference field change, with TI02's Verify failing if a Session write moves it.
- `docs/specs/conference-setup-and-schedule/s03-conference-lifecycle.md` – the lifecycle state machine and the exported editability/joinability guards (TI02, TI10) this story calls rather than re-deriving, the provisional per-conference authorization helper every check routes through, and the Conference row's own `updated_at` column (TI01) which S03's TI06 returns as `updatedAt` on the single-Conference read – so the base version this story requires on a name/date-span edit is a field the API actually sends.
- `docs/specs/conference-setup-and-schedule/s06-attendee-schedule-view.md#technical-overview` – the pinned schedule read model and cache envelope, including `conference.lastUpdatedAt` and `conference.state` carried but deliberately not acted on there. This story's refresh **replaces that same envelope wholesale**; consume its shape and its `render(envelope, effectiveWallClockNow)` component tree, and respect its rule that nothing inside the tree fetches – the poll loop belongs at the view boundary. Do not design a second schedule payload or a delta format.
- `docs/specs/conference-setup-and-schedule/plan.json#sharedDecisions` – all six entries bind S09: S01's route and error-envelope conventions (every refusal here carries a displayable message and a machine code), S02's authenticated caller context, S07's per-conference authorization primitive (via S03's provisional helper), the naive wall-clock representation, *Conference and Session timestamps – three fields, four consumers* (this story is the consumer that needs all three kept apart), and S06's schedule read model and cache envelope.
- `docs/UBIQUITOUS_LANGUAGE.md#conference-structure` – canonical terms: Conference, Conference Day, Schedule, Session, Admin (also *Organizer*), Attendee. Avoid the listed synonyms in code, API fields and UI copy.
- `docs/guidelines/CRITICAL-RULES-AND-GUARDRAILS.md` and `AGENTS.md` – always-on rules; in particular no in-process state between requests (the poll target is a database read, never a cached counter), no provider-specific database features, and no desktop-only layout.


## Deeper Context

- `docs/specs/conference-setup-and-schedule/s01-tracer-bullet-skeleton.md#constraints--gotchas` – the concrete error-envelope JSON shape, the existing machine-code list to extend rather than duplicate, and the route-registration and API base URL conventions this story's new endpoint follows.
- `docs/DECISIONS.md` – "Update latency: near-live – a few seconds is acceptable … polling or a lightweight push is sufficient" is the decision this story's mechanism rests on; **Push delivery service** is still listed under Pending, which is why push fan-out is out of scope.
- `docs/adrs/ADR-004-containerized-api-and-spa.md` – **accepted 2026-08-16, supersedes serverless-on-Azure.** The API is a long-running containerized HTTP server, not the Azure Functions programming model, and no cold-start allowance shapes the poll cadence. Statelessness still binds, now because handlers run across horizontal replicas: the watermark is read from the database per poll, never held in process. Read `plan.json#sharedDecisions`' stale "Azure Functions HTTP route layout" phrasing as S01's route layout, unchanged by the runtime swap.
- `docs/ARCHITECTURE.md#key-constraints` – near-live not real-time; native push, never web push; handlers hold no in-process state (per ADR-004, because replicas scale horizontally – the document's serverless framing is superseded).
- `docs/specs/conference-setup-and-schedule/plan.json#riskSummary` – the S09 entry: optimistic concurrency and near-live refresh are both easy to under-test; drive both edge cases explicitly and assert the attendee view updates without a manual reload.
- `docs/specs/conference-setup-and-schedule/prd.md#fr8-offline-schedule-access` – S10 consumes the same watermark as its cache cursor and renders the reconnect "what changed" summary for an Attendee who **was offline**. S10 lands a wave later and **consumes this story's envelope-diff function (TI03) rather than building a second one**; nothing here caches.


## Acceptance Scenarios

- [ ] **S01 [OC01,OC02] [TI01,TI02,TI04,TI09,TI10] A room change on a published Conference reaches an open attendee Schedule within the near-live window with no reload**
  - **Given** the published Conference "Autumn Offsite" is running, and Björn has its Schedule for 2026-09-15 open on his phone showing "Opening Keynote" 09:00–10:30 in "Room A"
  - **When** an Admin edits that Session to 09:30–11:00 in "Room B" and Björn touches nothing
  - **Then** within a few seconds Björn's open view shows 09:30–11:00 and "Room B" – no manual reload, no navigation – the times read exactly as authored with no timezone shift, and the view's staleness indicator resets to "just now" (an elapsed age, not a wall-clock time of day)

- [ ] **S02 [OC01,OC02] [TI01,TI02,TI03,TI10] A Session added and another deleted after publish both appear on an open attendee Schedule**
  - **Given** the published Conference "Autumn Offsite" has "Opening Keynote" and "Retrospective" on 2026-09-15, and Björn has that day open
  - **When** an Admin adds "Lightning Talks" 13:00–14:00 on 2026-09-15 and deletes "Retrospective"
  - **Then** Björn's open view gains "Lightning Talks" in start-time order and loses "Retrospective" within a few seconds, and the deletion alone – with no other write – is enough to trigger the refresh

- [ ] **S03 [OC03] [TI04,TI10] Two Admins edit the same Session at once and the second save is refused, not silently applied**
  - **Given** Ida and Björn both open "Opening Keynote" (09:00–10:30) for editing, so both hold the same base `lastUpdatedAt`
  - **When** Ida saves the start time as 09:30 and Björn then saves the location as "Room C" against his now-stale base value
  - **Then** Björn's save is refused with a displayable message stating the Session changed since he opened it, nothing of Björn's edit is persisted, Ida's 09:30 stands, and Björn is shown the current version (start time 09:30) so he can re-apply "Room C" on top of it – a second save carrying the newer base value then succeeds and yields 09:30 in "Room C"

- [ ] **S04 [OC03] [TI05,TI10] A lifecycle transition by one Admin wins over another Admin's in-flight edit**
  - **Given** Ida has "Opening Keynote" open for editing on the Conference "Autumn Offsite", which is published and past its end date
  - **When** Björn archives the Conference and Ida then saves her edit
  - **Then** Ida's save is refused with a message naming the Conference's new state, **archived**, rather than a generic version conflict, and nothing is persisted
  - **And** the same holds for the publish transition: an edit begun while the Conference was in draft and saved after another Admin published it is refused naming the **published** state

- [ ] **S05 [OC04] [TI06,TI07,TI10] Shortening the date span is refused while Sessions fall outside the new span, naming them**
  - **Given** the published Conference "Autumn Offsite" spans 2026-09-15 to 2026-09-17 and has "Retrospective" on 2026-09-17
  - **When** an Admin changes the span to 2026-09-15 – 2026-09-16
  - **Then** the change is refused, the span is unchanged, and the message names "Retrospective" on 2026-09-17 as the Session that would be orphaned
  - **And** after "Retrospective" is moved to 2026-09-16, the same span change succeeds and the Conference name may be changed in the same way

- [ ] **S06 [OC04] [TI08] Moving a Session to a day outside the Conference date span is refused, naming the permitted days**
  - **Given** the published Conference "Autumn Offsite" spans 2026-09-15 to 2026-09-16
  - **When** an Admin edits "Opening Keynote" to sit on 2026-09-18
  - **Then** the save is refused with the permitted days (2026-09-15 and 2026-09-16) named, nothing is persisted, and the refusal is produced by S04's existing day-containment validation rather than a second copy of it

- [ ] **S07 [OC02] [TI02,TI03] A failed refresh leaves the last successful sync on screen rather than blanking the Schedule**
  - **Given** Björn has the Schedule open and it last synced successfully at 09:41
  - **When** the venue wifi drops and the next refresh attempt fails
  - **Then** the Schedule stays on screen exactly as it was at the last successful sync, its staleness indicator keeps counting up as elapsed age ("updated 4 minutes ago", then 5, …), no error replaces the content and no empty state is shown
  - **And** when connectivity returns the next attempt succeeds, any change made in the meantime appears without a manual reload, and the age resets to "just now"

- [ ] **S08 [OC05,OC02] [TI02,TI03] An Attendee online throughout the change is told which Session changed and how – with no push involved**
  - **Given** Björn has the Schedule for 2026-09-15 open and online, showing "Opening Keynote" 09:00–10:30 in "Room A" and "Retrospective" 15:00–16:00
  - **When** an Admin moves "Opening Keynote" to 09:30–11:00 in "Room B" and deletes "Retrospective", and Björn touches nothing
  - **Then** alongside the refreshed times Björn is shown an in-app change banner naming **"Opening Keynote"** with its time and location as what changed, and **"Retrospective"** as removed – the schedule never simply swaps beneath him unannounced
  - **And** the banner is produced by the client-side diff of the previous and refreshed envelopes with no push, device token, notification record or server-side notification call anywhere in the path
  - **And** dismissing the banner leaves the refreshed Schedule in place, and a subsequent unchanged poll does not re-raise it


## Structural Criteria

> Each criterion is proved by a task Verify line, not a scenario.

- [ ] Session field, range and day-containment validation has exactly one implementation – S04's – and the post-publish edit path calls it; no validation rule is restated or duplicated in this story's handlers.
- [ ] The lifecycle-state check runs **before** the optimistic-concurrency check on every write path, so an archive or publish during an edit yields the state-named refusal and never a bare version conflict.
- [ ] The watermark poll target is a single-row database read returning the Conference's watermark (`schedule_watermark_at`, on the wire as `lastUpdatedAt`) and lifecycle state only – it never returns the Schedule payload and holds no in-process state between requests or between replicas.
- [ ] The attendee refresh replaces S06's schedule envelope in place and renders through S06's existing component tree – no second schedule payload shape, delta format, or parallel render path exists. The change banner is presentation over the diff of two envelopes, not a third payload.
- [ ] Exactly one envelope-diff function exists – pure, taking a previous and a current S06 envelope and returning added, removed and changed Sessions with the names of the changed fields – exported for S10 to consume for its reconnect summary; no second "what changed" derivation is written here or left for S10 to write.
- [ ] Wall-clock values survive the refresh path unchanged – no `Date` construction, `Date.parse`, `toLocaleTimeString` or `Intl.DateTimeFormat` is applied to a Session day or time anywhere in the poll/refresh code, and the diff compares them as strings.
- [ ] The staleness indicator renders an **elapsed age**, never a clock time derived on the client: no timezone conversion of the watermark instant exists anywhere in the view, and if an absolute time is ever displayed it is a naive wall-clock string carried in the envelope beside `serverNow.time` (S06's contract).
- [ ] The concurrency base sent with a Conference name/date-span edit is `conference.updated_at`; no code path uses `conference.schedule_watermark_at` (wire `conference.lastUpdatedAt`) as an edit precondition, and no code path uses `conference.updated_at` as the poll comparison.
- [ ] Every refusal added here emits through S01's error envelope with a displayable message and a machine code distinct per reason (version conflict, lifecycle-state change, span would orphan Sessions).
- [ ] Every endpoint added here obtains its caller through S02's context and its authorization through S03's single provisional per-conference helper; schema changes, if any, are plain PostgreSQL with a reversible migration.
- [ ] The conflict-resolution UI, the staleness indicator, the change banner and the Conference detail edit form are legible without horizontal scroll at 375px, 768px and 1280px.


## Scope & Boundaries

### Work Areas
- Schedule watermark endpoint – cheap per-Conference `lastUpdatedAt` + lifecycle state read for polling clients.
- Attendee schedule refresh client – poll loop, visibility/focus handling, in-place envelope swap, elapsed-age staleness indicator, failed-attempt resilience.
- Envelope-diff function and in-app change banner – one pure diff of two S06 envelopes (exported for S10) and the attendee-facing banner naming the affected Session(s) and what changed.
- Session write path – base-version precondition, conflict refusal carrying the current version, lifecycle-race guard.
- Conference detail edit endpoint – post-publish name and date-span change with span-containment refusal.
- Organizer schedule view – post-publish add/edit/delete affordances and inline conflict / state-change refusal handling with re-apply.

### What We're NOT Doing
- **Push notification delivery (APNs/FCM fan-out to the conference's Attendees)** -- deferred: it depends on push infrastructure REQ-005, which does not exist, and on a push delivery service still listed Pending in `docs/DECISIONS.md`. FR7's own text states the schedule edit has no such dependency and can ship without notification. Recorded as a follow-on requirement, not silent scope loss. **The in-app change banner delivered here is not push** – it is the in-app channel the owner designated as primary for this release, and it introduces no push surface (see *Final Validation Checklist*).
- **FR7's debounce-per-session and trivial-edit (description/typo) notification rules** -- these exist only to shape *push* volume; with no push channel they have nothing to govern, and they return with it. The in-app banner deliberately reports *every* change the diff finds, including a description edit: a banner on an already-open view costs the attendee nothing, and silent suppression is the failure this story exists to prevent.
- **The reconnect "what changed" summary and any schedule caching** -- S10 owns the reconnect surface and the cache, using the same watermark as its cursor and **consuming this story's exported envelope-diff function** rather than deriving "what changed" a second time. Nothing here writes a cache: the failed-refresh behaviour specified in **scenario S07 of this FIS** (not *story* S07, which is per-conference roles) is in-memory, in-session resilience only – the last successful envelope stays on screen and is gone when the app is.
- **Re-designing the attendee schedule read model** -- S06 owns the envelope, the day navigation and the running-session highlight; this story only swaps fresher data into it.
- **Merge or field-level conflict resolution** -- the refused editor re-applies their edit onto the newer version by hand. Automatic merging is not asked for and would be the sync-conflict machinery the product's anti-goals reject.


## Architecture Decision

**Approach**: Attendee clients poll a cheap per-Conference watermark endpoint on a few-second cadence and refetch S06's schedule envelope only when the watermark has advanced; the client diffs the previous envelope against the refreshed one to say what changed, and every write carries the base row version it was loaded with as an optimistic precondition, with a mismatch refused and the current version returned.
**Why this over alternatives**: near-live is explicitly a few seconds (`docs/DECISIONS.md`), so a socket or SSE channel would add connection-affinity concerns across container replicas (ADR-004) for latency nobody asked for, and push has no delivery service decided and never reaches browser attendees anyway – polling a watermark S04 already maintains is the one channel that covers all three surfaces with no new moving parts. "What changed" is derived on the client because the two envelopes are already in hand there; deriving it server-side would mean remembering per-client state, which the stateless-handler rule forbids.


## Technical Overview

**Three timestamp fields, two directions.** **Outbound**: the watermark endpoint returns the Conference's `schedule_watermark_at` (wire name `lastUpdatedAt`, per S06's envelope) and lifecycle state and nothing else; the client compares it with the value on the envelope it is rendering and refetches S06's schedule only on a change, so the steady state is one tiny read per client per interval. Because that watermark advances on Session **deletes** as well as inserts and updates, and on Conference field changes, a single scalar covers every change this story can produce. **Inbound**: a write carries the base version of the thing it edits – `session.last_updated_at` for a Session edit, `conference.updated_at` for a Conference name/date-span edit. The separation of those three columns is an established guarantee, not an assumption to hedge: S04's Structural Criteria pin that `conference.updated_at` advances **only** on a Conference field change and is untouched by every Session insert, update and delete (its TI02 Verify fails otherwise), and S03 TI06 returns it as `updatedAt` on the Conference read. Using the watermark as a Conference-edit precondition is therefore simply a defect – it advances on every Session write and would refuse edits that conflict with nothing. Each write runs three checks in fixed order – authorization (S03's helper), lifecycle state, then base version – so the edge cases produce distinct, correctly-named refusals rather than collapsing into one.

**Saying what changed, without push.** A refresh is the one moment the client holds both the previous and the refreshed envelope, so "what changed" is a pure local computation over two payloads – Sessions added, removed, and changed by named field – needing no server state, no per-client bookkeeping and no delivery channel. That one exported function serves both audiences: the in-app banner renders it for an Attendee who stayed online, and S10 renders its output as the reconnect summary for one who was offline, so the two surfaces cannot disagree. Its comparisons are string comparisons on S04's wall-clock values; nothing in the path parses a time.


## Code Patterns & External References

```
# type | path#anchor or url                                                       | why needed (intent)
prd    | docs/specs/conference-setup-and-schedule/prd.md#fr7-live-schedule-changes--notification | Criteria implemented here; validation is "same as FR2" plus span containment
prd    | docs/specs/conference-setup-and-schedule/prd.md#edge-cases                | Exact expected behaviour + recovery path for the two concurrency rows
spec   | docs/specs/conference-setup-and-schedule/s04-schedule-composition.md      | Session model, validation to reuse unchanged, the three timestamp columns and their guarantees
spec   | docs/specs/conference-setup-and-schedule/s03-conference-lifecycle.md      | Exported editability guard, transition state machine, authz helper signature
spec   | docs/specs/conference-setup-and-schedule/s06-attendee-schedule-view.md    | Schedule envelope + component tree the refresh replaces in place
plan   | docs/specs/conference-setup-and-schedule/plan.json#sharedDecisions        | Error envelope, caller context, authz primitive, wall clock, watermark, read model
doc    | docs/UBIQUITOUS_LANGUAGE.md#conference-structure                          | Canonical naming for Conference / Conference Day / Schedule / Session
adr    | docs/adrs/ADR-004-containerized-api-and-spa.md                            | Container API runtime – plain HTTP server, statelessness across replicas, no cold-start allowance
```

> S01–S06 create the route layout, error envelope, caller context, Session endpoints and attendee view this story extends. Read those surfaces as built before writing code; do not re-derive their conventions.


## Constraints & Gotchas

- **Critical**: the Conference's two timestamp columns mean different things and are deliberately named apart -- Must handle by: using `conference.schedule_watermark_at` (wire `conference.lastUpdatedAt`) **only** for the outbound poll comparison, and `conference.updated_at` (S03 TI01, wire `updatedAt`) as the sole concurrency base for a name/date-span edit. Both halves are guaranteed upstream – S04 pins that a Session write never advances `updated_at`, S03 TI06 puts `updatedAt` on the Conference read – so do not "tidy" the names together and do not add a further version column.
- **Critical**: check order on every write is authorization → lifecycle state → base version -- Must handle by: one shared precondition step used by both the Session and Conference write paths. Reversing the last two turns "the Conference was archived" into a bare version conflict and loses the edge case's required message.
- **Avoid**: comparing versions with a re-parsed or reformatted timestamp -- Instead: compare the exact serialized `lastUpdatedAt` value the client was given. S04 keeps microsecond precision on the wire specifically so this comparison is exact; truncating or round-tripping it through a `Date` collapses two distinct versions into one and reinstates last-write-wins.
- **Avoid**: polling continuously while the app is backgrounded or the tab is hidden -- Instead: pause on hidden and refresh **immediately** on becoming visible or focused. A phone in a pocket for an hour must not burn battery, and an attendee returning to the app expects current data at once rather than after the next tick.
- **Constraint**: 100 concurrent Attendees polling is the capacity case (`prd.md#non-functional-requirements`) -- Workaround: keep the watermark response to the two scalars, guarantee at most one in-flight poll per client, and skip a tick rather than queueing when one is outstanding.
- **Critical**: the watermark is an **instant** and must never be rendered as a time of day -- Must handle by: showing staleness as elapsed age ("updated 4 minutes ago"), computed as `(deviceNow + S06's clock offset) − lastUpdatedAt` – instant minus instant, no timezone involved. A clock-time rendering needs a timezone the product does not carry, and on a device set away from the venue it would contradict every Session time on the same screen. Any absolute "last updated" time must instead arrive as a naive wall-clock string in the envelope beside `serverNow.time` (S06's contract), never be derived on the client.
- **Constraint**: a refused edit must not lose the editor's typed input -- Workaround: the conflict response carries the current server version; the form keeps the user's values alongside it so "re-apply the edit on top of the current version" is a real recovery path, per the edge-case table.


## Implementation Plan

### Implementation Tasks

- [ ] **TI01** A watermark endpoint reports a Conference's current schedule version and lifecycle state
  - Single-row read returning the Conference watermark `schedule_watermark_at` – serialized as `lastUpdatedAt`, matching S06's envelope field – and lifecycle state, for a Conference the caller is a member of; caller via S02, authorization via S03's provisional helper; no Schedule payload, no in-process or cross-replica state. Route and error shape per S01, against the container API's plain HTTP framework (ADR-004).
  - **Verify**: `Test: the response body carries only the watermark and lifecycle state; a non-member is refused; the value advances after a Session update and after a Session delete with no other write`

- [ ] **TI02** The attendee Schedule refreshes itself from the watermark without any user action
  - Polls TI01 on a cadence meeting the ~5s propagation row, refetches S06's envelope only when the watermark advanced, and hands the new envelope to S06's existing component tree at the view boundary – nothing inside that tree fetches, per S06's rendering contract. **Retains the outgoing envelope across the swap and passes it with the refreshed one to TI03's diff function**, which is the only reason both are in hand at once. Pauses while hidden/backgrounded and refreshes immediately on visibility or focus; at most one poll in flight, ticks skipped rather than queued. Consumes S06's envelope unchanged – see Constraints & Gotchas on wall-clock values.
  - **Verify**: `Test: with a Session edited server-side, an already-rendered Schedule shows the new values within the near-live window with no reload or navigation; the refreshed Sessions render through S06's schedule components from S06's envelope shape with no second payload shape or delta format; refreshed times read identically with the client timezone set to UTC-7 and UTC+9; an unchanged watermark triggers no schedule refetch; hiding the view stops polling and revealing it triggers an immediate refresh; the previous envelope is passed to the diff on every swap`

- [ ] **TI03** The Schedule names what changed, states how recently it updated, and survives a failed refresh
  - **Envelope diff**: one pure exported function `diffSchedule(previousEnvelope, currentEnvelope)` returning Sessions added, Sessions removed, and Sessions changed with the names of the changed fields (day, start/end time, location, title, kind, description). Compares S04's wall-clock values as strings – no `Date` anywhere. Matching is by Session id, so a Session moved between Conference Days is one *changed* Session, not a remove plus an add. **This function is S10's reconnect summary source too** (see *Execution Contract*), so keep it pure, envelope-in/result-out, and free of view or connection assumptions.
  - **Change banner**: when the diff is non-empty after a refresh, the attendee view shows an in-app banner naming the affected Session(s) and what changed about each ("Opening Keynote moved to 09:30–11:00, now in Room B"; "Retrospective was removed"), dismissible, and not re-raised by a subsequent poll that changed nothing. This is the in-app channel, not push – no device token, notification record or server call is involved.
  - **Staleness indicator**: renders **elapsed age** since the envelope's watermark ("just now", "updated 4 minutes ago"), never a clock time derived on the client – see Constraints & Gotchas. A failed poll or refetch leaves the last successfully synced Schedule on screen with its age continuing to count up, replaces no content, and resumes on the next successful attempt. Depends on TI02.
  - **Verify**: `Test: a Session time+location edit, an added Session and a deleted Session each produce a banner naming that Session and the changed fields; a description-only edit is reported too; a Session moved to another day is reported as changed once, not as a removal plus an addition; the diff is a pure function of two envelopes with no network or clock input; dismissing the banner leaves the refreshed Schedule and an unchanged poll does not re-raise it; no push, device-token or notification-record code exists in the path`
  - **Verify**: `Test: the staleness indicator shows an elapsed age and no timezone conversion of the watermark occurs anywhere in the view – the rendered text is identical with the client timezone set to UTC-7 and UTC+9; with the poll endpoint failing, the previously rendered Sessions remain, the age keeps increasing and no empty or error state replaces them; on recovery the age resets`

- [ ] **TI04** A Session write whose base `lastUpdatedAt` has moved is refused with the current version returned
  - Session edit and delete carry the base `lastUpdatedAt` they were loaded with; a mismatch is refused through S01's envelope with a distinct machine code, a displayable "changed since you opened it" message, and the current Session representation in the payload. Nothing is persisted on refusal. Compare the exact serialized value (see Constraints & Gotchas).
  - **Verify**: `Test: two saves from the same base value – the first succeeds, the second is refused with the current version in the payload and the first Admin's change intact; re-saving with the returned base value succeeds; a missing base value is refused rather than treated as a force-write`

- [ ] **TI05** A lifecycle transition during an in-flight edit refuses that edit with the new state named
  - One shared precondition step for both write paths, ordered authorization → lifecycle → base version. Calls S03's exported editability guard and state machine; the refusal message names the Conference's current state (archived or published) and carries its own machine code. Depends on TI04 for the ordering it sits ahead of.
  - **Verify**: `Test: an edit saved after another Admin archived the Conference is refused naming the archived state, not as a version conflict; the same after a publish names the published state; both leave the Session unchanged; the version-conflict, lifecycle-state and span-orphan refusals each carry S01's envelope with a displayable message and a machine code distinct from the other two`

- [ ] **TI06** Conference name and date span are editable after publish under the same concurrency and lifecycle rules
  - Extends S03 TI07's detail edit to published Conferences, reusing S03 TI03's name and 1–4 day span validation unchanged. **Concurrency base is `conference.updated_at`** – the value S03 TI06 already returns as `updatedAt` on the Conference read – never `conference.schedule_watermark_at`. S04 guarantees a Session write leaves `updated_at` untouched, so an unrelated schedule edit cannot cause a spurious conflict here; no additional version column is needed. Depends on TI05.
  - **Verify**: `Test: renaming and re-spanning a published Conference succeeds and advances both conference.updated_at and the schedule watermark; a stale updatedAt base value is refused; a 5-day span is still refused by S03's existing rule; a Session insert, update and delete between load and save each leave the pending Conference edit saveable – no spurious conflict`

- [ ] **TI07** Shortening the date span is refused while Sessions fall outside the new span
  - Refusal names the offending Sessions and their days so the recovery path ("move or delete the affected sessions first") is actionable; the span is unchanged. Widening the span is always permitted. Depends on TI06.
  - **Verify**: `Test: shortening a span past a Session's day is refused naming that Session and its day with the span unchanged; after the Session is moved inside, the same change succeeds; widening the span succeeds with Sessions untouched`

- [ ] **TI08** A Session cannot be moved outside the Conference date span, through S04's existing validation
  - The post-publish edit path routes day changes through S04 TI04's day-containment validator so the refusal names the permitted days; no second implementation of the rule exists.
  - **Verify**: `Test: editing a published Conference's Session onto a day outside the span is refused naming the permitted days; the codebase contains one day-containment rule implementation, not two`

- [ ] **TI09** Change timestamps recorded by a post-publish write are readable by both consumers
  - The write returns the affected row's new version (`session.last_updated_at` or `conference.updated_at`) plus the Conference's advanced watermark, and the watermark is carried on S06's envelope as `lastUpdatedAt` – so the Organizer's re-apply flow, the attendee's staleness age and S10's later cache cursor all read the same values. Depends on TI04, TI06.
  - **Verify**: `Test: the watermark returned by a successful edit equals the value TI01 subsequently serves and the value on the next S06 envelope, and is the instant TI03's elapsed age is measured from; the row version returned is accepted as the base value of an immediate follow-up edit`

- [ ] **TI10** The Organizer's schedule view supports post-publish editing and resolves conflicts inline
  - Add, edit and delete affordances available on a published Conference (S04's last-Session delete guard still applies); TI04's and TI05's refusals render inline as the server's displayable message; on a version conflict the current version is shown beside the Admin's unsaved input so the edit can be re-applied and saved against the newer base value. Depends on TI04–TI08.
  - **Verify**: `Test: a conflicting save shows the newer version and the Admin's typed values together and a re-apply save succeeds; an archived-during-edit save shows the state-named message rather than a generic error; a deletion of a published Conference's only Session is still refused`

- [ ] **TI11** The surfaces changed here are responsive at the three target widths
  - Conflict-resolution view, staleness indicator, change banner and Conference detail edit form, per the binding NFR row and `AGENTS.md` → Visual Validation Workflow. Depends on TI03, TI10.
  - **Verify**: `Screenshots at 375px, 768px and 1280px show the conflict view, staleness indicator, a multi-session change banner and the detail edit form with no horizontal scroll and legible controls at each width`

### Testing Strategy

- The two concurrency edge cases must be driven with two genuinely distinct base values rather than a mocked comparison – a test that stubs the version check cannot catch the truncation trap that reinstates last-write-wins. Tag: `[TI04]`.
- Near-live propagation must be asserted on an **already-rendered** view with no reload, navigation or manual refresh call in the test body; a test that refetches explicitly proves nothing about this story. Tag: `[TI02]`.
- The diff is unit-tested directly against envelope pairs (added / removed / each changed field / moved between days / no change), separately from the banner's rendering – S10 depends on the function, not on this story's view. Tag: `[TI03]`.
- The staleness and diff tests must run under at least two non-UTC process/browser timezones, like S04's and S06's contract suites; a wall-clock leak into either surface is invisible under UTC. Tag: `[TI03]`.

### Execution Contract

- TI05 must complete before TI06 and TI10: both depend on the shared precondition step and its fixed check order.
- TI08 adds no validation of its own – if the day-containment rule is not reachable from the post-publish path, wire the path to S04's validator rather than writing a second copy.
- **Consumes S04's and S03's timestamp guarantees rather than re-deriving them.** `conference.updated_at` is untouched by Session writes (S04 Structural Criteria + TI02 Verify) and is returned as `updatedAt` on the Conference read (S03 TI06). If either turns out not to hold when this story executes, that is a defect in S04 or S03 to fix there – do not add a compensating version column here.
- **TI03 leaves a binding obligation on S10**: S10's reconnect "what changed" summary consumes `diffSchedule` exported here, applied to the cached envelope and the freshly fetched one. S10 must not write a second diff; if the function needs a signature change to serve the offline case, change it here and re-run this story's diff tests rather than forking it.


## Final Validation Checklist

- [ ] No push-notification surface was introduced – no APNs/FCM integration, device-token storage, notification record, or per-session debounce scheduler exists in this story's output. Push fan-out is deferred with REQ-005 and the Pending push delivery service; an implementation that "helpfully" adds it is scope drift, not completeness. TI03's in-app change banner is the delivered channel and is client-local by construction: if satisfying it required anything server-side beyond the existing schedule read, the implementation went the wrong way.
- [ ] No client-side timezone conversion was introduced on the watermark – the staleness surface renders an elapsed age, and grep of the poll/refresh/diff/banner code finds no `toLocaleString`, `Intl.DateTimeFormat` or `Date` constructed from a Session or watermark value.


## Implementation Observations

> _Managed by exec-spec post-implementation – append-only. Spec authors: leave this section empty._

_No observations recorded yet._
