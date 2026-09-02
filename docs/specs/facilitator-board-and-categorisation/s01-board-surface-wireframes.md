# S01 – Board Surface Wireframes

**Plan**: docs/specs/facilitator-board-and-categorisation/plan.json
**Story-ID**: S01

## Feature Overview and Goal

**Intent**: Four Board surfaces – three viewport classes of Facilitator sorting, a projected big screen, an Attendee phone, and a discard-reversal surface – are genuinely different layouts rather than one design rescaled, so the interaction model has to be settled by drawing them before any story implements one.

**Expected Outcomes**:

- [OC01] Every Board surface and state this feature ships has a wireframe at its required viewport class, so no later story invents a layout.
- [OC02] The Facilitator sorting surface's interaction model is settled – placement, Category management including reorder, and the entry into a Discard all need no drag-and-drop, survive 375px, and are fully operable by keyboard alone.
- [OC03] The projected Board View's behaviour at the design ceiling (~200 Post-its across ~20 Categories) is settled: every Category and its count stay visible, nothing becomes unreachable, and no input is required to reveal content.
- [OC04] The Facilitator's discarded-Post-its surface has a settled shape that supports reversing a Discard at any point until archival, not an ephemeral undo.

## Required Context

- `docs/specs/facilitator-board-and-categorisation/prd.md#ui-wireframes` – the four surfaces this story draws, the viewport classes each needs, and the PRD's statement that the discard-reversal surface's shape is settled here.
- `docs/specs/facilitator-board-and-categorisation/prd.md#constraints` – carries four binding constraints for this story: sorting must not require drag-and-drop (drag is an additional wide-viewport affordance only, never the only way); the projected screen takes no pointer input and is never a control surface; offline support is not widened, so no wireframe may show a queued or deferred sort; and Discard must stay apart from the author-deletion path, which is why the reversal surface cannot be an ephemeral undo.
- `docs/specs/facilitator-board-and-categorisation/prd.md#open-questions` – the projected-view overflow question this story closes, and the second question (Admin overriding Session Assignment generally) it deliberately does not touch.
- `docs/specs/facilitator-board-and-categorisation/prd.md#fr3-placing-post-its-into-categories` – the placement acceptance criteria the sorting wireframe must be able to satisfy: place from Uncategorised, move between Categories, move back to Uncategorised, keyboard and assistive-technology reachable, operable at all three widths.
- `docs/specs/facilitator-board-and-categorisation/prd.md#fr4-discard-and-restore` – that a restore always returns a Post-it to Uncategorised, that discarded Post-its are absent from every other surface, and that the undo window runs to archival – the three facts that shape the reversal surface.
- `docs/specs/facilitator-board-and-categorisation/prd.md#fr8-the-projected-board-view` – the projected surface's contract: read-only, author names shown, Categories in Facilitator order with Uncategorised alongside, legible at several metres, validated as a distinct fourth viewport class and not as 1280px with a larger font. Also its empty-Board, revoked-link and lost-connectivity states.
- `docs/specs/facilitator-board-and-categorisation/prd.md#fr9-the-attendees-live-board` – the Attendee Board's read-only-with-respect-to-placement contract, that discarded Post-its simply vanish with no marker, and that contribution continues alongside into Uncategorised.
- `docs/specs/facilitator-board-and-categorisation/prd.md#non-functional-requirements` – two binding constraints: no surface added here reads, joins to or exposes Vote data (ADR-006 untouched); and a Display Link reaches no Vote data in any response it can produce, which bounds what the projected wireframe may depict. Also the ~200/~20 design ceiling and the four-class responsiveness bar.
- `docs/specs/facilitator-board-and-categorisation/prd.md#edge-cases` – the stated overflow requirement the projected wireframe must satisfy ("every Category and its count stay visible, Post-it detail degrades before any Post-it becomes unreachable, the surface never requires input to reveal content"), plus the zero-Post-it and revoked-link states.
- `docs/UBIQUITOUS_LANGUAGE.md#output` and `docs/UBIQUITOUS_LANGUAGE.md#session-activities` – the registered vocabulary these artifacts must use: Board, Board View, Uncategorised, Display Link and Permanent Removal in Output; Category and Discard in Session Activities. "Column", "inbox", "bucket" and "swimlane" are registered avoided synonyms, and "wall" was retired in favour of Board on 2026-08-29 (see the document's Changelog).
- `docs/specs/facilitator-board-and-categorisation/requirements-clarification.md` – the discovery behind the PRD; read for the reasoning where a wireframe decision needs more than the PRD's one-line statement.

## Deeper Context

- `web/src/activities/SessionActivitiesPanel.tsx` – the shipped Board surface these wireframes evolve: today a flat chronological list with the authoring form. Read to keep the wireframes recognisable as the same product rather than a redesign.
- `web/src/styles.css` – the shipped token set (`--surface`, `--border`, `--gap`, `--radius`) and the `.board` / `.board__list` rules. Wireframes stay grayscale, but their structure should map onto these without a rewrite.
- `docs/specs/facilitator-board-and-categorisation/plan.json#sharedDecisions` – records that S02, S03, S05, S07 and S08 cite this story's output as required context rather than inventing a layout, which is why the settled decisions need durable anchors.

## Acceptance Scenarios

- [x] **S01 [OC01] [TI01,TI02,TI06] Every surface and state in the inventory has a wireframe**
  - **Given** the page inventory lists the Facilitator sorting surface with both its placement controls and its Category management controls, the per-Post-it Discard control on that surface, the discarded-Post-its surface, the projected Board View, the Attendee Board with the pending-Post-it position marked, and the distinct states the PRD names for them (empty Board projected, projected link no longer available, projected surface stale on lost connectivity)
  - **When** the inventory is cross-checked against the wireframe directory
  - **Then** every listed entry resolves to a wireframe file that exists and renders, with none skipped as "similar to another"

- [x] **S02 [OC02] [TI02,TI08] A Post-it is placed, moved and returned without a pointer at 375px**
  - **Given** the Facilitator sorting wireframe rendered at 375px, with Post-its sitting in Uncategorised and at least two Categories present
  - **When** the placement interaction is walked using keyboard input only
  - **Then** a Post-it can be placed from Uncategorised into a Category, moved from one Category to another, and moved back to Uncategorised, with every step reachable and its target announced by a visible label rather than by position alone

- [x] **S03 [OC02] [TI02,TI08] No wireframe in the set depicts a drag affordance at any width**
  - **Given** every Facilitator sorting wireframe in the set, including the 1280px one where the PRD's constraint would permit drag as an additional affordance
  - **When** each is inspected for a drag handle, a drag-target hint, a "drag to sort" instruction or any other depiction of dragging – for placement or for Category reorder
  - **Then** none appears anywhere in the set: stories S02 and S03 both decline to build drag, so drawing it would put an unimplementable control into the artifact five stories treat as authoritative – the same non-drag controls carry every action at 1280px that carry it at 375px, and a wireframe depicting drag is redrawn rather than annotated

- [x] **S04 [OC03] [TI04,TI08] The projected Board holds ~200 Post-its across ~20 Categories with nothing hidden behind an interaction**
  - **Given** the projected Board View wireframe populated at the design ceiling – 20 Categories plus Uncategorised, ~200 Post-its – rendered at the projection viewport class
  - **When** the rendered screen is inspected without touching the machine
  - **Then** all 20 Categories and Uncategorised are visible with their counts, no Post-it is unreachable, and any degradation is in Post-it detail – not in Category or count visibility – with no scroll, tab, page control or other input needed to reveal content

- [x] **S05 [OC03] [TI04] The projected surface presents nothing that could change the Board**
  - **Given** the projected Board View wireframes, including the empty-Board, link-unavailable and stale-connectivity states
  - **When** every interactive-looking element on them is enumerated
  - **Then** none is a control over Board state – no sort, place, discard, restore, category-edit or link-management affordance appears anywhere on the projected class, and the stale state is an indicator rather than a retry button

- [x] **S06 [OC04] [TI03,TI08] A Discard is reversed from a surface that persists to archival**
  - **Given** the discarded-Post-its wireframe reached from the Facilitator's own sorting surface
  - **When** a discarded Post-it is restored from it
  - **Then** the surface shows the discarded Post-its for this Board with who discarded them and when, offers restore per Post-it, and states that a restored Post-it returns to Uncategorised rather than to its former Category – and the surface is a place the Facilitator can navigate back to at any time, not a transient toast or timed undo

- [x] **S07 [OC01] [TI05,TI06] The Attendee Board reflows across the standing three widths with no horizontal body scroll**
  - **Given** the Attendee Board wireframe showing Categories in the Facilitator's order with Uncategorised alongside, Post-its carrying author names, and the contribution form still present for an open Round
  - **When** it is rendered at 375px, 768px and 1280px
  - **Then** each width shows every Category and count without horizontal body scroll, and the surface offers no place, move or discard control on any Post-it including the Attendee's own

- [x] **S08 [OC01,OC02] [TI02,TI08] A Category is created, renamed, reordered and removed without a pointer at 375px**
  - **Given** the Facilitator sorting wireframe rendered at 375px with three Categories present, the middle one holding Post-its, and Uncategorised alongside them
  - **When** the Category management controls are walked using keyboard input only – create a fourth Category, rename one, move one Category up and one down, and remove the occupied one
  - **Then** every control is reachable and operable one-handed at 375px with no pointer and no drag: reorder is an explicit non-drag control (move up / move down or a position control) with the resulting position stated in a visible label, the occupied-Category removal asks where its Post-its go with Uncategorised offered, and Uncategorised itself carries no rename, reorder or remove control

- [x] **S09 [OC02,OC04] [TI03,TI08] Discard starts from a control on the Post-it itself, not only from the reversal surface**
  - **Given** the Facilitator sorting wireframe at 375px and at 1280px, with Post-its sitting in Uncategorised and in a Category
  - **When** the affordance that starts a Discard is located on each Post-it and exercised by keyboard alone
  - **Then** every Post-it on the Facilitator's own sorting surface – in Uncategorised and in any Category alike – carries its own labelled Discard control reachable without a pointer, distinct from the author's own delete control and from any permanent-removal wording, and the discarded-Post-its reversal surface is reached from a separate, always-available entry point rather than from this control's aftermath

- [x] **S10 [OC01] [TI05,TI06] A pending Post-it is drawn inside the Uncategorised region, outside its count**
  - **Given** the Attendee Board wireframe at 375px, 768px and 1280px showing the grouped Board with Categories and Uncategorised, and one Post-it still held on the device because the network dropped
  - **When** the pending Post-it's position on each width is inspected against the Uncategorised region's boundary and against its stated count
  - **Then** the pending Post-it is drawn inside the Uncategorised region – not in a separate list below the Board – carries its author's name and a pending marker, and the count shown on Uncategorised is the server's number with the pending item excluded from it

## Structural Criteria

- [x] No wireframe on the projected class carries a control that would change Board state, and no wireframe in this story depicts Vote data, a vote affordance, or a vote result.
- [x] No wireframe depicts an offline, queued or deferred sort, discard or restore – every failure shown is stated and retried, never held.
- [x] Wireframes are grayscale, self-contained HTML with inline CSS and no external asset or network request.
- [x] The three settled decisions live at stable, citable heading anchors so S02, S03, S05, S07 and S08 can reference them.
- [x] Artifacts use the registered Ubiquitous Language – no "wall", "column", "inbox", "bucket" or "swimlane" standing in for Board, Category or Uncategorised.
- [x] No production code, migration, schema or API change lands in this story; `api/`, `db/` and `web/` are untouched.

## Scope & Boundaries

### Work Areas

- `docs/wireframes/facilitator-board-and-categorisation/` – new artifact directory: `index.html` hub and `page-inventory.md`.
- The Facilitator sorting surface wireframes at 375px, 768px and 1280px, carrying both the placement controls and the Category management controls (create, rename, non-drag reorder, remove).
- The per-Post-it Discard control on the Facilitator's sorting surface, and the separate entry point to the reversal surface.
- The Facilitator's discarded-Post-its reversal surface wireframe.
- The projected Board View wireframe at the design ceiling, plus its empty-Board, link-unavailable and stale-connectivity states.
- The Attendee Board wireframe at 375px, 768px and 1280px, including where a pending Post-it sits within the Uncategorised region.
- `docs/wireframes/facilitator-board-and-categorisation/design-decisions.md` – the three settled decisions at stable anchors.
- `docs/wireframes/facilitator-board-and-categorisation/screenshots/` and `validation-report.md` – the viewport capture evidence.

### What We're NOT Doing

- No production code, schema, migration or API route -- this is an enabler; S02 owns the Category model, the Uncategorised holding area and the Board read contract.
- No design-system or token creation -- the shipped `web/src/styles.css` token set stands; these are grayscale structural wireframes, not a visual redesign.
- Not re-deciding what the PRD already fixed -- Category as name-plus-order, the 60-character name limit, the 20-Category cap, the authority model and the read-only nature of the projected screen are inputs here, not open questions.
- No Display Link issuance or revocation surface -- FR7's Facilitator control belongs to S04; this story draws only what the link opens.
- Not answering the PRD's second Open Question (whether conference-wide Admin should override Session Assignment generally) -- the PRD routes it as a project-wide question larger than this feature.

## Architecture Decision

**Approach**: Route the four surfaces through the `andthen:ui-ux-design` skill in `--mode wireframes` with `OUTPUT_DIR` set to a feature-scoped subdirectory of the Project Document Index's wireframes location, and record the three settled decisions in a sibling `design-decisions.md` rather than inside a wireframe comment.
**Why this over alternatives**: five later stories cite these decisions as required context, and an HTML comment is not a citable anchor – a markdown file with stable headings survives wireframe refinement and gives each downstream FIS a `path#anchor` to point at.

## Code Patterns & External References

```
# type | path#anchor or url                                        | why needed (intent)
file   | web/src/activities/SessionActivitiesPanel.tsx             | The shipped Board surface these wireframes evolve – keep the sorting surface recognisable as the same screen
file   | web/src/styles.css#.board                                  | Existing Board layout rules and token names the wireframe structure should map onto
doc    | docs/specs/facilitator-board-and-categorisation/prd.md#ui-wireframes | The authoritative list of surfaces and viewport classes to cover
doc    | docs/UBIQUITOUS_LANGUAGE.md#output                         | Canonical terms and the avoided synonyms these artifacts must not use
```

## Constraints & Gotchas

- **Constraint**: The projected view is a fourth viewport class, not the 1280px layout enlarged. -- Workaround: draw it as its own HTML file with its own layout and validate it at projection scale; a wireframe that is the desktop file with a bigger root font fails S05 and the PRD's own acceptance criterion.
- **Constraint**: The `wireframes` mode's validation gate requires browser automation that can set viewports, capture screenshots and read DOM geometry. -- Workaround: this project ships Playwright (`playwright.config.ts`, `visual/`); use it. Per `docs/LEARNINGS.md#testing`, never pipe a Playwright run through `tail` – it masks the exit code and eats the failure summary.
- **Avoid**: Judging horizontal overflow from the page's `scrollWidth - clientWidth`. -- Instead: per `docs/LEARNINGS.md#css--responsive-layout`, an ancestor absorbs the scroll; compare each element's own `scrollWidth` against its `clientWidth`. This applies to the 375px sorting surface and the Attendee Board alike.
- **Critical**: A `flex-shrink: 0` with a rem `min-width` fits at a 16px root and runs off-screen at 24px, which Capacitor inherits from the OS font scale. -- Must handle by: `min-width: min(Xrem, 100%)` on Post-it and Category containers, per `docs/LEARNINGS.md#css--responsive-layout`.
- **Avoid**: Depicting a Post-it that shows its own Discard state to an Attendee or its author. -- Instead: a discarded Post-it is simply absent from every surface except the Facilitator's discarded-Post-its surface – no marker, no "set aside" badge, no notification (FR4, FR9).
- **Narrowing**: `OUTPUT_DIR` is a feature-scoped subdirectory. -- The Project Document Index names `docs/wireframes/` for wireframes; neither it nor the directory exists yet, so every artifact in this story lands under `docs/wireframes/facilitator-board-and-categorisation/` and a second feature's wireframes cannot collide with this one's flat `index.html` and `page-inventory.md`.
- **Narrowing**: The projection viewport class is validated at 1920x1080. -- The PRD requires a distinct fourth class and legibility at several metres but names no pixel size; 1920x1080 is the wireframes mode's own Wide entry and the common room-projector resolution. Legibility at distance is judged on the capture, not inferred from the pixel count.
- **Narrowing**: The standing three-width bar covers the member-facing surfaces only. -- The wireframes mode's blanket four-viewport matrix is deliberately narrowed: the Facilitator and Attendee surfaces are validated at 375/768/1280 per the PRD's Usability NFR, and the projected surface at its own class, because the PRD frames responsiveness in this feature as a four-*class* problem rather than four widths of one layout.
- **Narrowing**: Four of the plan's binding constraints have no expression in an artifact-only story and are deliberately not carried into this FIS. -- The Display Link's day bound (FR7), actor identity taken from the credential (FR6), plain-PostgreSQL storage (FR1) and server-side enforcement of Admin-only permanent removal (FR5) are server-side properties with nothing to draw; they bind S04, S02 and S06 respectively. The one wireframe-visible edge of that set is honoured: no surface drawn here offers a permanent-removal control, because permanent removal is Admin-only and belongs to S06.

## Implementation Plan

### Implementation Tasks

- [x] **TI01** A page inventory exists naming every surface and distinct state this story must draw
  - Derive it from `prd.md#ui-wireframes` plus the states FR8 and the Edge Cases table name (empty Board projected, link no longer available, stale on lost connectivity). Three further entries are required because later stories cite this story for them rather than deciding them: the Facilitator's Category management controls (S02 TI08), the per-Post-it Discard control on the Facilitator's Board (S05 TI08), and where a pending Post-it sits on the Attendee Board (S08). Written to `docs/wireframes/facilitator-board-and-categorisation/page-inventory.md` in the shape the `andthen:ui-ux-design` wireframes mode expects. The inventory names each surface's output file explicitly, in kebab-case: `facilitator-sorting.html` for the Facilitator sorting surface (cited by S03 and S05 as the surface carrying the per-Post-it Discard control and the Category management controls; TI02 draws it), `projected-board-view.html` for the projected Board View (TI04), `attendee-board.html` for the Attendee Board (TI05), and `discarded-postits.html` for the discarded-Post-its reversal surface (TI03). `index.html`, the hub that resolves these filenames (cited by S05), is produced by TI08.
  - **Verify**: The inventory names the Facilitator sorting surface with both its placement and its Category management controls, the per-Post-it Discard control, the discarded-Post-its surface, the projected Board View at the design ceiling, the Attendee Board including its pending-Post-it position, and the three projected states above; each entry names its viewport class; and the inventory names each file explicitly – `facilitator-sorting.html`, `projected-board-view.html`, `attendee-board.html` and `discarded-postits.html`.

- [x] **TI02** The Facilitator sorting surface is drawn at 375px, 768px and 1280px with placement and Category management models that need no drag
  - Must satisfy every FR3 acceptance criterion by inspection: place from Uncategorised, move between Categories, move back to Uncategorised, all reachable by keyboard with labelled targets. Show Uncategorised alongside the Categories, with per-Category and Uncategorised counts. The same surface also carries the Facilitator's **Category management controls** – create, rename, reorder and remove – because S02 TI08 requires them reachable one-handed at 375px *per this story's wireframes* and does not decide their shape: reorder is drawn as an explicit non-drag control (move up / move down or a position control) with the resulting position in a visible label, removal of an occupied Category asks for a destination with Uncategorised offered, and Uncategorised itself carries none of the four. No drag affordance is drawn at any width, 1280px included – the PRD's constraint permits one, but stories S02 and S03 both decline to build it, so depicting it would put an unimplementable control into an artifact five stories treat as authoritative.
  - **Verify**: At 375px the three placement actions and all four Category actions are each completable through non-drag keyboard-reachable controls with labelled targets; Uncategorised exposes no rename, reorder or remove control; and no wireframe at any width depicts a drag handle, drop-target hint or drag instruction.

- [x] **TI03** Discard has a per-Post-it control on the sorting surface, and the discarded-Post-its surface is drawn as a place that can be returned to
  - Two halves. First, the **affordance that starts a Discard**: a labelled per-Post-it control on the Facilitator's sorting surface (TI02), present on Post-its in Uncategorised and in every Category, keyboard-reachable at 375px, visibly distinct from the author's own delete control and never worded as permanent removal – S05 TI08 places that control on the Facilitator's Board *per this story's wireframes* and decides nothing about it itself. Second, the **reversal surface**: reached from its own always-available entry point on the sorting surface, showing this Board's discarded Post-its with who discarded them and when, a per-Post-it restore, and the statement that a restore returns the Post-it to Uncategorised. It cannot be a toast or timed undo – the window runs to archival (`prd.md#fr4-discard-and-restore`).
  - **Verify**: Every Post-it on the Facilitator sorting wireframe carries a labelled non-pointer Discard control at 375px and 1280px; and the reversal wireframe is a navigable surface with its own entry point on the sorting wireframe, showing restore, discarder and discard time per Post-it.

- [x] **TI04** The projected Board View is drawn as its own viewport class, populated at the design ceiling, with the overflow behaviour settled
  - 20 Categories plus Uncategorised and ~200 Post-its in a single rendered screen. All Categories and counts visible; degradation falls on Post-it detail only; no scroll, page, tab or any other input reveals content. No control of any kind appears. Include the empty-Board, link-unavailable and stale-connectivity states as separate wireframes.
  - **Verify**: At the projection viewport the populated wireframe shows 21 labelled regions with counts, no element requires input to become visible, and enumerating every interactive-looking element on all four projected wireframes yields no Board-state control.

- [x] **TI05** The Attendee Board is drawn at 375px, 768px and 1280px as a read-only rendering of the same Board
  - Same Categories in the same order as the projected view, Uncategorised alongside, Post-its with author names and counts, contribution form present for an open Round. No place, move or discard control on any Post-it including the Attendee's own. Also draw **where a pending Post-it sits**, which S08 cites this story for: the shipped surface renders held items in a list below the whole Board, and under S02's grouped shape they must be drawn **inside the Uncategorised region** – that is where they land – with a pending marker and the author's name, while the count shown on Uncategorised stays the server's number and excludes the pending item, so no count becomes a client-side derivation.
  - **Verify**: At each of the three widths every Category and count renders with no horizontal body scroll, no placement or discard control is present, and a pending Post-it is drawn inside the Uncategorised region – not below the Board – with the Uncategorised count unchanged by it.

- [x] **TI06** Viewport screenshots and a validation report exist for every wireframe, and the set passes the story's structural sweep
  - Member-facing surfaces (TI02, TI03, TI05) captured at 375, 768 and 1280px; the projected surfaces (TI04) at the projection class. Checks per the wireframes mode: no horizontal overflow, no overlapping elements, no collapsed containers, no console errors. Critical and high issues fixed before the report is written, not annotated.
  - **Verify**: `screenshots/` holds a capture per wireframe per its required viewport class, and `validation-report.md` records pass/fail per wireframe per viewport with no unfixed critical or high issue.

- [x] **TI07** The wireframe set holds no Vote data, no offline sort, no avoided term and no colour, and the repository holds no production change
  - A sweep across every file in `docs/wireframes/facilitator-board-and-categorisation/`, run once the set is complete (TI02–TI06). Covers this FIS's Structural Criteria, which no single surface task proves on its own.
  - **Verify**: No wireframe depicts Vote data, a vote affordance or a vote result; none shows a queued, held or deferred sort, discard or restore; every wireframe is self-contained HTML with inline CSS, no external asset request and no colour beyond grayscale; no artifact uses "wall", "column", "inbox", "bucket" or "swimlane" for Board, Category or Uncategorised; and `git status` shows no change under `api/`, `db/` or `web/`.

- [x] **TI08** The three settled decisions are recorded at stable anchors that later stories can cite
  - `design-decisions.md` states the non-drag placement interaction model (TI02), the shape of the discarded-Post-its surface (TI03), and the projected view's overflow behaviour at the design ceiling (TI04) – each as a decision with its reasoning and the wireframe that demonstrates it, under a heading whose slug will not move. Also produce the `index.html` hub linking every wireframe. `design-decisions.md` carries exactly these three H2 headings, in this order, with these resulting slugs, reproduced verbatim and not re-derived or re-worded:

    | Heading (verbatim) | Anchor slug |
    |---|---|
    | `## The non-drag placement interaction model` | `#the-non-drag-placement-interaction-model` |
    | `## The discarded Post-its surface` | `#the-discarded-post-its-surface` |
    | `## The projected view's overflow behaviour` | `#the-projected-views-overflow-behaviour` |

    These slugs are cited by S02, S03, S05 and S07 and must not be renamed.
  - **Verify**: Each of the three decisions resolves to its own heading anchor, states the decision unambiguously rather than listing options considered, and names the wireframe file that demonstrates it; each of the three headings above is present exactly as written and its slug matches the table; `index.html` links every file in the inventory.

### Validation

- Verification for this story is by artifact and by the three decisions being unambiguously stated – there is no running demo and nothing to exercise in the app. The standard build/test gate has nothing to bind to here; `validation-report.md` plus the design-decisions anchors are the evidence.
- The projected surface is signed off against the projection viewport class only. Signing it off as the 1280px capture is an explicit failure of this story (`plan.json#executionNotes`).

### Execution Contract

- TI01 precedes all drawing tasks – the inventory is the completeness gate for S01.
- TI08 depends on TI02, TI03 and TI04 having settled: the decisions are recorded from the drawn wireframes, not asserted ahead of them.
- Run the drawing work through the `andthen:ui-ux-design` skill in `--mode wireframes`, with `REQUIREMENTS` pointing at this FIS and the PRD anchors in Required Context, and `OUTPUT_DIR` at `docs/wireframes/facilitator-board-and-categorisation/`.

## Implementation Observations

> _Managed by exec-spec post-implementation – append-only. Spec authors: leave this section empty._

### Run: 2026-08-30 16:42 UTC – discovered-requirements

#### DISCOVERED REQUIREMENTS

- **The story's named screenshot evidence directory is invisible to version control.** The FIS Work Areas name `docs/wireframes/facilitator-board-and-categorisation/screenshots/` as a deliverable and TI06 requires it to hold a capture per wireframe per viewport class. The shipped `.gitignore:13` carries a bare `screenshots/` rule, written for the repo-root output of `npm run screenshots` (`docs/KEY_DEVELOPMENT_COMMANDS.md` -> Visual Validation), and a bare directory pattern matches at every depth - so every capture this story produces is ignored and the deliverable would exist only on the machine that ran the harness. Confirmed by `git check-ignore -v`. Resolution: a scoped negation in `.gitignore` un-ignoring this feature's wireframe screenshots, leaving the regenerated `npm run screenshots` output ignored as before. `.gitignore` is outside the FIS's stated Work Areas but is not under `api/`, `db/` or `web/`, so the story's no-production-change criterion is unaffected.

### Run: 2026-08-30 17:03 UTC – observations

#### NOTICED BUT NOT TOUCHING

- Pre-existing Prettier drift in three files, none of them in this story's change set and none under a path this story touches: `api/test/join-code.test.ts`, `visual/conferences.spec.ts`, `web/src/components/JoinCodePanel.tsx`. `npm run format:check` exits 1 on them on a clean checkout of this branch. Left alone deliberately - exec-spec is surgical and a project-wide format pass is out of scope here; `npm run lint` and `npm run typecheck` both exit 0.
- The wireframe validation harness was written as scaffolding under `.agent_temp/wireframe-validation/` (gitignored) rather than as a permanent spec in `visual/`. The story's Work Areas name only the wireframes directory, and a permanent Playwright spec asserting the geometry of static documentation is a scope decision this story was not asked to make. `validation-report.md` therefore states the measurements to reproduce rather than a command to re-run. If a later story wants these captures regenerated on every build, promoting the harness into `visual/` is the change to propose.
- `docs/wireframes/` did not exist before this story and the Project Document Index names it for wireframes generally. Everything here lands under the feature-scoped subdirectory `docs/wireframes/facilitator-board-and-categorisation/`, so a second feature's wireframes cannot collide with this one's flat `index.html` and `page-inventory.md`. A future feature adding wireframes should follow the same convention rather than writing to `docs/wireframes/` directly.
- The attendee board deliberately draws no dismiss control on the pending post-it, though the shipped `HeldPostIt` component offers one. No acceptance scenario in this story covers it - S10 fixes only the pending item's position, its author name, its pending marker and its exclusion from the count - so drawing it would have been an unasked-for decision about a shipped affordance. S08 should take the dismiss control from the shipped component rather than from this wireframe.
