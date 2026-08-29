import type { Database, Queryable } from '../db.ts';
import { instantExpression } from '../sessions/wall-clock-time.ts';

/**
 * The `post_it` table, behind one seam.
 *
 * Three properties are load-bearing, and none is a convention a caller has to remember:
 *
 *   - **Every guard lives in the write statement's own predicate.** Authorship and
 *     Round-is-open are conditions on the INSERT's source query and on the UPDATE's and DELETE's
 *     `where`, never a read the route makes first
 *     (`docs/LEARNINGS.md#concurrency`: optimistic concurrency belongs in the predicate, not in an
 *     earlier round trip).
 *
 *     **The window this closes is a round trip, not a statement, and the difference is worth
 *     stating exactly.** Under `READ COMMITTED` the source query takes its snapshot when the
 *     statement begins, so a close committing *during* that statement is not seen and the write
 *     lands in a Round that closed microseconds earlier. EvalPlanQual re-checks only the target
 *     relation - `post_it` - never the `round` row read to qualify it.
 *
 *     That residual is **accepted deliberately**, because the two ways to remove it both cost more
 *     than it does. `FOR KEY SHARE` on the Round would not remove it at all: a close is an ordinary
 *     `UPDATE`, which takes `FOR NO KEY UPDATE`, and the two modes do not conflict. `FOR SHARE`
 *     would remove it and would manufacture deadlocks on the hot path - every contribution's own
 *     `AFTER` trigger issues an `UPDATE round` to advance the cursor, so two people contributing to
 *     one Round would each hold a share lock the other's trigger needs. Buying a microsecond of
 *     precision on "was it open?" with a deadlock between two attendees typing at once is a bad
 *     trade, and the 40P01 retry existing is not a reason to generate work for it.
 *
 *     What the predicate does guarantee, and what the product actually needs: no *decision* taken in
 *     an earlier round trip can be stale by the time the write runs, because there is no such
 *     decision. A Post-it accepted in the same instant a Facilitator closed the Round is a race
 *     between two people in a room, and either answer is defensible; a Post-it accepted because the
 *     API checked half a second ago is a bug.
 *   - **The author is a parameter, never a column read off the request.** This seam is given a
 *     `sub`; where that `sub` came from is the route's business, and the only permitted source is
 *     the verified credential (Binding Constraint FR3).
 *   - **The display name is joined, never copied.** `app_user.display_name` is read at board-read
 *     time, so somebody correcting the spelling of their own name has every Post-it they ever
 *     wrote corrected with it.
 *
 * Nothing is retained between calls. The API runs as several container replicas with no request
 * affinity (ADR-004), so a cached board would be wrong on the next replica even if it were fresh on
 * this one. A Post-it write also updates its Round row through a trigger while a Facilitator may
 * be updating that same row directly; both go through `db.query` / `db.transaction`, whose
 * existing SQLSTATE `40P01` retry is the one deadlock policy this API has.
 */

export interface PostIt {
  id: string;
  roundId: string;
  /** The OIDC subject claim. The only thing a Post-it is attributed by. */
  authorSub: string;
  /** Joined from `app_user.display_name` on this read - never a column on `post_it`. */
  authorName: string;
  text: string;
  createdAt: string;
  /** `null` until its author corrected it. */
  editedAt: string | null;
  /**
   * Whether this Post-it arrived after its Round had closed - an offline-composed contribution
   * that reached the API once the signal returned (FR6).
   *
   * Decided by the server from the Round's state at the instant the row was written, never by
   * anything the device sent. A Round reopened before the device drained its queue takes the same
   * Post-it as an ordinary contribution, with this `false`.
   */
  arrivedAfterClose: boolean;
}

interface PostItRow {
  id: string;
  round_id: string;
  author_sub: string;
  author_name: string;
  text: string;
  created_at: string;
  edited_at: string | null;
  arrived_after_close: boolean;
}

/**
 * Why a guarded write matched nothing.
 *
 * Kept apart because each is a different sentence and a different next move: the Post-it is gone,
 * it was never yours, or the Round has stopped taking changes. Returned rather than thrown so the
 * error envelope stays in the route, where the rest of this API's refusals are built.
 */
export type PostItWriteOutcome =
  | { outcome: 'written'; postIt: PostIt }
  | { outcome: 'removed' }
  | { outcome: 'missing' }
  | { outcome: 'not-author' }
  | { outcome: 'round-closed' };

/**
 * Why a contribution matched no Round to hang off - or why it needed no Round at all.
 *
 * `already-delivered` is a **success**, not a refusal: this submission identity reached the board
 * once and its author has since removed the Post-it it produced. The retry is told the item is
 * dealt with so the device drops it, and nothing is written. Recreating it would put a withdrawn
 * idea back in front of the room under its author's real name.
 */
export type ContributionOutcome =
  | { outcome: 'written'; postIt: PostIt }
  | { outcome: 'already-delivered' }
  | { outcome: 'gone' }
  | { outcome: 'missing' }
  | { outcome: 'round-closed' };

/**
 * How a contribution reached the API, which is the whole of what the closed-Round rule branches on.
 *
 * **One rule with two branches, never two rules.** A *live* submission to a closed Round is
 * refused (FR3); an *offline-composed* one is accepted and marked as having arrived late (FR6) -
 * but only into a Round that actually **ran and closed**, never into one that was authored and
 * never opened. A Round reopened before the device drained takes it as an ordinary contribution.
 * Every branch reads S01's single open/closed state, and its `closed_at`, at the instant of the
 * write - there is no client-side belief about the Round, no cached state and no grace window
 * anywhere in this.
 *
 * `offlineComposed` is a client assertion the server cannot verify, and that is accepted
 * deliberately: contributions are named, a late arrival is marked wherever it appears, and the PRD
 * names no refusal for an online client that sets it (FIS -> Constraints & Gotchas).
 *
 * `submissionId` is minted on the device when the item is queued and is identical across every
 * attempt at it. Its repeat is refused by the `(round_id, submission_id)` unique constraint and
 * resolved onto the row already stored - never by a read taken before the write, which two
 * replicas would each pass (Binding Constraint FR2).
 */
export interface Arrival {
  offlineComposed: boolean;
  submissionId: string | null;
}

const LIVE: Arrival = { offlineComposed: false, submissionId: null };

export interface PostItRepository {
  /**
   * Every Post-it on one Session's Rounds, keyed by Round id, oldest first.
   *
   * One statement for the whole Session rather than one per Round: a handler looping per Round is
   * the N+1 this project has already been bitten by, and the PRD requires one read to answer a
   * Session and everything in it.
   */
  listForSession(conferenceId: string, sessionId: string): Promise<Map<string, PostIt[]>>;
  contribute(
    conferenceId: string,
    sessionId: string,
    roundId: string,
    authorSub: string,
    text: string,
    arrival?: Arrival,
  ): Promise<ContributionOutcome>;
  edit(
    conferenceId: string,
    sessionId: string,
    roundId: string,
    postItId: string,
    authorSub: string,
    text: string,
  ): Promise<PostItWriteOutcome>;
  remove(
    conferenceId: string,
    sessionId: string,
    roundId: string,
    postItId: string,
    authorSub: string,
  ): Promise<PostItWriteOutcome>;
}

/**
 * One projection, so no caller can invent a different shape.
 *
 * `p` is the Post-it and `u` its author's `app_user` row. The join is what keeps the name off this
 * table; see the module note.
 */
const COLUMNS = [
  'p.id',
  'p.round_id',
  'p.author_sub',
  'u.display_name as author_name',
  'p.text',
  instantExpression('p.created_at', 'created_at'),
  instantExpression('p.edited_at', 'edited_at'),
  'p.arrived_after_close',
].join(', ');

function toPostIt(row: PostItRow): PostIt {
  return {
    id: row.id,
    roundId: row.round_id,
    authorSub: row.author_sub,
    authorName: row.author_name,
    text: row.text,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    arrivedAfterClose: row.arrived_after_close,
  };
}

export function createPostItRepository(db: Database): PostItRepository {
  /**
   * Why a guarded write matched nothing, asked once and only after it did.
   *
   * Deliberately a *diagnosis*, not a pre-check: the write has already happened or already failed
   * by the time this runs, so nothing it reads can change what was written. Reading first and
   * writing afterwards is what leaves a window a Round close can slip through.
   */
  async function diagnose(
    conferenceId: string,
    sessionId: string,
    roundId: string,
    postItId: string,
    authorSub: string,
  ): Promise<PostItWriteOutcome> {
    const rows = await db.query<{ author_sub: string; state: string }>(
      `select p.author_sub, r.state
         from post_it p
         join round r on r.id = p.round_id
        where p.id = $4 and p.round_id = $3 and p.conference_id = $1 and r.session_id = $2`,
      [conferenceId, sessionId, roundId, postItId],
    );

    const row = rows[0];
    if (row === undefined) return { outcome: 'missing' };
    // Authorship is reported before the Round's state: "this is not yours" is true whatever the
    // Round is doing, and telling somebody a closed Round refused them would send them back when
    // it reopens to try a thing that was never theirs to do.
    if (row.author_sub !== authorSub) return { outcome: 'not-author' };
    if (row.state !== 'open') return { outcome: 'round-closed' };
    // The write matched nothing, the row is here, it is yours and the Round is open: the row moved
    // between the write and this read. Reported as gone, which is what the caller's next read will
    // find anyway.
    return { outcome: 'missing' };
  }

  /** The one row a write produced, with its author's name joined on. */
  /**
   * Runs a write whose foreign keys point at a Round, and treats that Round disappearing underneath
   * it as "no rows" rather than as an error.
   *
   * SQLSTATE 23503 is a foreign-key violation. Here it means exactly one thing: the Round was there
   * when the statement's source read ran and gone by the time its constraints were checked. That is
   * a race between an Organizer deleting a Session and somebody in the room contributing to it -
   * ordinary, and already answered by the diagnosis the empty-result path performs. Returning no
   * rows routes it there; the alternative was an unmapped 23503 reaching the error handler as
   * `INTERNAL_ERROR`, which told the contributor the API had broken.
   */
  async function insertOrDiagnose<T>(write: () => Promise<T[]>): Promise<T[]> {
    try {
      return await write();
    } catch (error) {
      const violation = error as { code?: unknown };
      if (violation.code === '23503') return [];
      throw error;
    }
  }

  async function hydrate(id: string): Promise<PostIt | null> {
    const rows = await db.query<PostItRow>(
      `select ${COLUMNS} from post_it p join app_user u on u.sub = p.author_sub where p.id = $1`,
      [id],
    );
    const row = rows[0];
    return row === undefined ? null : toPostIt(row);
  }

  return {
    async listForSession(conferenceId: string, sessionId: string): Promise<Map<string, PostIt[]>> {
      const rows = await db.query<PostItRow>(
        `select ${COLUMNS}
           from post_it p
           join app_user u on u.sub = p.author_sub
           join round r on r.id = p.round_id
          where p.conference_id = $1 and r.session_id = $2
          order by p.created_at, p.id`,
        [conferenceId, sessionId],
      );

      const byRound = new Map<string, PostIt[]>();
      for (const row of rows) {
        const postIt = toPostIt(row);
        const existing = byRound.get(postIt.roundId);
        if (existing === undefined) byRound.set(postIt.roundId, [postIt]);
        else existing.push(postIt);
      }
      return byRound;
    },

    async contribute(
      conferenceId: string,
      sessionId: string,
      roundId: string,
      authorSub: string,
      text: string,
      arrival: Arrival = LIVE,
    ): Promise<ContributionOutcome> {
      /*
       * Insert-from-select, so "the Round is an open Post-it Round of this Session in this
       * Conference" is the INSERT's own source rather than a read taken before it. A Facilitator
       * closing the Round in the same instant does not admit the contribution: the select simply
       * matches no row and nothing is written.
       *
       * `r.kind` is compared here as well, and it has to be. The inserted `round_kind` comes from
       * the column's default, so on an **open** Poll the source query would match, the composite
       * foreign key would refuse the write, and the caller would read a generic internal error
       * instead of the refusal a closed Poll already gets. The constraint stays the guarantee -
       * nothing but a Post-it Round can ever hold a Post-it, whatever code says - and this
       * predicate is what keeps the constraint out of the request path.
       */
      /*
       * `r.state = 'open' or ($6 and r.closed_at is not null)` is the closed-Round rule, both
       * halves of it, in the one place the rule can be enforced without a window. Without the
       * offline-composed marker the source matches only an open Round, exactly as it did before
       * this became two branches; with it a Round that has *run and stopped* takes the write too.
       *
       * `closed_at` is the second term, and it is load-bearing. A Round is `closed` from the moment
       * it is authored, so state alone cannot tell a Round that finished from one nobody has ever
       * started - and a Post-it composed offline has no business landing in a Round that never ran,
       * least of all stamped as having arrived after a close that never happened. `open` already
       * reads this column to tell the same two cases apart for the reopen rule
       * (`round-repository.ts`); this is that distinction applied on the arrival side. A Round that
       * was never opened refuses a queued contribution exactly as it refuses a live one.
       *
       * `r.state <> 'open'` is the late-arrival marker, read from the same row in the same
       * statement - so it is the Round's state *at the instant the row is written*, not a state
       * some earlier read saw and not anything the device asserted. A Round reopened before the
       * queue drained yields `false` here and the Post-it lands as an ordinary contribution.
       *
       * `on conflict do nothing` is not the duplicate rule - the constraint is. This clause only
       * keeps a repeat from raising, so the route can resolve it onto the row already stored
       * below; PostgreSQL waits for a concurrent inserter of the same key before skipping, so a
       * retry served by a second replica reads the first replica's committed row rather than
       * missing it (Binding Constraint FR2).
       */
      /*
       * The delivery record is written **in the same statement** as the Post-it, and the Post-it is
       * refused if one already exists.
       *
       * `post_it.submission_id` alone stops a retry only while the row is there. Its author may
       * remove their own Post-it while the Round is open (FR3), and that takes the identity with
       * it - after which the queue's retry meets no constraint and puts the withdrawn Post-it back
       * on the board under their real name. `post_it_delivery` outlives the row precisely so that
       * cannot happen (`db/migrations/20260901090000000_post-it-delivery-record.sql`).
       *
       * One statement rather than a transaction: a single statement is already atomic, so there is
       * no window in which a Post-it exists without its delivery record or the reverse, and no
       * second round trip to hold open. The `not exists` guard is evaluated against the same
       * snapshot as the insert, and a concurrent retry racing it is refused by the primary key.
       */
      /*
       * A Round deleted *between* this statement's source read and its foreign-key check raises
       * SQLSTATE 23503, which the error handler had no mapping for and surfaced as a 500. The
       * caller did nothing wrong and the answer they need is the one the diagnosis below already
       * produces: the Round is not there. The same window applies to the delivery record, whose
       * foreign key points at the same Round.
       *
       * Caught rather than prevented: preventing it would mean locking the Round for the duration
       * of a contribution, which is a heavier promise than this write needs and is not what the
       * closed-Round rule is built on.
       */
      const inserted = await insertOrDiagnose(() =>
        db.query<{ id: string }>(
          `with written as (
           insert into post_it
             (round_id, conference_id, author_sub, text, arrived_after_close, submission_id)
           select r.id, r.conference_id, $4, $5, r.state <> 'open', $7::uuid
             from round r
            where r.id = $3 and r.session_id = $2 and r.conference_id = $1
              and r.kind = 'PostItRound'
              and (r.state = 'open' or ($6::boolean and r.closed_at is not null))
              and not exists (
                select 1 from post_it_delivery d
                 where d.round_id = r.id and d.submission_id = $7::uuid
              )
           on conflict (round_id, submission_id) do nothing
           returning id, round_id
         ), recorded as (
           insert into post_it_delivery (round_id, submission_id)
           select round_id, $7::uuid from written where $7::uuid is not null
           on conflict do nothing
         )
         select id from written`,
          [
            conferenceId,
            sessionId,
            roundId,
            authorSub,
            text,
            arrival.offlineComposed,
            arrival.submissionId,
          ],
        ),
      );

      const row = inserted[0];
      if (row === undefined) {
        /*
         * Nothing was inserted, and there are two reasons for that. The constraint refused a
         * repeat of a submission identity already stored for this Round - in which case the
         * contribution this request is making already exists, and the request resolves to it
         * rather than becoming a second one. Or nothing matched: the Round is closed to a live
         * contribution, or it is not there (or it is a Poll, which the caller reaches through the
         * same "no such post-it round here" sentence).
         *
         * The lookup is *after* the write and only because it produced nothing. Read first and it
         * would be the application-side duplicate check FR2 forbids, which two replicas each pass.
         */
        if (arrival.submissionId !== null) {
          /*
           * Scoped exactly as every other statement in this module is - Conference, Session and
           * author all in the predicate. The retry is a contribution the *caller* is making, so the
           * only right answer is a row that is theirs, on a Round of this Session in this
           * Conference; anything else would be somebody else's text returned with a 200.
           */
          const already = await db.query<PostItRow>(
            `select ${COLUMNS}
               from post_it p
               join app_user u on u.sub = p.author_sub
               join round r on r.id = p.round_id
              where p.round_id = $3 and p.submission_id = $5::uuid
                and p.conference_id = $1 and r.session_id = $2 and p.author_sub = $4`,
            [conferenceId, sessionId, roundId, authorSub, arrival.submissionId],
          );
          const stored = already[0];
          if (stored !== undefined) return { outcome: 'written', postIt: toPostIt(stored) };

          /*
           * No Post-it, but the submission was delivered: its author put it on the board and then
           * took it off again. The retry must **not** write a second one - that is the whole point
           * of the delivery record outliving the row - and it is not a refusal either, because
           * nothing went wrong. The device is told the submission is dealt with so it drops the
           * item, and no Post-it comes back to explain itself to a room.
           */
          const delivered = await db.query<{ submission_id: string }>(
            `select d.submission_id
               from post_it_delivery d
               join round r on r.id = d.round_id
              where d.round_id = $3 and d.submission_id = $4::uuid
                and r.session_id = $2 and r.conference_id = $1`,
            [conferenceId, sessionId, roundId, arrival.submissionId],
          );
          if (delivered[0] !== undefined) return { outcome: 'already-delivered' };
        }

        const rounds = await db.query<{ state: string }>(
          `select state from round
            where id = $3 and session_id = $2 and conference_id = $1 and kind = 'PostItRound'`,
          [conferenceId, sessionId, roundId],
        );
        return rounds[0] === undefined ? { outcome: 'missing' } : { outcome: 'round-closed' };
      }

      const postIt = await hydrate(row.id);
      /*
       * Written, and gone before it could be read back. The insert and this read are two
       * statements, so its author removing it from another device in between is an ordinary race,
       * not a broken invariant - the same person on a phone and a laptop is a real configuration in
       * a room. Raising here turned that into a 500, which told them the API had failed when what
       * actually happened is that they got what they asked for and then undid it.
       */
      if (postIt === null) return { outcome: 'gone' };
      return { outcome: 'written', postIt };
    },

    async edit(
      conferenceId: string,
      sessionId: string,
      roundId: string,
      postItId: string,
      authorSub: string,
      text: string,
    ): Promise<PostItWriteOutcome> {
      /*
       * Both guards inside the UPDATE's predicate: `p.author_sub = $5` and `r.state = 'open'`.
       * Neither is checked in the route first, so neither carries a round-trip window - the check
       * *is* the write. The one-statement residual the module note sets out applies here too and is
       * accepted for the same reasons: a close committing during this statement is outside its
       * snapshot, and the locks that would change that either do not conflict with a close or
       * deadlock two people editing one Round.
       *
       * `edited_at` is stamped by the same statement, with `clock_timestamp()` rather than `now()`
       * (transaction-start time) - and only when the text actually changed. `(edited)` is a
       * sentence about the Post-it, not about somebody having opened the correction box: saving
       * the text unchanged is a no-op, and marking every board in the room for it would be a
       * visible claim that nothing supports. The comparison is on the stored text against the
       * incoming one, in the statement itself, so no read decides it.
       *
       * The Round's activity cursor still advances, because the AFTER trigger fires on any UPDATE.
       * That costs one refetch that finds the board unchanged, which is the same self-correcting
       * direction the Session read's stale-low watermark takes.
       */
      const updated = await db.query<{ id: string }>(
        `update post_it p
            set text = $6,
                edited_at = case when p.text = $6 then p.edited_at else clock_timestamp() end
           from round r
          where p.id = $4 and p.round_id = $3 and p.conference_id = $1
            and r.id = p.round_id and r.session_id = $2
            and p.author_sub = $5 and r.state = 'open'
         returning p.id`,
        [conferenceId, sessionId, roundId, postItId, authorSub, text],
      );

      const row = updated[0];
      if (row === undefined) {
        return diagnose(conferenceId, sessionId, roundId, postItId, authorSub);
      }

      const postIt = await hydrate(row.id);
      /*
       * Corrected, and gone before it could be read back - its author removed it from another
       * device between the two statements. `missing` is the honest answer and the route already has
       * the sentence for it: the post-it is not where the caller thinks it is, which is exactly what
       * their next read will find. Raising made this a 500 instead.
       */
      if (postIt === null) return { outcome: 'missing' };
      return { outcome: 'written', postIt };
    },

    async remove(
      conferenceId: string,
      sessionId: string,
      roundId: string,
      postItId: string,
      authorSub: string,
    ): Promise<PostItWriteOutcome> {
      /*
       * The row goes. No tombstone, no soft-delete flag, no placeholder - an Attendee deleting
       * their only Post-it leaves *no trace that it existed* (prd.md#edge-cases). The trigger on
       * this table fires on DELETE too, so the removal moves the Round's activity watermark and
       * reaches every open board on the next poll.
       *
       * The same two guards, in the same place, for the same reason as the edit above.
       */
      const deleted = await db.query<{ id: string }>(
        `delete from post_it p
          using round r
          where p.id = $4 and p.round_id = $3 and p.conference_id = $1
            and r.id = p.round_id and r.session_id = $2
            and p.author_sub = $5 and r.state = 'open'
         returning p.id`,
        [conferenceId, sessionId, roundId, postItId, authorSub],
      );

      if (deleted[0] === undefined) {
        return diagnose(conferenceId, sessionId, roundId, postItId, authorSub);
      }
      return { outcome: 'removed' };
    },
  };
}

/**
 * How many Post-its one Session has collected, across every Round it holds (S05 TI02).
 *
 * Exported, and taking a `Queryable`, so the Session-deletion transaction can ask without reaching
 * into the `post_it` table itself – which is what keeps this table owned by this module
 * (`api/test/post-it-structure.test.ts`). Reached through the Round, because that is the only way
 * a Post-it knows which Session it belongs to.
 *
 * A late arrival (S04) is an ordinary `post_it` row and is counted like any other: it is collected
 * output, and the marker records only *when* it landed.
 *
 * The Round's own open/closed state is deliberately not a condition. A closed Post-it Round still
 * holds its Board, and that Board is exactly what the deletion guard exists to protect.
 */
export async function countPostItsForSession(
  tx: Queryable,
  conferenceId: string,
  sessionId: string,
): Promise<number> {
  const rows = await tx.query<{ count: number }>(
    `select count(*)::int as count
       from post_it p
       join round r on r.id = p.round_id
      where r.conference_id = $1 and r.session_id = $2`,
    [conferenceId, sessionId],
  );
  return rows[0]?.count ?? 0;
}
