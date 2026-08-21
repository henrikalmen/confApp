import 'fake-indexeddb/auto';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { IDBFactory } from 'fake-indexeddb';
import { AttendeeSchedulePanel } from '../src/attendee/AttendeeSchedulePanel.tsx';
import {
  cachedKeys,
  readCachedSchedule,
  setCacheIdentity,
  writeCachedSchedule,
} from '../src/offline/schedule-cache.ts';
import { primeScheduleCache } from '../src/offline/schedule-data.ts';
import type { AttendeeSchedule, AttendeeSession } from '../src/api/client.ts';

/**
 * S10 – reading the Schedule with the network off, and being told what moved while it was.
 *
 * **Offline is simulated by making requests fail**, never by stubbing an `isOffline` flag (FIS →
 * Testing Strategy). A flag would pass while the real captive-portal and timeout paths still hung,
 * which is precisely the failure `navigator.onLine` invites; here the transport throws, exactly as
 * `fetch` does with no route to the host, and the component has to notice for itself.
 *
 * Storage is a **real IndexedDB implementation**, freshly created per test, and the S08 rehydration
 * test writes its entry directly rather than through a fetch – so nothing S06's clock module might
 * be holding in memory can carry the assertion. That is the whole point of that scenario: after a
 * force-quit there is nothing in memory, and the highlight has to come out of storage or not at all.
 *
 * The device clock is stubbed rather than the formatters, so a skew is driven for real and a wrong
 * implementation cannot pass by never having called the thing that was mocked.
 */

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const webSrc = join(here, '..', 'src');

const NADIA = 'google-sub-nadia';
const BJORN = 'google-sub-bjorn';
const KICKOFF = '11111111-1111-4111-8111-111111111111';
const RETRO_DAY = '22222222-2222-4222-8222-222222222222';
const LEADERSHIP = '33333333-3333-4333-8333-333333333333';

/** The server's reading at the last successful sync: 09:40 at the venue, 07:40:12.345678Z. */
const SERVER_NOW = {
  instant: '2026-09-15T07:40:12.345678Z',
  day: '2026-09-15',
  time: '09:40',
};
const SYNC_INSTANT_MILLIS = Date.UTC(2026, 8, 15, 7, 40, 12, 345);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const FIRST_WATERMARK = '2026-09-15T08:00:00.000000Z';
const SECOND_WATERMARK = '2026-09-15T09:15:00.000000Z';

function session(overrides: Partial<AttendeeSession> & { id: string }): AttendeeSession {
  return {
    title: 'Opening Keynote',
    description: null,
    kind: 'Presentation',
    startTime: '09:00',
    endTime: '10:30',
    location: 'Main Hall',
    concurrentWith: [],
    ...overrides,
  };
}

const KEYNOTE = session({ id: 'keynote' });
const DESIGN = session({
  id: 'design',
  title: 'Design Workshop',
  kind: 'Workshop',
  startTime: '13:00',
  endTime: '14:00',
  location: 'Room B',
});
const RETRO = session({
  id: 'retro',
  title: 'Retrospective',
  startTime: '15:00',
  endTime: '16:00',
  location: 'Room C',
});

function envelope(
  sessions: AttendeeSession[],
  lastUpdatedAt: string | null = FIRST_WATERMARK,
  conference = { id: KICKOFF, name: 'Kickoff 2026' },
): AttendeeSchedule {
  return {
    conference: {
      id: conference.id,
      name: conference.name,
      startDate: '2026-09-15',
      endDate: '2026-09-16',
      state: 'published',
      lastUpdatedAt,
    },
    days: [
      { date: '2026-09-15', dayNumber: 1, sessions },
      { date: '2026-09-16', dayNumber: 2, sessions: [] },
    ],
    serverNow: SERVER_NOW,
  };
}

const KICKOFF_LIST = {
  conferences: [
    {
      id: KICKOFF,
      name: 'Kickoff 2026',
      startDate: '2026-09-15',
      endDate: '2026-09-16',
      state: 'published',
    },
  ],
  defaultConferenceId: KICKOFF,
};

// ---------- the transport ----------

/** A stubbed answer, or `OFFLINE` – which throws exactly as `fetch` does with no route to a host. */
type Answer = { status: number; body: unknown } | 'offline';

/**
 * Routes by path suffix. Anything unrouted is offline, so "the network is down" is expressed by
 * routing nothing rather than by a flag the component could read.
 */
function routeFetch(routes: () => Record<string, Answer>): typeof fetch {
  return vi.fn(async (input: unknown, init?: RequestInit) => {
    if (init?.signal?.aborted === true) throw new DOMException('Aborted', 'AbortError');

    const url = String(input);
    const table = routes();
    // Longest match first, so '/schedule/watermark' is not captured by '/schedule'.
    const match = Object.keys(table)
      .sort((a, b) => b.length - a.length)
      .find((path) => url.endsWith(path));

    const answer = match === undefined ? 'offline' : table[match]!;
    if (answer === 'offline') {
      // What the browser throws when there is nothing to reach. Not an API refusal – an API
      // refusal is an answer, and the cache must never overrule one.
      throw new TypeError('Failed to fetch');
    }

    return {
      ok: answer.status < 400,
      status: answer.status,
      json: async () => answer.body,
    } as Response;
  }) as unknown as typeof fetch;
}

/** Every route offline. The state an attendee is in when the venue wifi dies. */
const NOTHING_REACHABLE: Record<string, Answer> = {};

/** The device clock, pinned. Stubbed rather than a formatter, so a skew is real arithmetic. */
function pinDeviceClock(millis: number): void {
  vi.spyOn(Date, 'now').mockReturnValue(millis);
}

function setOnLine(value: boolean): void {
  Object.defineProperty(navigator, 'onLine', { value, configurable: true });
}

/** The connection coming back, as the browser reports it – a prompt to try, never a promise. */
function reconnect(): void {
  setOnLine(true);
  window.dispatchEvent(new Event('online'));
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  window.__CONFAPP_CONFIG__ = { apiBaseUrl: '/api' };
  setCacheIdentity(() => NADIA);
  setOnLine(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  setCacheIdentity(() => null);
  setOnLine(true);
});

/** A cached Kickoff at the first watermark, with the three sessions the scenario names. */
async function cacheKickoff(receipt: number): Promise<void> {
  await writeCachedSchedule(NADIA, KICKOFF, {
    envelope: envelope([KEYNOTE, DESIGN, RETRO]),
    watermark: FIRST_WATERMARK,
    deviceClockAtReceipt: receipt,
  });
}

// ---------- Acceptance Scenario S01: joining online is enough ----------

describe('an attendee who joined two conferences online and never opened either schedule', () => {
  it('reads both of them offline, in the normal schedule view, from entries keyed to her sub', async () => {
    pinDeviceClock(SYNC_INSTANT_MILLIS);

    // Online, she joins. Nothing opens the schedule view - the join primes the cache (TI03).
    let table: Record<string, Answer> = {
      [`/conferences/${KICKOFF}/schedule`]: {
        status: 200,
        body: envelope([KEYNOTE, DESIGN, RETRO]),
      },
      [`/conferences/${RETRO_DAY}/schedule`]: {
        status: 200,
        body: envelope([KEYNOTE], FIRST_WATERMARK, { id: RETRO_DAY, name: 'Retro Day' }),
      },
    };
    vi.stubGlobal(
      'fetch',
      routeFetch(() => table),
    );

    await primeScheduleCache(KICKOFF);
    await primeScheduleCache(RETRO_DAY);
    // Two conferences, two entries – and a repeated join writes the same pair rather than a second.
    await primeScheduleCache(KICKOFF);
    expect(await cachedKeys()).toHaveLength(2);

    // The venue wifi dies. Every request now fails, including the conference list.
    table = NOTHING_REACHABLE;
    setOnLine(false);
    render(<AttendeeSchedulePanel />);

    // The same component tree S06 renders online, with the sessions in start-time order.
    const list = await screen.findByTestId('attendee-session-list');
    const titles = [...list.querySelectorAll('.session-card__title')].map(
      (node) => node.textContent,
    );
    expect(titles).toEqual(['Opening Keynote', 'Design Workshop', 'Retrospective']);

    // The authored strings, exactly – a cache round trip is a serialization boundary and this is
    // where a `Date` coercion would show up.
    expect(screen.getByTestId('attendee-session-keynote').textContent).toContain('09:00–10:30');
    expect(screen.getByTestId('attendee-session-design').textContent).toContain('13:00–14:00');
    // The day navigation is the online one, both days present.
    expect(screen.getByTestId('attendee-day-2026-09-15')).not.toBeNull();
    expect(screen.getByTestId('attendee-day-2026-09-16')).not.toBeNull();

    // Said, not implied: the data is cached, and how long ago it was last updated.
    const label = screen.getByTestId('schedule-cached-label');
    expect(label.textContent).toMatch(/saved on this device/i);
    expect(label.textContent).toMatch(/just now|ago/i);

    // "Retro Day" is a separate entry, readable offline too.
    expect(screen.getByTestId('attendee-conference-picker')).not.toBeNull();
    expect(screen.getByText('Retro Day')).not.toBeNull();

    // Both are keyed to Nadia's sub, and to nobody else's.
    expect(await readCachedSchedule(NADIA, KICKOFF)).not.toBeNull();
    expect(await readCachedSchedule(NADIA, RETRO_DAY)).not.toBeNull();
    expect(await readCachedSchedule(BJORN, KICKOFF)).toBeNull();
  });
});

// ---------- Acceptance Scenario S02: a three-day-old cache is shown, with its age ----------

describe('a cache last updated three days and four hours ago', () => {
  it('renders in full, labelled with its elapsed age and no absolute time', async () => {
    const receipt = SYNC_INSTANT_MILLIS;
    // Three days and four hours have passed on the device's own clock since the sync.
    pinDeviceClock(receipt + 3 * DAY + 4 * HOUR);

    await writeCachedSchedule(NADIA, KICKOFF, {
      envelope: envelope([KEYNOTE, DESIGN, RETRO]),
      watermark: FIRST_WATERMARK,
      deviceClockAtReceipt: receipt,
    });

    setOnLine(false);
    vi.stubGlobal(
      'fetch',
      routeFetch(() => NOTHING_REACHABLE),
    );
    render(<AttendeeSchedulePanel />);

    // Neither hidden, blanked, nor replaced by a "too old" refusal.
    const list = await screen.findByTestId('attendee-session-list');
    expect(within(list).getByText('Opening Keynote')).not.toBeNull();
    expect(within(list).getByText('Retrospective')).not.toBeNull();

    const label = screen.getByTestId('schedule-cached-label').textContent ?? '';
    expect(label).toContain('3 days ago');

    /*
     * The watermark is a `timestamptz`. Converting it to a wall clock on the device would print a
     * time disagreeing with every Session time on the same screen, so the label carries no clock
     * time at all - not the watermark's, not any other.
     */
    expect(label).not.toMatch(/\d{1,2}:\d{2}/);
    expect(label).not.toContain('2026-09-15');
  });
});

// ---------- Acceptance Scenario S03: a conference never loaded on this device ----------

describe('a conference that was never read online', () => {
  it('states it is not available offline, and reaches a terminal non-loading state', async () => {
    pinDeviceClock(SYNC_INSTANT_MILLIS);
    setOnLine(false);

    // The list is known; the schedule request is the one that cannot be made, and nothing is
    // cached for this conference.
    vi.stubGlobal(
      'fetch',
      routeFetch(() => ({
        '/me/conferences': {
          status: 200,
          body: {
            conferences: [
              {
                id: LEADERSHIP,
                name: 'Leadership Day',
                startDate: '2026-09-15',
                endDate: '2026-09-15',
                state: 'published',
              },
            ],
            defaultConferenceId: LEADERSHIP,
          },
        },
      })),
    );

    render(<AttendeeSchedulePanel />);

    const state = await screen.findByTestId('schedule-unavailable-offline');
    expect(state.textContent).toMatch(/not available offline/i);
    // It says what resolves the situation, rather than reporting a transport error.
    expect(state.textContent).toMatch(/once while you have a connection/i);
    expect(state.textContent).not.toMatch(/could not reach the server/i);

    // Terminal: the attempt resolved and left no spinner behind it.
    await waitFor(() => expect(screen.queryByTestId('attendee-loading')).toBeNull());
    expect(screen.queryByTestId('attendee-schedule')).toBeNull();
  });

  it('says the same thing when nothing at all was ever cached on the device', async () => {
    pinDeviceClock(SYNC_INSTANT_MILLIS);
    setOnLine(false);
    vi.stubGlobal(
      'fetch',
      routeFetch(() => NOTHING_REACHABLE),
    );

    render(<AttendeeSchedulePanel />);

    expect(await screen.findByTestId('schedule-unavailable-offline')).not.toBeNull();
    await waitFor(() => expect(screen.queryByTestId('attendee-loading')).toBeNull());

    /*
     * And it does not also claim she has joined nothing. Offline the conference list is unknown –
     * all that is known is that nothing was cached – and telling a member of three conferences that
     * she has joined none is a false statement, not a helpful hint.
     */
    expect(screen.queryByTestId('attendee-no-conferences')).toBeNull();
  });
});

// ---------- an entry this build cannot render is a miss, not a hang ----------

describe('a cached entry whose envelope this build cannot turn into a clock', () => {
  /** Writes past the store's own guard, the way a previous deploy would have. */
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

  /**
   * The offline render needs `rehydrateClock(anchorOf(entry))`, and both of those throw on an
   * envelope whose `serverNow` has been renamed, dropped or malformed by a deploy that wrote it.
   * Thrown inside the panel's own offline fallback, that would leave the view on "Loading the
   * schedule…" with nothing left to resolve it – the terminating-outcome failure S03 forbids, and
   * one an attendee could not escape without a connection.
   */
  it('reaches the not-available-offline state instead of hanging on the loading hint', async () => {
    pinDeviceClock(SYNC_INSTANT_MILLIS);
    await writeRaw({
      envelope: { ...envelope([KEYNOTE]), serverNow: undefined },
      watermark: FIRST_WATERMARK,
      deviceClockAtReceipt: SYNC_INSTANT_MILLIS,
    });

    setOnLine(false);
    vi.stubGlobal(
      'fetch',
      routeFetch(() => ({ '/me/conferences': { status: 200, body: KICKOFF_LIST } })),
    );

    render(<AttendeeSchedulePanel />);

    expect(await screen.findByTestId('schedule-unavailable-offline')).not.toBeNull();
    await waitFor(() => expect(screen.queryByTestId('attendee-loading')).toBeNull());
    expect(screen.queryByTestId('attendee-session-list')).toBeNull();
  });
});

// ---------- the API being down is not the API saying no ----------

/**
 * The Reliability requirement is that "a schedule loaded at least once always renders" (FR8), and
 * the SPA container has a 502 page precisely because the API container can be down while the static
 * assets are served perfectly well. Every non-ok response arrives as an `ApiError`, so a naive
 * "an `ApiError` means the server answered" would strand an attendee on the failure screen with a
 * good cached Schedule unread on the device.
 */
describe('a gateway or server error with a cached schedule present', () => {
  it.each([
    [502, 'the API container is unreachable through the gateway'],
    [503, 'the database is not ready'],
    [500, 'something failed inside the API'],
  ])('falls back to the cache on %i', async (status) => {
    const receipt = SYNC_INSTANT_MILLIS;
    pinDeviceClock(receipt + 5 * 60_000);
    await cacheKickoff(receipt);

    vi.stubGlobal(
      'fetch',
      routeFetch(() => ({
        '/me/conferences': { status: 200, body: KICKOFF_LIST },
        [`/conferences/${KICKOFF}/schedule`]: { status, body: null },
      })),
    );

    render(<AttendeeSchedulePanel />);

    expect(await screen.findByTestId('schedule-cached-label')).not.toBeNull();
    expect(screen.getByTestId('attendee-session-keynote').textContent).toContain('09:00–10:30');
    expect(screen.queryByTestId('attendee-schedule-error')).toBeNull();
  });

  /**
   * A 4xx is a different thing entirely: the server decided. Showing a cached Schedule over a
   * refusal would show somebody a Conference they are no longer a member of.
   */
  it.each([
    [403, 'AUTH_DOMAIN_NOT_ALLOWED'],
    [404, 'CONFERENCE_NOT_FOUND'],
  ])('shows the refusal on %i even though a cache entry exists', async (status, code) => {
    const receipt = SYNC_INSTANT_MILLIS;
    pinDeviceClock(receipt + 5 * 60_000);
    await cacheKickoff(receipt);

    vi.stubGlobal(
      'fetch',
      routeFetch(() => ({
        '/me/conferences': { status: 200, body: KICKOFF_LIST },
        [`/conferences/${KICKOFF}/schedule`]: {
          status,
          body: { error: { code, message: 'You are no longer a member of this conference.' } },
        },
      })),
    );

    render(<AttendeeSchedulePanel />);

    const error = await screen.findByTestId('attendee-schedule-error');
    expect(error.textContent).toContain('no longer a member');
    expect(screen.queryByTestId('schedule-cached-label')).toBeNull();
    expect(screen.queryByTestId('attendee-session-list')).toBeNull();
  });

  /**
   * With nothing cached, a server that answered still has the more useful thing to say. "Not
   * available offline" is for a request that never got through – telling somebody to find a
   * connection when they have one and the API is restarting would send them looking for the wrong
   * problem.
   */
  it('shows the server’s own sentence on a 503 when there is no cache to fall back to', async () => {
    pinDeviceClock(SYNC_INSTANT_MILLIS);

    vi.stubGlobal(
      'fetch',
      routeFetch(() => ({
        '/me/conferences': { status: 200, body: KICKOFF_LIST },
        [`/conferences/${KICKOFF}/schedule`]: {
          status: 503,
          body: {
            error: { code: 'DATABASE_UNAVAILABLE', message: 'The database is not ready yet.' },
          },
        },
      })),
    );

    render(<AttendeeSchedulePanel />);

    const error = await screen.findByTestId('attendee-schedule-error');
    expect(error.textContent).toContain('The database is not ready yet.');
    expect(error.textContent).toContain('DATABASE_UNAVAILABLE');
    expect(screen.queryByTestId('schedule-unavailable-offline')).toBeNull();
    // And a way back, rather than a dead end.
    expect(within(error).getByTestId('attendee-retry')).not.toBeNull();
  });
});

// ---------- a refusal on reconnect is still an answer ----------

/**
 * S09's poll swallowed every failure because it only ever polled a live view. S10 points the same
 * loop at a *cached* one, and there the rule the initial load already follows has to apply: a cache
 * must not overrule an answer. Otherwise an attendee removed from a Conference keeps reading its
 * Schedule from storage for as long as the view stays open, told they are offline while the server
 * is in fact refusing them.
 */
describe('reconnecting to a server that refuses the conference', () => {
  it('replaces the cached schedule with the refusal and forgets the entry', async () => {
    const receipt = SYNC_INSTANT_MILLIS;
    pinDeviceClock(receipt + 40 * 60_000);
    await cacheKickoff(receipt);

    let table: Record<string, Answer> = NOTHING_REACHABLE;
    vi.stubGlobal(
      'fetch',
      routeFetch(() => table),
    );

    setOnLine(false);
    render(<AttendeeSchedulePanel />);
    await screen.findByTestId('schedule-cached-label');

    // The connection returns, and the server says she is no longer a member.
    table = {
      '/me/conferences': { status: 200, body: KICKOFF_LIST },
      [`/conferences/${KICKOFF}/schedule/watermark`]: {
        status: 200,
        body: { lastUpdatedAt: SECOND_WATERMARK, state: 'published' },
      },
      [`/conferences/${KICKOFF}/schedule`]: {
        status: 403,
        body: {
          error: {
            code: 'CONFERENCE_NOT_READABLE',
            message: 'You are no longer a member of this conference.',
          },
        },
      },
    };
    reconnect();

    const error = await screen.findByTestId('attendee-schedule-error');
    expect(error.textContent).toContain('no longer a member');
    // Not still claiming to be offline over a schedule she may not read.
    expect(screen.queryByTestId('schedule-cached-label')).toBeNull();
    expect(screen.queryByTestId('attendee-session-list')).toBeNull();

    // And the copy goes with the membership, for the same reason leaving takes it.
    await waitFor(async () => expect(await readCachedSchedule(NADIA, KICKOFF)).toBeNull());
  });

  /** A request that never got through still changes nothing – that is S09's rule, and it stands. */
  it('leaves the cached schedule exactly as it was when the request simply fails', async () => {
    const receipt = SYNC_INSTANT_MILLIS;
    pinDeviceClock(receipt + 40 * 60_000);
    await cacheKickoff(receipt);

    setOnLine(false);
    vi.stubGlobal(
      'fetch',
      routeFetch(() => NOTHING_REACHABLE),
    );

    render(<AttendeeSchedulePanel />);
    await screen.findByTestId('schedule-cached-label');

    reconnect();

    await waitFor(() => expect(screen.getByTestId('attendee-session-list')).not.toBeNull());
    expect(screen.getByTestId('schedule-cached-label')).not.toBeNull();
    expect(screen.queryByTestId('attendee-schedule-error')).toBeNull();
    expect(await readCachedSchedule(NADIA, KICKOFF)).not.toBeNull();
  });
});

// ---------- leaving takes the cached copy with it ----------

describe('leaving a conference', () => {
  it('forgets its cached schedule, so it is not readable offline afterwards', async () => {
    const receipt = SYNC_INSTANT_MILLIS;
    pinDeviceClock(receipt + 60_000);
    await cacheKickoff(receipt);

    vi.stubGlobal(
      'fetch',
      routeFetch(() => ({
        '/me/conferences': { status: 200, body: KICKOFF_LIST },
        [`/conferences/${KICKOFF}/schedule/watermark`]: {
          status: 200,
          body: { lastUpdatedAt: FIRST_WATERMARK, state: 'published' },
        },
        [`/conferences/${KICKOFF}/schedule`]: {
          status: 200,
          body: envelope([KEYNOTE, DESIGN, RETRO]),
        },
        [`/conferences/${KICKOFF}/membership`]: { status: 200, body: { conferenceId: KICKOFF } },
      })),
    );

    render(<AttendeeSchedulePanel />);
    await screen.findByTestId('attendee-session-list');
    expect(await readCachedSchedule(NADIA, KICKOFF)).not.toBeNull();

    // The two deliberate acts the leave control asks for.
    fireEvent.click(screen.getByTestId('leave-conference'));
    fireEvent.click(await screen.findByTestId('leave-confirm-yes'));

    /*
     * "Its schedule will stop being available to you" is what the confirmation promises. An entry
     * left in storage would make that true online and false offline – and would put the conference
     * back in the offline picker on the next launch with no connection.
     */
    await waitFor(async () => expect(await readCachedSchedule(NADIA, KICKOFF)).toBeNull());
  });
});

// ---------- Acceptance Scenarios S04 and S05: what changed while she was away ----------

describe('reconnecting after sessions were added, moved and deleted while offline', () => {
  it('refreshes without being asked and names all three changes, the deletion included', async () => {
    const receipt = SYNC_INSTANT_MILLIS;
    pinDeviceClock(receipt + 40 * 60_000);
    await cacheKickoff(receipt);

    let table: Record<string, Answer> = NOTHING_REACHABLE;
    vi.stubGlobal(
      'fetch',
      routeFetch(() => table),
    );

    setOnLine(false);
    render(<AttendeeSchedulePanel />);
    await screen.findByTestId('schedule-cached-label');

    /*
     * While she was offline an Admin added "Lightning Talks", moved "Design Workshop" and deleted
     * "Retrospective". The Conference watermark advances on all three – including the delete, which
     * is why the cursor is the Conference's and not the newest Session's.
     */
    const moved = envelope(
      [
        KEYNOTE,
        session({
          id: 'lightning',
          title: 'Lightning Talks',
          startTime: '11:00',
          endTime: '11:30',
          location: 'Main Hall',
        }),
        session({ ...DESIGN, startTime: '14:30', endTime: '15:30' }),
      ],
      SECOND_WATERMARK,
    );
    table = {
      '/me/conferences': { status: 200, body: KICKOFF_LIST },
      [`/conferences/${KICKOFF}/schedule/watermark`]: {
        status: 200,
        body: { lastUpdatedAt: SECOND_WATERMARK, state: 'published' },
      },
      [`/conferences/${KICKOFF}/schedule`]: { status: 200, body: moved },
    };

    // The connection returns. Nothing here reloads, navigates or presses anything.
    reconnect();

    const summary = await screen.findByTestId('reconnect-summary');
    const text = summary.textContent ?? '';

    expect(text).toContain('Lightning Talks was added');
    // Both sides of the move, so she can recognise the slot she had written down.
    expect(text).toContain('Design Workshop');
    expect(text).toContain('14:30–15:30');
    expect(text).toContain('13:00–14:00');
    // The deletion stated as explicitly as the addition, never merely implied by absence.
    expect(text).toContain('Retrospective was removed');

    // The schedule itself refreshed, and the cached label is gone with it.
    await waitFor(() => expect(screen.queryByTestId('schedule-cached-label')).toBeNull());
    expect(screen.queryByTestId('attendee-session-retro')).toBeNull();
    expect(screen.getByTestId('attendee-session-lightning')).not.toBeNull();
  });

  /*
   * The list is projected from the cache while offline, and until the reconnect re-drove it nothing
   * ever handed it back: the schedule went live while the picker, the header name and the archived
   * badge stayed frozen at whatever the cache held. A Conference joined but never cached could not
   * be reached at all, and on a Capacitor shell there is no address bar to reload from.
   */
  it('hands the conference list back to the server, not just the schedule', async () => {
    const receipt = SYNC_INSTANT_MILLIS;
    pinDeviceClock(receipt + 40 * 60_000);
    await cacheKickoff(receipt);

    let table: Record<string, Answer> = NOTHING_REACHABLE;
    vi.stubGlobal(
      'fetch',
      routeFetch(() => table),
    );

    setOnLine(false);
    render(<AttendeeSchedulePanel />);
    await screen.findByTestId('schedule-cached-label');

    // Offline the picker can only know what was cached: one conference, under its cached name.
    expect(screen.queryByText('Retro Day')).toBeNull();
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Kickoff 2026');

    /*
     * The server holds two, and Kickoff has been renamed since. Nothing about the schedule payload
     * changes – the watermark stands still – so only the list re-drive can account for the update.
     */
    table = {
      '/me/conferences': {
        status: 200,
        body: {
          conferences: [
            {
              id: KICKOFF,
              name: 'Kickoff 2026 (rescheduled)',
              startDate: '2026-09-15',
              endDate: '2026-09-16',
              state: 'published',
            },
            {
              id: RETRO_DAY,
              name: 'Retro Day',
              startDate: '2026-09-17',
              endDate: '2026-09-17',
              state: 'published',
            },
          ],
          defaultConferenceId: KICKOFF,
        },
      },
      [`/conferences/${KICKOFF}/schedule/watermark`]: {
        status: 200,
        body: { lastUpdatedAt: FIRST_WATERMARK, state: 'published' },
      },
      [`/conferences/${KICKOFF}/schedule`]: {
        status: 200,
        body: envelope([KEYNOTE, DESIGN, RETRO]),
      },
    };

    reconnect();

    // The conference she never cached is now reachable, and the renamed one reads correctly.
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(
        'Kickoff 2026 (rescheduled)',
      ),
    );
    expect(screen.getByText('Retro Day')).not.toBeNull();
  });

  /*
   * The list re-drive must not move the selection. An attendee who picked a conference offline is
   * reading it; re-selecting the server's default underneath her would swap the schedule out at the
   * moment the connection returned, which is precisely when she is looking at the screen.
   */
  it('leaves the conference she was reading offline selected when the list comes back', async () => {
    const receipt = SYNC_INSTANT_MILLIS;
    pinDeviceClock(receipt + 40 * 60_000);
    // Only "Retro Day" is cached, so that is what the offline projection selects and renders.
    await writeCachedSchedule(NADIA, RETRO_DAY, {
      envelope: envelope([KEYNOTE], FIRST_WATERMARK, { id: RETRO_DAY, name: 'Retro Day' }),
      watermark: FIRST_WATERMARK,
      deviceClockAtReceipt: receipt,
    });

    let table: Record<string, Answer> = NOTHING_REACHABLE;
    vi.stubGlobal(
      'fetch',
      routeFetch(() => table),
    );

    setOnLine(false);
    render(<AttendeeSchedulePanel />);
    await screen.findByTestId('schedule-cached-label');
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Retro Day');

    // The server's default is Kickoff, not what she is reading. She is still a member of both.
    table = {
      '/me/conferences': {
        status: 200,
        body: {
          conferences: [
            ...KICKOFF_LIST.conferences,
            {
              id: RETRO_DAY,
              name: 'Retro Day',
              startDate: '2026-09-17',
              endDate: '2026-09-17',
              state: 'published',
            },
          ],
          defaultConferenceId: KICKOFF,
        },
      },
      [`/conferences/${RETRO_DAY}/schedule/watermark`]: {
        status: 200,
        body: { lastUpdatedAt: FIRST_WATERMARK, state: 'published' },
      },
      [`/conferences/${RETRO_DAY}/schedule`]: {
        status: 200,
        body: envelope([KEYNOTE], FIRST_WATERMARK, { id: RETRO_DAY, name: 'Retro Day' }),
      },
    };

    reconnect();

    // Wait for the list re-drive itself to land, so this cannot pass by asserting too early: the
    // server list is the only source that could add Kickoff beside the one cached entry shown.
    await waitFor(() =>
      expect(
        within(screen.getByTestId('attendee-conference-picker')).getByText('Kickoff 2026'),
      ).not.toBeNull(),
    );
    await waitFor(() => expect(screen.queryByTestId('schedule-cached-label')).toBeNull());

    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Retro Day');
  });

  /*
   * Venue wifi comes back unevenly, so the schedule request can succeed while the list request does
   * not. The list re-drive then falls to the cached projection, and picking its first entry would
   * switch conference under her *and* re-run the schedule effect, clearing the summary she has not
   * read yet – so this pins both halves: the conference stays put and the summary survives.
   */
  it('keeps the open conference and the summary when only the list request is still failing', async () => {
    const receipt = SYNC_INSTANT_MILLIS;
    pinDeviceClock(receipt + 40 * 60_000);
    // Two cached entries, and "Kickoff 2026" sorts before "Retro Day" – so cached[0] is not the
    // open one, which is what makes the unguarded branch observable.
    await cacheKickoff(receipt);
    await writeCachedSchedule(NADIA, RETRO_DAY, {
      envelope: envelope([KEYNOTE], FIRST_WATERMARK, { id: RETRO_DAY, name: 'Retro Day' }),
      watermark: FIRST_WATERMARK,
      deviceClockAtReceipt: receipt,
    });

    let table: Record<string, Answer> = NOTHING_REACHABLE;
    vi.stubGlobal(
      'fetch',
      routeFetch(() => table),
    );

    setOnLine(false);
    render(<AttendeeSchedulePanel />);
    await screen.findByTestId('schedule-cached-label');

    const picker = screen.getByTestId('attendee-conference-picker') as HTMLSelectElement;
    fireEvent.change(picker, { target: { value: RETRO_DAY } });
    /*
     * All three conditions together, because each alone is satisfied too early and the reconnect
     * would then be dispatched into a window with no listener on it. Switching conference passes
     * through `loading`, where the heading already reads "Retro Day" (it follows `conferenceId`
     * synchronously) and Design Workshop has already gone (the list is empty) – but the poll effect
     * has torn its `online` listener down and not yet re-registered. Only the settled cached phase
     * has the label back, the keynote present and Design Workshop absent at once.
     */
    await waitFor(() => {
      expect(screen.queryByTestId('schedule-cached-label')).not.toBeNull();
      expect(screen.queryByTestId('attendee-session-keynote')).not.toBeNull();
      expect(screen.queryByTestId('attendee-session-design')).toBeNull();
    });
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Retro Day');

    /*
     * Retro Day's schedule is reachable again and a session was added while she was away, but
     * `/me/conferences` is deliberately left unrouted – still offline.
     */
    table = {
      [`/conferences/${RETRO_DAY}/schedule/watermark`]: {
        status: 200,
        body: { lastUpdatedAt: SECOND_WATERMARK, state: 'published' },
      },
      [`/conferences/${RETRO_DAY}/schedule`]: {
        status: 200,
        body: envelope([KEYNOTE, DESIGN], SECOND_WATERMARK, {
          id: RETRO_DAY,
          name: 'Retro Day',
        }),
      },
    };

    reconnect();

    const summary = await screen.findByTestId('reconnect-summary');
    expect(summary.textContent ?? '').toContain('Design Workshop');

    /*
     * The summary appearing is not the end of the sequence: the list re-drive is dispatched right
     * after it and takes a failed request plus an IndexedDB read to resolve, so asserting here and
     * now would pass even if the selection were about to move. Settling first is what makes this
     * test fail when the guard in the offline branch of `loadConferences` is removed.
     */
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Retro Day');
    expect(screen.queryByTestId('reconnect-summary')).not.toBeNull();
    expect((screen.getByTestId('attendee-conference-picker') as HTMLSelectElement).value).toBe(
      RETRO_DAY,
    );
  });

  it('refreshes silently and shows no summary when the watermark has not moved', async () => {
    const receipt = SYNC_INSTANT_MILLIS;
    const now = receipt + 40 * 60_000;
    pinDeviceClock(now);
    await cacheKickoff(receipt);

    let table: Record<string, Answer> = NOTHING_REACHABLE;
    vi.stubGlobal(
      'fetch',
      routeFetch(() => table),
    );

    setOnLine(false);
    render(<AttendeeSchedulePanel />);
    await screen.findByTestId('schedule-cached-label');

    table = {
      '/me/conferences': { status: 200, body: KICKOFF_LIST },
      [`/conferences/${KICKOFF}/schedule/watermark`]: {
        status: 200,
        body: { lastUpdatedAt: FIRST_WATERMARK, state: 'published' },
      },
      [`/conferences/${KICKOFF}/schedule`]: {
        status: 200,
        body: envelope([KEYNOTE, DESIGN, RETRO]),
      },
    };
    reconnect();

    // The cached label is replaced by the live state ...
    await waitFor(() => expect(screen.queryByTestId('schedule-cached-label')).toBeNull());
    expect(screen.getByTestId('schedule-staleness')).not.toBeNull();
    // ... and an empty summary is never displayed as a change.
    expect(screen.queryByTestId('reconnect-summary')).toBeNull();
    expect(screen.queryByTestId('schedule-change-banner')).toBeNull();

    /*
     * The refresh re-anchored the entry even though nothing moved: staleness and the clock offset
     * are both measured from the receipt reading, and leaving a three-day-old one in place would
     * label a schedule fetched seconds ago as three days old (TI06).
     */
    await waitFor(async () =>
      expect((await readCachedSchedule(NADIA, KICKOFF))!.deviceClockAtReceipt).toBe(now),
    );
    expect((await readCachedSchedule(NADIA, KICKOFF))!.envelope.serverNow).toEqual(SERVER_NOW);
  });

  /**
   * The gate is the **Conference watermark**, not merely "the diff came out non-empty".
   *
   * Stated separately because the two are indistinguishable on the happy path: when nothing moved,
   * the watermark is unchanged *and* the diff is empty. Here they disagree – the sessions differ
   * while the watermark stands still, which is a server that failed to advance it – and the
   * specified behaviour is to say nothing rather than to announce a change the schedule does not
   * claim to have made (TI07).
   */
  it('shows no summary when the watermark stands still, however the sessions differ', async () => {
    const receipt = SYNC_INSTANT_MILLIS;
    pinDeviceClock(receipt + 40 * 60_000);
    await cacheKickoff(receipt);

    let table: Record<string, Answer> = NOTHING_REACHABLE;
    vi.stubGlobal(
      'fetch',
      routeFetch(() => table),
    );

    setOnLine(false);
    render(<AttendeeSchedulePanel />);
    await screen.findByTestId('schedule-cached-label');

    table = {
      '/me/conferences': { status: 200, body: KICKOFF_LIST },
      [`/conferences/${KICKOFF}/schedule/watermark`]: {
        status: 200,
        body: { lastUpdatedAt: FIRST_WATERMARK, state: 'published' },
      },
      // "Retrospective" is gone from the payload, but the watermark did not move.
      [`/conferences/${KICKOFF}/schedule`]: { status: 200, body: envelope([KEYNOTE, DESIGN]) },
    };
    reconnect();

    await waitFor(() => expect(screen.queryByTestId('schedule-cached-label')).toBeNull());
    expect(screen.queryByTestId('attendee-session-retro')).toBeNull();
    // The diff was not empty, and still nothing was announced.
    expect(screen.queryByTestId('reconnect-summary')).toBeNull();
  });
});

// ---------- Acceptance Scenario S07: nothing to change, and nothing queued ----------

/*
 * The storage guard is only half of it: `usable` refuses such an entry on the way out of the cache,
 * but the identical envelope can arrive live from the network, and there the blank panel OC03
 * forbids was still reachable.
 */
describe('a schedule that arrives with no days at all', () => {
  it('reaches a terminating state rather than rendering an empty panel', async () => {
    pinDeviceClock(SYNC_INSTANT_MILLIS);

    const empty = envelope([]);
    empty.days = [];

    vi.stubGlobal(
      'fetch',
      routeFetch(() => ({
        '/me/conferences': { status: 200, body: KICKOFF_LIST },
        [`/conferences/${KICKOFF}/schedule`]: { status: 200, body: empty },
      })),
    );

    render(<AttendeeSchedulePanel />);

    // Something terminal and legible, not a heading over nothing and not an endless spinner.
    const notice = await screen.findByTestId('attendee-schedule-empty');
    expect((notice.textContent ?? '').trim()).not.toBe('');
    expect(screen.queryByTestId('attendee-loading')).toBeNull();
  });
});

describe('the offline schedule', () => {
  it('offers no way to leave the conference and queues nothing for later', async () => {
    const receipt = SYNC_INSTANT_MILLIS;
    pinDeviceClock(receipt + 60_000);
    await cacheKickoff(receipt);

    setOnLine(false);
    const fetchMock = routeFetch(() => NOTHING_REACHABLE);
    vi.stubGlobal('fetch', fetchMock);

    render(<AttendeeSchedulePanel />);
    await screen.findByTestId('schedule-cached-label');

    const leave = screen.getByTestId('leave-conference') as HTMLButtonElement;
    expect(leave.disabled).toBe(true);
    expect(screen.getByTestId('leave-offline').textContent).toMatch(
      /nothing is saved to send later/i,
    );

    // The attendee view has no editing affordance at all – there is nothing here to disable.
    expect(screen.queryByTestId('session-form')).toBeNull();

    /*
     * And on reconnect nothing is submitted that was initiated offline: every request the panel
     * makes is a GET. A mutating one would mean something had been held back to send.
     */
    reconnect();
    await waitFor(() => {
      const calls = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      expect(calls.length).toBeGreaterThan(0);
    });
    const calls = (fetchMock as unknown as { mock: { calls: [unknown, RequestInit?][] } }).mock
      .calls;
    for (const [, init] of calls) {
      expect(init?.method ?? 'GET').toBe('GET');
    }
  });
});

// ---------- Acceptance Scenario S08: the highlight survives a force-quit ----------

describe('after a force-quit and an offline relaunch', () => {
  /**
   * The device clock read three hours fast at the moment of the sync, and twenty minutes have
   * passed on it since. Nothing S06 held in memory survives – the entry is written straight to
   * storage and the panel is mounted fresh, so the only possible source of a clock is the anchor.
   */
  const RECEIPT = SYNC_INSTANT_MILLIS + 3 * HOUR;

  it('still highlights the running session, from the persisted anchor and not the device clock', async () => {
    pinDeviceClock(RECEIPT + 20 * 60_000);

    await writeCachedSchedule(NADIA, KICKOFF, {
      envelope: envelope([KEYNOTE, DESIGN, RETRO]),
      watermark: FIRST_WATERMARK,
      deviceClockAtReceipt: RECEIPT,
    });

    setOnLine(false);
    vi.stubGlobal(
      'fetch',
      routeFetch(() => NOTHING_REACHABLE),
    );
    render(<AttendeeSchedulePanel />);

    await screen.findByTestId('attendee-session-list');

    /*
     * The effective wall clock is 09:40 + 20 minutes = 10:00, so the keynote (09:00–10:30) is
     * running. Read from the device's own clock it would be 12:40, which is inside nothing.
     */
    expect(screen.getByTestId('running-keynote')).not.toBeNull();
    expect(screen.getByTestId('attendee-session-keynote').dataset.running).toBe('true');
    expect(screen.getByTestId('attendee-session-design').dataset.running).toBe('false');

    // Every displayed time is still exactly the authored string: the rehydrated clock feeds the
    // highlight and never a formatter.
    expect(screen.getByTestId('attendee-session-keynote').textContent).toContain('09:00–10:30');
    expect(screen.getByTestId('attendee-schedule').textContent).not.toContain('12:40');
    expect(screen.getByTestId('attendee-schedule').textContent).not.toContain('12:00–13:30');
  });

  it('reads the raw device clock as "now" nowhere on the offline path', () => {
    /*
     * The behavioural test above proves the anchor is used *when it is right*. This proves there is
     * no branch where it is not: a fallback to `Date.now()` as the wall clock, or a render with the
     * clock input defaulted, would satisfy that test on the happy path and mis-highlight everywhere
     * else. `Date.now()` itself is permitted and appears twice – as the elapsed-age term and as the
     * receipt reading – neither of which is a wall clock.
     */
    const panel = readFileSync(join(webSrc, 'attendee', 'AttendeeSchedulePanel.tsx'), 'utf8');
    const code = panel.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // The only two producers of a wall clock, both of them the clock module's.
    expect(code).toMatch(/rehydrateClock\(anchorOf\(cached\)\)/);
    expect(code).toMatch(/effectiveWallClockNow\(\)/);
    // No `now` is ever synthesised from the device clock, and none is defaulted to a wall clock:
    // the only fallback is `null`, and the schedule is not rendered at all while it holds.
    expect(code).not.toMatch(/now\s*[=:]\s*Date\.now\(\)/);
    expect(code).not.toMatch(/effectiveWallClockNow\(\)\s*\?\?(?!\s*null)/);
    expect(code).toMatch(/rendering !== null && now !== null/);
    expect(code).not.toMatch(/new Date\(|Date\.parse/);
  });
});

// ---------- the structural half ----------

describe('the offline layer', () => {
  const sources = [
    'offline/schedule-cache.ts',
    'offline/schedule-data.ts',
    'offline/cached-age.ts',
    'offline/ReconnectSummary.tsx',
    'offline/use-online.ts',
    'attendee/AttendeeSchedulePanel.tsx',
    'attendee/schedule-change-lines.ts',
  ].map((relative) => ({
    relative,
    code: readFileSync(join(webSrc, relative), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, ''),
  }));

  /**
   * Exactly one envelope diff exists, and it is S09's. A second comparison would eventually
   * disagree with the first, and the two surfaces would tell the same person different stories
   * about their morning.
   */
  it('contains no second added/edited/deleted comparison', () => {
    const all = readFileSync(join(webSrc, 'attendee', 'schedule-diff.ts'), 'utf8');
    expect(all).toContain('export function diffSchedule');

    for (const { relative, code } of sources) {
      // No module here derives a diff; the summary and the banner present one.
      expect(/function\s+\w*[Dd]iff\w*\s*\(/.test(code), relative).toBe(false);
      expect(/added\s*:\s*\[|removed\s*:\s*\[/.test(code), relative).toBe(false);
    }

    // And the summary genuinely receives S09's result rather than building its own.
    const summary = sources.find((entry) => entry.relative.endsWith('ReconnectSummary.tsx'))!;
    expect(summary.code).toMatch(/from '\.\.\/attendee\/schedule-diff\.ts'/);
    const panel = sources.find((entry) => entry.relative.endsWith('AttendeeSchedulePanel.tsx'))!;
    expect(panel.code).toMatch(/diffSchedule\(rendered\.schedule, refreshed\)/);
  });

  /** No write path, no deferred submission, no conflict resolution – an explicit anti-goal. */
  it('introduces no outbox, sync queue, replay buffer or conflict resolution', () => {
    for (const { relative, code } of sources) {
      expect(
        /outbox|replay|pendingWrite|pending[_-]?mutation|syncQueue|conflictResolution/i.test(code),
        relative,
      ).toBe(false);
    }
  });

  /** Cached times are strings from end to end. A `Date` anywhere here moves a 09:00 session. */
  it('constructs no Date and converts no timezone anywhere on the cache path', () => {
    for (const { relative, code } of sources) {
      expect(/new Date\(|Date\.parse|JSON\.parse\([^)]*,/.test(code), relative).toBe(false);
      expect(
        /toLocaleTimeString|toLocaleDateString|Intl\.DateTimeFormat/.test(code),
        relative,
      ).toBe(false);
    }
  });

  /** The web build has to work: S11 has not run, so no Capacitor plugin may be reached for. */
  it('depends on no Capacitor package', () => {
    for (const { relative, code } of sources) {
      expect(/@capacitor/.test(code), relative).toBe(false);
    }
  });

  /**
   * The reconnect refresh is an ordinary authenticated request. It goes through the same API client
   * every other read does – which attaches the bearer token and is subject to server-side `hd`
   * verification – rather than a cache-only or unauthenticated bypass.
   */
  it('adds no unauthenticated or cache-only endpoint', () => {
    const data = sources.find((entry) => entry.relative.endsWith('schedule-data.ts'))!;
    expect(data.code).toMatch(/fetchAttendeeSchedule/);
    expect(data.code).not.toMatch(/authenticated:\s*false/);
    expect(data.code).not.toMatch(/\bfetch\(/);
  });
});

// ---------- the wall-clock contract across the cache's serialization boundary ----------

/**
 * TI04 and TI07 under a non-UTC process timezone, as the FIS Testing Strategy requires.
 *
 * Run in **fresh processes**, because `TZ` is read once when Node starts: setting `process.env.TZ`
 * inside a running test changes nothing that matters and would let a leak pass unnoticed. S04, S06
 * and S09 all do the same thing, and this story adds the reason to do it again – IndexedDB's
 * structured clone is a new serialization boundary for the naive wall-clock strings, and a coercion
 * introduced there is invisible on a UTC runner.
 *
 * The source greps elsewhere in this file prove the cache path *contains* no conversion. They
 * cannot prove the values that come back out are timezone-invariant; this can.
 */
describe('a schedule written to and read back from the cache', () => {
  async function probe(timezone: string): Promise<{
    timezone: string;
    offsetMinutes: number;
    date: string;
    sessions: { id: string; startTime: string; endTime: string; range: string }[];
    now: { day: string; time: string };
    running: string[];
  }> {
    const { stdout } = await run(process.execPath, [join(here, 'schedule-cache-probe.ts')], {
      cwd: join(here, '..', '..'),
      env: { ...process.env, TZ: timezone },
    });
    return JSON.parse(stdout);
  }

  it('reads identically at UTC-7 and UTC+9, strings and highlight alike', async () => {
    const [west, east] = await Promise.all([probe('America/Los_Angeles'), probe('Asia/Tokyo')]);

    // The processes really did run under two different offsets - otherwise this asserts nothing.
    expect(west.offsetMinutes).not.toBe(east.offsetMinutes);

    expect(JSON.stringify(west.sessions)).toBe(JSON.stringify(east.sessions));
    expect(west.date).toBe(east.date);
    expect(west.now).toEqual(east.now);
    expect(west.running).toEqual(east.running);
  });

  it('returns the authored values themselves, not merely values that agree', async () => {
    const west = await probe('America/Los_Angeles');

    // Byte-identical to what was written, including the session just after midnight that a
    // westward offset would have rolled back into the previous day.
    expect(west.date).toBe('2026-09-15');
    expect(west.sessions.map((session) => session.range)).toEqual(['09:00–10:30', '00:15–01:00']);

    // The rehydrated clock still reads the server's wall clock advanced by real elapsed time,
    // rather than the device's own three-hours-fast reading.
    expect(west.now).toEqual({ day: '2026-09-15', time: '10:00' });
    expect(west.running).toEqual(['keynote']);
  });
});
