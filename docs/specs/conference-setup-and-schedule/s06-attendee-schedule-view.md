# S06 – Attendee Schedule View

**Plan**: docs/specs/conference-setup-and-schedule/plan.json
**Story-ID**: S06

## Feature Overview and Goal

**Intent**: Everything before this story is authoring – the Attendee holding a phone in a corridor has still never seen the Schedule, and this is the surface the whole conference is actually consumed through, so what it says about *when* things happen has to be true on every device regardless of that device's clock or timezone.

**Expected Outcomes**:

- [OC01] An Attendee opens the app and lands on the right Conference and the right Conference Day without choosing either, seeing that day's Sessions in start-time order with title, start and end time, location and kind – and Sessions that overlap marked as running at the same time rather than stacked as a sequence.
- [OC02] Times read exactly as authored on every device, and the running Session highlight follows server time corrected by the server–device offset recorded at the last sync; a skewed device clock can change the highlight but can never change a displayed time.
- [OC03] Every non-result path is explicit: a Day with no Sessions, a Conference the caller may not read, and a failed fetch each state what happened, and the failed fetch offers retry.
- [OC04] The Schedule is legible on a phone held one-handed at 375px with no horizontal scroll, and rescales to 768px and 1280px.


## Required Context

- `docs/specs/conference-setup-and-schedule/prd.md#fr4-attendee-schedule-view` – the feature contract this FIS implements: the seven acceptance criteria, the inputs/outputs, the validation rule that Sessions are returned only for a **joined** Conference that is **published or archived**, and the three error-handling cases. Read it; this FIS does not restate it.
- `docs/specs/conference-setup-and-schedule/prd.md#non-functional-requirements` – **Binding Constraints (NFR)**: Security – `hd` claim verified server-side on every request (ADR-002); Portability – plain PostgreSQL only, no provider-specific extensions (ADR-003); Usability – responsive verified at 375px / 768px / 1280px per `AGENTS.md`, and legible at 375px width without horizontal scroll. The p95 < 1s render row applies here but is *measured* by S12; nothing in this story may make it unreachable (no N+1 per-Session round trip).
- `docs/specs/conference-setup-and-schedule/prd.md#constraints` – **Binding Constraint (FR4)**: "Session times are **naive wall-clock values** – stored and displayed without timezone conversion. A session at 09:00 reads as 09:00 on every device regardless of its timezone setting." This is the story's hardest rule and the reason OC02 exists.
- `docs/specs/conference-setup-and-schedule/prd.md#fr5-per-conference-role-assignment` – **Binding Constraint (FR5)**: the role set and that "Assignment is keyed on the user's stable `sub` claim, not email." The part that binds here: every membership and conference lookup this story performs resolves on the caller's **`sub`** from the S02 caller context. `sub` is the foreign key, referencing `app_user.sub`; `userId` is confApp's local surrogate for the `app_user` row and is never a downstream join key; email is never a key at all (S02 → *Technical Overview*, "The identity join key is `sub`").
- `docs/specs/conference-setup-and-schedule/prd.md#fr8-offline-schedule-access` – **Binding Constraint (FR8)**: offline scope is read-only, and cached data is cleared on sign-out and user switch. S10 implements it, but it binds the shape produced here: the envelope this story defines is the thing S10 caches, so it must be complete enough to render with no network call and must contain nothing that is only meaningful while online.
- `docs/specs/conference-setup-and-schedule/plan.json#sharedDecisions` – four decisions consumed, one **produced**. Consumed: *API route, handler and error envelope conventions* (S01), *Authenticated caller context* (S02), *Naive wall-clock time representation* (S04 – reuse its helpers, do not write a second time layer), *Conference and Session timestamps - three fields, four consumers* (Session row version and Conference schedule watermark owned by S04, Conference row version owned by S03 – this story carries only the schedule watermark through the envelope for S09/S10, not interpreted here). **Produced by this story**: *Schedule read model and cache envelope*, consumed by S09 (near-live replacement) and S10 (cache) – it is pinned concretely in **Technical Overview** rather than left to the executor.
- `docs/specs/conference-setup-and-schedule/s03-conference-lifecycle.md#implementation-tasks` – **the route split this story must respect, and the primitives it consumes.** TI06 owns `GET /conferences` as the **Organizer** list: the Conferences the caller holds a Role Assignment for, **drafts included**. The attendee list this story delivers is a genuinely different result set – joined Conferences in `published` or `archived` state – and therefore lives at **`GET /me/conferences`**, not on the same route. S03 states the split explicitly; do not merge, overload or "unify" the two endpoints. S03 also owns the **Membership table and its joined timestamp** (TI01, which S05 writes rows into) and the **single provisional per-conference authorization helper** (TI04) that every handler here routes its decision through.
- `docs/specs/conference-setup-and-schedule/s04-schedule-composition.md#structural-criteria` – the wall-clock guarantees this story consumes: `date` + `time without time zone` columns, driver returns them as strings, and no schedule time value ever passes through `new Date(...)`, `Date.parse`, `toLocaleTimeString` or `Intl.DateTimeFormat`. The same prohibition applies to every line of code written here.
- `docs/UBIQUITOUS_LANGUAGE.md#conference-structure` – canonical terms: Conference, Conference Day, Schedule, Session, Presentation, Workshop, **Parallel Track**, and **Personal Agenda** – whose definition states Sessions are open, attendance is neither chosen nor recorded, and there is no per-session personalization. Avoid the listed synonyms in code and UI copy.
- `AGENTS.md#do-not--never` – standing prohibitions this story is exposed to: never ship a fixed-width or desktop-only layout, never rely on in-process state between requests, never key a user on email.
- `docs/guidelines/CRITICAL-RULES-AND-GUARDRAILS.md#honesty-and-verification` – "Validate UI visually" is why the three-width check is an acceptance criterion here rather than a follow-up.


## Deeper Context

- `docs/specs/conference-setup-and-schedule/s01-tracer-bullet-skeleton.md#constraints--gotchas` – the exact JSON error envelope (`{"error":{"code","message","details?"}}`), the existing code list, the `/api` double-prefix trap, and the single configurable API base URL the SPA must keep using.
- `docs/specs/conference-setup-and-schedule/s02-google-workspace-sign-in.md#technical-overview` – the `withAuth(handler)` wrapper and the `AuthenticatedCaller` shape (`userId`, `sub`, `hd`, `email`, `displayName`) every handler here consumes.
- `docs/specs/conference-setup-and-schedule/s05-join-code-access.md#implementation-tasks` – TI04 defines the Attendee Membership keyed on `sub`; this story reads those rows and extends them with a creation timestamp.
- `docs/adrs/ADR-004-containerized-api-and-spa.md` – **accepted 2026-08-16, supersedes serverless-on-Azure.** The API is a long-running HTTP server in a container written against a plain HTTP framework; nothing here is written against the Azure Functions programming model, and the PRD's "excluding serverless cold start" NFR wording is stale. Statelessness still binds, for a different reason: handlers run across horizontal replicas, so no envelope, clock anchor or overlap result may live in process memory between requests.
- `docs/specs/conference-setup-and-schedule/plan.json#riskSummary` – the S06 entry names the two things this FIS is shaped around: three-width screenshots, and testing the running-Session highlight against a device clock deliberately skewed from server time.


## Acceptance Scenarios

- [x] **S01 [OC01] [TI03,TI06,TI08] An Attendee opens a running Conference and lands on today's Sessions in start-time order**
  - **Given** Ravi is an Attendee of the published Conference "Kickoff 2026" running 2026-09-14 to 2026-09-16, it is the only Conference he has joined, and today is 2026-09-15
  - **And** 2026-09-15 holds "Retrospective" 15:00–16:00 (Workshop, "Room B") and "Opening Keynote" 09:00–10:30 (Presentation, "Main Hall"), created in that order
  - **When** Ravi opens the schedule
  - **Then** the Conference Day 2026-09-15 is selected without him choosing it, and the list reads "Opening Keynote" first then "Retrospective", each showing its title, `09:00–10:30` / `15:00–16:00`, its location and its kind

- [x] **S02 [OC01] [TI01,TI02,TI10] The Conference shown by default is the running one, otherwise the most recently joined**
  - **Given** Ravi has joined three published Conferences: "Retro 2025" (ended 2025-11-20, joined 2025-11-01), "Kickoff 2026" (2026-09-14 to 2026-09-16, joined 2026-08-01) and "Product Days" (2026-11-02 to 2026-11-03, joined 2026-09-10)
  - **When** Ravi opens the schedule on 2026-09-15
  - **Then** "Kickoff 2026" is shown – the Conference currently running – and a picker lists all three
  - **And** on 2026-09-20, with none of the three running, "Product Days" is shown because it is the most recently joined

- [x] **S03 [OC01,OC03] [TI06,TI09] Days are navigable, default to day 1 outside the Conference, and a Day with no Sessions says so**
  - **Given** "Kickoff 2026" runs 2026-09-14 to 2026-09-16 and 2026-09-16 holds no Sessions at all
  - **When** Ravi opens the schedule on 2026-09-01 (before it starts) and again on 2026-10-01 (after it ends)
  - **Then** day 1 – 2026-09-14 – is selected on both occasions, and all three Conference Days are reachable from the day navigation
  - **And** navigating to 2026-09-16 shows an explicit "no sessions on this day" state, not a blank area

- [x] **S04 [OC01] [TI03,TI07] Overlapping Sessions are marked as running at the same time and offer nothing to choose**
  - **Given** on 2026-09-15 "Design Workshop" runs 10:00–11:00 and "Architecture Deep Dive" runs 10:00–11:00, while "Opening Keynote" runs 09:00–10:30 and "Retrospective" 15:00–16:00
  - **When** Ravi views 2026-09-15
  - **Then** "Design Workshop" and "Architecture Deep Dive" are presented as concurrent with each other, "Opening Keynote" is presented as concurrent with both (09:00–10:30 overlaps 10:00–11:00), and "Retrospective" is presented as concurrent with nothing
  - **And** no Session in the list offers a control to pick, attend, star, add to an agenda or otherwise record a choice, and nothing is written to the server by viewing the Schedule

- [x] **S05 [OC02] [TI05,TI08] A device clock three hours fast highlights the right Session and never alters a displayed time**
  - **Given** "Opening Keynote" was authored 09:00–10:30 on 2026-09-15, the server's wall clock reads 2026-09-15 09:40, and Ravi's device clock is set three hours fast
  - **When** Ravi loads the schedule and reads it
  - **Then** "Opening Keynote" is highlighted as currently running – the highlight follows the server wall clock carried in the response, corrected by the server–device offset measured at that sync – and it still reads `09:00–10:30`
  - **And** when Ravi's device clock then jumps a further three hours forward *after* the sync, the highlight may move to the wrong Session, but every time on screen is still exactly the authored value: `09:00–10:30` is not re-rendered as `12:00–13:30`, and no timezone conversion is applied to any Session time on any device

- [x] **S06 [OC03] [TI04] Reading a Conference the caller is not entitled to is refused with the reason named**
  - **Given** "Draft Days" is in `draft` state and Ravi holds an Admin Role Assignment for it; "Private Offsite" is published and Ravi has no Membership for it; "Retro 2025" is archived and Ravi is a member
  - **When** Ravi requests each schedule in turn through the attendee schedule endpoint
  - **Then** "Draft Days" is refused with a distinct machine code and a displayable message naming that the Conference is not published – its Sessions are not returned even to its own Admin – "Private Offsite" is refused as not joined, and "Retro 2025" returns its full Schedule and is marked as archived
  - **And** both refusals arrive in the shared error envelope, and neither response discloses Session content

- [x] **S07 [OC03] [TI09] A failed fetch shows an error state offering retry, and the retry succeeds**
  - **Given** Ravi is a member of "Kickoff 2026" and has never loaded its Schedule on this device
  - **When** the schedule request fails because the venue network drops the connection
  - **Then** the view shows an explicit error state carrying a displayable message with a retry control – not a blank screen, a spinner that never ends, or a fabricated empty Schedule
  - **And** activating retry after connectivity returns renders the Schedule; no cached copy is consulted, because caching arrives with S10

- [x] **S08 [OC04] [TI11] The Schedule is legible one-handed at 375px and rescales to tablet and desktop**
  - **Given** a Conference Day holding a concurrent pair, a currently-running highlighted Session and a long Session title
  - **When** the attendee schedule view is rendered at viewport widths 375px, 768px and 1280px
  - **Then** every Session's title, time range, location, kind, concurrency marking and the running highlight are readable at each width with no horizontal body scroll and no clipped or truncated-beyond-recognition content, and the day navigation is reachable one-handed at 375px


## Structural Criteria

- [x] The schedule endpoint returns **one self-contained envelope** – shape as pinned in *Technical Overview* – from which the whole view renders with no further network call, so S10 can cache it verbatim and S09 can replace it wholesale.
- [x] The attendee schedule component tree renders as a pure function of `(envelope, effectiveWallClockNow)`; no component in it issues a fetch, reads `Date.now()` directly, or requires a live connection to render.
- [x] The clock module's entire state is the serializable anchor `{ serverNowInstant, serverNowDay, serverNowTime, deviceClockAtReceipt }` – all four plain values – and the module exposes a **rehydration entry point** that accepts exactly that anchor and yields a working `effectiveWallClockNow()` in a process that has performed no fetch. The offset is *derived* from the anchor on demand, never the only place the sync is recorded, so a force-quit followed by an offline relaunch loses nothing S10 has persisted.
- [x] `serverNow` in the envelope carries **both** a UTC instant (for offset measurement) **and** the server's naive wall-clock day and time in the same clock Sessions are authored in – the client never converts an instant into a wall clock.
- [x] No Session `day`, `startTime` or `endTime` value in this story's server or client code passes through `new Date(...)`, `Date.parse`, `toLocaleTimeString`, `Intl.DateTimeFormat`, or any timezone-conversion library; all formatting and comparison uses the S04 wall-clock helpers.
- [x] `concurrentWith` is produced by **S04's single overlap implementation** (S04 TI07), imported and called – not a second function restating `start < otherEnd AND end > otherStart`. One rule, one implementation, exactly as the S04 wall-clock helpers are treated; the codebase contains no second overlap predicate.
- [x] `GET /me/conferences` (attendee, joined + published-or-archived) and S03's `GET /conferences` (Organizer, Role Assignment + drafts included) both exist as separate endpoints with separate result sets; no handler serves both, and neither is reachable by a query parameter switching the other's semantics.
- [x] The schedule and conference-list endpoints obtain their caller through S02's `withAuth` wrapper and their per-Conference decision through S03's single provisional authorization helper – no inline role or membership comparison in a handler body; every membership and conference lookup joins on `sub` against `app_user.sub`, never on `userId` or email.
- [x] Every refusal is emitted through S01's JSON error envelope with a displayable message and a distinct machine code; no endpoint-local error shape.
- [x] The Conference `lastUpdatedAt` produced by S04 is carried through the envelope unmodified and at full precision, and is not interpreted or acted on by this story.
- [x] The Membership timestamp migration is reversible and uses plain PostgreSQL only (ADR-003); handlers retain no request-derived state between requests, because the API runs as a long-running container scaled across replicas (ADR-004).
- [x] A Conference Day's Sessions are fetched in one query per schedule request – no per-Session or per-Day round trip.


## Scope & Boundaries

### Work Areas

- Membership schema: the creation timestamp the "most recently joined" default reads.
- Attendee conference-list endpoint `GET /me/conferences`: joined Conferences that are published or archived, plus the server-chosen default – distinct from S03's Organizer list at `GET /conferences`.
- Attendee schedule endpoint: the produced read-model envelope, its authorization and its refusal paths.
- Client clock module: server–device offset captured at sync, effective wall clock derived from it.
- Attendee schedule view: Conference picker, day navigation, Session list, concurrency marking, running highlight, empty/refusal/error-with-retry states, responsive layout.
- Contract test suite pinning the envelope shape and the clock rules that S09 and S10 build on.

### What We're NOT Doing

- **Offline caching, staleness messaging and the reconnect "what changed" summary** -- S10 owns them; this story only guarantees the envelope is cacheable and the view renders from it without a connection-dependent input.
- **Near-live refresh, polling and optimistic concurrency** -- S09 owns propagation of published edits; here the Schedule is fetched when the view opens and on explicit retry, and `lastUpdatedAt` is carried but not acted on.
- **Personal Agenda, attendance recording, session selection or check-in** -- a product anti-goal: Sessions are open and attendance is neither chosen nor recorded (`docs/UBIQUITOUS_LANGUAGE.md#conference-structure`, FR4, FR6).
- **Join-code entry, its refusals and its rate limiter** -- S05; no join-code path exists in this story, so FR3's binding constraints have no surface here.
- **Organizer composition, overlap warnings and editing** -- S04 and S09; the attendee endpoint deliberately refuses `draft` Conferences even to their own Admin, who uses the Organizer view instead.


## Architecture Decision

**Approach**: One request returns a self-contained schedule envelope – Sessions grouped by every Conference Day of the span, start-time ordered, with server-computed concurrency marks and a dual `serverNow` anchor (UTC instant plus the server's naive wall clock); the client derives "now" as `serverWallClock + elapsed-since-sync`, so no displayed value is ever produced by a timezone conversion and S10 can cache the payload byte-for-byte.
**Why this over alternatives**: reading the device clock directly (or converting the server instant to a wall clock on the device) makes a wrong clock or a foreign timezone change what the Schedule *says*, which is precisely the PRD's hardest constraint; and a lazily-fetched or per-day payload would force S10 to invent a second shape and a parallel component tree for the offline path.


## Technical Overview

**Produced shared decision – the schedule read model and cache envelope.** `GET /conferences/{conferenceId}/schedule` returns exactly this; S10 caches it and S09 replaces it:

```json
{ "conference": {"id","name","startDate":"2026-09-14","endDate":"2026-09-16","state":"published","lastUpdatedAt":"<ISO-8601 UTC, µs>"},
  "days": [ {"date":"2026-09-14","dayNumber":1,"sessions":[
      {"id","title","description","kind":"Presentation","startTime":"09:00","endTime":"10:30","location","concurrentWith":["<sessionId>"]} ]} ],
  "serverNow": {"instant":"2026-09-14T07:40:12.345678Z","day":"2026-09-14","time":"09:40"} }
```

Rules: every Conference Day of the span appears, including empty ones (`sessions: []`); Sessions are start-time ascending within a day; `day`/`startTime`/`endTime` are S04's naive wall-clock strings with no `Z` and no offset; `concurrentWith` is computed per read by **calling S04's overlap implementation** (S04 TI07 – `start < otherEnd AND end > otherStart`, touching boundaries excluded) rather than restating the rule, and is symmetric; `lastUpdatedAt` and `serverNow.instant` are the only instants in the payload.

`conference.lastUpdatedAt` is the wire name and does not change; S04 serializes it from the column `conference.schedule_watermark_at` (never from `conference.updated_at`, which is the Conference row version and belongs to S03/S09). The rename is a column-naming change only – this envelope is stable.

**Staleness is displayed as elapsed age, never as a wall clock.** `lastUpdatedAt` is a UTC *instant*, and the only timezone-free way to show it is the difference between two instants: S09 and S10 render it as an age – "updated 4 minutes ago" – computed as `deviceNow + offset − lastUpdatedAt` from the clock module's anchor. Rendering it as an absolute time ("last updated 2026-09-14 09:12") would require a client-side timezone conversion, which is banned; on a device set away from the venue such a stamp would also disagree with every Session time on the same screen, which is precisely the confusion the naive-wall-clock constraint exists to prevent. If a product decision later requires an absolute stamp, the only permitted route is a **server-rendered naive wall-clock field carried in this envelope in the same frame as `serverNow.time`** – added here as an additive field, never derived on the client. No such field exists today because elapsed age needs none.

**Effective-now arithmetic.** At sync the client records the **anchor** – `serverNow.{instant, day, time}` exactly as received, plus `deviceClockAtReceipt`, **defined as the device clock reading at the moment the response is received** – and derives `offset = serverNow.instant − deviceClockAtReceipt` from it. Thereafter `effectiveWallClock = serverNow.{day,time} + (deviceNow + offset − serverNow.instant)` – i.e. the server's wall clock advanced by elapsed real time. A device clock wrong at load is absorbed by `offset`; a device clock that jumps *after* the sync skews `elapsed` and may mis-highlight, which is accepted. `serverNow.time` is the deployment's configured wall clock, which is the same clock the Organizer authored in (see *Constraints & Gotchas* – recorded assumption).

**The anchor is state S10 persists, so it is data, not a live object.** All four values are plain serializable scalars and the module is constructed from them; the derived `offset` is recomputed from the anchor, never the sole record of the sync. This pins the contract S10 must meet: S10's cache entry stores the envelope **and the anchor** – the cached `serverNow` fields alongside `deviceClockAtReceipt`, which is S10's "fetched-at" instant and is the *device* clock reading at receipt, not a server value and not an unspecified clock. On an offline read S10 rehydrates the clock module from `(cached serverNow, cached deviceClockAtReceipt)` and the view renders with a corrected clock and no network. Without that pair persisted, an app force-quit and relaunched offline has no input for `effectiveWallClockNow()` and FR4's "offline the device clock is used, corrected by the server–device offset recorded at the last successful sync" cannot hold – which is why the rehydration entry point here is explicit rather than an in-memory detail.

**Rendering contract.** The view is `render(envelope, effectiveWallClockNow)`. Highlight = the Session whose `day` equals the effective day and whose `startTime <= now < endTime` by string comparison; more than one may match on a Parallel Track and all matching Sessions are highlighted. A local timer re-evaluates the highlight at minute granularity without re-fetching.


## Code Patterns & External References

```
# type | path#anchor or url                                                             | why needed (intent)
prd    | docs/specs/conference-setup-and-schedule/prd.md#fr4-attendee-schedule-view      | The acceptance criteria, validation and error-handling this FIS implements
fis    | docs/specs/conference-setup-and-schedule/s04-schedule-composition.md#implementation-tasks | TI06 grouping/ordering, TI07 overlap function, TI08 wall-clock helpers – all reused, not reimplemented
fis    | docs/specs/conference-setup-and-schedule/s03-conference-lifecycle.md#implementation-tasks | TI06's route split (GET /conferences is the Organizer list), TI04's authz helper, TI01's Membership table
adr    | docs/adrs/ADR-004-containerized-api-and-spa.md                                   | Container API runtime – plain HTTP server, statelessness across replicas, no Functions model
fis    | docs/specs/conference-setup-and-schedule/s02-google-workspace-sign-in.md#technical-overview | withAuth wrapper + AuthenticatedCaller shape every handler here consumes
fis    | docs/specs/conference-setup-and-schedule/s01-tracer-bullet-skeleton.md#constraints--gotchas | Error envelope shape, machine-code convention, route registration and API base URL
doc    | docs/UBIQUITOUS_LANGUAGE.md#conference-structure                                 | Parallel Track and Personal Agenda definitions – naming and the no-attendance rule
```


## Constraints & Gotchas

- **Critical**: a UTC instant alone cannot produce a wall clock without a timezone, and timezone conversion is banned by the FR4 constraint -- Must handle by: sending `serverNow.day` + `serverNow.time` as naive wall-clock strings alongside the instant, and doing all "is it running now" arithmetic on those strings plus an elapsed-milliseconds delta.
- **Critical**: no schedule time value may pass through `new Date(...)`, `Date.parse`, `toLocaleTimeString` or `Intl.DateTimeFormat` on server or client -- Instead: reuse S04's wall-clock helpers for parsing, formatting and comparison; `HH:mm` and `YYYY-MM-DD` compare correctly as strings. `Date` is permitted **only** for the instant arithmetic behind the offset, never for a value that reaches the screen.
- **Avoid**: driving the highlight from the raw device clock, or re-fetching the Schedule to keep the highlight fresh -- Instead: compute from the recorded offset and re-evaluate on a local timer; refresh-on-change is S09's job and adding it here duplicates it.
- **Avoid**: fetching inside the schedule component tree, or splitting the payload per day -- Instead: fetch once at the view boundary and pass the whole envelope down; S10 must be able to hand the same tree a cached envelope with no network available.
- **Constraint**: the attendee schedule endpoint refuses `draft` Conferences even to their own Admin -- the PRD's validation rule is joined **and** published-or-archived; the Organizer reads drafts through S04's composition view.
- **Constraint**: concurrency is a presentational fact, never an interaction -- a control that lets an Attendee pick between concurrent Sessions contradicts the Personal Agenda definition and FR6, and is a defect even if it looks helpful.
- **Assumption** (recorded, PRD does not specify): the deployment runs in one configured wall clock (the company's own), and that is the clock Sessions are authored in and `serverNow.time` is rendered in. A multi-timezone deployment would need a Conference-level timezone field, which the PRD does not define.
- **Critical**: `GET /conferences` is **not** this story's route -- S03 TI06 already delivers it as the **Organizer** list (Conferences the caller holds a Role Assignment for, drafts included). The attendee list is a different result set – joined Conferences that are published or archived – so it is **`GET /me/conferences`**, and S03 records the split from its side. Must handle by: taking the `/me/` route as given, not overloading S03's route with a query parameter or role-sniffing branch, and not "consolidating" the two later; both endpoints exist on purpose and a reader seeing both should see two intended endpoints.
- **Assumption** (recorded, PRD does not specify): route shapes are `GET /me/conferences` (the caller's readable Conferences plus the default) and `GET /conferences/{conferenceId}/schedule` (the attendee read; S04 TI06's Organizer read is the distinct `/schedule/organizer`); machine codes introduced are `CONFERENCE_NOT_READABLE` (not published) and `NOT_A_MEMBER`. Register routes without an `api/` prefix (S01 gotcha).


## Implementation Plan

### Implementation Tasks

- [x] **TI01** Membership records when it was created, so "most recently joined" is answerable
  - S03 TI01 owns the Membership table and already specifies a joined timestamp, and S05 writes join rows into it – reuse that column if it exists. Only if it does not, add a non-null `joined_at timestamptz` defaulting to `clock_timestamp()` via a reversible plain-PostgreSQL migration. No other Membership semantics change here.
  - **Verify**: `Test: migration applies and reverts cleanly; two Memberships created in sequence for one user order deterministically by joined_at`

- [x] **TI02** `GET /me/conferences` returns the caller's readable Conferences with the default already chosen
  - **Route, deliberate and non-negotiable**: this is `GET /me/conferences`, the **Attendee** list – joined Conferences in `published` or `archived` state only. `GET /conferences` is S03 TI06's **Organizer** list (Role Assignment, drafts included) and is a different result set; the two coexist and neither is overloaded to serve the other.
  - Membership is resolved on the S02 caller's **`sub`**, joined against `app_user.sub` – `userId` is a local surrogate and is never the join key, and email is never a key. Default = the Conference whose date span contains the server's current day; if none or several, the most recently joined (TI01) among the candidates. Response names the default explicitly rather than relying on list order.
  - **Verify**: `Test: with one running and two non-running joined Conferences the running one is the default; with none running the most recently joined is; a draft Conference the caller admins is absent from GET /me/conferences while GET /conferences still lists it; the membership query joins on sub and no query in this story filters or joins on userId or email`

- [x] **TI03** `GET /conferences/{conferenceId}/schedule` returns the schedule envelope pinned in *Technical Overview*
  - Every Conference Day of the span present including empty ones; Sessions start-time ascending; S04 wall-clock strings passed through untouched; `concurrentWith` computed per read by **calling S04 TI07's overlap implementation** – import it, do not restate the predicate, exactly as S04's wall-clock helpers are reused rather than re-derived; `serverNow` carrying instant + naive day/time; Conference `lastUpdatedAt` carried at full precision, serialized from `conference.schedule_watermark_at` under the unchanged wire name. This envelope is the artefact S09 and S10 consume; document it beside the serializer, **including that `lastUpdatedAt` is an instant to be shown as elapsed age only** – no absolute wall-clock rendering may be derived from it on the client, and any future absolute stamp must be added to this envelope as a server-rendered naive wall clock in `serverNow`'s frame. One query for the Sessions – no per-day or per-Session round trip.
  - **Verify**: `Test: Sessions inserted out of order return ascending within each day; a day with no Sessions is present with an empty list; 09:00–10:30 and 10:00–11:00 appear in each other's concurrentWith while 09:00–10:00 and 10:00–11:00 do not; the payload contains no Z-suffixed or offset-bearing Session time`
  - **Verify**: `Test: the schedule serializer calls S04's exported overlap function – a grep of this story's server code finds no second implementation of start < otherEnd AND end > otherStart, and changing S04's boundary rule in one place changes this endpoint's output`

- [x] **TI04** The schedule read is refused for a non-member and for a Conference that is not published or archived
  - Caller from S02's `withAuth`; per-Conference decision through S03's provisional authorization helper – no inline membership comparison. Distinct machine codes and displayable messages through S01's envelope; refusals disclose no Session content. Archived Conferences read successfully and the envelope marks the state. Depends on TI03.
  - **Verify**: `Test: a non-member is refused with its own machine code; a draft Conference is refused even for its own Admin; an archived Conference returns its full Schedule with state "archived"; neither refusal body contains a Session title`

- [x] **TI05** A shared clock module derives the effective wall clock from the sync anchor, never from the raw device clock
  - At each successful fetch it records the **anchor** – `serverNow.{instant, day, time}` as received plus `deviceClockAtReceipt`, **the device clock reading at the moment of receipt** – and derives `offset = serverNow.instant − deviceClockAtReceipt` from it, exposing `effectiveWallClockNow()` as `serverNow.{day,time}` advanced by elapsed real time (arithmetic per *Technical Overview*).
  - **Two entry points, both explicit**: one that takes a freshly received envelope plus the device clock reading at receipt, and one that **rehydrates** the module from a previously stored anchor object of exactly those four scalar values. The rehydration path performs no fetch and assumes no connection. The anchor is plain serializable data – no live object, no closure over a network client – because it is the thing S10 persists.
  - **Contract this leaves on S10** (S10's cache entry must satisfy it): S10 stores the anchor alongside the cached envelope, its "fetched-at" value **is** `deviceClockAtReceipt` – the device clock at receipt, not a server value and not an unspecified clock – and on an offline read it calls the rehydration entry point with `(cached serverNow, cached deviceClockAtReceipt)` before rendering. This is what makes FR4's offline clause – "offline the device clock is used, corrected by the server–device offset recorded at the last successful sync" – hold across a force-quit and offline relaunch; without it the offset dies with the process.
  - **Verify**: `Test: with a device clock offset by +3h at sync, effectiveWallClockNow() returns the server wall clock advanced only by elapsed time; the module never returns a value derived from a timezone conversion`
  - **Verify**: `Test: an anchor survives a JSON round trip and rehydrates a module in a fresh process with no fetch performed; the rehydrated effectiveWallClockNow() equals the original module's value for the same device clock reading, including when that device clock is +3h skewed`

- [x] **TI06** The attendee schedule view renders from `(envelope, effectiveWallClockNow)` with Conference Day navigation and the correct default day
  - Pure render from those two inputs – no fetch, no direct clock read inside the tree, so S10 can pass a cached envelope. Default day = the day containing the effective current day when it falls inside the span, otherwise day 1. All days of the span are navigable. Time strings come from S04's helpers. Consumes TI03's envelope and TI05's clock.
  - **Verify**: `Test: during the Conference the current day is preselected; before the start and after the end day 1 is; every day of the span is reachable; the tree renders when given an envelope and a fixed clock value with the network unavailable`

- [x] **TI07** Concurrent Sessions read as running at the same time and expose no way to choose between them
  - Driven by TI03's `concurrentWith`; concurrent Sessions are visually grouped or marked as simultaneous rather than listed as a sequence. No select/attend/star/add control on any Session, and viewing the Schedule issues no write.
  - **Verify**: `Test: two 10:00–11:00 Sessions render with a concurrency marking naming each other; a non-overlapping Session carries none; the rendered list contains no attendance or selection control and viewing produces no write request`

- [x] **TI08** The currently running Session is highlighted from the corrected clock, and displayed times are never touched by it
  - Highlight = Sessions on the effective current day where `startTime <= now < endTime` by string comparison; a Parallel Track highlights all matching Sessions. Re-evaluated on a local timer at minute granularity without re-fetching. The clock value is an input to the highlight only – it must not reach a formatter that renders a Session time. Consumes TI05.
  - **Verify**: `Test: with the server wall clock at 09:40 the 09:00–10:30 Session is highlighted; with a device clock skewed +3h at sync the same Session is highlighted; with the device clock jumped after sync the displayed time strings are byte-identical to the authored values`

- [x] **TI09** Empty Day, refusal, and fetch-failure states are explicit, and the failure state offers retry
  - A Day with no Sessions renders a named empty state, not a blank area. A refusal from TI04 renders the envelope's displayable message. A failed fetch renders an error state with a working retry control; no cached fallback is consulted or implied – that is S10.
  - **Verify**: `Test: an empty day shows the empty state; a refused request shows the server's message; a failed fetch shows an error state whose retry re-issues the request and renders the Schedule on success`

- [x] **TI10** An Attendee who joined more than one Conference can switch between them from the schedule view
  - Picker lists the TI02 Conferences with archived ones distinguishable, opens on the server-chosen default, and switching loads that Conference's envelope through TI03. A caller with exactly one readable Conference is taken straight to it.
  - **Verify**: `Test: with three joined Conferences the picker lists all three and opens on the default; selecting another renders that Conference's Schedule; with one joined Conference no selection step is imposed`

- [x] **TI11** The attendee schedule view is legible one-handed at 375px and rescales to 768px and 1280px
  - Fluid layout per `AGENTS.md`; day navigation, Session rows, concurrency marking and the running highlight all remain readable and reachable. Use the three-width screenshot command S01 documented rather than a manual resize.
  - **Verify**: `Screenshots at 375px, 768px and 1280px show titles, time ranges, locations, kinds, the concurrency marking and the highlight fully legible with no horizontal body scroll`

- [x] **TI12** A contract test suite pins the envelope and the clock rules that S09 and S10 build on
  - Asserts the envelope's required fields and their formats, that it renders a complete view with no further request, that `serverNow` carries both an instant and a naive wall clock, that the clock anchor is serializable and rehydratable into a working clock with no fetch (TI05), and that the corrected-clock arithmetic never alters a displayed time. These are the guard rails for the produced shared decision.
  - **Verify**: `Test: the suite fails if serverNow's wall-clock fields are dropped, if the clock anchor loses deviceClockAtReceipt or stops round-tripping through JSON, if a Session time is routed through a Date on the way to the screen, or if rendering the view requires a network call`

### Testing Strategy

- Device-clock skew (S05, TI05, TI08) is exercised by injecting the clock source into the module rather than by mocking a formatter – a formatter mock cannot catch a highlight computed from the raw device clock.
- Time-rendering assertions compare exact strings (`"09:00"`), not parsed values; a parsed comparison passes even when a timezone conversion has occurred.
- The three-width check reuses the scripted screenshot command from `docs/KEY_DEVELOPMENT_COMMANDS.md` (S01 TI14), so it stays repeatable rather than a one-off manual resize.

### Execution Contract

- Requires S03 (Conference and Membership tables, the provisional authorization helper, and `GET /conferences` as the Organizer list), S04 (Sessions, wall-clock helpers, the overlap function, `lastUpdatedAt`) and S05 (join rows in the Membership table) to have landed.
- TI01 precedes TI02; TI03 precedes TI04, TI06 and TI07; TI05 precedes TI06 and TI08; TI02 precedes TI10.
- **Leaves a binding obligation on S10**: persist TI05's clock anchor – the cached `serverNow` fields **and** `deviceClockAtReceipt`, S10's "fetched-at" defined as the device clock reading at receipt – alongside the cached envelope, and rehydrate the clock module from that pair before rendering an offline read. FR4's offline clock clause is unsatisfiable without it, and no other story in the bundle covers it.
- **Leaves a display rule on S09 and S10**: `lastUpdatedAt` is shown as elapsed age computed from the instant, never as an absolute wall clock derived on the client.


## Implementation Observations

> _Managed by exec-spec post-implementation – append-only._

### Run: 2026-08-17 21:09 UTC – observations

#### NOTICED BUT NOT TOUCHING

- **TI01 needed no migration.** S03 already ships `membership.joined_at timestamptz NOT NULL DEFAULT now()` (`db/migrations/20260817120000000_conference.sql`), and TI01 says to reuse the column if it exists. The Structural Criterion "the Membership timestamp migration is reversible and uses plain PostgreSQL only" is therefore satisfied by S03s migration, verified here by reverting through it and re-applying (`api/test/attendee-schedule.integration.test.ts`). A deterministic `c.id` tie-break was added to the ordering because `now()` is transaction-start time, so two Memberships written in one transaction would otherwise tie.
- **`plan.json` records S03 as `spec-ready` although S03 has landed.** `api/src/conferences/lifecycle.ts`, `authorization.ts` and the conference/membership/role_assignment tables all exist and are under test; S06 consumes them. The status is stale, not the code. Not corrected here - it is another storys status field.
- **Pre-existing Prettier drift in four untouched files**: `api/test/join-code-structure.test.ts`, `api/test/join-code.test.ts`, `visual/conferences.spec.ts`, `web/src/components/JoinCodePanel.tsx` (all S05). Left alone; `npm run format:check` still reports them.
- **`visual/shell.spec.ts` (3 tests) cannot pass without the composed stack.** It asserts a live database value through the health panel, so it needs `docker compose up -d`. Confirmed pre-existing: it fails identically with S06s `App.tsx` change stashed. Unrelated to this story.
- **Playwright has only Chromium installed**, so the three-width responsive claim is Chromium-verified. ADR-001 puts the same assets in a WKWebView on iOS, so a WebKit pass on this screen is worth adding before the mobile shells land in S11.

#### Visual review findings deliberately not fixed (shared S04 styles)

Each of these lives in a style S04 already shipped and both views share, so changing it is a cross-story design decision that would also re-open S04s validated screenshots - not an S06 defect. Acceptance Scenario S08 holds in all three cases.

- **Ragged Session-title alignment at 768px and 1280px.** `.session-card__when` sizes to its content, so the title column starts at a different x on every row (~78px of rag). Fixing it properly means widening the shared time column to a common `min-width`, which changes the Organizer view too.
- **Day navigation wraps 2+1 at 375px** and the orphaned third button stretches full width (`.schedule__day { flex: 1 1 auto }`). The nav is still reachable one-handed, which is what S08 requires.
- **`--overlap` amber means two things on one card**: `.badge--workshop` marks *kind = Workshop* and `.session-card--concurrent` marks *runs in parallel*. Both facts are also stated in words, so legibility holds, but the colour channel is ambiguous.

#### Review findings addressed during this run

- **HIGH - `/me/conferences` failure was an unrecoverable dead end.** On a list-fetch failure `conferenceId` stayed `null`, so the schedule phase never left `loading`, the retry control (rendered only under `phase.kind === "failed"`) never appeared, and `loadConferences` had `[]` deps so it could not be re-driven at all. That is exactly Acceptance Scenario S07s Given - a dropped venue network fails both requests and `/me/conferences` goes first - and there is no address bar to reload from on the Capacitor shells. Fixed by making `attempt` a dependency of both effects and giving the list-failure branch its own retry; pinned by a regression test that fails when the wiring is reverted.
- **MEDIUM - the "one query" test did not constrain the handler.** It called `listForConference` directly, which issues one statement by construction, so a handler looping per Conference Day would have stayed green. Rewritten to count `from sessions` reads across a whole request against a recording `Database` seam.
- **MEDIUM - S06s server logic had no coverage outside `describe.skipIf(!reachable)`.** Added `api/test/attendee-conferences.test.ts` and `api/test/schedule-envelope.test.ts` so the default-conference rule and the envelope composition keep their proof on a machine with no PostgreSQL.
- **MEDIUM - no web test drove `/me/conferences` to failure** (every stub was `status: 200`), which is why the HIGH above shipped green. Added.
- **Guardrail breach - em dash in shipped UI copy** (`ScheduleView.tsx`), against `docs/guidelines/CRITICAL-RULES-AND-GUARDRAILS.md` "En dashes, not em dashes". Replaced.
- **P2 visual - the time/badge column could not shrink.** `.session-card__when` had `flex-shrink: 0` with a rem-based `min-width`, so from about a 22px root font the "Now" badge left the card and pushed the body sideways at 375px - and the OS font-scale preference drives exactly that inside a Capacitor WebView (ADR-001). Fixed to `flex: 0 1 auto` / `min-width: min(7.5rem, 100%)`, with two raised-font-scale regression captures that fail against the old rule.
- **LOW (accepted, not fixed)** - `web/test/schedule-envelope-contract.test.tsx` asserts its format regexes against an envelope literal declared in the same file, so those particular assertions are self-referential. The binding constraint is `api/test/attendee-schedule.integration.test.ts`, which asserts `serverNow` and the instant count off a real response body; the contract file is kept for the render-with-no-network and source-scan assertions, which are not self-referential.

#### Contract left on later stories

- **S10** must persist TI05s clock anchor - the cached `serverNow` fields **and** `deviceClockAtReceipt`, its "fetched-at" being the *device* clock reading at receipt - alongside the cached envelope, and call `rehydrateClock(anchor)` before rendering an offline read. `web/test/effective-clock.test.ts` pins the round trip and shows a partial anchor producing a visibly wrong clock.
- **S09 and S10** must render `conference.lastUpdatedAt` as an elapsed age computed from the instant, never as an absolute wall clock derived on the client. Documented beside the serializer in `api/src/sessions/schedule-envelope.ts`.
