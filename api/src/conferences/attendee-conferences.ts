import { compareDates, type CalendarDate } from './calendar-date.ts';
import type { AttendeeConference } from './conference-repository.ts';

/**
 * Which Conference an Attendee is shown when they open the app having chosen nothing.
 *
 * The rule is the server's, not the client's, and the response names its answer outright (TI02).
 * A client re-deriving it from list order would be a second copy of this rule that drifts the first
 * time either changes – and it would have to be re-derived identically in the browser, the Android
 * shell and the iOS shell.
 *
 * It is decided against the **server's** calendar day, in the naive frame the Conference dates are
 * stored in. Not the device's: a phone in the wrong timezone, or with a wrong clock, must not be
 * shown a different conference than the one the person is standing in (OC02).
 */

/** Running means the server's day falls inside the span, endpoints included. */
export function isRunningOn(conference: AttendeeConference, today: CalendarDate): boolean {
  return (
    compareDates(conference.startDate, today) <= 0 && compareDates(conference.endDate, today) >= 0
  );
}

/**
 * The default: the Conference running today, otherwise the most recently joined.
 *
 * Both halves fall out of one selection because the ordering is the same in either case. The
 * candidates are the running Conferences when there are any – so a person attending two things at
 * once still lands on one of the two rather than on last spring's archived offsite – and the whole
 * readable list when there are none. Within the candidates the most recently joined wins, which for
 * a single running Conference is simply that Conference.
 *
 * `conferences` arrives ordered by `joined_at` descending with a deterministic tie-break (the
 * repository's ORDER BY), so "most recently joined" is the first survivor rather than a second sort
 * with a second opinion about ties.
 */
export function chooseDefaultConference(
  conferences: readonly AttendeeConference[],
  today: CalendarDate,
): AttendeeConference | null {
  const running = conferences.filter((conference) => isRunningOn(conference, today));
  const candidates = running.length > 0 ? running : conferences;
  return candidates[0] ?? null;
}
