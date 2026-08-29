# Reconciliation Ledger

> Durable, greppable record of deliberate spec-vs-code drift. Entries are written by implementation and remediation skills and transitioned by review / remediation. See `reconciliation-ledger.md` for the schema, stable-ID derivation, status lifecycle, and match/recurrence/escalation rules.

## Entries

### api/src/rounds/ballot-gate.ts:spec-stale:the-poll-freeze-is-a-read-then-write-across-two-statements
- Status: CLOSED
- Class: spec-stale
- Stale targets: docs/specs/session-activities/s03-anonymous-poll-voting-and-result-reveal.md#implementation-tasks
- Source run: exec-plan-s01-round-authoring-and-lifecycle-2026-08-29T00-20-00Z-7f3a91c4
- Recurrence: 1
- Falsifier: –
- Override reason: –
- Created: 2026-08-29
- Updated: 2026-08-29
- Notes: The Poll freeze reads the ballot-existence port and then writes in a separate statement. Harmless while the port answers a constant, but it pre-commits S03: that story's TI08 is specified as a straight body swap, and this finding says it cannot be one — TI08 must bind the port to a predicate the write statement carries, or take the option replacement into the same transaction under a row lock. ballot-gate.ts already states this at the call site. RECONCILED 2026-08-29: S03 TI08 discharged S01's ballot-existence port under a row lock. `api/src/rounds/round-repository.ts#updateContent` now opens a transaction, issues `select ... from round ... for update` FIRST, then calls the injected freeze guard (renamed `assertNotFrozen`), then the content UPDATE and option replacement; the guard's throw rolls the whole transaction back. Proved by `api/test/vote.integration.test.ts` "refuses an edit when a vote commits between the freeze check and the write" - a second connection takes the same row lock, writes both vote rows uncommitted, the PATCH parks on the lock, the voter commits, and the edit is refused POLL_CONTENT_FROZEN with the stored prompt and labels byte-identical. Prove-It confirmed: removing `for update` turns exactly that test red. S01's Structural Criterion "exactly one ballot-existence seam exists" still holds and S01's Scenario S07 passes byte-unmodified.

### web/src/activities/SessionActivitiesPanel.tsx:code-defect:two-load-calls-can-race-so-a-stale-response-can-flip-a-badge-back
- Status: WITHDRAWN
- Class: code-defect
- Stale targets: –
- Source run: exec-plan-s01-round-authoring-and-lifecycle-2026-08-29T00-20-00Z-7f3a91c4
- Recurrence: 1
- Falsifier: Owner decision 2026-08-29 (transition source run: exec-plan-ledger-sweep-2026-08-29T20-00-00Z-b7e4d219). The window needs two loads in flight within a few hundred milliseconds and self-corrects on the next tick, so the worst observable outcome is a briefly wrong badge; the fix would add exactly the kind of sequence-number state S01's Structural Criteria deliberately restrict on this panel, which is why the entry recorded the fix as undecided rather than pending. Cost exceeds the harm. Re-opens if a run shows the stale response persisting past the next tick, or shows the race producing a wrong write rather than a briefly wrong badge.
- Override reason: –
- Created: 2026-08-29
- Updated: 2026-08-29
- Notes: Fix needs a sequence-number ref; whether that counts as the in-flight guard S01's Structural Criteria forbid is a decision the FIS does not pin down.

### web/src/activities/SessionActivitiesPanel.tsx:code-defect:a-refresh-keeps-the-payload-on-403-and-404
- Status: CLOSED
- Class: code-defect
- Stale targets: –
- Source run: exec-plan-s01-round-authoring-and-lifecycle-2026-08-29T00-20-00Z-7f3a91c4
- Recurrence: 1
- Falsifier: –
- Override reason: –
- Created: 2026-08-29
- Updated: 2026-08-29
- Notes: A deleted Session or revoked role reads as live data. Applying AttendeeSchedulePanel's answered-vs-unreachable rule at this new surface is a behaviour decision. RECONCILED 2026-08-29 (transition source run: exec-plan-ledger-sweep-2026-08-29T20-00-00Z-b7e4d219): keepOnFailure now discards the payload on 403 and 404 only. The distinction is what the answer is ABOUT - a 403 or 404 is the server stating something about this caller's access to this Session, so what is on screen is no longer true; a 5xx, a timeout or an unreachable request says nothing about the caller, and the last good board stays. The first attempt applied AttendeeSchedulePanel's broader `answered` predicate and three existing tests went red on a 503 - correctly, since discarding a room's screen because the database blipped is the harm keepOnFailure exists to prevent - so the narrow 403/404 predicate is the shipped one. Proof: new test "replaces the board when the refresh is refused for this caller", proven red on revert. Verified at 1201/1201 tests across 73 files, typecheck/lint/build clean.

### web/src/schedule/SchedulePanel.tsx:code-defect:the-organizer-side-panel-never-refreshes
- Status: CLOSED
- Class: code-defect
- Stale targets: –
- Source run: exec-plan-s01-round-authoring-and-lifecycle-2026-08-29T00-20-00Z-7f3a91c4
- Recurrence: 1
- Falsifier: –
- Override reason: –
- Created: 2026-08-29
- Updated: 2026-08-29
- Notes: SchedulePanel has no poll loop and S01 TI11 forbids adding one. One line once S02's shared extracted loop exists; expected to close under S02. RECONCILED 2026-08-29 (transition source run: exec-plan-ledger-sweep-2026-08-29T20-00-00Z-b7e4d219): SchedulePanel is now a call site of the shared watermark tick, as this entry predicted it would be once S02's extracted loop existed. It refetches only when no form is open, no save is in flight and no conflict is pending - the panel holds S09's optimistic-concurrency base versions, and refetching mid-edit would move the base under the person typing. Two tests: it catches a co-organizer's change when idle, and asks nothing at all while a form is open. This tripped S02's shipped exact-call-site guard in web/test/watermark-poll.test.tsx, which was extended to three call sites; the load-bearing assertions (one timer, one cadence constant, one in-flight latch, one listener registration) were left untouched and the list stays exact, so a fourth consumer still has to be looked at. Verified at 1201/1201 tests across 73 files, typecheck/lint/build clean.

### db/migrations/20260828090000000_round.sql:code-defect:round-has-no-unique-session-id-position-constraint
- Status: WITHDRAWN
- Class: code-defect
- Stale targets: –
- Source run: exec-plan-s01-round-authoring-and-lifecycle-2026-08-29T00-20-00Z-7f3a91c4
- Recurrence: 1
- Falsifier: Owner decision 2026-08-29 (transition source run: exec-plan-ledger-sweep-2026-08-29T20-00-00Z-b7e4d219). The ordering defect this entry is the residual of is already fixed - every read orders by (position, id), so a shared position has no observable symptom left. Adding UNIQUE (session_id, position) would make max(position)+1 fail under a concurrent authoring race and so require a retry path: new failure modes introduced to close a gap with no remaining symptom. Re-opens if duplicate positions ever become observable, or if a feature needs position to be an identity rather than a sort key.
- Override reason: –
- Created: 2026-08-29
- Updated: 2026-08-29
- Notes: Residual of the applied fix for unstable Round order under a position tie. Reads now order by (position, id); a real fix needs the constraint plus a retry path.

### api/test/membership-structure.test.ts:code-defect:the-amended-membership-structure-guard-is-narrower-than-the-listing-it-replaced
- Status: OPEN
- Class: code-defect
- Stale targets: –
- Source run: exec-plan-s01-round-authoring-and-lifecycle-2026-08-29T00-20-00Z-7f3a91c4
- Recurrence: 1
- Falsifier: –
- Override reason: Reviewed 2026-08-29 in the session-activities ledger sweep (source run: exec-plan-ledger-sweep-2026-08-29T20-00-00Z-b7e4d219) and deliberately left OPEN, per owner decision: tightening a guard S08 owns is that story's call, not this sweep's. Out of scope here; the entry stays OPEN as the durable record and does not block presentation of this run.
- Created: 2026-08-29
- Updated: 2026-08-29
- Notes: S01 had to amend a guard owned by S08. It was re-stated rather than relaxed, but it is narrower than the exact-migration-listing it replaced. Tightening it is S08's call.
