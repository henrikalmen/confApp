# S09 Live Schedule Editing — Mixed Review (code + gap)

**Date**: 2026-08-18
**Review mode used**: mixed
**Resolved chain**: code → gap (dispatched as one flat batch, plus guardrails and an adversarial Critic pass)
**Target**: `docs/specs/conference-setup-and-schedule/s09-live-schedule-editing.md` and the S09 implementation
**Implementation root**: `C:\git\confApp` (commit `1a52748`, worktree clean)
**Source Trust**: trusted-local
**Reconciliation Ledger**: none present
**Intent Context**: the FIS's `## Feature Overview and Goal` — Intent plus Expected Outcomes OC01–OC05

---

## Verdict

**NOT READY.** The story's headline guarantee — *"a concurrent save never silently wins"* (OC03) — is broken, and the failure was reproduced empirically, not merely argued. S09 is currently marked `done` in `plan.json` with all 32 FIS checkboxes `[x]`; those marks are not earned.

| | Count |
|---|---|
| CRITICAL | 1 |
| HIGH | 5 |
| MEDIUM | 12 |
| LOW | 9 |

`CONVERGED`: no — a new CRITICAL `code-defect` appeared in this pass.
`Auto-Remediation: PENDING`

**Guardrails Coverage**: `7 checked, 0 findings` — statelessness, plain PostgreSQL (S09 adds no migration), no push surface, responsive CSS, `sub`-keyed identity, no committed credentials, wall-clock values compared as strings. All satisfied.

---

## CRITICAL

### C1 — Optimistic concurrency is check-then-act: two concurrent saves both win

**Severity** CRITICAL · **Confidence** 100 · **Class** code-defect · **Routing** Fix
**Location** `api/src/routes/sessions.ts:353-384` and `:409-434`; `api/src/sessions/session-repository.ts:202-229`; `api/src/routes/conferences.ts:242-276`; `api/src/conferences/conference-repository.ts:335-341`

**Threatened invariant** OC03 and Acceptance Scenario S03 — "A concurrent save never silently wins."

**Finding** The precondition is evaluated against a row read in a *separate* round trip from the write, and the UPDATE carries no version predicate. `findById` → `assertWritePreconditions` (in-process string compare) → `sessions.update`, with no transaction, no `SELECT … FOR UPDATE`, and `where id = $2 and conference_id = $1` — no `and last_updated_at = <base>`. `conference-repository.updateDetails` has the identical shape.

**Evidence — reproduced.** Two `PATCH`es issued with `Promise.all` from the same base against real PostgreSQL, six runs:

```
200/409  row={"start_time":"09:30","location":"Room B"}
200/409  …
200/409  …
200/409  …
200/200  row={"start_time":"09:30","location":"Room B"}   ← both accepted
200/409  …
```

Run 5: both saves returned **200** from the same base value. One Admin's edit is gone and they were told it succeeded. Last-write-wins is reachable in exactly the window the mechanism exists to close.

**Why the suite misses it** Every test in `api/test/schedule-concurrency.integration.test.ts` is strictly sequential — the second save is issued only after the first has fully resolved. Nothing in `api/test` issues two overlapping writes. The suite proves the *serialized* case and the *truncation* trap (genuinely, with microsecond precision pinned at `:280-293`); it cannot see interleaving.

**The pattern already exists in this codebase.** `session-repository.remove` (`:231-243`) takes `select … for update` on the conference row precisely because "checking then deleting in two round trips would let two concurrent requests each see two Sessions and each remove one." That reasoning applies unchanged here and was not applied.

**Suggested fix** Push the precondition into the write: `update sessions set … where id = $2 and conference_id = $1 and last_updated_at = $base`; zero rows affected ⇒ re-read and throw `EDIT_VERSION_CONFLICT` with the current representation. Same for `updateDetails`, and add the predicate to the `delete … returning id` inside the transaction `remove` already holds.

**Verification needed** A `Promise.all` two-PATCH test asserting exactly one 200 and one 409. Run it repeatedly — the interleaving is timing-dependent (~1 in 6 locally).

---

## HIGH

### H1 — The envelope binds a newer watermark to an older session list, so a change can become permanently invisible

**Severity** HIGH · **Confidence** 95 · **Class** code-defect · **Routing** Fix
**Location** `api/src/routes/attendee.ts:158-159`; same shape at `api/src/routes/sessions.ts:269-270`

```ts
const schedule  = await sessions.listForConference(conference.id);  // read 1
const watermark = await sessions.scheduleWatermark(conference.id);  // read 2
```

Two statements, no transaction. An edit committing between them produces an envelope carrying the **post-edit watermark** over the **pre-edit session list**. The client stores exactly that value as its comparison basis (`AttendeeSchedulePanel.tsx:205`), so every later poll compares equal and refetches nothing. The change never arrives — silently, until some unrelated edit moves the watermark again.

**Scope note** These two lines predate S09 (S06 wrote them, carrying the watermark without acting on it). S09 is what makes them load-bearing: it turned a latent inconsistency into a silent data-loss path. It is in scope because the story depends on the ordering being safe.

**Suggested fix** Read the watermark **first**. A stale watermark is safe — it costs one wasted refetch; a fresh watermark over a stale list is not. Or read both in one `REPEATABLE READ` transaction.

### H2 — A poll in flight across a conference switch renders the wrong conference's schedule

**Severity** HIGH · **Confidence** 95 · **Class** code-defect · **Routing** Fix
**Location** `web/src/attendee/AttendeeSchedulePanel.tsx:193-236` (fetches at `:199`, `:207`; swap at `:218-224`)

`syncIfChanged` calls `fetchScheduleWatermark` and `fetchAttendeeSchedule` with **no `AbortSignal`** — though both accept one, and every other fetch in the file threads a controller — and performs no post-`await` check that `conferenceId` is still the selected one before `setPhase`. Effect cleanup clears only the interval and listeners.

Three concrete outcomes: (a) conference A's envelope renders under conference B's name; (b) `renderedRef` then holds A while `conferenceId` is B, so the next poll diffs `diffSchedule(A, B)` and the banner announces every session of A as removed and every session of B as added; (c) the same window after `handleLeft()` repaints the schedule of the conference the attendee just left, with `conferenceId === null` so the loop can never correct it.

`diffSchedule` never compares `previous.conference.id` to `current.conference.id` — worth guarding, since S10 will apply it to a *cached* envelope where the mismatch risk is higher.

**Suggested fix** Own an `AbortController` in the poll effect, thread its signal into both fetches, abort on cleanup, and guard the swap with an identity re-check. Reset `pollingRef.current` in cleanup.

### H3 — The Conference detail version conflict is an unrecoverable dead end

**Severity** HIGH · **Confidence** 95 · **Class** code-defect · **Routing** Fix
**Location** `web/src/components/ConferenceDetail.tsx:64-90`

The server does the right thing — `conferences.ts:261` attaches `error.withCurrent(toWire(conference))`, and `client.ts:134` parses it into `ApiError.current`. `saveDetails` never reads it. The base on the next attempt is still `conference.updatedAt` from the **props**, and `onChanged` is called only on success.

So the second Admin reads, verbatim, *"The current version is shown beside your edit – re-apply it and save again."* Nothing is shown beside anything, and pressing Save again resends the identical stale version and is refused identically — forever. The only escape is a full page reload, which the Capacitor shells have no address bar for (a constraint this codebase notes elsewhere). `SchedulePanel` implements the whole recovery correctly; `ConferenceDetail` implements none of it.

### H4 — Publishing breaks the very next session edit with a false lifecycle-race refusal

**Severity** HIGH · **Confidence** 100 · **Class** code-defect · **Routing** Fix
**Location** `web/src/schedule/SchedulePanel.tsx:158-164` (`baseFor`), `:97-116` (`load` deps)

`baseFor` sources `conferenceState` from `schedule.conference.lifecycleState`, fetched once at mount and refreshed only by `load()` after a *session* save. Publishing happens in `ConferenceDetail`, which changes no prop `SchedulePanel` depends on — so the panel still holds `'draft'`.

**Evidence — reproduced.** Seeded a draft, took the organizer's base, published as the *same* Admin, then edited a session with that base:

```
AFTER-PUBLISH EDIT STATUS: 409
{"error":{"code":"CONFERENCE_STATE_CHANGED",
 "message":"This conference was published while you were editing, so your change was not saved.
            It is now published. Reload it to see where that leaves your edit."}}
```

A single Admin working alone is told a colleague changed the conference under them. This is the PRD's primary organizer flow (create → compose → publish → run) breaking on the first post-publish edit — the story's headline capability.

### H5 — The two-timezone Verify clauses are marked `[x]` with no such test

**Severity** HIGH · **Confidence** 95 · **Class** code-defect · **Routing** Note
**Location** FIS TI02 Verify; TI03 second Verify; Testing Strategy bullet 4

The only TZ-varied test in the story is the diff's subprocess probe (`America/Los_Angeles` / `Asia/Tokyo`). Neither *"refreshed times read identically with the client timezone set to UTC-7 and UTC+9"* (TI02) nor *"the rendered text is identical with the client timezone set to UTC-7 and UTC+9"* (TI03) has any test. The substitute is a source grep for `new Date(` / `Intl` over four files, which cannot catch a leak arriving through an imported helper.

The code is currently clean — `instantToMillis` is hand-rolled civil arithmetic — but nothing holds it that way, and this is the story's most explicitly flagged silent-failure mode.

---

## MEDIUM

| # | Finding | Location | Class |
|---|---|---|---|
| M1 | **Staleness measures age since the last *edit*, not the last *successful sync*.** A healthy phone in a hall where nobody has edited since 08:00 reads "Updated 3 hours ago" at 11:00 — identical to a phone with dead wifi. S07's "on recovery the age resets to just now" is false whenever nothing changed during the outage. Note the tension: TI03's text specifies "elapsed age since the envelope's watermark", so the code matches the task while missing the scenario's intent. | `web/src/attendee/staleness.ts:32-53` | ambiguous-intent |
| M2 | **The change banner is replaced, not accumulated.** Two single-field saves six seconds apart: the first announcement is silently overwritten by the second. Consecutive single-field saves are the normal organizer flow, and this is the unannounced swap OC05 exists to prevent. | `AttendeeSchedulePanel.tsx:224` | code-defect |
| M3 | **After `CONFERENCE_STATE_CHANGED` the client keeps sending the stale state**, so every retry is refused identically. The message says "Reload it" and neither panel offers a reload. | `SchedulePanel.tsx:158-207`; `ConferenceDetail.tsx:64-91` | code-defect |
| M4 | **The attendee header, name and Archived badge never refresh.** They read `/me/conferences`, fetched once. A post-publish rename (OC04) reaches the envelope and never reaches the header; an archive mid-session shows no badge. `watermark.state` is returned, typed, and never read — the route comment claims a behaviour that does not exist. | `AttendeeSchedulePanel.tsx:295-311`; `attendee.ts:183-198` | code-defect |
| M5 | **No test drives the DELETE base at all.** Every DELETE in the suite sends a valid current base. Deleting the entire precondition block from the delete path leaves the suite green. | `schedule-concurrency.integration.test.ts:742-767` | code-defect |
| M6 | **The concurrency suite is entirely sequential** — the trap it was written to catch (C1) is the one it cannot catch. | same file | code-defect |
| M7 | **`staleness.ts` has no unit test.** Untested: negative age, the 45 s boundary (which reads "1 minute ago", not "just now"), the hour branch, `null`, and ages over 24 h ("Updated 31 hours ago" — never days). | no `web/test/staleness*.test.ts` | code-defect |
| M8 | **The nested `base` schema still declares `required`**, so an unauthenticated caller with a partial `base` gets 400 before 401 — the exact defect the design note claims to have fixed by lifting `base` out of the top-level `required`. | `sessions.ts:69-77`; `conferences.ts:66-82` | code-defect |
| M9 | **No backoff, and the timer never stops.** `catch {}` swallows failures with no counter; `setInterval` keeps firing and only the *fetch* is skipped while hidden. 100 phones sustain 20 req/s through an outage and hit the API with a synchronized herd on recovery. | `AttendeeSchedulePanel.tsx:225-251` | code-defect |
| M10 | **`conference.updated_at` has no strict-monotonicity guard.** It is `now()` — transaction-start time — where the sessions trigger deliberately uses `GREATEST(clock_timestamp(), old + 1µs)`. Only the column's *serialization* was hardened for concurrency, not its *generation*. A no-op detail save also advances it, invalidating every other editor's base for nothing. | `conference-repository.ts:335-341` | code-defect |
| M11 | **The span-orphan check is non-transactional.** A session created on an outside day between the check and the write is stranded anyway — the state TI07 exists to prevent, with neither request refused. | `conferences.ts:273-276` | code-defect |
| M12 | **The `base.conferenceState` contract extension belongs in the FIS body, not an Observation.** The Technical Overview still describes the pre-implementation design. It also introduces a client-declared trust input: a caller echoing the current state suppresses the lifecycle-race refusal (the archive half still bites via `assertEditable`; the publish half does not). | FIS Technical Overview vs. `write-preconditions.ts:25-45` | design-changed |
| M13 | **Integration tests skip silently without a database.** `npm test` on a clean checkout is green while S03–S06's server-side proofs (27 tests) never execute. Pre-existing pattern, already logged in the S06 review. | `describe.skipIf` at both integration suites | code-defect (pre-existing) |

---

## LOW

| # | Finding | Location |
|---|---|---|
| L1 | A malformed `lastUpdatedAt` throws inside render (`instantToMillis` throws; `stalenessFor` is called unguarded in the component body), blanking the panel S07 specifies must never blank. | `AttendeeSchedulePanel.tsx:290`; `staleness.ts:33` |
| L2 | `diffSchedule` silently drops a session whose id appears on two days — `Map.set`, last wins, no collision check. S10 will call this on a cached envelope where the invariant is weaker. | `schedule-diff.ts:58-66` |
| L3 | `baseFor` falls back to `'draft'` when no schedule is loaded, fabricating a lifecycle observation the client never made. | `SchedulePanel.tsx:158-164` |
| L4 | A delete refused as a version conflict shows the *edit* sentence ("re-apply it and save again") with nothing to re-apply, and never reloads. | `SchedulePanel.tsx:212-225` |
| L5 | `ApiErrorEnvelope` does not declare the `current` field the parser reads, so its "mirrors api/src/errors.ts" claim is now false. | `client.ts:5-11` vs `:134` |
| L6 | Stale doc comment on `PATCH /conferences/:id` still says the base-version check and span-orphan refusal are "deliberately absent — both are S09's" — eleven lines above both implementations. | `conferences.ts:227-235` |
| L7 | Structural Criterion 1's "exactly one implementation" is proved by a two-token grep any re-implementation naming a different error code would evade. `outsideSpan` already computes the same containment predicate. | `live-editing-structure.test.ts:47-55` |
| L8 | S01's "staleness indicator resets to just now" clause is not asserted in the S01 test (covered only in the S07 test). | `AttendeeScheduleRefresh.test.tsx:150-182` |
| L9 | Four negative-grep assertions pass vacuously against a deleted module; the check-order assertion is `indexOf` on source text, not runtime behaviour; and `not.toMatch(/updatedAt|updated_at/)` passes only because `lastUpdatedAt` capitalises the U. | `live-editing-structure.test.ts:78,139,164,174`; `AttendeeScheduleRefresh.test.tsx:507,523` |

---

## Explicitly checked and clean

- **"What We're NOT Doing" fully respected.** Repo-wide grep for `apns|fcm|firebase|device_token|push_*|web-push|debounce`: zero hits outside negative test assertions. No notification record, no debounce, no trivial-edit exemption (description edits *are* reported), no cache, no second payload or delta format, no merge/field-level conflict resolution.
- **The S10 export contract holds.** `diffSchedule(previous, current): ScheduleDiff` is genuinely exported, pure, immutability-proven, and takes exactly the envelope shape S10 will hold cached. Not forked.
- **Forged and wrong bases are all handled.** A base from another session mismatches; a session id from another conference 404s (query scoped by `conference_id`); an invented lifecycle state fails `isLifecycleState` → 400; an omitted base is refused, never force-written; a client echoing `archived` to dodge the state check still hits `assertEditable`. The `loadWritable` → `loadAuthorized` swap did **not** drop the archived guard.
- **The client's poll basis is correct.** It compares against the envelope's own `lastUpdatedAt`, not the last polled value — so an edit landing between the client's two reads is already inside the refetched envelope. (This is the client half; H1 is the server half of the same guarantee.)
- **S01/S02 propagation proofs are genuine.** Asserted on an already-rendered view with only timer advancement in the body — removing the poll loop fails them.
- **S03's base values are genuine** — two distinct values from the real column, microsecond precision explicitly pinned. Not stubbed.
- **Scope creep: none.** The Conference detail edit form is required by TI11 and OC04 and reuses `ConferenceForm`. `base.conferenceState` is mechanically necessary for S04's publish half — though see M12 on where it should have been recorded.

---

## Coverage Matrix (condensed)

| Surface | Falsifier attempted | Result |
|---|---|---|
| S01 room change, no reload | poll removed → fails | finding (H5, L8) |
| S02 add + delete, delete alone | both halves genuine | finding (M13) |
| S03 two Admins, second refused | **parallel saves** | **finding (C1)** |
| S04 lifecycle wins, both halves | doubly-stale ordering | finding (H4, M12) |
| S05 span shortening + recovery | whole scenario covered | covered |
| S06 day containment, one impl | grep evadable | finding (L7) |
| S07 failed refresh keeps content | age genuinely increments | finding (M1) |
| S08 told what changed, no push | all three And-clauses | covered |
| SC1 one validation impl | second predicate in `outsideSpan` | finding (L7) |
| SC2 lifecycle before version | both directions proved | covered |
| SC3 watermark = 2 scalars, stateless | `state` dead client-side | finding (M4) |
| SC4 envelope replaced in place | no delta format | covered |
| SC5 exactly one diff, exported | tree-walked uniqueness | covered |
| SC6 no `Date` on wall-clock | no TZ-varied render test | finding (H5) |
| SC7 elapsed age, never clock time | branches untested | finding (M1, M7) |
| SC8 `updated_at` base / watermark poll | both directions proved | covered |
| SC9 three distinct codes | asserted | covered |
| SC10 caller / authz / plain SQL | all routes via `withAuth` | covered |
| SC11 responsive at 3 widths | 6 Playwright captures, overflow ≤ 0 | covered |

---

## Recommended next steps

1. **Fix C1 first.** It is the story's reason for existing, and it is reproducible.
2. **H1 and H4 are both silent-wrongness** — a change that never arrives, and a false conflict for a solo Admin. Neither surfaces as an error.
3. **H2 and H3** are recovery-path defects: the UI instructs an action that cannot succeed.
4. **Correct the status.** `plan.json` records S09 `done` and all 32 FIS checkboxes are `[x]`. Those should not stand while C1 is open.

---

## Remediation Status

Three passes, and the story is closed. Pass 1 fixed the original CRITICAL and four HIGHs; pass 2
fixed three HIGHs it had introduced, and introduced one more. **Pass 3 closed every remaining
finding, found one new defect of its own — in its own fix, caught before it shipped rather than by
the next reviewer — and then earned the four FIS checkboxes that were still being asserted.**

Every fix in pass 3 was falsified: the fix was reverted, the test was watched going red, and the fix
was restored. That check is recorded per finding below, because a green test written beside its own
fix has proved nothing here six times already.

### Original findings (from this report)

| Finding | Status | Evidence |
|---|---|---|
| **C1** concurrency check-then-act | **RESOLVED** (pass 1) | Version predicate in the write: `and last_updated_at = $10::timestamptz`, `and updated_at = $5::timestamptz`, and an in-transaction comparison in `remove`. Falsified: neutralising it fails the 10-round parallel race at round 0 with `[200, 200]`. |
| **H1** watermark read after the data it covers | **RESOLVED** (pass 1) | Watermark read immediately after authorization, before the Conference row and the Session list. Every read is stale-low, which self-corrects. Now guarded on **both** routes — see R13. |
| **H2** poll not scoped to its conference | **RESOLVED** (pass 2) | AbortController owned by the poll effect plus three post-await identity guards; the test holds the refetch open across the switch. Pins the pair rather than either mechanism. |
| **H3** conference conflict dead end | **RESOLVED** (pass 3) | `EDIT_VERSION_CONFLICT` recovery works; the archive case that pass 2 made *worse* is fixed and tested (R7), and the two-step version-then-publish variant with it (R8). |
| **H4** publish breaks the next session edit | **RESOLVED** (pass 1) | `lifecycleState` threaded as a prop; falsified by reverting. Pass 3 kept it intact — an early attempt at R9 that read the state from the composition payload instead would have regressed exactly this test, which is how it was caught. |
| **H5** two-timezone Verify clauses unearned | **RESOLVED** (pass 3) | The test TI02 and TI03 ask for now exists: the refreshed Schedule, day heading, banner and staleness age rendered under UTC-7 and UTC+9 and compared. **Falsified**: a `toLocaleTimeString` in `timeRange` makes the two readings disagree — `03:30–05:00` against `18:30–20:00`. |

### Pass-2 findings

| # | Severity | Status | Evidence |
|---|---|---|---|
| R1 stale-high envelope | HIGH | **RESOLVED** | See H1. |
| R2 delete/edit deadlock → 500 | HIGH | **RESOLVED** | `40P01` retried once in **both** `db.transaction` and `db.query`. |
| R3 `CONFERENCE_STATE_CHANGED` dead end | HIGH | **RESOLVED** | Conference path via R7/R8; Session path via R9. |
| R4 malformed version → 500 | MEDIUM | **RESOLVED** | See R10. |
| R5 four vacuous tests | MEDIUM | **RESOLVED** | The fourth is R11. |
| R6 three LOWs | LOW | **RESOLVED** | |

### Pass-3 findings

| # | Severity | Status | Fix, and the falsifier that proves it |
|---|---|---|---|
| **R7** archive-mid-edit loses the message and the typed values | **HIGH** | **RESOLVED** | `ConferenceDetail` captures the submitted details and the refusal into `abandoned` before lifting the archived Conference, and renders them outside the form — the one refusal whose form does not survive to show it. **Falsified**: removing the capture fails *"keeps the refusal and the typed values on screen after the form is gone"*. |
| **R8** stale `conflict` walks the base backwards | MEDIUM | **RESOLVED** | `setConflict(null)` on `CONFERENCE_STATE_CHANGED`, so `basis` falls back to the lifted Conference. **Falsified**: removing it sends the pre-publish version on the third save — `expected '…10:05:00.654321Z' to be '…10:09:00.111111Z'`. |
| **R9** the same dead end on the Session write path | MEDIUM | **RESOLVED** | `SchedulePanel` re-reads the composition view after a lifecycle refusal and holds the result in `observedState`, which overrides the prop until the parent learns something newer. Deliberately **not** the same mechanism as the Conference path: the panel owns its own payload, the parent owns the Conference. **Falsified**: reloading without recording the state still sends `draft` on the retry. |
| **R10** calendar-invalid version → 500 | MEDIUM | **RESOLVED** | `isRealInstant` range-checks the fields, including days-in-month, before the value reaches `$n::timestamptz`. Checked field by field rather than through `Date`, which accepts `2026-02-30` and rolls it into 2 March. **Falsified**: both new cases return 500 without it. |
| **R11** monotonicity test could not fail | MEDIUM | **RESOLVED** | Rewritten around a **held row lock**, which is the only place the property was ever at risk: a transaction takes the lock, a publish begins and blocks (capturing its `now()` before the wait), the holder stamps a later value and commits. **Falsified**: with `now()` the column moves backwards — `2026-08-19T14:45:07.918319Z vs …07.979714Z`. |
| **R12** `conference.updated_at` guarded in 1 of 4 writers | MEDIUM | **RESOLVED** | One `ADVANCE_UPDATED_AT` fragment, used by all four. **Falsified** twice: behaviourally by R11's test, and structurally by a per-statement guard that fails when any `update conference` omits it. |
| **R13** four LOWs | LOW | **RESOLVED** | (a) the read-order test's session-list half no longer no-ops — each route now names the slice for *both* reads, and reversing the order in `attendee.ts` fails it, which it previously did not; (b) a recovered deadlock logs at `warn`, not `error`, so a handled condition stops paging an operator; (c) `remove` reports a missing Conference as `CONFERENCE_NOT_FOUND` via a new `conference-missing` outcome; (d) the stale `loadWritable` comment in `sessions.ts` corrected. |

### The defect pass 3 introduced, and caught

| # | Severity | Finding |
|---|---|---|
| **R14** | **HIGH** | **R9's recovery re-read could unmount the editor it was rescuing.** `load()` sets `state` to `failed` on error, and the whole editor subtree renders under `schedule !== null` — so a network blip on the *extra* request made right after a recoverable refusal took the open form, the admin's typed values and the refusal message with it. R7's exact shape, on the path added to prevent R7's exact shape. Fixed with a `keepOnFailure` re-read that leaves the panel alone when the extra request fails. **Falsified**: without it the form is gone and the test fails looking for it. |

That is three consecutive passes in which a fix introduced a defect of the same class: **a refusal
that is only rendered inside a component that the refusal's own handling then unmounts.** It is worth
treating as a known trap in this codebase rather than three coincidences.

### Verification

- **740 tests pass** (46 files), up from 729. The integration suites genuinely executed:
  `schedule-concurrency` reports **29 passed**, not skipped, against PostgreSQL on the compose stack.
- `tsc --build`, ESLint and `npm run build` clean. Prettier clean on every touched file; the same
  three pre-existing warnings remain in files this work has never touched.
- **Visual: 59 of 62 pass** at 375 / 768 / 1280 against the freshly built assets, including the
  9 live-editing specs and a new three-width capture of the archived-mid-edit refusal. The 3
  failures are `shell.spec.ts`'s signed-in cases, which need a live API *through the SPA container's
  proxy*; that proxy is returning 502 in this environment while the API answers 200 directly on
  8080. Unrelated to this change set — `shell.spec.ts` covers the app shell and health panel, which
  it does not touch.

### Status artifacts

**S09 is `done` in `plan.json`.** All 32 FIS checkboxes are now earned rather than asserted.

The last four to be earned were TI02, TI03, SC6 and SC7, and one test closed all of them: the
refreshed Schedule, its day heading, its change banner and its staleness age are rendered under
`America/Denver` (UTC-7) and `Asia/Tokyo` (UTC+9) and compared, exactly as both Verify lines ask.
SC9 became earned earlier in this pass, when R10 stopped bare 500s reaching the client.

That test earned its place immediately. The structural grep it sits beside listed four files and
omitted `attendee/schedule-view-model.ts` — the module holding `timeRange`, which formats every
Session time an Attendee reads. A `toLocaleTimeString` planted there passed the grep and was caught
only by the render comparison: Denver read `03:30–05:00`, Tokyo `18:30–20:00`, and the Retrospective
drifted across midnight into the previous day. The grep's file list has been corrected, so both
halves catch it now — but the grep alone would have signed off SC6 on code that shipped the defect
it names.

Two smaller traps worth recording from writing it:

- The helper first *waited* on the new time before capturing each reading. A conversion failed that
  wait inside the helper, so neither reading was ever captured and the cross-timezone comparison
  never ran — a comparison that could not fail, in a test written to prove a comparison. It now
  waits on the room name, which no formatter touches.
- The fixture guards run **after** the comparison and against **both** readings. Two identical empty
  strings satisfy every `toBe` in the test, and so does a conversion that shifts both readings by the
  same fixed amount.

### Recommendation, not a finding

`conference.updated_at` is now stamped correctly by all four writers, but the guarantee lives in four
call sites rather than in the table. `sessions.last_updated_at` solves the identical problem with a
`BEFORE UPDATE` trigger, and the schema says why: *"maintained by the trigger below, never by an
application UPDATE, so no write path can forget it."* Moving `updated_at` to the same shape would
make the fifth writer safe by construction instead of by review. It is a migration and a design call,
so it was surfaced rather than taken.
