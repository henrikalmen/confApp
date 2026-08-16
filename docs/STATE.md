# Project State

Last Updated: 2026-08-16 13:30

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
- **No git remote / no commits** – GitHub issue workflows are configured but inert until a remote exists.

## Recent Decisions
<!-- Key decisions made in the last 1-2 sessions. Keep max ~10. Move older items to ADRs. -->

- Plan created: Conference setup & schedule (13 stories, 3 phases, all spec-ready) (2026-08-16).
- FR7 split: post-publish schedule editing planned; push notification deferred pending REQ-005 and the push delivery service decision – in-app propagation is the primary channel (2026-08-16).
- Foundation (scaffold, sign-in, Capacitor shells) planned inside the Conference setup & schedule bundle rather than a separate Phase 2 plan (2026-08-16).
- React SPA targeting browser + Android + iOS, responsive across viewports (2026-08-16).
- Backend: API and SPA ship as container images, cloud-deployed; ADR-004 accepted, superseding serverless on Azure (2026-08-16). Removed the PRD's cold-start carve-out and pre-warm requirement outright.
- Mobile packaging: Capacitor – ADR-001 accepted (2026-08-16).
- Scope: internal company app; store presence and iOS push required; no hardware access beyond the basics (2026-08-16).
- Product clarified: internal conference app – schedule, presentations and workshops, post-its, voting, leadership report (2026-08-16).
- Post-its named, votes anonymous – the product's load-bearing rule (2026-08-16).
- Offline position reversed: partial offline now required (schedule reads, post-it queueing) (2026-08-16).
- MVP is a thin end-to-end slice covering the whole conference loop (2026-08-16).
- Auth: Google Workspace OIDC, not Entra – the company runs on Google and Entra coverage is incomplete. ADR-002 accepted (2026-08-16).
- Roles live in confApp scoped per conference, not in directory groups (2026-08-16).
- Database: PostgreSQL, Docker Compose for development; production hosting is a phase-2 call. ADR-003 accepted (2026-08-16).
- GitHub selected as the agent issue-tracker backend (2026-08-16).
- `AGENTS.md` + thin `CLAUDE.md` import chosen for cross-agent portability (2026-08-16).
