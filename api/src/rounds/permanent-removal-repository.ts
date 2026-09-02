import type { Database } from '../db.ts';

/**
 * **Permanent Removal**: an Admin taking a Post-it off every surface for good (S06 FR5).
 *
 * The third and last removal concept on a Post-it, and it has its own module for the same reason
 * S05's Discard has one. The three are kept apart in *source* because they are kept apart in
 * *behaviour*, and a shared home is how one of them quietly acquires another's guards:
 *
 *   - **author deletion** (`post-it-repository.ts#remove`) – the author's own, only while the Round
 *     is open, refusing with a diagnosis when it matches nothing;
 *   - **Discard** (`post-it-discard-repository.ts`) – the Facilitator's, leaving a trace and
 *     reversible, expressed as a row *beside* the Post-it rather than as a change to it;
 *   - **Permanent Removal** – this one. Admin-only, at any Round state, on any Post-it in the
 *     Conference, irreversible, and leaving nothing at all behind.
 *
 * Three properties are load-bearing here.
 *
 * **The row goes, and the delete is the whole implementation.** No tombstone, no flag, no
 * `deleted_at`, no "removed by" record. FR5's *"leaves no trace on any surface"* is a property of
 * the row's absence, so anything written here to remember the act would be the trace the
 * requirement forbids. The `post_it` delete trigger fires, which is what carries the removal to
 * every open Board on the next poll through the one activity watermark.
 *
 * **Any Discard trace goes with it, and nothing here says so.** `post_it_discard.post_it_id`
 * references `post_it (id) ON DELETE CASCADE` (S05,
 * `db/migrations/20260904090000000_post-it-discard.sql`), so the trace is removed by the schema.
 * A second statement against `post_it_discard` here would make one fact true two ways and could
 * drift; the cascade is proved by test instead (`permanent-removal.integration.test.ts`).
 *
 * **Matching nothing is a success, and that is the opposite of the author path's answer.**
 * `post-it-repository.ts#remove` diagnoses a zero-row delete, because a caller who is not the
 * author or whose Round has closed must be told which. Here there is no diagnosis, no
 * `POST_IT_NOT_FOUND` and nothing for a route to refuse with (FR5 -> Validation: *"removing a
 * Post-it that is already gone succeeds silently"*).
 *
 * **What that guarantees is narrower than "that Post-it is gone", and the difference is deliberate
 * rather than incidental.** Every identity condition below is part of the statement's predicate, so
 * it matches nothing in two different cases: the Post-it is genuinely gone, *and* the Post-it is
 * still stored but at an address other than the one the request named - another Round, another
 * Session, another Conference, or a Round that is not a Post-it Round. Both answer success. What
 * this seam guarantees is that **nothing is stored at the address the caller named**, which is the
 * address their Board is drawn from; it says nothing about the id in isolation. A mis-targeted
 * removal is therefore neither refused nor reported, and `permanent-removal.integration.test.ts`
 * -> "touches no post-it on another round of the same session" is precisely that case, asserted.
 * Narrowing the success to "genuinely absent" would need a second read after the write and is a
 * product decision nobody has taken; what this note exists for is that the next reader does not
 * believe it already was.
 *
 * **No author condition and no Round-state condition**, unlike the author delete this module's
 * statement otherwise reads like. Permanent Removal reaches any Post-it in the Conference whoever
 * wrote it and whatever its Round is doing - moderating something abusive cannot wait for a Round
 * to be open, and the whole point is that it is *not* the author acting. Who may do it is the
 * route's question, answered by a conference-wide Admin check before this is ever called.
 *
 * Nothing is retained between calls (ADR-004).
 */

/**
 * What a Permanent Removal did.
 *
 * One member, deliberately. A union with a single arm reads oddly beside `PostItWriteOutcome`'s
 * five - and it is exactly the statement this seam makes: **there is no refusal here**. The two
 * refusals that are about the caller (not an Admin; the Conference is archived) are produced by the
 * route before this runs, and the only remaining outcome - the Post-it is not there - is a success.
 * Written as a union rather than as `void` so a later story that wanted to add a refusal would have
 * to add an arm and confront that decision head-on.
 */
export type PermanentRemovalOutcome = { outcome: 'removed' };

export interface PermanentRemovalRepository {
  /**
   * Take this Post-it off every surface for good.
   *
   * **No `sub` parameter, and that is the point.** Nothing about the acting Admin is written
   * anywhere, so there is no argument here an actor could arrive through and no column one could
   * reach (Binding Constraint FR6, and FR5's "no trace"). Who *may* remove is the route's question.
   */
  remove(
    conferenceId: string,
    sessionId: string,
    roundId: string,
    postItId: string,
  ): Promise<PermanentRemovalOutcome>;
}

/**
 * The Post-it named by the route, on the Board named by the route.
 *
 * Named rather than inlined for the reason `post-it-discard-repository.ts#ON_THIS_BOARD` is: the
 * identity conditions are one definition, and a later statement in this module would have to reuse
 * it rather than restate it slightly differently. `r.kind` is compared here for the same reason it
 * is there - a Round of another kind is simply not this Board.
 */
const ON_THIS_BOARD = `p.id = $4 and p.round_id = $3 and p.conference_id = $1
             and r.session_id = $2 and r.kind = 'PostItRound'`;

export function createPermanentRemovalRepository(db: Database): PermanentRemovalRepository {
  return {
    async remove(
      conferenceId: string,
      sessionId: string,
      roundId: string,
      postItId: string,
    ): Promise<PermanentRemovalOutcome> {
      /*
       * Every guard is the statement's own predicate, exactly as it is in the other two removal
       * paths: "this Post-it, on this Post-it Round, of this Session, in this Conference" is a
       * condition on the delete rather than a read taken before it, so a Post-it that moves or
       * disappears between a check and a write cannot be reached by one
       * (`docs/LEARNINGS.md#concurrency`).
       *
       * `r.kind` is compared for the reason S05's statements compare it: a Round of another kind is
       * simply not this Board, and treating it as such here keeps the answer identical to the one a
       * missing Post-it produces.
       *
       * **Deliberately no `p.author_sub` and no `r.state = 'open'`** - see the module note. Copying
       * the author delete's two guards across is the mistake this comment exists to prevent.
       *
       * The result is not read. Zero rows and one row are the same answer - and zero rows means
       * "nothing is stored at this address", which is not the same claim as "this Post-it no longer
       * exists". See the module note.
       */
      await db.query<{ id: string }>(
        `delete from post_it p
           using round r
           where r.id = p.round_id and ${ON_THIS_BOARD}
        returning p.id`,
        [conferenceId, sessionId, roundId, postItId],
      );

      return { outcome: 'removed' };
    },
  };
}
