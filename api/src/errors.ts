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
