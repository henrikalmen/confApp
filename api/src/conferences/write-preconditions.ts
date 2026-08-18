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
 * Reversing the last two is the defect this guards against. An Admin archives a Conference while a
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

export function isWriteBase(value: unknown): value is WriteBase {
  if (typeof value !== 'object' || value === null) return false;
  const { conferenceState, version } = value as Record<string, unknown>;
  return isLifecycleState(conferenceState) && typeof version === 'string' && version !== '';
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
function versionConflict(subject: string): AppError {
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
export function assertWritePreconditions(options: {
  conference: PreconditionSubject;
  base: WriteBase;
  /** The row version as it stands in the database right now. */
  currentVersion: string;
  /** How the edited thing is named in the refusal – 'session' or 'conference'. */
  subject: string;
}): void {
  const { conference, base, currentVersion, subject } = options;

  if (base.conferenceState !== conference.lifecycleState) {
    throw stateChanged(conference.lifecycleState);
  }
  assertEditable(conference);

  if (base.version !== currentVersion) throw versionConflict(subject);
}

/** Reads the base off a request body, refusing a write that carries none. */
export function requireWriteBase(value: unknown): WriteBase {
  if (!isWriteBase(value)) throw baseMissing();
  return value;
}
