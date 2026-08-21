# S11 – Capacitor Mobile Shells

**Plan**: docs/specs/conference-setup-and-schedule/plan.json
**Story-ID**: S11

## Feature Overview and Goal

**Intent**: Every attendee follows this conference from a phone, and until the same built web assets actually install, sign in and read a cached Schedule on real Android and iOS hardware, "one codebase, three targets" (ADR-001, REQ-002) is an untested claim – and the two things most likely to be false are precisely the two that only fail on device: an OIDC flow Google refuses inside an embedded WebView, and a schedule cache the WebView evicts or partitions away.

**Expected Outcomes** (each `[OC<NN>]`-tagged; scenarios anchor to these):

- [OC01] The same built web assets install and launch as an Android application and an iOS application on physical devices, with no separately maintained mobile copy of the app.
- [OC02] An employee signs in on a device through the **platform system browser** – `ASWebAuthenticationSession` on iOS, Chrome Custom Tabs on Android – is returned into the app by the redirect, and the next API call is accepted; credentials are never typed into confApp's own WebView.
- [OC03] A Schedule loaded once on a device is still readable after force-quitting the app and relaunching it with no connection, and reads exactly as authored regardless of the device's timezone; a different employee signing in on the same device sees none of it.
- [OC04] The Schedule is legible on a real phone and a real tablet on both platforms – nothing under the notch, status bar or home indicator, no horizontal scroll, and no platform-forked layout.


## Required Context

- `docs/adrs/ADR-001-mobile-packaging-capacitor.md#decision` – binding: the **same built web assets** are wrapped in a native WebView shell for Android and iOS. Also read the Consequences (macOS + Xcode required for iOS) and the **Distribution note + Amendment** – the channel is deliberately unsettled and this story must not close it.
- `docs/adrs/ADR-002-authenticate-with-google-workspace-oidc.md#decision` – "On mobile, the flow runs in the system browser (`ASWebAuthenticationSession` on iOS, Chrome Custom Tabs on Android) rather than an embedded WebView." This is the story's single most important rule; `hd` stays verified server-side and identity stays keyed on `sub`.
- `docs/adrs/ADR-004-containerized-api-and-spa.md#decision` – binding: the API is a **long-running HTTP server in a container** (not Azure Functions) and the SPA is built to static assets served from a static-file container. For this story the consequence is narrow but concrete: the shells talk to that API over HTTPS like any other client, and the API base URL is **runtime configuration, not a build-time constant** – so pointing a shell at an environment is a packaging-time act, not a rebuild of the SPA (see *Constraints & Gotchas*).
- `docs/specs/conference-setup-and-schedule/s02-google-workspace-sign-in.md#structural-criteria` – binding: `aud` is already validated against a **configured allow-list of confApp's own per-platform OAuth client IDs**, with no wildcard, no pattern match and no mobile-skip branch, and startup fails on an empty or wildcard list (S02 TI01, TI03). The validation logic exists and is S02's; this story only registers the mobile clients and populates that list.
- `docs/specs/conference-setup-and-schedule/prd.md#constraints` – **Binding Constraint (FR4)**: "Session times are **naive wall-clock values** – stored and displayed without timezone conversion. A session at 09:00 reads as 09:00 on every device regardless of its timezone setting." A phone carried across a timezone boundary, or set to a 12-hour locale, is where this breaks in practice. Same section: the client is a React SPA packaged with Capacitor and **all three surfaces share one codebase**.
- `docs/specs/conference-setup-and-schedule/prd.md#non-functional-requirements` – **Binding Constraints (NFR)**: Security – `hd` claim verified server-side on **every** request (ADR-002); Portability – plain PostgreSQL only, no provider-specific extensions (ADR-003); Usability – responsive verified at 375px / 768px / 1280px per `AGENTS.md`, legible at 375px without horizontal scroll. The security row binds directly: a request from a shell gets no exemption from validation. The portability row is not narrowed – this story adds no schema, so it holds by containing no database work at all. Also the Reliability row: "A schedule loaded at least once always renders."
- `docs/specs/conference-setup-and-schedule/prd.md#fr8-offline-schedule-access` – **Binding Constraint (FR8)**: "Offline scope is read-only – no schedule editing, joining, or leaving offline. […] Cached data is cleared on sign-out and when a different user signs in on the same device." S10 implements it; this story proves it true inside a WebView on both platforms, which is the only place the claim has never been tested.
- `docs/specs/conference-setup-and-schedule/plan.json#bindingConstraints` – the plan's full constraint set. The FR3 (join-code limiter) and FR5 (role assignment) entries have no surface in this story: it adds no join-code path and no role decision.
- `AGENTS.md#do-not--never` – four prohibitions bind here: **never run the OIDC flow in an embedded WebView**, never trust the `hd` request parameter, never use web push, never ship a fixed-width or desktop-only layout. Plus the standing fact that mobile is packaged with Capacitor and the same built assets run in the shell.
- `docs/guidelines/CRITICAL-RULES-AND-GUARDRAILS.md#honesty-and-verification` – this is an **enabler** story judged by device builds and on-device behaviour: "done" is false if any check was performed only in a desktop browser or a simulator where the criterion says device.


## Deeper Context

- `docs/specs/conference-setup-and-schedule/s02-google-workspace-sign-in.md#technical-overview` – the `withAuth` wrapper, the `AuthenticatedCaller` shape, and TI07–TI10 (PKCE authorization request, callback with `state`/`nonce` checks, renewal, sign-out hook). S02 explicitly leaves the mobile system-browser flow and its app redirect to this story and shares everything else unchanged.
- `docs/specs/conference-setup-and-schedule/s01-tracer-bullet-skeleton.md#constraints--gotchas` – the single configurable API base URL, emitted as **runtime** configuration the static container materializes at start rather than baked at build time ("relative `/api` works in the browser but not inside the Capacitor WebView"), and the error-envelope shape; `#implementation-tasks` TI10 is that runtime-config mechanism and TI13/TI14 are the `docs/STACK.md` and `docs/KEY_DEVELOPMENT_COMMANDS.md` rows this story completes for Capacitor.
- `docs/specs/conference-setup-and-schedule/s10-offline-schedule-access.md#structural-criteria` – IndexedDB for data, a static-assets-only service worker for the web build, purge on sign-out **and** on `sub` mismatch at sign-in. S10 chose that path partly because it lands before the shells exist; **verify it, do not assume it** (see *Constraints & Gotchas* on storage partitioning and service-worker registration).
- `docs/specs/conference-setup-and-schedule/s06-attendee-schedule-view.md#technical-overview` – the schedule envelope and the effective-wall-clock arithmetic whose device behaviour is checked here; `#structural-criteria` pins that no Session time passes through `Date`, `toLocaleTimeString` or `Intl.DateTimeFormat`.
- `docs/ARCHITECTURE.md#key-constraints` – "One codebase, three targets (browser, Android, iOS) – platform-specific forks are a last resort, not a default."
- `docs/DECISIONS.md#pending` – **Mobile distribution channel** and **Push delivery service** are both open. Building the shells does not require closing either, and this story must leave both open.
- `docs/ROADMAP.md#phase-2-scaffold` – "Capacitor shells build for Android and iOS" is the success criterion this story satisfies.


## Acceptance Scenarios

- [ ] **S01 [OC01] [TI01,TI02,TI03] The same built web assets install and launch on a physical Android phone and a physical iPhone**
  - **Given** a clean checkout with the web build, API and database working per S01
  - **When** the developer runs the documented build-and-sync flow and installs the resulting Android and iOS builds on connected physical devices
  - **Then** both applications launch to confApp's signed-out sign-in screen and reach the API successfully from the device
  - **And** changing a visible string in the SPA source and repeating the same flow changes it in **both** installed applications – neither shell holds its own copy of the web assets

- [ ] **S02 [OC02] [TI04,TI05,TI06] iOS sign-in runs in `ASWebAuthenticationSession` and the redirect returns Anna into the app signed in**
  - **Given** Anna (`anna@<company-domain>`) has the iOS build installed on her iPhone and is signed out
  - **When** she taps Sign in
  - **Then** the authorization request is carried by an `ASWebAuthenticationSession` – asserted at the native call site, which is the only observable that cannot be faked by a session that merely *looks* right – and Google's consent screen appears in that session, never in confApp's WebView
  - **And** `prefersEphemeralWebBrowserSession` is left at its default (false), so iOS's own consent alert naming `google.com` appears before any web content loads and stands as corroboration; setting it true suppresses that alert, which is exactly why the alert alone is not the contract
  - **And** on completing consent the session closes, the custom-scheme redirect returns her into the app, and the next API call carries her ID token and is accepted with her name shown as signed in

- [ ] **S03 [OC02] [TI04,TI05,TI06] Android sign-in runs in a Chrome Custom Tab and survives the activity being destroyed behind it**
  - **Given** Björn has the Android build installed on a physical phone with "Don't keep activities" enabled in developer options, and an existing Google session in Chrome
  - **When** he taps Sign in
  - **Then** the authorization page opens in a Chrome Custom Tab showing the browser's host indicator and offering his existing Chrome Google session – confApp's WebView never navigates to the authorization endpoint
  - **And** after he completes consent (with confApp's activity destroyed in the background meanwhile) the redirect returns into the app, the PKCE verifier and `state` from the initiating request are still available, and he is signed in

- [ ] **S04 [OC02] [TI05] The authorization request cannot be loaded inside the app's own WebView**
  - **Given** either shell is installed and running
  - **When** a navigation to Google's authorization endpoint is attempted from inside the WebView – by a link, a redirect, or the sign-in code being pointed at it directly
  - **Then** the WebView does not render Google's sign-in page: the navigation is refused or handed to the system browser, the WebView stays on the app origin, and no credential entry field belonging to Google is ever displayed inside confApp's own web view
  - **And** no configuration permits it – the shells' allowed-navigation set contains no external host, so the failure mode is a blocked navigation rather than a page that happens to work today and is refused by Google as a disallowed user agent tomorrow

- [ ] **S05 [OC03] [TI07,TI08] A cached Schedule survives a force-quit and relaunches with no connection, on both platforms**
  - **Given** Nadia has joined "Kickoff 2026" and opened its Schedule once online in the installed Android application, and again in the installed iOS application
  - **When** on each device she enables airplane mode, force-quits the application from the task switcher, and launches it again
  - **Then** the Schedule renders through the normal schedule view with its cached-data label and last-updated time, on both platforms – no blank screen, no spinner without an end, no browser-style offline error
  - **And** reinstalling the same application over the top (a rebuilt shell, same configuration) still reads the same cached Schedule, because the storage origin did not move

- [ ] **S06 [OC03] [TI09] A shared conference tablet shows the next employee nothing of the previous signer's conference**
  - **Given** Anna is signed in on a shared iPad with "Kickoff 2026" cached and readable offline
  - **When** Anna signs out and Björn signs in on the same device, and separately when Anna's session ends by force-quitting the app and Björn signs in on the next launch
  - **Then** in both cases no Conference name, Session title or cached timestamp from Anna's session is readable anywhere in the app, and the cached entry is gone from device storage rather than merely hidden

- [ ] **S07 [OC04] [TI10] The Schedule is legible on a real phone and a real tablet, clear of the system UI**
  - **Given** a Conference Day holding a concurrent pair, a currently-running highlighted Session and a long Session title
  - **When** the schedule view is opened on a notched iPhone, a physical Android phone and a tablet, in portrait and landscape
  - **Then** the header, day navigation, Session rows, concurrency marking and running highlight are fully visible and readable, with nothing obscured by the notch, status bar, gesture bar or home indicator, no horizontal scroll, and the day navigation reachable one-handed on the phones
  - **And** the same views at 375px / 768px / 1280px in the browser are unchanged by whatever made the device layouts correct – there is no phone-only or platform-only layout


## Structural Criteria

- [ ] `android/` and `ios/` contain no hand-edited or separately committed copy of built web assets; the only path from source into either shell is the web build plus `cap sync`, and build outputs are git-ignored.
- [ ] No platform-conditional branch exists in SPA feature code. Platform differences are confined to two named seams: the auth-session adapter and safe-area styling (`docs/ARCHITECTURE.md#key-constraints`).
- [ ] Neither mobile bundle contains an OAuth client secret; the mobile flow is PKCE-only.
- [ ] S02's existing audience allow-list is **populated correctly for both platforms** – the deployed configuration carries confApp's Android client ID and its iOS client ID alongside the web one, each a literal client ID, and a real device sign-in on each platform is accepted by the running API. No wildcard entry is introduced, no "skip `aud` on mobile" branch is added, and S02's validation code – audience comparison, `hd`, issuer, signature, expiry – is not modified by this story (NFR Security; S02 Structural Criteria).
- [ ] The shells reuse S02's token validation and S10's cache module unchanged: no second auth implementation, and no Capacitor-only storage path that would break S10's guarantee of working in the plain web build.
- [ ] Capacitor `appId`, scheme and hostname are fixed in tracked configuration and documented as change-sensitive, because they define the WebView origin that partitions S10's IndexedDB store.
- [ ] Session `day`, `startTime` and `endTime` render on device identically to the web build under a non-venue device timezone and a 12-hour locale – no value passes through a locale or timezone formatter (FR4 binding constraint, S06 contract).
- [ ] Offline behaviour in the shells stays read-only: no mutating affordance is enabled offline and no queue, outbox or deferred submission exists (FR8 binding constraint).
- [ ] No push plugin, notification-permission prompt, push token registration, or release/store distribution artifact is added to either project (both underlying decisions remain Pending in `docs/DECISIONS.md`).
- [ ] `docs/STACK.md` carries the resolved Capacitor version instead of `_TBD_`, and every mobile row added to `docs/KEY_DEVELOPMENT_COMMANDS.md` runs as written from a clean checkout.


## Scope & Boundaries

### Work Areas

- Capacitor configuration (`appId`, `appName`, `webDir`, scheme/hostname) plus the committed `android/` and `ios/` native projects.
- Mobile OAuth client registration in Google Cloud Console and the resulting client IDs added to S02's existing audience allow-list – configuration entered into a surface S02 already built, not a new one and not a change to how it is checked.
- System-browser auth-session adapter and custom-scheme redirect handling: iOS URL types, Android intent filter, deep-link handoff into the SPA callback, persisted PKCE/`state`/`nonce`.
- SPA API base URL for the non-same-origin shell case, and the API's allowed origins for the shell schemes.
- Safe-area and viewport handling in the shared responsive shell.
- On-device verification of S10's cache: storage-origin stability, cold-launch survival, service-worker absence, user-switch purge.
- Docs: `docs/STACK.md` Capacitor version and `docs/KEY_DEVELOPMENT_COMMANDS.md` mobile build/sync/run/device-verification rows.

### What We're NOT Doing

- **Push notification plumbing (plugin, permission prompt, APNs/FCM token registration)** -- no delivery service is decided (`docs/DECISIONS.md` → Pending) and REQ-005 does not exist, so a registration path would produce tokens with nowhere to send them and would prompt users for a permission the product cannot yet use. ADR-001's native-push decision stands and is unaffected by not wiring it here.
- **App-store and managed distribution (release signing, Google Endpoint Management, managed Google Play, Apple Business Manager)** -- the channel is explicitly undecided (ADR-001's distribution note and its amendment; `docs/DECISIONS.md` → Pending). Development/ad-hoc signing onto registered devices proves the shells build and run; the channel decision is due before the first mobile release, not before scaffolding.
- **Native plugins beyond the auth session (camera, biometrics, native secure storage)** -- nothing in this theme needs them, and a native storage plugin would fork S10's single storage path that must serve all three targets.
- **CI/CD or automated mobile build pipelines** -- S01 deliberately deferred all CI; nothing is deployed yet, and a pipeline for an undecided distribution channel would be built twice.
- **Changing S02's validation *logic*, S06's schedule rendering, or S10's cache design** -- this story wires and verifies them on device and fixes shell-level configuration only. Adding the mobile client IDs to S02's audience allow-list is configuration entered into an existing surface, not a logic change: S02 already specifies the allow-list, its wildcard/empty-list startup refusal, and the absence of any mobile branch. A device finding that requires changing one of those contracts is recorded as an Implementation Observation and raised, not silently redesigned.


## Architecture Decision

**Approach**: One Capacitor project over S01's existing web build – `webDir` points at the web build output and `cap sync` is the only path into `android/` and `ios/` – with exactly two native seams: an auth-session adapter running S02's PKCE request in `ASWebAuthenticationSession` (iOS) / Chrome Custom Tabs (Android) with a custom-scheme redirect back into the app, and safe-area styling. See ADR: `docs/adrs/ADR-001-mobile-packaging-capacitor.md`.
**Why this over alternatives**: loading the authorization request in the app's own WebView is the shortest path and is disqualified outright – Google refuses embedded user agents and the host app can read the typed credential – so the system-browser session is the only admissible mechanism; confining every platform-specific line to it and to safe areas is what keeps ADR-001's one-codebase premise verifiable rather than aspirational.


## Technical Overview

Three integration facts decide most of the work and are easy to discover only after a failed device run.

**Audience.** Google issues per-platform OAuth clients – an iOS client bound to the bundle ID and an Android client bound to package name plus signing-certificate fingerprint, neither carrying a secret. The ID token minted for a mobile client therefore has a different `aud` than the web client's. S02 anticipated this and already validates `aud` against a configured allow-list of confApp's own client IDs (S02 TI01/TI03, Structural Criteria), so **this story writes configuration, not validation code**: register the two mobile clients, add their IDs to the list, and the existing check admits them. What must not happen is the reflexive alternative – a wildcard entry or a mobile bypass – which deletes exactly the check that stops another Google app's token being replayed at confApp. S02's startup refusal on an empty or wildcard list is the guardrail against it.

**Origin.** The shell serves the app from `capacitor://localhost` (iOS) or `https://localhost` (Android), not from the API's origin. That means the SPA must use S01's configurable base URL pointed at an absolute API origin, the API container must allow those origins, and – the part that bites later – the same origin string partitions S10's IndexedDB store. Note where the configuration comes from: S01 supplies the base URL at container run time (the static-file container materializes it at start), and a shell has no such container, so the shell build must materialize the same runtime-configuration artefact into `webDir` before `cap sync`. The mechanism differs; the "one configurable base URL, never baked into the bundle by a rebuild" rule does not.

**Redirect.** `ASWebAuthenticationSession` returns the callback URL directly to the initiating call via its registered callback scheme; Android returns through an intent filter on the same custom scheme, and the calling activity may have been destroyed while the Custom Tab was in front. The PKCE verifier, `state` and `nonce` from S02 TI07 must therefore be persisted for the duration of the attempt and cleared when it resolves.


## Code Patterns & External References

```
# type | path#anchor or url                                                                    | why needed (intent)
adr    | docs/adrs/ADR-002-authenticate-with-google-workspace-oidc.md#decision                  | Binding: system browser on mobile, never an embedded WebView
adr    | docs/adrs/ADR-004-containerized-api-and-spa.md#decision                                | API is a long-running container, not Functions; SPA base URL supplied at run time, not baked at build
fis    | docs/specs/conference-setup-and-schedule/s02-google-workspace-sign-in.md#implementation-plan | TI01 audience allow-list config (populated here), TI03 aud/hd validation (unchanged here), TI07–TI10 PKCE, callback, renewal, sign-out hook
fis    | docs/specs/conference-setup-and-schedule/s10-offline-schedule-access.md#implementation-plan  | TI01 cache store, TI08 purge, TI10 service worker – the surfaces verified on device here
fis    | docs/specs/conference-setup-and-schedule/s01-tracer-bullet-skeleton.md#constraints--gotchas | Configurable API base URL; docs tables (TI13/TI14) this story completes
url    | https://capacitorjs.com/docs/basics/configuring-your-app                                | capacitor.config appId / webDir / server scheme+hostname semantics
url    | https://developers.google.com/identity/protocols/oauth2/native-app                      | Native-app OAuth: PKCE, no client secret, custom-scheme redirect, system-browser requirement
url    | https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession | Callback scheme handling and the system consent alert that distinguishes it
url    | https://developer.chrome.com/docs/android/custom-tabs                                   | Custom Tabs launch + returning through an intent filter
```


## Constraints & Gotchas

- **Critical**: the authorization endpoint must never be loaded in confApp's WebView -- Google refuses embedded user agents (`disallowed_useragent`), and where it appears to work the host application can read the credential being typed. Must handle by: the system-browser auth session on both platforms **plus** a navigation policy keeping the WebView on the app origin, so a future stray link cannot reintroduce it.
- **Critical**: `aud` is per-client, and mobile clients are separate from the web client -- an allow-list missing the mobile IDs refuses every device sign-in, and the reflexive fix ("accept any Google audience") deletes the check. Must handle by: adding confApp's own Android and iOS client IDs as literal entries in S02's existing allow-list configuration -- no wildcard, no new branch, and no edit to S02's validation module.
- **Critical**: the shell origin is not the API origin -- relative `/api` calls fail inside the WebView and CORS on the API container must permit `capacitor://localhost` and `https://localhost`. Instead: supply S01's configurable base URL to shell builds; do not reintroduce a same-origin assumption.
- **Constraint**: S01 supplies the SPA's API base URL as **runtime** configuration materialized by the static-file container at start (ADR-004) -- a Capacitor shell ships the assets on the device with no such container, so nothing materializes it unless the shell build does. Workaround: generate the same runtime-configuration artefact into `webDir` as a step before `cap sync`, so pointing a shell at a different environment is a re-sync rather than a source change; never hardcode the URL into the SPA source, which would fork the web and shell builds.
- **Critical**: the WebView origin partitions IndexedDB -- changing `appId`, scheme or hostname after release orphans every cached Schedule (S10), silently turning cached conferences into "not available offline". Must handle by: fixing them once, documenting them as change-sensitive, and treating any later change as a data-clearing migration.
- **Constraint**: service workers do not register under iOS's custom scheme, so S10's static-asset precache is web-only – the shells already carry assets locally -- Workaround: boot must not depend on registration succeeding, and a rejected registration must not surface an error state or an unhandled rejection.
- **Constraint**: a Custom Tab can outlive its calling activity on Android (low memory, "Don't keep activities") -- an in-memory PKCE verifier or `state` makes a legitimate sign-in fail after backgrounding. Workaround: persist them for the attempt and clear them when it resolves; a mismatched `state` still stores no token (S02 TI08).
- **Constraint**: iOS builds require macOS, Xcode, a registered device and a provisioning profile (ADR-001 Consequences) -- an environment without them can complete only the Android half. Report that plainly rather than marking the iOS criteria done; a simulator does not satisfy a criterion that says physical device.
- **Avoid**: platform-conditional feature code, or a mobile-specific layout -- Instead: fix the shared responsive shell (safe-area insets, viewport) so all three targets improve together; forks are a last resort (`docs/ARCHITECTURE.md#key-constraints`).


## Implementation Plan

### Implementation Tasks

- [x] **TI01** Capacitor wraps the existing web build, with committed Android and iOS projects and no second copy of the app
  - `capacitor.config` sets a stable reverse-DNS `appId`, `appName`, `webDir` = S01's web build output, and the scheme/hostname pair; `android/` and `ios/` are tracked while their build outputs are ignored. Assets enter the shells only via the web build + `cap sync`.
  - **Verify**: `After the documented build+sync flow both native projects serve the freshly built assets; changing a visible SPA string and repeating the flow changes it in both; no built web asset is tracked inside android/ or ios/`

- [ ] **TI02** The installed shells reach the API from a device over an absolute base URL the API accepts
  - Uses S01's single configurable API base URL. S01 materializes it as runtime configuration inside the static-file container (ADR-004); a shell has no such container, so the shell build generates the same artefact into `webDir` before `cap sync` and re-pointing an environment is a re-sync, not a source edit. The API container's allowed origins include the two shell schemes. No relative `/api` assumption anywhere in the client, and no hardcoded URL in SPA source.
  - **Verify**: `On a physical device the installed app completes an API request successfully; the same web build synced with a different configured base URL reaches a different API without any SPA source change; a shell build with the base URL unset fails with a named configuration error rather than silently requesting the WebView origin`

- [ ] **TI03** Android and iOS builds install and launch on physical devices from documented commands, and the docs record what shipped
  - Development/ad-hoc signing only – no release or store artifacts (see *What We're NOT Doing*). Fill the Capacitor row in `docs/STACK.md` (S01 TI13 left it `_TBD_`) and add build / sync / run / device-verification rows to `docs/KEY_DEVELOPMENT_COMMANDS.md` (S01 TI14 shape). Depends on TI01, TI02.
  - **Verify**: `Both builds install and launch to the sign-in screen on connected physical devices using only the documented commands; neither native project contains a push plugin, a notification-permission declaration, or a release/store signing artifact; docs/STACK.md has no _TBD_ for Capacitor; each new command runs as written from a clean checkout. Covers S01`

- [ ] **TI04** confApp's Android and iOS OAuth clients exist and their IDs are on S02's audience allow-list
  - Register the two native clients with Google (iOS bound to the bundle ID; Android bound to package name + signing-certificate fingerprint), neither issued a secret, and add both client IDs as literal entries in S02's existing audience allow-list configuration alongside the web ID. **Configuration only** – S02 TI03 already accepts any allow-list entry and refuses everything else, so no validation code, no branch and no wildcard is added here; `hd`, issuer, signature and expiry are untouched. Update `.env.example` and the local-setup rows S02 TI01 established so a fresh checkout knows the list is now three entries.
  - **Verify**: `Against the running API with the deployed configuration: a token whose aud is the iOS client and one whose aud is the Android client are both accepted; a token from an unrelated Google client is still refused with S02's machine code; a wrong-hd token is refused on a mobile audience; git diff shows no change to S02's verification module; neither mobile bundle contains a client secret`

- [ ] **TI05** Sign-in on device runs only in the platform system browser, and the WebView cannot reach the authorization endpoint
  - One auth-session adapter behind S02's authorization-request call: `ASWebAuthenticationSession` on iOS, Chrome Custom Tabs on Android. `prefersEphemeralWebBrowserSession` is left at its default (false) – setting it true suppresses iOS's consent alert, and the story keeps that alert available as corroborating evidence. The shells' allowed-navigation set contains no external host, and any off-origin navigation is handed to the system browser instead of being rendered.
  - **Verify**: `The iOS call site is ASWebAuthenticationSession and sets no prefersEphemeralWebBrowserSession = true anywhere (primary observable, asserted in the native source); on device the system consent alert naming google.com then precedes any web content, corroborating it; on Android the authorization page renders in a Custom Tab with the browser's host indicator; a WebView navigation attempt to the authorization endpoint leaves the WebView on the app origin and renders no Google credential field; no configuration entry allows an external host. Covers S02, S03, S04`

- [ ] **TI06** The redirect returns into the app and completes the exchange, even when the calling activity was destroyed
  - Custom scheme registered on both platforms (iOS URL types; Android intent filter) and handed to S02's existing callback logic – `state`/`nonce` checks and token storage unchanged. PKCE verifier, `state` and `nonce` persist for the attempt and are cleared when it resolves. Consumes TI05's adapter.
  - **Verify**: `On both devices completing consent returns to the app signed in and the next API call is accepted; on Android with "Don't keep activities" enabled the flow still completes; a callback whose state does not match the initiating request stores no token. Covers S02, S03`

- [ ] **TI07** A Schedule cached on device survives a force-quit cold launch with no connection, on both platforms
  - Verification of S10's IndexedDB store inside each WebView – nothing is reimplemented. If the store does not survive on a platform, record the finding as an Implementation Observation and raise it rather than swapping S10's storage path unilaterally (*What We're NOT Doing*).
  - **Verify**: `On each physical device: open the Schedule online, enable airplane mode, force-quit, relaunch – the Schedule renders with its cached label and last-updated time, every mutating affordance is unavailable or refused while offline, and no pending-write record appears in device storage; reinstalling the same build over the top still reads the same cached entry. Covers S05`

- [ ] **TI08** Launching offline in a shell never depends on a service worker
  - S10's precache is web-only; iOS's custom scheme cannot register a service worker. A failed or absent registration must leave boot unaffected and produce no error state or unhandled rejection. Depends on TI07's launch path.
  - **Verify**: `An offline cold launch on iOS reaches the schedule view (cached Schedule or the "not available offline" state), and no service-worker registration failure blocks boot or surfaces to the user. Covers S05`

- [ ] **TI09** Sign-out and a different employee signing in leave no cached Schedule on a shared device
  - Verification of S10's purge (sign-out hook and `sub`-mismatch purge) on device, including the case where the previous session ended by force-quit rather than sign-out. Privacy requirement, not cleanup (FR8 binding constraint).
  - **Verify**: `On a shared device, after sign-out and after a force-quit followed by a different employee signing in, no conference name, session title or cached timestamp from the previous employee is readable in the app or present in device storage. Covers S06`

- [ ] **TI10** The Schedule is legible on real phones and tablets, clear of system UI, without a platform-forked layout
  - Safe-area insets and viewport handling applied in the shared responsive shell (`viewport-fit` + inset-aware padding), not in mobile-only styles. Both orientations; long titles wrap.
  - **Verify**: `Device screenshots from a notched iPhone, an Android phone and a tablet – portrait and landscape – show the header, day navigation, Session rows, concurrency marking and running highlight fully visible with nothing under the notch, status bar or home indicator and no horizontal scroll; the 375px / 768px / 1280px browser checks still pass unchanged. Covers S07`

- [ ] **TI11** Session times on device are unaffected by the device's timezone and locale
  - Proves the FR4 constraint holds inside the WebView, where a phone set to another timezone or a 12-hour locale is the realistic case. Consumes S06's wall-clock rendering; no new time code.
  - **Verify**: `With the device set to a timezone several hours from the venue's and to a 12-hour locale, every Session time on device is byte-identical to the web build's render of the same Schedule (e.g. 09:00–10:30, not 9:00 AM and not shifted)`

### Testing Strategy

- The device checks (S01–S07) are executed on physical hardware and evidenced by screenshots or short recordings stored under `.agent_temp/`; a simulator or emulator run does not satisfy a criterion that names a device, because WebView storage eviction and the system auth-session UI are exactly what differs there.
- Everything that can be asserted without hardware must be: the populated audience allow-list (TI04), the absence of a client secret in the bundles, the allowed-navigation configuration and the `ASWebAuthenticationSession` call site (TI05), and the timezone/locale rendering (TI11, runnable in the web build under a non-UTC process timezone). Device time is spent only on what genuinely needs a device.
- TI05's iOS assertion binds to the mechanism, not the outcome: a sign-in that succeeds proves nothing about *which* browser ran it. The **primary** check is therefore the native call site – an `ASWebAuthenticationSession` with `prefersEphemeralWebBrowserSession` unset – which is a source-level assertion needing no device. The system consent alert observed on device corroborates it and is not sufficient alone, because that alert is suppressed whenever the ephemeral flag is set, making it possible for the scenario to pass or fail for reasons unrelated to the mechanism under test.
- TI04 is a configuration change, so its test is an end-to-end acceptance against the running API, not a new unit test of validation: S02 TI03 already covers the allow-list logic from both sides, and duplicating it here would test S02 twice while testing this story's actual deliverable – the deployed list contents – not at all.

### Execution Contract

- Requires S02 (auth flow and validation), S06 (schedule view) and S10 (offline cache) to have landed – TI04–TI06 extend S02's surfaces and TI07–TI09 verify S10's. If S10 has not landed, TI07–TI09 are blocked, not reimplemented here.
- TI01 precedes every other task; TI02 precedes TI03; TI05 precedes TI06; TI07 precedes TI08.
- The iOS half of TI03, TI05–TI11 requires macOS + Xcode + a registered device. If unavailable, complete and report the Android half and leave the iOS criteria explicitly unmet rather than marking them done.


## Final Validation Checklist

- [ ] Both platforms' sign-in was observed running in the system browser on a physical device – not inferred from a successful token, and not from a simulator. The iOS claim rests on the `ASWebAuthenticationSession` call site, not solely on the consent alert.
- [ ] This story's diff contains no change to S02's token-validation code – only the two new client IDs in the allow-list configuration and its documented example.
- [ ] No push plugin, notification permission, or release/store distribution artifact exists in either native project, so the two Pending decisions in `docs/DECISIONS.md` remain genuinely open.


## Implementation Observations

> _Managed by exec-spec post-implementation – append-only. Spec authors: leave this section empty._

### Run: 2026-08-20 – partial run (TI01 only), hardware-gated remainder

**Scope of this run.** Only TI01 was attempted. The owner scoped execution to the hardware-free half after preflight established that this machine cannot satisfy the story's device criteria. S11 remains `spec-ready`; nothing here claims a device-named criterion.

**TI01 — complete and verified.** Capacitor 8.5.0 wraps S01's existing Vite build. `web/capacitor.config.ts` sets `appId: se.ithuset.confapp`, `appName: confApp`, `webDir: dist`, and pins the scheme/hostname pair explicitly (`iosScheme: capacitor`, `androidScheme: https`, `hostname: localhost`) rather than inheriting defaults, because those four values compose the WebView origin that partitions S10's IndexedDB cache. All three Verify clauses were observed, not asserted:

1. Both native projects serve freshly built assets — `cap sync` copied `dist` into `web/android/app/src/main/assets/public` and `web/ios/App/App/public`.
2. Propagation proven by mutation — a probe string was added to the `app__brand` heading in `web/src/App.tsx`, rebuilt and synced; the new bundle `index-DtvCEURa.js` carried the string into BOTH native projects and the previous bundle `index-DvCNZggL.js` was gone from both, so there is no stale-asset accumulation. The probe was then reverted and `web/src/App.tsx` verified clean against HEAD.
3. No built web asset is tracked — `git check-ignore` confirms `app/src/main/assets/public`, `App/App/public` and both generated `capacitor.config.json` files are ignored by Capacitor's own generated `.gitignore` files. 73 native project files are addable; zero bundle assets among them.

**Native projects live under `web/`, not the repository root** — `web/android/` and `web/ios/` — because `capacitor.config.ts` sits beside the SPA whose `dist` is its `webDir`.

**Capacitor 8 removes the CocoaPods barrier to scaffolding.** `npx cap add ios` succeeded on Windows: Capacitor 8 generates a Swift Package Manager `Package.swift` instead of running `pod install`, so the iOS project can be created and can receive synced assets without macOS. This narrows — but does not remove — the story's macOS constraint: scaffolding and asset sync work anywhere, while compiling, signing and running still require macOS + Xcode.

**Toolchain gaps found on the execution machine (all pre-existing, none introduced here).** No Java, no `ANDROID_HOME`/`ANDROID_SDK_ROOT`, no Android SDK directory and no `adb` — so the Android project can be scaffolded and synced but cannot be compiled, installed or run. No macOS/Xcode — the entire iOS half is out of reach. No Docker (`docker.exe` absent, `docker-desktop` WSL distro stopped, no podman/nerdctl/buildah) — so the API container cannot be started, which additionally blocks TI04, whose Verify is an end-to-end acceptance "against the running API".

**Lint and format needed ignore rules for the synced trees.** `cap sync` copies the built bundle and the service worker into the native projects, and both ESLint and Prettier walked those copies: ESLint reported 2088 errors, mostly the service worker evaluated against a window global scope it does not run in. Fixed by ignoring `web/android/**` and `web/ios/**` in `eslint.config.js` and `web/android/`, `web/ios/` in `.prettierignore`, mirroring Capacitor's own `.gitignore` files. Nothing hand-authored is skipped — native code here is Kotlin/Swift, which neither tool lints. Any future `cap` platform added elsewhere will need the same pair of entries.

**TI11's web-build half is already covered by earlier stories.** S09 and S10 established fresh-process `TZ` probes asserting wall-clock rendering (`web/test/AttendeeScheduleRefresh.test.tsx`, `web/test/schedule-cache-probe.ts`, `web/test/schedule-diff-probe.ts`, `web/test/AttendeeScheduleOffline.test.tsx`). Re-asserting it here would test earlier stories twice while leaving this story's actual deliverable — the same property inside the device WebView — untested. TI11's remaining work is therefore the on-device half only.

**Gates after this run:** typecheck clean, lint clean, build clean, 815/815 tests across 50 files. Prettier reports three files drifted — `api/test/join-code.test.ts`, `visual/conferences.spec.ts`, `web/src/components/JoinCodePanel.tsx` — all confirmed clean against HEAD and therefore pre-existing drift already logged in `docs/TECH-DEBT-BACKLOG.md` during the S10 run; none is touched by this story.

**Outstanding for a later run:** TI02–TI11. TI02 additionally needs the shell-build step that materializes the runtime `config.js` artefact into `webDir` before `cap sync` (the container's `web/docker-entrypoint.d/40-runtime-config.sh` equivalent). TI04 needs two Google OAuth clients registered in Google Cloud Console plus a running API. TI03 and TI05–TI11 need physical devices, and every iOS criterion needs macOS + Xcode.
