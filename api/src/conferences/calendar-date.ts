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
 * The server's "now", in **both** frames at once – and that is the whole point of the shape.
 *
 * A UTC instant alone cannot produce a wall clock without a timezone, and timezone conversion is
 * banned for every schedule value (PRD → Constraints, Binding Constraint FR4). So the server sends
 * both and the client converts neither:
 *
 *   - `instant` is a real moment, ISO-8601 UTC. It exists so the client can measure the
 *     server–device offset by subtracting its own clock reading at receipt, and for nothing else.
 *     No value derived from it ever reaches the screen.
 *   - `day` and `time` are the server's **naive wall clock** – the same frame Sessions are authored
 *     in (S06 → Constraints & Gotchas, recorded assumption: one configured deployment wall clock).
 *     They are what "is this session running now" is decided against, by string comparison.
 */
export interface ServerNow {
  instant: string;
  day: CalendarDate;
  /** 'HH:mm' – the same naive form Session start and end times use. */
  time: string;
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
  /** The same reading in both frames, taken once so the two cannot disagree across midnight. */
  now(): ServerNow;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/**
 * Millisecond precision, padded to the microsecond wire form.
 *
 * The envelope's two instants – `serverNow.instant` and `lastUpdatedAt` – share one format so a
 * client needs one parser. `lastUpdatedAt` genuinely carries microseconds (PostgreSQL formats it;
 * see `instantExpression`), while a JavaScript clock is millisecond-granular, so the last three
 * digits here are always zero. That is a uniform format, not a precision claim: the offset this
 * value exists to measure is a network round trip, where a microsecond would be noise.
 */
function toInstant(reading: Date): string {
  return reading.toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');
}

export const systemClock: Clock = {
  today(): CalendarDate {
    return systemClock.now().day;
  },

  now(): ServerNow {
    // One reading, three fields. Taking `new Date()` twice would let a request that lands on the
    // stroke of midnight report today's date beside tomorrow's instant.
    const reading = new Date();
    return {
      instant: toInstant(reading),
      // The deployment's configured wall clock, read through local getters on purpose – that is
      // the clock the Organizer authored in, and it is the only frame these fields mean anything in.
      day: format(reading.getFullYear(), reading.getMonth() + 1, reading.getDate()),
      time: `${pad(reading.getHours())}:${pad(reading.getMinutes())}`,
    };
  },
};

/**
 * A clock pinned to one day and time, so the archive boundary and the running-Session highlight
 * can both be tested at a stated moment.
 *
 * The pinned wall clock is reported as its own UTC instant. A fixed clock is a statement of what
 * the server believes the time to be, and inventing a deployment timezone for it would put a
 * conversion into the one place this codebase is most careful there is none. A test that cares
 * about clock skew skews the *device*, which is where the skew lives in production.
 */
export function fixedClock(today: CalendarDate, time = '00:00'): Clock {
  return {
    today: () => today,
    now: () => ({ instant: `${today}T${time}:00.000000Z`, day: today, time }),
  };
}
