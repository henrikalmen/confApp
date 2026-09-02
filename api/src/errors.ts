/**
 * The API's single error envelope.
 *
 * Every refusal this API emits – validation, unknown route, database trouble, or an
 * unhandled throw – leaves the server in exactly this shape. Later API stories emit
 * their refusals through `AppError` rather than inventing per-endpoint shapes
 * (`plan.json` → sharedDecisions → "API route, handler and error envelope conventions").
 *
 * Rules that hold for every entry:
 * - the HTTP status carries the class of failure;
 * - `code` is a stable SCREAMING_SNAKE identifier a client can branch on;
 * - `message` is a complete, displayable sentence naming the reason – the PRD's error
 *   handling is user-facing prose, so this is shown to a person, not just logged;
 * - `details` is present only for field-level rejections.
 */

export const ERROR_CODES = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  ROUTE_NOT_FOUND: 'ROUTE_NOT_FOUND',
  DATABASE_UNAVAILABLE: 'DATABASE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',

  // ---------- authentication (S02) ----------
  // Every distinguishable way a credential can fail gets its own code, so a client can tell
  // "sign in again" from "you are not allowed here" without parsing prose. The messages are
  // displayable sentences for the same reason every other envelope message is.
  AUTH_CREDENTIAL_MISSING: 'AUTH_CREDENTIAL_MISSING',
  AUTH_CREDENTIAL_MALFORMED: 'AUTH_CREDENTIAL_MALFORMED',
  AUTH_TOKEN_MALFORMED: 'AUTH_TOKEN_MALFORMED',
  AUTH_TOKEN_SIGNATURE_INVALID: 'AUTH_TOKEN_SIGNATURE_INVALID',
  AUTH_TOKEN_ISSUER_INVALID: 'AUTH_TOKEN_ISSUER_INVALID',
  AUTH_TOKEN_AUDIENCE_INVALID: 'AUTH_TOKEN_AUDIENCE_INVALID',
  AUTH_TOKEN_EXPIRED: 'AUTH_TOKEN_EXPIRED',
  AUTH_SIGNING_KEY_UNKNOWN: 'AUTH_SIGNING_KEY_UNKNOWN',
  /** The token carried no `hd` claim at all – a consumer @gmail.com account. */
  AUTH_DOMAIN_CLAIM_MISSING: 'AUTH_DOMAIN_CLAIM_MISSING',
  /** The token carried an `hd` claim for some other company's Workspace domain. */
  AUTH_DOMAIN_NOT_ALLOWED: 'AUTH_DOMAIN_NOT_ALLOWED',
  AUTH_NONCE_MISMATCH: 'AUTH_NONCE_MISMATCH',
  AUTH_EXCHANGE_FAILED: 'AUTH_EXCHANGE_FAILED',

  // ---------- conference lifecycle (S03) ----------
  // One code per *reason*, not one per endpoint. The organizer surfaces show `message`; these
  // exist so a client can tell "fix this field" from "you may not do this" from "not yet"
  // without reading prose, and so a test can assert which rule refused.
  /** The name is blank after trimming, or longer than 120 characters. */
  CONFERENCE_NAME_INVALID: 'CONFERENCE_NAME_INVALID',
  /** The dates are unreadable, out of order, or span something other than 1–4 days. */
  CONFERENCE_DATE_SPAN_INVALID: 'CONFERENCE_DATE_SPAN_INVALID',
  /** No Conference with that id, asked by someone entitled to know that. */
  CONFERENCE_NOT_FOUND: 'CONFERENCE_NOT_FOUND',
  /** The caller does not hold the required role in this Conference. */
  CONFERENCE_ROLE_REQUIRED: 'CONFERENCE_ROLE_REQUIRED',
  /** The requested lifecycle move is not one the state machine permits. */
  CONFERENCE_TRANSITION_NOT_PERMITTED: 'CONFERENCE_TRANSITION_NOT_PERMITTED',
  /** Publish was asked for while the Conference still has no Session. */
  CONFERENCE_SCHEDULE_REQUIRED: 'CONFERENCE_SCHEDULE_REQUIRED',
  /** Archive was asked for on or before the Conference's end date. */
  CONFERENCE_ARCHIVE_TOO_EARLY: 'CONFERENCE_ARCHIVE_TOO_EARLY',
  /** An edit was attempted on an archived Conference, which is read-only. */
  CONFERENCE_NOT_EDITABLE: 'CONFERENCE_NOT_EDITABLE',

  // ---------- join code access (S05) ----------
  // One code per *reason*, deliberately disclosing which. Non-disclosure is not attempted: the
  // Join Code is not a security boundary – sign-in already restricts confApp to the company
  // Workspace domain (ADR-002) – and "invalid code" on the morning of day one costs an employee
  // more than the vagueness protects. The three non-joinable reasons are separate codes because
  // they are separate situations: one resolves itself when the Organizer publishes, one never
  // will, and one means the conference is over.
  /** No Conference in the database holds that code, in any lifecycle state. */
  JOIN_CODE_UNKNOWN: 'JOIN_CODE_UNKNOWN',
  /** The code names a Conference that is still a draft. */
  JOIN_CONFERENCE_NOT_PUBLISHED: 'JOIN_CONFERENCE_NOT_PUBLISHED',
  /** The code names a Conference that has been archived. */
  JOIN_CONFERENCE_ARCHIVED: 'JOIN_CONFERENCE_ARCHIVED',
  /** The code names a Conference whose end date has passed, archived or not. */
  JOIN_CONFERENCE_ENDED: 'JOIN_CONFERENCE_ENDED',
  /** This `sub` has made too many failed attempts inside the rolling window. */
  JOIN_ATTEMPTS_RATE_LIMITED: 'JOIN_ATTEMPTS_RATE_LIMITED',

  // ---------- schedule composition (S04) ----------
  // One code per rule, so the composition form can attach each message to the control it is
  // about and a test can assert which rule refused. There is deliberately no code for an
  // overlapping Session: overlap is a supported product option (Parallel Tracks) and is
  // reported as a non-blocking warning on a *successful* save, never as a refusal.
  /** The title is blank after trimming, or longer than 200 characters. */
  SESSION_TITLE_INVALID: 'SESSION_TITLE_INVALID',
  /** The location is blank after trimming, or longer than 100 characters. */
  SESSION_LOCATION_INVALID: 'SESSION_LOCATION_INVALID',
  /** The kind is something other than Presentation or Workshop. */
  SESSION_KIND_INVALID: 'SESSION_KIND_INVALID',
  /** The times are unreadable, or the end time is not after the start time. */
  SESSION_TIME_RANGE_INVALID: 'SESSION_TIME_RANGE_INVALID',
  /** The day is unreadable, or falls outside the Conference's date span. */
  SESSION_DAY_OUT_OF_SPAN: 'SESSION_DAY_OUT_OF_SPAN',
  /** No Session with that id in this Conference, asked by someone entitled to know that. */
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  /** Deleting the sole Session of a published Conference, which must keep a schedule. */
  SESSION_LAST_IN_PUBLISHED_CONFERENCE: 'SESSION_LAST_IN_PUBLISHED_CONFERENCE',
  /**
   * A write gave up waiting on a row somebody else was holding (`lock_timeout`, SQLSTATE 55P03).
   *
   * Distinct from every other refusal in this file because it is the only one where **retrying
   * unchanged is the right advice**. Nothing conflicts, nothing is stale, and the request was not
   * wrong - the Conference was simply busy. The alternative was holding the Conference row for as
   * long as the other writer took, which blocks every writer in that Conference rather than one.
   */
  CONFERENCE_BUSY: 'CONFERENCE_BUSY',
  /**
   * Deleting a Session that already holds collected output (S05 FR7).
   *
   * Its own reason and so its own code, kept apart from
   * SESSION_LAST_IN_PUBLISHED_CONFERENCE because the two send the Organizer to do opposite
   * things. That one means "add another session, then try again"; this one means the delete is
   * never going to be possible and the way forward is to edit or reschedule instead. The message
   * carries the counts because FR7's criterion is that the refusal *names what would be lost*.
   */
  SESSION_HOLDS_CONTRIBUTIONS: 'SESSION_HOLDS_CONTRIBUTIONS',

  // ---------- attendee schedule read (S06) ----------
  // Two reasons, two codes, because they are two different situations for the person holding the
  // phone: one means "you are not in this conference", the other means "you are, but there is
  // nothing published to show you yet". Neither is CONFERENCE_ROLE_REQUIRED: that one answers a
  // question about *acting* on a conference, and an attendee reading a schedule is not acting.
  /** The caller holds no Membership for this Conference – or it does not exist, told alike. */
  NOT_A_MEMBER: 'NOT_A_MEMBER',
  /** The Conference exists and the caller is in it, but it is still a draft. */
  CONFERENCE_NOT_READABLE: 'CONFERENCE_NOT_READABLE',

  // ---------- per-conference roles (S07) ----------
  // One code per *reason*, distinct from every other, because each one is a different thing for
  // the Admin to do next: wait for someone to sign in, pick a different person, add a second
  // Admin first, or give up because the conference is closed. A single ROLE_CHANGE_REFUSED would
  // collapse four different next actions into one sentence the client could not branch on.
  /** The revocation would leave the Conference with no Admin at all. */
  CONFERENCE_LAST_ADMIN: 'CONFERENCE_LAST_ADMIN',
  /** The typed address matches no confApp user – nobody by that name has ever signed in. */
  ROLE_TARGET_NOT_SIGNED_IN: 'ROLE_TARGET_NOT_SIGNED_IN',
  /**
   * The typed address matches more than one confApp user, so no single `sub` can be resolved.
   *
   * Reachable because `app_user` carries no unique index on email, deliberately: an address that
   * is freed and reissued belongs to two different people, and both keep their row. Resolving it
   * by picking either would key the assignment on a guess – see the Discovered Requirement in
   * `s07-per-conference-roles.md`.
   */
  ROLE_TARGET_AMBIGUOUS: 'ROLE_TARGET_AMBIGUOUS',
  /** The target is a confApp user but has not joined this Conference. */
  ROLE_TARGET_NOT_A_MEMBER: 'ROLE_TARGET_NOT_A_MEMBER',
  /** The revocation names a role this member does not currently hold here. */
  ROLE_ASSIGNMENT_NOT_FOUND: 'ROLE_ASSIGNMENT_NOT_FOUND',
  /** A Session was assigned to someone who does not hold Presenter/Facilitator in this Conference. */
  SESSION_ASSIGNMENT_ROLE_REQUIRED: 'SESSION_ASSIGNMENT_ROLE_REQUIRED',

  // ---------- live schedule editing (S09) ----------
  // Three codes for three genuinely different next actions, and collapsing any two of them would
  // cost the editor the one thing they need to know. "Someone else changed this row" means re-apply
  // your edit onto the version returned beside this refusal. "The conference was published or
  // archived while you were typing" means the edit may no longer be possible at all, and which it
  // is depends on the state named in the message. "Those dates would strand these sessions" means
  // go and move the sessions the message lists, then try the same change again. A single
  // EDIT_REFUSED would leave the client parsing prose to tell them apart.
  /**
   * The base row version sent with the write is not the row's current version – someone saved
   * between the editor loading the row and saving it. The payload carries the current version so
   * the edit can be re-applied on top of it rather than retyped.
   */
  EDIT_VERSION_CONFLICT: 'EDIT_VERSION_CONFLICT',
  /**
   * The Conference moved to another lifecycle state between load and save. Distinct from
   * EDIT_VERSION_CONFLICT because it is not the edited row that moved, and distinct from
   * CONFERENCE_NOT_EDITABLE because that one answers "this is archived" to someone who never had a
   * stale view – here the message must name the *new* state, which is the edge case's whole point.
   */
  CONFERENCE_STATE_CHANGED: 'CONFERENCE_STATE_CHANGED',
  /** The requested date span would leave existing Sessions outside the Conference's days. */
  CONFERENCE_SPAN_ORPHANS_SESSIONS: 'CONFERENCE_SPAN_ORPHANS_SESSIONS',

  // ---------- session activities: rounds (S01) ----------
  // One code per *reason*, following the convention above. Each one is a different thing for the
  // Facilitator to do next: fix the kind or purpose they sent, fix the text, fix the option list,
  // look somewhere else for the round, accept that this transition is not available, or accept
  // that voting has already frozen what the poll asks. A single ROUND_REFUSED would collapse six
  // different next actions into one sentence the client could not branch on.
  /** The kind is not one of the two Activities, or the purpose does not match the kind. */
  ROUND_KIND_INVALID: 'ROUND_KIND_INVALID',
  /** The prompt or question is blank after trimming, or longer than the cap. */
  ROUND_PROMPT_INVALID: 'ROUND_PROMPT_INVALID',
  /** The option list is too short, carries a blank or over-long label, or repeats one. */
  ROUND_OPTIONS_INVALID: 'ROUND_OPTIONS_INVALID',
  /** An edit tried to change what a Round *is* – its kind or its Voting Round purpose. */
  ROUND_KIND_IMMUTABLE: 'ROUND_KIND_IMMUTABLE',
  /** No Round with that id on this Session, asked by someone entitled to know that. */
  ROUND_NOT_FOUND: 'ROUND_NOT_FOUND',
  /** The requested open/close move is not one this Round permits – reopening a Poll that has run. */
  ROUND_TRANSITION_NOT_PERMITTED: 'ROUND_TRANSITION_NOT_PERMITTED',
  /** A Poll's question or options were edited after its first Vote was cast. */
  POLL_CONTENT_FROZEN: 'POLL_CONTENT_FROZEN',

  // ---------- session activities: post-its (S02) ----------
  // Three reasons, three codes, for three different next actions: fix what you typed, accept that
  // this one is not yours to change, or accept that the round has stopped taking contributions.
  // None of them is a synonym for a reason that already has a code above - a closed *Post-it*
  // Round refusing a contribution is not ROUND_TRANSITION_NOT_PERMITTED, which answers "this poll
  // has already shown its results" to a Facilitator working the run controls.
  /** The post-it text is blank after trimming, or longer than POST_IT_MAX_LENGTH. */
  POST_IT_TEXT_INVALID: 'POST_IT_TEXT_INVALID',
  /**
   * The Round is not taking contributions: it is closed, so contributing, correcting and removing
   * are all refused at the API and not merely hidden by a disabled control.
   */
  POST_IT_ROUND_CLOSED: 'POST_IT_ROUND_CLOSED',
  /**
   * The post-it belongs to somebody else.
   *
   * Deliberately distinct from CONFERENCE_ROLE_REQUIRED and NOT_A_MEMBER: the caller is in the
   * room and entitled to be here, and what refused them is authorship, not authority.
   */
  POST_IT_NOT_AUTHOR: 'POST_IT_NOT_AUTHOR',
  /** No post-it with that id on this Round, asked by someone entitled to know that. */
  POST_IT_NOT_FOUND: 'POST_IT_NOT_FOUND',
  /**
   * The post-it has been discarded, said to a Facilitator trying to move it (S05, FR3 -> Validation).
   *
   * Its own code, and neither of the two the placement path already had. It is not
   * POST_IT_NOT_FOUND: the post-it is still stored, still carries its author's text, and is still
   * restorable - "no longer on this round" would send a Facilitator looking for something that never
   * left. And it is emphatically not CATEGORY_NOT_FOUND, which is what a discarded post-it *used* to
   * be refused with before this code existed, naming a destination that was perfectly valid.
   *
   * The next action is the reason it earns a code: restore it first, from the discarded post-its
   * surface. Nobody else's refusal has that next move.
   *
   * `409`, because it is a state conflict rather than a malformed request: nothing about what was
   * sent is wrong. Reachable only to a holder of sorting authority, who can already read the
   * discarded list.
   */
  POST_IT_DISCARDED: 'POST_IT_DISCARDED',
  /**
   * Permanent Removal was attempted by somebody who is not a conference-wide Admin (S06, FR5).
   *
   * Its own code rather than CONFERENCE_ROLE_REQUIRED, because the next action is different and
   * that is this block's whole rule. CONFERENCE_ROLE_REQUIRED is the *non-disclosing* refusal - it
   * says nothing about the conference, the session or what the caller holds, deliberately, so a
   * stranger cannot enumerate anything with it. The caller here is not a stranger: they hold
   * sorting authority on this very Board and are looking at the Post-it. Telling them "only an
   * admin, and Discard is the act you already have" discloses nothing they cannot already see and
   * is the only useful sentence - "you do not have permission to do this" would leave a Facilitator
   * with an abusive Post-it on a projected wall and no next move.
   *
   * `403`. It is an authority refusal, and the request itself is perfectly well formed.
   *
   * Reached only *after* the sorting-authority gate has passed, which is what keeps the disclosure
   * that narrow: someone with no standing in the Conference never sees this code
   * (`api/src/routes/rounds.ts` -> the permanent-removal route).
   */
  POST_IT_ADMIN_REQUIRED: 'POST_IT_ADMIN_REQUIRED',

  // ---------- facilitator board: categories (S02) ----------
  // Four reasons, four codes, one per distinct next action: fix the name you typed, remove or
  // merge a category before adding another, say where this category's post-its go, or accept that
  // the category is not there any more. None is a synonym for a code above - a Board write refused
  // for authority is still CONFERENCE_ROLE_REQUIRED and one refused on an archived Conference is
  // still CONFERENCE_NOT_EDITABLE, because those are one rule with one sentence each and this
  // feature does not get a second copy of either.
  /** The category name is blank after trimming, or longer than CATEGORY_NAME_MAX_LENGTH. */
  CATEGORY_NAME_INVALID: 'CATEGORY_NAME_INVALID',
  /**
   * The board already holds as many categories as it may.
   *
   * The message names the limit **and the current count**, because that is what tells the
   * Facilitator the create failed on a full board rather than on something they typed. The count is
   * read fresh at the moment of refusal, so a create that lost a race for the last slot reports the
   * board as it actually is rather than as this request last saw it.
   */
  CATEGORY_LIMIT_REACHED: 'CATEGORY_LIMIT_REACHED',
  /**
   * A category holding post-its was asked to go with no destination for them.
   *
   * Its own code rather than a validation failure: nothing about the request is malformed, and the
   * next action is a choice the Facilitator has to make - move them to Uncategorised, or to another
   * category. The message carries the count because the choice depends on it.
   */
  CATEGORY_HOLDS_POST_ITS: 'CATEGORY_HOLDS_POST_ITS',
  /**
   * No category with that id on this round, asked by someone entitled to know that.
   *
   * This is also the answer to a request that tries to rename, reorder or remove **Uncategorised**.
   * Uncategorised is not stored as a category row and no identifier addresses it
   * (prd.md#fr2-the-uncategorised-holding-area), so any id sent to a category endpoint either names
   * a real category on this round or names nothing at all - and there is deliberately no sentinel
   * value, and so no special case, for the holding area.
   */
  CATEGORY_NOT_FOUND: 'CATEGORY_NOT_FOUND',

  // ---------- session activities: votes (S03) ----------
  // Four reasons, four codes, for four different next actions: your vote is already in and there
  // is nothing further to do, pick an option that is actually on this ballot, the poll has
  // finished, or wait for the result. None is a synonym for a code above.
  //
  // **No refusal on this path ever carries a count, a total or per-option data.** A tally that
  // could be read out of an error body would make the result reachable to somebody the result was
  // deliberately withheld from, and would do it through the one response nobody inspects
  // (prd.md#fr5-poll-result-reveal, FIS -> Constraints & Gotchas).
  /** This Member has already voted in this Poll. A Vote is final once cast. */
  VOTE_ALREADY_CAST: 'VOTE_ALREADY_CAST',
  /** The chosen option is not on this Poll's ballot – it belongs to another Round, or is gone. */
  VOTE_OPTION_UNKNOWN: 'VOTE_OPTION_UNKNOWN',
  /**
   * The Poll has closed, said to somebody trying to vote in it.
   *
   * Deliberately **not** POST_IT_ROUND_CLOSED. That one is S02's, and it means "the round stopped
   * taking post-its while you were typing – your text is still in the box and goes back up if the
   * round reopens". A Poll that has run cannot reopen at all (S01's open predicate refuses a
   * VotingRound carrying a `closed_at`), so that next move does not exist here: what happens next
   * is that the result appears. And it is not ROUND_TRANSITION_NOT_PERMITTED either, which answers
   * a Facilitator working the run controls rather than a Member refused a contribution.
   */
  VOTING_ROUND_CLOSED: 'VOTING_ROUND_CLOSED',
  /**
   * The tally was asked for on an open Poll by somebody who does not run this Session.
   *
   * **Refused rather than answered with an empty or zeroed tally**, which is the point: a zero
   * returned to an Attendee mid-Poll would say something about the votes, and absence would then
   * carry information. This says only that results appear when voting ends.
   */
  POLL_RESULTS_NOT_YET_AVAILABLE: 'POLL_RESULTS_NOT_YET_AVAILABLE',

  // ---------- the projected board: display links (S04) ----------
  /**
   * A Display Link did not resolve. **The deliberate exception to the one-code-per-reason
   * convention every code above follows**, and the exception is the point.
   *
   * Five distinguishable situations answer with this one code, this one status and this one
   * message: the link was revoked, its Round's Session day has passed, its Conference is still
   * Draft, its Round has been deleted, and it was never issued at all. A sixth - a value whose
   * shape could not be a token - answers identically too, which is why the route carries no shape
   * schema on the token parameter (`api/src/routes/display.ts`).
   *
   * Everywhere else in this file a second reason earns a second code, because a caller's next move
   * differs per reason and a person deserves to be told which wall they hit. Here there is no
   * caller to help: the holder is an anonymous browser on a room machine that nobody signed in on,
   * and telling the reasons apart would hand whoever holds a dead value an oracle over confApp's
   * data - which Conferences exist, which have been published, which Rounds were deleted, and
   * whether a guess was "not even a token" or "a token that has died". Every one of those is a fact
   * about named Post-its behind a bearer credential.
   *
   * `404`: the thing named is not there. There is deliberately no `403`, no `410` and no `401` -
   * each of those would say *why*, and "gone" and "never existed" would stop being the same answer.
   * The single sentence lives in `displayLinkUnavailable()` in `api/src/rounds/display-link.ts`,
   * built from a resolution result that carries no reason for it to read.
   */
  DISPLAY_LINK_UNAVAILABLE: 'DISPLAY_LINK_UNAVAILABLE',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface ErrorDetail {
  field: string;
  message: string;
}

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    details?: ErrorDetail[];
    current?: unknown;
  };
}

/** A refusal that is safe to show to the caller. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details: ErrorDetail[] | undefined;
  /**
   * What the refused thing looks like **now** – present only where the caller's next move is to
   * act on it (S09's version conflict, where the editor re-applies their edit onto this version).
   *
   * Additive to S01's envelope rather than a second refusal shape: a client that ignores it still
   * reads `code` and `message` exactly as before. It carries no field a successful read of the same
   * resource would not have disclosed to this caller, who was authorized before the check that
   * refused them ran.
   */
  readonly current: unknown | undefined;

  constructor(
    code: ErrorCode,
    statusCode: number,
    message: string,
    details?: ErrorDetail[],
    current?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    this.current = current;
  }

  /** The same refusal, carrying what the thing looks like now. */
  withCurrent(current: unknown): AppError {
    return new AppError(this.code, this.statusCode, this.message, this.details, current);
  }

  toEnvelope(): ErrorEnvelope {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
        ...(this.current === undefined ? {} : { current: this.current }),
      },
    };
  }
}

export function validationFailed(details: ErrorDetail[]): AppError {
  const fields = details.map((d) => d.field).join(', ');
  return new AppError(
    ERROR_CODES.VALIDATION_FAILED,
    400,
    `The request could not be accepted because ${fields} is not valid.`,
    details,
  );
}

/**
 * No route matched.
 *
 * **The path is deliberately not echoed.** It is attacker-controlled, and on this server it can
 * *be* a credential: a Display Link token rides in the path, and any spelling that misses the
 * display route - a percent-escape, a duplicate slash, a `.` or `..` segment - lands here. Echoing
 * it put a live bearer token into a response body, the shape most likely to be captured by
 * client-side error reporting and by proxies that log bodies but not paths (gap re-review
 * 2026-09-02, G29). Naming the address was worth something to a caller debugging a typo; it is not
 * worth handing back a credential to anyone who can guess a URL shape nobody normalised.
 *
 * The method is kept: it comes from a fixed set, carries no secret, and is the half that actually
 * tells a caller they used the wrong verb.
 */
export function routeNotFound(method: string): AppError {
  return new AppError(
    ERROR_CODES.ROUTE_NOT_FOUND,
    404,
    `No ${method} endpoint exists at that address.`,
  );
}

/**
 * The request line could not be parsed at all - a percent-malformed path, say.
 *
 * Raised by the router *before* any route is dispatched, so it is the one refusal that used to
 * leave the server in Fastify's own shape rather than this envelope (`buildApp`'s
 * `frameworkErrors`). It is here so that the claim this module makes about itself - one envelope,
 * one exit - is true of every response, including the ones no handler produced.
 *
 * **The offending URL is not echoed.** It is attacker-controlled, of no use to a caller who
 * already sent it, and under the Display Link prefix it would be a bearer credential.
 */
export function malformedRequestUrl(): AppError {
  return new AppError(
    ERROR_CODES.VALIDATION_FAILED,
    400,
    'That request could not be read. Check the address and try again.',
  );
}

/**
 * The database could not be reached. The message deliberately carries no driver text,
 * connection string, host name, or stack trace – that detail is logged server-side only.
 */
export function databaseUnavailable(): AppError {
  return new AppError(
    ERROR_CODES.DATABASE_UNAVAILABLE,
    503,
    'The service is temporarily unable to reach its database. Please try again shortly.',
  );
}

/**
 * The database is reachable but its schema has not been migrated yet – the normal state
 * between `docker compose up` and the documented migrate-up command, and after a
 * `docker compose down -v`. It reuses DATABASE_UNAVAILABLE because it is the same class of
 * answer to the caller (the service cannot serve from its database yet) and the code list is
 * fixed; the message is what tells an operator which of the two it is.
 */
export function databaseNotMigrated(): AppError {
  return new AppError(
    ERROR_CODES.DATABASE_UNAVAILABLE,
    503,
    'The service reached its database but the schema has not been migrated yet.',
  );
}

export function internalError(): AppError {
  return new AppError(
    ERROR_CODES.INTERNAL_ERROR,
    500,
    'The server encountered an unexpected problem handling this request.',
  );
}

/**
 * The one place an authentication refusal becomes a response.
 *
 * Two rules hold for every entry. The status separates "we do not know who you are" (401,
 * signing in again may help) from "we know, and this is not your company" (403, it never
 * will). And no message ever repeats the credential back – not the token, not a claim value,
 * not the `Authorization` header – because these strings are logged and displayed.
 */
const AUTH_REFUSALS = {
  [ERROR_CODES.AUTH_CREDENTIAL_MISSING]: [
    401,
    'This request needs you to be signed in. Sign in with your company Google account and try again.',
  ],
  [ERROR_CODES.AUTH_CREDENTIAL_MALFORMED]: [
    401,
    'The sign-in credential on this request was not in the expected format. Please sign in again.',
  ],
  [ERROR_CODES.AUTH_TOKEN_MALFORMED]: [
    401,
    'Your sign-in could not be read. Please sign in again.',
  ],
  [ERROR_CODES.AUTH_TOKEN_SIGNATURE_INVALID]: [
    401,
    'Your sign-in could not be verified as genuine. Please sign in again.',
  ],
  [ERROR_CODES.AUTH_TOKEN_ISSUER_INVALID]: [
    401,
    'Your sign-in did not come from Google. Please sign in again.',
  ],
  [ERROR_CODES.AUTH_TOKEN_AUDIENCE_INVALID]: [
    401,
    'Your sign-in was issued for a different application. Please sign in to confApp again.',
  ],
  [ERROR_CODES.AUTH_TOKEN_EXPIRED]: [401, 'Your sign-in has expired. Please sign in again.'],
  [ERROR_CODES.AUTH_SIGNING_KEY_UNKNOWN]: [
    401,
    'Your sign-in was signed with a key Google does not currently publish. Please sign in again.',
  ],
  [ERROR_CODES.AUTH_DOMAIN_CLAIM_MISSING]: [
    403,
    'confApp is limited to company Google Workspace accounts, and this account is not one. ' +
      'Please sign in with your work account.',
  ],
  [ERROR_CODES.AUTH_DOMAIN_NOT_ALLOWED]: [
    403,
    'confApp is limited to company Google Workspace accounts, and this account belongs to a ' +
      'different organisation.',
  ],
  [ERROR_CODES.AUTH_NONCE_MISMATCH]: [
    401,
    'This sign-in did not match the request that started it, so it was not completed. Please try signing in again.',
  ],
  [ERROR_CODES.AUTH_EXCHANGE_FAILED]: [
    401,
    'Google did not complete this sign-in. Please try signing in again.',
  ],
} as const satisfies Record<AuthRefusalCode, readonly [number, string]>;

/** The subset of `ERROR_CODES` that an authentication decision can produce. */
export type AuthRefusalCode =
  | typeof ERROR_CODES.AUTH_CREDENTIAL_MISSING
  | typeof ERROR_CODES.AUTH_CREDENTIAL_MALFORMED
  | typeof ERROR_CODES.AUTH_TOKEN_MALFORMED
  | typeof ERROR_CODES.AUTH_TOKEN_SIGNATURE_INVALID
  | typeof ERROR_CODES.AUTH_TOKEN_ISSUER_INVALID
  | typeof ERROR_CODES.AUTH_TOKEN_AUDIENCE_INVALID
  | typeof ERROR_CODES.AUTH_TOKEN_EXPIRED
  | typeof ERROR_CODES.AUTH_SIGNING_KEY_UNKNOWN
  | typeof ERROR_CODES.AUTH_DOMAIN_CLAIM_MISSING
  | typeof ERROR_CODES.AUTH_DOMAIN_NOT_ALLOWED
  | typeof ERROR_CODES.AUTH_NONCE_MISMATCH
  | typeof ERROR_CODES.AUTH_EXCHANGE_FAILED;

export function authRefusal(code: AuthRefusalCode): AppError {
  const [status, message] = AUTH_REFUSALS[code];
  return new AppError(code, status, message);
}
