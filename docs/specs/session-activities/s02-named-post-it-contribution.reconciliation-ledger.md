# Reconciliation Ledger

> Durable, greppable record of deliberate spec-vs-code drift. Entries are written by implementation and remediation skills and transitioned by review / remediation. See `reconciliation-ledger.md` for the schema, stable-ID derivation, status lifecycle, and match/recurrence/escalation rules.

## Entries

### db/migrations/20260828120000000_post-it.sql:spec-stale:editing-a-polls-options-advances-no-cursor
- Status: CLOSED
- Class: spec-stale
- Stale targets: docs/specs/session-activities/s03-anonymous-poll-voting-and-result-reveal.md
- Source run: exec-plan-s02-named-post-it-contribution-2026-08-29T02-30-00Z-b8e42d19
- Recurrence: 1
- Falsifier: –
- Override reason: –
- Created: 2026-08-29
- Updated: 2026-08-29
- Notes: round_option has no trigger, and updateContent's `set prompt = $4` leaves the Round trigger's WHEN false when the prompt is unchanged. S02's Structural Criterion says the cursor advances "on every Round write", but TI02 enumerates a closed set of three writers (post_it, round, S03's ballot) and the code matches TI02 exactly. Routed to S03: its ballots point at options the room may not be reading. RECONCILED 2026-08-29: the premise no longer holds. S03 shipped `CREATE TRIGGER round_option_advances_activity_watermark AFTER INSERT OR UPDATE OR DELETE ON round_option FOR EACH ROW EXECUTE FUNCTION advance_round_activity_watermark()` at `db/migrations/20260829090000000_vote.sql:171`, attached to S02's single advance function rather than copying the expression, so an option edit now advances the Round's activity watermark and reaches every polling client - exactly what this entry asked for. Verified in the migration source 2026-08-29; the entry was written before S03 executed and was never revisited. Scope: this closes only the round_option half. The sibling S02 entry `the-round-triggers-when-clause-is-a-hand-maintained-column-allow-list` stays OPEN - the `WHEN` clause on the `round` trigger is still a hand-maintained column allow-list (`db/migrations/20260828120000000_post-it.sql:175-182`, currently prompt, state, closed_at and position) and that mechanism is untouched by this closure.

### web/src/activities/SessionActivitiesPanel.tsx:code-defect:a-failed-initial-load-leaves-the-activities-panel-permanently-dead
- Status: CLOSED
- Class: code-defect
- Stale targets: –
- Source run: exec-plan-s02-named-post-it-contribution-2026-08-29T02-30-00Z-b8e42d19
- Recurrence: 1
- Falsifier: –
- Override reason: –
- Created: 2026-08-29
- Updated: 2026-08-29
- Notes: useWatermarkPoll is gated on state.kind === 'ready'; the failed state offers no retry and polls nothing. A regression against TI08's "behaviour-preserving" claim, since S01's tick fired regardless of panel state and self-healed. Two defensible fixes exist (poll while failed, or add a retry control), which is why it was not auto-applied. RECONCILED 2026-08-29 (transition source run: exec-plan-ledger-sweep-2026-08-29T20-00-00Z-b7e4d219): of the two defensible fixes this entry named, poll-while-failed was taken. The loop now ticks while `failed` as well as `ready`, taking the full read since there is no watermark to compare yet; `loading` stays excluded so a tick cannot race the initial request. This restores the self-healing S01's tick had and that TI08's behaviour-preserving claim assumed. Proof: new test "recovers from a failed first load on the next tick, with no remount", proven red. Verified at 1201/1201 tests across 73 files, typecheck/lint/build clean.

### web/src/activities/SessionActivitiesPanel.tsx:code-defect:board-writes-have-no-in-flight-guard
- Status: CLOSED
- Class: code-defect
- Stale targets: –
- Source run: exec-plan-s02-named-post-it-contribution-2026-08-29T02-30-00Z-b8e42d19
- Recurrence: 1
- Falsifier: –
- Override reason: –
- Created: 2026-08-29
- Updated: 2026-08-29
- Notes: No busy flag and no disabled on compose-submit, Save or Remove. A double-tap on a phone duplicates a contribution under a real name; a second Remove 404s, so the person whose delete succeeded is told the post-it is no longer on this round. Highest-value of the Notes. RECONCILED 2026-08-29: `boardWriteInFlight` holds the board write currently out as a namespaced key, or null - `round:<id>` for a contribution (one compose box per Round) and `postit:<id>` for a correction or a removal. Save and Remove deliberately share the post-it key, because hitting Remove while a Save is still out is the same double-write and the second would race the first's re-read. Keyed rather than boolean so one slow write never freezes the rest of the board - a removal out on one Post-it leaves that Round's compose box live, which is asserted. `writeToBoard` gained the key as its first parameter and refuses re-entry for the same key; `contribute` carries the same guard inline, since it deliberately does not go through `writeToBoard` (it owns the offline-hold path). The flag clears in a `finally` after the re-read rather than after the request, so the window stays closed while the board is still catching up. The three controls take `disabled` plus a state label - Adding, Saving, Removing - through a new `writeInFlight` prop on `Board`, read rather than derived so the disabled control and the guard refusing the second write are the same fact. Naming: `boardWriteInFlight` follows the `voteInFlight` precedent and is verified not to trip the shipped denylist `/\binFlight\b|pollingRef/`, which matches the bare identifier case-sensitively - both regexes run against the module source, both false. Prove-It evidence: two new tests in `web/test/PostItBoard.test.tsx` - "sends one contribution for a double-tap on Add post-it" and "sends one delete for a double-tap on Remove, and leaves the compose box live". Each holds its write open, because the window in which a second tap exists is exactly the window in which the first is unanswered, and each taps through the DOM's own activation path so a disabled control declines the second exactly as a phone would. The delete stub answers a real 404 POST_IT_NOT_FOUND to a second delete, so a missing guard fails the way the room would experience it: the author whose removal actually succeeded reads "That post-it is no longer on this round." Confirmed RED against the unguarded code - reverting both the handler guard and the disabled attributes turns both tests red - then GREEN with the guard restored. Assertions are on the rendered board and on the requests actually issued, not on a spy alone. Verified independently: typecheck exit 0, lint exit 0, 1190/1190 tests across 72 files (baseline 1188), build clean, format:check unchanged on exactly the three pre-existing unrelated files.

### api/src/rounds/post-it-repository.ts:code-defect:the-check-is-the-write-invariant-is-narrower-than-stated
- Status: CLOSED
- Class: code-defect
- Stale targets: –
- Source run: exec-plan-s02-named-post-it-contribution-2026-08-29T02-30-00Z-b8e42d19
- Recurrence: 1
- Falsifier: –
- Override reason: –
- Created: 2026-08-29
- Updated: 2026-08-29
- Notes: round is joined without a row lock. Under READ COMMITTED, EvalPlanQual re-checks only the target relation, so a close committing during the statement can still admit the write. The window is a statement rather than a round trip, but the FIS, the migration comments and the repository doc all state the invariant as absolute. Fix is `for key share of r` or an honest restatement. Related to the FOR UPDATE row lock decided for S03 TI08 in poll-freeze-toctou-discharge. RECONCILED 2026-08-29 (transition source run: exec-plan-ledger-sweep-2026-08-29T20-00-00Z-b7e4d219) by the honest restatement this entry offered as its second option, NOT by a lock, and the reasoning is recorded because it is the load-bearing part: a Round close is a plain UPDATE taking FOR NO KEY UPDATE, so FOR KEY SHARE does not conflict with it and would close nothing; FOR SHARE would conflict, but every contribution's own AFTER trigger issues an UPDATE round, so two people contributing to one Round would each hold a share lock the other's trigger needs - manufacturing deadlocks on the hot path to buy a microsecond of precision. The module note and the edit-path comment now state that the predicate closes a round-trip window rather than a statement one, name both rejected alternatives and why, and state what the guarantee actually is. Verified at 1201/1201 tests across 73 files, typecheck/lint/build clean.

### db/migrations/20260828120000000_post-it.sql:code-defect:the-round-triggers-when-clause-is-a-hand-maintained-column-allow-list
- Status: CLOSED
- Class: code-defect
- Stale targets: –
- Source run: exec-plan-s02-named-post-it-contribution-2026-08-29T02-30-00Z-b8e42d19
- Recurrence: 1
- Falsifier: –
- Override reason: –
- Created: 2026-08-29
- Updated: 2026-08-29
- Notes: Any column added to round later is silently outside the cursor; this is the mechanism behind entry 1. Suggested inversion: WHEN (OLD.activity_watermark_at IS NOT DISTINCT FROM NEW.activity_watermark_at). RECONCILED 2026-08-29 (transition source run: exec-plan-ledger-sweep-2026-08-29T20-00-00Z-b7e4d219): the inversion this entry suggested shipped as `db/migrations/20260901120000000_round-watermark-when-inversion.sql`, which rewrites the clause to WHEN (OLD.activity_watermark IS NOT DISTINCT FROM NEW.activity_watermark). The clause only ever needed column names for one job - not firing on the cursor writing to itself - and stating that directly puts every future column inside the rule by construction. The migration is reversible. Proven red by adding a column the trigger has never heard of and writing to it (expected 66 to be greater than 66 under the old allow-list). Verified at 1201/1201 tests across 73 files, typecheck/lint/build clean.

### api/src/rounds/post-it-repository.ts:code-defect:a-row-vanishing-between-the-write-and-hydrate-throws-a-500
- Status: CLOSED
- Class: code-defect
- Stale targets: –
- Source run: exec-plan-s02-named-post-it-contribution-2026-08-29T02-30-00Z-b8e42d19
- Recurrence: 1
- Falsifier: –
- Override reason: –
- Created: 2026-08-29
- Updated: 2026-08-29
- Notes: contribute and edit write then hydrate in two statements with no transaction; a missing row results in `throw new Error`. The same author on phone and laptop is a real configuration. RECONCILED 2026-08-29 (transition source run: exec-plan-ledger-sweep-2026-08-29T20-00-00Z-b7e4d219): contribute returns a new `gone` outcome (200, postIt null) and edit returns `missing` (404, "no longer on this round") instead of throwing, so the same author on phone and laptop gets a domain answer rather than a 500. Proof: new deterministic unit test `api/test/post-it-vanished-row.test.ts` driven with the fake database, because the window is between two statements and cannot be hit from outside; proven red. Verified at 1201/1201 tests across 73 files, typecheck/lint/build clean.
