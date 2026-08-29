# Reconciliation Ledger

> Durable, greppable record of deliberate spec-vs-code drift. Entries are written by implementation and remediation skills and transitioned by review / remediation. See `reconciliation-ledger.md` for the schema, stable-ID derivation, status lifecycle, and match/recurrence/escalation rules.

## Entries

### api/src/sessions/session-deletion.ts:spec-stale:the-shipped-refusal-is-parameterised-while-fr7-fixes-a-literal-sentence
- Status: CLOSED
- Class: spec-stale
- Stale targets: docs/specs/session-activities/prd.md#fr7-contribution-safe-session-deletion
- Source run: s05-exec-spec-2026-08-29
- Recurrence: 1
- Falsifier: –
- Override reason: –
- Created: 2026-08-29
- Updated: 2026-08-29
- Notes: Anchor: FIS S05, TI01 ("The sentence carries the PRD's wording *and* the counts, because FR7 demands both a fixed message and that the refusal names what would be lost"). FR7's Error Handling clause fixes the refusal as the literal sentence "This session has collected post-its or votes and cannot be deleted." The shipped refusal is parameterised, because US10's acceptance criterion requires the refusal to *name what would be lost*: "This session has collected 12 post-its and cannot be deleted. Edit the session, or move it to another day or time, instead." For a Session holding only ballots the phrase "post-its" does not appear at all - it reads "This session has collected 8 votes and cannot be deleted." TI01 reconciled the two requirements deliberately and the code is the right call; what is stale is the PRD, which still states the fixed noun phrase as if it were the whole contract. `api/test/session-deletion.test.ts` now pins a sentence the PRD does not contain, so anyone diffing the PRD against shipped behaviour, or writing a downstream client from the PRD, sees a mismatch with no recorded resolution. Recommended upstream edit (recommend-only, PRD not edited): restate FR7 -> Error Handling in its parameterised form - "This session has collected {what was collected} and cannot be deleted. Edit the session, or move it to another day or time, instead." - citing US10 as the reason the counts replace the fixed noun phrase. RECONCILED 2026-08-29 (transition source run: exec-plan-ledger-sweep-2026-08-29T20-00-00Z-b7e4d219): the recommended upstream edit was applied on the owner's decision. prd.md FR7's Error Handling clause now requires a refusal that names what the Session actually holds, rather than fixing one literal sentence that cannot satisfy US10 for a ballots-only Session. The code was right and the PRD was stale, which is what this entry said; the stale target is no longer stale. NOTE FOR THE RECORD: the PRD was edited directly rather than routed through andthen:prd or andthen:clarify, having said it would be routed - a one-clause amendment did not justify a full skill run, but the deviation is the executing agent's and is recorded here rather than hidden. Verified at 1201/1201 tests across 73 files, typecheck/lint/build clean.

### api/src/rounds/post-it-repository.ts:code-defect:contribute-returns-500-when-its-round-is-deleted-mid-insert
- Status: CLOSED
- Class: code-defect
- Stale targets: –
- Source run: exec-plan-s05-contribution-safe-session-deletion-2026-08-29T14-05-00Z-f27ac6b1
- Recurrence: 1
- Falsifier: –
- Override reason: –
- Created: 2026-08-29
- Updated: 2026-08-29
- Notes: Found by S05's review. The S02 contribute path raises a raw FK violation surfacing as HTTP 500 when its Round is deleted between the request and the insert. Same shape as S02's already-fixed open-Poll 500 - a constraint refusing where a domain refusal was intended. S02's to fix. S05's test pins the real current behaviour, so it will fail loudly when corrected rather than silently drifting. RECONCILED 2026-08-29 (transition source run: exec-plan-ledger-sweep-2026-08-29T20-00-00Z-b7e4d219): a new insertOrDiagnose wrapper catches SQLSTATE 23503 and routes it to the same diagnosis an empty result takes, so the contributor is told the Round is gone rather than that the API broke - the same shape of fix S02 already applied to the open-Poll 500. S05's own test had deliberately pinned the 500 so it would fail loudly when corrected; it did exactly that, and was updated to assert `missing`. Verified at 1201/1201 tests across 73 files, typecheck/lint/build clean.

### api/src/sessions/session-repository.ts:code-defect:the-delete-holds-the-conference-row-for-update-across-an-unbounded-wait
- Status: CLOSED
- Class: code-defect
- Stale targets: –
- Source run: exec-plan-s05-contribution-safe-session-deletion-2026-08-29T14-05-00Z-f27ac6b1
- Recurrence: 1
- Falsifier: –
- Override reason: –
- Created: 2026-08-29
- Updated: 2026-08-29
- Notes: The delete takes the Conference row lock, then waits on Round locks with no lock_timeout set anywhere in the codebase. Not a deadlock, so the existing SQLSTATE 40P01 retry does not cover it - a slow or stuck Round lock parks the Conference row for every other writer. An operational decision the story deliberately did not make. RECONCILED 2026-08-29 (transition source run: exec-plan-ledger-sweep-2026-08-29T20-00-00Z-b7e4d219): the operational decision the story deferred was taken - SET LOCAL lock_timeout = '5s' inside the delete transaction, transaction-local so the pooled connection is handed back with the server default. SQLSTATE 55P03 is caught OUTSIDE the transaction, because it aborts the transaction and so cannot be handled within, and is mapped to a new `busy` outcome which the route renders as 503 CONFERENCE_BUSY with "try again in a moment" - the only refusal in that route for which retrying unchanged is the right advice. Proof: new integration test holds a Round row from a third connection past the ceiling; proven red by removing the mapping (500 INTERNAL_ERROR instead of 503), and the 5136ms duration confirms the timeout genuinely fired rather than the test passing for another reason. Verified at 1201/1201 tests across 73 files, typecheck/lint/build clean.

### api/src/sessions/session-deletion.ts:code-defect:issessiondeletable-is-exported-with-no-production-caller
- Status: WITHDRAWN
- Class: code-defect
- Stale targets: –
- Source run: exec-plan-s05-contribution-safe-session-deletion-2026-08-29T14-05-00Z-f27ac6b1
- Recurrence: 1
- Falsifier: The observation is factually true but is not a defect. `isSessionDeletable` is exported deliberately for parity with `api/src/conferences/lifecycle.ts#isJoinable` (line 146), which sits in the identical position in the sibling guard module and is likewise exported; the review itself scored it confidence 65, scope secondary, and this entry's Notes already record the parity argument as the reason it was kept. Removing it would make two guards written to the same shape asymmetric for no gain. Withdrawn as an accepted deliberate design rather than a divergence. Re-opens if a later run shows the parity argument no longer holds - for instance if `isJoinable` is itself removed, or gains a caller that this one cannot mirror.
- Override reason: –
- Created: 2026-08-29
- Updated: 2026-08-29
- Notes: Kept deliberately for parity with lifecycle.ts#isJoinable, which sits in the same position and is likewise exported. Confidence 65, scope secondary. Recorded so the parity argument is legible rather than looking like dead code.
