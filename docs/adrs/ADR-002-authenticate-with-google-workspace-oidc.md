# ADR-002: Authenticate with Google Workspace via OIDC

- **Status**: Accepted
- **Date**: 2026-08-16
- **Scope**: Identity and access

## Context

confApp's backend is serverless on Azure (Azure Functions, Static Web Apps), which made Microsoft Entra ID the assumed default for sign-in. That assumption does not survive contact with the company's actual identity estate:

- The company has Azure, but **Entra ID coverage is incomplete** – not every employee has an account.
- **Every employee has a Google Workspace account**; company email runs on Google.

confApp is an internal conference app where every employee is an attendee. An identity provider that only some employees have is a rollout blocker, and provisioning Entra accounts for the remainder is IT work that delivers no product value. Identity should follow the users.

A second constraint shapes the mechanism rather than the provider: confApp ships as a React SPA **and** as Capacitor native shells on Android and iOS (ADR-001). Cookie- and redirect-based platform authentication is browser-shaped and fits a native WebView shell poorly; a bearer-token flow acquired through the system browser works identically on all three surfaces.

## Decision

Authenticate against **Google Workspace as an OpenID Connect provider, directly** – no identity broker.

- **Flow**: OAuth 2.0 authorization code with PKCE. On mobile, the flow runs in the system browser (`ASWebAuthenticationSession` on iOS, Chrome Custom Tabs on Android) rather than an embedded WebView.
- **Domain restriction**: sign-in is limited to the company's Workspace domain. The `hd` (hosted domain) claim is verified **server-side on the ID token**. The `hd` request parameter is a hint to Google's UI, not a security control, and is never trusted on its own.
- **API authorization**: Azure Functions validate the Google-issued JWT (signature, issuer, audience, expiry, `hd`) on every request. The Azure backend imposes no requirement to use Entra.
- **User key**: the `sub` claim is the stable user identifier. Email addresses are treated as display data – they change.
- **Roles**: `Admin`, `Presenter`/`Facilitator`, and `Attendee` are **confApp's own data, scoped per conference**, assigned by the organizer during setup and stored against the user's `sub`. They are not derived from directory group membership.

## Consequences

**Positive**
- Every employee can sign in on day one; no account provisioning precedes rollout.
- One token-based flow serves web, Android, and iOS identically.
- No second identity system to operate for a company of under 100 people.
- Google sign-in is a familiar, low-friction flow – material when a hundred people sign in simultaneously at the start of a conference.
- Per-conference roles model reality: the same person facilitates one workshop and attends everything else.

**Negative / costs**
- No Entra conditional access, and no single Azure-native place to see who has access. Access control lives in Google Workspace plus confApp's own role data.
- The API must implement JWT validation itself rather than delegating to platform authentication.
- A future move of the company onto Entra would make this a decision to revisit. Federating Google behind Entra remains available and would not require changing the client flow.
- Two sources of truth for people: Workspace holds identity, confApp holds roles. Deprovisioning in Workspace revokes access, but stale role rows can linger.

**Apple App Store note**

Guideline 4.8 can require an app offering third-party social login to also offer Sign in with Apple. confApp is **exempt**: the guideline carves out business and enterprise apps that require sign-in with an existing enterprise account, which a Workspace account is. Worth having this answer prepared for review rather than meeting it as a rejection.

## Alternatives considered

- **Microsoft Entra ID** – rejected. The natural fit for an Azure backend, but coverage is incomplete and the gap would have to be closed with account provisioning before anyone could use the app. Reconsider if the company migrates to Entra generally.
- **Entra External ID federating Google upstream** – rejected for now. Would deliver Azure-native integration, central user management, and conditional access, at the cost of operating an identity broker for a small internal app that already has a working directory. This is the migration path if Entra becomes a company-wide requirement.
- **Azure Static Web Apps Easy Auth with a custom OIDC provider** – rejected. Nearly code-free at the platform layer, but requires the SWA Standard plan and uses a cookie-based session model that fits the Capacitor shells poorly.
- **Roles from Google Groups** – rejected. Directory groups are organization-wide and slow-moving; confApp's roles are per-conference and per-session. Modelling them in the directory would force an organizer to file an IT request to appoint a workshop facilitator.
