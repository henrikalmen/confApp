# ADR-003: PostgreSQL as the database, containerized for development

- **Status**: Accepted
- **Date**: 2026-08-16
- **Scope**: Data persistence

## Context

confApp needs a datastore. The domain is small and relational – conferences, days, sessions, activities, groups, post-its, votes, categories, reports – for a company of under 100 people. The backend is serverless on Azure (Functions), and the client stack is Node/TypeScript and React.

Two properties of the workload shape the decision:

- **Usage is spiky and rare.** A conference runs 1–4 days, roughly once a year. Setup precedes it and report reading follows it, both light. The system is otherwise idle.
- **Data must outlive the event.** Past conferences and their reports form an archive that leadership reads after the fact. Storage is therefore continuous even when compute is not.

The developer additionally has two explicit goals: **learning Docker and containers**, and **retaining the freedom to host locally or in a cloud** rather than being bound to one managed service. Phase 1 runs on a laptop or local server; phase 2 targets Azure.

## Decision

**PostgreSQL** is the database engine.

**Development runs PostgreSQL in a container** via Docker Compose, locally. This is the primary development setup, not a fallback.

**Production hosting is deferred to phase 2.** Choosing plain PostgreSQL keeps every option open at that point – managed Azure Database for PostgreSQL Flexible Server, a container on Azure Container Apps or a VM, or a scale-to-zero provider such as Neon. Migration between them is a `pg_dump` and a restore; no application code changes.

**One boundary is set in advance**: the production database backing a live conference will not run on a laptop or on unattended office hardware. The event is fixed-date with no option to reschedule, the data must survive, and backups must be someone's explicit responsibility. This constrains phase 2 without deciding it.

## Consequences

**Positive**
- Zero infrastructure cost during development.
- Serves the developer's stated learning goal directly.
- PostgreSQL is a first-class citizen in the Node/TypeScript ecosystem – `pg`, Prisma, and Drizzle all treat it as their primary target.
- `JSONB` suits the semi-structured parts of the domain (post-it and vote payloads) alongside the relational spine.
- No managed-service lock-in. The engine is portable across local, Azure, and other clouds.
- Local development needs no cloud connectivity and no shared environment.

**Negative / costs**
- Self-managed PostgreSQL means owning backups, patching, and restore correctness – acceptable in development, a real responsibility if carried into production.
- The phase-2 hosting decision remains open and must be closed before the first real conference.
- Azure SQL Database's serverless auto-pause is forgone. Verified: Azure Database for PostgreSQL Flexible Server supports manual stop/start but has **no auto-pause or scale-to-zero**, and a stopped server auto-restarts after seven days. At roughly $150/year for a burstable managed instance, this was judged not worth optimizing around.

## Alternatives considered

- **Azure SQL Database (serverless tier)** – rejected. Its auto-pause genuinely suits a once-a-year workload, but the saving is around $150/year while the cost is ecosystem friction: a secondary citizen in Node/TypeScript tooling, a clumsier local development story, and Azure lock-in that conflicts with the stated flexibility goal.
- **Cosmos DB (serverless)** – rejected. Consumption billing scales to zero, but the document model makes the reporting queries – the product's entire point – harder than they need to be for a domain this relational.
- **Neon (serverless PostgreSQL via Azure Marketplace)** – not rejected; deferred. True auto-suspend with no operational ritual, the best technical match for the idle profile. Remains a live candidate for phase 2, at the cost of a third-party vendor.
- **Self-hosted on company on-premises hardware** – rejected for production. Would place the database across a network boundary from the Azure API, requiring a VPN gateway that costs more than managed PostgreSQL. More seriously, an offsite conference would then depend on the office uplink and hardware, concentrating risk on a date that cannot move. Still available if a data-residency requirement ever emerges, but it would require moving the API on-premises too.
- **Spinning the database up only around each conference** – rejected. Separates compute from storage incorrectly: the archive requirement means storage is billed continuously regardless, so only compute could be saved. Managed stop/start already offers that. More decisively, infrastructure that is rebuilt once a year is never in a known-good state when it is needed, and the moment of need is a fixed date with a room full of people.
