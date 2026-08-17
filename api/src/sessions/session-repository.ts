import type { Database, Queryable } from '../db.ts';
import type { CalendarDate } from '../conferences/calendar-date.ts';
import { AppError, ERROR_CODES } from '../errors.ts';
import type { SessionDetails, SessionKind } from './session-validation.ts';
import { instantExpression, wallClockExpression, type WallClockTime } from './wall-clock-time.ts';

/**
 * The `sessions` table, behind one seam.
 *
 * Two representations leave here and they are not the same kind of thing:
 *
 *   - `day`, `startTime` and `endTime` are **naive wall-clock values**. PostgreSQL is asked for
 *     them in their wire form (`to_char`), so they are strings before they reach JavaScript and
 *     nothing between the column and the response could apply an offset even by accident.
 *   - `lastUpdatedAt` is an **instant** – the row version S09 bases an optimistic-concurrency
 *     refusal on – serialized as ISO-8601 UTC with full microsecond precision. It is formatted in
 *     SQL rather than JS because the driver's `Date` holds only milliseconds and would quietly
 *     drop the last three digits of the value S09 compares.
 *
 * `last_updated_at` never appears in an INSERT or UPDATE column list here. A database trigger owns
 * it, which is what makes the monotonicity guarantee a property of the table rather than of every
 * write path remembering to stamp it.
 */

export interface Session {
  id: string;
  conferenceId: string;
  title: string;
  description: string | null;
  kind: SessionKind;
  day: CalendarDate;
  startTime: WallClockTime;
  endTime: WallClockTime;
  location: string;
  lastUpdatedAt: string;
}

interface SessionRow {
  id: string;
  conference_id: string;
  title: string;
  description: string | null;
  kind: string;
  day: string;
  start_time: string;
  end_time: string;
  location: string;
  last_updated_at: string;
}

/** Every read goes through the same projection, so no caller can invent a different shape. */
const COLUMNS = [
  'id',
  'conference_id',
  'title',
  'description',
  'kind',
  'day',
  wallClockExpression('start_time', 'start_time'),
  wallClockExpression('end_time', 'end_time'),
  'location',
  instantExpression('last_updated_at', 'last_updated_at'),
].join(', ');

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    conferenceId: row.conference_id,
    title: row.title,
    description: row.description,
    // The check constraint makes any other value unreachable, so a surprise here is a fault in
    // the schema or the mapping rather than anything the caller did – never a refusal.
    kind: row.kind as SessionKind,
    day: row.day,
    startTime: row.start_time,
    endTime: row.end_time,
    location: row.location,
    lastUpdatedAt: row.last_updated_at,
  };
}

function sessionNotFound(): AppError {
  return new AppError(
    ERROR_CODES.SESSION_NOT_FOUND,
    404,
    'That session no longer exists in this conference.',
  );
}

export interface SessionRepository {
  listForConference(conferenceId: string): Promise<Session[]>;
  /**
   * The Conference's whole-schedule watermark, as an ISO-8601 UTC instant.
   *
   * Read here rather than through the Conference repository because this story owns the column
   * and S03's `Conference` shape deliberately carries only `updated_at`, the Conference row's own
   * version. Putting the watermark on that object is how the two would come to be treated as one
   * field, which is the trap the whole three-column split exists to avoid.
   */
  scheduleWatermark(conferenceId: string): Promise<string | null>;
  create(conferenceId: string, details: SessionDetails): Promise<Session>;
  update(conferenceId: string, sessionId: string, details: SessionDetails): Promise<Session>;
  /**
   * Removes a Session, refusing to remove the last one from a published Conference.
   *
   * The invariant and the delete are one operation on purpose: TI11 binds the publish gate to the
   * real Session count, so "published implies at least one Session" has to survive a delete as
   * well as a publish, and checking then deleting in two round trips would let two concurrent
   * requests each see two Sessions and each remove one.
   */
  remove(conferenceId: string, sessionId: string): Promise<void>;
}

export function createSessionRepository(db: Database): SessionRepository {
  /** Ordered as the Organizer reads it: by day, then by start time within the day (FR2). */
  async function list(tx: Queryable, conferenceId: string): Promise<Session[]> {
    const rows = await tx.query<SessionRow>(
      `select ${COLUMNS} from sessions where conference_id = $1 order by day, start_time, title`,
      [conferenceId],
    );
    return rows.map(toSession);
  }

  return {
    async listForConference(conferenceId: string): Promise<Session[]> {
      return list(db, conferenceId);
    },

    async scheduleWatermark(conferenceId: string): Promise<string | null> {
      const rows = await db.query<{ watermark: string }>(
        `select ${instantExpression('schedule_watermark_at', 'watermark')}
           from conference where id = $1`,
        [conferenceId],
      );
      return rows[0]?.watermark ?? null;
    },

    async create(conferenceId: string, details: SessionDetails): Promise<Session> {
      const rows = await db.query<SessionRow>(
        `insert into sessions (conference_id, title, description, kind, day, start_time, end_time, location)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         returning ${COLUMNS}`,
        [
          conferenceId,
          details.title,
          details.description,
          details.kind,
          details.day,
          details.startTime,
          details.endTime,
          details.location,
        ],
      );

      const row = rows[0];
      if (row === undefined) throw new Error('The session insert returned no row.');
      return toSession(row);
    },

    /**
     * Scoped by `conference_id` as well as `id`, so a session id from one Conference cannot be
     * edited through another Conference's route – the caller was authorized for *that* Conference,
     * and the query is what holds the two together.
     */
    async update(
      conferenceId: string,
      sessionId: string,
      details: SessionDetails,
    ): Promise<Session> {
      const rows = await db.query<SessionRow>(
        `update sessions
            set title = $3, description = $4, kind = $5, day = $6,
                start_time = $7, end_time = $8, location = $9
          where id = $2 and conference_id = $1
         returning ${COLUMNS}`,
        [
          conferenceId,
          sessionId,
          details.title,
          details.description,
          details.kind,
          details.day,
          details.startTime,
          details.endTime,
          details.location,
        ],
      );

      const row = rows[0];
      if (row === undefined) throw sessionNotFound();
      return toSession(row);
    },

    async remove(conferenceId: string, sessionId: string): Promise<void> {
      await db.transaction(async (tx) => {
        /*
         * The Conference row is locked first, and every delete against this Conference queues
         * behind that lock. Without it two Admins each deleting one of the last two Sessions
         * would both count two, both proceed, and leave a published Conference with an empty
         * schedule – exactly the state the publish gate exists to prevent.
         */
        const conferences = await tx.query<{ lifecycle_state: string }>(
          'select lifecycle_state from conference where id = $1 for update',
          [conferenceId],
        );
        const conference = conferences[0];
        if (conference === undefined) throw sessionNotFound();

        /*
         * "Does this session exist" is answered before "may the last one be removed", so a
         * request naming a session that is not there is told exactly that. Asking in the other
         * order would answer a published conference's sole-session refusal to somebody who named
         * a session id that never existed — a refusal about a session other than the one they
         * asked about, and advice ("add another session first") that would not help them.
         */
        const existing = await tx.query<{ id: string }>(
          'select id from sessions where id = $2 and conference_id = $1',
          [conferenceId, sessionId],
        );
        if (existing[0] === undefined) throw sessionNotFound();

        const counts = await tx.query<{ count: number }>(
          'select count(*)::int as count from sessions where conference_id = $1',
          [conferenceId],
        );

        // A draft is unaffected: it has no attendees to leave without a schedule, and it is
        // refused publication separately while it is empty.
        if (conference.lifecycle_state === 'published' && (counts[0]?.count ?? 0) <= 1) {
          throw new AppError(
            ERROR_CODES.SESSION_LAST_IN_PUBLISHED_CONFERENCE,
            409,
            'A published conference must keep at least one session, and this is the last one. ' +
              'Add another session first, then remove this one.',
          );
        }

        const deleted = await tx.query<{ id: string }>(
          'delete from sessions where id = $2 and conference_id = $1 returning id',
          [conferenceId, sessionId],
        );
        if (deleted[0] === undefined) throw sessionNotFound();
      });
    },
  };
}
