# Reconciliation Ledger

> Durable, greppable record of deliberate spec-vs-code drift. Entries are written by implementation and remediation skills and transitioned by review / remediation. See `reconciliation-ledger.md` for the schema, stable-ID derivation, status lifecycle, and match/recurrence/escalation rules.

## Entries

### docs/specs/facilitator-board-and-categorisation/s06-admin-permanent-removal.md:spec-stale:c1-removal-unreachable-from-the-discarded-post-its-surface
- Status: CLOSED
- Class: spec-stale
- Stale targets: docs/wireframes/facilitator-board-and-categorisation/design-decisions.md ("The discarded Post-its surface" -> "What is deliberately absent"); docs/wireframes/facilitator-board-and-categorisation/discarded-postits.html (the "There is no permanent-removal control here" annotation); docs/wireframes/facilitator-board-and-categorisation/page-inventory.md ("Deliberately not drawn here" -> "Admin permanent removal"); docs/wireframes/facilitator-board-and-categorisation/validation-report.md (the structural-sweep row "No permanent-removal control or wording"); docs/specs/facilitator-board-and-categorisation/s06-admin-permanent-removal.md (TI05). All five corrected 2026-09-02.
- Source run: exec-plan-s06-admin-permanent-removal-2026-08-31T13:10:00Z-7f3a1e9b
- Recurrence: 1
- Falsifier: –
- Override reason: –
- Created: 2026-08-31
- Updated: 2026-09-02
- Notes: The FIS contradicted itself about where permanent removal is offered. OC01 names "already Discarded" as one of three places removal must be available; TI05 scoped the control to the Board. The worker implemented TI05 as written, so an Admin could not permanently remove an already-Discarded Post-it from any UI surface – the API delivered it and was tested, but no client offered it. The only route was to restore the Post-it first, republishing it to every Attendee's Board and the projected room screen, then remove it: for the abusive-content case this story exists for, putting the content back in front of the room in order to take it away. Acceptance Scenario S02 was honestly `[x]` because its *Then* clauses are all API-level and were genuinely satisfied – no single checkbox was positioned to notice. **Closed 2026-08-31 by owner decision, resolved in favour of OC01**: the permanent-removal control was added to the discarded-Post-its surface, and TI05 is superseded by the amended Structural Criterion 5. Verified: 90 files / 1495 tests, and `visual/session-activities.spec.ts` 15/15 at 375/768/1280 with the three `session-activities-discarded-*` captures regenerated. **2026-09-02, documentation half closed** (gap review G01: this entry closed the code half and left four wireframe artifacts plus TI05 stating the reversed position as current). `design-decisions.md` now carries a dated `### Amendment – 2026-08-31` block in the same shape as the legibility-floor one, with the original prose left exactly as written and a pointer blockquote under it; `discarded-postits.html`, `page-inventory.md` and `validation-report.md` are annotated, the last with its **PASS** row changed to **SUPERSEDED** because it certified a property the product deliberately no longer has; TI05 is marked superseded in place. No wireframe was redrawn – the drawings are the 2026-08-30 record and are left as drawn.

### docs/specs/facilitator-board-and-categorisation/s06-admin-permanent-removal.md:design-changed:criterion-5-gating
- Status: CLOSED
- Class: design-changed
- Stale targets: –
- Source run: exec-plan-s06-admin-permanent-removal-2026-08-31T13:10:00Z-7f3a1e9b
- Recurrence: 1
- Falsifier: –
- Override reason: –
- Created: 2026-08-31
- Updated: 2026-08-31
- Notes: Structural Criterion 5 said the control is rendered "only from a server-supplied capability flag". The control added to the discarded-Post-its surface sits inside that surface's `canRun` block, so it is gated on sorting authority as well as Admin, and the criterion as written was literally false. **Closed 2026-08-31 by owner decision**: the criterion was amended to match the shipped gating rather than the gating restructured. Nobody's access changes – `canRun` is true for an assigned Facilitator or a conference-wide Admin, so every Admin passes it – and the discarded surface belongs behind `canRun` because it is a Facilitator surface. The rationale is also recorded in `DiscardedPostIts.tsx`'s docblock so a reader of the code finds it without the FIS.
