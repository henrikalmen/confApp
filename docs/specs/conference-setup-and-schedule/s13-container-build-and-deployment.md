# S13 – Container Build and Deployment

**Plan**: docs/specs/conference-setup-and-schedule/plan.json
**Story-ID**: S13

## Feature Overview and Goal

**Intent**: Everything the plan builds runs only on a developer's machine – so the PRD's availability requirement ("No planned downtime across the conference date span") is owned by nobody, S12's performance thresholds cannot be failed because there is no deployed environment to measure them on, and the PRD's Durability rows hold only for the composed stack S01 owns – nothing yet guarantees a deployed conference survives the container serving it.

**Expected Outcomes** (each `[OC<NN>]`-tagged; scenarios anchor to these):

- [OC01] The API and SPA run in a cloud environment as published container images with a reachable PostgreSQL behind them, served over HTTPS, with each running service traceable to the commit its image was built from – and the environment named so S12 can quote its numbers against it.
- [OC02] Neither Pending decision is closed by implementation: the container platform and the database host are deploy-time inputs, and the identical published image digest runs against a second target with only configuration changed – no rebuild, no source edit.
- [OC03] No credential exists in the repository or inside either image; every secret arrives at deploy time from the platform's secret mechanism, referenced by name, and a missing one fails the deployment loudly rather than falling back to a committed default.
- [OC04] Availability across conference hours is demonstrated rather than asserted: an executed rolling restart drops no in-flight request, and an executed rollback returns the previous image to service – both driven from a written procedure that was actually run.
- [OC05] Conference data in the deployed environment outlives every container that touches it: the database's storage is independent of the container writing to it – a named volume where PostgreSQL runs as a container, the service's own storage where a managed one is used – the application containers are verified to hold nothing durable, and a conference read back after its database container is replaced is intact down to lifecycle state, sessions, memberships and role assignments. The boundary is written alongside it: a volume is not a backup.


## Required Context

- `docs/specs/conference-setup-and-schedule/prd.md#non-functional-requirements` – the row this story exists to own: **Reliability | Availability during conference hours | No planned downtime across the conference date span**. Three **Durability** rows bind here and are why this story was amended: no data lost when any container is stopped, replaced or recreated; *"PostgreSQL data lives on a **named volume** (or… a managed service's durable storage) – never in a container's writable layer"*; and the application containers being destroyable at any time, which makes the database the only component needing durable storage. Two further rows bind here: **Portability | Plain PostgreSQL only, no provider-specific extensions (ADR-003)**, and **Security | `hd` claim verified server-side on every request (ADR-002)** – the latter is why the only surface a platform probe may call is S01's deliberately anonymous `GET /api/health`, and why nothing else may be exposed unauthenticated to make probing easier. The table's two cold-start rows are **stale**: ADR-004 eliminated them rather than deferring them, so no warm-up, pre-warm, or keep-alive mechanism belongs in this deployment.
- `docs/adrs/ADR-004-containerized-api-and-spa.md#decision` – the shipping model this story implements. "The images are built to run on a container platform… **Nothing in the application depends on that platform's proprietary features.**" Also: statelessness survives the change because the API now scales across replicas, and venue-local deployment is a retained capability, **not** a supported path.
- `docs/adrs/ADR-003-postgresql-containerized-development.md#decision` – production hosting is deliberately open, and "migration between them is a `pg_dump` and a restore; no application code changes" is the portability property this story must leave intact. It also sets a boundary this story must honour: the production database backing a live conference "will not run on a laptop or on unattended office hardware… and backups must be someone's explicit responsibility".
- `docs/specs/conference-setup-and-schedule/prd.md#edge-cases` and `#constraints` – the four durability rows: the database container stopped, replaced or its host rebooted mid-conference; an API or SPA container destroyed and recreated ("Returns identically – neither holds state"); a past conference opened long after the event on infrastructure since restarted many times; and the volume itself deleted or its host lost – the case a volume explicitly does **not** cover ("is not a backup"), where restore is the only path. The archive (FR9) is what durability protects. S01 owns the composed topology's named volume; this story owns the deployed equivalent and does not fork S01's Compose definition.
- `docs/DECISIONS.md#pending` – **"Container platform"** and **"Production database hosting"** are both open, owner-owned decisions. This story deploys against a configured target and must not record, imply, or hard-code a resolution for either.
- `AGENTS.md#do-not--never` – three prohibitions bind directly: "Never commit `.env` files or credentials – they end up in version history"; "Never rely on in-process state between requests" (the property that makes more than one API replica safe); "Never tie the schema to a managed provider's proprietary features".
- `docs/guidelines/CRITICAL-RULES-AND-GUARDRAILS.md#honesty-and-verification` – "Verify before claiming done… 'Done'/'works' is false if anything was skipped." This is the acceptance bar for the availability posture: a restart and a rollback that were executed and observed, not a runbook nobody ran.
- `docs/ARCHITECTURE.md#key-constraints` – "Containerized backend (ADR-004) – one artifact runs in development, on a local server, and in the cloud. Handlers remain stateless: the API scales horizontally across replicas and requests are not sticky."
- `docs/specs/conference-setup-and-schedule/plan.json#stories` – this story's own `scope` and `notes`, and story **S12**, which `dependsOn` S13: "Measuring against S13's deployed environment is what makes these criteria falsifiable; a local-only harness cannot fail them."
- `docs/KEY_DEVELOPMENT_COMMANDS.md#build--deployment` – the `TODO` **Deploy** row this story fills. S01 deliberately left a pointer to S13 here instead of a fabricated command.


## Deeper Context

- `docs/specs/conference-setup-and-schedule/s01-tracer-bullet-skeleton.md#constraints--gotchas` – the inputs this story consumes: environment-driven configuration in both images, the `/api` prefix rule (a proxy that strips it while the API omits it is the failure mode), and the permanently-anonymous `GET /api/health` bounded to liveness/readiness facts, which exists precisely because container-platform probes cannot present an OIDC token.
- `docs/specs/conference-setup-and-schedule/s01-tracer-bullet-skeleton.md#implementation-plan` – TI08 (SIGTERM stops accepting connections and drains in-flight requests) and TI10 (the SPA image's API base URL supplied at run time, not baked at build time) are the two S01 behaviours this story's rolling restart and second-target run depend on. Verify they hold under a real restart rather than assuming the spec was met.
- `docs/specs/conference-setup-and-schedule/s01-tracer-bullet-skeleton.md#structural-criteria` – "Neither image bakes in environment-specific configuration… so the same image runs in development and against another target without a rebuild (S13 depends on this)."
- `docs/STACK.md#infrastructure` – the rows this story updates, and the two rows ("Container platform", "PostgreSQL" production hosting) that must remain undecided with a pointer to `docs/DECISIONS.md` → Pending.
- `docs/ARCHITECTURE.md#integration-points` – the `_TBD_` Config Location for the container platform row.


## Acceptance Scenarios

- [ ] **S01 [OC01] [TI01,TI02,TI08] Images published from a named commit serve the round trip in the cloud environment over HTTPS**
  - **Given** a clean checkout at a known commit, and a deployment target supplied entirely as configuration – registry, platform endpoint, database connection, SPA API base URL
  - **When** the documented build → publish → deploy sequence is run as written from `docs/KEY_DEVELOPMENT_COMMANDS.md`
  - **Then** the environment's public HTTPS URL serves the SPA – whichever signed-out view is current at W9, with no particular panel required – `GET /api/health` returns `200` from a network outside the platform reporting the schema version read from the **deployed** PostgreSQL, and the platform reports the API and SPA services running exactly the image digests published from that commit

- [ ] **S02 [OC01,OC04] [TI04] An API replica whose database is unreachable is taken out of rotation but is not restart-looped**
  - **Given** the API is deployed with at least two replicas, all serving, and a client polling `GET /api/health`
  - **When** one replica's database connection is made unreachable while the other's stays healthy
  - **Then** that replica reports not-ready, the platform routes no further traffic to it, every client request continues to be answered `200` by the healthy replica, and the unready replica is **not** killed and recreated in a loop – once its database is reachable again it returns to rotation with no redeployment

- [ ] **S03 [OC04] [TI05] A rolling restart of the whole API replica set completes without a single failed request**
  - **Given** the deployed API is running at least two replicas and a client is issuing continuous `GET /api/health` requests at roughly 5 per second
  - **When** a rolling restart is triggered by redeploying the same image digest
  - **Then** every request in the continuous stream returns `200`, no connection is reset or truncated mid-response, and the platform ends with every original replica replaced – proving S01's SIGTERM drain survives an actual restart rather than only a local signal test

- [ ] **S04 [OC04] [TI06,TI08] A rollback to the previously deployed digest is executed from the runbook and returns that version to service**
  - **Given** image digest A is deployed and serving, then digest B is deployed over it and confirmed running by the platform
  - **When** the rollback step in the deployment runbook is executed exactly as written, with the continuous request stream still running
  - **Then** the platform reports digest A running again, the request stream records no non-2xx response across the transition, and no step required a command that is absent from the runbook

- [ ] **S05 [OC03] [TI03] A deployment whose secret is missing fails loudly, and no credential exists in the repository or the images**
  - **Given** the deployment configuration references the database password and registry credential **by name** from the platform's secret mechanism, with no value in any tracked file
  - **When** the database password secret is absent at deploy time
  - **Then** the new API replica never becomes ready, the deployment does not take traffic, and no committed default or placeholder is silently used in its place – and separately, a scan of the repository tree, of every commit this story produces, and of the filesystem of both published images finds no database password, registry credential, or OIDC client secret

- [ ] **S06 [OC02] [TI02,TI07] The identical published digest runs against a second database host with only configuration changed**
  - **Given** the digest currently deployed to the cloud environment, and a second PostgreSQL instance restored from a `pg_dump` of the deployed one
  - **When** that exact digest is started against the second instance, supplying only environment variables and secret references – a different connection URL and a different SPA API base URL
  - **Then** it starts, passes readiness, and `GET /api/health` returns `200` with the restored schema version, with no rebuild, no source change, no manifest fork, and no platform SDK or CLI invoked from inside the image

- [ ] **S07 [OC05] [TI10,TI11] A conference survives the destruction and replacement of the database container it was written through**
  - **Given** a published conference mid-run and an archived one, both read out in full beforehand, and a PostgreSQL data directory resolving to storage declared independently of the container
  - **When** the database container is stopped, removed and recreated from the same image against that **same, not recreated** storage – or a managed instance is restarted or failed over – and the API replicas reconnect
  - **Then** both conferences match their captured state exactly, every session, membership and role assignment present and the archived one reading as it did on the day; readiness returns with no redeployment and no migration re-run; and the drill fails rather than passes if the storage was recreated with the container

- [ ] **S08 [OC05] [TI11] Destroying and recreating both application containers loses nothing, because neither holds anything durable**
  - **Given** the same conferences, and API and SPA services declaring no persistent storage
  - **When** every API and SPA container is destroyed and recreated from the same digests, the database untouched
  - **Then** the SPA serves, `GET /api/health` returns `200` from the same database, both conferences read back unchanged, and inspecting the services confirms no volume, mount or persistent claim on either – verified, not assumed


## Structural Criteria

- [ ] No credential, private key, connection string with a password, `.env` file, or registry token is committed by this story – in source, deployment manifests, or documentation examples. `.env.example` gains every new deployment variable as a non-secret placeholder only.
- [ ] Both `docs/DECISIONS.md` → Pending entries – "Container platform" and "Production database hosting" – are still listed and unresolved, and no document this story writes states or implies either is decided.
- [ ] No application source file, image layer, or build step depends on a specific vendor's SDK, CLI, or proprietary deployment primitive: the published digests still start and serve under S01's `docker-compose.yml` unchanged.
- [ ] Migrations and the deployed database use plain PostgreSQL only – no `CREATE EXTENSION`, no provider-specific types, functions, or DDL (ADR-003).
- [ ] `GET /api/health`'s response payload gains no field – no build, image, version, or configuration identifier – preserving S01's bound on the one permanently anonymous route.
- [ ] The deployed PostgreSQL's data directory resolves to storage whose lifecycle is independent of the container writing to it – a named volume or persistent-volume equivalent where it runs as a container, a managed service's own storage otherwise – never to a writable layer. The route taken is recorded as the *current* configuration, both stay reachable through the same definition, and neither Pending decision closes.
- [ ] Neither application service declares a volume, mount or persistent claim, and nothing either writes at run time has to survive its container.
- [ ] The runbook records that the production database runs on attended, backed-up infrastructure rather than a laptop or unattended office hardware (ADR-003), and names the backup mechanism, its schedule, and its owner – recording an unassigned owner as an explicit open item rather than leaving it implicit.
- [ ] `docs/KEY_DEVELOPMENT_COMMANDS.md` → Build & Deployment contains no `TODO`, and every command listed there was executed as written against the deployed environment.
- [ ] S01's gates still pass unchanged on a clean checkout – `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm test`, `npm run build` – and no application behaviour was altered to make deployment work.


## Scope & Boundaries

### Work Areas
- Image build and publication – tagging and pushing the API and SPA images to a configured registry, with digests recorded against the source commit.
- Deployment definition – one parameterized description of the API, SPA and PostgreSQL services, applied against a target supplied as input.
- Configuration and secret surface – the deployment variable inventory, `.env.example` additions, and secret references resolved by the platform at deploy time.
- Health, readiness and replica configuration – probe wiring per service, replica count, and the rolling-update strategy and grace period.
- Database provisioning, durable storage and portability – the deployed PostgreSQL, its migration run, the container-independent storage its data directory lives on, the `pg_dump`/restore drill onto a second instance, and the executed container-replacement and application-container-recreation durability drills.
- Operational runbook – restart, rollback, backup ownership, environment identity, and the conference-hours availability posture, landing in `docs/KEY_DEVELOPMENT_COMMANDS.md`.
- Stack documentation – `docs/STACK.md` infrastructure rows recording what shipped without closing either Pending decision.

### What We're NOT Doing
- **Choosing the container platform or the production database host** – both are Pending in `docs/DECISIONS.md` and are the owner's to close. Deploying against a configured target keeps them open; recording either as decided would close an owner's decision by implementation.
- **CI/CD pipeline automation** – no requirement asks for build-on-push, environment promotion, or deployment gating. Documented commands run by hand are sufficient to make S12 measurable and the availability row real; automating them is a separate decision once a platform is chosen.
- **Monitoring, alerting, log aggregation, dashboards, autoscaling policy, multi-region or multi-zone topology, and CDN fronting** – the PRD's NFR table asks for none of them. Readiness probes plus the platform's own replacement behaviour carry the availability requirement for an under-100-employee single-venue event.
- **Performance measurement and optimization** – S12 owns the p95 and 100-concurrent numbers and the harness that produces them. This story only produces and names the environment they are measured on; quoting a number here would pre-empt S12's baseline.
- **Replication, high availability, failover automation, point-in-time recovery, multi-region topology, and automated backup scheduling** – none is asked for. The Durability rows require that data survive the container lifecycle, not that the database survive its own host uninterrupted: the drills cover container-level loss and `pg_dump`/restore covers volume- and host-level loss, with backups already an owned responsibility (ADR-003). A replica would also begin prejudging the Pending database host.
- **Venue-local deployment as a supported path** – ADR-004 explicitly retains it as a capability but not a supported scenario, because Google Workspace OIDC needs internet reachability at sign-in. Making it supported requires resolving authentication for a disconnected venue first.


## Architecture Decision

**Approach**: Deploy S01's images unchanged to a *configured* container target – registry, platform endpoint, database URL, SPA API base URL and secret references are all deploy-time inputs to one parameterized deployment definition. See ADR: `docs/adrs/ADR-004-containerized-api-and-spa.md`.
**Why this over alternatives**: a platform-native descriptor (an ARM/Bicep template, a vendor CLI deployment recipe, or an equivalent proprietary primitive) would be shorter, but it closes the container-platform decision by implementation and forfeits exactly the portability that ADR-003 and ADR-004 both exist to protect.


## Technical Overview

The path is: clean checkout at commit → multi-stage build of `api/` and `web/` images (S01's Dockerfiles, unmodified) → tag and push to the configured registry, recording each digest against the commit → apply the parameterized deployment definition against the configured platform, supplying image digests, the database connection, the SPA's API base URL and secret *references* → the platform pulls the digests, injects the referenced secrets as environment variables, starts replicas, and gates traffic on each service's readiness probe → migrations are applied against the deployed database by a documented command → the SPA is reachable over HTTPS and `GET /api/health` answers from the deployed PostgreSQL.

Nothing target-specific crosses into an image. The database is reached through a connection URL that is an input, so whether it is a managed service, a container on the same platform, or a third-party host is configuration rather than a decision made here – with ADR-003's boundary applying to whichever instance backs a live conference. Its *storage* is an input of the same kind – a named volume for a containerized instance, the service's own guarantee for a managed one – so durability is satisfied on either path without choosing one. If the environment deployed here is not the production one, the runbook records the difference, because a performance number taken on different sizing does not transfer to S12's verdict.


## Code Patterns & External References

```
# type | path#anchor or url                                              | why needed (intent)
file   | docs/specs/conference-setup-and-schedule/s01-tracer-bullet-skeleton.md#constraints--gotchas | env-driven config, /api prefix rule, anonymous bounded health route
file   | api/Dockerfile, web/Dockerfile, docker-compose.yml               | S01's build inputs – publish and deploy these, do not fork them
file   | docs/KEY_DEVELOPMENT_COMMANDS.md#build--deployment               | table row shape to fill – keep the existing headings and structure
file   | docs/STACK.md#infrastructure                                     | rows to update in place; leave the two undecided rows undecided
url    | https://docs.docker.com/reference/cli/docker/image/push/         | publishing a tagged image to a configured registry, and digests
url    | https://nodejs.org/api/process.html#signal-events                | SIGTERM drain – the behaviour the platform's grace period must not outrun
url    | https://www.postgresql.org/docs/current/app-pgdump.html          | dump/restore is the database-host migration path ADR-003 relies on
url    | https://docs.docker.com/engine/storage/volumes/                  | named vs anonymous volume lifecycle – the container-route durability shape
```


## Constraints & Gotchas

- **Critical – neither Pending decision may be closed here.** Every target-specific value (platform endpoint, region, registry host, database host) is an input, never a literal in application source, a Dockerfile, or a committed manifest default. The test an executor should apply: if the owner picks a different platform next month, does anything in the repository need editing beyond configuration values? If yes, the decision was closed by implementation.
- **Critical – liveness is not readiness.** A database outage must make replicas *not ready*, never *dead*. Wiring a liveness probe to database reachability restart-loops the entire replica set during a blip that would otherwise self-heal, converting a partial outage into a total one – on the one date that cannot move.
- **Critical – the platform's termination grace period must exceed the API's drain window.** S01's TI08 implements a SIGTERM drain; if the platform sends SIGKILL first, the rolling restart drops in-flight requests and S03 fails for a reason entirely invisible in application code. Set the grace period from the drain window, not from a platform default.
- **Critical – a durability drill that recreates the storage alongside the container proves nothing.** The tempting shortcut tears the database down and brings it back with one command that also recreates its volume; the data "survives" because it was seeded again, and the drill passes while the requirement is unmet. The surviving artifact must be the storage – identified before the drill, the same afterwards – and the drill must be able to **fail**. An anonymous or default-named volume a redeploy silently replaces is the same defect in a volume's clothes.
- **A volume is not a backup, and the runbook (TI08) must not let a reader conflate them.** It covers the container going away and nothing more; volume deletion or host loss is what `pg_dump`/restore covers.
- **Rollback across a migration is not automatically safe.** Returning to an older image over a newer schema only works while the older code tolerates that schema. The runbook must state that boundary explicitly rather than presenting rollback as unconditionally safe; the scenario here rolls back across no schema change, and that limit is part of what gets written down.
- **`GET /api/health` is the probe – keep it anonymous and keep it bounded.** Platform probes cannot present an OIDC token, which is why S01 made this route permanently anonymous and S02 leaves it alone. Do not authenticate it, and do not add a build/image/version field to it to make the rollback observable – observe the platform's reported running digest instead (S01: no later story may add such a field).
- **Secrets are referenced, never inlined.** A password pasted into a committed deployment manifest is the same defect as a committed `.env` – `.gitignore` already excludes `.env` and `.env.*` while allowing `.env.example`, and any new configuration file must land on the correct side of that rule. Registry credentials come from the deploy environment too, not from a tracked file.
- **Avoid**: baking the SPA's API base URL into the web image at build time. S01 made it runtime configuration precisely so one digest serves every target; a build-time bake silently reintroduces one image per environment and quietly breaks S06 and every future rollback.


## Implementation Plan

### Implementation Tasks

- [ ] **TI01** Each deployable has a published image in a configured registry, traceable to the commit it was built from
  - Registry host, repository and tag come from deploy-time configuration rather than literals in the build files; each published tag's digest is recorded alongside the source commit SHA. Builds use S01's `api/Dockerfile` and `web/Dockerfile` unchanged.
  - **Verify**: building the same clean checkout twice produces images whose application content is identical (same file set and content hashes in the application layers), and the digest the platform reports running matches the digest recorded for that commit. Covers S01.

- [ ] **TI02** One parameterized deployment definition brings up the API, SPA and PostgreSQL against a target supplied entirely as input
  - Required inputs are named explicitly: image digests, database connection URL, SPA API base URL, listen port, replica count, secret references, and – where the target runs PostgreSQL as a container – the durable storage its data directory binds to (TI10). No platform, region, registry, hostname or database host literal appears in application source or in either image.
  - **Verify**: the definition applies against the configured target with every target-specific value supplied as input, and the published digests still start and serve under S01's `docker-compose.yml` unchanged – proving no platform-proprietary primitive was baked in. Covers S01, S06.

- [ ] **TI03** Every secret reaches a running container from the platform's secret mechanism at deploy time, with no fallback to anything committed
  - The deployment definition references secrets by name; `.env.example` gains each new deployment variable with a non-secret placeholder; a missing secret is a hard startup failure, never a silent default. Registry credentials likewise come from the deploy environment.
  - **Verify**: with the database password secret absent the API replica never becomes ready and takes no traffic; scanning the repository tree, this story's commits, and the filesystem of both published images finds no password, token, or client secret. Covers S05.

- [ ] **TI04** Each service exposes a readiness signal the platform gates traffic on, kept distinct from liveness
  - API readiness is S01's `GET /api/health` reporting database reachability; SPA readiness is the static container serving `index.html`. Liveness must not be wired to database reachability (see *Constraints & Gotchas*).
  - **Verify**: a replica whose database is unreachable reports not-ready, receives no traffic, is not killed and recreated in a loop while the database is down, and returns to rotation without redeployment once it is reachable. Covers S02.

- [ ] **TI05** The API runs more than one replica and a rolling restart replaces the whole set without dropping a request
  - Replica count ≥ 2 with a rolling update that brings a new replica to ready before terminating an old one; the platform's termination grace period is set from S01 TI08's drain window, not from a default. More than one replica is only safe because handlers hold no in-process state between requests (`AGENTS.md`).
  - **Verify**: under a continuous request stream a rolling restart completes with zero non-2xx responses and zero reset connections, and every original replica is replaced. Covers S03.

- [ ] **TI06** A recorded previous image digest can be returned to service by a documented rollback that was executed
  - Rollback is a redeploy of a prior digest recorded by TI01, applied through the same TI02 definition – never a rebuild from an older commit, which would produce a different artifact than the one that was known good. The migration boundary from *Constraints & Gotchas* is stated wherever the procedure is written.
  - **Verify**: after deploying digest B over A, executing the rollback step returns digest A to service – confirmed by the platform's reported running digest – with no failed request in the continuous stream. Covers S04.

- [ ] **TI07** The identical published digest serves a second PostgreSQL instance restored from a dump of the deployed one, with only configuration changed
  - `pg_dump` from the deployed database, restore into a second instance, repoint the same digest via environment variables and secret references only – ADR-003's claim that a host migration is a dump and restore with no application code change. This doubles as the restore drill that makes the backup responsibility real rather than nominal.
  - **Verify**: the same digest starts against the restored database, passes readiness, and returns the restored schema version from `GET /api/health`; no rebuild, source edit, manifest fork, or image change was required. Covers S06.

- [ ] **TI08** The deployment runbook states restart, rollback, backup ownership, environment identity and the conference-hours posture, and every step in it was executed as written
  - Fills `docs/KEY_DEVELOPMENT_COMMANDS.md` → Build & Deployment, replacing the `TODO` Deploy row and S01's pointer to this story. Records the environment's public URL and running digests; names the backup mechanism, schedule and owner (an unassigned owner is recorded as an explicit open item); states the ADR-003 boundary on production database hosting; states the durability boundary – volume or managed storage covers container-level loss, `pg_dump`/restore covers volume- and host-level loss, and a volume is not a backup; and states that a change during the conference date span ships as a rolling update, never a stop-then-start.
  - **Verify**: no `TODO` remains in that section, and each documented command was run against the deployed environment with its observed result recorded – not transcribed from this spec. Covers S01, S04.

- [ ] **TI09** `docs/STACK.md` records what actually shipped for deployment while leaving both Pending decisions open
  - Add the registry, the deployed image tag/digest convention, and the environment's identity; the Container platform row and PostgreSQL production-hosting row continue to read as undecided with a pointer to `docs/DECISIONS.md` → Pending, naming the target deployed against as the *current* target rather than the decision.
  - **Verify**: both rows still read as undecided and reference the Pending list, `docs/DECISIONS.md` → Pending still carries both entries unresolved, and every added row matches what was actually deployed.

- [ ] **TI10** The deployed database's data lives on storage whose lifecycle is independent of any container, satisfiable on either hosting path
  - Where PostgreSQL runs as a container, its data directory binds to an explicitly declared named volume or persistent-volume equivalent – never a default, anonymous or implicitly-created one, and never the writable layer. Where a managed PostgreSQL is used, the service supplies the guarantee and no volume is declared. Both shapes are reachable through TI02's definition by configuration alone, so neither Pending decision closes; the application services get no storage at all.
  - **Verify**: the deployed data directory resolves to the declared independent storage rather than the writable layer, the same definition expresses the other hosting shape by configuration change alone, and neither application service shows a volume, mount or claim. Covers S07, S08.

- [ ] **TI11** A durability drill was executed against the deployed environment and a conference read back intact
  - Seed a published conference mid-run and an archived one, capture their state, replace the database container against the same surviving storage (or restart/fail over the managed instance), then destroy and recreate every application container, reading both back after each. Recorded evidence, like the restart and rollback drills.
  - **Verify**: after each replacement both conferences match their captured state exactly – lifecycle state, sessions, memberships, role assignments – with no redeployment, migration re-run, or re-entered data; the storage identified beforehand is the same afterwards, and a run in which it was recreated counts as failed. Covers S07, S08.

### Testing Strategy

- The rolling-restart stream (S03) is generated by a scripted client issuing `GET /api/health` at ~5 req/s from **outside** the platform for the whole restart window, recording status, connection outcome and timing per request to a file that is kept as evidence. A *dropped* request is any of: a non-2xx status, a connection reset or refused, a response truncated mid-body, or a request that exceeds the client timeout – not merely a non-200 status, since the SIGKILL failure mode shows up as a reset rather than an error code. The platform's termination grace period is asserted against S01 TI08's measured drain window (read the configured value, don't assume the manifest default): if the grace period is shorter, the restart drops requests in production while a short-lived or low-rate test stream still passes clean. Tag: `[TI05]`.
- The rollback (S04) captures its "before" state from the **platform's own report** of the running digest for digest A, recorded before digest B is deployed, and asserts the post-rollback report matches that recorded digest exactly. Without the recorded-before value the test cannot distinguish a rollback from a redeploy of whatever is currently newest, and a rebuild from an older commit must fail the assertion rather than satisfy it – a fresh build of the same source is a different digest. Tag: `[TI06]`.
- The secret scan (S05) runs over **both** the committed history (every commit this story produces, not just the working tree) and the extracted filesystem of each published image – enumerate the layers of the API and SPA images and search the assembled filesystem, including build-stage leftovers and any `.env`-shaped file. An image can carry a secret in a layer that appears in no commit, and a working-tree-only scan reports clean for both cases. Tag: `[TI03]`.
- The `pg_dump`/restore drill (S06) is run as a single exercise serving two assertions: portability (the *identical* digest, compared by digest string, serves the second instance with only environment variables and secret references changed) and the backup restore drill (the dump is taken by the mechanism TI08 names as the backup mechanism, and the restored instance answers readiness). A drill run with an ad-hoc dump command that differs from the documented backup mechanism proves the first but not the second. Tag: `[TI07,TI08]`.
- Liveness vs readiness (S02) is tested by making one replica's database unreachable at the **network** level – point that replica's connection at a closed port or block the route – while the other replica stays healthy, then observing for longer than several liveness-probe periods. The assertions are three: the affected replica reports not-ready and receives no traffic; the healthy replica answers every client request `200`; and the affected replica's restart count and container identity are **unchanged** across the observation window, and unchanged again after the database is restored and it rejoins rotation. The restart-count assertion is the one that catches a liveness probe wired to database reachability – without it, a restart-looping replica set still passes the traffic-routing half. Tag: `[TI04]`.
- The durability drill (S07, S08) runs from a **captured baseline**: both conferences are read out in full beforehand and compared field by field after, because a drill asserting only that the API answers `200` passes against an empty database. The trap is a drill that recreates the storage along with the container – record its identity (volume name, claim, or instance id) before and after, and treat a run where those differ as a failure. The container must be **removed and recreated**, never stopped and started: a data directory on the writable layer survives a stop-start, so only a real replacement can fail the test. Tag: `[TI10,TI11]`.

### Execution Contract

- The owner supplies the exec-time inputs this story deploys *against* – a reachable container target, a registry, a PostgreSQL host, and the credentials for each. They are inputs, not decisions: supplying them exercises the parameterized path and closes neither Pending decision. Without them TI01–TI11 cannot be observed, so an unattended run should collect them first (the `andthen:preflight` skill).
- TI01 must complete before TI02 – there is nothing to deploy until digests exist and are recorded.
- TI04 must complete before TI05 and TI06: a rolling restart and a rollback both depend on the platform knowing when a new replica is ready, and without it both "succeed" while dropping requests.
- TI10 precedes TI11 – a drill run before the storage is declared independent cannot tell surviving data from re-seeded data – and TI11 needs real conference data, so it follows the plan stories that create it.
- TI08 runs after TI05, TI06, TI07 and TI11 and records what was actually observed; writing it from this spec's expectations instead of from executed runs defeats its only purpose.


## Final Validation Checklist

- [ ] `docs/DECISIONS.md` → Pending still lists both "Container platform" and "Production database hosting", and nothing this story wrote states or implies either is decided.
- [ ] Every command in the deployment runbook was actually executed against the deployed environment and its observed result recorded – a documented procedure nobody ran is not evidence (`docs/guidelines/CRITICAL-RULES-AND-GUARDRAILS.md` → Honesty and Verification).
- [ ] Nothing in the tree implements or documents a warm-up, pre-warm, or keep-alive mechanism – ADR-004 removed that requirement rather than deferring it, and a scheduled ping added "for availability" resurrects it.
- [ ] No secret value appears in any file this story added or changed, including deployment manifests and documentation examples.
- [ ] The durability drill was executed – not described – and its evidence shows the storage identified beforehand was still the surviving artifact afterwards.


## Implementation Observations

### Run: 2026-08-20 08:02 UTC – discovered-requirements

#### DISCOVERED REQUIREMENTS

- **The SPA container must serve `/sw.js` with a no-cache (or `no-store`) `Cache-Control` header.** S10 introduced a service worker at `web/public/sw.js`; this story owns the container that serves it, and the header is the only place the update path can be fixed – it is served, not built, so no change to the worker source can substitute for it. Verified state of the repo as of S10's completion: `web/nginx/default.conf.template` sets `add_header Cache-Control "no-store" always;` for `location = /config.js` only, and `/sw.js` falls through to `location /` with `try_files $uri $uri/ /index.html;` and no explicit cache header. A browser that has HTTP-cached a service worker script may reuse it for up to 24 hours before refetching, so without an explicit no-cache header a deployment shipping a corrected or updated worker may not take effect on returning devices for a day – a change made during the conference date span that returning attendees never receive is the same failure the rolling-update posture (TI08) exists to prevent, arriving through the browser instead of the platform.
- **What is already handled and must not be re-solved.** `sw.js` treats `/index.html`, `/config.js` and all navigations as network-first precisely so a redeploy cannot pin a browser to a previous build's assets or API base URL. The stale-deployment hazard at the application layer is therefore closed, and re-solving it in the container – or weakening the network-first strategy to compensate – would undo S10's work. The residual is only the worker script's own update path at the HTTP layer.
- **Lower severity, recorded alongside it: `CACHE_NAME` is a constant while Vite's asset names are fingerprinted**, so Cache Storage accumulates one `/assets/*` entry set per deployment. Bounded and harmless for an under-100-employee conference, but versioning `CACHE_NAME` per build would evict superseded sets.
- **Suggested verification.** Assert the deployed container returns a no-cache-family `Cache-Control` on `/sw.js`, in the same place this story already asserts `/config.js` is `no-store`.

#### DECISION NOTE: container-build-toolchain

Decision-Key: container-build-toolchain
Altitude: fis-local
Affected surface: Implementation Plan → TI01 (image build and publication), and every downstream task that depends on published digests (TI02, TI04–TI11).
Decision: **Resolved 2026-08-21 – hold cleared and never validly blocking.** The stated clearing condition ("an image builder is available and `docker build` succeeds against both S01 Dockerfiles") is met: Docker Engine 29.1.3 in the `Ubuntu` WSL2 distro built `api/Dockerfile` and `web/Dockerfile` successfully, twice each with `--no-cache`. No route change was needed – the "install Docker Engine in the Ubuntu WSL2 distro" intent recorded on 2026-08-20 described something already present. This supersedes the deferred block of the same key recorded on 2026-08-20; TI01 remains unchecked because only the reproducibility half of its Verify clause is earned (see the run block below).
Rationale: The hold rested on an environment claim that was false when it was written, so the blocking condition never actually held. Clearing it unblocks TI01's build half only – the publish half stays blocked behind the still-open `registry-and-credentials` and `deploy-target-platform` holds, so this closes no Pending decision in `docs/DECISIONS.md`.
Evidence: **Original evidence was wrong and is corrected here (2026-08-21).** It described only the Windows side – `docker.exe` absent from Program Files, the `docker-desktop` WSL distro Stopped, no `podman`/`nerdctl`/`buildah` on the Windows PATH – and never checked the `Ubuntu` WSL2 distro, where Docker Engine 29.1.3 was running the whole time with the confApp composed stack up (`confapp-db-1` since 2026-08-16, `confapp-web-1` and `confapp-api-1` since 2026-08-17). No image builder was ever missing.

### Run: 2026-08-21 11:15 UTC – observations

#### TI01 REPRODUCIBILITY EVIDENCE (PARTIAL; PUBLISH HALF NOT ATTEMPTED)

**TI01 is NOT complete and its checkbox stays unchecked.** Its Verify clause has two halves; only the first was earned. The second – "the digest the platform reports running matches the digest recorded for that commit" – requires a registry and a running platform, neither of which exists yet (`registry-and-credentials` and `deploy-target-platform` remain deferred).

**Reproducibility: proven.** The same clean checkout at commit `ca09d8f` was built twice per image with `--no-cache`, and application content compared by per-file SHA-256 rather than by image digest – digests differ on metadata alone even when content is identical, which is why TI01's clause is worded around content. Results: `api/Dockerfile` produced **3744 files with identical paths and identical content hashes** across both builds; `web/Dockerfile` produced **10 files identical** across both (the served asset tree plus `default.conf.template`, `40-runtime-config.sh` and `05-resolvers.envsh`). Image IDs differed between builds in both cases, as expected.

**Both Dockerfiles build unmodified**, satisfying the `container-build-toolchain` hold's clearing condition. Neither was edited.

#### NOTICED BUT NOT TOUCHING

- **The legacy builder is in use, not BuildKit.** `docker build` emits "the legacy builder is deprecated"; `buildx` is not installed. Install `docker-buildx` before the publish half of TI01 is attempted, and record which builder produced the digests that get published – a digest produced by the legacy builder is not necessarily reproducible against one produced by BuildKit.
- **The `# syntax=docker/dockerfile:1` directive is inert in both Dockerfiles, and not only because of the legacy builder.** Verified 2026-08-21: in both `api/Dockerfile` and `web/Dockerfile` the directive sits on **line 4**, preceded by three comment lines. A parser directive is only honoured when it precedes all other comments, blank lines and instructions, so once BuildKit is installed the directive will still be read as an ordinary comment unless it is moved to line 1. Installing `buildx` alone will therefore not activate it. Nothing currently depends on it, but any future cache-mount or multi-platform build will. Not moved here – the Dockerfiles are a TI01/TI02 surface and this run was scoped to evidence gathering.
- **The build context grew by S11.** The context sent to the daemon is 18MB, of which roughly 3.7MB is `web/android` (~1.9MB) and `web/ios` (~1.8MB), created by S11 TI01. `web/Dockerfile` does `COPY web web`, so both native trees enter the build stage; they cannot reach the shipped image because the runtime stage copies only `web/dist`, so this is build cost rather than image bloat. The repository `.dockerignore` exists and lists neither path; adding `web/android` and `web/ios` to it would trim the context. Not done here – `.dockerignore` is a TI01/TI02 surface.
- **`confapp-api-1` has been crash-looping since 2026-08-17, and it explains S09's open note.** The container restarts continuously with `WildcardAudienceError: GOOGLE_AUDIENCE_ALLOWLIST entry "<paste client ID>" is a wildcard or pattern`. The repository `.env` still holds S02's literal placeholder. **This is S02's startup guard working exactly as specified**, not a defect – it refuses to boot rather than accept a non-literal entry that would widen the audience allow-list. It also resolves the S09 observation that "the SPA container's proxy returns 502 locally while the API answers 200 on 8080": the proxy is not misconfigured, it has no upstream, and the API answering on 8080 was a separately-run dev process rather than the container. Supplying a real web client ID in `.env` should restore the three `shell.spec.ts` signed-in visual cases S09 recorded as unverifiable. Not fixed here: a real OAuth client ID is owner-supplied configuration and must not be committed.


## Deferred Decisions

#### DEFERRED DECISION: deploy-target-platform

Decision-Key: deploy-target-platform
Altitude: fis-local
Affected surface: Implementation Plan → TI02 and TI04–TI11; Architecture Decision (one parameterized deployment definition); Structural Criteria 2 and 3.
Decision: Deferred as a signed-off execution hold. Intended target for the next execution run: Azure Container Apps, recorded as the *current, intended* target only – `docs/DECISIONS.md` → Pending must continue to list "Container platform" unresolved, and this hold closes neither Pending entry. TI02 must remain one parameterized definition whose target-specific values are supplied as inputs; Bicep or ARM as the sole deployment definition would fail the story. Hold clears when a reachable Container Apps environment exists and every target-specific value is suppliable as configuration.
Rationale: No deployment target is provisioned, so TI02 and TI04–TI11 cannot be observed. The FIS Execution Contract names the target as an owner-supplied exec-time input, not a decision this story closes. Executor trap to carry forward: this FIS's Architecture Decision section explicitly rejects a platform-native descriptor, naming "an ARM/Bicep template" as the alternative that "closes the container-platform decision by implementation and forfeits exactly the portability that ADR-003 and ADR-004 both exist to protect", and Structural Criterion 3 still requires the published digests to start and serve under S01's `docker-compose.yml` unchanged.
Evidence: Verified 2026-08-20 – no provisioned container-platform environment identified for confApp; the FIS Execution Contract lists "a reachable container target" among the owner-supplied exec-time inputs, and `docs/DECISIONS.md` → Pending still carries "Container platform" unresolved.
Signed-off-by: Henrik Almen (owner) – 2026-08-20

#### DEFERRED DECISION: registry-and-credentials

Decision-Key: registry-and-credentials
Altitude: fis-local
Affected surface: Implementation Plan → TI01 (publish step) and TI03 (registry-credential handling).
Decision: Deferred as a signed-off execution hold. Intended registry for the next execution run: Azure Container Registry, consistent with the intended Container Apps target and recorded as an intended target only, closing no Pending decision. Hold clears when a subscription, resource group and registry exist for confApp and credentials reach the deploy step from the environment rather than any tracked file (TI03; `AGENTS.md` – "Never commit `.env` files or credentials").
Rationale: No image registry is provisioned for confApp and no credential path is established, blocking TI01's publish step and TI03's registry-credential handling.
Evidence: Environment state verified 2026-08-20 – the Azure CLI is installed (2.87.0) and an Azure MCP server is configured, but no confApp subscription, resource group or registry has been identified. Separately, the gcloud SDK is authenticated as the owner but its active project is `beleco-europe-mvp-live`, an unrelated live project, and its tokens are expired – nothing in this story may deploy into it.
Signed-off-by: Henrik Almen (owner) – 2026-08-20

#### DEFERRED DECISION: deployed-postgres-host

Decision-Key: deployed-postgres-host
Altitude: fis-local
Affected surface: Implementation Plan → TI07 (dump/restore portability drill), TI10 (container-independent storage) and TI11 (durability drill).
Decision: Deferred as a signed-off execution hold. Intended shape for the next execution run: Azure Database for PostgreSQL – i.e. TI10's managed path, where "the service supplies the guarantee and no volume is declared", rather than the named-volume container path – recorded as an intended target only, closing no Pending decision. Consequence to carry forward: TI11's durability drill then runs as a restart or failover of the managed instance rather than replacing a database container against surviving named-volume storage; the FIS supports both shapes and this fixes which one the next run must evidence. Hold clears when a reachable instance exists and its connection details are suppliable as configuration.
Rationale: No deployed PostgreSQL instance exists, blocking TI07's dump/restore portability drill and TI10/TI11's durability work. TI10's requirement that both hosting shapes stay reachable through the same definition by configuration change alone still binds, so neither Pending decision closes. ADR-003's boundary also still applies: whichever instance backs a live conference runs on attended, backed-up infrastructure, and TI08 must name the backup mechanism, its schedule and its owner.
Evidence: Verified 2026-08-20 – no deployed PostgreSQL instance identified for confApp; `docs/DECISIONS.md` → Pending still carries "Production database hosting" unresolved, and the FIS Execution Contract lists "a PostgreSQL host" among the owner-supplied exec-time inputs.
Signed-off-by: Henrik Almen (owner) – 2026-08-20
