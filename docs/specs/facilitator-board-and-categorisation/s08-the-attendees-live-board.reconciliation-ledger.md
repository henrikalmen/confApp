# Reconciliation Ledger

> Durable, greppable record of deliberate spec-vs-code drift. Entries are written by implementation and remediation skills and transitioned by review / remediation. See `reconciliation-ledger.md` for the schema, stable-ID derivation, status lifecycle, and match/recurrence/escalation rules.

## Entries

### docs/specs/facilitator-board-and-categorisation/s08-the-attendees-live-board.md:design-changed:staleness-anchor
- Status: CLOSED
- Class: design-changed
- Stale targets: –
- Source run: exec-plan-s08-the-attendees-live-board-2026-09-01T23:04:46Z-fd7f627f
- Recurrence: 1
- Falsifier: –
- Override reason: –
- Created: 2026-09-01
- Updated: 2026-09-01
- Notes: The age anchored on the last successful Session read, which for an Attendee runs only when the activity cursor moves, so on a healthy connection with nobody sorting the age climbed exactly as it would during an outage. Owner decided 2026-09-01 (UTC; a later step of the same run crossed local midnight, which is why some notes in this bundle say 2026-09-02) to anchor on the watermark exchange instead; the FIS's Architecture Decision, Constraints & Gotchas and TI06 were amended to match, rather than the code diverging from a spec that still said otherwise.

### docs/specs/facilitator-board-and-categorisation/s08-the-attendees-live-board.md:ambiguous-intent:gates-reported-unrunnable
- Status: CLOSED
- Class: ambiguous-intent
- Stale targets: –
- Source run: exec-plan-s08-the-attendees-live-board-2026-09-01T23:04:46Z-fd7f627f
- Recurrence: 1
- Falsifier: –
- Override reason: –
- Created: 2026-09-01
- Updated: 2026-09-01
- Notes: The story reported "no Docker daemon and no reachable TEST_DATABASE_URL" and left five checkboxes ticked with no executed proof (TI03, TI04, TI07 server half, TI09, Structural Criterion 7). Docker was running and the confApp stack was up; what had broken was WSL2 localhost forwarding, so the database answered on the WSL interface but not on `127.0.0.1`. The orchestrator executed every one of those gates: the four new integration tests pass against real PostgreSQL and both visual specs pass. The checkboxes are now earned rather than asserted. A near-repeat of the trap already in `docs/LEARNINGS.md`.

### docs/specs/facilitator-board-and-categorisation/s08-the-attendees-live-board.md:design-changed:held-item-not-captured
- Status: OPEN
- Class: design-changed
- Stale targets: –
- Source run: exec-plan-s08-the-attendees-live-board-2026-09-01T23:04:46Z-fd7f627f
- Recurrence: 1
- Falsifier: –
- Override reason: –
- Created: 2026-09-01
- Updated: 2026-09-01
- Notes: C07 – the new three-width capture seeds no held item, so the one element this story relocated (a pending Post-it inside Uncategorised) is measured at no viewport width. The relocation is proved by component tests; what is unproved is that it holds at 375px, the standing responsiveness bar. Needs a fixture, not a decision – recorded OPEN so it is not lost.

### docs/specs/facilitator-board-and-categorisation/s08-the-attendees-live-board.md:spec-stale:attendee-wireframe-draws-no-staleness-indicator
- Status: OPEN
- Class: spec-stale
- Stale targets: docs/wireframes/facilitator-board-and-categorisation/attendee-board.html (the toolbar line – no age or staleness state is drawn anywhere on it); docs/wireframes/facilitator-board-and-categorisation/page-inventory.md entry 7 (enumerates the Attendee Board's required content and never names the indicator)
- Source run: exec-plan-s08-the-attendees-live-board-2026-09-01T23:04:46Z-fd7f627f
- Recurrence: 1
- Falsifier: `grep -Ei "stale|updated |age" docs/wireframes/facilitator-board-and-categorisation/attendee-board.html` returns one unrelated hit (a post-it's own text) and no indicator, while the shipped surface renders `activities-age` (`web/src/activities/SessionActivitiesPanel.tsx:1207`) and `visual/session-activities.spec.ts:1387,1403` asserts it visible and inside the viewport at 375 / 768 / 1280 px – re-run 2026-09-02, 18/18 green.
- Override reason: Wireframe authorship is S01's and S08's Scope & Boundaries does not include redrawing it. The wireframe set is a signed-off 2026-08-30 record with 13 committed viewport captures and a validation report certifying each of them by measurement; adding an element to `attendee-board.html` invalidates its three captures and three PASS rows, so the honest correction is an S01 re-validation pass, not an untracked edit. FR9's requirement itself is not in doubt – `prd.md#fr9-the-attendees-live-board` still requires the indicator, and the shipped surface has it and proves it at all three widths – so this is an omission in the drawing, not a contradiction between artifacts.
- Created: 2026-09-02
- Updated: 2026-09-02
- Notes: Opened 2026-09-02 by the bundle gap review (G06). FR9's Error Handling requires that "the last-read Board remains readable with a staleness indicator". The shipped Attendee Board renders one; `attendee-board.html` draws only a static toolbar line, and `page-inventory.md` entry 7 – which enumerates the Attendee Board's content in detail, down to S08's pending-Post-it relocation – never names it. S08's Implementation Observations recorded the drift in prose with the S01-owns-wireframes reason and no ledger entry, which is what the review objected to: prose is not greppable by class or status. `design-decisions.md` -> "The projected view's overflow behaviour" ("a statement, not a retry button") settles staleness wording only for the projected class, so the Attendee wording is settled nowhere in the wireframe record either. Resolution taken here is the second of the two the review offered – record the deviation with the override reason rather than edit an S01 artifact and its captures out from under its validation report. Interacts with the S07 entry `design-decisions-under-describes-the-projected-surface`: both are the same "the wireframe record is behind the shipped surface and belongs to S01" call and should be taken together in one S01 re-validation pass.
