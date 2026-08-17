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
  };
}

/** A refusal that is safe to show to the caller. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details: ErrorDetail[] | undefined;

  constructor(code: ErrorCode, statusCode: number, message: string, details?: ErrorDetail[]) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }

  toEnvelope(): ErrorEnvelope {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
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

export function routeNotFound(method: string, path: string): AppError {
  return new AppError(ERROR_CODES.ROUTE_NOT_FOUND, 404, `No endpoint exists at ${method} ${path}.`);
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
