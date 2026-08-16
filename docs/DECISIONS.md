# Decisions

<!-- Maintenance:
     - The `andthen:architecture` skill in `--mode trade-off` auto-registers
       ADRs (appends to Current ADRs; moves prior rows to Superseded on
       supersession). Idempotent on ADR ID.
     - "Still Current" captures load-bearing choices that don't warrant a full
       ADR. Promote via `--mode trade-off` if the choice becomes contested.
     - Status enum (Current ADRs): Proposed | Accepted | Deprecated.
       Superseded decisions move to the dedicated table; Rejected decisions
       stay only in the ADR file itself (not indexed). -->

## Current ADRs

| ID | Title | Status | Scope |
|----|-------|--------|-------|
| [ADR-001](adrs/ADR-001-mobile-packaging-capacitor.md) | Package the React SPA with Capacitor for mobile distribution | Accepted | Client delivery – web, Android, iOS |
| [ADR-002](adrs/ADR-002-authenticate-with-google-workspace-oidc.md) | Authenticate with Google Workspace via OIDC | Accepted | Identity and access |
| [ADR-003](adrs/ADR-003-postgresql-containerized-development.md) | PostgreSQL as the database, containerized for development | Accepted | Data persistence |

## Superseded

<!-- Move prior rows here when a new ADR supersedes them. Never delete –
     the lineage is load-bearing context for agents reading the codebase. -->

| Prior Decision | Superseded By | Notes |
|----------------|---------------|-------|
| ... | ... | ... |

## Still Current

<!-- Load-bearing decisions that don't warrant a full ADR. One bullet each.
     Format: **<Topic>**: <decision + brief rationale>. -->

- **UI framework**: React SPA – one codebase serving browser, Android, and iOS _(2026-08-16)_.
- **Responsiveness**: layout rescales to viewport across phone/tablet/desktop rather than targeting a single form factor – it is a product property, not a per-feature nicety _(2026-08-16)_.
- **Issue tracker**: GitHub – agent issue workflows read and publish there _(2026-08-16)_. See `docs/ISSUE-TRACKER.md`.
- **Agent instruction layout**: `AGENTS.md` holds shared content; `CLAUDE.md` is a thin `@AGENTS.md` import – keeps one authored home while staying portable across Claude Code and Codex/generic agents _(2026-08-16)_.
- **Backend**: serverless on **Azure** – Azure Functions for the API, with Azure Static Web Apps the natural host for the React SPA (it integrates a managed Functions API and built-in auth). Chosen for fit with existing Azure tooling and to avoid owning always-on infrastructure _(2026-08-16)_. Warrants promotion to a full ADR once the database and auth choices land alongside it.
- **Audience**: internal – company employees, not the public _(2026-08-16)_. Shapes auth (Google Workspace, ADR-002), distribution (managed distribution over public store listing), and lowers the bar on public-facing polish and SEO.
- **Offline support**: **partial** – the schedule is readable offline and post-its queue through a network blip; everything else assumes connectivity _(2026-08-16)_. Supersedes the earlier "offline not a requirement" position, reversed during clarification once conference-venue wifi conditions were considered.
- **Update latency**: near-live – a few seconds is acceptable for post-its and poll results _(2026-08-16)_. Rules out the cost of hard real-time; polling or a lightweight push is sufficient.
- **Attribution**: post-its always carry the author's name; votes are always anonymous _(2026-08-16)_. Two different functions – named ideas drive discussion and follow-up, anonymous votes make leadership-facing sentiment honest. Anonymity is a storage-level guarantee, not a UI convention.
- **Facilitator big-screen view**: in scope – the post-it board is projected to the room during workshops _(2026-08-16)_. Gives the web build a distinct role from the mobile shells.
- **Workshop groups**: attendees self-select _(2026-08-16)_.
- **Conference scope**: confApp hosts many conferences over time, not one _(2026-08-16)_. Past conferences and reports remain as an archive.
- **Roles are confApp's own data, scoped per conference** – not derived from directory groups _(2026-08-16, ADR-002)_. The same person facilitates one workshop and attends the rest; a directory can't express that.
- **Database engine**: **PostgreSQL**, run in Docker Compose for development _(2026-08-16, ADR-003)_. Chosen for Node/TypeScript ecosystem fit, trivial local development, `JSONB` for semi-structured payloads, and portability across local and cloud hosting.
- **Identity estate**: the company runs on **Google Workspace** – all employees have Google accounts; Entra ID coverage is incomplete despite the Azure footprint _(2026-08-16)_. Identity follows the users, not the cloud provider.

## Pending

<!-- Decisions under discussion, awaiting acceptance. Typically populated by
     the `andthen:architecture` skill in `--mode trade-off` when a
     recommendation hasn't yet been accepted as an ADR. -->

- **Production database hosting** – deferred to phase 2 by ADR-003. Candidates: managed Azure Database for PostgreSQL Flexible Server, a container on Azure Container Apps or a VM, or Neon. Engine is settled (PostgreSQL), so migration between them is a dump and restore. Must be closed before the first real conference.
- **Mobile distribution channel** – undecided. Internal audience means public App Store listing is likely wrong. Google Endpoint Management (included with Workspace) plus managed Google Play for Android, and Apple Business Manager for iOS, is the current front-runner – see ADR-001's distribution note and its amendment. Settle before the first mobile release, not before scaffolding.
- **Push delivery service** – undecided. Azure Notification Hubs recommended as the Azure-native front for APNs + FCM.
