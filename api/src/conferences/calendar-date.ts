/**
 * Naive calendar dates – 'YYYY-MM-DD' and nothing else.
 *
 * A Conference day is a calendar day, not an instant. Every operation here stays in that frame:
 * no value is ever routed through a `new Date(string)`, because that parses a bare date as UTC
 * midnight and then reports it back through local getters, which is exactly how 2026-09-14
 * becomes the 13th somewhere. Where arithmetic is genuinely needed (the day after an end date)
 * it runs entirely in the UTC frame and comes straight back out of it, so no offset is ever
 * applied in either direction.
 *
 * Ordering is plain string comparison. Zero-padded ISO dates sort chronologically as text, so
 * comparing them needs no parsing at all – the representation is doing the work.
 */

/** A date known to be well-formed and to name a real day. */
export type CalendarDate = string;

const SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Well-formed *and* real: the shape check alone accepts 2026-02-30, so the parts are round
 * tripped through the UTC calendar and required to come back unchanged.
 */
export function isCalendarDate(value: unknown): value is CalendarDate {
  if (typeof value !== 'string') return false;
  const match = SHAPE.exec(value);
  if (match === null) return false;

  const [, year, month, day] = match as unknown as [string, string, string, string];
  const utc = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return (
    utc.getUTCFullYear() === Number(year) &&
    utc.getUTCMonth() === Number(month) - 1 &&
    utc.getUTCDate() === Number(day)
  );
}

function format(year: number, month: number, day: number): CalendarDate {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Calendar arithmetic in the UTC frame, in and out. Month and year roll over correctly. */
export function addDays(date: CalendarDate, days: number): CalendarDate {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return format(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

/** Negative when `a` is earlier. Text comparison – see the module note. */
export function compareDates(a: CalendarDate, b: CalendarDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Inclusive day count: a conference starting and ending the same day spans 1 day. */
export function daySpan(startDate: CalendarDate, endDate: CalendarDate): number {
  const [startY, startM, startD] = startDate.split('-').map(Number) as [number, number, number];
  const [endY, endM, endD] = endDate.split('-').map(Number) as [number, number, number];
  const millis = Date.UTC(endY, endM - 1, endD) - Date.UTC(startY, startM - 1, startD);
  return Math.round(millis / 86_400_000) + 1;
}

/**
 * How the server decides what day it is.
 *
 * Its own wall-clock calendar date, in the same naive frame the stored dates use – read fresh on
 * every call, never cached. Nothing about "today" may be remembered between requests: the API
 * runs as several container replicas and a request crossing midnight must see the new day
 * (ADR-004, ARCHITECTURE.md#key-constraints).
 */
export interface Clock {
  today(): CalendarDate;
}

export const systemClock: Clock = {
  today(): CalendarDate {
    const now = new Date();
    return format(now.getFullYear(), now.getMonth() + 1, now.getDate());
  },
};

/** A clock pinned to one day, so the archive-boundary rules can be tested at a stated date. */
export function fixedClock(today: CalendarDate): Clock {
  return { today: () => today };
}
