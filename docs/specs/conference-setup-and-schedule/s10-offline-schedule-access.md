# S10: Offline Schedule Access

**Plan**: docs/specs/conference-setup-and-schedule/plan.json
**Story-ID**: S10

## Feature Overview and Goal

**Intent**: Venue wifi drops exactly when an Attendee needs to know where to be next, and – with push deferred out of S09 – a change made while their device was offline or asleep reaches them through nothing else; this story keeps the Schedule readable without a connection and tells the Attendee what moved while they were away.

**Expected Outcomes**:

- [OC01] An Attendee who joined a Conference online can open its Schedule with no connection and read it in the normal schedule view – including the running-Session highlight, driven by the device clock corrected by the server–device offset recorded at the last successful sync – told that the data is cached and how long ago it was last updated.
- [OC02] On reconnect the Attendee is shown a "what changed" summary covering Sessions added, edited **and** deleted since the cached watermark – the fallback channel for the window in which push (FR7) was undeliverable.
- [OC03] No offline Attendee lands on a blank screen or an endless spinner: a Conference never loaded online states it is not available offline, and a stale cache is shown with its age rather than withheld.
- [OC04] Cached Schedule data belongs to exactly one user and one Conference, and is gone from the device on sign-out and when a different employee signs in on the same device.


## Required Context

- `docs/specs/conference-setup-and-schedule/prd.md#fr8-offline-schedule-access` – the feature contract this FIS implements: the eight acceptance criteria, the per-conference/per-user validation rule, and the two error-handling rules (cache miss offline → explicit empty state; stale cache → shown with its age). **Binding Constraint (FR8)**: "Offline scope is read-only – no schedule editing, joining, or leaving offline. […] Cached data is cleared on sign-out and when a different user signs in on the same device." Do not restate it – read it.
- `docs/specs/conference-setup-and-schedule/prd.md#fr4-attendee-schedule-view` – **Binding Constraint (FR4)**, and the only place in the bundle it is realised: "The currently running session is highlighted. Server time is authoritative while online; **offline the device clock is used, corrected by the server–device offset recorded at the last successful sync.**" S06 builds the clock module and holds the offset in memory; this story is what makes it survive a force-quit, so the offline highlight has a clock source at all.
- `docs/specs/conference-setup-and-schedule/s06-attendee-schedule-view.md#technical-overview` – the pinned envelope (including the dual `serverNow` anchor: `instant` plus naive `day`/`time`), the **effective-now arithmetic** (`offset = serverNow.instant − deviceClockAtReceipt`), and the rendering contract "the view is `render(envelope, effectiveWallClockNow)`". Both inputs are this story's responsibility offline, not just the first. S06 TI05 states explicitly that the offset and anchor "are values S10 will persist".
- `docs/specs/conference-setup-and-schedule/s09-live-schedule-editing.md#implementation-tasks` – S09 owns the **envelope-diff function** (base envelope vs. newer envelope → Sessions added / edited / deleted) and the in-app change banner for Attendees who are online when a change lands. This story's reconnect summary **consumes that function**; it does not define a second diff. S09 lands in W7, this story in W8, so the function exists when this story runs.
- `docs/specs/conference-setup-and-schedule/prd.md#edge-cases` – three rows bind this story: an Attendee opening the app offline having never loaded the Conference gets an explicit "not available offline" state; an Attendee offline for the whole window in which a Session moves sees the change in the "what changed" summary because push was undeliverable; and a wrong device clock must never change the times shown.
- `docs/specs/conference-setup-and-schedule/prd.md#non-functional-requirements` – **Binding Constraints (NFR)**: `hd` claim verified server-side on **every** request (ADR-002) – the reconnect refresh is a normal authenticated request and gets no exemption; plain PostgreSQL only, no provider-specific extensions (ADR-003); responsive behaviour verified at 375px / 768px / 1280px per `AGENTS.md`. Also the Reliability row: "A schedule loaded at least once always renders (FR8; a never-loaded conference is explicitly out)."
- `docs/specs/conference-setup-and-schedule/prd.md#constraints` – **Binding Constraint (FR4)**: "Session times are **naive wall-clock values** – stored and displayed without timezone conversion." A cache round trip is a serialization boundary and therefore a place this constraint is broken by accident; OC01's rendering must be byte-identical to the online rendering.
- `docs/specs/conference-setup-and-schedule/plan.json#sharedDecisions` – three decisions bind this story and are consumed unchanged, never re-derived: **"Schedule read model and cache envelope"** (S06 defines the single schedule payload; S10 caches *exactly* that envelope so the offline render reuses the online component tree), **"Conference and Session timestamps - three fields, four consumers"** (three distinct fields, not one shared timestamp: `session.last_updated_at` is the per-Session row version and S09's concurrency base, not this story's; `conference.schedule_watermark_at` is the whole-schedule watermark advanced by every Session insert, update **and delete**, serialized to the wire as `conference.lastUpdatedAt` – this is S10's staleness marker *and* reconnect cursor; `conference.updated_at` is the Conference row's own version, S03's concurrency base for a name or date-span edit, and must never be conflated with the schedule watermark), and **"Naive wall-clock time representation"** (S04 fixes it; S10 must not coerce it).
- `docs/specs/conference-setup-and-schedule/s04-schedule-composition.md#structural-criteria` – the two contracts this story stands on, already pinned by tests there: wall-clock times are strings that never pass through `Date`, and **`conference.schedule_watermark_at` advances on any Session insert, update *or delete*** – the delete half is precisely why a Conference-level cursor can observe removals. **Naming**: `conference.schedule_watermark_at` is the DB column; it is serialized to the wire as `conference.lastUpdatedAt` in S06's envelope (S04 structural criterion). This story reads the **wire** field – refer to the column name only when talking about the database.
- `docs/specs/conference-setup-and-schedule/s02-google-workspace-sign-in.md#implementation-plan` – TI10 exposes the sign-out / user-switch clearing hook; S02 explicitly leaves the cache itself to this story. Register with that hook; do not build a second auth teardown path.
- `docs/specs/conference-setup-and-schedule/s05-join-code-access.md#acceptance-scenarios` – S01/S02 there define the successful-join moment this story hooks to prime the cache, and the idempotent re-join that must not duplicate or corrupt a cache entry.
- `docs/PRODUCT.md#anti-goals` – "Not fully offline." Offline sync and conflict resolution are an explicit product anti-goal; this is the boundary the story is most likely to drift across.
- `AGENTS.md` – standing facts and the Do Not / Never list, in particular "Never widen offline support beyond schedule reads and post-it queueing", "Never ship a fixed-width or desktop-only layout", and "Never key a user on their email address" (the cache is keyed on `sub`).
- `docs/guidelines/CRITICAL-RULES-AND-GUARDRAILS.md#scope-discipline` – scope discipline; this story sits downstream of S06 and S09 and must extend their surfaces rather than fork them.


## Deeper Context

- `docs/adrs/ADR-001-mobile-packaging-capacitor.md` – the 2026-08-16 amendment records that partial offline support was added after the ADR and that a native shell gives more dependable local storage than a browser tab. The decision is unchanged; read it before assuming a native-only storage plugin is available (it is not – S11 builds the shells *after* this story).
- `docs/ARCHITECTURE.md#key-constraints` – "Partially offline … Broader offline sync and conflict resolution are out of scope", and "One codebase, three targets".
- `docs/specs/conference-setup-and-schedule/plan.json#riskSummary` – the S10 entry names the two failure modes this FIS is shaped around: creep into sync, and treating cache clearing as cleanup rather than as a privacy requirement.
- `docs/specs/conference-setup-and-schedule/prd.md#decisions-log` – the "Offline is read-only" row and its rejected alternative ("Offline edits with sync reconciliation").


## Acceptance Scenarios

- [ ] **S01 [OC01,OC04] [TI01,TI02,TI03,TI04,TI10] Joining online is enough – the Schedule reads with the network off, in the normal view**
  - **Given** Nadia is signed in and joins the published Conferences "Kickoff 2026" and "Retro Day" by code, without ever opening either Schedule
  - **When** her device loses all connectivity and she launches confApp and opens "Kickoff 2026"
  - **Then** the Schedule renders through the same day-navigable session list she sees online – same component tree, same start-time ordering, same "09:00–10:30" wall-clock strings as authored – with a visible statement that the data is cached and how long ago it was last updated
  - **And** "Retro Day" is readable offline too, held as a separate cache entry, and both entries are keyed to Nadia's `sub`

- [ ] **S02 [OC01,OC03] [TI04] A three-day-old cache is shown with its elapsed age rather than withheld**
  - **Given** Nadia's cached Schedule for "Kickoff 2026" was last updated three days and four hours ago and the device has had no connectivity since
  - **When** she opens the Schedule with no connectivity
  - **Then** the full Schedule renders, labelled as cached with its staleness stated as an **elapsed age** – "updated 3 days ago" – and it is neither hidden, blanked, nor replaced by a "too old" refusal
  - **And** the label renders no absolute wall-clock time derived from the watermark instant: the watermark is a `timestamptz` and converting it to a wall clock on the device would print a time disagreeing with every Session time on the same screen (Binding Constraint FR4)

- [ ] **S03 [OC03] [TI05] A Conference never loaded online states it is not available offline**
  - **Given** Nadia is signed in and has never joined or loaded "Leadership Day" on this device
  - **When** she opens it with no connectivity
  - **Then** she sees an explicit "not available offline" state explaining that a connection is needed once – not a blank screen, not an indefinite spinner, and not a generic network error
  - **And** the schedule view never enters a spinner state that has no terminating outcome while offline

- [ ] **S04 [OC02] [TI06,TI07] Reconnect reports additions, edits and deletions since the cached watermark**
  - **Given** Nadia's cache holds "Kickoff 2026" at Conference `lastUpdatedAt` = `2026-09-15T08:00:00.000000Z` with Sessions "Opening Keynote" 09:00–10:30, "Design Workshop" 13:00–14:00 and "Retrospective" 15:00–16:00
  - **And** while her device is offline an Admin adds "Lightning Talks" 11:00–11:30, moves "Design Workshop" to 14:30–15:30, and deletes "Retrospective"
  - **When** her device regains connectivity
  - **Then** the Schedule refreshes without her asking and a "what changed" summary names all three changes – "Lightning Talks" added, "Design Workshop" time changed from 13:00–14:00 to 14:30–15:30, and "Retrospective" removed – with the deletion stated as explicitly as the addition
  - **And** the summary is derived from the cached watermark and cached envelope, so it is complete even though no push notification ever reached the device

- [ ] **S05 [OC02,OC03] [TI06,TI07] Reconnect with nothing changed refreshes silently and shows no summary**
  - **Given** Nadia's cached Schedule for "Kickoff 2026" is at the same Conference `lastUpdatedAt` the server currently holds
  - **When** her device regains connectivity
  - **Then** the cache is refreshed, the cached-data label is replaced by the live state, and no "what changed" summary is shown – an empty summary is never displayed as a change

- [ ] **S06 [OC04] [TI08] A shared device shows the next employee nothing of the previous signer's Conference**
  - **Given** Anna is signed in on a shared tablet with "Kickoff 2026" cached and readable offline
  - **When** Anna signs out and Björn – who has joined no Conference – signs in on the same device, and connectivity is then lost
  - **Then** no Schedule, Conference name, Session title or cached timestamp from Anna's session is readable or discoverable by Björn anywhere in the app or in device storage
  - **And** the same holds when Anna's session ended without a clean sign-out (the app was killed) and Björn signs in on next launch – the purge is driven by the signed-in identity differing, not only by the sign-out action

- [ ] **S07 [OC01] [TI09] Offline offers no way to change anything, and nothing is queued for later**
  - **Given** Nadia is reading the cached "Kickoff 2026" Schedule with no connectivity
  - **When** she looks for the join, leave, and any schedule-editing affordances, and an in-flight mutating request is attempted
  - **Then** every mutating affordance is unavailable or refused with a message stating a connection is required, and no pending write, outbox entry, or replay queue is created anywhere on the device – on reconnect nothing is submitted

- [ ] **S08 [OC01] [TI01,TI04] After a force-quit and an offline relaunch the running Session is still highlighted, from the persisted offset**
  - **Given** Nadia's last successful sync of "Kickoff 2026" carried `serverNow` = `{instant: 2026-09-15T07:40:12.345678Z, day: "2026-09-15", time: "09:40"}`, her device clock read three hours fast at that moment, and "Opening Keynote" is authored 09:00–10:30 on 2026-09-15
  - **And** she force-quits the app, so nothing S06 held in memory survives, and the device stays offline
  - **When** she relaunches confApp twenty minutes later (by her device's own clock) and opens "Kickoff 2026"
  - **Then** "Opening Keynote" is highlighted as currently running – the offline render supplies **both** inputs of S06's `render(envelope, effectiveWallClockNow)` contract, having rehydrated the clock module from the persisted `serverNow` anchor and the persisted device-clock reading taken at receipt, so the effective wall clock reads 10:00 and not the device's 12:40
  - **And** every displayed time is still exactly the authored string – `09:00–10:30` – because the rehydrated clock feeds the highlight only and never a formatter


## Structural Criteria

- [ ] Cache entries are keyed on the pair (authenticated `sub`, conference id); no code path reads an entry written under a different `sub` or a different conference id, and no entry is keyed on email.
- [ ] The offline render path uses S06's schedule component tree and S06's cache envelope shape unchanged – no parallel offline-only schedule component, and no second payload shape that would drift from the online one.
- [ ] The offline render path supplies **both** inputs of S06's `render(envelope, effectiveWallClockNow)` contract: the cached envelope **and** an `effectiveWallClockNow` produced by S06's clock module rehydrated from the persisted `(serverNow anchor, device clock reading at receipt)` pair. No offline code path reads the raw device clock as "now", and none renders the schedule with the clock input absent, null, or defaulted.
- [ ] Exactly one envelope-diff implementation exists in the codebase – S09's. This story's reconnect summary calls it; no second added/edited/deleted comparison is written here, and no diff logic lives in this story's summary module beyond presenting S09's result.
- [ ] No staleness or "last updated" string displayed by this story is produced by converting the watermark instant (or any other `timestamptz`) into a wall-clock time on the device; staleness is rendered as elapsed age.
- [ ] No write, mutation, or deferred-submission path exists in the offline layer: no outbox table, sync queue, replay buffer, or conflict-resolution code is introduced (`docs/PRODUCT.md#anti-goals`).
- [ ] A cached Session's day, start time and end time survive the cache write/read round trip as the same strings the API returned – no schedule time value passes through `new Date(...)`, `Date.parse`, a JSON reviver, or a timezone-conversion library (S04 contract).
- [ ] Cache clearing is invoked through S02's sign-out / user-switch hook and at sign-in identity mismatch – this story introduces no independent auth teardown or token handling.
- [ ] Static build assets are the only thing the service worker precaches; no API response and no user data is stored in a Cache Storage entry, so the sign-out purge is complete.
- [ ] The reconnect refresh is an ordinary authenticated API request carrying the bearer token and subject to server-side `hd` verification – no unauthenticated or cache-only bypass endpoint is added.
- [ ] The cache works in the plain web build with no Capacitor plugin dependency – S11 has not run when this story lands.
- [ ] The cached-data label, the "not available offline" state and the "what changed" summary are legible with no horizontal body scroll at 375px, 768px and 1280px.


## Scope & Boundaries

### Work Areas

- Client cache store: keyed per (`sub`, conference id), holding S06's envelope plus its wire `conference.lastUpdatedAt` watermark and the **device-clock reading taken at the moment of receipt**, with a whole-store purge.
- Clock rehydration: restoring S06's clock module from the persisted `serverNow` anchor (inside the envelope) and the persisted device-clock-at-receipt, so `effectiveWallClockNow()` exists after a cold, offline launch.
- Schedule data access: online read writes through to the cache; offline read serves from it; join success primes it.
- Connectivity/resume observer and the automatic refresh it triggers.
- Reconnect "what changed" summary UI, presenting the result of **S09's** envelope-diff function.
- Schedule view states: cached-with-elapsed-age label, and the "not available offline" state.
- Auth integration: registration with S02's sign-out / user-switch clearing hook plus the sign-in identity-mismatch purge.
- Static asset precache so the web build launches with no connection.

### What We're NOT Doing

- **Offline editing, joining or leaving, and any queued or deferred mutation** -- Binding Constraint (FR8) and an explicit product anti-goal; offline writes would require conflict resolution, which `docs/PRODUCT.md#anti-goals` and the PRD Decisions Log both reject. The offline path is strictly read-only.
- **A server-side change log or "changes since" delta endpoint** -- the summary is a client-side diff of the cached envelope against the freshly fetched one, which reports deletions without tombstones or new schema. S09 owns server-side change timestamps.
- **The envelope-diff computation itself, and the online in-app change banner** -- S09 owns both (it needs the diff for the banner shown to Attendees who are online when a change lands). This story consumes that function and owns only the reconnect summary that presents it – the channel S09's banner cannot reach, because its Attendee was offline while the Schedule moved.
- **Building a second clock module** -- S06 owns the offset arithmetic and `effectiveWallClockNow()`; this story persists its two inputs and rehydrates it. Re-deriving effective-now here would fork the one rule that keeps a wrong device clock from changing a displayed time.
- **Push notification delivery** -- deferred out of S09 for this release (REQ-005 absent, delivery service Pending in `docs/DECISIONS.md`). The reconnect summary is the compensating channel, not a re-implementation of push.
- **Caching anything but the Schedule read model** -- no post-its, votes, membership lists, or organizer surfaces. Post-it queueing belongs to a later theme (`AGENTS.md`).
- **On-device native verification and native secure storage** -- S11 owns the Capacitor shells and verifies offline reads on real devices; this story ships the storage path all three targets share.

## Architecture Decision

**Approach**: Cache S06's schedule envelope verbatim in IndexedDB under the key (`sub`, conference id), together with its wire `conference.lastUpdatedAt` watermark and the device-clock reading taken at receipt; the offline path swaps the data source, not the view, and rehydrates S06's clock module from the persisted anchor pair so the view still gets both of its inputs. The reconnect summary presents S09's envelope diff of the cached envelope against the freshly fetched one.
**Why this over alternatives**: a server "changes since" endpoint would need tombstone rows to report deletions and adds server state for a purely client-side need – diffing two full envelopes yields additions, edits and deletions with no schema change, and S09 already needs that diff for its online change banner, so one implementation serves both channels. Persisting the anchor pair rather than the derived offset keeps the stored values exactly the two S06 already measures, so no second arithmetic path can drift from S06's. IndexedDB rather than a Capacitor storage plugin because this story lands a full wave before the shells exist (S11) and one storage path must serve browser, Android and iOS from one codebase.


## Technical Overview

**Two render inputs, not one.** S06 pins its view as `render(envelope, effectiveWallClockNow)`, and caching the envelope only solves the first half. The second input comes from S06's clock module, which measures `offset = serverNow.instant − deviceClockAtReceipt` at each successful fetch and holds it **in memory** – so after a force-quit and an offline relaunch it has no input at all, and the running-Session highlight FR4 requires offline has no clock source. This story therefore persists the **anchor pair**: the `serverNow` object already inside the cached envelope, and the device clock reading taken at the moment that envelope was received. "Fetched-at" in this story means exactly that reading – `Date.now()` on the device as the response landed, not a server value and not a re-read taken later. On an offline read, the cache module hands both back and S06's clock module is rehydrated from them; the arithmetic is S06's unchanged. Note the asymmetry this preserves: a device clock wrong *at the original sync* is absorbed by the offset, but a device clock that drifts or is changed *between* sync and offline relaunch skews elapsed time and may mis-highlight – accepted by S06, and the reason the highlight is the only thing the clock feeds. No displayed time is ever produced from it.

**Staleness is an age, not a timestamp.** The watermark is an instant (`timestamptz`); rendering it as a wall clock on the device requires a timezone conversion nobody specified, and on a device set away from the venue that stamp would contradict every Session time beside it. Staleness is therefore displayed as elapsed age – "updated 4 minutes ago", "updated 19 hours ago" – computed from the persisted device-clock-at-receipt against the device clock now, which is a duration and so immune to the timezone question. If an absolute time is ever wanted, it must come from a naive wall-clock string carried in the envelope in the same frame as `serverNow.time`, never from a client-side conversion of an instant.

Two independent caches, deliberately not merged. A service worker precaches the **static build assets only**, so the web build launches with no connection – on the Capacitor shells the assets are already local, which is why this half is web-specific and carries no user data. All **data** lives in IndexedDB at application level, because it must be queryable per conference and wholly purgeable per user; a service worker caching API responses would put user data outside the purge and is prohibited by a Structural Criterion. The watermark does double duty: as the staleness marker behind the "last updated" label, and as the reconnect cursor. It must be the **Conference** `lastUpdatedAt`, which S04 advances on Session deletes – a cursor derived from the maximum Session timestamp would be blind to exactly the change class this story exists to report.


## Code Patterns & External References

```
# type | path#anchor or url                                                        | why needed (intent)
doc    | docs/specs/conference-setup-and-schedule/plan.json#sharedDecisions        | Cache envelope (S06), lastUpdatedAt semantics (S04/S09), wall-clock representation – consume unchanged
fis    | docs/specs/conference-setup-and-schedule/s06-attendee-schedule-view.md#technical-overview | Envelope shape, dual serverNow anchor, effective-now arithmetic and the two-input render contract to satisfy offline
fis    | docs/specs/conference-setup-and-schedule/s09-live-schedule-editing.md#implementation-tasks | The envelope-diff function this story's reconnect summary calls – do not write a second one
doc    | docs/specs/conference-setup-and-schedule/s04-schedule-composition.md#structural-criteria | The delete-advances-watermark guarantee (conference.schedule_watermark_at → wire conference.lastUpdatedAt) the reconnect cursor depends on
doc    | docs/specs/conference-setup-and-schedule/s02-google-workspace-sign-in.md#implementation-plan | TI10 – the sign-out / user-switch hook this story's purge registers with
url    | https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API             | Structured-clone storage semantics and transaction/versioning model
url    | https://developer.mozilla.org/en-US/docs/Web/API/Navigator/onLine          | Why onLine is a hint, not a connectivity test (see Constraints & Gotchas)
```

_S06 (W6) and S09 (W7) both land before this story (W8): take the envelope shape, the clock module and the online refresh path as built. Do not define a second envelope, a second clock module, or a second diff._


## Constraints & Gotchas

- **Critical**: caching only the envelope leaves S06's view with one of its two inputs -- the clock module's offset lives in memory and dies with the process, so after a force-quit the offline highlight has no clock source. Must handle by: persisting the `serverNow` anchor and the device-clock-at-receipt alongside the envelope and rehydrating S06's clock module from them on every offline read (TI01, TI04).
- **Avoid**: persisting the *derived* offset instead of the anchor pair, or recomputing the offset at rehydration time against the current device clock -- Instead: store the two measured values S06 already has; recomputing against a later device-clock reading would zero the offset out and silently reintroduce the raw device clock as "now".
- **Critical**: rendering the watermark instant as a clock time requires a timezone conversion the FR4 constraint bans -- Must handle by: showing staleness as elapsed age only. An absolute time may come only from a naive wall-clock string carried in the envelope, never from converting an instant on the device.
- **Critical**: the reconnect cursor must be the **Conference** watermark (wire `conference.lastUpdatedAt`, from `conference.schedule_watermark_at`), not the newest Session timestamp -- a Session-derived cursor cannot see a deletion, which is the change class most likely to strand an Attendee outside a room that no longer exists. Must handle by: reading the Conference watermark S04 advances on Session insert, update *and* delete.
- **Critical**: `navigator.onLine` reports link state, not reachability – it is `true` behind a captive portal or dead venue wifi -- Must handle by: treating a failed or timed-out schedule request as offline and falling back to cache; `onLine` and its events may trigger a refresh attempt but must never be the sole gate on rendering.
- **Critical**: clearing on sign-out alone leaves a hole – an app killed mid-session never runs the sign-out path -- Must handle by: purging on sign-out **and** whenever the `sub` presented at sign-in differs from the `sub` the store was written under. This is a privacy requirement (S06), not cleanup.
- **Avoid**: rehydrating cached times through `JSON.parse` with a date reviver, or normalizing them "for sorting" -- Instead: store and return the exact strings the API produced; sorting is a `(day, startTime)` string compare (S04).
- **Constraint**: browser and WebView storage is evictable – iOS WebKit clears IndexedDB for unused origins, and quota pressure can drop entries -- Workaround: treat a cache miss as an ordinary outcome that renders the "not available offline" state (TI05); never let correctness depend on an entry surviving.
- **Avoid**: letting the service worker intercept and store API responses "since it is already there" -- Instead: precache static assets only; data lives in IndexedDB where it is scoped per user and purgeable.
- **Avoid**: any code path that accepts input offline "to submit later" -- Instead: disable or refuse the affordance. A queue is the first step into sync and conflict resolution, an explicit anti-goal.


## Implementation Plan

### Implementation Tasks

- [ ] **TI01** A schedule cache store exists, keyed per user and per Conference, holding the clock anchor alongside the envelope, with a whole-store purge
  - One access module over IndexedDB; entry key is (`sub` from the S02 caller/session state, conference id). Value is S06's envelope verbatim (the `serverNow` anchor rides inside it), its wire `conference.lastUpdatedAt`, and `deviceClockAtReceipt` – **the device clock reading taken at the moment the response was received**, which is what "fetched-at" means throughout this story. It is the second half of S06's offset measurement and is stored so the offset can be reconstituted after a process restart; it is never re-read at a later moment. Exposes read, write and purge-all; no other module touches storage directly. No Capacitor plugin – the web build must work (S11 has not run).
  - **Verify**: `Test: an entry written under sub A / conference X is not returned for sub B, nor for sub A / conference Y; purge-all leaves no readable entry; values round-trip with day/startTime/endTime as the identical strings written; a read returns the serverNow anchor and the deviceClockAtReceipt recorded at write time, unchanged by how much later the read happens; the module pulls in no Capacitor package`

- [ ] **TI02** Every successful online Schedule read writes the envelope through to the cache
  - Hooks the S06 schedule read path so caching is a property of reading, not a separate opt-in; stores the envelope unmodified together with the wire `conference.lastUpdatedAt` from that response and the device clock reading taken at receipt – the same reading S06's clock module uses for its offset, captured once and shared, not measured twice. Uses TI01's store.
  - **Verify**: `Test: after one online schedule read the cache holds an entry for that (sub, conference) whose envelope is byte-identical to the API response body, whose watermark equals the response's conference.lastUpdatedAt, and whose deviceClockAtReceipt equals the value S06's clock module recorded for that same fetch`

- [ ] **TI03** A successful join primes the cache, so joining online is sufficient
  - On the S05 join success (including the idempotent re-join, which must not duplicate or corrupt the entry), fetch and cache the Schedule via TI02's path without requiring the Attendee to open the schedule view.
  - **Verify**: `Test: an Attendee who joins and never opens the schedule view then reads it with the network disabled and sees the full Schedule; a repeated join of the same code leaves exactly one cache entry`

- [ ] **TI04** The Schedule renders offline through the online view, with both render inputs supplied and staleness shown as elapsed age
  - When the schedule request fails or connectivity is absent, the same S06 component tree renders from TI01's entry. **Both** inputs of `render(envelope, effectiveWallClockNow)` are supplied: the cached envelope, and an effective wall clock from S06's clock module **rehydrated** from the cached `serverNow` anchor and the cached `deviceClockAtReceipt` – so the running-Session highlight works after a cold, offline launch with nothing left in memory (FR4: offline the device clock is used, corrected by the recorded offset). No offline path reads the raw device clock as "now" and none renders with the clock input missing. A label states the data is cached and its **elapsed age** ("updated 4 minutes ago") – never an absolute time converted from the watermark instant. Stale entries are labelled, never withheld. Session times render through S04's wall-clock helpers – no `Date` construction on any displayed value.
  - **Verify**: `Test (S01,S02,S08): with the network disabled the schedule list renders the same sessions in the same order as the online render; after a cold start with no in-memory clock state, a device clock skewed +3h at the cached sync still highlights the Session running at the anchored server wall clock while every displayed time string is byte-identical to the authored value; the label shows an elapsed age and no absolute time derived from the watermark; a three-day-old entry renders in full rather than being suppressed`

- [ ] **TI05** A Conference with no cache entry shows an explicit "not available offline" state
  - Terminal state, reached on cache miss while offline: explains a connection is needed once, per `prd.md#fr8-offline-schedule-access` error handling. Never a blank region, an indefinite spinner, or a raw network error. Depends on TI01's read returning a distinguishable miss.
  - **Verify**: `Test (S03): opening a never-cached conference with the network disabled renders the not-available-offline message and reaches a terminal non-loading state; no spinner remains after the attempt resolves`

- [ ] **TI06** Returning connectivity refreshes the cached Schedule automatically
  - A connectivity/app-resume observer re-fetches through TI02 with no user action, replacing the cached-data label with the live state. `navigator.onLine` may prompt an attempt but a failed request is the authoritative offline signal (see Constraints & Gotchas). Reuses S09's online refresh path rather than adding a second fetcher.
  - **Verify**: `Test (S04,S05): with the network restored the view updates without user interaction and the cached-data label clears; a refresh whose watermark is unchanged still rewrites the entry's deviceClockAtReceipt and serverNow anchor, so staleness and the clock offset both re-anchor; the refresh request carries the bearer token and is refused server-side without it`

- [ ] **TI07** A "what changed" summary presents S09's envelope diff of the cached envelope against the freshly fetched one
  - Call **S09's** envelope-diff function with the cached envelope as the base and the envelope TI06 fetched as the new one; write no comparison logic here. Present its result as the reconnect summary: additions, edits (naming old and new values for changed times) **and deletions**, the deletion stated as explicitly as the addition. Gate on the Conference watermark having advanced; show nothing when it has not. This summary is this story's own – it is the only channel reaching an Attendee who was offline while the Schedule moved, which S09's online change banner by definition cannot (`prd.md#edge-cases`, push deferred). Only the diff computation is shared.
  - **Verify**: `Test (S04,S05): one add, one time change and one delete applied while offline all appear in the summary after reconnect, the delete named as a removal; an unchanged schedule produces no summary at all; the summary module calls S09's diff function and the codebase contains exactly one envelope-diff implementation`

- [ ] **TI08** Sign-out and a different user signing in leave no cached Schedule on the device
  - Register TI01's purge with the S02 sign-out / user-switch hook (`s02-google-workspace-sign-in.md` TI10), **and** purge at sign-in whenever the presented `sub` differs from the `sub` the store holds – covering a session that ended without a clean sign-out. Privacy requirement: a shared device must never show one employee the previous signer's Conference.
  - **Verify**: `Test (S06): after sign-out the store is empty and an offline launch shows no conference; after a kill-then-sign-in as a different sub, no conference name, session title or timestamp from the previous sub is readable from storage or the UI`

- [ ] **TI09** The offline experience offers no mutating action and queues nothing
  - Join, leave and any schedule-editing affordance is unavailable or refused while offline with a message stating a connection is required. No outbox, replay queue or deferred-submission path is introduced anywhere (`docs/PRODUCT.md#anti-goals`).
  - **Verify**: `Test (S07): every mutating affordance is disabled or refused while offline; after reconnect no request is submitted that was initiated offline, and no pending-write record exists in device storage`

- [ ] **TI10** The web build launches with no connection
  - A service worker precaches the built static assets only – no API response and no user data enters Cache Storage, so TI08's purge remains complete. The Capacitor shells already serve assets locally and need no equivalent.
  - **Verify**: `Test: a cold launch of the web build with the network disabled reaches the schedule view (rendering TI04 or TI05) rather than a browser offline error; Cache Storage contains no API response or user data after a cached schedule read`

- [ ] **TI11** The offline states are legible across the three target widths
  - Cached-with-elapsed-age label, "not available offline" state and the "what changed" summary; fluid layout per `AGENTS.md`. Long session titles in the summary must wrap rather than overflow.
  - **Verify**: `Screenshots at 375px, 768px and 1280px show the cached-with-age label, the not-available-offline state and a three-item what-changed summary fully visible with no horizontal body scroll`

### Testing Strategy

- Offline must be simulated by making requests fail (and by disabling the network at the browser/driver level), not by stubbing an `isOffline` flag – a stubbed flag passes while the real captive-portal and timeout paths still hang.
- TI08's assertions inspect the underlying store as well as the UI: a rendering that merely hides another user's data while the entry survives in IndexedDB is the failure this scenario exists to catch.
- TI04 and TI07 run under at least one non-UTC process/browser timezone so a `Date` coercion introduced by the cache round trip fails the test rather than passing locally (S04 contract).
- The S08 highlight test must destroy in-memory state between write and read – a fresh store/module instance, not a same-session read – or it passes on S06's surviving in-memory offset and proves nothing about rehydration. Inject the device clock (as S06 does) so the +3h skew and the elapsed interval are both controlled.

### Execution Contract

- Requires S06 (schedule read model, cache envelope, clock module) and S09 (online refresh path, envelope-diff function) to have landed – TI02, TI04, TI06 and TI07 extend their surfaces and must not define parallel ones. If S09's diff function is not reachable from this story's summary module, wire it rather than writing a second copy.
- TI01 precedes TI02–TI08 (all use the store); TI02 precedes TI03 and TI06; TI06 precedes TI07 (the summary diffs what the refresh fetched).


## Implementation Observations

> _Managed by exec-spec post-implementation – append-only._

_No observations recorded yet._
