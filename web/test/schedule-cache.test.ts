import 'fake-indexeddb/auto';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { IDBFactory } from 'fake-indexeddb';
import {
  adoptCacheOwner,
  anchorOf,
  cacheOwner,
  cachedKeys,
  forgetCachedSchedule,
  purgeScheduleCache,
  readCachedSchedule,
  readCachedSchedulesFor,
  writeCachedSchedule,
  type CachedSchedule,
} from '../src/offline/schedule-cache.ts';
import { rehydrateClock } from '../src/clock/effective-clock.ts';
import type { AttendeeSchedule } from '../src/api/client.ts';

/**
 * S10 TI01 – the cache store: keyed on the pair, round-tripping strings, purgeable whole.
 *
 * Driven against a **real IndexedDB implementation** rather than a stubbed key-value object. The
 * properties under test are storage properties – that a compound key really does separate two
 * subjects, that structured clone really does return the authored time strings, that `clear()`
 * really does leave nothing readable – and a `Map` pretending to be a database would confirm all
 * three whatever the module did.
 */

const here = dirname(fileURLToPath(import.meta.url));
const webSrc = join(here, '..', 'src');

const NADIA = 'google-sub-nadia';
const BJORN = 'google-sub-bjorn';
const KICKOFF = '11111111-1111-4111-8111-111111111111';
const RETRO_DAY = '22222222-2222-4222-8222-222222222222';
const LEADERSHIP = '33333333-3333-4333-8333-333333333333';

const SERVER_NOW = {
  instant: '2026-09-15T07:40:12.345678Z',
  day: '2026-09-15',
  time: '09:40',
};

const WATERMARK = '2026-09-15T08:00:00.000000Z';

function envelope(name = 'Kickoff 2026', id = KICKOFF): AttendeeSchedule {
  return {
    conference: {
      id,
      name,
      startDate: '2026-09-15',
      endDate: '2026-09-16',
      state: 'published',
      lastUpdatedAt: WATERMARK,
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
      { date: '2026-09-16', dayNumber: 2, sessions: [] },
    ],
    serverNow: SERVER_NOW,
  };
}

function entry(overrides: Partial<CachedSchedule> = {}): CachedSchedule {
  return {
    envelope: envelope(),
    watermark: WATERMARK,
    deviceClockAtReceipt: 1_789_000_000_000,
    ...overrides,
  };
}

beforeEach(() => {
  // A fresh database per test, so nothing leaks between them and every purge assertion is about
  // the purge rather than about the previous test having written nothing.
  globalThis.indexedDB = new IDBFactory();
});

// ---------- the key is the pair ----------

describe('an entry written under one subject and conference', () => {
  it('is not readable under a different subject, nor a different conference', async () => {
    await writeCachedSchedule(NADIA, KICKOFF, entry());

    expect(await readCachedSchedule(NADIA, KICKOFF)).not.toBeNull();
    expect(await readCachedSchedule(BJORN, KICKOFF)).toBeNull();
    expect(await readCachedSchedule(NADIA, RETRO_DAY)).toBeNull();
  });

  it('holds two conferences for the same person as two separate entries', async () => {
    await writeCachedSchedule(NADIA, KICKOFF, entry());
    await writeCachedSchedule(
      NADIA,
      RETRO_DAY,
      entry({ envelope: envelope('Retro Day', RETRO_DAY) }),
    );

    expect((await readCachedSchedule(NADIA, KICKOFF))!.envelope.conference.name).toBe(
      'Kickoff 2026',
    );
    expect((await readCachedSchedule(NADIA, RETRO_DAY))!.envelope.conference.name).toBe(
      'Retro Day',
    );
    expect(await cachedKeys()).toHaveLength(2);
  });

  it('leaves exactly one entry when the same pair is written twice', async () => {
    await writeCachedSchedule(NADIA, KICKOFF, entry());
    await writeCachedSchedule(NADIA, KICKOFF, entry({ deviceClockAtReceipt: 1_789_000_060_000 }));

    expect(await cachedKeys()).toHaveLength(1);
    expect((await readCachedSchedule(NADIA, KICKOFF))!.deviceClockAtReceipt).toBe(
      1_789_000_060_000,
    );
  });
});

// ---------- the round trip is byte-identical ----------

describe('a cached session', () => {
  it('comes back with its day, start and end times as the identical authored strings', async () => {
    await writeCachedSchedule(NADIA, KICKOFF, entry());

    const read = await readCachedSchedule(NADIA, KICKOFF);
    const session = read!.envelope.days[0]!.sessions[0]!;

    expect(read!.envelope.days[0]!.date).toBe('2026-09-15');
    expect(session.startTime).toBe('09:00');
    expect(session.endTime).toBe('10:30');
    // Strings, not anything a `Date` reviver turned into an object on the way back.
    expect(typeof session.startTime).toBe('string');
    expect(read!.envelope).toEqual(envelope());
  });

  it('returns the serverNow anchor and the receipt reading unchanged however much later it is read', async () => {
    const written = entry({ deviceClockAtReceipt: 1_789_000_000_000 });
    await writeCachedSchedule(NADIA, KICKOFF, written);

    const read = await readCachedSchedule(NADIA, KICKOFF);

    expect(read!.deviceClockAtReceipt).toBe(1_789_000_000_000);
    expect(read!.envelope.serverNow).toEqual(SERVER_NOW);
    expect(read!.watermark).toBe(WATERMARK);

    // And the pair reconstitutes S06's clock, which is the only reason it is stored.
    const clock = rehydrateClock(anchorOf(read!), () => 1_789_000_000_000);
    expect(clock.effectiveWallClockNow()).toEqual({ day: '2026-09-15', time: '09:40' });
  });
});

// ---------- an entry this build cannot render ----------

/**
 * Storage outlives code. The value was written by whichever build was installed at the time, the
 * database version carries no shape marker, and the API client casts its response body without
 * validating it – so an envelope with a renamed, missing or malformed `serverNow` can be written by
 * one deploy and read by the next.
 *
 * The offline render calls `rehydrateClock(anchorOf(entry))`, and both of those **throw** on such a
 * value. Thrown from inside the caller's offline fallback, that leaves the schedule view on its
 * loading state with nothing to resolve it – exactly what Acceptance Scenario S03 forbids. So a
 * corrupt entry is a miss, and it is dropped rather than left to fail every future launch.
 */
describe('a cached entry this build cannot turn into a clock', () => {
  /** Writes past the module's own guard, the way an older build would have. */
  async function writeRaw(value: unknown): Promise<void> {
    const request = indexedDB.open('confapp-offline', 1);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains('schedules')) {
          database.createObjectStore('schedules');
        }
        if (!database.objectStoreNames.contains('meta')) database.createObjectStore('meta');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['schedules'], 'readwrite');
      tx.objectStore('schedules').put(value, [NADIA, KICKOFF]);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }

  it.each([
    ['a missing serverNow', { envelope: { ...envelope(), serverNow: undefined } }],
    [
      'a malformed instant',
      { envelope: { ...envelope(), serverNow: { ...SERVER_NOW, instant: 'not-an-instant' } } },
    ],
    [
      'a malformed wall-clock time',
      { envelope: { ...envelope(), serverNow: { ...SERVER_NOW, time: '25:99' } } },
    ],
    ['a missing receipt reading', { deviceClockAtReceipt: undefined }],
    ['no conference at all', { envelope: { days: [], serverNow: SERVER_NOW } }],
    // Distinct from the row above: everything else is valid here, and only `days` is empty. Such an
    // entry used to pass every branch and then render an entirely blank panel – no list, no cached
    // label, no hint – which is the one outcome OC03 rules out.
    ['a valid conference but no days at all', { envelope: { ...envelope(), days: [] } }],
  ])('reads as a miss and is dropped – %s', async (_label, overrides) => {
    await writeRaw({ ...entry(), ...overrides });
    expect(await cachedKeys()).toHaveLength(1);

    // A miss, not a throw. The caller renders "not available offline" exactly as for an evicted
    // entry, rather than rejecting inside its own fallback path.
    await expect(readCachedSchedule(NADIA, KICKOFF)).resolves.toBeNull();

    // And it is gone, so the next launch is not the same failure again.
    await vi.waitFor(async () => expect(await cachedKeys()).toEqual([]));
  });

  it('is refused on the way in, so a good entry is never replaced by one that cannot render', async () => {
    await writeCachedSchedule(NADIA, KICKOFF, entry());

    await writeCachedSchedule(NADIA, KICKOFF, {
      ...entry(),
      envelope: { ...envelope(), serverNow: { ...SERVER_NOW, instant: 'nonsense' } },
    });

    // The original survived rather than being overwritten by something unreadable.
    const read = await readCachedSchedule(NADIA, KICKOFF);
    expect(read).not.toBeNull();
    expect(read!.envelope.serverNow.instant).toBe(SERVER_NOW.instant);
  });
});

// ---------- reading every entry for one person ----------

/**
 * The offline conference picker is built from this, so it is the one path that reads *across*
 * entries – and therefore the one place a missing `sub` filter would put another employee's
 * conference names on screen without any single-entry read having been wrong.
 */
describe('reading every cached schedule for one subject', () => {
  it('returns that subject’s entries and none of anybody else’s', async () => {
    await writeCachedSchedule(NADIA, KICKOFF, entry());
    await writeCachedSchedule(
      NADIA,
      RETRO_DAY,
      entry({ envelope: envelope('Retro Day', RETRO_DAY) }),
    );
    await writeCachedSchedule(
      BJORN,
      LEADERSHIP,
      entry({ envelope: envelope('Leadership Day', LEADERSHIP) }),
    );

    const mine = await readCachedSchedulesFor(NADIA);

    expect(mine.map((cached) => cached.envelope.conference.name).sort()).toEqual([
      'Kickoff 2026',
      'Retro Day',
    ]);
    // The name that must never appear: it belongs to the other person signed in on this device.
    expect(mine.map((cached) => cached.envelope.conference.name)).not.toContain('Leadership Day');
  });

  it('returns nothing for a subject that has cached nothing', async () => {
    await writeCachedSchedule(NADIA, KICKOFF, entry());
    expect(await readCachedSchedulesFor(BJORN)).toEqual([]);
  });
});

// ---------- forgetting one conference ----------

describe('forgetting a single entry', () => {
  it('removes only that pair, leaving the person’s other conferences readable', async () => {
    await writeCachedSchedule(NADIA, KICKOFF, entry());
    await writeCachedSchedule(
      NADIA,
      RETRO_DAY,
      entry({ envelope: envelope('Retro Day', RETRO_DAY) }),
    );

    await forgetCachedSchedule(NADIA, KICKOFF);

    expect(await readCachedSchedule(NADIA, KICKOFF)).toBeNull();
    expect(await readCachedSchedule(NADIA, RETRO_DAY)).not.toBeNull();
  });
});

// ---------- purge, and the owner check that covers a session that never signed out ----------

describe('purging', () => {
  it('leaves no readable entry for anybody', async () => {
    await writeCachedSchedule(NADIA, KICKOFF, entry());
    await writeCachedSchedule(BJORN, RETRO_DAY, entry());

    await purgeScheduleCache();

    expect(await cachedKeys()).toEqual([]);
    expect(await readCachedSchedule(NADIA, KICKOFF)).toBeNull();
    expect(await readCachedSchedule(BJORN, RETRO_DAY)).toBeNull();
  });
});

describe('adopting the store for a signed-in subject', () => {
  it('empties it when it belonged to somebody else', async () => {
    await adoptCacheOwner(NADIA);
    await writeCachedSchedule(NADIA, KICKOFF, entry());

    await adoptCacheOwner(BJORN);

    expect(await cachedKeys()).toEqual([]);
    expect(await cacheOwner()).toBe(BJORN);
  });

  it('keeps the entries when the same person signs in again', async () => {
    await adoptCacheOwner(NADIA);
    await writeCachedSchedule(NADIA, KICKOFF, entry());

    await adoptCacheOwner(NADIA);

    expect(await cachedKeys()).toHaveLength(1);
    expect(await readCachedSchedule(NADIA, KICKOFF)).not.toBeNull();
  });

  it('empties it when it holds entries but records no owner', async () => {
    // Deliberately no `adoptCacheOwner(NADIA)`: this is the shape a *failed* owner write leaves
    // behind, and `transact` reports that failure as a plain `null` with no retry and no signal.
    // An absent marker is therefore not evidence the store is empty – it is evidence that nobody
    // who can be named owns these rows, which is exactly when they must not survive a sign-in.
    await writeCachedSchedule(NADIA, KICKOFF, entry());
    expect(await cacheOwner()).toBeNull();

    await adoptCacheOwner(BJORN);

    expect(await cachedKeys()).toEqual([]);
    expect(await readCachedSchedule(NADIA, KICKOFF)).toBeNull();
    expect(await cacheOwner()).toBe(BJORN);
  });
});

// ---------- a database that cannot serve the store a call needs ----------

/**
 * Opens `confapp-offline` at the version the module expects, creating **only** `schedules`.
 *
 * This is not a hypothetical: a database left at version 1 by an earlier build never re-runs
 * `onupgradeneeded`, so a missing store is permanent for that device. Every call that touches
 * `meta` then throws from `transaction()` itself – before any request exists to attach a handler
 * to – which is the one failure mode the module's own error handling can miss.
 */
async function openWithOnly(store: 'schedules' | 'meta'): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = globalThis.indexedDB.open('confapp-offline', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(store);
    };
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error ?? new Error('open failed'));
  });
}

describe('a store the database does not have', () => {
  it('is reported as a miss rather than rejecting, so the purge still runs to completion', async () => {
    // `meta` absent: this is what `cacheOwner`, `adoptCacheOwner` and the purge all reach for.
    await openWithOnly('schedules');

    // Each of these resolves rather than rejects. The distinction is the whole point: every caller
    // invokes these as `void purgeScheduleCache()` / `void adoptCacheOwner(...)`, so a rejection is
    // unhandled and the sign-out purge is skipped silently instead of reported as a failure.
    await expect(cacheOwner()).resolves.toBeNull();
    await expect(adoptCacheOwner(BJORN)).resolves.toBeUndefined();
    await expect(purgeScheduleCache()).resolves.toBeUndefined();
  });

  it('leaves the read path with a terminating outcome instead of an unhandled rejection', async () => {
    // `schedules` absent, not `meta`: the read path never touches `meta`, so a fixture missing only
    // that store leaves these two calls on their ordinary success path and proves nothing about
    // them. The store a call actually opens is the one the fixture has to withhold.
    await openWithOnly('meta');

    // S10 Acceptance Scenario S03 forbids a spinner with no terminating outcome. The panel reaches
    // its offline state by way of `readCachedSchedule` resolving `null`; a rejection escapes the
    // effect instead, `setPhase` is never called, and the view stays on `attendee-loading`.
    await expect(readCachedSchedule(NADIA, KICKOFF)).resolves.toBeNull();
    await expect(readCachedSchedulesFor(NADIA)).resolves.toEqual([]);
  });
});

// ---------- an entry whose receipt reading is not a real number ----------

describe('an entry written with a non-finite receipt reading', () => {
  /**
   * Review 2026-08-26, SEC-14. `typeof NaN === 'number'`, so `usable()` used to accept such an
   * entry, and a `NaN` receipt propagates through the clock into a day string like '0NaN-NaN-NaN'
   * that the readability window compared lexicographically and answered **readable** for.
   *
   * The window guards itself now; this is the other half — an entry that cannot produce a real
   * day is not served at all, and is dropped on the way past like any other unrenderable row.
   */
  it('is refused on write and treated as a miss on read', async () => {
    await writeCachedSchedule(NADIA, KICKOFF, entry({ deviceClockAtReceipt: Number.NaN }));

    // Refused on the way in – a value that cannot render offline is not stored.
    expect(await cachedKeys()).toEqual([]);
    expect(await readCachedSchedule(NADIA, KICKOFF)).toBeNull();
  });
});

// ---------- what the module is not ----------

describe('the offline layer', () => {
  it('depends on no Capacitor package and introduces no queue, outbox or replay path', () => {
    const source = readFileSync(join(webSrc, 'offline', 'schedule-cache.ts'), 'utf8');

    expect(source).not.toMatch(/@capacitor/);
    // Comments discuss the anti-goal by name, so this looks for the identifiers a queue would need.
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(code).not.toMatch(/outbox|replayQueue|pendingWrite|syncQueue/i);
  });
});
