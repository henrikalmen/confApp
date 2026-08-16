# ADR-001: Package the React SPA with Capacitor for mobile distribution

- **Status**: Accepted
- **Date**: 2026-08-16
- **Scope**: Client delivery – web, Android, iOS

## Context

confApp is a React single-page application that must run in the browser and on Android and iOS from one codebase, with a responsive UI. Three packaging strategies were considered. The requirements that decide between them:

| Requirement | Answer |
|-------------|--------|
| App Store / Play Store presence | Required |
| Push notifications on iOS | Required |
| Hardware access beyond the camera (NFC, Bluetooth) | Not required |
| Offline capability | Not important _(later revised – see Amendment below)_ |
| Audience | Internal – company employees |

Two of these are decisive. **Store presence** eliminates a pure PWA outright. **iOS push** independently eliminates it: Safari has supported web push since iOS 16.4, but only for PWAs the user manually installs via Share → "Add to Home Screen", and iOS offers no install prompt. In practice most users never complete that step, so push would not reach a reliable share of the iOS audience.

Conversely, the absence of hardware and offline requirements removes the usual arguments for React Native. Its cost – a separate UI layer with no DOM or CSS, or React Native Web with the constraints that imposes on the web build – would buy capabilities this product does not need, and would contradict the one-SPA-everywhere premise.

## Decision

Package the React SPA with **Capacitor**. The same built web assets are served as the web application and wrapped in a native WebView shell for Android and iOS.

Push notifications use the native APNs/FCM path through Capacitor's push plugin rather than web push. **Azure Notification Hubs** is the recommended fronting service, consistent with the serverless-on-Azure backend.

## Consequences

**Positive**
- One React codebase, one build pipeline, three targets. The web build remains a first-class deliverable.
- Reliable push on both platforms via native channels – no Home Screen install dependency.
- Native plugin bridge is available if requirements later grow beyond the camera.
- Reversible in the cheap direction: dropping the shell leaves a working web app.

**Negative / costs**
- Requires macOS and Xcode for iOS builds, an Apple Developer account, and a Google Play developer account.
- App review cycles now sit between a change and its release on mobile. JS-only over-the-air updates are possible within Apple's rules for interpreted code, but native-shell changes always require a release.
- UI is a WebView, not native widgets. Acceptable here; it would not be if native feel were a top requirement.

**Distribution note (internal audience)**

Because confApp is an internal company app, public App Store listing is likely the wrong channel. Options, in rough order of fit:

- **Google Endpoint Management** – included with Google Workspace, which the company already runs company-wide. Strongest fit; see the Amendment note below.
- **Microsoft Intune / MDM** – push the app to managed devices. ~~Strongest fit given the existing Azure and Entra footprint.~~ Weakened by ADR-002: Intune manages devices through Entra identities, and Entra coverage is incomplete.
- **Apple Business Manager custom apps** – private, unlisted distribution to the organization; still reviewed, but the "minimum functionality" bar (App Store guideline 4.2, which rejects thin website wrappers) is more forgiving than for public listings.
- **Managed Google Play private app** – the Android equivalent.
- **Apple Developer Enterprise Program** – in-house distribution bypassing review, but eligibility is restrictive and Apple polices it tightly. Only if the options above fail.

The distribution channel is a separate decision and is not settled by this ADR.

**Amendment (2026-08-16)**: ADR-002 established that the company runs on Google Workspace and that Entra coverage is incomplete. Intune was recommended above on the assumption of an Entra footprint that does not exist; it manages devices through Entra identities, so it would inherit the same coverage gap. **Google Endpoint Management**, included with the Workspace licences the company already holds, is the better-matched option, paired with managed Google Play for Android. iOS still requires Apple Business Manager for private distribution regardless of the MDM chosen.

## Amendment (2026-08-16, same day)

During product clarification the offline input above was revised: confApp now requires **partial** offline support – the schedule must be readable without a connection, and a typed post-it must survive a network blip and sync later. Conference venues have unreliable wifi and a lost idea is unrecoverable.

**The decision is unaffected.** Capacitor remains correct, and the revision mildly strengthens it: a native shell gives more dependable local storage than a browser tab, where eviction policies are outside our control. The rejection of a pure PWA also stands – it was driven by store presence and iOS push, neither of which changed.

## Alternatives considered

- **Responsive PWA only** – rejected. No store presence, and iOS push depends on a manual Home Screen install that most users will not perform. Lowest cost, and remains the fallback if the mobile shells are ever abandoned.
- **React Native / Expo** – rejected. Delivers native UI and full hardware access, neither of which is required, at the cost of a second UI layer and the loss of the single-SPA premise. It is also the least reversible option.
