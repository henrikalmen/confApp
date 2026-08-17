/**
 * The client half of the naive wall-clock representation.
 *
 * A Session authored at 09:00 reads 09:00 here too, whatever timezone the browser is set to (PRD
 * → Constraints, Binding Constraint FR4). The API hands over strings – `'2026-09-15'`, `'09:00'` –
 * and they stay strings all the way to the screen. Formatting is string work; ordering is a
 * lexicographic compare of zero-padded values, which is order-correct.
 *
 * **Nothing in this folder may construct a `Date`.** `new Date('2026-09-15')` parses as UTC
 * midnight and reads back through local getters, so the 15th renders as the 14th for anyone west
 * of UTC; `toLocaleTimeString` and `Intl.DateTimeFormat` apply the browser's zone to a value that
 * has none. A contract test asserts the absence of all of them across this folder, because the
 * failure is invisible on the machine of whoever introduces it.
 */

/** A time as the API sends it: 24-hour, zero-padded, no seconds, no offset. */
export type WallClockTime = string;

/** A day as the API sends it: 'YYYY-MM-DD', a calendar day with no timezone. */
export type CalendarDay = string;

const TIME_SHAPE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isWallClockTime(value: string): value is WallClockTime {
  return TIME_SHAPE.test(value);
}

/** "09:00–10:30". An en dash, because it is a range rather than a subtraction. */
export function formatTimeRange(startTime: WallClockTime, endTime: WallClockTime): string {
  return `${startTime}–${endTime}`;
}

/** Negative when `a` starts earlier. Text comparison – see the module note. */
export function compareByStart(
  a: { day: CalendarDay; startTime: WallClockTime },
  b: { day: CalendarDay; startTime: WallClockTime },
): number {
  if (a.day !== b.day) return a.day < b.day ? -1 : 1;
  if (a.startTime === b.startTime) return 0;
  return a.startTime < b.startTime ? -1 : 1;
}

/**
 * How a Conference Day is labelled: its position in the span and the date itself.
 *
 * The ordinal comes from the day's index in the Conference's own list of days, not from any
 * calendar arithmetic. A weekday name would need a `Date` to work out, and buying "Tue" at the
 * cost of the whole guarantee this module exists to hold is not a trade worth making.
 */
export function dayLabel(day: CalendarDay, index: number): string {
  return `Day ${index + 1} · ${day}`;
}
