import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuthenticatedCaller, WithAuth } from '../auth/with-auth.ts';
import { AppError, ERROR_CODES } from '../errors.ts';
import type { ConferenceAuthorization } from '../conferences/authorization.ts';
import type { Conference, ConferenceRepository } from '../conferences/conference-repository.ts';
import { assertEditable, isDraft, isEditable } from '../conferences/lifecycle.ts';
import type { Session, SessionRepository } from '../sessions/session-repository.ts';
import { toWire as sessionToWire } from './sessions.ts';
import { assertPollContentEditable, type BallotGate } from '../rounds/ballot-gate.ts';
import type { Round, RoundRepository, TransitionResult } from '../rounds/round-repository.ts';
import {
  isRoundKind,
  validateRoundDetails,
  type RoundDetailsInput,
} from '../rounds/round-validation.ts';
import type { PostIt, PostItRepository, PostItWriteOutcome } from '../rounds/post-it-repository.ts';
import {
  POST_IT_MAX_LENGTH,
  validatePostItText,
  type PostItTextInput,
} from '../rounds/post-it-validation.ts';
import type { CastOutcome, OptionTally, VoteRepository } from '../votes/vote-repository.ts';

/**
 * The Session Activities endpoints: authoring a Round, editing one, running one, and the single
 * read that answers a Session with its Rounds.
 *
 * Every one runs the same steps in the same order as `registerSessionRoutes`: `withAuth` resolves
 * the caller (S02); the per-Conference decision goes through `requireConferenceRole` /
 * `requireMembership` – never an inline role, membership or assignment comparison in a handler
 * body; and the lifecycle module decides whether a change is legal in the Conference's current
 * state, read fresh from the database on this request.
 *
 * **The authority split this story establishes** (`plan.json#sharedDecisions`): reading a Session's
 * Rounds needs **Membership**, because every Conference Member sits in the room. Authoring, editing
 * and every open/close transition need a **Session Assignment** for *this* Session, expressed as
 * `requireConferenceRole(..., 'PresenterFacilitator', { sessionId })` – the same narrowing S07
 * built, not a per-Activity authority of its own. An Admin passes on conference-wide authority.
 *
 * The acting identity comes from the verified credential and from nowhere else. No request body
 * field here names or influences who is acting (Binding Constraint FR3).
 *
 * **Exactly one cursor leaves this module, and no Round carries it.** Near-live propagation is
 * `round.activity_watermark` (`plan.json#sharedDecisions` -> "Near-live propagation: one cursor"),
 * and it reaches a client in exactly two shapes: one Session-level scalar beside the Session read,
 * and the same scalar alone on the two-scalar poll below. It is deliberately not a field on a
 * Round: a per-Round cursor is one a client would poll per Round, which is the second mechanism
 * that decision removed.
 *
 * **That cursor carries nothing vote-derived, and it is not an instant** - both are security
 * properties rather than formatting choices. The poll below is Membership-gated, so an Attendee who
 * is deliberately refused a running Poll's tally can hold it open for the whole Session. A
 * timestamp there handed them the instant of every Vote cast
 * (`db/migrations/20260829120000000_activity-watermark-counter.sql` replaced it with an opaque
 * counter, and records what that does and does not close); the ballot trigger then handed them the
 * *arrival* of every Vote, whatever the value said, and was dropped for it
 * (`db/migrations/20260831090000000_vote-advances-no-cursor.sql`, ADR-007).
 *
 * **S02 adds the named contribution path.** Contributing, correcting and removing a Post-it need
 * **Membership** - the other half of the authority split, applied here rather than reinvented per
 * Activity - and the author is `caller.sub` on every one of them. No body field on any route in
 * this module names or influences who is acting (Binding Constraint FR3); the Post-it body schema
 * accepts an author-ish property without refusing it and then never reads it, which is what makes
 * it *inert* rather than merely unused.
 *
 * Nothing is remembered between requests – no Round list, no board, no watermark, no authority
 * decision, no per-author count. The API runs as several container replicas with no request
 * affinity (ADR-004).
 */

export interface RoundRouteDependencies {
  withAuth: WithAuth;
  conferences: ConferenceRepository;
  sessions: SessionRepository;
  rounds: RoundRepository;
  postIts: PostItRepository;
  votes: VoteRepository;
  authorization: ConferenceAuthorization;
  /** "Does this Round have a Vote yet" – the Poll freeze's only question. See `ballot-gate.ts`. */
  ballotGate: BallotGate;
}

/** Shape only. The business rules live in round-validation.ts. */
const roundBodySchema = {
  type: 'object',
  required: ['kind', 'prompt'],
  additionalProperties: false,
  properties: {
    kind: { type: 'string' },
    purpose: { type: ['string', 'null'] },
    prompt: { type: 'string' },
    options: { type: 'array', items: { type: 'string' } },
  },
} as const;

const sessionParamsSchema = {
  type: 'object',
  required: ['conferenceId', 'sessionId'],
  properties: {
    conferenceId: { type: 'string', format: 'uuid' },
    sessionId: { type: 'string', format: 'uuid' },
  },
} as const;

const roundParamsSchema = {
  type: 'object',
  required: ['conferenceId', 'sessionId', 'roundId'],
  properties: {
    conferenceId: { type: 'string', format: 'uuid' },
    sessionId: { type: 'string', format: 'uuid' },
    roundId: { type: 'string', format: 'uuid' },
  },
} as const;

const postItParamsSchema = {
  type: 'object',
  required: ['conferenceId', 'sessionId', 'roundId', 'postItId'],
  properties: {
    conferenceId: { type: 'string', format: 'uuid' },
    sessionId: { type: 'string', format: 'uuid' },
    roundId: { type: 'string', format: 'uuid' },
    postItId: { type: 'string', format: 'uuid' },
  },
} as const;

/**
 * Shape only, and deliberately **not** `additionalProperties: false`.
 *
 * A request carrying `authorSub` or `authorName` is accepted and its author fields are never read
 * - the contribution lands under the caller's own credential, which is the observable Binding
 * Constraint FR3 actually demands. Refusing the request instead would prove nothing about where
 * authorship comes from: a route that refuses an author field and a route that trusts one both
 * pass "does not accept a body with an author in it", and only one of them is correct. Ignored is
 * the stronger statement, and it is asserted behaviourally in `post-it.integration.test.ts`.
 *
 * `text` is the only property this schema names, and the business rules on top of that shape live
 * in `post-it-validation.ts`.
 */
const postItBodySchema = {
  type: 'object',
  required: ['text'],
  properties: {
    text: { type: 'string' },
  },
} as const;

/**
 * The same body, plus the two facts a Post-it composed with no connection carries (FR6).
 *
 * Its own schema rather than two more optional properties on the one above, because only the
 * *contribution* has an arrival: correcting a Post-it that is already on the board is a live write
 * with a row to guard and nothing to say about how it got here.
 *
 * `offlineComposed` unlocks the closed-Round branch and nothing else. It is an assertion the server
 * cannot verify - see `Arrival` in `post-it-repository.ts` for why that is accepted rather than
 * defended against, and why no refusal path exists for it.
 *
 * `submissionId` is `format: 'uuid'` so a malformed identity is refused as a bad request here
 * rather than reaching PostgreSQL as a `22P02` the caller reads as an internal error. The **text**
 * still goes through `validatePostItText` on arrival exactly as a live contribution does - a
 * queued Post-it is validated when it lands, by the one validation module, never by a second copy
 * on the device.
 */
const contributionBodySchema = {
  type: 'object',
  required: ['text'],
  properties: {
    text: { type: 'string' },
    offlineComposed: { type: 'boolean' },
    submissionId: { type: 'string', format: 'uuid' },
  },
} as const;

interface ContributionBody extends PostItTextInput {
  offlineComposed?: boolean;
  submissionId?: string;
}

/**
 * A ballot: which option, and nothing else.
 *
 * Deliberately **not** `additionalProperties: false`, for the same reason the post-it body is not.
 * A request carrying a `userSub`, a `voterSub` or an `email` is accepted and those fields are never
 * read - the Vote is recorded against the caller's own credential, which is the observable thing
 * Binding Constraint FR3 demands and the thing `vote.integration.test.ts` proves. Refusing such a
 * request instead would leave the actual rule untested: a route that refuses a voter field and a
 * route that trusts one both pass "does not accept a body with a voter in it".
 */
const voteBodySchema = {
  type: 'object',
  required: ['optionId'],
  properties: {
    optionId: { type: 'string', format: 'uuid' },
  },
} as const;

interface VoteBody {
  optionId: string;
}

interface SessionParams {
  conferenceId: string;
  sessionId: string;
}

interface RoundParams extends SessionParams {
  roundId: string;
}

interface PostItParams extends RoundParams {
  postItId: string;
}

/**
 * What one Poll adds to its Round on the wire, where it was looked up.
 *
 * Two facts and no third: whether **this** caller has voted, and the counts per option where this
 * caller may see them. `tally` is `null` for "not for you yet" rather than an empty list, and the
 * key is then omitted from the payload entirely – absence is not a zero.
 */
interface PollView {
  hasVoted: boolean;
  tally: OptionTally[] | null;
}

/**
 * What a Round looks like on the wire.
 *
 * `purpose` is present exactly on a `VotingRound` and `options` exactly on one too, so the payload
 * says the same thing the table's `round_purpose_matches_kind` constraint says. There is **no**
 * timestamp, version or cursor field of any name – see the module note.
 *
 * **The only Vote-shaped value this function can emit is a count per option.** There is no branch
 * here, and none anywhere in this module, that produces a ballot, a voter, or a per-voter fact
 * about anybody other than the caller (`AGENTS.md`: never attribute a vote to a voter).
 */
function toRoundWire(
  round: Round,
  viewerSub: string,
  board?: readonly PostIt[],
  poll?: PollView,
): Record<string, unknown> {
  return {
    id: round.id,
    kind: round.kind,
    ...(round.purpose === null ? {} : { purpose: round.purpose }),
    prompt: round.prompt,
    state: round.state,
    ...(round.kind === 'VotingRound'
      ? {
          options: round.options.map((option) => ({ id: option.id, label: option.label })),
          /*
           * No Poll view was loaded, so none is claimed - the same discipline as the board below.
           * The authoring and run-control responses answer about the Round itself and ask nothing
           * of the vote tables; saying `hasVoted: false` there would assert a fact about the
           * caller nobody looked up. A client that needs either re-reads the Session, which is
           * what the panel already does.
           */
          ...(poll === undefined
            ? {}
            : {
                /*
                 * Whether **this** caller has voted, which is the only thing anyone is ever told
                 * about who voted. There is no field here, and no endpoint anywhere, that names
                 * another Member's participation.
                 */
                hasVoted: poll.hasVoted,
                /*
                 * Counts per option and nothing else, and present only where the gate permits it:
                 * to a Session Assignment holder while the Poll runs, and to every Member once it
                 * closes. For an Attendee on an open Poll the key is simply absent - not a zeroed
                 * tally, which would be a statement about the votes.
                 */
                ...(poll.tally === null ? {} : { tally: poll.tally }),
              }),
        }
      : board === undefined
        ? /*
           * No board was loaded, so none is claimed. The authoring and run-control responses answer
           * about the Round itself and never read its Post-its; saying `postIts: []` there would
           * assert an empty board the caller has no reason to believe, and a Round with a board would
           * be described as having none. Both properties are optional on the wire shape, and a
           * client that needs the board re-reads the Session - which is what the panel already does.
           */
          {}
        : {
            /*
             * The whole board, in the same response as the Round it belongs to - one request for a
             * Session and everything in it (prd.md#non-functional-requirements). A closed Round's
             * board comes back in full: closing stops contribution, it does not hide what the room
             * produced.
             *
             * `textMaxLength` rides along so the compose box can state the limit without carrying
             * a number of its own. It is `POST_IT_MAX_LENGTH`, interpolated - the client renders
             * what the payload hands it, which is why no cap literal exists under `web/` anywhere.
             */
            postIts: board.map((postIt) => toPostItWire(postIt, viewerSub)),
            textMaxLength: POST_IT_MAX_LENGTH,
          }),
  };
}

/**
 * One Post-it as the board reads it.
 *
 * The author's **name** is here and their `sub` is not. The name is what the room reads and is
 * joined from `app_user.display_name` on this read, so a rename reaches every Post-it its owner
 * ever wrote. The `sub` is an identity confApp has no reason to publish to every Member in the
 * room, and `mine` answers the only question a client has of it - the same discipline as `canRun`:
 * the server's answer, consumed rather than re-derived, so no second client-side opinion about who
 * may correct a Post-it can drift out of step with the predicate that actually enforces it.
 *
 * `edited` is a boolean and `edited_at` deliberately stays in the database. The instant is the
 * stored fact and the flag is what the board shows; putting the instant on the wire would hand a
 * client a timestamp it could only render by converting a timezone the product does not carry
 * (S09's `AttendeeScheduleRefresh` guard), and a board of "13:42" readings would contradict every
 * Session time beside it on a device set away from the venue. Order is the payload's order.
 */
function toPostItWire(postIt: PostIt, viewerSub: string): Record<string, unknown> {
  return {
    id: postIt.id,
    text: postIt.text,
    authorName: postIt.authorName,
    mine: postIt.authorSub === viewerSub,
    edited: postIt.editedAt !== null,
    /*
     * Rides the Post-it in the read model everything already uses, so every surface that shows a
     * Post-it shows this too - there is no separate late-arrivals list and no second read path
     * (FR6). It is the server's answer, computed from the Round's state at the instant the row was
     * written; no client re-derives it and none could.
     */
    arrivedAfterClose: postIt.arrivedAfterClose,
  };
}

/**
 * The refusal a person reads when the Round has stopped taking contributions.
 *
 * Its own code, not `ROUND_TRANSITION_NOT_PERMITTED`. That one answers a Facilitator working the
 * run controls ("a poll cannot be reopened once its results are shown"); this one answers a
 * Member whose Round closed while they were typing, and their next move is different - the text is
 * still in the box, and it goes back up if the Round reopens.
 *
 * `409`, because it is a state conflict rather than a malformed request: nothing about what was
 * sent is wrong.
 */
function roundClosed(): AppError {
  return new AppError(
    ERROR_CODES.POST_IT_ROUND_CLOSED,
    409,
    'This round is closed, so it is not taking post-its at the moment.',
  );
}

/** The Round has ended, said to somebody trying to change a post-it that is already on it. */
function roundEnded(): AppError {
  return new AppError(
    ERROR_CODES.POST_IT_ROUND_CLOSED,
    409,
    'This round has ended, so its post-its can no longer be changed.',
  );
}

function postItNotFound(): AppError {
  return new AppError(
    ERROR_CODES.POST_IT_NOT_FOUND,
    404,
    'That post-it is no longer on this round.',
  );
}

function notTheAuthor(): AppError {
  return new AppError(
    ERROR_CODES.POST_IT_NOT_AUTHOR,
    403,
    'Only the person who wrote a post-it can change or remove it.',
  );
}

/**
 * The one place a guarded write's outcome becomes a refusal.
 *
 * Shared by the edit and the delete so the two cannot drift into naming the same situation
 * differently - "not yours" and "the round has ended" are the two sentences FR3 asks for, and they
 * are produced here once.
 */
function refuseWrite(outcome: PostItWriteOutcome): never {
  if (outcome.outcome === 'not-author') throw notTheAuthor();
  if (outcome.outcome === 'round-closed') throw roundEnded();
  // 'missing', and the two success outcomes a caller only reaches here by mistake: the post-it is
  // not where the caller thinks it is, which is what their next read will find anyway.
  throw postItNotFound();
}

function roundNotFound(): AppError {
  return new AppError(
    ERROR_CODES.ROUND_NOT_FOUND,
    404,
    'That round no longer exists on this session.',
  );
}

/**
 * Why a cast matched nothing, as the sentence the voter reads.
 *
 * The one place a cast refusal is built, so no caller can produce a variant – and **not one of
 * these four bodies carries a count, a total or any per-option data**. A duplicate-vote refusal
 * that helpfully returned the tally would hand the result to somebody the result is deliberately
 * withheld from, through the one response nobody thinks to inspect (FIS -> Constraints & Gotchas).
 * `AppError` has no field for one; this function passes none.
 */
function refuseCast(outcome: CastOutcome): never {
  if (outcome.outcome === 'already-voted') {
    throw new AppError(
      ERROR_CODES.VOTE_ALREADY_CAST,
      409,
      'You have already voted in this poll. A vote is final once it is cast, so it cannot be ' +
        'changed or withdrawn.',
    );
  }
  if (outcome.outcome === 'round-closed') {
    throw new AppError(
      ERROR_CODES.VOTING_ROUND_CLOSED,
      409,
      'This poll has closed, so it is no longer taking votes. Its result is on the session.',
    );
  }
  if (outcome.outcome === 'unknown-option') {
    throw new AppError(
      ERROR_CODES.VOTE_OPTION_UNKNOWN,
      400,
      'That answer is not one of this poll’s options. Reload the session and choose again.',
    );
  }
  // 'missing', and the success outcome a caller only reaches here by mistake: there is no poll of
  // that id on this session, which is what their next read will find anyway.
  throw roundNotFound();
}

/**
 * The tally was asked for while the Poll is still running, by somebody who does not run it.
 *
 * Refused rather than answered with an empty or zeroed tally, deliberately
 * (`prd.md#fr5-poll-result-reveal`): a zero mid-Poll is a statement about the votes, and once
 * absence can be distinguished from "no votes yet" it carries information. `403`, because the
 * caller is entitled to be here and what refused them is timing.
 */
function resultsNotYetAvailable(): AppError {
  return new AppError(
    ERROR_CODES.POLL_RESULTS_NOT_YET_AVAILABLE,
    403,
    'The results of this poll appear when voting ends.',
  );
}

/**
 * The refusal a room needs when a Poll is asked to run again.
 *
 * The sentence is FR2's, verbatim, and the code is distinct from CONFERENCE_ROLE_REQUIRED: "you may
 * not do this" and "this poll has already shown its results" are two different situations and the
 * Facilitator's next move differs. A closed Poll's result stays on screen; there is nothing to
 * retry.
 */
function transitionNotPermitted(): AppError {
  return new AppError(
    ERROR_CODES.ROUND_TRANSITION_NOT_PERMITTED,
    409,
    'A poll cannot be reopened once its results are shown.',
  );
}

/**
 * A Round's kind and purpose are what it *is*, and an edit cannot change them.
 *
 * Refused rather than ignored. A Post-it Round that became a Poll would be a different Activity
 * wearing the first one's identity, and every Post-it or Vote already pointing at it would be
 * pointing at something it never was. Silently applying the prompt and dropping the kind would be
 * worse still: the editor would be told the change landed.
 */
function assertSameActivity(existing: Round, body: RoundDetailsInput): void {
  /*
   * An *unknown* kind is not an immutability refusal – it is a bad field value, and
   * `validateRoundDetails` below names it as one. Returning here rather than refusing is what keeps
   * "Poll is not a kind" from being reported as "the kind cannot be changed", which would send the
   * caller looking for a rule instead of a typo.
   */
  if (!isRoundKind(body.kind)) return;

  const purpose = body.purpose ?? null;
  if (body.kind === existing.kind && purpose === existing.purpose) return;

  const message =
    'The kind and purpose of a round are fixed when it is created, so they cannot be changed ' +
    'here. Add a new round instead.';
  throw new AppError(ERROR_CODES.ROUND_KIND_IMMUTABLE, 409, message, [{ field: 'kind', message }]);
}

function requireTransitioned(result: TransitionResult): Round {
  if (result.outcome === 'changed') return result.round;
  if (result.outcome === 'missing') throw roundNotFound();
  throw transitionNotPermitted();
}

export function registerRoundRoutes(
  app: FastifyInstance,
  {
    withAuth,
    conferences,
    sessions,
    rounds,
    postIts,
    votes,
    authorization,
    ballotGate,
  }: RoundRouteDependencies,
): void {
  /** The Conference named in the route, or the refusal that it is gone. */
  async function loadConference(conferenceId: string): Promise<Conference> {
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

  /** The Session named in the route, or the refusal that it is gone. */
  async function loadSession(conferenceId: string, sessionId: string): Promise<Session> {
    const session = await sessions.findById(conferenceId, sessionId);
    if (session === null) {
      throw new AppError(
        ERROR_CODES.SESSION_NOT_FOUND,
        404,
        'That session no longer exists in this conference.',
      );
    }
    return session;
  }

  /**
   * A write to a Session's Activities: authorized through the Session Assignment narrowing, and
   * refused outright on an archived Conference.
   *
   * Authorization runs **first**, so a caller with no authority learns nothing further – not
   * whether the Session exists, not what state the Conference is in. A transition is a write like
   * any other, so `assertEditable` gates open and close as well as authoring (PRD FR2 -> Error
   * Handling).
   */
  async function authorizeWrite(
    request: FastifyRequest,
    caller: AuthenticatedCaller,
  ): Promise<{ conference: Conference; session: Session }> {
    const { conferenceId, sessionId } = request.params as SessionParams;
    await authorization.requireConferenceRole(caller, conferenceId, 'PresenterFacilitator', {
      sessionId,
    });

    const conference = await loadConference(conferenceId);
    assertEditable(conference);

    return { conference, session: await loadSession(conferenceId, sessionId) };
  }

  /**
   * A **contribution** to a Session's Activities: the other half of the authority split.
   *
   * Membership, not a Session Assignment - every Conference Member sits in the room and every one
   * of them may put an idea on the board (`plan.json#sharedDecisions` -> "Authorization split:
   * Membership contributes, Session Assignment runs"). The split is applied here rather than
   * invented per Activity, which is why this reads the same as the Session read's gate rather than
   * anything Post-it-shaped.
   *
   * Membership is decided **first**, so a caller who has not joined is told exactly that and learns
   * nothing further - not whether the Session exists, not what state the Conference is in.
   * `assertEditable` then refuses on an archived Conference: archiving makes a Conference read-only
   * (FR9), and a board is not exempt from that.
   *
   * Whether the *Round* is open is deliberately **not** decided here. That guard lives in the write
   * statement's own predicate (`post-it-repository.ts`), because a Round closing between a check
   * here and a write there is exactly the window this API does not have.
   */
  async function authorizeContribution(
    request: FastifyRequest,
    caller: AuthenticatedCaller,
  ): Promise<Session> {
    const { conferenceId, sessionId } = request.params as SessionParams;

    await authorization.requireMembership(caller, conferenceId);

    const conference = await loadConference(conferenceId);
    if (isDraft(conference)) {
      // Same rule as the read: a draft has been published to nobody, and its own role holders are
      // the only people composing it.
      await authorization.requireConferenceRole(caller, conferenceId, 'PresenterFacilitator');
    }
    assertEditable(conference);

    return loadSession(conferenceId, sessionId);
  }

  /** The Round named in the route, on the Session already authorized. */
  async function loadRound(request: FastifyRequest): Promise<Round> {
    const { conferenceId, sessionId, roundId } = request.params as RoundParams;
    const round = await rounds.findById(conferenceId, sessionId, roundId);
    if (round === null) throw roundNotFound();
    return round;
  }

  /**
   * May *this* caller work the run controls on this Session?
   *
   * Asked through the same canonical check every write goes through, so the flag the client renders
   * from and the decision the server enforces cannot drift apart. The client consumes `canRun`; it
   * never re-derives authority, which is what stops a second, client-side opinion about who may run
   * a Round from existing at all.
   */
  /**
   * Does this caller hold a Session Assignment for this Session – the "runs it" half of the
   * authority split?
   *
   * The canonical check, asked as a question rather than as a refusal, so nothing re-derives
   * authority. Both `mayRun` and the open-Poll tally gate below are this one answer read for two
   * different purposes, which is what stops a second opinion about who runs a Session from
   * existing. An Admin passes on conference-wide authority.
   */
  async function holdsAssignment(
    caller: AuthenticatedCaller,
    conferenceId: string,
    sessionId: string,
  ): Promise<boolean> {
    try {
      await authorization.requireConferenceRole(caller, conferenceId, 'PresenterFacilitator', {
        sessionId,
      });
      return true;
    } catch (error) {
      // Only the authority refusal means "no". Anything else – the database being unreachable, for
      // instance – is a real failure and must not be reported to the room as "you are not allowed".
      if (error instanceof AppError && error.code === ERROR_CODES.CONFERENCE_ROLE_REQUIRED) {
        return false;
      }
      throw error;
    }
  }

  function mayRun(conference: Conference, assigned: boolean): boolean {
    /*
     * Editability first, and it is not a detail. Every write and every transition runs
     * `assertEditable` (see `authorizeWrite`), so on an archived Conference a `canRun` that answered
     * "yes, you hold the authority" would put a full set of live-looking run controls in front of an
     * organizer and refuse every one of them with a 409. The client is told it holds no second
     * opinion about who may run a Round; the flag it is handed therefore has to mean "these controls
     * will work", not "you would be allowed if anything here were writable".
     *
     * Reading an open Poll's tally is deliberately **not** gated on this. Watching the result build
     * is a read, not a control, and an archived Conference is read-only rather than invisible – so
     * the tally gate below asks `holdsAssignment` directly.
     */
    return isEditable(conference) && assigned;
  }

  /**
   * One Session, its Rounds and this caller's authority over them – **one request** (TI07).
   *
   * Gated on Membership, so every Conference Member in the room reads it. A draft Conference is
   * readable only to a Role Assignment holder, the same rule the rest of the app applies to a
   * Conference nothing has been published from yet.
   *
   * Deliberately **not** folded into the attendee schedule envelope. S10 caches that envelope
   * verbatim, so a Round field there would become offline scope by construction – which Binding
   * Constraint FR6 forbids – and every Round state change would advance
   * `conference.schedule_watermark_at` and fire S09's "what changed" banner with nothing
   * schedule-shaped to report.
   */
  app.get('/api/conferences/:conferenceId/sessions/:sessionId', {
    schema: { params: sessionParamsSchema },
    handler: withAuth(async (request, caller) => {
      const { conferenceId, sessionId } = request.params as SessionParams;

      // Membership first, so a caller who has not joined is told exactly that and learns nothing
      // about whether the Conference or the Session exists.
      await authorization.requireMembership(caller, conferenceId);

      const conference = await loadConference(conferenceId);
      if (isDraft(conference)) {
        // A draft has been published to nobody. Its own role holders compose it; a plain member
        // who somehow joined one is refused with the authority sentence, not shown the programme.
        await authorization.requireConferenceRole(caller, conferenceId, 'PresenterFacilitator');
      }

      const session = await loadSession(conferenceId, sessionId);

      /*
       * The watermark is read **before** the Rounds and their boards, and the order is load-bearing
       * in one direction only - the same reasoning as `attendee.ts#loadReadable`, for the same
       * reason.
       *
       * These are separate statements with no transaction, so a write can land between any two.
       * Read this way the payload may carry a watermark slightly *older* than the board beside it,
       * which costs one wasted refetch on the next poll and then agrees. Read the other way round
       * it carries a *newer* watermark over an older board - and the client stores that value as
       * its comparison basis, so every later poll compares equal and the contribution never
       * arrives. Silently, for the rest of the session. Stale-low is self-correcting; stale-high
       * is not.
       */
      const activityWatermark = await rounds.activityWatermark(conferenceId, sessionId);

      /*
       * Four statements for the whole Session, never one per Round: the Rounds, every board, every
       * Poll's counts, and which Polls *this* caller has voted in. One read answers a Session and
       * everything in it (prd.md#non-functional-requirements), and a handler looping per Round is
       * the N+1 this project has already been bitten by.
       *
       * `votedRoundsFor` is asked about `caller.sub` and nobody else. It is the only question this
       * API ever puts to the has-voted table, and the payload turns it into a single boolean per
       * Round – so there is no path here, and no response shape, that says who else voted.
       */
      const [authored, boards, tallies, voted] = await Promise.all([
        rounds.listForSession(conferenceId, sessionId),
        postIts.listForSession(conferenceId, sessionId),
        votes.tallyForSession(conferenceId, sessionId),
        votes.votedRoundsFor(conferenceId, sessionId, caller.sub),
      ]);

      /*
       * Who may see a tally, decided once for the whole payload.
       *
       * While a Poll runs, only a Session Assignment holder; once it has closed, every Conference
       * Member, however long afterwards - the Membership that gated this read is the whole of that
       * permission (prd.md#fr5-poll-result-reveal). An Attendee looking at an open Poll gets the
       * has-voted flag and no `tally` key at all, which is an absent field rather than a zeroed
       * result: the refusal on the dedicated tally endpoint is what states the reason.
       */
      const assigned = await holdsAssignment(caller, conferenceId, sessionId);
      const pollView = (round: Round): PollView => ({
        hasVoted: voted.has(round.id),
        tally: round.state === 'closed' || assigned ? (tallies.get(round.id) ?? []) : null,
      });

      return {
        session: sessionToWire(session),
        rounds: authored.map((round) =>
          toRoundWire(
            round,
            caller.sub,
            boards.get(round.id) ?? [],
            round.kind === 'VotingRound' ? pollView(round) : undefined,
          ),
        ),
        canRun: mayRun(conference, assigned),
        /*
         * The Session's cursor, beside the payload it describes - the same arrangement as S06's
         * schedule envelope, which carries `conference.lastUpdatedAt` beside the Sessions it lists.
         * The client compares the poll below against this value and refetches only when the two
         * differ, which is what makes the poll two scalars rather than a whole board (S02 TI10).
         *
         * The *value* is not the same kind of thing as the schedule envelope's, and the name says
         * so: an opaque counter, never a time. `lastUpdatedAt` there is a real instant S09 also
         * uses as an optimistic-concurrency base; this one is compared for difference and nothing
         * else.
         */
        activityWatermark,
      };
    }),
  });

  /**
   * The **activity watermark poll** – how an open Round view finds out the board has moved (TI07).
   *
   * Two scalars and nothing else, shaped like `/schedule/watermark` and for the same capacity
   * reasons. This is the endpoint every phone in a workshop hits every few seconds: a client
   * compares `activityWatermark` here with the one on the payload it is already rendering and
   * refetches the Session *only* when the two differ. Returning a Round or a Post-it here would
   * make the poll as expensive as the thing it exists to avoid, and would give a client a second,
   * smaller shape to merge - which is the delta format this bundle deliberately does not have.
   *
   * **What it advances on is what makes this route safe to leave open to every Member.** It is the
   * highest `round.activity_watermark` across the Session's Rounds - a global sequence's `nextval`
   * - and it advances on every Round write, every Post-it insert, update **or delete**, and every
   * option write. A removal leaves no row behind to notice, which is why the delete cases matter.
   *
   * **A cast Vote advances nothing** (ADR-007,
   * `db/migrations/20260831090000000_vote-advances-no-cursor.sql`). It used to, and because this
   * value is scoped to one Session, on a Session running only a Poll every movement of it was a
   * ballot arriving - readable here by the very Attendee `prd.md#fr5-poll-result-reveal` refuses
   * the running tally, at whatever rate they chose to poll. Making the value opaque
   * (`20260829120000000_activity-watermark-counter.sql`) addressed what it says and left when it
   * moves; the trigger was dropped rather than gated, so no vote-derived value remains here for a
   * later change to re-expose. A Session Assignment holder's live tally is delivered by refetching
   * the Session read on the client's existing tick instead.
   *
   * Closing a Poll is a Round write, so **reveal-on-close still moves this value** and still
   * reaches every Member near-live.
   *
   * Membership-gated, like the read it exists to trigger. A poll that answered where the read
   * refuses, or refused where it answers, would be a second opinion about who may see a Session.
   *
   * Nothing is remembered between polls; the counter is read from the database on every request
   * (ADR-004).
   */
  app.get('/api/conferences/:conferenceId/sessions/:sessionId/activities/watermark', {
    schema: { params: sessionParamsSchema },
    handler: withAuth(async (request, caller) => {
      const { conferenceId, sessionId } = request.params as SessionParams;

      await authorization.requireMembership(caller, conferenceId);

      // The counter first, then the state beside it - see the read above.
      const activityWatermark = await rounds.activityWatermark(conferenceId, sessionId);
      const conference = await loadConference(conferenceId);

      return { activityWatermark, state: conference.lifecycleState };
    }),
  });

  /**
   * Authoring a Round, ahead of the Session and without typing in front of the room (US01).
   *
   * The Round is created **closed**: the state is the table's default, not something this handler
   * chooses, so no write path can produce one that is already running.
   */
  app.post('/api/conferences/:conferenceId/sessions/:sessionId/rounds', {
    schema: { params: sessionParamsSchema, body: roundBodySchema },
    handler: withAuth(async (request, caller) => {
      const { session } = await authorizeWrite(request, caller);

      // Validation before any write, so a refused request persists nothing.
      const details = validateRoundDetails(request.body as RoundDetailsInput);
      const created = await rounds.create(session.conferenceId, session.id, details);

      return { round: toRoundWire(created, caller.sub) };
    }),
  });

  /**
   * Editing what a Round asks.
   *
   * A Post-it Round's prompt is editable at any time, open or closed, before or after contributions
   * exist – post-its are free text and stand on their own (FR1). A Poll's question and options are
   * refused once its first Vote exists, and that decision is made in exactly one place:
   * `assertPollContentEditable`. There is no second freeze rule, constant or flag anywhere on this
   * path, which is what lets S03 TI08 discharge the obligation by replacing one function body.
   */
  app.patch('/api/conferences/:conferenceId/sessions/:sessionId/rounds/:roundId', {
    schema: { params: roundParamsSchema, body: roundBodySchema },
    handler: withAuth(async (request, caller) => {
      const { session } = await authorizeWrite(request, caller);
      const existing = await loadRound(request);

      /*
       * What the Round *is* is checked before what it says. A caller trying to turn a Post-it Round
       * into a Poll would otherwise be refused for having sent too few options – advice about a
       * change that was never going to be accepted.
       */
      const body = request.body as RoundDetailsInput;
      assertSameActivity(existing, body);

      const details = validateRoundDetails(body);

      /*
       * The freeze rule, asked **inside** the write's transaction and after its row lock.
       *
       * Still the one guard, still `assertPollContentEditable` and no second statement of the rule
       * anywhere - what changed is only where it runs. Asked out here, as S01 asked it, a Vote
       * landing between the answer and the UPDATE would let the edit through after the freeze
       * should have applied (S03 TI08, `poll-freeze-toctou-discharge`). The refusal it throws is
       * S01's, unchanged, and rolls the transaction back so a refused edit persists nothing.
       */
      const saved = await rounds.updateContent(
        session.conferenceId,
        session.id,
        existing.id,
        details,
        (round, tx) => assertPollContentEditable(ballotGate, round, tx),
      );
      if (saved === null) throw roundNotFound();

      return { round: toRoundWire(saved, caller.sub) };
    }),
  });

  /**
   * Opening a Round – and reopening one, which is the same transition asked twice.
   *
   * Several Rounds in a Session may be open at once (FR2), so nothing here closes another Round as
   * a side effect. Whether a Poll may run again is decided by the repository's own UPDATE
   * predicate, never re-implemented here.
   */
  app.post('/api/conferences/:conferenceId/sessions/:sessionId/rounds/:roundId/open', {
    schema: { params: roundParamsSchema },
    handler: withAuth(async (request, caller) => {
      const { session } = await authorizeWrite(request, caller);
      const { roundId } = request.params as RoundParams;

      return {
        round: toRoundWire(
          requireTransitioned(await rounds.open(session.conferenceId, session.id, roundId)),
          caller.sub,
        ),
      };
    }),
  });

  app.post('/api/conferences/:conferenceId/sessions/:sessionId/rounds/:roundId/close', {
    schema: { params: roundParamsSchema },
    handler: withAuth(async (request, caller) => {
      const { session } = await authorizeWrite(request, caller);
      const { roundId } = request.params as RoundParams;

      return {
        round: toRoundWire(
          requireTransitioned(await rounds.close(session.conferenceId, session.id, roundId)),
          caller.sub,
        ),
      };
    }),
  });

  /**
   * Putting a named idea on the board (US03, TI04).
   *
   * **The author is `caller.sub` and nothing else** (Binding Constraint FR3). The body carries
   * `text`; anything else it happens to carry - an `authorSub`, an `authorName` - is accepted by
   * the schema and then never read, so a request claiming to be from somebody else lands under the
   * caller's own name rather than being refused for a reason that would leave the actual rule
   * untested. The repository is handed a `sub` as a parameter, so there is no path by which a
   * request field could reach the column.
   *
   * The Round-is-open guard is the INSERT's own predicate, so a Facilitator closing the Round in
   * the same instant refuses the contribution rather than racing it. A refusal writes nothing at
   * all: validation runs before the statement, and the statement is the only writer.
   *
   * **One rule, two branches** (S04, FR6). A *live* contribution to a closed Round is refused with
   * the sentence below; one composed offline and drained when the signal returned is accepted and
   * marked as having arrived late, and a Round reopened in the meantime takes it as ordinary. Both
   * read the same predicate on the same statement, so the two halves cannot drift apart. A repeat
   * of a `submissionId` already stored for this Round resolves to the Post-it already written - the
   * `(round_id, submission_id)` unique constraint is what makes that true, and nothing in this
   * process records which identities it has seen (Binding Constraint FR2).
   *
   * **No count is computed or enforced** anywhere on this path. "A Member may contribute any number
   * of Post-its to one Round" and "No per-Member count limit" are FR3's words, so there is no
   * per-author tally, no per-Round total, and nothing retained between requests to hold one in
   * (ADR-004).
   */
  app.post('/api/conferences/:conferenceId/sessions/:sessionId/rounds/:roundId/post-its', {
    schema: { params: roundParamsSchema, body: contributionBodySchema },
    handler: withAuth(async (request, caller) => {
      const session = await authorizeContribution(request, caller);
      const { roundId } = request.params as RoundParams;
      const body = request.body as ContributionBody;

      // Validation before any write, so a refused contribution persists nothing. A Post-it that
      // waited on a device is validated **here**, on arrival, by the same call - which is why no
      // copy of the rule or of its limit exists on the client (FR6 → validation rules).
      const text = validatePostItText(body);

      const result = await postIts.contribute(
        session.conferenceId,
        session.id,
        roundId,
        caller.sub,
        text,
        {
          offlineComposed: body.offlineComposed === true,
          /*
           * The author is still `caller.sub` from the credential presented on *this* request
           * (Binding Constraint FR3). A queued item carries no author and could not: it is sent
           * under whoever is signed in when it drains, which on a shared tablet is the only safe
           * answer.
           */
          submissionId: body.submissionId ?? null,
        },
      );

      if (result.outcome === 'missing') throw roundNotFound();
      if (result.outcome === 'round-closed') throw roundClosed();
      /*
       * Delivered once already, and the Post-it it produced has since been withdrawn by its author.
       * A success with nothing to return: the device's retry must stop, and no Post-it may come
       * back. Not a refusal - nothing went wrong and there is nothing for the room to be told.
       */
      if (result.outcome === 'already-delivered') return { postIt: null };
      /*
       * Written, then removed by its author from another device before it could be read back. Same
       * answer as above and for the same reason: the write is accounted for, there is nothing to
       * return, and nothing went wrong. This used to raise, which surfaced a race between two of
       * one person's own devices as a 500.
       */
      if (result.outcome === 'gone') return { postIt: null };

      return { postIt: toPostItWire(result.postIt, caller.sub) };
    }),
  });

  /**
   * Answering a Poll, untraceably (US05, TI05).
   *
   * **The voter's identity is `caller.sub` from the verified credential and nothing else** (Binding
   * Constraint FR3), and it goes exactly one place: the has-voted claim. It is not passed to the
   * ballot insert, to the existence check or to the tally, and none of those has a parameter it
   * could arrive through (`api/src/votes/vote-repository.ts`). The body carries `optionId`;
   * anything else it happens to carry - a `voterSub`, a `userSub`, an `email` - is accepted by the
   * schema and then never read, so a request claiming to be somebody else is recorded against the
   * caller rather than refused for a reason that would leave the actual rule untested.
   *
   * Authority is Conference **Membership**, the contribute half of the split, exactly as the board
   * writes above use it - every Member sits in the room and every one of them answers. It is
   * deliberately not a Session Assignment (that is the *runs it* half, and it gates the live tally
   * below), and not `requireConferenceRole(..., 'Attendee')`, which `authorization.ts` documents as
   * the wrong question: its refusal is a sentence about permission to act, where somebody who never
   * joined must be told they have not joined.
   *
   * Every remaining guard - the Round is an open Poll, the option is on it, and this Member has not
   * already voted - is inside the repository's single transaction under the Round's row lock, so
   * none of them is a check with a window after it. No refusal on this path carries a count.
   */
  app.post('/api/conferences/:conferenceId/sessions/:sessionId/rounds/:roundId/votes', {
    schema: { params: roundParamsSchema, body: voteBodySchema },
    handler: withAuth(async (request, caller) => {
      const session = await authorizeContribution(request, caller);
      const { roundId } = request.params as RoundParams;
      const { optionId } = request.body as VoteBody;

      const result = await votes.cast(
        session.conferenceId,
        session.id,
        roundId,
        optionId,
        caller.sub,
      );
      if (result.outcome !== 'cast') refuseCast(result);

      /*
       * What a voter is told back: that it landed, and nothing else.
       *
       * No tally, no total, no per-option data - not even to a Facilitator who would be allowed to
       * read one, because a cast response that sometimes carried counts would be a second, unGated
       * path to the result. The tally has exactly two surfaces, and both are gated below.
       */
      return { voted: true };
    }),
  });

  /**
   * The result: counts per option, to whoever is entitled to it *now* (US07, US08, TI06).
   *
   * Two different permissions, because a Poll's result means two different things at two moments.
   * While it runs it is a facilitation tool - only a holder of a Session Assignment for this
   * Session may watch it build, so the room cannot see the count drift as it answers. Once it has
   * closed it is the outcome, and every Conference Member reads it, however long afterwards.
   *
   * An Attendee asking mid-Poll is **refused, not answered with an empty tally**. That is the whole
   * reason this endpoint exists beside the Session read, which simply omits the key: a zeroed
   * result handed to somebody it is being withheld from would be a statement about the votes, and
   * once "no tally" and "no votes" look alike, absence carries information
   * (prd.md#fr5-poll-result-reveal).
   *
   * The response carries per-option counts and no other field, at every point and for every actor.
   */
  app.get('/api/conferences/:conferenceId/sessions/:sessionId/rounds/:roundId/tally', {
    schema: { params: roundParamsSchema },
    handler: withAuth(async (request, caller) => {
      const { conferenceId, sessionId, roundId } = request.params as RoundParams;

      // Membership first, so a caller who has not joined is told exactly that and learns nothing
      // further - not whether the Session exists, not whether the Poll has closed.
      await authorization.requireMembership(caller, conferenceId);

      const conference = await loadConference(conferenceId);
      if (isDraft(conference)) {
        await authorization.requireConferenceRole(caller, conferenceId, 'PresenterFacilitator');
      }
      await loadSession(conferenceId, sessionId);

      const round = await rounds.findById(conferenceId, sessionId, roundId);
      if (round === null || round.kind !== 'VotingRound') throw roundNotFound();

      if (round.state !== 'closed' && !(await holdsAssignment(caller, conferenceId, sessionId))) {
        throw resultsNotYetAvailable();
      }

      // One entry per option, zero included - a Poll closed with nobody voting reads zero rather
      // than erroring or coming back empty (Acceptance Scenario S05).
      return { tally: await votes.tallyFor(round.id) };
    }),
  });

  /**
   * Correcting your own typo, without asking anyone (US04, TI05).
   *
   * Both guards - "this is yours" and "the round is open" - are conditions on the UPDATE itself,
   * never a read taken first. The route's job is to turn what the statement matched into the right
   * sentence, and the two it can produce are genuinely different situations: somebody else's
   * post-it is never yours to change however the Round is doing, and your own stops being editable
   * the moment the Round ends.
   */
  app.patch(
    '/api/conferences/:conferenceId/sessions/:sessionId/rounds/:roundId/post-its/:postItId',
    {
      schema: { params: postItParamsSchema, body: postItBodySchema },
      handler: withAuth(async (request, caller) => {
        const session = await authorizeContribution(request, caller);
        const { roundId, postItId } = request.params as PostItParams;

        const text = validatePostItText(request.body as PostItTextInput);

        const result = await postIts.edit(
          session.conferenceId,
          session.id,
          roundId,
          postItId,
          caller.sub,
          text,
        );

        if (result.outcome !== 'written') refuseWrite(result);

        return { postIt: toPostItWire(result.postIt, caller.sub) };
      }),
    },
  );

  /**
   * Taking your own post-it back down (US04, TI05).
   *
   * The row goes: no tombstone, no placeholder, no "removed by" marker. An Attendee who deletes
   * their only Post-it leaves **no trace that it existed** (prd.md#edge-cases), and the delete
   * trigger moves the Round's activity watermark so the removal reaches every open board on the
   * next poll rather than lingering until something else happens to write.
   */
  app.delete(
    '/api/conferences/:conferenceId/sessions/:sessionId/rounds/:roundId/post-its/:postItId',
    {
      schema: { params: postItParamsSchema },
      handler: withAuth(async (request, caller) => {
        const session = await authorizeContribution(request, caller);
        const { roundId, postItId } = request.params as PostItParams;

        const result = await postIts.remove(
          session.conferenceId,
          session.id,
          roundId,
          postItId,
          caller.sub,
        );

        if (result.outcome !== 'removed') refuseWrite(result);

        return { removed: true };
      }),
    },
  );
}
