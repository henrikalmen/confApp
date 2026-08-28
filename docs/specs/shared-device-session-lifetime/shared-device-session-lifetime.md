# Session Lifetime and Launch Identity

## Feature Overview and Goal

**Intent**: ADR-005 deleted the refusal-code classification, leaving explicit sign-out as the only
thing that ever ends a stored session – so a phone that is never signed out stays signed in for the
life of the installation, and someone who picks up a colleague's device reads their data with
nothing on screen saying whose session it is.

**Expected Outcomes**:

- [OC01] An attendee stays signed in across the whole multi-day conference without re-entering
  credentials, and the session then stops on its own – bounded by the latest conference they joined,
  or by their sign-in when they have joined none.
- [OC02] A session cleared for passing its bound is a real data boundary, not a UI state: it goes
  through S02's sign-out path, so S10's cache purge fires and no cached schedule survives the
  session it was read under.
- [OC03] Someone launching confApp on a device that is not theirs sees whose session it is and can
  switch to their own in one tap, without re-authenticating the existing one.

## Required Context

- `docs/specs/shared-device-session-lifetime/requirements-clarification.md` – the ratified rule this
  FIS implements. Its **Session lifetime rule**, **Edge Cases** and **Decisions Log** are the
  contract; the *Not Doing* section names the rejected designs, one of which is the intuitive fix.
- `docs/adrs/ADR-005-bound-access-by-time-not-by-refusal-code.md#decision` – point 6 promotes this
  feature to load-bearing. Read points 4 and 5 too: eviction and the second cache horizon both
  landed after the clarification was written and change how this bound must read its inputs (see
  Constraints & Gotchas).
- `web/src/auth/session.ts#StoredSession` – the object that gains the bound's second term, and
  `clearSession` (line ~261), the single teardown path this feature must call rather than duplicate.
  `current()` is **synchronous** and read on hot paths, including `setCacheIdentity`.
- `web/src/auth/AuthProvider.tsx` – the restore path. The `completeRedirect` → `nothing-to-do` →
  `const existing = session.current()` branch is where a cold-launch session is adopted, and is the
  only place the bound can be evaluated before the app settles to `signed-in`.
- `web/src/offline/readability-window.ts#READABILITY_MARGIN_DAYS` – the margin this feature shares.
  One constant, imported; the clarification's "recommended 7 days" is ratified by that import.
- `web/src/offline/schedule-cache.ts#readCachedSchedulesFor` – the raw per-`sub` entry set the bound
  reads. **Not** `listCachedConferences`, which filters and evicts (Constraints & Gotchas).
- `docs/specs/conference-setup-and-schedule/s02-google-workspace-sign-in.md#implementation-plan` –
  TI10 settled "access ends at the next request; no server-side eviction", and OC01 there
  ("stays signed in across the multi-day conference") must still hold unchanged.

## Deeper Context

- `docs/specs/offline-session-expiry/offline-session-expiry.md#implementation-observations` – the
  `SUPERSEDED SPEC TEXT` block records what ADR-005 changed and why the fail-closed predicate was
  made total before eviction was wired. Same class of hazard applies here.
- `web/src/clock/effective-clock.ts#rehydrateClock` – how "now" is derived from a persisted anchor
  without a raw device clock, and the tamper limitation that comes with it.
- `docs/LEARNINGS.md` – § Testing, in particular "a regression test written beside its fix usually
  passes without the fix" and "never wait on the value you are about to assert".

## Acceptance Scenarios

- [x] **S01 [OC01] [TI01,TI02,TI03] A session lives through the conference it belongs to**
  - **Given** Nadia signed in on 1 September 2026 and joined "Kickoff 2026" (15–18 September 2026),
    the margin is 7 days, and it is 20 September 2026
  - **When** she launches confApp
  - **Then** she is signed in without re-authenticating, and the schedule renders

- [x] **S02 [OC01,OC02] [TI02,TI03] A session past its bound is cleared on launch and takes the cache with it**
  - **Given** the same session, but it is now 26 September 2026 – past "Kickoff 2026"'s end plus the
    margin, with no other conference joined
  - **When** she launches confApp
  - **Then** the sign-in screen is shown, and the cached schedule for "Kickoff 2026" is gone from
    IndexedDB – asserted on the store's contents, not on a purge function having been called

- [x] **S03 [OC01] [TI02] Two joined conferences bound by the later one, not the earlier**
  - **Given** Nadia joined "Autumn Offsite" (ended 3 October 2025) and "Kickoff 2026" (15–18
    September 2026), both cached, and it is 20 September 2026
  - **When** she launches confApp
  - **Then** she is still signed in – the ended conference does not shorten the bound

- [x] **S04 [OC01] [TI01,TI02] Having joined nothing, the bound runs from sign-in**
  - **Given** Bram signed in on 1 September 2026 and has joined no conference, so nothing is cached
  - **When** he launches confApp on 5 September 2026, and again on 9 September 2026
  - **Then** the first launch leaves him signed in and the second shows the sign-in screen

- [x] **S05 [OC01] [TI02,TI03] A stale token is not an expired session**
  - **Given** a stored session whose ID token expired hours ago, inside its conference's bound
  - **When** confApp launches
  - **Then** the session stands and the schedule renders – token expiry is never an input to the
    bound
  - **Proof**: `web/test/auth-session.test.ts#never navigates from the credential accessor, however stale the stored token is` – green – parity/regression

- [x] **S06 [OC03] [TI05,TI06] Switching account on someone else's device clears it cleanly**
  - **Given** Nadia's session is stored and within its bound, and Bram picks the phone up online
  - **When** he launches confApp, reads the identity shown on the launch screen, and taps switch
  - **Then** the displayed identity is Nadia's before the tap, the tap performs an ordinary
    sign-out – firing the same purge as the sign-out control – and the sign-in screen follows with
    no cached schedule left for Nadia

- [x] **S07 [OC03] [TI06] Switch while offline refuses rather than stranding the device**
  - **Given** a stored session within its bound and no connectivity
  - **When** the switch control is used
  - **Then** the existing session is still stored and still signed in, and the reason is shown –
    clearing it offline would leave the device with neither a session nor a way to get one

## Structural Criteria

- [x] The session bound reads `expiresAt` nowhere. Token expiry and session lifetime are separate
      values with separate purposes, and conflating them signs attendees out roughly hourly.
- [x] Exactly one margin constant governs both this bound and the offline readability window – the
      bound imports `READABILITY_MARGIN_DAYS` rather than restating `7`.
- [x] Clearing on an expired bound goes through the existing `clearSession` path and its
      `onSessionCleared` hook; no second teardown path is introduced.
- [x] `current()` remains synchronous and free of the bound – it is read on hot paths including
      `setCacheIdentity`, and the conference dates the bound needs come from IndexedDB.
- [x] A cached schedule can never outlive the session it was read under: for every cached entry,
      the readability horizon is at or below the session bound.
- [x] Missing or malformed inputs never produce an unbounded session.
- [x] S02's and S10's existing suites pass unmodified.

## Scope & Boundaries

### Work Areas

- `web/src/auth/session.ts` – `StoredSession` gains the sign-in reading; the bound's evaluation and
  clearing entry point.
- A session-bound predicate module beside `web/src/offline/readability-window.ts`, sharing its
  margin constant.
- `web/src/auth/AuthProvider.tsx` – the cold-launch restore path where the bound is evaluated.
- `web/src/App.tsx` – the header identity block and the new switch control.
- `web/test/` – `auth-session.test.ts`, `auth-shell.test.tsx`, and a new bound suite.

### What We're NOT Doing

- **Re-evaluating the bound while the app is open** – launch-only. A phone-first app is opened
  repeatedly during an event; a tablet left open for days outlives its bound until next launch, and
  that is the accepted cost of not putting a timer on every session.
- **Extending an expired-but-uncleared session by joining a conference** – the bound is evaluated at
  launch before any join is possible, so a join extends it from the next launch. Stated so an
  implementer does not have to guess.
- **A server-side session or revocation endpoint** – S02 TI10 settled this and ADR-005 did not
  reopen it. The bound is client-side, consistent with "access ends at the next request".
- **Deciding what "prominent" means beyond the existing header treatment** – the clarification
  parks this for a wireframe pass once the schedule screen's layout settles. This FIS makes the
  identity present and the switch reachable; it does not redesign the header.
- **Expiring at the token's `expiresAt`** – explicitly rejected upstream. Recorded here because it
  is the intuitive implementation and it breaks S02 OC01 outright.

## Architecture Decision

**Approach**: the bound is evaluated once per launch, asynchronously, in `AuthProvider`'s restore
path, from a pure predicate that takes the stored session and the raw cached entries.
**Why this over alternatives**: the conference term's inputs live in IndexedDB, which is async,
while `current()` is synchronous and read on hot paths – so the bound cannot live inside `current()`
without making every credential read async, and evaluating it anywhere later than the restore path
would let one render of another person's data through first.

## Technical Overview

Two terms, and the later one wins: `max( max over cached conferences of (endDate + margin),
signedInAt + margin )`. The first term is what honours OC01 across an event; the second is what
bounds someone who joined nothing, and what the first falls back to when no conference data is
available. The terms use different clocks by design – the conference term compares calendar days on
the rehydrated effective clock, exactly as the readability window does, because it gates data that
renders offline; the sign-in term compares against the raw device clock, because in that state
nothing is cached and nothing renders offline, so there is no offline data for a skewed clock to
expose. That split is deliberate and is the one place this feature departs from S10's "no raw device
clock on any offline path".

## Code Patterns & External References

```
# type | path#anchor                                      | why needed (intent)
file   | web/src/offline/readability-window.ts#withinReadabilityWindow | Predicate shape: pure, injectable clock, total input validation, fails closed
file   | web/src/clock/effective-clock.ts#rehydrateClock  | Deriving "now" from a persisted anchor without a raw device clock
file   | web/src/offline/schedule-cache.ts#readCachedSchedulesFor | The raw per-sub entry set the bound reads
file   | web/src/auth/session.ts#clearSession             | The single teardown path; fires the hook S10's purge is registered on
file   | web/src/offline/use-online.ts#useOnline          | The connectivity hint for gating the switch control
```

## Constraints & Gotchas

- **Critical**: the bound must read `readCachedSchedulesFor`, **not** `listCachedConferences`. The
  latter applies the readability window and now *evicts* what it filters (ADR-005). An entry
  withheld by the 30-day sync horizon can still carry the largest `endDate` on the device – a
  conference joined 40 days early – so a bound computed from the filtered list would drop the very
  date that justifies the session and sign the attendee out before their conference began.
- **Critical**: evaluate the bound before anything on the launch path evicts. `listCachedConferences`
  and `readOfflineSchedule` both delete lapsed entries as a side effect, and an evicted entry's
  `endDate` is gone for good. The restore path runs before `AttendeeSchedulePanel` mounts, which
  gives the right order today; a Verify line must pin it rather than rely on it.
- **Avoid**: treating a session that predates this feature as expired. Existing devices carry a
  `StoredSession` with no sign-in reading, and failing those closed signs out every current user on
  deploy. **Instead**: backfill the field once, persist it, and read the stored value thereafter –
  backfilling on every read would reset the margin each launch and make the session unbounded, which
  is the one outcome the clarification's Error Handling table forbids.
- **Constraint**: the bound is advisory against a device clock moved backwards, exactly as the
  readability window is. Accepted upstream for the same reasons; do not add a high-water mark here
  without reopening that decision for both.
- **Avoid**: asserting the purge by spying on `purgeScheduleCache`. **Instead**: assert the store is
  empty – S10's own learning is that a guard which watches the call and not the cache stays green
  while the key is wrong.
- **Constraint**: once ADR-005's 30-day sync horizon actually evicts an entry, that conference's
  `endDate` is gone and the bound falls back to the sign-in term – so an attendee who joins a
  conference well ahead and then stays offline past 30 days loses offline access (ADR-005's accepted
  cost) *and* is signed out on the next launch. Defined behaviour, not a hole: they sign in again
  when next online and the cache re-primes. Recorded because the clarification predates the second
  horizon and never weighed this compound case; raise it if early joining turns out to be common.

## Implementation Plan

### Implementation Tasks

- [x] **TI01** A stored session carries the moment it was established, and sessions written before
      this feature acquire one exactly once
  - `StoredSession` gains a sign-in reading in milliseconds. Persisted at sign-in in
    `session.ts#completeRedirect`'s success branch; a session read back without one is backfilled
    and written back, never recomputed on later reads.
  - **Verify**: `Test: a session stored without the field gets one on first read, and the value is unchanged after two further reads`

- [x] **TI02** A pure predicate answers whether a stored session is still within its bound
  - Takes the session and the raw cached entries; returns the later of the conference term and the
    sign-in term. Imports `READABILITY_MARGIN_DAYS` from `web/src/offline/readability-window.ts`;
    follow `withinReadabilityWindow` for shape, injectable clock, and total operand validation.
    Conference term on the rehydrated effective clock, sign-in term on the injected device clock.
  - **Verify**: `Test: bound is the later conference's end + margin with two joined; falls back to sign-in + margin with none; the module names expiresAt nowhere and declares no margin of its own, reading READABILITY_MARGIN_DAYS`

- [x] **TI03** A session past its bound is cleared at launch, before the app settles signed-in
  - Evaluated in `AuthProvider`'s `nothing-to-do` restore branch against TI02, using
    `readCachedSchedulesFor`. Past the bound, call the existing sign-out path so `onSessionCleared`
    fires and S10's purge runs; the app renders the sign-in screen. Depends on TI01 and TI02.
  - **Verify**: `Test: launching past the bound leaves the store with no session and IndexedDB with no cached schedule for that sub, and the sign-in screen rendered; current() still returns synchronously and the bound is evaluated before any evicting read runs`

- [x] **TI04** Missing or unreadable inputs bound the session rather than freeing it
  - Conference dates unavailable or malformed fall back to the sign-in term; a session that fails
    every term is treated as expired. Follow `withinReadabilityWindow`'s total operand check – it
    claimed to fail closed while answering "readable" for `NaN`-derived day strings.
  - **Verify**: `Test: an entry whose endDate is absent or malformed does not extend the bound, and no input combination yields a session that never expires`

- [x] **TI05** The signed-in identity is present on launch with a switch control beside it
  - The header identity block already exists in `web/src/App.tsx#App`; this makes it visible on the
    launch screen and adds the control. Legible with no horizontal body scroll at 375 / 768 /
    1280 px, and reachable one-handed on a phone – the standing constraint on the sign-out control.
  - **Verify**: `Test: the signed-in name and email render on launch and a switch control is present; visual specs pass at 375, 768 and 1280`

- [x] **TI06** Switching account signs out and starts a fresh sign-in, and refuses while offline
  - The control performs an ordinary sign-out – the same path and the same purge as the sign-out
    control – then begins sign-in. Offline, it leaves the session intact and says why; read
    connectivity through `useOnline`. Depends on TI05.
  - **Verify**: `Test: online, tapping switch empties the cache and lands on sign-in; offline, the session is still stored and still rendered signed-in`

- [x] **TI07** A cached schedule cannot outlive the session it was read under
  - A property held across the two predicates: for any cached entry, `withinReadabilityWindow`
    returning true implies TI02's bound has not passed. Both read the same `endDate` and the same
    margin, so the guard is against a future edit to either constant or either horizon.
  - **Verify**: `Test: across a matrix of end dates, sync dates and sign-in dates, no case renders a readable entry while the session bound has passed`

### Testing Strategy

- The bound predicate is unit-tested directly with an injected clock; the launch behaviour is tested
  through `AuthProvider` with a real IndexedDB harness, following `web/test/offline-cache-purge.test.tsx`
  for cache-visible assertions [TI03,TI06].
- TI07 is a property-style matrix over the two predicates rather than a scenario, because what it
  guards is a relationship between constants, not a user-visible behaviour.

## Final Validation Checklist

- [x] No literal `7` for the margin outside `READABILITY_MARGIN_DAYS`.
- [x] `expiresAt` appears nowhere in the session-bound module.

## Implementation Observations

> _Managed by exec-spec post-implementation – append-only._

### Run: 2026-08-27 – observations

Gates: typecheck clean, lint clean, build clean, **895/895 unit tests across 54 files** (baseline
871/52), visual **shell 6/6 at 375 / 768 / 1280** including the new switch control.

#### DESIGN NOTE: the conference term is shared, not restated

`session-bound.ts` calls `withinConferenceHorizon` — exported from `readability-window.ts` by this
run — rather than recomputing `endDate + margin` beside it. Readability is that predicate **and**
the sync horizon, so a readable entry always satisfies it and any entry satisfying it holds the
session open. That makes Structural Criterion 5 true *by construction* instead of by two copies of
the same arithmetic agreeing. `withinReadabilityWindow` keeps its exact previous behaviour; its 32
existing tests passed unchanged across the refactor.

Verified adversarially: giving `session-bound.ts` its own three-day conference margin makes the
TI07 matrix fail with `readable at end=-40 sync=-400 elapsed=8 but session expired`. Severing the
launch wiring likewise fails both TI03 scenarios. Neither guard is green by accident.

#### DISCOVERED REQUIREMENT: a silent renewal must not restamp the sign-in reading

- **Description**: `completeRedirect` rewrites the stored session on every silent renewal. Stamping
  `signedInAt` there would push the horizon out roughly hourly for anyone using the app — an
  unbounded session wearing a bound's clothes, which is the one outcome the clarification's Error
  Handling table forbids. The reading is now carried over on a silent renewal and stamped fresh only
  on an interactive sign-in, where somebody has proved who they are.
- **Rationale**: the FIS specified the field and the backfill but not the renewal path, because the
  clarification treats "sign-in" as a single event and the code has two writers.
- **Traced from**: TI01
- **Date**: 2026-08-27

#### NOTICED BUT NOT TOUCHING

- **Six visual specs in `visual/offline-schedule.spec.ts` failed, and they predated this run.**
  ~~They arrived with the ADR-005 eviction work.~~ **Corrected 2026-08-27 by a triage run**: that
  attribution was a hypothesis and was wrong. Stashing *all* uncommitted work and rebuilding
  reproduced the same six failures at `HEAD`, so neither ADR-005 nor this feature caused them. The
  root cause was a latent race in the test harness — `seedCache` wrote into the window before the
  app's own `adoptCacheOwner` claim had landed, and that claim's fail-closed purge then deleted the
  seeded entry. Fixed by porting `waitForCacheClaimed` from `offline-session-expiry.spec.ts`, which
  had hit and fixed the same race locally without back-porting it. Visual suite now **74/74**.
- **`web/test/` is outside `tsconfig`'s `include`, so no test file is type-checked.** Recorded in
  `auth-shell.test.tsx` already. It cost real time this run: `StoredSession` gained a required field
  and two fixtures kept building the old shape, which surfaced as three timeouts rather than as a
  compile error. Widening `include` is a project-level change, not this feature's.
- **`AuthProvider.tsx`'s comment on the surviving-session branch still describes ADR-005's deleted
  classification** ("clears the session only for a refused *grant*"). Pre-existing text on a line
  this run did not need to change.

#### ASSUMPTION: where the predicate module lives

The FIS's Work Areas say "a session-bound predicate module beside `web/src/offline/readability-window.ts`".
Placed at `web/src/auth/session-bound.ts` — its subject is the session, `auth` already imports from
`offline`, and S10's structural criteria constrain what lives in `web/src/offline/`. No criterion
constrains placement; the shared margin constant is satisfied either way.
