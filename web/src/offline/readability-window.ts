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

/**
 * The grace period measured from the **last successful sync**, in whole days.
 *
 * A separate, longer horizon from `READABILITY_MARGIN_DAYS`, and deliberately not the same number.
 * It answers a different question – "how long since this device was last shown to be entitled to
 * this?" rather than "how long since the event ended?" – and it has to be long enough that priming
 * the cache at join time still serves a conference joined weeks in advance (S10 OC01).
 *
 * Thirty days is a judgement about how far ahead conferences are joined, not a measurement. If
 * they are routinely joined months ahead this bites legitimate attendees and should be raised
 * (ADR-005 → Risks).
 */
export const SYNC_MARGIN_DAYS = 30;

const MILLIS_PER_DAY = 86_400_000;
const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Whether a value is a day this module may compare.
 *
 * The comparison below is `<=` over strings, which orders chronologically **only** for four-digit,
 * zero-padded years. `civilFromDays` will happily emit '0NaN-NaN-NaN', '10000-01-01' or
 * '-2735938-12-29' for a corrupt receipt reading, and every one of those sorts before a real date –
 * i.e. answers "readable" for an entry whose window is unknowable.
 */
function isCalendarDay(value: string): boolean {
  return CALENDAR_DAY.test(value);
}

/** The day `days` after `from`, in the same naive frame and with no `Date` involved. */
function dayPlus(from: string, days: number): string {
  return wallClockPlusMillis(from, '00:00', days * MILLIS_PER_DAY).day;
}

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
 * is constructed and no timezone is applied – a well-formed 'YYYY-MM-DD' sorts lexicographically
 * exactly as it orders chronologically, and the arithmetic that adds the margin is the same integer
 * civil-date arithmetic the clock module already uses (S04's contract). **Well-formed is doing real
 * work in that sentence** – see `isCalendarDay`.
 *
 * The boundary day itself is **readable**: an entry is withheld only once the effective day has
 * passed the horizon.
 */
function withinHorizon(
  entry: CachedSchedule,
  select: (entry: CachedSchedule) => string,
  marginDays: number,
  deviceClock: DeviceClock,
): boolean {
  try {
    const horizon = dayPlus(select(entry), marginDays);
    const today = rehydrateClock(anchorOf(entry), deviceClock).effectiveWallClockNow().day;

    /*
     * Both operands are checked before either is compared. A lexicographic compare is only a
     * chronological compare for well-formed days, and `civilFromDays` has no domain guard: a
     * `deviceClockAtReceipt` of `NaN` yields '0NaN-NaN-NaN', and out-of-range values yield 5-digit
     * or negative years. All of those sort *before* every real date and answered "readable" – so
     * the fail-closed this module documents covered only the inputs that throw, and silently failed
     * open for the ones that do not. That mattered when the window merely gated rendering; it
     * matters more now that a closed window deletes the entry.
     */
    if (!isCalendarDay(today) || !isCalendarDay(horizon)) return false;

    return today <= horizon;
  } catch {
    /*
     * Fails closed, for the reason spelled out on `withinReadabilityWindow`.
     */
    return false;
  }
}

/**
 * Whether this entry's **conference** is still inside its span plus the shared margin.
 *
 * Exported because `shared-device-session-lifetime` bounds the *session* on exactly this term, and
 * sharing the function rather than the constant is what makes "a cached schedule can never outlive
 * the session it was read under" true by construction: readability is this predicate **and** the
 * sync horizon, so anything still readable necessarily satisfies this, and the session bound is
 * satisfied by any entry that does. Restating the arithmetic there would leave that relationship
 * holding only by coincidence, until someone edited one copy.
 */
export function withinConferenceHorizon(
  entry: CachedSchedule,
  deviceClock: DeviceClock = Date.now,
): boolean {
  return withinHorizon(
    entry,
    (e) => e.envelope.conference.endDate,
    READABILITY_MARGIN_DAYS,
    deviceClock,
  );
}

/**
 * Whether this entry has been synced recently enough to still be trusted (ADR-005).
 *
 * `SYNC_MARGIN_DAYS` is **not** the same number as the conference margin and must not be collapsed
 * into it: bounding by `lastSync + 7d` expires a cache primed at join time before the conference it
 * was primed for even starts, which breaks S10's "joining online is enough" outright. Thirty days
 * is the horizon that leaves an ordinary early joiner alone.
 */
function withinSyncHorizon(entry: CachedSchedule, deviceClock: DeviceClock): boolean {
  return withinHorizon(entry, (e) => e.envelope.serverNow.day, SYNC_MARGIN_DAYS, deviceClock);
}

export function withinReadabilityWindow(
  entry: CachedSchedule,
  deviceClock: DeviceClock = Date.now,
): boolean {
  try {
    /*
     * **Two horizons, and the earlier one wins** (ADR-005).
     *
     * The conference's own span bounds how long its schedule is worth reading. But `endDate` alone
     * says nothing about how long ago the person was last known to be entitled to it: a conference
     * eleven months out, cached the day it was published, stayed readable for eleven months on a
     * device that never spoke to the API again. So the time since the last successful sync bounds
     * it too, on a deliberately longer margin.
     */
    return withinConferenceHorizon(entry, deviceClock) && withinSyncHorizon(entry, deviceClock);
  } catch {
    /*
     * Fails closed. Storage outlives code and `apiRequest` casts its response body without
     * validating it, so an entry whose `endDate`, `serverNow` or receipt reading is missing or
     * malformed can be written by one build and read by the next. An entry whose window cannot be
     * established is one whose exposure cannot be bounded.
     */
    return false;
  }
}
