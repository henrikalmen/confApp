# S04: Offline Post-it Queueing

**Plan**: docs/specs/session-activities/plan.json
**Story-ID**: S04

## Feature Overview and Goal

**Intent**: A dead spot in the venue must not cost an Attendee the idea they have just typed – the Post-it is held on their device and still reaches the Board when the signal returns, even if the Facilitator closed the Round while they were out of coverage.

**Expected Outcomes**:

- [OC01] A Post-it typed with no connection is shown as pending on that device, survives a force-quit and relaunch, and reaches the Board for everyone once connectivity returns – and nothing is silently dropped: a retry that fails again leaves the item queued, and an item whose Round no longer exists comes back to its author with its text intact.
- [OC02] The closed-Round rule reads the same from both sides: a *live* contribution to a closed Round is refused (FR3) while an *offline-composed* one is accepted and marked as having arrived late (FR6), and a Round reopened before the queue drains takes it as an ordinary contribution with no late marking.
- [OC03] Queued Post-its belong to the Member who composed them and are gone from the device on sign-out and on user switch, through the purge that already exists rather than a second teardown path.
- [OC04] The device gains exactly one new offline capability – holding a Post-it composed against a Round it had already rendered open – and no other: no offline Round browsing, no queued Vote, no general outbox.


## Required Context

- `docs/specs/session-activities/prd.md#fr6-offline-post-it-queueing` – the contract this FIS implements: six acceptance criteria – including the bolded **"A retried send produces one Post-it, not two"**, which makes the submission identity a written requirement rather than an inference – the two validation rules (same text validation applied *on arrival*; queued items belong to their composer and are discarded on sign-out or user switch, consistent with the existing cache purge) and the three error-handling rules, the middle of which is the ambiguous-outcome retry. **Binding Constraint (FR6)**, from `prd.md#constraints`: "**Offline support must not widen** beyond schedule reads and Post-it queueing (`AGENTS.md`)." Read it; do not restate it.
- `docs/specs/session-activities/prd.md#fr3-named-post-it-contribution` – **the other half of the one rule this story completes.** Its final acceptance criterion scopes S02's refusal to *live* submission and names FR6 as "the one deliberate exception"; its Error Handling gives the closed-Round refusal wording. **Binding Constraint (FR3)**: "Author identity is taken from the authenticated credential, never from the request body" – which for a queued item means the credential presented at *drain* time, not anything stored in the queue.
- `docs/specs/session-activities/prd.md#constraints` – three further Binding Constraints bind this story. **(FR1)** "**Plain PostgreSQL only**" – the late-arrival marker and the submission identity are ordinary columns and an ordinary unique constraint (ADR-003). **(FR2)** "**No in-process state between requests**" – a drain may hit any replica, so nothing about a queued submission may live in API memory. This is precisely why a retry is de-duplicated by a database constraint and never by an application pre-read: the first attempt and its retry can be served by different replicas. **(FR4)** "**Vote anonymity is a hard, storage-level constraint** […] A schema that *could* deanonymize is a defect" – this story is where that constraint is most easily broken by generalisation: a queued Vote would be a device-held record joining a Member to a ballot, so the queue holds Post-its and nothing else.
- `docs/specs/session-activities/prd.md#edge-cases` – the two rows that are this story's core interaction: "Offline Post-it syncs after close → Accepted, flagged late, appears on the Board" and "Offline Post-it syncs after the Round reopened → Ordinary contribution, no late flag".
- `docs/specs/session-activities/prd.md#data-requirements` – the Post-it row: text, author identity (the OIDC `sub`, never the email), created and last-edited times, **and a late-arrival marker**. That marker plus the submission identity FR6's bolded criterion requires are this story's whole schema delta, over S02 TI01's `post_it` (`id, round_id, conference_id, author_sub, text, created_at, edited_at`).
- `docs/specs/session-activities/plan.json#sharedDecisions` – "**Round entity and its open/closed state model**": S01 owns whether an Activity is running and this story reads that one model. Introducing a second notion of open/closed – a client-side belief, a cached Round state, a grace window – is the failure this decision exists to prevent.
- `docs/specs/conference-setup-and-schedule/s10-offline-schedule-access.md` – the offline boundary this queue rides, and **the one shipped document this story must correct**. Read its structural criterion "No write, mutation, or deferred-submission path exists in the offline layer", its scenario S07 ("no pending write, outbox entry, or replay queue is created anywhere on the device") and its TI09 Verify ("no pending-write record exists in device storage"). All three were written when Post-it queueing did not yet exist and are phrased **device-wide**, so all three are false as written once TI01 lands – while every behaviour they guard still holds of the *schedule* path. TI10 narrows the wording to that path; nothing S10 prohibited becomes permitted. Post-it queueing is the second of the two allowances `AGENTS.md` names, and is the only thing this story adds.
- `web/src/offline/schedule-cache.ts` – the existing storage module: `open` / `DATABASE_VERSION`, `transact`, `exclusively`, `purgeNow`, `adoptCacheOwner`, `setCacheIdentity` / `cacheIdentity`. The queue reuses all of it. Its module doc currently asserts "There is no outbox, no queue, no replay buffer" and "The one module that touches offline storage" – both become false and are this story's to correct.
- `web/src/offline/use-online.ts` – `useOnline` is "a hint, never a gate on rendering": `navigator.onLine` is `true` behind a captive portal and on dead venue wifi. What decides that an item must queue is the *request failing*, not this signal.
- `docs/LEARNINGS.md#testing` – three traps that bear directly: "Seeding the offline cache without claiming ownership purges it" (adopt, write, then assert); "Assert cache contents, not the requests issued"; "A new required field on a persisted type breaks fixtures with no compile error".
- `docs/LEARNINGS.md#browser-testing--jsdom` – jsdom has no Web Storage and no jest-dom in this workspace; assert plain DOM properties. `page.goto` resolves long before the app's IndexedDB claim lands – wait for the owner marker.
- `AGENTS.md` – Do Not / Never, in particular "Never widen offline support beyond schedule reads and post-it queueing", "Never key a user on their email address", "Never rely on in-process state between requests", and "Never ship a fixed-width or desktop-only layout".
- `docs/UBIQUITOUS_LANGUAGE.md` – **Post-it**, **Post-it Round**, **Activity**. This story introduces no new domain vocabulary; "queue" is a device-local mechanism, not a domain term.


## Deeper Context

- `docs/PRODUCT.md#anti-goals` – "Not fully offline." Broader offline sync and conflict resolution are the anti-goal this story is most likely to drift across.
- `docs/specs/session-activities/prd.md#decisions-log` – two rows. "A Post-it syncing after its Round closed is accepted, flagged late", with its rejected alternatives: refusing while preserving the text (the idea still misses the report) and a grace window (an underivable duration plus a second refusal path). And "A queued Post-it carries a submission identity so a retry cannot duplicate it", whose rejected alternatives are retrying without one (duplicates under a real name) and giving up after one failure (breaks the no-loss promise).
- `visual/offline-schedule.spec.ts#waitForCacheClaimed` – the Playwright helper for the IndexedDB claim race; reuse it rather than fixing the pattern locally again (`docs/LEARNINGS.md#testing`, "A harness fix made in one spec is not a fix").
- `web/test/schedule-cache.test.ts` – the `fake-indexeddb` harness, the adopt-then-write ordering, and how a purge is asserted by key absence rather than by a rendering.


## Acceptance Scenarios

- [x] **S01 [OC01] [TI01,TI03,TI04,TI05] A Post-it typed in a dead spot is held pending, survives a relaunch, and lands on the Board when the signal returns**
  - **Given** Nadia is a Member of "Kickoff 2026" with the Post-it Round "What slowed us down?" open on her phone, and the venue wifi dies
  - **When** she types "Nobody owns the staging environment" and submits, then force-quits confApp and relaunches it, still with no connection
  - **Then** her Post-it is on her own Board under her name, marked pending rather than posted, both before and after the relaunch
  - **And** when connectivity returns it is sent, appears on every other participant's Board under her name within seconds, and the pending marking is gone from hers

- [x] **S02 [OC02] [TI06,TI07,TI08] One rule, two halves: the same closed Round refuses Nadia's live Post-it and accepts her offline-composed one, marked late**
  - **Given** "What slowed us down?" was open, Nadia composed "Nobody owns the staging environment" while her phone had no signal, and the Facilitator has since closed the Round
  - **When** Björn – online throughout – types a Post-it into the same closed Round and submits it, and Nadia's phone regains connectivity moments later
  - **Then** Björn's live submission is refused by the API with the round-closed refusal and his typed text stays on his screen
  - **And** Nadia's queued Post-it is accepted into the same closed Round, appears on the Board under her name, and is distinguishable everywhere it appears as having arrived after the Round closed

- [x] **S03 [OC02] [TI07,TI08] A Round reopened before the queue drains takes the same Post-it as an ordinary contribution**
  - **Given** Nadia's "Nobody owns the staging environment" is queued on her phone, the Facilitator closed "What slowed us down?" and then reopened it because the room had more to say
  - **When** her phone regains connectivity and the item is sent
  - **Then** the Post-it lands as an ordinary contribution with no late marking anywhere it appears – the marking follows the Round's state at the moment the Post-it is written, not the state Nadia's device last saw

- [x] **S04 [OC03] [TI01,TI02] A shared tablet hands the next employee nothing of the previous signer's queued Post-its**
  - **Given** Anna has two Post-its queued and unsent on a shared tablet
  - **When** Anna signs out and Björn signs in on the same tablet
  - **Then** no queued text, author name or Round reference of Anna's is readable or discoverable by Björn anywhere in the app or in device storage, and nothing of Anna's is ever sent under Björn's credential
  - **And** the same holds when Anna's session ended without a clean sign-out – the app was killed – and Björn signs in on the next launch

- [x] **S05 [OC01] [TI05,TI06,TI07] A send that fails again keeps the Post-it queued, and a send retried after an ambiguous outcome produces one Post-it, not two**
  - **Given** Nadia has "Nobody owns the staging environment" queued, and the first send attempt reaches the API but its response never reaches her phone
  - **When** connectivity flaps and the item is attempted a second time, and a third attempt fails outright at the network
  - **Then** exactly one Post-it with that text exists on the Board
  - **And** after the failing attempt the item is still queued and still shown as pending, with its text unchanged – nothing is discarded on a failure

- [x] **S06 [OC01] [TI09] A queued Post-it whose Round has been deleted comes back to its author with its text**
  - **Given** Nadia has a Post-it queued against "What slowed us down?" and an Admin deletes the Round's Session before her phone reconnects
  - **When** the item is sent and the API refuses it because the Round no longer exists
  - **Then** Nadia is shown her own text and told why it could not be posted – it is not silently dropped and it does not sit retrying forever
  - **And** the item leaves the device only once she has acted on it, not on the refusal itself

- [x] **S07 [OC04] [TI03,TI10] Offline capability is not widened: a cold offline launch offers no way to compose, and no Vote is ever held on the device**
  - **Given** Nadia launches confApp with no connection, having never opened "What slowed us down?" on this device in this app session
  - **When** she navigates to the cached Schedule and opens the Session
  - **Then** the cached Schedule reads exactly as S10 already makes it read, and no Round content, no compose box and no vote affordance is offered offline – the Round is only composable against once the app has rendered it open from the server
  - **And** attempting to cast a Vote with no connection queues nothing anywhere on the device: it is refused as requiring a connection


## Structural Criteria

- [x] The queue lives in `web/src/offline/` and reuses `schedule-cache.ts`'s database, transaction and mutual-exclusion helpers. No second IndexedDB database, no `localStorage` fallback, and no Capacitor storage plugin is introduced.
- [x] Nothing but a Post-it is ever held for later on the device: no Vote, no Round open/close/reopen, no schedule edit, no join or leave has a queued, deferred or replayed write path. S10's offline scenarios and `web/test/offline-cache-purge.test.tsx` still pass, and the structural half of `web/test/AttendeeScheduleOffline.test.tsx` stays green **without being edited** – S10's guarantee is narrowed in wording to the schedule path by TI10, never weakened.
- [x] Queue entries are keyed under the authenticated `sub`, never an email, and no code path reads or sends an entry written under a different `sub`.
- [x] The queue store is emptied inside the same purge and owner-adoption operations that empty the schedule cache – this story registers no independent auth teardown hook.
- [x] Whether a Post-it is marked late is decided server-side from S01's Round state at the moment the row is written; no client-supplied timestamp, flag or device clock reading decides it, and no second open/closed model is introduced.
- [x] The late-arrival marker and the submission identity are plain PostgreSQL columns on the Post-it row, added by a migration in `db/migrations/` following the existing file convention. No provider-proprietary feature is used.
- [x] Exactly-once arrival is enforced by a **database uniqueness constraint on `(round_id, submission_id)`**, never by an application read-then-insert: two attempts at one queued item may be served by different API replicas, so a check held anywhere in process is not a check at all (Binding Constraint FR2, `plan.json#bindingConstraints`). No per-replica or in-memory record of seen submission identities exists, and removing the application's own duplicate handling still leaves exactly one Post-it on the Board.
- [x] No queued submission depends on API in-process state: a drain whose attempts land on different replicas produces the same outcome as one that does not.
- [x] Cached Schedule values are untouched by this story – no `Date`, `Date.parse` or JSON reviver is introduced on any stored value, and no cached day, start time or end time changes shape.
- [x] The pending, late-arrival and returned-to-author states are legible with no horizontal body scroll at 375px, 768px and 1280px.


## Scope & Boundaries

### Work Areas

- `web/src/offline/post-it-queue.ts` (new) – the device-held queue: write, list for the signed-in `sub`, mark attempted, remove.
- `web/src/offline/schedule-cache.ts` – `DATABASE_VERSION` and `onupgradeneeded` widened to create the queue store; `purgeNow` and `adoptCacheOwner` widened to clear it; module boundary documentation corrected.
- The Post-it contribution surface from S02 – queue-on-failed-submission, and the pending / late / returned-to-author renderings on the Board.
- The drain trigger – on the `online` event and on app start, sequential per item.
- The API contribution route from S02 – the offline-composed marker, the submission identity, and the two branches of the closed-Round rule.
- `db/migrations/` – the Post-it late-arrival marker column, the `submission_id` column, and the `(round_id, submission_id)` uniqueness constraint that makes a retry idempotent.
- `docs/specs/conference-setup-and-schedule/s10-offline-schedule-access.md` – S10's device-wide offline-write wording narrowed to the schedule path (documentation only; no S10 behaviour changes).

### What We're NOT Doing

- **No offline reading of Rounds or their contents** -- only a Round the app has already rendered open can be composed against; caching Round state would widen offline past the two allowances `AGENTS.md` names.
- **No general outbox, sync engine or conflict resolution** -- an explicit product anti-goal (`docs/PRODUCT.md#anti-goals`); this queue holds one kind of item, sends it once, and has no merge semantics.
- **No queued Votes** -- a ballot held on a device beside its owner's identity is a stored link between a Member and their Vote, which Binding Constraint FR4 forbids at the storage level regardless of where the storage is.
- **No grace window or time-based acceptance rule** -- rejected in the PRD's Decisions Log as an underivable duration plus a second refusal path; the Round's state at the instant of the write is the entire test.
- **No editing or deleting a Post-it while it is still queued on the device** -- S02 owns edit and delete on a *written* Post-it and enforces its open-Round rule inside the write statement, which is the only place that rule can be enforced. Text sitting in the queue has no row to guard, so a device-side editor would be a second compose surface carrying a second copy of the 280-character validation. Once the item lands, S02's ordinary rule applies to it like any other Post-it -- editable if it arrived into an open or reopened Round (S03), not if it arrived into a closed one.


## Architecture Decision

**Approach**: The queue is a second object store inside the existing `confapp-offline` IndexedDB database, filled by a *submission failing* rather than by `navigator.onLine`, and drained sequentially on reconnect carrying a submission identity minted at compose time, whose repeat is refused by a `(round_id, submission_id)` unique constraint rather than by any application check; the API's closed-Round rule becomes one predicate with two branches, where an offline-composed marker on the request unlocks acceptance and the Round's state at the instant of the insert decides the late flag.
**Why this over alternatives**: A separate database or a generic outbox would both cross the product's anti-goal and duplicate the purge that already makes a shared tablet safe; deciding lateness from a client timestamp would trust a clock the server cannot check, whereas the Round's own state at write time is a fact the server already holds; and de-duplicating in application code would put the guarantee in exactly the in-process place Binding Constraint FR2 forbids, where two replicas each see a first attempt.


## Code Patterns & External References

```
# type | path#anchor                                      | why needed (intent)
file   | web/src/offline/schedule-cache.ts#transact       | Transaction wrapper – settle on the transaction, not the request; a missing store resolves null
file   | web/src/offline/schedule-cache.ts#exclusively    | Mutual exclusion so a purge and a claim cannot interleave; reuse, do not add a second chain
file   | web/src/offline/schedule-cache.ts#adoptCacheOwner| Fails-closed owner check – the queue must be inside the same unit of work
file   | web/src/offline/use-online.ts#useOnline          | Link hint only; use it to trigger a drain attempt and to label, never to decide
file   | web/src/auth/AuthProvider.tsx                    | Where the purge and owner adoption are already wired – register nothing new here
file   | db/migrations/20260817150000000_session.sql      | Migration file naming and shape; plain PostgreSQL
file   | api/src/errors.ts#ERROR_CODES                    | One stable code per reason, message a displayable sentence
file   | web/test/schedule-cache.test.ts                  | fake-indexeddb harness and the adopt-then-write ordering the offline tests depend on
file   | web/test/AttendeeScheduleOffline.test.tsx        | Shipped offline-layer guard: its file list includes schedule-cache.ts and bans outbox/replay/syncQueue naming
```


## Constraints & Gotchas

- **Critical**: `DATABASE_VERSION` in `schedule-cache.ts` is `1` and `onupgradeneeded` only runs when it rises. A new object store needs the bump, and `transact` resolves `null` rather than throwing when a named store is absent -- so a forgotten bump degrades into a permanently, silently empty queue instead of an error. Must handle by: bumping the version and adding the store behind the same `if (!contains)` guard the existing stores use, so the upgrade is additive for devices already holding a cached Schedule.
- **Avoid**: gating queue-vs-send on `useOnline()` -- `navigator.onLine` is `true` behind a captive portal and on dead venue wifi, which is how an offline path comes to hang forever. Instead: submit, and queue when the request fails; use the online event only to *attempt* a drain.
- **Constraint**: the offline-composed marker is a client assertion the server cannot verify, so an online client could in principle set it to slip a Post-it into a closed Round. Accepted deliberately -- contributions are named, the late marking makes such an arrival visible, and the PRD names no refusal for it. Workaround: none; do **not** add a refusal path, a grace window or a timestamp check, all of which the Decisions Log rejected.
- **Critical**: seeding offline storage without first claiming ownership purges it -- `adoptCacheOwner` fails closed, so an entry written before the claim is deleted and every later "the queue is empty" assertion passes vacuously. Must handle by: adopt, then write, then assert; in Playwright wait for the owner marker rather than for `page.goto` (`visual/offline-schedule.spec.ts#waitForCacheClaimed`).
- **Critical**: `web/test/AttendeeScheduleOffline.test.tsx` (its `describe('the offline layer')` structural half) reads an explicit file list that **includes `offline/schedule-cache.ts`** – the module TI02 widens – strips comments, and asserts no listed source matches `/outbox|replay|pendingWrite|pending[_-]?mutation|syncQueue|conflictResolution/i`. A shipped, passing test therefore turns red the moment a queue store, constant, type or helper is named `syncQueue`, `OUTBOX`, `replayBuffer` or `pendingWrite`. Must handle by: naming everything in the queue after *what it holds* -- `postItQueue`, `POST_IT_QUEUE`, `queuedPostIt` -- none of which the regex matches; and by leaving that file list and that regex untouched, since the one widening this story is licensed for is proved by TI10's behavioural checks, not by relaxing a guard.
- **Avoid**: proving the drain by asserting that a request was issued -- S10's guard was green while its cache key was wrong. Instead: assert the queue is empty *and* the Post-it is on the Board.
- **Constraint**: `web/test/` is outside `tsconfig`'s `include`, so adding a required field to a persisted type breaks fixtures as a silent timeout rather than a compile error -- grep every fixture when the queue entry shape changes.


## Implementation Plan

### Implementation Tasks

- [x] **TI01** Post-its composed on the device persist in the existing offline database under the signed-in `sub`
  - New module `web/src/offline/post-it-queue.ts`, reusing `transact`, `exclusively` and `cacheIdentity` from `web/src/offline/schedule-cache.ts`; a new object store created behind the same `if (!contains)` guard with `DATABASE_VERSION` raised; entries keyed with the `sub` in the key, as `SCHEDULES` already is. No signed-in subject means no key, so the write is dropped rather than guessed at.
  - **Verify**: `Test: an item written under Nadia's sub is read back after the database is reopened, is absent from a listing for Björn's sub, and a device already holding a cached Schedule at the previous database version still reads that Schedule after the upgrade`

- [x] **TI02** Sign-out and user switch discard queued Post-its along with the cached Schedule
  - Widen `purgeNow` and `adoptCacheOwner` in `schedule-cache.ts` to include the queue store in the *same* transaction and the same `exclusively` unit; `web/src/auth/AuthProvider.tsx` already calls both, so no new hook is registered.
  - **Verify**: `Test: after purgeScheduleCache() and after adoptCacheOwner(a different sub), the queue lists nothing and no queue key remains in the store; the existing offline-cache-purge tests still pass`

- [x] **TI03** A submission that does not reach the API leaves the Post-it queued instead of lost
  - On S02's contribution surface, offered only on a Round the app has rendered open; the queue decision is made by the request failing, not by `useOnline` (see Constraints & Gotchas). Each queued item carries a client-generated submission identity, stored *with* the item so it is identical across every retry and across a relaunch rather than regenerated per send; TI05 sends it with every attempt and TI07's uniqueness constraint is what makes the repeat harmless.
  - **Verify**: `Test: with the contribution request rejecting, submitting leaves one queued item carrying the typed text; with it succeeding, the Post-it posts and nothing is queued`

- [x] **TI04** A pending Post-it is visibly distinct from a posted one and survives a relaunch
  - Rendered on the author's own Board under her name, with the pending state conveyed by more than colour; the queue from TI01 is the source of truth after a remount, so no in-memory pending list.
  - **Verify**: `Test: after remounting the app with the store intact, the item still renders under its author's name and still reads as pending, not as posted`

- [x] **TI05** The queue drains on reconnect and on app start, once per item and without duplicating on retry
  - Sequential per item, not parallel; the submission identity from TI03 accompanies each attempt, and the API treats a repeat of the same identity within the same Round as the same contribution rather than a new one (`prd.md#fr6-offline-post-it-queueing`, the bolded criterion). The recognition happens at TI06's route over TI07's constraint – nothing on the client decides it. A failed attempt leaves the item queued and pending.
  - **Verify**: `Test: an attempt whose response is lost, followed by a retry, yields exactly one Post-it on the Board and an empty queue; an attempt that fails at the network leaves exactly one queued item with its text unchanged`

- [x] **TI06** The closed-Round rule is one predicate with two branches at the API, and a repeated submission identity resolves to the contribution already written
  - The contribution route from S02 accepts an offline-composed marker **and** the queued item's submission identity on the request; without the marker a closed Round refuses with S02's round-closed refusal (FR3), with it the write proceeds whatever the Round's state. A repeat of a submission identity already stored for that Round resolves to the Post-it already written and is not a second contribution – enforced by **TI07's `(round_id, submission_id)` uniqueness constraint, which must land first**, with the route mapping the constraint violation onto the existing row rather than pre-reading for one (Binding Constraint FR2). Author identity still comes from the credential presented on *this* request, never from the payload (Binding Constraint FR3).
  - **Verify**: `Test: a contribution to a closed Round without the marker is refused with the round-closed code and message; the same contribution with the marker is accepted; a contribution carrying someone else's author id in its body is attributed to the caller; two requests carrying the same submission identity for the same Round leave exactly one Post-it and both return that same one, with the outcome unchanged when the two requests are handled by separate API processes sharing only the database`

- [x] **TI07** A Post-it row carries a late-arrival marker derived from the Round's state at the moment it is written, and a submission identity the database itself refuses to store twice
  - Migration in `db/migrations/` following `db/migrations/20260817150000000_session.sql`, extending S02 TI01's `post_it` (`id, round_id, conference_id, author_sub, text, created_at, edited_at`) with two plain PostgreSQL columns and one constraint: the late-arrival marker; `submission_id`, null for a live contribution that was never queued; and a **unique constraint on `(round_id, submission_id)`** – PostgreSQL treats nulls as distinct, so live contributions are unaffected. That constraint is the enforcement point for FR6's "one Post-it, not two", **not** an application pre-read, because two attempts at one queued item may land on different replicas (Binding Constraint FR2). The late marker is computed inside the insert from S01's Round state rather than from an earlier read round trip -- the same discipline as `docs/LEARNINGS.md#concurrency` ("Optimistic concurrency belongs in the UPDATE predicate"), and what makes a close racing an arrival impossible to disagree with.
  - **Verify**: `Test: an offline-composed arrival at a closed Round stores the marker set; at an open or reopened Round stores it clear; a close committed while an arrival waits on the row lock never yields a row whose marker disagrees with the Round state the row was written against; a second insert of the same (round_id, submission_id) is refused by the constraint with the application's own duplicate handling bypassed, while two live rows carrying no submission identity both insert; the migration applies and rolls back cleanly`

- [x] **TI08** A late-arriving Post-it is distinguishable as such wherever it appears
  - The marker rides the Post-it in the read model S02 already returns, so every surface showing a Post-it shows it; no separate late-arrivals list and no second read path.
  - **Verify**: `Test: a Post-it stored with the marker set renders with a stated late-arrival indication on the Board, and one without it renders with none`

- [x] **TI09** A queued Post-it whose Round or Session no longer exists returns to its author with its text
  - Distinguish a refusal that will never succeed (the Round is gone) from a failure worth retrying (network, 5xx): only the former stops retrying, and it surfaces the text plus a reason rather than discarding it. The item leaves the device on the author's action, not on the refusal.
  - **Verify**: `Test: a not-found refusal on drain surfaces the queued text and a reason to its author and stops retrying, with the item still on the device until dismissed; a network failure or 5xx instead leaves it queued and pending with no message`

- [x] **TI10** The offline layer's documented boundary states the one widening and nothing more – in this story's module doc **and** in S10's own text, which this story otherwise falsifies
  - Two corrections, both required. **(a)** `web/src/offline/schedule-cache.ts`'s module doc claims "The one module that touches offline storage" and "There is no outbox, no queue, no replay buffer"; both are false after TI01. It names Post-it queueing as the second of the two allowances in `AGENTS.md`, points at `web/src/offline/post-it-queue.ts`, and keeps the anti-goal statement for everything else. **(b)** S10's wording is **device-wide, not schedule-scoped**, so it is false as written the moment TI01 lands: in `docs/specs/conference-setup-and-schedule/s10-offline-schedule-access.md`, scenario S07's "no pending write, outbox entry, or replay queue is created anywhere on the device", TI09's Verify "no pending-write record exists in device storage", and the structural criterion "No write, mutation, or deferred-submission path exists in the offline layer" are each narrowed to the schedule path -- join, leave, schedule edit, Round lifecycle -- naming Post-it queueing as the one licensed exception. S10's guarantee survives **verbatim once scoped**: no S10 behaviour changes, no shipped S10 checkbox is cleared, and nothing S10 already prohibited becomes permitted.
  - **Verify**: `Test: no queued or deferred write path exists for a Vote, a Round lifecycle action, a schedule edit, a join or a leave -- asserted behaviourally by attempting each with the network down and observing a refusal with nothing added to device storage, not by a file-list grep alone (docs/LEARNINGS.md#testing); and S10's S07, its TI09 Verify and its offline-layer structural criterion each name the schedule path rather than the device, while web/test/AttendeeScheduleOffline.test.tsx passes unmodified`

- [x] **TI11** The pending, late and returned-to-author states hold at every supported viewport
  - Phone-first and one-handed at 375px per the PRD's Usability row; the returned-to-author state must show the full typed text without truncating it away.
  - **Verify**: `Test: at 375px, 768px and 1280px the pending, late and returned states render with no horizontal body scroll and the returned text is fully readable`

### Testing Strategy

- The interaction in S02 is the point of this story and must be one test against **one** Round -- a live refusal and a queued acceptance observed on the same closed Round. Two separate tests, each proving one half, are exactly the shape that lets the two rules drift into a contradiction. [TI06]
- Web tests run on `fake-indexeddb` with the jsdom setup in `web/test/setup.ts`; there is no jest-dom, so assert plain DOM properties. Always `adoptCacheOwner` before seeding the queue -- see Constraints & Gotchas. [TI01,TI02]
- The lateness race in TI07 needs a held row lock rather than concurrency, following `docs/LEARNINGS.md#concurrency`: take the lock on a second connection, start the arrival, commit the close, then release. [TI07]
- Before believing any guard written beside its fix, revert the fix and re-run (`docs/LEARNINGS.md#testing`). [TI05,TI07]

### Execution Contract

- TI06 and TI07 extend surfaces S02 creates; both require S02's contribution route and Post-it read model to exist.
- **TI07 must complete before TI06**, against the numbering: TI06's route persists the submission identity and maps a duplicate onto the existing row, both of which need TI07's `submission_id` column and its `(round_id, submission_id)` constraint already migrated.
- TI01 must complete before TI02, TI03 and TI05, which all consume the queue module it creates.


## Implementation Observations

#### DECISION NOTE: offline-drain-is-device-wide

Decision-Key: offline-drain-is-device-wide
Altitude: fis-local
Affected surface: The drain's mount point - moved from web/src/activities/SessionActivitiesPanel.tsx to a PostItQueueDrain mounted once in web/src/App.tsx's signed-in branch, with module-level draining state shared through useSyncExternalStore. Already implemented; this note is provenance.
Decision: The offline Post-it queue drains device-wide rather than per Session panel, so a queued Post-it syncs as soon as connectivity returns whatever the person is looking at. Exactly one drain runs at a time however many surfaces are mounted.
Rationale: FR6 and US09 promise a typed Post-it is not lost and is sent when connectivity returns. A panel-scoped drain did not deliver that - someone who typed offline, left the room and reconnected elsewhere kept a pending item until they navigated back to that specific Session.
Evidence: Raised as an ambiguous-intent finding by S04's quick-review, escalated by the orchestrator because an accepted ambiguous-intent finding contains a story from completion, and decided by the user on 2026-08-29. Proved by a new test file mounting no Session panel at all, red without the shell drain; the shared-tablet identity re-check and S10's single purge path both still go red when reverted.

#### DECISION NOTE: late-marked-post-it-editability-on-reopen

Decision-Key: late-marked-post-it-editability-on-reopen
Altitude: fis-local
Affected surface: The interaction between S04's late-arrival marker and S02's author-may-correct-while-open rule. No code change - this ratifies shipped behaviour.
Decision: A Post-it marked as having arrived late becomes editable again if its Round is reopened, exactly like any other Post-it in an open Round. The late marker records how the Post-it arrived; it is not a lock on it.
Rationale: Keeps S02's single uniform rule - while the Round is open, an author may correct their own Post-it. A second editability rule would contradict it, need its own refusal message, and have to be explained to a room mid-session.
Evidence: Raised as an ambiguous-intent finding by S04's quick-review and decided by the user on 2026-08-29. No implementation follows; the shipped behaviour already matches.

### Run: 2026-08-29 11:00 UTC – observations

#### NOTICED BUT NOT TOUCHING

- `api/test/join-code.test.ts:48` asserts 1000 distinct random join codes and can fail on a birthday collision (pre-existing flake; not this story).
- `npm run format:check` fails on three pre-existing unrelated files: `api/test/join-code.test.ts`, `visual/conferences.spec.ts`, `web/src/components/JoinCodePanel.tsx`. Left untouched.
- `visual/shell.spec.ts` fails 3 cases when port 8080 has no live `/api/health` (environmental; not run here).

#### DECISIONS MADE WHILE IMPLEMENTING (S04)

- **The drain is mounted on the Session Activities panel, not at the app shell.** TI05 says "on the `online` event and on app start"; the panel mount is the app-start moment for this feature, because it is the only surface that can *show* a pending item and the only place a returned-to-author refusal has anywhere to land. A drain at the app root would strand a refused item with no screen reporting it. The drain itself is device-wide - it sends every held item, not only this Session's.
- **The wire and column names are `arrivedAfterClose` / `arrived_after_close`**, a sentence rather than a shade in the UI ("Arrived after this round closed"). "late" alone was rejected as ambiguous on a board.
- **Retryable vs terminal is one exported predicate**, `mayStillBeDelivered` in `web/src/offline/use-post-it-queue.ts`, shared by the compose box and the drain: status 0 or 5xx or a transport throw retries; any other server refusal (4xx) returns the text to its author. Two copies would eventually disagree.
- **`useSignedInName()` was added to `web/src/auth/AuthProvider.tsx`** - a non-throwing read, registering nothing - so a pending Post-it renders under its author's real name without the name being copied into device storage and without the panel becoming unrenderable outside a provider.

#### SPEC-ADJACENT CORRECTIONS (beyond TI10 (a) and (b), same class)

- **`api/test/post-it-structure.test.ts`** - S02's "this story widens offline support by nothing at all" scanned *every* file under `web/src/offline/` for post-it and Round vocabulary. That stated something true of S02 and false of the product: `AGENTS.md` licenses two offline capabilities and S04 is the second. Narrowed to S10's named schedule modules, with the cached-entry shape and the cache module's lack of any send path asserted directly instead. S02's claim is unchanged; nothing it prohibited became permitted.
- **`api/test/post-it-structure.test.ts` / `api/test/round-structure.test.ts`** - the "no body field names the acting identity" guards matched `sub` as a substring, so `body.submissionId` tripped them. Word-bounded to `\bsub\b`; the contribution body schema is now held to the same rule by its own assertion.
- **`web/test/schedule-cache.test.ts#openWithOnly`** - opened the database at a literal version 1. After the bump the module's own upgrade would have *created* the store the fixture exists to withhold, so both "a store the database does not have" tests would have passed vacuously. Now opens at the exported `DATABASE_VERSION`.
- **`visual/offline-schedule.spec.ts`, `visual/offline-session-expiry.spec.ts`** - four `indexedDB.open('confapp-offline', 1)` calls would have thrown `VersionError` against the upgraded database. They now open with no version at all, so they never pin or force a downgrade again.

#### PROVE-IT CHECKS RUN

- Reverted `DATABASE_VERSION` to 1 -> `web/test/post-it-queue.test.ts` "keeps that schedule and gains a working queue" fails. Restored.
- Replaced the in-INSERT marker with a post-write re-read -> `api/test/post-it.integration.test.ts` "marks an arrival from the round state its own write read, not from a later one" fails. Restored.

### Run: 2026-08-29 11:35 UTC – observations

#### QUICK-REVIEW REMEDIATION (fresh-context critic, 15 findings; 11 fixed, 4 noted)

Fixed, each proved load-bearing by reverting the fix and watching the named test go red:

- **The submission identity is now minted before the *first* attempt, not on the way into the queue.** A transport failure looks identical whether the request never left the phone or reached the API, wrote the row and lost its answer; minting on queue-entry gave the retry a different key in the second case and landed one idea twice under a real name. The live POST carries `submissionId` with no `offlineComposed`; the retry carries both. `web/src/api/client.ts#Submission` (was `OfflineComposed`), `SessionActivitiesPanel#contribute`, `usePostItQueue#hold`. Proof: `api/test/post-it.integration.test.ts` "treats an ambiguous live submission and its queued retry as one contribution".
- **The drain captures the signed-in `sub` once and re-checks it before every send.** A hung send outlives a handover on a shared tablet, and re-reading the identity per call would have posted one person's text under the next signer's credential and deleted the queue entry under the wrong key. `web/src/offline/use-post-it-queue.ts#drain`. Proof: `web/test/PostItQueueing.test.tsx` "stops sending when the device changes hands mid-drain".
- **A returned-to-author item whose Round is gone now renders.** Held items were shown per-Round, or panel-level only when the Session read failed - so Scenario S06's actual shape (Session reads fine, Round deleted) had no surface at all and no reachable Discard. `heldElsewhere` in `SessionActivitiesPanel`. The old test stubbed a payload still listing the Round, a combination that cannot occur; it now stubs `rounds: []`.
- **A 401 is retryable, not terminal** - the module already said so in prose. `mayStillBeDelivered`.
- **`purgeNow` clears the stores the database actually has.** Naming the queue store unconditionally made the *whole* shared-tablet purge a silent no-op on any device whose upgrade did not complete. Done through a `presentOnly` option on `transact` and the transaction's own `objectStoreNames` - **one** open, because a second one widened a real timing window and made `visual/offline-schedule.spec.ts` flaky.
- **The duplicate-resolution lookup is scoped** by conference, session and author, like every sibling statement; it could otherwise have answered 200 with another member's text.
- **S02's offline guard is a folder sweep again**, minus three files named one by one, so a *fourth* module in `web/src/offline/` still trips it.
- **`mintSubmissionId` no longer throws outside a secure context** (a `getRandomValues` v4 fallback), and `hold` never throws, so a storage failure always produces a visible refusal.
- **The client "one post-it, not two" test was renamed to what it proves** - that one identity rides every attempt. Exactly-once is a database property and is proved in the integration suite.
- **Overlapping concurrent attempts are now tested** (`Promise.all` across two connection pools), which the sequential test could not distinguish from an application pre-read.
- **The last version-1 pin in `web/test/schedule-cache.test.ts` is gone.**

Noted, not fixed:

- **The drain is still mounted on the Session panel rather than the app shell** (TI05 "on app start"). Moving it needs a device-wide surface for returned-to-author items first, which is a product decision, and without one a refused item would be stranded with nothing reporting it.
- **Leaving a Conference does not discard Post-its queued against it.** The FIS scopes queue teardown to the purge and the owner claim and registers no other hook; adding a leave-time purge is new scope.
- **`queuedKeys()` is unfiltered by design** - it exists to prove "nothing of the previous signer's is left anywhere in here", which a per-subject listing could not state. Documented rather than narrowed.
- **`web/test/AttendeeScheduleOffline.test.tsx:374` still opens the database at version 1.** It is under a no-edit instruction and passes today; it will need the same one-line unpin the next time that file is touched.
- **A late-marked Post-it becomes editable again if its Round reopens** while the marker still asserts when it landed. No requirement covers the pairing; raised as a product question.

Also fixed while remediating: `web/test/PostItBoard.test.tsx` asserted the contribution body equals exactly `{ text }`. Its intent is "no author of any kind", which `submissionId` does not violate, so it now checks the text and that no key names an actor.

### Run: 2026-08-29 14:00 UTC – observations

#### THE DRAIN MOVED TO THE APP SHELL (product decision, 2026-08-29)

The note left above – "the drain is still mounted on the Session panel rather than the app shell" –
is now closed. The product owner decided that a queued Post-it must sync as soon as connectivity
returns whatever the person is looking at, so the drain is device-wide:

- **`web/src/App.tsx`** mounts `<PostItQueueDrain />` inside the signed-in branch. It renders
  nothing; what it owns is the loop's lifetime, which is now the signed-in app's rather than one
  panel's. Signed out there is no drain at all, and the store's "no subject, no key" rule is the
  second half of that.
- **`web/src/offline/use-post-it-queue.ts`** keeps the drain's body verbatim – the captured `sub`,
  the re-check before every send, the sequential loop, `mayStillBeDelivered` – and moves its state
  from component refs to **module level**: one `draining` flag for the device rather than one per
  mount, one listing every surface subscribes to through `useSyncExternalStore`. `usePostItQueue()`
  is now a read of that shared state and starts no drain.
- **`web/src/activities/SessionActivitiesPanel.tsx`** consumes the shared state and no longer owns
  the loop. The `onSent` callback is replaced by a `deliveries` counter plus `useDeliveredPostIts`,
  which re-reads the board when a drain has actually delivered something and never on mount – a
  mount-time re-read would have shifted every stubbed response sequence in the tests and would have
  cost a request per panel open in the app.
- The queue module, the migration, the API route and the purge are **unchanged**. This was a change
  of mount point and ownership, not a rewrite, and it registers no second teardown path.

**One thing was fixed rather than moved**: the in-memory projection now carries the `sub` it was
read for, and a surface renders nothing whose owner is not the signed-in subject. Without it the
first render after a handover would have shown the previous signer's held text under the new name,
for as long as the re-read took – the store on disk is already emptied by `adoptCacheOwner` by then,
but the copy in memory was not.

#### PROVE-IT CHECKS RUN

- **New: `web/test/PostItQueueDrain.test.tsx`**, five cases, none of which mounts
  `SessionActivitiesPanel`. Confirmed **red before green**: with `<PostItQueueDrain />` removed from
  the shell – which is the panel-mounted arrangement as these tests see it, since no panel is on
  screen – "sends a held post-it with no session panel anywhere on screen" and its `online`-event
  sibling both fail with the queue still holding Nadia's item (`expected [ [ 'google-sub-nadia', … ]
  ] to deeply equal []`). Restored: 5/5 green.
- Removed `if (draining) return;` -> "runs one drain at a time however many surfaces are mounted"
  fails, 2 sends instead of 1. Restored.
- Removed the per-send `cacheIdentity() !== sub` re-check -> **both** shared-tablet tests fail, the
  new one and `PostItQueueing.test.tsx`'s "stops sending when the device changes hands mid-drain",
  each with 2 sends instead of 1. Restored.
- Dropped `POST_IT_QUEUE` from `purgeNow`'s transaction -> "leaves no queued post-it readable, and
  no key behind, after a purge", "empties the queue when the next employee claims the device" and
  "hands the next employee nothing of the previous one's queued post-its" all fail. Restored.

#### NOTICED BUT NOT TOUCHING

- **A returned-to-author item is still surfaced only by the Session panel.** The drain can now refuse
  an item while its author is on the schedule, and they see the reason when they next open that
  Session. If the Session itself is deleted there is no surface at all – a device-wide held-items
  list would close that, and it is new scope rather than part of this move.
- `heldAt` collisions: two items held in the same millisecond are ordered by their random submission
  identities, which made a first-draft test flake. The new tests seed from a counter. The stored
  ordering key itself is unchanged.

### Run: 2026-08-29 – gap-review remediation G-01 (drain retry trigger)

#### THE GAP

Mount and `window.'online'` were the drain's only two triggers. `navigator.onLine` reports the link,
not reachability: on dead venue wifi and behind a captive portal it stays `true` and no `online`
event is ever raised – which is the exact state FR6 exists for. A held Post-it was therefore never
retried for as long as the app stayed loaded (under Capacitor, until a force-quit). Moving the drain
to the app shell had fixed *where* it runs, not *when*.

#### THE CORRECTION

The drain now also runs on the application's single foreground tick – **one more consumer of the one
cadence, not a second loop**. `web/src/poll/use-watermark-poll.ts` keeps sole ownership of the
cadence constant, the interval and the `visibilitychange` / `focus` / `online` registrations; it
announces each tick through a new seam, `web/src/tick/foreground-tick.ts`, and `PostItQueueDrain`
subscribes. The drain owns no timer, no cadence constant, no in-flight latch and no listener of its
own, and it is not a `useWatermarkPoll` call site.

The seam sits outside `poll/` on purpose: S03's structural guard keeps every source under
`offline/` clear of poll vocabulary (`poll`), so importing the loop module by path would have
tripped a shipped guard. No guard was widened, relaxed or exempted.

The tick is announced *past* the loop's `document.hidden` check (a view nobody is looking at is a
view nothing should spend battery on) and *before* its in-flight latch (that latch is about the
poll's own request overlapping itself). The drain's tick handler is gated on the published
projection – it looks only while the device is holding something sendable – so an empty queue costs
a comparison rather than an IndexedDB read and a publish every few seconds. The `online` handler is
deliberately left ungated: the link returning is rare and is the one moment worth reading the store
itself.

#### RED BEFORE GREEN

- New: `web/test/PostItQueueDrain.test.tsx` – "retries on the shared tick, with the link never
  dropping and no online event". `navigator.onLine` is `true` at both ends, no `online` event is
  ever dispatched, the first send meets a transport throw and the access point silently starts
  forwarding again. Only `setInterval` is faked, so everything else runs on the real clock. Red
  against the two-trigger arrangement (`expected [ [ 'google-sub-nadia', … ] ] to deeply equal []`),
  green after.
- The three S04 properties re-confirmed red when reverted, on top of the change: removing
  `if (draining) return;` fails "runs one drain at a time however many surfaces are mounted"
  (2 sends); removing the per-send `cacheIdentity() !== sub` re-check fails "stops sending when the
  device changes hands mid-drain" (2 sends, the second under the next signer); dropping
  `POST_IT_QUEUE` from `purgeNow`'s transaction fails three `web/test/post-it-queue.test.ts` cases.
  All restored.

#### NOTICED BUT NOT TOUCHING

- **With no watermark poll mounted, nothing ticks.** The seam is not a scheduler. In the shell that
  is not a hole – `PostItQueueDrain` and `AttendeeSchedulePanel` are siblings in the signed-in
  branch, and the panel polls whenever its schedule is `ready` or `cached`, which it must already be
  for a Round to have been rendered and typed into. A device in the terminal
  `unavailable-offline` state polls nothing and still relies on mount and `online`.

### Run: 2026-08-29 – gap-review remediation G-03 (never-opened Round)

`contribute`'s offline-composed branch unlocked *any* Round that was not currently open, including
one authored and never opened, and then stamped the arrival `arrived_after_close`. A Round is
`closed` from the moment it is created, so state alone cannot tell a Round that finished from one
nobody ever started – `open` already separates the two through `closed_at` for the reopen rule, and
`contribute` now does the same on the arrival side:

`and (r.state = 'open' or ($6::boolean and r.closed_at is not null))`

A queued Post-it is accepted late only into a Round that actually ran and closed; one aimed at a
Round that never ran is refused with `POST_IT_ROUND_CLOSED`, exactly as a live contribution is. The
late marker is still `r.state <> 'open'` read in the same statement, so a Round reopened before the
device drained still takes the item as an ordinary contribution.

Red before green: new case in `api/test/post-it.integration.test.ts` – "refuses an offline-composed
post-it to a round that was never opened", which asserts `closed_at is null` first so the case under
test is genuinely the never-opened one. Against the old predicate it returned `200` with
`arrivedAfterClose: true`; after the fix, `409` / `POST_IT_ROUND_CLOSED`, no row written and an empty
board.
