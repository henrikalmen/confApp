# Requirements Clarification: Session Lifetime and Launch Identity

> **Source Trust**: trusted-local

## Summary

Defines how long a signed-in session persists and what confApp shows when it launches with one
already stored. S02 ratified that a session survives across a multi-day conference without
re-entering credentials, but nothing ever bounded it and nothing handles the case where a person
opens the app on a device that is not theirs and never signs in. Devices are personal phones in
practice, so this bounds every session by the event it belongs to and makes the signed-in identity
visible on launch with a one-tap switch – a cheap safeguard rather than a reshaped session model.

> **Promoted to load-bearing, 2026-08-26, by [ADR-005](../../adrs/ADR-005-bound-access-by-time-not-by-refusal-code.md).**
> That decision established that no client-observable signal distinguishes a deprovisioned Google
> Workspace account from a merely lapsed Google session, and removed the refusal-code classification
> that `offline-session-expiry` used to end a session on deprovisioning. **The bound specified here
> is now the only mechanism that will ever end a stored session other than an explicit sign-out.**
> It is no longer a defence-in-depth nicety alongside a Google-driven path — there is no Google-driven
> path. Two consequences for whoever specs this: the bound must hold on a session *restored on cold
> launch*, not only on a running one; and the 7-day margin it shares with the offline readability
> window is recorded there as "recommended", which should be ratified rather than left implied.

## Scope

### In Scope

- Whether a stored session has a lifetime bound, and what sets it.
- What bounds the session of someone who has joined no conference.
- Whether that bound shares a margin with the offline readability window.
- What the app shows on launch when a stored session exists.

### Out of Scope

- **S02's renewal mechanism (DR04).** Silent `prompt=none` re-authorization by top-level
  navigation, no refresh token, no iframe. Unchanged.
- **Server-side session revocation.** S02 TI10 settled this: "Access ends at the next request; no
  server-side eviction." Not reopened.
- **The cache purge triggers themselves.** S10 owns sign-out and user-switch purging; this
  clarification adds a reason the triggers fire, not a new teardown path.
- **Detecting whether a device is shared.** confApp cannot tell without asking, and the answer
  below makes asking unnecessary.
- **Offline reading rules** – see `docs/specs/offline-session-expiry/`, which this doc completes.

### MVP Boundary

Two pieces, both required: the lifetime bound, and the identity-plus-switch affordance on launch.
The bound without the affordance leaves someone holding another person's session for the whole
event; the affordance without the bound leaves a device signed in indefinitely if nobody ever taps
it. Neither carries the requirement alone.

### Not Doing (for now)

- **Expiring the stored session at the token's `expiresAt`** – **explicitly rejected.** `expiresAt`
  is the Google ID token's expiry, roughly one hour. Persistence across a conference works through
  silent renewal, not long-lived tokens, so expiring the session at token expiry would sign
  attendees out hourly and break S02 OC01 outright. Recorded because it is the intuitive fix and it
  is wrong.
- **Inactivity timeout** – an attendee who does not open the app between the morning and afternoon
  sessions would be signed out mid-conference, which is friction exactly where OC01 wants none.
- **An interstitial confirmation on every launch** – a tap between an attendee and "which room am I
  in", repeated all event, against a risk that is rare on personal phones.
- **A device-registration or kiosk mode** – no requirement asks for it.

## Functional Requirements

### User Stories

- As an **attendee**, I want to stay signed in across the whole conference without re-entering
  credentials, so that checking the schedule is instant. *(S02 OC01, preserved.)*
- As **someone who picks up a device that is not mine**, I want to see immediately whose session it
  is and be able to switch, so that I do not read another employee's data without realising.
- As the **company**, I want every session to be bounded by something, so that a device that is
  never signed out does not stay signed in indefinitely.

### Core Flows

1. **Launch inside the bound** – a stored session exists and is within its lifetime. The signed-in
   identity is shown prominently on launch, with a visible switch control. The schedule follows as
   normal. No re-authentication.
2. **Launch past the bound** – the stored session has passed its lifetime. It is cleared through
   S02's existing sign-out path, which fires S10's purge, and the sign-in screen is shown.
3. **Switching account** – the person taps the switch control. This is an ordinary sign-out
   followed by sign-in: the existing purge fires and the next identity starts clean.

### Alternate Flows

- **No conference joined** – the bound is the margin measured from sign-in.
- **Several conferences joined** – the bound is the latest of them, so an attendee mid-way through
  one event is never signed out because a different one ended.
- **Offline at launch, past the bound** – signed out as normal. Because the session bound and the
  offline readability window share a margin, the cached schedules lapse on the same clock, so there
  is no state where a schedule is still readable but the session behind it is gone.

### Session lifetime rule

A stored session remains valid until the **latest** of:

- each joined conference's `endDate` + margin, and
- the sign-in date + margin.

The second term is what bounds someone who has joined nothing, and it also covers an attendee who
leaves every conference. Recommended margin: **7 days**, shared with the offline readability window.

### UI Wireframes

Not produced here. The signed-in identity block already exists in the app shell; this makes it
prominent on launch and adds a switch control beside it. Must satisfy the standing 375 / 768 /
1280 legibility criterion, and the control must be reachable one-handed on a phone (S02 TI10's
existing constraint on the sign-out control).

## Design Decisions

### Design Space Decomposition

```
Session lifetime and launch identity
├── Device model
│   ├── Personal phones, essentially always            ← chosen
│   ├── Mixed personal and shared tablets
│   └── Shared tablets as a normal part of the setup
├── Session lifetime bound
│   ├── Conference end + margin                        ← chosen
│   ├── Unbounded until sign-out or user switch
│   ├── Inactivity timeout                             ✗ (pruned)
│   └── Absolute maximum, conference-agnostic          ✗ (pruned)
├── Bound with no conference joined
│   ├── Margin measured from sign-in                   ← chosen
│   ├── Unbounded until they join one
│   └── Bound to the token, re-authenticate hourly     ✗ (pruned)
├── Margin
│   ├── One value shared with the offline window       ← chosen
│   └── Independent values
└── Launch behaviour
    ├── Show identity + visible switch control         ← chosen
    ├── Nothing – restore straight into the schedule
    └── Require explicit confirmation each launch      ✗ (pruned)
```

### Cross-Consistency Notes

- **Session bound + offline readability window share a margin – deliberately coupled.** Both are
  measured from a conference's `endDate`, so they lapse together. Independent values would create
  two half-states: a readable schedule behind a lapsed session, or a live session over data that
  has stopped rendering, each needing its own defined behaviour for no benefit.
- **Token expiry is not session lifetime – conflating them breaks OC01.** See *Not Doing*. This is
  the single most important consistency constraint in this document.
- **Personal-phone device model + interstitial confirmation – incompatible in spirit.** Confirming
  identity on every launch prices the common case for a rare one. The chosen affordance costs
  nothing when the answer is "yes, me".
- **The bound is evaluated per person, not per conference.** Unlike the offline readability window,
  which S10 evaluates per cached entry, a session is a single object; the "latest of" rule is what
  keeps the two consistent without signing someone out mid-event.

### Resolved Decisions

| Dimension | Choice | Rationale |
|---|---|---|
| Device model | Personal phones, essentially always | Every employee has a company Google account and a phone; confApp is phone-first. The shared tablet in S02/S10's scenarios is illustrative, so this warrants a cheap safeguard rather than a session-model redesign. |
| Session lifetime | Latest joined conference's end + margin | Ties the session to the event it exists for, honouring OC01 across the whole conference and then stopping. |
| No conference joined | Margin measured from sign-in | Nothing is cached and nothing is readable offline in that state, so a tight bound costs that person nothing and leaves no unbounded hole in the rule. |
| Margin | One value, shared with the offline readability window | A single number to reason about, document and change; both lapse on the same clock. |
| Launch behaviour | Identity shown, switch control visible | Addresses the pick-up-someone's-device case with no re-authentication and no change to OC01. |
| Expiring at token expiry | Rejected | Would sign attendees out roughly hourly and break S02 OC01. |

### Open Design Questions

None at requirements level. Where the bound is evaluated, and whether it is checked on launch only
or also periodically, are implementation decisions for the `andthen:spec` skill.

## Edge Cases

| Scenario | Expected Behavior |
|---|---|
| Launch, session within bound | Identity shown prominently; schedule renders; no re-authentication |
| Launch, session past bound | Cleared through S02's sign-out path (firing S10's purge); sign-in screen shown |
| Signed in, no conference joined, within margin of sign-in | Session valid |
| Signed in, no conference joined, past margin of sign-in | Session cleared on next launch |
| Joined two conferences, the earlier one has ended | Session valid – bound is the later conference's end + margin |
| Attendee leaves every conference | Bound falls back to sign-in + margin |
| Conference is archived but its `endDate` has not passed | Bound follows the dates, not the lifecycle state – session still valid |
| Offline at launch, session past bound | Signed out; cached schedules have lapsed on the same clock, so nothing is stranded readable |
| Person taps switch on someone else's session | Ordinary sign-out and purge; next identity starts clean |
| Device clock moved backwards | Same limitation as the offline window: evaluated against the rehydrated effective clock, extendable by a deliberately altered device clock. Accepted for the same reasons |
| A person is signed in on two devices | Independent – bounds are per device, and there is no server-side session to revoke (S02 TI10) |

## Error Handling

| Error | User Message | Recovery |
|---|---|---|
| Session past bound on launch | "Your sign-in has expired. Sign in again to continue." | Sign-in screen; cache already purged by the sign-out path |
| Switch tapped while offline | "You need a connection to sign in as someone else." | The current session is *not* cleared, because clearing it offline would leave the device with neither a session nor a way to get one |
| Conference dates unavailable to evaluate the bound | Treat as no-conference: sign-in + margin | Bound never silently becomes unbounded when data is missing |

## Non-Functional Requirements

- **Performance**: the bound is a comparison against already-available dates; evaluating it must not
  add a network call or delay first render.
- **Security**: the bound is enforced client-side only, consistent with S02 TI10's "no server-side
  eviction". A determined holder of an unlocked device can already read what is on it; this bounds
  the casual case and the never-signed-out device, not a targeted attacker.
- **Privacy**: clearing a session past its bound must fire S10's existing purge, so the bound is a
  genuine data boundary and not merely a UI state change.
- **Accessibility**: the identity block and switch control must be legible with no horizontal body
  scroll at 375 px, 768 px and 1280 px, and the control reachable one-handed on a phone.

## Success Criteria

- [ ] A session whose latest joined conference ended within the margin is still valid on launch.
- [ ] A session whose latest joined conference ended longer ago than the margin is cleared on
      launch, and S10's purge is observed to fire.
- [ ] A session with no joined conference is valid within the margin of sign-in and cleared after.
- [ ] A session with two joined conferences, one ended and one current, remains valid.
- [ ] Token expiry alone never clears the stored session – asserted directly, since this is the
      rejected design and the intuitive thing to implement by mistake.
- [ ] S02's acceptance scenarios, including OC01's "stays signed in across the multi-day
      conference", still pass unchanged.
- [ ] The signed-in identity is present on launch, and a switch control is reachable from it.
- [ ] Tapping switch performs an ordinary sign-out, firing the same purge as the sign-out control.
- [ ] Tapping switch while offline leaves the existing session intact.

## Dependencies

| Dependency | Purpose | Risk |
|---|---|---|
| S02 `OC01`, session storage, sign-out hook | The session this bounds, and the path clearing it must go through | Medium – the bound must not be implemented as a token-expiry check, which is the intuitive reading and would break OC01 |
| S10 purge (sign-out / user-switch) | Makes an expired bound a real data boundary | Low – the trigger already exists; this adds a caller |
| `docs/specs/offline-session-expiry/` | Shares the margin, and its readability window is measured on the same clock | Low – decided together; the two documents must be amended together if the margin changes |
| Joined conferences' `endDate` | Sets the bound | Low – already carried through the cache by `listCachedConferences`, so it is available offline |
| App shell identity block (S02 TI10) | Where the identity and switch control live | Low – the control exists; this makes it prominent on launch |

## Open Questions

- Should the bound be re-evaluated while the app is open, or only on launch? Launch-only is simpler
  and sufficient for a phone-first app that is opened repeatedly during an event; a long-running
  session on a tablet left open for days would outlive its bound until next launch.
- Should joining a new conference extend an already-expired-but-not-yet-cleared session, or is the
  bound evaluated strictly at launch before any join is possible? Only observable in a narrow
  window; worth stating so an implementer does not have to guess.
- Area to revisit: what "prominent" means for the launch identity – whether it is the existing
  header treatment, a one-time confirmation on first launch of a day, or something between.
  Sharpened by a wireframe pass once the schedule screen's layout is settled.

## Decisions Log

| Decision | Rationale | Date |
|---|---|---|
| Devices are personal phones essentially always; the shared tablet is an edge case | Every employee has a company Google account and a phone. Warrants a cheap safeguard, not a session-model redesign | 2026-08-24 |
| A stored session is bounded by the latest joined conference's end date plus a margin | Ties the session to the event it exists for; honours OC01 across the conference and then stops | 2026-08-24 |
| With no conference joined, the bound is the margin from sign-in | Nothing is cached or readable offline in that state, so a tight bound costs nothing and closes the unbounded hole | 2026-08-24 |
| One margin, shared with the offline readability window; recommended 7 days | A single number to reason about; both lapse on the same clock, avoiding half-states | 2026-08-24 |
| On launch, the signed-in identity is shown with a visible switch control | Addresses picking up someone else's device with no re-authentication and no change to OC01 | 2026-08-24 |
| Expiring the stored session at the token's `expiresAt` is rejected | `expiresAt` is the ID token's ~1 hour expiry, not a session lifetime; this would sign attendees out hourly and break S02 OC01 | 2026-08-24 |
