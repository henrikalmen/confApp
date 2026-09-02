import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
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
import type {
  PlacementOutcome,
  PostItRepository,
  PostItWriteOutcome,
} from '../rounds/post-it-repository.ts';
import type {
  DiscardedPostIt,
  PostItDiscardRepository,
} from '../rounds/post-it-discard-repository.ts';
import type { PermanentRemovalRepository } from '../rounds/permanent-removal-repository.ts';
import {
  POST_IT_MAX_LENGTH,
  validatePostItText,
  type PostItTextInput,
} from '../rounds/post-it-validation.ts';
import type {
  Category,
  CategoryRepository,
  CategoryWriteOutcome,
  RemovalDestination,
} from '../rounds/category-repository.ts';
import {
  CATEGORY_LIMIT_PER_BOARD,
  validateCategoryName,
  type CategoryNameInput,
} from '../rounds/category-validation.ts';
import { toBoardWire, toPostItWire, type BoardView } from '../rounds/board-wire.ts';
import { mintDisplayToken, type DisplayTokenMinter } from '../rounds/display-link.ts';
import type { DisplayLinkRepository } from '../rounds/display-link-repository.ts';
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
  /** The `category` table's one write seam, and the Board read's Category half. */
  categories: CategoryRepository;
  votes: VoteRepository;
  authorization: ConferenceAuthorization;
  /** "Does this Round have a Vote yet" – the Poll freeze's only question. See `ballot-gate.ts`. */
  ballotGate: BallotGate;
  /**
   * The `post_it_discard` table's one seam - discard, restore and the Facilitator's reversal list
   * (S05 FR4, ADR-008).
   *
   * A seam of its own rather than four more methods on `postIts`, because the two removal paths on a
   * Post-it have opposite guarantees and are kept apart in storage, in source and in test.
   */
  discards: PostItDiscardRepository;
  /**
   * Permanent Removal's one statement (S06 FR5) - the Admin act that takes a Post-it off every
   * surface for good.
   *
   * A third seam rather than a method on either of the two above, because the three removal
   * concepts on a Post-it have three different gates, three different idempotency answers and
   * three different things left behind. See `permanent-removal-repository.ts`.
   */
  permanentRemovals: PermanentRemovalRepository;
  /** The `display_link` table's write seam (S04 FR7). */
  displayLinks: DisplayLinkRepository;
  /**
   * How a Display Link's value is produced. Production draws 32 bytes from the CSPRNG; a test
   * may pin the value so a scenario can name the token it then opens (S04 TI02).
   */
  mintDisplayLinkToken?: DisplayTokenMinter;
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
 * Where a Post-it goes: a Category on its own Board, or **Uncategorised** (S03, FR3).
 *
 * `null` is admitted by the schema **so that it stays `null`**, which is the only reason it is
 * named - the same trap `categoryChangeBodySchema` documents. Ajv coerces to a schema's type, so a
 * `categoryId` typed as string alone would turn `null` into `''` and the destination that means
 * "Uncategorised" would arrive as an id that names nothing. Uncategorised is the *absence* of a
 * placement (`prd.md#fr2-the-uncategorised-holding-area`), so it travels as an absence and there is
 * no sentinel id anywhere on this path.
 *
 * `required`, and deliberately so: this route sets a placement rather than patching a Post-it, and a
 * body that named no destination would be a request with nothing in it. `format: 'uuid'` refuses a
 * malformed id here rather than letting it reach PostgreSQL as a `22P02` the caller reads as an
 * internal error.
 *
 * Deliberately **not** `additionalProperties: false`, exactly like the three body schemas above and
 * for the same reason. A request carrying an `actorSub`, a `facilitatorSub` or an `email` is
 * accepted and those fields are never read - the write is decided and attributed by the caller's own
 * credential, which is the observable thing Binding Constraint FR6 demands. Refusing such a request
 * instead would prove nothing: a route that refuses an actor field and a route that trusts one both
 * pass "does not accept a body with an actor in it", and only one of them is correct.
 */
const placementBodySchema = {
  type: 'object',
  required: ['categoryId'],
  properties: {
    categoryId: {
      anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }],
    },
  },
} as const;

interface PlacementBody {
  categoryId: string | null;
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

const categoryParamsSchema = {
  type: 'object',
  required: ['conferenceId', 'sessionId', 'roundId', 'categoryId'],
  properties: {
    conferenceId: { type: 'string', format: 'uuid' },
    sessionId: { type: 'string', format: 'uuid' },
    roundId: { type: 'string', format: 'uuid' },
    categoryId: { type: 'string', format: 'uuid' },
  },
} as const;

/**
 * Naming a Category. Shape only; the business rule lives in `category-validation.ts`.
 *
 * Deliberately **not** `additionalProperties: false`, exactly like `postItBodySchema` and
 * `voteBodySchema` and for the same reason. A request carrying an `authorSub`, an `actorSub` or a
 * `userSub` is accepted and those fields are never read - the write is attributed to the caller's
 * own credential, which is the observable thing Binding Constraint FR6 demands. Refusing such a
 * request instead would prove nothing: a route that refuses an actor field and a route that trusts
 * one both pass "does not accept a body with an actor in it", and only one of them is correct.
 * Ignored is the stronger statement, and it is asserted behaviourally in
 * `category.integration.test.ts`.
 */
const categoryBodySchema = {
  type: 'object',
  required: ['name'],
  properties: {
    name: { type: 'string' },
  },
} as const;

/**
 * Changing a Category: its name, its position, or both.
 *
 * Neither is required on its own - a rename and a reorder are two different things a Facilitator
 * does to the same row, and one endpoint that takes either keeps the surface's controls pointed at
 * one address. A request naming neither is refused rather than silently doing nothing.
 *
 * `position` is an integer and is **clamped at the top**, not validated against the current range:
 * asking for position 99 on a Board of three means "put it last"
 * (`prd.md#fr1-categories-on-a-board`).
 *
 * `null` is admitted by the schema **so that it stays `null`**, which is the only reason it is
 * named. Ajv coerces to a schema's type, so a `position` typed as integer alone turns `null` into
 * `0`: the natural "leave the position alone" idiom would then pass the presence check and move the
 * Category to the front - the opposite of what the sender meant. Listing `null` as a permitted type
 * leaves it uncoerced, and `typeof body.position === 'number'` reads it as "not moving".
 *
 * A `minimum` here would close the same hole and break a different rule: FR1 says a position
 * outside the current range is **clamped rather than refused**, and that is one rule about both
 * ends. The clamp lives in `category-repository.ts`, where it can see the range.
 */
const categoryChangeBodySchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    position: { type: ['integer', 'null'] },
  },
} as const;

/**
 * Removing a Category, and where its Post-its go if it holds any.
 *
 * The **presence** of `destinationCategoryId` is what says a destination was chosen; its value
 * `null` is Uncategorised. That is not a sentinel: Uncategorised is the absence of a placement, so
 * the destination that means "no Category" is written as the absence it is
 * (`prd.md#fr2-the-uncategorised-holding-area`). A body naming no destination at all is what makes
 * an occupied Category's removal a refusal that states the count.
 *
 * `type: ['object', 'null']` so a removal sent with no body at all - which is what an empty
 * Category needs - is not refused for having omitted a field it does not need.
 */
const categoryRemovalBodySchema = {
  type: ['object', 'null'],
  properties: {
    destinationCategoryId: {
      anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }],
    },
  },
} as const;

interface CategoryChangeBody {
  name?: string;
  position?: number | null;
}

interface CategoryRemovalBody {
  destinationCategoryId?: string | null;
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

interface CategoryParams extends RoundParams {
  categoryId: string;
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
  board?: BoardView,
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
           * about the Round itself and never read its Post-its; saying `uncategorised: { … }` there
           * would assert an empty board the caller has no reason to believe, and a Round with a
           * board would be described as having none. Both properties are optional on the wire
           * shape, and a client that needs the board re-reads the Session - which is what the panel
           * already does.
           */
          {}
        : {
            /*
             * The whole board, grouped, in the same response as the Round it belongs to - one
             * request for a Session and everything on its Boards
             * (prd.md#non-functional-requirements). A closed Round's board comes back in full:
             * closing stops contribution, it does not hide what the room produced - and archival
             * stops writes rather than emptying the Board.
             *
             * `textMaxLength` rides along so the compose box can state the limit without carrying
             * a number of its own. It is `POST_IT_MAX_LENGTH`, interpolated - the client renders
             * what the payload hands it, which is why no cap literal exists under `web/` anywhere.
             */
            ...toBoardWire(board, viewerSub),
            textMaxLength: POST_IT_MAX_LENGTH,
          }),
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
 * Permanent Removal, refused to a holder of sorting authority who is not a conference-wide Admin
 * (S06, FR5 -> Error Handling).
 *
 * **It names the act they do have.** A Facilitator looking at something abusive on a projected wall
 * needs a next move, and Discard is it - so this is the one refusal on the Post-it path that offers
 * an alternative rather than only stating a rule. See `errors.ts#POST_IT_ADMIN_REQUIRED` for why it
 * is not the neutral CONFERENCE_ROLE_REQUIRED sentence, and why saying this much discloses nothing.
 */
function onlyAnAdminMayRemovePermanently(): AppError {
  return new AppError(
    ERROR_CODES.POST_IT_ADMIN_REQUIRED,
    403,
    'Only an admin can permanently remove a post-it. You can discard it instead.',
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

/**
 * The one place a placement's outcome becomes a refusal (S03, FR3).
 *
 * **Two reasons, two codes, and neither is new.** A placement is refused because the Post-it is not
 * on this Board or because the destination Category is not - and both of those already have exactly
 * one sentence in this API. A `POST_IT_PLACEMENT_NOT_FOUND` beside `POST_IT_NOT_FOUND` would be a
 * synonym, which is the thing `errors.ts` says this feature does not get a second copy of. The two
 * refusals that are *about the caller* rather than about the Board - no sorting authority, and an
 * Archived Conference - are produced by `authorizeWrite` before this is ever reached, under
 * `CONFERENCE_ROLE_REQUIRED` and `CONFERENCE_NOT_EDITABLE`.
 *
 * Both sentences say the **Board changed**, which is FR3's error-handling rule: the surface re-reads
 * and states what it found rather than reporting a bare failure. Neither carries a count, and
 * neither discloses anything about a Board the caller has no authority over.
 */
function refusePlacement(outcome: PlacementOutcome): never {
  /*
   * Discarded, and it is neither of the other two sentences. The Post-it is still stored and still
   * restorable, so "no longer on this round" would be false; and the destination the Facilitator
   * chose was fine, so naming the category would send them to fix something that is not broken. The
   * next move is the reason this exists: put it back first (FR3 -> Validation).
   */
  if (outcome.outcome === 'discarded') {
    throw new AppError(
      ERROR_CODES.POST_IT_DISCARDED,
      409,
      'That post-it has been discarded, so it was not moved. Restore it from the discarded ' +
        'post-its first if you want it back on the board.',
    );
  }
  if (outcome.outcome === 'destination-missing') {
    throw new AppError(
      ERROR_CODES.CATEGORY_NOT_FOUND,
      404,
      'That category is not on this board, so the post-it was not moved. The board has changed ' +
        'since you last read it.',
    );
  }
  // 'missing', and the success outcome a caller only reaches here by mistake.
  throw postItNotFound();
}

/**
 * One discarded Post-it on the wire.
 *
 * Both names and no `sub`, exactly as `toPostItWire` does: the room reads names, and the identities
 * behind them are not published to a client that has no use for them.
 *
 * `discardedAt` is the display string the seam produced, sent as-is. No client formats it and none
 * could - see `DiscardedPostIt` for why the instant does not reach the wire.
 *
 * There is no `mine`, no `edited` and no `arrivedAfterClose`: this is not a Board, and every control
 * those fields exist to gate is absent from this surface. There is no permanent-removal field either
 * - that act is Admin-only and belongs to S06, and nothing on this surface may read as a removal that
 * cannot be undone (`design-decisions.md` -> "The discarded Post-its surface").
 */
function toDiscardedWire(discarded: DiscardedPostIt): Record<string, unknown> {
  return {
    id: discarded.postItId,
    text: discarded.text,
    authorName: discarded.authorName,
    discardedByName: discarded.discardedByName,
    discardedAt: discarded.discardedAt,
  };
}

function roundNotFound(): AppError {
  return new AppError(
    ERROR_CODES.ROUND_NOT_FOUND,
    404,
    'That round no longer exists on this session.',
  );
}

/**
 * No Category of that id on this Round.
 *
 * **This is also the whole of the API's backstop against addressing Uncategorised.** Uncategorised
 * is not stored as a Category row and no identifier names it, so a rename, reorder or remove aimed
 * at it carries an id that matches nothing and is answered here - there is no sentinel to
 * special-case and no branch anywhere that tests for one
 * (`prd.md#fr2-the-uncategorised-holding-area`).
 */
function categoryNotFound(): AppError {
  /*
   * "There is no such category", not "it is no longer here". The same sentence answers an id that
   * named a Category somebody removed, an id that never named one, and any attempt to address
   * Uncategorised - and only the first of those is a *removal*. Telling a Facilitator something
   * vanished sends them looking for who took it.
   */
  return new AppError(
    ERROR_CODES.CATEGORY_NOT_FOUND,
    404,
    'There is no such category on this round.',
  );
}

/**
 * The one place a guarded Category write's outcome becomes a refusal.
 *
 * Shared by the create, the change and the removal so the three cannot drift into naming the same
 * situation differently, exactly as `refuseWrite` does for the Post-it paths.
 *
 * Both counted sentences take their number from the outcome, which the repository read **at the
 * moment of refusal** rather than before the write - so a create that lost the race for the last
 * free slot names the Board as it actually is.
 */
function refuseCategoryWrite(outcome: CategoryWriteOutcome): never {
  if (outcome.outcome === 'limit-reached') {
    throw new AppError(
      ERROR_CODES.CATEGORY_LIMIT_REACHED,
      409,
      `A board can hold at most ${CATEGORY_LIMIT_PER_BOARD} categories, and this one already ` +
        `holds ${outcome.count}. Remove or merge one before adding another.`,
    );
  }
  if (outcome.outcome === 'holds-post-its') {
    const noun = outcome.count === 1 ? 'post-it' : 'post-its';
    throw new AppError(
      ERROR_CODES.CATEGORY_HOLDS_POST_ITS,
      409,
      `This category holds ${outcome.count} ${noun}. Move them to Uncategorised, or choose ` +
        'another category.',
    );
  }
  if (outcome.outcome === 'destination-missing') {
    throw new AppError(
      ERROR_CODES.CATEGORY_NOT_FOUND,
      404,
      'The category chosen for these post-its is not on this board, so nothing was moved or ' +
        'removed.',
    );
  }
  // 'missing', and the two success outcomes a caller only reaches here by mistake.
  throw categoryNotFound();
}

/**
 * A written Category, and the warning that rides a **successful** write.
 *
 * Two Categories on one Board may share a name: names are labels, not identifiers, and the Report
 * groups by identity (`prd.md#fr1-categories-on-a-board`). So the duplicate is stored and the
 * Facilitator is told, in a `warning` beside the row rather than in an error envelope - a refusal
 * here would take a decision the product deliberately leaves to the room.
 */
function categoryResponse(category: Category, duplicateName: boolean): Record<string, unknown> {
  return {
    category: { id: category.id, name: category.name, position: category.position },
    ...(duplicateName
      ? {
          warning:
            'Another category on this board already has that name. Both are kept - names are ' +
            'labels, not identifiers.',
        }
      : {}),
  };
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
    categories,
    votes,
    authorization,
    ballotGate,
    discards,
    permanentRemovals,
    displayLinks,
    mintDisplayLinkToken = mintDisplayToken,
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

  /**
   * Does this caller hold **conference-wide Admin** – the authority Permanent Removal needs
   * (S06 FR5)?
   *
   * The same primitive `holdsAssignment` uses, asked a second question rather than a second
   * authority path. `ROLE_RANK` is why a Session Assignment cannot satisfy it: an assignment
   * *narrows* a `PresenterFacilitator` requirement to one Session and never raises rank
   * (`conferences/authorization.ts`). Resolved from the rows on every call with nothing cached, so
   * an Admin role revoked a moment ago takes effect on the next request (ADR-004).
   *
   * Asked as a question rather than as a refusal, for the same reason `holdsAssignment` is: the
   * Session read has to *report* it, and the removal route has its own sentence for it. Neither
   * re-derives authority; both ask this.
   */
  async function holdsConferenceAdmin(
    caller: AuthenticatedCaller,
    conferenceId: string,
  ): Promise<boolean> {
    try {
      await authorization.requireConferenceRole(caller, conferenceId, 'Admin');
      return true;
    } catch (error) {
      // Only the authority refusal means "no". Anything else – the database being unreachable, for
      // instance – is a real failure and must not be reported as "you are not allowed".
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
   * May *this* caller permanently remove a Post-it on this Board (S06 FR5, TI04)?
   *
   * **A second flag beside `canRun`, because `canRun` cannot carry this.** `canRun` is true for an
   * assigned Facilitator and for an Admin alike - that is the whole point of it - so rendering the
   * irreversible control from it would offer the act to exactly the people FR5 refuses.
   *
   * Derived from the same `requireConferenceRole(..., 'Admin')` question the removal route enforces
   * with, and folding editability in the same way `mayRun` does, so the flag means "this control
   * will work" rather than "you would be allowed if anything here were writable". On an archived
   * Conference every write is refused, and a live-looking Remove permanently that answers 409 is
   * worse than no control at all.
   *
   * Binding Constraint FR5 is still enforced server-side; this only decides what is *offered*. The
   * client consumes it and holds no second opinion - there is no role name, rank or Admin test
   * anywhere under `web/`.
   */
  function mayRemovePermanently(conference: Conference, admin: boolean): boolean {
    return isEditable(conference) && admin;
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
       * Five statements for the whole Session, never one per Round and never one per Category: the
       * Rounds, every board's Post-its, every board's Categories, every Poll's counts, and which
       * Polls *this* caller has voted in. One read answers a Session and everything on its Boards
       * (prd.md#non-functional-requirements), and a handler looping per Round - or per Category -
       * is the N+1 this project has already been bitten by. The count does not grow with the number
       * of Categories or of Post-its, which is what
       * `api/test/category-structure.test.ts` counts across a whole request.
       *
       * `votedRoundsFor` is asked about `caller.sub` and nobody else. It is the only question this
       * API ever puts to the has-voted table, and the payload turns it into a single boolean per
       * Round – so there is no path here, and no response shape, that says who else voted.
       */
      const [authored, boards, boardCategories, tallies, voted] = await Promise.all([
        rounds.listForSession(conferenceId, sessionId),
        postIts.listForSession(conferenceId, sessionId),
        categories.listForSession(conferenceId, sessionId),
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
      /*
       * Two authority questions, asked together rather than one after the other: who runs this
       * Session, and who holds conference-wide Admin (S06 TI04). Both are the one canonical check
       * asked for different purposes, and neither is cached - so the payload adds a round trip's
       * worth of work and not a round trip's worth of latency.
       */
      const [assigned, admin] = await Promise.all([
        holdsAssignment(caller, conferenceId, sessionId),
        holdsConferenceAdmin(caller, conferenceId),
      ]);
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
            {
              categories: boardCategories.get(round.id) ?? [],
              postIts: boards.get(round.id) ?? [],
            },
            round.kind === 'VotingRound' ? pollView(round) : undefined,
          ),
        ),
        canRun: mayRun(conference, assigned),
        /**
         * Whether the irreversible control is offered at all – see `mayRemovePermanently`. A second
         * flag rather than a widening of `canRun`, because the two answer different questions and
         * an Admin and an assigned Facilitator differ on exactly this one.
         */
        canRemovePermanently: mayRemovePermanently(conference, admin),
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
   * Naming a Category on a Board (FR1, TI06).
   *
   * **Every Category write on this Round runs through `authorizeWrite` and nothing else** - the
   * sorting-authority gate (`prd.md#fr6-sorting-authority`), which is a Session Assignment on this
   * Round's Session or conference-wide Admin, resolved per request from the database with nothing
   * carried between requests, and then `assertEditable` so an Archived Conference refuses every one
   * of them with the one archived sentence this API has. It is deliberately the same gate the
   * authoring and run controls already use rather than an authority of its own: sorting a Board *is*
   * running the Session.
   *
   * **The acting identity is `caller.sub` from the verified credential and nothing else** (Binding
   * Constraint FR6). No body field here names or influences who is acting; a request carrying an
   * `actorSub`, an `authorSub` or a `userSub` is accepted by the schema and then never read, so a
   * request claiming to be somebody else writes under the caller's own authority rather than being
   * refused for a reason that would leave the actual rule untested.
   *
   * A Category is creatable at **any** Round state - open, closed or reopened - and whether or not
   * the Board already holds Post-its. Nothing is auto-placed: creating a Category moves no Post-it,
   * and Uncategorised keeps everything it had.
   *
   * The 20-per-Board cap is not checked here, deliberately. It is a storage constraint, so two
   * replicas cannot both pass it; this route's job is to turn what the database refused into the
   * sentence that names the limit and the count.
   */
  app.post('/api/conferences/:conferenceId/sessions/:sessionId/rounds/:roundId/categories', {
    schema: { params: roundParamsSchema, body: categoryBodySchema },
    handler: withAuth(async (request, caller) => {
      const { session } = await authorizeWrite(request, caller);
      const { roundId } = request.params as RoundParams;

      // Validation before any write, so a refused name persists nothing.
      const name = validateCategoryName(request.body as CategoryNameInput);

      const result = await categories.create(session.conferenceId, session.id, roundId, name);
      /*
       * A create names no Category, so "nothing matched" can only mean the Round is not a Post-it
       * Round of this Session - the same sentence a contribution to a Poll reads, and not "that
       * category is gone", which would send the Facilitator looking for a row they never named.
       */
      if (result.outcome === 'missing') throw roundNotFound();
      if (result.outcome !== 'written') refuseCategoryWrite(result);

      return categoryResponse(result.category, result.duplicateName);
    }),
  });

  /**
   * Renaming a Category, moving one in the order, or both (FR1, TI06).
   *
   * One endpoint for two changes because they are two things done to the same row from the same
   * control set, and splitting them would give the surface two addresses for one Category. A request
   * naming neither is refused rather than quietly doing nothing.
   *
   * **Renaming moves nothing** - not a Post-it, and not the Category's own position
   * (`prd.md#edge-cases`); that is a property of the repository's UPDATE, which touches one column.
   * **A position outside the current range is clamped, not refused**, and the whole ordering is left
   * contiguous afterwards: asking for position 99 on a Board of three means "put it last".
   *
   * Concurrent reorders are **last write wins for the ordering as a whole** - no version token, no
   * per-Category merge and no conflict prompt (`prd.md#edge-cases`). Both Facilitators converge
   * through the one activity cursor, which every Category write advances.
   */
  app.patch(
    '/api/conferences/:conferenceId/sessions/:sessionId/rounds/:roundId/categories/:categoryId',
    {
      schema: { params: categoryParamsSchema, body: categoryChangeBodySchema },
      handler: withAuth(async (request, caller) => {
        const { session } = await authorizeWrite(request, caller);
        const { roundId, categoryId } = request.params as CategoryParams;
        const body = request.body as CategoryChangeBody;

        /*
         * `typeof` rather than `!== undefined`, on both. The schema refuses a coerced `0` already;
         * this is the second half of the same rule, and it is what keeps the two branches below
         * reading a value of the type they think they have rather than whatever survived coercion.
         */
        const renaming = typeof body.name === 'string';
        const moving = typeof body.position === 'number';

        if (!renaming && !moving) {
          const message = 'A category change needs a new name, a new position, or both.';
          throw new AppError(ERROR_CODES.VALIDATION_FAILED, 400, message);
        }

        let category: Category | null = null;
        let duplicateName = false;

        if (renaming) {
          // Validation before any write, so a refused name persists nothing.
          const name = validateCategoryName(body as CategoryNameInput);
          const renamed = await categories.rename(
            session.conferenceId,
            session.id,
            roundId,
            categoryId,
            name,
          );
          if (renamed.outcome !== 'written') refuseCategoryWrite(renamed);
          category = renamed.category;
          duplicateName = renamed.duplicateName;
        }

        if (moving) {
          const moved = await categories.reorder(
            session.conferenceId,
            session.id,
            roundId,
            categoryId,
            body.position!,
          );
          if (moved.outcome !== 'written') refuseCategoryWrite(moved);
          // The name is the one just written where both were sent; the position is the settled one.
          category = { ...moved.category, ...(category === null ? {} : { name: category.name }) };
        }

        return categoryResponse(category!, duplicateName);
      }),
    },
  );

  /**
   * Removing a Category, and saying where its Post-its go (FR1, TI06).
   *
   * **An empty Category goes with no prompt; an occupied one cannot go until a destination is
   * chosen**, and the refusal names the count because that is what the choice turns on. The
   * destination is `null` for Uncategorised - the absence of a placement, sent as an absence - or
   * the id of another Category on this same Board. Nothing is deleted: the Post-its move, and the
   * message says so.
   *
   * The database says the same thing from the other side. `post_it_placed_on_its_own_round` is
   * `NO ACTION`, so a delete that skipped the move is refused by the foreign key rather than
   * orphaning a placement - the sentence is here, the guarantee is in the schema.
   */
  app.delete(
    '/api/conferences/:conferenceId/sessions/:sessionId/rounds/:roundId/categories/:categoryId',
    {
      schema: { params: categoryParamsSchema, body: categoryRemovalBodySchema },
      handler: withAuth(async (request, caller) => {
        const { session } = await authorizeWrite(request, caller);
        const { roundId, categoryId } = request.params as CategoryParams;

        /*
         * The **presence** of the key is the choice, not its value: `null` is Uncategorised and is
         * a destination like any other, while an absent key is a removal that has not said where
         * anything goes. A body omitted entirely is the empty-Category case and needs to say
         * nothing at all.
         */
        const body = (request.body ?? {}) as CategoryRemovalBody;
        const destination: RemovalDestination =
          body !== null && 'destinationCategoryId' in body
            ? { chosen: true, categoryId: body.destinationCategoryId ?? null }
            : { chosen: false };

        const result = await categories.remove(
          session.conferenceId,
          session.id,
          roundId,
          categoryId,
          destination,
        );
        if (result.outcome !== 'removed') refuseCategoryWrite(result);

        return { removed: true };
      }),
    },
  );

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

  /**
   * Sorting: putting a Post-it into a Category, or back into Uncategorised (US03, S03 FR3).
   *
   * **Its own route, and not an overload of the correction above.** The two writes to one Post-it
   * belong to two different people under two different gates: correcting the words is the
   * *author's* write under Membership, and placing it is the Facilitator's under the
   * sorting-authority gate. One address carrying both authorities is how a Facilitator ends up able
   * to edit somebody's words, or an author ends up able to sort.
   *
   * **The gate is `authorizeWrite` - S02's, consumed unchanged.** A Session Assignment on this
   * Round's Session or conference-wide Admin, resolved per request from the database with nothing
   * carried between requests, authority **first** so a caller without it learns nothing further, and
   * then `assertEditable` so an Archived Conference refuses with the one archived sentence this API
   * has. Sorting a Board *is* running the Session, so it is deliberately the same gate the run
   * controls use rather than an authority of its own (`prd.md#fr6-sorting-authority`).
   *
   * **The acting identity is the credential and nothing else** (Binding Constraint FR6). Nothing
   * about the actor is passed to the repository - `place` has no parameter for one - so no body
   * field could reach a column even if the schema admitted it, and one carrying an `actorSub` or an
   * `email` changes neither the decision nor what is written.
   *
   * Every remaining guard is the write statement's own predicate: the Post-it is on this Board, and
   * the destination is a Category of this same Board. A cross-Board destination is refused there
   * rather than by a read taken first, and a placement into the Category a Post-it already occupies
   * simply succeeds - the requested end state is the one that holds (FR3 -> Validation).
   *
   * **The Round's state is not consulted anywhere on this path.** Sorting is what happens after the
   * room has written: it is permitted while the Round is open, after it has closed, and after a
   * reopen, and a Post-it contributed after a reopen arrives in Uncategorised like any other.
   */
  app.patch(
    '/api/conferences/:conferenceId/sessions/:sessionId/rounds/:roundId/post-its/:postItId/placement',
    {
      schema: { params: postItParamsSchema, body: placementBodySchema },
      handler: withAuth(async (request, caller) => {
        const { session } = await authorizeWrite(request, caller);
        const { roundId, postItId } = request.params as PostItParams;
        const { categoryId } = request.body as PlacementBody;

        const result = await postIts.place(
          session.conferenceId,
          session.id,
          roundId,
          postItId,
          categoryId ?? null,
        );

        if (result.outcome !== 'written') refusePlacement(result);

        return { postIt: toPostItWire(result.postIt, caller.sub) };
      }),
    },
  );

  /**
   * Discard, restore, and the surface a restore is made from (US05, S05 FR4, ADR-008).
   *
   * **Three routes, one authority, and it is S02's gate consumed unchanged** - a Session Assignment
   * on this Round's Session, or conference-wide Admin, resolved from the database per request with
   * nothing carried between them, authority **first** so a caller without it learns nothing further,
   * and then `assertEditable` so an Archived Conference refuses with the one archived sentence this
   * API has. Taking a named colleague's idea off the Board is running the Session, so it is
   * deliberately the same authority as the run controls rather than an authority of its own
   * (`prd.md#fr6-sorting-authority`).
   *
   * **The list is gated identically to the writes, and that is deliberate.** It is the only surface
   * in the system on which a discarded Post-it appears at all - it is absent from every Board,
   * including its own author's - so reading it is exactly as much of a Facilitator's act as reversing
   * from it.
   *
   * **The discarder is the credential and nothing else** (Binding Constraint FR6). `caller.sub` is
   * the only value that reaches `discarded_by_sub`; neither route below reads a body at all, so
   * there is no field a request could name an actor through even by accident.
   *
   * **`assertWritePreconditions` is deliberately not used.** Sorting is last-write-wins with no base
   * version (`prd.md#edge-cases`), so there is nothing for a precondition to compare, and both of
   * these writes are idempotent besides.
   *
   * **No Round open/closed condition, on any of the three.** Sorting begins before a Round closes and
   * continues after it, unlike author deletion - see `post-it-discard-repository.ts`.
   *
   * **The two writes have exactly one refusal between them, and the absence of the others is the
   * specification.** Discarding an already-discarded Post-it and restoring one that was never
   * discarded are both *successes* - the seam reports the requested end state rather than whether a
   * row moved - so there is no "already discarded" sentence to write and none for a Facilitator to
   * read (FR4 -> Error Handling: silent success, no message needed). The two refusals that are
   * *about the caller* rather than about the Board are produced by `authorizeWrite` before either
   * handler is entered. What remains is a Post-it that is not on the Board the caller named, which
   * already has exactly one sentence in this API - `postItNotFound()`, shared with the author's own
   * write paths so the two cannot drift into naming the same situation differently.
   */
  app.post(
    '/api/conferences/:conferenceId/sessions/:sessionId/rounds/:roundId/post-its/:postItId/discard',
    {
      schema: { params: postItParamsSchema },
      handler: withAuth(async (request, caller) => {
        const { session } = await authorizeWrite(request, caller);
        const { roundId, postItId } = request.params as PostItParams;

        const result = await discards.discard(
          session.conferenceId,
          session.id,
          roundId,
          postItId,
          caller.sub,
        );

        if (result.outcome !== 'discarded') throw postItNotFound();

        /*
         * `true` on a first Discard and on a repeat alike: FR4 says the requested end state is the
         * one that holds, and a second Discard is a success with no message. The response says what
         * is true of the Post-it now, not whether this particular request was the one that moved it.
         */
        return { discarded: true };
      }),
    },
  );

  app.post(
    '/api/conferences/:conferenceId/sessions/:sessionId/rounds/:roundId/post-its/:postItId/restore',
    {
      schema: { params: postItParamsSchema },
      handler: withAuth(async (request, caller) => {
        const { session } = await authorizeWrite(request, caller);
        const { roundId, postItId } = request.params as PostItParams;

        /*
         * **No destination is read, because there is none to read.** A restore always returns the
         * Post-it to Uncategorised (FR4 -> Validation), and the seam it calls has no parameter for a
         * Category - so this route carries no body schema, and a request naming a destination is
         * ignored rather than refused, exactly as an actor field is.
         */
        const result = await discards.restore(session.conferenceId, session.id, roundId, postItId);

        if (result.outcome !== 'restored') throw postItNotFound();

        return { restored: true };
      }),
    },
  );

  app.get('/api/conferences/:conferenceId/sessions/:sessionId/rounds/:roundId/discarded-post-its', {
    schema: { params: roundParamsSchema },
    handler: withAuth(async (request, caller) => {
      const { session } = await authorizeWrite(request, caller);
      const { roundId } = request.params as RoundParams;

      const discarded = await discards.listForRound(session.conferenceId, session.id, roundId);
      return { discarded: discarded.map(toDiscardedWire) };
    }),
  });

  /**
   * **Permanent Removal**: an Admin taking a Post-it off every surface for good (S06, FR5, US06).
   *
   * **Its own sub-resource, following `/open`, `/close` and `/discard`** - and deliberately not an
   * overload of the author's `DELETE …/post-its/:postItId` above. One address carrying two removals
   * is how an author's delete and an Admin's moderation come to share a gate, and they must not:
   * the author's needs an open Round and refuses a non-author, this one needs neither and refuses
   * everyone who is not an Admin.
   *
   * **The gate is S02's, with an Admin layer inserted - not a second authority path.** The order is
   * the whole design, because it is what decides which sentence each caller reads:
   *
   *   1. `requireConferenceRole(..., 'PresenterFacilitator', { sessionId })` - the shipped
   *      sorting-authority check. Someone with no standing in this Conference gets
   *      `authorization.ts#refusal()`'s neutral answer and learns nothing: not that the Session
   *      exists, not that the Post-it does, not that this endpoint means anything here.
   *   2. `requireConferenceRole(..., 'Admin')`, through `holdsConferenceAdmin` - the same primitive
   *      asked a second question. A Session Assignment cannot satisfy it: an assignment *narrows* a
   *      `PresenterFacilitator` requirement and never raises rank (`ROLE_RANK`). A
   *      Presenter/Facilitator therefore reaches exactly one refusal, and it is the one that offers
   *      Discard instead.
   *   3. `assertEditable` - only an Admin gets this far, so an archived Conference's state is
   *      disclosed to nobody who was not already entitled to change it.
   *
   * `assertWritePreconditions` is deliberately not used: there is no base version to compare and
   * nothing to conflict with, exactly as on the Discard routes.
   *
   * **The acting identity is the credential and nothing else** (Binding Constraint FR6). The seam
   * below has no parameter for an actor, so a body naming an `actorSub`, a `userSub` or an
   * `adminSub` is accepted and never read - inert rather than refused, which is the stronger
   * statement and the one the integration suite proves. Nothing about the act is recorded anywhere
   * in any case: FR5's "no trace" means there is no "removed by" record to write.
   *
   * **No Round open/closed condition and no author condition.** Permanent Removal reaches any
   * Post-it in the Conference whoever wrote it and whatever its Round is doing - moderation cannot
   * wait for a Round to be open.
   *
   * **Matching nothing is a success and there is no "already gone" sentence to write** (FR5 ->
   * Validation). That is the opposite of the author delete's answer above, and deliberately so: the
   * author path must say *which* of "not yours" and "the round has ended" refused it, while here
   * the requested end state is simply the one that already holds. The success answers for what is
   * true at the address the request named, not for the Post-it id everywhere - a removal aimed at
   * the wrong Round or Session matches nothing and succeeds with the row still stored elsewhere.
   *
   * **The Discard trace goes with the row, and nothing here mentions it.** S05's
   * `post_it_discard … ON DELETE CASCADE` removes it, so an already-Discarded Post-it needs no
   * special case on this path and no pending restore survives it.
   */
  app.post(
    '/api/conferences/:conferenceId/sessions/:sessionId/rounds/:roundId/post-its/:postItId/permanent-removal',
    {
      schema: { params: postItParamsSchema },
      handler: withAuth(async (request, caller) => {
        const { conferenceId, sessionId, roundId, postItId } = request.params as PostItParams;

        // Sorting authority first, so a caller with no standing learns nothing further.
        await authorization.requireConferenceRole(caller, conferenceId, 'PresenterFacilitator', {
          sessionId,
        });
        // Then conference-wide Admin, which a Session Assignment does not confer.
        if (!(await holdsConferenceAdmin(caller, conferenceId))) {
          throw onlyAnAdminMayRemovePermanently();
        }

        const conference = await loadConference(conferenceId);
        assertEditable(conference);
        const session = await loadSession(conferenceId, sessionId);

        await permanentRemovals.remove(session.conferenceId, session.id, roundId, postItId);

        /*
         * `true` whether a row went or the statement matched nothing. What it states is what is
         * true **at the address this request named** - nothing is stored on that Board under that
         * id - and not that this particular request was the one that removed it.
         *
         * It is deliberately not the stronger claim "that Post-it no longer exists anywhere". A
         * removal naming the right Post-it against the wrong Round, Session or Conference matches
         * nothing and answers this same way, with the row still stored under its own address. The
         * seam's module note carries the full reading; `permanent-removal.integration.test.ts` ->
         * "touches no post-it on another round of the same session" is that case, pinned.
         */
        return { removed: true };
      }),
    },
  );

  /**
   * The Display Link on a Post-it Round: read the live one, issue one, take it back (FR7, US01,
   * US07).
   *
   * **Three routes, one authority, and it is S02's gate consumed unchanged** - a Session Assignment
   * on this Round's Session, or conference-wide Admin, resolved from the database per request with
   * nothing carried between them. Handing a room a way to read named Post-its is running the
   * Session, so it is deliberately the same authority as the run controls rather than an authority
   * of its own (`prd.md#fr6-sorting-authority`).
   *
   * **The acting identity is the credential and nothing else** (Binding Constraint FR6). The issuer
   * written to the row is `caller.sub`; no route below reads a body at all, so there is no field a
   * request could name an actor through even by accident, and no schema that would have to refuse
   * one.
   *
   * **The token reaches exactly one audience: a holder of sorting authority on its own Round.** It
   * is never logged (`redactDisplayToken` in `api/src/routes/display.ts` keeps it out of the request
   * line), never put in an error message, and never returned by any other endpoint - the Session
   * read carries no display-link field, so a Member of the Conference cannot learn that a Board is
   * being projected, let alone where.
   *
   * A Board is **fully usable with no link ever issued**: nothing on any Board surface asks for one,
   * and `null` here is an ordinary answer rather than a state to recover from.
   */
  const DISPLAY_LINK_URL =
    '/api/conferences/:conferenceId/sessions/:sessionId/rounds/:roundId/display-link';

  /**
   * The authority these three share, without the editability check.
   *
   * `authorizeWrite` refuses on an Archived Conference, which is right for issuing - archiving makes
   * a Conference read-only and minting a new way in is a write. It is the wrong sentence for
   * *reading* what is already issued, and it would be an actively bad one for **revoking**: taking
   * access back must never be refused because the Conference has gone read-only. Withdrawal is
   * always available.
   */
  async function authorizeDisplayLink(
    request: FastifyRequest,
    caller: AuthenticatedCaller,
  ): Promise<Session> {
    const { conferenceId, sessionId } = request.params as SessionParams;
    // Authority first, so a caller without it learns nothing further - not whether the Session
    // exists, not what state the Conference is in, and certainly not whether a link exists.
    await authorization.requireConferenceRole(caller, conferenceId, 'PresenterFacilitator', {
      sessionId,
    });
    await loadConference(conferenceId);
    return loadSession(conferenceId, sessionId);
  }

  /**
   * `no-store`, on every response that carries a Display Link value.
   *
   * A route-level hook rather than a line in each handler, because `withAuth` hands the inner
   * handler a caller instead of a `reply` - deliberately, so nothing downstream builds its own
   * response shape. These three routes are the ones that **hand out** the bearer credential, and
   * confApp is used on shared hardware by design; Fastify sends no default directive, so without
   * this the body holding a live token is left to whatever heuristic a browser or an intermediary
   * applies (review 2026-08-31, L8). The anonymous resolution route sets the same header for the
   * same reason.
   */
  const noStore = async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    void reply.header('cache-control', 'no-store');
  };

  /**
   * The live link, or `null`. A Round with no link is not an error and never has been.
   *
   * `no-store`, like the two below and like the anonymous resolution route: these are the responses
   * that **hand out** the credential, and confApp is used on shared hardware by design (review
   * 2026-08-31, L8). Fastify sends no default directive, so without this the body carrying a bearer
   * token is left to whatever heuristic a browser or an intermediary applies.
   */
  app.get(DISPLAY_LINK_URL, {
    schema: { params: roundParamsSchema },
    onRequest: noStore,
    handler: withAuth(async (request, caller) => {
      const session = await authorizeDisplayLink(request, caller);
      const { roundId } = request.params as RoundParams;

      const link = await displayLinks.current(session.conferenceId, session.id, roundId);
      return { displayLink: link };
    }),
  });

  /**
   * Issue, which is also how a link is **replaced**.
   *
   * A Round holds at most one live link, so issuing again revokes the current one in the same
   * transaction and inserts the new one - and the request names no link, because there is never
   * more than one to mean. The value that comes back is different every time and the previous one
   * stops resolving at the next poll, wherever it had been pasted.
   *
   * Refused on an Archived Conference through `authorizeWrite`: a Conference that has gone
   * read-only does not get a new way in.
   */
  app.post(DISPLAY_LINK_URL, {
    schema: { params: roundParamsSchema },
    onRequest: noStore,
    handler: withAuth(async (request, caller) => {
      const { session } = await authorizeWrite(request, caller);
      const { roundId } = request.params as RoundParams;

      const issued = await displayLinks.issue(
        session.conferenceId,
        session.id,
        roundId,
        // The issuer is the verified credential. There is no parameter here a body could reach.
        caller.sub,
        mintDisplayLinkToken(),
      );
      if (issued.outcome !== 'issued') throw roundNotFound();

      return { displayLink: issued.link };
    }),
  });

  /**
   * Revoke, which **names the Round and not a link**.
   *
   * There is at most one live link per Round, so there is nothing to disambiguate and no identifier
   * for a Facilitator to have kept. Revoking twice succeeds twice - the end state is the same and a
   * second press is not a mistake - and no path anywhere can move a link back to live.
   *
   * The room machine finds out at its next poll, within the near-live window, with nobody touching
   * it: the resolution route re-reads the row on every request and nothing between the two is
   * allowed to answer from a copy (`Cache-Control: no-store`, and the service worker refuses the
   * path outright).
   */
  app.delete(DISPLAY_LINK_URL, {
    schema: { params: roundParamsSchema },
    onRequest: noStore,
    handler: withAuth(async (request, caller) => {
      const session = await authorizeDisplayLink(request, caller);
      const { roundId } = request.params as RoundParams;

      await displayLinks.revoke(session.conferenceId, session.id, roundId);
      return { displayLink: null };
    }),
  });
}
