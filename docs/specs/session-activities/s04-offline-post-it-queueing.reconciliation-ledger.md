# Reconciliation Ledger

> Durable, greppable record of deliberate spec-vs-code drift. Entries are written by implementation and remediation skills and transitioned by review / remediation. See `reconciliation-ledger.md` for the schema, stable-ID derivation, status lifecycle, and match/recurrence/escalation rules.

## Entries

### web/src/offline/use-post-it-queue.ts:code-defect:leaving-a-conference-does-not-discard-its-queued-post-its
- Status: OPEN
- Class: code-defect
- Stale targets: –
- Source run: exec-plan-s04-offline-post-it-queueing-2026-08-29T14-05-00Z-e91b23d7
- Recurrence: 1
- Falsifier: –
- Override reason: Reviewed 2026-08-29 in the session-activities ledger sweep (source run: exec-plan-ledger-sweep-2026-08-29T20-00-00Z-b7e4d219) and deliberately left OPEN, per owner decision: membership-change purge is new scope beyond S04's contract, as the entry's own Notes already record. Out of scope here; the entry stays OPEN as the durable record and does not block presentation of this run.
- Created: 2026-08-29
- Updated: 2026-08-29
- Notes: Queued Post-its survive a Member leaving the Conference they were composed for. The sign-out and user-switch purge covers identity change but not membership change. New scope, not a regression.

### web/src/offline/post-it-queue.ts:code-defect:queuedkeys-is-unfiltered-by-design
- Status: WITHDRAWN
- Class: code-defect
- Stale targets: –
- Source run: exec-plan-s04-offline-post-it-queueing-2026-08-29T14-05-00Z-e91b23d7
- Recurrence: 1
- Falsifier: Not a code-versus-spec divergence, so not a code-defect. The entry's own Notes say so on their face - "Documented behaviour rather than an oversight, recorded so a later reader does not mistake the breadth for a bug." Nothing in the S04 FIS requires `queuedKeys()` to be filtered; the breadth is the intended contract rather than a defect against it. Withdrawn as an invalid finding, not resolved. Re-opens if a later run supplies evidence that some caller actually depends on a filtered `queuedKeys()`, or that the FIS requires filtering, either of which would refute this falsifier.
- Override reason: –
- Created: 2026-08-29
- Updated: 2026-08-29
- Notes: Documented behaviour rather than an oversight, recorded so a later reader does not mistake the breadth for a bug.

### web/test/AttendeeScheduleOffline.test.tsx:code-defect:line-374-still-pins-database-version-1
- Status: CLOSED
- Class: code-defect
- Stale targets: –
- Source run: exec-plan-s04-offline-post-it-queueing-2026-08-29T14-05-00Z-e91b23d7
- Recurrence: 1
- Falsifier: –
- Override reason: –
- Created: 2026-08-29
- Updated: 2026-08-29
- Notes: S04 bumped DATABASE_VERSION 1 to 2, but this S10-owned test still pins 1 at line 374. It was under a standing do-not-edit instruction during S04, so the unpin was deliberately deferred. One line, next time that file is touched. RECONCILED 2026-08-29 (transition source run: exec-plan-ledger-sweep-2026-08-29T20-00-00Z-b7e4d219): writeRaw now opens at the imported DATABASE_VERSION. What simulates the older deploy is the malformed envelope the helper writes, not the database version it opens at - the hardcoded 1 was a latent trap that only worked because that helper happens to run before anything opening at the current version, and indexedDB.open below the existing version throws VersionError. The file was under a standing do-not-edit instruction during S04; that instruction no longer applies. Verified at 1201/1201 tests across 73 files, typecheck/lint/build clean.

### web/src/activities/SessionActivitiesPanel.tsx:code-defect:a-returned-to-author-item-is-surfaced-only-by-the-session-panel
- Status: OPEN
- Class: code-defect
- Stale targets: –
- Source run: exec-plan-s04-offline-post-it-queueing-2026-08-29T14-05-00Z-e91b23d7
- Recurrence: 1
- Falsifier: –
- Override reason: Reviewed 2026-08-29 in the session-activities ledger sweep (source run: exec-plan-ledger-sweep-2026-08-29T20-00-00Z-b7e4d219) and deliberately left OPEN, per owner decision: closing it needs a device-wide held-items surface, which is new scope. Out of scope here; the entry stays OPEN as the durable record and does not block presentation of this run.
- Created: 2026-08-29
- Updated: 2026-08-29
- Notes: Surfaced when the drain moved to the app shell. Sending is now device-wide, but a refusal returned to its author is still rendered only by the Session panel, so an author elsewhere sees it when they next open that Session - and if the Session was deleted there is no surface at all. Same class of gap as the one the drain move closed, one step further on. A device-wide held-items list would close it; new scope.

### web/src/offline/use-post-it-queue.ts:code-defect:the-drain-has-no-trigger-that-fires-on-dead-venue-wifi
- Status: CLOSED
- Class: code-defect
- Stale targets: –
- Source run: exec-plan-final-gap-review-2026-08-29T16-00-00Z-a3f81c95
- Recurrence: 1
- Falsifier: –
- Override reason: –
- Created: 2026-08-29
- Updated: 2026-08-29
- Notes: Final gap review G-01, HIGH. The drain has exactly two triggers - component mount and the window `online` event - and `online` does not fire in the failure mode S04 was written for. `web/src/offline/use-online.ts` documents the trap in plain words three files away: `navigator.onLine` reports the link and not reachability, is true behind a captive portal and on dead venue wifi, and is the single most common way an offline path hangs forever. A held Post-it is therefore never retried while the app stays loaded - under Capacitor, until a force-quit. FR6's central promise, that a typed Post-it is sent when connectivity returns, is unmet in its primary case. Moving the drain to the app shell fixed WHERE it runs, not WHEN. Reconciliation applied 2026-08-29: the drain gained a third trigger without introducing a second cadence. A new announce/subscribe seam at `web/src/tick/foreground-tick.ts` - deliberately not a scheduler, containing no timer, no cadence constant and no event registration - is called by `use-watermark-poll.ts`'s existing tick, placed past the `document.hidden` check and before its in-flight latch. `PostItQueueDrain` subscribes alongside its mount and `online` triggers, gated by `somethingToSend()` reading the published projection so an empty device pays a comparison rather than an IndexedDB read every 5s. The cadence constant, the interval, the in-flight latch and the visibilitychange/focus/online registrations all remain solely in `use-watermark-poll.ts`. The seam was placed at `web/src/tick/` rather than under `poll/` because `api/test/vote-structure.test.ts` sweeps `web/src/offline` for `/\bpoll\b/` and an import path containing "poll" would have tripped that shipped guard - no guard was widened, relaxed or exempted. Proved by a new test in `web/test/PostItQueueDrain.test.tsx` in which `navigator.onLine` is asserted true at both ends, no `online` event is ever dispatched, the first send meets a transport throw and the access point then silently starts forwarding: red against the two-trigger arrangement, green after. S04's three properties re-confirmed red on revert: one drain device-wide, the per-send identity re-check, and S10's single purge path. Residual, recorded not hidden: the tick only exists while a watermark poll is mounted. In the signed-in shell that is not a hole - `PostItQueueDrain` and `AttendeeSchedulePanel` are siblings and the panel polls whenever its schedule is ready or cached, which it must be for a Round to have been rendered and typed into. A device in the terminal `unavailable-offline` state polls nothing and falls back to mount and `online`.

### api/src/rounds/post-it-repository.ts:code-defect:offlinecomposed-unlocks-a-round-that-was-never-opened
- Status: CLOSED
- Class: code-defect
- Stale targets: –
- Source run: exec-plan-final-gap-review-2026-08-29T16-00-00Z-a3f81c95
- Recurrence: 1
- Falsifier: –
- Override reason: –
- Created: 2026-08-29
- Updated: 2026-08-29
- Notes: Final gap review G-03, the review's one Fix-routed finding. The `offlineComposed` branch unlocks any Round not currently open, including one that has never been opened at all, and then marks the arrival "after close". `open()` already distinguishes the two cases via `closed_at`; `contribute()` does not. One-predicate fix. Reconciliation applied 2026-08-29: the contribute insert-from-select predicate became `and (r.state = 'open' or ($6::boolean and r.closed_at is not null))`, was `($6::boolean or r.state = 'open')`. A Round is closed from creation, so state alone cannot distinguish one that finished from one nobody started; `closed_at` is the same column `open()` already reads for the reopen rule. A never-opened Round now falls through to the existing diagnosis and returns POST_IT_ROUND_CLOSED. The late marker is still `r.state <> 'open'` read in the same statement, so a Round reopened before the device drains still takes the item as an ordinary contribution. Proved by a new case in `api/test/post-it.integration.test.ts` asserting `state = 'closed', closed_at = null` first so the case under test is genuinely the never-opened one: 200 with arrivedAfterClose true against the old predicate, 409 POST_IT_ROUND_CLOSED with zero rows after.

### web/src/offline/post-it-queue.ts:code-defect:the-idempotency-key-dies-with-the-row-so-a-retry-can-recreate-a-withdrawn-post-it
- Status: CLOSED
- Class: code-defect
- Stale targets: –
- Source run: exec-plan-final-gap-review-2026-08-29T16-00-00Z-a3f81c95
- Recurrence: 1
- Falsifier: –
- Override reason: –
- Created: 2026-08-29
- Updated: 2026-08-29
- Notes: Final gap review G-04. The submission identity that makes delivery exactly-once is carried on the `post_it` row, so it dies when the row is deleted. A lost response followed by the author deleting their Post-it lets the queued retry recreate it - under their real name, with no affordance that explains its return. The only gap-review finding that touches the NAMED half of the load-bearing rule rather than the anonymous half. Reconciliation applied 2026-08-29: the submission identity that makes a retry harmless lived only on the `post_it` row, so removing the Post-it removed it. `db/migrations/20260901090000000_post-it-delivery-record.sql` adds `post_it_delivery (round_id, submission_id)` with a composite primary key and `REFERENCES round (id) ON DELETE CASCADE`, following `round_option`'s idiom, plus a backfill from existing rows so the invariant holds from the moment it lands rather than from the next write - plain portable PostgreSQL, reversible, `migrate:up`/`down`/`up` clean. The write is ONE statement, not a transaction, because a single statement is already atomic: a CTE inserts the Post-it and its delivery record together, with `and not exists (select 1 from post_it_delivery d where d.round_id = r.id and d.submission_id = $7::uuid)` added to the INSERT's source predicate so a delivered submission can never write a second row. There is therefore no window in which a Post-it exists without its delivery record or the reverse, and a concurrent retry racing the guard is refused by the primary key rather than by anything in application code (Binding Constraint FR2). New outcome `already-delivered` on `ContributionOutcome`, mapped by the route to a 200 carrying `postIt: null` - deliberately a SUCCESS and not a refusal: nothing went wrong, the device must stop retrying, and there is nothing for the room to be told. `web/src/api/client.ts#contributePostIt` now returns `PostIt | null`; no caller reads the value - the drain drops the queue item on a resolved promise and the panel re-reads the board - so the blast radius is the type alone. What it deliberately is NOT, recorded in the migration comment: not a tombstone and not a soft delete (S05 rejected that model outright, and no text, author or time is retained - only a uuid meaning "already used"); not a contribution, so S05's deletion guard, which counts `post_it` and `vote` rows, still lets a Session whose only Post-it was withdrawn be deleted, and the Round cascade then clears these; and not author-scoped, because a submission identity is minted before anyone knows which credential will send it on a shared tablet. Prove-It evidence: `api/test/post-it.integration.test.ts` - "does not recreate a post-it its author withdrew, when the queued send retries" - walks the real sequence: the send lands, its answer is lost so the item stays queued, the author removes their own Post-it from the open Round as FR3 permits, then the queue drains. Confirmed RED against the unguarded code by removing the `not exists` clause - the retry answered with a recreated Post-it, `AssertionError: expected { ...(6) } to be null` - then GREEN with it restored. The board is read as the room reads it (`boardSeenBy`), not only as a row count. An earlier revert attempt via regex silently failed to match and produced a false green; that was caught and redone as an exact edit before the red was accepted. Verified independently: typecheck exit 0, lint exit 0, 1191/1191 tests across 72 files (baseline 1190), build clean.
