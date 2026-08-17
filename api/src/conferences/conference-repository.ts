import type { Database, Queryable } from '../db.ts';
import type { CalendarDate } from './calendar-date.ts';
import type { ConferenceDetails } from './conference-validation.ts';
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
   * The Conference row's own version, and the base version S09 sends back with an edit. It moves
   * when *this row* is written and at no other time. S04's schedule watermark is a separate
   * column, deliberately named differently, and surfaces separately as `lastUpdatedAt`.
   */
  updatedAt: string;
}

interface ConferenceRow {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  lifecycle_state: string;
  created_by_sub: string;
  updated_at: Date;
}

/** Every read goes through the same column list, so no caller can invent a different shape. */
const COLUMNS = 'id, name, start_date, end_date, lifecycle_state, created_by_sub, updated_at';

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
    updatedAt: row.updated_at.toISOString(),
  };
}

export interface ConferenceRepository {
  create(details: ConferenceDetails, createdBySub: string): Promise<Conference>;
  findById(conferenceId: string): Promise<Conference | null>;
  listForRoleHolder(sub: string): Promise<Conference[]>;
  updateDetails(conferenceId: string, details: ConferenceDetails): Promise<Conference>;
  updateLifecycleState(conferenceId: string, state: LifecycleState): Promise<Conference>;
}

export function createConferenceRepository(db: Database): ConferenceRepository {
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
        `select distinct ${COLUMNS.split(', ')
          .map((column) => `c.${column}`)
          .join(', ')}
         from conference c
         join role_assignment r on r.conference_id = c.id
         where r.user_sub = $1
         order by c.start_date desc, c.name`,
        [sub],
      );
      return rows.map(toConference);
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
  };
}
