import type { Database, Queryable } from '../db.ts';

/**
 * The `category` table, behind one seam.
 *
 * Four properties are load-bearing, and none is a convention a caller has to remember:
 *
 *   - **Every guard lives in the write statement's own predicate.** "This Category is on a Post-it
 *     Round of this Session in this Conference" is a condition on the INSERT's source query and on
 *     the UPDATE's and DELETE's `where`, never a read the route makes first
 *     (`docs/LEARNINGS.md#concurrency`: the check *is* the write). The one-statement residual
 *     `post-it-repository.ts` sets out applies here too and is accepted for the same reasons.
 *   - **The 20-per-Board cap is storage, not arithmetic.** The create takes its position from
 *     `coalesce(max(position), 0) + 1` inside the INSERT's own source query, and the database
 *     refuses a 21st through `CHECK (position BETWEEN 1 AND 20)` and a concurrent duplicate through
 *     `UNIQUE (round_id, position)`. A `select count(*)` followed by an `insert` is precisely the
 *     check two container replicas both pass (ADR-004), which is the failure
 *     `prd.md#non-functional-requirements` names with "the cap cannot be raced past".
 *   - **This module owns its own transaction boundary, and that is not decoration.**
 *     `category_position_unique` is `DEFERRABLE INITIALLY DEFERRED`, so a losing create raises
 *     SQLSTATE 23505 **at COMMIT rather than at the failing statement**. An `insertOrDiagnose`-shaped
 *     wrapper around the statement alone would never see it, and the caller would read an unmapped
 *     internal error where the refusal that names the limit belongs. Every write below therefore
 *     runs inside `db.transaction` and is wrapped by `writeOnceThenRetry`, which catches the
 *     violation wherever it surfaces.
 *   - **Uncategorised is nowhere in this file.** It is the state of a Post-it having no placement
 *     (`post_it.category_id IS NULL`), never a row, an id or a reserved value
 *     (`prd.md#fr2-the-uncategorised-holding-area`). A destination of `null` on the removal below is
 *     that absence being written, not a sentinel being looked up - which is why no rename, reorder
 *     or remove path needs a special case for it: an id that names no Category row simply is not
 *     found.
 *
 * Nothing is retained between calls. The API runs as several container replicas with no request
 * affinity (ADR-004), so a cached Category list or count would be wrong on the next replica even if
 * it were fresh on this one. Every write also moves its Round's row through the
 * `category_advances_activity_watermark` trigger while a Facilitator may be updating that same row
 * directly; both go through `db.query` / `db.transaction`, whose existing SQLSTATE `40P01` retry is
 * the one deadlock policy this API has.
 */

export interface Category {
  id: string;
  roundId: string;
  name: string;
  /** The Facilitator's explicit order, 1-based and contiguous across the Board. */
  position: number;
}

interface CategoryRow {
  id: string;
  round_id: string;
  name: string;
  position: number;
}

/**
 * Where the Post-its of a Category being removed should go.
 *
 * `chosen: false` is the request that named no destination at all, which is the only thing that
 * makes an occupied Category's removal a refusal. `categoryId: null` is **Uncategorised** - the
 * absence of a placement, written as an absence - and is the destination the surface offers by
 * default (`prd.md#fr1-categories-on-a-board`).
 */
export type RemovalDestination = { chosen: false } | { chosen: true; categoryId: string | null };

/**
 * Why a guarded Category write matched nothing, or what it produced.
 *
 * Kept apart because each is a different sentence and a different next move: the Category is gone,
 * the Board is full, its Post-its need somewhere to go first, or the destination that was named is
 * not on this Board. Returned rather than thrown so the error envelope stays in the route, where the
 * rest of this API's refusals are built.
 *
 * `duplicateName` rides a **successful** write and is never a refusal. Two Categories on one Board
 * may share a name - names are labels and the Report groups by identity - so the Facilitator is
 * warned and the write stands (`prd.md#fr1-categories-on-a-board`).
 */
export type CategoryWriteOutcome =
  | { outcome: 'written'; category: Category; duplicateName: boolean }
  | { outcome: 'removed' }
  | { outcome: 'missing' }
  | { outcome: 'limit-reached'; count: number }
  | { outcome: 'holds-post-its'; count: number }
  | { outcome: 'destination-missing' };

export interface CategoryRepository {
  /**
   * Every Category on one Session's Rounds, keyed by Round id, in the Facilitator's order.
   *
   * One statement for the whole Session rather than one per Round or per Category: a handler
   * looping per Category is the N+1 the PRD's "one read per Board; no per-Category or per-Post-it
   * request" row rules out.
   */
  listForSession(conferenceId: string, sessionId: string): Promise<Map<string, Category[]>>;
  /**
   * One Board's Categories, in the Facilitator's order.
   *
   * The Session read never uses this - it asks `listForSession` once for every Board at once. This
   * exists for the Display Link resolution route, which is scoped to exactly one Round and must
   * read exactly that: a Session-wide read there would pull a sibling Round's Board into the
   * process on confApp's only anonymous route, where "scoped" is an acceptance property rather
   * than an efficiency one (S04, FR7 -> NFR).
   */
  listForRound(conferenceId: string, roundId: string): Promise<Category[]>;
  create(
    conferenceId: string,
    sessionId: string,
    roundId: string,
    name: string,
  ): Promise<CategoryWriteOutcome>;
  rename(
    conferenceId: string,
    sessionId: string,
    roundId: string,
    categoryId: string,
    name: string,
  ): Promise<CategoryWriteOutcome>;
  reorder(
    conferenceId: string,
    sessionId: string,
    roundId: string,
    categoryId: string,
    position: number,
  ): Promise<CategoryWriteOutcome>;
  remove(
    conferenceId: string,
    sessionId: string,
    roundId: string,
    categoryId: string,
    destination: RemovalDestination,
  ): Promise<CategoryWriteOutcome>;
}

/** One projection, so no caller can invent a different shape. */
const COLUMNS = 'c.id, c.round_id, c.name, c.position';

function toCategory(row: CategoryRow): Category {
  return { id: row.id, roundId: row.round_id, name: row.name, position: row.position };
}

function sqlState(error: unknown): { code?: string; constraint?: string } {
  return (error ?? {}) as { code?: string; constraint?: string };
}

/**
 * "This Category still holds Post-its", raised from **inside** the transaction so it rolls back.
 *
 * Thrown rather than returned, and that is the whole point. A removal moves the Post-its before it
 * deletes the row; if the delete is then refused, returning the outcome normally would commit the
 * relocation and answer 409 over the top of it - the Facilitator would read "this category holds 4
 * post-its" while those four had already been moved somewhere they never agreed to. `db.transaction`
 * rolls back on a throw and commits on a return, so the refusal has to leave by the door that
 * undoes the work.
 *
 * It carries the Category rather than a count: the count is read *after* the rollback, on the pool,
 * so the number the sentence names is the Board as it actually stands.
 */
class StillOccupied extends Error {
  /*
   * Declared and assigned, never a constructor parameter property. `api/test/join-attempt-probe.ts`
   * and `api/test/wall-clock-probe.ts` run this source in a fresh Node process under strip-only
   * type removal, which refuses `constructor(readonly x: string)` outright - so the shorthand takes
   * the whole API out of every out-of-process path, including `npm run dev:api`.
   */
  readonly categoryId: string;

  constructor(categoryId: string) {
    super('category still holds post-its');
    this.name = 'StillOccupied';
    this.categoryId = categoryId;
  }
}

/**
 * A named constraint refused this write.
 *
 * **Every check below matches on the constraint name and not on the SQLSTATE alone.** Two different
 * rules in this schema raise 23503 and two raise 23514, and they mean opposite things to the person
 * reading the refusal - "the round is gone" and "this category still holds post-its" are not
 * interchangeable sentences. Matching the class and guessing the rule is how a refusal comes to
 * name the wrong thing.
 */
function violated(error: unknown, code: string, constraint: string): boolean {
  return sqlState(error).code === code && sqlState(error).constraint === constraint;
}

/**
 * The deferred `UNIQUE (round_id, position)`, which arrives **at COMMIT**: another create took the
 * position this one computed while it was in flight.
 */
function isPositionConflict(error: unknown): boolean {
  return violated(error, '23505', 'category_position_unique');
}

/** `CHECK (position BETWEEN 1 AND 20)`, at the statement: there is no next position left. */
function isCapReached(error: unknown): boolean {
  return violated(error, '23514', 'category_position_within_cap');
}

/**
 * The destination named for a Category's Post-its was removed while this removal was in flight.
 *
 * The **only** placement violation this seam can still see. The delete carries the occupancy guard
 * in its own predicate (see `remove`), so a Post-it acquiring this placement mid-removal is answered
 * with the counted sentence rather than reaching the foreign key - which is what makes this one
 * unambiguously about the *destination*.
 */
function isVanishedDestination(error: unknown): boolean {
  return violated(error, '23503', 'post_it_placed_on_its_own_round');
}

/**
 * The Round disappeared between a statement's source read and its foreign-key check.
 *
 * The same ordinary race `post-it-repository.ts#insertOrDiagnose` absorbs - an Organizer deleting a
 * Session while a Facilitator sorts its Board - and the same answer: the Round is not there, which
 * is what the caller's next read will find anyway.
 */
function isVanishedRound(error: unknown): boolean {
  return violated(error, '23503', 'category_round_in_conference');
}

export function createCategoryRepository(db: Database): CategoryRepository {
  /** How many Post-its this Category is holding **now** - read at the moment of refusal. */
  async function heldBy(tx: Queryable, categoryId: string): Promise<number> {
    const rows = await tx.query<{ held: number }>(
      'select count(*)::int as held from post_it where category_id = $1',
      [categoryId],
    );
    return rows[0]?.held ?? 0;
  }

  /** How many Categories this Board holds **now** - read at the moment of refusal, never before. */
  async function countFor(roundId: string): Promise<number> {
    const rows = await db.query<{ held: number }>(
      'select count(*)::int as held from category where round_id = $1',
      [roundId],
    );
    return rows[0]?.held ?? 0;
  }

  /**
   * Does another Category on this Board already carry this name?
   *
   * Case- and whitespace-insensitive, because "Tooling" and " tooling " are the same label to a
   * room and the warning exists to stop two Categories nobody can tell apart. It is asked **after**
   * a successful write and about the row that write produced, so it can never turn into a refusal.
   */
  async function nameIsDuplicated(
    tx: Queryable,
    roundId: string,
    categoryId: string,
    name: string,
  ): Promise<boolean> {
    const rows = await tx.query<{ held: number }>(
      `select count(*)::int as held from category
        where round_id = $1 and id <> $2 and lower(btrim(name)) = lower(btrim($3))`,
      [roundId, categoryId, name],
    );
    return (rows[0]?.held ?? 0) > 0;
  }

  /**
   * Runs a Category write, and answers a lost race for a position by running it again.
   *
   * The retry is what makes the cap honest without an application-level count. A create that lost
   * the last free position recomputes `max(position) + 1` against the state the winner left, finds
   * there is no next position, and is refused by the CHECK with the count that refusal names read
   * fresh.
   *
   * **The terminal answer depends on which write asked**, which is why `creating` is a parameter
   * rather than an assumption. Only a *create* can be defeated by a full Board, so only a create
   * may be told so; answering "this board already holds 20 categories" to somebody who pressed
   * *Move down* would name a rule that had nothing to do with their press. A reorder and a removal
   * write the whole ordering under row locks, so a position conflict on either is unreachable by
   * construction - and an unreachable condition is better surfaced as the unexpected thing it is
   * than dressed up as a rule.
   *
   * Once, not in a loop: a second conflict means contention this layer cannot resolve, and further
   * retries would only bury it.
   */
  async function writeOnceThenRetry(
    work: (tx: Queryable) => Promise<CategoryWriteOutcome>,
    roundId: string,
    creating = false,
  ): Promise<CategoryWriteOutcome> {
    const terminal = async (error: unknown): Promise<CategoryWriteOutcome> => {
      // The transaction has rolled back by the time this runs, so the count is read on the pool
      // and describes the Board the Facilitator is about to be told about.
      if (error instanceof StillOccupied) {
        return { outcome: 'holds-post-its', count: await heldBy(db, error.categoryId) };
      }
      if (isVanishedRound(error)) return { outcome: 'missing' };
      if (isVanishedDestination(error)) return { outcome: 'destination-missing' };
      if (creating && (isPositionConflict(error) || isCapReached(error))) {
        return { outcome: 'limit-reached', count: await countFor(roundId) };
      }
      throw error;
    };

    try {
      return await db.transaction(work);
    } catch (first) {
      // A lost position race is the one condition worth running again. Everything else is answered
      // as it stands, so a genuine fault is never retried into a second fault.
      if (!isPositionConflict(first)) return terminal(first);

      try {
        return await db.transaction(work);
      } catch (second) {
        return terminal(second);
      }
    }
  }

  /**
   * This Board's Categories in order, read inside a write's own transaction.
   *
   * Scoped through the Round to the Session and the Conference, so it doubles as the existence
   * guard for both: a Round that is not this Session's, or is a Poll, yields no rows and every
   * caller answers `missing`.
   */
  async function orderingFor(
    tx: Queryable,
    conferenceId: string,
    sessionId: string,
    roundId: string,
  ): Promise<Category[]> {
    const rows = await tx.query<CategoryRow>(
      `select ${COLUMNS}
         from category c
         join round r on r.id = c.round_id
        where c.round_id = $3 and c.conference_id = $1 and r.session_id = $2
          and r.kind = 'PostItRound'
        order by c.position, c.id`,
      [conferenceId, sessionId, roundId],
    );
    return rows.map(toCategory);
  }

  /**
   * Writes one whole ordering, contiguously, in **one statement**.
   *
   * One statement and not one per Category, because `category_position_unique` is the constraint
   * that makes the cap unraceable and a per-row pass would collide with itself mid-renumber - row
   * two taking position one before row one has left it. Deferred to COMMIT, the pass is judged on
   * the ordering it produced.
   *
   * **Every row in the ordering is written, not only the ones whose position changed**, and that is
   * the mechanism behind "last write wins for the ordering as a whole" (`prd.md#edge-cases`).
   * Touching only the changed rows looks like a saving and is a per-Category merge: two concurrent
   * reorders whose changed sets do not overlap never block one another, and the Board settles on a
   * *composition* of the two moves that neither Facilitator asked for. Writing the whole ordering
   * makes the second pass wait on the first's row locks and then overwrite it entire, so what
   * settles is one Facilitator's intended order rather than a blend of two.
   *
   * **The ordinals are ranked over the rows that still exist, not over the array as handed in.**
   * The ordering this receives was read without a lock, so a rival removal may since have taken one
   * of the ids with it. Trusting the array's own `ordinality` then skips that id's number and leaves
   * a hole - and because `create` takes its position from `max(position) + 1`, a hole costs the
   * Board one of its twenty slots permanently. The `live` CTE locks this Round's Categories (by id,
   * so two renumbers take them in the same order) and the join drops any id that is already gone
   * before `row_number()` assigns anything, which is what makes the result contiguous rather than
   * merely intended to be.
   *
   * The lock is taken **here**, in the write, and deliberately not on the earlier ordering read: a
   * lock on the read would make the loser recompute from the winner's committed state and apply its
   * move on top, which is the *composition* of two reorders and the blend the paragraph above
   * exists to prevent. Locking at write time closes the hole and leaves that semantics untouched.
   */
  async function renumber(
    tx: Queryable,
    roundId: string,
    ordered: readonly string[],
  ): Promise<void> {
    if (ordered.length === 0) return;
    await tx.query(
      `with live as (
           select id
             from category
            where round_id = $1
            order by id
              for update
         ),
         ranked as (
           select ordered.id,
                  row_number() over (order by ordered.ord)::int as position
             from unnest($2::uuid[]) with ordinality as ordered(id, ord)
             join live on live.id = ordered.id
         )
       update category c
          set position = ranked.position
         from ranked
        where c.id = ranked.id and c.round_id = $1`,
      [roundId, ordered],
    );
  }

  return {
    async listForSession(
      conferenceId: string,
      sessionId: string,
    ): Promise<Map<string, Category[]>> {
      const rows = await db.query<CategoryRow>(
        `select ${COLUMNS}
           from category c
           join round r on r.id = c.round_id
          where c.conference_id = $1 and r.session_id = $2
          order by c.position, c.id`,
        [conferenceId, sessionId],
      );

      const byRound = new Map<string, Category[]>();
      for (const row of rows) {
        const category = toCategory(row);
        const existing = byRound.get(category.roundId);
        if (existing === undefined) byRound.set(category.roundId, [category]);
        else existing.push(category);
      }
      return byRound;
    },

    async listForRound(conferenceId: string, roundId: string): Promise<Category[]> {
      // Same projection and same order as the Session-wide read above, narrowed to one Round by
      // its own predicate rather than by filtering a wider result in memory.
      const rows = await db.query<CategoryRow>(
        `select ${COLUMNS}
           from category c
          where c.conference_id = $1 and c.round_id = $2
          order by c.position, c.id`,
        [conferenceId, roundId],
      );
      return rows.map(toCategory);
    },

    async create(
      conferenceId: string,
      sessionId: string,
      roundId: string,
      name: string,
    ): Promise<CategoryWriteOutcome> {
      return writeOnceThenRetry(
        async (tx) => {
          /*
           * Insert-from-select, so "the Round is a Post-it Round of this Session in this Conference"
           * is the INSERT's own source rather than a read taken before it, and the next position is
           * computed **inside** the statement that uses it. A Facilitator deleting the Round in the
           * same instant does not admit the Category: the select matches no row and nothing is
           * written.
           *
           * `r.kind` is compared here as well, and it has to be. The inserted `round_kind` comes from
           * the column's default, so on a Poll the source query would match, the composite foreign
           * key would refuse the write, and the caller would read a generic internal error instead of
           * "that round no longer exists on this session". The constraint stays the guarantee -
           * nothing but a Post-it Round can ever hold a Category - and this predicate is what keeps
           * the constraint out of the request path.
           *
           * No count is taken first. Position 21 is refused by `category_position_within_cap`, and a
           * concurrent create that took the same position is refused by `category_position_unique` at
           * COMMIT; `writeOnceThenRetry` turns either into the refusal that names the limit and the
           * count.
           */
          const rows = await tx.query<CategoryRow>(
            `insert into category (round_id, conference_id, name, position)
           select r.id, r.conference_id, $4,
                  coalesce((select max(existing.position) from category existing
                             where existing.round_id = r.id), 0) + 1
             from round r
            where r.id = $3 and r.session_id = $2 and r.conference_id = $1
              and r.kind = 'PostItRound'
           returning id, round_id, name, position`,
            [conferenceId, sessionId, roundId, name],
          );

          const row = rows[0];
          if (row === undefined) return { outcome: 'missing' };

          const category = toCategory(row);
          return {
            outcome: 'written',
            category,
            duplicateName: await nameIsDuplicated(tx, category.roundId, category.id, category.name),
          };
        },
        roundId,
        true,
      );
    },

    async rename(
      conferenceId: string,
      sessionId: string,
      roundId: string,
      categoryId: string,
      name: string,
    ): Promise<CategoryWriteOutcome> {
      return writeOnceThenRetry(async (tx) => {
        /*
         * Every guard in the UPDATE's own predicate, and `position` deliberately untouched:
         * renaming is cosmetic and moves nothing, not even the Category itself
         * (`prd.md#edge-cases`). Nothing here reads or writes `post_it`, which is what makes
         * "renaming moves no post-its" a property of the statement rather than a promise.
         */
        const rows = await tx.query<CategoryRow>(
          `update category c
              set name = $5
             from round r
            where c.id = $4 and c.round_id = $3 and c.conference_id = $1
              and r.id = c.round_id and r.session_id = $2 and r.kind = 'PostItRound'
           returning ${COLUMNS}`,
          [conferenceId, sessionId, roundId, categoryId, name],
        );

        const row = rows[0];
        if (row === undefined) return { outcome: 'missing' };

        const category = toCategory(row);
        return {
          outcome: 'written',
          category,
          duplicateName: await nameIsDuplicated(tx, category.roundId, category.id, category.name),
        };
      }, roundId);
    },

    async reorder(
      conferenceId: string,
      sessionId: string,
      roundId: string,
      categoryId: string,
      position: number,
    ): Promise<CategoryWriteOutcome> {
      return writeOnceThenRetry(async (tx) => {
        const ordering = await orderingFor(tx, conferenceId, sessionId, roundId);
        const from = ordering.findIndex((category) => category.id === categoryId);
        if (from === -1) return { outcome: 'missing' };

        /*
         * Clamped rather than refused. "A client-supplied position outside the current range is
         * clamped" is FR1's own validation rule: asking for position 99 on a Board of three means
         * "put it last", and answering that with an error would make the control harder to use than
         * the rule it enforces.
         */
        const to = Math.min(Math.max(Math.trunc(position), 1), ordering.length) - 1;

        const current = ordering.map((category) => category.id);
        const moved = [...current];
        const [target] = moved.splice(from, 1);
        moved.splice(to, 0, target!);

        /*
         * A move that changes nothing writes nothing.
         *
         * Not an optimisation: every row this would write fires the cursor trigger, so a reorder to
         * the position a Category already holds would tell every open Board in the room that
         * something had changed and hand them all a refetch that finds the same Board. Pressing a
         * control at the end of the order is the ordinary way to arrive here.
         */
        if (moved.every((id, index) => id === current[index])) {
          return { outcome: 'written', category: ordering[from]!, duplicateName: false };
        }

        await renumber(tx, roundId, moved);

        return {
          outcome: 'written',
          category: { ...ordering[from]!, position: to + 1 },
          duplicateName: false,
        };
      }, roundId);
    },

    async remove(
      conferenceId: string,
      sessionId: string,
      roundId: string,
      categoryId: string,
      destination: RemovalDestination,
    ): Promise<CategoryWriteOutcome> {
      return writeOnceThenRetry(async (tx) => {
        const ordering = await orderingFor(tx, conferenceId, sessionId, roundId);
        if (!ordering.some((category) => category.id === categoryId)) return { outcome: 'missing' };

        const count = await heldBy(tx, categoryId);

        /*
         * An occupied Category cannot go until somebody says where its Post-its land. Nothing is
         * written on this branch - the transaction has taken no write yet - so the refusal the
         * route builds is true of the stored Board, and the count it names is the count that was
         * there.
         *
         * The database says the same thing from the other side: `post_it_placed_on_its_own_round`
         * is `NO ACTION`, so a DELETE that skipped this step is refused by the foreign key rather
         * than orphaning a placement. This is the sentence; that is the guarantee.
         */
        if (count > 0 && !destination.chosen) return { outcome: 'holds-post-its', count };

        const target = destination.chosen ? destination.categoryId : null;
        /*
         * A destination has to be a Category on **this** Board and cannot be the Category being
         * removed. `null` needs no such check: it is Uncategorised, which is the absence of a
         * placement and is always available on every Board.
         */
        if (target !== null) {
          const valid = ordering.some(
            (category) => category.id === target && category.id !== categoryId,
          );
          if (!valid) return { outcome: 'destination-missing' };
        }

        if (count > 0) {
          await tx.query('update post_it set category_id = $2 where category_id = $1', [
            categoryId,
            target,
          ]);
        }

        /*
         * **The occupancy guard is a condition on the DELETE itself**, not the count taken above.
         * That count decides which *question* to put to the Facilitator; this decides whether the
         * row may go, and it is the only one of the two with no window after it. A Post-it placed
         * into this Category between the count and here is seen by this statement's own snapshot,
         * so it is refused with the counted sentence rather than reaching the foreign key and
         * surfacing as "that category is no longer on this round" - which would be the opposite of
         * true. The refusal leaves by a throw, so the placement update above goes back with it and
         * the sentence stays true of the stored Board.
         *
         * The `NO ACTION` foreign key is still the guarantee underneath, and is what a delete
         * issued through any other path meets.
         */
        const deleted = await tx.query<{ id: string }>(
          `delete from category c
            where c.id = $1 and c.round_id = $2
              and not exists (select 1 from post_it p where p.category_id = c.id)
           returning c.id`,
          [categoryId, roundId],
        );
        if (deleted[0] === undefined) {
          // Thrown, never returned: the placement update above is already in this transaction and
          // must go back with it. See `StillOccupied`.
          throw new StillOccupied(categoryId);
        }

        // Contiguous afterwards, in one statement, exactly as a reorder is: removing the second of
        // three leaves positions 1 and 3 without this.
        await renumber(
          tx,
          roundId,
          ordering.filter((category) => category.id !== categoryId).map((category) => category.id),
        );

        return { outcome: 'removed' };
      }, roundId);
    },
  };
}
