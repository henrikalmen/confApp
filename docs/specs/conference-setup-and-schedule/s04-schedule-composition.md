# S04 – Schedule Composition

**Plan**: docs/specs/conference-setup-and-schedule/plan.json
**Story-ID**: S04

## Feature Overview and Goal

**Intent**: A Conference is an empty shell until someone fills its Days with Sessions – this story gives the Organizer the composition surface the whole product reads from, fixes the two data contracts (naive wall-clock times, the timestamp fields) that three later stories build on, and closes S03's publish gate so a Conference can actually reach **published** for the first time.

**Expected Outcomes**:

- [OC01] An Organizer adds, edits and removes Sessions in a Conference and sees the Schedule ordered by start time within each Conference Day.
- [OC02] Invalid Session input is refused with a user-facing reason naming what is permitted, and the last remaining Session of a published Conference cannot be deleted.
- [OC03] A Session authored at 09:00 reads as 09:00 on every device regardless of its timezone setting – no timezone conversion exists at any layer.
- [OC04] Overlapping Sessions save successfully and are marked by a persistent overlap indicator that survives a reload, because Parallel Tracks are supported.
- [OC05] S03's publish gate reads the real Session count: a draft Conference with no Sessions is still refused publication, and one with at least one Session publishes end to end – no stub anywhere in the path.


## Required Context

- `docs/specs/conference-setup-and-schedule/prd.md#fr2-schedule-composition` – the Session field set, validation rules, error-handling wording, ordering rule, the persistent overlap indicator, and the last-session delete refusal. This FIS implements that section; do not restate it, read it.
- `docs/specs/conference-setup-and-schedule/prd.md#data-requirements` – Session and Conference Day entity shape; Conference Day is *derived* from the Conference date span, not an independently created record. Also names the last-updated timestamp as the basis for detecting a concurrent overwrite.
- `docs/specs/conference-setup-and-schedule/prd.md#constraints` – Binding Constraint (FR4): "Session times are **naive wall-clock values** – stored and displayed without timezone conversion. A session at 09:00 reads as 09:00 on every device regardless of its timezone setting." This is the story's hardest rule; OC03 exists to hold it.
- `docs/specs/conference-setup-and-schedule/prd.md#non-functional-requirements` – Binding Constraints (NFR): plain PostgreSQL only, no provider-specific extensions (ADR-003); `hd` claim verified server-side on every request (ADR-002); responsive behaviour verified at 375px / 768px / 1280px per `AGENTS.md`.
- `docs/specs/conference-setup-and-schedule/plan.json#sharedDecisions` – four decisions consumed and two produced here. Consumed: the API route/error-envelope conventions (S01) and the authenticated caller context (S02); the per-conference authorization primitive, whose provisional helper seam S03 produces and this story must call rather than writing inline role checks. **Produced by this story**: "Naive wall-clock time representation" and the two timestamp fields this story owns under "Conference and Session timestamps - three fields, four consumers" – S06, S09 and S10 consume both, so they are pinned concretely below rather than left to the executor.
- `docs/specs/conference-setup-and-schedule/plan.json#sharedDecisions` → *Conference and Session timestamps - three fields, four consumers* – **read this before writing the trigger.** Three distinct fields, not one: (1) `session.last_updated_at`, the per-Session row version S09 uses as its optimistic-concurrency base – **owned here**; (2) `conference.schedule_watermark_at`, the whole-schedule watermark advanced by every Session insert, update **and delete**, which S10 uses as its reconnect cursor and S09 as its poll comparison – **owned here**; (3) `conference.updated_at`, the Conference row's own version and the concurrency base for a name or date-span edit – **owned by S03, and this story's trigger must leave it alone**. Two near-identically named columns on one table is the trap; the names above are the mitigation.
- `docs/specs/conference-setup-and-schedule/s03-conference-lifecycle.md` – TI08 defines the schedule-gate port `hasAtLeastOneSession(conferenceId)` whose production binding returns `false` until this story supplies the real Session count, and TI01 owns `conference.updated_at`. S03's Execution Contract records the resulting obligation on S04; TI11 here discharges it. Read S03's publish scenario **S03** before starting TI11 – it is the scenario re-run end to end.
- `docs/UBIQUITOUS_LANGUAGE.md#conference-structure` – canonical terms: Conference, Conference Day, Schedule, Session, Presentation, Workshop, Parallel Track. Use them in code and UI copy; avoid the listed synonyms (`talk`, `slot`, `event`, `item`, `agenda`, `programme`).
- `docs/guidelines/CRITICAL-RULES-AND-GUARDRAILS.md` – always-on agent rules; scope discipline and verify-before-done apply to every task here.
- `AGENTS.md` – project standing facts and the Do Not / Never list, in particular no in-process state between requests, no provider-specific database features, and no desktop-only layout.


## Deeper Context

- `docs/adrs/ADR-003-postgresql-containerized-development.md` – why portability constrains the schema; migrations must be reversible and use plain PostgreSQL.
- `docs/adrs/ADR-004-containerized-api-and-spa.md` – the API is a **long-running HTTP server in a container**, not Azure Functions; write endpoints against a plain HTTP framework and follow whatever S01 established. Statelessness still binds, for a different reason: handlers run across horizontal replicas, so no schedule state, overlap cache or watermark may live in process memory between requests. Where `plan.json#sharedDecisions` still says "Azure Functions HTTP route layout" / "Function handler", read it as the container API's route layout and handler – the convention it points at is S01's, and it is unchanged by the runtime swap.
- `docs/specs/conference-setup-and-schedule/plan.json#riskSummary` – the S04 entry states the mitigation this FIS is shaped around: pin both produced contracts in tests that assert no timezone coercion across the DB → API → client boundary before S06, S09 and S10 build on them.


## Acceptance Scenarios

- [x] **S01 [OC01] [TI01,TI03,TI06,TI09] Sessions added out of order render in start-time order within their Conference Day**
  - **Given** the published Conference "Autumn Offsite" spans 2026-09-15 to 2026-09-16
  - **When** an Admin adds "Retrospective" 15:00–16:00 on 2026-09-16, then "Opening Keynote" 09:00–10:30 on 2026-09-16
  - **Then** the Organizer's schedule view lists 2026-09-16 as "Opening Keynote" first, "Retrospective" second, and the day 2026-09-15 renders as an explicit empty state

- [x] **S02 [OC01] [TI03,TI04,TI06,TI09] Editing a Session moves it to another Conference Day and it re-sorts there**
  - **Given** "Retrospective" 15:00–16:00 sits on 2026-09-16 alongside "Opening Keynote" 09:00–10:30
  - **When** an Admin edits "Retrospective" to 08:00–09:00 on 2026-09-15
  - **Then** it disappears from 2026-09-16, appears on 2026-09-15, and 2026-09-16 now lists only "Opening Keynote"

- [x] **S03 [OC02] [TI05] Deleting the last remaining Session of a published Conference is refused**
  - **Given** the published Conference "Autumn Offsite" has exactly one Session, "Opening Keynote"
  - **When** an Admin deletes "Opening Keynote"
  - **Then** the deletion is refused with a reason stating a published Conference must keep at least one Session, the Session still exists, and after a second Session is added the same delete succeeds

- [x] **S04 [OC02] [TI01,TI04] A Session whose end time is not after its start time is refused**
  - **Given** the Conference "Autumn Offsite" spans 2026-09-15 to 2026-09-16
  - **When** an Admin saves a Session 23:15–00:45 on 2026-09-15 (a Session that would span midnight), or 10:00–10:00
  - **Then** both are refused with a reason naming that the end time must be after the start time on the same Conference Day, and nothing is persisted in either case

- [x] **S05 [OC02] [TI04] A Session placed outside the Conference date span is refused, naming the valid days**
  - **Given** the Conference "Autumn Offsite" spans 2026-09-15 to 2026-09-16
  - **When** an Admin saves a Session on 2026-09-17
  - **Then** the save is refused and the message names the permitted days (2026-09-15 and 2026-09-16)

- [x] **S06 [OC03] [TI01,TI08,TI10] A Session authored at 09:00 reads 09:00 on devices in three different timezones**
  - **Given** "Opening Keynote" was authored as 09:00–10:30 on 2026-09-15 from a device set to Europe/Stockholm (UTC+2)
  - **When** the same Session is read on a device set to America/Los_Angeles (UTC-7) and on one set to Asia/Tokyo (UTC+9)
  - **Then** both show 2026-09-15, 09:00–10:30 – identical to the authored values; the stored row holds date `2026-09-15` and time `09:00:00` with no offset, and the API response carries `"day": "2026-09-15"`, `"startTime": "09:00"`, `"endTime": "10:30"` with no `Z`, no offset suffix and no instant anywhere in the chain

- [x] **S07 [OC04] [TI07,TI09] Overlapping Sessions save with a non-blocking warning and stay marked after reload**
  - **Given** "Opening Keynote" runs 09:00–10:30 on 2026-09-15
  - **When** an Admin saves "Design Workshop" 10:00–11:00 on 2026-09-15
  - **Then** the save succeeds, a non-blocking warning names "Opening Keynote" as the overlapped Session, both Sessions carry an overlap indicator on the Organizer's schedule view, and the indicator is still on both after a full page reload by a different Admin

- [x] **S08 [OC05] [TI11] A draft Conference publishes once it has a real Session, and is still refused while it has none**
  - **Given** the draft Conference "Autumn Offsite" has no Sessions, and S03's publish gate is bound to the real Session count with no stub in the path
  - **When** an Admin publishes it, then adds "Opening Keynote" 09:00–10:30 on 2026-09-15 and publishes again
  - **Then** the first attempt is refused with S03's message about needing a schedule with at least one Session and the Conference stays draft, and the second attempt moves it to **published**

- [x] **S09 [OC01] [TI02] A Session write advances the schedule watermark without touching the Conference's own row version**
  - **Given** the Conference "Autumn Offsite" holds "Opening Keynote", and both `schedule_watermark_at` and `updated_at` are read from the Conference row
  - **When** an Admin edits "Opening Keynote" and then deletes it, and separately renames the Conference
  - **Then** each Session write advances `schedule_watermark_at` (the delete included) while `updated_at` is byte-identical to its value before those writes, and only the rename advances `updated_at`


## Structural Criteria

- [x] Session day, start time and end time are stored as PostgreSQL `date` and `time without time zone`; no `timestamp`, `timestamptz`, timezone column, or offset is used for authored Session times anywhere in schema, API or client.
- [x] The database driver returns `date` and `time` columns as strings, never as JavaScript `Date` objects, and no schedule time value is ever passed through `new Date(...)`, `Date.parse`, `toLocaleTimeString`, `Intl.DateTimeFormat` or a timezone-conversion library.
- [x] `session.last_updated_at` and `conference.schedule_watermark_at` both exist, are microsecond-granular, and are strictly monotonic per row – two consecutive writes to the same row never produce an equal or decreasing value, and the value is serialized to the wire without truncation.
- [x] `conference.schedule_watermark_at` advances on any Conference field change **and** on any Session insert, update or delete within that Conference, so it is a complete schedule watermark even for deletions.
- [x] `conference.updated_at` (S03 TI01) advances **only** on a change to a Conference's own fields and is left untouched by every Session insert, update and delete – no row-level "touch on any update" trigger may reach it, or story S09's Conference-edit concurrency base inherits the watermark's noise.
- [x] The wire field S06's envelope names `conference.lastUpdatedAt` is serialized from `conference.schedule_watermark_at`, never from `conference.updated_at` – the rename is a column-naming change only and must not alter the payload S06, S09 and S10 were specified against.
- [x] The production binding of S03's `hasAtLeastOneSession(conferenceId)` port queries the real Session count; no stub, constant or feature flag remains in the publish path, and S03's publish scenario passes against it unmodified.
- [x] Migrations are reversible and use plain PostgreSQL only – no provider-specific extensions (ADR-003).
- [x] Every Session write endpoint obtains its caller through S02's authenticated-caller context and its authorization through S03's single provisional per-conference helper – no inline role check and no in-process state between requests.
- [x] Refusals are emitted through S01's JSON error envelope carrying both a displayable message and a machine code.
- [x] The Organizer's schedule view is legible and usable at 375px, 768px and 1280px.


## Scope & Boundaries

### Work Areas
- Database migration: `sessions` table, `session.last_updated_at`, `conference.schedule_watermark_at`, and the monotonicity/watermark trigger – leaving S03's `conference.updated_at` untouched by Session writes.
- Publish-gate binding: the production implementation of S03's `hasAtLeastOneSession(conferenceId)` port, backed by the real Session count, with S03's publish scenario re-run end to end against it.
- Session write API: create, edit and delete endpoints with field, range and day-containment validation.
- Organizer schedule read endpoint `GET /conferences/{conferenceId}/schedule/organizer`: Sessions grouped by Conference Day, start-time ordered, carrying computed overlap pairs and the timestamp fields.
- Shared wall-clock time representation: server serialization and client parsing/formatting helpers used by every schedule surface.
- Organizer schedule view UI: day navigation, ordered Session list, persistent overlap indicator, add/edit/delete forms with inline errors.
- Contract test suite pinning the naive wall-clock and timestamp-field guarantees (including that `conference.updated_at` stays put) for S06, S09 and S10.

### What We're NOT Doing
- **The attendee-facing schedule view and its read model** -- S06 owns the attendee envelope and the server–device clock offset; this story only serves the Organizer's composition view.
- **Assigning Presenters/Facilitators to Sessions** -- referenced by FR2 but owned by S07. Leave the seam: introduce no Session Assignment table, column or endpoint here.
- **Optimistic-concurrency refusal and near-live propagation** -- S09 consumes `session.last_updated_at` for that; S04 only produces the fields and their guarantees. Do not implement conflict detection on save.
- **Offline caching and staleness UI** -- S10 consumes `conference.schedule_watermark_at` as its cache cursor; nothing here caches.
- **Changing how `conference.updated_at` behaves for Conference-field edits** -- S03 owns that field and S09 uses it as a concurrency base; this story's only obligation is that Session writes leave it alone.
- **Location as a bookable resource** -- free text only (FR2). No room clash detection, no resource registry.


## Architecture Decision

**Approach**: Session times are modelled as a `date` day plus two `time without time zone` columns, so a naive wall-clock value has no representation that could carry an offset; the two timestamp fields this story owns – `session.last_updated_at` (row version) and `conference.schedule_watermark_at` (schedule watermark) – are separate microsecond `timestamptz` instants kept strictly monotonic per row by a trigger, and are deliberately distinct columns from S03's `conference.updated_at` rather than one field doing three jobs.
**Why this over alternatives**: storing a `timestamptz` and "just not converting" fails the moment any driver, serializer or client library applies the offset it is entitled to apply – the constraint is enforced by making the wrong value unrepresentable rather than by discipline. The single-day + `end > start` shape also makes a midnight-spanning Session structurally impossible instead of a rule to remember.


## Technical Overview

Three layers must each independently refuse to convert. **Database**: `date` + `time without time zone` have no offset to apply. **API**: the query layer returns those columns as strings and the handler passes them through as strings – no `Date` is constructed, so `JSON.stringify` has nothing to render as a UTC instant. **Client**: schedule times stay strings (`"09:00"`) or a `{hour, minute}` value object; display formatting is string work and sorting is a lexicographic compare of the zero-padded `HH:mm`, which is order-correct. The timestamp fields are the deliberate exception – they *are* instants, are `timestamptz`, and are serialized as ISO-8601 UTC. Keeping the two kinds visibly different in naming and type is what stops a later story from "fixing" one to match the other; the same reasoning is why the Conference's watermark and its row version get visibly different column names (`schedule_watermark_at` vs `updated_at`) instead of near-identical ones.


## Code Patterns & External References

```
# type | path#anchor or url                                              | why needed (intent)
doc    | docs/specs/conference-setup-and-schedule/prd.md#fr2-schedule-composition | Field set, validation, error wording, ordering, overlap and delete rules
doc    | docs/specs/conference-setup-and-schedule/plan.json#sharedDecisions       | Error envelope (S01), caller context (S02), provisional authz helper (S03) to reuse verbatim
spec   | docs/specs/conference-setup-and-schedule/s03-conference-lifecycle.md    | Schedule-gate port (TI08) TI11 binds, the publish scenario re-run here, and conference.updated_at (TI01)
doc    | docs/UBIQUITOUS_LANGUAGE.md#conference-structure                         | Canonical naming for Session / Conference Day / Schedule / Parallel Track
adr    | docs/adrs/ADR-004-containerized-api-and-spa.md                           | Container API runtime – plain HTTP server, statelessness across replicas
url    | https://node-postgres.com/features/types                                 | Overriding type parsers so date/time columns arrive as strings, not Date objects
```

_No source files exist yet – S01 creates the API, migration and SPA scaffolding this story extends. Follow the conventions S01 establishes rather than inventing parallel ones._


## Constraints & Gotchas

- **Critical**: `node-postgres` parses `date` (OID 1082) and `time` (OID 1083) into JavaScript `Date` objects by default, silently anchoring the value to the server process's local midnight -- Must handle by: registering type parsers that return the raw strings for those OIDs, and covering it with a test that runs under a non-UTC `TZ`.
- **Avoid**: constructing a `Date` from day + start time "just to sort or compare" -- Instead: sort by `(day, startTime)` string tuple; zero-padded ISO date and `HH:mm` compare correctly as strings.
- **Constraint**: `now()` / `CURRENT_TIMESTAMP` return transaction-start time, so two writes in one transaction get identical `lastUpdatedAt` values and S09's concurrency check would not see the second -- Workaround: use `clock_timestamp()` and enforce strict monotonicity per row (`GREATEST(clock_timestamp(), old + interval '1 microsecond')`).
- **Avoid**: truncating `lastUpdatedAt` to seconds or milliseconds when serializing -- Instead: preserve full microsecond precision on the wire; S09 compares the exact value it was given.
- **Critical**: overlap is a **warning, never an error** -- Parallel Tracks are a supported product option (FR2, `docs/UBIQUITOUS_LANGUAGE.md`). A validation path that rejects an overlapping Session is a defect.
- **Critical**: the watermark trigger must not touch `conference.updated_at` -- a Session write advances the parent Conference row, which is mechanically an `UPDATE` on that row; if `updated_at` is maintained by an ordinary row-level "touch on any update" trigger it is bumped too, and S09's Conference-edit concurrency base becomes as noisy as the watermark, refusing an Organizer's rename because someone else moved a Session. Must handle by: writing `schedule_watermark_at` explicitly in the Session trigger, and maintaining `updated_at` only where Conference fields themselves change (a `WHEN` clause on the Conference trigger comparing the Conference's own columns, or setting it in the Conference update statement) – never as an unconditional `BEFORE UPDATE` touch. Prove it with a test that fails if a Session write moves `updated_at`.
- **Avoid**: naming the two Conference timestamps alike (`last_updated_at` / `updated_at`) -- Instead: `conference.schedule_watermark_at` for the watermark and `conference.updated_at` for the row version. This is the same trap the Technical Overview names for wall-clock vs instant: near-identical names invite a later story to "unify" two fields that mean different things. The Session-scoped field keeps `session.last_updated_at`, since on that table there is only one.
- **Constraint**: Session writes on an archived Conference must be refused -- Workaround: call the lifecycle guard S03 introduces; do not re-derive archived-state logic here.


## Implementation Plan

### Implementation Tasks

- [x] **TI01** Session schema exists with naive wall-clock columns and a reversible migration
  - `sessions` table: id, conference_id (FK), `title`, `description` (nullable), `kind` (constrained to `Presentation` | `Workshop`), `day date`, `start_time time without time zone`, `end_time time without time zone`, `location`, plus a `CHECK (end_time > start_time)`. Plain PostgreSQL only (ADR-003); follow the migration tooling S01 establishes.
  - **Verify**: `Test: migration applies and rolls back cleanly; column types report date and time without time zone; an insert with end_time <= start_time is rejected by the database`

- [x] **TI02** The Session row version and the Conference schedule watermark are strictly monotonic, and the Conference's own row version is untouched by Session writes
  - Add `session.last_updated_at timestamptz` (the per-Session row version S09 uses as its concurrency base) and `conference.schedule_watermark_at timestamptz` (the whole-schedule watermark S10 uses as its reconnect cursor). A trigger sets each to `GREATEST(clock_timestamp(), OLD.<column> + interval '1 microsecond')` on write, and any Session insert/update/delete also advances its parent Conference's `schedule_watermark_at` so deletions are observable to a cursor. **`conference.updated_at` (S03 TI01) is a third, separate field and must not move on a Session write** – see Constraints & Gotchas for why an unconditional row-level touch trigger breaks S09. On the wire the watermark is serialized as S06's `conference.lastUpdatedAt`; only the column name changes.
  - **Verify**: `Test: two consecutive updates to one Session yield strictly increasing session.last_updated_at; two writes inside a single transaction still differ; inserting, updating and deleting a Session each advance conference.schedule_watermark_at`
  - **Verify**: `Test: conference.updated_at is byte-identical before and after a Session insert, update and delete, and advances only when a Conference field itself changes – the test fails if a Session write bumps it`

- [x] **TI03** Session create, edit and delete endpoints exist behind the authenticated caller context and the provisional authorization helper
  - Route shape and JSON error envelope per S01; caller per S02; authorization via the single provisional per-conference helper from S03 (S07 generalizes that one call-site pattern) and the same lifecycle guard that refuses writes on an archived Conference. Handlers hold no in-process state.
  - **Verify**: `Test: an unauthenticated request is rejected before handler logic runs; a non-Admin of that Conference is refused; a write to an archived Conference is refused with the reason named`

- [x] **TI04** Invalid Session input is refused with a user-facing reason naming what is permitted
  - Title non-empty ≤200 chars; location non-empty ≤100 chars; kind exactly Presentation or Workshop; end after start; `day` within the Conference date span with the refusal naming the valid days. Emit through S01's envelope (displayable message + machine code). Covers S04 and S05.
  - **Verify**: `Test: each invalid field yields a 4xx whose envelope message names the violated rule; the out-of-span case lists the Conference's permitted days; nothing is persisted`

- [x] **TI05** Deleting the last remaining Session of a published Conference is refused
  - Holds the invariant TI11 binds S03's publish gate to (a published Conference always has ≥1 Session), so publishing cannot be undone by a later delete. Draft Conferences are unaffected. Depends on TI03's delete endpoint.
  - **Verify**: `Test: deleting the sole Session of a published Conference is refused and the row survives; deleting one of two succeeds; deleting the sole Session of a draft Conference succeeds`

- [x] **TI06** `GET /conferences/{conferenceId}/schedule/organizer` returns Sessions grouped by Conference Day in start-time order
  - Route pinned explicitly to keep it distinct from S06's attendee read `GET /conferences/{conferenceId}/schedule` – same resource, two audiences: this one is Admin-only, carries composition data (overlap pairs, per-Session `lastUpdatedAt`) and has no membership/clock-offset envelope. Register it without an `api/` prefix per S01's convention. Conference Days are derived from the Conference date span, so a day with no Sessions is still present and empty. Payload carries wall-clock strings per TI08, each Session's `lastUpdatedAt`, and the Conference watermark serialized as `lastUpdatedAt`. This is the Organizer payload only – S06 owns the attendee read model.
  - **Verify**: `Test: GET /conferences/{conferenceId}/schedule/organizer returns Sessions start-time ascending within each day when inserted out of order; every day in the span appears, including empty ones; a non-Admin member of that Conference is refused on this route`

- [x] **TI07** Overlap pairs are recomputed on every schedule read and returned with the payload
  - Two Sessions on the same day overlap when `start < otherEnd AND end > otherStart` (touching boundaries do not overlap). Computed per read, never stored, so it cannot go stale. Overlap is warning data – no write path may reject on it.
  - **Verify**: `Test: 09:00–10:30 and 10:00–11:00 on one day are returned as an overlapping pair; 09:00–10:00 and 10:00–11:00 are not; the pair is present on a fresh read by a different caller with no prior save in that session`

- [x] **TI08** A single wall-clock time representation is used from database to screen
  - Wire format: `"day": "YYYY-MM-DD"`, `"startTime": "HH:mm"`, `"endTime": "HH:mm"` – 24-hour, zero-padded, no seconds, no offset, no `Z`. Driver type parsers return `date`/`time` as strings (see Constraints & Gotchas); client helpers parse/format/compare as strings or `{hour, minute}` and never construct a `Date`. `lastUpdatedAt` is the explicit exception and stays an ISO-8601 UTC instant.
  - **Verify**: `Test: round-tripping a 09:00 Session through create then read returns exactly "09:00" with the test process TZ set to UTC, UTC-7 and UTC+9`

- [x] **TI09** The Organizer's schedule view composes the Schedule and marks overlaps persistently
  - Day navigation across the Conference span, Sessions in start-time order with title, kind, time range and location; add/edit/delete forms surfacing TI04's messages inline; a persistent overlap indicator driven by TI07's payload (not a save-time toast only) plus the non-blocking save warning naming the overlapped Session. Consumes TI08's helpers for all time rendering. Responsive at 375px / 768px / 1280px.
  - **Verify**: `Test: overlap indicator is present after a fresh load with no prior save; screenshots at 375px, 768px and 1280px show no clipped or horizontally scrolling content`

- [x] **TI10** A contract test suite pins the two produced shared decisions for S06, S09 and S10
  - One suite asserting the full DB → API → client path performs no timezone coercion under at least two non-UTC process timezones, and one asserting timestamp granularity, per-row monotonicity, `conference.schedule_watermark_at` watermark behaviour on insert/update/delete, and that `conference.updated_at` is unmoved by Session writes. These are the guard rails the risk summary calls for; they must fail if a later story introduces a UTC round-trip.
  - **Verify**: `Test: the suite fails when a schedule time is deliberately routed through a Date, and fails when a timestamp is truncated to second granularity, and fails when conference.updated_at is made to advance on a Session write`

- [x] **TI11** S03's schedule-gate port is bound to the real Session count and its publish scenario passes end to end
  - Replace the production binding of `hasAtLeastOneSession(conferenceId)` (S03 TI08), which returns `false` until this story lands, with a query over the `sessions` table for that Conference. Nothing else about S03's publish path changes – the port, its call site and its refusal message stay as S03 wrote them; only the implementation behind the port is supplied. No stub, constant or flag may remain in the production path. Then re-run S03's publish acceptance scenario (S03 **S03**) against the real gate and real Sessions rather than a stubbed port. **This discharges the binding obligation S03's Execution Contract leaves on this story; without it every downstream story needing a published Conference (S05's join code, S06, S08, S09, S10, S12's fixture) is unreachable.** Depends on TI01 and TI03.
  - **Verify**: `Test: S03's publish scenario passes unmodified with the port's production binding in place – zero Sessions refuses and the Conference stays draft, one real Session publishes; grep of the publish path finds no stub or hard-coded gate result`

### Testing Strategy

- No test infrastructure exists before S01 – use the runner and fixture conventions S01 establishes rather than adding a second stack.
- Timezone tests must set the process `TZ` (and, for browser-level checks, the emulated timezone) rather than mocking a formatter; a mock cannot catch the driver-level coercion this story exists to prevent.
- S03's publish scenario is re-run here **unmodified** against the real gate; if it needs editing to pass, the gate binding is wrong, not the scenario. Tag: `[TI11]`.
- The `conference.updated_at` assertion must read the column directly from the database around a Session write, not infer it from an API payload – the field is S03's and is not necessarily on this story's wire shape. Tag: `[TI02]`.

### Execution Contract

- TI01 and TI03 must complete before TI11: the gate query needs the `sessions` table and Sessions must be creatable for S03's publish success path to be provable with real data.
- **Discharges S03's binding obligation.** S03 TI08 defines `hasAtLeastOneSession(conferenceId)` with a production binding that returns `false`, and S03's Execution Contract states: "TI08 leaves a binding obligation on S04: bind the real Session count to the schedule-gate port and re-run S03's publish scenario end to end." TI11 is that discharge. The story is not done while S03's publish scenario passes only against a stub.
- **Leaves no timestamp obligation on S03.** `conference.updated_at` remains S03's field with S03's semantics; this story only guarantees its trigger does not move it. If binding the watermark requires changing how `updated_at` is maintained, change it here so both invariants hold, and record it in Implementation Observations rather than deferring it to S09.


## Implementation Observations

### Run: 2026-08-17 11:50 UTC – discovered-requirements

#### DISCOVERED REQUIREMENTS

- **A Session whose day falls outside the Conference's current date span must still appear on the Organizer's schedule.** TI06 derives Conference Days from the span, which is correct for showing an unfilled day, but a Session can legitimately sit outside that span: S03 permits a Conference's dates to be shortened past its Sessions, and records that as a deliberate sequencing gap left to S09. Grouping strictly by the derived days therefore drops such a Session from the payload while it still exists, still counts toward the publish gate, and still blocks the last-Session delete — invisible to the only surface that could fix it. The Organizer read now emits every day in the span **plus** any further day that holds Sessions, all in date order, so the payload is total over the Conference's Sessions. Discovered during S04 execution; the alternative (refusing the span change) belongs to S09, which owns that edit.

### Run: 2026-08-17 11:54 UTC – observations

#### NOTICED BUT NOT TOUCHING

- `visual/conferences.spec.ts` – pre-existing Prettier drift; `npm run format:check` reports it and S04 did not modify the file. Every file S04 touched is formatted.
- `visual/shell.spec.ts` – its 3 tests fail locally because the API refuses to start: `.env` carries an unconfigured `GOOGLE_AUDIENCE_ALLOWLIST` placeholder (`<paste client ID>`) and S02's startup guard rejects it (`WildcardAudienceError`). Local developer setup, unrelated to S04; the other 18 Playwright tests pass. Fixing it means configuring Google sign-in per `docs/KEY_DEVELOPMENT_COMMANDS.md`.
- `api/test/conference.integration.test.ts` – the test named 'is refused by the production schedule gate, which reports no session until S04' still passes, and for the right reason (a Conference with no Sessions). Only its title is dated now that TI11 has bound the real count. Left unmodified deliberately: the FIS requires S03's publish scenario to be re-run unmodified, and the assertion needs no change.
- `docs/specs/conference-setup-and-schedule/plan.json` – S03 is recorded as `spec-ready` although its code is committed and its suite is green. Pre-existing status drift; S04 changed only its own story's entry.

#### ASSUMPTIONS

- **Route prefix.** TI06 says to register the organizer read 'without an `api/` prefix per S01's convention'. S01's actual convention – visible in `api/src/routes/*` and asserted by S03's own structural test (`expect(urls).toContain('POST /api/conferences')`) – registers every route under `/api`, while the SPA resolves an `/api` base URL so client paths are written without it. The convention was followed over the literal example: the route is registered as `GET /api/conferences/:conferenceId/schedule/organizer`, and the client calls `/conferences/{conferenceId}/schedule/organizer`, which is the FIS's literal path exactly as the client writes it. Registering outside `/api` would have broken the SPA's base-URL resolution and the container's reverse proxy.
- **Table name.** The table is `sessions` (plural), as the FIS names it in TI01, TI11 and the Structural Criteria, although S01/S03's tables are singular (`conference`, `membership`, `role_assignment`). FIS-as-source-of-truth was taken over the implicit local convention, because S06, S09 and S10 were specified against the same name.
- **One S03 test was updated.** `conference.integration.test.ts` → "is the conference table's only version column – the watermark is S04's" asserted `schedule_watermark_at` was absent, and its own comment said S04 adds it. It now asserts the invariant that outlives both stories: `updated_at` and `schedule_watermark_at` exist as separate, deliberately unalike-named columns, and `last_updated_at` is still absent from `conference` because that field belongs to `sessions`. No scenario or acceptance contract was changed.
