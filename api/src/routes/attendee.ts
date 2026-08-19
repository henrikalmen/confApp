import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WithAuth, AuthenticatedCaller } from '../auth/with-auth.ts';
import { AppError, ERROR_CODES } from '../errors.ts';
import type { Clock } from '../conferences/calendar-date.ts';
import type { ConferenceAuthorization } from '../conferences/authorization.ts';
import type { Conference, ConferenceRepository } from '../conferences/conference-repository.ts';
import { chooseDefaultConference } from '../conferences/attendee-conferences.ts';
import type { SessionRepository } from '../sessions/session-repository.ts';
import { buildScheduleEnvelope } from '../sessions/schedule-envelope.ts';

/**
 * The Attendee's two endpoints: which Conferences they can read, and one Conference's Schedule.
 *
 * Both run the same two steps in the same order: `withAuth` resolves the caller (S02), and the
 * per-Conference decision goes through S03's provisional authorization module – never an inline
 * `membership` comparison in a handler body, so S07 replaces one implementation rather than a hunt
 * through handlers.
 *
 * **These are not the Organizer's endpoints, and they are not a variant of them.** `GET /conferences`
 * is S03 TI06's Organizer list – the Conferences the caller holds a Role Assignment for, drafts
 * included – and `GET /conferences/:id/schedule/organizer` is S04's composition view. The attendee
 * result sets are genuinely different (joined, and published-or-archived), which is why they live
 * here on their own routes. Neither pair is to be merged, and neither is to be reachable by a query
 * parameter that switches the other's semantics: a reader seeing four endpoints should see four
 * intended endpoints (S06 → Constraints & Gotchas; S03 records the split from its side).
 *
 * Nothing is remembered between requests – no envelope, no clock anchor, no overlap result. The API
 * runs as several container replicas with no request affinity (ADR-004), so anything held here would
 * be absent on the next request anyway.
 */

export interface AttendeeRouteDependencies {
  withAuth: WithAuth;
  conferences: ConferenceRepository;
  sessions: SessionRepository;
  authorization: ConferenceAuthorization;
  clock: Clock;
}

const conferenceParamsSchema = {
  type: 'object',
  required: ['conferenceId'],
  properties: { conferenceId: { type: 'string', format: 'uuid' } },
} as const;

interface ConferenceParams {
  conferenceId: string;
}

/**
 * The Conference is in the caller's list but is still a draft.
 *
 * Refused **even to its own Admin**, deliberately. The attendee validation rule is joined *and*
 * published-or-archived (FR4 → Validation), and an Admin previewing their draft through the
 * attendee surface would be reading a schedule that no attendee can see – the Organizer reads a
 * draft through the composition view, which is the surface that can also change it.
 */
function notReadable(name: string): AppError {
  return new AppError(
    ERROR_CODES.CONFERENCE_NOT_READABLE,
    409,
    `"${name}" has not been published yet, so there is no schedule to show. ` +
      'The organizer publishes it when the programme is ready.',
  );
}

export function registerAttendeeRoutes(
  app: FastifyInstance,
  { withAuth, conferences, sessions, authorization, clock }: AttendeeRouteDependencies,
): void {
  /**
   * The **Attendee** list, with the default already chosen.
   *
   * The default is named outright rather than implied by list order: the rule ("the one running
   * today, else the most recently joined") is the server's, and a client re-deriving it would be a
   * second copy of it in three shells.
   */
  app.get(
    '/api/me/conferences',
    withAuth(async (_request, caller) => {
      // Resolved on the verified `sub`, joined against `app_user.sub`. `userId` is confApp's local
      // surrogate and is never a join key; email is never a key at all (ADR-002).
      const readable = await conferences.listJoinedAndReadable(caller.sub);

      // The server's own calendar day, read now rather than remembered – a replica that started
      // yesterday must still pick today's conference.
      const chosen = chooseDefaultConference(readable, clock.today());

      return {
        conferences: readable.map((conference) => ({
          id: conference.id,
          name: conference.name,
          startDate: conference.startDate,
          endDate: conference.endDate,
          // Named `state` to match the schedule envelope, which pins the field (S06 → Technical
          // Overview). The Organizer wire calls it `lifecycleState`; the two surfaces have separate
          // shapes on purpose and the attendee ones are consistent with each other.
          state: conference.lifecycleState,
        })),
        defaultConferenceId: chosen?.id ?? null,
      };
    }),
  );

  /**
   * The one readability decision, made once and shared by both attendee reads.
   *
   * The order of the two refusals is load-bearing. Membership is decided **first**, so a caller who
   * has not joined is told exactly that and learns nothing further – not whether the id is real, not
   * what state the Conference is in. Checking the lifecycle first would answer "not published yet"
   * to anyone who guessed a uuid, disclosing both that the Conference exists and what it is doing.
   * Neither refusal carries any Session content.
   *
   * S09's watermark poll goes through this same helper rather than a check of its own. A poll that
   * answered where the schedule read refuses – or refused where it answers – would be a second,
   * divergent opinion about who may read a Conference, and the client polls precisely so it can
   * refetch the schedule: the two must agree by construction.
   */
  async function loadReadable(
    request: FastifyRequest,
    caller: AuthenticatedCaller,
  ): Promise<{ conference: Conference; watermark: string | null }> {
    const { conferenceId } = request.params as ConferenceParams;

    await authorization.requireMembership(caller, conferenceId);

    /*
     * The watermark is read **before** the Conference row, and before the Session list, and the
     * order is load-bearing in one direction only.
     *
     * These are separate statements with no transaction, so a write can land between any two. Read
     * this way the envelope may carry a watermark slightly *older* than the data beside it, which
     * costs one wasted refetch on the next poll and then agrees. Read the other way round it carries
     * a *newer* watermark over older data - and the client stores that value as its comparison
     * basis, so every later poll compares equal and the change never arrives. Silently, for the rest
     * of the conference. Stale-low is self-correcting; stale-high is not.
     *
     * This matters for the Conference row too, not only the Session list: the watermark advances on
     * a name, date-span or lifecycle change, and a stale span drops Sessions from the envelope
     * outright, because the days they sit on are no longer emitted.
     */
    const watermark = await sessions.scheduleWatermark(conferenceId);

    const conference = await conferences.findById(conferenceId);
    if (conference === null) {
      // Reachable only where the Conference was removed between the two reads: the caller held a
      // Membership a moment ago, so they are entitled to be told it is gone.
      throw new AppError(
        ERROR_CODES.CONFERENCE_NOT_FOUND,
        404,
        'That conference no longer exists.',
      );
    }

    // Archived Conferences read successfully and the envelope marks the state – archiving makes a
    // Conference read-only, not invisible (FR9). Only a draft is refused.
    if (conference.lifecycleState === 'draft') throw notReadable(conference.name);

    return { conference, watermark };
  }

  /**
   * The Attendee's Schedule read: the envelope pinned in S06 → Technical Overview, and nothing else.
   */
  app.get('/api/conferences/:conferenceId/schedule', {
    schema: { params: conferenceParamsSchema },
    handler: withAuth(async (request, caller) => {
      const { conference, watermark } = await loadReadable(request, caller);

      /*
       * One query for the Sessions, whatever the span (TI03). A per-day or per-Session round trip
       * would put the p95 render budget S12 measures out of reach before it was ever measured, and
       * would give S10 a payload it could not cache as one thing.
       */
      const schedule = await sessions.listForConference(conference.id);

      // `serverNow` is taken once, here, and carried into the envelope – both frames from one
      // reading, so a request landing on the stroke of midnight cannot report today's day beside
      // tomorrow's instant.
      return buildScheduleEnvelope(conference, schedule, watermark, clock.now());
    }),
  });

  /**
   * The **watermark poll** – how an open Schedule finds out it has gone stale (S09 TI01).
   *
   * Two scalars and nothing else. This is the endpoint every attendee's phone hits every few
   * seconds for the length of a conference, so its cost is the story's capacity case: a client
   * compares `lastUpdatedAt` with the value on the envelope it is already rendering and refetches
   * the Schedule *only* when it has moved. Returning any Session content here would make the poll
   * as expensive as the thing it exists to avoid, and would give a client a second, smaller
   * schedule shape to merge – which is the delta format S09 deliberately does not have.
   *
   * `lastUpdatedAt` is S04's `schedule_watermark_at`, under the name S06's envelope gives it. It
   * advances on a Conference field change and on any Session insert, update **or delete**, which is
   * what makes a deletion – a change that leaves no row behind to notice – observable to a polling
   * client. It is emphatically not `conference.updated_at`: that column is the Conference row's own
   * version and is untouched by every Session write, so polling it would miss the whole schedule.
   *
   * `state` rides along because archiving is a change an open Schedule must notice too, and the
   * client already has to read this response to decide whether to refetch.
   *
   * Nothing is remembered between polls. The watermark is read from the database on every request –
   * never a counter held in the handler, which would be absent on the next replica anyway (ADR-004).
   */
  app.get('/api/conferences/:conferenceId/schedule/watermark', {
    schema: { params: conferenceParamsSchema },
    handler: withAuth(async (request, caller) => {
      const { conference, watermark } = await loadReadable(request, caller);

      return { lastUpdatedAt: watermark, state: conference.lifecycleState };
    }),
  });
}
