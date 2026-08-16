# S08: Membership Management

**Plan**: docs/specs/conference-setup-and-schedule/plan.json
**Story-ID**: S08

## Feature Overview and Goal

**Intent**: Joining a Conference must be reversible – an employee who joined the wrong one, or who is no longer part of it, gets out (or is taken out) cleanly, without erasing what they contributed while they were in.

**Expected Outcomes**:

- [OC01] An Attendee can end their own Membership, but only after an explicit confirmation, so a mis-tap during a Session never removes them.
- [OC02] An Admin of a Conference can remove any of its members; nobody else can, and the last-Admin rule keeps a Conference from being left without an Admin.
- [OC03] Once a Membership ends, access to that Conference's Schedule stops at the user's next request, and they may re-join with the code unless the Conference is archived.
- [OC04] Ending a Membership removes only the Membership and the standing it granted – every historical record of what the user did in the Conference survives.


## Required Context

- `docs/specs/conference-setup-and-schedule/prd.md#fr6-conference-membership-management` – the feature contract: the six acceptance criteria, the validation rules (only an Admin of *that* Conference may remove another user; membership cannot be changed on an archived Conference), and the two error-handling rules (last Admin refused with an explanation; removing a non-member is a no-op, not an error).
- `docs/specs/conference-setup-and-schedule/prd.md#edge-cases` – four rows govern this story: "Attendee leaves, then re-enters the join code" (re-joins normally, **no trace of having left**), "Admin removes an attendee who is mid-session" (**access ends at the next request; no live eviction**), "Last Admin tries to leave the conference" (refused), and "Last Admin removes their own Admin role" (refused).
- `docs/specs/conference-setup-and-schedule/s03-conference-lifecycle.md#implementation-tasks` – **the membership model this story revokes against**. S03 owns the Membership table (TI01) and its create path seeds **both** a Membership and an Admin Role Assignment for the Conference's creator in one transaction (TI05). Membership therefore means "is in this conference" for every role without exception – no role holder exists without a Membership row. That is what makes "revoke a member" and "removing a non-member is a no-op" two disjoint cases rather than two rules competing over the creator.
- `docs/specs/conference-setup-and-schedule/prd.md#fr5-per-conference-role-assignment` – **binding constraint**: the roles are Admin, Presenter/Facilitator (**one** role, not two) and Attendee, each scoped to the Conference it was granted in and keyed on the user's stable `sub` claim, never email. This story revokes standing; it does not model roles.
- `docs/specs/conference-setup-and-schedule/prd.md#constraints` – **binding constraint**: roles are confApp's own per-conference data and are never derived from directory groups (ADR-002) – so removal is a confApp write, never a directory operation.
- `docs/specs/conference-setup-and-schedule/prd.md#fr8-offline-schedule-access` – **binding constraint**: offline scope is read-only – no schedule editing, joining, **or leaving** offline; cached data is cleared on sign-out and when a different user signs in on the same device.
- `docs/specs/conference-setup-and-schedule/prd.md#non-functional-requirements` – **binding constraints**: the `hd` claim is verified server-side on every request (ADR-002); plain PostgreSQL only, no provider-specific extensions (ADR-003); responsive behaviour verified at 375px / 768px / 1280px per `AGENTS.md`.
- `docs/specs/conference-setup-and-schedule/plan.json#sharedDecisions` – three decisions bind this story unchanged: S01's route and error-envelope conventions (every refusal carries a displayable message *and* a machine code), S02's authenticated-caller context (validated `sub`, verified `hd`), and the per-conference authorization primitive – every check here goes through the `requireConferenceRole` helper, never an inline comparison.
- `AGENTS.md#do-not--never` – the prohibitions this story is most exposed to: never key a user on their email address, never rely on in-process state between requests, never derive confApp roles from directory groups.
- `docs/UBIQUITOUS_LANGUAGE.md#roles` – Admin (also *Organizer*) and Attendee as used here; Presenter/Facilitator is one role, not two.


## Deeper Context

- `docs/specs/conference-setup-and-schedule/s05-join-code-access.md` – the Membership record this story revokes (links the caller's validated `sub` to a Conference; S05's join endpoint writes Attendee rows into the table S03 created) and the join path a departed user re-enters; its joinability guard already refuses archived and ended Conferences, so re-join needs no new rule here.
- `docs/specs/conference-setup-and-schedule/s03-conference-lifecycle.md` – `requireConferenceRole(caller, conferenceId, required, options?)` (Constraints & Gotchas) and TI10's exported editability/joinability guards, which this story consumes for the archived-Conference refusal rather than re-deriving it.
- `docs/adrs/ADR-004-containerized-api-and-spa.md#decision` – **accepted 2026-08-16, supersedes serverless-on-Azure.** The API is a long-running HTTP server in a container, not Azure Functions. Handlers still hold no state between requests; the reason is now horizontal scaling across replicas. Read before assuming any server-side "pending confirmation" could be held anywhere but the database.
- `docs/specs/conference-setup-and-schedule/plan.json#stories` – S07's scope owns the last-Admin rule and the canonical per-conference role check; this story consumes both and re-implements neither. S07's FIS lands at `docs/specs/conference-setup-and-schedule/s07-per-conference-roles.md`.
- `docs/guidelines/CRITICAL-RULES-AND-GUARDRAILS.md#scope-discipline` – this story sits between S05 (joining) and S07 (roles) and must not reach into either.


## Acceptance Scenarios

- [ ] **S01 [OC01,OC03] [TI01,TI04,TI06,TI08] An Attendee leaves after confirming, and access ends at the next request**
  - **Given** Nadia is an Attendee of the published Conference "Kickoff 2026", which is running today
  - **When** Nadia taps Leave and then confirms in the confirmation step
  - **Then** her Membership for "Kickoff 2026" no longer exists
  - **And** her next request for that Conference's Schedule is refused as not a member, through the shared error envelope – no signed-in session is terminated and no connection is torn down

- [ ] **S02 [OC01] [TI08] A leave that is not confirmed revokes nothing**
  - **Given** Nadia is an Attendee of "Kickoff 2026" and is sitting in a Session
  - **When** she taps Leave and then dismisses or cancels the confirmation
  - **Then** no revocation request reaches the server and her Membership is intact
  - **And** the destructive action is reachable only through that second, explicit confirming act – a single tap on Leave never revokes

- [ ] **S03 [OC02] [TI05] Only an Admin of that Conference can remove a member, and removing a non-member succeeds as a no-op**
  - **Given** Priya is an Admin of "Kickoff 2026"; Ola is an Attendee of it; Björn is an Attendee of it holding no Admin role; and Ida is an Admin of a *different* Conference, "Retro 2026", and not a member of "Kickoff 2026"
  - **When** Priya removes Ola, then Björn attempts to remove another Attendee, then Ida attempts to remove another Attendee
  - **Then** Ola's Membership is gone; Björn's and Ida's attempts are both refused as unauthorized through the shared error envelope and no Membership changes
  - **And** when Priya then issues the same removal for Ola a second time – he now holds neither a Membership nor any Role Assignment for "Kickoff 2026" – the request succeeds as a no-op rather than returning an error, and nothing is deleted

- [ ] **S04 [OC02] [TI02,TI04,TI05] The last Admin can neither leave nor be removed, and can leave once a second Admin exists**
  - **Given** Priya created "Kickoff 2026" and is therefore both its only Admin and a member of it (S03 seeds a Membership alongside the Admin Role Assignment), and it also has 40 Attendees
  - **When** Priya attempts to leave, and separately another caller attempts to remove her
  - **Then** both are refused with a user-facing message explaining that another Admin must be appointed first, and Priya still holds both her Membership and her Admin Role Assignment
  - **And** once Björn is granted Admin, Priya's leave succeeds and removes her Membership together with her Admin Role Assignment, leaving "Kickoff 2026" with one Admin
  - **And** when two Admins attempt to leave at the same moment, exactly one succeeds and the Conference is never left without an Admin

- [ ] **S05 [OC04] [TI01,TI07] Ending a Membership deletes the Membership and that Conference's standing, and nothing else**
  - **Given** Nadia is a member of both "Kickoff 2026" and "Retro 2026", holds a Presenter/Facilitator role in "Kickoff 2026", and rows recorded against her `sub` for "Kickoff 2026" exist from what she did there
  - **When** an Admin of "Kickoff 2026" removes her
  - **Then** exactly two things are gone: her Membership of "Kickoff 2026" and her role standing in "Kickoff 2026"
  - **And** her user record, her Membership and role in "Retro 2026", and every row recording what she did in "Kickoff 2026" are all still present and unmodified – the deletion cascades to nothing

- [ ] **S06 [OC03] [TI01,TI04] A user who left re-joins with the code and no trace of having left remains**
  - **Given** Nadia left "Kickoff 2026" yesterday and it is still published and running
  - **When** she enters the join code `K7RM4P` again
  - **Then** she becomes an Attendee again exactly as a first-time joiner would, and nothing in what she is shown or in what the API returns records that she previously left

- [ ] **S07 [OC02,OC03] [TI03] An archived Conference refuses every membership change**
  - **Given** "Retro 2025" is archived, Nadia is a member of it and Ida is its Admin
  - **When** Nadia confirms leaving it, and separately Ida attempts to remove Nadia from it
  - **Then** both are refused with a message naming the archived state, both Memberships are unchanged, and the archived Conference remains readable to its members


## Structural Criteria

- [ ] Revoking a Membership deletes exactly that Membership row and that user's role standing for that Conference – no foreign key from the user or the Membership is declared with a delete rule that would remove any other row.
- [ ] Every authorization decision in this story's handlers resolves through `requireConferenceRole`; no membership endpoint contains an inline role or creator comparison.
- [ ] The last-Admin rule is consumed from S07's implementation and is not re-implemented, duplicated, or approximated here.
- [ ] The last-Admin check and the revocation write happen inside one transaction on both the leave and the remove path – no read-then-write pair exists in which two concurrent revocations could each observe a second Admin.
- [ ] Every refusal in this story is emitted through the shared JSON error envelope with a user-facing message and a distinct machine code – no endpoint-local error shape.
- [ ] Every endpoint in this story runs behind S02's authenticated-caller wrapper, so the `hd` claim is verified server-side on every request.
- [ ] No live-eviction machinery is introduced – no session invalidation, no push, no connection teardown; access is re-derived from membership on each request.
- [ ] Leaving is unavailable offline: no revocation is queued, optimistically applied, or synced later; the offline surface stays read-only.
- [ ] Schema changes, if any, use plain PostgreSQL only – no provider-specific extension (ADR-003).
- [ ] The leave confirmation and the Admin member list are legible with no horizontal body scroll at 375px, 768px and 1280px.


## Scope & Boundaries

### Work Areas

- Membership revocation service – the single write path shared by self-leave and Admin removal.
- Leave endpoint (caller revokes their own Membership) and Admin remove endpoint (caller revokes a named member's).
- Migration/schema delete rules on the user and Membership tables – the no-cascade guarantee.
- Conference access resolution on Schedule reads, so a revoked member is refused at their next request.
- Attendee leave UI with its confirmation step, and the Admin member list with its remove control.

### What We're NOT Doing

- Joining itself and the join code -- S05 owns Membership creation; the re-join path in S06 is exercised through S05's existing endpoint, unchanged.
- Role assignment, revocation and the last-Admin rule's implementation -- S07 owns them; this story calls the rule and clears standing as a consequence of revocation.
- Live eviction of a member who is mid-session -- explicitly excluded by the PRD edge case; access ends at the next request.
- Offline or queued leaving -- FR8 pins offline scope to read-only; a queued revocation would be sync behaviour, a product anti-goal.
- Any audit trail, tombstone or "previously left" marker -- the edge case requires re-joining to leave no trace, so the Membership is removed rather than soft-marked.


## Architecture Decision

**Approach**: One revocation service, called by both the self-leave and the Admin-remove endpoint, deletes the Membership and the user's role standing for that one Conference in a single transaction; access is re-derived from membership on every request, so nothing needs to be evicted.
**Why this over alternatives**: Per-request authorization already gives the PRD's "access ends at the next request" for free, whereas a live-eviction channel is new infrastructure for a guarantee the PRD explicitly declines; and a soft-delete marker would contradict the edge case requiring no trace of having left after a re-join.


## Technical Overview

Two endpoints, one write path. The leave endpoint targets the caller's own validated `sub`; the Admin remove endpoint targets a named member and asserts `Admin` for that Conference through `requireConferenceRole`. Both then run the same two guards in the same order – S03's archived-Conference guard, then S07's last-Admin rule – and both call the one revocation operation, which deletes the Membership row and that user's Role Assignment rows for that Conference in a single transaction. Because S03 seeds a Membership alongside the creator's Admin Role Assignment, "is in this conference" is one uniform fact: every role holder has a Membership, so revocation always has exactly one shape and a target with no Membership has no role standing either – which is why the non-member case is a genuine no-op rather than a hidden Admin revocation. The last-Admin count and the delete share that transaction, so two Admins leaving simultaneously cannot both pass. Nothing else changes: access is re-derived from Membership on every request, so a revoked member is refused at their next Schedule read with no eviction machinery, and the leave confirmation lives entirely in the client because the API is a horizontally replicated container (ADR-004) with nowhere to keep a pending server-side step.


## Code Patterns & External References

```
# type | path#anchor or url                                                          | why needed (intent)
fis    | docs/specs/conference-setup-and-schedule/s03-conference-lifecycle.md         | Membership table + creator seed (Membership AND Admin role), requireConferenceRole signature, exported archived-state guards
fis    | docs/specs/conference-setup-and-schedule/s07-per-conference-roles.md         | TI07 – the last-Admin rule exported for this story, already transactional and row-locked
fis    | docs/specs/conference-setup-and-schedule/s05-join-code-access.md             | Membership shape, sub-keyed identity, and the re-join path this story feeds back into
adr    | docs/adrs/ADR-004-containerized-api-and-spa.md                               | Container API, not Functions; why no pending-confirmation state can live in the process
plan   | docs/specs/conference-setup-and-schedule/plan.json#sharedDecisions           | Error envelope, authenticated-caller context and the authorization primitive – consume, do not invent
prd    | docs/specs/conference-setup-and-schedule/prd.md#fr6-conference-membership-management | Acceptance criteria, validation and the exact refusal semantics
```


## Constraints & Gotchas

- **Critical**: revocation must not cascade -- a naive `ON DELETE CASCADE` from the user or the Membership row is the likely implementation mistake and silently destroys the historical records FR6 requires kept. Must handle by: deleting the Membership and role standing with explicit scoped statements, and asserting the database's declared delete rules rather than trusting the ORM's default.
- **Critical**: revocation must also end the user's role standing for that Conference -- otherwise a departed Admin still satisfies `requireConferenceRole` and keeps authority over a Conference they left. Must handle by: performing both deletions in one transaction so no state exists where the Membership is gone but the role remains.
- **Constraint**: Membership is universal, so revocation has exactly one shape -- S03 seeds **both** a Membership and an Admin Role Assignment for a Conference's creator (`s03-conference-lifecycle.md` TI05), so there is no role holder without a Membership row and no "member by implication". Workaround: treat the Membership row as the single test of "is in this conference" on both the leave and the remove path; never special-case the creator, and never infer membership from a Role Assignment. This is what keeps the revocation rule and the non-member no-op from overlapping on the same user.
- **Constraint**: the last-Admin rule lives in S07 -- Workaround: call it from both the leave and the remove path; a second copy here will drift from S07's self-demotion path, which enforces the same invariant on role changes. S07's rule is already evaluated inside the write transaction with the Admin rows locked (`s07-per-conference-roles.md` TI07) – call it inside this story's revocation transaction so that property is inherited rather than re-created.
- **Avoid**: treating a removal of a non-member as an error -- Instead: the endpoint is idempotent; a repeated or mistaken removal returns success, per FR6's Error Handling. "Not a member" means **no Membership row**, which under the seeded model also means no Role Assignment for that Conference – so the no-op path deletes nothing and can never silently strip an Admin's standing.
- **Avoid**: making the leave button destructive on first tap, or confirming only with a toast/undo -- Instead: a distinct confirming act precedes the request. The PRD's stated reason is a mis-tap during a Session, so an undo window that expires unattended does not satisfy it.
- **Assumption (recorded, PRD says only "membership and access")**: "role standing" means the user's Role Assignment rows for that Conference. Clearing them is not defensive tidying – without it a removed Admin still satisfies `requireConferenceRole` and keeps authority over a Conference they are no longer in. The invariant is that nothing granting authority over the Conference survives the revocation.
- **Assumption (recorded)**: the confirmation is a client-side two-step; the server exposes one revocation call and models no pending state. Under ADR-004 the API is a long-running container that scales horizontally across replicas, so a "pending confirmation" held in the process would be per-replica and would not survive the second request – the standing no-in-process-state rule (`AGENTS.md`) is unchanged, only its reason is.


## Implementation Plan

### Implementation Tasks

- [ ] **TI01** A single revocation operation ends one user's Membership of one Conference and nothing else
  - Deletes the Membership row and that user's Role Assignment rows for that Conference in one transaction, keyed on the user's `sub` from S02's caller context – never on email. Both deletions are required: S03 seeds a Membership alongside every creator's Admin Role Assignment, so a role holder always has a Membership and revoking one without the other would leave standing behind. Explicit scoped deletes only; no cascade from the user or Membership row. Plain PostgreSQL (ADR-003). TI04 and TI05 both call this and duplicate none of it.
  - **Verify**: `Test: after revoking one user's Membership, that user's Memberships and roles in other Conferences, their user record, and rows recorded against their sub for the revoked Conference all still exist; only the Membership and the Role Assignments for that Conference are gone; revoking a Conference creator removes their seeded Membership and their Admin Role Assignment together, leaving neither behind`

- [ ] **TI02** The last Admin of a Conference can neither leave nor be removed
  - Consumes S07's last-Admin rule (`s07-per-conference-roles.md` → TI07), which already counts remaining Admins with the rows locked; does not re-implement or approximate it. The check is evaluated **inside** TI01's revocation transaction rather than by the endpoints beforehand, so a check-then-revoke pair cannot let two concurrent departures both observe a second Admin. The refusal carries a user-facing message explaining that another Admin must be appointed first, through S01's envelope, and reaches TI04 and TI05 unchanged.
  - **Verify**: `Test: with exactly one Admin, that Admin's leave and a removal targeting them are both refused with a message about appointing another Admin, and their Membership and Admin Role Assignment are both unchanged; with two Admins either may leave; two concurrent leaves by the only two Admins result in exactly one success and one refusal, and the Conference still has an Admin; this story's modules contain no Admin-count query of their own – the rule resolves to S07's single implementation`

- [ ] **TI03** Membership cannot be changed on an archived Conference
  - Uses the editability guard S03 exported (`s03-conference-lifecycle.md` → TI10) rather than re-testing the lifecycle state; the refusal names the archived state. TI04 and TI05 both apply it before entering TI01's transaction, since an archived Conference is refused whatever the Admin count.
  - **Verify**: `Test: a leave and an Admin removal against an archived Conference are each refused with a message naming the archived state, both Memberships persist, and the archived Conference stays readable to its members`

- [ ] **TI04** An Attendee can end their own Membership through a leave endpoint
  - Revokes only the caller's own Membership – the target is the caller's validated `sub`, never a value the client supplies. Applies TI03's archived guard, then calls TI01, which enforces TI02's last-Admin check inside its own transaction.
  - **Verify**: `Test: a member's leave removes their own Membership and returns success; a request attempting to leave on another user's behalf cannot revoke that user's Membership`

- [ ] **TI05** An Admin of a Conference can remove any of its members, and removing a non-member is a no-op
  - Authorization goes through `requireConferenceRole(caller, conferenceId, 'Admin')` from S03 – no inline role comparison. A caller who is an Admin of a *different* Conference is not an Admin here. When the target holds no Membership for the Conference they are not in it at all – under S03's seeded model that also means no Role Assignment – so the request succeeds without change rather than erroring, and deletes nothing. Applies TI03's archived guard, then calls TI01, which enforces TI02's last-Admin check inside its own transaction.
  - **Verify**: `Test: an Admin of the Conference removes a member; a non-Admin member, a non-member, and an Admin of another Conference are each refused through the shared error envelope with no state change; an unauthenticated or wrong-domain caller is refused by S02's wrapper before handler code runs; removing a user who holds no Membership returns success while the Membership and Role Assignment tables have no row added, removed or modified; the membership handlers contain no role check that bypasses requireConferenceRole`

- [ ] **TI06** A revoked user's next request for that Conference is refused, with no eviction machinery
  - Conference-scoped reads – the Schedule above all – resolve membership per request from stored state, so revocation takes effect on the next call with no in-flight interruption. No session invalidation, push, or connection teardown is introduced.
  - **Verify**: `Test: a user whose Membership was just revoked mid-session is refused on their next Schedule request while their sign-in remains valid, and their other Conferences still load`

- [ ] **TI07** The database's declared delete rules cannot remove historical records when a Membership ends
  - Assert on the schema itself, not only on today's tables: no foreign key referencing the user or the Membership carries a cascading delete rule. Records of what a user did in a Conference are keyed on the user and the Conference, so the Membership is never their parent row.
  - **Verify**: `Test: a query of the database catalog finds no foreign-key constraint referencing the user or Membership table with a cascade delete rule`

- [ ] **TI08** The leave and remove surfaces make the destructive step explicit and work at all three widths
  - Leave requires a distinct confirming act naming the Conference before any request is sent, and the affordance is unavailable while offline (FR8 – no leaving offline, nothing queued). The Admin member list shows the Conference's members with a remove control and renders the server's refusal message verbatim; the UI may disable an affordance but never substitutes for the server guard. Depends on TI04 and TI05.
  - **Verify**: `Test: cancelling the confirmation issues no request and leaves the Membership intact; the leave action is unavailable offline and queues nothing. Screenshots at 375px, 768px and 1280px show the confirmation and the member list fully visible with no horizontal body scroll`

### Testing Strategy

- The last-Admin rule needs a genuinely **concurrent** test at this story's call sites, not only S07's: two Admins issuing leave simultaneously, and an Admin leaving while another Admin is being removed, must yield exactly one success and never leave the Conference without an Admin. A sequential test passes against a read-then-write implementation that fails in production, and this story invokes the rule from two paths S07 never exercised. Tag: `[TI02,TI04,TI05]`.
- Revocation's atomicity needs an assertion that no intermediate state is observable – no committed state in which the Membership is gone but a Role Assignment for that Conference survives, or the reverse. Force a failure between the two deletes and assert both rows are still present. Tag: `[TI01]`.
- TI07's no-cascade assertion queries the **database catalog**, not today's rows: a behavioural test only proves the rows that happen to exist survived, while a catalog query also fails when a future table is added under a cascading rule. Tag: `[TI07]`.
- The non-member no-op asserts *absence of writes*, not merely a success status – compare the Membership and Role Assignment tables before and after, since a handler that deletes zero rows and one that deletes the wrong rows both return success. Tag: `[TI05]`.

### Execution Contract

- Requires S05 (join path) and S07 (canonical role check and the last-Admin rule) to have landed, with S03 (the Membership table and the creator's seeded Membership **and** Admin Role Assignment) beneath both – TI01 has nothing to revoke and TI02 has no rule to call otherwise.
- Tasks are in build order: TI01 (the revocation operation), then TI02 and TI03 (the two guards both endpoints apply), then TI04 and TI05 (the endpoints composing them). No task depends on a later one.


## Implementation Observations

> _Managed by exec-spec post-implementation – append-only._

_No observations recorded yet._
