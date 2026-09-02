# Reconciliation Ledger

> Durable, greppable record of deliberate spec-vs-code drift. Entries are written by implementation and remediation skills and transitioned by review / remediation. See `reconciliation-ledger.md` for the schema, stable-ID derivation, status lifecycle, and match/recurrence/escalation rules.

## Entries

### docs/specs/facilitator-board-and-categorisation/s07-the-projected-board-view.md:spec-stale:display-bundle-carried-the-authenticated-client
- Status: CLOSED
- Class: spec-stale
- Stale targets: –
- Source run: exec-plan-s07-the-projected-board-view-2026-09-01T23:04:46Z-16bf9aac
- Recurrence: 1
- Falsifier: –
- Override reason: –
- Created: 2026-09-01
- Updated: 2026-09-01
- Notes: The display bundle imported the whole authenticated API client for one anonymous GET, putting `castVote`, Join Code and Membership helpers into a 195 kB chunk a room machine downloads over an anonymous link. No vote data was ever exposed, but the story's own Structural Criterion was false and both guards read file *names* rather than the import graph. Fixed by splitting `api/client.ts` into `request.ts` and `board.ts` with `client.ts` re-exporting both, so every existing importer is unchanged. Verified against the built artifact: 5,754 bytes, with none of `castVote`, `joinCode`, `Membership`, `ballot`, `conferences` or `setTokenSource` present.

### docs/specs/facilitator-board-and-categorisation/s07-the-projected-board-view.md:design-changed:projected-legibility-floor
- Status: CLOSED
- Class: design-changed
- Stale targets: –
- Source run: exec-plan-s07-the-projected-board-view-2026-09-01T23:04:46Z-16bf9aac
- Recurrence: 1
- Falsifier: –
- Override reason: –
- Created: 2026-09-01
- Updated: 2026-09-02
- Notes: S01's settled overflow decision guaranteed nothing became unreachable but named no legibility floor, so an in-ceiling skewed Board (80 of 200 in one Category) drew Post-its at ~0.2px – a grey band beside a count pill. Owner decided 2026-09-01 to floor it at `0.7rem` and have a region that cannot draw its Post-its at that size state what it holds instead. `design-decisions.md` carries a dated amendment; the original prose is byte-intact. Date corrected 2026-09-02 (gap review G23): this note read "2026-09-02" against `Created:`/`Updated: 2026-09-01`, the FIS run heading `Run: 2026-09-01`, and all three date statements in `design-decisions.md`. The owner decided on **2026-09-01**; the source run began `2026-09-01T23:04:46Z`, so a later step of the same run crossed local midnight and recorded the wrong day here.

### docs/specs/facilitator-board-and-categorisation/s07-the-projected-board-view.md:design-changed:answered-5xx-clears-the-projected-wall
- Status: OPEN
- Class: design-changed
- Stale targets: web/src/display/DisplayBoardView.tsx:13-14,151-166 (the `error.status > 0` branch and the `UNAVAILABLE` / `UNAVAILABLE_DETAIL` constants); docs/specs/facilitator-board-and-categorisation/s07-the-projected-board-view.md:285,289 (M1, recorded in prose only)
- Source run: exec-plan-s07-the-projected-board-view-2026-09-01T23:04:46Z-16bf9aac
- Recurrence: 1
- Falsifier: A component test that stubs `fetchDisplayBoard` to reject with `new ApiError('INTERNAL_ERROR', '…', 500)` after one successful read, and asserts the Board is still rendered and `display-unavailable` is not. That test fails today, which is the entry.
- Override reason: The FIS deliberately did not change this. It is S04's settled decision consumed unchanged (a server's own words must never reach a wall in front of a room), the FIS's own Critical constraint says to branch on whether the response *resolved*, and S07's 5 s poll makes the wrong screen self-healing rather than permanent. The FIS records it twice and says explicitly that reversing it "is worth a decision rather than a quiet change here" – so it is deliberate drift awaiting an owner call, not an omission.
- Created: 2026-09-02
- Updated: 2026-09-02
- Notes: Opened 2026-09-02 by the bundle gap review (G22, G32): the FIS held this only as append-only prose, which is not greppable by class or status and would not surface at the next review. `DisplayBoardView.tsx` routes **every** answered failure – a 500, an nginx 502 during an API restart, a 503 during a rollout – to the same terminal screen as a revoked link: the Board is cleared and the wall reads "This board is no longer available." plus "Ask the facilitator for a new link." The FIS's stated trade is "blanks the wall for one interval"; the shipped behaviour is not a blank wall but **a false assertion plus a call to action**, and acting on that instruction is destructive – issuing a new link revokes the current one in the same transaction (`api/src/rounds/display-link-repository.ts:69`), and the room machine is holding the old URL in its address bar with no way to be told. So a ten-second API blip converts a recoverable outage into an unrecoverable one needing physical access to the room machine to retype a 43-character token. The suggested resolution is to branch on the **code** rather than the status – only `DISPLAY_LINK_UNAVAILABLE_CODE` reaches the "ask for a new link" screen – and let a 5xx keep the Board on screen behind the staleness indicator, which already exists and already says the right thing. Owner's call; recorded OPEN so it is not lost.

### docs/specs/facilitator-board-and-categorisation/s07-the-projected-board-view.md:spec-stale:design-decisions-under-describes-the-projected-surface
- Status: OPEN
- Class: spec-stale
- Stale targets: docs/wireframes/facilitator-board-and-categorisation/design-decisions.md ("The projected view's overflow behaviour" – it names four projected states, and describes the staleness detail as a wall-clock time); docs/wireframes/facilitator-board-and-categorisation/projected-board-stale.html:266 ("Showing the board as it stood at 15:12"); docs/wireframes/facilitator-board-and-categorisation/page-inventory.md:36-58 (entries 3-6)
- Source run: exec-plan-s07-the-projected-board-view-2026-09-01T23:04:46Z-16bf9aac
- Recurrence: 1
- Falsifier: Count the projected states the shipped surface can reach against the four the wireframe record draws; and grep `web/src/display/**` for a wall-clock staleness string. Six states ship – populated, empty, unavailable, stale, cold-start unreachable, first-paint loading – and the staleness detail is an elapsed age from `web/src/attendee/staleness.ts#stalenessLabel`, never a time of day.
- Override reason: Wireframe authorship is S01's, and S07's Scope & Boundaries does not include redrawing the wireframe record. The FIS overrode the wall-clock wording explicitly and with a reason – a time of day would need a timezone the product deliberately does not carry – and captured the two undrawn states at the projection class instead of drawing them.
- Created: 2026-09-02
- Updated: 2026-09-02
- Notes: Opened 2026-09-02 by the bundle gap review (G22): the FIS recorded this as F3 in two "NOTICED BUT NOT TOUCHING" runs and nowhere else, so it was not greppable by class or status. The legibility-floor third of F3 is closed (`design-decisions.md` now carries the dated amendment); these two thirds stand. Evidence for both undrawn states is now in version control beside the wireframes: `docs/wireframes/facilitator-board-and-categorisation/screenshots/display-board-projection-1920-unreachable.png` and `-loading.png`. Resolving this means either redrawing the two states and the staleness sentence into S01's set and re-validating it, or accepting the captures as the record for those two states – an S01 authorship call, not a code change.

### docs/specs/facilitator-board-and-categorisation/s07-the-projected-board-view.md:code-defect:g31-sql-guard-self-test-vacuous
- Status: OPEN
- Class: code-defect
- Stale targets: –
- Source run: review-gap-facilitator-board-and-categorisation-rereview-2026-09-02T06:23:51Z-88556a43
- Recurrence: 1
- Falsifier: –
- Override reason: –
- Created: 2026-09-02
- Updated: 2026-09-02
- Notes: G31 (source: `facilitator-board-and-categorisation-gap-review-claude-2026-09-02-rereview.md`). The display route's table allow-list was widened to read single- and double-quoted SQL as well as backticked, then narrowed to statement-shaped strings after the widening surfaced a false positive (`'…did not come from Google.'` read as a table named `google`). Two problems remain, both found by the re-review. **The self-test written to prove the widening is vacuous**: it asserts the extractor sees `from category` in `category-repository.ts`, but that phrase also appears in seven *backticked* statements there, so deleting the entire `quotedSql` half – a complete revert of the fix – leaves it green. **And the narrowing re-blinded the guard**: a fragment constant, a parenthesised subquery, a statement opening with a comment, and a tail fragment spliced into a template literal are all invisible, including the codebase's own `NOT_DISCARDED` fragment at `api/src/rounds/post-it-discard-repository.ts:56`, which sits on the display route's own module closure. **Revert-recipes proving the gap is real** (these are not withdrawal falsifiers – the entry is OPEN): for the vacuous self-test, delete `quotedSql` and its use and the self-test still passes; for the blindness, add a single-quoted fragment naming a vote table without a leading verb and the guard stays green. Same guard-narrowness class as G07, which is also unremediated. Left OPEN deliberately – the owner scoped the second remediation pass to the credential leak only.
