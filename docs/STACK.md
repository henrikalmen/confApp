# Technology Stack

<!-- Versions below are the resolved versions actually shipped, taken from package-lock.json
     and the image tags in docker-compose.yml. Regenerate from the real manifest with the
     `andthen:map-codebase` skill. Rows still marked _TBD_ belong to work not yet done, and
     say which story owns them. -->

## Languages
| Language | Version | Notes |
|----------|---------|-------|
| TypeScript | 6.0.3 | Strict mode on across `api/` and `web/` |
| SQL (PostgreSQL dialect) | – | Plain PostgreSQL only; no extensions or provider-specific DDL (ADR-003) |

## Frameworks & Libraries
| Name | Version | Purpose |
|------|---------|---------|
| React | 19.2.8 | SPA UI framework (confirmed) |
| React DOM | 19.2.8 | DOM renderer |
| Vite | 8.2.1 | SPA build tool and dev server |
| @vitejs/plugin-react | 6.0.5 | React support for Vite |
| Fastify | 5.12.0 | API HTTP framework – a plain long-running HTTP server, not a proprietary invocation model (ADR-004). Its route-level JSON schemas are the request-validation entry point |
| pg | 8.23.0 | PostgreSQL driver; one module-scoped pool per process |
| node-pg-migrate | 9.0.0 | Reversible migrations, plain-SQL up/down, applied migrations recorded in the database |
| Router | _TBD_ | Client-side routing – not yet needed; the SPA is a single shell. The static container already serves a history fallback so a router can be added without infrastructure change |
| Styling | Plain CSS | Custom properties + fluid units (`clamp`, `min`, grid `auto-fit`). No CSS framework – the shell is small and responsive-by-default is a layout discipline, not a dependency |
| Capacitor | _TBD_ | Native WebView shell for Android + iOS (ADR-001). Owned by S11 |

## Infrastructure
| Service  | Version / Image | Purpose | Notes |
|----------|-----------------|---------|-------|
| API container | `node:24-alpine` | Long-running HTTP server (ADR-004) | Multi-stage build, non-root, healthcheck on `/api/health`. Supersedes Azure Functions |
| SPA container | `nginx:alpine` | Static-file server for the built web assets (ADR-004) | Serves `/`, proxies `/api/` to the API, materializes runtime config at start. Supersedes Azure Static Web Apps |
| PostgreSQL | `postgres:18-alpine` (18.6) | Database | Confirmed (ADR-003). Data on the named volume `confapp-db-data`, mounted at `/var/lib/postgresql` – the directory the image declares. Production hosting decided in phase 2 |
| Container platform | _TBD_ | Runs the images in the cloud | Undecided – Azure Container Apps is the front-runner (`docs/DECISIONS.md` → Pending). Owned by S13 |
| Azure Notification Hubs | _TBD_ | Push fan-out to APNs + FCM | Recommended, not yet confirmed. Push is deferred out of the current plan |

## External Services
| Service | Purpose | Docs |
|---------|---------|------|
| GitHub  | Source hosting + issue tracker for agent workflows | `docs/ISSUE-TRACKER.md` |
| Google Workspace | Identity provider (OIDC) – company sign-in | ADR-002. Owned by S02; no authentication code exists yet |

## Dev Tools
| Tool | Version | Purpose | Config |
|------|---------|---------|--------|
| Node.js | 24 LTS (pinned) | Runtime / tooling | `.nvmrc` pins `24`; the root manifest's `engines` allows `>=24` so a newer local runtime is not rejected. The API image is built on `node:24-alpine` |
| npm workspaces | npm 11.x | Monorepo layout (`api/`, `web/`, `db/`) | One lockfile at the repository root |
| Docker Engine | 29.x | Container runtime | Verified on 29.1.3 |
| Docker Compose | v2.40+ | Local composition of SPA + API + PostgreSQL (ADR-003, ADR-004) | `docker-compose.yml`; verified on Compose v5.4.0 |
| ESLint | 10.8.1 | Lint | `eslint.config.js` (flat config) |
| typescript-eslint | 8.67.0 | TypeScript lint rules | Constrains TypeScript to `<6.1.0`, which is why TS is pinned at 6.0.3 |
| @eslint/js | 10.0.1 | ESLint recommended base rules | |
| Prettier | 3.9.6 | Format | `.prettierrc.json`; `eslint-config-prettier` 10.1.8 keeps the two from fighting |
| Vitest | 4.1.10 | Test runner (unit + integration) | Root `vitest.config.ts` with an `api` project (node) and a `web` project (jsdom) |
| jsdom | 30.0.1 | DOM environment for web tests | |
| @testing-library/react | 16.3.2 | Component testing | |
| Playwright | 1.62.1 | Scripted three-width visual validation | `playwright.config.ts`, specs in `visual/` |
