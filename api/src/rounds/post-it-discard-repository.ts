import type { Database } from '../db.ts';
import { instantExpression } from '../sessions/wall-clock-time.ts';

/**
 * The Facilitator's Discard, behind one seam (S05 FR4, ADR-008).
 *
 * **A separate module from `post-it-repository.ts`, and the separation is the point.** The two
 * removal paths on a Post-it have opposite guarantees - an author's delete leaves *no trace that it
 * existed*, a Facilitator's Discard leaves a trace and is reversible - and they are kept apart in
 * storage so that neither can be relaxed by relaxing the other (Binding Constraint FR4). Keeping
 * them apart in *source* is the same rule one level up: `api/test/post-it-structure.test.ts` asserts
 * that `post-it-repository.ts` matches no `deleted_at|is_deleted|tombstone|soft` and carries exactly
 * one `count(`, and that guard is the module boundary rather than an obstacle to route around.
 *
 * Three properties are load-bearing here, and none is a convention a caller has to remember:
 *
 *   - **The presence of a `post_it_discard` row *is* the Discard**; its absence *is* not-discarded.
 *     There is no boolean, no state column and no second representation, so both directions are
 *     idempotent by construction: a repeat Discard conflicts on the primary key and does nothing, a
 *     restore of a never-discarded Post-it deletes nothing and is a success. Neither needs a read
 *     taken before the write, which two container replicas would each pass (ADR-004).
 *   - **Every guard lives in the write statement's own predicate**, exactly as it does in
 *     `post-it-repository.ts`: "this Post-it, on this Post-it Round, of this Session, in this
 *     Conference" is a condition on the statement, never a read the route takes first
 *     (`docs/LEARNINGS.md#concurrency`).
 *   - **The discarder is a parameter, never a column read off the request.** This seam is given a
 *     `sub`; where it came from is the route's business and the only permitted source is the verified
 *     credential (Binding Constraint FR6). There is no argument here an actor could arrive through
 *     any other way.
 *
 * **No Round open/closed condition anywhere in this module.** Sorting may begin before a Round
 * closes and continues after it (FR3, FR4), so there is nothing to compare `r.state` against - unlike
 * author deletion, which keeps its `r.state = 'open'` guard for a different reason. The
 * archived-Conference refusal is the route's, through `assertEditable`.
 *
 * Nothing is retained between calls.
 */

/**
 * The exclusion predicate: **the single definition of "not discarded", read by every Board read.**
 *
 * An anti-join in the statement itself, never a filter a handler applies to a result set. A read
 * that returned discarded rows and dropped them in TypeScript would compute its counts over the
 * wrong set, and every surface downstream of it would have to remember to do the same thing again
 * (`plan.json#sharedDecisions` -> "Discard state is stored outside the post_it row"; S06, S07 and
 * S08 read through this).
 *
 * It names `p` because every statement it is spliced into aliases `post_it` as `p` - the projection
 * in `post-it-repository.ts` does, and so does the placement write whose predicate this closes.
 * Exported as a fragment rather than restated per query so there is one place the rule lives and one
 * place a mistake in it would show.
 *
 * Exactly two reads in this system select *on* the presence of the row instead: `listForRound`
 * below, and the future Report slice (REQ-023 / REQ-024).
 */
export const NOT_DISCARDED =
  'not exists (select 1 from post_it_discard pd where pd.post_it_id = p.id)';

/**
 * One discarded Post-it as its Board's Facilitator reads it.
 *
 * The Post-it's own author **and** the person who discarded it, both joined from
 * `app_user.display_name` at read time and neither copied onto a row - so a corrected spelling
 * reaches every trace as it reaches every Post-it.
 *
 * `discardedAt` is a **display string, already formatted, and deliberately not an instant.** The
 * board wire has never carried a timestamp for exactly this reason (`board-wire.ts`, `edited`): the
 * product stores no venue timezone, so a client handed a raw instant could only render it by
 * applying the browser's zone, and a trace reading "14:32" on a laptop set two zones away would
 * contradict every Session time beside it. Formatting here, in UTC and labelled as such, means no
 * layer converts anything and the sentence on screen is the sentence the server stands behind. The
 * format is numeric rather than `DD Mon YYYY` so it does not depend on the server's `lc_time`.
 */
export interface DiscardedPostIt {
  postItId: string;
  text: string;
  /** The Post-it's own author. Post-its always carry the author's name (`AGENTS.md`). */
  authorName: string;
  /** Who discarded it - the half of the trace that makes this not an author deletion. */
  discardedByName: string;
  /** When, as `2026-11-12 14:32 UTC`. See the interface note. */
  discardedAt: string;
}

interface DiscardedRow {
  post_it_id: string;
  text: string;
  author_name: string;
  discarded_by_name: string;
  discarded_at: string;
}

/**
 * What a Discard or a restore did, or why it matched nothing.
 *
 * **`discarded` and `restored` are the *requested end state*, not "a row moved".** A second Discard
 * of an already-discarded Post-it and a restore of one that was never discarded both report success
 * with nothing written, because FR4 says the requested end state is the one that holds. `missing` is
 * the only refusal, and it is the one sentence this API already has for a Post-it that is not on the
 * Board the caller named.
 *
 * Returned rather than thrown so the error envelope stays in the route, where the rest of this API's
 * refusals are built.
 */
export type DiscardOutcome = { outcome: 'discarded' } | { outcome: 'missing' };
export type RestoreOutcome = { outcome: 'restored' } | { outcome: 'missing' };

export interface PostItDiscardRepository {
  /**
   * Take a Post-it off the Board, leaving a trace of who did it and when.
   *
   * Clears the placement in the same statement, which is what makes "a restore returns it to
   * Uncategorised" a structural consequence rather than a rule the restore path has to remember:
   * Uncategorised is the absence of a placement, so there is nothing left to return to.
   */
  discard(
    conferenceId: string,
    sessionId: string,
    roundId: string,
    postItId: string,
    discardedBySub: string,
  ): Promise<DiscardOutcome>;
  /**
   * Put it back - into **Uncategorised**, always.
   *
   * **No destination parameter, and that is the point.** FR4's *"a restore always targets
   * Uncategorised; a destination Category may not be supplied"* is expressed as a seam with nowhere
   * to supply one, rather than as a validation rule a route remembers to apply.
   */
  restore(
    conferenceId: string,
    sessionId: string,
    roundId: string,
    postItId: string,
  ): Promise<RestoreOutcome>;
  /** Everything currently discarded on one Board, oldest Discard first. */
  listForRound(
    conferenceId: string,
    sessionId: string,
    roundId: string,
  ): Promise<DiscardedPostIt[]>;
}

/**
 * The Post-it named by the route, on the Board named by the route, as the source of every write
 * here.
 *
 * Spliced into both statements so the identity conditions cannot drift between them. `r.kind` is
 * compared for the same reason the contribution's insert compares it: a Round of another kind is
 * reached through the same "no such post-it round here" sentence rather than through a constraint
 * violation the caller reads as an internal error.
 */
const ON_THIS_BOARD = `p.id = $4 and p.round_id = $3 and p.conference_id = $1
              and r.session_id = $2 and r.kind = 'PostItRound'`;

export function createPostItDiscardRepository(db: Database): PostItDiscardRepository {
  /**
   * Runs a write whose foreign keys point at a Post-it or a Round, and treats either disappearing
   * underneath it as "no rows" rather than as an error.
   *
   * SQLSTATE 23503 here means exactly one thing: the row was there when the statement's source query
   * ran and gone by the time its constraints were checked - an author removing their own Post-it, or
   * an Organizer deleting the Session, while a Facilitator sorts. That is an ordinary race in a room
   * with two devices in it, and the diagnosis below already produces the sentence that is true either
   * way. The alternative was an unmapped 23503 reaching the error handler as `INTERNAL_ERROR`, which
   * tells a Facilitator the API broke.
   */
  async function writeOrDiagnose<T>(write: () => Promise<T[]>): Promise<T[]> {
    try {
      return await write();
    } catch (error) {
      const violation = (error ?? {}) as { code?: unknown };
      if (violation.code === '23503') return [];
      throw error;
    }
  }

  /**
   * Why a write matched nothing, asked once and only after it did.
   *
   * A *diagnosis*, never a pre-check - the same discipline `post-it-repository.ts` holds to. The
   * write has already happened or already failed by the time this runs, so nothing it reads can
   * change what was written, and there is no window between a decision and its consequence because
   * there is no earlier decision.
   *
   * It answers one question: is the Post-it on the Board the caller named, and does it carry a
   * trace? A write that matched nothing while the answer agrees with what was asked for is the
   * idempotent case and is a success.
   */
  async function traceState(
    conferenceId: string,
    sessionId: string,
    roundId: string,
    postItId: string,
  ): Promise<{ onBoard: boolean; discarded: boolean }> {
    const rows = await db.query<{ discarded: boolean }>(
      `select (pd.post_it_id is not null) as discarded
         from post_it p
         join round r on r.id = p.round_id
         left join post_it_discard pd on pd.post_it_id = p.id
        where ${ON_THIS_BOARD}`,
      [conferenceId, sessionId, roundId, postItId],
    );
    const row = rows[0];
    if (row === undefined) return { onBoard: false, discarded: false };
    return { onBoard: true, discarded: row.discarded };
  }

  /**
   * One attempt at a write, and whether the state moved under it.
   *
   * `contested` is the narrow interleaving the diagnosis cannot otherwise name: the write matched
   * nothing, the Post-it **is** on the Board, and the trace is not in the state the caller asked
   * for - so a second Facilitator did the opposite act between this statement and its diagnosis.
   * Reporting that as `missing` would tell somebody a named colleague's Post-it is not on the round
   * it is visibly sitting on, which is the one sentence this seam must never produce for a Post-it
   * that is there.
   *
   * The caller retries once. That is `category-repository.ts#writeOnceThenRetry`'s idiom, applied
   * for the same reason: the state that refused the write is transient, and a second attempt against
   * a fresh snapshot resolves it without holding a lock across a round trip.
   */
  type Attempt<T> = T | 'contested';

  async function attemptDiscard(
    conferenceId: string,
    sessionId: string,
    roundId: string,
    postItId: string,
    discardedBySub: string,
  ): Promise<Attempt<DiscardOutcome>> {
    const written = await writeOrDiagnose(() =>
      db.query<{ post_it_id: string }>(
        `with traced as (
             insert into post_it_discard (post_it_id, round_id, discarded_by_sub)
             select p.id, p.round_id, $5
               from post_it p
               join round r on r.id = p.round_id
              where ${ON_THIS_BOARD}
             on conflict (post_it_id) do nothing
             returning post_it_id
           ), cleared as (
             update post_it set category_id = null
              where id in (select post_it_id from traced)
             returning id
           )
           select post_it_id from traced`,
        [conferenceId, sessionId, roundId, postItId, discardedBySub],
      ),
    );

    if (written[0] !== undefined) return { outcome: 'discarded' };

    /*
     * Nothing was traced, and there are three reasons for that: the Post-it already carries a trace,
     * which is the idempotent success; it is not on this Board at all; or somebody restored it
     * between the conflicting insert and this read. The lookup is *after* the write and only because
     * it produced nothing - read first and it would be the application-side check two replicas each
     * pass.
     */
    const state = await traceState(conferenceId, sessionId, roundId, postItId);
    if (state.discarded) return { outcome: 'discarded' };
    return state.onBoard ? 'contested' : { outcome: 'missing' };
  }

  async function attemptRestore(
    conferenceId: string,
    sessionId: string,
    roundId: string,
    postItId: string,
  ): Promise<Attempt<RestoreOutcome>> {
    const removed = await writeOrDiagnose(() =>
      db.query<{ post_it_id: string }>(
        `with removed as (
             delete from post_it_discard pd
               using post_it p, round r
              where pd.post_it_id = p.id and r.id = p.round_id
                and ${ON_THIS_BOARD}
            returning pd.post_it_id
           ), cleared as (
             update post_it set category_id = null
              where id in (select post_it_id from removed)
             returning id
           )
           select post_it_id from removed`,
        [conferenceId, sessionId, roundId, postItId],
      ),
    );

    if (removed[0] !== undefined) return { outcome: 'restored' };

    /*
     * Nothing was removed: the Post-it was never discarded - the idempotent success, where the
     * requested end state already holds - or it is not on this Board, or somebody discarded it
     * between the no-op delete and this read.
     */
    const state = await traceState(conferenceId, sessionId, roundId, postItId);
    if (!state.onBoard) return { outcome: 'missing' };
    return state.discarded ? 'contested' : { outcome: 'restored' };
  }

  return {
    async discard(
      conferenceId: string,
      sessionId: string,
      roundId: string,
      postItId: string,
      discardedBySub: string,
    ): Promise<DiscardOutcome> {
      /*
       * **One statement: the trace goes in and the placement comes off together** - see
       * `attemptDiscard`, which owns it.
       *
       * Insert-from-select, so "this Post-it, on this Post-it Round, of this Session, in this
       * Conference" is the INSERT's own source rather than a read taken before it. `round_id` is
       * carried from the Post-it's own row rather than from the route's parameter, so the composite
       * foreign key on the trace cannot be satisfied by a request that names a Round the Post-it is
       * not on - the predicate and the constraint agree by construction.
       *
       * `on conflict (post_it_id) do nothing` is not the idempotence rule - the primary key is. That
       * clause only keeps a repeat from raising, so the diagnosis can resolve it onto the trace
       * already stored, with its original discarder and its original instant untouched (FR4:
       * discarding an already-discarded Post-it succeeds silently).
       *
       * **Clearing the placement is half of what makes restore-to-Uncategorised structural.**
       * Uncategorised is the absence of a placement (`prd.md#fr2-the-uncategorised-holding-area`),
       * so once this has run there is no former Category for a restore to return the Post-it to. The
       * other half is `restore` clearing it again - see there for the race that makes the second
       * clearing load-bearing rather than defensive.
       *
       * The Post-it's own `AFTER UPDATE` trigger and the trace table's `AFTER INSERT` trigger both
       * advance the Round's activity watermark, so the Discard reaches every open Board on the next
       * tick of the one shared poll. There is no cursor of this story's own.
       *
       * **Retried once, and only on `contested`** - a second Facilitator restoring in the window
       * between the conflicting insert and its diagnosis. The retry runs against a fresh snapshot,
       * which is what resolves it; a second contested answer means the two of them are actively
       * undoing each other, and sorting is last-write-wins with no conflict UI
       * (`prd.md#edge-cases`), so the requested end state is reported and the Board re-read both
       * surfaces make next is what says where the Post-it actually is.
       */
      const first = await attemptDiscard(
        conferenceId,
        sessionId,
        roundId,
        postItId,
        discardedBySub,
      );
      if (first !== 'contested') return first;

      const second = await attemptDiscard(
        conferenceId,
        sessionId,
        roundId,
        postItId,
        discardedBySub,
      );
      return second === 'contested' ? { outcome: 'discarded' } : second;
    },

    async restore(
      conferenceId: string,
      sessionId: string,
      roundId: string,
      postItId: string,
    ): Promise<RestoreOutcome> {
      /*
       * The trace goes, and the placement is cleared with it.
       *
       * **The second clearing is not belt-and-braces.** `place`'s not-discarded conjunct is a
       * `NOT EXISTS` sub-select over `post_it_discard`, and under `READ COMMITTED` a placement that
       * blocks on the row lock the Discard holds is re-checked by EvalPlanQual against the *target
       * relation only* - `post_it` - while the sub-select still sees the command's original
       * snapshot, in which the trace does not yet exist. That is the same limit the module note in
       * `post-it-repository.ts` records for the `round` row, and it means a placement can commit a
       * `category_id` onto a Post-it that is already discarded. Clearing here removes the
       * dependence entirely: whatever raced the Discard, a restore returns the Post-it to
       * **Uncategorised** and to nowhere else, which is what FR4 and OC02 require and what ADR-008
       * calls a structural consequence rather than a rule this path has to remember.
       *
       * There is no destination parameter and no column holding a former Category, so this
       * statement could not put a Post-it back where it came from even if it tried.
       *
       * The identity conditions are the same ones the Discard used, in the statement's own
       * predicate: a trace is removable only through the Board it belongs to. The `AFTER DELETE`
       * trigger on the trace table advances the Round's activity watermark, so the Post-it
       * reappears on every open Board on the next tick.
       *
       * Retried once on `contested`, for the mirror of the reason `discard` is.
       */
      const first = await attemptRestore(conferenceId, sessionId, roundId, postItId);
      if (first !== 'contested') return first;

      const second = await attemptRestore(conferenceId, sessionId, roundId, postItId);
      return second === 'contested' ? { outcome: 'restored' } : second;
    },

    async listForRound(
      conferenceId: string,
      sessionId: string,
      roundId: string,
    ): Promise<DiscardedPostIt[]> {
      /*
       * **The one read in this system that selects *on* the presence of a trace** - every other read
       * excludes it through `NOT_DISCARDED` above. The Facilitator's reversal surface is the only
       * place a discarded Post-it appears at all, which is what makes it the only place a Discard can
       * be reversed (`design-decisions.md` -> "The discarded Post-its surface").
       *
       * Both names are joined here and neither is stored: `a` is the Post-it's own author and `u` is
       * whoever discarded it. The trace is worth nothing without the second one - "who discarded it
       * and when" is the entire difference between this and an author deleting their own Post-it,
       * which leaves nothing at all.
       *
       * Oldest Discard first, which is the order `post_it_discard_by_round` already carries.
       * `post_it_id` breaks the tie so the order is total and stable rather than whatever the plan
       * produced - two Discards can share a `clock_timestamp()` reading under a coarse clock.
       *
       * Scoped by Conference, Session and Round in the predicate like every other statement in this
       * module, so a Round id from another Session answers with nothing rather than with somebody
       * else's Board.
       */
      const rows = await db.query<DiscardedRow>(
        `select pd.post_it_id,
                p.text,
                a.display_name as author_name,
                u.display_name as discarded_by_name,
                ${instantExpression('pd.discarded_at', 'discarded_at')}
           from post_it_discard pd
           join post_it p on p.id = pd.post_it_id
           join round r on r.id = p.round_id
           join app_user a on a.sub = p.author_sub
           join app_user u on u.sub = pd.discarded_by_sub
          where pd.round_id = $3 and p.conference_id = $1
            and r.session_id = $2 and r.kind = 'PostItRound'
          order by pd.discarded_at, pd.post_it_id`,
        [conferenceId, sessionId, roundId],
      );

      return rows.map((row) => ({
        postItId: row.post_it_id,
        text: row.text,
        authorName: row.author_name,
        discardedByName: row.discarded_by_name,
        discardedAt: displayInstant(row.discarded_at),
      }));
    },
  };
}

/**
 * `2026-11-12T14:32:07.123456Z` -> `2026-11-12 14:32 UTC`.
 *
 * The one place a Discard instant becomes something a person reads, and it happens **here** rather
 * than on a device. See `DiscardedPostIt.discardedAt`: the product carries no venue timezone, so a
 * client given the instant could only render it in the browser's zone, and the trace would then
 * disagree with every Session time beside it for anyone travelling. Saying UTC in the string is the
 * honest version of that and needs no zone the schedule does not have.
 *
 * Derived from `instantExpression`'s output by truncation, so the two cannot drift into different
 * ideas of what the stored instant is; the seconds and microseconds are dropped because a Discard is
 * an act in a room, not a measurement.
 */
function displayInstant(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}
