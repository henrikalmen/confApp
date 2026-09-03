# Reconciliation Ledger

> Durable, greppable record of deliberate spec-vs-code drift. Entries are written by implementation and remediation skills and transitioned by review / remediation. See `reconciliation-ledger.md` for the schema, stable-ID derivation, status lifecycle, and match/recurrence/escalation rules.

## Entries

### docs/specs/facilitator-board-and-categorisation/s02-categories-uncategorised-and-sorting-authority.md:ambiguous-intent:s07-s-never-a-blend-contradicts-the-fis-s-own-retry-design-and-the-prd-s-edge-case-row
- Status: CLOSED
- Class: ambiguous-intent
- Stale targets: –
- Source run: exec-plan-s02-categories-uncategorised-and-sorting-authority-2026-08-30T21:40:00Z-6b3d9e74
- Recurrence: 1
- Falsifier: –
- Override reason: –
- Created: 2026-08-30
- Updated: 2026-08-30
- Notes: Acceptance Scenario S07 and TI11's Verify say a concurrent reorder returns one ordering whole and "never a blend", while the FIS's Constraints & Gotchas describes a retry that recomputes from the winner's state (which yields sequential composition), and `prd.md:670` says only "last write wins for the ordering as a whole". Resolution: closed by owner decision of 2026-08-30 plus verifying evidence. The whole-ordering write makes the losing pass block on row locks and overwrite entire, so no blend is produced and S07/TI11 are correct as written; the reviewer's simulation predated that remediation. Pinned by the gated test "overwrites a concurrent reorder whole, rather than composing the two moves". No artifact reworded.

### docs/specs/facilitator-board-and-categorisation/s02-categories-uncategorised-and-sorting-authority.md:spec-stale:a-discovered-requirement-is-cited-in-the-tests-but-recorded-in-no-spec-artifact
- Status: CLOSED
- Class: spec-stale
- Stale targets: –
- Source run: exec-plan-s02-categories-uncategorised-and-sorting-authority-2026-08-30T21:40:00Z-6b3d9e74
- Recurrence: 1
- Falsifier: –
- Override reason: –
- Created: 2026-08-30
- Updated: 2026-08-30
- Notes: A Discovered Requirement (a Post-it whose Category is absent from the same Board read renders in Uncategorised) was cited in two test files – `api/test/category-structure.test.ts:336` and `api/test/category.integration.test.ts:1164` – but recorded in no spec artifact, with the FIS's observations empty, all checkboxes unticked and `plan.json` at `spec-ready`. Resolution: the requirement is recorded in the FIS's 2026-08-30 18:34 UTC Implementation Observations run, all 33 checkboxes are ticked, and `plan.json` is set to `done` in this same pass.

### api/test/category.integration.test.ts:ambiguous-intent:accepted-and-ignored-is-inferred-not-observed
- Status: OPEN
- Class: ambiguous-intent
- Stale targets: –
- Source run: exec-plan-s02-categories-uncategorised-and-sorting-authority-2026-08-30T21:40:00Z-6b3d9e74
- Recurrence: 1
- Falsifier: –
- Override reason: –
- Created: 2026-08-30
- Updated: 2026-08-30
- Notes: The authority test "refuses a member with no assignment, admits an admin with none, and ignores an actor field" proves the credential decides (Ada refused, Ida admitted) but, as its own comment concedes, `category` has no author column, so nothing observes that `actorSub` was not read – a route that read `userSub` to pick, say, the Session would pass both halves. Recorded remedy from the review: send a Session-shaped field naming a *different* Session and assert the Category lands on the credential's Session. Left OPEN deliberately: shipped behaviour is correct and this is a test-strength gap, so it is surfaced for an owner rather than closed by the agent that would benefit from closing it.

### docs/specs/facilitator-board-and-categorisation/s02-categories-uncategorised-and-sorting-authority.md:code-defect:g03-aria-label-overrides-position-announcement
- Status: CLOSED
- Class: code-defect
- Stale targets: –
- Source run: review-gap-facilitator-board-and-categorisation-rereview-2026-09-02T06:23:51Z-f87a750e
- Recurrence: 1
- Falsifier: –
- Override reason: –
- Created: 2026-09-02
- Updated: 2026-09-02
- Notes: G03 (source: `facilitator-board-and-categorisation-gap-review-claude-2026-09-02-rereview.md`). Adding `aria-label` to the four Category management controls closed the assistive-technology half of Structural Criterion 5 – the controls now name which Category they act on, asserted through the accessibility tree by role and name. But an `aria-label` **overrides** the element's visible text, so `Move up – to position 1` is no longer what a screen reader speaks; it speaks `Move the category "Tooling" up`. The destination position is exactly what `docs/wireframes/facilitator-board-and-categorisation/design-decisions.md` requires be announced, and it is now announced to sighted users only. This is a **WCAG 2.5.3 (Label in Name, Level A) failure introduced by the remediation**, not pre-existing. Likely fix: an `aria-label` that contains the visible string, or `aria-describedby` / a visually-hidden suffix instead of an override. The plan's named `h4` insertion is also still missing. Left OPEN deliberately – the owner scoped the second remediation pass to the credential leak only. **Closed 2026-09-02 (fix verified, red before green).** The accessible name now *contains* the visible text instead of replacing it. Both are derived from one hoisted value (`upText` / `downText`), so they stay in step through the busy and first/last states where the visible words change – a hand-written label would silently stop matching there. `Move down – to position 2 – Tooling` is what a screen reader now hears: the destination the wireframe decision requires, plus the Category that was missing. Proved red before green: restoring the overriding label on one button fails with `expected 'Move the category "Tooling" down' to contain 'Move down – to position 2'`. The test asserts the containment property for all four controls on a two-Category board, asserts the position text explicitly (so it cannot pass on a button that renders no position at all), and keeps the uniqueness check via `getByRole`. Changed: `web/src/activities/SessionActivitiesPanel.tsx`, `web/test/CategoryBoard.test.tsx`.
