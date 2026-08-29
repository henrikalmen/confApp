import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  DATABASE_VERSION,
  adoptCacheOwner,
  cachedKeys,
  purgeScheduleCache,
  readCachedSchedule,
  setCacheIdentity,
  writeCachedSchedule,
  type CachedSchedule,
} from '../src/offline/schedule-cache.ts';
import {
  dropQueuedPostIt,
  holdPostIt,
  listQueuedPostIts,
  markQueuedPostItRefused,
  mintSubmissionId,
  queuedKeys,
} from '../src/offline/post-it-queue.ts';
import type { AttendeeSchedule } from '../src/api/client.ts';

/**
 * S04 TI01 and TI02 – the device-held queue: keyed on the subject, purged with everything else, and
 * added to S10's database by an upgrade that does not cost anybody their cached Schedule.
 *
 * Driven against a **real IndexedDB implementation**, freshly created per test, for the same reason
 * S10's own store test is: every property here is a storage property. That a compound key really
 * does separate two employees, that `clear()` really does leave nothing readable, and that raising
 * `DATABASE_VERSION` really does run `onupgradeneeded` additively are all things a `Map` pretending
 * to be a database would confirm whatever the module did.
 *
 * **Ownership is claimed before anything is written, everywhere in this file.** `adoptCacheOwner`
 * fails closed, so an entry written before the claim is deleted by it – and every later "the queue
 * is empty" assertion then passes without proving anything (`docs/LEARNINGS.md#testing`).
 */

const NADIA = 'google-sub-nadia';
const BJORN = 'google-sub-bjorn';
const KICKOFF = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const ROUND = '33333333-3333-4333-8333-333333333333';

const SERVER_NOW = {
  instant: '2026-09-15T07:40:12.345678Z',
  day: '2026-09-15',
  time: '09:40',
};

function envelope(): AttendeeSchedule {
  return {
    conference: {
      id: KICKOFF,
      name: 'Kickoff 2026',
      startDate: '2026-09-15',
      endDate: '2026-09-16',
      state: 'published',
      lastUpdatedAt: '2026-09-15T08:00:00.000000Z',
    },
    days: [
      {
        date: '2026-09-15',
        dayNumber: 1,
        sessions: [
          {
            id: 'keynote',
            title: 'Opening Keynote',
            description: null,
            kind: 'Presentation',
            startTime: '09:00',
            endTime: '10:30',
            location: 'Main Hall',
            concurrentWith: [],
          },
        ],
      },
    ],
    serverNow: SERVER_NOW,
  };
}

function cached(): CachedSchedule {
  return {
    envelope: envelope(),
    watermark: '2026-09-15T08:00:00.000000Z',
    deviceClockAtReceipt: Date.UTC(2026, 8, 15, 7, 40, 12, 345),
  };
}

let held = 0;
function item(text: string, roundId = ROUND) {
  held += 1;
  return {
    submissionId: mintSubmissionId(),
    conferenceId: KICKOFF,
    sessionId: SESSION,
    roundId,
    text,
    heldAt: held,
  };
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  setCacheIdentity(() => NADIA);
  held = 0;
});

describe('holding a post-it on the device', () => {
  it('reads it back after the database is reopened, and never under somebody else’s subject', async () => {
    await adoptCacheOwner(NADIA);
    const mine = item('Nobody owns the staging environment');
    expect(await holdPostIt(mine)).toBe(true);

    // A fresh open of the same database – the relaunch, as far as this store is concerned.
    const back = await listQueuedPostIts(NADIA);
    expect(back.map((entry) => entry.text)).toEqual(['Nobody owns the staging environment']);
    expect(back[0]!.submissionId).toBe(mine.submissionId);
    expect(back[0]!.refusal).toBeNull();

    // Björn's listing is empty, and the key that holds Nadia's names her.
    expect(await listQueuedPostIts(BJORN)).toEqual([]);
    expect(await queuedKeys()).toEqual([[NADIA, mine.submissionId]]);
  });

  it('is dropped rather than written under a guessed key when nobody is signed in', async () => {
    await adoptCacheOwner(NADIA);
    setCacheIdentity(() => null);

    expect(await holdPostIt(item('Typed by nobody'))).toBe(false);
    expect(await queuedKeys()).toEqual([]);
  });

  it('keeps the queue in the order it was typed', async () => {
    await adoptCacheOwner(NADIA);
    await holdPostIt(item('First'));
    await holdPostIt(item('Second'));
    await holdPostIt(item('Third'));

    expect((await listQueuedPostIts()).map((entry) => entry.text)).toEqual([
      'First',
      'Second',
      'Third',
    ]);
  });

  it('records a refusal against the item without discarding its text, and drops it when told to', async () => {
    await adoptCacheOwner(NADIA);
    const mine = item('Nobody owns the staging environment');
    await holdPostIt(mine);

    await markQueuedPostItRefused(mine.submissionId, 'That round is no longer here.');

    const [after] = await listQueuedPostIts();
    expect(after!.text).toBe('Nobody owns the staging environment');
    expect(after!.refusal).toBe('That round is no longer here.');

    await dropQueuedPostIt(mine.submissionId);
    expect(await listQueuedPostIts()).toEqual([]);
    expect(await queuedKeys()).toEqual([]);
  });
});

// ---------- the same purge, not a second teardown path (TI02) ----------

describe('signing out and switching employee', () => {
  it('leaves no queued post-it readable, and no key behind, after a purge', async () => {
    await adoptCacheOwner(NADIA);
    await holdPostIt(item('Nobody owns the staging environment'));
    await writeCachedSchedule(NADIA, KICKOFF, cached());
    expect(await queuedKeys()).toHaveLength(1);

    await purgeScheduleCache();

    expect(await listQueuedPostIts(NADIA)).toEqual([]);
    expect(await queuedKeys()).toEqual([]);
    // The schedule went with it – one operation, both stores.
    expect(await cachedKeys()).toEqual([]);
  });

  it('empties the queue when the next employee claims the device, however the last session ended', async () => {
    await adoptCacheOwner(NADIA);
    await holdPostIt(item('One'));
    await holdPostIt(item('Two'));

    // No sign-out ran: the app was killed. The claim is what covers that case.
    await adoptCacheOwner(BJORN);

    expect(await queuedKeys()).toEqual([]);
    expect(await listQueuedPostIts(BJORN)).toEqual([]);
    expect(await listQueuedPostIts(NADIA)).toEqual([]);
  });

  it('keeps what the same employee left when they sign in again', async () => {
    await adoptCacheOwner(NADIA);
    await holdPostIt(item('Still mine'));

    await adoptCacheOwner(NADIA);

    expect((await listQueuedPostIts()).map((entry) => entry.text)).toEqual(['Still mine']);
  });
});

// ---------- the upgrade that adds the store (TI01) ----------

/**
 * Opens the database the way an **earlier build** did – at version 1, with only the two stores S10
 * created – and writes a Schedule into it directly.
 *
 * This is the device that has had confApp installed since before S04: `onupgradeneeded` runs only
 * when the version rises, so if it did not, the queue store would be permanently absent and every
 * write to it would resolve `null` and vanish silently rather than failing.
 */
async function asPreviousBuild(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = globalThis.indexedDB.open('confapp-offline', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('schedules');
      request.result.createObjectStore('meta');
    };
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction(['schedules', 'meta'], 'readwrite');
      transaction.objectStore('schedules').put(cached(), [NADIA, KICKOFF]);
      transaction.objectStore('meta').put(NADIA, 'owner-sub');
      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
    };
    request.onerror = () => reject(request.error);
  });
}

describe('a device that already held a cached schedule at the previous database version', () => {
  it('keeps that schedule and gains a working queue', async () => {
    expect(DATABASE_VERSION).toBeGreaterThan(1);
    await asPreviousBuild();

    // The upgrade is additive, so the entry written by the older build is still readable.
    const schedule = await readCachedSchedule(NADIA, KICKOFF);
    expect(schedule?.envelope.conference.name).toBe('Kickoff 2026');

    // And the store the upgrade created actually holds something, rather than swallowing writes.
    const mine = item('Nobody owns the staging environment');
    expect(await holdPostIt(mine)).toBe(true);
    expect((await listQueuedPostIts()).map((entry) => entry.text)).toEqual([
      'Nobody owns the staging environment',
    ]);

    // Both stores, still one purge.
    await purgeScheduleCache();
    expect(await cachedKeys()).toEqual([]);
    expect(await queuedKeys()).toEqual([]);
  });
});
