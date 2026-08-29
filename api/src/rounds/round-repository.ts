import type { Database, Queryable } from '../db.ts';
import { instantExpression } from '../sessions/wall-clock-time.ts';
import type { RoundDetails, RoundKind, RoundPurpose, RoundState } from './round-validation.ts';

/**
 * The `round` and `round_option` tables, behind one seam.
 *
 * Three properties are load-bearing and none of them is a convention a caller has to remember:
 *
 *   - **Every state guard lives in the write statement.** The reopen rule is a predicate on the
 *     UPDATE that opens a Round, not a read followed by a write in the route: a Poll whose
 *     `closed_at` is set simply does not match, so there is no window between deciding and doing.
 *   - **A Poll and its options are written in one transaction**, so a Poll can never be persisted
 *     without the options its ballots will point at.
 *   - **No row-version expression appears in the projection**, because this story adds no such
 *     column. `round.activity_watermark` and its triggers are S02's
 *     (`plan.json#sharedDecisions` -> "Near-live propagation: one cursor"), and a second cursor of
 *     identical semantics is what that decision removed.
 *
 * Nothing is retained between calls. Round state is read from the database on every request – the
 * API runs as several container replicas with no request affinity (ADR-004), so a cached Round
 * list would be wrong on the next replica even if it were fresh on this one.
 */

export interface RoundOption {
  id: string;
  position: number;
  label: string;
}

export interface Round {
  id: string;
  conferenceId: string;
  sessionId: string;
  kind: RoundKind;
  /** Present exactly when the kind is `VotingRound` – the table constrains it, not a convention. */
  purpose: RoundPurpose | null;
  /** The Post-it Round's prompt, or the Poll's question. */
  prompt: string;
  state: RoundState;
  position: number;
  /**
   * When this Round last stopped running, or `null` if it never has.
   *
   * Internal to the API: it is what tells "created closed" apart from "already run", and it is
   * deliberately **not** on the wire. The Session payload carries no timestamp for the Round set,
   * because a client that found one there would poll it as a cursor – the second cursor
   * `plan.json#sharedDecisions` withdrew (S01 TI07).
   */
  closedAt: string | null;
  /** Empty for a Post-it Round; the Poll's options in authored order. */
  options: RoundOption[];
}

interface RoundRow {
  id: string;
  conference_id: string;
  session_id: string;
  kind: string;
  purpose: string | null;
  prompt: string;
  state: string;
  position: number;
  closed_at: string | null;
}

interface OptionRow {
  id: string;
  round_id: string;
  position: number;
  label: string;
}

/**
 * Every read goes through the same projection, so no caller can invent a different shape.
 *
 * Note what is absent: any row-version or watermark expression. See the module note.
 */
const COLUMNS = [
  'id',
  'conference_id',
  'session_id',
  'kind',
  'purpose',
  'prompt',
  'state',
  'position',
  instantExpression('closed_at', 'closed_at'),
].join(', ');

const OPTION_COLUMNS = 'id, round_id, position, label';

function toRound(row: RoundRow, options: RoundOption[]): Round {
  return {
    id: row.id,
    conferenceId: row.conference_id,
    sessionId: row.session_id,
    // The check constraints make any other value unreachable, so a surprise here is a fault in the
    // schema or the mapping rather than anything the caller did – never a refusal.
    kind: row.kind as RoundKind,
    purpose: row.purpose as RoundPurpose | null,
    prompt: row.prompt,
    state: row.state as RoundState,
    position: row.position,
    closedAt: row.closed_at,
    options,
  };
}

function toOption(row: OptionRow): RoundOption {
  return { id: row.id, position: row.position, label: row.label };
}

/**
 * What an open/close attempt did.
 *
 * `not-permitted` is kept apart from `missing` because they are two different sentences: one names
 * the rule that refused (a Poll that has run cannot run again), the other says the Round is gone.
 * Returning a result rather than throwing keeps the error envelope in the route, where the rest of
 * this API's refusals are built.
 */
export type TransitionResult =
  | { outcome: 'changed'; round: Round }
  | { outcome: 'not-permitted'; round: Round }
  | { outcome: 'missing' };

export interface RoundRepository {
  /** One Session's Rounds in authored order, each with its options in position order. */
  listForSession(conferenceId: string, sessionId: string): Promise<Round[]>;
  findById(conferenceId: string, sessionId: string, roundId: string): Promise<Round | null>;
  create(conferenceId: string, sessionId: string, details: RoundDetails): Promise<Round>;
  /**
   * Edits the prompt or question and, for a Poll, replaces the option set.
   *
   * Whether the edit is *permitted* is decided by `assertNotFrozen`, which is the caller's single
   * rule – a Post-it Round's prompt is always editable, a Poll's content freezes once a Vote
   * exists, and that rule lives in `ballot-gate.ts` and nowhere else. It is passed in rather than
   * applied first **because it has to run inside this transaction**, after the Round row is locked:
   * asked before, a Vote landing between the answer and the write would let the edit through after
   * the freeze should have applied (S03 TI08, `poll-freeze-toctou-discharge`).
   */
  updateContent(
    conferenceId: string,
    sessionId: string,
    roundId: string,
    details: RoundDetails,
    assertNotFrozen: (round: Round, tx: Queryable) => Promise<void>,
  ): Promise<Round | null>;
  /** Opens a Round, refusing a Poll that has already run. The rule is the statement's predicate. */
  open(conferenceId: string, sessionId: string, roundId: string): Promise<TransitionResult>;
  close(conferenceId: string, sessionId: string, roundId: string): Promise<TransitionResult>;
  /**
   * The Session's activity cursor: the highest `activity_watermark` across its Rounds, or `null`
   * where it has none (S02 TI07).
   *
   * **An opaque counter, not an instant.** It is `nextval` of one global sequence
   * (`db/migrations/20260829120000000_activity-watermark-counter.sql`) and is returned as the
   * decimal digits PostgreSQL holds - it never passes through `instantExpression`, and a caller
   * that formatted, parsed or diffed it as a time would be reading something that is not there.
   * A timestamp here told every Conference Member the instant of every write on the Session.
   *
   * **And a Vote is not one of the writes it moves on** (ADR-007,
   * `db/migrations/20260831090000000_vote-advances-no-cursor.sql`). This query is scoped to a
   * single Session, so on a Session running only a Poll nothing but a ballot could have moved the
   * value - and the endpoint serving it is gated on Membership, which every Attendee refused the
   * running tally already holds. Making the value opaque addressed what it says; dropping the
   * ballot trigger addressed when it moves. What is left is the honest cursor: *something a
   * Member is entitled to see has changed*.
   *
   * One scalar for the whole Session, because that is all a poll needs to decide whether to
   * refetch. It is deliberately **not** on `Round` and not in the projection above: a per-Round
   * cursor on the wire is one a client would poll per Round, and the bundle has exactly one
   * (`plan.json#sharedDecisions` -> "Near-live propagation: one cursor").
   *
   * A maximum rather than a sum or a count: it moves on any Round, Post-it or Round-option write -
   * insert, update and delete alike, because the triggers fire on all three - and a delete is
   * precisely the change that leaves no row behind to notice. `bigint` arrives from
   * `node-postgres` as a string already; the cast says so rather than relying on it.
   */
  activityWatermark(conferenceId: string, sessionId: string): Promise<string | null>;
}

export function createRoundRepository(db: Database): RoundRepository {
  async function optionsFor(
    tx: Queryable,
    roundIds: readonly string[],
  ): Promise<Map<string, RoundOption[]>> {
    const byRound = new Map<string, RoundOption[]>(roundIds.map((id) => [id, []]));
    if (roundIds.length === 0) return byRound;

    // One statement for the whole Session, not one per Round: a handler looping per Round is the
    // N+1 this project has already been bitten by (docs/LEARNINGS.md#testing).
    const rows = await tx.query<OptionRow>(
      `select ${OPTION_COLUMNS} from round_option where round_id = any($1::uuid[]) order by position, id`,
      [roundIds],
    );
    for (const row of rows) byRound.get(row.round_id)?.push(toOption(row));
    return byRound;
  }

  async function hydrate(tx: Queryable, rows: readonly RoundRow[]): Promise<Round[]> {
    const options = await optionsFor(
      tx,
      rows.map((row) => row.id),
    );
    return rows.map((row) => toRound(row, options.get(row.id) ?? []));
  }

  /** The one row an operation acted on, hydrated with its options. */
  async function hydrateOne(tx: Queryable, row: RoundRow | undefined): Promise<Round | null> {
    if (row === undefined) return null;
    const [round] = await hydrate(tx, [row]);
    return round ?? null;
  }

  async function readOne(
    tx: Queryable,
    conferenceId: string,
    sessionId: string,
    roundId: string,
  ): Promise<Round | null> {
    const rows = await tx.query<RoundRow>(
      `select ${COLUMNS} from round where id = $3 and session_id = $2 and conference_id = $1`,
      [conferenceId, sessionId, roundId],
    );
    return hydrateOne(tx, rows[0]);
  }

  /**
   * A transition, and its whole outcome, decided by whether the guarded UPDATE matched.
   *
   * The guard is passed in as SQL because that is where it belongs: comparing in JavaScript and
   * writing afterwards is two statements with nothing holding between them, which is how two
   * concurrent opens both pass a check only one of them should.
   */
  async function transition(
    conferenceId: string,
    sessionId: string,
    roundId: string,
    assignments: string,
    guard: string,
  ): Promise<TransitionResult> {
    const rows = await db.query<RoundRow>(
      `update round set ${assignments}
        where id = $3 and session_id = $2 and conference_id = $1 and ${guard}
       returning ${COLUMNS}`,
      [conferenceId, sessionId, roundId],
    );

    const changed = await hydrateOne(db, rows[0]);
    if (changed !== null) return { outcome: 'changed', round: changed };

    // Nothing matched: either the guard refused it or the Round is not there. One further read
    // tells the caller which, and carries the Round the refusal is about.
    const current = await readOne(db, conferenceId, sessionId, roundId);
    return current === null ? { outcome: 'missing' } : { outcome: 'not-permitted', round: current };
  }

  return {
    async listForSession(conferenceId: string, sessionId: string): Promise<Round[]> {
      const rows = await db.query<RoundRow>(
        `select ${COLUMNS} from round where conference_id = $1 and session_id = $2 order by position, id`,
        [conferenceId, sessionId],
      );
      return hydrate(db, rows);
    },

    async findById(
      conferenceId: string,
      sessionId: string,
      roundId: string,
    ): Promise<Round | null> {
      return readOne(db, conferenceId, sessionId, roundId);
    },

    async activityWatermark(conferenceId: string, sessionId: string): Promise<string | null> {
      const rows = await db.query<{ watermark: string | null }>(
        `select max(activity_watermark)::text as watermark
           from round where conference_id = $1 and session_id = $2`,
        [conferenceId, sessionId],
      );
      // `max()` over no rows is one row holding NULL, so a Session with no Round answers null
      // rather than nothing - which is the value a client stores and compares against next tick.
      return rows[0]?.watermark ?? null;
    },

    async create(conferenceId: string, sessionId: string, details: RoundDetails): Promise<Round> {
      /*
       * The Round and its options in one transaction, so a Poll can never be persisted without the
       * options its ballots will point at.
       *
       * The authored position comes from `max(position) + 1` in the same statement. Note what that
       * is **not**: under READ COMMITTED two concurrent creates can both read the same max and both
       * take it, and a transaction is not an exclusion. Two Rounds sharing a position is harmless
       * only because every read here orders by `position, id` - so the list order stays stable and
       * total rather than being whatever the plan produced. Making the position itself unique would
       * need a constraint and a retry, and reordering is not a stated need (FIS -> What We're NOT
       * Doing), so the tiebreaker is where this story stops.
       */
      return db.transaction<Round>(async (tx) => {
        const inserted = await tx.query<RoundRow>(
          `insert into round (conference_id, session_id, kind, purpose, prompt, position)
           values ($1, $2, $3, $4, $5,
                   (select coalesce(max(position) + 1, 0) from round where session_id = $2))
           returning ${COLUMNS}`,
          [conferenceId, sessionId, details.kind, details.purpose, details.prompt],
        );

        const row = inserted[0];
        if (row === undefined) throw new Error('The round insert returned no row.');

        await insertOptions(tx, row.id, details.options);

        const round = await hydrateOne(tx, row);
        if (round === null) throw new Error('The round insert returned no row.');
        return round;
      });
    },

    async updateContent(
      conferenceId: string,
      sessionId: string,
      roundId: string,
      details: RoundDetails,
      assertNotFrozen: (round: Round, tx: Queryable) => Promise<void>,
    ): Promise<Round | null> {
      return db.transaction<Round | null>(async (tx) => {
        /*
         * The Round row, locked, **before** the freeze rule is asked about it.
         *
         * `for update` is the whole of what closes S01's read-then-write: a Vote arriving now
         * blocks on this lock until the edit commits or rolls back, so the answer `assertNotFrozen`
         * gets is still true when the UPDATE below lands. Without it the check and the write are
         * two statements with a gap between them, and a Poll edited through that gap leaves a
         * closed tally answering a question it was never cast against
         * (`docs/LEARNINGS.md#concurrency`; S03 TI08, `poll-freeze-toctou-discharge`).
         *
         * Casting a Vote takes this same row lock first, in the same order
         * (`api/src/votes/vote-repository.ts#cast`), so the two serialise rather than deadlock -
         * and `db.transaction` carries the one SQLSTATE 40P01 retry this API has either way.
         */
        const locked = await tx.query<RoundRow>(
          `select ${COLUMNS} from round
            where id = $3 and session_id = $2 and conference_id = $1
            for update`,
          [conferenceId, sessionId, roundId],
        );

        const current = await hydrateOne(tx, locked[0]);
        if (current === null) return null;

        // Throws the caller's refusal, which rolls this transaction back and writes nothing.
        await assertNotFrozen(current, tx);

        /*
         * The prompt only. `kind` and `purpose` are not editable: a Post-it Round that became a
         * Poll would be a different Activity wearing the first one's identity, and any Post-it or
         * Vote already pointing at it would be pointing at something it never was.
         *
         * The state is untouched too, which is what keeps a Post-it Round open across an edit of
         * its prompt (FR1: the prompt stays editable *at any time*).
         */
        const rows = await tx.query<RoundRow>(
          `update round set prompt = $4
            where id = $3 and session_id = $2 and conference_id = $1
           returning ${COLUMNS}`,
          [conferenceId, sessionId, roundId, details.prompt],
        );

        const row = rows[0];
        if (row === undefined) return null;

        /*
         * Replaced rather than merged. An option list is one authored thing – a rename, an
         * addition and a reordering are all "these are the options now" – and reconciling it
         * label-by-label would need an identity for an option the Facilitator never gave one.
         * Safe precisely because this path is reachable only while no Vote exists: the guard above
         * has already refused otherwise *under the lock*, so no ballot can be pointing at a row
         * this deletes and none can arrive before the commit.
         */
        if (details.kind === 'VotingRound') {
          await tx.query('delete from round_option where round_id = $1', [roundId]);
          await insertOptions(tx, roundId, details.options);
        }

        return hydrateOne(tx, row);
      });
    },

    async open(
      conferenceId: string,
      sessionId: string,
      roundId: string,
    ): Promise<TransitionResult> {
      /*
       * The reopen rule, as the open statement's own predicate.
       *
       * A Voting Round that has been closed after running carries a `closed_at`, and does not match
       * – so "a poll cannot be reopened once its results are shown" is enforced by the write rather
       * than by a read the route makes first. A Post-it Round matches whatever its history, which
       * is what lets it run again and again; a Poll authored and never opened has no `closed_at`
       * and opens normally, because created-closed is not already-run.
       */
      return transition(
        conferenceId,
        sessionId,
        roundId,
        `state = 'open'`,
        `not (kind = 'VotingRound' and closed_at is not null)`,
      );
    },

    async close(
      conferenceId: string,
      sessionId: string,
      roundId: string,
    ): Promise<TransitionResult> {
      /*
       * `closed_at` is stamped only on a real open -> closed transition, so it means "when this
       * Round last stopped running" and nothing else. Stamping it unconditionally would let a
       * Facilitator who pressed Close on a Poll they had not opened yet lock it shut forever.
       *
       * `clock_timestamp()`, not `now()`: the latter is transaction-start time (docs/LEARNINGS.md
       * #postgresql-datetime-via-node-postgres).
       */
      return transition(
        conferenceId,
        sessionId,
        roundId,
        `state = 'closed',
         closed_at = case when state = 'open' then clock_timestamp() else closed_at end`,
        'true',
      );
    },
  };
}

/** The options of one Round, in the order they were given. Shared by create and replace. */
async function insertOptions(
  tx: Queryable,
  roundId: string,
  labels: readonly string[],
): Promise<void> {
  if (labels.length === 0) return;
  await tx.query(
    `insert into round_option (round_id, position, label)
     select $1, ordinality - 1, label
       from unnest($2::text[]) with ordinality as t(label, ordinality)`,
    [roundId, labels],
  );
}

/**
 * Locks every Round of one Session against new contributions, for the caller's transaction (S05).
 *
 * Exported, and taking a `Queryable`, so the Session-deletion transaction can hold these rows
 * without reaching into the `round` table itself – the same seam
 * `session-repository.ts#sessionExistsInConference` opens in the other direction, and what keeps
 * the round tables owned by this module (`api/test/round-structure.test.ts`).
 *
 * **`for update`, and not `for no key update`.** A contribution insert takes `FOR KEY SHARE` on
 * its Round row to satisfy its foreign key. `FOR UPDATE` conflicts with `FOR KEY SHARE` and blocks
 * it; `FOR NO KEY UPDATE` does not, and would leave the window open while looking like a lock.
 * That window is the one S05's race scenarios name: a Post-it committing after the deletion guard
 * has counted, and vanishing into the cascade.
 *
 * Ordered by `id` so two transactions locking the same Session's Rounds take them in the same
 * order rather than in whatever order the plan produced.
 */
export async function lockRoundsOfSession(
  tx: Queryable,
  conferenceId: string,
  sessionId: string,
): Promise<void> {
  await tx.query(
    'select id from round where conference_id = $1 and session_id = $2 order by id for update',
    [conferenceId, sessionId],
  );
}
