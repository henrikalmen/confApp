import type { Queryable } from '../db.ts';
import { AppError, ERROR_CODES } from '../errors.ts';

/**
 * The failed-attempt store and the limiter that reads it.
 *
 * Three properties are the whole point of this module, and each of them fails *silently* if it is
 * got wrong – the obvious implementation passes a local test and enforces nothing in production:
 *
 *   *Keyed on the authenticated `sub`, never on the client address.* Nothing here reads a request,
 *   a header or a socket – the caller hands in a `sub` from the S02 caller context and there is no
 *   other way to call it. The venue puts ~100 employees behind one NAT egress address at exactly
 *   the moment of peak joining, so an IP-keyed limiter refuses the scenario the rule exists to
 *   protect (FR3, ADR-002).
 *
 *   *Server-side, not in-process.* The count lives in PostgreSQL. This module holds no state at
 *   all: no map, no static field, no cache. The API scales horizontally across replicas with no
 *   request affinity (ADR-004), so anything remembered here would be per-replica and would
 *   enforce nothing (`AGENTS.md` → never rely on in-process state).
 *
 *   *Atomic per attempt.* Recording is one statement that appends one row. There is no counter to
 *   read and write back, so ten concurrent failures by one `sub` record ten attempts rather than
 *   losing increments to a lost update, and window rollover is a predicate on a timestamp rather
 *   than a field a handler resets.
 *
 * The window arithmetic runs inside PostgreSQL, against the database's clock. Two replicas whose
 * clocks disagree by a minute must still agree on whether an attempt is inside the window, and
 * they only can if one clock decides.
 */

/**
 * Ten failures per `sub` per rolling ten minutes.
 *
 * The PRD names no number: it asks for enough to deter enumeration without locking a legitimate
 * employee out on the morning of day one. Ten is well beyond the two or three attempts a mistyped
 * code costs a person, and a rolling window means the allowance returns by itself – there is no
 * unlock step for an Organizer to perform mid-conference.
 *
 * Constants rather than configuration on purpose. An environment variable here would be a new way
 * for a deployment to start with the limiter effectively disabled.
 */
export const FAILED_ATTEMPT_LIMIT = 10;
export const FAILED_ATTEMPT_WINDOW_MINUTES = 10;

/**
 * One atomic statement that records this attempt and prunes the aged ones.
 *
 * The CTE is not a flourish. Retention has to happen without a manual operational step and without
 * a scheduler that only one replica runs (`TI11`), so it rides along with the write that creates
 * the rows in the first place – the store can never hold more than roughly one window's worth of
 * failures. It stays a *single* statement, so the "one atomic statement per attempt" guarantee is
 * unaffected: nothing between the delete and the insert can observe an intermediate state.
 *
 * The delete predicate is the same window the count uses, so a row is only ever removed once it can
 * no longer count towards anyone's threshold.
 */
const RECORD_AND_PRUNE = `
  with pruned as (
    delete from failed_join_attempt
     where attempted_at < clock_timestamp() - make_interval(mins => $2)
  )
  insert into failed_join_attempt (user_sub) values ($1)
`;

/**
 * The windowed count for one `sub`, and how long until its oldest attempt leaves the window.
 *
 * `retry_after_seconds` is derived from the *oldest* attempt still inside the window, because that
 * is the one whose expiry frees an allowance. It is computed here rather than in JavaScript so the
 * whole comparison happens against one clock – and because node-postgres hands a `timestamptz`
 * back as a millisecond-precision `Date`, which is not a value to do window arithmetic on.
 */
const WINDOW_STATE = `
  select count(*)::int as attempts,
         greatest(
           0,
           ceil(extract(epoch from (
             min(attempted_at) + make_interval(mins => $2) - clock_timestamp()
           )))
         )::int as retry_after_seconds
    from failed_join_attempt
   where user_sub = $1
     and attempted_at >= clock_timestamp() - make_interval(mins => $2)
`;

export interface FailedAttemptWindow {
  /** Failures by this `sub` inside the rolling window. */
  attempts: number;
  /** Seconds until the oldest of them leaves the window, or `null` when there are none. */
  retryAfterSeconds: number | null;
}

export interface FailedJoinAttempts {
  /** Records one failure, and prunes anything that has aged out, in one statement. */
  record(sub: string): Promise<void>;
  /** Reads the window without writing to it – checking is not itself an attempt. */
  window(sub: string): Promise<FailedAttemptWindow>;
  /** Refuses when this `sub` has already used its allowance. */
  assertWithinLimit(sub: string): Promise<void>;
}

/** "in about 3 minutes" – the granularity a person can act on, and never "in 0 minutes". */
function whenToRetry(retryAfterSeconds: number | null): string {
  const seconds = retryAfterSeconds ?? FAILED_ATTEMPT_WINDOW_MINUTES * 60;
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return minutes === 1 ? 'in about a minute' : `in about ${minutes} minutes`;
}

export function rateLimited(retryAfterSeconds: number | null): AppError {
  return new AppError(
    ERROR_CODES.JOIN_ATTEMPTS_RATE_LIMITED,
    429,
    `That is ${FAILED_ATTEMPT_LIMIT} incorrect codes in a row, so joining is paused for a moment. ` +
      `Check the code with the organizer and try again ${whenToRetry(retryAfterSeconds)}.`,
  );
}

export interface FailedJoinAttemptOptions {
  limit?: number;
  windowMinutes?: number;
}

export function createFailedJoinAttempts(
  db: Queryable,
  { limit = FAILED_ATTEMPT_LIMIT, windowMinutes = FAILED_ATTEMPT_WINDOW_MINUTES }:
    FailedJoinAttemptOptions = {},
): FailedJoinAttempts {
  const store: FailedJoinAttempts = {
    async record(sub: string): Promise<void> {
      await db.query(RECORD_AND_PRUNE, [sub, windowMinutes]);
    },

    async window(sub: string): Promise<FailedAttemptWindow> {
      const rows = await db.query<{ attempts: number; retry_after_seconds: number | null }>(
        WINDOW_STATE,
        [sub, windowMinutes],
      );
      const row = rows[0];
      // `count(*)` over an empty set is a row holding 0, so there is always one.
      if (row === undefined) throw new Error('The failed-attempt window query returned no row.');
      return { attempts: row.attempts, retryAfterSeconds: row.retry_after_seconds };
    },

    async assertWithinLimit(sub: string): Promise<void> {
      const { attempts, retryAfterSeconds } = await store.window(sub);
      if (attempts < limit) return;
      throw rateLimited(retryAfterSeconds);
    },
  };

  return store;
}
