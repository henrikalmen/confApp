# S10 Offline Schedule Access — Mixed Review

**Date**: 2026-08-24
**Reviewer**: claude (orchestrated, four fresh-context find-passes)
**Review mode used**: mixed
**Resolved chain**: guardrails → doc, code, gap, security
**Target**: S10 (Offline Schedule Access), plus S11 TI01's hand-written surface
**Implementation root**: `C:/git/confApp`
**Requirements baseline**: `docs/specs/conference-setup-and-schedule/s10-offline-schedule-access.md`
**Intent Context**: S10 FIS (OC01–OC04, Acceptance Scenarios S01–S08, TI01–TI11, 12 Structural Criteria)
**Source Trust**: trusted-local
**Reconciliation Ledger**: none present for S10
**Baseline at review**: `e95739b`, working tree clean; visual 71/71, unit 815/815, typecheck/lint/build clean

> **Why this review exists.** S10 and S11 are the only stories in the bundle with no review report
> (S05, S06 and S09 have one each). `docs/STATE.local.md` recorded both as self-reviewed. Every
> checkbox in the S10 FIS was `[x]` and `plan.json` records the story as `done`.

---

## Verdict

**NOT READY.** Three defects materially threaten the story's stated outcomes, one of which
defeats its headline guarantee in the field. S10's `done` status and several of its `[x]`
checkboxes are not carried by the evidence.

This is not a weak implementation. The offline layer is careful, well-commented work that
designed against most of the traps in `docs/LEARNINGS.md` on purpose — real IndexedDB rather
than a `Map`, offline simulated by failing transport rather than a flag, a fresh-process non-UTC
probe, cache-contents-not-request assertions in the service-worker suite. Four mutation tests
run during this review confirmed that load-bearing guards do fail when the behaviour is removed.
The findings below are where a checked box outruns its proof, plus three genuine functional gaps.

CONVERGED: **NO** — new `code-defect` findings at severity ≥ MEDIUM appeared.
Auto-Remediation: **PENDING**

---

## Corroboration across passes

Two findings were discovered independently by two passes approaching from different directions,
which raises confidence materially:

- **H1** — found by the code lens tracing the offline read path, and by the security lens tracing
  the credential path.
- **M2** — found by the code lens (`adoptCacheOwner` guard) and the security lens (fail-open purge).

---

## Findings

### H1 — An offline device with an expired ID token navigates away from the app instead of reading the cache
**Severity HIGH · Confidence 88 · Class `code-defect` · Routing `Note`**
**Location** `web/src/auth/session.ts:301-319`, reached via `web/src/api/client.ts:112-115` from
`web/src/offline/schedule-data.ts:55` and `web/src/attendee/AttendeeSchedulePanel.tsx:157,275,368`

Every offline read runs through `apiRequest`, which awaits `tokenSource()` **before** `fetch`.
When the stored token is at or past its renewal margin, `validToken()` performs a top-level
navigation to Google with no connectivity check. Offline, that navigation cannot complete, so the
browser replaces the SPA with its own network-error page. The cached envelope is intact in
IndexedDB and never read.

**Threatened invariant** — OC01/OC03 and PRD Reliability: "a schedule loaded at least once always
renders (FR8)"; and the FIS gotcha "No offline Attendee lands on a blank screen."

**Evidence** — the code states the mechanism itself:

```ts
// session.ts:308-311
// This is a top-level navigation, so nothing after it in this tab will run – and only the
// first caller may start it (see `renewalStarted`).
if (renewalStarted) return null;
renewalStarted = true;
await authorize({ returnTo: …, silent: true, loginHint: session.user.email });
```

The reasoning is correct for the online case and does not consider the offline one. Nothing on
this path consults `navigator.onLine`, a failed request, or the cache. `useOnline` exists but is
wired only into `JoinConferencePanel` and `LeaveConferenceControl`.

**Failure scenario** — Acceptance Scenario **S02 is unachievable in a real build**: a three-day-old
cache implies a token expired for roughly three days, so the scenario the FIS specifies is
*guaranteed* to hit this. Same for S08's force-quit relaunch at 12:40.

**Secondary** — the attempted URL carries `login_hint=<employee email>` into a shared device's
browser history.

**Impact** — The central promise of the story fails for any offline session older than the token
lifetime, i.e. most of the offline window the story exists for.

**Why `Note` and not `Fix`** — the correction is not mechanical and not uniquely determined: it
changes S02's credential API, and S10's own Structural Criterion says this story "introduces no
independent auth teardown or token handling." This needs an owner decision about where renewal
belongs, not a patch applied under a review.

**Suggested fix** — split the credential API so `validToken()` never navigates: it returns the
token or `null`, and a separate `renewIfPossible()` is reachable only from a path that has already
proven the network is up. The renewal navigation must be unreachable from `fetchAttendeeSchedule`,
`fetchMyConferences` and `fetchScheduleWatermark`.

**Verification needed** — render `AttendeeSchedulePanel` with a real `createAuthSession` whose
stored `expiresAt` is in the past, every fetch rejecting, `navigate` spied: assert `navigate` is
**not** called and the cached schedule renders. There is currently zero coverage of this
interaction — every offline test leaves `tokenSource` at its module default.

---

### H2 — The "what changed" summary never fires on a cold launch, which is the scenario it exists for
**Severity HIGH · Confidence 85 · Class `code-defect` · Routing `Note`**
**Location** `web/src/attendee/AttendeeSchedulePanel.tsx:267-336` (initial load), `:427-431` (gate)

The reconnect summary is set at exactly one place, gated on `rendered.cached` — true only when the
view is *already* rendering from cache in the same session. The initial-load effect never diffs,
and `fetchAndCacheSchedule` **overwrites the stored envelope before any diff could be taken**.
`readOfflineSchedule` appears only in the `catch`.

**Threatened invariant** — OC02, Acceptance Scenario S04, and TI06/TI07 for the app-resume path.
The FIS Intent says the summary reaches an attendee whose device was "offline **or asleep**", and
TI06 specifies "a connectivity/**app-resume** observer".

**Failure scenario** — offline overnight, iOS kills the app, attendee launches in the morning on
wifi. Correct current schedule renders; the deleted session she wrote down is never mentioned —
the exact harm `ReconnectSummary.tsx:15-17` names.

**Why the tests miss it** — all six summary tests and the visual spec follow one shape: render
offline → assert cached label → reconnect. None launches with connectivity over a stale entry.

**Suggested fix** — read the cache entry before `fetchAndCacheSchedule`; on success, when the
cached `conference.lastUpdatedAt` differs from the fetched one, feed `diffSchedule(cached.envelope,
schedule)` into `setReconnected` on the success branch too, gated on the same watermark rule.

**Verification needed** — seed a cache entry at watermark A, route the endpoint to watermark B with
one add/one move/one delete, mount **online from cold**, assert the summary names all three.
Confirm it fails against `e95739b` first.

---

### H3 — Force-quit on a shared device restores the previous employee's session, and no purge fires
**Severity HIGH · Confidence 90 · Class `code-defect` · Routing `Note`**
**Location** `web/src/auth/AuthProvider.tsx:166-172`, `web/src/auth/session.ts:131-133`

`current()` performs **no expiry check** — it deserializes whatever is in `localStorage`. On cold
launch `AuthProvider` restores it as signed-in and calls `claim(existing.user)`, which invokes
`adoptCacheOwner(anna.sub)` — matching the recorded owner, so nothing is purged.

**Threatened invariant** — OC04 / Acceptance Scenario S06: a shared device must show the next
employee nothing of the previous signer's Conference.

**Evidence** — the comment shows the author considered this launch and still missed the outcome:

```tsx
// A session restored from storage on a cold launch claims the store too – that launch is
// exactly the case where the previous session ended without a sign-out.
if (existing !== null) claim(existing.user);
```

`claim` is called with the *previous* user's sub, so the mismatch purge cannot fire.

**Failure scenario** — Anna reads the schedule on the shared tablet and walks away without signing
out. Björn launches confApp: it comes up **signed in as Anna** — her name and email in the header,
her Conference selected, her Schedule readable with the network off. If Björn never taps "Sign
out", no purge ever runs, and `LAST_SUB_KEY` never advances so the user-switch trigger stays
disarmed.

**Impact** — S10 makes this materially worse than before the story: previously the leaked surface
needed a live network and a valid token; now Conference name, Session titles and timestamps sit
durably on the device and render with no connection.

**Ownership** — the root cause is S02's session-restore policy, so the fix likely belongs there.
It is reported here because S10's OC04 is the requirement it breaks.

**Suggested fix** — `current()` refuses a session past its own `expiresAt` and clears it, which
makes the restore path fire the existing purge automatically. Pair with a "Not you? Switch
account" affordance so the purge is one tap away. Do **not** fix by purging on a matching owner —
that breaks the legitimate same-user relaunch the cache exists for.

---

### H4 — `transact` rejects instead of resolving `null`, skipping the purge and hanging the view
**Severity HIGH · Confidence 90 · Class `code-defect` · Routing `Fix`**
**Location** `web/src/offline/schedule-cache.ts:163`

The documented contract is "resolving with whatever the request produced, or `null` if anything
failed". `database.transaction(stores, mode)` sits inside the Promise executor but **outside** the
inner `try`; only `work(transaction)` is guarded. A throw from `transaction()` rejects the promise.
The outer block has `finally` but no `catch`, and no caller has one either.

**Consequences** — `purgeScheduleCache()` and `adoptCacheOwner()` are called as `void …`, so the
rejection is unhandled and **the purge does not happen**. On the read path the rejection escapes
the async IIFE, `setPhase` is never called, and the panel stays on `attendee-loading` — the
terminal-state prohibition in S03.

**Failure scenario** — a device whose `confapp-offline` database is at version 1 without the `meta`
store (an earlier build, a name collision). `onupgradeneeded` never re-runs because
`DATABASE_VERSION` is still `1`, so every `transact([META], …)` throws `NotFoundError`.

**Why `Fix`** — mechanical, bounded, uniquely determined: move one line inside the existing `try`.
Confidence 90, scope primary, no expansion beyond Intent.

**Suggested fix** — move `database.transaction(...)` inside the `try`; additionally make
`purgeScheduleCache`/`adoptCacheOwner` never reject.

**Verification needed** — with `fake-indexeddb`, pre-create the database with only the `schedules`
store; assert all four entry points resolve rather than reject, and that the panel reaches
`schedule-unavailable-offline` rather than staying on `attendee-loading`.

---

### M1 — A missing credential is classified as a server refusal and *deletes* the cached schedule
**Severity MEDIUM · Confidence 80 · Class `code-defect` · Routing `Note`**
**Location** `web/src/api/client.ts:112-115`, `web/src/attendee/AttendeeSchedulePanel.tsx:90-93,462-467`

`apiRequest` sends the request **without an `Authorization` header** when `tokenSource()` returns
`null`. The resulting 401 is not `unreachable()`, so the cached-phase catch calls
`forgetSchedule(conferenceId)` — destroying the offline copy because of a client-side credential
gap, on the device that has no connectivity to re-fetch. This also breaches the Structural
Criterion that the reconnect refresh is "an ordinary authenticated API request carrying the bearer
token".

**Suggested fix** — when `authenticated === true` and the token is `null`, do not issue the request;
throw `ApiError(status 0)`, which already routes to `unreachable()`. Mechanically secure because it
removes the ability to emit an unauthenticated call on an authenticated route at all.

---

### M2 — `adoptCacheOwner` fails open when the owner marker is absent
**Severity MEDIUM · Confidence 85 · Class `code-defect` · Routing `Fix`**
**Location** `web/src/offline/schedule-cache.ts:317`

`if (owner !== undefined && owner !== sub) await purgeNow();` — a store holding rows but no owner
record is adopted by any `sub` without being emptied. Note the asymmetry: a failed *read* returns
`null`, which does trip the purge; only a genuinely missing record returns `undefined` and skips it.
Every `transact` failure is swallowed, so a failed owner write is indistinguishable from a
successful one and leaves `owner === undefined` permanently.

**Why `Fix`** — one-line, uniquely determined, fails closed. Purging an already-empty store costs
nothing.

**Suggested fix** — `if (owner !== sub) await purgeNow();`

**Mitigating** — the `LAST_SUB_KEY` marker in localStorage is a complementary trigger in a
different storage bucket; both must fail together. That redundancy is deliberate and good design.

---

### M3 — A malformed `serverNow` in a **successful** response is reported to the attendee as being offline
**Severity MEDIUM · Confidence 85 · Class `code-defect` · Routing `Note`**
**Location** `web/src/attendee/AttendeeSchedulePanel.tsx:281-285`, `:421-425`

`clockFromSync(...)` is evaluated inside the `try` whose `catch` treats any non-`ApiError` as the
network being gone. `unreachable()` returns `true` for a parse throw from a 200 response, so a
server-side format regression degrades into a fleet-wide stale-schedule state labelled "Offline",
misdirecting both the attendee and the on-call engineer toward the network.

---

### M4 — Reaching `unavailable-offline` then reconnecting with zero joined conferences is a dead end
**Severity MEDIUM · Confidence 90 · Class `code-defect` · Routing `Note`**
**Location** `web/src/attendee/AttendeeSchedulePanel.tsx:149-211`, `:623-630`, `:696-713`

`loadConferences`' success path never clears `phase`, so an `unavailable-offline` phase set from a
*list* failure survives a successful reconnect when the list is empty — and that same phase value
suppresses the correct "you have not joined a conference yet" hint. The attendee sees a message
about a conference that does not exist, and "Try again" reproduces it. This is exactly the
attendee (Björn, joined nothing) that Acceptance Scenario S06 describes.

---

### M5 — The cache key is resolved *after* the response lands
**Severity MEDIUM · Confidence 70 · Class `code-defect` · Routing `Note`**
**Location** `web/src/offline/schedule-data.ts:51-97`

The bearer token is read at the start of the request; `cacheIdentity()` is read one round trip
later, live from `localStorage`, which is shared across tabs. A response fetched under Anna's token
can be filed under Björn's `sub` if he completes sign-in in another tab mid-flight — a cross-`sub`
write that lands *after* the purge. `primeScheduleCache` widens the window by passing no
`AbortSignal`.

**Suggested fix** — capture the subject before the request, compare after, write under the captured
value; pass an `AbortSignal` into `primeScheduleCache`.

---

### M6 — The service worker's `activate` cleanup can never evict a superseded asset set
**Severity MEDIUM · Confidence 92 · Class `code-defect` · Routing `Note`**
**Location** `web/public/sw.js:20`, `:126-136`

`CACHE_NAME` is a build-invariant constant and the only name the worker ever opens, so the
`names.filter(name => name !== CACHE_NAME)` in `activate` is always empty. One full `/assets/*` set
accumulates per deployment, forever. Compounding: `sw.js` contains no build-varying token, so a
deployment does not change its bytes, the worker is not re-installed, `precacheShell` never
re-runs, and the precached `/` entry stays pinned to build 1.

Cache Storage and IndexedDB share one origin quota, so this raises the probability of the eviction
that takes the cached Schedule with it. This **falsifies** the Implementation Observation calling
it "bounded and harmless" — it is bounded only by deployment count.

---

### M7 — The service-worker registration has zero automated coverage
**Severity MEDIUM · Confidence 95 · Class `code-defect` · Routing `Note`**
**Location** `web/src/main.tsx:35-41`; FIS TI10

**Proven by mutation**: the registration block was disabled and the full web suite ran
**297 passed, 0 failed**. `service-worker.test.ts` drives `sw.js` in a `vm` sandbox and never
touches registration; the visual spec aborts only `/api/` routes so the worker is never exercised.
A wrong path, a scope mistake, an inverted `PROD` gate, or `sw.js` missing from the build output all
ship green. TI10 is the one task standing between an offline web launch and the browser's error
page, and its wiring is unverified. *(The FIS Implementation Observations disclose this honestly —
but TI10 is still `[x]`.)*

---

### M8 — TI06's re-anchor clause is implemented only for the reconnect path
**Severity MEDIUM · Confidence 90 · Class `spec-stale` · Routing `Note`**
**Location** `web/src/attendee/AttendeeSchedulePanel.tsx:380-385`

TI06's Verify says an unchanged-watermark refresh "**still rewrites** the entry's
`deviceClockAtReceipt` and `serverNow` anchor". The steady-state online poll returns early and
leaves both untouched, so a device online for eight hours then losing signal reports "Updated 8
hours ago" over data verified seconds earlier. Disclosed in Implementation Observations, but the
checkbox sits over unqualified Verify text. **Reconcile**: fix the code or amend the task text —
the current state is a claim the implementation does not meet.

---

### M9 — Acceptance Scenario S08's own test cannot detect the defect the FIS names
**Severity MEDIUM · Confidence 92 · Class `code-defect` (test) · Routing `Note`**
**Location** `web/test/AttendeeScheduleOffline.test.tsx:1100-1131`

**Proven by mutation**: `anchorOf` was changed to `deviceClockAtReceipt: Date.now()` — precisely the
FIS's named "Avoid" — and **the S08 test passed**. Two other tests caught it, so the property does
hold and the defect would not ship; but S08's checkbox is not carried by the scenario test it names.
Delete either of those two other tests and the property is lost with S08 still green.

This is the `LEARNINGS.md` trap "a regression test written beside its fix usually passes without the
fix" appearing in a new place.

---

### M10 — The sign-in identity-mismatch purge is proven only at unit level
**Severity MEDIUM · Confidence 88 · Class `code-defect` (test) · Routing `Note`**
**Location** `web/test/offline-cache-purge.test.tsx:176-216`

The integration test whose comment claims it is "driven by the signed-in identity differing" never
calls `adoptCacheOwner(ANNA)`, so the META owner record is absent and the mismatch guard never
fires. The purge that empties the store actually comes from the `lastSub` localStorage hook.
**Proven by mutation**: disabling the purge inside `adoptCacheOwner` and running the entire web
suite gives **1 failed, 296 passed** — only the unit test. One leg of a deliberately redundant
privacy control is integration-untested.

---

### M11 — `docs/ARCHITECTURE.md` still declares the project unimplemented
**Severity MEDIUM · Confidence 98 · Class `spec-stale` · Routing `Note`**

The doc says "No code exists yet – this document describes intent" and lists the React SPA and
Capacitor shell as `_not yet scaffolded_`, while ~50 test files, both containers, the offline layer
and the native projects are shipped. It also contradicts itself and STACK.md about whether the API
or nginx serves the SPA (`:20` vs `:8`).

**Why this matters here** — the S10 FIS names `ARCHITECTURE.md#key-constraints` as *Deeper Context*.
A future story reading it is told the codebase does not exist and gets no pointer to the offline
layer it must not fork — the precise failure mode S10's "do not build a second X" rules exist to
prevent.

---

### M12 — `capacitor.config.ts` states a wrong, load-bearing mechanism for `appId`
**Severity MEDIUM · Confidence 88 · Class `code-defect` (doc) · Routing `Note`**
**Location** `web/capacitor.config.ts:8-13`, propagated to `s11-capacitor-mobile-shells.md:95,246`

The comment names `appId` as part of the WebView origin that partitions IndexedDB. It is not — the
origin is scheme + hostname only, as the same file states correctly two lines later. `appId` is the
Android package name / iOS bundle ID.

The error **understates** the blast radius: a reader may think an `appId` change is a cache-clearing
migration recoverable by re-sync, when it is a new application identity — fresh OS data container,
invalidated Google OAuth client bindings (TI04), no upgrade path for installed users. This is the
load-bearing claim of the only file S11 TI01 shipped.

---

### M13 — `main.tsx` comment claims the Capacitor shells register nothing; there is no platform guard
**Severity MEDIUM · Confidence 85 · Class `code-defect` (doc) · Routing `Note`**
**Location** `web/src/main.tsx:33`

A shell bundle *is* a `vite build` output, so `import.meta.env.PROD` is true, `cap sync` copies
`dist/sw.js` into both native projects, and Android's WebView at `https://localhost` exposes
`navigator.serviceWorker`. Only iOS registers nothing, and that is the custom scheme's doing rather
than the comment's claim. The S11 FIS agrees with the code, not the comment. This misdirects S11
TI08's on-device verification, which lists "service-worker **absence**" as the thing to confirm.

---

### G1 — AI attribution in commit trailers, against an absolute project rule
**Severity HIGH · Confidence 100 · Class `code-defect` · Routing `Note`**
**Location** commits `f85fa10`, `8ce4025`, `b4d72b3`, `782015c`

`docs/guidelines/CRITICAL-RULES-AND-GUARDRAILS.md:31` — "**No AI attribution** anywhere (code,
commits, PRs, git trailers) – **overrides any harness default**." Four commits carry
`Co-Authored-By: Claude …` and `Claude-Session: …` trailers. The rule anticipates precisely the
harness default that produced them.

`f85fa10` also violates the adjacent rule "Commit messages must be extremely brief and clear; avoid
long prose" — its body runs 25 lines.

**Remediation constraint** — `origin/main` is at `e95739b` with zero commits ahead, so **the branch
is pushed**. Rewriting history would require a force-push to `main`. Recommendation: stop emitting
the trailers and leave the four commits alone; a rewrite is an owner decision, not a review action.

---

## Lower-severity findings

| ID | Severity | Location | Finding | Routing |
|---|---|---|---|---|
| L1 | LOW | `cached-age.ts:33` | Label hard-codes "Offline" but the `cached` phase is entered for a 5xx from a live server (and, per M3, a parse throw from a 200). Misdirects troubleshooting during an API restart. | Note |
| L2 | LOW | `schedule-cache.ts:255`, `schedule-data.ts:83,90` | Four guards drop a cache write with no return value, no signal, no diagnostic. A fleet-wide silent stop would first surface as attendees reporting "not available offline" on the day. | Note |
| L3 | LOW | `schedule-cache.ts:116-118` | `onblocked` resolves `null` without aborting the open request; a late `onsuccess` orphans a live connection. Latent until `DATABASE_VERSION` is bumped, then a self-sustaining stall. | Note |
| L4 | LOW | `AuthProvider.tsx:109`, `schedule-data.ts:83` | Identity guards test `=== null` only; an empty-string `sub` is a valid IndexedDB key component and would collapse two identities into one key space. | Note |
| L5 | LOW | `sw.js:187-201` | `storeShell` files any 200 same-origin HTML navigation body as the shared shell. Safe today only because nginx serves a static `index.html`; the guarantee lives in a different artifact from the worker. Suggested: fetch the shell with `credentials: 'omit'` so it is user-neutral by construction. | Note |
| L6 | LOW | `sw.js:71-74` vs `nginx/default.conf.template:23` | The worker compares a raw undecoded `pathname` against `/api/`; nginx matches a decoded, normalized URI. Three encoding/traversal variants were attempted and **all fail closed** — but only because the cache rule is a whitelist, not because the prefix check is sound. | Note |
| L7 | LOW | `schedule-cache.ts:152-181`, `AuthProvider.tsx:116-130` | Every purge is fire-and-forget over a layer that swallows all failures. The UI reports sign-out complete before the purge has opened the database, and reports it complete whether or not it succeeded. | Note |
| L8 | LOW | `schedule-cache.test.ts:344`, `AttendeeScheduleOffline.test.tsx:1159` | Structural Criteria 6/7/11 are proven by greps over hardcoded file lists omitting `LeaveConferenceControl.tsx`, `JoinConferencePanel.tsx` (the two mutating affordances), `staleness.ts`, and `sw.js`. An outbox in `JoinConferencePanel` or a Background Sync registration in `sw.js` would leave every structural test green. The properties **do** currently hold codebase-wide (verified). | Note |
| L9 | LOW | `LeaveConferenceControl.test.tsx`, `JoinConferencePanel.test.tsx:491` | S07's "an in-flight mutating request is attempted" half is untested for the captive-portal case (`onLine === true`, transport throws) that `use-online.ts:8-12` explicitly calls out. | Note |
| L10 | LOW | `docs/STACK.md:26,41` | Capacitor row reads `_TBD_` / "Owned by S11" though 8.5.0 shipped; auth row says "no authentication code exists yet" though S02 shipped. No row for IndexedDB, the service worker, `fake-indexeddb`, or `@testing-library/user-event`. | Note |
| L11 | LOW | `docs/KEY_DEVELOPMENT_COMMANDS.md:143-145` | The visual-validation table promises `screenshots/phone-375.png` etc.; every spec writes `<surface>-<viewport>.png` and a repo-wide grep for the promised names returns zero hits. The file's own header claims every command was run as written. | Note |
| L12 | LOW | `docs/KEY_DEVELOPMENT_COMMANDS.md` | No Capacitor section, so the build-order footgun `capacitor.config.ts` warns about ("`cap sync` never builds") has no documented command and no npm script. | Note |
| L13 | LOW | `s10-*.md:107,38,132` | Structural Criterion asserts "S11 has not run when this story lands" — S11 TI01 has since run and `@capacitor/*` are runtime dependencies. The enforced invariant (no `@capacitor` import under `web/src/offline/`) still holds. | Note |
| L14 | LOW | `s10-*.md:146` vs `schedule-cache.ts:48` | The FIS says the stored `watermark` field does "double duty"; the shipped field is written and never read. Self-disclosed in Observations, but the Technical Overview still presents it as load-bearing. | Note |
| L15 | LOW | `KEY_DEVELOPMENT_COMMANDS.md:151`, `s11-*.md:246-296` | Em dashes against the standing "en dashes, not em dashes" rule (16 occurrences, confined to two recently authored files). | Note |

### Scope creep

| ID | Location | Note |
|---|---|---|
| C1 | `schedule-cache.ts:140-150` | The `exclusively` serializer ships with an in-file admission that **no test fails when it is removed**. No criterion requires ordering. Untested shipped code on the privacy-critical purge path — constrain it or drop it. |
| C2 | `AttendeeSchedulePanel.tsx:724-738` | `attendee-schedule-empty` is a UI state no scenario or task names. Justified by OC03's blank-screen prohibition and disclosed, but unscoped. |
| C3 | `schedule-data.ts:132-147` | `listCachedConferences`' `localeCompare`-then-`[0]` selection ignores the server's `defaultConferenceId` and is locale-dependent. It determines which Conference an attendee lands on mid-event — worth escalating from Note to a decision. |

---

## Guardrails Coverage

**18 checked, 5 findings** (G1; L15; the WebView-navigation exposure below; M12 and M13 reported as
doc findings).

Verified clean: offline scope not widened beyond schedule reads (no outbox/queue/replay anywhere);
`sub` never email; no web push (`PushManager`/`showNotification`/`web-push` = 0 hits); no `.env`
tracked and no secret in `config.js`; responsive assertions at all three widths; no in-process
server state; ADR-003/ADR-004 portability untouched. Not applicable, stated explicitly: vote
anonymity (no voting code in scope), schema portability (no DB change), roles from directory groups
(no role code).

**Additional guardrail exposure** — with S11 TI01 landed, the shells are buildable and ship no
`allowNavigation` policy and no auth-session adapter, so the SPA's same-window authorization
redirect would render Google's sign-in **inside the embedded WebView** — forbidden by AGENTS.md.
Not a shipped-criterion violation (TI04/TI09 are `[ ]`), but it is now reachable by anyone running
`npx cap open android`, and it is the highest-consequence item left on the S11 board.

---

## Coverage Matrix

| Surface | Evidence read | Positive proof | Falsifier attempted | Result |
|---|---|---|---|---|
| `schedule-cache.ts` (357L) | full; test suite; `fake-indexeddb` | Key `[sub, conferenceId]`, no `keyPath`; list read re-filters on `sub`; `usable()` probes a real clock build | cross-`sub` read; IDB unavailable/quota/blocked/upgrade-abort; write-vs-purge race | **findings** H4, M2, L2, L3 |
| `schedule-data.ts` (163L) | full; `client.ts`; `session.ts` | Envelope stored verbatim; receipt clock read once; write isolated so storage failure ≠ unreachable | key resolution end-to-end; raw clock; sign-out ordering | **findings** M5, L2, L4 |
| `cached-age.ts`, `use-online.ts`, `ReconnectSummary.tsx`, `schedule-change-lines.ts`, `staleness.ts` | all full | Age = deviceNow − receipt, clamped; `onLine` never gates rendering; single wording source | no `Date`/`toLocale` on displayed values; second diff | **covered**; L1 on wording |
| `AttendeeSchedulePanel.tsx` (offline paths) | full; `effective-clock.ts` | Both render inputs supplied; never renders with `now === null`; poll is the reconnect detector | expired token; parse throw on 200; empty-list reconnect | **findings** H1, H2, M3, M4 |
| `web/public/sw.js` (252L) | full; SW test inventory; LEARNINGS §SW | `/api/` excluded before the navigate clause; whitelist not blacklist; `storeShell` rebuilds the Response (recorded `?code=` fix **verified holding**); `isHtml` gate | activate eviction across a deployment; 3 encoding/traversal variants | **findings** M6, L5, L6 |
| Auth wiring (`AuthProvider.tsx`, `session.ts`) | full | Purge on S02's single hook; `claim()` on both paths; `sub` never email; `SESSION_KEY` cleared before listeners fire | force-quit restore; concurrent write vs purge (**could not construct one** — three independent barriers) | **findings** H1, H3, M1, M2 |
| Acceptance Scenarios S01–S08 | all traced to code + named test | S01, S02, S03, S05 earned | ✔ 4 mutations executed and reverted | S04 → H2; S06 → M10; S07 → L9; S08 → M9 |
| Structural Criteria 1–12 | all traced | SC1, SC2, SC4, SC5, SC7, SC9, SC10, SC11 earned (SC9 strong — navigation-keying mutation failed 4 tests) | ✔ codebase-wide greps; mutations | SC3, SC6 earned but **weakly proven** (L8); SC12 not re-executed here |
| TI01–TI11 | all traced | — | ✔ registration disabled → 297/297 still pass | TI10 → M7; TI06 → M8 |
| `capacitor.config.ts`, `eslint.config.js`, `.prettierignore` | all full | Ignore rationale matches Capacitor's own `.gitignore`; no hand-authored TS/JS under the native trees | `appId`-in-origin claim tested against the file's own origin list | **finding** M12 |
| `ARCHITECTURE.md`, `STACK.md`, `KEY_DEVELOPMENT_COMMANDS.md`, S10 FIS | all full | — | Compared every claim against shipped code; grepped for the promised screenshot filenames (0 hits) | **findings** M11, L10, L11, L12, L13, L14 |
| `ADR-002` | **not read by the security pass** (reported unreadable at its path; it exists and is readable) | — | — | **coverage caveat** — AGENTS.md restatements substituted |

**Not reviewed**: the API side; `ScheduleView.tsx` / `schedule-view-model.ts` internals (S06-owned,
read only far enough to confirm the two-input contract); SC12 visual execution (passing at HEAD in
the 71/71 run, not independently re-executed inside this review).

---

## Routing summary

| Routing | Count | IDs |
|---|---|---|
| **Fix** | 2 | H4, M2 |
| **Note** | 28 | H1, H2, H3, M1, M3–M13, G1, L1–L15, C1–C3 |

Only two findings meet the Fix bar (confidence ≥75, primary scope, `code-defect`, mechanical and
uniquely determined). Both are one-line changes that fail closed. Everything else needs either a
design decision, a cross-story change, or new tests — none of which a review should apply
unilaterally.

## Recommended order

1. **H4** and **M2** — one-line, fail-closed, no design decision. Do these first.
2. **H1** — the largest functional risk; needs an owner decision about where token renewal belongs.
3. **H3** — privacy; root cause in S02, so scope it deliberately.
4. **H2** — functional gap in OC02 on the most likely real-world path.
5. **M7, M9, M10** — proof-hardening on properties that presently hold but are not carried by the
   tests that name them.
6. **M8** — reconcile TI06: fix the code or amend the task text; the current `[x]` over unqualified
   Verify text is the mismatch.
7. **M11, L10–L12** — documentation that actively misleads the next story.
8. **G1** — stop emitting AI trailers; leave history alone absent an explicit decision.

## Consequence for plan status

`plan.json` records S10 as `done` and every FIS checkbox as `[x]`. On this evidence:

- **S04** (reconnect summary) is not earned for the app-resume path — H2.
- **TI10** (offline launch) has no automated leg at all — M7.
- **TI06**'s Verify text is not met — M8.
- **S06**'s identity-mismatch leg is unit-only — M10; **S08**'s own test does not discriminate — M9.

Marking those boxes back to `[ ]`, or amending the claims to match what shipped, is a
`andthen:ops` action and an owner decision — not something this review performs.
