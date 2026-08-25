# Offline Access With an Expired Session

## Feature Overview and Goal

**Intent**: Offline schedule reading currently works only while a Google ID token is fresh – about
an hour – so S10's guarantee that "a schedule loaded at least once always renders" fails from the
second day of a conference onward; this makes cached reads independent of credential freshness and
bounds them by the conference they belong to.

**Expected Outcomes**:

- [OC01] An attendee whose sign-in has lapsed, with no connectivity, reads the cached schedule for a
  conference inside its date span – and confApp never navigates away from the app trying to renew.
- [OC02] A cached schedule stops rendering once its conference's date span plus the shared margin
  has passed, so a departed employee's offline access ends without depending on a reconnect.
- [OC03] When the API is genuinely reachable again, renewal is attempted, and the outcome depends on
  what Google refused with: a lapsed Google session leaves the cached schedule on screen and prompts
  a sign-in, while a genuinely refused grant ends the session and purges, as it does today.
- [OC04] An attendee can tell why a schedule is not shown: a lapsed sign-in and an absent cache
  produce distinguishable states.

## Required Context

- `docs/specs/offline-session-expiry/requirements-clarification.md` – the ratified rule this FIS
  implements: credential-free cached reads, the conference-span window, the reconnect behaviour, and
  the explicitly rejected alternatives. Its Decisions Log is the contract.
- `docs/specs/conference-setup-and-schedule/s02-google-workspace-sign-in.md#implementation-plan` –
  TI09, the renewal task itself. **DR04** is not in that section: it was recorded later, under
  `s02-google-workspace-sign-in.md#implementation-observations` → DISCOVERED REQUIREMENTS. DR04
  fixes renewal as a silent `prompt=none` **top-level navigation**, no refresh token, no iframe.
  This FIS constrains *when* that navigation may fire and changes nothing about *what* it is. OC01
  there ("stays signed in across the multi-day conference") must still hold.
- `web/src/auth/session.ts` – the `error !== null` branch of the redirect handler. It currently
  calls `clearSession('sign-out', …)` for **every** refusal code, and `AuthProvider` registers
  `purgeScheduleCache()` on that hook. This is the only place the refusal split can be made: by the
  time the panel sees anything, the store is already empty and `cacheIdentity()` returns null.
- `docs/specs/conference-setup-and-schedule/s10-offline-schedule-access.md#structural-criteria` – the
  invariants this FIS must not break, in particular: the cache key pair, the two-input render
  contract, no raw device clock as "now", and no write or outbox path in the offline layer.
- `AGENTS.md#do-not--never` – "Never widen offline support beyond schedule reads and post-it
  queueing"; "Never key a user on their email address"; "Never run the OIDC flow in an embedded
  WebView".
- `docs/specs/conference-setup-and-schedule/prd.md#edge-cases` – "Employee leaves the company
  mid-conference | Google sign-in fails at next token refresh; access ends". Offline there is no
  refresh, which is precisely why OC02 exists.

## Deeper Context

- `docs/LEARNINGS.md` – § Browser Testing / jsdom and § Testing. Two entries bear directly here: a
  regression test written beside its fix usually passes without the fix, and a file-list grep is only
  as good as its longest omission.
- `docs/specs/shared-device-session-lifetime/requirements-clarification.md` – the sibling rule that
  bounds the session itself and **shares this feature's margin**. Not implemented here; read it
  before changing the margin, because both documents move together.
- `docs/adrs/ADR-002-authenticate-with-google-workspace-oidc.md#decision` – why the credential is the
  ID token and why the system browser is mandatory.

## Acceptance Scenarios

- [x] **S01 [OC01] [TI01,TI03] Offline with a lapsed sign-in, the cached schedule renders and nothing navigates**
  - **Given** Nadia opened "Kickoff 2026" (15–18 September 2026) on the 15th, her stored ID token
    expired hours ago, her device has no connectivity, and it is the 16th
  - **When** she launches confApp and opens "Kickoff 2026"
  - **Then** the schedule renders through S10's cached path with its existing cached-data label and
    elapsed age, and **no navigation to the authorization endpoint is initiated**

- [x] **S02 [OC02,OC04] [TI02,TI04] A conference whose span plus margin has passed is withheld, and says why**
  - **Given** "Autumn Offsite" ended on 2025-10-03 and is still cached, the margin is 7 days, it is
    2026-09-16, the device is offline and the sign-in has lapsed
  - **When** Nadia opens "Autumn Offsite"
  - **Then** a sign-in-required state renders, distinguishable from S10's "not available offline"
    state, and the schedule is not displayed

- [x] **S03 [OC02] [TI02,TI08] Two cached conferences with different spans lapse independently**
  - **Given** both "Kickoff 2026" (current) and "Autumn Offsite" (ended 2025) are cached, offline,
    sign-in lapsed
  - **When** Nadia launches confApp with no connection, so the conference list is projected from the
    cache
  - **Then** the offline candidate set contains "Kickoff 2026" and not "Autumn Offsite", and the
    conference she lands on is "Kickoff 2026", which renders – the picker cannot offer or select the
    lapsed one. Asserted on the candidate set, not on the picker control, which does not render at
    all when the filter leaves a single candidate.

- [x] **S04 [OC03] [TI05] Renewal is attempted once the API has actually answered, not before**
  - **Given** the cached schedule is on screen with a lapsed sign-in, and the device is behind a
    captive portal where `navigator.onLine` reports true but every request fails
  - **When** connectivity is genuinely restored and a request succeeds
  - **Then** renewal is attempted exactly once at that point – and was not attempted at any time
    while requests were still failing

- [x] **S05 [OC03] [TI06] A renewal refused because the Google session lapsed keeps the cached schedule**
  - **Given** the cached schedule is on screen, the network is reachable, and Nadia is still an
    employee – her Google-side Workspace session has simply expired
  - **When** the silent renewal is refused with `login_required`
  - **Then** the cached schedule is still rendered read-only with a banner stating that signing in
    again is needed, the cache entry still exists, and the stored session is not cleared

- [x] **S06 [OC04] [TI04] A conference never opened offline still reports an absent cache, not a lapsed sign-in**
  - **Given** Nadia joined "Retro Day" but never opened it, the device is offline, sign-in lapsed
  - **When** she opens "Retro Day"
  - **Then** S10's existing "not available offline" state renders – unchanged, and distinct from the
    sign-in-required state

- [x] **S08 [OC03] [TI06] A renewal refused because the grant was refused ends the session and purges**
  - **Given** the cached schedule is on screen, the network is reachable, and Nadia's account has
    been deprovisioned
  - **When** the silent renewal is refused with `invalid_grant`
  - **Then** the session ends with S02's existing reason shown, and the cache is purged – this is
    the case `prd.md#edge-cases` means by "access ends", and the only one that means it

- [x] **S09 [OC03] [TI06] An unrecognised refusal code keeps the cache rather than purging**
  - **Given** the cached schedule is on screen and the network is reachable
  - **When** the silent renewal is refused with `server_error`
  - **Then** the cache is retained and a sign-in is prompted – the lenient default, safe because the
    readability window still bounds a misclassified deprovisioning

- [x] **S07 [OC01] [TI07] A read with no usable credential does not become an anonymous request that discards the cache**
  - **Given** the cached schedule is on screen and the stored token has lapsed
  - **When** the panel's next scheduled refresh runs
  - **Then** no request is sent without an `Authorization` header, the cached view is retained, and
    the cache entry is **not** forgotten

## Structural Criteria

- [x] No code path reachable from a schedule or conference-list read initiates the authorization
      navigation while the API has not been proven reachable – asserted on the renewal entry point
      itself, not inferred from rendered output.
- [x] S02's DR04 mechanism is unchanged: renewal is still a `prompt=none` top-level navigation, with
      no refresh token introduced and no iframe.
- [x] This story does not change session **lifetime**. Token expiry alone must not clear the stored
      session or purge the cache – that would break S02 OC01 and belongs to
      `shared-device-session-lifetime`.
- [x] This story **does** change session **clearing**, narrowly: a refused renewal no longer clears
      unconditionally. Exactly one place classifies a refusal – the `error !== null` branch in
      `web/src/auth/session.ts`. `invalid_grant` and `access_denied` clear the session and purge as
      today; every other code, including unrecognised and transient ones, leaves the session and the
      cache intact and surfaces the sign-in prompt. No second classification exists downstream, and
      no other clearing trigger (explicit sign-out, user switch) is touched.
- [x] The readability window is computed from data already in the cache entry; no new persisted
      field is added to `CachedSchedule` and no new store is created.
- [x] The window is evaluated against S10's rehydrated effective clock. No offline path reads the raw
      device clock as "now", and the window predicate has exactly one definition in the codebase.
- [x] The margin is a single named constant holding the ratified value – **7 days** – and the
      sibling document `docs/specs/shared-device-session-lifetime/` is referenced at its definition
      so the two cannot silently diverge.
- [x] The window predicate reads the conference's dates only. It does not consult
      `lifecycleState`: an archived conference inside its span plus margin stays readable, and one
      past it stops, on exactly the same rule as a published one.
- [x] No write, mutation, outbox, sync queue or replay path is introduced (`docs/PRODUCT.md`
      → Anti-Goals).
- [x] The reconnect refresh remains an ordinary authenticated request; no unauthenticated or
      cache-only bypass route is added.
- [x] S02's and S10's existing **acceptance scenarios** still hold, including S02 S06 (the session
      survives token expiry, and a renewal Google refuses ends it) and S10 S01–S08. S10's suite
      passes unchanged. S02's suite does not, and must not be forced to: TI01 removes the navigation
      from the credential accessor, so `auth-session.test.ts`'s two renewal tests – "renews silently
      when the stored token is at its expiry margin" and "starts only one renewal when several
      callers hit a stale token at once" – **move to the new renewal entry point** rather than being
      deleted or relaxed. Their assertions are unchanged; only what they call is.
- [x] The sign-in control in the sign-in-required state is gated on the existing
      `web/src/offline/use-online.ts#useOnline` seam – the same one `LeaveConferenceControl` and
      `JoinConferencePanel` use. No second connectivity check is introduced, and no path from that
      control can initiate a navigation while offline.
- [x] The sign-in-required state is legible with no horizontal body scroll at 375 px, 768 px and
      1280 px.

## Scope & Boundaries

### Work Areas

- Credential path – `web/src/auth/session.ts#validToken` stops navigating; the renewal navigation
  moves behind an explicitly-invoked entry point.
- Request path – `web/src/api/client.ts#apiRequest` refuses to send an authenticated request with no
  credential rather than sending it anonymously.
- Readability window – one predicate over a cached entry's conference dates plus the shared margin.
- Attendee panel – the cached/offline phases and the new sign-in-required state in
  `web/src/attendee/AttendeeSchedulePanel.tsx`.
- Offline conference picker – `web/src/offline/schedule-data.ts#listCachedConferences` candidate set.
- Refusal classification – the `error !== null` branch in `web/src/auth/session.ts`, and the
  `onSessionCleared` hook `AuthProvider` purges through.
- Styles for the new state, at the three standing viewport widths.

### What We're NOT Doing

- **Changing S02's renewal mechanism (DR04)** – only *when* it may fire, and *how its refusal is
  classified*. The top-level-navigation, no-refresh-token, no-iframe design itself is settled and
  re-opening it is out of scope. Classifying the refusal is in scope and is TI06.
- **Bounding the session's own lifetime** – specified separately in
  `docs/specs/shared-device-session-lifetime/`. Implementing it here would couple two features and
  risks the rejected token-expiry-as-session-lifetime mistake.
- **Introducing a refresh-token store** – explicitly out of scope in S02 and unchanged.
- **Post-it queueing offline** – the other half of the offline scope; untouched.
- **Fixing the offline picker's ordering rule** – this FIS removes out-of-window candidates, which
  closes the reported symptom. Whether the remaining candidates honour `defaultConferenceId` rather
  than `localeCompare` is a separate open question in the clarification.

## Architecture Decision

**Approach**: `validToken()` becomes a pure credential accessor – it returns the stored token or
`null` and never navigates. The renewal navigation moves behind a separate entry point invoked only
from a path that has just proven the API answered. `apiRequest` refuses to send an authenticated
request without a credential, raising a transport-shaped `ApiError` (status 0) that the panel
already classifies as unreachable.

**Why this over alternatives**: making `validToken()` itself connectivity-aware would put a network
concern inside the credential module and still leave callers unable to distinguish "no credential"
from "the server refused" – the distinction that currently causes a missing token to be read as a
401 and the cached entry to be discarded. Gating at the point where reachability is already known
keeps DR04 intact and makes the failing case indistinguishable from any other transport failure,
which is the behaviour the cached path is already built around.

## Constraints & Gotchas

- **Critical**: `navigator.onLine` is true behind a captive portal and on dead venue wifi
  (`web/src/offline/use-online.ts` says so in as many words). Reachability for the purpose of firing
  a renewal must come from a request that actually succeeded, never from the flag.
- **Critical**: expiring or clearing the stored session when the token expires breaks S02 OC01 –
  attendees would be signed out roughly hourly. It is the intuitive change and it is wrong; the
  session bound lives in the sibling feature and is measured from conference dates, not token expiry.
- **Critical**: the window must be evaluated against S10's rehydrated effective clock, not
  `Date.now()` as a wall clock. S10's Structural Criteria forbid a raw device clock as "now" on any
  offline path, and a second time source here would reintroduce exactly that.
- **Avoid**: a second "is this readable" predicate – one for the picker and one for the panel. Two
  definitions will drift, and the picker's candidate set and the panel's render decision must agree
  or an attendee can select a conference that then refuses to render.
- **Critical**: the offline paths in `AttendeeSchedulePanel.tsx` consult **two** classifiers, not
  one. `unreachable()` decides whether the cache may answer; a separate `error instanceof ApiError`
  decides whether anything answered at all, and that one selects `schedule-unavailable-offline`.
  Introducing a new `ApiError` for a request that never left the device (TI07) silently changes the
  second answer while leaving the first correct – which is how S06 regresses with every other test
  still green.
- **Critical**: a renewal refusal never reaches the panel's request-failure branch. It arrives as a
  top-level redirect carrying `?error=`, is handled in `web/src/auth/session.ts`, and clears the
  session there – which fires the hook `AuthProvider` purges the cache on. Any attempt to preserve
  the cache from the panel, the poll `catch`, or the cached-phase 4xx branch is unreachable code:
  the store is already empty and `cacheIdentity()` returns null before those run.
- **Constraint**: `readCachedSchedulesFor` already re-filters entries on the `sub` half of the key.
  The window filter composes with that; it must not replace it, or the per-user boundary is lost.

## Implementation Plan

### Implementation Tasks

- [x] **TI01** The credential accessor never initiates a navigation
  - `web/src/auth/session.ts#validToken` returns the stored token or `null`; the `authorize()` call
    moves behind a separately-invoked renewal entry point on the same session object. DR04's request
    shape is copied across unchanged.
  - **Verify**: `Test: with an expired stored session and an injected navigate spy, calling the credential accessor resolves and navigate is not called; invoking the renewal entry point navigates exactly once, to the authorization endpoint, with prompt=none, a login_hint and code_challenge_method=S256 (DR04's shape, asserted positively)`

- [x] **TI02** A cached entry outside its conference's readability window is reported unreadable
  - One predicate, evaluated with S10's rehydrated effective clock over the entry's own
    `conference.endDate` plus a single named margin constant holding the ratified **7 days**. No new
    persisted field. The constant's definition names `docs/specs/shared-device-session-lifetime/` as
    its co-owner. **Dates only** – the predicate does not read `lifecycleState`, so an archived
    conference lapses on the same rule as a published one (clarification → Decisions Log).
  - **Verify**: `Test: an entry whose conference ended longer ago than the margin is unreadable; one inside its span is readable; one exactly at the margin boundary is readable; an archived entry inside its span is readable and an archived entry past the margin is not, on the same rule as a published one`

- [x] **TI03** An offline read with a lapsed sign-in renders the cached schedule
  - Consumes TI01 and TI02 in the cached path of
    `web/src/attendee/AttendeeSchedulePanel.tsx`; the render contract and both clock inputs are S10's,
    unchanged.
  - **Verify**: `Test (S01): an expired stored session, a failing transport and an in-window cache entry render the schedule with its cached-data label, and no navigation occurs`

- [x] **TI04** A withheld schedule is distinguishable from an absent one
  - A sign-in-required state beside S10's `schedule-unavailable-offline`, reusing that notice's
    layout. Depends on TI02 to know which case applies.
  - **Verify**: `Test (S02, S06): an out-of-window entry renders the sign-in-required state; no entry at all renders schedule-unavailable-offline; the two are distinguishable in the DOM`

- [x] **TI05** Renewal is attempted only after a request has actually succeeded
  - Invoked from the reconnect path in `AttendeeSchedulePanel.tsx` that has just completed a
    successful request, never from `navigator.onLine`. Consumes TI01's entry point.
  - **Verify**: `Test (S04): with every request failing while navigator.onLine reports true, the renewal entry point is never called; after one request succeeds it is called exactly once`

- [x] **TI06** A refused renewal is classified by code, and only a refused grant clears the session
  - The split is made at the `error !== null` branch in `web/src/auth/session.ts` – the same branch
    that today calls `clearSession('sign-out', …)` for every code. `invalid_grant` and
    `access_denied` keep that behaviour; every other code returns the failure to the caller with the
    session and the cache untouched. **A fix applied anywhere downstream cannot work**: `AuthProvider`
    registers `purgeScheduleCache()` on that hook, so by the time the panel is involved the store is
    empty and `cacheIdentity()` returns null.
  - **Verify**: `Test (S05, S08, S09): a renewal refused with login_required leaves the stored session and the cache entry intact and surfaces a sign-in prompt; one refused with invalid_grant clears the session and purges; one refused with an unrecognised code (server_error) leaves both intact`

- [x] **TI07** An authenticated request with no credential is not sent
  - `web/src/api/client.ts#apiRequest` raises a transport-shaped `ApiError` with status 0 instead of
    sending without an `Authorization` header; status 0 already routes to the panel's `unreachable`
    classification, so the cached entry is preserved rather than forgotten.
  - **`unreachable()` is not the only classifier on this path.** The panel decides "did anything
    answer at all" with a *second* test – `error instanceof ApiError`, in the conference-list catch
    and in the schedule catch – and that is what selects S10's `schedule-unavailable-offline` state.
    Today a no-network read throws a raw `TypeError`, so that test is false; an `ApiError` alone
    would flip it and send the absent-cache case to the failure alert instead. This task must leave
    both branches choosing `unavailable-offline` for a read that never reached the network.
  - **Verify**: `Test (S07, S06): with a credential source yielding null, no request is issued, the cached phase is retained, and the cache entry is not forgotten – and with no cache entry at all the panel renders schedule-unavailable-offline, not the failure alert`

- [x] **TI08** The offline picker offers only conferences inside their window
  - `web/src/offline/schedule-data.ts#listCachedConferences` filters through TI02's single predicate,
    composed with the existing `sub` filter rather than replacing it.
  - **Verify**: `Test (S03): with one in-window and one out-of-window cached conference, the candidate set contains only the in-window one`

- [x] **TI10** The sign-in control in the sign-in-required state is disabled while offline
  - Gate it on `web/src/offline/use-online.ts#useOnline`, as `LeaveConferenceControl` and
    `JoinConferencePanel` already do, with text stating a connection is required. An enabled control
    would navigate to Google and fail – the defect this whole feature removes, reintroduced through a
    button. Depends on TI04 for the state it lives in.
  - **Verify**: `Test: in the sign-in-required state with the device offline the control is present and disabled, activating it initiates no navigation, and the accompanying text states a connection is required`

- [x] **TI09** The sign-in-required state is legible at the three standing widths
  - Follows S10's existing offline-notice styling; no mobile-only layout fork.
  - **Verify**: `Visual: the sign-in-required state renders with no horizontal body scroll at 375, 768 and 1280 px`

### Testing Strategy

- **Every new guard must be falsified before it is believed.** `docs/LEARNINGS.md` records that a
  regression test written beside its fix usually passes without the fix, and that exact trap has now
  been hit twice in this codebase. For TI01, TI05 and TI07 in particular, revert the change and
  confirm the test fails before accepting it.
- **TI01 and TI05 assert on the renewal entry point, not on rendered output.** A test that only
  checks "the schedule rendered" passes just as well when a navigation was attempted and silently
  failed in jsdom. Inject and spy the navigation seam.
- The existing offline suites leave the token source at its module default (`async () => null`), so
  they exercise none of this. New tests must install a real session with a controlled `expiresAt`.
- **The refusal split must be tested in both directions.** A test asserting only that
  `login_required` keeps the cache passes just as well against code that never purges at all, which
  would silently delete the deprovisioning behaviour `prd.md#edge-cases` requires. Pair it with the
  `invalid_grant` case asserting the purge *does* happen.
- **S02's renewal tests move; they are not relaxed.** `auth-session.test.ts` asserts that
  `validToken()` navigates exactly once, and TI01 makes that false by design. Re-point both tests at
  the renewal entry point with their assertions intact, and add the negative on the accessor. A
  suite edited to expect zero navigations from *either* seam would delete DR04's only proof.

### Execution Contract

- TI01 precedes TI03 and TI05 – both consume the entry point it creates.
- TI02 precedes TI04 and TI08 – both consume its predicate, and it is the only place the window may
  be defined.

## Final Validation Checklist

- [x] Reverting TI01's change makes S01 fail; reverting TI07's makes S07 fail. Confirmed by running
      them, not by inspection.
- [x] No occurrence of the stored session being cleared, or the cache purged, as a consequence of
      token expiry alone anywhere in this story's diff.
- [x] `docs/specs/shared-device-session-lifetime/` and this feature still state the same margin.
- [x] Exactly one site in the tree classifies a renewal refusal code. A second classifier anywhere
      means the panel and the session module can disagree about whether the cache survived.

## Implementation Observations

> _Managed by exec-spec post-implementation – append-only. Spec authors: leave this section empty._

### Run: 2026-08-25 08:46 UTC – observations

#### NOTICED BUT NOT TOUCHING

- `web/src/attendee/AttendeeSchedulePanel.tsx` (the `renderedRef` effect, ~line 340) — the poll identifies "the view I started against" by the identity of a freshly allocated object, and `syncIfChanged` abandons its result when that identity has moved. Any subscription that re-renders the panel on the `online` event therefore silently cancels the very poll that event prompts. This bit during implementation: holding `useOnline()` in the panel made several S10 reconnect tests fail intermittently, and the fix was to push the hook down into `SignInRequiredNotice` / `SessionRenewalNotice`. The underlying fragility is S10-era and is left as it is — a future subscription added to this component will hit it again.
- `web/src/components/JoinCodePanel.tsx` and `visual/conferences.spec.ts` — pre-existing Prettier drift; both fail `prettier --check` at HEAD and neither was touched by this story. Not bundled into this diff.
- `web/src/components/ConferencesPanel.tsx` (organizer surface) — with a lapsed token it now shows `CREDENTIAL_UNAVAILABLE` and its sentence ("Your sign-in has expired, so this could not be requested…") instead of the previous transport message. A consequence of TI07 rather than a change to this panel; visible in `screenshots/offline-sign-in-required-*.png`. Arguably clearer than what it said before, but no one specified organizer-surface wording for a lapsed sign-in.
- `web/src/offline/schedule-cache.ts#adoptCacheOwner` (uncommitted work predating this story, excluded from this diff) — now fails closed, so a store with no owner marker is purged. A cold launch on a fresh device therefore empties the store asynchronously while the app boots, which races anything seeding that store from outside. `visual/offline-session-expiry.spec.ts` waits for the owner marker before seeding for this reason.

#### ASSUMPTIONS

- The reconnect reachability probe uses `/health`, the existing anonymous readiness route, because a lapsed credential means no authenticated request can leave the device (TI07) and so the poll can no longer be what notices the connection returning. The FIS names "a request that has actually succeeded" without naming which; `/health` is the only one available in that state. No new route was added, and the schedule refresh itself remains an ordinary authenticated request.
- The sign-in prompt for a refusal that does not end the session (S05) is rendered by the shell as a banner over the still-working app (`SessionRenewalNotice`), with `AuthProvider` reporting `signed-in` plus `renewalFailed` rather than dropping to `signed-out`. The FIS requires the cached schedule to stay on screen with such a banner but does not say where it lives; the shell is the only place that sees the redirect outcome.
- `web/test/setup.ts` now installs a credential for every web test, and `asyncUtilTimeout` / `testTimeout` were raised. Both are harness changes forced by this story: without a credential, TI07 makes every existing panel test exercise the lapsed-sign-in path, and the default waits are shorter than the panel's own five-second poll interval, so one skipped tick failed a reconnect test. No assertion was weakened. Verified over 16 consecutive clean full-suite runs.
