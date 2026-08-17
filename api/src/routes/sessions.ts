import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WithAuth, AuthenticatedCaller } from '../auth/with-auth.ts';
import { AppError, ERROR_CODES } from '../errors.ts';
import type { ConferenceAuthorization } from '../conferences/authorization.ts';
import type { Conference, ConferenceRepository } from '../conferences/conference-repository.ts';
import { assertEditable } from '../conferences/lifecycle.ts';
import type { Session, SessionRepository } from '../sessions/session-repository.ts';
import {
  conferenceDays,
  validateSessionDetails,
  type SessionDetailsInput,
} from '../sessions/session-validation.ts';
import { overlappingPairs, overlapsWith } from '../sessions/overlap.ts';

/**
 * The schedule-composition endpoints.
 *
 * Every one runs the same three steps in the same order, exactly as the Conference routes do:
 * `withAuth` resolves the caller (S02); `requireConferenceRole` asserts their role for the named
 * Conference through the single provisional helper (S03, generalized by S07), never an inline
 * comparison; and the lifecycle module decides whether a change is legal in the Conference's
 * current state, read fresh from the database on this request.
 *
 * Nothing is remembered between requests – no schedule state, no overlap cache, no watermark. The
 * API runs as several container replicas with no request affinity (ADR-004), so anything held here
 * would be absent on the next request anyway.
 */

export interface SessionRouteDependencies {
  withAuth: WithAuth;
  conferences: ConferenceRepository;
  sessions: SessionRepository;
  authorization: ConferenceAuthorization;
}

/** Shape only. The business rules live in session-validation.ts. */
const sessionBodySchema = {
  type: 'object',
  required: ['title', 'kind', 'day', 'startTime', 'endTime', 'location'],
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    description: { type: ['string', 'null'] },
    kind: { type: 'string' },
    day: { type: 'string' },
    startTime: { type: 'string' },
    endTime: { type: 'string' },
    location: { type: 'string' },
  },
} as const;

const conferenceParamsSchema = {
  type: 'object',
  required: ['conferenceId'],
  properties: { conferenceId: { type: 'string', format: 'uuid' } },
} as const;

const sessionParamsSchema = {
  type: 'object',
  required: ['conferenceId', 'sessionId'],
  properties: {
    conferenceId: { type: 'string', format: 'uuid' },
    sessionId: { type: 'string', format: 'uuid' },
  },
} as const;

interface ConferenceParams {
  conferenceId: string;
}

interface SessionParams extends ConferenceParams {
  sessionId: string;
}

/**
 * What a Session looks like on the wire.
 *
 * `day`, `startTime` and `endTime` are naive wall-clock strings – 'YYYY-MM-DD' and 'HH:mm', with
 * no seconds, no `Z`, no offset and no instant anywhere. `lastUpdatedAt` is the one field that
 * genuinely is an instant: the row version S09 will send back as the base of an edit.
 */
function toWire(session: Session): Record<string, unknown> {
  return {
    id: session.id,
    conferenceId: session.conferenceId,
    title: session.title,
    description: session.description,
    kind: session.kind,
    day: session.day,
    startTime: session.startTime,
    endTime: session.endTime,
    location: session.location,
    lastUpdatedAt: session.lastUpdatedAt,
  };
}

/**
 * The warning that accompanies a *successful* save of an overlapping Session.
 *
 * Parallel Tracks are supported (FR2), so this is never a refusal – the save has already happened
 * by the time it is built. It names the Sessions the new one runs alongside, because "this session
 * overlaps another" leaves the Organizer to hunt for which.
 */
function overlapWarning(
  saved: Session,
  schedule: readonly Session[],
): Record<string, unknown> | null {
  const clashing = overlapsWith(saved, schedule);
  if (clashing.length === 0) return null;

  const named = clashing
    .map((other) => `"${other.title}" (${other.startTime}–${other.endTime})`)
    .join(', ');

  return {
    code: 'SESSION_OVERLAPS',
    message:
      `Saved. On ${saved.day} this session runs at the same time as ${named}. ` +
      'Parallel tracks are allowed, so nothing needs changing unless you meant otherwise.',
    sessions: clashing.map((other) => ({
      id: other.id,
      title: other.title,
      startTime: other.startTime,
      endTime: other.endTime,
    })),
  };
}

export function registerSessionRoutes(
  app: FastifyInstance,
  { withAuth, conferences, sessions, authorization }: SessionRouteDependencies,
): void {
  /**
   * Loads a Conference the caller has already been authorized to administer.
   *
   * Authorization runs *first*, so this refuses only where an Admin's Conference has since been
   * removed. A caller with no role never reaches it – they were refused by the helper without
   * learning whether the id exists at all.
   */
  async function loadAuthorized(
    request: FastifyRequest,
    caller: AuthenticatedCaller,
  ): Promise<Conference> {
    const { conferenceId } = request.params as ConferenceParams;
    await authorization.requireConferenceRole(caller, conferenceId, 'Admin');

    const conference = await conferences.findById(conferenceId);
    if (conference === null) {
      throw new AppError(
        ERROR_CODES.CONFERENCE_NOT_FOUND,
        404,
        'That conference no longer exists.',
      );
    }
    return conference;
  }

  /** A write to the schedule: authorized, and refused outright on an archived Conference. */
  async function loadWritable(
    request: FastifyRequest,
    caller: AuthenticatedCaller,
  ): Promise<Conference> {
    const conference = await loadAuthorized(request, caller);
    // The lifecycle guard S03 introduced, not a re-derivation of what "archived" means here.
    assertEditable(conference);
    return conference;
  }

  /**
   * The **Organizer's** composition view: every Conference Day, in order, each with its Sessions
   * in start-time order, plus the overlap pairs and the timestamps composition needs.
   *
   * Deliberately a different route from S06's attendee read at `GET /conferences/:id/schedule`.
   * Same resource, two audiences: this one is Admin-only, carries composition data, and has no
   * membership or clock-offset envelope. Do not merge them.
   */
  app.get('/api/conferences/:conferenceId/schedule/organizer', {
    schema: { params: conferenceParamsSchema },
    handler: withAuth(async (request, caller) => {
      // Readable while archived – archiving makes a Conference read-only, not invisible (FR9).
      const conference = await loadAuthorized(request, caller);

      const schedule = await sessions.listForConference(conference.id);
      const watermark = await sessions.scheduleWatermark(conference.id);

      /*
       * Conference Days are derived from the date span, never stored (PRD → Data Requirements),
       * which is what puts an empty day in this payload instead of omitting it. An Organizer
       * composing a schedule needs to see the day they have not filled in yet.
       *
       * A Session can also sit *outside* that span: S03 lets a Conference's dates be shortened
       * past its Sessions and leaves refusing that to S09. Such a Session still exists, still
       * satisfies the publish gate and still blocks the last-Session delete, so dropping it here
       * would hide it from the only surface that could move or remove it. Every day holding a
       * Session is therefore emitted too, and the whole list is ordered by date – which is a text
       * sort, because these are zero-padded calendar days.
       */
      const byDay = new Map<string, Session[]>(
        conferenceDays(conference).map((day) => [day, [] as Session[]]),
      );
      for (const session of schedule) {
        const existing = byDay.get(session.day);
        if (existing === undefined) byDay.set(session.day, [session]);
        else existing.push(session);
      }
      const days = [...byDay].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

      return {
        conference: {
          id: conference.id,
          name: conference.name,
          startDate: conference.startDate,
          endDate: conference.endDate,
          lifecycleState: conference.lifecycleState,
          // The whole-schedule watermark, under the name S06's envelope gives it. The rename from
          // `schedule_watermark_at` is a column-naming change only; the payload is unchanged.
          lastUpdatedAt: watermark,
        },
        days: days.map(([day, daySessions]) => ({
          day,
          sessions: daySessions.map(toWire),
        })),
        // Recomputed on every read, never stored, so it cannot go stale (TI07).
        overlaps: overlappingPairs(schedule),
      };
    }),
  });

  app.post('/api/conferences/:conferenceId/sessions', {
    schema: { params: conferenceParamsSchema, body: sessionBodySchema },
    handler: withAuth(async (request, caller) => {
      const conference = await loadWritable(request, caller);

      // Validation before any write, so a refused request persists nothing.
      const details = validateSessionDetails(request.body as SessionDetailsInput, conference);
      const created = await sessions.create(conference.id, details);

      return {
        session: toWire(created),
        overlapWarning: overlapWarning(created, await sessions.listForConference(conference.id)),
      };
    }),
  });

  app.patch('/api/conferences/:conferenceId/sessions/:sessionId', {
    schema: { params: sessionParamsSchema, body: sessionBodySchema },
    handler: withAuth(async (request, caller) => {
      const conference = await loadWritable(request, caller);
      const { sessionId } = request.params as SessionParams;

      const details = validateSessionDetails(request.body as SessionDetailsInput, conference);
      const updated = await sessions.update(conference.id, sessionId, details);

      return {
        session: toWire(updated),
        overlapWarning: overlapWarning(updated, await sessions.listForConference(conference.id)),
      };
    }),
  });

  app.delete('/api/conferences/:conferenceId/sessions/:sessionId', {
    schema: { params: sessionParamsSchema },
    handler: withAuth(async (request, caller) => {
      const conference = await loadWritable(request, caller);
      const { sessionId } = request.params as SessionParams;

      // The "a published conference keeps at least one session" refusal is raised inside the
      // repository, where the count and the delete share a transaction and a lock.
      await sessions.remove(conference.id, sessionId);
      return { deleted: sessionId };
    }),
  });
}
