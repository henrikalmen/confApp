# Architecture

## System Overview
<!-- One paragraph describing the system at a high level. -->

confApp is an **internal company** application: a **React single-page application** running in the browser and, via a **Capacitor** WebView shell, on **Android and iOS** from one codebase, with a **responsive** UI that rescales to the viewport. No code exists yet – this document describes intent, and is superseded by real analysis once the app is scaffolded (regenerate with the `andthen:map-codebase` skill).

The **API and SPA ship as container images** (ADR-004) – the API a long-running HTTP server, the SPA static assets behind a static-file container, with PostgreSQL alongside them under Docker Compose in development. Cloud is the target deployment; the same images run locally. This supersedes the earlier serverless-on-Azure position. The container platform, production database hosting, push service, and mobile distribution channel are not yet chosen – see `docs/DECISIONS.md` → Pending.

## Key Components
<!-- List major components/modules and their responsibilities. -->

| Component | Responsibility | Key Files/Dirs |
|-----------|---------------|----------------|
| React SPA | Responsive UI for browser, Android, iOS | _not yet scaffolded_ |
| Attendee experience | Schedule, personal agenda, group self-selection, post-it entry, voting | _not yet scaffolded_ |
| Facilitator/board view | Projected post-it board, live activity control | _not yet scaffolded_ |
| Organizer/admin | Conference setup, post-it categorization, report generation | _not yet scaffolded_ |
| Capacitor shell | Native WebView host for Android/iOS + native plugin bridge (push) | _not yet scaffolded_ |
| API container | Long-running HTTP server serving the SPA (ADR-004) | _not yet scaffolded_ |

## Data Flow
<!-- Describe how data moves through the system. A simple numbered list or diagram reference. -->

1. Client (browser or mobile shell) loads the React SPA from the static-file container.
2. User signs in against Google Workspace via auth code + PKCE, through the system browser on mobile. The client receives an ID/access token.
3. SPA calls the API container over HTTPS, presenting the token as a bearer credential.
4. The API validates the token – signature, issuer, audience (an allow-list of confApp's own per-platform client IDs), expiry, and the `hd` hosted-domain claim – then resolves the caller's per-conference role from confApp's own data, keyed on the `sub` claim.
5. The API reads/writes PostgreSQL.

## Integration Points
<!-- External services, APIs, databases the system depends on. -->

| Service | Purpose | Config Location |
|---------|---------|-----------------|
| Container platform | Runs the API and SPA images; undecided, Azure Container Apps the front-runner | _TBD_ |
| Google Workspace | OIDC identity provider – auth code + PKCE (ADR-002) | _TBD_ |
| PostgreSQL | Persistence (ADR-003). Docker Compose locally; production hosting is a phase-2 decision | `docker-compose.yml` _(not yet created)_ |

## Key Constraints
<!-- Architectural decisions or constraints that shape the system. Reference ADRs if available. -->

- **One codebase, three targets** (browser, Android, iOS) – platform-specific forks are a last resort, not a default.
- **Responsive by default** – layout must rescale across phone, tablet, and desktop widths. Validated visually at three widths (see `AGENTS.md` → Visual Validation Workflow).
- **Containerized backend** (ADR-004) – one artifact runs in development, on a local server, and in the cloud. Handlers remain stateless: the API scales horizontally across replicas and requests are not sticky, so in-process state must not survive between calls. Cold-start tolerance is no longer a design constraint.
- **Partially offline** – the schedule must render without a connection, and a typed post-it must be queued locally and synced when connectivity returns. Broader offline sync and conflict resolution are out of scope.
- **Near-live, not real-time** – a few seconds of latency is acceptable for post-its and poll results. Polling or lightweight push suffices; hard real-time infrastructure is not warranted.
- **Vote anonymity is structural** – the schema must not permit linking a ballot to a voter. This is a storage constraint, not a presentation choice.
- **Three client surfaces, one codebase** – attendee mobile, organizer/admin, and a projected facilitator big-screen view.
- **Native push, not web push** – push is delivered through APNs/FCM via the Capacitor shell.
