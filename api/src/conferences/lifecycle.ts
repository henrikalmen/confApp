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

// ---------- the two exported guards S05 and S09 consume (TI10) ----------

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
 * The single, whole definition of joinable – state AND end date, in one place.
 *
 * Both halves matter, and the second is the one that gets forgotten: a Conference that is still
 * `published` but ended yesterday is closed, whether or not anyone has got round to archiving it.
 * Joining ends with the end date, not with the manual archive step.
 *
 * S05's join endpoint consumes this predicate. It must not restate the rule – two implementations
 * of one invariant is precisely what a later story then has to unpick.
 */
export function isJoinable(conference: LifecycleSubject, today: CalendarDate): boolean {
  if (conference.lifecycleState !== 'published') return false;
  // Still joinable *on* the last day; closed the day after.
  return compareDates(conference.endDate, today) >= 0;
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
