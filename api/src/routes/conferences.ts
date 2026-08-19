import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WithAuth, AuthenticatedCaller } from '../auth/with-auth.ts';
import { AppError, ERROR_CODES } from '../errors.ts';
import type { Clock } from '../conferences/calendar-date.ts';
import type { ConferenceAuthorization } from '../conferences/authorization.ts';
import type { Conference, ConferenceRepository } from '../conferences/conference-repository.ts';
import type { ScheduleGate } from '../conferences/schedule-gate.ts';
import type { SessionRepository } from '../sessions/session-repository.ts';
import { conferenceDays } from '../sessions/session-validation.ts';
import {
  validateConferenceDetails,
  type ConferenceDetails,
} from '../conferences/conference-validation.ts';
import { assertArchivable, assertPublishable } from '../conferences/lifecycle.ts';
import {
  assertLifecyclePreconditions,
  requireWriteBase,
  versionConflict,
} from '../conferences/write-preconditions.ts';

/**
 * The Conference endpoints.
 *
 * Every one of them runs the same three steps in the same order, and the order is the point:
 *
 *   1. `withAuth` resolves the caller – an unauthenticated or wrong-domain request never reaches
 *      any of this (S02);
 *   2. `requireConferenceRole` asserts the caller's role for the named Conference – the single
 *      canonical check, never an inline comparison. Every endpoint here declares `Admin`: changing
 *      a Conference's details, publishing it and archiving it are conference-wide acts, and S07
 *      replaced that helper's body without touching one of these call sites;
 *   3. the lifecycle module decides whether the change is legal in the Conference's current
 *      state, read fresh from the database on this request.
 *
 * The client is not consulted at any point. The organizer UI may hide or disable an affordance,
 * but every refusal here is reproducible by calling the endpoint directly – which is what
 * Acceptance Scenario S07 checks.
 */

export interface ConferenceRouteDependencies {
  withAuth: WithAuth;
  repository: ConferenceRepository;
  /** Read-only here: a date-span change must know which Sessions it would strand (S09 TI07). */
  sessions: SessionRepository;
  authorization: ConferenceAuthorization;
  scheduleGate: ScheduleGate;
  clock: Clock;
}

/** Shape only. The business rules live in conference-validation.ts and lifecycle.ts. */
const detailsBodySchema = {
  type: 'object',
  required: ['name', 'startDate', 'endDate'],
  additionalProperties: false,
  properties: {
    name: { type: 'string' },
    startDate: { type: 'string' },
    endDate: { type: 'string' },
  },
} as const;

/**
 * The same body, plus the base the edit was composed against (S09 TI06).
 *
 * `base` is pinned in shape but not listed in `required`: Fastify validates before the handler
 * runs, so requiring it here would answer 400 to an unauthenticated or unauthorized caller who
 * must be answered 401 or 403. Its presence is asserted in the handler, after authorization –
 * which is also the order TI05 fixes for the three checks.
 */
const detailsEditBodySchema = {
  type: 'object',
  required: ['name', 'startDate', 'endDate'],
  additionalProperties: false,
  properties: {
    ...detailsBodySchema.properties,
    base: {
      type: 'object',
      required: ['conferenceState', 'version'],
      additionalProperties: false,
      properties: {
        conferenceState: { type: 'string' },
        version: { type: 'string' },
      },
    },
  },
} as const;

const conferenceParamsSchema = {
  type: 'object',
  required: ['conferenceId'],
  properties: { conferenceId: { type: 'string', format: 'uuid' } },
} as const;

interface ConferenceParams {
  conferenceId: string;
}

interface DetailsBody {
  name: string;
  startDate: string;
  endDate: string;
}

/**
 * What a Conference looks like on the wire.
 *
 * `updatedAt` is the row version S09 bases an edit on, so it is load-bearing rather than
 * decorative – an edit cannot be based on a version it was never sent. There is deliberately no
 * watermark field here: S04's `schedule_watermark_at` is a different fact and surfaces separately
 * through S06's envelope as `lastUpdatedAt`.
 */
function toWire(conference: Conference): Record<string, unknown> {
  return {
    id: conference.id,
    name: conference.name,
    startDate: conference.startDate,
    endDate: conference.endDate,
    lifecycleState: conference.lifecycleState,
    updatedAt: conference.updatedAt,
  };
}

/** The Sessions a proposed date span would leave with no Conference Day to sit on. */
function outsideSpan(
  span: Pick<ConferenceDetails, 'startDate' | 'endDate'>,
  schedule: readonly { title: string; day: string }[],
): { title: string; day: string }[] {
  const days = new Set<string>(conferenceDays(span));
  return schedule.filter((session) => !days.has(session.day));
}

/**
 * Refuses a date-span change that would strand Sessions, naming them and their days.
 *
 * Named rather than counted, because the recovery path is "go and move these" and a count would
 * leave the Organizer opening every day of the schedule to find which. The span is unchanged: the
 * refusal is raised before the write, so nothing is half-applied.
 */
function spanWouldOrphan(stranded: readonly { title: string; day: string }[]): AppError {
  const named = stranded.map((session) => `"${session.title}" on ${session.day}`).join(', ');

  return new AppError(
    ERROR_CODES.CONFERENCE_SPAN_ORPHANS_SESSIONS,
    409,
    `These dates would leave ${stranded.length === 1 ? 'a session' : 'sessions'} outside the ` +
      `conference: ${named}. Move or delete ${stranded.length === 1 ? 'it' : 'them'} first, ` +
      'then change the dates.',
    /*
     * Both dates, like every other span refusal (conference-validation.ts): the span is a property
     * of the pair, and blaming one of them would send the organizer to correct the wrong input.
     * The message is the same sentence, so the form shows it inline beside the date inputs.
     */
    ['startDate', 'endDate'].map((field) => ({
      field,
      message: `These dates would leave ${named} outside the conference. Move or delete them first.`,
    })),
  );
}

export function registerConferenceRoutes(
  app: FastifyInstance,
  {
    withAuth,
    repository,
    sessions,
    authorization,
    scheduleGate,
    clock,
  }: ConferenceRouteDependencies,
): void {
  /**
   * Loads a Conference the caller has already been authorized for.
   *
   * Authorization runs *first*, so this refuses only in the case where the caller holds a role
   * for a Conference that is no longer there. A caller with no role never reaches it – they were
   * refused by the helper without learning whether the id exists at all.
   */
  async function loadAuthorized(
    request: FastifyRequest,
    caller: AuthenticatedCaller,
  ): Promise<Conference> {
    const { conferenceId } = request.params as ConferenceParams;
    await authorization.requireConferenceRole(caller, conferenceId, 'Admin');

    const conference = await repository.findById(conferenceId);
    if (conference === null) {
      throw new AppError(
        ERROR_CODES.CONFERENCE_NOT_FOUND,
        404,
        'That conference no longer exists.',
      );
    }
    return conference;
  }

  /**
   * Creating is the one action with no per-conference check to make: any signed-in employee may
   * create a Conference, and there is no instance to hold a role in until they have. They become
   * its Admin by creating it.
   */
  app.post('/api/conferences', {
    schema: { body: detailsBodySchema },
    handler: withAuth(async (request, caller) => {
      // Validation before any write, so a refused request leaves none of the three rows behind.
      const details = validateConferenceDetails(request.body as DetailsBody);
      const conference = await repository.create(details, caller.sub);
      return toWire(conference);
    }),
  });

  /**
   * The **Organizer** list – the Conferences the caller holds a Role Assignment for, drafts
   * included, each with its lifecycle state so the client can mark the archived ones.
   *
   * The **Attendee** list is a different result set at `GET /me/conferences` and belongs to S06.
   * Two intended endpoints; do not merge them.
   */
  app.get(
    '/api/conferences',
    withAuth(async (_request, caller) => {
      const conferences = await repository.listForRoleHolder(caller.sub);
      return { conferences: conferences.map(toWire) };
    }),
  );

  app.get('/api/conferences/:conferenceId', {
    schema: { params: conferenceParamsSchema },
    handler: withAuth(async (request, caller) => toWire(await loadAuthorized(request, caller))),
  });

  /**
   * Name and date span, changeable while the Conference is not archived – draft and published
   * alike (FR1).
   *
   * Deliberately absent: the `updatedAt` base-version check and the refusal to shorten a span so
   * that Sessions fall outside it. Both are S09's, and both need Sessions to exist first. Between
   * this story and that one a span genuinely can be shortened past its Sessions; that is a
   * sequencing consequence, recorded in the FIS, not something to half-implement here.
   */
  app.patch('/api/conferences/:conferenceId', {
    schema: { params: conferenceParamsSchema, body: detailsEditBodySchema },
    handler: withAuth(async (request, caller) => {
      // Step one of three: authorization. `assertEditable` is deliberately *not* called here – the
      // precondition step below runs it after the state-change check, so an Admin whose conference
      // was archived under them reads that fact rather than the standing archived rule.
      const conference = await loadAuthorized(request, caller);

      const base = requireWriteBase((request.body as { base?: unknown }).base, 'conference');

      /*
       * Step two: lifecycle, before the version, so an archive under an in-flight edit is named.
       *
       * The current representation travels with this refusal too, not only with the version
       * conflict. Without it the message ("reload it to see where that leaves your edit") named an
       * action the editor had no way to take: the state they sent is the only signal a race
       * happened, so every retry resent the stale one and was refused identically, forever.
       */
      try {
        assertLifecyclePreconditions({ conference, base });
      } catch (error) {
        if (error instanceof AppError && error.code === ERROR_CODES.CONFERENCE_STATE_CHANGED) {
          throw error.withCurrent(toWire(conference));
        }
        throw error;
      }

      const details = validateConferenceDetails(request.body as DetailsBody);

      /*
       * A span may be widened freely; shortening it past a Session is refused rather than silently
       * stranding one. The check runs against the *proposed* span, so widening simply finds nothing
       * outside it and needs no separate branch.
       */
      const stranded = outsideSpan(details, await sessions.listForConference(conference.id));
      if (stranded.length > 0) throw spanWouldOrphan(stranded);

      /*
       * Step three: the base version, compared by the database in the same statement as the write.
       * The base is `conference.updated_at` - the Conference row's own version, which S03 TI06
       * returns as `updatedAt` - and never the schedule watermark, which advances on every Session
       * write and would refuse a rename because somebody moved a session in another room.
       */
      const result = await repository.updateDetails(conference.id, details, base.version);

      if (result.outcome === 'missing') {
        throw new AppError(
          ERROR_CODES.CONFERENCE_NOT_FOUND,
          404,
          'That conference no longer exists.',
        );
      }
      if (result.outcome === 'conflict') {
        throw versionConflict('conference').withCurrent(toWire(result.current));
      }
      const saved = result.conference;

      /*
       * Both timestamps, under the two names they are deliberately kept apart by (S09 TI09).
       * `updatedAt` is this row's new version, which the form keeps as the base of an immediate
       * follow-up edit. `lastUpdatedAt` is the schedule watermark, advanced because a name or date
       * change is a schedule change – the same value the poll endpoint now serves and the next
       * attendee envelope carries, so the Admin's own client can tell its poll apart from somebody
       * else's change.
       */
      return {
        ...toWire(saved),
        lastUpdatedAt: await sessions.scheduleWatermark(conference.id),
      };
    }),
  });

  app.post('/api/conferences/:conferenceId/publish', {
    schema: { params: conferenceParamsSchema },
    handler: withAuth(async (request, caller) => {
      const conference = await loadAuthorized(request, caller);

      const hasSession = await scheduleGate.hasAtLeastOneSession(conference.id);
      assertPublishable(conference, hasSession);

      // Publishing mints the Conference's Join Code in the same statement as the transition (S05):
      // a published Conference always has one, and republishing is refused above rather than
      // silently reissuing a code that is already on a slide. Regenerating is a separate,
      // deliberate action at `POST /api/conferences/:id/join-code/regenerate`.
      return toWire(await repository.publish(conference.id));
    }),
  });

  app.post('/api/conferences/:conferenceId/archive', {
    schema: { params: conferenceParamsSchema },
    handler: withAuth(async (request, caller) => {
      const conference = await loadAuthorized(request, caller);

      // The server's own calendar date, read now rather than remembered – a replica that started
      // yesterday must still archive correctly today.
      assertArchivable(conference, clock.today());

      return toWire(await repository.updateLifecycleState(conference.id, 'archived'));
    }),
  });
}
