import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WithAuth, AuthenticatedCaller } from '../auth/with-auth.ts';
import { AppError, ERROR_CODES } from '../errors.ts';
import type { Clock } from '../conferences/calendar-date.ts';
import type { ConferenceAuthorization } from '../conferences/authorization.ts';
import type { Conference, ConferenceRepository } from '../conferences/conference-repository.ts';
import type { ScheduleGate } from '../conferences/schedule-gate.ts';
import { validateConferenceDetails } from '../conferences/conference-validation.ts';
import { assertArchivable, assertEditable, assertPublishable } from '../conferences/lifecycle.ts';

/**
 * The Conference endpoints.
 *
 * Every one of them runs the same three steps in the same order, and the order is the point:
 *
 *   1. `withAuth` resolves the caller – an unauthenticated or wrong-domain request never reaches
 *      any of this (S02);
 *   2. `requireConferenceRole` asserts the caller's role for the named Conference – the single
 *      provisional helper, never an inline comparison, so S07 replaces one implementation;
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

export function registerConferenceRoutes(
  app: FastifyInstance,
  { withAuth, repository, authorization, scheduleGate, clock }: ConferenceRouteDependencies,
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
    schema: { params: conferenceParamsSchema, body: detailsBodySchema },
    handler: withAuth(async (request, caller) => {
      const conference = await loadAuthorized(request, caller);
      assertEditable(conference);

      const details = validateConferenceDetails(request.body as DetailsBody);
      return toWire(await repository.updateDetails(conference.id, details));
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
