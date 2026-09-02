import type { Database, Queryable } from '../db.ts';
import { NOT_DISCARDED } from './post-it-discard-repository.ts';
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
  /**
   * Where it sits on the Board: the Category holding it, or `null` for **Uncategorised**.
   *
   * `null` is not a sentinel and names nothing. Uncategorised is the *state of having no
   * placement* (`prd.md#fr2-the-uncategorised-holding-area`), which is why there is no id, no
   * reserved value and no row for it anywhere - and why a Post-it that has never been sorted needs
   * no write at all to be in it.
   *
   * It does not reach the wire. The Board read groups by it server-side and sends Categories with
   * their Post-its, so no client re-derives the grouping and the Post-it wire shape is unchanged.
   */
  categoryId: string | null;
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
  category_id: string | null;
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
 * What a placement did, or why it matched nothing (S03 FR3).
 *
 * Its own union rather than a reuse of `PostItWriteOutcome`, because the two writes refuse for
 * different reasons and a shared union would carry members neither of them can produce. A placement
 * is never refused for authorship - it is not the author's write - and never for the Round being
 * closed, because sorting is exactly what happens *after* a Round closes
 * (`prd.md#fr3-placing-post-its-into-categories`).
 *
 * `destination-missing` is the cross-Board refusal and the vanished-Category one, which are the same
 * sentence: the Category named is not on this Post-it's Board.
 *
 * `discarded` is S05's, and it is a **third** member rather than a reuse of either of the other two.
 * A Facilitator whose stale Board still shows a Post-it somebody has discarded has a next move
 * nobody else has - restore it first (FR3 -> Validation) - and folding it into
 * `destination-missing` would tell them their perfectly valid destination is not on the board.
 * Returned rather than thrown so the error envelope stays in the route, where the rest of this API's
 * refusals are built.
 */
export type PlacementOutcome =
  | { outcome: 'written'; postIt: PostIt }
  | { outcome: 'missing' }
  | { outcome: 'discarded' }
  | { outcome: 'destination-missing' };

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
  /**
   * One Board's Post-its, oldest first - the order `post_it_by_round` already carries.
   *
   * The Session read never uses this; it asks `listForSession` once for every Board at once. This
   * exists for the Display Link resolution route, which is scoped to one Round and must read
   * exactly that. On confApp's only anonymous route "scoped" is an acceptance property, so the
   * narrowing is the statement's own predicate rather than a filter applied to a wider result
   * (S04, FR7 -> NFR).
   */
  listForRound(conferenceId: string, roundId: string): Promise<PostIt[]>;
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
  /**
   * Where a Post-it sits on its Board: a Category of **this** Round, or `null` for Uncategorised.
   *
   * **No `sub` parameter, and that is the point.** Placement is not attributed to anybody: there is
   * no actor column on `post_it` for one to reach and no argument here one could arrive through, so
   * "the actor is the credential" is a property of the seam rather than a rule the route remembers
   * (Binding Constraint FR6). Who *may* place is the route's question and is answered by the
   * sorting-authority gate before this is called.
   */
  place(
    conferenceId: string,
    sessionId: string,
    roundId: string,
    postItId: string,
    categoryId: string | null,
  ): Promise<PlacementOutcome>;
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
  'p.category_id',
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
    categoryId: row.category_id,
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

  /**
   * Why a placement matched nothing, asked once and only after it did.
   *
   * A *diagnosis*, never a pre-check, exactly as `diagnose` above is: the write has already failed
   * to match by the time this runs, so nothing it reads can change what was written. Two conditions
   * can have refused it and they are two different sentences - the Post-it is not on this Board, or
   * the destination Category is not. Asking which afterwards is what keeps both out of the
   * statement's own predicate as separate round trips.
   *
   * The destination is deliberately not re-read here. If the Post-it is on the Board and carries no
   * Discard, the only other conjunct that could have refused is the destination - and re-reading it
   * would only be able to disagree with the snapshot the write already took.
   *
   * **This is the second of the placement path's two refusal sites, and it moves with the first.**
   * Before S05 it answered `destination-missing` for *every* case in which the `post_it` row was
   * found, which was exact while identity and destination were the only conjuncts. Adding the
   * not-discarded conjunct to the write without adding this branch would make a discarded Post-it
   * match no rows while this SELECT still found it, and the Facilitator would be told "that category
   * is not on this board" about a destination that was perfectly valid. The two sites are one rule
   * and are changed together; the test that names the discarded case explicitly is what holds them
   * together, because neither `tsc` nor the structure guards can.
   */
  async function diagnosePlacement(
    conferenceId: string,
    sessionId: string,
    roundId: string,
    postItId: string,
  ): Promise<PlacementOutcome> {
    const rows = await db.query<{ discarded: boolean }>(
      `select not (${NOT_DISCARDED}) as discarded
         from post_it p
         join round r on r.id = p.round_id
        where p.id = $4 and p.round_id = $3 and p.conference_id = $1
          and r.session_id = $2 and r.kind = 'PostItRound'`,
      [conferenceId, sessionId, roundId, postItId],
    );
    const row = rows[0];
    if (row === undefined) return { outcome: 'missing' };
    return row.discarded ? { outcome: 'discarded' } : { outcome: 'destination-missing' };
  }

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

  /**
   * Runs the placement write, and treats the destination Category vanishing underneath it as "no
   * rows" rather than as an error.
   *
   * SQLSTATE 23503 on `post_it_placed_on_its_own_round` means exactly one thing here: the Category
   * was on this Board when the statement's predicate was evaluated and gone by the time the
   * constraint was checked - an Organizer removing a Category while a Facilitator sorts into it,
   * which is an ordinary race in a room with two devices in it. Routing it to no rows lets the
   * diagnosis above produce the sentence that is true either way; the alternative was an unmapped
   * 23503 reaching the error handler as `INTERNAL_ERROR`, which tells a Facilitator the API broke.
   *
   * **Matched on the constraint name, not on the SQLSTATE alone.** Other rules in this schema raise
   * 23503 and mean different things - the Round disappearing, for one - and matching the class while
   * guessing the rule is how a refusal comes to name the wrong thing.
   */
  async function placeOrDiagnose<T>(write: () => Promise<T[]>): Promise<T[]> {
    try {
      return await write();
    } catch (error) {
      const violation = (error ?? {}) as { code?: unknown; constraint?: unknown };
      if (
        violation.code === '23503' &&
        violation.constraint === 'post_it_placed_on_its_own_round'
      ) {
        return [];
      }
      throw error;
    }
  }

  /** The one row a write produced, with its author's name joined on. */
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
      /*
       * **A discarded Post-it is not on this Board, for anybody** - including its own author, who
       * finds it simply absent with no marker and no notification (S05 FR4). The exclusion is the
       * statement's own anti-join and not a filter applied afterwards, so the counts the Board
       * projection computes are counts of what is actually there: a handler that dropped rows after
       * reading them would have to be repeated on every surface, and the first one to forget would
       * put a discarded idea back in front of the room.
       *
       * `NOT_DISCARDED` is the single definition, shared with `listForRound` below and with the
       * placement predicate that refuses to move one (`post-it-discard-repository.ts`).
       */
      const rows = await db.query<PostItRow>(
        `select ${COLUMNS}
           from post_it p
           join app_user u on u.sub = p.author_sub
           join round r on r.id = p.round_id
          where p.conference_id = $1 and r.session_id = $2
            and ${NOT_DISCARDED}
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

    async listForRound(conferenceId: string, roundId: string): Promise<PostIt[]> {
      // Same projection and same order as the Session-wide read above - including the
      // `app_user` join that supplies the author's display name, which is what the room reads, and
      // the Discard exclusion, which is why a discarded Post-it is absent from the projected screen
      // as well as from every phone (S05 TI05; S07 consumes this rather than filtering again).
      const rows = await db.query<PostItRow>(
        `select ${COLUMNS}
           from post_it p
           join app_user u on u.sub = p.author_sub
          where p.conference_id = $1 and p.round_id = $2
            and ${NOT_DISCARDED}
          order by p.created_at, p.id`,
        [conferenceId, roundId],
      );
      return rows.map(toPostIt);
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
       * *is* the write.
       *
       * **There is deliberately no not-discarded condition here, and the omission is a decision
       * rather than an oversight** (owner, 2026-08-31; S05 review). `place` refuses a discarded
       * Post-it and `remove` does not, and `edit` follows `remove`: an author owns their own words
       * whether or not a Facilitator has set the Post-it aside, exactly as an author's deletion
       * already wins its race against a Discard. The consequence is accepted rather than hidden -
       * an author whose client read the Board before the Discard can still commit a correction, so
       * the text in the Facilitator's discarded list, and the text a restore puts back in front of
       * the room, can change under them. The alternative was refusing the edit for consistency with
       * `place`; author ownership was judged the stronger rule, since the Post-it is still the
       * author's and Discard is not deletion. Pinned by
       * `api/test/discard.integration.test.ts` ("lets the author correct a discarded post-it, and
       * the discarded list shows the new text"), which asserts all four halves: the edit returns
       * 200, the discarded list shows the new text, the Post-it is not restored, and no Board read
       * returns it.
       * The one-statement residual the module note sets out applies here too and is
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

    async place(
      conferenceId: string,
      sessionId: string,
      roundId: string,
      postItId: string,
      categoryId: string | null,
    ): Promise<PlacementOutcome> {
      /*
       * **One guarded statement, whose predicate is a flat conjunction of independently named
       * placement conditions.** That shape is the extension point this story owes its successors
       * (S03 -> Architecture Decision): a later refusal is one more conjunct appended here, with no
       * restructuring of the statement, no second guard site and no pre-check read. S05 appends the
       * not-discarded condition - an anti-join or `NOT EXISTS` against `post_it_discard`, consistent
       * with the read-exclusion mechanism it establishes. A discarded Post-it cannot be placed;
       * restore it first (FR3 -> Validation), and that rule lands here.
       *
       * **"Nothing else moves" is not quite true, and the exception is load-bearing.** The
       * predicate is one of *two* sites: `diagnosePlacement` decides which refusal a zero-row
       * result gets, and it answers `destination-missing` for **every** case in which the
       * `post_it` row is still found. Append the not-discarded conjunct here alone and a
       * discarded Post-it matches no rows while the diagnosis SELECT still finds it, so the
       * caller is refused with `CATEGORY_NOT_FOUND` - "that category is not on this board" - about
       * a destination that was perfectly valid. `PlacementOutcome` also carries no member for the
       * discarded case, so S05 widens the union as well. Neither `tsc`, `eslint` nor the structure
       * guards catch this: the structure test asserts only the predicate's conjuncts.
       *
       * The three conditions in force today:
       *
       *   - **identity** - this Post-it, on this Round, of this Session, in this Conference;
       *   - **the destination is a Category of this Round's own Board** - checked in the statement
       *     rather than by a read taken first, so two replicas cannot each pass it. The composite
       *     foreign key `post_it_placed_on_its_own_round` is the guarantee underneath, and a
       *     destination deleted between this statement's snapshot and its constraint check is
       *     caught below rather than surfacing as an internal error;
       *   - **the Post-it is still placeable** - which since S05 means it carries no Discard trace.
       *     `NOT_DISCARDED` is the *same* fragment every Board read excludes through
       *     (`post-it-discard-repository.ts`), so "invisible" and "unplaceable" cannot drift apart:
       *     a Post-it that is off the Board cannot be moved on it, and a Facilitator working from a
       *     Board read taken a moment before the Discard is refused by this predicate rather than by
       *     a read taken first. Without it a Post-it could be placed while invisible and a later
       *     restore would hand it back to that Category - which FR4 and OC02 forbid.
       *
       * **Deliberately absent, and each absence is a rule.** No author condition: sorting is not
       * the author's write, and a Facilitator places other people's ideas. No Round-state
       * condition: placement is permitted while the Round is open, after it closes, and after a
       * reopen (FR3), so there is nothing to compare `r.state` against. No version predicate:
       * concurrent placements are **last write wins per Post-it with no conflict UI**
       * (`prd.md#edge-cases`), so optimistic concurrency is the wrong tool here even though
       * `docs/LEARNINGS.md#concurrency` is right about where it would belong if it were needed.
       *
       * **And no "currently somewhere else" condition**, which is the trap this write is easiest to
       * get wrong. A statement conditioned on the Post-it not already being in the destination
       * matches zero rows on a repeat - indistinguishable from "the Post-it is gone" - where FR3
       * says the repeat **succeeds**. The row is written either way; the requested end state is the
       * one that holds.
       *
       * The `AFTER UPDATE` trigger on this table advances the Round's activity watermark, so a
       * placement reaches every open Board on the next tick of the one shared poll. There is no
       * second cursor and no trigger of this story's own.
       */
      const placed = await placeOrDiagnose(() =>
        db.query<{ id: string }>(
          `update post_it p
              set category_id = $5::uuid
             from round r
            where p.id = $4 and p.round_id = $3 and p.conference_id = $1
              and r.id = p.round_id and r.session_id = $2 and r.kind = 'PostItRound'
              and ($5::uuid is null
                   or exists (select 1 from category c
                               where c.id = $5::uuid and c.round_id = p.round_id))
              and ${NOT_DISCARDED}
           returning p.id`,
          [conferenceId, sessionId, roundId, postItId, categoryId],
        ),
      );

      const row = placed[0];
      if (row === undefined) {
        return diagnosePlacement(conferenceId, sessionId, roundId, postItId);
      }

      const postIt = await hydrate(row.id);
      /*
       * Placed, and gone before it could be read back - its author removed it from another device
       * between the two statements. `missing` is the honest answer and the route already has the
       * sentence for it: the Post-it is not where the caller thinks it is, which is what the Board
       * re-read the surface makes next will find anyway.
       */
      if (postIt === null) return { outcome: 'missing' };
      return { outcome: 'written', postIt };
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
 *
 * **Neither is a Discard, and that is a decision rather than an omission (S05 TI07, FR4).** A
 * Facilitator's Discard takes a Post-it off every Board and leaves its text, its author and its
 * attribution entirely intact, restorable until the Conference is archived - so a Session whose only
 * Post-it is discarded still holds a named colleague's contribution, and deleting the Session would
 * destroy something recoverable with no way back. It therefore still counts and still refuses the
 * deletion.
 *
 * **A Permanent Removal is the counter-case, and it needs no condition here (S06 TI06, FR5).** An
 * Admin's permanent removal takes the `post_it` row itself, so the count falls because there is
 * nothing left to count - the Session that held one permanently removed Post-it becomes deletable
 * again, while the Session that held one merely discarded still refuses. Two opposite answers from
 * one unconditional count, which is precisely why neither act is named in this statement: adding a
 * state condition for either would be a second definition of "still holds something worth
 * protecting". Both halves are pinned by test (`permanent-removal.integration.test.ts`).
 *
 * The delivery record chose the **opposite** for a withdrawn submission
 * (`db/migrations/20260901090000000_post-it-delivery-record.sql` -> "Not a contribution"), and the
 * two are the same rule applied to different facts: there the `post_it` row is already gone and
 * nothing remains to protect, here the row is still there in full. Pinned by test so a later state
 * condition cannot be added silently.
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
