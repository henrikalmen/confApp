# Reconciliation Ledger

> Durable, greppable record of deliberate spec-vs-code drift. Entries are written by implementation and remediation skills and transitioned by review / remediation. See `reconciliation-ledger.md` for the schema, stable-ID derivation, status lifecycle, and match/recurrence/escalation rules.

## Entries

### docs/specs/facilitator-board-and-categorisation/s03-placing-post-its-into-categories.md:spec-stale:the-single-extension-point-contract-s03-owes-s05-is-actually-two-sites-and-the-second-is-unnamed
- Status: CLOSED
- Class: spec-stale
- Stale targets: –
- Source run: exec-plan-s03-placing-post-its-into-categories-2026-08-31T07:53:08Z-7b6d6756
- Recurrence: 1
- Falsifier: –
- Override reason: –
- Created: 2026-08-31
- Updated: 2026-08-31
- Notes: The FIS's Architecture Decision and Constraints & Gotchas promise S05 a single extension point – the flat conjunction in `place`'s UPDATE predicate. There are two. `diagnosePlacement` in the same module answers `destination-missing` for every case in which the `post_it` row is found, so appending S05's not-discarded conjunct to the predicate alone would leave a discarded Post-it matching zero rows in the UPDATE while the diagnosis SELECT still finds it, refusing the caller with `CATEGORY_NOT_FOUND` about a destination that was perfectly valid; `PlacementOutcome` also carries no member for the discarded case. Resolution: closed by documentation rather than restructuring. The second site is now named in `api/src/rounds/post-it-repository.ts`'s `place` docblock, and the fact is propagated to S05 as a Discovered Requirement in `s05-discard-and-restore.md` (2026-08-31 run). Documenting was chosen over re-deriving the destination check inside `diagnosePlacement` because it removes the hazard without foreclosing S05's choice of correction.
