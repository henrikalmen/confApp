# S12 – Performance Validation

**Plan**: docs/specs/conference-setup-and-schedule/plan.json
**Story-ID**: S12

## Feature Overview and Goal

**Intent**: The PRD states two numbers for the attendee Schedule and nothing in the repository can produce either, so "fast enough" is an opinion, the venue is the wrong place to discover it is wrong, and any index or payload change added now would be a guess dressed up as engineering – and now that S13 puts a real deployed environment on the table, the verdict can be falsifiable instead of a local run where nothing is ever contended.

**Expected Outcomes**:

- [OC01] One documented command produces the PRD's schedule render number as a pass/fail verdict against the p95 < 1s threshold, with nothing hand-timed and no number recorded without the environment it was taken on.
- [OC02] The session-boundary case – 100 concurrent attendees – is measured as the same quantity as the single-user case, meets the same p95, and refuses, throttles or drops no request.
- [OC03] The recorded verdict is taken against the deployed environment S13 produces, so a pass is evidence about what attendees will experience rather than about a developer's laptop; a local run is labelled as the convenience it is and can never be mistaken for the verdict.
- [OC04] Every change made in the name of performance – index, query, payload, transport, configuration – carries a recorded before/after from that harness, so the repository states what the schedule path costs and why each optimization exists instead of leaving the next person to re-guess.


## Required Context

- `docs/specs/conference-setup-and-schedule/prd.md#non-functional-requirements` – the two rows this story is measured against: Performance – "Schedule view renders on a phone over venue wifi | p95 < 1s"; Capacity – "Concurrent attendees during a session boundary | 100 concurrent, still meeting the p95 < 1s render target". **The table is stale**: the first row still carries an "excluding serverless cold start" carve-out and a second Performance row still asks that "API is warm during conference hours". ADR-004 eliminated both requirements – see *What We're NOT Doing*. `NOTICED:` correcting those two PRD rows is owner-owned drift cleanup outside this story; flag it, do not silently edit the PRD. Also **Binding Constraints (NFR)**: Security – `hd` claim verified server-side on **every** request (ADR-002), which includes every request the harness issues; Portability – "Plain PostgreSQL only, no provider-specific extensions (ADR-003)", which rules out provider-specific performance features and `CREATE EXTENSION` in any diagnostic tooling.
- `docs/specs/conference-setup-and-schedule/prd.md#non-functional-requirements` – **Binding Constraint (NFR)**: "Usability | Responsive across targets | Verified at 375px / 768px / 1280px per `AGENTS.md`". Binds twice: the measured client is a 375px phone-class viewport, because that is what the render target is stated for, and no optimization may cost the layout its behaviour at the other two widths.
- `docs/specs/conference-setup-and-schedule/prd.md#executive-summary` – the success metric "Schedule view renders in under 1 second at p95 on venue wifi" and the venue reality behind it (offsite venue, unreliable wifi). This is why the measurement is taken through a throttled client rather than as a server-side latency figure – a fast handler behind a slow link still fails the metric as written.
- `docs/adrs/ADR-004-containerized-api-and-spa.md#consequences` – the load-bearing change for this story: the API is a long-running container that "serves its first request as fast as its thousandth", so "the p95 requirement becomes a single unqualified number instead of a target plus a carve-out plus a warming mechanism", and the pre-warm story that existed to satisfy the cold-start row is "eliminated rather than implemented". Read this before writing anything that classifies, excludes, or warms.
- `docs/specs/conference-setup-and-schedule/plan.json#stories` – story **S13** (Container build and deployment, wave W9) produces the deployed environment this story measures against: reproducible images, a registry, a reachable PostgreSQL, health/readiness per service, and the availability posture. S12 `dependsOn` S13. S13 also owns the "No planned downtime across the conference date span" NFR row – **not this story**.
- `docs/specs/conference-setup-and-schedule/prd.md#constraints` – **Binding Constraint (FR4)**: "Session times are **naive wall-clock values** – stored and displayed without timezone conversion. A session at 09:00 reads as 09:00 on every device regardless of its timezone setting." Any serialization, compression or payload change made here crosses that boundary and must leave it intact.
- `docs/specs/conference-setup-and-schedule/prd.md#fr8-offline-schedule-access` – **Binding Constraint (FR8)**: "Offline scope is read-only […] Cached data is cleared on sign-out and when a different user signs in on the same device." Binds the harness: S10 primes and refreshes that cache on every read, so a sample taken with a populated cache measures local storage, not the product's first look. Every render sample starts from a cleared cache, and nothing here widens the offline surface.
- `docs/specs/conference-setup-and-schedule/prd.md#fr5-per-conference-role-assignment` – **Binding Constraint (FR5)**: the three roles, Presenter/Facilitator being one role not two, and "Assignment is keyed on the user's stable `sub` claim, not email." Binds the benchmark fixture: its 100 attendees are 100 distinct `sub` values with real Memberships, because the measured read resolves membership per caller.
- `docs/specs/conference-setup-and-schedule/prd.md#fr3-conference-access-via-join-code` – **Binding Constraint (FR3)**: the failed-attempt limiter "is keyed on the authenticated `sub`, never on client IP: the venue presents ~100 employees behind one NAT egress address at exactly the moment of peak joining […] The counter is server-side state, not in-process." This story implements no join-code path, but that same venue topology is the load model: the concurrency driver represents 100 distinct authenticated identities arriving from one egress address, not 100 repeats of one caller.
- `docs/specs/conference-setup-and-schedule/s06-attendee-schedule-view.md#technical-overview` – the artefact under measurement: the schedule envelope (every Conference Day of the span, each with its ordered Sessions and per-read `concurrentWith` marks), the single-query rule, and the `render(envelope, effectiveWallClockNow)` contract. Payload size scales with the whole Conference, not one day; that, and the per-read pairwise overlap computation, are the two candidate hotspots – candidates, not conclusions.
- `docs/specs/conference-setup-and-schedule/s06-attendee-schedule-view.md#structural-criteria` – the envelope guarantees S09 and S10 consume and this story must not quietly break: one self-contained envelope, one query per schedule request, `serverNow` carrying both an instant and a naive wall clock, `lastUpdatedAt` carried at full precision.
- `AGENTS.md#do-not--never` – two prohibitions shape the solution space: "Never rely on in-process state between requests" (so no response or query cache inside the API process – the only permitted module-scoped survivor is a reusable resource such as the connection pool; under ADR-004 the reason is horizontal replicas rather than transient instances, and the rule is unchanged) and "Never tie the schema to a managed provider's proprietary features".
- `docs/guidelines/CRITICAL-RULES-AND-GUARDRAILS.md#working-style` – "Stay lean. Solve the actual problem; no speculative features, abstractions, or over-engineering." Index-guessing before a measurement is precisely the failure mode this story is exposed to, and is why the harness is built first.
- `docs/guidelines/CRITICAL-RULES-AND-GUARDRAILS.md#honesty-and-verification` – "Verify before claiming done… 'works' is false if anything was skipped". A harness that cannot fail, or one whose only passing run was local, is the version of that failure specific to this story.


## Deeper Context

- `docs/specs/conference-setup-and-schedule/s09-live-schedule-editing.md#technical-overview` – the watermark poll loop every attendee client runs (one tiny read per client per interval, at most one in flight, paused while hidden). It is part of the steady-state load at a session boundary and belongs in the concurrency model; its own Constraints section already names 100 concurrent Attendees polling as the capacity case.
- `docs/specs/conference-setup-and-schedule/s10-offline-schedule-access.md#technical-overview` – what a repeat visit actually costs: the cache is primed at join and written through on every online read, so a returning Attendee renders from IndexedDB. This story measures the uncached first look, which is the honest worst case and the one the NFR describes. S10's Structural Criteria also require the cached times to survive the round trip as the same strings the API returned – which is why a payload change here is not a local decision.
- `docs/specs/conference-setup-and-schedule/s04-schedule-composition.md#structural-criteria` – the wall-clock and `lastUpdatedAt` guarantees any payload or serialization change must survive, and the reversible plain-PostgreSQL migration convention any index added here follows.
- `docs/specs/conference-setup-and-schedule/s01-tracer-bullet-skeleton.md#constraints--gotchas` – the pooled `pg` data-access module, the "no in-process request state" rule stated at source, the `/api` prefix trap, the environment-driven configuration rule, and the error envelope. `docs/KEY_DEVELOPMENT_COMMANDS.md` and its scripted three-width screenshot command are S01 TI14's output; this story adds rows to that file rather than starting a second command reference.
- `docs/specs/conference-setup-and-schedule/plan.json#riskSummary` – the S12 entry states the shape of this FIS: "Targets are meaningless without a repeatable measurement, and a local-only harness cannot fail them. Build the harness first, record a baseline against S13's deployed environment, and let measurements drive any indexing work rather than optimizing speculatively."
- `docs/adrs/ADR-003-postgresql-containerized-development.md#decision` – portability is the reason for PostgreSQL and the reason production hosting is deliberately open; nothing added here may assume a particular managed host.
- `docs/DECISIONS.md#pending` – **two** open decisions bound this story: "Production database hosting" and "Container platform". The harness measures against a configured target and closes neither.
- `docs/ARCHITECTURE.md#key-constraints` – "Containerized backend (ADR-004) – one artifact runs in development, on a local server, and in the cloud. […] Cold-start tolerance is no longer a design constraint."


## Acceptance Scenarios

- [ ] **S01 [OC01,OC03] [TI01,TI02,TI03] A single attendee opening the Schedule on a throttled phone-class client meets the p95 against the deployed environment**
  - **Given** the benchmark Conference is seeded – 4 Conference Days, parallel tracks, 100 Memberships – into the environment under test, configured as S13's deployed environment
  - **When** the documented benchmark command runs the attendee first-look render repeatedly, each sample starting from a signed-in client with an empty schedule cache, on a 375px phone-class viewport with the pinned venue-wifi network profile and CPU throttling applied
  - **Then** the run reports the p95 time from view-open to the Schedule's Session list painted for the default Conference Day, that p95 is under 1 second as a single unqualified number with no sample class excluded, and the report names the sample count, the target environment and the network/CPU profile alongside it

- [ ] **S02 [OC02,OC03] [TI01,TI04] One hundred attendees arriving at a session boundary still meet the same p95**
  - **Given** the same seeded Conference on the same target environment with 100 distinct authenticated attendee identities, each also running the S09 watermark poll at its normal cadence
  - **When** all 100 request the Schedule within a short session-boundary window from one egress address
  - **Then** the run reports the p95 across those requests as under 1 second, reports it as the same measured quantity as S01 rather than a server-only timing, and records no request refused, throttled or dropped

- [ ] **S03 [OC03] [TI02,TI05] A local convenience run can never be recorded as the verdict**
  - **Given** both the local composed stack and S13's deployed environment are reachable as configured targets
  - **When** the same command is run against each
  - **Then** each result carries the identity of the environment that produced it – target, deployed image build, database and dataset dimensions – the deployed run is the entry recorded as the verdict against the NFR, and the local result is recorded as a local run and is never presented as a production or verdict figure

- [ ] **S04 [OC04] [TI06,TI07,TI08] Every performance change in the tree carries the measurement that justified it, and unjustified ones are absent**
  - **Given** the baseline from S01 and S02 has been recorded before any optimization
  - **When** the committed result of this story is inspected – its indexes, query changes, payload and transport changes
  - **Then** each one has a recorded before/after p95 from the harness naming what it bought, and where a measurement showed no change was needed the record says so with the number that justified leaving it alone – so no index exists that no measurement asked for
  - **And** every index that does exist is plain PostgreSQL DDL in a reversible migration, with no `CREATE EXTENSION` anywhere in the tree

- [ ] **S05 [OC01,OC02] [TI03,TI04] The harness fails a breach instead of reporting one**
  - **Given** the schedule read path is deliberately degraded – for example an injected delay on the server response
  - **When** the documented benchmark command and the concurrency command each run
  - **Then** both report the breached p95 and exit non-zero, naming which threshold was missed and by how much
  - **And** with the degradation removed both exit zero again, so the gate is demonstrated to have teeth rather than assumed to

- [ ] **S06 [OC01] [TI03] A sample served from the S10 cache is caught, not reported as a fast render**
  - **Given** S10 primes the schedule cache at join and writes through on every online read, so a second view-open would render from IndexedDB with no network call
  - **When** a run is made in which the cache is not cleared between samples
  - **Then** the harness detects that a sample rendered without issuing a schedule request and fails the run, rather than reporting the flattered p95 that no first-time attendee experiences

- [ ] **S07 [OC01] [TI02] A run with no target environment configured refuses rather than quietly measuring localhost**
  - **Given** no environment target is supplied to the harness
  - **When** the benchmark command runs
  - **Then** it exits non-zero naming the missing configuration, produces no p95, and writes no entry to the measurement record – it never falls back to a default host, so no number can enter the record without the environment that produced it


## Structural Criteria

- [ ] Any index added is plain PostgreSQL DDL in a reversible migration following S04's convention; no `CREATE EXTENSION`, no provider-specific type, function, index method or storage parameter appears in migrations, queries or diagnostic tooling (ADR-003).
- [ ] No response cache, query cache, precomputed result or counter survives a request inside the API process; the only module-scoped survivors are reusable resources (the S01 connection pool). The API scales horizontally across replicas (ADR-004), so a memoized result is a defect even when it makes the number look better.
- [ ] No field is added to S06's schedule envelope or to any API response by this story – no diagnostic, timing, instance or build value. S10 caches the envelope and asserts its strings survive the round trip unchanged, so a new field perturbs a contract two stories already depend on.
- [ ] S06's envelope contract suite and S04's wall-clock / `lastUpdatedAt` contract suite both still pass unchanged; no envelope field is removed, renamed or restructured here – if a measurement calls for one, that is a change to the shared read-model decision and lands with its S06, S09 and S10 consumers, or it does not land.
- [ ] No Session `day`, `startTime` or `endTime` value acquires a `Date` round trip, a timezone conversion, or a numeric encoding on any path this story touches (S04 contract, FR4 Binding Constraint).
- [ ] The harness names no container platform and no production database host in code or committed configuration – both are supplied as environment configuration for the target under test, so neither still-Pending decision is closed by this story (`docs/DECISIONS.md#pending`).
- [ ] Every harness run emits its result together with the environment it was taken on – target identity, deployed image build, database, dataset dimensions, client network and CPU profile, and sample count – so no number in the record stands without them, and every entry states whether it is the deployed verdict or a local run.
- [ ] Both harness commands exit non-zero on a threshold breach and are documented in `docs/KEY_DEVELOPMENT_COMMANDS.md`, which is left with no `TODO` introduced by this story.
- [ ] Every request the harness issues is an ordinary authenticated request carrying a bearer token and subject to server-side `hd` verification; no anonymous, unauthenticated or benchmark-only bypass route is added (ADR-002).
- [ ] The attendee Schedule remains legible with no horizontal body scroll at 375px, 768px and 1280px after any change made here.


## Scope & Boundaries

### Work Areas

- Benchmark fixture: a seeded worst-case-realistic Conference – full 4-day span, parallel tracks, 100 Memberships on distinct `sub` values – seeded through the real S03/S04/S05 write paths into the environment under test on demand.
- Environment targeting and run metadata: the configured target (S13's deployed environment for the verdict, the local composed stack as a convenience), and the metadata block emitted with every result.
- Client render harness: throttled phone-class browser run of the attendee first look, percentile computation over a minimum sample count, threshold gate with a non-zero exit.
- Concurrency driver: 100 distinct attendee identities arriving at a session boundary from one egress address, with the S09 watermark poll running underneath.
- Schedule read path on the server: query plans against the fixture, any measurement-justified index migration, and any measurement-justified response transport or payload change.
- Measurement record and commands: baseline, before/after entries and environment metadata committed, and the two commands added to `docs/KEY_DEVELOPMENT_COMMANDS.md`.

### What We're NOT Doing

- **Cold-start measurement, cold/warm sample classification, and any pre-warm mechanism** -- **not deferred: ADR-004 removed the requirement.** The API is a long-running container that serves its first request as fast as its thousandth, so there is no cold-start class of sample to exclude, no warmup trigger or timer keep-alive to build, and no instance-warmth diagnostic on the response. The PRD's "excluding serverless cold start" carve-out and its separate "API is warm during conference hours" row describe a runtime that no longer exists, and the p95 here is a single unqualified number. Anyone reading this should not conclude a requirement was quietly dropped – it was designed away (`docs/adrs/ADR-004-containerized-api-and-spa.md#consequences`, `docs/DECISIONS.md#superseded`).
- **Availability, deployment and the environment itself** -- **S13** owns the "No planned downtime across the conference date span" NFR row, the image builds, the registry, the deployed PostgreSQL, health and readiness signals, and the documented restart and rollback path. This story consumes that environment and measures against it; it deploys nothing.
- **NFR rows owned elsewhere, and paths that would flatter the number** -- the ~5s change-propagation row is S09's and is satisfied in-app by the watermark poll (taken here as an input to the load model, not a target to tune); S10's cached render and S11's shell startup are not measured, because the number the PRD states is the online first look.
- **Any optimization no measurement asked for** -- no index, denormalization, materialized view, in-process cache, query rewrite or payload trim exists unless a recorded before/after named it (`docs/guidelines/CRITICAL-RULES-AND-GUARDRAILS.md#working-style`). Guessing at indexes is the specific failure mode `plan.json#riskSummary` warns about for this story.
- **Provider-specific performance features** -- read replicas, managed poolers, host-tier caching, platform autoscaling knobs and extension-based instrumentation such as `pg_stat_statements` are all closed off by ADR-003, and both the container platform and production database hosting are still Pending. Query analysis uses `EXPLAIN (ANALYZE, BUFFERS)` and harness timings.


## Architecture Decision

**Approach**: Build one environment-parameterized harness that measures the attendee first look end to end from a throttled phone-class client against a configured target – S13's deployed environment for the verdict, the local composed stack as a convenience – and runs the same measured quantity single-user and at 100 concurrent; only then does any index, query, payload or transport change land, each with a recorded before/after.
**Why this over alternatives**: a server-side latency figure cannot prove "renders on a phone over venue wifi" and would pass while the venue fails; a local-only harness cannot fail either target, because a laptop stack is neither on venue wifi nor under real deployment conditions, which is exactly why S13 exists; and measuring before optimizing is the only order in which the PRD's numbers can be honoured without inventing indexes the data may never need.


## Technical Overview

**The measured quantity.** `t_render` runs from the attendee opening the schedule view to the Session list for the default Conference Day being painted, on a browser page with the pinned venue-wifi network profile and CPU throttling, at a 375px viewport, with the S10 schedule cache cleared before each sample. It is one number spanning link, API, database and render – not a handler timing – because that is what the NFR row describes. The concurrency run measures the same quantity so the two figures are comparable.

**One steady state, no sample classes.** Under ADR-004 the API is a long-running HTTP server in a container. There is no cold instance and no eviction window, so every sample counts toward the p95 and the target is a single unqualified number. Nothing in this story classifies, excludes or warms – and consequently nothing here adds a diagnostic field to a response.

**The environment under test.** The target is configuration – base URL, database connection, credentials and the identity recorded with each result – so neither the container platform nor the production database host is pinned by this story (`docs/DECISIONS.md#pending`). The verdict run is against the environment S13 deploys; a local composed run is a convenience for iterating on the harness and is recorded as such.

**The load model.** A session boundary is ~100 distinct authenticated Attendees requesting the Schedule inside a short window from one venue egress address, on top of the steady-state S09 watermark poll those same clients run. Each identity is a real `sub` with a real Membership, because the read resolves membership per caller.


## Code Patterns & External References

```
# type | path#anchor or url                                                                    | why needed (intent)
adr    | docs/adrs/ADR-004-containerized-api-and-spa.md                                            | Long-running container runtime – why there is no cold start to measure or hide
fis    | docs/specs/conference-setup-and-schedule/s06-attendee-schedule-view.md#technical-overview | The envelope and render contract under measurement – shape, single-query rule, per-read overlap computation
fis    | docs/specs/conference-setup-and-schedule/s09-live-schedule-editing.md#technical-overview  | Watermark poll cadence and per-client rules – the steady-state load underneath the boundary spike
fis    | docs/specs/conference-setup-and-schedule/s01-tracer-bullet-skeleton.md#technical-overview | Pooled pg client, Playwright already adopted for scripted browser capture, runtime-configured API base URL
url    | https://chromedevtools.github.io/devtools-protocol/tot/Network/#method/emulateNetworkConditions | Repeatable venue-wifi profile – latency, up/down throughput, packet loss
url    | https://chromedevtools.github.io/devtools-protocol/tot/Emulation/#method/setCPUThrottlingRate   | Phone-class CPU throttling so a desktop CPU does not flatter the render
url    | https://www.postgresql.org/docs/current/using-explain.html                                | EXPLAIN (ANALYZE, BUFFERS) – the plain-PostgreSQL substitute for extension-based instrumentation
```


## Constraints & Gotchas

- **Critical**: no caching may live inside the API process (`AGENTS.md#do-not--never`) -- Instead: transport-level compression and client-level caching (S10) are the available levers. Under ADR-004 the API is long-lived, which makes a module-scoped memoized result far more tempting than it was before and no less a defect: replicas do not share it and requests are not sticky, so it produces a number the deployment cannot reproduce.
- **Critical**: S06's envelope is a shared decision consumed by S09 and S10 -- Must handle by: treating any field addition, removal or restructuring as a change to that decision landing with all three consumers and their contract suites, or not making it. S10 caches the envelope and asserts the cached strings match what the API returned, so a payload trim that silently breaks the cached render trades one NFR for another.
- **Avoid**: measuring a repeat visit -- S10 primes the cache at join and writes through on every read, so a second load never touches the network and would report a p95 that no first-time attendee experiences. Clear the schedule cache before every sample and assert each sample actually issued a schedule request.
- **Avoid**: quoting a p95 from a handful of samples, or from a run whose environment is not recorded -- Instead: fix a minimum sample count for the run, report it with the number, and refuse to record a result without its environment metadata.
- **Avoid**: reaching for an index because the query "looks like it needs one" -- Instead: capture the plan against the seeded fixture, and add nothing whose before/after the harness cannot show. `concurrentWith` being computed pairwise per read and the envelope carrying the whole Conference are *candidate* hotspots named by S06, not conclusions.
- **Constraint**: the container platform and production database hosting are both still Pending (`docs/DECISIONS.md#pending`) -- Workaround: the harness names neither; the target is supplied as configuration and its identity is recorded with each result, so re-running against a different platform or database host is a configuration change rather than a rewrite.
- **Constraint**: this story depends on S13 and cannot produce its verdict without a deployed environment -- Workaround: the harness runs against the local composed stack while it is being built, and those results are recorded as local runs; the verdict entries are the ones taken against S13's deployment. If S13's environment is unavailable when this story runs, that is a blocker to raise, not a licence to record a local figure as the answer.
- **Assumption** (recorded, PRD does not specify): the benchmark Conference is the realistic worst case for this product – a 4-day span, parallel tracks and roughly a dozen Sessions per day, with 100 Memberships – since the PRD fixes the day span (1–4) and the concurrency (100) but not a Session count. The fixture states its own dimensions so a later change to them is visible in the record.
- **Assumption** (recorded, PRD does not specify): "venue wifi" is pinned as a concrete, versioned network profile in the harness rather than a description, because a p95 is meaningless without one; the chosen figures are part of the recorded environment and can be re-argued from the record.


## Implementation Plan

### Implementation Tasks

- [ ] **TI01** A benchmark Conference of stated worst-case dimensions can be seeded into the environment under test on demand
  - Full 4-day span with parallel tracks and 100 Memberships on distinct `sub` values (FR5 Binding Constraint – never email), built through the existing S03/S04/S05 write paths rather than a parallel schema or direct inserts, so the fixture cannot drift from what the product actually stores. Dimensions are declared in the fixture and echoed in every run's environment metadata. Against a local target this reuses S01's dedicated-test-database convention – never a developer's working database.
  - **Verify**: `Test: seeding twice yields the same declared dimensions; the seeded Conference is readable through the S06 schedule endpoint by each of its attendee identities; teardown leaves no fixture rows`

- [ ] **TI02** The harness runs only against an explicitly configured target and records that target's identity with every result
  - Base URL, database connection and credentials come from configuration – no default host, no platform or database-host name in code or committed configuration (`docs/DECISIONS.md#pending`). The emitted metadata block names the target, the deployed image build, the database, the fixture dimensions, the network and CPU profile, the sample count, and whether the run is the deployed verdict or a local convenience run. Consumed by TI03, TI04 and TI05.
  - **Verify**: `Test (S07, S03): with no target configured the command exits non-zero naming the missing configuration and writes no record entry; run against two different configured targets, the two results carry different target identities and the local one is marked as a local run; no container-platform or database-host name appears in harness code or committed configuration`

- [ ] **TI03** One command measures the attendee first-look render as a p95 and fails the run on a breach
  - Drives a signed-in browser at a 375px phone-class viewport with the pinned venue-wifi network profile and CPU throttling; each sample starts from a cleared schedule cache and must issue a schedule request to count (FR8 Binding Constraint – S10 would otherwise serve it locally); measures view-open to Session-list painted; enforces a minimum sample count; exits non-zero when the p95 is at or above 1s. Emits TI02's environment metadata with the result. Consumes TI01's fixture. No sample class is excluded – there is no cold start under ADR-004.
  - **Verify**: `Test (S01, S05, S06): a run against the unmodified stack reports a p95 with its sample count and exits zero; the same run against a server with an injected delay reports the breach and exits non-zero; a run in which a sample renders without issuing a schedule request fails rather than reporting a cache-served p95`

- [ ] **TI04** One command reproduces a session boundary – 100 distinct attendees, one egress address – and reports the same measured quantity
  - 100 distinct authenticated identities from TI01 request the Schedule inside a short window while the S09 watermark poll runs underneath at its normal cadence (`s09-live-schedule-editing.md#technical-overview`). Same percentile treatment and same non-zero-exit gate as TI03, so the two numbers are comparable rather than two different quantities. No request may be refused, throttled or dropped.
  - **Verify**: `Test (S02, S05): the run issues 100 concurrent schedule reads under 100 distinct sub values plus their watermark polls, reports a p95 with its sample count, exits non-zero when the threshold is breached, and records no refused or dropped request; every request carries a bearer token and is hd-verified, and no anonymous or benchmark-only route was added`

- [ ] **TI05** A baseline for both runs is recorded against S13's deployed environment before any optimization exists
  - Both commands run against the deployed target and their results – p95, sample count, full environment metadata – are committed as the first verdict entries in the measurement record; local runs made while building the harness are recorded separately and are not the baseline. Everything after this point is measured against it. Depends on TI02–TI04; must precede TI06 and TI07.
  - **Verify**: `Test (S03): the record contains a dated baseline entry for each of the two runs, each naming the deployed target and its image build; no index migration, query change or payload change exists in the tree at the commit that records it`

- [ ] **TI06** The schedule read path's database work is understood from plans, and any index that exists was bought by a measurement
  - Capture `EXPLAIN (ANALYZE, BUFFERS)` for the S06 schedule query and the S09 watermark read against TI01's fixture; add an index only where re-running TI03/TI04 shows a change, in a reversible plain-PostgreSQL migration following S04's convention (ADR-003 – no extensions, no provider-specific DDL). If nothing is warranted, the record says so with the numbers that justify it. Depends on TI05's baseline.
  - **Verify**: `Test (S04): every index introduced by this story appears in the record with a before/after p95; the migration applies and rolls back cleanly; the migration directory contains no CREATE EXTENSION and no provider-specific DDL; if no index was added the record carries the plan evidence and the unchanged numbers`

- [ ] **TI07** Any payload or transport change on the measured path was bought by a measurement and leaves the envelope contract intact
  - Transport-level levers (response compression and equivalents) are available; envelope field changes – including additions – are not a local decision, see *Constraints & Gotchas*. S06's envelope suite, S04's wall-clock suite and S10's cache round-trip suite must pass unchanged, and no schedule time may acquire a `Date` round trip or a numeric encoding. If nothing is warranted, the record says so. Depends on TI05's baseline.
  - **Verify**: `Test (S04): S06's envelope contract suite, S04's wall-clock contract suite and S10's cached-strings round-trip assertion all pass; the response carries every envelope field at its documented format and no field this story added; no module-scoped value derived from a request survives it in the API; each change present in the tree has a before/after entry in the record`

- [ ] **TI08** The results, their environment, and the two commands are in the repository where the next person will find them
  - The measurement record holds the baseline, every before/after, and each run's environment metadata; every entry states which target produced it and whether it is a verdict or a local run. Both commands are added to `docs/KEY_DEVELOPMENT_COMMANDS.md` in the existing table structure, leaving no `TODO` behind. Depends on TI05–TI07.
  - **Verify**: `Test (S04): both commands run as written from a clean checkout against a configured target and produce a report matching the recorded shape; every performance change in the tree is traceable to an entry in the record; the commands file gains no TODO; the attendee Schedule on the shipped tree renders with no horizontal body scroll at 375px, 768px and 1280px`

### Testing Strategy

- Threshold gates are proved by breaking them: S05's degraded-stack run is part of the suite, not a manual check. A harness that has never failed has not been shown to be able to.
- The cache-served-sample guard (S06) is exercised by actually letting S10's cache serve a render, not by stubbing the detector – a stub passes while the real run silently measures IndexedDB.
- Percentile assertions are made on the reported statistic together with its sample count; a p95 asserted without a minimum sample count passes on three samples and means nothing.
- Concurrency is driven with distinct identities and real tokens rather than one token replayed, so per-caller work (membership resolution, `hd` verification) is inside the measurement where it is in production.

### Execution Contract

- TI01–TI04 build the harness and must all complete before TI05; TI05's baseline must be recorded against S13's deployed environment before TI06 or TI07 changes anything. This ordering is the story's point – an optimization landed before the baseline cannot be shown to have helped.
- TI08 runs last and records what actually shipped rather than what this spec expected.
- If S13's deployed environment is not available, stop and raise it rather than substituting a local baseline – a local figure recorded as the verdict is the failure mode this story was rescoped to prevent.
- If measurement shows the p95 cannot be met within this story's constraints – plain PostgreSQL, no in-process state, two open hosting decisions – stop and raise it as a decision (`docs/DECISIONS.md`) rather than reaching for a provider feature or a platform tier that would close the container-platform or database-hosting question as a side effect.


## Final Validation Checklist

- [ ] No index, query, payload, transport or configuration change exists in the tree without a matching before/after entry in the measurement record.
- [ ] Every recorded number names the environment it was taken on, and no local run is presented as the verdict.
- [ ] No warm-up trigger, keep-alive timer, cold/warm sample classification, or instance-lifetime diagnostic exists anywhere in the tree – ADR-004 removed the requirement they would serve.


## Implementation Observations

> _Managed by exec-spec post-implementation – append-only._

_No observations recorded yet._
