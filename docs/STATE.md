# Project State

Last Updated: 2026-08-20 15:02

## Current Phase
<!-- Active phase/milestone name and one-line status -->

Phase: P3 Hardening – started, no story completed. S11 partially executed (TI01 only); S13 deferred; S12 unreachable.
Status: Blocked

## Active Stories
<!-- When a plan.json governs (has undone stories), Active Stories derive from it on read – store rows only for ad-hoc work in no governing plan.
     Otherwise one row per in-progress story (Owner = who is executing it); move completed stories to Recently Completed. -->

| Story | Owner | Status | FIS | Notes |
|-------|-------|--------|-----|-------|
| _none_ | | | | |

## Recently Completed
<!-- Last 2 milestones only, one line each. Older milestones belong in CHANGELOG.md.
     If more exist, add a trailing line: "Previous: 0.3, 0.2, 0.1" -->

- **Init** (2026-08-16): AndThen workflow structure scaffolded – agent instruction files, core orientation docs, planning docs, GitHub issue-tracker config.
- **Product clarification** (2026-08-16): product-mode clarify run – `docs/PRODUCT.md` written from four rounds of Discovery & Ideation.

## Blockers
<!-- Anything preventing progress. Remove resolved blockers and those older than ~14 days with no activity. -->

- **S13 deferred on four signed execution holds** (2026-08-20, preflight verdict DEFERRED, `plan.json` status `blocked`). No container image builder on the machine (Docker absent; intended route: Docker Engine in the existing Ubuntu WSL2 distro); no provisioned deploy target (intended: Azure Container Apps); no registry (intended: Azure Container Registry); no deployed PostgreSQL (intended: Azure Database for PostgreSQL, TI10's managed path). All four are recorded as *intended targets for the next run only* – neither `docs/DECISIONS.md` → Pending entry is closed. Full detail in the FIS's `## Deferred Decisions` section.
- **S12 unreachable until S13 lands** – it `dependsOn` S13 and its p95 and 100-concurrent thresholds are unfalsifiable without a deployed environment to measure against.
- **S11 blocked on hardware, not on code** – TI02–TI11 need a physical Android device, and every iOS criterion needs macOS + Xcode + a registered device. TI04 additionally needs two Google OAuth clients registered in Google Cloud Console and a running API. A simulator does not satisfy a criterion that names a device (S11 Testing Strategy).
- **No local container runtime** – Docker is absent from the dev machine (`docker.exe` gone, `docker-desktop` WSL distro stopped, no podman/nerdctl/buildah). This blocks S13 outright and also prevents running the composed stack locally.
- **Production database hosting** – deferred to phase 2 (ADR-003). Not blocking development.
- **Push service not confirmed** – Azure Notification Hubs recommended, fronting APNs + FCM.

## Recent Decisions
<!-- Key decisions made in the last 1-2 sessions. Keep max ~10. Move older items to ADRs. -->

- P3 Hardening **started and immediately contained** – superseding the S10 entry below, which correctly recorded P3 as not started at the time it was written. An exec-plan run scoped to S11 + S13 completed with **zero stories done**, by design. Preflight on S13 returned DEFERRED: all four of its blocking decisions were missing exec-time inputs rather than design questions – no container image builder on the machine, no provisioned deploy target, no registry, no deployed PostgreSQL – and the owner signed off deferring rather than provisioning mid-run. S13 is now `blocked` with four signed `#### DEFERRED DECISION:` blocks naming Docker-in-WSL2, Azure Container Apps, Azure Container Registry and Azure Database for PostgreSQL as *intended targets for the next run only*; neither `docs/DECISIONS.md` → Pending entry is closed, and the ADR sweep deliberately authored nothing because S13's FIS is engineered to execute without closing them (OC02). S11 ran as an approved partial – **TI01 only**, fully verified, staying `spec-ready` at 1 of 31 checkboxes; TI05 was deliberately not authored because Swift/Kotlin cannot be compiled on this machine, and TI11's web half was skipped as already covered by S09/S10. Gates green: typecheck, lint, build, 815/815 tests across 50 files (2026-08-20).
- S10 (Offline schedule access) done → **P2 Feature slices complete** (S03–S10). Closed on orchestrator verification re-run independently of the worker's self-report: 805/805 tests across 50 files (baseline 740/46), typecheck + lint + build clean, the new offline tests confirmed genuinely executing via `--reporter=verbose`, `visual/offline-schedule.spec.ts` 9/9 at 375/768/1280 against the Vite dev server, and every Structural Criterion spot-checked in source – exactly one `diffSchedule` (S09's, consumed not duplicated), no outbox/queue/replay path anywhere, the anchor pair persisted rather than the derived offset, staleness as elapsed age with zero date-conversion calls in `web/src/offline/`, the reconnect cursor reading `conference.lastUpdatedAt`, cache keyed on (`sub`, conferenceId) with no email in the offline layer, and the service worker precaching only `['/', '/index.html', '/config.js']` plus fingerprinted assets with `/api/` bypassed. This exec-plan run was deliberately scoped to S10 and stops here – P3 is **not** started (2026-08-20).
- S03 (Conference lifecycle) reconciled to **done** – its code shipped in `d54cbf9` and S04–S09 all built on it, but `plan.json` still read `spec-ready` and all 29 FIS checkboxes were unchecked. Status and checkboxes were corrected against the shipped evidence (740/740 suite green; 34 integration tests against real PostgreSQL, all 10 Structural Criteria covered, TI11/TI12 covered by `ConferencesPanel.test.tsx` and 9 visual specs at 375/768/1280). Nothing was re-implemented – this was bookkeeping catching up with the code (2026-08-20).
- S09 closed on a raised evidence standard: a Structural Criterion is earned by a **behavioural** assertion, not by a source grep alone. The grep for "no timezone conversion in the refresh path" listed four files and omitted `schedule-view-model.ts` – the module that formats every Session time an Attendee reads – so a `toLocaleTimeString` there passed it untouched. The two-timezone render test now proves the property; the grep is kept as the cheap guard and its file list corrected (2026-08-19).
- S05: joinability reason-naming (`joinRefusalReason` / `assertJoinable`) added to S03's `api/src/conferences/lifecycle.ts` in place rather than as a second mapping in S05 – keeps exactly one definition of joinability, as the FIS Constraints section directs. `isJoinable` now delegates to it, and S03's pre-existing lifecycle tests still pass unmodified, so the refactor is regression-guarded on behavioural equivalence (2026-08-17).
- Plan created: Conference setup & schedule (13 stories, 3 phases, all spec-ready) (2026-08-16).
- FR7 split: post-publish schedule editing planned; push notification deferred pending REQ-005 and the push delivery service decision – in-app propagation is the primary channel (2026-08-16).
- Foundation (scaffold, sign-in, Capacitor shells) planned inside the Conference setup & schedule bundle rather than a separate Phase 2 plan (2026-08-16).
- React SPA targeting browser + Android + iOS, responsive across viewports (2026-08-16).
- Backend: API and SPA ship as container images, cloud-deployed; ADR-004 accepted, superseding serverless on Azure (2026-08-16). Removed the PRD's cold-start carve-out and pre-warm requirement outright.

<!-- Trimmed to the last 10 per the Recent Decisions maintenance rule; the trimmed entries are recorded in ADR-001 (Capacitor mobile packaging), ADR-002 (Google Workspace OIDC), ADR-003 (PostgreSQL), `AGENTS.md` (offline scope, agent-instruction layout, issue tracker, post-its named / votes anonymous) and `docs/PRODUCT.md` (MVP slice, product clarification, internal-app scope / store presence / iOS push). -->
