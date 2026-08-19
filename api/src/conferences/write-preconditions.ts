import { AppError, ERROR_CODES } from '../errors.ts';
import { assertEditable, isLifecycleState, type LifecycleState } from './lifecycle.ts';

/**
 * The three checks every post-publish write runs, in the one order they may run in (S09 TI05).
 *
 * **authorization → lifecycle → base version**, and the order is the whole reason this module
 * exists. Authorization is asserted by the route through S03's helper before anything here is
 * called; the two that remain are ordered here, once, and both write paths call this rather than
 * repeating the sequence.
 *
 * **The base-version check is not here.** It lives in the write statement itself – the repository
 * adds `where … and <version column> = $base`, so the comparison and the write are one indivisible
 * step. Comparing a version read in an earlier round trip and writing afterwards leaves a window in
 * which two concurrent saves both read the same value, both compare equal, and both write: the
 * second silently overwrites the first while being told it succeeded. That is last-write-wins
 * reappearing inside the mechanism built to prevent it, reachable in exactly the two-Admin case
 * this story is named for. What remains here is the lifecycle half, which must be decided *before*
 * the version half.
 *
 * Reversing the two is the defect this guards against. An Admin archives a Conference while a
 * colleague is mid-edit; the colleague saves. If the base-version check ran first it would fire –
 * archiving advances nothing on the *Session* row, but on the Conference path it moves
 * `updated_at` – and the colleague would be told "someone else changed this, re-apply your edit"
 * about a Conference that can no longer be edited at all. The advice would be wrong and the real
 * reason invisible. Lifecycle first means the refusal names the state (`PRD → Edge Cases`, "one
 * admin archives or publishes mid-edit").
 *
 * Nothing here reads the database or holds state between calls: every input is a value the caller
 * has just read on this request (ADR-004).
 */

/** What a write must declare about the version of the world it was composed against. */
export interface WriteBase {
  /**
   * The Conference's lifecycle state as the editor loaded it.
   *
   * Sent by the client because a lifecycle race is only detectable against the state the editor
   * *saw*. There is no server-side alternative: remembering per-editor state across requests is
   * precisely what the stateless-handler rule forbids, and the Session's own row version cannot
   * carry it – publishing and archiving are Conference writes and leave every Session row untouched.
   */
  conferenceState: LifecycleState;
  /**
   * The row version of the thing being edited, exactly as it was serialized to the editor –
   * `session.lastUpdatedAt` for a Session, `conference.updatedAt` for the Conference itself.
   *
   * Compared as the string it arrived as. Both are serialized in SQL at full microsecond precision
   * for this comparison alone: re-parsing either through a `Date` truncates to milliseconds, which
   * collapses two distinct versions into one and quietly reinstates last-write-wins for the two
   * saves most likely to land inside the same millisecond – the concurrent ones.
   */
  version: string;
}

/** What the precondition step needs to know about the Conference. Deliberately not the whole row. */
export interface PreconditionSubject {
  lifecycleState: LifecycleState;
  endDate: string;
}

/**
 * The exact shape `instantExpression` serializes a row version to: ISO-8601 UTC, microseconds, `Z`.
 *
 * Checked rather than assumed, because the version now reaches PostgreSQL as `$n::timestamptz`.
 * A value that is not a timestamp raises SQLSTATE 22007 there, which nothing maps - so an
 * out-of-date client, a truncated value or a URL-mangled query parameter turned a recoverable
 * refusal into a 500 and an error-level log line per attempt. A malformed version cannot match any
 * real row, so the honest answer is the same conflict a stale one gets.
 */
const VERSION_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** Days in a month, Gregorian, so 30 February is refused here rather than by PostgreSQL. */
function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/**
 * Is a shape-valid version an instant that actually exists?
 *
 * `VERSION_SHAPE` counts digits and nothing more, so `2026-13-45T25:61:61.000000Z` passes it and
 * then reaches `$n::timestamptz`, where PostgreSQL raises SQLSTATE 22008 - a 500 and an error-level
 * log line for what is, once again, a value that cannot be any row's version. The fields are
 * range-checked here so the same recoverable conflict comes back for a malformed version whichever
 * way it is malformed.
 *
 * Checked field by field rather than through `Date`: `Date.parse` accepts `2026-02-30` and silently
 * rolls it into 2 March, so it would wave through exactly the values PostgreSQL rejects.
 */
function isRealInstant(version: string): boolean {
  const year = Number(version.slice(0, 4));
  const month = Number(version.slice(5, 7));
  const day = Number(version.slice(8, 10));
  const hour = Number(version.slice(11, 13));
  const minute = Number(version.slice(14, 16));
  const second = Number(version.slice(17, 19));

  // Year 0 does not exist in PostgreSQL's calendar either, and a leap second is not a value this
  // API ever serializes - both would be refused downstream, so both are refused here.
  if (year < 1 || month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  return hour <= 23 && minute <= 59 && second <= 59;
}

export function isWriteBase(value: unknown): value is WriteBase {
  if (typeof value !== 'object' || value === null) return false;
  const { conferenceState, version } = value as Record<string, unknown>;
  return (
    isLifecycleState(conferenceState) &&
    typeof version === 'string' &&
    VERSION_SHAPE.test(version) &&
    isRealInstant(version)
  );
}

/**
 * A write that arrived without the base it was composed against.
 *
 * Refused rather than accepted as a force-write. Treating a missing base as "no opinion, save
 * anyway" would make last-write-wins reachable from any client that simply omitted the field,
 * which is the failure this whole mechanism exists to prevent – and it would be reachable by
 * accident rather than by decision.
 */
function baseMissing(): AppError {
  return new AppError(
    ERROR_CODES.VALIDATION_FAILED,
    400,
    'This change did not say which version it was based on, so it was not saved. ' +
      'Reload the schedule and make the change again.',
  );
}

/** How a state is named to a person, in the sentence the editor reads. */
const STATE_SENTENCE: Record<LifecycleState, string> = {
  draft: 'moved back to draft',
  published: 'published',
  archived: 'archived',
};

/**
 * The Conference changed lifecycle state under an in-flight edit.
 *
 * Names the state it is in **now**, not the one the editor left. "This conference changed while you
 * were editing" would leave them to go and find out which of two very different things happened:
 * a publish means the change is still possible and simply has a wider audience now, an archive
 * means it never will be.
 */
function stateChanged(current: LifecycleState): AppError {
  return new AppError(
    ERROR_CODES.CONFERENCE_STATE_CHANGED,
    409,
    `This conference was ${STATE_SENTENCE[current]} while you were editing, so your change was ` +
      `not saved. It is now ${current}. Reload it to see where that leaves your edit.`,
  );
}

/**
 * Somebody else saved this row first.
 *
 * The current representation travels beside this refusal in the response payload, so the editor
 * can re-apply their change on top of it rather than retype it from memory – the recovery path the
 * PRD's edge-case table asks for. The message says what happened, never "try again", because
 * trying again unchanged would simply be refused identically.
 */
export function versionConflict(subject: string): AppError {
  return new AppError(
    ERROR_CODES.EDIT_VERSION_CONFLICT,
    409,
    `This ${subject} changed since you opened it, so your change was not saved. ` +
      'The current version is shown beside your edit – re-apply it and save again.',
  );
}

/**
 * Runs the lifecycle and base-version checks, in that order, and returns having decided the write
 * may proceed.
 *
 * The state-change check comes before `assertEditable` deliberately. An editor whose Conference was
 * archived under them is told *that*, with the new state named; an editor acting on a Conference
 * that was already archived when they loaded it has no stale view and is told the standing rule
 * ("this is archived and read-only") through S03's existing guard. Two different situations, two
 * different sentences, and neither is a version conflict.
 */
export function assertLifecyclePreconditions(options: {
  conference: PreconditionSubject;
  base: WriteBase;
}): void {
  const { conference, base } = options;

  if (base.conferenceState !== conference.lifecycleState) {
    throw stateChanged(conference.lifecycleState);
  }
  assertEditable(conference);
}

/**
 * Reads the base off a request body, refusing a write that carries none - or one whose version is
 * not a row version at all.
 *
 * A malformed version is refused as a **version conflict** rather than a missing base: the client
 * did state what it was based on, that value simply cannot be any row's version, and the conflict
 * carries the recovery path ("reload and re-apply") that actually applies.
 */
export function requireWriteBase(value: unknown, subject = 'record'): WriteBase {
  if (isWriteBase(value)) return value;

  const version = (value as { version?: unknown } | null)?.version;
  if (
    typeof version === 'string' &&
    version !== '' &&
    !(VERSION_SHAPE.test(version) && isRealInstant(version))
  ) {
    throw versionConflict(subject);
  }
  throw baseMissing();
}
