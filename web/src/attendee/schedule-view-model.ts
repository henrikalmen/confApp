import type { AttendeeSchedule, AttendeeScheduleDay, AttendeeSession } from '../api/client.ts';
import type { WallClockReading } from '../clock/effective-clock.ts';

/**
 * Every decision the attendee schedule view makes, as pure functions of `(envelope, now)`.
 *
 * They live apart from the components for two reasons. They are the parts with rules in them –
 * which day opens, which Session is running – and rules deserve tests that state a day and a clock
 * rather than tests that render a tree and read the DOM. And keeping them here is what lets the
 * component tree be a plain projection of its two inputs, with no fetch and no clock read anywhere
 * inside it, which is the property S10 needs in order to hand that same tree a cached envelope.
 *
 * **Nothing here constructs a `Date` or parses one.** Days are 'YYYY-MM-DD' and times are 'HH:mm',
 * both zero-padded, so comparing them is a text compare that is already chronological. A parsed
 * comparison would pass on the developer's machine and move a Session for anyone else.
 */

/**
 * The day the view opens on: the effective current day when the Conference is running, else day 1.
 *
 * "Effective" is the corrected clock, not the device's – a phone whose clock is a day out must not
 * open on a different day than the person is standing in. Before the Conference starts and after it
 * ends there is no current day inside the span, and day 1 is the useful answer in both directions:
 * before, it is what is coming; after, it is where reading back through the programme begins.
 */
export function defaultDay(schedule: AttendeeSchedule, now: WallClockReading): string | undefined {
  const inSpan = schedule.days.find((day) => day.date === now.day);
  return (inSpan ?? schedule.days[0])?.date;
}

/**
 * The Sessions running at this instant: on the effective current day, and `startTime <= now < endTime`.
 *
 * Half-open, matching the server's overlap rule, so a Session ending at 10:30 and one starting at
 * 10:30 are never both highlighted. More than one Session can match and all of them are returned –
 * on a Parallel Track two things really are running at once, and highlighting only the first would
 * be a lie about the schedule rather than a tidier screen.
 */
export function runningSessionIds(
  schedule: AttendeeSchedule,
  now: WallClockReading,
): ReadonlySet<string> {
  const today = schedule.days.find((day) => day.date === now.day);
  if (today === undefined) return new Set();

  return new Set(
    today.sessions
      .filter((session) => session.startTime <= now.time && now.time < session.endTime)
      .map((session) => session.id),
  );
}

/**
 * The titles of the Sessions a given one runs alongside.
 *
 * Driven entirely by the server's `concurrentWith`. The overlap rule – half-open, so touching
 * boundaries do not count – is written down once, on the server, in the same function the
 * Organizer's parallel-track warnings come from. Recomputing it here would be a second opinion
 * about the same pair, and the two views would disagree the first time either changed.
 */
export function concurrentTitles(session: AttendeeSession, day: AttendeeScheduleDay): string[] {
  return session.concurrentWith
    .map((id) => day.sessions.find((other) => other.id === id)?.title)
    .filter((title): title is string => title !== undefined);
}

/** "Day 2 · 2026-09-15". The ordinal is the server's `dayNumber`, never calendar arithmetic. */
export function dayLabel(day: AttendeeScheduleDay): string {
  return `Day ${day.dayNumber} · ${day.date}`;
}

/** "09:00–10:30". An en dash, because it is a range rather than a subtraction. */
export function timeRange(session: AttendeeSession): string {
  return `${session.startTime}–${session.endTime}`;
}
