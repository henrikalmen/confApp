# S07: Per-Conference Roles

**Plan**: docs/specs/conference-setup-and-schedule/plan.json
**Story-ID**: S07

## Feature Overview and Goal

**Intent**: Until now every endpoint has leaned on a provisional "the creator is the Admin" stand-in, so confApp cannot yet express the thing the product is actually built around – the same employee facilitating one workshop, administering a different conference, and merely attending the rest – and this story makes that the server's enforced answer rather than a placeholder.

**Expected Outcomes** (scenarios anchor to these via `[OC<NN>]`):

- [OC01] Roles are confApp's own per-Conference data keyed on the user's `sub`: an Admin grants and revokes Admin or Presenter/Facilitator for members of their own Conference only, and the same employee holds different roles in different Conferences without one affecting the other.
- [OC02] Presenter/Facilitator is one role whose authority is exactly the Sessions assigned to it – its holder edits those Sessions and is refused on every other surface, including the Conference itself and Sessions it was not assigned.
- [OC03] Every protected endpoint introduced by S03, S04 and S05 refuses an under-privileged caller through one canonical role check, while creating a Conference stays open to any authenticated employee with no instance-level permission consulted.
- [OC04] A role change that would leave the Conference without an Admin, that targets an employee who has never signed in, or that touches an archived Conference is refused with a displayable reason naming it.


## Required Context

- `docs/specs/conference-setup-and-schedule/prd.md#fr5-per-conference-role-assignment` – the feature contract this story implements: the three roles and the **binding constraint** that Presenter/Facilitator is *one* role, not two, and that assignment is keyed on the stable `sub` claim, not email; also the per-conference scoping rule, the Session-scoped authority of a Presenter/Facilitator, creation being open to any authenticated employee, the last-Admin rule, and the two named refusals. Read it; do not restate it.
- `docs/specs/conference-setup-and-schedule/prd.md#data-requirements` – the **Role Assignment** (user, conference, role – scoped per conference, never derived from a directory), **Session Assignment** (links a Presenter/Facilitator role assignment to the Sessions they may run and edit) and **Membership** (links a user's `sub` to a conference) shapes this story reads and writes. **The Membership table is created by S03's migration**, which also seeds a Membership *and* an Admin Role Assignment for the Conference's creator in one transaction; S05's join endpoint writes further rows into it. Membership therefore means "is in this Conference" for **every** role, creator included – this story reads it and never writes it.
- `docs/specs/conference-setup-and-schedule/prd.md#constraints` – **binding constraint**: "Roles are confApp's own per-conference data and are never derived from directory groups (ADR-002)." Also: attendee identity is the `sub` claim and email is display data only.
- `docs/specs/conference-setup-and-schedule/prd.md#non-functional-requirements` – **binding constraints**: `hd` claim verified server-side on every request (ADR-002); plain PostgreSQL only, no provider-specific extensions (ADR-003); responsive behaviour verified at 375px / 768px / 1280px per `AGENTS.md`.
- `docs/specs/conference-setup-and-schedule/plan.json#sharedDecisions` – three decisions bind this story. *Per-conference authorization primitive*: **S07 owns the canonical check** and generalizes the one provisional helper S03 produced – it replaces a body, not a pattern of scattered conditionals. *Authenticated caller context*: the verified `sub`/`hd` arrive from S02's wrapper unchanged. *API route, handler and error envelope conventions*: every refusal here emits S01's envelope with a displayable message and a machine code.
- `docs/specs/conference-setup-and-schedule/s03-conference-lifecycle.md#constraints--gotchas` – the exact provisional helper this story generalizes: `requireConferenceRole(caller, conferenceId, required, options?)` with `required` one of `Admin | PresenterFacilitator | Attendee` and `options.sessionId` **currently accepted and ignored**. S07 gives `options.sessionId` meaning without changing the signature or the call sites.
- `docs/adrs/ADR-002-authenticate-with-google-workspace-oidc.md#decision` – why the user key is `sub` and, explicitly, why roles are confApp data assigned per conference and **not** derived from directory group membership; the "Roles from Google Groups" alternative and why it was rejected.
- `docs/UBIQUITOUS_LANGUAGE.md#roles` – canonical role names and the listed synonyms to avoid, including "Presenter" or "Facilitator" used *as if they were separate roles*. Use `Admin`, `PresenterFacilitator`, `Attendee` in code, API fields and UI copy.
- `AGENTS.md#do-not--never` – the standing prohibitions this story is most exposed to: never derive confApp roles from directory groups, never key a user on their email address, never rely on in-process state between requests.


## Deeper Context

- `docs/specs/conference-setup-and-schedule/s03-conference-lifecycle.md#implementation-tasks` – `TI01` creates the Membership and Role Assignment tables; `TI05` seeds the creator's Membership **and** Admin Role Assignment atomically, which is why the creator is a normal member of their own Conference here rather than a special case.
- `docs/specs/conference-setup-and-schedule/s04-schedule-composition.md#what-were-not-doing` – S04 deliberately introduced **no** Session Assignment table, column or endpoint; that seam is this story's to fill, and the Session write endpoints from S04 `TI03` are the retrofit surface.
- `docs/specs/conference-setup-and-schedule/s05-join-code-access.md#implementation-tasks` – `TI04` writes Attendee Membership rows into the table S03 created; `TI07`/`TI08` are Admin-only endpoints this story retrofits with a declared role requirement.
- `docs/adrs/ADR-004-containerized-api-and-spa.md#decision` – **accepted 2026-08-16, supersedes serverless on Azure.** The API is a long-running HTTP server in a container written against a plain HTTP framework; nothing here is written against the Azure Functions programming model. The "handlers hold no state between requests" rule survives unchanged – the reason is now horizontal scaling across replicas rather than transient Function instances, which is exactly why the role check may cache nothing in process.
- `docs/guidelines/CRITICAL-RULES-AND-GUARDRAILS.md#scope-discipline` – this story edits three earlier stories' handler modules; changes there must be the declared role requirement and nothing else.


## Acceptance Scenarios

- [x] **S01 [OC01] [TI01,TI02,TI05,TI11] A role granted in one Conference has no effect in another**
  - **Given** Priya is an Admin of "Kickoff 2026" and Björn is a member of it holding no role beyond his Membership, while Björn is separately an Admin of "Retro 2027"
  - **When** Priya grants Björn the Presenter/Facilitator role in "Kickoff 2026"
  - **Then** Björn holds Presenter/Facilitator in "Kickoff 2026" only, keyed on his `sub`, and his Admin authority in "Retro 2027" is unchanged – and Priya, who is not a member of "Retro 2027", is refused when she calls the same grant endpoint against it

- [x] **S02 [OC01,OC02] [TI01,TI09] Presenting and facilitating are the same role with the same permissions**
  - **Given** Björn holds the Presenter/Facilitator role in "Kickoff 2026" and is assigned to "Opening Keynote" (kind Presentation) and "Design Workshop" (kind Workshop)
  - **When** he edits each of the two Sessions
  - **Then** both succeed under the identical role value – no separate `Presenter` and `Facilitator` roles are representable in the API, the role type, or the database check constraint, and the Session's kind plays no part in the authorization decision

- [x] **S03 [OC02] [TI03,TI09,TI10] A Presenter/Facilitator edits only the Sessions assigned to them**
  - **Given** Björn holds Presenter/Facilitator in "Kickoff 2026" and is assigned to "Opening Keynote" but not to "Design Workshop"
  - **When** he edits "Opening Keynote", then edits "Design Workshop", then renames the Conference, then grants a role to another member – calling each endpoint directly rather than through the UI
  - **Then** only the "Opening Keynote" edit succeeds; the other three are refused as unauthorized through the canonical check with nothing persisted, and an Admin of "Kickoff 2026" succeeds at all four without holding any Session Assignment

- [x] **S04 [OC03] [TI02,TI04] Every Admin-only endpoint from S03, S04 and S05 refuses a mere Attendee**
  - **Given** Nadia is an Attendee of the published Conference "Kickoff 2026" with no other role
  - **When** she calls each protected endpoint those stories introduced – update Conference details, publish, archive, create/edit/delete Session, view join code, regenerate join code – bypassing the UI
  - **Then** every one is refused through the canonical role check with S01's error envelope and no state changes, and the refusal is produced by the shared check rather than by any comparison inside the individual handler

- [x] **S05 [OC03] [TI04,TI05,TI06,TI09] Any authenticated employee creates a Conference and is its first Admin**
  - **Given** Nadia is a signed-in employee holding no role in any Conference
  - **When** she creates the Conference "Team Days 2027"
  - **Then** the creation succeeds and she holds **both** a Membership and an Admin Role Assignment in it, having consulted no instance-level, global, or cross-conference permission – there is no role row that is not scoped to a single Conference
  - **And** she appears in that Conference's own member list from the moment it exists, and is a valid target for a grant, a Session assignment and a revocation like any other member
  - **And** she still cannot administer "Kickoff 2026", where she is only an Attendee

- [x] **S06 [OC04] [TI07,TI11] The last Admin cannot be removed, including by self-demotion**
  - **Given** Priya is the only Admin of "Kickoff 2026"
  - **When** she revokes her own Admin role, and separately another Admin-level call attempts to revoke it
  - **Then** both are refused with a displayable message explaining that a Conference must always have at least one Admin, and her role is unchanged
  - **And** after Björn is granted Admin, revoking Priya's Admin succeeds and "Kickoff 2026" still has one Admin

- [x] **S07 [OC01,OC04] [TI08,TI11] An employee who has never signed in cannot be assigned, and the stored key survives an email change**
  - **Given** Priya identifies the target of a grant by typing the company email `lars@example.com`, and Lars has never signed in to confApp
  - **When** she submits the grant
  - **Then** it is refused with a message explaining that Lars must sign in at least once before he can be assigned, and no role row is written
  - **And** once Lars has signed in and been granted the role, the stored assignment carries his `sub`; changing his email address afterwards leaves his role intact and resolvable, because no row keys, joins on, or looks the assignment up by email

- [x] **S08 [OC04] [TI08] Roles cannot be changed on an archived Conference**
  - **Given** "Retro 2025" is archived and Priya is an Admin of it
  - **When** she grants a role, revokes a role, and assigns a Session to a Presenter/Facilitator in it
  - **Then** each is refused with a message naming the archived state, the existing role and Session Assignments are unchanged and still readable, and the refusal comes from the same lifecycle guard S03 exported rather than a re-derived archived check


## Structural Criteria

> Each criterion is proved by a task Verify line, not a scenario.

- [x] Exactly one implementation of `requireConferenceRole` exists, its signature is unchanged from the provisional one S03 pinned, and no handler in S03's, S04's, S05's or this story's modules contains an inline creator or role comparison – every per-Conference authorization decision is a call to it.
- [x] The role set has exactly three members – `Admin`, `PresenterFacilitator`, `Attendee` – in the TypeScript type, the API contract and the database check constraint; no `Presenter` or `Facilitator` member exists as a role anywhere in schema, code or wire format.
- [x] Role Assignment and Session Assignment rows identify the user by `sub`; no column, foreign key, unique constraint, or lookup path keys the assignment on an email address.
- [x] No authorization path reads a Google Workspace directory group, a `groups`/`hd`-derived group claim, or any external directory – the caller's role comes solely from confApp's own rows for the named Conference (ADR-002).
- [x] Every Role Assignment row is scoped to exactly one Conference; no row, wildcard value, or configuration expresses an instance-level or cross-Conference role.
- [x] Membership means "is in this Conference" for **every** role without exception, the creator included – no authorization path, member-listing query, or grant-target check treats an Admin as a member-by-implication rather than by a Membership row, and no role holder exists without one.
- [x] The role check re-reads its rows per request and holds no role, membership, or permission cache in module, global, or static scope.
- [x] Revoking a role leaves the user's Membership and every historical record intact – revocation removes an assignment only.
- [x] Migrations are reversible and use plain PostgreSQL only, with no provider-specific extensions (ADR-003).
- [x] Every refusal in this story emits through S01's JSON error envelope with a displayable message and a machine code distinct per refusal reason.
- [x] The Admin's member-and-roles surface is legible with no horizontal body scroll at 375px, 768px and 1280px.


## Scope & Boundaries

### Work Areas

- Migration: Session Assignment table, plus any Role Assignment change needed to carry the full three-role model from S03's minimal table.
- The canonical `requireConferenceRole` implementation replacing the provisional body, including effective-role resolution and the `options.sessionId` Session scope.
- Retrofit of S03, S04 and S05 protected endpoints to declare their required role through that check.
- Role management API: list members with their roles, grant, revoke, assign and unassign Sessions.
- Role-change validation: last-Admin rule, never-signed-in target, archived-Conference guard.
- Admin web surface for members, roles and Session assignments.

### What We're NOT Doing

- **Membership creation and revocation** -- S03 owns the Membership table and seeds the creator's row, S05 writes join rows into it, and S08 owns leaving and Admin removal; this story reads Membership and never writes it, and adds no migration for it. S08 consumes the last-Admin rule produced here rather than re-deriving it.
- **Any pre-publish gate on Presenter/Facilitator assignment** -- assignment may happen during the Conference (owner decision, recorded in Constraints & Gotchas). PRD User Flow 1's ordering is indicative, not a requirement, so this story adds no publish-time check that Sessions carry holders and no ordering constraint between assignment and publish.
- **Any new capability for a Presenter/Facilitator beyond editing their assigned Sessions** -- starting Voting Rounds, running Groups and the Board View belong to later themes; this story only fixes who may edit what in this one.
- **Roles for the Workshop Group level** -- Groups do not exist in this theme (`docs/UBIQUITOUS_LANGUAGE.md`); Session Assignment is the finest scope here.
- **Changing S02's authenticated caller context or S01's error envelope** -- both are consumed unchanged; this story adds no token validation and no bespoke error shape.
- **A role-change audit trail or notification to the affected employee** -- neither is in FR5; the member list showing current roles is the whole surface.


## Architecture Decision

**Approach**: One `requireConferenceRole` resolves the caller's effective role for the named Conference per request from that Conference's own rows – Role Assignment rows plus Membership, which alone satisfies `Attendee` – and grants when the caller's effective role is at or above the required one in the fixed order `Attendee < PresenterFacilitator < Admin`; `options.sessionId`, when supplied, additionally requires a Presenter/Facilitator to hold a Session Assignment for that Session, while an Admin passes it on conference-wide authority.
**Why this over alternatives**: it gives the ignored `options.sessionId` parameter its meaning without touching the signature or a single call site S03–S05 already wrote, which is exactly what the plan's shared decision bought – and expressing Session scope as a narrowing of one check, rather than as a second "session role", is what keeps Presenter/Facilitator a single role instead of quietly splitting it in the code.


## Technical Overview

Three inputs decide every request: the verified `sub` from S02's wrapper, the Conference named in the route, and the required role the handler declares. The check loads the caller's Role Assignment rows for that Conference and, if none grants enough, falls back to Membership as `Attendee`. Membership is universal: S03 seeds the creator's Membership alongside their Admin Role Assignment in one transaction (S03 TI05), and S05's join endpoint writes the rest, so every role holder – creator included – has one. That is what makes the member list this story exposes complete, and what makes "already a member" a satisfiable precondition for a grant. The check resolves nothing from process memory: the API is a long-running container that scales across replicas (ADR-004), so every request re-reads its rows. Session-scoped calls (`options.sessionId`) pass for an Admin unconditionally and for a Presenter/Facilitator only against a Session Assignment row for that Session – a Session's `kind` is never consulted. Grant, revoke and Session-assignment endpoints run the same check requiring `Admin`, then apply the three role-change rules in order: archived-Conference guard (S03's exported lifecycle predicate), target-resolvable-to-a-`sub` guard, and the last-Admin rule evaluated inside the same transaction as the write so two concurrent revocations cannot both see a second Admin. Email is accepted only as a *lookup input* for identifying the target; what is stored, compared and returned is `sub`.


## Code Patterns & External References

```
# type | path#anchor or url                                                                 | why needed (intent)
prd    | docs/specs/conference-setup-and-schedule/prd.md#fr5-per-conference-role-assignment | Acceptance criteria, validation and the two named refusals
prd    | docs/specs/conference-setup-and-schedule/prd.md#data-requirements                  | Role Assignment, Session Assignment and Membership shapes
fis    | docs/specs/conference-setup-and-schedule/s03-conference-lifecycle.md#implementation-tasks | TI01 Membership + role tables, TI02 lifecycle guards, TI04 the provisional helper this story replaces, TI05 the creator's Membership + Admin seed
fis    | docs/specs/conference-setup-and-schedule/s04-schedule-composition.md#implementation-tasks | TI03 Session write endpoints – the retrofit surface and the untouched Session Assignment seam
fis    | docs/specs/conference-setup-and-schedule/s05-join-code-access.md#implementation-tasks     | TI07/TI08 Admin-only join-code endpoints to retrofit; TI04 the Attendee Membership rows this check reads
doc    | docs/specs/conference-setup-and-schedule/plan.json#sharedDecisions                  | Helper ownership, caller context and error envelope – consume unchanged
adr    | docs/adrs/ADR-002-authenticate-with-google-workspace-oidc.md                        | Why roles are confApp data and never directory groups; why the key is `sub`
adr    | docs/adrs/ADR-004-containerized-api-and-spa.md                                      | Container API, not Functions; why the role check may hold no state between requests
```


## Constraints & Gotchas

- **Critical**: Presenter/Facilitator is **one** role, not two -- the two words describe what the holder is doing, not different permissions (`prd.md#fr5-per-conference-role-assignment`, `docs/UBIQUITOUS_LANGUAGE.md`, ADR-002). Must handle by: a single enum member, a single database check-constraint value, and no branch anywhere that reads a Session's `kind` to decide authority. A `Presenter` role and a `Facilitator` role are a defect even if their permission tables are identical.
- **Critical**: roles are never derived from Google Workspace directory groups -- a directory cannot express "facilitates one workshop, attends the rest" (ADR-002, `prd.md#constraints`). Must handle by: resolving authority only from confApp's own rows; no group claim is read, requested, or added to the OIDC scope.
- **Critical**: assignment is keyed on the stable `sub` claim, never on email -- emails change and are reissued. Must handle by: email may be a *lookup input* for choosing a target, but the resolved `sub` is what is stored and compared; an unresolvable email is the never-signed-in refusal, not an invitation to store the email as the key.
- **Constraint**: a role assignment is meaningful only inside the Conference it was granted in -- the same user legitimately holds different roles in different Conferences. Workaround: every query, unique constraint and cache key carries `conference_id`; a lookup that resolves a role for a `sub` without a Conference is a defect.
- **Avoid**: rewriting call sites in S03, S04 and S05 -- Instead: replace the helper body and add the declared `required` role (and `options.sessionId` where a Session is the subject) at the existing call sites. The plan's shared decision exists so this story is one implementation swap; a sweep of handler internals means the seam was not held and should be reported, not worked around.
- **Avoid**: re-deriving the archived-Conference check -- Instead: call the editability guard S03 exported (`s03-conference-lifecycle.md` TI02/TI10), so archived semantics stay in one place.
- **Constraint**: the last-Admin rule must survive concurrency -- two Admins revoking each other simultaneously can both observe a second Admin. Workaround: count remaining Admins and write in one transaction with the row locked, not in a read-then-write pair.
- **Assumption (recorded)**: the `Attendee` role is satisfied by a Membership row; joining does **not** additionally write an `Attendee` Role Assignment row. Roles are additive, so an Admin or Presenter/Facilitator who is also in the Conference holds both. **Membership is universal**: S03 seeds one for the creator at creation time alongside their Admin Role Assignment (S03 TI05), and S05's join endpoint writes the rest, so *every* role holder – the creator included – has a Membership. There is no member-by-implication path and no authority without a Membership. Recorded because `prd.md#data-requirements` lists Membership and Role Assignment separately without stating which carries the Attendee role.
- **Assumption (recorded)**: a grant target must already hold a Membership in the Conference, per FR5's "any member of their conference"; the never-signed-in refusal is the distinct case where the typed target resolves to no confApp user at all. This is satisfiable as written **because** Membership is universal: no role holder can exist without one, so the precondition never excludes someone who is legitimately in the Conference – including the creator, who is a normal grant, assignment and revocation target from the moment the Conference exists.
- **Owner decision (binding, recorded)**: assigning a Presenter/Facilitator to a Session is **not** required before publish – it may happen at any point during the Conference. `prd.md#user-flows` Flow 1 lists "assign presenters/facilitators" before "publish", but that ordering is **indicative, not binding**: members other than the creator only exist after publish (join codes are minted on publish, S05 TI02), so a pre-publish assignment step would be unexecutable for anyone but the creator. Must handle by: building **no** pre-publish assignment requirement and adding **no** publish-time gate on Session assignment. FR2's criterion "a session records … zero or more assigned Presenters/Facilitators" is satisfied by **zero** at publish time. Recorded so a later reader does not read Flow 1's ordering as a missing capability and retrofit a gate.


## Implementation Plan

### Implementation Tasks

- [x] **TI01** The three-role model is complete and Session Assignment links a Presenter/Facilitator to specific Sessions
  - Reversible migration on top of S03's Role Assignment table (`s03-conference-lifecycle.md` TI01), whose check constraint already carries exactly `Admin | PresenterFacilitator | Attendee` – keep it at three. Session Assignment: conference-scoped, user `sub`, session FK, unique per (session, sub), removed with its Session. Plain PostgreSQL only (ADR-003).
  - **Verify**: `Test: migration applies and rolls back cleanly; inserting a role value of 'Presenter' or 'Facilitator' is rejected by the database; a Session Assignment cannot be written twice for the same (session, sub); deleting a Session removes its assignments`

- [x] **TI02** `requireConferenceRole` resolves the caller's real effective role for the named Conference
  - Replaces the provisional body from `s03-conference-lifecycle.md` TI04 behind the unchanged signature. Effective role from that Conference's Role Assignment rows plus Membership as `Attendee`; grants at or above `required` in the order `Attendee < PresenterFacilitator < Admin`. Every role holder has a Membership (S03 TI05 seeds the creator's, S05 TI04 writes joiners'), so Membership is the universal "is in this Conference" fact rather than a special case to work around. Reads per request, caches nothing (ADR-004: replicas, not sticky requests), reads no directory group.
  - **Verify**: `Test: an Admin passes a required Attendee check; an Attendee fails a required Admin check; a caller with a role in a different Conference fails; a Conference's creator passes both a required Admin check and a required Attendee check, and holds a Membership row as well as an Admin Role Assignment; no code path grants authority to a caller holding no Membership for the Conference; refusals carry S01's envelope; the authorization path performs no directory-group lookup and reads no group claim, and holds no role or permission state in module, global or static scope between requests`

- [x] **TI03** `options.sessionId` narrows a Presenter/Facilitator to their assigned Sessions without widening an Admin
  - Gives meaning to the parameter S03 accepted and ignored. With `sessionId` supplied: an Admin of the Conference passes; a Presenter/Facilitator passes only with a Session Assignment for that Session; anyone else fails. The Session's `kind` is never read. Depends on TI01, TI02.
  - **Verify**: `Test: an assigned Presenter/Facilitator passes for their Session and fails for another Session in the same Conference; an Admin passes for both holding no Session Assignment; the same holder passes identically for a Presentation and a Workshop`

- [x] **TI04** Every protected endpoint from S03, S04 and S05 declares its required role through the canonical check
  - Conference update/publish/archive and the join-code view/regenerate endpoints require `Admin`; Session write endpoints are TI10. Conference create declares no role requirement at all (TI06). Change only the declared requirement at the existing call sites – no handler grows a comparison of its own. Depends on TI02.
  - **Verify**: `Test: an Attendee is refused at each of update details, publish, archive, view join code and regenerate join code; a repository-wide search of handler modules finds no inline creator or role comparison and exactly one implementation of the check`

- [x] **TI05** An Admin grants and revokes Admin or Presenter/Facilitator for a member of their own Conference
  - Grant and revoke endpoints plus a member list returning each member's `sub`, display name and current roles. **The member list is derived from Membership rows**, so it lists everyone in the Conference including its creator, whose Membership S03 seeded at creation. Both mutations require `Admin` for that Conference via TI02. A grant target must already hold a Membership – a precondition every role holder satisfies. Revoke deletes the Role Assignment only – Membership and every historical record survive. Depends on TI01, TI02.
  - **Verify**: `Test: a grant creates one role row scoped to that Conference keyed on sub and the member list reflects it; a revoke removes only that row and the user's Membership still exists; an Admin of a different Conference is refused; a freshly created Conference's member list contains exactly its creator, shown with the Admin role; the creator is accepted as the target of a grant and of a revoke like any other member`

- [x] **TI06** Conference creation consults no instance-level permission
  - Confirms and pins S03 TI05's behaviour under the real role model: any authenticated employee creates a Conference and is seeded with **both** a Membership and an Admin Role Assignment atomically, and no role row exists that is not scoped to a single Conference. This story adds no seeding logic of its own – it verifies S03's seed still holds once the real role model is in place. Depends on TI02.
  - **Verify**: `Test: an employee holding no role anywhere creates a Conference and holds both a Membership and an Admin Role Assignment in it, and appears in TI05's member list; the schema permits no null/wildcard conference on a role row; that employee remains unauthorized on a Conference where they are only an Attendee`

- [x] **TI07** The last Admin of a Conference cannot be removed, including by self-demotion
  - Remaining-Admin count and the delete happen in one transaction with the row locked, so concurrent revocations cannot both pass. Refusal message explains that a Conference must always have at least one Admin. Exported for S08, which applies the same rule to leaving. Depends on TI05.
  - **Verify**: `Test: revoking the sole Admin's role is refused and the row survives; the same Admin revoking their own role is refused identically; with two Admins one revocation succeeds; two concurrent revocations of two Admins leave exactly one Admin standing`

- [x] **TI08** Role changes are refused for an unresolvable target and on an archived Conference
  - Target identified by email is resolved to a confApp user's `sub`; no confApp user means refusal explaining they must sign in first, and the email is never stored as the assignment key. The archived guard calls S03's exported editability predicate (`s03-conference-lifecycle.md` TI10). Distinct machine codes per reason through S01's envelope. Depends on TI05, TI09.
  - **Verify**: `Test: granting to an email with no confApp user is refused naming the sign-in requirement and writes nothing; grant, revoke and Session assignment on an archived Conference are each refused naming the archived state; the two reasons carry different machine codes; no email value is persisted on any assignment row`

- [x] **TI09** An Admin assigns and unassigns a Presenter/Facilitator to specific Sessions of their Conference
  - A Session may carry zero or more holders and a holder may cover several Sessions. Assigning requires the target to already hold the Presenter/Facilitator role in that Conference; revoking the role removes its Session Assignments. **Assignment is not gated on lifecycle state beyond the archived guard (TI08)** – it is legal on a draft and on a published Conference alike, and publishing is never blocked by a Session having no holder (see the recorded owner decision in Constraints & Gotchas; FR2's "zero or more" is satisfied by zero). The candidate list is TI05's member list, so the creator is selectable like any other member. Depends on TI01, TI05.
  - **Verify**: `Test: assigning a holder to two Sessions yields two rows and the Session detail lists its holders; assigning someone without the role in that Conference is refused; revoking the role leaves no orphan Session Assignment; the creator of the Conference can be granted Presenter/Facilitator and assigned to a Session of it; a Conference with no Session Assignment at all publishes successfully, and a Session is assignable after publish just as before it`

- [x] **TI10** Session write endpoints authorize an Admin or the Session's assigned Presenter/Facilitator
  - The S04 create/edit/delete endpoints (`s04-schedule-composition.md` TI03) pass `options.sessionId` for edit and delete so TI03's scope applies; creating and deleting a Session require `Admin`, since neither has an assigned holder to scope to. The archived-Conference and last-Session refusals S04 established are unchanged. Depends on TI03, TI04.
  - **Verify**: `Test: an assigned Presenter/Facilitator edits their Session, is refused on an unassigned Session, and is refused on Session creation and deletion; an Admin succeeds at all four; S04's last-Session-delete and archived refusals still fire`

- [x] **TI11** The Admin's member surface shows every member's roles and Session assignments and applies changes there
  - Member list with each member's roles, controls to grant/revoke and to assign Sessions, and the server's refusal message rendered verbatim – including the last-Admin and never-signed-in messages. Affordances may be hidden but never substitute for the server guard. Depends on TI05–TI09.
  - **Verify**: `Test: the list shows a member's role change immediately after it is applied; attempting to revoke the last Admin displays the server's message rather than a generic error; a member's Session assignments are visible on their row`

- [x] **TI12** The member and roles surface is responsive across the three target widths
  - Per the binding NFR row and `AGENTS.md` → Visual Validation Workflow. Depends on TI11.
  - **Verify**: `Screenshots of the member list, the grant/revoke controls and a refusal message at 375px, 768px and 1280px show no horizontal body scroll and legible controls at each width`

### Testing Strategy

- The negative authorization tests are the point of this story, not an afterthought: every protected endpoint needs an explicit under-privileged case (`plan.json#riskSummary` → S07), and the Presenter/Facilitator-on-an-unassigned-Session case must exist for the Session write path specifically.
- The last-Admin rule needs a genuinely concurrent test (two overlapping transactions), not two sequential calls – a read-then-write implementation passes the sequential version.

### Execution Contract

- TI02 and TI03 must complete before TI04 and TI10: the retrofit is only safe once the canonical check answers correctly, and the point of the plan's shared decision is that the retrofit changes declared requirements rather than handler internals.
- If any handler in S03, S04 or S05 is found to contain an inline creator or role comparison, report it as a seam violation alongside the fix rather than silently absorbing a broader rewrite.
- TI07 exports the last-Admin rule for S08 to apply to leaving and removal; do not let S08 re-derive it.
- This story depends on S03 TI05 having seeded the creator's **Membership** alongside their Admin Role Assignment. If the landed S03 code writes only the Role Assignment, report it as an upstream defect and fix it there – do not compensate here with a member-by-implication branch in the role check or the member list, which is the exact composition break this model was corrected to remove.


## Implementation Observations

> _Managed by exec-spec post-implementation – append-only. Spec authors: leave this section empty._

### Run: 2026-08-17 21:23 UTC – discovered-requirements

#### DISCOVERED REQUIREMENTS

- **A grant target's email can resolve to more than one confApp user, and the FIS names no behaviour for it** — TI08 resolves the typed target email to a `sub` and specifies exactly two outcomes: one confApp user (proceed) or none (refuse, naming the sign-in requirement). A third outcome is reachable in the landed schema. `app_user` deliberately carries no unique index on email — `api/test/database.integration.test.ts` ("constrains app_user on sub alone, never on email") asserts that absence on purpose, because two people who have at some point shared an address must stay two rows. A row's email is refreshed only when that user next signs in, so an employee who leaves and never signs in again keeps their old address on their row while a new employee issued the same address signs in and gets a second row carrying it. An email lookup then matches two live rows. Resolving it by picking either row would key the assignment on a guess, which is precisely the "email is a lookup input, `sub` is what is stored" rule inverted. **Required behaviour**: an email matching more than one confApp user is refused through S01's envelope with a machine code distinct from both the never-signed-in refusal and the not-a-member refusal, and a displayable message saying the address matches more than one account and that the target should be picked from the member list instead; no role row is written. The refusal stays distinct from never-signed-in because the two are different situations for the Admin — one is resolved by the target signing in, the other never resolves itself and needs a different target identifier.

### Run: 2026-08-18 06:34 UTC – observations

#### NOTICED BUT NOT TOUCHING

- **A Presenter/Facilitator cannot read the composition view containing the Session they may edit** — `GET /api/conferences/:conferenceId/schedule/organizer` (`api/src/routes/sessions.ts`) still declares `Admin`, which this story left alone deliberately: TI04 names only conference update/publish/archive and the two join-code endpoints as the retrofit surface, and "any new capability for a Presenter/Facilitator beyond editing their assigned Sessions" is explicitly out of scope. The consequence is that the role's one capability is reachable through the API but has no organizer surface behind it — a holder can `PATCH` their Session but cannot list it. Worth a decision in a later story (S09 touches this view) rather than a silent widening here.
- **Pre-existing Prettier drift in four files this story did not author** — `api/test/join-code-structure.test.ts` (lines 64, 188), `api/test/join-code.test.ts`, `visual/conferences.spec.ts`, `web/src/components/JoinCodePanel.tsx` all fail `format:check` on the checkout as it stood before this run. `join-code-structure.test.ts` was edited by this story, but the drift is nowhere near the edited region and was deliberately not bundled into this diff; `npm run format` would fix all four in a separate change.
- **An S05 structural guard had to be re-stated rather than merely satisfied** — `join-code-structure.test.ts` → "adds no endpoint that revokes a membership" asserted "no DELETE route mentions a member", a proxy that held only while S05 was the newest story. S07's `DELETE …/members/:userSub/roles/:role` removes a Role Assignment and leaves the Membership standing, so the proxy reported a violation for the wrong thing. The assertion now states the rule directly — no member-scoped DELETE that fails to name a role, and no `POST /api/leave` — which still catches S08's leave/removal surface arriving early.
