# Wireframe validation report

Story S01 · Facilitator board view and post-it categorisation.

Captured and measured with Playwright (Chromium) against the wireframe files on disk. Every check
below is a measurement of the rendered DOM, not a reading of the source. Captures are in
`screenshots/`, one per wireframe per required viewport class.

**Result: 13 of 13 pass. No critical, high, medium or low issue is left unfixed.**

## Viewport classes

Responsiveness in this feature is a **four-class problem**, not four widths of one layout
(`prd.md#non-functional-requirements`). The member-facing surfaces are validated at the standing
three widths; the projected surface is validated at its own class and is **not** signed off as the
1280 px capture with a larger font – doing so would be an explicit failure of this story
(`plan.json#executionNotes`).

| Class | Size | Applies to |
|---|---|---|
| Phone | 375 × 667 | Facilitator sorting, discarded post-its, attendee board |
| Tablet | 768 × 1024 | Facilitator sorting, discarded post-its, attendee board |
| Desktop | 1280 × 800 | Facilitator sorting, discarded post-its, attendee board |
| Projection | 1920 × 1080 | The four projected board view wireframes |

## Member-facing surfaces – 375 / 768 / 1280 px

Checks run at every width: **no element overflows its own box**; **nothing past the right edge of the
viewport**; **no collapsed container**; **no overlapping controls**; **every touch target ≥ 44 px
tall**; **no console error or failed request**.

Horizontal overflow is judged per element – each element's own `scrollWidth` against its own
`clientWidth` – and not from the page's `scrollWidth - clientWidth`, which an ancestor absorbs
(`docs/LEARNINGS.md#css--responsive-layout`).

| Wireframe | Viewport | Result | Issues |
|---|---|---|---|
| `facilitator-sorting.html` | 375px | **PASS** | 0 |
| `facilitator-sorting.html` | 768px | **PASS** | 0 |
| `facilitator-sorting.html` | 1280px | **PASS** | 0 |
| `discarded-postits.html` | 375px | **PASS** | 0 |
| `discarded-postits.html` | 768px | **PASS** | 0 |
| `discarded-postits.html` | 1280px | **PASS** | 0 |
| `attendee-board.html` | 375px | **PASS** | 0 |
| `attendee-board.html` | 768px | **PASS** | 0 |
| `attendee-board.html` | 1280px | **PASS** | 0 |

## Projected board view – projection class (1920 × 1080)

Checks run on all four: **one screen with no scroll in either axis**; **no scrollable container
anywhere**; **no control of any kind**; **every region on screen with its name and its count**;
**every declared post-it laid out and none hidden**; **no author name clipped**; **no console error
or failed request**.

| Wireframe | Viewport | Result | Issues |
|---|---|---|---|
| `projected-board-view.html` | 1920×1080 | **PASS** | 0 |
| `projected-board-empty.html` | 1920×1080 | **PASS** | 0 |
| `projected-board-unavailable.html` | 1920×1080 | **PASS** | 0 |
| `projected-board-stale.html` | 1920×1080 | **PASS** | 0 |

### The design-ceiling measurement

`projected-board-view.html` was measured at the PRD's design ceiling and reported:

- **21 regions** – 20 Categories plus Uncategorised – all on screen, none clipped by the viewport,
  every one carrying a non-empty name and a non-empty count.
- **200 post-its declared, 200 laid out.** Nothing is omitted and nothing is hidden.
- **No overflow, on two independent readings.** The box reading compares each tile's `scrollHeight`
  with its `clientHeight`; the geometric reading compares each post-it's own rectangle against the
  rectangle of the tile holding it. The geometric reading is the one a container cannot satisfy
  merely by reporting its content's height.
- **Zero author names clipped.** Only post-it *text* gives up its tail, which is what
  `design-decisions.md#the-projected-views-overflow-behaviour` requires: detail degrades, and a
  post-it never stops displaying who wrote it.
- **Document and body scroll extents are 0 in both axes**, on a root that declares
  `overflow: hidden`. There is no scrollbar to reach for, which is the point – there is nobody at
  the room machine to reach for one.
- **Zero elements matching `button, a, input, select, textarea, [onclick], [tabindex],
  [role="button"], form, details, summary`**, on all four projected wireframes. The staleness
  indicator is a statement; there is no retry control and no other Board-state control.

`projected-board-stale.html` carries the same 21 regions and 200 post-its behind its staleness band
and still passes every check, so the indicator costs no content.

### Guard integrity

The "every declared post-it is laid out, none hidden" check was verified by deliberately breaking it
before it was trusted: three extra post-it rows were injected into the fullest tile and the harness
re-run. It failed as intended, on **both** readings –

```
rendered=203 declared=200 overflowing=box tile 350>329; box tile__body 285>258;
geom "PROBE overflow row that " bottom=1088 tile=1068 h=18
```

– and passed again once the injection was reverted. The guard is not vacuous
(`docs/LEARNINGS.md#testing`: a regression test written beside its fix usually passes without the
fix).

## Structural sweep across the set

Run once over every file in this directory after the set was complete.

| Check | Result |
|---|---|
| No wireframe depicts Vote data, a vote affordance or a vote result | **PASS** – no match for vote / voting / ballot / poll / anonymous anywhere |
| No wireframe depicts a queued, held or deferred sort, discard or restore | **PASS** – the only matches are statements of the opposite ("Nothing here is queued", "Sorting is online-only") and the inventory's explicit exclusion. The one pending item drawn anywhere is a post-it *contribution*, which is the shipped offline queue this feature does not touch |
| Every wireframe is self-contained HTML with inline CSS | **PASS** – no `http(s)://`, no `<link>`, no `@import`, no CDN reference, no external font. Confirmed by zero failed requests at every viewport |
| Grayscale only | **PASS** – every hex literal in the set has equal R, G and B channels; no `rgb()`, `hsl()` or named colour |
| No avoided synonym stands in for Board, Category or Uncategorised | **PASS** – no match for wall, inbox, bucket or swimlane. "column" appears only as the CSS `flex-direction: column` property value and inside `grid-template-columns`, never as a domain term |
| No drag affordance at any width | **PASS** – no `draggable`, `ondrag`, `ondrop` or drag-handle class anywhere. Every textual match for "drag" is a statement that drag is *not* used |
| No permanent-removal control or wording | **SUPERSEDED 2026-08-31** – this check passed when the set was validated on 2026-08-30 (the only matches were the negation on `discarded-postits.html` and "the permanent entry to the discarded post-its" on the hub, which describes the entry point rather than a removal). It is **no longer a property the product has**, and this row must not be read as certifying one: the owner decided on 2026-08-31 that permanent removal **is** offered on the discarded-Post-its surface, Admin-only and gated on `canRemovePermanently` (`design-decisions.md` → "The discarded Post-its surface" → *Amendment – 2026-08-31*). Re-run 2026-09-02 against the amended set: `discarded-postits.html` now carries the amendment annotation naming the shipped control, so the sweep no longer returns only negations. No wireframe *draws* the control – the drawings are left as drawn |
| No discard marker on any surface but the reversal one | **PASS** – the projected wireframes contain no match at all; the attendee board's only matches are the annotation stating a discarded post-it is simply absent |
| No production code, migration, schema or API change | **PASS** – `git status` reports no change under `api/`, `db/` or `web/` |

## Fresh-context review, and what it changed

An independent reviewer re-measured this set with its own Playwright harness rather than reading the
source, and returned **PASS with notes** – 0 critical, 0 high, 2 medium, 4 low, all routed as notes
rather than required fixes. All ten Acceptance Scenarios, all six Structural Criteria and all eight
implementation tasks were confirmed satisfied.

All six were nonetheless fixed, because five later stories treat this set as authoritative and a
contradiction drawn here propagates into them:

| # | Finding | Fix |
|---|---|---|
| F1 | The post-it `asdfasdf` / Mia Holm was drawn **both** on the Board with a live Discard control **and** on the discarded post-its page – contradicting the rule that page itself states ("they are not on the board"). S05 builds this invariant from these two files | The board's post-it is now a different idea by the same author. Verified by extracting every post-it text from both files and asserting the intersection is empty |
| F2 | `attendee-board.html` showed the round **open** but gave the attendee's own post-it no controls at all, while the shipped board offers the author `Correct` and `Remove` (`SessionActivitiesPanel.tsx`, `postIt.mine && open`). S08 builds the grouped attendee board from this file and could have withdrawn a shipped capability | The author's own `Correct` and `Remove` are now drawn on their own placed post-it, with the reason stated on the surface. This does not weaken FR9: the surface is read-only about **placement**, and author deletion of a post-it sitting in a category is explicitly permitted while the round is open (`prd.md#edge-cases`). Verified: the only controls on any post-it are `Correct` and `Remove`, on the author's own; zero move, place or discard controls; zero destination selects |
| F3 | `Discard` and the author's `Remove` rendered identically, so S09's "visibly distinct" rested on label text alone | `Discard` now carries a heavier dashed edge matching the dashed treatment of the discarded post-its surface it feeds. All 14 restyled |
| F4 | `design-decisions.md` claimed the reorder control at the end of the order being disabled meant "nothing shifts under a keyboard user" – but the HTML `disabled` attribute removes a control from the tab order, so the sequence *does* change. A false accessibility claim in a document S02 builds from | The wireframe now uses `aria-disabled="true"` rather than `disabled`, and the decision says so and says why. Verified: every reorder control stays in the tab order at every position |
| F5 | The hub's projection thumbnails overflowed their card at 375px (365 > 303) – the ancestor-absorbs-the-scroll trap this story's own constraints warn about | Scale steps down with the card. Now 259-in-307 at 375px, 298-in-700 at 768px, 365-in-375 at 1280px, with zero overflowing elements at all three |
| F6 | This report's "How to reproduce" pointed at a gitignored path that is not in the changeset, so the recipe could not be run by anyone else | Replaced with what to rebuild and the measurements to assert, which need nothing but Playwright and the wireframe files |

| F7 | Orchestrator verification found a seventh defect the review missed, of the same class as F1 but *within* one file: Priya Nair's "The build takes 22 minutes and fails about a third of the time." was drawn **twice** on the sorting surface – once in Uncategorised and once placed in **Tooling gaps** – so the same post-it appeared to occupy two regions at once. S03 builds placement from this file, and exclusive placement is the model it implements | The Uncategorised copy is now a different unsorted idea by the same author ("Code review sits for two days before anyone picks it up."). No count moves: the toolbar still reads 14 · 5 · 3 · 9 and the regions still hold 5 + 3 + 4 + 2. Verified by keying every post-it on text **and** author: 14 elements, 14 distinct, at all three widths, with the cross-file intersection against the discarded surface still empty. The three `facilitator-sorting-*.png` captures were re-taken after the edit, with horizontal overflow measured at 0 at 375, 768 and 1280 |

Every check in this report was re-run after these fixes: **13 of 13 still pass.**

## Repository changes outside this directory

One, recorded as a Discovered Requirement on the FIS and applied deliberately:

- **`.gitignore`** – the shipped `screenshots/` rule is a bare directory pattern and so matches at
  every depth, which silently swallowed this story's own named evidence directory. A scoped negation
  un-ignores `docs/wireframes/**/screenshots/` so the captures this report cites are actually in
  version control, while the regenerated `npm run screenshots` output at the repository root stays
  ignored exactly as before. Both halves verified with `git check-ignore -v` and `git status`.

## How to reproduce

**The harness is not committed.** It was agent scaffolding under `.agent_temp/` (gitignored) – the
evidence it produced is what this story ships, and a permanent Playwright spec asserting the geometry
of static documentation is not something this story was asked to add to `visual/`. So the recipe
below is what to rebuild, not a path to run.

Every check is reproducible from this report without the original code, because each one is stated as
a measurement rather than a tool invocation. A replacement harness needs only Playwright – already a
project dependency, driven here at version 1.62.1 – pointed at the wireframe files over `file://`,
which means no stack, no database and no server:

1. Load each member-facing wireframe at 375×667, 768×1024 and 1280×800, and each projected wireframe
   at 1920×1080.
2. Run the checks named in the two tables above. Judge horizontal overflow per element – each
   element's own `scrollWidth` against its own `clientWidth` – never from the document's, which an
   ancestor absorbs (`docs/LEARNINGS.md#css--responsive-layout`).
3. For the projected class, assert the region count, that each tile's `data-count` equals the number
   of `.pi` children it actually renders, that every `.pi` rectangle lies inside its tile's
   rectangle, and that the control selector in the "no control of any kind" row matches nothing.
4. Before trusting the "nothing hidden" check, break it – inject extra rows into the fullest tile and
   confirm it fails – then revert. A guard that has never failed has not been tested
   (`docs/LEARNINGS.md#testing`).

Never pipe a Playwright run through `tail`: it masks the exit code and eats the failure summary
(`docs/LEARNINGS.md#testing`). Redirect to a file instead.
