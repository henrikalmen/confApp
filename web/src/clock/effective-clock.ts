/**
 * "What time does the *server* think it is, right now" – without ever converting a timezone.
 *
 * The Schedule says a Session runs 09:00–10:30 and that is what it says on every device, however
 * that device's clock is set (Binding Constraint FR4). But "which Session is running now" still has
 * to be answered, and answering it from the raw device clock would let a phone three hours fast
 * highlight the wrong Session. So the server sends its own reading in **both** frames – a UTC
 * instant and its naive wall clock – and this module advances the wall clock by elapsed real time:
 *
 *     offset            = serverNow.instant − deviceClockAtReceipt
 *     effectiveWallClock = serverNow.{day,time} + (deviceNow + offset − serverNow.instant)
 *
 * A device clock that is wrong *at* sync is absorbed entirely by `offset`. A device clock that
 * jumps *after* sync skews the elapsed term and may mis-highlight, which is accepted – and which is
 * exactly the trade the FIS records, because the alternative is re-fetching to keep a highlight
 * fresh, which is S09's job.
 *
 * **The highlight may be wrong; a displayed time may never be.** Nothing this module returns is a
 * formatted Session time. It answers "what wall clock is it" and the view compares that answer
 * against `startTime`/`endTime` as strings. No value produced here reaches the screen as a time.
 *
 * **Nothing here constructs a `Date` or parses one.** `Date.UTC`-style coercion is not needed: the
 * civil-date arithmetic below is plain integer maths, so there is no object that could read a value
 * back through local getters and no parser that could guess a timezone. `Date.now()` is the single
 * exception and is not a conversion – it is a count of milliseconds since the epoch, identical in
 * every timezone – and even that is injected, so a test drives a skewed device clock for real
 * rather than mocking a formatter that a wrong implementation would never have called.
 *
 * **The anchor is data, not a live object.** All four of its values are plain serializable scalars
 * because S10 persists them: its cache entry stores the envelope *and* this anchor, and an offline
 * relaunch rehydrates a working clock from the pair with no fetch. Without that, an app force-quit
 * and reopened offline has no input for `effectiveWallClockNow()` at all and FR4's offline clause
 * cannot hold – which is why `rehydrateClock` is an explicit entry point rather than an internal
 * detail.
 */

/** A day as the API sends it: 'YYYY-MM-DD'. */
export type CalendarDay = string;
/** A time as the API sends it: 'HH:mm', 24-hour, zero-padded. */
export type WallClockTime = string;

/** The server's reading of now, in both frames – the `serverNow` field of the schedule envelope. */
export interface ServerNow {
  instant: string;
  day: CalendarDay;
  time: WallClockTime;
}

/**
 * The module's entire state: four plain scalars, and nothing else.
 *
 * This is what S10 stores beside the cached envelope. `deviceClockAtReceipt` is **the device
 * clock's reading at the moment the response arrived** – S10's "fetched-at" is this value, not a
 * server timestamp and not an unspecified clock. Storing a server value there would make the
 * derived offset zero and reintroduce the very skew the anchor exists to cancel.
 */
export interface ClockAnchor {
  serverNowInstant: string;
  serverNowDay: CalendarDay;
  serverNowTime: WallClockTime;
  deviceClockAtReceipt: number;
}

export interface WallClockReading {
  day: CalendarDay;
  time: WallClockTime;
}

export interface EffectiveClock {
  /** Exactly what S10 persists. Serializable as it stands – no methods, no closures. */
  readonly anchor: ClockAnchor;
  /**
   * The server–device difference in milliseconds, **derived** from the anchor rather than stored
   * beside it. Exposed because S09 and S10 render `lastUpdatedAt` as an elapsed age
   * (`deviceNow + offset − lastUpdatedAt`) and need the same correction this clock applies.
   */
  offsetMillis(): number;
  /** The server's wall clock, advanced by the time that has really passed since the sync. */
  effectiveWallClockNow(): WallClockReading;
}

/** How the device's own clock is read. Injected so a test can skew it for real. */
export type DeviceClock = () => number;

const MILLIS_PER_DAY = 86_400_000;
const DAY_SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_SHAPE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const INSTANT_SHAPE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/;

/**
 * Days since 1970-01-01 for a proleptic Gregorian date, by Howard Hinnant's `days_from_civil`.
 *
 * Integer arithmetic on purpose. The obvious alternative – build a `Date`, read it back – is how a
 * calendar day silently becomes the day before for anyone west of UTC, and this codebase has
 * already paid for that lesson once in the driver's `date` parser (`api/src/db.ts`). There is no
 * object here to apply an offset, so there is no offset to forget to disable.
 */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

/** The exact inverse – Hinnant's `civil_from_days`. Round trips for every representable day. */
function civilFromDays(days: number): CalendarDay {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const dayOfEra = z - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1460) +
      Math.floor(dayOfEra / 36_524) -
      Math.floor(dayOfEra / 146_096)) /
      365,
  );
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthPrime = Math.floor((5 * dayOfYear + 2) / 153);

  const day = dayOfYear - Math.floor((153 * monthPrime + 2) / 5) + 1;
  const month = monthPrime + (monthPrime < 10 ? 3 : -9);
  const year = era * 400 + yearOfEra + (month <= 2 ? 1 : 0);

  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parts(pattern: RegExp, value: string, what: string): number[] {
  const match = pattern.exec(value);
  if (match === null)
    throw new Error(`${what} is not in the expected form: ${JSON.stringify(value)}`);
  return match.slice(1).map((part) => (part === undefined ? 0 : Number(part)));
}

/**
 * A UTC instant as milliseconds since the epoch.
 *
 * Sub-millisecond digits are dropped rather than rounded. The envelope's instants carry six
 * fractional digits so both of its timestamp fields share one format, but this value measures a
 * network round trip – microseconds are noise, and truncation cancels out of the arithmetic below
 * because the same parsed value appears on both sides of it.
 */
export function instantToMillis(instant: string): number {
  const match = INSTANT_SHAPE.exec(instant);
  if (match === null) {
    throw new Error(`an instant is not in the expected form: ${JSON.stringify(instant)}`);
  }

  const [, year, month, day, hour, minute, second, fraction = ''] = match as unknown as string[];
  // Padded then cut to exactly three digits, so '.5' is 500ms and '.345678' is 345ms whatever the
  // sender's precision. Slicing a shorter string would read '.5' as 5ms.
  const millisOfSecond = Number(fraction.padEnd(3, '0').slice(0, 3));

  return (
    daysFromCivil(Number(year), Number(month), Number(day)) * MILLIS_PER_DAY +
    Number(hour) * 3_600_000 +
    Number(minute) * 60_000 +
    Number(second) * 1000 +
    millisOfSecond
  );
}

/**
 * A naive wall clock advanced by a signed number of milliseconds, staying naive throughout.
 *
 * The day rolls over correctly – a Session running at 23:50 with twenty minutes of elapsed time is
 * 00:10 the next day – and it does so without either value ever being an instant. Seconds are
 * discarded on the way out because the result is only ever compared against 'HH:mm' Session times.
 */
export function wallClockPlusMillis(
  day: CalendarDay,
  time: WallClockTime,
  deltaMillis: number,
): WallClockReading {
  const [year, month, dayOfMonth] = parts(DAY_SHAPE, day, 'a day') as [number, number, number];
  const [hour, minute] = parts(TIME_SHAPE, time, 'a time') as [number, number];

  const total =
    daysFromCivil(year, month, dayOfMonth) * MILLIS_PER_DAY +
    hour * 3_600_000 +
    minute * 60_000 +
    deltaMillis;

  // Floor, not truncate: a negative elapsed time (a device clock that went backwards after sync)
  // must roll back into the previous day rather than towards zero.
  const dayNumber = Math.floor(total / MILLIS_PER_DAY);
  const millisOfDay = total - dayNumber * MILLIS_PER_DAY;
  const minutesOfDay = Math.floor(millisOfDay / 60_000);

  return {
    day: civilFromDays(dayNumber),
    time: `${String(Math.floor(minutesOfDay / 60)).padStart(2, '0')}:${String(minutesOfDay % 60).padStart(2, '0')}`,
  };
}

/**
 * **Entry point one of two: rehydration.** Builds a working clock from a stored anchor and nothing
 * else – no fetch, no connection, no envelope.
 *
 * This is the entry point S10 calls on an offline read, with `(cached serverNow, cached
 * deviceClockAtReceipt)`. It is also what `clockFromSync` is implemented in terms of, so the fresh
 * and the rehydrated path cannot drift into computing "now" two different ways.
 */
export function rehydrateClock(
  anchor: ClockAnchor,
  deviceClock: DeviceClock = Date.now,
): EffectiveClock {
  const syncInstant = instantToMillis(anchor.serverNowInstant);

  // Derived on demand, never the sole record of the sync – the anchor is, which is what makes the
  // sync survive being written to storage and read back in a new process.
  const offsetMillis = (): number => syncInstant - anchor.deviceClockAtReceipt;

  return {
    anchor,
    offsetMillis,

    effectiveWallClockNow(): WallClockReading {
      /*
       * Written as the Technical Overview states it – `deviceNow + offset − serverNow.instant` –
       * rather than as the device-clock delta it algebraically reduces to. The two are exactly
       * equal (the offset contains `−deviceClockAtReceipt` and `+syncInstant`), and spelling out
       * the correction is what makes it readable that a device clock wrong at sync is cancelled
       * rather than merely unnoticed.
       */
      const elapsed = deviceClock() + offsetMillis() - syncInstant;
      return wallClockPlusMillis(anchor.serverNowDay, anchor.serverNowTime, elapsed);
    },
  };
}

/**
 * **Entry point two of two: a fresh sync.** Takes the `serverNow` just received and the device
 * clock's reading at the moment of receipt.
 *
 * `deviceClockAtReceipt` is passed in rather than read here, because "at receipt" is a fact about
 * when the caller got the response – reading the clock at construction time would fold whatever
 * happened between the two into the offset.
 */
export function clockFromSync(
  serverNow: ServerNow,
  deviceClockAtReceipt: number,
  deviceClock: DeviceClock = Date.now,
): EffectiveClock {
  return rehydrateClock(
    {
      serverNowInstant: serverNow.instant,
      serverNowDay: serverNow.day,
      serverNowTime: serverNow.time,
      deviceClockAtReceipt,
    },
    deviceClock,
  );
}
