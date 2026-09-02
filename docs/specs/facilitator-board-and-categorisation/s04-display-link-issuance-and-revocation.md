# S04 – Display Link Issuance and Revocation

**Plan**: docs/specs/facilitator-board-and-categorisation/plan.json
**Story-ID**: S04

## Feature Overview and Goal

**Intent**: Sorting is only a shared act if the Board is on the wall, but a room machine is hardware nobody should sign in on – so the Board needs a way out of the authenticated app that the Facilitator can hand to a projector and take back again.

**Expected Outcomes** (scenarios anchor to these via `[OC<NN>]`):

- [OC01] A holder of sorting authority issues a Display Link for one Post-it Round from their own device, reads and copies the value, and revokes it at any time. A Round holds at most one live link, so issuing again replaces the current one and revocation never names which link it means – and a Board is fully usable with no link ever issued.
- [OC02] A browser with no Workspace session, holding a live link, receives that one Board – Categories, Post-its and author names – and nothing else in the Conference. The link performs no write of any kind and reaches **no Vote data in any response it can produce**.
- [OC03] Revoked, past its Round's Session day, Conference still Draft, Round deleted, and never existed are indistinguishable to the holder: one status, one code, one message. A revoked value never resolves again, and no link outlives its conference day.
- [OC04] The projected URL reaches its own SPA entry point on the shipped serving path – built, served and cached as a distinct document that never mounts the authenticated app – so S07 renders into it without inventing a second resolution path.


## Required Context

- `docs/specs/facilitator-board-and-categorisation/prd.md#fr7-display-link-issuance-and-revocation` – the contract this FIS implements: fourteen acceptance criteria, the inputs/outputs (the value **presented for copying or opening**, plus its issued/revoked state), the three validation rules, and the three error-handling rules. Its **Binding Constraint (FR7)** binds here in full – verbatim at `plan.json#bindingConstraints`, this anchor. Read it there; do not work from a restatement.
- `docs/specs/facilitator-board-and-categorisation/prd.md#non-functional-requirements` – the rows this story is measured by. Two **Binding Constraints** bind here in full – **FR7** (time bound) and **FR8** (vote anonymity), verbatim at `plan.json#bindingConstraints`, this anchor. Also binding: unguessable ("not derivable from any Conference, Session, Round or Post-it identifier"), scoped and powerless, revocation effective within the near-live window without action on the room machine, discloses nothing about why it failed, no in-process state, plain PostgreSQL, and the standing 375 / 768 / 1280 row for the Facilitator's surface.
- `docs/specs/facilitator-board-and-categorisation/prd.md#constraints` – four constraints bind this story and are applied unnarrowed: **(FR1)** storage and in-process state, **(FR8)** the projected screen, **(FR3)** offline scope – all three verbatim at `plan.json#bindingConstraints`, this anchor; plus the two constraints that motivate the whole story – "A Display Link is a bearer credential over named Post-its … it must therefore be unguessable, revocable, read-only, and scoped to a single Round rather than public", and "No Workspace session on shared hardware". (The FR4 Discard-storage, FR3 drag-and-drop and FR5 permanent-removal Binding Constraints belong to S05, S03 and S06; nothing here touches them.)
- `docs/specs/facilitator-board-and-categorisation/prd.md#edge-cases` – five rows are this story's observable contract: a link opened after its Round is deleted (refused, disclosing nothing about whether the Round ever existed); a link revoked while the room screen is open (stops at the next poll); a link issued while the Conference is Draft (created and openable, neutral page until Published, then starts working **on its own** with no reissue); a link opened the day after its Round's Session (same neutral message as a revoked link); a link issued for a Session several days out (valid immediately, dies after that Session's day rather than on a countdown from issue).
- `docs/specs/facilitator-board-and-categorisation/prd.md#user-stories` – **US01** (project the Board to the room: read-only, with author names, without a signed-in session) and **US07** (withdraw the room screen's access; revocation stops the projected view within the near-live window and a new link can be issued immediately) are this story's acceptance rows.
- `docs/specs/facilitator-board-and-categorisation/prd.md#data-requirements` – the **Display Link** entity as the PRD defines it: "an unguessable value scoped to one Round, with issued and revoked state, and an effective validity that ends once the Round's Session `day` has passed. Never reissued once revoked. Persisted, not held in process."
- `docs/specs/facilitator-board-and-categorisation/plan.json#sharedDecisions` – two decisions. **Produced here** (consumed by S07): "The Display Link is an anonymous surface with its own SPA entry point" – this FIS settles the token, the persisted issued/revoked state, the Session-day bound, the unauthenticated resolution route, and how the projected URL reaches a distinct entry point without a Workspace session; S07 consumes all of it and adds no second resolution path. **Consumed unchanged**: "Sorting authority is Session Assignment or conference-wide Admin, resolved per request" – the issue and revoke routes reuse S02's gate over `api/src/conferences/authorization.ts`, with actor identity always taken from the credential (**Binding Constraint FR6**, `prd.md#fr6-sorting-authority`).
- `docs/adrs/ADR-005-bound-access-by-time-not-by-refusal-code.md` – the decision this story's time bound is an application of: access that cannot be signalled as ended is bounded by time instead. Cite it; do not re-derive the reasoning. Its shape here is the Session's own `day` rather than a rolling timer, which is what stops the bound firing mid-activity.
- `docs/adrs/ADR-006-vote-anonymity-holds-against-application-paths-not-database-credentials.md` – the guarantee that must be left exactly as it is. Two consequences: nothing added here may read, join to or expose Vote data, **and** the ADR's scoping (application paths, not database credentials) is what makes storing the link value readably in PostgreSQL a consistent choice rather than a new exception.
- `api/src/auth/with-auth.ts` – `ANONYMOUS_ROUTES`, `isAnonymous` and `installRouteAudit`. The anonymous allow-list is a literal so that adding to it is a visible edit to a reviewed file, and startup **refuses** on any route that is neither wrapped nor listed. The list already holds **two** entries – `GET /api/health` and `POST /api/auth/token` – so this story adds the **third**.
- `api/src/routes/health.ts` – the header comment on one of confApp's two unauthenticated routes today and why it is deliberately factless: "it must never grow domain, personal, or configuration data." (The other, `POST /api/auth/token`, is how a caller *obtains* a credential.) This story adds the first unauthenticated route **over domain content**, so that cost has to be bounded by the token and the scope rather than by the emptiness of the payload.
- `api/src/conferences/join-code.ts` – the shipped precedent for a minted value, and the contrast that matters: the Join Code documents in its own header that it is **not a security boundary** and is sized for transcribability. The Display Link is the opposite on both counts. Follow the module shape; do not follow the alphabet or the length.
- `api/src/conferences/failed-join-attempts.ts` – the shipped abuse-containment precedent, read here for why it is **not** extended to this route: it is keyed on the authenticated `sub` and never on the client address, because the venue puts ~100 employees behind one NAT egress at the moment of peak use. See *What We're NOT Doing*.
- `api/src/conferences/calendar-date.ts` – `Clock`, `systemClock.today()`, `CalendarDate`, `compareDates`, and the module note on why a bare date is never routed through `new Date(string)`. `sessions.day` is a wall-clock `date` with no timezone stored anywhere (`api/src/sessions/wall-clock-time.ts`); the PRD accepts up to a day of boundary drift rather than widening the schedule's design.
- `web/public/sw.js` – `isCacheableAsset`, `storeShell` and the fetch handler. **Every** navigation is filed under one shell key and **every** navigation is answered from it. A `/display/<token>` navigation would both overwrite the cached app shell and later be answered with the wrong document.
- `web/nginx/default.conf.template` and `web/vite.config.ts` – the two serving surfaces the projected URL has to survive: nginx's `try_files $uri $uri/ /index.html` SPA fallback, and the Vite dev server and build. The SPA has **no client-side router** (`web/src/App.tsx` carries none; `web/package.json` no routing dependency), so the entry-point mechanism is a decision this story settles, not a convention it follows.
- `docs/LEARNINGS.md#service-workers--cache-storage` – three entries bear directly on TI12: a navigate-mode cache branch caches the query string; re-keying does not shed a URL; `request.mode === 'navigate'` does not mean the response is HTML.
- `docs/LEARNINGS.md#testing` – a file-list grep is only as good as its longest omission (pair any file-list assertion with a behavioural one); a regression test written beside its fix usually passes without the fix; a structure guard sees only what its parser matches.
- `AGENTS.md` – the Do Not / Never list, in particular "Never rely on in-process state between requests", "Never attribute a vote to a voter", "Never tie the schema to a managed provider's proprietary features", "Never widen offline support beyond schedule reads and post-it queueing", and "Never ship a fixed-width or desktop-only layout".
- `docs/UBIQUITOUS_LANGUAGE.md#output` – **Display Link** is the canonical term. "Share link", "public link", "guest access" and "projector URL" are the synonyms to avoid, in code identifiers as well as in prose.


## Deeper Context

- `docs/specs/facilitator-board-and-categorisation/plan.json#sharedDecisions` → "Board read projection contract" and "Board writes advance the activity watermark; the projected view uses none of it" – S02 owns the Board read this route projects. The projected surface deliberately uses no activity watermark – it is Session-scoped and Membership-gated – so S07 polls the whole Board, and this route must carry no cursor and stay cheap to re-request.
- `api/src/routes/rounds.ts` – the module header records the authority split, the "acting identity comes from the verified credential and from nowhere else" rule, and why nothing is remembered between requests. The issue and revoke routes belong to this surface and follow the same order of steps.
- `db/migrations/20260828120000000_post-it.sql` – the migration idiom to follow: a composite foreign key that makes a cross-parent row *unwritable* rather than merely discouraged, `gen_random_uuid()` as core PostgreSQL with no extension, and an explicit written statement of what the table deliberately does **not** carry.
- `api/src/errors.ts` – the `ERROR_CODES` map, the `AppError` shape, the single error envelope, and the surrounding one-code-per-*reason* convention this story deliberately excepts.
- `docs/adrs/ADR-004-containerized-api-and-spa.md` – why nothing may be held between requests, and why the SPA is a static-file container whose serving rules are the ones in the nginx template.


## Acceptance Scenarios

- [x] **S01 [OC01] [TI01,TI02,TI03,TI08,TI13,TI14] A Facilitator issues a Display Link, reads and copies the value, and a second issue replaces it rather than adding to it**
  - **Given** Ada holds a Session Assignment on the Session running the Post-it Round "What slowed us down this quarter?", and no Display Link has ever been issued for that Round
  - **When** she issues a Display Link from her own phone, then issues a second one without revoking the first
  - **Then** her surface shows one link value at a time, presented so it can be copied or opened, alongside its issued state; the second value is different from the first; the first no longer resolves; and no request she made had to name *which* link to replace
  - **And** the Board is fully usable throughout for a Facilitator who never issues a link at all – no Board surface requires one

- [x] **S02 [OC01,OC03] [TI03,TI04,TI05,TI13] Revoking stops the room screen at its next poll, and a replacement link is available immediately**
  - **Given** a room machine has the live Display Link open and is re-reading the Board on its poll interval
  - **When** Ada revokes the link from her phone, with nobody touching the room machine
  - **Then** the room machine's next poll, within the ~5s near-live window, no longer receives the Board – the resolution response ceases and the neutral refusal takes its place (what the room machine *renders* in the Board's place is S07's, proved across all four dead-link reasons at `s07-the-projected-board-view.md#acceptance-scenarios` S04)
  - **And** Ada can issue a new link straight away, and it is a different, equally unguessable value

- [x] **S03 [OC03] [TI01,TI02,TI03,TI04] A revoked value is never reissued and never resolves again**
  - **Given** the value `v1` was issued for a Round and then revoked, and `v2` was subsequently issued and revoked in its turn
  - **When** `v1` is presented again after `v2` exists, and again after `v2` is revoked
  - **Then** `v1` is refused on every occasion, with the same neutral response as an unknown value
  - **And** no code path exists that clears `revoked_at`, and no mint can produce a value already recorded for any Round in any state – asserted against the stored rows, not against the mint alone

- [x] **S04 [OC02] [TI04,TI05,TI07,TI09] A browser with no Workspace session gets that one Board and nothing else in the Conference**
  - **Given** the Conference is Published, holds two Sessions, and the linked Round's Session also carries a second Post-it Round; the linked Board holds Categories with placed Post-its and an Uncategorised holding area
  - **When** the link is opened in a browser with no stored session and no `Authorization` header
  - **Then** the response carries that Board – its Categories in order, their Post-its, their authors' display names, and Uncategorised – and nothing about the other Round, the other Session, the Conference's Join Code, its Membership list, or its roles
  - **And** every write verb against the resolution route is refused, and no request the link can make changes anything the Board holds

- [x] **S05 [OC02] [TI07] The link reaches no Vote data, in any response it can produce**
  - **Given** the linked Round's Session also runs a Voting Round whose Poll has ballots cast against it
  - **When** the Board is read through the Display Link, in every state the route can answer in
  - **Then** no response body carries a tally, an option, a ballot, a vote count, or any field derived from one, and the resolution path reaches no vote table at any point
  - **And** the assertion is made both against the response bodies and against the modules on the path, because a file-list guard alone is only as good as its longest omission (`docs/LEARNINGS.md#testing`)

- [x] **S06 [OC03] [TI01,TI04] The link dies with its Round's Session day, not on a countdown from issue**
  - **Given** the Round's Session is on `2026-09-15`, and a link is issued on `2026-09-10`
  - **When** the link is opened on `2026-09-10`, on `2026-09-15`, and on `2026-09-16`, with the server's date pinned to each
  - **Then** it renders the Board on the 10th and on the 15th, and is refused on the 16th with the neutral message
  - **And** the decision is made against the server's own wall-clock date compared with `sessions.day` as a calendar date, never against an instant, a device clock, or an elapsed interval from issue (ADR-005)

- [x] **S07 [OC03] [TI04,TI06] Revoked, expired, Draft, deleted Round and never-existed are one indistinguishable answer**
  - **Given** five links: one revoked; one whose Session day has passed; one whose Conference is still Draft; one whose Round has been deleted; and one value that was never issued at all, plus a sixth value whose shape could not be a token
  - **When** each is opened
  - **Then** all six produce byte-identical refusals – same HTTP status, same error code, same message `This board is no longer available.`, no `details`, and no header that varies between them
  - **And** the Draft one begins rendering the Board once the Conference is Published, with no reissue and nobody touching the room machine

- [x] **S08 [OC04] [TI09,TI10,TI11,TI12,TI14] The projected URL reaches its own entry point on the shipped serving path**
  - **Given** the built web image is served by its own nginx configuration, and the same URL is opened against the Vite dev server
  - **When** `/display/<token>` is opened cold in a browser that has previously visited and cached the signed-in app
  - **Then** both serve the display document, the display bundle mounts without an auth provider and issues no sign-in request, the token is read from the path, and the Board renders for a viewer who has never signed in
  - **And** the visit neither overwrites the cached application shell nor is answered from it, and the signed-in app still launches offline afterwards

- [x] **S09 [OC01] [TI08] Issue and revoke are refused server-side without sorting authority, and the actor is the credential**
  - **Given** Bo is a Conference Member with neither a Session Assignment on the Round's Session nor conference-wide Admin
  - **When** Bo issues and then revokes a Display Link by calling the API directly rather than through controls he was never offered, including a request body naming Ada as the actor
  - **Then** both are refused at the API naming the authority required, nothing is written, and no body field influenced who was treated as acting
  - **And** an Admin without a Session Assignment succeeds on both, on conference-wide authority


## Structural Criteria

- [x] `ANONYMOUS_ROUTES` in `api/src/auth/with-auth.ts` grows by exactly one entry, carrying a written reason in the same shape as the two existing ones; every other route added by this story goes through `withAuth`; the startup route audit still refuses an unwrapped, unlisted route.
- [x] No module on the Display Link resolution path imports, queries or joins to any vote or ballot table, and no vote-derived field can appear in any response the route produces (ADR-006 unaffected).
- [x] Display Link state lives only in PostgreSQL: no module-level map, cache, counter or memoized token anywhere in the new code, and the migration uses plain PostgreSQL with no extension and no provider-proprietary feature.
- [x] The token value never reaches a log line, an error message, or a response to any caller other than a holder of sorting authority on its own Round – the same discipline `withAuth` applies to bearer tokens today.
- [x] Existing tests continue to pass, including the anonymous-surface assertion in `api/test/with-auth.test.ts` and the shell-cache assertions in `web/test/service-worker.test.ts`.
- [x] The Facilitator's issue and revoke controls hold at 375 / 768 / 1280 px with no horizontal body scroll, and the primary control is reachable one-handed at 375 px.


## Scope & Boundaries

### Work Areas
- `db/migrations/` – the `display_link` table, its composite foreign key to the Round, and the partial unique index that enforces one live link per Round.
- `api/src/rounds/display-link.ts` – minting, the canonical token shape, the resolvability predicate, and the single neutral refusal.
- `api/src/routes/rounds.ts`, a new anonymous resolution route, and the `ANONYMOUS_ROUTES` allow-list in `api/src/auth/with-auth.ts`.
- `web/display.html` and `web/src/display/` – the second SPA entry point and its bootstrap, with no auth provider.
- `web/vite.config.ts`, `web/nginx/default.conf.template`, `web/public/sw.js` – building, serving and caching the `/display/` path.
- `web/src/activities/SessionActivitiesPanel.tsx` and `web/src/api/client.ts` – the Facilitator's issue/revoke controls and the unauthenticated resolution call.

### What We're NOT Doing
- **The projected rendering of the Board itself** – layout, type scale, overflow at the ~200 Post-it / ~20 Category ceiling, and the poll loop on the room machine are S07's, and its overflow behaviour is settled at wireframing (S01). This story delivers the resolution contract and the entry point, and renders only enough to prove both.
- **Rate limiting or lockout on the anonymous resolution route** – the token is the boundary. `api/src/conferences/failed-join-attempts.ts` is `sub`-keyed precisely because the venue is one NAT egress, so an address-keyed limiter here would refuse the room it exists to serve, and the room machine legitimately re-requests the same link every few seconds.
- **Hashing the stored token** – FR7's Outputs require the live value to be re-presented to its Facilitator for copying, which a one-way hash cannot do. ADR-006 already scopes confApp's guarantees to application paths rather than database credentials, so this is consistent with the shipped position rather than a new exception to it.
- **A client-side router** – no routing dependency enters `web/package.json`. The projected surface is a separate document, which is also what keeps the auth, offline and service-worker machinery out of the bundle a room machine downloads.
- **Display Links for anything but a Post-it Round's Board** – no link for a Voting Round, a Session, or a Conference. The composite foreign key makes the other shapes unwritable rather than merely unoffered.


## Architecture Decision

**Approach**: One `display_link` row per issue, holding a 256-bit CSPRNG token minted independently of every domain identifier, with `revoked_at` and a partial unique index enforcing at most one live link per Round; resolution is a single anonymous `GET /api/display/:token` whose validity predicate is *not revoked* **and** *Conference Published* **and** *server's calendar date ≤ the Round's Session `day`*; the projected URL `/display/<token>` reaches a second Vite HTML entry that never mounts the authenticated app.
**Why this over alternatives**: A signed stateless token would still need a store to be revocable, so the store is the simpler mechanism – and it is what makes "never reissued" a property of a row that is retained rather than of a key that must be rotated.


## Code Patterns & External References

```
# type | path#anchor                                          | why needed (intent)
file   | api/src/auth/with-auth.ts#ANONYMOUS_ROUTES            | The written-reason shape a new anonymous entry must match; installRouteAudit refuses startup otherwise
file   | api/src/routes/health.ts                              | The existing anonymous route's header comment – the bound this story has to replace with token + scope
file   | api/src/conferences/join-code.ts#generateJoinCode     | Module shape for a minted value: one minter, one canonical-form statement, no state (alphabet and length deliberately NOT reused)
file   | api/src/conferences/calendar-date.ts#Clock            | today() / compareDates – the only way a calendar date is compared; injected so a test can pin the day
file   | api/src/routes/rounds.ts                              | Handler order: withAuth, then requireConferenceRole(..., { sessionId }), then the lifecycle check read fresh
file   | db/migrations/20260828120000000_post-it.sql           | Migration idiom: composite FK making a cross-parent row unwritable; explicit note of what the table deliberately omits
file   | web/public/sw.js#storeShell                           | Why every navigation is filed under one shell key – the exclusion TI12 has to add
file   | web/nginx/default.conf.template                       | try_files SPA fallback and the /api/ proxy the new location block must sit ahead of
file   | web/src/main.tsx                                      | What the display bootstrap must NOT do: no AuthProvider, no service-worker registration
```


## Constraints & Gotchas

- **Critical**: a schema `pattern`/`minLength` on the `:token` path parameter would answer a wrong-shaped value with `VALIDATION_FAILED` while a real-but-dead token answers the neutral refusal – an oracle that tells "not even a token" from "not a live token". The route must carry no shape-validating schema on that parameter, or must map every validation outcome onto the identical neutral refusal. Cross-cutting between TI05 and TI06.
- **Critical**: the token goes in the **path**, never a query string. `docs/LEARNINGS.md#service-workers--cache-storage` records that a navigate-mode cache branch caches the query string and that a `Response` keeps its own URL, which is how the OIDC `?code=…` ended up in Cache Storage; a bearer credential in a query string is the same defect with a longer life. It also keeps the value out of the places query strings are habitually logged.
- **Critical**: `web/public/sw.js` answers *every* navigation from one shell key and stores every navigation under it. Without the `/display/` exclusion (TI12) the room machine gets the signed-in app document and the employee's cached shell is replaced by the display document – two defects from one omission, and the second only shows up offline.
- **Avoid**: comparing the Session day through a `Date`. `api/src/conferences/calendar-date.ts` exists because a bare date routed through `new Date(string)` becomes UTC midnight and then reports back through local getters. Compare `CalendarDate` strings with `compareDates`, against a `Clock` that a test can pin – both TI04 and its tests depend on this.
- **Constraint**: `sessions.day` carries no timezone and none is stored anywhere in confApp. A link may therefore stay live up to about a day longer, or die up to about a day earlier, than a viewer in another timezone expects. The PRD accepts this rather than widening the schedule's design; do not introduce a timezone column, a UTC offset, or an instant to "fix" it.
- **Constraint**: the resolution response must be `Cache-Control: no-store`. Revocation "takes effect without user action on the room machine … at the next poll" (NFR) is only true if nothing between the API and the room is allowed to answer from a copy.
- **Recorded assumption**: no wireframe gates this story. The plan's wireframes shared decision lists S01, S02, S03, S05, S07 and S08 and deliberately not S04, so the issue/revoke affordance is two controls plus the value on the existing Facilitator Round surface, not a new screen. The projected view's own design is S07's.


## Implementation Plan

### Implementation Tasks

- [x] **TI01** A `display_link` table holds the token, its Round and Conference, who issued it and when, and its revoked state, with at most one live link per Round unwritable past
  - Follow `db/migrations/20260828120000000_post-it.sql` for the composite foreign key (a link naming a Round in another Conference, or a Round that is not a Post-it Round, must be unwritable, not merely unwritten) and for stating in the migration what the table deliberately omits. `token` is globally `UNIQUE`; `revoked_at timestamptz NULL`; a partial unique index on `(round_id) WHERE revoked_at IS NULL`. Rows are never deleted except by cascade with their Round – retention is what makes "never reissued" true. Plain PostgreSQL, no extension.
  - **Verify**: `Test: two live links for one Round violate the partial unique index; a link naming a Round from another Conference is refused by the foreign key; a second row with an existing token value is refused by the UNIQUE constraint; deleting the Round removes its links`

- [x] **TI02** Minting produces a value that is unguessable and not derivable from any Conference, Session, Round or Post-it identifier
  - New `api/src/rounds/display-link.ts`, module-shaped like `api/src/conferences/join-code.ts` (one minter, one canonical-form predicate, no state) but explicitly **not** its alphabet or length: 32 bytes from `node:crypto` `randomBytes`, base64url-encoded, and a comment stating why this module's requirements are the inverse of the Join Code's. Injectable as a `DisplayTokenMinter` so a test can pin the value, exactly as `mintJoinCode` is in `api/src/app.ts`.
  - **Verify**: `Test: minted values are 43 base64url characters, are distinct across many mints, and no mint is a function of the round, session, conference or post-it id it is issued for`

- [x] **TI03** Issuing revokes any live link for that Round in the same write, and revoking is idempotent and irreversible
  - Repository beside `api/src/rounds/round-repository.ts`. Issue is one statement or one transaction that stamps `revoked_at` on the Round's live link and inserts the new one, so a concurrent double-issue cannot leave two live rows (the partial index from TI01 is the backstop). Revoke names the Round, not a link. No path clears `revoked_at`; there is no update that can.
  - **Verify**: `Test: after a second issue the first link's revoked_at is set and the new one is the only live row; revoking twice succeeds both times with the same end state; no exported operation can move a link from revoked back to live`

- [x] **TI04** One predicate decides whether a token resolves, and no reason leaves it
  - In `api/src/rounds/display-link.ts`: resolvable iff the token matches a row, `revoked_at IS NULL`, the Conference's `lifecycle_state` is `published`, and `compareDates(clock.today(), session.day) <= 0` using `api/src/conferences/calendar-date.ts`. The function's failure result carries no discriminator of any kind – not a code, not an enum, not a boolean pair – because a caller that cannot tell the reasons apart cannot leak them. The `Clock` is injected (see `BuildAppOptions.clock` in `api/src/app.ts`) so S06 can pin the day. Time bound per ADR-005; do not re-derive it.
  - **Verify**: `Test: with the clock pinned, a link resolves on its Session day and refuses the day after; revoked, Draft, deleted-Round and unknown values all reach the same single failure result, and that result exposes no field distinguishing them`

- [x] **TI05** `GET /api/display/:token` answers without a credential, and is the only anonymous route this story adds
  - Registered in `api/src/app.ts` with a matching `ANONYMOUS_ROUTES` entry in `api/src/auth/with-auth.ts` carrying a written reason in the existing shape – the room machine has no Workspace session to present and must not acquire one on shared hardware. Startup already refuses an unwrapped unlisted route; that guard must not be weakened to accommodate this. No shape schema on `:token` (see Constraints & Gotchas). Response carries `Cache-Control: no-store`. The token is never logged.
  - **Verify**: `Test: the route answers with no Authorization header; ANONYMOUS_ROUTES holds exactly three entries, each with a reason; registering any other new route of this story without withAuth still fails startup; the response carries Cache-Control: no-store and no log line contains the token`

- [x] **TI06** Every unavailable case is one byte-identical refusal
  - One new `ERROR_CODES` entry in `api/src/errors.ts` with a comment saying that this is the deliberate exception to the surrounding one-code-per-reason convention and why. One status, one code, message exactly `This board is no longer available.`, no `details`, no varying header. Consumes TI04's undiscriminated failure result – the handler has nothing to branch on.
  - **Verify**: `Test: revoked, past-day, Draft, deleted-Round, never-issued and malformed-shape values produce identical status, code, message and headers, compared as whole responses rather than field by field`

- [x] **TI07** The resolution response is that one Board, and carries nothing vote-derived
  - Projects S02's Board read contract (`plan.json#sharedDecisions` → "Board read projection contract") – Categories in Facilitator order with their Post-its and author display names, plus Uncategorised and the counts – for the linked Round only, plus the Round's prompt for labelling. Nothing about sibling Rounds, other Sessions, the Join Code, Membership, roles, or the activity watermark (the projected surface deliberately uses none of it). Read-only: no write verb is registered on this route. Depends on TI04 for the gate and TI05 for the route.
  - **Verify**: `Test: with a Poll holding cast ballots in the same Session, no response field is a tally, option, ballot or count; the payload names only the linked Round's Board; POST/PUT/PATCH/DELETE on the route are refused; a module-graph assertion shows no vote or ballot table reachable from the handler, paired with the behavioural assertion above`

- [x] **TI08** Issue and revoke are held to sorting authority, with the actor taken from the credential
  - Two authenticated routes on the Facilitator's Round surface (`api/src/routes/rounds.ts`), both through `withAuth` and `requireConferenceRole(..., 'PresenterFacilitator', { sessionId })` from `api/src/conferences/authorization.ts` – S02's gate reused unchanged, resolved per request, Admin passing on conference-wide authority. No body field names or influences the actor (Binding Constraint FR6). The read of the current link's value and state is held to the same authority.
  - **Verify**: `Test: a Member with neither a Session Assignment nor Admin is refused on issue, revoke and read with nothing written; an Admin without an assignment succeeds; a body field naming another user changes neither the persisted issuer nor the decision`

- [x] **TI09** A second SPA entry point exists that renders a Board from a path token with no authenticated app behind it
  - `web/display.html` (its own document, mirroring `web/index.html`'s `/config.js` script tag) plus `web/src/display/main-display.tsx`, which reads the token from `window.location.pathname`, calls the resolution endpoint through TI14, and mounts **no** `AuthProvider` and registers **no** service worker – contrast `web/src/main.tsx`. Renders the Board plainly and the neutral message on refusal; the projection-scale design is S07's. Takes no pointer input that could change Board state (Binding Constraint FR8).
  - **Verify**: `Test: mounting the display entry with a token in the path renders the Board and issues no sign-in or token request; a refused token renders the neutral message; the entry module's import graph reaches neither AuthProvider nor the service-worker registration`

- [x] **TI10** The build emits the display document, and the dev server serves it at the same URL
  - `web/vite.config.ts`: a second Rollup input alongside `index.html` so `dist/display.html` is produced with its own hashed bundle; and a dev-server middleware rewriting `/display/*` to `/display.html`, because Vite's SPA fallback would otherwise serve `index.html` and the mechanism would only be wrong in production. Same file already hosts the `runtimeConfig` middleware to follow for shape.
  - **Verify**: `Test: a production build emits dist/display.html referencing its own entry chunk and dist/index.html referencing the app chunk; against the dev server, GET /display/<token> returns the display document and not the app document`

- [x] **TI11** The served image routes `/display/<token>` to the display document
  - `web/nginx/default.conf.template`: a `location ^~ /display/` block with `try_files $uri /display.html;`, placed so it wins over `location /` and does not shadow `location /api/`. Comment it in the file's existing voice, naming what breaks if the prefix match is dropped.
  - **Verify**: `Test: against the built image, GET /display/<any-token> returns the display document, GET / returns the app document, GET /api/health still proxies to the API, and a real asset under /display/ is still served as itself`

- [x] **TI12** The service worker neither stores nor answers `/display/` navigations
  - `web/public/sw.js`: exclude the `/display/` path prefix in `isCacheableAsset`/`storeShell` and in the fetch handler's navigation branch, so the projected page never becomes the cached shell and is never answered from it. `docs/LEARNINGS.md#service-workers--cache-storage` explains why a navigate-mode branch is the wrong place to be permissive.
  - **Verify**: `Test: a /display/<token> navigation leaves the cached shell unchanged and is fetched from the network; after such a visit the signed-in app still launches offline from the shell it had; asserted against cache contents, not against the requests issued`

- [x] **TI13** The Facilitator's Round surface offers issue, the current value, and revoke
  - `web/src/activities/SessionActivitiesPanel.tsx`, offered only where sorting authority is already established for that Session. Shows the live value ready to copy or open, its issued state, and a revoke control; issuing again replaces what is shown. A refusal is rendered outside any subtree its own handler unmounts (`docs/LEARNINGS.md#react-state--refusals`). Responsive at 375 / 768 / 1280 px.
  - **Verify**: `Test: with authority, issuing shows a copyable value and a revoke control; revoking clears it and leaves issue available; a second issue replaces the displayed value; without authority no control is rendered; a failed issue leaves the panel and its message on screen`

- [x] **TI14** The web client can read a Board through a Display Link without a credential
  - A resolution call in `web/src/api/client.ts` that sends **no** `Authorization` header and no session-derived value, using the same `resolveApiBaseUrl` and `ApiError` envelope handling as the rest of the module, and mapping the single neutral refusal to the display message. Consumed by TI09; also the shape S07 renders through.
  - **Verify**: `Test: the resolution call carries no Authorization header and no credential-derived value; a refused response surfaces as the neutral message and not as a sign-in prompt`

### Testing Strategy

- The neutrality assertion (TI06, S07) compares **whole responses** – status, headers and body together – rather than asserting each field, because the disclosure this story guards against is any difference at all, and a field-by-field test only covers the fields somebody thought of.
- The no-Vote-data guard (TI07, S05) is written twice on purpose: a module-graph assertion over the resolution path, and a behavioural assertion against a Session that genuinely holds a Poll with cast ballots. `docs/LEARNINGS.md#testing` records a file-list guard that missed the one file that mattered.
- Day-boundary scenarios pin the server date through the injected `Clock` (`fixedClock` in `api/src/conferences/calendar-date.ts`), never by moving a system clock.
- The service-worker guard (TI12) asserts cache **contents** after the navigation, not the requests issued – the recorded failure mode from S10.

### Execution Contract

- **S03 lands first on the two files W3 shares; S04 rebases onto the result.** S03 and S04 are both in W3 and both list `web/src/activities/SessionActivitiesPanel.tsx` and `web/src/api/client.ts` in **Work Areas** – across this bundle six of the eight stories modify that panel and five modify `client.ts`. The plan resolves this at plan level rather than leaving it to merge luck: **S04 is no longer marked parallel, and W3 runs S03 then S04 sequentially** (`plan.json#executionNotes`, which also records that any pair run concurrently on that panel needs worktree isolation and an explicit integration step). So TI13 and TI14 start from S03's landed state in those two files rather than from S02's, and S04 rebases onto that result. Do not run the two concurrently against one shared tree.
- TI01 → TI02 → TI03 → TI04 gate everything else on the API side; TI05 must not be registered before TI04 exists, or the route ships with an ad-hoc gate that TI04 then duplicates.
- TI09 depends on TI14 for its data path and on TI05 for the endpoint; TI10, TI11 and TI12 are the three serving surfaces of the same URL and must all land before S08 is claimed – any one of them missing makes the projected URL work in exactly one of dev, production and repeat-visit.


## Implementation Observations

> _Managed by exec-spec post-implementation – append-only. Spec authors: leave this section empty._

### Run: 2026-08-30 21:14 UTC – discovered-requirements

#### DISCOVERED REQUIREMENTS

_Propagated by the exec-plan wave triage from S02 (2026-08-30) – not authored with this story._

- **Do not inherit the SPA's absent-Board default.** `web/src/api/client.ts` defaults a missing Board with `round.uncategorised ?? { postIts: [], postItCount: 0 }`, which renders the Uncategorised region with a count of 0 and the "this round collected no post-its" copy for a payload that never claimed a Board – a positive assertion the API deliberately declines to make by omitting the keys. It is unreachable through `fetchSessionActivities`, which always supplies the Board for a Post-it Round, but this story reads the same type from a different endpoint where an absent Board is reachable. Distinguish "no Board in this payload" from "a Board with nothing on it"; do not copy the `??` fallback.

### Run: 2026-08-31 09:20 UTC – observations

#### NOTICED BUT NOT TOUCHING

- **`npx vitest run --project api` cannot be run green on this machine**, and it predates S04. Seventeen files - every integration file - fail on migration advisory-lock contention: `api/vitest.config.ts` sets `fileParallelism: false` and it is not taking effect for that invocation. Run individually every file passes, and the full `npx vitest run` (both projects, 84 files / 1401 tests) is green. S04 changes no vitest configuration, but it does add an eighteenth migrate-up/down integration file to a suite that already could not run them together. Worth a tech-debt entry.
- `api/test/join-code.test.ts` and `web/src/components/JoinCodePanel.tsx` carry pre-existing Prettier drift. Untouched; no project-wide format pass was run.
- The API has **no round-delete endpoint**, so the `ON DELETE CASCADE` and the deleted-Round refusal are proved against a direct `delete from round`. That is the honest subject anyway - the cascade must hold for a Session or Conference removal too - but the edge case's *route* is not exercised, because there is not one yet.
- `web/src/activities/SessionActivitiesPanel.tsx:1772` still carries S02's absent-Board default (`round.uncategorised ?? { postIts: [], postItCount: 0 }`). Not changed here: it is unreachable through `fetchSessionActivities`, and this story's own read path avoids it rather than inheriting it. Left to whichever story owns that panel's payload handling.
- **TI11 is proved by reading the nginx configuration, not by running it.** `scripts/verify-stack.sh` does not touch the display path and was not modified. The `location ^~ /display/` ordering, the `location = /display.html` cache directive and the redacting `log_format` are all asserted against the template text; the composed stack is where the behaviour itself would be confirmed. Recorded as the gap it is rather than papered over with a citation a maintainer would follow and find empty.

#### DESIGN NOTES (S04 implementation)

- **The Board projection moved to `api/src/rounds/board-wire.ts`.** TI07's Verify asks for a module-graph assertion that no vote table is reachable from the handler. `toBoardWire`/`toPostItWire` lived in `api/src/routes/rounds.ts`, which legitimately imports the vote repository for the Poll surface. Lifting the projection - not copying it - keeps the one Board read shape the shared decision requires *and* makes the closure assertable. Two existing structure tests were repointed at the new module; the properties they assert are unchanged.
- **`listForRound` was added to `CategoryRepository` and `PostItRepository`.** The shipped reads are Session-wide, which is correct for the one-read-per-Session rule; on the anonymous route "scoped to one Board" is an acceptance property, so the narrowing is the statement's own predicate rather than a filter over a wider result.
- **The Round's prompt rides `findByToken`'s own statement.** Reaching it through `RoundRepository` hydrates `round_option` - the Poll's option set - on every poll from every room machine, which made the route's written closure false and defeated the filename-based graph guard. Folding it into the one statement also removes the window in which the Round could vanish between two reads.
- **`NO_VIEWER` must stay a `\u0000` escape, never a literal NUL byte.** Written as a raw NUL it made `board-wire.ts` a *binary* file to git and to grep, which would have silently removed it from every source-scanning structure guard in the suite - including this story's own no-vote-data assertions. The escape produces the identical runtime value.
- **Issue is refused on an Archived Conference; revoke and read are not.** `authorizeWrite` gates issue - a read-only Conference does not get a new way in. Revoke and the read use authority-only gating, because withdrawing access must never be refused for the Conference having gone read-only.
- **The projected view has no poll loop.** The FIS assigns the room machine's re-read cadence to S07, and `web/src` is guarded to exactly one cadence constant (`poll/use-watermark-poll.ts`) - which this surface could not use anyway, since the watermark endpoint is Membership-gated. Scenario S02's "the resolution response ceases" is proved against the API.

#### REVIEW REMEDIATION (2026-08-31)

Two fresh-context reviews ran: a code+gap review (`.agent_temp/reviews/facilitator-board-and-categorisation-s04-mixed-review-claude-2026-08-31.md`, PASS with findings) and an adversarial Critic pass. Every finding that touched a stated criterion was fixed rather than noted, because each was a case of the code claiming something about itself that was not true.

- **The nginx access log wrote the token** (HIGH). `nginx:alpine` defaults to the `main` format, whose `$request` carries the full path, so both the projected page load and every board poll through the `/api/` proxy logged a live bearer credential to stdout - defeating `redactDisplayToken` from in front of it. Fixed with a `map` + `log_format confapp` + server-level `access_log` that rewrites both display prefixes to `<token>`, mirroring the API's placeholder. `access_log off` was rejected: it would erase the fact that a projected board was served at all.
- **`displayLinkUrl` used `window.location.origin`** (HIGH), which inside the Capacitor shells is `capacitor://localhost` or `https://localhost` - so a link issued from a Facilitator's phone, the device the acceptance scenario names, was unopenable by any room machine, in a field that looked fine. Added `webBaseUrl` to the runtime config contract (`config.js`, the container entrypoint, the Vite dev middleware) and `resolveWebBaseUrl` beside `resolveApiBaseUrl`; it returns `null` where no address can be stated, and the control then shows the token with a sentence saying so rather than a broken URL. **S11 must set `webBaseUrl` in the Capacitor builds** - see Discovered Requirements.
- **The token was echoed in `ROUTE_NOT_FOUND`** (MEDIUM), contradicting Structural Criterion 4: any verb or path shape under the prefix that missed the single registered route put the credential back into a response body. The not-found handler now maps everything under `DISPLAY_ROUTE_PREFIX` onto the neutral refusal, which also collapses the trailing-slash divergence.
- **A percent-malformed path escaped the shared envelope** (MEDIUM): find-my-way rejects it before dispatch, so Fastify answered `400 FST_ERR_BAD_URL` in its own shape, echoing the path - a seventh answer under a prefix whose whole point is six identical ones. Added a `frameworkErrors` handler; `%zz` and `%` are now in the byte-identical comparison.
- **A concurrent double-issue surfaced as a 500** (MEDIUM). The partial unique index always kept the data right; the loser was told the wrong thing. `issue` now absorbs a `display_link_one_live_per_round` violation by re-reading the live link. A *token* collision is deliberately not absorbed, and the driver error is not logged on that path - PostgreSQL's `detail` for it is literally `Key (token)=(<value>) already exists.`
- **`/display.html` was not covered by the service-worker exclusion** (LOW), so a navigation to the bare document replaced the cached app shell - the same second defect TI12 exists to prevent, through a different URL.
- **`withTokenRedaction` no-opped for `logger: true`** (LOW), Fastify's idiomatic "log with defaults" - a latent one-word regression on the story's most guarded property. Now covered, and driven as its own test case.
- **The projected view rendered any server message** (LOW), so a 500 or a proxy's 502 text could reach the wall. It now renders the neutral sentence for every answered failure, which also stops `DISPLAY_LINK_UNAVAILABLE_CODE` being a dead export.
- **The three routes that hand out the token carried no cache directive** (LOW). They now send `no-store`, like the route that spends it.
- **The nginx `no-store` never reached the response** (LOW): `try_files`' internal redirect drops `add_header`, so the directive moved to the exact-match `location = /display.html` the redirect lands in, and a test now asserts the prefix block contains no `add_header` at all.
- **The graph guard filtered by filename** (MEDIUM, second half), which is the trap the FIS cites from `LEARNINGS#testing` firing inside the guard written to honour it. It now extracts SQL table names from template literals across every reachable module, subtracts declared CTE names, and checks them against a written allow-list.
- **The one assertion covering the copyable URL restated the implementation** (LOW) - it read `window.location.origin` on both sides, so it could not fail for the reason it existed. It now asserts a literal origin the test sets, with a Capacitor-origin case beside it.

Accepted and not changed: a token unique-violation still exits as an internal error (256 bits repeating must stay loud), and the `Referer` guard added to `display.html` mid-review closes the referrer path the Critic would otherwise have raised.

### Run: 2026-08-31 09:21 UTC – discovered-requirements

#### DISCOVERED REQUIREMENTS

_Appended by exec-spec during the S04 run (2026-08-31), after two fresh-context reviews._

- **The SPA must be able to state the address another machine reaches it at, and it cannot derive one.** `window.location.origin` is the WebView origin inside the Capacitor shells - `capacitor://localhost` (iOS) or `https://localhost` (Android), both recorded in `web/capacitor.config.ts` - so a Display Link built from it on a Facilitator's phone is unopenable by any room machine, in a field that looks entirely plausible. This story adds `webBaseUrl` to the runtime configuration contract (`web/public/config.js`, `web/docker-entrypoint.d/40-runtime-config.sh`, the Vite dev middleware) and `resolveWebBaseUrl` in `web/src/config.ts`, which returns `null` rather than guessing. **S11 (Capacitor packaging) must set `webBaseUrl` to the deployment's public web origin in the mobile builds**, exactly as it must supply an absolute `apiBaseUrl`; until it does, the issue control on the mobile shells shows the token and says it cannot state an address. The container and the dev server need no value - a browser served over http(s) genuinely is reachable at its own origin.

- **A refusal raised before routing must still leave through the shared error envelope.** `errors.ts` calls itself "the single exit through which every refusal leaves the server", and that was not true: find-my-way rejects a percent-malformed path before any route is dispatched, so Fastify answered in its own `{"error":"Bad Request","code":"FST_ERR_BAD_URL",...}` shape, echoing the requested path. This story adds a `frameworkErrors` handler to `buildApp` and `malformedRequestUrl()` to `errors.ts`. **Every later story inherits the guarantee**; nothing needs to re-derive it, and no route may reintroduce a response shape outside `ErrorEnvelope`.

- **The static-file container's access log is part of confApp's credential surface.** `nginx:alpine` defaults to a format carrying the full request line, so a secret in a URL path is written to stdout by the container in front of the API regardless of what the API does about its own logging. S04 adds a redacting `log_format` for the two display prefixes. **Any later story that puts a secret in a path must extend that map**, and the standing rule "never key on the request line" now has two halves rather than one.

### Run: 2026-08-31 09:32 UTC – observations

#### OWNER DECISIONS

_Recorded by the exec-plan orchestrator at S04 close (2026-08-31), after independent verification of this story's gates._

- **The two HIGH findings were real defects in the story's own central discipline and were fixed, not noted.** **nginx logged the token**: the container in front of the API falls through to `nginx:alpine`'s default `main` log format, whose `"$request"` carries the full request line, so a live bearer credential over named Post-its would be written to stdout on every poll, defeating the API's own `redactDisplayToken` entirely. Fixed with a `map` plus a `log_format confapp` referenced by `access_log`, redacting to `/display/<token>` in the same shape the API uses. The reviewer had routed this Note pending verification against a running image; the orchestrator supplied that verification – `nginx -t` passes on the rendered template and a live request logs the placeholder, with `/index.html` unaffected – so the redaction is scoped rather than blanket-hiding traffic. Bare nginx variables survive `envsubst` because nginx's entrypoint passes it an explicit variable list.
- **`displayLinkUrl` used `window.location.origin`**, which is `capacitor://localhost` on the very phone the acceptance scenario names – a plausible-looking but unopenable link. `webBaseUrl` was added to the runtime-config contract and returns `null` rather than guessing.
- **Three MEDIUM and six LOW findings were all remediated.** The MEDIUMs: the token echoed in `ROUTE_NOT_FOUND`; a percent-malformed path escaping the shared error envelope; a concurrent double-issue surfacing as a 500. The LOWs include L1 (the `/display.html` service-worker gap, now covered by a `DISPLAY_DOCUMENT` constant beside the prefix) and L7 (six em dashes against the standing guardrail).
- **L5 resolved in code.** The display refusal branch rendered whatever message any answered failure carried, which would have put an internal-error string or a proxy's 502 text on a wall in front of a room, while `DISPLAY_LINK_UNAVAILABLE_CODE` sat exported and unreferenced. The surface now branches on that code and gives every other answered failure one neutral sentence, discarding the server's words. The export is no longer dead, and the "one sentence and nothing else" discipline is enforced client-side rather than delegated to the server.
