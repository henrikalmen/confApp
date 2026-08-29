# Reconciliation Ledger

> Durable, greppable record of deliberate spec-vs-code drift. Entries are written by implementation and remediation skills and transitioned by review / remediation. See `reconciliation-ledger.md` for the schema, stable-ID derivation, status lifecycle, and match/recurrence/escalation rules.

## Entries

### api/src/routes/rounds.ts:spec-stale:the-activity-watermark-hands-every-member-the-instant-of-each-vote
- Status: CLOSED
- Class: spec-stale
- Stale targets: docs/adrs/ADR-006-vote-anonymity-holds-against-application-paths-not-database-credentials.md
- Source run: exec-plan-final-gap-review-2026-08-29T16-00-00Z-a3f81c95
- Recurrence: 1
- Falsifier: –
- Override reason: –
- Created: 2026-08-29
- Updated: 2026-08-29
- Notes: The activity watermark endpoint is requireMembership-only and rendered the microsecond instant of the most recent Vote, so on a Poll-only Session every movement was a Vote and an Attendee refused the tally could still read precise vote timing. FIXED THIS RUN by owner decision - see the reconcile in operation C. RECONCILED 2026-08-29: owner decision 2026-08-29 replaced the exposed value with an opaque monotonic counter. `db/migrations/20260829120000000_activity-watermark-counter.sql` creates one GLOBAL sequence `activity_watermark_seq` and changes `round.activity_watermark_at timestamptz` to `round.activity_watermark bigint`, redefining S02's single `advance_round_activity_watermark()` in place so no trigger was created, dropped or repointed. Global rather than per-Round deliberately: a per-Round counter's delta between two polls would be the Vote count, which an Attendee refused the tally must not gain. The value no longer passes through `instantExpression`. Guarded by `api/test/vote.integration.test.ts` "serves an opaque counter that carries no wall-clock time", proved red three independent ways against the shipped instant (catalogue type, wire shape, and a disguised epoch-microseconds value that passed the first two). Accepted residual, recorded in the migration comment without overclaiming: in a very quiet deployment the global delta approximates local write volume - strictly better than the microsecond instant, not a complete closure. `conference.schedule_watermark_at`, `sessions.last_updated_at` and S09's optimistic-concurrency preconditions are untouched. REFUTED 2026-08-29 by the final gap review (finding G-02). The closure argued the opaque global counter removed the leak because unrelated writes advance the sequence and so the delta does not reveal a Round's vote count. That reasoning covers the delta's MAGNITUDE only and misses the change EVENT. `api/src/rounds/round-repository.ts#activityWatermark` returns `max(activity_watermark) from round where conference_id = $1 and session_id = $2` - scoped to a single Session - so writes anywhere else advance the sequence but never change this Session's value. The change event therefore carries zero noise at any deployment volume: on a Poll-only Session, "the value moved" still means "a Vote arrived", to any Conference Member, on an unthrottled endpoint whose polling rate the reader chooses. The counter did remove the microsecond wall-clock instant and is strictly better than what it replaced, but it did not close the oracle. S03's Structural Criterion at line 101 states the exposure accurately and then closes it with this same incomplete argument, as does the header comment of `db/migrations/20260829120000000_activity-watermark-counter.sql`. RECONCILED 2026-08-29 by ADR-007, implemented and verified. `db/migrations/20260831090000000_vote-advances-no-cursor.sql` drops `vote_advances_activity_watermark` reversibly, without editing the applied migration that created it. A Vote now advances no cursor at all, so there is no vote-derived value for any caller to read and no future endpoint can re-expose one - the channel is closed at its source rather than gated behind an authority check, which was the explicit reason the authority-split alternative was rejected. A Session Assignment holder's tally now refetches on each tick of the existing poll loop in `web/src/activities/SessionActivitiesPanel.tsx`, adding no timer, no cadence constant, no in-flight latch and no event registration; the shipped guards in `api/test/round-structure.test.ts` and `web/test/watermark-poll.test.tsx` are byte-identical to before. Attendee propagation is unaffected and still proven: Post-it writes advance the cursor, and `round_change_advances_activity_watermark` fires on a Round state change so reveal-on-close still reaches every Member. Prove-It evidence: recreating the dropped trigger on the test database turns five independent assertions red across three files; removing the holder's per-tick branch fails on rendered counts (3 0 0 versus 3 1 0), not on a request count. Verified independently by the orchestrator at 1188/1188 tests across 72 files, typecheck, lint and build clean. The sibling entry `a-facilitator-can-pair-a-ballot-with-an-observed-voter-via-the-live-tally` is NOT closed by this: a holder watching the live tally in a room where they can see who acted is inherent to US07 and is now named explicitly in ADR-006's amended Decision 1 as an accepted open channel.

### api/src/routes/rounds.ts:spec-stale:a-facilitator-can-pair-a-ballot-with-an-observed-voter-via-the-live-tally
- Status: CLOSED
- Class: spec-stale
- Stale targets: docs/adrs/ADR-006-vote-anonymity-holds-against-application-paths-not-database-credentials.md
- Source run: exec-plan-s03-anonymous-poll-voting-2026-08-29T11-15-00Z-c4d71fa8
- Recurrence: 1
- Falsifier: –
- Override reason: –
- Created: 2026-08-29
- Updated: 2026-08-29
- Notes: A Session Assignment holder sees the live tally move and can correlate a count change with observing a colleague act. Inherent to US07's live-tally-to-the-Facilitator product decision, not a defect in this story. The timing half of this vector was closed by the counter change; the tally half remains. ADR-006 Decision 1 is written as though only a single response matters and does not model correlation across successive responses - it needs an amendment, not code. RECONCILED 2026-08-29: the stale target caught up. ADR-006 was amended 2026-08-29 (header now reads `**Amended**: 2026-08-29 (Decision 1 - correlation across successive responses and against out-of-band observation)`) and models this vector by name: Decision 1 adds "Correlation with out-of-band observation" - a Session Assignment holder watching the live tally move, in a room where they can see who just acted, can pair a ballot with a voter using information the API never put in a response at all - records it as inherent to US07's deliberate decision to show the holder a live tally and explicitly NOT closed by ADR-007, and adds the reading rule that "the observer is in the room". Decision 1 previously read in the singular, as though only a single response mattered, which is why an out-of-band vector was invisible to it. The upstream document no longer misstates the guarantee, which is what reconciling a spec-stale entry means. The channel itself remains open by design and is now documented as an accepted residual rather than an oversight: this closure records that the documentation caught up, not that the correlation stopped being possible.

### db/migrations/20260829090000000_vote.sql:code-defect:on-delete-cascade-on-the-ballot-to-option-fk-means-a-freeze-bug-destroys-ballots
- Status: CLOSED
- Class: code-defect
- Stale targets: –
- Source run: exec-plan-s03-anonymous-poll-voting-2026-08-29T11-15-00Z-c4d71fa8
- Recurrence: 1
- Falsifier: –
- Override reason: –
- Created: 2026-08-29
- Updated: 2026-08-29
- Notes: updateContent deletes the option set; the cascade takes the ballots with it, with no error and no trace. Only the freeze stands between a bug and lost Votes - the one place this migration does not make the wrong state unrepresentable. RESTRICT may break S05's cascade ordering, so the correction is not mechanical. Unreachable today now that the freeze is under a row lock; this is defence in depth. RECONCILED 2026-08-29 (transition source run: exec-plan-ledger-sweep-2026-08-29T20-00-00Z-b7e4d219) by a reachability guard rather than a schema change, per owner decision - RESTRICT would collide with S05's Session cascade, which is exactly the non-mechanical correction this entry flagged. A new test asserts that exactly one statement in the API deletes a round_option, that it sits inside the transaction taking the Round row FOR UPDATE and calling assertNotFrozen first, and that nothing outside api/src/rounds deletes one at all. The defence in depth is therefore on the reachability of the delete rather than on the FK action. Proven red by adding a second unguarded deleter. Verified at 1201/1201 tests across 73 files, typecheck/lint/build clean.

### db/migrations/20260829090000000_vote.sql:code-defect:the-round-option-delete-trigger-fires-during-cascade-deletion-and-is-untested-there
- Status: CLOSED
- Class: code-defect
- Stale targets: docs/specs/session-activities/s05-contribution-safe-session-deletion.md
- Source run: exec-plan-s03-anonymous-poll-voting-2026-08-29T11-15-00Z-c4d71fa8
- Recurrence: 1
- Falsifier: –
- Override reason: –
- Created: 2026-08-29
- Updated: 2026-08-29
- Notes: Same shape as S02's shipped post-it trigger so it is expected to no-op, but S05 is contribution-safe Session deletion and will land on it. Also a six-option Poll bumps the cursor six times in one transaction. Belongs to S05. RECONCILED 2026-08-29: S05, this entry's named stale target, landed the coverage it asked for. `api/test/session-deletion.integration.test.ts:471` is 'deletes a session holding a multi-option poll, the cascade reaching round_option': it seeds a six-option Poll with no contributions, probes `pg_trigger` to assert `round_option_advances_activity_watermark` is actually attached BEFORE deleting - so a dropped trigger cannot make the test pass for the wrong reason - then deletes and asserts the cascade completes cleanly with the trigger firing six times against a Round being deleted in the same transaction, and not raising. Verified present 2026-08-29. The six-bumps-in-one-transaction observation this entry also carried is a wasted-work note, not a correctness problem, and was explicitly not S05's to fix.

### db/migrations/20260828120000000_post-it.sql:code-defect:wall-survives-in-migration-comments-after-the-board-rename
- Status: CLOSED
- Class: code-defect
- Stale targets: –
- Source run: exec-plan-s03-anonymous-poll-voting-2026-08-29T11-15-00Z-c4d71fa8
- Recurrence: 1
- Falsifier: –
- Override reason: –
- Created: 2026-08-29
- Updated: 2026-08-29
- Notes: Lines 112 and 127 of S02's migration still say "wall" after Board became the canonical noun. S03's own files introduce none. Comment-only, in an already-applied migration, so cosmetic and deliberately not churned mid-run. RECONCILED 2026-08-29 (transition source run: exec-plan-ledger-sweep-2026-08-29T20-00-00Z-b7e4d219): lines 112 and 127 of S02's migration now say "board"; zero occurrences of the old noun remain in that migration. Comment-only change, deliberately taken outside the run whose mid-flight churn it was avoiding. Verified at 1201/1201 tests across 73 files, typecheck/lint/build clean.

### api/test/vote-structure.test.ts:code-defect:the-migration-is-read-by-hardcoded-name-so-a-later-voter-column-does-not-turn-it-red
- Status: CLOSED
- Class: code-defect
- Stale targets: –
- Source run: exec-plan-final-gap-review-2026-08-29T16-00-00Z-a3f81c95
- Recurrence: 1
- Falsifier: –
- Override reason: –
- Created: 2026-08-29
- Updated: 2026-08-29
- Notes: Final gap review G-05. The structure test reads one migration by hardcoded filename, so a LATER migration adding a voter-bearing column to the ballot table would not turn it red. The live-schema backstop that would catch it is database-dependent and silently skips when no database is reachable, so on a machine without PostgreSQL the anonymity structural guarantee has no enforcing assertion at all. RECONCILED 2026-08-29 (transition source run: exec-plan-ledger-sweep-2026-08-29T20-00-00Z-b7e4d219): the guard now lists the migrations directory and asserts that no ALTER TABLE ... ADD COLUMN has touched `vote` or `round_voter` in ANY migration, present or future. Zero-tolerance rather than a denylist of names, because the failure mode is the column nobody thought to name. It needs no database, which was the whole point of the finding - the live-schema backstop stays where it was, behind describe.skipIf(!reachable), so the anonymity structural guarantee now has an enforcing assertion on a machine with no PostgreSQL. Proven red with a hypothetical later migration adding `submitted_by`. Verified at 1201/1201 tests across 73 files, typecheck/lint/build clean.

### docs/specs/session-activities/s03-anonymous-poll-voting-and-result-reveal.md:spec-stale:structural-criterion-5-still-requires-the-ballot-trigger-adr-007-removed
- Status: CLOSED
- Class: spec-stale
- Stale targets: docs/specs/session-activities/s03-anonymous-poll-voting-and-result-reveal.md
- Source run: exec-plan-adr-007-implementation-2026-08-29T17-30-00Z-d5b9e4a2
- Recurrence: 1
- Falsifier: –
- Override reason: –
- Created: 2026-08-29
- Updated: 2026-08-29
- Notes: Structural Criterion 5 (line 101) still reads "Permitted and required ...: exactly one AFTER INSERT trigger on the ballot table, which advances its Round's activity watermark and does nothing else ... Any wider trigger on the ballot table is a defect." ADR-007 removed that trigger, so a CHECKED criterion now requires something that must not exist - and a future reader satisfying it literally would reintroduce the vote-arrival oracle. The `design-change` form explicitly forbids editing Structural Criteria, which are the proof record, so this cannot be corrected through that instrument and is recorded here instead pending an explicit owner override. The shipped code is strictly stronger than the criterion permits: zero triggers on the ballot table rather than one. RECONCILED 2026-08-29: the criterion was amended under an explicit, recorded owner override of the `design-change` form's Structural-Criteria prohibition. It now states that the ballot table carries no trigger and that any trigger attached to it is a defect, matching the shipped code, and it carries an explicit "do not restore the ballot trigger to satisfy the text below" instruction naming the dropping migration `db/migrations/20260831090000000_vote-advances-no-cursor.sql` and the test `api/test/vote-structure.test.ts` that asserts its absence. The original per-reader analysis (the `**What it reveals ...**` remainder) is retained byte-identically as history - superseded in its conclusion, not in its analysis. The override, its authority and its verbatim reasoning are recorded in the FIS audit block (`### Run: 2026-08-29 15:53 UTC – design-change`) and are deliberately scoped to this one criterion, setting no precedent for editing Structural Criteria generally. Checkbox state untouched: the FIS remains 35/35 checked, 0 unchecked.
