# Gap Review (re-review after remediation) – Facilitator Board View and Post-it Categorisation

> **Review mode used**: `gap` (single lens)
> **Review target (requirements baseline)**: `docs/specs/facilitator-board-and-categorisation/plan.json` and the bundle it governs – `prd.md`, `s01`–`s08` FIS files, and the eight sibling `*.reconciliation-ledger.md` files
> **Resolved implementation root** (`CODE DIRECTORY:`): `C:\git\confApp`
> **Source Trust**: trusted-local
> **Completed story IDs**: S01–S08 (`plan.json` reports all eight `done`)
> **Prior review**: `docs/specs/facilitator-board-and-categorisation/facilitator-board-and-categorisation-gap-review-claude-2026-09-02.md` (FAIL; 37 findings, 3 HIGH)
> **Intent Context**: `prd.md` (Executive Summary, MVP Boundary, Out of Scope, Constraints, Decisions Log); `plan.json` → `overview.summary`, `sharedDecisions`, `bindingConstraints`, `executionNotes`
> **Project Rules Context**: `AGENTS.md`, `docs/guidelines/CRITICAL-RULES-AND-GUARDRAILS.md`
> **Reconciliation Ledger**: eight per-story ledgers. **22 entries – 16 `CLOSED`, 6 `OPEN`** (was 18 / 15 / 3)
> **Findings Filter**: inline self-check against the shared calibration references, under the same verdict-discipline floor. Recorded rather than papered over – see § Findings Filter Result
> **Date**: 2026-09-02

---

## Executive Summary

The remediation pass did real work and most of it holds. **The entire documentation
reconciliation is genuinely closed** – twelve findings across four wireframe artifacts, three FIS
files, the PRD, four story records and three new ledger entries, checked one by one against the
files rather than against the remediation's own account. **G03's stated acceptance criterion is
met**, through the accessibility tree rather than by assertion. **G30's leak is closed and I
reproduced the proof against a real `nginx:alpine` with a refusing upstream** – 1 token occurrence
before, 0 after, with the 502 still visible in the redacted access log.

**The two credential findings the caller asked me to attack hardest are not closed.** Both were
proved by execution, not by reading:

- **G29 is open on both halves.** The API-side normalisation collapses `/{2,}` and lower-cases,
  which covers exactly the two spellings the prior report happened to name and nothing else. Over a
  **raw socket against the real app with the production logger configuration**, `/%61pi/display/<t>`
  and `/api/%64isplay/<t>` write the live token unredacted to the API's log line; `/api/display%2f<t>`,
  `/api%2Fdisplay/<t>`, `/./api/display/<t>`, `/foo/../api/display/<t>`, `/api/./display/<t>` and
  `/api%09/display/<t>` write it to **both the log and the 404 response body**. S04's Structural
  Criterion 4 – *"the token must never reach a log line"* – is still falsified. And the **nginx half
  was not touched at all**: against a real container, `//api/display/<t>`, `/API/display/<t>`,
  `//display/<t>`, `/DISPLAY/<t>` and `/api/display%2f<t>` are written verbatim to the access log –
  five lines, one of them (`//display/<t>`) a **200 that successfully serves the projected board**,
  so the leak happens on a working request with no signal that anything is wrong.
- **G31 is half closed, and the half that closed is the half that was cheap.** Widening to every
  quoted string surfaced a prose false positive, and the narrowing chosen – *the string must open
  with a statement verb* – reopens the guard to four of five hostile shapes. Mutation-tested in
  memory over the route's real 11-module closure: a fragment constant, a parenthesised subquery, a
  leading-SQL-comment statement and a tail fragment spliced into a template literal are **all
  invisible**, and so is the codebase's own `NOT_DISCARDED` (`post-it-discard-repository.ts:56`) –
  a single-quoted SQL fragment that does not open with a verb. That is not a hypothetical shape; it
  is the idiom this codebase already uses for shared SQL. **And the self-test written to stop the
  fix regressing is vacuous**: `from category` appears in **7 backticked** statements in
  `category-repository.ts`, so deleting `quotedSql` entirely – reverting G31 completely – leaves the
  self-test green.

**On the em-dash editorial note, which the caller asked me to judge**: it is honest and adequate. It
is dated, it names the guideline and the finding, it scopes the amendments' *"left exactly as it was
written"* and *"byte-intact"* claims to wording rather than bytes, and it states plainly that no
word, decision or reason changed. It sits in the file whose amendments it scopes, above them. That
is the right shape. Two residues: the sweep did not reach the bundle's **wireframe HTML** (~63 em
dashes remain in ordinary prose across six files), and the S07 ledger repeats *"the original prose is
byte-intact"* in a different file, out of the note's reach.

**On the deliberate deferrals, judged**: the reasons hold. G04 is genuinely unfalsifiable by any
test as the race tests are written, and the honest thing was to say so – it is recorded, not hidden.
G05 and G08 do need harness work whose blast radius is unrelated errors, and deferring is defensible.
G33 at confidence 50 should not be fixed before the EvalPlanQual race is demonstrated. G34 and the
LOW cluster are correctly parked. **One Fix-routed finding is in neither account**: G07 (b) and (c)
are unchanged, and G07c is literally the same guard-narrowness class that just recurred inside the
G31 fix.

**Verification reproduced independently and matches the caller's stated state exactly**: `npm test`
**92 files / 1554 tests passed**; `visual/session-activities.spec.ts` **18 passed**;
`visual/display-board.spec.ts` **14 passed**; typecheck, lint and build clean; `format:check` flags
**3** files, all long-standing (G10's fourth is corrected and the four story records now say three).
Working tree unmutated by this review – all probes ran from `.agent_temp/`, which is gitignored, and
the two source mutations were in-memory only.

## Verdict

| Dimension     | Score | Threshold | Status |
|---------------|-------|-----------|--------|
| Functionality | 7/10  | >= 7      | PASS |
| Completeness  | 9/10  | >= 9      | PASS |
| Wiring        | 7/10  | >= 8      | FAIL |

**Overall: FAIL**

CONVERGED: no – new `code-defect` findings at HIGH (R01, R02, R03) and MEDIUM (R04, R05, R06)
Auto-Remediation: PENDING

**Scoring rationale.**

*Functionality* **7** (unchanged, PASS). The core happy path works and every specified requirement is
met on canonical input. G30's leak is closed, which is a real improvement; G29's is not, and it still
falsifies a named Structural Criterion on the feature's one bearer credential. The gaps remain a
malformed-URL path and a proxy/log path rather than a broken behaviour – minor gaps, not
all-edge-cases-handled. It does not rise above 7 while the criterion is still falsifiable by
execution.

*Completeness* **9** (was 8, now PASS). The single deduction the prior review named was G03, and its
stated acceptance criterion – four `aria-label`s mirroring the sibling pattern plus a `getByRole`
assertion over a two-Category board – is met exactly, and the names are unique (proved: `getByRole`
throws on a duplicate, and the test loops both Categories). The whole documentation reconciliation
closed. Still no stubs, TODOs or placeholders anywhere in the bundle. The deduction that keeps it off
10 is R05: the fix names the subject by suppressing the destination the binding design decision
requires spoken, plus the h4 heading skip the remediation plan named and did not insert.

*Wiring* **7** (was 8, now FAIL). Product wiring is complete and proved by 1554 tests, 32 visual
tests, typecheck, lint and build. The deduction is verification wiring, and it got worse rather than
better: the two pre-existing holes stand by design (G05, G08), and the remediation added two more –
`error_log … crit;` is a claimed security property that **no test asserts**, so it can be deleted
silently (R06); and G31's self-test is **provably vacuous**, so it reads as a guard against exactly
the regression it cannot detect (R04). A guard that cannot fail is worse than no guard, because it
consumes the attention a real one would get. Four verification-wiring holes, two of them newly
minted and one of them actively misleading, is 7.

**What stands between this bundle and PASS**: R01 + R02 (finish G29 – normalise percent-decoded and
dot-segment spellings, or stop `routeNotFound` echoing the path at all, and extend the nginx map),
R03 + R04 (replace the leading-verb filter with something that does not drop SQL fragments, and make
the self-test detect its own removal), and R06 (assert the `error_log` directive). R05 is a
correctness fix on the same four controls the remediation already touched.

**Ledger annotations**: the three `OPEN` entries the caller named are **confirmed still OPEN and
still accurate** – S02 `accepted-and-ignored-is-inferred-not-observed`, S05
`discarded-list-refused-after-archival`, S08 `held-item-not-captured`. The remediation added **three
more**, all correctly `OPEN` with populated `Falsifier` and `Override reason` fields: S07
`answered-5xx-clears-the-projected-wall` (G22/G32), S07
`design-decisions-under-describes-the-projected-surface` (G22), S08
`attendee-wireframe-draws-no-staleness-indicator` (G06). **Six OPEN, sixteen CLOSED, twenty-two
entries.** The `CLOSED` entry the prior review partially refuted – S06
`c1-removal-unreachable-from-the-discarded-post-its-surface` – now carries a five-item enumerated
`Stale targets:` field and a dated closure note. That refutation is discharged.

---

## Coverage Matrix

Rows below are this pass's own evidence. Every HIGH and MEDIUM was proved by execution, not by
reading, and every command is recorded so it can be re-run.

### The three HIGH credential findings – the caller's primary named concern

| surface | evidence read | positive proof | falsifier attempted | result |
|---|---|---|---|---|
| **G29** – one normalised gate at all three sites | `api/src/routes/display.ts:87-94` (`isDisplayPath`), `api/src/app.ts:68`, `:186`, `:223` | All three call sites now route through `isDisplayPath`; it collapses `/{2,}`, strips the query and lower-cases. The four spellings the prior report named are covered, and `api/test/display-link.integration.test.ts:896-928` pins them against a **live** token, asserting body, headers and `redactDisplayToken` together | **Falsifier: is the normalisation complete?** Raw-socket probe against the real app built with the production logger shape (`loggerOptions: {level:'info'}`, matching `api/src/index.ts:49`), 11 spellings. `/%61pi/display/<t>` and `/api/%64isplay/<t>` → **token in the log line**. `/api/display%2f<t>`, `/api%2Fdisplay/<t>`, `/./api/display/<t>`, `/foo/../api/display/<t>`, `/api/./display/<t>`, `/api%09/display/<t>` → **token in the log line *and* in the `ROUTE_NOT_FOUND` body** | **finding (R01, HIGH)** |
| ↳ the two mechanisms, separated | same | – | find-my-way percent-decodes for *matching* but Fastify hands the handler the **raw** `request.url`, so `/%61pi/…` reaches the route (correct 404 envelope) and leaks only to the log; `%2F` is correctly *not* decoded to a separator, so `/api/display%2f<t>` matches no route, falls to `routeNotFound`, and leaks to the body as well. Two distinct paths, one gate | covered |
| ↳ the docblock's stated reason | `display.ts:82-85` – *"Percent-encoding is not decoded here: the router rejects a malformed escape before any handler runs"* | – | **Falsifier**: true of `%zz`; false of `%61`, which is well-formed, is not rejected, and is the shape that actually leaks. The justification does not cover the case | **finding (R08, LOW)** |
| **G29, nginx half** | `web/nginx/default.conf.template:20-24` – the `map $request_uri $confapp_logged_uri` block | The two canonical prefixes are redacted | **Falsifier: was the map extended, as the remediation plan's item 1 required?** No – unchanged, case-sensitive `~`, keyed on the **unmerged** `$request_uri`. Verified against a real `nginx:alpine` container serving the rendered template with a refusing upstream: 8 requests, **5 access-log lines carrying the raw token** – `//api/display/<t>` (502), `/API/display/<t>` (200), `//display/<t>` (**200, serves display.html**), `/DISPLAY/<t>` (200), `/api/display%2f<t>` (502) | **finding (R02, HIGH)** |
| **G30** – `error_log … crit;` | `web/nginx/default.conf.template:44-54` | **Reproduced against a real container.** Same template, same html root, `API_UPSTREAM=http://api:8080` with no such host; one request to `/api/display/<t>`. Without the directive: `[error] … api could not be resolved … request: "GET /api/display/<t> HTTP/1.1"` → **1 token occurrence**. With it: **0 token occurrences**, and the 502 still present in the redacted access log as `"GET /api/display/<token> HTTP/1.1" 502` | **Falsifier: does `crit` suppress the leak in *every* log nginx writes?** Attempted a `[crit]`-level request-context line by `chmod 000` on `display.html`: nginx answered 403 and logged nothing above `crit`. No residual leak demonstrated | **covered – the fix works** |
| ↳ what operational signal was lost | same, and the two container runs | – | **Falsifier**: is the comment's *"a duplicate of a signal the access log already carries"* accurate? No. The suppressed line carried the **cause** (`api could not be resolved (110: Operation timed out)`); the access log carries only `502`. Connection-independent resolver errors survive (they are logged in the main context), but that is incidental, not by design. Every request-context `[error]` for **every** location is now silenced, not only the display ones | **finding (R07, LOW)** |
| ↳ is the directive guarded? | `web/test/display-build.test.ts:160-190` | – | **Falsifier**: `grep -n error_log web/test/display-build.test.ts` → **nothing**. The test asserts the `log_format`/`access_log` pair only. Deleting `error_log … crit;` leaves the suite green – the same shape the prior report's acceptance criterion required be closed | **finding (R06, MEDIUM)** |
| **G31** – the SQL allow-list's quote coverage | `api/test/display-link-structure.test.ts:414-447` | `quotedSql` now reads single- and double-quoted strings, and the specific case the prior report named – verb-leading single-quoted statements in `category-repository.ts` – **is** caught. Confirmed by an in-memory mutation over the route's real closure: `'select 1 from vote'` appended to `category-repository.ts` → `CAUGHT ["vote"]` | **Falsifier: can the narrowed filter be evaded by a statement that does not open with a verb?** Yes, four ways, all mutated in memory over the same 11-module closure and all **NOT CAUGHT**: `const VOTE_JOIN = 'join vote v on v.post_it_id = p.id'`; `const X = '(select count(*) from ballot b)'`; `const X = '/* tally */ select count(*) from vote'`; a tail fragment `'left join vote v using (post_it_id)'` spliced into a template literal | **finding (R03, HIGH)** |
| ↳ is that shape hypothetical? | `api/src/rounds/post-it-discard-repository.ts:56` | – | **Falsifier**: run the shipped extractor over `NOT_DISCARDED` – a **single-quoted SQL fragment on this very closure**, exported precisely so there is one place the rule lives. Narrow extractor → `[]`. Widened extractor → `["post_it_discard"]`. The idiom the guard is now blind to is the idiom the codebase already uses | **finding (R03, evidence)** |
| ↳ does the self-test defend the fix? | `display-link-structure.test.ts:449-459` – *"the extractor must see single-quoted SQL in category-repository.ts"*, asserting `some(sql => /\bfrom category\b/i.test(sql))` | – | **Falsifier**: how many **backticked** statements in that file contain `from category`? **7.** Reverting the whole G31 widening – deleting `quotedSql` from `statementsIn` – leaves the self-test **green** (executed). The guard written to stop the fix regressing cannot detect the fix's removal | **finding (R04, MEDIUM)** |
| G07 (b) vocabulary and (c) import walk | `api/test/post-it-structure.test.ts:597` (`VOTE_SHAPED`, unchanged); `display-link-structure.test.ts:364,578` (`/from '(\.[^']+\.ts)'/g`, unchanged) | – | **Falsifier**: was this Fix-routed finding remediated or deferred? Neither – it appears in no account, and (c) is the same guard-narrowness class that recurred inside the G31 fix | **finding (R10, LOW)** |

### G03 – the P0 accessibility criterion

| surface | evidence read | positive proof | falsifier attempted | result |
|---|---|---|---|---|
| Four Category controls carry an accessible name | `web/src/activities/SessionActivitiesPanel.tsx:2438,2462,2476,2495` | `aria-label={\`Rename the category “${category.name}”\`}` and three siblings, mirroring the existing Post-it pattern at `:2024`/`:2050`. The panel now carries 6 `aria-label`s where it carried 2 | **Falsifier: present, or actually useful and unique?** `web/test/CategoryBoard.test.tsx:296-312` renders a **two-Category** board and resolves all four controls on **both** by `getByRole('button', {name})`. `getByRole` throws on more than one match, so the test proves uniqueness rather than presence. Executed: **green**, and the whole suite is green | covered |
| ↳ does the name survive the interaction? | `visual/session-activities.spec.ts` re-run | **18 passed** at 375 / 768 / 1280 px, including the sorting surface at the design ceiling | – | covered |
| ↳ what the label now suppresses | `docs/wireframes/facilitator-board-and-categorisation/design-decisions.md:45-46,60-63` vs `SessionActivitiesPanel.tsx:2462-2481` | – | **Falsifier**: the binding design decision states *"Reorder is an explicit control that names its own outcome – `Move up – to position 1`"* and *"Naming the destination in a label rather than implying it by position is what makes the same control legible to someone reading the screen, **someone hearing it announced**, and someone using it one-handed."* `aria-label` **overrides** element content, so the accessible name is now `Move the category “Tooling” up` and the destination ordinal is no longer announced. Same for the in-flight states `Moving…` / `Working…` | **finding (R05, MEDIUM)** |
| ↳ the rest of the G03 cluster | `SessionActivitiesPanel.tsx:1164` (`h3`), `:2353`, `:2416` (`h5`) | – | **Falsifier**: the remediation plan's item 5 said *"Insert the missing `h4`"*. Heading order is still `h3` → `h5`; no `role="status"` announces a successful rename, reorder or removal, while every other transient message in the file carries one | **finding (R11, LOW)** |
| ↳ is the criterion honestly ticked? | `s02-…:115` | The criterion stands `[x]` and is now substantially met – each control names its subject and the surface is operable by AT | **Falsifier**: is the fix recorded anywhere? No FIS observation, no ledger entry. Given the criterion is now met rather than unticked, this is acceptable but leaves the M5/M6/L10 cluster's residue untracked | folded into R11 |

### Documentation reconciliation – the caller's third named concern

Twelve findings, each checked against the files rather than against the remediation's account.

| finding | evidence read | result |
|---|---|---|
| **G01** – four artifacts stating the retired position | `design-decisions.md:101` (original prose intact) + `:106` superseding blockquote + `:117,136` dated `### Amendment – 2026-08-31`; `discarded-postits.html:267-268` annotation; `page-inventory.md:78` + `:81` amendment; `validation-report.md:113` **PASS → SUPERSEDED**, with the re-run date and the reason the row must not be read as certifying the property; S06 ledger `Stale targets:` now enumerates all five targets | **closed** – and the amendment uses the same shape as the legibility-floor one, which is exactly what the finding asked for |
| **G02** – cited captures not in version control | `docs/wireframes/facilitator-board-and-categorisation/screenshots/` now holds `display-board-projection-1920-{floor,skewed-40,skewed-80,unreachable,loading}.png`; `git status --untracked-files=all` lists 18 files there, and `git check-ignore -v` resolves to `.gitignore:21 !docs/wireframes/**/screenshots/**`; citations corrected at `design-decisions.md:243,294` and `s07-…:291,368,370` with a dated note | **closed** |
| **G06** – attendee wireframe draws no staleness indicator | New S08 ledger entry `attendee-wireframe-draws-no-staleness-indicator`, `OPEN`, with a populated Falsifier and the S01-owns-wireframes override reason | **closed** (correctly, as a tracked deviation rather than a redraw) |
| **G09** – em dashes | `prd.md`, `requirements-clarification.md`, `validation-report.md`, `page-inventory.md`, `s02`, `s03`, `s06`, `s06-ledger` all at **0** | **partially closed → finding (R09, LOW)**: `attendee-board.html` 14, `discarded-postits.html` 8, `facilitator-sorting.html` 29, `index.html` 8, `projected-board-*.html` 10, `design-decisions.md` 1, `s07-….md:163` 1 – all ordinary prose, sampled and confirmed |
| ↳ the editorial note | `design-decisions.md:13-16` | **judged sound.** Dated, names the guideline and the finding, scopes the amendments' *"left exactly as it was written"* and *"byte-intact"* claims to wording rather than bytes, states no word/decision/reason changed, and sits above the amendments it scopes. This is the right way to do it |
| ↳ residue | `s07-…reconciliation-ledger.md:29` | **finding (R13, LOW)** – repeats *"the original prose is byte-intact"* in a different file, out of the note's reach |
| **G10** – `format:check` | `npx prettier --check .` → **3 files**, all long-standing; S08 record at `:222` corrected in place with the reason a per-story "not mine" rule has no bundle backstop | **closed** |
| **G11** – S06 TI05 | `s06-…:170` now carries an inline **SUPERSEDED 2026-08-31** marker naming OC01, the amended Criterion 5, the design-decisions amendment and the ledger entry | **closed** |
| **G12** – `edit`'s comment names the wrong test | `post-it-repository.ts:657-658` now cites `api/test/discard.integration.test.ts` **and** quotes the test's name; the line is re-wrapped | **closed** |
| **G19** – PRD Edge Cases / Open Questions | `prd.md:652` now opens *"Settled 2026-09-01 (owner decision, during S07); this row is the pre-amendment statement and is superseded in one respect"* and states the floor, the count sentence and the binding artifact | **closed** |
| **G21** – S08 ASSUMPTIONS block false | `s08-…:212` – the original block struck through, retired with the 2026-09-02 evidence (92/1552, both visual specs), C16 closed for all but the held item, and the residue scoped to the one fixture | **closed** |
| **G22 / G32** – S07 drift held only in prose | Two new `OPEN` S07 ledger entries with populated `Falsifier` and `Override reason`; `DisplayBoardView.tsx` correctly **unchanged**, since the finding routes to an owner decision | **closed** (as tracking, which is what the finding asked for) |
| **G23** – three artifacts, two dates | S07 ledger note now states **2026-09-01** with an explicit correction note explaining the local-midnight crossing; `design-decisions.md` and the FIS run heading agree | **closed** |

### Deliberate deferrals – judged

| finding | stated reason | judgement |
|---|---|---|
| **G04** – `FOR UPDATE` unfalsifiable | *"a real gap I did not close"* | **Reason holds.** Both race tests park the loser until the rival has committed, so the loser takes a post-commit snapshot and the `live` join alone suffices; the lock is genuinely undefended. Declaring it rather than papering it is the correct disposition. The cheap half – a structural guard asserting `for update` and `order by id` in `renumber`, beside `category-structure.test.ts:574` – is still available and was not taken |
| **G05** – legibility floor's gate outside `npm test` | *"needs new harness setup"* | **Reason holds for the harness half.** But the one-line half does not need a harness: `postItsAreLegible` is still imported by **no test** (`grep -rn postItsAreLegible web/ visual/` finds only the build artefacts), and `expect(postItsAreLegible(0.2, 11.2)).toBe(false)` would run in `npm test` today. Contributes to Wiring |
| **G08** – no tsconfig covers test sources | *"needs new harness setup"* | **Reason holds.** No `tsconfig.test.json`; `npm run typecheck` is clean and would not be after adding one. Project-wide and pre-existing; triaging the unrelated errors is a separate job |
| **G33** – EvalPlanQual race | *"needs the race demonstrated before choosing a fix"* | **Reason holds.** Confidence 50, unobserved, and the two candidate fixes differ in blast radius. Demonstrating first is right |
| **G34** – sw guard matches the comment | not remediated | **Reason holds** (the property is covered behaviourally by `web/test/service-worker.test.ts`), though the fix is one word: `display-structure.test.ts:222` still reads `expect(worker).toMatch(/\/display\//)` against uncommented source |
| **G13–G18, G24–G28, G35–G37** | LOW, single triage pass | **Reason holds.** Spot-checked G24 and G27 – both still accurate and both still correctly `OPEN` in their ledgers |
| **G07** | *(in neither account)* | **finding (R10, LOW)** – Fix-routed, unaddressed, unrecorded |

### Verification evidence (reproduced independently)

| surface | evidence | result |
|---|---|---|
| Full unit + integration suite | `TEST_DATABASE_URL=postgres://confapp:local-dev-only@172.23.72.231:5434/confapp_test npm test` | **92 files / 1554 tests passed**, exit 0 |
| Facilitator + Attendee visual gate | `npm run dev:web` → port 5189; `WEB_URL=http://localhost:5189 npx playwright test visual/session-activities.spec.ts` | **18 passed**, including the sorting surface and the attendee board at the design ceiling at 375 / 768 / 1280 px |
| Projected-surface visual gate | same, `visual/display-board.spec.ts` | **14 passed** |
| Typecheck / lint / build | `npm run typecheck`, `npm run lint`, `npm run build` | all exit 0; display chunk 6.48 kB vs main 112.20 kB |
| `format:check` | `npx prettier --check .` | 3 files: `api/test/join-code.test.ts`, `visual/conferences.spec.ts`, `web/src/components/JoinCodePanel.tsx` – all long-standing. G10 discharged |
| Plan status hygiene | `plan.json` `stories[].status` | all eight `done`; every `fis` resolves; eight ledgers present |
| Ledger arithmetic | all eight ledgers | 22 entries, 16 `CLOSED`, 6 `OPEN`; the three by-design OPEN entries re-derived and confirmed accurate |
| Working tree unmutated by review | `git status --porcelain --untracked-files=all` → 130 entries; `git check-ignore` confirms `.agent_temp/` ignored | covered – all probes ran from `.agent_temp/`; the two source mutations were in-memory only and touched no file |

---

## Guardrails Coverage

**Guardrails Coverage: 11 checked, 1 finding.**

| Rule (source) | Result |
|---|---|
| Never attribute a vote to a voter; anonymity is storage-level (`AGENTS.md`; ADR-006) | pass on the storage guarantee – no new table joins to `vote`, no voter link, baseline table set unchanged at nine. The **guard** over it is weaker than the prior review measured (R03) |
| Never tie the schema to a managed provider's proprietary features (ADR-003) | pass – no migration changed in this pass |
| Never rely on in-process state between requests | pass – `isDisplayPath` is a pure function; no new state |
| Never widen offline support beyond schedule reads and Post-it queueing | pass – nothing in this pass touches the queue or `sw.js` |
| Never key a user on their email address | pass |
| Never ship a fixed-width or desktop-only layout | pass – 32 visual assertions re-run green at 375 / 768 / 1280 and the 1920 projection class |
| Never commit `.env` files or credentials | pass |
| No AI attribution anywhere (`CRITICAL-RULES` → Operational) | pass – grep over every changed source and doc: zero hits |
| Temp files in `.agent_temp/`, never the repo root | pass |
| Real dates only (`CRITICAL-RULES` → Operational) | pass – G23 closed; the three artifacts agree on 2026-09-01 with a correction note |
| En dashes (–), not em dashes (`CRITICAL-RULES` → Operational) | **finding (R09)** – the `.md` sweep landed; ~63 remain in the bundle's own wireframe HTML plus two in prose |

---

## Findings

Ordered by severity. `Class` and `Routing` follow the review contract: `Fix` requires confidence
≥ 75, primary scope, class `code-defect`, and a mechanical, uniquely determined correction.

### HIGH

#### R01 – G29 is not closed on the API side: percent-encoded and dot-segment spellings still write the token to the log line and the 404 body

- **Reviewer**: orchestrator, proved by execution
- **Severity**: HIGH · **Confidence**: 100 · **Scope relation**: primary
- **Location**: `C:\git\confApp\api\src\routes\display.ts:87-89`; consumed at `C:\git\confApp\api\src\app.ts:68`, `:186`, `:223`
- **Finding**: `isDisplayPath` normalises exactly two things – runs of `/`, and case. Those are the
  two spellings the prior report named. Every other spelling that Fastify does not normalise still
  misses the gate. Proved over a **raw TCP socket** (not `app.inject`, which normalises dot segments
  and would have hidden three of these) against the real app built with the production logger shape:

  | request line | 404 body carries token | log line carries token |
  |---|---|---|
  | `/api/display/<t>`, `//api/display/<t>`, `/API/display/<t>` | no | no |
  | `/%61pi/display/<t>` | no | **yes** |
  | `/api/%64isplay/<t>` | no | **yes** |
  | `/api/display%2f<t>` | **yes** | **yes** |
  | `/api%2Fdisplay/<t>` | **yes** | **yes** |
  | `/./api/display/<t>` | **yes** | **yes** |
  | `/foo/../api/display/<t>` | **yes** | **yes** |
  | `/api/./display/<t>` | **yes** | **yes** |
  | `/api%09/display/<t>` | **yes** | **yes** |

  Two mechanisms are at work. find-my-way percent-decodes for *route matching* but Fastify hands the
  handler and the log serializer the **raw** `request.url`, so `/%61pi/…` resolves to the real route
  (correct 404 envelope, no body leak) and leaks only to the log. `%2F` is correctly *not* treated as
  a separator, so `/api/display%2f<t>` matches no route, falls through to `routeNotFound`, and leaks
  to the body as well.
- **Threatened assumption**: S04 Structural Criterion 4 – *"the token must never reach a log
  line"* – and `display.ts:60-68`'s own claim that the redaction exists so the credential is not
  *"written to the API's log on every poll"*. `api/src/index.ts:49` sets `loggerOptions` to a real
  level, so the serializer under test is the production one.
- **Impact**: unchanged from G29 – a live bearer credential over named Post-its written into a 404
  body and into a log stream where it outlives revocation. What changed is only which spellings reach
  it.
- **Suggested fix**: The uniquely determined correction is to stop `routeNotFound` echoing the
  request path at all (the path is attacker-controlled and of no use to a caller who already sent
  it – the framework-error branch at `app.ts:236-238` already reasons exactly this way and does not
  echo). That closes the body half for every spelling at once, present and future. For the log half,
  either percent-decode once before the prefix test (guarding against a decode error) or invert the
  gate to an allow-list of paths known safe to log.
- **Verification needed**: re-run the table above; assert each row returns
  `DISPLAY_LINK_UNAVAILABLE` with a body free of the token, and that the serialized request line is
  free of it. Add the rows to `display-link.integration.test.ts:896`'s loop, which today covers only
  slash and case.
- **Class**: `code-defect` · **Routing**: **Fix** – bounded and uniquely determined by the existing constant, once the echo is dropped.
- **Ledger**: none.

#### R02 – G29's nginx half was not addressed: five spellings write the live token to the container access log, one of them on a request that succeeds

- **Reviewer**: orchestrator, proved against a real `nginx:alpine`
- **Severity**: HIGH · **Confidence**: 100 · **Scope relation**: primary
- **Location**: `C:\git\confApp\web\nginx\default.conf.template:20-24`
- **Finding**: The redacting `map` is unchanged: two case-sensitive patterns keyed on
  `$request_uri`, which nginx forwards **unmerged**. The prior report's remediation item 1 required
  *"extend the nginx map to slash- and case-tolerant patterns"*; it was not done.
- **Evidence**: The template rendered as the entrypoint would render it, run in `nginx:alpine`
  1.31.3 with the SPA root and a refusing upstream. Eight requests, **five access-log lines carrying
  the raw token**:

  ```
  "GET //api/display/<t> HTTP/1.1" 502     ← map missed (unmerged $request_uri)
  "GET /API/display/<t> HTTP/1.1" 200      ← map missed (~ is case-sensitive)
  "GET //display/<t> HTTP/1.1" 200         ← map missed; location ^~ /display/ matched after merging, display.html served
  "GET /DISPLAY/<t> HTTP/1.1" 200          ← map missed
  "GET /api/display%2f<t> HTTP/1.1" 502    ← map missed
  ```

  The three canonical spellings were correctly redacted to `/display/<token>` and
  `/api/display/<token>` in the same run, so the format itself works – the patterns are the gap.
- **Threatened assumption**: the template's opening sentence, *"The Display Link token must never
  reach a log line (S04, FIS Structural Criterion 4)."*
- **Impact**: This is the more reachable half of G29 and it is untouched. `//display/<token>` is
  what a URL built by naive concatenation looks like, it **serves the projected board successfully**
  (200, `display.html`), and it writes the credential to container stdout on every page load with no
  signal to anyone that it happened. `/API/display/<token>` behaves the same way.
- **Suggested fix**: make both map patterns case-insensitive (`~*`) and slash-tolerant
  (`"~*^/+(api/+)?display/+[^/?]+"`), or – stronger and in the same spirit as the API's
  `ANONYMOUS_ROUTES` – replace `$confapp_logged_uri`'s default with an allow-list so an unrecognised
  URI logs a placeholder rather than itself.
- **Verification needed**: re-run the container probe; assert zero token occurrences across all
  eight spellings. Assert the pattern shapes in `web/test/display-build.test.ts` beside the existing
  `map` assertions.
- **Class**: `code-defect` · **Routing**: **Fix** – bounded, and the pattern form is determined by the two spellings the API side already normalises.
- **Ledger**: none. Same defect as S04's own CLOSED HIGH (*"The nginx access log wrote the token"*), one spelling class over.

#### R03 – G31's narrowing reopens the guard to every SQL fragment, including the one the codebase already exports

- **Reviewer**: orchestrator, proved by in-memory mutation over the route's real closure
- **Severity**: HIGH · **Confidence**: 100 · **Scope relation**: primary
- **Location**: `C:\git\confApp\api\test\display-link-structure.test.ts:439-447`
- **Finding**: Widening to every quoted string surfaced a prose false positive (`errors.ts`'s
  *"…did not come from Google."* read as a table named `google`), and the narrowing chosen – the
  string must match `/^\s*(with|select|insert\s+into|update|delete\s+from)\b/i` – drops far more than
  prose. It drops **SQL fragments**, which is how this codebase writes shared SQL.
- **Evidence**: The guard's own extraction and table-collection logic, replicated exactly and run
  over the route's real 11-module closure with one file mutated in memory:

  | mutation appended to `category-repository.ts` | result |
  |---|---|
  | `const X = 'select 1 from vote';` | **CAUGHT** `["vote"]` – the G31 case |
  | `const VOTE_JOIN = 'join vote v on v.post_it_id = p.id';` | **NOT CAUGHT** |
  | `const X = '(select count(*) from ballot b)';` | **NOT CAUGHT** |
  | `const X = '/* tally */ select count(*) from vote';` | **NOT CAUGHT** |
  | `const F = 'left join vote v using (post_it_id)'; const Q = \`select p.id from post_it p ${F}\`;` | **NOT CAUGHT** (only `post_it`) |

  And the decisive one: run the shipped extractor over
  `api/src/rounds/post-it-discard-repository.ts:56` –
  `export const NOT_DISCARDED = 'not exists (select 1 from post_it_discard pd where pd.post_it_id = p.id)'`.
  Narrow → `[]`. Widened → `["post_it_discard"]`. That fragment is **on this route's own closure**,
  is exported *"as a fragment rather than restated per query so there is one place the rule lives"*,
  and is invisible to the guard that claims to read every table the route can reach.
- **Threatened assumption**: ADR-006 and the plan's binding constraint FR7/FR8. Also the guard's own
  new docblock heading, *"Every string literal, not only backticked ones"* – which the code
  immediately contradicts.
- **Impact**: Nothing is exposed today; no vote or ballot table is reachable. What is broken is
  again the only mechanism that would catch it, and it is broken in the same class as before: a
  later edit adding a vote query as a fragment, a subquery, or a commented statement to any module on
  the display graph ships green on the one route that answers without a credential over named
  Post-its. This is the **fifth** instance of "a guard narrower than its name" in this bundle and the
  first introduced by a fix for one of the earlier four.
- **Suggested fix**: Do not filter by leading verb. Two shapes that keep the width and kill the false
  positive: (a) require the string to name a table *and* carry a second SQL token
  (`/\b(select|from|join|where|set|values|into)\b.*\b(from|join|into|update)\s+[a-z_]/i`), or (b)
  keep every quoted string and carry a short written exclusion list beside the allow-list, so a
  future prose false positive is one named line rather than a class of silent false negatives. Either
  way, record `NOT_DISCARDED` as the fixture the extractor must see.
- **Verification needed**: re-run the five mutations above; all five must be caught. Confirm the
  baseline table set is still exactly the nine allow-listed names.
- **Class**: `code-defect` (test coverage) · **Routing**: **Fix** – bounded, in one function, with the failing fixtures already written above.
- **Ledger**: none. Recurrence of `docs/LEARNINGS.md:64`.

### MEDIUM

#### R04 – The self-test written to stop G31's fix regressing is vacuous

- **Reviewer**: orchestrator, proved by execution
- **Severity**: MEDIUM · **Confidence**: 100 · **Scope relation**: primary
- **Location**: `C:\git\confApp\api\test\display-link-structure.test.ts:449-459`
- **Finding**: The self-test asserts
  `statementsIn(categoryRepository).some(sql => /\bfrom category\b/i.test(sql))` under the message
  *"the extractor must see single-quoted SQL in category-repository.ts"*. But `from category` occurs
  in **7 backticked statements** in that file. Deleting `quotedSql` from `statementsIn` entirely –
  a complete revert of the G31 fix – leaves the assertion **green** (executed).
- **Threatened assumption**: the docblock directly above it – *"a guard that silently stopped finding
  statements would go green by reading nothing, which is the failure mode this whole family is prone
  to"* – and *"pinned by the self-test below so the claim and the code cannot drift apart again"*.
- **Impact**: The guard that exists to detect the fix's removal cannot detect the fix's removal. That
  is worse than no self-test, because it consumes the scrutiny a real one would attract – and this
  bundle has now hit that exact shape five times.
- **Suggested fix**: assert on the extractor's *quoted* half specifically, and pin a fixture only it
  can see – e.g. `expect(quotedSql(discardRepository).some(sql => /post_it_discard/.test(sql)))`
  against `NOT_DISCARDED`, which no backtick extractor can reach.
- **Verification needed**: delete `quotedSql` from `statementsIn`; the self-test must go red.
- **Class**: `code-defect` (test coverage) · **Routing**: **Fix** – one assertion, uniquely determined once R03's extractor is chosen.
- **Ledger**: none.

#### R05 – G03's `aria-label`s suppress the reorder destination the binding design decision requires spoken

- **Reviewer**: orchestrator
- **Severity**: MEDIUM · **Confidence**: 90 · **Scope relation**: primary
- **Location**: `C:\git\confApp\web\src\activities\SessionActivitiesPanel.tsx:2462-2481`
- **Finding**: `aria-label` **overrides** element content in the accessible-name computation. The
  Move up / Move down controls render visible text `Move up – to position 1` and now carry
  `aria-label={\`Move the category “${category.name}” up\`}`. The subject is named – which is what
  G03 asked for – and the destination ordinal is removed from what a screen reader announces.
- **Threatened assumption**: `docs/wireframes/facilitator-board-and-categorisation/design-decisions.md:45`
  – *"**Reorder is an explicit control that names its own outcome** – `Move up – to position 1`"* –
  and `:60-63`, which states the reason: *"Naming the destination in a label rather than implying it
  by position is what makes the same control legible to someone reading the screen, **someone
  hearing it announced**, and someone using it one-handed."* The remediation closed one half of that
  sentence by opening the other. Separately this is a WCAG 2.5.3 *Label in Name* (Level A) failure on
  these two controls – the visible label is not contained in the accessible name – which matters for
  speech input. The in-flight states `Moving…` and `Working…` are likewise not announced.
- **Stated fairly**: the region still renders `Position {n} of {m}` as its own paragraph immediately
  above the controls, so the ordinal is available in reading order; and `getByRole` resolves each
  control uniquely on a two-Category board, which is what was missing. This is a narrowing of the
  announcement, not a loss of operability.
- **Suggested fix**: compose rather than replace – `aria-label={\`${visibleText} – ${category.name}\`}`
  or `aria-label={\`Move the category “${name}” up, to position ${index}\`}` – and extend the
  `CategoryBoard.test.tsx` assertion to the composed name, so the destination cannot be dropped
  again. `Rename` and `Remove` are unaffected: their visible text is contained in their new names.
- **Verification needed**: `getByRole('button', {name: /to position 1/})` resolves on a
  three-Category board; `visual/session-activities.spec.ts` still green at three widths.
- **Class**: `code-defect` · **Routing**: **Fix** – mechanical, on the two controls already touched.
- **Ledger**: none.

#### R06 – `error_log … crit;` is a claimed security property that no test asserts

- **Reviewer**: orchestrator
- **Severity**: MEDIUM · **Confidence**: 100 · **Scope relation**: primary
- **Location**: `C:\git\confApp\web\nginx\default.conf.template:54`; `C:\git\confApp\web\test\display-build.test.ts:160-190`
- **Finding**: G30's fix works – I reproduced it against a real container. It is guarded by nothing.
  `grep -n error_log web/test/display-build.test.ts` returns no hit; the test that owns this file's
  logging assertions checks only the `log_format`/`access_log` pair. Deleting the directive leaves
  the suite green. The prior report's acceptance criterion for G30 named this assertion explicitly.
- **Threatened assumption**: the template's own claim, restated in the new comment, that the token
  never reaches a log line.
- **Impact**: The one directive standing between an API outage and the credential in container
  stdout can be removed by anyone tidying this file, with no signal. Same class as R04 and as the
  bundle's four earlier instances.
- **Suggested fix**: `expect(template).toMatch(/error_log\s+\S+\s+crit;/)` beside the existing
  `access_log` assertion, with the two-line reason.
- **Class**: `code-defect` (test coverage) · **Routing**: **Fix** – one assertion, uniquely determined.
- **Ledger**: none.

### LOW

#### R07 – The `error_log` comment overstates what the access log replaces, and repeats itself

- **Severity**: LOW · **Confidence**: 95 · **Location**: `web/nginx/default.conf.template:49-53`
- **Finding**: The comment says *"What is given up is a duplicate of a signal the access log already
  carries"*. It is not a duplicate. In the container run, the suppressed line was
  `[error] … *1 api could not be resolved (110: Operation timed out), client: …, request: "GET /api/display/<t> …"` –
  it carried the **cause**; the access log carries `502` and nothing else. The scope is also wider
  than stated: `crit` silences every request-context `[error]` for **every** location in this server
  (upstream timeouts, `no live upstreams`, `open()` failures, invalid upstream headers), not only the
  display ones. Connection-independent resolver errors happen to survive because they are logged in
  the main context, which is incidental rather than designed. The paragraph also contains two
  consecutive sentences opening *"What is given up is"*, reading as an editing artifact.
- **Suggested fix**: state the trade honestly – the cause of a 502 is no longer logged anywhere,
  server-wide, and the access log gives only the status and the rate – and say why that is accepted.
- **Class**: `code-defect` (documentation) · **Routing**: **Note** – the wording is an authoring decision.

#### R08 – `isDisplayPath`'s stated reason for not decoding percent-encoding does not cover the case that leaks

- **Severity**: LOW · **Confidence**: 100 · **Location**: `api/src/routes/display.ts:82-85`
- **Finding**: *"Percent-encoding is not decoded here: the router rejects a malformed escape before
  any handler runs, and decoding attacker-controlled input to make a security decision is the larger
  hazard."* True of `%zz`. The spellings that actually leak (R01) use **well-formed** escapes –
  `%61`, `%64`, `%2f`, `%09` – which the router does not reject. The comment therefore reads as a
  reasoned exclusion of a case that was not considered.
- **Class**: `code-defect` (documentation) · **Routing**: **Fix** – paired with R01; the comment must say what the fix decided.

#### R09 – The em-dash sweep did not reach the bundle's wireframe HTML

- **Severity**: LOW · **Confidence**: 100 · **Location**: `docs/wireframes/facilitator-board-and-categorisation/{attendee-board,discarded-postits,facilitator-sorting,index,projected-board-*}.html`; `design-decisions.md:29`; `s07-the-projected-board-view.md:163`
- **Finding**: The `.md` half of G09 is fully closed (`prd.md`, `requirements-clarification.md`,
  `validation-report.md`, `page-inventory.md`, `s02`, `s03`, `s06` and the S06 ledger all at zero).
  ~63 em dashes remain in the six wireframe HTML files, sampled and confirmed to be ordinary prose
  and rendered UI copy (*"Waiting to send — on this device only"*), not code fences or quoted
  third-party text. `design-decisions.md:29`'s single survivor is inside an inline code span quoting
  UI copy, so it is arguably faithful quotation; `s07-…:163` is plain prose.
- **Class**: `code-defect` (project standards) · **Routing**: **Fix** – mechanical substitution, though the rendered UI copy in the wireframes should be changed together with whatever it mirrors.

#### R10 – G07 is Fix-routed and appears in neither the remediated nor the deferred account

- **Severity**: LOW · **Confidence**: 100 · **Location**: `api/test/post-it-structure.test.ts:597`; `api/test/display-link-structure.test.ts:364,578`
- **Finding**: `VOTE_SHAPED` is unchanged, so `pollResults`, `choiceCounts`, `selectedChoice`,
  `answerCounts`, `score` and `sentiment` still escape both halves of the Attendee-board guard; and
  the API-side import walk still matches `/from '(\.[^']+\.ts)'/g`, single quotes only, where its
  web-side twin uses `['"]`. Neither is a defect on its own – the routing is defensible – but the
  finding was routed **Fix** and is unaccounted for, and (c) is the same guard-narrowness class that
  recurred inside the G31 fix.
- **Class**: `code-defect` (test coverage) · **Routing**: **Note** – restore it to a triage list rather than applying it blind.

#### R11 – G03's heading skip and success announcements stand, and the fix is recorded nowhere

- **Severity**: LOW · **Confidence**: 95 · **Location**: `web/src/activities/SessionActivitiesPanel.tsx:1164`, `:2353`, `:2416`
- **Finding**: Heading order is still `h3` → `h5`; the remediation plan's item 5 named the missing
  `h4` explicitly. No `role="status"` announces a successful rename, reorder or removal, while
  `:1290`, `:1555`, `:1732` and `:2293` all carry one for other transient messages. The four
  `aria-label`s are recorded in no FIS observation and no ledger entry, so the M5/M6/L10 cluster's
  residue is again untracked prose.
- **Class**: `code-defect` · **Routing**: **Note** – the `h4` is mechanical; the announcements need a wording decision.

#### R12 – The two recommended `docs/LEARNINGS.md` entries were not appended, and the class recurred again during remediation

- **Severity**: LOW · **Confidence**: 100 · **Location**: `docs/LEARNINGS.md`
- **Finding**: `docs/LEARNINGS.md:64` still carries the single S05 entry; neither recommended entry
  was added. In the interval, the "guard narrower than its name" class produced two new instances
  (R03, R04) and the "claimed property with no test that could fail" class produced one (R06) –
  inside the fixes for the earlier instances. The prior report's recommendation still stands, and its
  enforcing-check half – one shared `sqlStringsIn`/`importsIn` helper with a self-test that a
  narrowing would fail – is now more clearly the right answer, because a hand-written self-test was
  tried and came out vacuous.
- **Class**: `spec-stale` · **Routing**: **Note** – must go through the `andthen:ops` skill; this review is read-only.

#### R13 – The S07 ledger repeats a "byte-intact" claim out of the editorial note's reach

- **Severity**: LOW · **Confidence**: 90 · **Location**: `s07-the-projected-board-view.reconciliation-ledger.md:29`
- **Finding**: The note reads *"`design-decisions.md` carries a dated amendment; the original prose
  is byte-intact."* The em-dash sweep changed those bytes. `design-decisions.md:13-16`'s editorial
  note scopes the claim correctly, but it lives in the other file, and a reader of the ledger does not
  see it.
- **Class**: `spec-stale` · **Routing**: **Note** – one clause, paired with R09.

---

## Findings Filter Result

The gate fired (>5 findings, HIGH set present). The filter ran as an **inline self-check** against
the shared calibration references under the same verdict-discipline floor, rather than as a dedicated
fresh-context sub-agent – this session's operating instructions forbid spawning agents unsolicited.
That is a real reduction in independence and is recorded rather than papered over. It is partly
compensated by the evidentiary standard used: **every HIGH and MEDIUM here was produced by running
something**, not by reading, and each carries the command that reproduces it, so the findings are
falsifiable by anyone who disagrees.

| ID | Verdict | Final severity | Note |
|---|---|---|---|
| R01 | VALIDATED | **HIGH** | executed over a raw socket against the production logger shape; 9 of 12 spellings leak |
| R02 | VALIDATED | **HIGH** | executed against `nginx:alpine` 1.31.3; 5 of 8 spellings leak, one on a 200 |
| R03 | VALIDATED | **HIGH** | 4 of 5 hostile shapes invisible; the codebase's own exported fragment invisible |
| R04 | VALIDATED | MEDIUM | complete revert of the G31 fix leaves the self-test green |
| R05 | VALIDATED, mitigation stated | MEDIUM | challenged on "the position paragraph still reads in order"; kept, because the design decision names the *label* as the mechanism and WCAG 2.5.3 is a Level A failure |
| R06 | VALIDATED | MEDIUM | the prior report's own acceptance criterion for G30 |
| R07–R13 | VALIDATED | LOW | all locations confirmed against the files |

Considered and **not** recorded as findings, so the absences are visible:

- **The editorial note on the em-dash sweep.** Judged sound rather than papering over. It is dated,
  scoped to the exact claim, states what did and did not change, and sits above the amendments it
  qualifies. A weaker version – silently rewriting the prose, or leaving the "byte-intact" claim
  unqualified – is what would have been a finding.
- **`crit` leaving `[crit]`/`[alert]`/`[emerg]` request-context lines through.** Raised as a
  theoretical residual and then attacked: a permission-denied read of `display.html` produced a 403
  and no line above `crit`. No residual demonstrated, so none is claimed.
- **The three by-design `OPEN` ledger entries.** Re-derived independently and confirmed accurate.
  Correctly open, correctly excluded from convergence.
- **G01, G02, G06, G10, G11, G12, G19, G21, G22, G23, G32.** Each checked against the files rather
  than the account. All closed, and G01's amendment is in the right shape.

---

## Remediation Plan

### 1. Finish the credential work (HIGH) – R01, R02

| # | Action | Routing | Acceptance criterion |
|---|---|---|---|
| 1 | Stop `routeNotFound` echoing the request path (`api/src/errors.ts`, called at `app.ts:228`). The framework-error branch already declines to echo for the same reason | **Fix** | No 404 body anywhere in the API contains any part of the request path |
| 2 | Close the log half: percent-decode once (guarded) before the prefix test in `isDisplayPath`, or invert to a logged-path allow-list. Correct the docblock at `display.ts:82-85` (R08) | **Fix** | All 12 spellings in R01's table produce a serialized request line free of the token |
| 3 | Extend the nginx map: `~*` and slash-tolerant, or an allow-list default | **Fix** | The container probe writes 0 token occurrences across all 8 spellings in R02 |
| 4 | Assert both in tests: extend `display-link.integration.test.ts:896`'s loop, and add the map-shape assertions to `web/test/display-build.test.ts` | **Fix** | Reverting either normalisation turns something in `npm test` red |

### 2. Repair the anonymity guard and its self-test (HIGH/MEDIUM) – R03, R04, R06

| # | Action | Routing | Acceptance criterion |
|---|---|---|---|
| 5 | Replace the leading-verb filter with a shape that keeps SQL fragments. Kill the `google` false positive with a written exclusion or a two-token requirement, not by narrowing | **Fix** | All five mutations in R03's table are caught; the baseline table set is still exactly nine |
| 6 | Re-pin the self-test on the quoted half alone, using `NOT_DISCARDED` as the fixture no backtick extractor can see | **Fix** | Deleting `quotedSql` from `statementsIn` turns the self-test red |
| 7 | Assert `error_log … crit;` in `display-build.test.ts` | **Fix** | Deleting the directive turns `npm test` red |

### 3. The accessibility residue (MEDIUM/LOW) – R05, R11

| # | Action | Routing | Acceptance criterion |
|---|---|---|---|
| 8 | Compose the reorder `aria-label` so it carries both the Category and the destination; extend the `CategoryBoard.test.tsx` assertion to the composed name | **Fix** | `getByRole('button', {name: /to position 1/})` resolves; 18 visual tests still green |
| 9 | Insert the missing `h4`; decide whether a successful rename/reorder/removal is announced | Note | Heading order is `h3` → `h4` → `h5`; the announcement question is settled either way and recorded |

### 4. Hygiene and record-keeping (LOW) – R07, R09, R10, R12, R13

| # | Action | Routing |
|---|---|---|
| 10 | Sweep em dashes from the six wireframe HTML files; fix `s07-…:163` | **Fix** |
| 11 | Correct the `error_log` comment's claim about what the access log replaces; remove the duplicated sentence | Note |
| 12 | Return G07 (b) and (c) to a triage list, or record the decision to leave them | Note |
| 13 | Scope or drop the S07 ledger's "byte-intact" clause | Note |
| 14 | Append the two `docs/LEARNINGS.md` entries via the `andthen:ops` skill, with the shared-helper enforcing check | Note |

### Not remediation – accepted as correct

The six `OPEN` ledger entries are all correctly open. The deferrals of G04, G05, G08, G33, G34 and
the LOW cluster are all correctly reasoned, and the reasons were checked rather than taken on trust.

---

## Recurring Traps

The single most important observation in this review is that **the "guard narrower than its name"
class produced two new instances (R03, R04) inside the fix for one of its earlier instances**, and
the "claimed property with no test that could fail" class produced a third (R06) inside the fix for
another. That is five and six occurrences respectively in one bundle, with the lesson already written
down at `docs/LEARNINGS.md:64` and a correct implementation already sitting in
`api/test/discard-structure.test.ts:77-83`.

Prose is demonstrably not holding this. The enforcing check the prior report recommended – **one
shared `sqlStringsIn` / `importsIn` helper that every structure guard imports, with a self-test
asserting each extractor finds a known single-quoted *fragment* and a known double-quoted import** –
is now the answer, not a suggestion. R04 is the proof: a hand-written, well-intentioned self-test was
added specifically to prevent this regression, and it cannot detect the regression it was written
for.
