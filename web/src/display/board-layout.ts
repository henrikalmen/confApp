/**
 * The two layout rules that make the projected Board **always exactly one screen**.
 *
 * They are S01's settled overflow decision, expressed as arithmetic rather than re-decided here
 * (`docs/wireframes/facilitator-board-and-categorisation/design-decisions.md#the-projected-views-overflow-behaviour`).
 * Nothing pages, nothing scrolls, nothing cycles and no input reveals content, because there is
 * nobody at the room machine to provide any. What gives way instead is Post-it *detail*, and only
 * that: the Category name, its count and its boundary hold their size whatever a region holds,
 * because they are what a reader at the back of the room is actually reading.
 *
 * They live in their own module, away from the component, so they can be stated over the whole
 * range they have to hold for - from a pre-Round Board with four Categories to the ~200-across-~20
 * design ceiling - without rendering anything.
 */

/** How the regions are laid out across the screen: every one of them visible at once. */
export interface RegionGrid {
  across: number;
  down: number;
}

/**
 * The grid, **sized to the number of regions**.
 *
 * Every Category and Uncategorised are on screen at once whatever the Board holds, so the number of
 * regions decides the grid rather than the grid deciding how many regions fit. At the design
 * ceiling that is 21 tiles as 7 across and 3 down; on an empty pre-Round Board with four Categories
 * it is 5 tiles as 3 across and 2 down - the two cases S01 drew, and this returns both.
 *
 * The shape comes from the screen's own: rows are chosen so a region is about as wide as it is
 * tall on a 16:9 projector, and the columns then follow from how many regions have to fit into
 * them. Deriving `down` first is what keeps the last row from being nearly empty - `across` absorbs
 * the remainder instead, which costs a little width on tiles that are wide to begin with.
 *
 * `regionCount` is never zero: `uncategorised` is always present, on a Board holding no Post-its
 * and on a Board with no Category at all (`plan.json#sharedDecisions` -> Board read projection
 * contract). The clamp is here so a caller cannot produce a `grid-template` of zero tracks if that
 * invariant is ever broken upstream.
 */
export function regionGrid(regionCount: number): RegionGrid {
  const regions = Math.max(1, Math.floor(regionCount));
  const down = Math.max(1, Math.round(Math.sqrt((regions * 9) / 16)));
  return { across: Math.ceil(regions / down), down };
}

/**
 * How much of each Post-it a region can afford to show.
 *
 * Chosen **per Category**, from the number that Category holds - so a Category holding two stays
 * rich while its neighbour holding eleven does not. That is the whole of the degradation S01
 * settled: nothing else on the screen changes, and no Post-it ever becomes unreachable.
 */
export type DetailTier = 'full' | 'clamped' | 'condensed';

/**
 * The tier boundaries, as S01 drew them.
 *
 * - `full` (up to 2) - text wraps freely, the author's name on its own line
 * - `clamped` (3-4) - text clamped to two lines, the author's name on its own line
 * - `condensed` (5 and up) - text on one line ending in an ellipsis if it must, the author's name
 *   beside it and never clipped. A Post-it always displays its author's name - that is what a
 *   Post-it is - so the name keeps its width and the text gives up its tail instead.
 */
export function detailTier(postItCount: number): DetailTier {
  if (postItCount <= 2) return 'full';
  if (postItCount <= 4) return 'clamped';
  return 'condensed';
}

/**
 * **The legibility floor: whether a region may draw its Post-its at all.**
 *
 * S01's decision degrades Post-it *detail* until all of a region's Post-its fit its tile, and the
 * fit rule in `display.css` obeys it by capping the type at the height a row can actually have. That
 * cap had no lower bound, so an in-ceiling but skewed Board - 200 Post-its with 80 in one Category -
 * drew that region at about a fifth of a pixel: a grey band beside a count of 80, on a screen where
 * every other tile read fine at several metres. Nothing was unreachable, and the room still got
 * nothing from the tile.
 *
 * The amendment (`design-decisions.md#the-projected-views-overflow-behaviour`, 2026-09-01) gives the
 * cap a floor and says what a region does below it: **it draws none of its Post-its and states how
 * many it holds instead.** That keeps every part of S01's rule intact - every Category and its count
 * stay visible, nothing scrolls, nothing pages, and no input reveals anything - while turning an
 * illegible smear into an honest sentence.
 *
 * **The number itself lives in the stylesheet**, as `--display-post-it-floor`, beside the type scale
 * it bounds; both it and the size the tier would actually use are read back off the rendered element
 * so this rule can never drift from the CSS that produces the size. This function is only the
 * comparison, and its one judgement call: **when the size cannot be read, the Post-its are drawn.**
 * A surface that has no layout yet - the first paint, a test environment with no stylesheet - must
 * not decide it cannot see, and hiding content on a missing measurement would be a far worse failure
 * on a wall than showing it slightly too small.
 */
export function postItsAreLegible(postItSizePx: number, floorPx: number): boolean {
  if (!Number.isFinite(postItSizePx) || postItSizePx <= 0) return true;
  if (!Number.isFinite(floorPx) || floorPx <= 0) return true;
  return postItSizePx >= floorPx;
}
