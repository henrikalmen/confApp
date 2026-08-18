import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuthenticatedCaller, WithAuth } from '../auth/with-auth.ts';
import { AppError, ERROR_CODES } from '../errors.ts';
import type { Clock } from '../conferences/calendar-date.ts';
import type { ConferenceAuthorization } from '../conferences/authorization.ts';
import type { Conference, ConferenceRepository } from '../conferences/conference-repository.ts';
import type { FailedJoinAttempts } from '../conferences/failed-join-attempts.ts';
import { normalizeJoinCode } from '../conferences/join-code.ts';
import { assertJoinable } from '../conferences/lifecycle.ts';

/**
 * The Join Code endpoints: one an employee uses, two an Organizer does.
 *
 * The join endpoint runs its steps in this order and the order is the point:
 *
 *   1. `withAuth` resolves the caller – an unauthenticated or wrong-domain request never reaches
 *      any of this, and the `sub` it produces is the only identity anything below uses (S02);
 *   2. the limiter is consulted *before* any lookup, so an employee who has spent their allowance
 *      is told so rather than being allowed to keep probing;
 *   3. the submitted value is normalized once, then matched against the canonical stored form;
 *   4. joinability is decided by S03's exported predicate – this module contains no lifecycle-state
 *      or end-date comparison of its own, which is what keeps one definition of the rule;
 *   5. a refusal records a failed attempt; a success records nothing, so a legitimate employee's
 *      allowance is never consumed by joining.
 *
 * The two Organizer endpoints go through the canonical per-conference authorization check exactly as
 * the Conference and Session routes do (`plan.json` → sharedDecisions), never an inline role
 * comparison. Both declare `Admin`: a Join Code is the Organizer's to see and to replace, and S07
 * implemented that check without touching either call site.
 *
 * Nothing is remembered between requests – no attempt counters, no resolved codes, no caller cache.
 * The API runs as several container replicas with no request affinity (ADR-004).
 */

export interface JoinCodeRouteDependencies {
  withAuth: WithAuth;
  repository: ConferenceRepository;
  authorization: ConferenceAuthorization;
  failedAttempts: FailedJoinAttempts;
  clock: Clock;
}

/**
 * Shape only – the rules are below. `maxLength` is not a validation of the code: a code is six
 * characters, and anything longer simply matches nothing. It is there so a caller cannot make the
 * server normalize a megabyte of text before discovering it is not a code.
 */
const joinBodySchema = {
  type: 'object',
  required: ['code'],
  additionalProperties: false,
  properties: {
    code: { type: 'string', minLength: 1, maxLength: 64 },
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

interface JoinBody {
  code: string;
}

function codeUnknown(): AppError {
  // The exact sentence FR3 → Error Handling asks for. It says nothing about what the code might
  // have been for, because there is nothing to say – no Conference holds it.
  return new AppError(ERROR_CODES.JOIN_CODE_UNKNOWN, 404, 'No conference found with that code.');
}

/**
 * What an Organizer's code panel is told.
 *
 * `joinCode` is null while the Conference is a draft, and the panel says so rather than showing an
 * empty box: a code exists from publication onwards and not before (FR3).
 */
function codeToWire(conference: Conference): Record<string, unknown> {
  return {
    conferenceId: conference.id,
    joinCode: conference.joinCode,
    lifecycleState: conference.lifecycleState,
  };
}

export function registerJoinCodeRoutes(
  app: FastifyInstance,
  { withAuth, repository, authorization, failedAttempts, clock }: JoinCodeRouteDependencies,
): void {
  /**
   * Loads a Conference whose code the caller is entitled to see or replace.
   *
   * Authorization runs first, through the helper, so a caller with no role is refused without
   * learning whether the id names a real Conference – and, importantly, without learning its code.
   */
  async function loadAdministered(
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
   * Joining by code.
   *
   * Not nested under a conference id, because the code is what selects the Conference – the caller
   * does not know the id yet, and requiring one would make the code decorative.
   */
  app.post('/api/join', {
    schema: { body: joinBodySchema },
    handler: withAuth(async (request, caller) => {
      // Keyed on the verified `sub` from the caller context, never on a request address. There is
      // no header read anywhere in this handler, which is what makes the NAT case a non-event.
      await failedAttempts.assertWithinLimit(caller.sub);

      const code = normalizeJoinCode((request.body as JoinBody).code);
      const conference = await repository.findByJoinCode(code);

      if (conference === null) {
        await failedAttempts.record(caller.sub);
        throw codeUnknown();
      }

      try {
        // S03's predicate, which carries both the lifecycle-state rule and the end-date rule. A
        // Conference still marked `published` whose end date has passed is refused here, and that
        // rule is not restated in this module.
        assertJoinable(conference, clock.today());
      } catch (refusal) {
        await failedAttempts.record(caller.sub);
        throw refusal;
      }

      await repository.joinAsAttendee(conference.id, caller.sub);

      // Names the Conference joined, which is the whole point of the code having selected one. What
      // the Attendee then sees is S06's; this request ends at the Membership existing.
      return {
        conference: {
          id: conference.id,
          name: conference.name,
          startDate: conference.startDate,
          endDate: conference.endDate,
          lifecycleState: conference.lifecycleState,
        },
      };
    }),
  });

  app.get('/api/conferences/:conferenceId/join-code', {
    schema: { params: conferenceParamsSchema },
    handler: withAuth(async (request, caller) =>
      codeToWire(await loadAdministered(request, caller)),
    ),
  });

  /**
   * A new code, effective immediately.
   *
   * The old one is not retained, so from the next request it is refused exactly like a code nobody
   * ever issued. No Membership is touched – regenerating is not a way to clear the room (FR3).
   */
  app.post('/api/conferences/:conferenceId/join-code/regenerate', {
    schema: { params: conferenceParamsSchema },
    handler: withAuth(async (request, caller) => {
      const conference = await loadAdministered(request, caller);

      // A draft has no code to replace, and minting one here would hand out a code for a Conference
      // no attendee may join. Publishing is what mints it.
      if (conference.joinCode === null) {
        throw new AppError(
          ERROR_CODES.JOIN_CONFERENCE_NOT_PUBLISHED,
          409,
          `"${conference.name}" has no join code yet because it has not been published. ` +
            'Publishing it creates one.',
        );
      }

      return codeToWire(await repository.regenerateJoinCode(conference.id));
    }),
  });
}
