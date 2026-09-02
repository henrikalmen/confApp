import type { Category } from './category-repository.ts';
import type { PostIt } from './post-it-repository.ts';

/**
 * The Board projection: one shape, in one place, shared by every surface that renders a Board.
 *
 * Lifted out of `api/src/routes/rounds.ts` when S04 added the anonymous Display Link resolution
 * route, and lifted rather than copied for two reasons.
 *
 * The first is the shared decision itself (`plan.json#sharedDecisions` -> "Board read projection
 * contract"): five later stories read this shape, and a second one would be a second opinion about
 * what a Board is. Both callers now project *the same function* over the same rows, so the room's
 * projected Board and the Facilitator's cannot describe the same Round differently.
 *
 * The second is structural, and it is why this module has exactly two imports. The resolution route
 * must reach **no Vote data in any response it can produce** (ADR-006, Binding Constraint FR8), and
 * `routes/rounds.ts` legitimately imports the vote repository for the Poll surface it also serves.
 * Importing the projection *from there* would put the vote tables on the anonymous route's module
 * graph - reachable, even if unreached - and there would be nothing but vigilance stopping some
 * later edit from actually reaching them. Here there is nothing to reach: this file imports two
 * types and `node` nothing, and `api/test/display-link-structure.test.ts` asserts the closure.
 *
 * Nothing here asks the database anything. Grouping is one pass over the Post-its a Round already
 * carries: no statement per Category, and no count re-derived by a client.
 */

/**
 * The viewer of a Board nobody is signed in to - the projected surface (S04).
 *
 * `mine` is the one field in this projection that is *about the viewer*, and a room machine has no
 * viewer, so nothing on a projected Board is anybody's. Passing a sentinel rather than adding a
 * branch keeps one projection: the room and the Facilitator's phone run the same code over the same
 * rows and cannot describe a Round differently.
 *
 * The NUL is what makes it safe rather than merely unlikely. PostgreSQL cannot store a NUL byte in
 * a `text` column at all, so this value provably equals no `post_it.author_sub` ever written - where
 * an empty string or a made-up word is only a value nobody has *happened* to use.
 */
export const NO_VIEWER = '\u0000 no signed-in viewer';

/**
 * One Post-it Round's Board as the read seams answer it: its Categories in the Facilitator's order,
 * and every Post-it on the Round with the placement that decides where it sits.
 *
 * The two arrive from two statements, each covering the whole Session, and are joined here - not by
 * a statement per Round and never by a statement per Category.
 */
export interface BoardView {
  categories: readonly Category[];
  postIts: readonly PostIt[];
}

/**
 * The Board projection contract: Categories in the Facilitator's order with their Post-its and
 * their counts, and the Uncategorised holding area beside them.
 *
 * Three things about this shape are load-bearing, and five later stories read it rather than
 * inventing a second one (`plan.json#sharedDecisions` → "Board read projection contract"):
 *
 *   - **`uncategorised` is always present** - on a Board holding no Post-its, and on a Board with
 *     no Category at all. It is where every Post-it arrives, where a late-syncing one lands, and a
 *     Conference archived with Post-its still in it is a valid terminal state the categorised
 *     output has to be able to represent (`prd.md#fr2-the-uncategorised-holding-area`).
 *   - **`uncategorised` is not a Category.** It carries no `id`, no `name` and no `position`,
 *     precisely so that nothing addresses it: a rename, reorder or remove has no identifier to
 *     send, and the API needs no refusal for a row that does not exist.
 *   - **Every Post-it appears exactly once**, under the Category holding it or in `uncategorised`.
 *     The flat array this replaced would have had to appear twice or be grouped again on every
 *     surface, and a client that groups is a second opinion about where a Post-it is.
 *
 * The counts are computed here and consumed, never re-derived by a client - the same discipline as
 * `canRun` and `mine`. Grouping is one pass over the Post-its this Round already carries: no
 * statement per Category, and nothing in here asks the database anything.
 */
export function toBoardWire(board: BoardView, viewerSub: string): Record<string, unknown> {
  const byCategory = new Map<string, Record<string, unknown>[]>();
  const uncategorised: Record<string, unknown>[] = [];
  const listed = new Set(board.categories.map((category) => category.id));

  for (const postIt of board.postIts) {
    const wire = toPostItWire(postIt, viewerSub);
    /*
     * No placement *is* Uncategorised. There is no id to compare and no sentinel to match against.
     *
     * **And a placement naming a Category this read did not list is Uncategorised too.** The
     * Categories and the Post-its are two statements with no transaction between them, so a
     * Category removed in between leaves the Post-it snapshot naming a row the Category snapshot no
     * longer has. Grouped strictly by id, such a Post-it would be in *neither* bucket and would
     * simply vanish from the payload for one read - which contradicts the invariant that a
     * non-discarded Post-it is in exactly one Category or in Uncategorised, never neither
     * (prd.md#fr2-the-uncategorised-holding-area). Uncategorised is the honest answer and the
     * self-correcting one: the removal this races against is itself moving those Post-its there,
     * and the write advanced the cursor, so the next read agrees.
     */
    const placement = postIt.categoryId;
    if (placement === null || !listed.has(placement)) {
      uncategorised.push(wire);
      continue;
    }
    const existing = byCategory.get(placement);
    if (existing === undefined) byCategory.set(placement, [wire]);
    else existing.push(wire);
  }

  return {
    categories: board.categories.map((category) => {
      const held = byCategory.get(category.id) ?? [];
      return { id: category.id, name: category.name, postIts: held, postItCount: held.length };
    }),
    uncategorised: { postIts: uncategorised, postItCount: uncategorised.length },
  };
}

/**
 * One Post-it as the board reads it.
 *
 * The author's **name** is here and their `sub` is not. The name is what the room reads and is
 * joined from `app_user.display_name` on this read, so a rename reaches every Post-it its owner
 * ever wrote. The `sub` is an identity confApp has no reason to publish to every Member in the
 * room, and `mine` answers the only question a client has of it - the same discipline as `canRun`:
 * the server's answer, consumed rather than re-derived, so no second client-side opinion about who
 * may correct a Post-it can drift out of step with the predicate that actually enforces it.
 *
 * `edited` is a boolean and `edited_at` deliberately stays in the database. The instant is the
 * stored fact and the flag is what the board shows; putting the instant on the wire would hand a
 * client a timestamp it could only render by converting a timezone the product does not carry
 * (S09's `AttendeeScheduleRefresh` guard), and a board of "13:42" readings would contradict every
 * Session time beside it on a device set away from the venue. Order is the payload's order.
 */
export function toPostItWire(postIt: PostIt, viewerSub: string): Record<string, unknown> {
  return {
    id: postIt.id,
    text: postIt.text,
    authorName: postIt.authorName,
    mine: postIt.authorSub === viewerSub,
    edited: postIt.editedAt !== null,
    /*
     * Rides the Post-it in the read model everything already uses, so every surface that shows a
     * Post-it shows this too - there is no separate late-arrivals list and no second read path
     * (FR6). It is the server's answer, computed from the Round's state at the instant the row was
     * written; no client re-derives it and none could.
     */
    arrivedAfterClose: postIt.arrivedAfterClose,
  };
}
