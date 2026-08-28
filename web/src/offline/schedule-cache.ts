import type { AttendeeSchedule } from '../api/client.ts';
import { rehydrateClock, type ClockAnchor } from '../clock/effective-clock.ts';

/**
 * The one module that touches offline storage – S06's schedule envelope, per user and per
 * Conference, in IndexedDB.
 *
 * **Read-only data, deliberately.** There is no outbox, no queue, no replay buffer and no
 * conflict resolution here, and adding one would cross the product's anti-goal rather than extend
 * this module (`docs/PRODUCT.md#anti-goals`). Everything below writes exactly what a *read*
 * returned and hands it back later; nothing here is ever sent anywhere.
 *
 * **The key is a pair.** `(sub, conferenceId)` – the OIDC subject, never an email (AGENTS.md), and
 * the Conference the envelope belongs to. Two Conferences are two entries and two employees on a
 * shared tablet are two disjoint key spaces, so a read can only ever return what the caller's own
 * identity wrote.
 *
 * **Nothing here parses a time.** The envelope is stored by structured clone exactly as it arrived,
 * so `day`, `startTime` and `endTime` come back as the identical strings the API produced (S04
 * contract). A `JSON.parse` with a date reviver, or any normalization "for sorting", would move a
 * 09:00 session for anyone whose device is not in the API's timezone – so neither exists.
 *
 * **No Capacitor plugin.** S11 has not run when this story lands, and one storage path has to serve
 * the browser, the Android shell and the iOS one from a single codebase (ADR-001).
 */

const DATABASE_NAME = 'confapp-offline';
const DATABASE_VERSION = 1;
/** Cached envelopes, keyed `[sub, conferenceId]`. */
const SCHEDULES = 'schedules';
/** Whose device this is – see `adoptCacheOwner`. One record, under `OWNER_KEY`. */
const META = 'meta';
const OWNER_KEY = 'owner-sub';

/**
 * One cached Schedule: the envelope, its watermark, and the clock anchor's second half.
 *
 * `deviceClockAtReceipt` is **the device clock's reading at the moment the response arrived** –
 * "fetched-at" throughout this story means exactly that, never a server timestamp and never a
 * re-read taken later. It is stored because it is one of the two values S06's offset is measured
 * from, and the other (`envelope.serverNow`) already rides inside the envelope. Persisting the pair
 * rather than the derived offset is what lets `rehydrateClock` reconstitute S06's arithmetic
 * unchanged after a force-quit; storing the offset instead, or recomputing it against a later
 * device-clock reading, would zero it out and silently reintroduce the raw device clock as "now".
 */
export interface CachedSchedule {
  envelope: AttendeeSchedule;
  /** The wire `conference.lastUpdatedAt` – the staleness marker *and* the reconnect cursor. */
  watermark: string | null;
  deviceClockAtReceipt: number;
}

/** The anchor S06's `rehydrateClock` takes, assembled from a cache entry and nothing else. */
export function anchorOf(entry: CachedSchedule): ClockAnchor {
  return {
    serverNowInstant: entry.envelope.serverNow.instant,
    serverNowDay: entry.envelope.serverNow.day,
    serverNowTime: entry.envelope.serverNow.time,
    deviceClockAtReceipt: entry.deviceClockAtReceipt,
  };
}

/**
 * Who the cache belongs to, supplied by the auth layer rather than read from storage here.
 *
 * The same shape as `setTokenSource` in the API client, for the same reason: this module never has
 * to know where a session lives, and a caller with no signed-in identity simply has no cache – a
 * read misses and a write is dropped, rather than an entry landing under a guessed key.
 */
export type SubjectSource = () => string | null;

let currentSubject: SubjectSource = () => null;

export function setCacheIdentity(source: SubjectSource): void {
  currentSubject = source;
}

/** The signed-in `sub`, or `null` when nobody is. */
export function cacheIdentity(): string | null {
  return currentSubject();
}

/**
 * Whether this browser can store anything at all.
 *
 * A WebView with storage disabled, a private window that refuses IndexedDB, and a jsdom process
 * with no implementation all land here. None of them is an error: the cache is an optimisation on
 * the read path, so its absence renders the "not available offline" state (TI05) exactly as an
 * evicted entry does.
 */
function factory(): IDBFactory | null {
  return typeof indexedDB === 'undefined' ? null : indexedDB;
}

function open(): Promise<IDBDatabase | null> {
  const idb = factory();
  if (idb === null) return Promise.resolve(null);

  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = idb.open(DATABASE_NAME, DATABASE_VERSION);
    } catch {
      resolve(null);
      return;
    }

    request.onupgradeneeded = () => {
      const database = request.result;
      // No `keyPath`: the key is the caller's `(sub, conferenceId)` pair, which is deliberately
      // *not* a field of the stored value – the value is the envelope as it arrived, unmodified.
      if (!database.objectStoreNames.contains(SCHEDULES)) database.createObjectStore(SCHEDULES);
      if (!database.objectStoreNames.contains(META)) database.createObjectStore(META);
    };
    // Storage that will not open is storage that is not there. Same outcome as a miss.
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
    request.onsuccess = () => resolve(request.result);
  });
}

/**
 * Mutating operations run one at a time, in the order they were called.
 *
 * **Not a write queue.** Nothing is held for later and nothing is ever sent anywhere – this is
 * mutual exclusion over local storage, and every operation it serializes still completes within its
 * own call. The queue an outbox would be is an explicit anti-goal and is not what this is.
 *
 * It exists because a user switch fires two independent async calls: S02's clearing hook purges,
 * and the sign-in that follows claims the store for the new `sub`. IndexedDB orders transactions by
 * when they are *created*, and each of those calls opens its own database first – so the claim's
 * `put` can be created before the purge's `clear`, leaving the store correctly empty but with no
 * owner recorded, which is exactly the marker the next user-switch check reads.
 *
 * **Defence, not a tested guarantee.** The hazard is a property of real browser IndexedDB; the
 * in-memory implementation the tests run against resolves `open()` too promptly to reproduce it, so
 * no test here fails when this wrapper is removed. It is kept because it is a few lines and the
 * failure it prevents is a shared tablet losing the marker that tells it whose data it holds.
 */
let mutations: Promise<unknown> = Promise.resolve();

function exclusively<T>(work: () => Promise<T>): Promise<T> {
  const next = mutations.then(work, work);
  // The chain must survive a rejection, or one failed write would deadlock every later one.
  mutations = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/** One transaction, resolving with whatever the request produced, or `null` if anything failed. */
async function transact<T>(
  stores: string[],
  mode: IDBTransactionMode,
  work: (transaction: IDBTransaction) => IDBRequest<T> | null,
): Promise<T | null> {
  const database = await open();
  if (database === null) return null;

  try {
    return await new Promise<T | null>((resolve) => {
      try {
        // `transaction()` itself throws when a named store is absent – a database left at this
        // version by an earlier build never re-runs `onupgradeneeded`, so the miss is permanent.
        // It has to be inside the guard: outside it, the throw rejects this promise instead of
        // resolving `null`, and every caller `void`s the result, so the sign-out purge would be
        // skipped by an unhandled rejection rather than reported as a failure.
        const transaction = database.transaction(stores, mode);
        const request = work(transaction);

        // The *transaction* is what settles the promise, not the request: a write is only true once
        // it has committed, and quota pressure fails at commit rather than at `put`.
        transaction.oncomplete = () => resolve(request === null ? null : request.result);
        transaction.onerror = () => resolve(null);
        transaction.onabort = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  } finally {
    database.close();
  }
}

/**
 * Whether an entry can still do the one job it is stored for.
 *
 * **A corrupt entry is a miss, not an exception.** Storage outlives code: the value was written by
 * whichever build was installed at the time, `DATABASE_VERSION` carries no shape version, and
 * `apiRequest` casts its response body without validating it – so an envelope with a renamed,
 * missing or malformed `serverNow` can be written by one deploy and read by the next. The offline
 * render calls `rehydrateClock(anchorOf(entry))`, and both of those *throw* on such a value; a
 * throw inside the caller's fallback path would leave the schedule view on its loading state with
 * nothing to resolve it, which is precisely what Acceptance Scenario S03 forbids.
 *
 * So the check is the real operation rather than a shape guess: build the clock and read it. If
 * that cannot be done, the entry cannot render and the caller should be told there is nothing here.
 */
function usable(entry: CachedSchedule | null | undefined): entry is CachedSchedule {
  if (entry === null || entry === undefined) return false;
  // `Number.isFinite`, not `typeof === 'number'`: `NaN` passes the latter, and a `NaN` receipt
  // reading propagates through the clock into a malformed day string that the readability window
  // used to answer "readable" for (review 2026-08-26, SEC-14). The window guards itself now; this
  // stops such an entry being served at all.
  if (!Number.isFinite(entry.deviceClockAtReceipt)) return false;
  // Empty counts as unusable, not merely absent. `defaultDay` returns `undefined` for an empty
  // `days`, and the panel then renders no session list, no cached label and no hint – a blank
  // screen with no terminating outcome, which is exactly what OC03 forbids and what this guard
  // exists to prevent. The server derives `days` from a 1–4 day span and never emits an empty
  // array, but this guards storage, which outlives whichever build wrote it.
  if (!Array.isArray(entry.envelope?.days) || entry.envelope.days.length === 0) return false;
  if (typeof entry.envelope.conference?.id !== 'string') return false;

  try {
    rehydrateClock(anchorOf(entry)).effectiveWallClockNow();
    return true;
  } catch {
    return false;
  }
}

/**
 * The cached Schedule for one employee and one Conference, or `null` where there is none.
 *
 * A miss is an ordinary outcome, not a failure: browser and WebView storage is evictable – iOS
 * WebKit clears IndexedDB for origins that go unused, and quota pressure drops entries – so the
 * caller renders "not available offline" and nothing about correctness depends on an entry having
 * survived. An entry that cannot render is the same outcome, and is dropped on the way past so a
 * poisoned row cannot sit there failing every future launch.
 */
export async function readCachedSchedule(
  sub: string,
  conferenceId: string,
): Promise<CachedSchedule | null> {
  const entry = await transact<CachedSchedule | undefined>([SCHEDULES], 'readonly', (transaction) =>
    transaction.objectStore(SCHEDULES).get([sub, conferenceId]),
  );

  if (!usable(entry)) {
    // Nothing there is nothing to clean up; something unreadable is, and it goes now so the next
    // launch is not the same failure again.
    if (entry !== null && entry !== undefined) void forgetCachedSchedule(sub, conferenceId);
    return null;
  }
  return entry;
}

/**
 * Stores one Schedule under `(sub, conferenceId)`.
 *
 * `put`, not `add`: writing the same pair twice replaces the entry, which is what makes an
 * idempotent re-join (S05) and a reconnect refresh leave exactly one entry rather than a duplicate.
 */
export async function writeCachedSchedule(
  sub: string,
  conferenceId: string,
  entry: CachedSchedule,
): Promise<void> {
  // Refused rather than stored. A response that cannot produce a clock cannot render offline, and
  // writing it would replace a good entry with one guaranteed to miss (see `usable`).
  if (!usable(entry)) return;

  await exclusively(() =>
    transact([SCHEDULES], 'readwrite', (transaction) =>
      transaction.objectStore(SCHEDULES).put(entry, [sub, conferenceId]),
    ),
  );
}

/**
 * Forgets one Conference for one employee.
 *
 * Leaving a Conference is the case this exists for. The membership is gone server-side, so the
 * Schedule is no longer readable online – and an entry left behind here would keep it readable
 * *offline*, which contradicts what the leave confirmation promises in as many words. Narrower than
 * the purge on purpose: the other Conferences on this device are untouched.
 */
export async function forgetCachedSchedule(sub: string, conferenceId: string): Promise<void> {
  await exclusively(() =>
    transact([SCHEDULES], 'readwrite', (transaction) =>
      transaction.objectStore(SCHEDULES).delete([sub, conferenceId]),
    ),
  );
}

/**
 * Every cached Schedule, gone – the whole store, not this user's rows.
 *
 * A privacy requirement rather than cleanup (S10 → risk summary): a shared tablet must leave the
 * next employee nothing of the previous signer's Conference, and "nothing" includes rows a future
 * bug could read back. Clearing everything is also what makes the purge correct when the identity
 * that wrote the rows is no longer known.
 */
export async function purgeScheduleCache(): Promise<void> {
  await exclusively(purgeNow);
}

/** The purge itself, without the ordering wrapper – so `adoptCacheOwner` can reuse it inside one. */
async function purgeNow(): Promise<void> {
  await transact([SCHEDULES, META], 'readwrite', (transaction) => {
    transaction.objectStore(SCHEDULES).clear();
    return transaction.objectStore(META).clear();
  });
}

/**
 * Claims the store for `sub`, purging first when it currently belongs to somebody else.
 *
 * This is the half of the purge that a sign-out event cannot cover. An app killed mid-session never
 * runs the sign-out path, so the next employee to sign in on that device would find the previous
 * signer's rows intact; here the store checks its own owner against the identity presented at
 * sign-in and empties itself when they differ. No token is read and no session is ended – the auth
 * teardown path stays S02's, and this is the store answering a question about itself.
 */
export async function adoptCacheOwner(sub: string): Promise<void> {
  // Read, purge and claim as one unit: a purge landing between the read and the claim would leave
  // the store owned by somebody whose rows had just been deleted.
  await exclusively(async () => {
    const owner = await transact<string | undefined>([META], 'readonly', (transaction) =>
      transaction.objectStore(META).get(OWNER_KEY),
    );

    // Fails closed. An absent owner marker is not evidence the store is empty – a failed owner
    // write leaves rows with no recorded owner, and `transact` reports that failure as a plain
    // `null`. Purging a store that nobody can be shown to own costs one no-op clear on a fresh
    // device and removes the only path by which one employee's rows outlive a different sign-in.
    if (owner !== sub) await purgeNow();

    await transact([META], 'readwrite', (transaction) =>
      transaction.objectStore(META).put(sub, OWNER_KEY),
    );
  });
}

/** The `sub` the store currently belongs to. Exported for the tests that assert the purge. */
export async function cacheOwner(): Promise<string | null> {
  const owner = await transact<string | undefined>([META], 'readonly', (transaction) =>
    transaction.objectStore(META).get(OWNER_KEY),
  );
  return owner ?? null;
}

/**
 * Every Schedule stored for one employee, in no particular order.
 *
 * The keys are read first and filtered on their `sub` half, so an entry belonging to somebody else
 * cannot be returned even by a caller that asked for everything.
 */
export async function readCachedSchedulesFor(sub: string): Promise<CachedSchedule[]> {
  const keys = await cachedKeys();
  const mine = keys.filter(
    (key): key is [string, string] => Array.isArray(key) && key[0] === sub && key.length === 2,
  );

  const entries = await Promise.all(
    mine.map(([, conferenceId]) => readCachedSchedule(sub, conferenceId)),
  );
  return entries.filter((entry): entry is CachedSchedule => entry !== null);
}

/** Every key in the store, so a test can assert emptiness rather than absence of a rendering. */
export async function cachedKeys(): Promise<IDBValidKey[]> {
  const keys = await transact<IDBValidKey[]>([SCHEDULES], 'readonly', (transaction) =>
    transaction.objectStore(SCHEDULES).getAllKeys(),
  );
  return keys ?? [];
}
