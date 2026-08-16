# Technology Stack

<!-- Versions are unpinned until the app is scaffolded and a package manifest exists.
     Regenerate from the real manifest with the `andthen:map-codebase` skill. -->

## Languages
| Language | Version | Notes |
|----------|---------|-------|
| TypeScript / JavaScript | _TBD_ | TypeScript recommended for a multi-target SPA |

## Frameworks & Libraries
| Name | Version | Purpose |
|------|---------|---------|
| React | _TBD_ | SPA UI framework (confirmed) |
| Build tool | _TBD_ | Vite is the conventional default for a React SPA |
| Router | _TBD_ | Client-side routing |
| Styling | _TBD_ | Must support responsive/fluid layout |
| Capacitor | _TBD_ | Native WebView shell for Android + iOS (ADR-001) |

## Infrastructure
| Service  | Purpose | Notes |
|----------|---------|-------|
| Azure Functions | Serverless API | Confirmed. Runtime/version TBD |
| Azure Static Web Apps | SPA hosting | Recommended pairing – integrates a managed Functions API and built-in auth |
| PostgreSQL | Database | Confirmed (ADR-003). Docker Compose in development; production hosting decided in phase 2 |
| Azure Notification Hubs | Push fan-out to APNs + FCM | Recommended, not yet confirmed |

## External Services
| Service | Purpose | Docs |
|---------|---------|------|
| GitHub  | Source hosting + issue tracker for agent workflows | `docs/ISSUE-TRACKER.md` |
| Google Workspace | Identity provider (OIDC) – company sign-in | ADR-002 |

## Dev Tools
| Tool | Purpose | Config |
|------|---------|--------|
| Node.js | Runtime / tooling | _TBD_ |
| Docker + Docker Compose | Local PostgreSQL for development (ADR-003) | `docker-compose.yml` _(not yet created)_ |
| _TBD_ | Lint / format | _TBD_ |
| _TBD_ | Test runner | _TBD_ |
