import {
  fetchAttendeeSchedule,
  type AttendeeConference,
  type AttendeeSchedule,
} from '../api/client.ts';
import {
  cacheIdentity,
  forgetCachedSchedule,
  readCachedSchedule,
  readCachedSchedulesFor,
  writeCachedSchedule,
  type CachedSchedule,
} from './schedule-cache.ts';
import { withinReadabilityWindow } from './readability-window.ts';

/**
 * Reading the Schedule, with caching as a property of the read rather than an opt-in.
 *
 * Every successful online read passes through here and writes through to the store, so there is no
 * path that fetches a Schedule and forgets to cache it – which is what makes "joining online is
 * enough" (S01) true without an Attendee ever opening the schedule view.
 *
 * The request is an ordinary authenticated API call: `fetchAttendeeSchedule` attaches the bearer
 * token like every other, and the server verifies the `hd` claim on it (ADR-002). Nothing here adds
 * a cache-only or unauthenticated route, and nothing here writes to the API – the offline scope is
 * read-only (FR8).
 */

/** A fetched Schedule and the device clock's reading at the moment it landed. */
export interface FetchedSchedule {
  schedule: AttendeeSchedule;
  /**
   * `Date.now()` as the response arrived – the second half of S06's offset measurement, captured
   * **once** here and shared by the clock module and the cache, rather than measured twice. Two
   * readings taken moments apart would give the live clock and the rehydrated one different
   * offsets, which is exactly the drift the anchor pair exists to prevent.
   */
  deviceClockAtReceipt: number;
}

/**
 * Fetches the Schedule and writes it through to the cache.
 *
 * **The write cannot fail the read.** A device whose storage is full, disabled or holding a shape
 * this build no longer understands must still show the Schedule it just downloaded; what it loses
 * is the offline copy, which is a degraded outcome rather than a broken read. Letting the write
 * throw here would be worse than not caching at all: the caller classifies a throw as the server
 * being unreachable, so a successful fetch would be reported as "you are offline" over a stale
 * cached copy – on a device that is online, in the one situation where an attendee is deciding
 * whether to trust the times in front of them.
 */
export async function fetchAndCacheSchedule(
  conferenceId: string,
  signal?: AbortSignal,
): Promise<FetchedSchedule> {
  const schedule = await fetchAttendeeSchedule(conferenceId, signal);
  // Read here and nowhere else: "at receipt" is a fact about this moment, and reading it after the
  // cache write would fold the storage round trip into the offset.
  const deviceClockAtReceipt = Date.now();

  try {
    await cacheSchedule(schedule, deviceClockAtReceipt);
  } catch {
    // No offline copy this time. The Schedule below is still exactly what the server sent.
  }

  return { schedule, deviceClockAtReceipt };
}

/**
 * Stores one envelope under the signed-in employee's key.
 *
 * Deliberately not exported: `fetchAndCacheSchedule` is the only way in, which is what makes
 * caching a property of *reading* rather than something a caller can forget to do. A second entry
 * point would be the first step back towards a read path that does not cache.
 */
async function cacheSchedule(
  schedule: AttendeeSchedule,
  deviceClockAtReceipt: number,
): Promise<void> {
  const sub = cacheIdentity();
  // No signed-in subject means no key to write under. Guessing one would put an employee's
  // Schedule somewhere the purge does not look.
  if (sub === null) return;
  /*
   * And no conference id means no key either. `apiRequest` casts its response body without
   * validating it, so a 200 with an empty or unexpected payload – a captive portal answering JSON,
   * an API contract that has moved – arrives here as something with no `conference` on it at all.
   * The store refuses such a value anyway; this stops it being a `TypeError` on the way in.
   */
  if (typeof schedule?.conference?.id !== 'string') return;

  await writeCachedSchedule(sub, schedule.conference.id, {
    // Verbatim. The envelope is stored as it arrived so the offline render is the online render.
    envelope: schedule,
    watermark: schedule.conference.lastUpdatedAt,
    deviceClockAtReceipt,
  });
}

/**
 * What the cache can offer for one Conference – and **why**, when the answer is nothing.
 *
 * Three outcomes, not two, because the two ways of having nothing to show call for opposite
 * remedies. `absent` means this Conference was never read on this device, and opening it once with
 * a connection fixes that for good. `lapsed` means it *is* on the device and may no longer be
 * rendered, and the only thing that helps is signing in again. Telling somebody a schedule is "not
 * available offline" while it sits in storage a few hundred bytes away is the wrong sentence
 * (`offline-session-expiry` OC04).
 */
export type OfflineSchedule =
  | { kind: 'readable'; entry: CachedSchedule }
  /** Stored, but its Conference's span plus the shared margin has passed. */
  | { kind: 'lapsed' }
  | { kind: 'absent' };

/**
 * The cached Schedule for the signed-in employee, classified against its readability window.
 *
 * The window is applied **here and not in the view**, so the panel and the offline picker below
 * cannot come to different conclusions about the same entry – which would let an attendee select a
 * Conference that then refuses to render.
 */
export async function readOfflineSchedule(conferenceId: string): Promise<OfflineSchedule> {
  const sub = cacheIdentity();
  if (sub === null) return { kind: 'absent' };

  const entry = await readCachedSchedule(sub, conferenceId);
  if (entry === null) return { kind: 'absent' };

  if (!withinReadabilityWindow(entry)) {
    /*
     * **Evicted, not merely withheld** (ADR-005). The window used to be a render gate only: the
     * envelope, every session title and room, and the fact of this employee's membership stayed in
     * IndexedDB indefinitely behind a screen that declined to draw them. "Access ends" has to mean
     * the data goes, not that one code path stops looking at it.
     *
     * Not awaited, for the same reason the other cache writes are not: the caller's answer does not
     * depend on the delete landing, and a storage failure must not turn "this lapsed" into a thrown
     * read. It is retried on the next launch, which reaches this branch again.
     *
     * Costs OC04 something, accepted deliberately: from the *next* launch this conference reads as
     * absent rather than lapsed, so the sign-in-required wording appears on the launch where the
     * lapse is first observed and not after. That is the launch the attendee is looking at.
     */
    void forgetCachedSchedule(sub, conferenceId);
    return { kind: 'lapsed' };
  }

  return { kind: 'readable', entry };
}

/**
 * Drops the cached Schedule for a Conference the employee has just left (S08).
 *
 * The membership is gone, so the Schedule is no longer readable online – and the leave confirmation
 * says so: "Its schedule will stop being available to you." An entry left behind would make that
 * false offline, and would put it back in the offline picker on the next launch with no connection.
 */
export async function forgetSchedule(conferenceId: string): Promise<void> {
  const sub = cacheIdentity();
  if (sub === null) return;
  await forgetCachedSchedule(sub, conferenceId);
}

/**
 * The Conferences readable offline, projected from the cached Schedules themselves.
 *
 * **Not a second cached payload.** Every stored envelope already carries the Conference it belongs
 * to – id, name, span and lifecycle state – so the offline picker is a projection of the schedule
 * read model rather than a cached copy of `/me/conferences`. Nothing but the Schedule is cached
 * (S10 → What We're NOT Doing).
 *
 * It exists because the picker is what *selects* a Conference: an attendee who launches the app
 * with no connection would otherwise have nothing selected, and would never reach the cached
 * Schedule that is sitting there ready to read.
 */
export interface OfflineConferences {
  /** What may be opened offline right now. */
  conferences: AttendeeConference[];
  /**
   * Whether anything was **removed by the window** rather than never having been there.
   *
   * The difference is the whole of OC04 at the list level. A device with one cached Conference that
   * has lapsed produces an empty candidate set, and without this the panel could only say "not
   * available offline" – which is the one thing that is not true: it is available, it is on the
   * device, and what has run out is the sign-in it was read under.
   */
  withheld: boolean;
}

export async function listCachedConferences(): Promise<OfflineConferences> {
  const sub = cacheIdentity();
  if (sub === null) return { conferences: [], withheld: false };

  const entries = await readCachedSchedulesFor(sub);
  /*
   * Composed with the `sub` filter `readCachedSchedulesFor` already applies, never replacing it:
   * the per-employee boundary and the per-Conference window are two different guarantees, and
   * dropping either one loses something the other never covered.
   *
   * A lapsed Conference is removed from the candidate set rather than offered and then refused.
   * The picker is what *selects* what gets rendered, so leaving a lapsed entry in it would let an
   * attendee land on a Conference the panel will not show – and on a device holding exactly one
   * lapsed entry, land there by default with nothing else to choose.
   */
  const readable = entries.filter((entry) => {
    if (withinReadabilityWindow(entry)) return true;
    // The picker observes the window too, so it evicts on the same terms – otherwise a lapsed
    // conference the attendee never opens is never observed by `readOfflineSchedule` and survives
    // forever in the store (ADR-005).
    void forgetCachedSchedule(sub, entry.envelope.conference.id);
    return false;
  });

  const conferences = readable
    .map(({ envelope }) => ({
      id: envelope.conference.id,
      name: envelope.conference.name,
      // Naive calendar dates, straight through – no `Date` anywhere on this path (S04).
      startDate: envelope.conference.startDate,
      endDate: envelope.conference.endDate,
      state: envelope.conference.state,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { conferences, withheld: readable.length < entries.length };
}

/**
 * Primes the cache after a successful join (S05), so joining online is sufficient.
 *
 * Deliberately quiet. The employee has just joined and is being told so; a failure to warm a cache
 * they have not asked for is not something to put on that screen, and the next time they open the
 * Schedule online it caches itself anyway. A repeated join writes the same `(sub, conferenceId)`
 * pair, so the idempotent re-join leaves exactly one entry rather than a duplicate.
 */
export async function primeScheduleCache(conferenceId: string): Promise<void> {
  try {
    await fetchAndCacheSchedule(conferenceId);
  } catch {
    // Nothing to report and nothing queued for later – see `docs/PRODUCT.md#anti-goals`.
  }
}
