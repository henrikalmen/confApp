# Gap Review – Facilitator Board View and Post-it Categorisation

> **Review mode used**: `gap` (single lens)
> **Review target (requirements baseline)**: `docs/specs/facilitator-board-and-categorisation/plan.json` and the bundle it governs – `prd.md`, `s01`–`s08` FIS files, and the eight sibling `*.reconciliation-ledger.md` files
> **Resolved implementation root** (`CODE DIRECTORY:`): `C:\git\confApp`
> **Source Trust**: trusted-local
> **Completed story IDs**: S01, S02, S03, S04, S05, S06, S07, S08 (full-bundle review; `plan.json` reports all eight `done`)
> **Intent Context**: `docs/specs/facilitator-board-and-categorisation/prd.md` (Executive Summary, MVP Boundary, Out of Scope, Constraints, Decisions Log) plus `plan.json` → `overview.summary`, `sharedDecisions`, `bindingConstraints`, `executionNotes`
> **Project Rules Context**: `AGENTS.md`, `docs/guidelines/CRITICAL-RULES-AND-GUARDRAILS.md`
> **Reconciliation Ledger**: eight per-story ledgers, all present. 18 entries – 15 `CLOSED`, 3 `OPEN`
> **Report location**: tier 2, spec-directory match (the requirements baseline is this directory)
> **Date**: 2026-09-02

---

## Executive Summary

Eight stories, three migrations, ~15 new API modules, a new anonymous SPA entry point and a rebuilt
Facilitator sorting surface. **The specified behaviour is correct and unusually well proved.** Four
partition passes and an adversarial Critic pass attacked every acceptance criterion in FR1–FR9 with
named falsifiers, and two passes ran real source mutations. The authority gate, the unraceable
Category cap, the whole-ordering reorder, the 256-bit Display Link, its day bound, its single neutral
refusal across eight distinct failure reasons, the three-way removal semantics and the projected
view's legibility floor all hold, and all are pinned by tests that would genuinely go red.

**Three HIGH findings sit outside that well-tested envelope**, and two of them are the same defect
the story went to unusual lengths to prevent, arriving by a path nobody checked:

- **G29** – a duplicate slash or a case variant in the display URL (`//api/display/<token>`,
  `/API/display/<token>`) misses all three token-protection sites at once, because all three gate on
  the same raw-path `startsWith('/api/display/')`. The live token is echoed verbatim in the 404
  response body and written unredacted to two log streams, where it outlives revocation. Proved by
  injection and re-verified from Fastify's own defaults.
- **G30** – the nginx template redacts `access_log` and never sets `error_log`, so every 502 while
  the API restarts writes the full request line – token included – to container stdout, at 5-second
  poll cadence.
- **G31** – the guard that would catch a vote table reaching the anonymous route extracts **backtick
  SQL only**, under a docblock claiming every statement in the codebase is a template literal. Three
  single-quoted statements in `category-repository.ts`, a module on that very graph, are invisible to
  it. A correct three-quote-style implementation exists in a sibling test file, and
  `docs/LEARNINGS.md:64` already records this exact trap.

Nothing is exposed today by G31 – no vote table is reachable – but it is the fourth recurrence of
"a guard narrower than its name" in this one bundle, and the second recurrence of a trap already
written down.

The review fails on **Completeness**, on exactly one thing after filtering: **a P0 accessibility
criterion is ticked `[x]` and unmet.** S02's Structural Criterion *"Category reorder is fully
operable by keyboard **and assistive technology**"* is checked. The keyboard half ships and is proved
three ways. The assistive-technology half does not exist – not one Category control carries an
accessible name identifying which Category it acts on, while the Post-it controls in the same
component do. Two FIS Implementation Observations runs name this and neither ledgers it.

Two further documentation problems are worth the owner's attention even though the Findings Filter
correctly ruled they do not belong on the Completeness axis:

1. **G01 – a settled design decision the product now contradicts was never amended.**
   `design-decisions.md` still states that permanent removal is *deliberately absent* from the
   discarded-Post-its surface. The owner reversed that on 2026-08-31 and the control shipped. Four
   artifacts still carry the retired position, one of them a literal **PASS** row in a validation
   report. The bundle contains the model for doing this right – the legibility floor got a dated
   `### Amendment` block in the same file; this decision got nothing.
2. **G02 – the other mid-run owner decision cites evidence that is not in version control.** The
   0.7 rem legibility floor names two captures as its whole demonstration; neither resolves from the
   citing document, and both live only in the gitignored repo-root `screenshots/`. A recurrence of a
   defect S01's own ledger already closed once.

**Direct answers to the three questions asked of this review** are in the coverage matrix: the five
mid-run owner decisions are all correctly implemented in code, and four of five are correctly
reflected across every artifact – the exception is the permanent-removal-on-the-discarded-surface
decision (G01). No artifact states a superseded version of the reorder-lock, edit-on-discarded,
legibility-floor or staleness-anchor decisions. The "claimed property with no test that could fail"
shape survives in five places (G04, G05, G17, G25, G31), of which **G31 is HIGH**. The vote-anonymity
guards are strong and caught four of five hostile mutations, but have three real gaps – one HIGH.

Verification was reproduced independently and matches the run record exactly: **92 files / 1552
tests**, **`visual/display-board.spec.ts` 14 + `visual/session-activities.spec.ts` 18 = 32 passed**,
typecheck / lint / build clean. One correction to the run record: `format:check` flags four files,
but one of them – `api/test/display-link.integration.test.ts` – was **created by S04 in this
bundle**, not long-standing.

## Verdict

| Dimension     | Score | Threshold | Status |
|---------------|-------|-----------|--------|
| Functionality | 7/10  | >= 7      | PASS |
| Completeness  | 8/10  | >= 9      | FAIL |
| Wiring        | 8/10  | >= 8      | PASS |

**Overall: FAIL**

CONVERGED: no – new `code-defect` findings at HIGH (G29, G30, G31) and MEDIUM (G03)
Auto-Remediation: PENDING

**Scoring rationale** (post Findings Filter). *Functionality* **7**: the core happy path works and
every specified requirement is met on canonical input; the gaps are a malformed-URL path (G29) and a
proxy-failure path (G30) that between them falsify a named Structural Criterion – minor gaps, not
all-edge-cases-handled. *Completeness* **8**: there are **no stubs, TODOs or placeholders anywhere in
the bundle**; the single deduction is G03, one partially-delivered aspect of a shipped feature, which
is more than "trivial TODOs only" (9) and well short of "features stubbed" (7). The filter's
challenge to an earlier score of 7 was accepted – see § Findings Filter Result. *Wiring* **8**:
everything is connected end-to-end and proved by 1552 tests, 32 visual tests, typecheck, lint and
build; the deductions are verification wiring rather than product wiring – the legibility floor's
gate sits outside `npm test` (G05) and no tsconfig covers any test source (G08).

**One finding stands between this bundle and PASS**: G03. Adding four `aria-label`s to the Category
controls and one `getByRole` assertion – or unticking S02's Structural Criterion and ledgering it –
takes Completeness to 9. The three HIGH findings are real and should be fixed, but they sit on the
Functionality axis, which passes.

Ledger annotations: three `OPEN` entries matched and confirmed still accurate (S02 `accepted-and-ignored-is-inferred-not-observed`, S05 `discarded-list-refused-after-archival`, S08 `held-item-not-captured`); all three route `Note` and are excluded from convergence. One `CLOSED` entry is **partially refuted** – S06 `c1-removal-unreachable-from-the-discarded-post-its-surface` closed the code half and left four documentation artifacts stating the reversed position (G01).

**Findings Filter**: full filter run (>5 findings). See § Findings Filter Result.

---

## Coverage Matrix

Fan-out was used: four vertical partitions by story pair (never horizontal layers), plus an
adversarial Critic pass and an orchestrator pass over cross-artifact consistency and verification.
Rows below are the reviewing pass's own evidence.

### Verification evidence (orchestrator, reproduced)

| surface | evidence read | positive proof | falsifier attempted | result |
|---|---|---|---|---|
| Full unit + integration suite | `npm test` with `TEST_DATABASE_URL` on the WSL interface address | **92 files / 1552 tests passed**, exit 0 | Ran twice, once before and once after sub-agent activity, to prove no reviewer mutated the tree | covered |
| Working tree unmutated by review | `git status --short`, `git diff --stat`, grep for planted `vote`/`poll_result` strings in `board-wire.ts`, `category-repository.ts`, `post-it-repository.ts` | 0 hits; 38 tracked files changed, same as at review start | The S04/S07 partition ran real source mutations; confirmed all reverted | covered |
| Typecheck / lint / build | `npm run typecheck`, `npm run lint`, `npm run build` | all exit 0; display chunk 6.48 kB vs main 111.99 kB | – | covered |
| `format:check` | `npm run format:check` | exits 0 with 4 warnings | **Falsifier**: are all four long-standing? `git ls-files --error-unmatch api/test/display-link.integration.test.ts` → *not known to git*. It is **new in this bundle** (S04) | **finding (G10)** |
| Projected-surface visual gate | `WEB_URL=http://localhost:5401 npx playwright test visual/display-board.spec.ts` | **14 passed** | First attempt failed 17 tests; diagnosed as my own env error (bare `npx vite` omits `--env-file-if-exists=../.env`, so `/config.js` carries no `auth.clientId`). Re-run with the documented invocation: green | covered |
| Facilitator + Attendee visual gate | `… visual/session-activities.spec.ts` | **18 passed**, including *the attendee's board holds at the design ceiling* at 375 / 768 / 1280 px | This is the spec the S08 partition reported as never executed. **Now executed and green** – half of G06's sibling concern discharged | covered |
| Plan status hygiene | `plan.json` `stories[].status` | all eight `done`; every `fis` resolves; eight sibling ledgers present | Checked mid-review after the file changed on disk (S07/S08 were `spec-ready` at review start, updated concurrently) | covered |
| ADR + glossary registration | `docs/DECISIONS.md:24`, `docs/UBIQUITOUS_LANGUAGE.md:32,58-62` | ADR-008 indexed; `Category`, `Board`, `Board View`, `Uncategorised`, `Display Link`, `Permanent Removal`, `Discard` all registered with `Avoid` lists | Checked every term this feature introduces has a glossary row | covered |
| Guardrail: no AI attribution, no `.env`, no repo-root temp files | grep over all new sources and docs for `Co-Authored-By`/`Generated with`/`🤖`/`Anthropic`; `git status` | zero hits; no `.env`; `.agent_temp/` used correctly | – | covered |
| Guardrail: en dashes, not em dashes | `grep -c "—"` across the 10 new feature documents | – | **Falsifier**: are they inside code fences or quoted third-party text? No – ordinary prose | **finding (G09)** |
| Guardrail: `.gitignore` un-ignore for wireframe captures actually works | `git check-ignore -v`, `git status --untracked-files=all` | 13 captures visible to git; the negation pattern does work | **Falsifier**: are the two captures the 2026-09-01 amendment cites among them? **No** | **finding (G02)** |

### Owner decisions made mid-run (orchestrator, the caller's named concern)

| surface | evidence read | positive proof | falsifier attempted | result |
|---|---|---|---|---|
| **Reorder is LWW for the whole ordering; the row lock is in the WRITE and never on the ordering read** | `api/src/rounds/category-repository.ts:341-395` (`renumber`), `:323-339` (`orderingFor`) | `for update` sits inside `renumber`'s `live` CTE, `order by id`; `orderingFor`, `listForSession` and `listForRound` take no lock. A 45-line docblock states the decision and its reason at the site | Would removing `for update` turn any test red? **No** – both race tests park the loser through a gated `Database` until the rival has committed, so the losing statement takes a fresh snapshot and the `live` join alone suffices | **code correct; property unfalsifiable → finding (G04)** |
| ↳ artifacts agree | `s02-….md:275,281,294`; S02 ledger `never-a-blend` (CLOSED); `prd.md:670,782` | Chronological run log: the 20:50 UTC observation records the open decision, the 21:40 UTC entry records the owner settling it. Later entry authoritative by convention | Checked for any artifact stating the superseded position as current | covered |
| **An author may correct their own Post-it while it is discarded** | `api/src/rounds/post-it-repository.ts:647-681` – predicate is `p.author_sub = $5 and r.state = 'open'`, no not-discarded conjunct, with the owner decision documented in the docblock | Pinned by `api/test/discard.integration.test.ts:1089`, asserting all four halves: edit returns 200, the discarded list shows the new text, it is not restored, and no Board read returns it | Adding `and NOT_DISCARDED` to the predicate makes the UPDATE match zero rows → falls into `diagnose` → non-200 → `expect(200)` red. **Genuinely pinned** | covered |
| ↳ artifacts agree | grep of `docs/`, `api/src`, `web/src` for any statement that an author cannot correct a discarded Post-it | Nothing asserts the superseded position | S05 FIS `:261` still records the question as undecided, superseded 10 lines later at `:271` in an append-only log | **finding (G26, LOW)** |
| **Permanent removal is offered on the discarded surface as well as the Board** | `web/src/activities/DiscardedPostIts.tsx:312-332` renders `PermanentRemovalControl` + `PermanentRemovalConfirmation` per discarded Post-it, inside the surface's `canRun` block; rationale in the file's docblock | Reachability proved by a UI-driving test, not an API test: `web/test/PostItPermanentRemoval.test.tsx:440` toggles the surface, tabs to the control, confirms, and asserts zero `/restore` calls – the content never goes back in front of the room | **Falsifier: does any artifact still state the superseded position?** `design-decisions.md:96`, `discarded-postits.html:264`, `page-inventory.md:77-78`, `validation-report.md:113` **all four still say the control is deliberately absent** | **finding (G01, MEDIUM)** |
| **The projected view's 0.7 rem legibility floor** | `web/src/display/display.css:260` `--display-post-it-floor: 0.7rem`; `web/src/display/DisplayBoardView.tsx:367-383,449-453`; `web/src/display/board-layout.ts:71-96` | A region that cannot draw **all** its Post-its at or above the floor draws none and states `N post-its – too many to show at this size` at `clamp(0.85rem,0.95vw,1.8rem)` ≈ 18.2 px, well above the 11.2 px floor. Category name, count pill and boundary sized independently (`display.css:117-142`) | Both sides of the line proved separately in one layout: `visual/display-board.spec.ts:508-582` – 13 draws all 13, 14 draws none and states its count, reading both lengths back off the DOM. `:453` asserts `belowFloor` empty across three skew fixtures | covered |
| ↳ does the floor's proof run? | `vitest.config.ts:5` projects `['api','web']`; `package.json:27,32`; no `.github/workflows/` | The assertions are real, but they live only under `npm run screenshots`. Deleting `drawsPostIts` leaves `npm test` (92 files) fully green | Confirmed by the partition; `board-layout.ts:95-96` returns `true` when the size cannot be read, so jsdom can never cover it | **finding (G05, MEDIUM)** |
| ↳ artifacts agree | `design-decisions.md:129-132` + `:170-239`; `s07-….md:303-329`; S07 ledger `projected-legibility-floor` (CLOSED) | Amendment is a dated `### Amendment` section with a pointer under the tier table; original prose byte-intact. This is the correct pattern – and the one **not** applied to the S06 decision above | `prd.md:652` Edge Cases still says detail degrades *"before any Post-it becomes unreachable"*; `prd.md:733-737` Open Questions still lists projected-view overflow as open | **finding (G19, LOW)** |
| ↳ cited evidence exists | `design-decisions.md:187,238`; `s07-….md:291,368,370` | – | Resolve `screenshots/display-board-projection-1920-floor.png` and `-skewed-80.png` from the citing directory: **absent**. They exist only at repo-root `screenshots/`, excluded by `.gitignore:13` | **finding (G02, MEDIUM)** |
| **The Attendee's staleness age anchors on the watermark exchange, not the last Board read** | `web/src/activities/SessionActivitiesPanel.tsx:385` (`contactAtRef`), `:545-552` – `noteContact()` fires immediately after `fetchActivityWatermark` answers and **before** the cursor-comparison early return, with the owner decision dated in the comment | Discriminating test exists: `web/test/PostItBoard.test.tsx:1030` answers the watermark on every tick with the cursor never moving, advances the device clock 90 s then 4 min, and asserts the age stays `"Updated just now"` **and** `answersFor('GET', BASE) === 1`. Anchored on the last Board read this reads `"Updated 4 minutes ago"` → red | It polls **twice** and the watermark **never** moves – exactly the case the two anchors disagree on. Paired with `:950` for the opposite case. **Genuinely discriminating** | covered |
| ↳ artifacts agree | S08 FIS Architecture Decision / Constraints & Gotchas / TI06 (all amended); `design-decisions.md:161`; `page-inventory.md:54`; S08 ledger `staleness-anchor` (CLOSED) | No artifact states the superseded anchor | `prd.md:519` says *"the last-read Board remains readable with a staleness indicator"* – the grammatical subject is the Board, not the anchor, so it is ambiguous rather than stale | **finding (G20, LOW)** |
| ↳ the wireframe agrees | `attendee-board.html`; `page-inventory.md:47-58` | – | The wireframe draws **no** staleness indicator at all, while the shipped surface renders `activities-age` and the visual spec asserts it visible and in-viewport at all three widths | **finding (G06, MEDIUM)** |

### Vote anonymity – the caller's second named concern

| surface | evidence read | positive proof | falsifier attempted | result |
|---|---|---|---|---|
| S04 display-route guard, layer (a) name regex | `api/test/display-link-structure.test.ts:339-345` over 4 `DISPLAY_MODULES` incl. `board-wire.ts` | `/\bvotes?\b|ballot|voter|has_voted|tally|poll/i` | mutation: `select count(*) from vote` in `board-wire.ts` | **CAUGHT** |
| S04 guard, layer (b) transitive import closure | same file `:348-380` – walks relative imports from `routes/display.ts`, asserts no reached filename matches `/vote|ballot|poll/i`, that `board-wire.ts` **is** reached and `routes/rounds.ts` is **not** | closure = 11 modules | mutation: `join vote t` in `category-repository.ts` (outside `DISPLAY_MODULES`) | **CAUGHT** by layer (c) |
| S04 guard, layer (c) SQL table allow-list | same file `:395-460` – extracts every table named by every module in the closure, subtracts CTEs, checks against a 9-name written allow-list, with anti-vacuity assertions | this layer exists **because** a prior review found `round-repository.ts` passing a filename filter while querying `round_option` | mutations: `left join vote` in `post-it-repository.ts`; new table `poll_result` in `board-wire.ts` | **CAUGHT** |
| S04 guard, behavioural half | `api/test/display-link.integration.test.ts:786-830` – real Poll, 3 cast ballots verified by `select 1 from vote` (`rowCount===3`), then both the resolved and the refused body checked | a real HTTP response shape, not source text | – | covered |
| **Residual blind spot (a)** | – | – | mutation: `select p.id, p.vote_count from post_it p` in `category-repository.ts` – no new table name, and the file is outside the name-regex scope; the body regex `\bvotes?\b` fails on `vote_count`/`voteCount` because `_`/`C` are word characters | **NOT CAUGHT → finding (G07a)** |
| **Residual blind spot (c)** | `api/test/display-link-structure.test.ts:364,578` vs `web/test/display-structure.test.ts:81` | – | the API-side closure walk matches `/from '(\.[^']+\.ts)'/g` – **single quotes only**. A double-quoted import drops a module out of the closure the allow-list is computed over. The web-side walk was widened to `['"]` during S07; the API-side one was not, and the S07 FIS says so and leaves it | **finding (G07c)** – mitigated by Prettier's single-quote rule, not by the guard |
| S08 / Attendee-Board guard | `api/test/post-it-structure.test.ts:597-627` over `board-wire.ts`, `category-repository.ts`, `post-it-repository.ts`, `post-it-discard-repository.ts`, `web/src/api/board.ts`, **plus** the extracted Post-it branch of `toRoundWire` (extraction asserted found and >40 chars, so it cannot silently return empty) | `routes/rounds.ts` is deliberately scoped out with a written reason – it legitimately serves the Poll surface – and covered behaviourally instead | 19 candidate field names simulated against both regexes. `voteCount`, `votes`, `tally`, `pollTally`, `hasVoted`, `option_id`, `voterMarker` caught; `choiceCounts`, `pollResults`, `results`, `selectedChoice`, `answerCounts`, `score`, `sentiment` **escape both halves** | **finding (G07)** |
| S08 guard, behavioural half | `api/test/post-it.integration.test.ts:1419` – walks every key at every depth of a real Attendee's real Session read, filters `/vote\|ballot\|tally\|option/i` → `[]`, with `keys.size > 10` so an empty sweep cannot pass | a genuine response-shape assertion reaching the `routes/rounds.ts` assembly point the file list excludes | – | covered |
| Built-artifact guard | `web/test/display-build.test.ts:65-104` – walks `import`/`from`/`modulepreload` across every emitted chunk | this exists because the S07 ledger records that **both earlier guards read file names rather than the import graph** and a 195 kB authenticated client shipped to the room machine | – | covered |
| Storage-level guarantee (ADR-006) | `db/migrations/20260902*`, `20260903*`, `20260904*` | no new table joins to `vote`; no voter link added anywhere | – | covered |

**Answer to the concern (the caller's second named question):** the guards are **not** materially
narrower than their names, and this is the strongest-guarded property in the bundle. They are
three-layered on the API side, include a real HTTP response-shape sweep over a live Attendee read and
a built-chunk walk over the emitted display bundle, and they **caught four of five hostile source
mutations**. Nothing is exposed today: no vote or ballot table is reachable from the anonymous route
by any path, and anonymity itself is a storage guarantee (ADR-006) that these guards only shadow.

**But the guards do have real gaps, and one is HIGH.** After the Findings Filter struck one
over-broad sub-claim (G07a – the display guard misses a vote-derived column, but the Attendee-board
guard catches it), three stand:

- **G31 (HIGH)** – the display route's table allow-list, the strongest layer, extracts **backtick SQL
  only** while three single-quoted statements sit in `category-repository.ts` on its own graph. This
  is the one that matters: it is the layer that exists because a filename filter already failed once,
  and it can be defeated by quote style alone.
- **G07b (LOW)** – vocabulary: `pollResults`, `choiceCounts`, `selectedChoice`, `answerCounts`,
  `score`, `sentiment` escape both halves of the Attendee-board guard (verified by execution).
- **G07c (LOW)** – the API-side import walk matches single-quoted imports only, so the closure the
  allow-list is computed over is set by a regex rather than by the language.

**All four are the same shape**, and all four were **already known to this bundle**: the S07 ledger
records that two earlier guards read file names rather than the import graph and shipped a 195 kB
authenticated client to a room machine before a review caught it; the S07 FIS records the
single-quote import asymmetry and leaves it; and `docs/LEARNINGS.md:64` already carries *"A
SQL-scanning guard must read all three quote styles"* from S05, with a correct implementation sitting
in `api/test/discard-structure.test.ts:77-83`. The guards got materially stronger during the run.
What did not happen is a final sweep applying the lesson uniformly – so the answer to the concern is:
**not narrower than their names in intent, but narrower in three places in practice, and the bundle
had already written down how to avoid each one.**

### Boundary pass (cross-partition surface – orchestrator)

Fan-out slices vertically by story pair, so the surfaces three or more partitions share get attacked
by none of them. Four were checked directly.

| surface | evidence read | positive proof | falsifier attempted | result |
|---|---|---|---|---|
| One Board projection read by three surfaces, through **two different SQL reads** | `api/src/rounds/post-it-repository.ts:426` (`listForSession`, the Facilitator + Attendee path) and `:451` (`listForRound`, the anonymous display path) | Both interpolate the **same exported constant** `NOT_DISCARDED` (`post-it-discard-repository.ts:56`), and both `order by p.created_at, p.id` | **Falsifier**: could the two reads disagree on which Post-its are excluded, or on order, so the wall and the phone show different Boards? No – one fragment, one ordering, four call sites, and `board-wire.ts` adds no filtering of its own | covered |
| Permanent removal advancing the watermark | `db/migrations/20260828120000000_post-it.sql:154-157` | `post_it_advances_activity_watermark` fires `AFTER INSERT OR UPDATE **OR DELETE**`, so S06's hard delete moves the cursor without S06 adding a trigger | **Falsifier**: FR5 requires removal to propagate near-live, and S06 adds no migration – is the advance actually there? `permanent-removal.integration.test.ts:548-562` asserts the cursor changes | covered |
| Three stories attaching to one watermark function | `20260828…:132`, `20260902…:182-185`, `20260904…:150-154` | All three attach to the **same** `advance_round_activity_watermark()`; none copies it. Category and Discard each add a trigger on their own table; placement needs none, being an UPDATE on `post_it` | ADR-007 untouched – a Vote still advances nothing (`category.integration.test.ts:1351` asserts this explicitly) | covered |
| Six of eight stories editing `SessionActivitiesPanel.tsx` | the file, plus `plan.json` → `executionNotes` (which sequences W3 as S03-then-S04 for exactly this reason) | Typecheck, lint, build and 1552 tests green; the panel's Category, placement, Discard, permanent-removal and Display-Link blocks are separately gated and separately tested | **Falsifier**: the `aria-label` asymmetry (G03) is a real cross-story seam – S03/S05 added labelled controls to the same markup S02 left unlabelled, and no story owned the join | **finding (G03)** |

### Per-story acceptance coverage (partition summaries)

Every FR1–FR9 acceptance criterion, every FIS Acceptance Scenario and every Structural Criterion in
S01–S08 was walked with a named falsifier. Full per-row matrices were produced by each partition;
the material results are folded into the findings below. Summary of what was proved rather than
assumed:

| area | proved by | falsifier that would have caught a fake |
|---|---|---|
| 60-code-point Category name, API and schema agreeing on the unit | `category.integration.test.ts:1303-1313` | 60 astral-plane emoji (122 UTF-16 units) **stored**; 61 refused – which also proves the DB `CHECK` counts code points, since the row lands |
| The 20-Category cap cannot be raced past | `category.integration.test.ts:1012` | a **second real `pg.Client`** holds a transaction open past its insert; the API's COMMIT blocks on it. Genuine concurrency, not two sequential calls |
| Reorder never blends two orderings | `category.integration.test.ts:1113` | two disjoint changed sets; composition yields `Beta,Alpha,Delta,Gamma`, the test asserts `Beta,Alpha,Gamma,Delta` |
| No drag affordance at any width | repo-wide grep → **zero** `draggable\|dragstart\|onDrop\|dragover`; guarded 3 ways plus `visual/session-activities.spec.ts:482` asserting `[draggable]` count is 0 | – |
| End-of-order control is `aria-disabled`, not `disabled` | `CategoryBoard.test.tsx:445` asserts both the attribute present and `disabled` absent, then tabs to it and asserts zero PATCHes; plus a structural guard and a layout assertion at 3 widths | the one claim in the bundle that ships **fully** tested |
| Placement never enters the offline queue | `placement-structure.test.ts:258,272` slice-scoped guards + `PostItPlacement.test.tsx:525` behavioural + `web/public/sw.js` registers no `sync`/`periodicsync` | the panel *does* import the queue for contribution; the guard is slice-scoped and says so |
| Every Board write refuses against an Archived Conference | all four S02/S03 routes traced through `authorizeWrite` → `assertEditable`; `category.integration.test.ts:954`, `placement.integration.test.ts:783` | every `app.post/patch/delete` in `rounds.ts` enumerated; none bypasses |
| Display Link unguessable | `display-link.ts:43` `randomBytes(32).toString('base64url')`; `display-link-structure.test.ts:171-186` asserts minter arity 0, body matches `randomBytes(DISPLAY_TOKEN_BYTES)`, does **not** match `/round\|session\|conference\|postIt\|id\b/i`, and the module names no `createHash\|createHmac\|Math.random` | structural, not sampled – a Round-id-derived value cannot pass |
| A revoked token is never reissued | migration `:112` `token text NOT NULL UNIQUE` – **unconditional**, distinct from the partial `display_link_one_live_per_round … WHERE revoked_at IS NULL` | the partial index alone would not prevent reissue; both regexes asserted separately at `display-link-structure.test.ts:229-232` |
| One neutral message across every failure reason | `display-link.integration.test.ts:885-935` compares **whole responses** – status + all headers minus `date`/`content-length` + body – across **8** cases: revoked, past-day, Draft, deleted-Round, never-issued, non-token shape, `%zz`, `%` | all byte-identical `404 / DISPLAY_LINK_UNAVAILABLE`. The failure type carries **no discriminator**, so the handler has nothing to branch on |
| Day bound, correct comparison direction | `display-link-structure.test.ts:202-206` pins day−5 true, **day itself true**, day+1 false | flipping `>` to `>=` fails the same-day case |
| Anonymous route exemption is not a prefix | `auth/with-auth.ts:107-146` exact `{method,url}` match; `installRouteAudit` throws at startup on any unwrapped or unlisted route; exactly 3 anonymous routes, each with a written reason | POST/PUT/PATCH/DELETE, trailing slash and subpath all mapped to the same refusal, `post_it` rows unchanged (`display-link.integration.test.ts:743-781`) |
| Token never logged | `routes/display.ts:70-73` `redactDisplayToken` in the Fastify serializer; `web/nginx/default.conf.template:19-30` `map` + `log_format confapp` redacting **both** `/display/<t>` and `/api/display/<t>` | S04's own review caught nginx's default `main` format writing a live bearer credential to stdout; fixed, not noted |
| Projected surface takes no input | grep of `web/src/display/**` for `onClick\|onSubmit\|<button\|<a \|href=\|<input\|<select\|<form\|onKeyDown\|role="button"\|tabIndex` → **zero**; `ProjectedBoardView.test.tsx:537-597` dispatches click/Enter/Space at **every** element in all four states and asserts request count unchanged, all GET, `innerHTML` unchanged | – |
| Discard storage is apart from the author-deletion path | `20260904090000000_post-it-discard.sql` adds **no column** to `post_it`; the one `ALTER TABLE post_it` is a `UNIQUE (id, round_id)` supporting the composite FK, reversed on down | `20260902…` does add `category_id` to `post_it` – checked and consistent: it records *where a Post-it is*, `NULL` is the live default, it carries no removal semantics |
| Author delete wins the race, taking the trace | `post-it-repository.ts:700-730` predicate is `author_sub` + `state='open'` and nothing else; FK `ON DELETE CASCADE` asserted in SQL text **and** against `information_schema` | `discard.integration.test.ts:609,1032` assert the row gone, the trace gone, global trace count 0 |
| Admin-only permanent removal, server-side | `rounds.ts:1926-1935` authority → Admin → editable, in that order; `permanent-removal.integration.test.ts:723` – assigned Facilitator gets **403** with the exact Discard-offering sentence, the row still stored, `canRemovePermanently === false` while `canRun === true` | the test calls the endpoint directly, so a UI-only check could not satisfy it |
| The Attendee Board is read-only wrt placement, server-side | `post-it.integration.test.ts:1267` – a Member with no assignment issues place/discard/restore against **her own** Post-it; all three 403, and after **each** the test re-reads `storedPlacement()` and `storedDiscard()` from the table | an envelope-only refusal would not pass |
| One Board projection, not one per surface | `post-it-structure.test.ts:636` asserts `toBoardWire` declared exactly once server-side and `Category`/`Uncategorised`/`PostIt` exactly once client-side, and forbids `.sort(\|groupBy\|.toSorted(` in `web/src/activities/**`, `web/src/display/**`, `web/src/api/board.ts` | a client re-ordering that made the two surfaces disagree |
| Counts are the server's everywhere | `display-structure.test.ts:266`; `PostItQueueing.test.tsx` fixtures deliberately state `postItCount` ≠ `postIts.length` (9 vs 3, 5 vs 2) | a client re-derivation fails the fixture |

---

## Guardrails Coverage

**Guardrails Coverage: 11 checked, 2 findings.**

| Rule (source) | Result |
|---|---|
| Never attribute a vote to a voter; vote anonymity is storage-level (`AGENTS.md` → Do Not / Never; ADR-006) | pass – no new table joins to `vote`; three-layer guards plus a response-shape sweep (see matrix) |
| Never tie the schema to a managed provider's proprietary features (`AGENTS.md`; ADR-003) | pass – three migrations, plain PostgreSQL, no `CREATE EXTENSION`, all reverse cleanly (`category.integration.test.ts:1747`) |
| Never rely on in-process state between requests (`AGENTS.md`) | pass – every repository is a closure over `db`; guarded in `category-structure.test.ts:250`, `discard-structure.test.ts:457`, `permanent-removal-structure.test.ts:155` |
| Never widen offline support beyond schedule reads and Post-it queueing (`AGENTS.md`) | pass – placement, discard, restore and removal all excluded from the queue by slice-scoped guards plus a behavioural test; `sw.js` registers no background sync |
| Never key a user on their email address (`AGENTS.md`) | pass – no new code reads an email; `display-link.integration.test.ts:667-740` asserts no email in any anonymous response |
| Never ship a fixed-width or desktop-only layout (`AGENTS.md`) | pass – 18 session-activities visual assertions at 375/768/1280 incl. the design ceiling, plus 14 at the 1920 projection class; `horizontalOverflow <= 0` asserted, not screenshotted |
| Never commit `.env` files or credentials (`AGENTS.md`) | pass |
| No AI attribution anywhere (`CRITICAL-RULES` → Operational) | pass – zero hits across all new sources, docs, migrations and specs |
| Temp files in `.agent_temp/`, never the repo root (`CRITICAL-RULES` → Operational) | pass |
| Real dates only (`CRITICAL-RULES` → Operational) | **finding (G23)** – the legibility-floor amendment is dated 2026-09-01 in two artifacts and 2026-09-02 in a third |
| En dashes (–), not em dashes (`CRITICAL-RULES` → Operational) | **finding (G09)** – ~185 em dashes across 10 new feature documents |

---

## Gap Analysis Results

Findings are ordered by severity, then by story. `Class` and `Routing` follow the review contract:
`Fix` requires confidence ≥ 75, primary scope, class `code-defect`, and a mechanical, uniquely
determined correction.

### HIGH

All three HIGH findings come from the Critic pass and **all three were independently re-verified by
the orchestrator** before being recorded. Two of the three are the same defect the story went to
unusual lengths to prevent, arriving through a path nobody checked.

#### G29 – A duplicate slash or case variant in the display URL echoes the live token in the response body and defeats all three redactions

- **Reviewer**: Critic, verified by orchestrator
- **Severity**: HIGH · **Confidence**: 100 · **Scope relation**: primary
- **Location**: `C:\git\confApp\api\src\app.ts:74` and `:229`; `C:\git\confApp\api\src\routes\display.ts:71-73`; `C:\git\confApp\web\nginx\default.conf.template:19-23`
- **Finding**: The three places that protect the Display Link token – the not-found branch, the
  framework-error branch, and the log serializer – **all gate on the same raw-path prefix test**,
  `path.startsWith(DISPLAY_ROUTE_PREFIX)` where `DISPLAY_ROUTE_PREFIX = '/api/display/'`
  (`display.ts:54`). A URL with a duplicated slash or a different case misses every one of them,
  falls through to `routeNotFound(request.method, path)` – which interpolates the raw path into its
  message (`errors.ts:430-432`) – and is logged unredacted.
- **Threatened assumption**: S04's Structural Criterion 4 – *"the token must never reach a log
  line"* – and `api/src/routes/rounds.ts:1975`'s claim that it is *"never put in an error message"*.
  `app.ts:60-73`'s own docblock states the purpose exactly: *"`routeNotFound` builds its message from
  the path, which is helpful everywhere else and actively wrong here: the path **is** a bearer
  credential."*
- **Evidence**: The Critic built the real app and injected requests:

  | request | answer | logged as |
  |---|---|---|
  | `/api/display/SECRET` | `404 DISPLAY_LINK_UNAVAILABLE` | `/api/display/<token>` |
  | `//api/display/SECRET` | `404 ROUTE_NOT_FOUND`, **`No endpoint exists at GET //api/display/SECRET.`** | `//api/display/SECRET` |
  | `/api//display/SECRET` | `404 ROUTE_NOT_FOUND`, path echoed | unredacted |
  | `/API/display/SECRET` | `404 ROUTE_NOT_FOUND`, path echoed | unredacted |

  **Orchestrator re-verification**: `api/src/app.ts:211` calls `Fastify({…})` passing neither
  `ignoreDuplicateSlashes` nor `caseSensitive`; `node_modules/fastify/lib/config-validator.js:42-43`
  and `:33-34` show the defaults are `false` and `true` respectively. So Fastify neither collapses
  duplicate slashes nor case-folds, the not-found handler receives the raw path, and all three
  `startsWith` tests fail on it – the leak follows from the code without needing the injection to be
  taken on trust. Trailing slash, query string, `;a=b`, `%2f`, `%zz` and `/extra` **are** correctly
  covered; the hole is specifically slash-duplication and case.
  On the nginx side the redaction map keys on `$request_uri`, which nginx forwards **unmerged**
  through `proxy_pass $confapp_upstream$request_uri` even though it merges slashes for *location*
  matching – so the same request is written in full by the static container too, and
  `//display/<token>` matches `location ^~ /display/` after merging while missing the
  `~^/display/[^/?]+` map entry.
- **Impact**: A live bearer credential over named Post-its is written verbatim into a 404 response
  body – the shape most likely to be captured by client-side error reporting – and into two log
  streams, where it **outlives revocation**. Reachable by anyone who pastes the link into a tool that
  normalises differently, by an intermediary that rewrites paths, or on purpose.
- **Suggested fix**: Normalise before the prefix test at all three sites – compare on a collapsed,
  lower-cased path (`path.replace(/\/{2,}/g, '/').toLowerCase()`) – or, better, stop echoing the
  request path from `routeNotFound` at all. Extend the nginx map to slash- and case-tolerant
  patterns, or replace `$confapp_logged_uri` with an allow-list.
- **Verification needed**: Re-run the injection table; assert `//api/display/X`, `/api//display/X`
  and `/API/display/X` all return `DISPLAY_LINK_UNAVAILABLE` and that `redactDisplayToken` collapses
  all three. Add each as a case to `display-link.integration.test.ts:885-935`'s whole-response
  comparison, which today covers eight shapes and not these.
- **Class**: `code-defect` · **Routing**: **Fix** – the correction is mechanical and uniquely determined by the existing constant.
- **Ledger**: none.

#### G30 – nginx writes the unredacted token to the error log, which the access-log redaction does not cover

- **Reviewer**: Critic, verified statically by orchestrator
- **Severity**: HIGH · **Confidence**: 75 (not executed against a running image) · **Scope relation**: primary
- **Location**: `C:\git\confApp\web\nginx\default.conf.template` (whole file – no `error_log` directive); `C:\git\confApp\web\Dockerfile:22` (`FROM nginx:alpine`)
- **Finding**: The template redacts `access_log` only (`:19-27,39`). `nginx:alpine`'s bundled
  `nginx.conf` sets `error_log /var/log/nginx/error.log notice`, symlinked to stderr, and nginx
  error entries carry `request: "GET /api/display/<token> HTTP/1.1"` plus
  `upstream: "http://…/api/display/<token>"`.
- **Threatened assumption**: The template's own opening sentence – *"The Display Link token must
  never reach a log line (S04, FIS Structural Criterion 4)."*
- **Evidence**: **Orchestrator re-verification**: `grep -rn "error_log"` across `web/` returns
  **nothing**; the only logging directives in the template are the `map`, the `log_format confapp`
  and one `access_log`. The `/api/` block deliberately resolves the upstream per request so *"only
  /api/ calls return 502"* (`:52-57`) – every one of those 502s is an `[error]`-level entry carrying
  the full request line. The room machine polls `/api/display/<token>` every 5 s
  (`web/src/poll/use-watermark-poll.ts:43`), so one API restart mid-conference writes the live token
  to container stdout dozens of times. `web/test/display-build.test.ts:171-190` asserts only the
  `log_format`/`access_log` pair, so this passes green.
- **Impact**: The credential the whole story exists to protect is emitted to whatever aggregates
  container logs, retained by that system's policy, surviving revocation. The failure mode that
  triggers it – API unreachable – is precisely the one the config was written to tolerate gracefully.
- **Suggested fix**: Add `error_log /var/log/nginx/error.log crit;` at server level so proxy-level
  errors stop carrying request lines, and extend `display-build.test.ts` to assert the directive
  exists. Keep operator visibility of 502s through `$status` in the redacted access log.
- **Verification needed**: `docker compose up`, stop the API, request `/api/display/<token>` from the
  static container, inspect `docker logs` for the raw token. **This has not been run** – the finding
  rests on `nginx:alpine`'s documented default and the absence of any override, the same evidentiary
  basis `display-build.test.ts:152-157` already admits for this file (*"Nothing executes this
  configuration"*).
- **Class**: `code-defect` · **Routing**: **Note** – confidence is 75 and the fix should be confirmed against a running image first.
- **Ledger**: none. Closely related to S04's own CLOSED HIGH (*"The nginx access log wrote the token"*) – the same defect, one log stream over.

#### G31 – The display route's table allow-list guard reads backtick SQL only, and its docblock says otherwise

- **Reviewer**: Critic, verified by orchestrator
- **Severity**: HIGH · **Confidence**: 100 · **Scope relation**: primary
- **Location**: `C:\git\confApp\api\test\display-link-structure.test.ts:414-417`
- **Finding**: The guard that enforces *"no table outside the written allow-list is reachable from
  the anonymous display route"* – the layer that exists **specifically because** a filename filter
  was found missing `round_option` – collects statements with
  `[...source.matchAll(/`([^`]*)`/g)]`, **backticks only**, under a docblock asserting *"Template
  literals are where every statement in this codebase is written."* That claim is false in a module
  on the very graph it walks.
- **Threatened assumption**: ADR-006 and the plan's binding constraint FR7/FR8 – the anonymous route
  reaches no vote or ballot table by any path.
- **Evidence**: **Orchestrator re-verification**: `api/src/rounds/category-repository.ts` is in the
  display route's reachable closure, and writes SQL in **single quotes** at `:227`
  (`'select count(*)::int as held from post_it where category_id = $1'`) and `:612`
  (`'update post_it set category_id = $2 where category_id = $1'`). Neither is visible to the
  extractor. The Critic ran the guard's own extraction over that file and got
  `['category','post_it','round']` – the single-quoted `post_it` absent – and, after replacing that
  string with `'select count(*) from vote v join ballot b on b.id = v.ballot_id'`, still got no
  `vote` and no `ballot`.
  **This is a documented trap with a correct implementation next door**: `api/test/discard-structure.test.ts:77-83`
  implements `sqlStringsIn` over all three quote styles, with a docblock saying *"Over-collecting
  costs nothing while under-collecting is the omission that lets one through"*. And
  `docs/LEARNINGS.md:64` already carries the entry **"A SQL-scanning guard must read all three quote
  styles"**, written after S05 hit exactly this.
- **Impact**: No offending table is reachable today, so **nothing is currently exposed**. What is
  broken is the only mechanism that would catch it: a later edit adding a vote or ballot query in a
  single- or double-quoted string to any module on the display graph ships green, on the one route
  that answers without a credential over named Post-its. It also means the four-of-five
  mutation-testing result reported above is weaker than it looks – every caught mutation was written
  into a template literal.
- **Suggested fix**: Replace `statementsIn` with `discard-structure.test.ts`'s `sqlStringsIn`, and add
  a self-test asserting the extractor finds `post_it` in `category-repository.ts:227` – so a future
  narrowing fails loudly rather than silently.
- **Verification needed**: Inject a single-quoted `from vote` into `category-repository.ts`, confirm
  the test now fails, revert.
- **Class**: `code-defect` (test coverage) · **Routing**: **Fix** – copy an implementation that already exists in a sibling file.
- **Ledger**: none. **This is the fourth recurrence** of the guard-narrowness shape in this one bundle, and the second recurrence of an entry already in `docs/LEARNINGS.md`.

### MEDIUM and downgraded-from-MEDIUM

> Findings appear in discovery order. **Four of the six reported here were downgraded to LOW by the
> Findings Filter** and say so on their own Severity line. The authoritative final severities are the
> table in § Findings Filter Result. Surviving at MEDIUM: **G01, G03, G32, G33**.

#### G01 – `design-decisions.md` and three sibling artifacts still forbid the permanent-removal control that shipped

- **Reviewer**: orchestrator + S05/S06 partition (independently found twice)
- **Severity**: MEDIUM · **Confidence**: 98 · **Scope relation**: primary
- **Location**: `C:\git\confApp\docs\wireframes\facilitator-board-and-categorisation\design-decisions.md:96-99`; also `discarded-postits.html:264`, `page-inventory.md:77-78`, `validation-report.md:113`
- **Finding**: The section *"The discarded Post-its surface"* – cited by anchor as required context by
  S05's FIS at `:35` and `:148`, whose heading `design-decisions.md:3` forbids renaming because five
  later stories depend on it – still reads verbatim: *"**What is deliberately absent.** No
  permanent-removal control, and no wording anywhere on this surface that reads as deletion or as a
  removal that cannot be undone. … a Facilitator reaching this page must not find the irreversible
  act sitting beside the reversible one."* The owner reversed this on 2026-08-31 and
  `web/src/activities/DiscardedPostIts.tsx:312-332` now renders exactly that control, with a
  confirmation whose text contains *"cannot be undone"*.
- **Threatened assumption**: That `design-decisions.md` describes the shipped surface and can be
  trusted as the binding source for S05's and S06's UI.
- **Evidence**: `design-decisions.md:96` vs `DiscardedPostIts.tsx:312-332` and `PermanentRemoval.tsx:37-42`.
  `validation-report.md:113` records a **PASS** for *"No permanent-removal control or wording"* – a
  green verification row for a property the product deliberately no longer has.
  `DiscardedPostIts.tsx:32-55` argues the opposite case in its own docblock, so code and design
  record now contradict each other head-on. The S06 ledger entry that closed this carries
  `Stale targets: –`, so the documentation half was never tracked.
  **The asymmetry is the clincher**: the *other* mid-run owner decision in this bundle (the legibility
  floor) got a dated `### Amendment` block in this very file. This one got nothing.
- **Impact**: The next person to work this surface reads a binding design document instructing them
  to remove a control the owner deliberately added, and a wireframe drawn without it. This is the
  original S06 C1 defect – a document contradicting itself about where removal is offered – relocated
  from the FIS into the design artifacts.
- **Suggested fix**: Amend `design-decisions.md:96-99` with a dated amendment block in the same shape
  as the legibility-floor one, stating that permanent removal **is** offered here, gated on
  `canRemovePermanently` within the surface's own `canRun`, beside the restore control and never
  instead of it, carrying OC01's rationale. Update `discarded-postits.html:264` and
  `page-inventory.md:77-78`; re-run the wireframe validation and correct `validation-report.md:113`.
  Add `Stale targets:` to the S06 ledger entry naming all four files.
- **Verification needed**: Re-read the four files; reconcile `web/test/PostItDiscard.test.tsx:322` (G13).
- **Class**: `spec-stale` · **Routing**: **Note** – four documentation artifacts plus a ledger field; the amendment wording is an authoring decision, not a mechanical edit.
- **Ledger**: S06 `c1-removal-unreachable-from-the-discarded-post-its-surface` (CLOSED) – **partially refuted**. The entry closes the code half; the documentation half was left stating the reversed position.

#### G02 – The legibility-floor amendment's sole cited evidence is not in version control

- **Reviewer**: orchestrator + S04/S07 partition (independently found twice)
- **Severity**: **LOW** – downgraded from MEDIUM by the Findings Filter · **Confidence**: 90 · **Scope relation**: primary
- **Filter reasoning**: factually correct, but nothing is *misstated* – `design-decisions.md:180-190` describes the skewed-80 case in full prose and `web/src/display/board-layout.ts:93-96` carries the same reasoning, so the decision is self-supporting. A broken evidence pointer beside an intact argument is LOW.
- **Location**: `C:\git\confApp\docs\wireframes\facilitator-board-and-categorisation\design-decisions.md:187,238`; `C:\git\confApp\docs\specs\facilitator-board-and-categorisation\s07-the-projected-board-view.md:291,368,370`
- **Finding**: The amendment states *"The wireframes in this directory were **not** redrawn … the
  shipped surface plus its projection-class captures are the demonstration of this amendment
  (`screenshots/display-board-projection-1920-floor.png` for the boundary, `-skewed-80.png` for the
  case that prompted it)."* Relative to the citing document that resolves to
  `docs/wireframes/facilitator-board-and-categorisation/screenshots/`, which holds 13 captures and
  **neither of these two**. The real files sit at repo-root `screenshots/`, excluded by
  `.gitignore:13`.
- **Threatened assumption**: That an owner decision amending a settled S01 design decision is
  demonstrable by the evidence it names.
- **Evidence**: `find . -iname "*projection-1920*"` returns only `./screenshots/…`;
  `git check-ignore -v` confirms the exclusion; `ls docs/wireframes/…/screenshots/` returns the 13
  S01 captures and nothing matching. The project already has the correct convention – `.gitignore:18-21`
  un-ignores `docs/wireframes/**/screenshots/**` with the comment *"they are evidence, not
  regenerated build output … cited by the validation report beside them."*
- **Impact**: The single artifact the owner decision points a future reader at is unreachable from
  version control. The amendment's stated demonstration is regenerable-only, and only by someone who
  knows to run `npm run screenshots` and look outside `docs/`.
- **Recurrence**: this is the same defect class as S01's already-CLOSED ledger entry
  *"the validation report's reproduction recipe cannot be reproduced"* – a citation pointing at a
  gitignored path. Second occurrence in one bundle.
- **Suggested fix**: Copy the two cited captures – plus `-unreachable.png`, `-loading.png` and
  `-skewed-40.png` referenced at `s07-….md:291` – into
  `docs/wireframes/facilitator-board-and-categorisation/screenshots/` under the existing un-ignore,
  and correct the citations.
- **Verification needed**: `git ls-files docs/wireframes/**/screenshots/ | grep projection` returns the cited names.
- **Class**: `spec-stale` · **Routing**: **Note** – whether to commit ~1.5 MB of captures is an owner call, not a mechanical edit.
- **Ledger**: none; recurrence of S01 `validation-report.md:spec-stale:…` (CLOSED).

#### G03 – Category management controls carry no accessible name, while the criterion claiming assistive-technology operability is ticked

- **Reviewer**: S02/S03 partition, confirmed by orchestrator
- **Severity**: MEDIUM · **Confidence**: 92 · **Scope relation**: primary
- **Location**: `C:\git\confApp\web\src\activities\SessionActivitiesPanel.tsx:2434-2497` (Rename, Move up, Move down, Remove) and `:2413-2416` (the region markup)
- **Finding**: Every Category control renders bare text – `Rename`, `Move up – to position 1`,
  `Remove` – inside a plain `<li className="region">` whose only name is an `<h5>`. Nothing
  associates a control with its Category programmatically: no `aria-label`, no `aria-labelledby`, no
  `role="group"`. A screen-reader user listing the buttons on a five-Category Board hears twenty
  controls, of which ten (`Rename` ×5, `Remove` ×5) are indistinguishable. The Post-it controls in
  the same component do it correctly – `aria-label={\`Move "${label}" to the destination chosen for
  it\`}` at `:2024` and `aria-label={\`Discard "${label}" from this board\`}` at `:2050` – so the
  inconsistency is internal to one file. The whole panel contains exactly **two** `aria-label`s, both
  on the S03/S05 half. Separately the heading level skips `h3` (`:1164`) straight to `h5`, and no
  `role="status"` announces a successful rename, reorder or removal.
- **Threatened assumption**: S02 Structural Criterion (`s02-….md:115`), ticked `[x]`: *"Category
  reorder is fully operable by keyboard **and assistive technology**"*. PRD NFR Accessibility:
  *"Fully keyboard-operable **and usable with assistive technology**"*. `design-decisions.md:47-58`
  makes this the reason the interaction model is what it is – *"legible to someone reading the
  screen, someone **hearing it announced**, and someone using it one-handed"*.
- **Evidence**: `grep -n "aria-label" web/src/activities/SessionActivitiesPanel.tsx` → 3 hits, two of
  them the Post-it controls, one an `aria-labelledby` on the panel title. `web/test/CategoryBoard.test.tsx`
  contains **zero** `getByRole` or accessible-name assertions – it addresses every control by
  `data-testid`, which assistive technology cannot see. The gap is named in two FIS Implementation
  Observations runs (S02 20:16 UTC: *"the accessibility cluster (M5 – no accessible name identifying
  which Category a control acts on; M6; L10 – the region heading level skips h3 to h5) is the one
  worth taking before S03 builds more controls onto the same markup"*; S03 `:252`: *"this leaves
  S02's M5/M6 accessibility cluster still open"*) and recorded in **neither** reconciliation ledger.
- **Impact**: The 375 px + assistive-technology case is the case the PRD says decides the interaction
  model. The keyboard half ships and is proved three ways; the assistive-technology half is absent on
  the Category half of the only control surface in the feature. Because the criterion is ticked and
  unledgered, this will not be re-detected.
- **Stated fairly** (this is why it is MEDIUM and not HIGH): in **linear document order** the surface
  reads correctly – heading *"Tooling"*, then *"3 post-its"*, then *"Position 2 of 3"*, then the four
  controls – so a screen-reader user reading the page top to bottom has the context, and
  `design-decisions.md`'s requirement that position be *spoken* rather than implied by layout is met.
  The failure is confined to control-list / rotor navigation, which is how a power user on a
  20-Category Board would actually work, and to the two controls whose labels carry no position
  (`Rename`, `Remove`). It is a real shortfall against a ticked P0 criterion, not a surface that
  cannot be used at all.
- **Suggested fix**: Add `aria-label` to the four controls mirroring the pattern already in the file
  at `:2024`/`:2050` – e.g. `aria-label={\`Rename the category "${category.name}"\`}` – or wrap the
  region in `role="group" aria-labelledby={\`category-name-${category.id}\`}`. Then add a
  `getByRole('button', { name: … })` assertion to `CategoryBoard.test.tsx`, or untick the criterion.
- **Verification needed**: A `getByRole`-based assertion against a Board with two Categories, plus a re-run of `web/test/CategoryBoard.test.tsx` and `visual/session-activities.spec.ts`.
- **Class**: `code-defect` · **Routing**: **Fix** – the correction is mechanical, bounded, and uniquely determined by the sibling pattern in the same file.
- **Ledger**: none. Recorded only as prose in two FIS observation sections.

#### G04 – The `FOR UPDATE` row lock the owner's reorder decision turns on is not falsifiable by any test

- **Reviewer**: S02/S03 partition
- **Severity**: **LOW** – downgraded from MEDIUM by the Findings Filter · **Confidence**: 90 · **Scope relation**: primary
- **Filter reasoning**: the claim was verified, not withdrawn – `category.integration.test.ts:1146-1163` parks on `/update category c/` and `:1240-1256` on `/delete from category c/`, and `release()` fires only after the rival's request has been awaited and asserted, so the loser always starts from a post-commit snapshot and `for update` can be deleted with nothing going red. But the lock's *behaviour* is correct and documented in a 45-line docblock that names the EvalPlanQual hole explicitly. Regression risk on correct code calibrates LOW.
- **Location**: `C:\git\confApp\api\src\rounds\category-repository.ts:378-383`
- **Finding**: `renumber`'s `live` CTE takes `for update` on the Board's Category rows, ordered by
  `id`. **Delete that clause and every test in the bundle still passes.** The two tests that look
  like they cover it do not: `overwrites a concurrent reorder whole`
  (`category.integration.test.ts:1113`) and `leaves no hole in the ordering when a removal races a
  removal` (`:1221`) both park the loser through a gated `Database` **until the rival has
  committed**, so the losing `UPDATE` begins after the commit and takes a fresh `READ COMMITTED`
  snapshot that already excludes the removed row – the `live` join alone then produces the right
  answer, lock or no lock. `leaves the ordering contiguous and complete under two unsynchronised
  reorders` (`:1200`) uses `Promise.all` and asserts only invariants that hold in every interleaving.
  `category-structure.test.ts:574` pins the *whole-ordering write* and says nothing about the lock.
- **Threatened assumption**: The owner decision of 2026-08-30 (S02 FIS, 21:40 UTC run) states the fix
  is that *"the `live` CTE **locks** this Round's Categories (by id, so two renumbers take them in
  the same order) **and** the join drops any id that is already gone"*. Two mechanisms are claimed;
  only the join is defended by a test.
- **Evidence**: The bad state that would still pass: two genuinely interleaved removals where the
  rival commits *while* the loser's `UPDATE` is already blocked. Without `for update`, `live`'s
  statement-start snapshot still contains the doomed id, `row_number()` assigns it an ordinal, the
  `UPDATE` then blocks on the rival's delete lock, and EvalPlanQual drops that row from the update
  set – leaving the ordinal unassigned and a hole. Because `create` takes
  `coalesce(max(position),0)+1` (`:466-467`), each hole permanently costs the Board one of its twenty
  slots. That is exactly the defect the 20:50 UTC observation named and the 21:40 UTC decision claims
  to have fixed.
- **Impact**: Silent, cumulative reduction of the user-visible 20-Category cap under real concurrent
  editing – the condition the PRD's Reliability NFR (*"The Category cap cannot be raced past"*) and
  its Edge Cases row exist to cover. Invisible to CI, so a future simplification of `renumber` ships
  the regression.
- **Suggested fix**: Cheapest and deterministic – add a structural guard beside
  `category-structure.test.ts:574` asserting `renumber` contains `for update` and `order by id`,
  citing the owner decision. Stronger – add a race test whose rival commits *after* the loser's
  `UPDATE` has already begun blocking (gate on the rival's `DELETE` rather than the loser's `UPDATE`).
- **Verification needed**: In a scratch worktree, remove `for update` and run `api/test/category.integration.test.ts` + `category-structure.test.ts`. Both going green **is** the finding.
- **Class**: `code-defect` (test strength) · **Routing**: **Fix** – the structural-guard form is mechanical and uniquely determined.
- **Ledger**: no match. The S02 CLOSED `never-a-blend` entry covers the *blend* claim – which is genuinely pinned – and not the lock.

#### G05 – The legibility floor's only automated proof runs outside `npm test`, and there is no CI

- **Reviewer**: S04/S07 partition
- **Severity**: **LOW** – downgraded from MEDIUM by the Findings Filter · **Confidence**: 85 · **Scope relation**: primary
- **Filter reasoning**: verified, but *every* Playwright assertion in this repo is equally unrun by default – the absence of CI is pre-existing and project-wide, making this one instance of it rather than a bundle defect. The one primary-scope residue is the single missing unit assertion on `postItsAreLegible`.
- **Location**: `C:\git\confApp\vitest.config.ts:5`; `C:\git\confApp\package.json:27,32`; `C:\git\confApp\visual\display-board.spec.ts:453,552-560`; `C:\git\confApp\web\src\display\board-layout.ts:95-96`
- **Finding**: The floor is genuinely asserted rather than screenshotted – `belowFloor` across three
  skew fixtures, and the 13-vs-14 boundary read back off the DOM. But all of it lives in Playwright
  under `npm run screenshots`. `vitest.config.ts` projects are `['api','web']` only and
  `.github/workflows/` does not exist. Deleting `drawsPostIts` from `DisplayBoardView.tsx` leaves
  `npm test` (92 files, 1552 tests) fully green. `postItsAreLegible` deliberately returns `true` when
  the size cannot be read, so jsdom can never cover it as written.
- **Threatened assumption**: The S07 FIS EVIDENCE section, *"Red first … four projection-class tests
  fail: `Error: no post-it may be drawn below the legibility floor`"* – true, but only in a suite
  nothing runs by default.
- **Evidence**: `npx vitest run --project web web/test/*Display*` → 56/56 with no floor assertion among
  them; `visual/` is not a vitest project. I reproduced the Playwright gate manually (14 passed) –
  which is the point: it takes a human who knows to run it. **Sharper still**: `postItsAreLegible`,
  the pure comparison the whole amendment reduces to, is imported by **no test at all** –
  `web/test/ProjectedBoardView.test.tsx:4` imports `detailTier` and `regionGrid` from the same module
  and not it. A one-line `expect(postItsAreLegible(0.2, 11.2)).toBe(false)` would run in `npm test`
  today and does not exist.
- **Impact**: The owner's mid-run design decision is one careless edit from silent regression, in
  exactly the class this bundle's own FIS files repeatedly warn about – here, not "a claimed property
  with no test that could fail" but "with no test that **runs**".
- **Suggested fix**: Either wire the projection spec into a `npm test`-reachable gate, or add a
  jsdom-level test stubbing `getComputedStyle` to return a below-floor `--display-post-it-size` and
  asserting zero `.display-post-it` plus the statement. The latter closes the hole
  `board-layout.ts:95-96` deliberately leaves.
- **Verification needed**: Revert the floor; run the chosen gate; confirm red.
- **Class**: `code-defect` (test coverage) · **Routing**: **Note** – the fix is not uniquely determined (two viable shapes, one of which touches project-wide test configuration).
- **Ledger**: none.

#### G06 – `attendee-board.html` draws no staleness indicator, while the shipped Attendee Board renders one at three widths

- **Reviewer**: S08/S01 partition
- **Severity**: **LOW** – downgraded from MEDIUM by the Findings Filter · **Confidence**: 85 · **Scope relation**: primary
- **Filter reasoning**: the drift is confirmed, but unlike G01 this is an *omission*, not a contradiction – no artifact asserts the indicator should be absent, `prd.md:517-521` still requires it, and the shipped surface is proved at all three widths. S08's Observations already record it with the S01-owns-wireframes reason.
- **Location**: `C:\git\confApp\docs\wireframes\facilitator-board-and-categorisation\attendee-board.html:280`; `page-inventory.md:47-58`
- **Finding**: FR9's Error Handling requires *"the last-read Board remains readable **with a staleness
  indicator**"*. The shipped surface renders `activities-age`
  (`SessionActivitiesPanel.tsx:1207`) and `visual/session-activities.spec.ts:1387,1403` asserts it
  visible and within the viewport at 375 / 768 / 1280 px – **which I re-ran and confirmed green**.
  The wireframe draws only a static toolbar line and no age or staleness state at all;
  `page-inventory.md` item 7 enumerates the Attendee Board's required content in detail, including
  S08's pending-Post-it relocation, and never names the indicator. `design-decisions.md:161` settles
  staleness wording only for the projected class.
- **Threatened assumption**: That `attendee-board.html` is the reference S08's Code Patterns table
  points at (*"take it from there, do not invent one"*), and that S01's page inventory is complete
  against FR9.
- **Evidence**: `grep -i "stale|updated |age\b" attendee-board.html` → one unrelated hit, a Post-it's
  own text. S08's Implementation Observations record the drift: *"`attendee-board.html` draws no
  staleness indicator; … the wireframe was not updated, since wireframe authorship is S01's."*
- **Impact**: The wireframe no longer describes the shipped surface, and the next person to change
  the Attendee Board from the wireframe drops or misplaces the age. This is the same drift class
  S01's ledger already carries a CLOSED entry for (the `Correct`/`Remove` case) – the mechanism
  exists and was not used.
- **Suggested fix**: Either add the indicator to `attendee-board.html` and `page-inventory.md` item 7,
  or record a ledger entry with the S01-owns-wireframes reason as the override.
- **Verification needed**: Owner call on whether the age belongs on the Attendee wireframe (interacts with G25).
- **Class**: `spec-stale` · **Routing**: **Note**.
- **Ledger**: none. This is the strongest reason the absence of an S08 ledger entry here is not correct.

#### G32 – Any answered failure tells the room the board is dead and to ask for a new link – and acting on that instruction kills the working link

- **Reviewer**: Critic
- **Severity**: MEDIUM · **Confidence**: 75 · **Scope relation**: primary
- **Location**: `C:\git\confApp\web\src\display\DisplayBoardView.tsx:155-166`, message constants at `:13-14`
- **Finding**: `error.status > 0` routes **every** answered failure – a 500, a proxy 502, a 503
  during an API rollout – to the same terminal screen as a revoked link: board cleared,
  `UNAVAILABLE` (*"This board is no longer available."*) plus `UNAVAILABLE_DETAIL` (*"Ask the
  facilitator for a new link."*).
- **Threatened assumption**: The S07 FIS's stated trade is *"blanks the wall for one interval"*. The
  shipped behaviour is not a blank wall – it is a false assertion plus a call to action.
- **Evidence**: The comment at `:151-153` acknowledges the 5xx case and argues the poll makes it
  survivable; it does not consider what the **detail line instructs**. Issuing a new link revokes the
  current one in the same transaction (`display-link-repository.ts:69`), and the room machine holds
  the old URL in its address bar with no way to be told.
- **Impact**: A ten-second API blip during a workshop puts a wrong sentence on the wall in front of
  the room **and tells the Facilitator to do the one thing that converts a recoverable outage into an
  unrecoverable one** – the pasted URL is then permanently dead and needs physical access to the room
  machine to retype a 43-character token. This is the strongest holistic-outcome finding in the
  review: every individual assertion about the surface is satisfied and the user experience is still
  wrong.
- **Suggested fix**: Branch on the code, not the status – only `DISPLAY_LINK_UNAVAILABLE_CODE` reaches
  the "ask for a new link" screen (optionally after N consecutive occurrences). A 5xx should keep the
  board on screen and show the staleness indicator, which already exists and already says the right
  thing.
- **Verification needed**: Component test – stub `fetchDisplayBoard` to reject with
  `new ApiError('INTERNAL_ERROR','…',500)` after a successful read; assert the board is still
  rendered and `display-unavailable` is not.
- **Class**: `design-changed` · **Routing**: **Note** – the S07 FIS records the 5xx behaviour as *"worth a decision rather than a quiet change here"* (M1, deliberately not changed). This finding is the reason to take that decision, and it is the owner's to take.
- **Ledger**: **should have been an entry and is not** – see G22.

#### G33 – "A discarded Post-it never carries a `category_id`" is an unenforced invariant with three dependents

- **Reviewer**: Critic
- **Severity**: MEDIUM · **Confidence**: 50 (reasoned from PostgreSQL's documented Read Committed caveat, not observed) · **Scope relation**: primary
- **Location**: `C:\git\confApp\api\src\rounds\category-repository.ts:227` and `:634`; `C:\git\confApp\api\src\rounds\post-it-repository.ts:794-800`; `C:\git\confApp\api\test\discard-structure.test.ts:300-322`
- **Finding**: `place`'s not-discarded guard is a `NOT EXISTS` sub-select inside the UPDATE. Under
  READ COMMITTED, when `place` blocks on the row lock a concurrent `discard` holds and then
  re-evaluates via EvalPlanQual, PostgreSQL's documented caveat applies: the re-check *"can see the
  effects of concurrent updating commands on the same rows it is trying to update, but does not see
  effects of those commands on other rows in the database."* `post_it_discard` is another table, so
  the anti-join still passes and the placement lands on a Post-it that is now discarded.
- **Threatened assumption**: The invariant `discard-structure.test.ts` writes down explicitly as the
  justification for its three EXCEPTIONS – *"All three are correct only while a discarded post-it
  never carries a `category_id`."* Nothing in the schema enforces it: no CHECK, no partial unique, no
  trigger.
- **Evidence**: The three dependents are `heldBy` (`:227`, `count(*) … where category_id = $1`, no
  discard exclusion), the reassignment at `:612`, and the delete guard at `:634`
  (`not exists (select 1 from post_it p where p.category_id = c.id)`). All three are single-quoted
  strings the sweep at `discard-structure.test.ts:334` classifies as exceptions. Board reads **do**
  exclude discarded rows (`post-it-repository.ts:441-455`), so the two disagree.
- **Impact**: A Category shows `postItCount: 0` on every surface – Facilitator, Attendee, projected
  wall – while `DELETE …/categories/:id` refuses it with *"This category holds 1 post-it. Move them
  to Uncategorised, or choose another category."* about a Post-it nobody can see. **The Facilitator
  has no move**: the only content in that Category is invisible. `prd.md:223` constrains only
  *non-discarded* Post-its, so the spec has no defined outcome here. Restore does clear the placement
  (`post-it-discard-repository.ts:118`), so FR4/OC02's *"handed back to that Category"* harm is
  avoided – the residual is the stuck Category.
- **Note**: S05's Implementation Observations record the closely related EPQ hazard and state the fix
  taken (*"`restore` now clears the placement in its own statement, removing the dependence rather
  than narrowing the window"*). That closes the restore-hands-it-back harm and **not** this one.
- **Suggested fix**: Append the `NOT_DISCARDED` anti-join to `heldBy` and to the delete guard at
  `:634`, removing two of the three EXCEPTIONS; or make the invariant storage-level with a partial
  constraint. Either way the guard stops depending on a coincidence.
- **Verification needed**: Two psql sessions – T2 `BEGIN; INSERT INTO post_it_discard …; UPDATE post_it SET category_id=NULL WHERE id=P;` (uncommitted); T1 runs `place`'s UPDATE (blocks); `COMMIT` T2; observe whether T1 reports 1 row and whether `post_it.category_id` is non-null with a `post_it_discard` row present.
- **Class**: `code-defect` · **Routing**: **Note** – confidence 50 and unobserved; the race must be demonstrated before the fix is applied.
- **Ledger**: none.

### LOW

#### G07 – Both vote-anonymity guards are narrower than their names, in vocabulary and in scope

- **Reviewer**: S04/S07 partition (proved by source mutation) + S08/S01 partition (proved by regex simulation)
- **Severity**: LOW · **Confidence**: 95 · **Scope relation**: primary
- **Location**: `C:\git\confApp\api\test\display-link-structure.test.ts:339-345,395-460`; `C:\git\confApp\api\test\post-it-structure.test.ts:597`; `C:\git\confApp\api\test\display-link.integration.test.ts:823`; `C:\git\confApp\api\test\post-it.integration.test.ts:1449`
- **Finding**: Two residual gaps, both proved rather than asserted.
  **~~(a) Scope.~~ FALSIFIED by the Findings Filter, re-verified by the orchestrator, struck.** The
  original claim was that a vote-derived column on an already-allowed table
  (`select p.id, p.vote_count from post_it p` in `category-repository.ts`) escapes every guard. It
  escapes the **display-route** guard – the one the S04/S07 partition actually mutated – but **not**
  the Attendee-board guard: `api/test/post-it-structure.test.ts:589-594` lists
  `category-repository.ts` in `boardModules`, and
  `VOTE_SHAPED = /\bvote|ballot|tally|hasVoted|option_id|\boption\b/i` carries **no trailing `\b`**
  after `vote`, so `\bvote` matches both `vote_count` and `voteCount`. Executed:
  `/\bvote/i.test('select p.id, p.vote_count from post_it p')` → **true**. The mutation is caught.
  The partition tested one guard and generalised to both; the filter caught it.
  **(b) Vocabulary.** Simulated against 19 candidate field names, `choiceCounts`, `choices`,
  `pollResults`, `results`, `selectedChoice`, `answerCounts`, `score` and `sentiment` escape **both**
  halves of the Attendee-Board guard. `docs/UBIQUITOUS_LANGUAGE.md:35` lists the synonyms to avoid
  for **Vote** as *"response, **answer**, submission"* – none of which either regex checks – and
  `SessionActivitiesPanel.tsx` already uses `choices`/`setChoices` for local ballot draft state, so
  `choice` is live vocabulary in this codebase.
  **(c) The API-side import walk sees single-quoted imports only.**
  `api/test/display-link-structure.test.ts:364` and `:578` use `/from '(\.[^']+\.ts)'/g`, so a
  double-quoted import silently drops a module out of the closure the whole allow-list is computed
  over. The **web**-side equivalent at `web/test/display-structure.test.ts:81` was widened to
  `['"]` during S07 and the API-side one was not – the S07 FIS records exactly this and leaves it
  (*"Noted because `api/test/display-link-structure.test.ts#reachableFromDisplayRoute` … still has the
  single-quote form"*). Prettier's single-quote rule makes it unlikely to fire today, but the guard's
  scope is set by a regex rather than by the language.
- **Threatened assumption**: PRD NFR Privacy and the plan's binding constraint – *"No surface added
  here reads, joins to, or exposes Vote data"*.
- **Evidence**: Four of five hostile mutations were caught (`from vote` in `board-wire.ts`,
  `join vote` in `category-repository.ts`, `left join vote` in `post-it-repository.ts`, a new
  `poll_result` table). The fifth was not. Mutations were reverted; I verified the working tree
  clean afterwards.
- **Impact**: **Bounded, and not an open anonymity hole.** A vote count added under any realistic
  name (`voteCount`, `tally`, `votes`) **is** caught, in the right place, and anonymity itself is a
  storage guarantee (ADR-006) rather than something these guards create. No vote-derived column
  exists on any allowed table, and creating one would breach ADR-006 at the schema layer first. This
  is guard-name-vs-guard-scope drift.
- **Suggested fix**: Three bounded edits. Widen the display guard's name regex to the whole reachable
  closure – the helper `reachableFromDisplayRoute()` already exists; add
  `|poll|choice|result|answer|score|vote_?count` to both structural regexes and both behavioural body
  regexes; and bring `api/test/display-link-structure.test.ts:364,578` to the `['"]` form
  `web/test/display-structure.test.ts:81` already uses.
- **Verification needed**: Re-run the mutation set; confirm no legitimate Board key (`postItCount`, `arrivedAfterClose`, `categories`) trips the new words.
- **Class**: `code-defect` (test coverage) · **Routing**: **Fix** – a bounded regex widening in four named locations.
- **Ledger**: partial. Quick-review C05 raised the *file-list* half of (b) and it was fixed; the vocabulary and column halves were never raised.

#### G08 – Test sources are typechecked by nothing, and a display test proves it

- **Severity**: LOW · **Confidence**: 99 · **Scope relation**: adjacent (pre-existing, project-wide)
- **Location**: `C:\git\confApp\api\tsconfig.json` (`"include": ["src/**/*.ts"]`), `C:\git\confApp\web\tsconfig.json` (same); demonstrated at `C:\git\confApp\api\test\display-link-structure.test.ts:193-200`
- **Finding**: `const LIVE: DisplayLinkCandidate = {…}` omits the required fields `prompt` and
  `roundKind` (`api/src/rounds/display-link.ts:99,101`). `npm run typecheck` exits 0 because the root
  `tsconfig.json` references only `./api` and `./web`, and neither includes `test/` or `visual/`.
- **Impact**: Behaviourally harmless – the predicate reads neither field – but it means every
  structure guard, allow-list and wire-shape assertion in this bundle is unverified against the types
  it claims to assert over. That matters more here than in most bundles, because this feature's proof
  strategy leans unusually hard on structure tests.
- **Suggested fix**: A `tsconfig.test.json` covering `api/test`, `web/test` and `visual`, wired into `npm run typecheck`.
- **Class**: `code-defect` · **Routing**: **Note** – project-wide, pre-existing, and adding a tsconfig will surface unrelated errors that need their own triage.

#### G09 – Em dashes across the new feature documents violate a critical project rule

- **Severity**: LOW · **Confidence**: 99 · **Scope relation**: primary
- **Location**: `docs/wireframes/facilitator-board-and-categorisation/design-decisions.md` (38), `requirements-clarification.md` (62), `validation-report.md` (31), `page-inventory.md` (20), `prd.md` (11), `s03-….md` (9), `s06-….md` (9), `s07-….md` (2), `s06-…ledger.md` (2), `s02-….md` (1)
- **Finding**: `docs/guidelines/CRITICAL-RULES-AND-GUARDRAILS.md` → Operational Rules states
  **"En dashes (–), not em dashes."** ~185 occurrences across ten documents, all new in this bundle,
  all in ordinary prose rather than code fences or quoted third-party text. Notably `s01-….md`,
  `s04-….md`, `s05-….md`, `s08-….md` and `ADR-008` follow the rule scrupulously, so the drift is
  concentrated rather than uniform.
- **Class**: `code-defect` (project standards) · **Routing**: **Fix** – mechanical substitution outside code fences.

#### G10 – `format:check` fails on a file this bundle created, recorded by four stories as pre-existing

- **Severity**: LOW · **Confidence**: 100 · **Scope relation**: primary
- **Location**: `C:\git\confApp\api\test\display-link.integration.test.ts`
- **Finding**: `npm run format:check` flags four files. Three are genuinely long-standing
  (`api/test/join-code.test.ts`, `visual/conferences.spec.ts`, `web/src/components/JoinCodePanel.tsx`
  – named as such by S01 before this bundle wrote any code). The fourth,
  `api/test/display-link.integration.test.ts`, was **created by S04 in this bundle**
  (`git ls-files --error-unmatch` → *not known to git*). S04's own record
  (`s04-….md:260`) names only the two pre-existing files and never notices it added a third; S05
  (`:242`), S06 (`:207`) and S07 (`:283`) then each classified it as *"pre-existing Prettier drift in
  files this story does not touch"* – true of each story individually, false of the bundle.
- **Impact**: Trivial as a defect; notable as a verification-record error. A per-story "not mine"
  rule has no bundle-scope backstop, so a file introduced unformatted becomes permanently
  "pre-existing" one story later.
- **Suggested fix**: `npx prettier --write api/test/display-link.integration.test.ts`; correct the
  four story records to name three long-standing files, not four.
- **Class**: `code-defect` · **Routing**: **Fix**.

#### G11 – S06 TI05 still scopes the removal control to the Board only, and is not marked superseded

- **Severity**: LOW · **Confidence**: 92 · **Location**: `s06-admin-permanent-removal.md:170-171`
- **Finding**: TI05 reads *"Control rendered per Post-it on the Facilitator's Board **only** …"* and
  remains `[x]` with no superseded marker. Structural Criterion 5 **was** genuinely amended (`:87`),
  so half the ledger's claim holds; TI05 itself is untouched and the correction lives ~50 lines below
  in Implementation Observations (`:221-225`).
- **Impact**: A reader working the task list in its natural order sees "the Board only" against
  OC01's "or already Discarded" and must reach the observations to learn which won – the same
  FIS-internal contradiction that produced the original C1 defect, in weakened form.
- **Class**: `spec-stale` · **Routing**: **Note** · **Ledger**: S06 `criterion-5-gating` (CLOSED), partially refuted.

#### G12 – `edit`'s documenting comment names the wrong test file

- **Severity**: LOW · **Confidence**: 99 · **Location**: `api/src/rounds/post-it-repository.ts:656`
- **Finding**: The comment closing the 2026-08-31 owner decision reads *"Pinned by
  `post-it.integration.test.ts`."* The pinning test is `api/test/discard.integration.test.ts:1089`.
  `post-it.integration.test.ts` contains no such test. The line is also ~190 characters against a
  ~100-column block, indicating a late in-place insertion.
- **Impact**: Someone "fixing" `edit` for consistency with `place` follows the pointer, finds
  nothing, and concludes the property is unpinned – the guard rail fails exactly when it is needed.
  The test itself still goes red; only the signpost is broken.
- **Class**: `code-defect` (documentation) · **Routing**: **Fix**.

#### G13 – A web test still asserts the retired "no removal wording on this surface" rule

- **Severity**: LOW · **Confidence**: 90 · **Location**: `web/test/PostItDiscard.test.tsx:322-325`
- **Finding**: `expect(…textContent).not.toMatch(/delete|permanent|cannot be undone/i)` with the
  comment *"And nothing on this surface is worded as a removal that cannot be undone (S06 is
  elsewhere)."* Green only because this file's `payload` helper hardcodes
  `canRemovePermanently: false` (`:128`). For an Admin the panel now contains both phrases by design.
- **Impact**: Not a false green – the Admin path is covered at `PostItPermanentRemoval.test.tsx:602`
  – but the assertion encodes the superseded position and reads as a standing prohibition. Anyone
  widening the fixture to an Admin hits an unexplained failure and may "fix" it by removing the
  control.
- **Class**: `spec-stale` · **Routing**: **Note** (re-scoping the comment is an authoring decision paired with G01).

#### G14 – The session-deletion counting decision is made and doubly tested, but absent from the PRD's Decisions Log

- **Severity**: LOW · **Confidence**: 88 · **Location**: `prd.md:757` (the requirement to decide) vs `prd.md:765-791` (the log, which omits it)
- **Finding**: The Dependencies table says the decision *"must be decided here"*. It **was** – ADR-008
  §Decision 7, `post-it-repository.ts:839-873`, S05 TI07 – and is pinned by two integration tests
  (`discard.integration.test.ts:1060`, `permanent-removal.integration.test.ts:845`, the second a
  single two-halves contrast test). It is simply missing from the log, which carries every other
  FR4/FR5 decision. **This is not an undecided-but-implemented state.**
- **Suggested fix**: One log row – *"A discarded Post-it still counts as a contribution and still
  blocks Session deletion"* – with ADR-008's reasoning and the delivery-record's opposite choice as
  the rejected alternative.
- **Class**: `spec-stale` · **Routing**: **Note**.

#### G15 – A combined rename-and-reorder is two transactions, so a refused reorder returns 404 over a committed rename

- **Severity**: LOW · **Confidence**: 92 · **Location**: `api/src/routes/rounds.ts:1404-1432`
- **Finding**: The handler calls `categories.rename(...)` then `categories.reorder(...)` as two
  separate `db.transaction` calls. If the Category is removed between them the second answers
  `missing`, `refuseCategoryWrite` throws 404 `CATEGORY_NOT_FOUND`, and the rename has already
  committed and advanced the watermark. The caller reads *"there is no such category"* about a
  Category it just successfully renamed. This breaks the pattern the bundle holds everywhere else –
  `StillOccupied` exists precisely so a refused removal rolls back its own relocation
  (`category-repository.ts:139-152`).
- **Mitigation**: API-surface only today; the SPA sends one field or the other, never both
  (`SessionActivitiesPanel.tsx:1060-1092`). Recorded verbatim in S02's Implementation Observations as
  `NOTICED BUT NOT TOUCHING`. But the endpoint's own docblock invites the combined body
  (*"its name, its position, **or both**"*, `rounds.ts:318`).
- **The Critic rated this MEDIUM** on the grounds that the trigger – another Facilitator removing the
  Category between the two writes – is exactly the concurrent-sorting scenario `prd.md:648` calls
  normal, and that the response also asserts a merged shape (`:1427`) which only exists if both
  halves succeeded. I have kept it LOW because the SPA cannot produce the combined body today, so no
  user can currently reach it; the Critic's reading is the right one the moment any other client
  does. Recorded so the disagreement is visible rather than averaged away.
- **Suggested fix**: One repository call in one transaction, or narrow the schema to reject a body naming both and correct the docblock.
- **Class**: `code-defect` · **Routing**: **Note** – two viable corrections; not uniquely determined.

#### G16 – A double position-race reports "this board already holds N categories" on a board that is not full

- **Severity**: LOW · **Confidence**: 70 · **Location**: `api/src/rounds/category-repository.ts:293-296`; message at `api/src/routes/rounds.ts:668-675`
- **Finding**: `writeOnceThenRetry`'s `terminal` maps *either* `isPositionConflict` (deferred 23505)
  *or* `isCapReached` (23514) to `{outcome:'limit-reached', count}` whenever `creating` is true. A
  position conflict only means somebody took the computed position. The single retry usually rescues
  it; a second conflict produces *"A board can hold at most 20 categories, and this one already holds
  6."* The count is honest, the sentence is not.
- **Suggested fix**: Map to `limit-reached` only when the freshly read `count >= CATEGORY_LIMIT_PER_BOARD`; otherwise surface a retryable conflict.
- **Class**: `code-defect` · **Routing**: **Note** – rare, and the correction touches the shared retry helper.

#### G17 – No test drives a non-Member against a Category or placement route

- **Severity**: LOW · **Confidence**: 80 · **Location**: `api/test/category.integration.test.ts:882`; `api/test/placement.integration.test.ts:688`
- **Finding**: FR6 AC4 – *"A non-Member is refused, and is told nothing about whether the Board
  exists"* – is satisfied by construction (`authorization.ts:172` refuses on missing membership
  through the same neutral `refusal()` a role-short Member gets), but every test in these two files
  uses a *Member* lacking authority. The disclosure property is a security property and the FIS ticks
  the scenario, so a future divergence between `refusal()` and `notAMember()` on these routes would
  go undetected here.
- **Suggested fix**: Add a caller with no membership row and assert the identical code and message.
- **Class**: `code-defect` (test strength) · **Routing**: **Note**.

#### G18 – DISPUTED by the Findings Filter (over-reported; excluded from remediation)

- **Severity**: LOW · **Confidence**: 85 · **Location**: `api/test/discard.integration.test.ts:366-379`
- **Finding**: FR4 Validation – *"A restore always targets Uncategorised; a destination Category may
  not be supplied."* The answer is silently **ignored**, not refused, and that is structurally
  guaranteed (`restore` has no destination parameter; the route declares no body schema;
  `discard-structure.test.ts:503` fails on any body schema or `request.body` read). But no
  integration test sends `{categoryId: <id>}` and asserts the Post-it lands in Uncategorised. The
  exactly parallel property on the removal path **does** have one
  (`permanent-removal.integration.test.ts:783`, *"ignores an actorSub in the body"*).
- **Class**: `ambiguous-intent` (proof depth, not behaviour) · **Routing**: **Note**.
- **Filter verdict – DISPUTED**: the property is guaranteed three independent ways (`restore` takes no
  destination parameter; the route declares no body schema; `discard-structure.test.ts:503` fails on
  any body schema or `request.body` read on that path). A senior engineer would not act on this.
  Retained for the record, excluded from the remediation plan.

#### G19 – The PRD still states the pre-amendment overflow position and lists the question as open

- **Severity**: LOW · **Confidence**: 75 · **Location**: `prd.md:652` (Edge Cases), `prd.md:733-737` (Open Questions)
- **Finding**: The Edge Cases row reads *"Post-it detail degrades **before any Post-it becomes
  unreachable**"*. Under the floor, a region holding more than ~13 at the 20-Category grid renders
  **none** of its Post-its – they are absent, not merely small. Open Questions still lists
  projected-view overflow as open and routes it to wireframing.
- **Mitigating**: the same row says *"Exact behaviour is settled at wireframing (see Open
  Questions)"*, and `design-decisions.md` – the wireframing record – **is** properly amended. So the
  deferral clause gives real cover and no other artifact states the old rule as current.
- **Class**: `spec-stale` · **Routing**: **Note**.

#### ~~G20~~ – WITHDRAWN by the Findings Filter

- **Original claim**: `prd.md:519`'s *"the last-read Board remains readable with a staleness
  indicator"* could be read as stating the superseded staleness anchor.
- **Falsifier**: `prd.md:517-521`'s subject and predicate are the Board's *readability*; the sentence
  makes no claim about what the age is anchored to, so there is nothing stale to fix. The finding's
  own text concluded *"I read it as **not** stale"* – a non-finding recorded as a finding.
- **Disposition**: withdrawn. **No artifact states the superseded staleness anchor.** The owner
  decision to anchor on the watermark exchange is correctly reflected in every artifact that
  describes it.

#### G21 – The S08 FIS's ASSUMPTIONS block is now false

- **Severity**: LOW · **Confidence**: 98 · **Location**: `s08-the-attendees-live-board.md:212-216`
- **Finding**: The block states that `api/test/post-it.integration.test.ts` *"reports `skipped`"* and
  that TI03, TI04 and TI07's server half *"rest on authored-and-typechecked evidence rather than on a
  green run"*, and quick-review C16 left the ticked boxes with the plan owner on that basis. The file
  runs **39/39 green** against real PostgreSQL, and I additionally executed both visual specs
  (**32/32**, including the attendee-ceiling tests at all three widths). Only the unseeded held item
  (G22's sibling, the OPEN S08 ledger entry) remains genuinely unproved.
- **Suggested fix**: Scope the caveat to the held-item fixture and close C16 for the rest.
- **Class**: `spec-stale` · **Routing**: **Fix** – mechanical, and the evidence is in this report.

#### G22 – S07's ledger omits two drift items the FIS itself says need a decision

- **Severity**: LOW · **Confidence**: 85 · **Location**: `s07-the-projected-board-view.reconciliation-ledger.md` vs `s07-….md:286,300-302,375-379`
- **Finding**: The S07 ledger (created 2026-09-02, concurrently with this review) records the
  client-bundle split and the legibility floor. It does **not** record (a) that any answered 5xx
  replaces every projected wall with the neutral unavailable message for one poll interval – which
  the FIS says explicitly *"is worth a decision rather than a quiet change here"* – or (b) that
  `design-decisions.md` draws four projected states where six ship, and describes staleness as a
  wall-clock time where the shipped surface renders an elapsed age
  (`projected-board-stale.html:266`).
- **Impact**: The ledger is the durable, greppable record. Drift held only in an append-only
  observations section is not greppable by class or status and will not surface at the next review.
- **Class**: `ambiguous-intent` · **Routing**: **Note**.

#### G23 – The legibility-floor amendment carries two different dates

- **Severity**: LOW · **Confidence**: 95 · **Location**: `design-decisions.md:129,170,173`; `s07-….md:303`; vs `s07-…ledger.md` notes
- **Finding**: `design-decisions.md` heads the amendment *"Amended 2026-09-01"* / *"Amendment –
  2026-09-01"* and calls it *"Owner decision, 2026-09-01, during S07"*; the S07 FIS run heading says
  *"Run: 2026-09-01"*; the S07 ledger note says *"Owner decided **2026-09-02**"* while its own
  `Created:`/`Updated:` fields say `2026-09-01`. `date +%Y-%m-%d` is 2026-09-02 and the source run
  began `2026-09-01T23:04:46Z`, so the local date genuinely crossed mid-run – but the artifacts
  disagree in text, against a rule that says **"Real dates only … never guess."**
- **Class**: `spec-stale` · **Routing**: **Fix** – pick the date the owner actually decided and make the three artifacts agree.

#### G24 – The S02 ledger's OPEN entry on unobservable actor identity is still accurate and unremedied

- **Severity**: LOW · **Confidence**: 95 · **Location**: `api/test/category.integration.test.ts:882-948`
- **Finding**: Re-derived and confirmed. The test proves the *decision* is the credential's (Ada
  refused whatever the body claims at `:929`; Ida succeeds with `actorSub: ADA` in the body at
  `:940`), but `category` has no author column, so nothing observes that a body field was not read to
  select a *target*. A route reading `body.userSub` to pick, say, the Session would pass both halves.
  No test added since covers it; S03's `placement.integration.test.ts:802` covers the placement path
  only, where the stored `author_sub` is genuinely observable.
- **Class**: `ambiguous-intent` · **Routing**: **Note** · **Ledger**: matches the OPEN entry `accepted-and-ignored-is-inferred-not-observed`. Excluded from convergence.

#### G25 – Two claimed properties of the staleness age have no test that could go red

- **Severity**: LOW · **Confidence**: 85 · **Location**: `SessionActivitiesPanel.tsx:599`, `:1203`
- **Finding**: (a) The age is panel-scoped, not Board-scoped: `showsAge = state.kind === 'ready'`
  renders it on any ready payload, including a Session running only a Poll and no Post-it Round,
  while FR9 scopes the indicator to the Attendee's *Board*. No test moves either way (quick-review
  C09, left with the plan owner). (b) The comment claims the age is *deliberately not an ARIA live
  region*; nothing asserts the absence of `aria-live`/`role="status"` on `activities-age`. Adding
  `aria-live="polite"` would interrupt a screen-reader user once a minute and go undetected – and
  every other transient message in the file (`:1290`, `:1555`, `:1732`, `:2293`) **does** carry
  `role="status"`, so the odds are not theoretical.
- **Class**: (a) `ambiguous-intent`, (b) `code-defect` (test gap) · **Routing**: **Note**.

#### ~~G26~~ – WITHDRAWN by the Findings Filter

- **Original claim**: `s05-discard-and-restore.md:261` still records the `edit`-on-discarded question
  as undecided.
- **Falsifier**: established project convention. Implementation Observations are append-only and
  run-stamped, and the superseding entry sits ~10 lines below under an explicit
  `#### OWNER DECISIONS` heading dated `Run: 2026-08-31 11:30 UTC`, stating *"The `edit` omission is
  now a decision, not an oversight."* A reader stopping mid-log is reader error, not artifact drift –
  and the finding conceded the convention in its own text.
- **Disposition**: withdrawn. The `edit`-on-discarded owner decision is correctly and completely
  reflected in code, comment, pinning test and FIS.

#### G27 – The archived discarded-list refusal is real, and pinned by no test

- **Severity**: LOW · **Confidence**: 95 · **Location**: `api/src/routes/rounds.ts:1862-1871` → `:872-885`
- **Finding**: Confirmed live. `GET …/discarded-post-its` goes through `authorizeWrite` → `assertEditable`
  and answers `CONFERENCE_NOT_EDITABLE` after archival for a request that changes nothing, while
  `post_it_discard` retains every trace. **Beyond the ledger entry: the behaviour is asserted
  nowhere.** `discard.integration.test.ts:951` covers only the two writes; no test drives the list
  route against an archived Conference, so neither the current over-refusal nor a future fix would be
  caught.
- **Class**: `design-changed` · **Routing**: **Note** · **Ledger**: matches the OPEN entry `discarded-list-refused-after-archival`. S05's Structural Criterion 4 forbade fixing it in-story; the Report slice (REQ-023/REQ-024) must settle it. Excluded from convergence.

#### G34 – The service-worker exclusion guard matches the comment that explains it, not the code that enforces it

- **Reviewer**: Critic · **Severity**: LOW · **Confidence**: 100 · **Location**: `web/test/display-structure.test.ts:221-224`
- **Finding**: `expect(worker).toMatch(/\/display\//)` is satisfied by the docblock in
  `web/public/sw.js:48-65`, which contains the literal `/display/<token>` several times. Deleting
  `DISPLAY_PREFIX` and the exclusion branch at `sw.js:107-109` while leaving the prose leaves this
  test green. The test's own sibling assertions strip comments first (`:32-34`); this one does not.
- **Mitigation**: the property **is** genuinely covered behaviourally by `web/test/service-worker.test.ts`'s
  *a projected board navigation* block, so nothing is unprotected – but the assertion contributes
  nothing while reading as coverage.
- **Suggested fix**: Assert over `withoutComments(worker)`, or delete the assertion and cite `service-worker.test.ts`.
- **Class**: `code-defect` (test quality) · **Routing**: **Fix** – one-word change to an existing helper call.

#### G35 – A doubly-contested discard or restore reports the requested end state without having established it

- **Reviewer**: Critic · **Severity**: LOW · **Confidence**: 75 · **Location**: `api/src/rounds/post-it-discard-repository.ts:341-359` and `:378-396`
- **Finding**: After two `contested` attempts both functions return `{outcome:'discarded'}` /
  `{outcome:'restored'}` unconditionally. `contested` means the write matched nothing **and** the
  trace read says the opposite of what was just tried – precisely the case where the end state is
  *not* known to hold. The route's contract says `{discarded:true}` *"says what is true of the Post-it
  now"* (`routes/rounds.ts:1834`).
- **Impact**: The Facilitator's control reports success and the Board re-read immediately contradicts
  it – a Post-it still on the wall after a confirmed Discard, with no error to explain it. Narrow
  (two consecutive contests), but the response is a claim the code has evidence against.
- **Suggested fix**: On the second contest take one final `traceState` and answer from it, or return a distinct outcome the route maps to "try again".
- **Class**: `code-defect` · **Routing**: **Note** – two viable shapes; the retry ceiling is a design choice.

#### G36 – The route audit exempts `OPTIONS` entirely rather than requiring a written reason

- **Reviewer**: Critic · **Severity**: LOW · **Confidence**: 100 · **Scope relation**: pre-existing, in a file this bundle changed · **Location**: `api/src/auth/with-auth.ts:191`
- **Finding**: `if (method === 'OPTIONS') continue;` skips the record **and** the refusal. A route
  registered with `method: 'OPTIONS'` and an unwrapped handler starts the server, is absent from
  `app.confappRoutes`, and is invisible to `web/test/display-structure.test.ts:210-218`'s allow-list
  assertion – against the file's own claim at `:103` that *"this list is the whole anonymous surface
  of the API"*.
- **Suggested fix**: Record `OPTIONS` routes in `confappRoutes` so the assertion sees them, and skip only the throw.
- **Class**: `code-defect` · **Routing**: **Note** – pre-existing and touching a startup audit shared by every route.

#### G37 – The one anonymous route over domain content has no rate limit

- **Reviewer**: Critic · **Severity**: LOW · **Confidence**: 75 · **Location**: `api/src/routes/display.ts:93-153`; `api/src/auth/with-auth.ts:125-136`
- **Finding**: Every request to `GET /api/display/:token` runs `findByToken` – a four-table join –
  unconditionally before any resolvability decision, with no throttle in the request path and no
  cheap rejection (the deliberate absence of a shape schema at `display.ts:80-92` means even a
  one-character path executes it). Two further full-round reads follow on a hit.
- **Threatened assumption**: The `ANONYMOUS_ROUTES` entry's claim that this route's *"cost … is
  bounded by the token … and by the scope"*. That bounds **disclosure**, not **work**. `AGENTS.md`
  states rate limiters belong in PostgreSQL; none exists.
- **Impact**: The only unauthenticated, publicly reachable, DB-hitting endpoint in the system, with
  no ceiling – a cheap way to saturate the connection pool every authenticated surface shares. The
  two pre-existing anonymous routes share the characteristic but are factless and far cheaper.
- **Suggested fix**: Either state the decision in the `ANONYMOUS_ROUTES` reason (edge/ingress owns rate limiting) or add a PostgreSQL-backed per-IP counter as `AGENTS.md` prescribes.
- **Class**: `ambiguous-intent` · **Routing**: **Note** – needs an owner decision on where rate limiting lives.

#### G28 – Every ledger's header points at a schema document that does not exist

- **Severity**: LOW · **Confidence**: 99 · **Location**: all eight `*.reconciliation-ledger.md:3`
- **Finding**: *"See `reconciliation-ledger.md` for the schema, stable-ID derivation, status
  lifecycle…"* – no file of that name exists anywhere in the repo. Repo-wide, pre-existing, cosmetic.
- **Class**: `spec-stale` · **Routing**: **Note**.

---

## Critic Coverage

The Critic pass ran as a dedicated fresh-context sub-agent (`review-critic`) against the three
calibration references, with a prompt that deliberately excluded checklist walking – four partitions
were already doing that – and directed it at interleavings, hostile input, counts-vs-contents, the
offline boundary, the mirror-not-control constraint, guard narrowness, and holistic outcome. It
produced **10 findings, 3 of them HIGH**, and three were proved by execution rather than reading.
Every HIGH was independently re-verified by the orchestrator before being recorded.

**Attacked and found nothing** (this is the part that makes the HIGHs meaningful):

- **URL matcher hardening.** `isAnonymous` (`with-auth.ts:139`) is a *registration-time* audit over
  Fastify route patterns, not a per-request matcher, so no crafted URL can widen the anonymous
  surface. Proved by injection that trailing slash, query string, `;a=b`, `%2f`, `%00`, `%zz`,
  `/extra` and every non-GET verb reach the identical neutral refusal. Only slash-duplication and
  case escape, and they escape the *redaction*, not the *authorisation* (G29).
- **The neutral-refusal oracle.** `resolveDisplayLink` (`display-link.ts:143-158`) returns a
  discriminator-free `{resolved:false}` for revoked / Draft / past-day / unknown; the not-found
  handler, `frameworkErrors` and the route handler all emit the same envelope with `no-store`. Query
  counts are identical for "no row" and "dead row", so there is no timing oracle either.
- **The day bound.** `sessions.day` is `date NOT NULL`; `pg.types.setTypeParser(DATE)` returns the
  raw string (`api/src/db.ts:14`); `compareDates` is a string compare. **No `new Date` anywhere on
  the path, so no DST and no locale drift.** The wall-clock slack is documented and accepted.
- **The offline queue boundary.** `web/src/offline/post-it-queue.ts` holds only text contributions;
  every sorting write goes through `writeToBoard` (`SessionActivitiesPanel.tsx:733-765`), which holds
  nothing, re-reads on both branches, and clears the placement `<select>` only on success. `sw.js`
  returns early for non-GET and for `/display/` + `/display.html`. No background-sync registration
  exists anywhere.
- **The projected surface as a control.** `DisplayBoardView.tsx` has one `window.resize` listener and
  no form, link, keyboard handler, `postMessage` or storage write. `display.html` carries
  `<meta name="referrer" content="no-referrer">`, mounts no `AuthProvider` and registers no worker.
- **Counts vs contents.** `toBoardWire:106-111` derives `postItCount` from the same array it emits,
  so they cannot differ; the legibility floor's "too many" message uses the server count and the
  `<ul>`'s `--display-rows` uses `postIts.length`, equal by construction. The orphaned-placement
  re-bucketing at `board-wire.ts:96` is correct and self-correcting. The single divergence found is
  G33, and it is upstream of the projection.
- **Removal interleavings.** restore vs permanent-removal, permanent-removal vs author-delete,
  author-delete vs discard (`ON DELETE CASCADE`), Category removal vs discard of one of its Post-its,
  and Round reopen vs all of them – each traced through the actual SQL predicate to a defined
  outcome. The three-way removal model holds.

**Could not reach**: the Critic ran nothing against PostgreSQL (read-only instruction), so G33's
EvalPlanQual interleaving is reasoned from PostgreSQL's documented Read Committed caveat rather than
observed – hence confidence 50. It did not run nginx, so G30 rests on `nginx:alpine`'s documented
default and the absence of any override – hence confidence 75. It did not render the projected
surface, so it could not confirm that registered `<length>` custom properties resolve through
`getComputedStyle` on a real engine; the orchestrator's Playwright run (14 passed) covers that.

---

## Findings Filter Result

The full filter was triggered (>5 findings, and a Critical-adjacent HIGH set). It ran as a dedicated
fresh-context sub-agent (`review-devils-advocate`) against the shared and code-specific calibration
references, verifying every cited location against the repository rather than taking the finding text
on trust. It was explicitly told it may only VALIDATE, DOWNGRADE, WITHDRAW or DISPUTE – never add.

**Sequencing note, stated plainly**: the filter was dispatched over G01–G28 while the Critic pass was
still running, so **G29–G37 did not go through it**. Those nine had an inline severity self-check
against the same calibration references instead, under the same verdict-discipline floor; the three
HIGHs were additionally re-verified against the repository by the orchestrator, and one of them (G31)
was the evidence that falsified a sub-claim in G07. This is a real gap in the filter's coverage and
is recorded rather than papered over.

### Authoritative final severities

| ID | Verdict | Final severity | Note |
|---|---|---|---|
| G01 | VALIDATED | **MEDIUM** | all four artifacts confirmed, incl. the literal PASS row |
| G02 | DOWNGRADED | LOW | broken pointer beside an intact argument |
| G03 | VALIDATED | **MEDIUM** | linear-order defence explicitly rejected; the ticked criterion is decisive |
| G04 | DOWNGRADED | LOW | claim verified; regression risk on correct code |
| G05 | DOWNGRADED | LOW | one instance of a pre-existing project-wide CI absence |
| G06 | DOWNGRADED | LOW | an omission, not a contradiction |
| G07 | DOWNGRADED, sub-claim (a) **falsified** | LOW | (b) and (c) hold; (a) struck |
| G08–G17, G19, G21–G25, G27, G28 | VALIDATED | LOW | all locations confirmed |
| G18 | **DISPUTED** | LOW | over-reported; excluded from remediation |
| G20 | **WITHDRAWN** | – | the sentence makes no claim about the anchor |
| G26 | **WITHDRAWN** | – | append-only run-stamped log; reader error, not drift |
| G29, G30, G31 | inline self-check (post-filter) | **HIGH** | each re-verified against the repository by the orchestrator |
| G32, G33 | inline self-check (post-filter) | MEDIUM | G33 at confidence 50, unobserved |
| G34–G37 | inline self-check (post-filter) | LOW | |

**Filter summary: 20 validated, 5 downgraded, 2 withdrawn, 1 disputed** across G01–G28; 9 findings
inline-calibrated.

### The filter's challenge to the Completeness score – accepted

The filter argued that Completeness 7 was not defensible and 8 is the honest score, on the grounds
that the dimension asks about *stubs, TODOs, placeholders and missing features* – of which the bundle
has **none** – and that G01 and G02 are `spec-stale` documentation drift being double-counted into an
implementation dimension. That is right, and the score has been corrected to **8**.

**The verdict does not change.** 8 is still below the threshold of 9, and the reason is now a single
one: **G03**, where a P0 accessibility criterion is ticked `[x]` and its assistive-technology half is
unmet. One partially-delivered aspect of a shipped feature is more than "trivial TODOs only" (9) and
well short of "features stubbed" (7). Adding four `aria-label`s and one `getByRole` assertion – or
unticking `s02-….md:115` and ledgering it – closes Completeness to 9–10 on its own.

Functionality is scored **7** rather than the filter's 8, because the filter scored before the three
HIGH findings existed: G29 and G30 between them falsify a named Structural Criterion (*"the token
must never reach a log line"*) on the feature's one bearer credential. The core happy path works and
every specified requirement is met on canonical input, which is what keeps it at 7 and above the
threshold.

`CONVERGED` was originally justified by two MEDIUM `code-defect` findings. After the filter G04 is
LOW, so convergence would have turned on G03 alone – but the three post-filter HIGHs are new
`code-defect` findings at ≥ MEDIUM, so the pass is **not** converged.

---

## Remediation Plan

Sequenced by dependency, not by severity alone. `Fix`-routed findings are the ones
`andthen:remediate-findings` can apply unattended; `Note`-routed ones need an owner decision or a
non-mechanical edit.

### 1. Credential handling – do these first and together (HIGH)

They share one root cause: **three separate sites deciding "is this a display URL?" by an
un-normalised prefix test.**

| # | Finding | Routing | Acceptance criterion |
|---|---|---|---|
| 1 | **G29** – normalise the path (collapse `/{2,}`, lower-case) before all three `startsWith(DISPLAY_ROUTE_PREFIX)` tests in `app.ts:74`, `app.ts:229` and `display.ts:71`; extend the nginx map to match. Better still, stop `routeNotFound` echoing the request path. | **Fix** | `//api/display/X`, `/api//display/X` and `/API/display/X` each return `DISPLAY_LINK_UNAVAILABLE` with a body that does not contain `X`, and `redactDisplayToken` collapses all three. Add them to `display-link.integration.test.ts:885-935`'s whole-response comparison. |
| 2 | **G30** – add `error_log … crit;` at server level in the nginx template; assert the directive in `display-build.test.ts`. | Note | With the API stopped, a request to `/api/display/<token>` from the static container leaves no raw token in `docker logs`. **Confirm the leak against a running image before fixing** – confidence is 75. |
| 3 | **G31** – replace `statementsIn` in `display-link-structure.test.ts:414-417` with `discard-structure.test.ts:77-83`'s `sqlStringsIn`; add a self-test asserting the extractor finds `post_it` in `category-repository.ts:227`. | **Fix** | Injecting a single-quoted `from vote` into `category-repository.ts` turns the guard red. |
| 4 | **G07** – widen the display guard's name regex to the whole reachable closure, add `poll\|choice\|result\|answer\|score\|vote_?count` to both structural and both behavioural regexes, and bring `display-link-structure.test.ts:364,578` to the `['"]` import form. | **Fix** | The full mutation set is caught; no legitimate Board key trips the new words. |

### 2. The unmet P0 criterion (MEDIUM)

| # | Finding | Routing | Acceptance criterion |
|---|---|---|---|
| 5 | **G03** – add `aria-label` to the four Category controls mirroring `SessionActivitiesPanel.tsx:2024`/`:2050`, or wrap the region in `role="group" aria-labelledby`. Insert the missing `h4`. | **Fix** | `getByRole('button', {name: /Rename the category "Tooling"/})` resolves uniquely on a two-Category Board; `visual/session-activities.spec.ts` still green at three widths. **Or** untick S02's Structural Criterion at `:115` and ledger it. |

### 3. Reconcile the mid-run owner decisions with their artifacts (one MEDIUM, rest LOW, all Note)

These are one job, and the bundle already contains the model for doing it right – the legibility
floor's dated `### Amendment` block in `design-decisions.md`.

| # | Finding | Acceptance criterion |
|---|---|---|
| 6 | **G01** – amend `design-decisions.md:96-99` with a dated amendment recording that permanent removal **is** offered on the discarded surface; update `discarded-postits.html:264`, `page-inventory.md:77-78`, and correct the **PASS** row at `validation-report.md:113`; add `Stale targets:` to the S06 ledger entry. | Grepping the four artifacts for "no permanent-removal control" returns nothing that reads as current. |
| 7 | **G02** – commit the cited projection captures into `docs/wireframes/facilitator-board-and-categorisation/screenshots/` under the existing un-ignore, and correct the citation paths. | `git ls-files docs/wireframes/**/screenshots/ \| grep projection` returns `-floor.png` and `-skewed-80.png`. |
| 8 | **G06** – add the staleness indicator to `attendee-board.html` and `page-inventory.md` item 7, or ledger the deviation. | The wireframe and the shipped surface agree, or the disagreement is greppable. |
| 9 | **G11, G19, G23, G26** – mark S06 TI05 superseded; amend the PRD's Edge Cases overflow row and close its Open Question; make the three amendment dates agree; add a forward pointer at `s05-….md:261`. | No artifact states a superseded position as current. |
| 10 | **G22, G32** – open two ledger entries for the S07 drift the FIS records only in prose: the answered-5xx behaviour (which G32 shows is a real product problem, not just a blank wall) and the wireframe under-description. | Both are greppable by class and status. |

### 4. Verification infrastructure (LOW, Note)

| # | Finding | Acceptance criterion |
|---|---|---|
| 11 | **G05** – at minimum add `expect(postItsAreLegible(0.2, 11.2)).toBe(false)` to a `web` test, since that function is imported by no test today. Separately decide whether the projection spec belongs in a `npm test`-reachable gate. | Reverting the floor turns something in `npm test` red. |
| 12 | **G08** – add a `tsconfig.test.json` covering `api/test`, `web/test`, `visual`, wired into `npm run typecheck`. | `display-link-structure.test.ts:193`'s missing `prompt`/`roundKind` fails the build. Expect unrelated errors to surface; triage separately. |
| 13 | **G34** – assert over `withoutComments(worker)`. | Deleting `sw.js:107-109` turns `display-structure.test.ts` red. |

### 5. Mechanical hygiene (LOW, all Fix)

| # | Finding | Acceptance criterion |
|---|---|---|
| 14 | **G10** – `npx prettier --write api/test/display-link.integration.test.ts`; correct the four story records to name three long-standing files. | `format:check` flags exactly three files, all predating this bundle. |
| 15 | **G09** – replace `—` with `–` in the ten named documents, outside code fences. | Zero em dashes in the feature's documents. |
| 16 | **G12** – point `post-it-repository.ts:656` at `discard.integration.test.ts` and re-wrap the line. | The comment names a test that exists. |
| 17 | **G21** – scope the S08 ASSUMPTIONS caveat to the held-item fixture; this report's verification section is the evidence. | The block no longer claims green tests are unrun. |

### 6. Needs an owner decision before any code changes (Note)

| # | Finding | Decision required |
|---|---|---|
| 18 | **G33** | Demonstrate the EvalPlanQual race first (verification command in the finding). If real, decide between adding `NOT_DISCARDED` to `heldBy` and the delete guard, or a storage-level partial constraint. |
| 19 | **G32** | Take the decision the S07 FIS deferred: should an answered 5xx keep the Board on the wall with the staleness indicator, rather than asserting the link is dead and instructing a revocation? |
| 20 | **G37** | Where does rate limiting live for the anonymous route – edge/ingress, or a PostgreSQL counter as `AGENTS.md` prescribes? Record either way. |
| 21 | **G15, G16, G17, G18, G24, G25, G27, G28, G35, G36** | Test-strength, rare-race and documentation items. **G24 and G27 are already OPEN ledger entries** and stay open; the rest are worth a single triage pass rather than individual decisions. |

### Not remediation – accepted as correct

The three `OPEN` ledger entries are confirmed accurate and correctly left open: S02's unobservable
actor field (a test-strength gap the agent that would benefit from closing it correctly refused to
close), S05's archived discarded-list refusal (S05's own Structural Criterion 4 forbade the fix; the
Report slice must settle it), and S08's uncaptured held item (needs a fixture, not a decision).

---

## Recurring Traps (candidates for `docs/LEARNINGS.md`)

Two defect classes repeated often enough in this one bundle to be worth an entry, and one of them is
a **repeat of an entry that already exists** – which is the signal that prose alone is not holding it
and an enforcing check is needed.

### 1. A guard narrower than its name – four instances, one already in LEARNINGS

| # | Instance | Status |
|---|---|---|
| 1 | Two vote-anonymity guards read file *names* rather than the import graph; a 195 kB authenticated client shipped to an anonymous room machine before a review caught it | fixed during S07, recorded in its ledger |
| 2 | **G31** – the display route's table allow-list extracts **backtick SQL only**, blind to three single-quoted statements on its own graph | **open, HIGH** |
| 3 | **G07c** – the API-side import walk matches single-quoted imports only, where its web-side twin was widened to `['"]` | open, LOW; the S07 FIS records it and leaves it |
| 4 | **G07b** – guard vocabulary misses `pollResults`, `choiceCounts`, `selectedChoice`, `answerCounts`, `score`, `sentiment` | open, LOW |

`docs/LEARNINGS.md:64` already carries **"A SQL-scanning guard must read all three quote styles"**,
written after S05 hit exactly instance 2, and `api/test/discard-structure.test.ts:77-83` already
contains the correct implementation with a docblock explaining it. The lesson was written down, and
then not applied to the highest-stakes guard in the bundle.

**Recommended enforcing check** (the entry can be deleted once this exists): a shared
`sqlStringsIn` / `importsIn` helper in one place that every structure guard imports, with a
self-test asserting each extractor finds a known single-quoted statement and a known double-quoted
import. A lint rule cannot catch this; a shared helper plus a self-test can, and it converts a
recurring judgement call into a structural property.

### 2. A mid-run owner decision amended into some artifacts and not others – four instances

`G01` (four artifacts still state the reversed position, including a PASS row), `G11` (TI05 not
marked superseded), `G19` (the PRD's Edge Cases row and Open Questions), `G23` (three artifacts, two
different dates). Two further candidates were **withdrawn** by the Findings Filter (`G20`, `G26`), so
the class is real but smaller than it first looked.

The bundle also contains the model for doing it right: the legibility floor's dated
`### Amendment — 2026-09-01` block in `design-decisions.md`, which leaves the original prose
byte-intact and states what changed and why. The three decisions that drifted got no such block.

**Recommended enforcing check**: make `Stale targets:` mandatory and enumerated on every
`design-changed` and `spec-stale` ledger entry – today only 1 of 18 entries populates it, and the one
entry that should have named four documentation files left it as `–`. That single field is what turns
"the code half was closed" into "and here is what still says otherwise."

Both should be appended via the `andthen:ops` skill (`update-learnings add`); this review is
read-only and does not write them.
