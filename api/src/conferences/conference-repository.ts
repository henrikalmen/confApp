import type { Database, Queryable } from '../db.ts';
import type { CalendarDate } from './calendar-date.ts';
import type { ConferenceDetails } from './conference-validation.ts';
import { instantExpression } from '../sessions/wall-clock-time.ts';
import { generateJoinCode, type JoinCodeMinter } from './join-code.ts';
import { isLifecycleState, type LifecycleState } from './lifecycle.ts';

/**
 * The `conference`, `membership` and `role_assignment` tables, behind one seam.
 *
 * Dates leave here as the 'YYYY-MM-DD' strings the columns hold – the driver is configured not to
 * coerce a `date` into a JS Date (api/src/db.ts), so nothing between the column and the wire
 * applies an offset.
 */

export interface Conference {
  id: string;
  name: string;
  startDate: CalendarDate;
  endDate: CalendarDate;
  lifecycleState: LifecycleState;
  createdBySub: string;
  /**
   * The Join Code, in its canonical uppercase form – `null` until the Conference is published.
   *
   * Present on the domain object because the join lookup and the Organizer's code panel both need
   * it, and deliberately **not** on the wire shape the Conference endpoints return: only the
   * dedicated code endpoint discloses it, so there is one authorized surface rather than a value
   * riding along on every read (`routes/join-code.ts`).
   */
  joinCode: string | null;
  /**
   * The Conference row's own version, and the base version S09 sends back with an edit. It moves
   * when *this row* is written and at no other time. S04's schedule watermark is a separate
   * column, deliberately named differently, and surfaces separately as `lastUpdatedAt`.
   */
  updatedAt: string;
}

/**
 * One Conference as the Attendee list sees it: the fields the picker renders, plus the timestamp
 * that decides the default.
 *
 * Deliberately not a `Conference`. It carries no `joinCode`, no `createdBySub` and no `updatedAt` –
 * an attendee has no use for any of them, and the narrower type is what stops the code from
 * reaching the picker at all. `joinedAt` never leaves the server: it orders the list and picks the
 * default, and the response names the default outright rather than making a client re-derive it.
 */
export interface AttendeeConference {
  id: string;
  name: string;
  startDate: CalendarDate;
  endDate: CalendarDate;
  lifecycleState: LifecycleState;
  joinedAt: string;
}

interface AttendeeConferenceRow {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  lifecycle_state: string;
  joined_at: Date;
}

interface ConferenceRow {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  lifecycle_state: string;
  created_by_sub: string;
  join_code: string | null;
  updated_at: string;
}

/**
 * Every read goes through the same column list, so no caller can invent a different shape.
 *
 * `updated_at` is formatted in SQL rather than in JavaScript, exactly as `session.last_updated_at`
 * is and for the same reason: it is the base version S09 compares an edit against, the driver's
 * `Date` holds only milliseconds, and a round trip through one would drop the last three digits –
 * collapsing two distinct versions into one and quietly reinstating last-write-wins for the two
 * saves most likely to land inside the same millisecond, the concurrent ones.
 */
function columnList(prefix = ''): string {
  return [
    `${prefix}id`,
    `${prefix}name`,
    `${prefix}start_date`,
    `${prefix}end_date`,
    `${prefix}lifecycle_state`,
    `${prefix}created_by_sub`,
    `${prefix}join_code`,
    instantExpression(`${prefix}updated_at`, 'updated_at'),
  ].join(', ');
}

const COLUMNS = columnList();

/** PostgreSQL's unique-violation SQLSTATE, and the constraint a minted code can collide with. */
const UNIQUE_VIOLATION = '23505';
const JOIN_CODE_UNIQUE = 'conference_join_code_unique';

function isJoinCodeCollision(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  return code === UNIQUE_VIOLATION && constraint === JOIN_CODE_UNIQUE;
}

function toConference(row: ConferenceRow): Conference {
  if (!isLifecycleState(row.lifecycle_state)) {
    // The database check constraint makes this unreachable, so it is a fault in the schema or
    // the mapping rather than anything the caller did – never a refusal.
    throw new Error(`conference ${row.id} holds unknown lifecycle state ${row.lifecycle_state}.`);
  }

  return {
    id: row.id,
    name: row.name,
    startDate: row.start_date,
    endDate: row.end_date,
    lifecycleState: row.lifecycle_state,
    createdBySub: row.created_by_sub,
    joinCode: row.join_code,
    updatedAt: row.updated_at,
  };
}

export interface ConferenceRepository {
  create(details: ConferenceDetails, createdBySub: string): Promise<Conference>;
  findById(conferenceId: string): Promise<Conference | null>;
  /**
   * The Conference holding this **canonical** code, in any lifecycle state.
   *
   * Unscoped by state on purpose: a code minted for a Conference that has since been archived must
   * resolve to *that* Conference so the refusal can name the real reason, rather than miss and
   * report the code as unknown (FR3 → Validation).
   */
  findByJoinCode(joinCode: string): Promise<Conference | null>;
  listForRoleHolder(sub: string): Promise<Conference[]>;
  /**
   * The **Attendee** list: the Conferences this `sub` has *joined* that are `published` or
   * `archived`, most recently joined first.
   *
   * A genuinely different result set from `listForRoleHolder`, not a filtered view of it, and that
   * is why the two endpoints stay separate (S03 TI06 records the split from its side). This one
   * joins through `membership`, so a draft nobody could have joined never appears – and a draft its
   * own Admin *is* a member of is excluded by the state predicate, because the attendee surface
   * shows only what has been published (FR4 → Validation). The Organizer reads their draft through
   * the composition view instead.
   */
  listJoinedAndReadable(sub: string): Promise<AttendeeConference[]>;
  updateDetails(conferenceId: string, details: ConferenceDetails): Promise<Conference>;
  updateLifecycleState(conferenceId: string, state: LifecycleState): Promise<Conference>;
  /** The draft → published transition, which is also where the Conference's code is minted. */
  publish(conferenceId: string): Promise<Conference>;
  /** A new code, replacing the old one, which is not retained anywhere. */
  regenerateJoinCode(conferenceId: string): Promise<Conference>;
  /**
   * Records that this `sub` is an Attendee of this Conference, idempotently.
   *
   * The Attendee role *is* Membership and needs no Role Assignment
   * (`docs/UBIQUITOUS_LANGUAGE.md`), so this writes exactly one row and no grant.
   */
  joinAsAttendee(conferenceId: string, sub: string): Promise<void>;
}

export function createConferenceRepository(
  db: Database,
  /**
   * How a code is produced. Injected with the real generator as its default so production wiring
   * says nothing about it, and so a test can pin the code it expects rather than reading it back.
   */
  mintJoinCode: JoinCodeMinter = generateJoinCode,
): ConferenceRepository {
  /**
   * Runs a write that assigns a freshly minted code, retrying on the uniqueness violation.
   *
   * The retry is what makes the database constraint – rather than a `select` for an existing code –
   * the authority on uniqueness. A read-then-insert check passes every test and still collides
   * under two concurrent publishes, because nothing holds between the two statements. Here the
   * collision is simply an outcome to draw again from: at ~7.3e8 codes it is a theoretical event,
   * so a handful of attempts is generous rather than a loop that could spin.
   */
  async function withMintedCode(
    conferenceId: string,
    sql: string,
    trailing: readonly unknown[] = [],
  ): Promise<Conference> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        const rows = await db.query<ConferenceRow>(sql, [
          conferenceId,
          mintJoinCode(),
          ...trailing,
        ]);
        const row = rows[0];
        if (row === undefined) {
          // Either the row is gone or it no longer matches the statement's guard – both mean it
          // changed under a request whose decision had already been made, never anything the
          // caller did wrong.
          throw new Error(`conference ${conferenceId} changed while its join code was being set.`);
        }
        return toConference(row);
      } catch (error) {
        if (!isJoinCodeCollision(error)) throw error;
      }
    }

    throw new Error(
      `Could not mint an unused join code for conference ${conferenceId} in 8 attempts.`,
    );
  }

  return {
    /**
     * Three rows, one transaction: the Conference, the creator's Membership, and the creator's
     * Admin Role Assignment.
     *
     * The Membership is not ceremony. Membership means "is in this conference" for every role
     * without exception, so a creator without one could never appear in their own member list,
     * be removed, leave once a second Admin exists (FR6), or open the attendee view of their own
     * Conference. Atomic because a Conference whose creator is not its Admin is a Conference
     * nobody can administer.
     *
     * Both child rows are keyed on the verified `sub`. Neither carries an email – addresses
     * change and are reissued (ADR-002).
     */
    async create(details: ConferenceDetails, createdBySub: string): Promise<Conference> {
      return db.transaction(async (tx: Queryable) => {
        const rows = await tx.query<ConferenceRow>(
          `insert into conference (name, start_date, end_date, lifecycle_state, created_by_sub)
           values ($1, $2, $3, 'draft', $4)
           returning ${COLUMNS}`,
          [details.name, details.startDate, details.endDate, createdBySub],
        );

        const row = rows[0];
        if (row === undefined) throw new Error('The conference insert returned no row.');

        await tx.query('insert into membership (conference_id, user_sub) values ($1, $2)', [
          row.id,
          createdBySub,
        ]);

        await tx.query(
          "insert into role_assignment (conference_id, user_sub, role) values ($1, $2, 'Admin')",
          [row.id, createdBySub],
        );

        return toConference(row);
      });
    },

    async findById(conferenceId: string): Promise<Conference | null> {
      const rows = await db.query<ConferenceRow>(
        `select ${COLUMNS} from conference where id = $1`,
        [conferenceId],
      );
      const row = rows[0];
      return row === undefined ? null : toConference(row);
    },

    async findByJoinCode(joinCode: string): Promise<Conference | null> {
      // An equality match against the canonical stored form – no `lower(...)`, no `ilike`. Case is
      // absorbed by normalizing the submitted value before it gets here, which keeps the comparison
      // index-friendly and keeps case-insensitivity in one place rather than in every query.
      const rows = await db.query<ConferenceRow>(
        `select ${COLUMNS} from conference where join_code = $1`,
        [joinCode],
      );
      const row = rows[0];
      return row === undefined ? null : toConference(row);
    },

    /**
     * The Organizer list: the Conferences this `sub` holds a Role Assignment for, **including
     * drafts**. A draft is visible only to holders of a role in it (FR1), which is exactly what
     * joining through `role_assignment` expresses – someone else's draft is not omitted by a
     * filter that could be forgotten, it simply never joins.
     *
     * The Attendee list is a different result set and a different endpoint (`GET /me/conferences`,
     * S06). These are two intended endpoints, not one overloaded one.
     */
    async listForRoleHolder(sub: string): Promise<Conference[]> {
      const rows = await db.query<ConferenceRow>(
        `select distinct ${columnList('c.')}
         from conference c
         join role_assignment r on r.conference_id = c.id
         where r.user_sub = $1
         order by c.start_date desc, c.name`,
        [sub],
      );
      return rows.map(toConference);
    },

    /**
     * The Attendee list, most recently joined first.
     *
     * `joined_at` is S03's column on `membership` – already there, already defaulted, already
     * indexed by the unique constraint – so this story adds no migration for it. The tie-break on
     * `c.id` is not decoration: `joined_at` defaults to `now()`, which is *transaction*-start time,
     * so two Memberships written inside one transaction carry the identical stamp and an untied
     * ORDER BY would pick a different default on different reads of the same data.
     */
    async listJoinedAndReadable(sub: string): Promise<AttendeeConference[]> {
      const rows = await db.query<AttendeeConferenceRow>(
        `select c.id, c.name, c.start_date, c.end_date, c.lifecycle_state, m.joined_at
           from conference c
           join membership m on m.conference_id = c.id
          where m.user_sub = $1
            and c.lifecycle_state in ('published', 'archived')
          order by m.joined_at desc, c.id`,
        [sub],
      );

      return rows.map((row) => {
        if (!isLifecycleState(row.lifecycle_state)) {
          throw new Error(`conference ${row.id} holds unknown lifecycle state.`);
        }
        return {
          id: row.id,
          name: row.name,
          startDate: row.start_date,
          endDate: row.end_date,
          lifecycleState: row.lifecycle_state,
          joinedAt: row.joined_at.toISOString(),
        };
      });
    },

    /** A write to the Conference row, so `updated_at` moves with it. */
    async updateDetails(conferenceId: string, details: ConferenceDetails): Promise<Conference> {
      const rows = await db.query<ConferenceRow>(
        `update conference
            set name = $2, start_date = $3, end_date = $4, updated_at = now()
          where id = $1
         returning ${COLUMNS}`,
        [conferenceId, details.name, details.startDate, details.endDate],
      );

      const row = rows[0];
      if (row === undefined) throw new Error(`conference ${conferenceId} vanished mid-update.`);
      return toConference(row);
    },

    /**
     * Also a write to the Conference row, so `updated_at` moves here too. Only a Session write
     * must leave it alone, and Sessions are S04's – this column is never touched from there.
     */
    async updateLifecycleState(conferenceId: string, state: LifecycleState): Promise<Conference> {
      const rows = await db.query<ConferenceRow>(
        `update conference
            set lifecycle_state = $2, updated_at = now()
          where id = $1
         returning ${COLUMNS}`,
        [conferenceId, state],
      );

      const row = rows[0];
      if (row === undefined) throw new Error(`conference ${conferenceId} vanished mid-transition.`);
      return toConference(row);
    },

    /**
     * Publishing, which is where a Conference gets its code.
     *
     * The transition and the minting are one statement, so a published Conference without a code is
     * not a state this schema can be left in – not by a crash between two writes and not by a later
     * story adding a publish path that forgets the second one.
     *
     * The `lifecycle_state = 'draft'` predicate is a guard, not the rule: `assertPublishable` has
     * already refused a republish with both states named, and this keeps a concurrent second publish
     * from minting a *new* code over an existing one (which would silently invalidate a code already
     * on a slide). A no-op update surfaces as a vanished row and is reported as a fault, because by
     * the time this runs the transition has been decided.
     */
    async publish(conferenceId: string): Promise<Conference> {
      return withMintedCode(
        conferenceId,
        `update conference
            set lifecycle_state = 'published', join_code = $2, updated_at = now()
          where id = $1 and lifecycle_state = 'draft'
         returning ${COLUMNS}`,
      );
    },

    /**
     * A new code for a Conference that already has one.
     *
     * The previous code is overwritten rather than kept in a history table: it must be refused
     * exactly like an unknown code from the next request onwards (FR3), and a row that still held it
     * is a row some later lookup could match. Nothing else on the Conference changes, so every
     * existing Membership is untouched by construction – there is no delete in this statement.
     *
     * `updated_at` moves because this is a write to the Conference row, which is the whole rule for
     * that column (`plan.json` → sharedDecisions → "three fields, four consumers", field 3). The
     * schedule watermark does not, and cannot: S04's trigger fires only on the Conference's own
     * name, dates and lifecycle state, and a code is none of those.
     */
    async regenerateJoinCode(conferenceId: string): Promise<Conference> {
      return withMintedCode(
        conferenceId,
        `update conference
            set join_code = $2, updated_at = now()
          where id = $1
         returning ${COLUMNS}`,
      );
    },

    /**
     * One Membership row, or none if it is already there.
     *
     * `on conflict do nothing` against the `(conference_id, user_sub)` unique constraint S03
     * created is what makes re-entering a code a no-op rather than an error – and it makes it so for
     * *every* way a caller can already be a member, including the creator's seeded Membership and a
     * second request that arrives while the first is still in flight. A `select` for an existing row
     * followed by an `insert` would refuse the second of two concurrent joins with a constraint
     * violation the employee would read as "something went wrong".
     */
    async joinAsAttendee(conferenceId: string, sub: string): Promise<void> {
      await db.query(
        `insert into membership (conference_id, user_sub) values ($1, $2)
         on conflict (conference_id, user_sub) do nothing`,
        [conferenceId, sub],
      );
    },
  };
}
