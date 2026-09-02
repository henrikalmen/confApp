# Reconciliation Ledger

> Durable, greppable record of deliberate spec-vs-code drift. Entries are written by implementation and remediation skills and transitioned by review / remediation. See `reconciliation-ledger.md` for the schema, stable-ID derivation, status lifecycle, and match/recurrence/escalation rules.

## Entries

### docs/specs/facilitator-board-and-categorisation/s05-discard-and-restore.md:ambiguous-intent:edit-on-discarded
- Status: CLOSED
- Class: ambiguous-intent
- Stale targets: –
- Source run: exec-plan-s05-discard-and-restore-2026-08-31T11:30:43Z-ce691d7d
- Recurrence: 1
- Falsifier: –
- Override reason: –
- Created: 2026-08-31
- Updated: 2026-08-31
- Notes: `api/src/rounds/post-it-repository.ts#edit` carried no not-discarded condition, and the FIS recorded the omission as unstated – `place` was amended deliberately and `remove` was left alone deliberately, both documented and both tested, while `edit` was neither. Its predicate is `p.author_sub = $5 and r.state = 'open'`, so an author whose client read the Board before the Discard can still commit a correction to a discarded Post-it's text. Whether that should be refused (like a placement) or allowed (like the author's delete, which wins its race) was a product decision this story did not have, which is why the class is `ambiguous-intent` rather than `code-defect`. **Closed by owner decision of 2026-08-31: allow, like author deletion** – an author owns their words whether or not a Facilitator has set the Post-it aside, so `edit` follows `remove` rather than `place`. The accepted consequence is that the text in the discarded list, and the text a restore puts back in front of the room, can change under the Facilitator. Closed in code and documentation together: a documenting comment on `edit` and a pinning integration test (`lets the author correct a discarded post-it, and the discarded list shows the new text`) that also asserts the correction does not restore it and that no Board read returns it.

### docs/specs/facilitator-board-and-categorisation/s05-discard-and-restore.md:design-changed:discarded-list-refused-after-archival
- Status: OPEN
- Class: design-changed
- Stale targets: docs/specs/facilitator-board-and-categorisation/prd.md#fr4-discard-and-restore
- Source run: exec-plan-s05-discard-and-restore-2026-08-31T11:30:43Z-ce691d7d
- Recurrence: 1
- Falsifier: –
- Override reason: –
- Created: 2026-08-31
- Updated: 2026-08-31
- Notes: The discarded-Post-its read (`GET .../rounds/:roundId/discarded-post-its`) goes through `routes/rounds.ts#authorizeWrite`, which ends in `assertEditable`, so after archival it answers `CONFERENCE_NOT_EDITABLE` for a request that changes nothing – while `post_it_discard` still retains every trace, retained as long as the Conference including after archival because the Report reads it. Nothing is lost and TI09 still holds (the client keeps the list it already read), but a Facilitator opening the surface fresh after archival reads the archived sentence instead of the list. **Structural Criterion 4 forbids a second authority path**, so S05 could not fix this without violating its own spec; S04's Display Link read is the shipped precedent that splits authority from editability for exactly this reason. **The Report slice (REQ-023 / REQ-024) must settle this.** Left OPEN deliberately – a real product gap awaiting a story that does not exist yet, not something this run can close.

### docs/specs/facilitator-board-and-categorisation/s05-discard-and-restore.md:design-changed:board-and-discarded-list-skew
- Status: CLOSED
- Class: design-changed
- Stale targets: –
- Source run: exec-plan-s05-discard-and-restore-2026-08-31T11:30:43Z-ce691d7d
- Recurrence: 1
- Falsifier: –
- Override reason: –
- Created: 2026-08-31
- Updated: 2026-08-31
- Notes: The Board read and the discarded-list read are two snapshots, so one Post-it can appear on both for a single poll tick. `DiscardedPostIts` re-reads when the Session's `activityWatermark` moves and the list request is issued after the Session payload lands, so a Discard taken on another device between the two leaves the Post-it drawn on the Board (with a Discard control) and in the discarded list (with a Restore control) until the next tick. Both controls are idempotent, nothing breaks, and the next tick agrees. It is the same two-statement skew S02 already recorded for the Categories/Post-its pair. Accepted; removing it would need a single combined read.
