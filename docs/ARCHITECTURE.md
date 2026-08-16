# Architecture

## System Overview
<!-- One paragraph describing the system at a high level. -->

confApp is an **internal company** application: a **React single-page application** running in the browser and, via a **Capacitor** WebView shell, on **Android and iOS** from one codebase, with a **responsive** UI that rescales to the viewport. No code exists yet – this document describes intent, and is superseded by real analysis once the app is scaffolded (regenerate with the `andthen:map-codebase` skill).

The **backend is serverless on Azure** – Azure Functions for the API, with Azure Static Web Apps the natural host for the SPA. Database, auth, push service, and the mobile distribution channel are not yet chosen – see `docs/DECISIONS.md` → Pending.

## Key Components
<!-- List major components/modules and their responsibilities. -->

| Component | Responsibility | Key Files/Dirs |
|-----------|---------------|----------------|
| React SPA | Responsive UI for browser, Android, iOS | _not yet scaffolded_ |
| Attendee experience | Schedule, personal agenda, group self-selection, post-it entry, voting | _not yet scaffolded_ |
| Facilitator/board view | Projected post-it board, live activity control | _not yet scaffolded_ |
| Organizer/admin | Conference setup, post-it categorization, report generation | _not yet scaffolded_ |
| Capacitor shell | Native WebView host for Android/iOS + native plugin bridge (push) | _not yet scaffolded_ |
| Serverless API | HTTP-triggered Azure Functions serving the SPA | _not yet scaffolded_ |

## Data Flow
<!-- Describe how data moves through the system. A simple numbered list or diagram reference. -->

1. Client (browser or mobile shell) loads the React SPA from static hosting.
2. User signs in against Google Workspace via auth code + PKCE, through the system browser on mobile. The client receives an ID/access token.
3. SPA calls HTTP-triggered Azure Functions over HTTPS, presenting the token as a bearer credential.
4. Functions validate the token – signature, issuer, audience, expiry, and the `hd` hosted-domain claim – then resolve the caller's per-conference role from confApp's own data, keyed on the `sub` claim.
5. Functions read/write PostgreSQL.

## Integration Points
<!-- External services, APIs, databases the system depends on. -->

| Service | Purpose | Config Location |
|---------|---------|-----------------|
| Azure Functions | Serverless API; validates Google-issued JWTs | _TBD_ |
| Azure Static Web Apps | SPA hosting (+ managed Functions API) | _TBD_ |
| Google Workspace | OIDC identity provider – auth code + PKCE (ADR-002) | _TBD_ |
| PostgreSQL | Persistence (ADR-003). Docker Compose locally; production hosting is a phase-2 decision | `docker-compose.yml` _(not yet created)_ |

## Key Constraints
<!-- Architectural decisions or constraints that shape the system. Reference ADRs if available. -->

- **One codebase, three targets** (browser, Android, iOS) – platform-specific forks are a last resort, not a default.
- **Responsive by default** – layout must rescale across phone, tablet, and desktop widths. Validated visually at three widths (see `AGENTS.md` → Visual Validation Workflow).
- **Serverless backend** – no always-on servers. Design for cold starts and stateless request handling; do not assume in-process state survives between calls.
- **Partially offline** – the schedule must render without a connection, and a typed post-it must be queued locally and synced when connectivity returns. Broader offline sync and conflict resolution are out of scope.
- **Near-live, not real-time** – a few seconds of latency is acceptable for post-its and poll results. Polling or lightweight push suffices; hard real-time infrastructure is not warranted.
- **Vote anonymity is structural** – the schema must not permit linking a ballot to a voter. This is a storage constraint, not a presentation choice.
- **Three client surfaces, one codebase** – attendee mobile, organizer/admin, and a projected facilitator big-screen view.
- **Native push, not web push** – push is delivered through APNs/FCM via the Capacitor shell.
