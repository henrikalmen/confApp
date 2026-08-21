# S03 – Conference Lifecycle

**Plan**: docs/specs/conference-setup-and-schedule/plan.json
**Story-ID**: S03

## Feature Overview and Goal

**Intent**: Nothing else in the theme can exist until a Conference does – the Schedule, join codes, Memberships and Role Assignments all hang off one record whose lifecycle state decides who may see, change and join it, so this story makes that state the server's decision rather than a UI convention.

**Expected Outcomes** (scenarios anchor to these via `[OC<NN>]`):

- [OC01] Any signed-in employee can create a Conference with a name and a 1–4 consecutive-day span and is immediately both a member of it and its Admin; invalid details are refused with a displayable message naming the offending field and the permitted range.
- [OC02] A Conference advances draft → published → archived and never backwards, with publishing gated on the Conference having at least one Session and archiving restricted to published Conferences past their end date; every refusal states its reason.
- [OC03] An archived Conference stays readable and is visually distinguished from active ones, while edits and joins against it are refused and no data is deleted.
- [OC04] A signed-in employee who is not an Admin of a Conference cannot create, change or advance its lifecycle state, and the refusal comes from the server regardless of what the client offers.


## Required Context

- `docs/specs/conference-setup-and-schedule/prd.md#fr1-conference-creation--lifecycle` – the lifecycle states, the 1–4 day span rule, the publish gate, the one-way draft → published transition, and the three user-facing error messages this story must be able to display.
- `docs/specs/conference-setup-and-schedule/prd.md#fr9-conference-archive` – archived Conferences stay viewable by those who joined, are visually distinguished, cannot be edited or joined, and archiving deletes nothing; only **published** Conferences past their end date may be archived.
- `docs/specs/conference-setup-and-schedule/prd.md#data-requirements` – the Conference record (name, start date, end date, lifecycle state, join code absent until published), the **Membership** record (links a user's `sub` claim to a conference – the fact of being in it), and the Role Assignment record (user, conference, role; per-conference, never derived from a directory). This story owns the Membership *table*; S05 and S08 own joining and revocation.
- `docs/specs/conference-setup-and-schedule/plan.json#sharedDecisions` – two entries bind this story: *Per-conference authorization primitive* (S07 owns the canonical role check; S03 must express every check through one provisional helper with that signature) and *API route, handler and error envelope conventions* (refusals emit through S01's envelope carrying a displayable message, not a bare status).
- `docs/specs/conference-setup-and-schedule/plan.json#sharedDecisions` → *Authenticated caller context* – the verified `sub` and `hd` claim arrive from S02's wrapper; this story adds no token-validation code of its own.
- `docs/specs/conference-setup-and-schedule/plan.json#sharedDecisions` → *Conference and Session timestamps – three fields, four consumers* – binding: three distinct fields, not one. This story owns field 3 only, the **Conference row version** `conference.updated_at` (`updatedAt` on the wire), which S09 uses as the base version for a name or date-span edit and which must **never** advance on a Session write. Field 2, the schedule watermark `conference.schedule_watermark_at` (`lastUpdatedAt` on the wire), is S04's and is deliberately not created here; the names are chosen so the two Conference columns are distinguishable at a glance.
- `docs/specs/conference-setup-and-schedule/prd.md#fr6-conference-membership-management` – context for why the creator is given a Membership: FR6 contemplates an Admin leaving once another Admin exists, and leaving means revoking a Membership. A creator with no Membership row could never be listed, removed, or leave.
- `docs/specs/conference-setup-and-schedule/prd.md#non-functional-requirements` – binding: `hd` claim verified server-side on **every** request (ADR-002); plain PostgreSQL only, no provider-specific extensions (ADR-003); responsive verified at 375px / 768px / 1280px per `AGENTS.md`.
- `docs/specs/conference-setup-and-schedule/prd.md#constraints` – binding: roles are confApp's own per-conference data and are never derived from directory groups (ADR-002); attendee identity is the `sub` claim and email is display data only.
- `docs/specs/conference-setup-and-schedule/prd.md#fr5-per-conference-role-assignment` – binding: Presenter/Facilitator is **one** role, not two, and assignment is keyed on the stable `sub` claim, not email. This story seeds only the creator's Admin assignment, but the record it writes must already obey both rules.
- `docs/UBIQUITOUS_LANGUAGE.md` – canonical terms: Conference, Conference Day, Schedule, Session, Admin (also *Organizer*), Attendee, Archive. Avoid the listed synonyms in code, API field names and UI copy.
- `docs/guidelines/CRITICAL-RULES-AND-GUARDRAILS.md` – always-on agent rules; scope discipline and verify-before-claiming-done apply to this story's validation.


## Deeper Context

- `docs/adrs/ADR-003-postgresql-containerized-development.md` – why the schema must stay portable plain PostgreSQL; read before choosing a column type or an extension.
- `docs/adrs/ADR-002-authenticate-with-google-workspace-oidc.md` – why identity is the `sub` claim and why roles are confApp data; read before touching the Role Assignment seed.
- `docs/adrs/ADR-004-containerized-api-and-spa.md` – **accepted 2026-08-16, supersedes serverless-on-Azure.** The API is a long-running HTTP server in a container, written against a plain HTTP framework; nothing here is written against the Azure Functions programming model. Read before creating a route or a handler.
- `docs/ARCHITECTURE.md#key-constraints` – handlers hold no in-process state between requests. Under ADR-004 the reason is horizontal scaling across replicas rather than transient serverless instances, but the rule is unchanged and binding: the lifecycle guard must read Conference state from the database on every call.
- `docs/specs/conference-setup-and-schedule/prd.md#edge-cases` – the "publishes a conference with no sessions" and "one Admin archives while another is mid-edit" rows; the second is S09's to implement but explains why the transition guard is server-side and re-read per request.


## Acceptance Scenarios

- [x] **S01 [OC01,OC04] [TI01,TI04,TI05,TI06,TI11] A signed-in employee creates a Conference and is both a member of it and its Admin**
  - **Given** Ida is signed in with her company Google account and is a member of no Conference
  - **When** she creates a Conference named "Autumn Kickoff 2026" running 2026-09-14 to 2026-09-16
  - **Then** the Conference is persisted in state **draft**, Ida holds **both** a Membership and an Admin Role Assignment for it, each keyed on her `sub`, and it appears in her Conference list marked as a draft
  - **And** no other signed-in employee sees that draft Conference in their list
  - **And** the Conference read carries an `updatedAt` row version that a later edit can be based on

- [x] **S02 [OC01] [TI03,TI05,TI11] Invalid Conference details are refused with the permitted range stated**
  - **Given** Ida is signed in
  - **When** she submits a Conference spanning 2026-09-14 to 2026-09-18 (five days), and separately one whose name is blank after trimming
  - **Then** each attempt is refused, nothing is persisted, and the response carries a displayable message identifying the offending field – the span refusal states the permitted 1–4 day range, the name refusal states that a name is required
  - **And** a 4-day span and a 120-character name are both accepted, while a 121-character name is refused

- [x] **S03 [OC02] [TI02,TI08] Publishing is gated on the Conference having at least one Session**
  - **Given** "Autumn Kickoff 2026" is in draft and its schedule gate reports zero Sessions
  - **When** Ida publishes it
  - **Then** the transition is refused, the Conference stays in draft, and the message explains that a schedule with at least one Session is required
  - **And** when the schedule gate reports one Session, the same action moves the Conference to **published**

- [x] **S04 [OC02] [TI02] Lifecycle transitions run one way only**
  - **Given** "Autumn Kickoff 2026" is published
  - **When** Ida attempts to return it to draft
  - **Then** the transition is refused with the current and requested states named, and the Conference remains published
  - **And** the same refusal applies to any transition out of **archived** – archived is terminal

- [x] **S05 [OC02] [TI02,TI09] Archiving is restricted to published Conferences past their end date**
  - **Given** today is 2026-09-15 and "Autumn Kickoff 2026" is published, ending 2026-09-16
  - **When** Ida archives it
  - **Then** the attempt is refused and the message states the earliest permitted date, 2026-09-17
  - **And** archiving a Conference still in draft is refused whatever the date, because a draft never became visible to anyone
  - **And** on 2026-09-17 the published Conference archives successfully

- [x] **S06 [OC03] [TI01,TI07,TI10,TI11] An archived Conference stays readable but refuses edits and joins**
  - **Given** "Autumn Kickoff 2026" is archived and Ida is its Admin
  - **When** she opens it, renames it, and a signed-in employee attempts to join it
  - **Then** the Conference and its stored data are still retrievable, its list and detail views mark it as archived and visually distinct from active Conferences, the rename is refused with an explanation naming the archived state, and the joinability guard reports it as not joinable
  - **And** the Conference row, its Memberships, its Role Assignments and its `startDate`/`endDate` are unchanged by archiving – nothing is deleted
  - **And** a Conference still in **published** state whose end date has already passed also reports as not joinable – joinability ends with the end date, not with the manual archive step

- [x] **S07 [OC04] [TI04,TI05,TI07,TI08,TI09] A non-Admin cannot change or advance another employee's Conference**
  - **Given** "Autumn Kickoff 2026" is a draft created by Ida, and Björn is a signed-in employee with no Role Assignment for it
  - **When** Björn calls the rename, publish and archive endpoints for that Conference directly, bypassing the UI
  - **Then** each call is refused as unauthorized through the same authorization helper, no state changes, and the response does not disclose Conference details Björn is not entitled to
  - **And** an unauthenticated or wrong-`hd`-domain caller is refused by S02's wrapper before any handler code runs


## Structural Criteria

> Each criterion is proved by a task Verify line, not a scenario.

- [x] Every per-Conference authorization decision in this story's handlers goes through the single provisional helper – no inline role or creator comparisons in handler bodies, so S07 replaces one implementation.
- [x] The schema uses plain PostgreSQL only – no provider-specific extensions – and the migration is reversible in both directions.
- [x] Conference `startDate` and `endDate` are naive calendar dates that survive the database → API → client round trip unchanged, with no timezone coercion at any layer.
- [x] Membership and Role Assignment rows are keyed on the user's `sub` claim; no column keys, joins on, or uniquely identifies a user by email.
- [x] Membership means "is in this conference" for **every** role without exception – no code path treats an Admin, or the creator, as a member-by-implication rather than by a Membership row.
- [x] Exactly one joinability predicate exists in the codebase, exported from the lifecycle module, and it tests lifecycle state **and** end date; no second implementation of the rule appears anywhere.
- [x] `conference.updated_at` is the Conference row's own version and is advanced only by writes to the Conference row itself.
- [x] Every refusal in this story emits through S01's error envelope with a displayable message and a distinct machine code per refusal reason.
- [x] Multiple Conferences may exist and more than one may be published at a time – no constraint or guard enforces a single active Conference.
- [x] The Conference list, create and detail surfaces render without horizontal scroll and remain legible at 375px, 768px and 1280px.


## Scope & Boundaries

### Work Areas
- Database migration introducing the Conference table (name, start date, end date, lifecycle state, `updated_at` row version), the **Membership** table (user `sub`, conference) and the minimal Role Assignment table (user `sub`, conference, role).
- Seeding the creator's Membership alongside their Admin Role Assignment, so "is in this conference" is one uniform fact for every role.
- Conference lifecycle domain module – transition state machine, guards, and the editability/joinability predicates S05 and S09 consume.
- Conference field validation – name and date-span rules producing field-level, displayable refusals.
- Provisional per-conference authorization helper – the seam S07 generalizes.
- Conference HTTP endpoints – create, list, get, update details, publish, archive.
- Publish gate port against Session existence – interface only; S04 binds the real implementation.
- Organizer web surfaces – Conference list with archived styling, create form with inline field errors, detail view with lifecycle actions and refusal display.

### What We're NOT Doing
- Session records, the Schedule and Conference Day content -- S04 owns them; this story consumes only a boolean "has at least one Session" through a port.
- Join code generation on publish, and joining itself -- S05 owns both; this story publishes without minting a code, owns the Membership table S05 writes into, and exports the joinability predicate S05 consumes rather than redefines.
- The full role model, Presenter/Facilitator assignment, the last-Admin rule and the canonical role check -- S07 owns them; this story seeds only the creator's Admin assignment and leaves the helper provisional.
- Post-publish concurrency (the `updatedAt` base-version check) and the refusal to shorten a date span that orphans Sessions -- S09 owns them, and they need Sessions to exist first. This story only *supplies* `updatedAt` on the Conference read so S09 has a base version to send back.
- The Conference schedule watermark `schedule_watermark_at` -- S04 owns that column, its advance-on-insert/update/delete behaviour, and S10's use of it as a reconnect cursor. This story creates only `updated_at`.
- Joining, leaving and Admin removal of a member -- S05 creates Memberships, S08 revokes them. This story creates the Membership **table** and writes exactly one row: the creator's. Archived-state refusal is expressed here as a guard, not as a membership endpoint.


## Architecture Decision

**Approach**: One server-side lifecycle state machine is the sole authority on legal transitions and on whether a Conference is editable or joinable; handlers ask it, the client only reflects it.
**Why this over alternatives**: The API scales horizontally across container replicas (ADR-004) and the client is untrusted, so state read from the database per request and guarded in one module is the only place the draft/published/archived invariants can actually hold – scattering the checks across endpoints is exactly the pattern S07 would then have to unpick. The same single-module rule is what keeps joinability from being defined twice: S05 extends this predicate rather than writing its own.


## Technical Overview

Create writes three rows in one transaction: the Conference in `draft`, the creator's Membership, and the creator's Admin Role Assignment – the latter two both keyed on the verified `sub` from S02's caller context. The Membership is not ceremony: it makes "is in this conference" one uniform fact, so the creator appears in their own member list, can be shown the attendee view, and can be removed or leave once a second Admin exists (FR6). Every subsequent endpoint runs the same three steps – S02's wrapper resolves the caller, the provisional authorization helper asserts Admin for the named Conference, then the lifecycle module decides whether the requested change is legal in the Conference's current state. Publish additionally consults a schedule-gate port; that port is defined here and returns `false` until S04 supplies a real Session count, so the publish success path is proven against the port rather than against a Sessions table that does not yet exist. Refusals from validation, authorization and the state machine all surface through S01's error envelope so the organizer surfaces render one message shape.


## Code Patterns & External References

```
# type | path#anchor or url                                              | why needed (intent)
plan   | docs/specs/conference-setup-and-schedule/plan.json#sharedDecisions | Helper signature + envelope conventions this story must consume, not invent
plan   | docs/specs/conference-setup-and-schedule/plan.json#bindingConstraints | Constraints carried verbatim because they are violated by reflex
prd    | docs/specs/conference-setup-and-schedule/prd.md#fr1-conference-creation--lifecycle | Acceptance criteria, validation rules and the exact refusal semantics
prd    | docs/specs/conference-setup-and-schedule/prd.md#fr9-conference-archive | Archive guard, read-only consequences and the no-deletion rule
doc    | docs/UBIQUITOUS_LANGUAGE.md                                     | Canonical naming for entities, API fields and UI copy
adr    | docs/adrs/ADR-003-postgresql-containerized-development.md       | Portability bar for the migration and column types
adr    | docs/adrs/ADR-004-containerized-api-and-spa.md                  | The API is a long-running containerized HTTP server, not Azure Functions; statelessness still binding
```

> No application code exists at authoring time – S01 and S02 create the route layout, error envelope, migration tooling and caller-context wrapper this story extends. Read the surfaces they produced before writing the first endpoint; do not re-derive their conventions.


## Constraints & Gotchas

- **Critical**: Every authorization check routes through the single provisional helper -- Must handle by: exporting one function whose signature already matches S07's canonical check, e.g. `requireConferenceRole(caller, conferenceId, required, options?)` where `caller` is S02's authenticated caller, `required` is one of `Admin | PresenterFacilitator | Attendee`, and `options.sessionId` is accepted and ignored for now (S07 gives it meaning for the Presenter/Facilitator session scope). It resolves the caller's Role Assignment row for that Conference and throws an authorization error mapped to S01's envelope. Never inline `conference.createdBySub === caller.sub` in a handler.
- **Critical**: Presenter/Facilitator is **one** role, not two -- Must handle by: a single enum member in the role type and in the database check constraint, even though this story only ever writes `Admin`. Splitting it now costs a migration and a rewrite in S07.
- **Avoid**: Storing Conference dates as timestamps or coercing them through a `Date` with an implicit local offset -- Instead: plain `date` columns, ISO `YYYY-MM-DD` strings on the wire, and no client-side `new Date(string)` parsing that shifts the day. A day-boundary shift silently breaks both the span validation and the archive guard.
- **Critical**: The Conference carries **two** timestamp columns before this theme is finished and they mean different things -- Must handle by: this story creates `conference.updated_at` only, the Conference row's own version, exposed as `updatedAt`. S04 adds `conference.schedule_watermark_at` (`lastUpdatedAt` on the wire), the whole-schedule watermark advanced by every Session insert, update and delete. Never advance `updated_at` from a Session write, or S09's conflict detection fires on every unrelated schedule change; never use the watermark as an edit base version. The deliberately dissimilar column names are the guard against confusing them – do not "tidy" them into one shared column.
- **Critical**: One definition of joinable, not two -- Must handle by: the lifecycle module exports the single joinability predicate and it tests lifecycle state `published` **and** end date not in the past. S05's join endpoint consumes this predicate; it must not restate the rule. Archived is not the only non-joinable state – a published Conference that has ended is closed too.
- **Avoid**: Letting the client decide whether a lifecycle action is legal -- Instead: the UI may hide or disable an affordance, but the server refuses independently; every scenario refusal must be reproducible by calling the endpoint directly.
- **Constraint**: The publish success path cannot be proven end-to-end until S04 exists -- Workaround: the schedule-gate port is the seam; prove refusal against the real binding (zero Sessions) and success against a stubbed port. S04 must bind the real Session count and re-run this story's publish scenario.
- **Assumption (recorded)**: "after its end date" is read as *strictly after* – a Conference ending 2026-09-16 becomes archivable on 2026-09-17, which is the date the refusal message states. The comparison uses the server's current calendar date in the same naive frame as the stored dates. The joinability predicate uses the same frame and the complementary boundary: that Conference is still joinable on 2026-09-16 and stops being joinable on 2026-09-17, whether or not anyone has archived it.
- **Assumption (recorded)**: Draft Conferences are listed only to employees holding a Role Assignment for them, per FR1's "visible only to Organizers"; published and archived Conferences are listed to their members. Discovery of a Conference one has never joined is FR3's join-code path, not a list query.


## Implementation Plan

### Implementation Tasks

- [x] **TI01** Conference, Membership and Role Assignment tables exist with a reversible migration
  - Conference: name, start date, end date as plain `date` columns, lifecycle state constrained to `draft | published | archived`, creator `sub`, `created_at`, and `updated_at` – **the Conference row's own version**, advanced only by writes to the Conference row itself (`plan.json#sharedDecisions` → *three fields, four consumers*, field 3). The watermark column `schedule_watermark_at` is **not** created here; S04 adds it, and the two names are kept visibly different on purpose. **Membership**: conference, user `sub`, joined timestamp, unique per (conference, sub) – this story owns the table; S05 writes join rows into it and S08 revokes them. Role Assignment: conference, user `sub`, role constrained to `Admin | PresenterFacilitator | Attendee`, unique per (conference, sub, role). Plain PostgreSQL only per ADR-003; no join-code column yet (S05).
  - **Verify**: `Test: migration applies and rolls back cleanly against the Docker Compose database; inserting a lifecycle state or role outside the permitted sets is rejected by the database; a second Membership for the same (conference, sub) is rejected by the unique constraint; a Conference written with startDate 2026-09-14 reads back as 2026-09-14; the Conference table has exactly one timestamp column named updated_at and no column named schedule_watermark_at`

- [x] **TI02** A lifecycle module is the single authority on legal Conference transitions and on editability and joinability
  - Exposes the permitted transitions (draft → published, published → archived) and refuses every other pair, including any return to draft and any transition out of archived, naming current and requested state in a displayable message. Also exposes the editability and joinability predicates TI07 and S05 consume. **Joinable means lifecycle state `published` AND end date not in the past** – this is the single, whole definition of the invariant, absorbing the end-date rule so S05 extends this predicate instead of writing a second one. Holds no in-process state – state is read from the database per request (ADR-004: replicas, not sticky requests).
  - **Verify**: `Test: each illegal transition pair is refused with a message naming both states; draft → published and published → archived are permitted; an archived Conference reports not editable and not joinable; a draft Conference reports not joinable; a published Conference whose end date has passed reports not joinable; a published Conference within its span reports joinable`

- [x] **TI03** Conference field validation refuses invalid names and spans with field-level displayable messages
  - Name non-empty after trimming and at most 120 characters; end date on or after start date; span 1–4 consecutive days inclusive. Refusals name the field and state the permitted range, per FR1's Error Handling prose, and emit through S01's envelope.
  - **Verify**: `Test: a 5-day span is refused with a message stating the 1–4 day range; a blank/whitespace name is refused naming the name field; a 4-day span and a 120-character name are accepted; a 121-character name is refused; each refusal body carries S01's envelope with a displayable message and a machine code distinct from the other refusal reasons`

- [x] **TI04** A single provisional per-conference authorization helper exists and is the only authorization path in this story's handlers
  - Signature as pinned in Constraints & Gotchas; resolves the caller's Role Assignment for the Conference (only the creator's Admin seed exists at this point) and throws an authorization error mapped to S01's envelope. Consumes S02's authenticated caller unchanged; adds no token validation. S07 replaces the body, not the call sites.
  - **Verify**: `Test: a caller with no Role Assignment for the Conference is refused by the helper; grep of this story's handler modules finds no inline creator/role comparison – every check is a call to the helper`

- [x] **TI05** Creating a Conference persists it in draft and seeds the creator's Membership **and** Admin Role Assignment atomically
  - Any authenticated employee may create; no instance-level permission is consulted. All three rows – Conference, Membership, Admin Role Assignment – are written in one transaction, the latter two keyed on the verified `sub`, never on email. The Membership is not optional: Membership means "is in this conference" for every role, so the creator is visible in their own member list (S07), can be granted or removed (S07/S08), can leave once a second Admin exists (FR6), and can open the attendee view of their own Conference (S06). Validation from TI03 runs before any write. Depends on TI01, TI03, TI04.
  - **Verify**: `Test: creation returns the persisted draft Conference and the creator holds both a Membership and an Admin Role Assignment for it, each keyed on sub; a validation failure leaves none of the three rows behind; no email value is written to either key`

- [x] **TI06** `GET /conferences` is the Organizer list, and the Conference read returns the row version
  - **Route split, deliberate – two endpoints, not a collision.** `GET /conferences` is the **Organizer** list and belongs to this story: the Conferences the caller holds a Role Assignment for, **including drafts**, each with its lifecycle state so the client can distinguish archived ones. The **Attendee** list is a different result set – joined Conferences in `published` or `archived` state – and lives at `GET /me/conferences`, owned by S06. Do not merge or overload them; a reader seeing both should see two intended endpoints.
  - The single-Conference read returns `updatedAt`, the Conference row version from TI01. S09 cannot base a name or date-span edit on a version it was never sent, so this field is load-bearing, not decorative. No watermark field is present on this read; S04's schedule watermark surfaces separately via S06's envelope as `lastUpdatedAt`. Depends on TI01, TI04.
  - **Verify**: `Test: a second signed-in employee's GET /conferences omits another employee's draft Conference; the creator's includes it with state draft; each entry carries its lifecycle state; the single-Conference read body carries updatedAt and no watermark field; renaming the Conference changes the updatedAt value returned by the next read`

- [x] **TI07** Conference name and date span can be changed while the Conference is not archived
  - Applies TI03's validation and TI02's editability predicate; refused with an explanation naming the archived state when the Conference is archived. A successful edit advances `conference.updated_at`. Post-publish concurrency and the orphaned-Session rule are S09's and are deliberately absent here. Depends on TI02, TI03, TI04.
  - **Known gap, accepted:** between this story (W3) and S09 (W7) a date span may be shortened so that Sessions fall outside it, because the orphan check does not exist yet. The invariant is genuinely violable in that window – this is a sequencing consequence, not an oversight, and Sessions themselves only appear in S04 (W4). S09 adds the refusal; nothing here should attempt a partial version of it, and no data written in the interim is assumed to satisfy the invariant.
  - **Verify**: `Test: renaming a draft and a published Conference succeeds and the Conference's updatedAt advances; renaming an archived Conference is refused with a message naming the archived state and the stored name and updatedAt are unchanged`

- [x] **TI08** Publishing moves a draft Conference to published only when the schedule gate reports at least one Session
  - Defines the schedule-gate port (`hasAtLeastOneSession(conferenceId)`); its production binding returns `false` until S04 supplies the real Session count. Refusal message explains that a schedule with at least one Session is required. Depends on TI02, TI04.
  - **Verify**: `Test: with the gate reporting zero the publish is refused and the Conference stays draft with a message about needing a Session; with the gate stubbed to report one the Conference becomes published; two Conferences can be published concurrently – nothing enforces a single active Conference`

- [x] **TI09** Archiving moves a published Conference to archived only after its end date
  - Refuses a draft Conference whatever the date, and refuses a published Conference on or before its end date with the earliest permitted date stated. Comparison against the server's current calendar date in the stored naive frame. Depends on TI02, TI04.
  - **Verify**: `Test: with today 2026-09-15 archiving a Conference ending 2026-09-16 is refused stating 2026-09-17; archiving a draft is refused; with today 2026-09-17 the published Conference becomes archived`

- [x] **TI10** The editability and joinability guards are exported for S05 and S09 to consume
  - Public, documented entry points on TI02's module so S05's join endpoint and S09's edit path assert refusal against the same rule rather than re-deriving it. The exported joinability guard carries the **whole** definition – state `published` and end date not in the past – so S05 consumes or extends it and never restates the end-date rule. Two implementations of one invariant is precisely what S07's retrofit exists to prevent.
  - **Verify**: `Test: the guards are importable from outside the lifecycle module; the joinability guard reports not-joinable for an archived Conference, for a draft, and for a published Conference past its end date, and joinable for a published Conference within its span; the editability guard reports not-editable for an archived Conference`

- [x] **TI11** Organizer surfaces cover the Conference list, creation and lifecycle actions with refusals shown
  - List distinguishes archived Conferences visually from active ones (not by text alone); create form renders TI03's field-level messages inline; detail view offers publish and archive and renders the server's refusal message verbatim. The UI may disable an affordance but never substitutes for the server guard. Depends on TI05–TI09.
  - **Verify**: `Test: an archived Conference is rendered with its distinguishing treatment in the list; a 5-day span submission shows the permitted-range message on the date field; a refused publish shows the server's message rather than a generic error`

- [x] **TI12** The organizer surfaces are responsive across the three target widths
  - Per the binding NFR row and `AGENTS.md` → Visual Validation Workflow. Depends on TI11.
  - **Verify**: `Screenshots of the Conference list, create form and detail view at 375px, 768px and 1280px show no horizontal scroll and legible controls at each width`

### Testing Strategy

- The publish success path is proven with the schedule-gate port stubbed; only the refusal path is proven against the production binding until S04 lands. Tag: `[TI08]`.
- Date handling needs an explicit no-coercion assertion across the database → API → client boundary, not just an equality check inside one layer, since a timezone shift only appears at a boundary. Tag: `[TI01]`.
- `updated_at`'s negative guarantee – that a Session write never advances it – cannot be proven here because no Session table exists yet. Prove the positive half now (a Conference edit advances it, an archived-refusal does not) and leave the negative half to S04, which owns the watermark trigger. Tags: `[TI01,TI06,TI07]`.

### Execution Contract

- TI04 must complete before TI05–TI09: those handlers are required to call the helper rather than grow their own checks, which is what makes S07 a single replacement.
- TI08 leaves a binding obligation on S04: bind the real Session count to the schedule-gate port and re-run S03's publish scenario end to end.
- TI01 leaves a binding obligation on S04: add `schedule_watermark_at` as a **separate** column and guarantee its trigger leaves `updated_at` untouched.
- TI01/TI05 leave a binding obligation on S05 and S08: the Membership table is created here, so S05 inserts into it rather than creating it, and S08 revokes rows from it including the creator's once a second Admin exists.
- TI02/TI10 leave a binding obligation on S05: consume the exported joinability predicate; do not restate the state-plus-end-date rule at the join endpoint.


## Implementation Observations

> _Managed by exec-spec post-implementation – append-only. Spec authors: leave this section empty._

_No observations recorded yet._
