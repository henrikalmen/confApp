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

/**
 * Does this Session belong to this Conference?
 *
 * Exported, and taking a `Queryable`, so a caller working inside its own transaction can ask
 * without reaching into the `sessions` table itself. S07's Session Assignment needs exactly this
 * question answered under the Conference row lock it already holds, and the table stays owned by
 * this module – which is the boundary `session-structure.test.ts` asserts.
 */
export async function sessionExistsInConference(
  tx: Queryable,
  conferenceId: string,
  sessionId: string,
): Promise<boolean> {
  const rows = await tx.query<{ id: string }>(
    'select id from sessions where id = $1 and conference_id = $2',
    [sessionId, conferenceId],
  );
  return rows[0] !== undefined;
}

/**
 * What a version-guarded write did (S09 C1).
 *
 * Three outcomes, kept apart because they are three different answers to the caller: the write
 * landed; the row moved under it and here is what it looks like now; or the row is gone. Returning
 * a result rather than throwing keeps the error envelope and the wire shape in the route, where the
 * rest of this API's refusals are built.
 */
export type GuardedWrite =
  | { outcome: 'saved'; session: Session }
  | { outcome: 'conflict'; current: Session }
  | { outcome: 'missing' }
  /**
   * The **Conference** is gone, not the Session.
   *
   * Kept apart from `missing` because the two produce different sentences. Answering "that session
   * no longer exists in this conference" to an Admin whose whole Conference was removed under them
   * sends them looking for a Session, and hides the fact that there is nothing left to look in.
   */
  | { outcome: 'conference-missing' };

export interface SessionRepository {
  listForConference(conferenceId: string): Promise<Session[]>;
  /**
   * One Session of one Conference, or `null`.
   *
   * Scoped by `conference_id` as well as `id` for the same reason every write here is: the caller
   * was authorized for *that* Conference, and the query is what holds the two together. S09 reads
   * the row before a write so it can compare the caller's base version against the current one.
   */
  findById(conferenceId: string, sessionId: string): Promise<Session | null>;
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
  /**
   * Edits a Session **only if** its row version still equals `expectedVersion`.
   *
   * The version predicate is part of the UPDATE rather than a check the caller makes first. Reading
   * the row, comparing in JavaScript and then writing is three statements with no lock between
   * them: two concurrent saves both read the same version, both compare equal, and both write - so
   * the second silently overwrites the first while being told it succeeded. That is last-write-wins
   * reappearing inside the mechanism built to prevent it, and it is reachable in exactly the case
   * this story is named for.
   */
  update(
    conferenceId: string,
    sessionId: string,
    details: SessionDetails,
    expectedVersion: string,
  ): Promise<GuardedWrite>;
  /**
   * Removes a Session, refusing to remove the last one from a published Conference.
   *
   * The invariant and the delete are one operation on purpose: TI11 binds the publish gate to the
   * real Session count, so "published implies at least one Session" has to survive a delete as
   * well as a publish, and checking then deleting in two round trips would let two concurrent
   * requests each see two Sessions and each remove one.
   */
  remove(conferenceId: string, sessionId: string, expectedVersion: string): Promise<GuardedWrite>;
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

    async findById(conferenceId: string, sessionId: string): Promise<Session | null> {
      const rows = await db.query<SessionRow>(
        `select ${COLUMNS} from sessions where id = $2 and conference_id = $1`,
        [conferenceId, sessionId],
      );
      const row = rows[0];
      return row === undefined ? null : toSession(row);
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
      expectedVersion: string,
    ): Promise<GuardedWrite> {
      /*
       * `last_updated_at = $10` is the whole concurrency guarantee, and it is here rather than in
       * the caller because only the database can compare and write in one indivisible step. The
       * comparison is against the exact serialized value the editor was given - the column is
       * formatted at microsecond precision on the way out precisely so this equality is exact.
       */
      const rows = await db.query<SessionRow>(
        `update sessions
            set title = $3, description = $4, kind = $5, day = $6,
                start_time = $7, end_time = $8, location = $9
          where id = $2 and conference_id = $1 and last_updated_at = $10::timestamptz
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
          expectedVersion,
        ],
      );

      const row = rows[0];
      if (row !== undefined) return { outcome: 'saved', session: toSession(row) };

      // No row matched: either the version moved or the Session is gone. One further read tells
      // the caller which, and carries the current values the editor re-applies onto.
      const current = await db.query<SessionRow>(
        `select ${COLUMNS} from sessions where id = $2 and conference_id = $1`,
        [conferenceId, sessionId],
      );
      const existing = current[0];
      return existing === undefined
        ? { outcome: 'missing' }
        : { outcome: 'conflict', current: toSession(existing) };
    },

    async remove(
      conferenceId: string,
      sessionId: string,
      expectedVersion: string,
    ): Promise<GuardedWrite> {
      return db.transaction<GuardedWrite>(async (tx) => {
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
        if (conference === undefined) return { outcome: 'conference-missing' };

        /*
         * "Does this session exist" is answered before "may the last one be removed", so a
         * request naming a session that is not there is told exactly that. Asking in the other
         * order would answer a published conference's sole-session refusal to somebody who named
         * a session id that never existed — a refusal about a session other than the one they
         * asked about, and advice ("add another session first") that would not help them.
         */
        const existing = await tx.query<SessionRow>(
          `select ${COLUMNS} from sessions where id = $2 and conference_id = $1`,
          [conferenceId, sessionId],
        );
        const found = existing[0];
        if (found === undefined) return { outcome: 'missing' };

        /*
         * The same version guarantee the edit path has. A delete is a write like any other: the
         * Session may have been edited since the Admin last looked at it, and removing it on a view
         * that stale is the silent overwrite in its most destructive form.
         *
         * Compared inside the transaction that already holds the conference row lock, so nothing
         * can move between this check and the delete below.
         */
        if (found.last_updated_at !== expectedVersion) {
          return { outcome: 'conflict', current: toSession(found) };
        }

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
        if (deleted[0] === undefined) return { outcome: 'missing' };
        return { outcome: 'saved', session: toSession(found) };
      });
    },
  };
}
