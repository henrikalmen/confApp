# Page Inventory – Facilitator Board View and Post-it Categorisation

Derived from `docs/specs/facilitator-board-and-categorisation/prd.md#ui-wireframes`, the states FR8
and the PRD's Edge Cases table name, and the three entries later stories cite this story for rather
than deciding themselves (S02 TI08, S05 TI08, S08).

Four surfaces across two viewport classes. The Facilitator's and the Attendee's surfaces are
validated at the standing three widths (375 / 768 / 1280 px, per the PRD's Usability NFR). The
projected Board View is a **fourth viewport class**, validated at 1920×1080 only – signing it off as
the 1280 px capture is an explicit failure of this story
(`docs/specs/facilitator-board-and-categorisation/plan.json#executionNotes`).

## Pages to Wireframe

1. [x] **`facilitator-sorting.html`** – The Facilitator's sorting surface. The one control surface in
   this feature. Carries, on a single page:
   - [x] the Uncategorised holding area alongside the Categories, each region with its count;
   - [x] **placement controls** – place a Post-it from Uncategorised into a Category, move it between
     Categories, and move it back to Uncategorised, without drag and without a pointer (FR3);
   - [x] **Category management controls** – create, rename, non-drag reorder (move up / move down with
     the resulting position in a visible label), and remove; and Uncategorised carrying none of
     them (cited by S02 TI08);
   - [x] **a per-Post-it Discard control** on every Post-it, in Uncategorised and in every Category
     alike, visibly distinct from the author's own delete control (cited by S05 TI08);
   - [x] **the always-available entry point** to the discarded-Post-its surface;
   - [x] the occupied-Category removal state, which asks where the Post-its go with Uncategorised
     offered;
   - [x] the Category rename state.
   - **Viewport class**: 375 / 768 / 1280 px.

2. [x] **`discarded-postits.html`** – The Facilitator's discarded-Post-its surface, reached from the
   sorting surface's own entry point, and the only place a Discard can be reversed (FR4). Shows this
   Board's discarded Post-its with who discarded them and when, a restore per Post-it, and the
   statement that a restore returns the Post-it to Uncategorised. A place that can be navigated back
   to at any time until archival – not a toast and not a timed undo.
   - **Viewport class**: 375 / 768 / 1280 px.

3. [x] **`projected-board-view.html`** – The projected Board View at the **design ceiling**: 20
   Categories plus Uncategorised, ~200 Post-its, in one rendered screen. Every Category and its count
   visible, no Post-it unreachable, degradation falling on Post-it detail only, and no scroll, page,
   tab or any other input needed to reveal content. No control of any kind (FR8).
   - **Viewport class**: projection (1920×1080).

4. [x] **`projected-board-empty.html`** – The projected Board View with **zero Post-its**: its
   Categories render with counts of 0. A legitimate pre-Round state on the big screen, not an error
   (FR8, Edge Cases).
   - **Viewport class**: projection (1920×1080).

5. [x] **`projected-board-unavailable.html`** – The projected Board View when the Display Link **no
   longer resolves** – revoked, expired, Draft, deleted Round or never-existed alike. One neutral
   message that discloses nothing about which of those it was, and no control (FR7, FR8).
   - **Viewport class**: projection (1920×1080).

6. [x] **`projected-board-stale.html`** – The projected Board View when **connectivity is lost at the
   room machine**: the last-rendered Board stays on screen behind a visible staleness indicator, and
   resumes on reconnect. An indicator, never a retry button – nothing on this class is a control
   (FR8).
   - **Viewport class**: projection (1920×1080).

7. [x] **`attendee-board.html`** – The Attendee's live Board: the same Categories in the Facilitator's
   order with Uncategorised alongside, Post-its carrying author names, per-region counts, and the
   contribution form still present for an open Round. Read-only with respect to placement – no place,
   move or discard control on any Post-it, the Attendee's own included (FR9). Also draws **where a
   pending Post-it sits**: inside the Uncategorised region, not in a separate list below the Board,
   with the count on Uncategorised staying the server's number and excluding it (cited by S08).
   - **Viewport class**: 375 / 768 / 1280 px.

8. [x] **`index.html`** – Navigation hub resolving every filename above.
   - **Viewport class**: not a product surface; not captured.

## Total: 7 wireframes required (plus the index hub)

## Deliberately not drawn here

- **Display Link issuance and revocation** – FR7's Facilitator control belongs to S04. This story
  draws only what the link opens.
- **Admin permanent removal** – Admin-only and owned by S06. No surface drawn here offers a
  permanent-removal control, and no wording on any surface reads as permanent removal.
  - **Amended 2026-08-31.** Still true of the *drawings*, which are left as drawn, and no longer true
    of the shipped product. The owner reversed the discarded-Post-its half of this on 2026-08-31: a
    per-Post-it permanent-removal control ships on the discarded-Post-its surface as well as on the
    Board, gated on the server-supplied `canRemovePermanently` flag, beside the restore control and
    never instead of it. The reason and the full decision are in `design-decisions.md` →
    "The discarded Post-its surface" → *Amendment – 2026-08-31*. Anyone building against entry 2
    should read that amendment before treating this line as a constraint on the surface.
- **A discarded Post-it's absence made visible** – a discarded Post-it is simply absent from every
  surface except entry 2. No marker, no "set aside" badge, no notification (FR4, FR9), so there is
  no state to draw.
- **Any offline, queued or deferred sort, discard or restore** – offline support is not widened;
  sorting is online-only and a failure is stated and retried, never held. The one pending item drawn
  anywhere is a Post-it *contribution* in entry 7, which is the shipped queue this feature does not
  touch.
