import { rehydrateClock, wallClockPlusMillis, type DeviceClock } from '../clock/effective-clock.ts';
import { anchorOf, type CachedSchedule } from './schedule-cache.ts';

/**
 * How long a cached Schedule stays readable without a connection – and the single definition of
 * that rule for the whole codebase.
 *
 * **The window is a property of the Conference, not of the credential.** A Google ID token lasts
 * about an hour, so binding offline reading to a fresh one cancels offline reading in practice:
 * from the second morning of a conference onwards there is no valid token and S10's guarantee that
 * "a schedule loaded at least once always renders" quietly stops holding. What bounds exposure
 * instead is the event the data belongs to. An attendee reads her conference for as long as it is
 * running, and a departed employee's device stops rendering anything shortly after it ends –
 * without needing to reconnect for that to happen, which is exactly the case a revoked session
 * cannot reach.
 *
 * **Dates only.** The predicate does not consult `lifecycleState`: an archived Conference inside
 * its span plus the margin stays readable and one past it stops, on exactly the same rule as a
 * published one. Archiving is an organizer's filing decision, not a statement about who may read
 * what offline (`offline-session-expiry` → Decisions Log).
 */

/**
 * The grace period after a Conference's last day, in whole days.
 *
 * **Co-owned with `docs/specs/shared-device-session-lifetime/`**, which bounds the *session* by the
 * same number. The two move together on purpose: a margin that differed would leave a readable
 * schedule sitting behind a session that had already lapsed, or the reverse. Change one and the
 * other has to change in the same commit.
 */
export const READABILITY_MARGIN_DAYS = 7;

const MILLIS_PER_DAY = 86_400_000;

/**
 * Whether this cached entry may still be rendered offline.
 *
 * **"Now" is S10's rehydrated effective clock**, built from the entry's own persisted anchor – the
 * server's reading at the last sync, advanced by elapsed real time. S10 forbids a raw device clock
 * as "now" on any offline path and this is one: a phone whose clock was already wrong *at* the last
 * sync would otherwise expire every entry on it, and the anchor cancels that error exactly.
 *
 * **What it does not do is make the window tamper-proof.** The elapsed term reduces to
 * `deviceClock() - anchor.deviceClockAtReceipt`, so a clock changed *after* the sync moves the
 * effective day one-for-one – set the device back to the sync date and a lapsed entry reads as
 * readable again, indefinitely. `effective-clock.ts` says the same thing about the highlight it was
 * written for ("a device clock that jumps after sync skews the elapsed term"), and the same limit
 * applies here. OC02's bound is therefore enforced against an *honest* device and is advisory
 * against a hostile one. Closing it needs a monotonic high-water mark persisted with the entry, and
 * that is a product decision rather than an oversight – recorded under `## Implementation
 * Observations` in `docs/specs/offline-session-expiry/offline-session-expiry.md`, which is where
 * the reasoning lives. (Not the review report it came from: `.agent_temp/` is the transient agent
 * workspace by contract, so a permanent comment must not be the only pointer into it.)
 *
 * The comparison is between two naive calendar days, as strings, in the API's own frame. No `Date`
 * is constructed and no timezone is applied – 'YYYY-MM-DD' sorts lexicographically exactly as it
 * orders chronologically, and the arithmetic that adds the margin is the same integer civil-date
 * arithmetic the clock module already uses (S04's contract).
 *
 * The boundary day itself is **readable**: an entry is withheld only once the effective day has
 * passed `endDate + margin`.
 */
export function withinReadabilityWindow(
  entry: CachedSchedule,
  deviceClock: DeviceClock = Date.now,
): boolean {
  try {
    const endDate = entry.envelope.conference.endDate;
    const lastReadableDay = wallClockPlusMillis(
      endDate,
      '00:00',
      READABILITY_MARGIN_DAYS * MILLIS_PER_DAY,
    ).day;
    const today = rehydrateClock(anchorOf(entry), deviceClock).effectiveWallClockNow().day;

    return today <= lastReadableDay;
  } catch {
    /*
     * Fails closed. Storage outlives code and `apiRequest` casts its response body without
     * validating it, so an entry whose `endDate` or `serverNow` is missing or malformed can be
     * written by one build and read by the next – and both calls above throw on such a value.
     * An entry whose window cannot be established is one whose exposure cannot be bounded, and
     * the caller renders "sign in again" rather than a schedule nobody can put a date on.
     */
    return false;
  }
}
