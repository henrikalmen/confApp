# Reconciliation Ledger

> Durable, greppable record of deliberate spec-vs-code drift. Entries are written by implementation and remediation skills and transitioned by review / remediation. See `reconciliation-ledger.md` for the schema, stable-ID derivation, status lifecycle, and match/recurrence/escalation rules.

## Entries

### docs/wireframes/facilitator-board-and-categorisation/attendee-board.html:ambiguous-intent:the-attendee-board-drops-the-shipped-author-controls-on-an-open-round
- Status: CLOSED
- Class: ambiguous-intent
- Stale targets: –
- Source run: exec-plan-s01-board-surface-wireframes-2026-08-30T17:32:30Z-9f4c2a1b
- Recurrence: 1
- Falsifier: –
- Override reason: –
- Created: 2026-08-30
- Updated: 2026-08-30
- Notes: `attendee-board.html` drew an open Round with no controls on the Attendee's own Post-it, while the shipped `web/src/activities/SessionActivitiesPanel.tsx` (`postIt.mine && open` branch, ~lines 1144-1168) offers `Correct` and `Remove` there and `facilitator-sorting.html` draws both. Owner decided 2026-08-30 to draw `Correct` / `Remove` on the Attendee's own Post-it while the Round is open, matching the shipped labels. Implemented and verified: `attendee-board.html` now carries exactly `Correct`, `Remove`, `Add post-it` – zero `<select>`, zero move/place/discard controls – so FR9's read-only-with-respect-to-placement is intact. Closed by owner decision plus verifying evidence, not by assumption.

### docs/wireframes/facilitator-board-and-categorisation/validation-report.md:spec-stale:the-validation-report-s-reproduction-recipe-cannot-be-reproduced
- Status: CLOSED
- Class: spec-stale
- Stale targets: –
- Source run: exec-plan-s01-board-surface-wireframes-2026-08-30T17:32:30Z-9f4c2a1b
- Recurrence: 1
- Falsifier: –
- Override reason: –
- Created: 2026-08-30
- Updated: 2026-08-30
- Notes: `validation-report.md`'s "How to reproduce" pointed at a gitignored `.agent_temp/` path that is not in the changeset, so the recipe could not be run by anyone else. Replaced with what to rebuild and the measurements to assert, needing only Playwright and the committed wireframe files.
