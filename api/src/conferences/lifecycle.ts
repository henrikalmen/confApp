import { AppError, ERROR_CODES } from '../errors.ts';
import { addDays, compareDates, type CalendarDate } from './calendar-date.ts';

/**
 * The single authority on what a Conference's lifecycle state permits.
 *
 * Every question of the form "may this happen now" is answered here and nowhere else: which
 * transitions are legal, whether the Conference may be edited, and whether it may be joined.
 * Handlers ask; they do not decide. The client may hide or disable an affordance, but the
 * refusal is reproducible by calling the endpoint directly, because the check lives on this side.
 *
 * The module holds no state. Everything is a pure function of the Conference row passed in, which
 * the caller has just read from the database. The API runs as several container replicas with no
 * request affinity, so anything remembered here would be wrong on the next request anyway
 * (ADR-004, ARCHITECTURE.md#key-constraints).
 */

export const LIFECYCLE_STATES = ['draft', 'published', 'archived'] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

export function isLifecycleState(value: unknown): value is LifecycleState {
  return typeof value === 'string' && (LIFECYCLE_STATES as readonly string[]).includes(value);
}

/**
 * The whole state machine, as data.
 *
 * draft → published → archived, and nothing else. There is no way back to draft: a published
 * Conference has been seen by attendees and un-publishing it would retract something people are
 * already relying on. Archived is terminal – it lists no successors at all, which is what makes
 * "archived is final" a property of this table rather than of a check someone remembered.
 */
const PERMITTED_TRANSITIONS: Record<LifecycleState, readonly LifecycleState[]> = {
  draft: ['published'],
  published: ['archived'],
  archived: [],
};

/** How a state is named to a person. The wire and the database use the lowercase form. */
const STATE_LABELS: Record<LifecycleState, string> = {
  draft: 'draft',
  published: 'published',
  archived: 'archived',
};

/** What the lifecycle rules need to know about a Conference. Deliberately not the whole row. */
export interface LifecycleSubject {
  lifecycleState: LifecycleState;
  endDate: CalendarDate;
}

export function isTransitionPermitted(from: LifecycleState, to: LifecycleState): boolean {
  return PERMITTED_TRANSITIONS[from].includes(to);
}

/**
 * Refuses with both states named, because "that is not allowed" leaves an organizer with nothing
 * to act on – they need to know what the Conference actually is now.
 */
export function assertTransitionPermitted(from: LifecycleState, to: LifecycleState): void {
  if (isTransitionPermitted(from, to)) return;

  const terminal = PERMITTED_TRANSITIONS[from].length === 0;
  const because = terminal
    ? `A ${STATE_LABELS[from]} conference is final and cannot be changed to ${STATE_LABELS[to]}.`
    : `A ${STATE_LABELS[from]} conference cannot be changed to ${STATE_LABELS[to]}.`;

  throw new AppError(ERROR_CODES.CONFERENCE_TRANSITION_NOT_PERMITTED, 409, because);
}

// ---------- the guards S05 and S09 consume (S03 TI10) ----------

/**
 * Editable means "not archived". Archiving makes a Conference read-only (FR9); draft and
 * published both accept edits, and a published Conference explicitly stays editable (FR1).
 *
 * S09 asserts its edit refusals against this predicate rather than re-deriving the rule.
 */
export function isEditable(conference: LifecycleSubject): boolean {
  return conference.lifecycleState !== 'archived';
}

export function assertEditable(conference: LifecycleSubject): void {
  if (isEditable(conference)) return;
  throw new AppError(
    ERROR_CODES.CONFERENCE_NOT_EDITABLE,
    409,
    'This conference has been archived, so it is read-only and can no longer be changed.',
  );
}

/**
 * Why a Conference cannot be joined – the three situations, named.
 *
 * They are distinguished here and not by the caller. S05's join endpoint has to tell an employee
 * which of the three it is (FR3 → Error Handling), and the only way to do that without a second
 * copy of the lifecycle rule living in the join path is for the rule itself to report its reason.
 */
export type JoinRefusalReason = 'not-published' | 'archived' | 'ended';

/**
 * The single, whole definition of joinable – state AND end date, in one place.
 *
 * Both halves matter, and the second is the one that gets forgotten: a Conference that is still
 * `published` but ended yesterday is closed, whether or not anyone has got round to archiving it.
 * Joining ends with the end date, not with the manual archive step.
 *
 * Order is deliberate. A draft is reported as not-published whatever its dates, because publishing
 * is what its Organizer has to do next and a date is irrelevant to that. An archived Conference is
 * reported as archived rather than as ended, because archived is the terminal fact and "it ended"
 * would invite the employee to wait for something.
 *
 * Every consumer reaches the rule through this function or through the two below it. S05's join,
 * re-join and refusal paths call them and restate nothing – two implementations of one invariant is
 * precisely what a later story then has to unpick.
 */
export function joinRefusalReason(
  conference: LifecycleSubject,
  today: CalendarDate,
): JoinRefusalReason | null {
  if (conference.lifecycleState === 'draft') return 'not-published';
  if (conference.lifecycleState === 'archived') return 'archived';
  // Still joinable *on* the last day; closed the day after.
  if (compareDates(conference.endDate, today) < 0) return 'ended';
  return null;
}

export function isJoinable(conference: LifecycleSubject, today: CalendarDate): boolean {
  return joinRefusalReason(conference, today) === null;
}

/** The refusal each reason produces, in the words the employee reads. */
const JOIN_REFUSALS: Record<
  JoinRefusalReason,
  (conference: LifecycleSubject & { name: string }) => AppError
> = {
  'not-published': (conference) =>
    new AppError(
      ERROR_CODES.JOIN_CONFERENCE_NOT_PUBLISHED,
      409,
      `That code is for "${conference.name}", which has not been published yet. ` +
        'Ask the organizer to publish it, then try again.',
    ),
  archived: (conference) =>
    new AppError(
      ERROR_CODES.JOIN_CONFERENCE_ARCHIVED,
      409,
      `That code is for "${conference.name}", which has been archived and can no longer be joined.`,
    ),
  ended: (conference) =>
    new AppError(
      ERROR_CODES.JOIN_CONFERENCE_ENDED,
      409,
      `That code is for "${conference.name}", which ended on ${conference.endDate} and can no ` +
        'longer be joined.',
    ),
};

/**
 * Refuses a join with the reason named, or returns having decided the Conference is joinable.
 *
 * The Conference is named in every message. Non-disclosure is deliberately not attempted (FR3 →
 * Error Handling): the code is not a security boundary, and an employee who mistyped one digit
 * needs to know *which* conference they nearly joined.
 */
export function assertJoinable(
  conference: LifecycleSubject & { name: string },
  today: CalendarDate,
): void {
  const reason = joinRefusalReason(conference, today);
  if (reason === null) return;
  throw JOIN_REFUSALS[reason](conference);
}

// ---------- archiving ----------

/**
 * The first day a Conference may be archived: the day after it ends.
 *
 * "After its end date" is read as strictly after, so a Conference ending 2026-09-16 becomes
 * archivable on the 17th. That is the complement of the joinability boundary above – it is
 * joinable through the 16th and archivable from the 17th, with no day belonging to both.
 */
export function earliestArchiveDate(conference: LifecycleSubject): CalendarDate {
  return addDays(conference.endDate, 1);
}

/**
 * Only a **published** Conference past its end date may be archived.
 *
 * A draft is refused whatever the date: it never became visible to anyone, so archiving it would
 * produce a record with no join code and no viewers (FR9). That refusal is the transition rule –
 * draft's only successor is published – so it is raised before the date is even considered, and
 * the message a draft's organizer sees is about the state, not about a date that is irrelevant.
 */
export function assertArchivable(conference: LifecycleSubject, today: CalendarDate): void {
  assertTransitionPermitted(conference.lifecycleState, 'archived');

  const earliest = earliestArchiveDate(conference);
  if (compareDates(today, earliest) >= 0) return;

  throw new AppError(
    ERROR_CODES.CONFERENCE_ARCHIVE_TOO_EARLY,
    409,
    `This conference cannot be archived until after it ends on ${conference.endDate}. ` +
      `The earliest it can be archived is ${earliest}.`,
  );
}

// ---------- publishing ----------

export function assertPublishable(conference: LifecycleSubject, hasSession: boolean): void {
  assertTransitionPermitted(conference.lifecycleState, 'published');

  if (hasSession) return;

  throw new AppError(
    ERROR_CODES.CONFERENCE_SCHEDULE_REQUIRED,
    409,
    'This conference cannot be published yet because its schedule is empty. ' +
      'Add at least one session first.',
  );
}
