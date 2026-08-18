# Project State

Last Updated: 2026-08-18 09:23

## Current Phase
<!-- Active phase/milestone name and one-line status -->

Phase: Phase 1: Foundation
Status: On Track

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

- **Production database hosting** – deferred to phase 2 (ADR-003). Not blocking development.
- **Push service not confirmed** – Azure Notification Hubs recommended, fronting APNs + FCM.

## Recent Decisions
<!-- Key decisions made in the last 1-2 sessions. Keep max ~10. Move older items to ADRs. -->

- S05: joinability reason-naming (`joinRefusalReason` / `assertJoinable`) added to S03's `api/src/conferences/lifecycle.ts` in place rather than as a second mapping in S05 – keeps exactly one definition of joinability, as the FIS Constraints section directs. `isJoinable` now delegates to it, and S03's pre-existing lifecycle tests still pass unmodified, so the refactor is regression-guarded on behavioural equivalence (2026-08-17).
- Plan created: Conference setup & schedule (13 stories, 3 phases, all spec-ready) (2026-08-16).
- FR7 split: post-publish schedule editing planned; push notification deferred pending REQ-005 and the push delivery service decision – in-app propagation is the primary channel (2026-08-16).
- Foundation (scaffold, sign-in, Capacitor shells) planned inside the Conference setup & schedule bundle rather than a separate Phase 2 plan (2026-08-16).
- React SPA targeting browser + Android + iOS, responsive across viewports (2026-08-16).
- Backend: API and SPA ship as container images, cloud-deployed; ADR-004 accepted, superseding serverless on Azure (2026-08-16). Removed the PRD's cold-start carve-out and pre-warm requirement outright.
- Mobile packaging: Capacitor – ADR-001 accepted (2026-08-16).
- Scope: internal company app; store presence and iOS push required; no hardware access beyond the basics (2026-08-16).
- Product clarified: internal conference app – schedule, presentations and workshops, post-its, voting, leadership report (2026-08-16).
- Post-its named, votes anonymous – the product's load-bearing rule (2026-08-16).

<!-- Trimmed to the last 10 per the Recent Decisions maintenance rule; the trimmed entries are recorded in ADR-002 (Google Workspace OIDC), ADR-003 (PostgreSQL), `AGENTS.md` (offline scope, agent-instruction layout, issue tracker) and `docs/PRODUCT.md` (MVP slice). -->
