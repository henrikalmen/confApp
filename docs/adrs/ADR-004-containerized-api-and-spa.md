# ADR-004: Package the API and SPA as containers, superseding serverless on Azure

- **Status**: Accepted
- **Date**: 2026-08-16
- **Scope**: Backend runtime and hosting
- **Supersedes**: the "Backend: serverless on Azure – Azure Functions for the API, Azure Static Web Apps for hosting" decision recorded in `docs/DECISIONS.md` → Still Current (2026-08-16)

## Context

The backend was provisionally settled as Azure Functions behind Azure Static Web Apps, chosen for fit with existing Azure tooling and to avoid owning always-on infrastructure. That choice was recorded in `docs/DECISIONS.md` as a Still Current decision rather than an ADR, with a note that it "warrants promotion to a full ADR once the database and auth choices land alongside it". Those choices have since landed (ADR-002, ADR-003), and planning the Conference setup & schedule theme surfaced the costs of the serverless shape concretely.

Three forces pushed against Functions:

- **Cold start is a first-class product problem, not an implementation detail.** The PRD's non-functional requirements had to carve an exception into their own performance target – "p95 < 1s, **excluding serverless cold start**" – and then add a second requirement that no attendee-facing request pays a cold start across the conference date span. Planning that work produced a story whose central mechanism was a timer trigger firing to keep instances warm. That is infrastructure ceremony existing solely to hide a property of the runtime, and it is unfalsifiable in local development, where nothing is ever evicted.
- **The stated goals in ADR-003 point the other way.** ADR-003 records two explicit developer goals: **learning Docker and containers**, and **retaining the freedom to host locally or in a cloud**. Development already runs PostgreSQL under Docker Compose. A serverless API is the one component that cannot join that model.
- **Venue conditions reward portability.** The conference is an offsite event on a fixed date with unreliable wifi. A runtime that can, in principle, be brought up on a machine at the venue is a materially better answer to that risk than one that cannot, even if that path is not exercised in this release.

Against those, the original rationale – avoid owning always-on infrastructure – survives only partly. A container platform still runs the container; what changes is that the platform is replaceable.

## Decision

**The API and the SPA are packaged as container images.** The API is a long-running HTTP server; the SPA is built to static assets and served from a static-file container. PostgreSQL continues to run as a container in development per ADR-003.

**Cloud is the target deployment.** The images are built to run on a container platform, with Azure Container Apps the natural fit given the existing Azure footprint and ADR-003's portability requirement. Nothing in the application depends on that platform's proprietary features.

**Local-server deployment is a retained capability, not a supported path.** The images can be brought up on a single machine with Docker Compose, and that is how development runs. Deploying to a box at the venue for a live conference is explicitly *not* a tested or supported scenario in this release: Google Workspace OIDC (ADR-002) requires internet reachability at sign-in, so a genuinely disconnected venue deployment would not let anyone authenticate. Making it supported would require solving that first and is a separate decision.

**Azure Functions and Azure Static Web Apps are dropped.** No part of the application is written against the Functions programming model.

**Statelessness survives the change, for a different reason.** Handlers must still hold no state between requests. Under Functions the reason was that instances are transient and requests are not sticky; under containers the reason is horizontal scaling across replicas. The rule is unchanged and remains binding – the join-code rate limiter, for instance, still keeps its counter in PostgreSQL rather than in process.

## Consequences

**Positive**
- The cold-start exception disappears from the performance target. A long-running container serves its first request as fast as its thousandth, so the p95 requirement becomes a single unqualified number instead of a target plus a carve-out plus a warming mechanism.
- The "no attendee-facing request pays a cold start" requirement and the pre-warm story that existed to satisfy it are both eliminated rather than implemented.
- Development, local-server, and cloud runtimes become the same artifact. What is tested locally is what deploys.
- Serves ADR-003's stated learning goal, and extends its portability property from the database to the whole system.
- Availability during conference hours becomes an ownable, testable property of a deployment rather than a characteristic of a managed platform.
- The API is written against a plain HTTP framework, which is more portable and more testable than handlers bound to a proprietary invocation model.

**Negative / costs**
- Always-on compute replaces scale-to-zero. For a system idle most of the year this is a real if small cost, and it is the main thing given up.
- Container images, a registry, and deployment configuration are now owned artifacts requiring maintenance and patching.
- Azure Static Web Apps' integrated managed API and built-in auth are forgone; both were conveniences the design was not relying on.
- The production database hosting decision (ADR-003, still Pending) is unchanged but now sits alongside a container-platform choice, so two hosting questions must close before the first real conference rather than one.
- The PRD's non-functional requirements table is now partly stale: the cold-start exception and the pre-warm row describe a runtime that no longer exists.

## Alternatives considered

- **Keep Azure Functions** – rejected. Viable, and the pre-warm mechanism does work (a timer trigger, since the warmup trigger is unavailable on the Consumption plan). But it keeps a performance requirement that exists only to describe the runtime's weakness, and keeps a class of behaviour that cannot be exercised in development.
- **Containers for local development only, Functions in production** – rejected. Two runtime shapes for one API means the thing under test is not the thing deployed, which is the specific failure this decision is trying to avoid. It also doubles the surface to maintain for no benefit the single-artifact model does not already provide.
- **Containers with venue-local deployment as a supported path** – deferred, not rejected. It is the strongest available answer to unreliable venue wifi, but Google Workspace OIDC needs internet reachability at sign-in, so it cannot be made to work without resolving authentication for a disconnected venue. Revisit if the first real conference shows the network is the binding constraint.
- **A managed platform-as-a-service without containers (App Service code deploy)** – rejected. Gives up the artifact portability that motivates the change while retaining most of the operational surface.
