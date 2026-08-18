import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WithAuth, AuthenticatedCaller } from '../auth/with-auth.ts';
import { AppError, ERROR_CODES } from '../errors.ts';
import type {
  ConferenceAuthorization,
  ConferenceRole,
  RequireConferenceRoleOptions,
} from '../conferences/authorization.ts';
import type { Conference, ConferenceRepository } from '../conferences/conference-repository.ts';
import { assertEditable } from '../conferences/lifecycle.ts';
import type { Session, SessionRepository } from '../sessions/session-repository.ts';
import {
  conferenceDays,
  validateSessionDetails,
  type SessionDetailsInput,
} from '../sessions/session-validation.ts';
import { overlappingPairs, overlapsWith } from '../sessions/overlap.ts';
import { assertWritePreconditions, requireWriteBase } from '../conferences/write-preconditions.ts';

/**
 * The schedule-composition endpoints.
 *
 * Every one runs the same three steps in the same order, exactly as the Conference routes do:
 * `withAuth` resolves the caller (S02); `requireConferenceRole` asserts their role for the named
 * Conference through the single canonical check (S03's seam, implemented by S07), never an inline
 * comparison; and the lifecycle module decides whether a change is legal in the Conference's
 * current state, read fresh from the database on this request.
 *
 * What each endpoint *declares* is where they differ, and the split is deliberate: composing the
 * schedule – creating and deleting Sessions, and reading the whole composition view – is `Admin`
 * work, while editing one Session is open to the Presenter/Facilitator assigned to it, narrowed by
 * `options.sessionId` (S07 TI10).
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

/**
 * The version of the world an edit was composed against (S09 TI04, TI05).
 *
 * Both halves are required, and neither has a default. A write that could omit `version` would be
 * a force-write available by accident; a write that could omit `conferenceState` could not tell a
 * lifecycle race from a version conflict, which is the distinction the edge-case table turns on.
 */
const writeBaseSchema = {
  type: 'object',
  required: ['conferenceState', 'version'],
  additionalProperties: false,
  properties: {
    conferenceState: { type: 'string' },
    version: { type: 'string' },
  },
} as const;

/**
 * An edit: the Session's fields, plus the base it was composed against.
 *
 * `base` is deliberately **not** in `required`. Fastify validates the schema before the handler
 * runs, so a required-here base would be refused with a 400 before `withAuth` had established who
 * the caller is – an unauthenticated request would learn the shape of the endpoint, and an
 * unauthorized one would be answered 400 where it must be answered 403. Its presence is asserted
 * inside the handler instead, after authorization, which is also the order TI05 fixes for the three
 * checks. The schema still pins its *shape*, so a malformed base is caught here.
 */
const sessionEditBodySchema = {
  type: 'object',
  required: ['title', 'kind', 'day', 'startTime', 'endTime', 'location'],
  additionalProperties: false,
  properties: {
    ...sessionBodySchema.properties,
    base: writeBaseSchema,
  },
} as const;

/**
 * A delete carries its base in the query string, because a DELETE body is not reliably forwarded
 * by every proxy and client in the path. The values are the same two, checked identically, and
 * required in the handler rather than here for the reason given above.
 */
const sessionDeleteQuerySchema = {
  type: 'object',
  properties: {
    conferenceState: { type: 'string' },
    version: { type: 'string' },
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
   * What a successful Session write answers with (S09 TI09).
   *
   * Three things, and each has a reader. The saved Session carries its **new row version**, which
   * the Organizer's form keeps as the base of an immediate follow-up edit – without it a second
   * save straight after the first would be refused as a conflict with itself. The Conference's
   * **advanced watermark** is the same value the poll endpoint will serve and the same one the next
   * attendee envelope carries, so the Admin's own client can tell its poll apart from somebody
   * else's change. The overlap warning is S04's, unchanged.
   */
  async function savedSession(
    session: Session,
    schedule: readonly Session[],
    conferenceId: string,
  ): Promise<Record<string, unknown>> {
    return {
      session: toWire(session),
      overlapWarning: overlapWarning(session, schedule),
      conference: { lastUpdatedAt: await sessions.scheduleWatermark(conferenceId) },
    };
  }

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
    required: ConferenceRole = 'Admin',
    options: RequireConferenceRoleOptions = {},
  ): Promise<Conference> {
    const { conferenceId } = request.params as ConferenceParams;
    await authorization.requireConferenceRole(caller, conferenceId, required, options);

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
    required: ConferenceRole = 'Admin',
    options: RequireConferenceRoleOptions = {},
  ): Promise<Conference> {
    const conference = await loadAuthorized(request, caller, required, options);
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

      return savedSession(created, await sessions.listForConference(conference.id), conference.id);
    }),
  });

  /**
   * Editing a Session – the one schedule endpoint a Presenter/Facilitator may reach.
   *
   * `options.sessionId` is what narrows them to it. An Admin passes on conference-wide authority
   * and holds no Session Assignment; a Presenter/Facilitator passes only against a row for *this*
   * Session, and is refused on a colleague's exactly as an Attendee is (S07 TI03, TI10). The
   * Session's `kind` is not consulted anywhere in that decision: presenting and facilitating are
   * one role, so a Presentation and a Workshop authorize identically.
   */
  app.patch('/api/conferences/:conferenceId/sessions/:sessionId', {
    schema: { params: sessionParamsSchema, body: sessionEditBodySchema },
    handler: withAuth(async (request, caller) => {
      const { sessionId } = request.params as SessionParams;
      /*
       * Authorization first – step one of the three, and the only one that is not in the
       * precondition module. `loadWritable` also applies S03's standing archived guard, which
       * refuses an editor who never had a stale view; the precondition step below is what
       * distinguishes the editor who did.
       */
      const conference = await loadAuthorized(request, caller, 'PresenterFacilitator', {
        sessionId,
      });

      const base = requireWriteBase((request.body as { base?: unknown }).base);

      const existing = await sessions.findById(conference.id, sessionId);
      if (existing === null) {
        throw new AppError(
          ERROR_CODES.SESSION_NOT_FOUND,
          404,
          'That session no longer exists in this conference.',
        );
      }

      /*
       * Steps two and three, in the module that owns their order. Both run before validation and
       * before any write, so a refused save persists nothing – the edge-case table's "nothing of
       * the second edit is applied".
       */
      try {
        assertWritePreconditions({
          conference,
          base,
          currentVersion: existing.lastUpdatedAt,
          subject: 'session',
        });
      } catch (error) {
        // The current representation travels with the refusal so the editor can re-apply their
        // change onto it, rather than reloading and retyping it from memory.
        if (error instanceof AppError && error.code === ERROR_CODES.EDIT_VERSION_CONFLICT) {
          throw error.withCurrent(toWire(existing));
        }
        throw error;
      }

      const details = validateSessionDetails(request.body as SessionDetailsInput, conference);
      const updated = await sessions.update(conference.id, sessionId, details);

      return savedSession(updated, await sessions.listForConference(conference.id), conference.id);
    }),
  });

  /**
   * Deleting a Session requires `Admin`, not the Session's own holder.
   *
   * Removing a Session changes the schedule everybody else is reading, which is a conference-wide
   * act rather than authority over one's own slot – so a Presenter/Facilitator is refused here even
   * for a Session they are assigned to (S07 TI10). `sessionId` is still passed: it is a no-op for
   * the Admin who passes on conference-wide authority, and stating it keeps this call site honest
   * about what it is acting on rather than relying on the required role to carry the whole answer.
   */
  app.delete('/api/conferences/:conferenceId/sessions/:sessionId', {
    schema: { params: sessionParamsSchema, querystring: sessionDeleteQuerySchema },
    handler: withAuth(async (request, caller) => {
      const { sessionId } = request.params as SessionParams;
      const conference = await loadAuthorized(request, caller, 'Admin', { sessionId });

      // A delete is a write like any other and races the same way: the Session it names may have
      // been edited, and the Conference may have been archived, since the Admin last looked.
      const base = requireWriteBase(request.query);

      const existing = await sessions.findById(conference.id, sessionId);
      if (existing === null) {
        throw new AppError(
          ERROR_CODES.SESSION_NOT_FOUND,
          404,
          'That session no longer exists in this conference.',
        );
      }

      try {
        assertWritePreconditions({
          conference,
          base,
          currentVersion: existing.lastUpdatedAt,
          subject: 'session',
        });
      } catch (error) {
        if (error instanceof AppError && error.code === ERROR_CODES.EDIT_VERSION_CONFLICT) {
          throw error.withCurrent(toWire(existing));
        }
        throw error;
      }

      // The "a published conference keeps at least one session" refusal is raised inside the
      // repository, where the count and the delete share a transaction and a lock.
      await sessions.remove(conference.id, sessionId);
      return {
        deleted: sessionId,
        conference: { lastUpdatedAt: await sessions.scheduleWatermark(conference.id) },
      };
    }),
  });
}
