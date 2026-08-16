# S01 – Containerized Tracer Bullet

**Plan**: docs/specs/conference-setup-and-schedule/plan.json
**Story-ID**: S01

## Feature Overview and Goal

**Intent**: The repository holds only documentation – nothing proves that a request can travel from the SPA container through the API container to PostgreSQL and back, so every feature story after this one would build on an unverified stack and discover its wiring defects at feature-review time.

**Expected Outcomes** (each `[OC<NN>]`-tagged; scenarios anchor to these):

- [OC01] A request originating in the browser reaches PostgreSQL through the composed SPA → API → database container path and its result is rendered on screen – the three containers are proven joined, not assumed.
- [OC02] Every API refusal arrives in one JSON envelope carrying a displayable message and a stable machine code, so the seven later API stories emit refusals through it instead of inventing per-endpoint shapes.
- [OC03] The app shell rescales legibly from a 375px phone through 768px and 1280px with no horizontal scroll.
- [OC04] A developer goes from clean clone to a running, migrated, testable stack using only commands written in `docs/KEY_DEVELOPMENT_COMMANDS.md`, against versions pinned in `docs/STACK.md`.
- [OC05] Data written to PostgreSQL outlives the container that wrote it – the database's data sits on a named volume, so stopping, replacing or recreating the container loses nothing, while the API and SPA containers carry no volume because they hold no state to lose.


## Required Context

- `docs/adrs/ADR-004-containerized-api-and-spa.md#decision` – **the governing decision for this story.** The API is a long-running HTTP server in its own container; the SPA is built to static assets served from a static-file container; PostgreSQL stays a container per ADR-003. Azure Functions and Azure Static Web Apps are dropped – no part of the application is written against the Functions programming model. Statelessness survives the change, now because the API scales across replicas.
- `docs/specs/conference-setup-and-schedule/prd.md#non-functional-requirements` – binding NFR row set. Five rows bind this story directly: **Portability – plain PostgreSQL only, no provider-specific extensions (ADR-003)**; **Usability – responsive, verified at 375px / 768px / 1280px per `AGENTS.md`**; and the three **Durability** rows – data survives the container lifecycle, PostgreSQL data lives on a **named volume** and never in a container's writable layer, and the API and SPA containers hold nothing that needs saving. S13 owns the deployed environment's equivalent of those Durability rows (including the managed-PostgreSQL alternative); this story owns the composed topology only. The same table's Security row (`hd` claim verified server-side on every request) is **not narrowed away** – it is unimplementable here because this story adds no authentication, and it is delivered by S02; nothing built here may make it harder to add. The table's two cold-start rows are **stale**: ADR-004 eliminated them rather than deferring them (see *Constraints & Gotchas*).
- `docs/specs/conference-setup-and-schedule/prd.md#dependencies` – "PostgreSQL schema and access layer (ADR-003) | All entities in Data Requirements persist through it". This story is that access layer; it creates no domain entity.
- `docs/specs/conference-setup-and-schedule/plan.json#sharedDecisions` – entry *"API route, handler and error envelope conventions"*. S01 fixes the route layout, the request-validation entry point, and the error envelope; S03–S09 consume them unchanged. The envelope must carry a **displayable message**, not just a status, because the PRD's error handling is user-facing prose. That entry's wording still says "Azure Functions HTTP route layout" – stale against ADR-004; the *conventions* it names are what binds, not the runtime it names.
- `docs/specs/conference-setup-and-schedule/prd.md#edge-cases` – the four durability rows at the end of that table are the behavior this story must make true locally: the database container stopping/being replaced loses nothing; an API or SPA container destroyed and recreated returns identically because neither holds state; a past conference reads unchanged on infrastructure restarted many times; and deleting the **named volume itself** does lose the data, because a volume is not a backup.
- `docs/specs/conference-setup-and-schedule/prd.md#constraints` – "Data durability is a storage property, not an application one… **A named volume is not a backup** – it survives the container, not the deletion of the volume or the loss of its host (ADR-003)."
- `docs/adrs/ADR-003-postgresql-containerized-development.md#decision` – PostgreSQL in Docker Compose is the primary development setup, and production hosting is deliberately open. Portability is the reason; do not adopt anything that would break a `pg_dump`/restore move. Its Consequences also make backups, patching and **restore correctness** an explicit owned responsibility – the reason the named volume must not be read as a durability guarantee it does not provide.
- `docs/ARCHITECTURE.md#key-constraints` – containerized backend (one artifact for development and cloud), stateless handlers across replicas, responsive-by-default, one codebase / three targets.
- `AGENTS.md#do-not--never` – standing prohibitions that apply here: no fixed-width layout, no provider-proprietary schema features, no in-process state between requests, never commit `.env` files. **Note**: that file's Standing Facts still describe a serverless Azure Functions backend and "cold-start-tolerant handlers" – superseded by ADR-004, which wins (see *Constraints & Gotchas*).
- `docs/guidelines/CRITICAL-RULES-AND-GUARDRAILS.md#honesty-and-verification` – "done" requires the real build/test/lint run and visual validation, which is how this enabler story is judged.
- `docs/STACK.md#frameworks--libraries` – the `_TBD_` rows this story replaces with pinned versions; also the Infrastructure rows naming the API container and SPA container as confirmed.
- `docs/KEY_DEVELOPMENT_COMMANDS.md#testing` – the `TODO` rows this story fills, including **how to run a single targeted test**.

## Deeper Context

- `docs/specs/conference-setup-and-schedule/plan.json#stories` – story **S13** ("Container build and deployment") consumes what this story produces: reproducible image builds, environment-driven configuration, and a health/readiness signal per service. Keeping configuration out of the images is what lets S13 deploy them without rework.
- `docs/ROADMAP.md#phase-2-scaffold` – the success criteria this story satisfies (SPA builds and runs, responsive shell verified at three widths, commands documented). Capacitor shells and sign-in on that list belong to S11 and S02.
- `docs/DECISIONS.md#superseded` – the serverless-on-Azure lineage and why it was dropped; read if a source or document encountered during execution still assumes Functions.


## Acceptance Scenarios

- [ ] **S01 [OC01] [TI07,TI08,TI10,TI11] Browser renders a value read from PostgreSQL through the composed SPA and API containers**
  - **Given** the composed stack is up from the documented commands – static-file SPA container, API container, PostgreSQL container – with migrations applied and `app_meta` seeded with `schema_version`
  - **When** a developer opens the SPA's container-served URL in a browser and the page calls `GET /api/health` with no query parameters
  - **Then** the page displays the seeded schema version and a server timestamp returned by the API, and the response is `200` – proving the value came from the database rather than from client-side or handler-side constants, and that the call reached the API container from the SPA container's origin without a manual CORS or proxy step; the omitted optional `verbose` parameter defaults to the concise payload rather than erroring

- [ ] **S02 [OC02] [TI05] Unknown API route is refused in the standard error envelope**
  - **Given** the API container is running
  - **When** a client requests `GET /api/does-not-exist`
  - **Then** the response is `404` with body `{"error":{"code":"ROUTE_NOT_FOUND","message":"<displayable sentence>"}}` – a human-readable message and a stable machine code, no framework default HTML or empty body

- [ ] **S03 [OC02] [TI06] Invalid query parameter is rejected by the validation entry point before handler logic runs**
  - **Given** the API container is running and the database is reachable
  - **When** a client requests `GET /api/health?verbose=maybe`
  - **Then** the response is `400` with `error.code` `VALIDATION_FAILED`, a displayable `error.message`, and `error.details` naming the `verbose` field – and no database query is issued for the rejected request

- [ ] **S04 [OC02] [TI04] Database unavailability is reported as a refusal, not a crash or an internal-detail leak**
  - **Given** the API is configured with a PostgreSQL connection that cannot be established
  - **When** a client requests `GET /api/health`
  - **Then** the response is `503` with `error.code` `DATABASE_UNAVAILABLE` and a displayable `error.message`, the body contains no driver text, connection string, host name, or stack trace, and the API process stays up and keeps serving subsequent requests

- [ ] **S05 [OC03] [TI09] App shell is legible one-handed at 375px and rescales to tablet and desktop**
  - **Given** the SPA is running with the API reachable
  - **When** the shell is rendered at viewport widths 375px, 768px and 1280px
  - **Then** all content – header, navigation affordance and the health panel – is readable with no horizontal scrolling at any of the three widths, and the layout reflows rather than being clipped or letterboxed

- [ ] **S06 [OC04] [TI02,TI03,TI14] Migrations are reversible and leave a working schema after a full down/up cycle**
  - **Given** a freshly started, empty database container
  - **When** the developer runs migrate-up, then migrate-down to zero, then migrate-up again, using only the commands documented in `docs/KEY_DEVELOPMENT_COMMANDS.md`
  - **Then** every step exits successfully, the down step leaves no `app_meta` table behind, and after the second up step `GET /api/health` returns `200` with the seeded schema version

- [ ] **S07 [OC01] [TI04] Consecutive requests to the same long-lived API process do not leak state between each other**
  - **Given** the API container has been running for some time and has already served at least one `GET /api/health?verbose=true` request
  - **When** a subsequent `GET /api/health` request arrives with no `verbose` parameter
  - **Then** the second response carries the concise default payload – the previous request's parameter does not influence it – and each response's server timestamp is computed for its own request

- [ ] **S08 [OC05] [TI02,TI03,TI11] Data written before the database container is destroyed is read back unchanged after the container is recreated**
  - **Given** the composed stack is up with migrations applied, and a distinguishable value has been written into `app_meta` through the running database so its loss would be visible
  - **When** the developer runs `docker compose down` **without** `-v`, confirms the database container no longer exists, then `docker compose up` again and re-runs the documented migrate-up command against the recreated container
  - **Then** the recreated container starts against the same named volume, migrate-up recognizes the already-applied migration and re-applies nothing (no duplicate-object or already-exists failure), and `GET /api/health` returns `200` carrying the value written before the teardown – durability proven by exercising it, not by reading the Compose file

- [ ] **S09 [OC05] [TI11,TI14] `docker compose down -v` deliberately discards state, and the command reference says so before a developer finds out**
  - **Given** the composed stack has been up with migrations applied and data written to `app_meta`
  - **When** the developer runs the documented clean-rebuild command `docker compose down -v` and brings the stack up again
  - **Then** the database comes up empty, migrate-up is required before `GET /api/health` returns `200`, and `docs/KEY_DEVELOPMENT_COMMANDS.md` states beside that command that `-v` deletes the named volume and every row in it while plain `down` does not

- [ ] **S10 [OC05] [TI11] Neither application container declares a volume, and neither needs one**
  - **Given** the composed stack defined by the root `docker-compose.yml`
  - **When** the API and SPA containers are destroyed and recreated while the database container is left untouched
  - **Then** both come back serving identically with no configuration replay and no data restoration step, and no volume is declared for either service – they hold nothing between requests (`AGENTS.md#do-not--never`), which is what makes the database the only component needing durable storage


## Structural Criteria

- [ ] `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm test` and `npm run build` all exit 0 on a clean checkout after `npm ci`.
- [ ] No Azure Functions artifact exists anywhere in the tree – no `function.json`, no `host.json`, no `local.settings.json`, no `@azure/functions` dependency (ADR-004: no part of the application is written against the Functions programming model).
- [ ] Neither image bakes in environment-specific configuration: database host/credentials, listen port, and the SPA's API base URL are all supplied at container run time, so the same image runs in development and against another target without a rebuild (S13 depends on this).
- [ ] Migration SQL uses plain PostgreSQL only – no `CREATE EXTENSION`, no provider-specific types, functions, or DDL (ADR-003 portability).
- [ ] `docker-compose.yml` declares a top-level **named** volume and the PostgreSQL service mounts it at the database data directory – not an anonymous volume, not a bind mount to a host path, and never left on the container's writable layer.
- [ ] **No application service declares a volume of any kind** – neither the API nor the SPA service has a `volumes:` entry. This is a stated design property, not an omission: they keep no state between requests (`AGENTS.md#do-not--never`), which is exactly what makes the database the only component requiring durable storage.
- [ ] No `.env` file or credential is committed; a tracked `.env.example` documents every required variable with non-secret placeholders.
- [ ] `docs/STACK.md` contains no `_TBD_` entry for any component this story delivers, and each recorded version matches the committed lockfile / manifest / image tag.
- [ ] `docs/KEY_DEVELOPMENT_COMMANDS.md` contains no `TODO`, including a working single-targeted-test command and the three visual-validation width commands.


## Scope & Boundaries

### Work Areas
- Root workspace and toolchain configuration – package manifest/workspaces, TypeScript, lint, format, test runner, pinned Node version.
- `web/` – React + TypeScript SPA: responsive app shell, API client with a single runtime-configurable base URL.
- `api/` – long-running Node HTTP server: route registration layout, request-validation entry point, error-envelope mapping, the `health` handler, pooled data access, process lifecycle.
- `db/` – reversible migration tooling and the initial migration creating and seeding the non-domain `app_meta` table.
- Containerization – `api/Dockerfile`, `web/Dockerfile` (build → static-file server), root `docker-compose.yml` composing SPA + API + PostgreSQL with a named volume for the database's data directory and no volume on either application service, and `.env.example`.
- Documentation – `docs/STACK.md` version pinning and `docs/KEY_DEVELOPMENT_COMMANDS.md` command reference.

### What We're NOT Doing
- **Authentication of any kind** – S02 owns OIDC, token validation and the authenticated-caller context. `GET /api/health` is deliberately anonymous and stays that way permanently (see *Constraints & Gotchas*); it is the only route S02 leaves unauthenticated.
- **Any conference domain entity or table** – Conference, Session, Membership and Role Assignment belong to S03–S07; `app_meta` exists solely to prove the database round trip.
- **Cloud deployment, registries, and CI** – S13 owns image publication, deployment to a container platform, secret handling, and the availability posture. This story only ensures the images are reproducible and configured from the environment so S13 needs no rework.
- **Backups and the restore drill** – S13 owns durable storage in the deployed environment, the managed-PostgreSQL alternative to a named volume, and exercising an actual restore. This story owns the composed topology's named volume only, and states plainly that a volume is not a backup (see *Constraints & Gotchas*) rather than implying it covers that ground.
- **Capacitor Android/iOS projects** – S11. This story only keeps the web build free of anything that would block a WebView shell (no absolute same-origin API assumption baked into the client).
- **Performance targets and indexing** – S12 owns the p95 and capacity numbers, measured against S13's deployed environment; measuring an empty stack proves nothing.


## Architecture Decision

**Approach**: One npm-workspace repository – `web/` (Vite + React + TypeScript SPA), `api/` (long-running Node HTTP server, TypeScript), `db/` (migrations) – with a multi-stage Dockerfile per deployable and a root `docker-compose.yml` composing SPA + API + PostgreSQL. See ADR: `docs/adrs/ADR-004-containerized-api-and-spa.md`.
**Why this over alternatives**: one artifact runs in development and in the cloud, so the thing tested is the thing deployed (ADR-004); writing the API against a plain HTTP framework rather than a proprietary invocation model keeps it portable while the container-platform decision stays open (`docs/DECISIONS.md` → Pending).


## Technical Overview

The tracer path is: browser loads the SPA from the static-file container → SPA API client resolves its base URL from runtime configuration → request reaches the API container → routing → validation entry point → handler → pooled `pg` client → `app_meta` row → JSON response → rendered panel. Every refusal along that path exits through one envelope mapper. In the composed default, the static-file container reverse-proxies `/api/` to the API service so the browser sees one origin; the base URL stays configurable because the Capacitor shell (S11) and any split-origin deployment (S13) are not same-origin.

Toolchain choices made without user input and recorded as **assumptions** – any may be swapped at exec time if a concrete blocker appears, provided `docs/STACK.md` records what actually shipped: Vite as the SPA build tool (already the conventional default in `docs/STACK.md`); Node.js current LTS pinned in `.nvmrc` and `engines`; a mainstream plain Node HTTP framework for the API (Fastify or Express – nothing bound to a proprietary invocation model); Vitest as the test runner (shares Vite's transform pipeline, so one config serves both); ESLint + Prettier; `pg` with a module-scoped pool; a migration tool with explicit, executable **down** steps in plain SQL; a small static-file server image (nginx or equivalent) for the SPA; Playwright for scripted three-width screenshot capture.

Exact versions are not prescribed here – the executor installs current versions and records the **resolved** versions from the lockfile and image tags into `docs/STACK.md`, so the document matches reality rather than this document's authoring date.


## Code Patterns & External References

```
# type | path#anchor or url                                        | why needed (intent)
url    | https://docs.docker.com/build/building/multi-stage/       | multi-stage build – build deps stay out of the runtime image
url    | https://docs.docker.com/reference/compose-file/services/  | compose service definition – depends_on/condition, healthcheck, env_file
url    | https://vite.dev/guide/build                              | SPA static build output + dev-server proxy for the local dev loop
url    | https://nodejs.org/api/process.html#signal-events         | SIGTERM handling – a long-running container must drain, not be killed mid-request
file   | docs/KEY_DEVELOPMENT_COMMANDS.md                          | table shape to fill – keep the existing headings and row structure
file   | docs/STACK.md                                             | table shape to fill – replace _TBD_ in place, do not restructure
```


## Constraints & Gotchas

- **Critical – ADR-004 wins over stale documents.** `AGENTS.md` (Standing Facts) still says "Backend is serverless on Azure – Azure Functions for the API, Azure Static Web Apps for hosting. Design stateless, cold-start-tolerant handlers", and the PRD's NFR table still carries a cold-start carve-out and a pre-warm row. Both predate ADR-004, which is Accepted and supersedes them. **Cold-start tolerance is not a design constraint in this codebase** and must not appear as one in code, comments, tests, or docs written here. Do not implement warm-up timers or pre-warm mechanisms. `NOTICED:` correcting those two documents is owner-owned drift cleanup outside this story's scope – flag it, do not silently edit them.
- **Critical – no in-process request state**: handlers must hold nothing derived from a request between requests (`AGENTS.md#do-not--never`). The reason changed with ADR-004 – horizontal replicas rather than transient instances – but the rule is identical and still binding. A module-scoped connection **pool** is permitted: it is a reusable resource, not request state. Anything request-derived (parsed input, computed results, counters, caches keyed by caller) must not outlive the request. This is more tempting under a long-lived process than it was under Functions, and S05's rate limiter later depends on the rule being respected from the start.
- **Critical – plain PostgreSQL only**: no `CREATE EXTENSION`, no provider-specific SQL, in migrations or queries. Production hosting is undecided (ADR-003) and portability is the whole reason PostgreSQL was chosen.
- **Anonymous surface – resolved here, not deferred to S02.** `GET /api/health` is **permanently unauthenticated by design**: S13 requires a health/readiness signal per service, and container-platform probes cannot present an OIDC token. S02 authenticates every other route and leaves this one alone – it does not need to close it. The cost is bounded by keeping the endpoint's payload to liveness/readiness facts only (schema version, server timestamp, database reachability); it must never grow domain, personal, or configuration data, and no later story may add such a field to it.
- **Configuration is environment-driven, in both images.** The API reads its listen port and database connection from the environment at startup. The SPA is static, so its API base URL must **not** be baked at build time – emit it as runtime configuration the static container materializes at start (e.g. a generated `config.js`/`config.json` read by the API client), or one image per environment is the result and S13 pays for it.
- **Route prefix is `/api`, owned by the API itself.** The API serves `/api/health`, so the path is identical whether reached through the SPA container's proxy, directly against the API container, or from the Capacitor shell using an absolute base URL. A proxy that strips the prefix while the API also omits it is the failure mode – pin one and verify the resolved URL from both entry points.
- **Error envelope is the contract, not a convenience**: the shape below is consumed by S03–S09. Fix it here concretely and document it next to the mapper.
  ```json
  {"error":{"code":"VALIDATION_FAILED","message":"verbose must be true or false.","details":[{"field":"verbose","message":"Expected true or false."}]}}
  ```
  Rules: HTTP status carries the class; `code` is a stable SCREAMING_SNAKE identifier; `message` is a complete, displayable sentence naming the reason; `details` is optional and only present for field-level rejections. Codes introduced here: `VALIDATION_FAILED` (400), `ROUTE_NOT_FOUND` (404), `DATABASE_UNAVAILABLE` (503), `INTERNAL_ERROR` (500).
- **Critical – database durability is a storage property, and a named volume is not a backup.** PostgreSQL's data directory must be backed by a **named** volume declared in `docker-compose.yml`. An anonymous volume, a bind mount to a host path, or no volume at all each look fine until a container is replaced and the data is gone – the container's writable layer is destroyed with the container, which is precisely the failure this requirement guards against. The boundary must be stated honestly: a named volume survives the *container*, **not** deletion of the volume (`docker compose down -v`) and **not** loss of its host. It is not a backup. ADR-003 makes backups, patching and restore correctness an explicit owned responsibility, and S13 owns the deployed environment's durable storage and the restore drill. Nothing written here may be worded as if the volume were the whole durability story.
- **The API and SPA containers get no volume, and that is the design.** They hold no state between requests (`AGENTS.md#do-not--never`), so there is nothing on them to preserve – destroy and recreate them freely. Say this explicitly in the Compose file's comments rather than leaving the absence to be read as an oversight: it is the property that makes the database the single component needing durable storage. Adding a volume to either service to "keep" something is the smell that request state has crept in.
- **Migrations must be safe against an already-populated volume.** After the first run this is the *normal* case: a recreated container starts against a volume that already holds the schema and its applied-migration record. The migration tool must consult that record and skip what is already applied rather than re-running it – a naive bootstrap that unconditionally executes the initial migration fails on the second `up` with a duplicate-object error, and a bootstrap that only runs when the data directory is empty silently never applies later migrations. The `app_meta` schema-version row and the reversible-migration work below are the mechanism; S08 is the scenario that exercises it.
- **Never commit `.env`**: commit `.env.example` with placeholders; the local database password lives only in the untracked `.env`. `.gitignore` already excludes `.env` and `.env.*` while allowing `.env.example` – confirm the new files land on the correct side of that rule.


## Implementation Plan

### Implementation Tasks

- [ ] **TI01** Repository builds from a clean clone as one npm workspace containing `web/` and `api/`, both TypeScript with strict mode on
  - Node version pinned in `.nvmrc` and in the root manifest's `engines`; one lockfile at the root; no build output or `node_modules` tracked (see `.gitignore`).
  - **Verify**: `npm ci` then `npm run build` succeeds on a clean checkout and produces SPA static assets plus a runnable compiled API server.

- [ ] **TI02** Local PostgreSQL starts from the composed stack with credentials supplied by an untracked `.env`, and its data lives on a named volume that outlives the container
  - Pinned `postgres` image tag, container healthcheck, port documented; tracked `.env.example` lists every variable with placeholders. A **top-level named volume** is declared and mounted at the database's data directory – not anonymous, not a bind mount, never the container's writable layer.
  - **Verify**: after bringing the database service up, the container reports healthy and accepts a client connection using the documented variables; `git status` shows no `.env`, and `git check-ignore .env` confirms it is ignored; a row written to the database is still present after `docker compose down` (no `-v`) followed by `up`, and is gone after `docker compose down -v` followed by `up`. Covers S06, S08, S09.

- [ ] **TI03** Schema is created and reverted by reversible migrations, with an initial migration creating and seeding the non-domain `app_meta` table
  - `app_meta(key text primary key, value text not null)` seeded with a `schema_version` row; every migration has an executable down step; plain PostgreSQL only – no extensions or provider-specific DDL. Applied migrations are recorded in the database itself, so a run against a volume that already holds the schema skips what is applied rather than re-executing it – this is the normal case after the first run (see *Constraints & Gotchas*).
  - **Verify**: migrate-up creates `app_meta` with the seeded row; migrate-down to zero leaves no `app_meta`; a second migrate-up succeeds; migrate-up run again against a **populated, recreated** database container reports nothing to apply and exits 0 without a duplicate-object error, leaving existing rows untouched; the migration directory contains no `CREATE EXTENSION` and no provider-specific SQL. Covers S06, S08.

- [ ] **TI04** Handlers reach PostgreSQL through one shared pooled data-access module that retains nothing request-derived between requests
  - Connection settings read from environment at startup; pool reused across requests; connection failure surfaces as a typed error the envelope mapper (TI05) turns into `DATABASE_UNAVAILABLE` without killing the process.
  - **Verify**: two consecutive requests with different query parameters each return a payload reflecting only their own input, and a request against an unreachable database yields the `DATABASE_UNAVAILABLE` refusal while the server keeps serving. Covers S04, S07.

- [ ] **TI05** Every API refusal leaves the server in the standard error envelope, including unknown routes and unhandled exceptions
  - Envelope shape and code list are fixed in *Constraints & Gotchas*; a catch-all handler returns `ROUTE_NOT_FOUND`; unhandled exceptions map to `INTERNAL_ERROR` with a generic message and are logged server-side only. This is the shared convention S03–S09 consume – document it beside the mapper.
  - **Verify**: `GET /api/does-not-exist` returns 404 with `error.code` `ROUTE_NOT_FOUND` and a displayable message; a handler forced to throw returns 500 with `error.code` `INTERNAL_ERROR` and no exception message or stack in the body. Covers S02.

- [ ] **TI06** Request input is validated at one shared entry point before handler logic runs, and rejections use the TI05 envelope
  - One place parses and validates query/route/body input per route; failures produce `VALIDATION_FAILED` with `details` naming the offending field. The `health` route declares an optional `verbose` parameter accepting only `true`/`false`.
  - **Verify**: `GET /api/health?verbose=maybe` returns 400 with `error.code` `VALIDATION_FAILED` and `details` naming `verbose`, with no database query issued; `GET /api/health?verbose=true` returns 200. Covers S03.

- [ ] **TI07** `GET /api/health` answers from PostgreSQL, returning the seeded schema version and a server timestamp
  - Uses the TI04 data-access module and the TI06 validation entry point; reads `app_meta.schema_version` – the value must come from the database, not a constant; omitted `verbose` yields the concise payload. Payload stays bounded to liveness/readiness facts (see *Constraints & Gotchas* – this route is permanently anonymous).
  - **Verify**: with the database up, the response is 200 and its schema version equals the value seeded by TI03's migration; changing that row's value in the database changes the response without a restart or rebuild. Covers S01.

- [ ] **TI08** The API runs as a long-running HTTP server from its own image, configured entirely from the environment and shutting down without dropping in-flight requests
  - Multi-stage `api/Dockerfile` (build deps excluded from the runtime image, non-root user); listen port and database settings read from environment at startup; SIGTERM stops accepting connections and drains in-flight requests before exit, which is what makes S13's restart and rollback path safe; a container healthcheck hits `/api/health`.
  - **Verify**: the built image starts and serves `GET /api/health` with configuration supplied only as environment variables; sending SIGTERM completes an in-flight request before the process exits; the tree contains no `function.json`, `host.json`, `local.settings.json`, or `@azure/functions` dependency.

- [ ] **TI09** The SPA presents a responsive app shell that renders the health result and reflows cleanly from 375px to 1280px
  - React + TypeScript, fluid layout (relative units / flex or grid), no fixed-width containers; a visible health panel showing schema version, server timestamp, and an explicit error state driven by the TI05 envelope's `message`.
  - **Verify**: at 375px, 768px and 1280px the shell renders with no horizontal scrollbar and no clipped content, and the panel shows the live database value at each width. Covers S05.

- [ ] **TI10** The SPA's built static assets are served from their own container image whose API base URL is supplied at run time, not at build time
  - Multi-stage `web/Dockerfile` (build → static-file server); SPA history fallback so deep links serve `index.html`; API client reads one base URL from runtime configuration materialized by the container at start (see *Constraints & Gotchas*), defaulting to same-origin `/api`, which the static container reverse-proxies to the API service. Consumes TI09's shell.
  - **Verify**: the same built image serves the app against two different API base URLs supplied only as environment variables, with no rebuild; a deep link to a non-root path returns the app rather than 404. Covers S01.

- [ ] **TI11** One documented command brings the whole stack up from a clean state and the round trip works end to end
  - Root `docker-compose.yml` composes the SPA container (TI10), API container (TI08) and PostgreSQL (TI02) with service dependency conditions on health, a shared network, and `.env`-supplied configuration; migrations are applied by a documented command against the composed database. Only the database service mounts a volume – the API and SPA services declare none and need none, stated as a comment in the file so the absence reads as intent (see *Constraints & Gotchas*).
  - **Verify**: from a stopped state with no images built, the documented bring-up plus migrate commands yield the SPA URL showing the database-backed schema version in a browser, with no manual proxy, CORS, or hostname edit; destroying and recreating only the API and SPA containers restores identical behavior with no data or configuration replay; the file declares exactly one named volume and no `volumes:` entry on any application service. Covers S01, S08, S09, S10.

- [ ] **TI12** Lint, format-check, type-check and test commands exist at the workspace root and pass on a clean tree
  - Single root entry point per gate covering both `web/` and `api/`; test runner supports targeting a single test file/name – that invocation is what TI14 documents.
  - **Verify**: `npm run lint`, `npm run format:check`, `npm run typecheck` and `npm test` each exit 0 on a clean checkout, and the single-test invocation runs exactly one test file.

- [ ] **TI13** `docs/STACK.md` records the resolved versions of everything this story ships, with no `_TBD_` left for delivered components
  - Replace `_TBD_` in place; keep the existing table structure; name the chosen HTTP framework, static-file image, and Docker/Compose versions. Components not delivered here (Capacitor, container platform, push service, production database hosting) legitimately stay `_TBD_`/undecided – say so rather than inventing values.
  - **Verify**: every language, framework, runtime, database, container-image, lint/format and test-runner row for a delivered component carries a version string matching the committed lockfile or image tag; the file's leading "versions are unpinned" comment is removed or corrected.

- [ ] **TI14** `docs/KEY_DEVELOPMENT_COMMANDS.md` contains only commands that work as written, including running a single targeted test and the three visual-validation widths
  - Fill every `TODO`: composed stack up/down, application URL, local dev loop, format, lint/type-check, run all tests, **run a specific test file**, migrate up/down, production build and image build, and screenshot capture at ~375px / ~768px / ~1280px. Cloud deployment stays explicitly out of scope with a one-line pointer to S13 rather than a fabricated command. The teardown entries distinguish the two directions explicitly: `docker compose down` keeps the named volume and its data, `docker compose down -v` is the deliberate clean-rebuild command that deletes it – with the consequence written next to the command, not left to be discovered.
  - **Verify**: no `TODO` remains in the file, each listed command executes successfully when copy-pasted from a clean checkout, and the teardown section states in words which command preserves data and which destroys it. Covers S06, S09.

### Testing Strategy

- Integration tests for TI04–TI07 run against the composed PostgreSQL with migrations applied to a **dedicated test database**, not the development one – the migrate-down half of S06 destroys data and must never touch a developer's working database.
- The `DATABASE_UNAVAILABLE` path (S04) is exercised by pointing the connection at a closed port rather than stopping the container, so the whole suite still runs in one command without operator intervention.
- S08–S10's durability checks act on the composed stack (container teardown and recreation), so they are a scripted compose-level check rather than an in-process test, and they run against the development stack's own named volume – never the dedicated test database, whose migrate-down cycle would mask what S08 is trying to prove.
- S05's three-width check is a scripted screenshot capture (the same command TI14 documents), not a manual browser resize – it must be repeatable by every later UI story.

### Execution Contract

- TI03 must complete before TI04 and TI07 – there is no schema to read otherwise.
- TI05 and TI06 must complete before TI07, so the health handler is written through the conventions rather than retrofitted into them.
- TI08 and TI10 must complete before TI11 – there is nothing to compose until both images exist.
- TI13 and TI14 run last and record what actually shipped; writing them from this spec's assumptions instead of from the built repository defeats their purpose.


## Final Validation Checklist

- [ ] No authentication code, no conference-domain table or entity, and no Capacitor project exists in the tree – those are S02, S03/S04 and S11, and landing them early would pre-empt decisions those stories own.
- [ ] `GET /api/health` is the only route intended to remain anonymous after S02, and its payload carries nothing beyond liveness/readiness facts.
- [ ] Nothing in the tree implements or documents a warm-up, pre-warm, or cold-start mitigation – ADR-004 removed the requirement rather than deferring it.
- [ ] The named volume was proven by destroying and recreating the database container and reading the data back – not by inspecting `docker-compose.yml` – and nothing written in code, comments, or docs describes that volume as a backup.


## Implementation Observations

_No observations recorded yet._
