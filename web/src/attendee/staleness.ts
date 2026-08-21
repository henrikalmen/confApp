import { instantToMillis, type EffectiveClock } from '../clock/effective-clock.ts';

/**
 * How recently the Schedule updated, as an **elapsed age** – never a time of day.
 *
 * The watermark is an instant, and rendering it as a clock time would need a timezone the product
 * does not carry. On a device set away from the venue the result would contradict every Session
 * time on the same screen: "last updated 09:12" beside a session at 09:00 that has not started yet.
 * So the answer is always a duration – "just now", "updated 4 minutes ago" – computed as
 *
 *     (deviceNow + offset) − lastUpdatedAt
 *
 * which is instant minus instant, with no timezone anywhere in it (S09 → Constraints & Gotchas).
 *
 * If an absolute "last updated" time is ever wanted, the only permitted route is a naive wall-clock
 * string added to the envelope beside `serverNow.time` by the server – never a derivation here.
 * No such field exists, because an elapsed age needs none.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Anything fresher than this reads as "just now" rather than "0 minutes ago". */
const JUST_NOW = 45_000;

/**
 * The age of a watermark in milliseconds, corrected for the device's clock skew.
 *
 * Negative when a device clock has run backwards since the sync; callers clamp rather than showing
 * a schedule updated in the future.
 */
export function ageMillis(lastUpdatedAt: string, clock: EffectiveClock, deviceNow: number): number {
  return deviceNow + clock.offsetMillis() - instantToMillis(lastUpdatedAt);
}

/**
 * The sentence shown beside the Schedule.
 *
 * Coarse on purpose. The propagation bar is a few seconds, so a second-by-second countdown would
 * re-render constantly to tell an attendee something they cannot act on; what they need to know is
 * whether the screen is current or has quietly stopped updating.
 */
export function stalenessLabel(age: number): string {
  if (age < JUST_NOW) return 'Updated just now';

  if (age < HOUR) {
    const minutes = Math.max(1, Math.floor(age / MINUTE));
    return `Updated ${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }

  if (age < DAY) {
    const hours = Math.floor(age / HOUR);
    return `Updated ${hours} hour${hours === 1 ? '' : 's'} ago`;
  }

  /*
   * Days, because S10 shows this label on a cache that may not have been refreshed since the
   * conference started – and "updated 76 hours ago" is a number an attendee has to divide before it
   * means anything. Still an elapsed age, and still a duration: no timezone is involved at any
   * tier, which is the property the whole module exists to keep (S10 Acceptance Scenario S02).
   */
  const days = Math.floor(age / DAY);
  return `Updated ${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * The label for an envelope, or `null` where the Conference has no watermark yet.
 *
 * A negative age is clamped to zero: a device whose clock jumped backwards after the sync would
 * otherwise be told the schedule updates in the future, which is alarming and actionable by nobody.
 */
export function stalenessFor(
  lastUpdatedAt: string | null,
  clock: EffectiveClock,
  deviceNow: number,
): string | null {
  if (lastUpdatedAt === null) return null;
  return stalenessLabel(Math.max(0, ageMillis(lastUpdatedAt, clock, deviceNow)));
}
