# Requirements Clarification: Offline Access With an Expired Session

> **Source Trust**: trusted-local

## Summary

Defines what an attendee may read when their device is offline and their Google session has
expired. Offline schedule reading (S10) and silent token renewal (S02) were each specified
correctly in isolation, but S02's renewal mechanism is a top-level navigation to Google, which
cannot complete without a network – so today an offline attendee with an expired token is
navigated off the app instead of shown the schedule sitting on their device. This clarifies the
rule: cached schedule reads do not require a live credential, they remain readable through the
conference's own date span, and renewal is attempted only when the network can actually carry it.

## Scope

### In Scope

- Whether reading an already-cached schedule requires a currently-valid session.
- How long a cached schedule stays readable offline once the session has expired.
- What the attendee experiences when connectivity returns with an expired session.
- Whether the readability window applies to archived conferences.
- The user-visible state shown when the window has passed and the device is still offline.
- How a refused renewal is handled, split by what Google actually refused with.

### Out of Scope

- **Where the renewal call is invoked from in code**, and the shape of the credential API. An
  implementation concern for the `andthen:spec` skill.
- **Changing S02's renewal mechanism itself.** DR04 (silent `prompt=none` re-authorization by
  top-level navigation, no refresh token, no iframe) stands. This clarification constrains *when*
  it may fire, not *what* it is.
- **Post-it queueing offline.** A separate half of the offline scope, untouched here.
- **Widening offline support** beyond schedule reads (`docs/PRODUCT.md` → Anti-Goals).
- **Shared-device session lifetime** – whether a session should survive a force-quit at all. Real,
  related, and deliberately separate; see Dependencies.

### MVP Boundary

The full rule as stated below. It is not divisible in a useful way: permitting credential-free
cached reads without bounding them leaves a deprovisioned employee reading conference data with no
expiry, and bounding them without the reconnect behaviour strands an attendee on a flaky
connection. The refusal split is part of that same interlock rather than an extra – the lenient
default for an unrecognised code is only safe because the window bounds it, and the window is only
tolerable because a genuine grant-refusal still purges immediately.

### Not Doing (for now)

- **A refresh-token store** – explicitly out of scope in S02 and unchanged here.
- **Re-authenticating offline by any means** – impossible against Google, and no local credential
  exists to check against.
- **Distinguishing personal from shared devices** – confApp cannot tell them apart without asking,
  and asking is its own requirements question.

## Functional Requirements

### User Stories

- As an **attendee** in a venue with no wifi, I want the schedule I already opened to keep
  rendering even though my sign-in has expired, so that I can see which room I am supposed to be
  in.
- As an **attendee** whose connection comes back, I want to be signed in again without doing
  anything, so that the schedule refreshes on its own.
- As an **attendee** whose renewal fails, I want to keep seeing the schedule I already had rather
  than losing it to an error screen, so that a transient failure does not cost me the information.
- As the **company**, I want a departed employee's offline access to conference data to end within
  a bounded window, so that deprovisioning means something even for a device that never reconnects.

### Core Flows

1. **Offline read with an expired session** – attendee launches offline; a cached entry exists for
   the selected conference; the session is expired. **No renewal is attempted.** The schedule
   renders through S10's normal cached path, with its existing cached-data label and elapsed age.
2. **Reconnect with an expired session** – network becomes reachable; renewal is attempted once
   via S02's existing `prompt=none` mechanism; on success the schedule refreshes normally through
   S09's diff and reconnect summary.
3. **Renewal refused because the Google session lapsed** (`login_required`,
   `interaction_required`, or any code not on the grant-refusal list) – the cached schedule stays on
   screen, read-only, with a banner stating that signing in again is needed. The attendee is not
   navigated away and the cache is **not** cleared.
4. **Renewal refused because the grant was refused** (`invalid_grant`, `access_denied`) – the
   session ends and the cache is purged, as it does today. This is the case `prd.md#edge-cases`
   means by "access ends", and it is the only case that means it.

### Alternate Flows

- **Window has passed, still offline** – the cached entry is not rendered. A distinct
  *sign-in-required* state is shown, separate from S10's existing "not available offline" state.
- **Window has passed, network available** – ordinary expired-session handling: renewal is
  attempted, and the normal signed-out path follows if it fails.
- **No cached entry at all** – unchanged; S10's existing "not available offline" state applies.

### UI Wireframes

Not produced here. One new state is introduced (*sign-in required, offline*); it reuses S10's
existing notice layout and must satisfy the standing 375 / 768 / 1280 legibility criterion.

## Design Decisions

### Design Space Decomposition

```
Offline access with an expired session
├── Credential requirement for cached reads
│   ├── None – local data reads without a live token   ← chosen
│   ├── Bounded grace period past expiry
│   └── Strict – expired session denies local data     ✗ (pruned)
├── Offline readability window
│   ├── Conference date span + margin                  ← chosen
│   ├── Indefinite, until next successful sign-in
│   ├── Fixed window regardless of conference dates    ✗ (pruned)
│   └── Until superseded by newer data                 ✗ (pruned)
├── Reconnect behaviour
│   ├── Silent renewal; hold cached view on failure    ← chosen
│   ├── Silent renewal; sign out on failure
│   └── Ask before renewing                            ✗ (pruned)
├── Refusal handling
│   ├── Split by refusal code                          ← chosen
│   ├── One kind – purge on any refusal
│   └── One kind – keep cache on any refusal           ✗ (superseded)
├── Default for an unrecognised refusal code
│   ├── Keep cache; purge only on known grant-refusal  ← chosen
│   ├── Purge; keep only on known session-lapse
│   └── Treat as transient – no purge, no prompt       ✗ (pruned)
├── Sign-in control while offline
│   ├── Shown, disabled, with an explanation           ← chosen
│   ├── No control, explanation only
│   └── Shown enabled and allowed to fail              ✗ (pruned)
├── Archived conferences
│   ├── Uniform per-conference rule                    ← chosen
│   ├── Exempt – readable indefinitely once cached
│   └── Never cached at all                            ✗ (pruned)
└── State when the window has passed
    ├── Distinct sign-in-required state                ← chosen
    ├── Reuse "not available offline"                  ✗ (pruned)
    └── Render anyway with an expiry banner            ✗ (pruned)
```

### Cross-Consistency Notes

- **Credential-free reads + indefinite window – incompatible.** Together they would mean a
  departed employee reads cached conference data forever, since the deprovisioning check only
  happens on reconnect (`prd.md#edge-cases`: *"Google sign-in fails at next token refresh; access
  ends"*). The bounded window is what makes credential-free reads acceptable.
- **Render-anyway-with-a-banner + a bounded window – incompatible.** A banner makes the window
  advisory rather than enforced, which removes the bound the window exists to create.
- **Uniform per-conference rule resolves the C3 picker defect.** The offline picker currently
  selects the alphabetically first cached conference and could land an attendee on a past event
  (S10 FIS, Implementation Observations). Once a past conference is no longer offline-readable, the
  picker cannot select one, and that defect closes without its own fix.
- **The readability window is what permits the lenient refusal default.** Keeping the cache on an
  unrecognised refusal code is only acceptable because the window already bounds exposure: a code
  that really did mean deprovisioning still stops rendering within the margin. Remove the window and
  the default would have to invert.
- **Splitting refusals contradicts nothing in DR04.** DR04 fixes the renewal *mechanism*; it names
  `login_required`, `interaction_required` and `invalid_grant` without saying they are equivalent.
  Today's code branches on `error !== null` and treats all three alike – that conflation is the
  defect, not the mechanism.
- **The chosen rule needs no new persisted state.** `listCachedConferences` already carries
  `startDate` and `endDate` through the cache, and S10 already rehydrates an effective wall clock
  from its persisted anchor – so "has this conference's span passed" is computable offline from
  what is already stored.

### Resolved Decisions

| Dimension | Choice | Rationale |
|---|---|---|
| Credential for cached reads | Not required | The envelope is already local, written under that employee's own key, and rendering it transmits nothing. Google ID tokens last about an hour, so requiring a live one would make offline reading fail from day two onward – cancelling a capability ratified on 2026-08-16. |
| Readability window | Conference date span + margin | Ties exposure to the event the data is for, and bounds the departed-employee case without ever cutting an attendee off mid-conference. |
| Reconnect behaviour | Silent renewal; hold the cached view if it fails | Preserves S02's DR04 mechanism and confines it to the case where it can succeed. A transient failure must not cost an attendee the schedule she already had. |
| Archived conferences | Same rule, applied per conference | Offline reading serves "where am I supposed to be" for the current event; a past conference is read online at leisure. Also dissolves the C3 picker defect. |
| Refusal handling | Split by refusal code | `login_required`/`interaction_required` mean the Google session lapsed, not that the person left; purging their offline schedule mid-conference over a routine expiry is not what the PRD's deprovisioning row asks for. |
| Unrecognised refusal code | Keep the cache; purge only on a known grant-refusal | The window already bounds exposure, so an unknown code that really was a deprovisioning still lapses within the margin – whereas purging on a transient `server_error` would wipe every attendee's schedule at once for no security gain. |
| Sign-in control while offline | Shown, disabled, with an explanation | Matches how `LeaveConferenceControl` and `JoinConferencePanel` already gate on `useOnline()`. An enabled control would navigate to Google and fail, reintroducing through a button the defect this feature removes. |
| Window-passed state | A distinct sign-in-required state | The cause differs from a cache miss and so does the remedy – one needs a connection to fetch, the other to re-authenticate. Reusing the existing message would tell the attendee the schedule is not on the device when it is. |

### Open Design Questions

None at requirements level. Where the connectivity gate lives in the credential API is an
implementation decision for the `andthen:spec` skill.

## Edge Cases

| Scenario | Expected Behavior |
|---|---|
| Offline, session expired, cached entry exists, conference in span | Schedule renders normally with the existing cached-data label; no renewal attempted |
| Offline, session expired, conference's span + margin has passed | Sign-in-required state; schedule withheld |
| Offline, session expired, no cached entry | Existing "not available offline" state (unchanged) |
| Reconnect, renewal succeeds | Normal refresh; S09 diff and reconnect summary apply |
| Reconnect, renewal refused with `login_required` / `interaction_required` | Cached schedule held read-only with a sign-in-required banner; cache **not** cleared |
| Reconnect, renewal refused with `invalid_grant` / `access_denied` | Session ends and the cache is purged – access ends, as `prd.md#edge-cases` intends |
| Reconnect, renewal refused with an unrecognised or transient code (`server_error`, `temporarily_unavailable`) | Treated as a session lapse: cache retained, sign-in prompted. Never purges |
| Sign-in control tapped while still offline | Control is present but disabled, with text stating a connection is required; no navigation is attempted |
| Reconnect, renewal fails transiently (network drops mid-attempt) | Treated as still-offline; cached view retained; retried on the next reachability signal |
| Conference is archived while cached and its span has passed | No longer offline-readable; readable online as normal |
| Conference is archived mid-event, span not yet passed | Still offline-readable until the span + margin passes – the window follows the dates, not the lifecycle state |
| Multiple cached conferences with different spans | The window is evaluated per conference; one expiring does not affect another |
| Device clock moved backwards while offline | The window is evaluated against S10's rehydrated effective clock, not the raw device clock. A deliberately altered device clock can extend the window; accepted (see Non-Functional Requirements → Security) |
| Attendee leaves a conference, then goes offline | Unchanged – S10 already forgets that entry on a successful leave |

## Error Handling

| Error | User Message | Recovery |
|---|---|---|
| Renewal refused, Google session lapsed | "Your sign-in has expired. Sign in again to see the latest schedule." | Cached schedule stays visible read-only; sign-in control offered, disabled while offline |
| Renewal refused, grant refused (deprovisioned) | S02's existing message: the session has ended because Google would not renew it | Session ends, cache purged; sign-in screen |
| Renewal fails while still unreachable | No message; the existing offline/cached label already explains the state | Retried on the next reachability signal |
| Window passed while offline | "Sign in again to see this schedule." Distinct from "not available offline" | Connect and sign in |
| Cache unreadable (storage failure) | Existing "not available offline" state | Unchanged from S10 |

## Non-Functional Requirements

- **Performance**: the window check is a comparison against already-cached dates; it must not add
  a storage round trip to the offline render path.
- **Security**: cached reads without a live credential are a deliberate, bounded relaxation. The
  bound is the conference date span plus a margin, evaluated against the rehydrated effective
  clock. That clock is anchored to the last successful sync but still advances on the device clock,
  so an attendee who deliberately alters their device clock can extend their own offline window.
  Accepted: the data is a conference schedule, the audience is under 100 employees of one company,
  and the alternative (a server check) is unavailable by definition when offline.
- **Privacy**: this changes nothing about the sign-out and user-switch purges, which remain the
  mechanism protecting a shared device. Withholding an expired-window schedule is not a purge – the
  entry may remain on disk until a purge trigger fires.
- **Accessibility**: the new sign-in-required state must be legible with no horizontal body scroll
  at 375 px, 768 px and 1280 px, matching the standing criterion.

## Success Criteria

- [ ] With an expired stored session, no network, and a cached entry for a conference inside its
      date span, the schedule renders and **no navigation is initiated**.
- [ ] The same case does not call the renewal path at all – asserted on the renewal entry point,
      not merely on the rendered output.
- [ ] With an expired session and a cached entry whose conference span + margin has passed, the
      sign-in-required state renders and the schedule is not shown.
- [ ] The sign-in-required state is distinguishable in the DOM from the "not available offline"
      state.
- [ ] On reconnect with an expired session, renewal is attempted exactly once; on success the
      schedule refreshes and S09's reconnect summary behaves as before.
- [ ] On a renewal refused with `login_required`, the previously cached schedule is still on screen
      and the cache entry still exists.
- [ ] On a renewal refused with `invalid_grant`, the session ends and the cache is purged.
- [ ] On a renewal refused with an unrecognised code, the cache survives – asserted directly, since
      this is the lenient default and the easy thing to get backwards.
- [ ] The sign-in control in the sign-in-required state is disabled while offline, and tapping it
      initiates no navigation.
- [ ] Two cached conferences with different date spans expire independently.
- [ ] The offline picker cannot select a conference whose window has passed.
- [ ] S02's existing acceptance scenarios, including S06 (session survives token expiry) and the
      deprovisioned-account path, still pass unchanged.

## Dependencies

| Dependency | Purpose | Risk |
|---|---|---|
| S02 `validToken` / DR04 renewal | The mechanism this clarification gates on reachability | Changing where renewal is invoked touches S02's credential API; S10's structural criterion says S10 "introduces no independent auth teardown or token handling", so the change belongs to S02's surface, not S10's |
| S02 refusal handling (`session.ts`, the `error !== null` branch) and the `onSessionCleared` hook | Splitting refusals by code is a change to S02's surface, and the hook is what purges the cache | **Medium.** Today every refusal calls `clearSession('sign-out', …)`, which fires the hook `AuthProvider` registers `purgeScheduleCache()` on. The split must happen at that branch; a fix applied further downstream cannot work, because by then the store is already empty and `cacheIdentity()` returns null |
| S10 cache (`schedule-cache.ts`, `schedule-data.ts`) | Supplies the cached envelope and the conference dates the window is computed from | Low – no new persisted state required |
| S10 rehydrated effective clock | Evaluates the window without trusting the raw device clock | Low – already built and tested |
| S10 offline conference picker | Must not offer a conference whose window has passed | The picker's selection rule is a known open item (C3); this clarification narrows it but does not fully specify ordering |
| Session lifetime (`docs/specs/shared-device-session-lifetime/`) | Bounds the session behind an offline read, and shares this document's margin | **Resolved 2026-08-24.** A session is bounded by the latest joined conference's end date plus the same margin, so a session and the schedules cached under it lapse on the same clock. The intuitive fix – expiring the session at the token's `expiresAt` – was explicitly rejected there, because it would sign attendees out roughly hourly and break S02 OC01. An implementation that makes that mistake would defeat this document's core flow as well |
| Reachability signal | Deciding when renewal may fire | `navigator.onLine` is true behind a captive portal (`use-online.ts`), so reachability must be established by a request actually succeeding, not by the flag |

## Open Questions

- ~~How many days after a conference's `endDate` should its cached schedule remain readable
  offline?~~ **Answered 2026-08-24: 7 days**, and the value is shared with the session lifetime
  bound rather than set independently – see `docs/specs/shared-device-session-lifetime/`. Changing
  it means amending both documents together.
- ~~Should the sign-in-required state offer a sign-in control while the device is still offline?~~
  **Answered 2026-08-24: shown but disabled, with an explanation** – matching the existing
  `useOnline()` gating on the leave and join affordances.
- Area to revisit: the offline picker's selection rule – this clarification removes past
  conferences from the candidate set, which resolves the worst symptom, but the ordering among
  remaining candidates is still `localeCompare` rather than the server's `defaultConferenceId`.
  Sharpened by deciding whether the last-selected conference id is worth persisting.

## Decisions Log

| Decision | Rationale | Date |
|---|---|---|
| Cached schedule reads do not require a currently-valid session | The data is already local and rendering it transmits nothing; requiring a live token would cancel offline reading in practice, since Google ID tokens last about an hour | 2026-08-24 |
| Cached schedules remain offline-readable through the conference date span plus a margin | Ties exposure to the event, and bounds offline access for a departed employee whose device never reconnects | 2026-08-24 |
| The window applies per conference, archived ones included | Offline reading serves the current event; a past conference is read online. Also dissolves the C3 picker defect | 2026-08-24 |
| ~~On reconnect, a renewal failure holds the cached view rather than clearing it~~ **Superseded 2026-08-24** by the refusal split below | Correct for a transient failure and for a lapsed Google session, but it over-applied: it also covered a genuinely refused grant, where `prd.md#edge-cases` says access ends and S02 deliberately ends the session. The conflict surfaced during FIS authoring | 2026-08-24 |
| On reconnect, renewal is attempted silently once the API has answered | Preserves S02's DR04 mechanism while confining it to the case where it can succeed | 2026-08-24 |
| A refused renewal is split by code: session-lapse keeps the cache, grant-refusal purges | `login_required`/`interaction_required` mean the Google session ended, not the employment; purging a still-valid employee's offline schedule mid-conference is not what the deprovisioning row asks for | 2026-08-24 |
| An unrecognised or transient refusal code keeps the cache | The readability window already bounds exposure, so a misclassified deprovisioning still lapses within the margin; purging on a transient `server_error` would cost every attendee her schedule at once | 2026-08-24 |
| The sign-in control is shown but disabled while offline | Matches the existing `useOnline()` gating; an enabled control would navigate to Google and fail, reintroducing the defect this feature removes | 2026-08-24 |
| A distinct sign-in-required state, not a reuse of "not available offline" | Different cause, different remedy; the existing message would claim the schedule is absent when it is on the device | 2026-08-24 |
| The margin is 7 days, shared with the session lifetime bound | One number governs both, so a session and the schedules cached under it lapse together rather than leaving a readable schedule behind a lapsed session | 2026-08-24 |
| S02's DR04 renewal mechanism is unchanged | Only *when* it may fire is constrained. The top-level-navigation, no-refresh-token, no-iframe design stands | 2026-08-24 |
