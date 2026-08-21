import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { AttendeeSchedulePanel } from '../src/attendee/AttendeeSchedulePanel.tsx';
import type { AttendeeSchedule, AttendeeSession } from '../src/api/client.ts';

/**
 * S09 TI02 and TI03 – the near-live refresh, the change banner and the staleness age.
 *
 * Every propagation assertion here is made on an **already-rendered** view, with no reload, no
 * navigation and no manual refresh call in the test body (FIS → Testing Strategy). A test that
 * re-rendered or refetched explicitly would prove nothing about this story: what is under test is
 * that the schedule changes under an attendee who touched nothing.
 *
 * The API is driven at the `fetch` boundary so the real client module is exercised, and the clock
 * is a real fake timer rather than a stubbed formatter.
 */

const here = dirname(fileURLToPath(import.meta.url));
const webSrc = join(here, '..', 'src');

const KICKOFF = '11111111-1111-4111-8111-111111111111';

const SERVER_NOW = {
  instant: '2026-09-15T07:40:12.345678Z',
  day: '2026-09-15',
  time: '09:40',
};
const SYNC_INSTANT_MILLIS = Date.UTC(2026, 8, 15, 7, 40, 12, 345);

/*
 * Twelve seconds before the server's reading of now, so a freshly opened schedule reads "just now"
 * rather than "40 minutes ago" - the age is measured from the watermark, not from the render.
 */
const FIRST_WATERMARK = '2026-09-15T07:40:00.123456Z';
const SECOND_WATERMARK = '2026-09-15T07:41:00.654321Z';

const ONE_CONFERENCE = {
  conferences: [
    {
      id: KICKOFF,
      name: 'Autumn Offsite',
      startDate: '2026-09-15',
      endDate: '2026-09-16',
      state: 'published',
    },
  ],
  defaultConferenceId: KICKOFF,
};

function session(overrides: Partial<AttendeeSession> & { id: string }): AttendeeSession {
  return {
    title: 'Opening Keynote',
    description: null,
    kind: 'Presentation',
    startTime: '09:00',
    endTime: '10:30',
    location: 'Room A',
    concurrentWith: [],
    ...overrides,
  };
}

const KEYNOTE = session({ id: 'keynote' });
const RETRO = session({
  id: 'retro',
  title: 'Retrospective',
  startTime: '15:00',
  endTime: '16:00',
});

function schedule(
  sessions: AttendeeSession[],
  lastUpdatedAt: string | null = FIRST_WATERMARK,
): AttendeeSchedule {
  return {
    conference: {
      id: KICKOFF,
      name: 'Autumn Offsite',
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

interface Route {
  status: number;
  body: unknown;
  /** When present, the response waits on this before resolving. */
  hold?: Promise<void>;
}

function routeFetch(routes: Record<string, Route | (() => Route)>): typeof fetch {
  return vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);

    /*
     * The signal is honoured, not discarded. A mock that ignored it could not tell a component that
     * aborts its in-flight requests from one that does not - which is exactly the guard under test.
     */
    if (init?.signal?.aborted === true) throw new DOMException('Aborted', 'AbortError');
    // Longest match first, so '/schedule/watermark' is not captured by '/schedule'.
    const match = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((path) => url.endsWith(path));
    if (match === undefined) throw new Error(`unrouted request: ${url}`);

    const entry = routes[match]!;
    const route = typeof entry === 'function' ? entry() : entry;
    if (route.status >= 400 && route.body === undefined) throw new Error('network down');

    // A route may hold its response open, so a test can keep a request in flight across an action
    // and release it afterwards.
    if (route.hold !== undefined) {
      await new Promise<void>((resolve, reject) => {
        route.hold!.then(resolve, reject);
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      });
    }

    return {
      ok: route.status < 400,
      status: route.status,
      json: async () => route.body,
    } as Response;
  }) as unknown as typeof fetch;
}

function watermark(value: string | null, state = 'published'): Route {
  return { status: 200, body: { lastUpdatedAt: value, state } };
}

beforeEach(() => {
  window.__CONFAPP_CONFIG__ = { apiBaseUrl: '/api', googleClientId: 'x', googleRedirectUri: 'x' };
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.setSystemTime(new Date(SYNC_INSTANT_MILLIS));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Renders and waits for the first schedule to be on screen. */
async function openSchedule(): Promise<void> {
  render(<AttendeeSchedulePanel />);
  await vi.waitFor(() => expect(screen.queryByTestId('attendee-session-list')).not.toBeNull());
}

/** One poll cycle, with nothing touched by the person holding the phone. */
async function waitOnePoll(): Promise<void> {
  await vi.advanceTimersByTimeAsync(5_000);
}

// ---------- Acceptance Scenario S01: a room change reaches an open schedule ----------

describe('a session edited server-side while the schedule is open', () => {
  it('appears within the near-live window with no reload and no navigation', async () => {
    let current = FIRST_WATERMARK;
    let body = schedule([KEYNOTE, RETRO]);

    vi.stubGlobal(
      'fetch',
      routeFetch({
        '/me/conferences': { status: 200, body: ONE_CONFERENCE },
        [`/conferences/${KICKOFF}/schedule/watermark`]: () => watermark(current),
        [`/conferences/${KICKOFF}/schedule`]: () => ({ status: 200, body }),
      }),
    );

    await openSchedule();
    expect(screen.getByTestId('attendee-session-keynote').textContent).toContain('09:00–10:30');
    expect(screen.getByTestId('attendee-session-keynote').textContent).toContain('Room A');

    // An Admin moves the keynote. Björn touches nothing.
    body = schedule(
      [session({ id: 'keynote', startTime: '09:30', endTime: '11:00', location: 'Room B' }), RETRO],
      SECOND_WATERMARK,
    );
    current = SECOND_WATERMARK;

    await waitOnePoll();

    await vi.waitFor(() =>
      expect(screen.getByTestId('attendee-session-keynote').textContent).toContain('09:30–11:00'),
    );
    expect(screen.getByTestId('attendee-session-keynote').textContent).toContain('Room B');
    // The times read exactly as authored - no timezone shift on the way through the refresh.
    expect(screen.getByTestId('attendee-schedule').textContent).not.toContain('12:30');
  });

  it('refetches nothing while the watermark is unchanged', async () => {
    const fetchMock = routeFetch({
      '/me/conferences': { status: 200, body: ONE_CONFERENCE },
      [`/conferences/${KICKOFF}/schedule/watermark`]: watermark(FIRST_WATERMARK),
      [`/conferences/${KICKOFF}/schedule`]: { status: 200, body: schedule([KEYNOTE, RETRO]) },
    });
    vi.stubGlobal('fetch', fetchMock);

    await openSchedule();
    const calls = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const scheduleReads = (): number =>
      calls.filter((call) => String(call[0]).endsWith('/schedule')).length;
    expect(scheduleReads()).toBe(1);

    await waitOnePoll();
    await waitOnePoll();

    // Polled repeatedly, and the schedule payload was never asked for again.
    expect(calls.filter((call) => String(call[0]).endsWith('/watermark')).length).toBeGreaterThan(
      1,
    );
    expect(scheduleReads()).toBe(1);
  });
});

// ---------- Acceptance Scenario S02: an addition and a deletion ----------

describe('sessions added and deleted after publish', () => {
  it('both reach an open schedule, and a deletion alone is enough to trigger the refresh', async () => {
    let current = FIRST_WATERMARK;
    let body = schedule([KEYNOTE, RETRO]);

    vi.stubGlobal(
      'fetch',
      routeFetch({
        '/me/conferences': { status: 200, body: ONE_CONFERENCE },
        [`/conferences/${KICKOFF}/schedule/watermark`]: () => watermark(current),
        [`/conferences/${KICKOFF}/schedule`]: () => ({ status: 200, body }),
      }),
    );

    await openSchedule();
    expect(screen.queryByTestId('attendee-session-retro')).not.toBeNull();

    // "Retrospective" is deleted and nothing else is written - the watermark still moves, which is
    // the only reason a deletion is observable to a polling client at all.
    body = schedule(
      [
        KEYNOTE,
        session({
          id: 'lightning',
          title: 'Lightning Talks',
          startTime: '13:00',
          endTime: '14:00',
        }),
      ],
      SECOND_WATERMARK,
    );
    current = SECOND_WATERMARK;

    await waitOnePoll();

    await vi.waitFor(() => expect(screen.queryByTestId('attendee-session-retro')).toBeNull());
    expect(screen.queryByTestId('attendee-session-lightning')).not.toBeNull();

    // In start-time order: the keynote at 09:00 before the lightning talks at 13:00.
    const rendered = screen.getByTestId('attendee-session-list').textContent ?? '';
    expect(rendered.indexOf('Opening Keynote')).toBeLessThan(rendered.indexOf('Lightning Talks'));
  });
});

// ---------- pausing while nobody is looking ----------

describe('the poll loop', () => {
  function setHidden(hidden: boolean): void {
    Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }

  afterEach(() => setHidden(false));

  it('stops while the view is hidden and refreshes immediately when it is revealed', async () => {
    let current = FIRST_WATERMARK;
    let body = schedule([KEYNOTE, RETRO]);
    const fetchMock = routeFetch({
      '/me/conferences': { status: 200, body: ONE_CONFERENCE },
      [`/conferences/${KICKOFF}/schedule/watermark`]: () => watermark(current),
      [`/conferences/${KICKOFF}/schedule`]: () => ({ status: 200, body }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await openSchedule();
    const calls = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const polls = (): number =>
      calls.filter((call) => String(call[0]).endsWith('/watermark')).length;

    setHidden(true);
    const whileHidden = polls();
    await waitOnePoll();
    await waitOnePoll();

    // A phone in a pocket asks the server nothing.
    expect(polls()).toBe(whileHidden);

    // Meanwhile the schedule moved. Revealing the view must not wait for the next tick.
    body = schedule([session({ id: 'keynote', location: 'Room B' }), RETRO], SECOND_WATERMARK);
    current = SECOND_WATERMARK;

    setHidden(false);

    await vi.waitFor(() =>
      expect(screen.getByTestId('attendee-session-keynote').textContent).toContain('Room B'),
    );
  });
});

// ---------- Acceptance Scenario S07: a failed refresh ----------

describe('a refresh that fails', () => {
  it('leaves the last successful sync on screen, with its age still counting up', async () => {
    let failing = false;
    vi.stubGlobal(
      'fetch',
      routeFetch({
        '/me/conferences': { status: 200, body: ONE_CONFERENCE },
        [`/conferences/${KICKOFF}/schedule/watermark`]: () =>
          failing ? { status: 500, body: undefined } : watermark(FIRST_WATERMARK),
        [`/conferences/${KICKOFF}/schedule`]: { status: 200, body: schedule([KEYNOTE, RETRO]) },
      }),
    );

    await openSchedule();
    expect(screen.getByTestId('schedule-staleness').textContent).toBe('Updated just now');

    failing = true;
    // Four minutes of a dead venue wifi.
    for (let minute = 0; minute < 4; minute += 1) {
      vi.setSystemTime(new Date(SYNC_INSTANT_MILLIS + (minute + 1) * 60_000));
      await vi.advanceTimersByTimeAsync(60_000);
    }

    // The schedule is still there, unchanged, with no error and no empty state over it.
    expect(screen.queryByTestId('attendee-session-keynote')).not.toBeNull();
    expect(screen.queryByTestId('attendee-schedule-error')).toBeNull();
    expect(screen.queryByTestId('attendee-loading')).toBeNull();
    expect(screen.getByTestId('schedule-staleness').textContent).toBe('Updated 4 minutes ago');
  });

  it('picks the change up on the next successful attempt, with the age reset', async () => {
    let failing = true;
    let current = FIRST_WATERMARK;
    let body = schedule([KEYNOTE, RETRO]);

    vi.stubGlobal(
      'fetch',
      routeFetch({
        '/me/conferences': { status: 200, body: ONE_CONFERENCE },
        [`/conferences/${KICKOFF}/schedule/watermark`]: () =>
          failing ? { status: 500, body: undefined } : watermark(current),
        [`/conferences/${KICKOFF}/schedule`]: () => ({ status: 200, body }),
      }),
    );

    await openSchedule();

    // Two minutes of failing polls, with the clock advancing as the timers do.
    await vi.advanceTimersByTimeAsync(120_000);
    await vi.waitFor(() =>
      expect(screen.getByTestId('schedule-staleness').textContent).toBe('Updated 2 minutes ago'),
    );

    // Connectivity returns, and the change made in the meantime arrives with no manual reload.
    body = schedule([session({ id: 'keynote', location: 'Room B' }), RETRO], SECOND_WATERMARK);
    current = SECOND_WATERMARK;
    failing = false;

    await waitOnePoll();

    await vi.waitFor(() =>
      expect(screen.getByTestId('attendee-session-keynote').textContent).toContain('Room B'),
    );
    expect(screen.getByTestId('schedule-staleness').textContent).toBe('Updated just now');
  });
});

// ---------- Acceptance Scenario S08: told what changed, with no push ----------

describe('the in-app change banner', () => {
  async function withChange(): Promise<void> {
    let current = FIRST_WATERMARK;
    let body = schedule([KEYNOTE, RETRO]);

    vi.stubGlobal(
      'fetch',
      routeFetch({
        '/me/conferences': { status: 200, body: ONE_CONFERENCE },
        [`/conferences/${KICKOFF}/schedule/watermark`]: () => watermark(current),
        [`/conferences/${KICKOFF}/schedule`]: () => ({ status: 200, body }),
      }),
    );

    await openSchedule();

    body = schedule(
      [session({ id: 'keynote', startTime: '09:30', endTime: '11:00', location: 'Room B' })],
      SECOND_WATERMARK,
    );
    current = SECOND_WATERMARK;

    await waitOnePoll();
    await vi.waitFor(() => expect(screen.queryByTestId('schedule-change-banner')).not.toBeNull());
  }

  it('names the changed session and what changed about it, and the removed one', async () => {
    await withChange();

    const banner = screen.getByTestId('schedule-change-banner').textContent ?? '';
    expect(banner).toContain('Opening Keynote');
    expect(banner).toContain('09:30–11:00');
    expect(banner).toContain('Room B');
    expect(banner).toContain('Retrospective');
    expect(banner).toMatch(/removed/i);

    /*
     * The sentence, pinned. This banner appears on a view the attendee was already watching when
     * the session moved, so the time they last saw is the one they just read - naming it back to
     * them costs a line on a 375px phone and tells them nothing. S10's reconnect summary is the
     * surface that does name both sides, because its reader was offline while it happened.
     */
    expect(banner).toContain('now runs 09:30–11:00');
    expect(banner).not.toContain('instead of');
  });

  it('is dismissible, and an unchanged poll does not raise it again', async () => {
    await withChange();

    // Real timers for the click: user-event schedules its own.
    vi.useRealTimers();
    await userEvent.click(screen.getByTestId('schedule-change-dismiss'));
    vi.useFakeTimers({ shouldAdvanceTime: false });

    expect(screen.queryByTestId('schedule-change-banner')).toBeNull();
    // The refreshed schedule is still on screen - dismissing the banner dismisses the banner.
    expect(screen.getByTestId('attendee-session-keynote').textContent).toContain('09:30–11:00');

    await waitOnePoll();
    await waitOnePoll();

    expect(screen.queryByTestId('schedule-change-banner')).toBeNull();
  });
});

// ---------- switching conference ----------

describe('switching to another conference', () => {
  const OTHER = '22222222-2222-4222-8222-222222222222';

  const TWO_CONFERENCES = {
    conferences: [
      ONE_CONFERENCE.conferences[0]!,
      {
        id: OTHER,
        name: 'Product Days',
        startDate: '2026-11-02',
        endDate: '2026-11-03',
        state: 'published',
      },
    ],
    defaultConferenceId: KICKOFF,
  };

  /**
   * Regression: whatever changed about the conference just left is not news about the one being
   * opened. The banner named a session that is not on the new schedule at all.
   */
  it('clears a change banner raised for the conference just left', async () => {
    let current = FIRST_WATERMARK;
    let body = schedule([KEYNOTE, RETRO]);

    vi.stubGlobal(
      'fetch',
      routeFetch({
        '/me/conferences': { status: 200, body: TWO_CONFERENCES },
        [`/conferences/${KICKOFF}/schedule/watermark`]: () => watermark(current),
        [`/conferences/${KICKOFF}/schedule`]: () => ({ status: 200, body }),
        [`/conferences/${OTHER}/schedule/watermark`]: watermark(FIRST_WATERMARK),
        [`/conferences/${OTHER}/schedule`]: {
          status: 200,
          body: schedule([session({ id: 'other-open', title: 'Product Kickoff' })]),
        },
      }),
    );

    await openSchedule();

    body = schedule([session({ id: 'keynote', location: 'Room B' })], SECOND_WATERMARK);
    current = SECOND_WATERMARK;
    await waitOnePoll();
    await vi.waitFor(() => expect(screen.queryByTestId('schedule-change-banner')).not.toBeNull());

    // Switch conference. Real timers for the interaction; user-event schedules its own.
    vi.useRealTimers();
    await userEvent.selectOptions(screen.getByTestId('attendee-conference-picker'), OTHER);
    vi.useFakeTimers({ shouldAdvanceTime: false });

    await vi.waitFor(() =>
      expect(screen.queryByTestId('attendee-session-other-open')).not.toBeNull(),
    );
    expect(screen.queryByTestId('schedule-change-banner')).toBeNull();
  });
});

// ---------- regression: a poll still in flight when the conference changes ----------

describe('a poll outstanding across a conference switch', () => {
  const OTHER = '33333333-3333-4333-8333-333333333333';

  const TWO = {
    conferences: [
      ONE_CONFERENCE.conferences[0]!,
      {
        id: OTHER,
        name: 'Product Days',
        startDate: '2026-11-02',
        endDate: '2026-11-03',
        state: 'published',
      },
    ],
    defaultConferenceId: KICKOFF,
  };

  /**
   * Regression, and this time the request really is in flight across the switch.
   *
   * The first version of this test resolved everything before switching, so neither the abort nor
   * any of the three post-await guards was reached - it passed with the guards deleted. Here the
   * first conference's schedule refetch is held open, the attendee switches, and only then is it
   * released: the exact interleaving where a slow poll used to paint the conference just left over
   * the one now on screen, and diff two different conferences into a nonsense banner.
   */
  it('never paints the previous conference over the new one', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let scheduleReads = 0;

    vi.stubGlobal(
      'fetch',
      routeFetch({
        '/me/conferences': { status: 200, body: TWO },
        [`/conferences/${KICKOFF}/schedule/watermark`]: () => watermark(SECOND_WATERMARK),
        /*
         * The first call is the initial load and resolves at once; the second is the poll's refetch
         * and is held open, so the switch below happens with that request genuinely in flight.
         */
        [`/conferences/${KICKOFF}/schedule`]: () => {
          scheduleReads += 1;
          return scheduleReads === 1
            ? { status: 200, body: schedule([KEYNOTE, RETRO]) }
            : { status: 200, body: schedule([KEYNOTE, RETRO], SECOND_WATERMARK), hold: held };
        },
        [`/conferences/${OTHER}/schedule/watermark`]: watermark(FIRST_WATERMARK),
        [`/conferences/${OTHER}/schedule`]: {
          status: 200,
          body: schedule([session({ id: 'other-open', title: 'Product Kickoff' })]),
        },
      }),
    );

    render(<AttendeeSchedulePanel />);
    await vi.waitFor(() => expect(screen.queryByTestId('attendee-session-list')).not.toBeNull());

    // Start the poll. Its watermark resolves, its schedule refetch blocks on `held`.
    await vi.advanceTimersByTimeAsync(5_000);

    vi.useRealTimers();
    await userEvent.selectOptions(screen.getByTestId('attendee-conference-picker'), OTHER);
    vi.useFakeTimers({ shouldAdvanceTime: false });

    await vi.waitFor(() =>
      expect(screen.queryByTestId('attendee-session-other-open')).not.toBeNull(),
    );

    /*
     * Let the stale poll finish, and flush only the microtasks its resolution schedules - not a
     * further poll interval. Advancing a full tick would let the *new* conference's poll repaint the
     * correct schedule and mask a stale paint that did happen, which is how the first two versions
     * of this test passed against the very defect they name.
     */
    release();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(screen.queryByTestId('attendee-session-other-open')).not.toBeNull();
    expect(screen.queryByTestId('attendee-session-keynote')).toBeNull();
    expect(screen.queryByTestId('attendee-session-retro')).toBeNull();

    // And no banner diffed across two different conferences.
    const banner = screen.queryByTestId('schedule-change-banner');
    if (banner !== null) {
      expect(banner.textContent).not.toContain('Retrospective');
      expect(banner.textContent).not.toContain('Product Kickoff');
    }
  });
});

// ---------- TI02 / TI03 Verify: the same reading in every timezone ----------

/**
 * The behavioural half of SC6 and SC7, which the source grep below cannot reach.
 *
 * That grep proves the refresh path *contains* no conversion. It cannot prove the rendered output
 * is timezone-invariant: a conversion introduced through S06's component tree, a formatter added to
 * a shared helper, or a `day` routed through anything offset-aware would all satisfy it and still
 * show a session at 02:00 to an attendee whose phone is set to Denver. TI02 and TI03 both ask for
 * the same evidence instead - the rendered text, read under two client timezones sixteen hours
 * apart, byte for byte identical.
 *
 * UTC-7 and UTC+9 are the FIS's own values, and they straddle the venue: 09:00 in Stockholm is the
 * previous evening in Denver and the same evening in Tokyo, so a date that shifted would shift in
 * opposite directions and a time that shifted could not agree with either.
 */
describe('the refreshed schedule read from a device in another timezone', () => {
  const ORIGINAL_TZ = process.env.TZ;

  afterEach(() => {
    process.env.TZ = ORIGINAL_TZ;
  });

  interface Reading {
    sessions: string;
    day: string;
    staleness: string;
    banner: string;
  }

  /**
   * One full pass of the story's own flow - open, an Admin edit lands, the poll picks it up, time
   * passes - captured as text. Deliberately the whole flow rather than one component: the claim is
   * about what the attendee ends up reading, not about which function formats it.
   */
  async function readUnder(zone: string): Promise<Reading> {
    process.env.TZ = zone;
    vi.setSystemTime(new Date(SYNC_INSTANT_MILLIS));

    let current = FIRST_WATERMARK;
    let body = schedule([KEYNOTE, RETRO]);

    vi.stubGlobal(
      'fetch',
      routeFetch({
        '/me/conferences': { status: 200, body: ONE_CONFERENCE },
        [`/conferences/${KICKOFF}/schedule/watermark`]: () => watermark(current),
        [`/conferences/${KICKOFF}/schedule`]: () => ({ status: 200, body }),
      }),
    );

    await openSchedule();

    // The Admin moves the keynote across the hour boundary and changes the room.
    body = schedule(
      [session({ id: 'keynote', startTime: '09:30', endTime: '11:00', location: 'Room B' }), RETRO],
      SECOND_WATERMARK,
    );
    current = SECOND_WATERMARK;

    await waitOnePoll();
    /*
     * Waited on the *location*, deliberately. Waiting on the new time would make this wait the
     * assertion: a conversion would fail it here, inside the helper, before either reading was
     * captured - and the comparison below would never run at all, which is a comparison that cannot
     * fail. The room is a plain string no formatter touches, so it says only "the poll landed".
     */
    await vi.waitFor(() =>
      expect(screen.getByTestId('attendee-session-keynote').textContent).toContain('Room B'),
    );

    // Four minutes on from the watermark the refresh carried, so the age is a real elapsed
    // duration rather than the "just now" every reading would share by default.
    vi.setSystemTime(new Date(SYNC_INSTANT_MILLIS + 4 * 60_000));
    await vi.advanceTimersByTimeAsync(60_000);

    const reading: Reading = {
      sessions: screen.getByTestId('attendee-session-list').textContent ?? '',
      day: screen.getByTestId('attendee-day-2026-09-15').textContent ?? '',
      staleness: screen.getByTestId('schedule-staleness').textContent ?? '',
      banner: screen.queryByTestId('schedule-change-banner')?.textContent ?? '',
    };

    cleanup();
    return reading;
  }

  it('reads identically at UTC-7 and UTC+9, times, day and elapsed age alike', async () => {
    const denver = await readUnder('America/Denver');
    const tokyo = await readUnder('Asia/Tokyo');

    // The claim itself, first: sixteen hours of client offset change nothing that is read.
    expect(tokyo.sessions).toBe(denver.sessions);
    expect(tokyo.day).toBe(denver.day);
    expect(tokyo.staleness).toBe(denver.staleness);
    expect(tokyo.banner).toBe(denver.banner);

    /*
     * And the fixture actually said something, in both readings. Two identical empty strings would
     * satisfy every comparison above, and so would a conversion that shifted both readings by the
     * same fixed amount - the guard is what separates "agrees" from "agrees on the right value".
     */
    for (const [zone, reading] of [
      ['denver', denver],
      ['tokyo', tokyo],
    ] as const) {
      expect(reading.sessions, zone).toContain('09:30–11:00');
      expect(reading.sessions, zone).toContain('Room B');
      expect(reading.day, zone).toContain('2026-09-15');
      expect(reading.staleness, zone).toMatch(/just now|minutes? ago/);
      expect(reading.banner, zone).not.toBe('');
    }
  });
});

// ---------- the structural half: no push, no timezone conversion ----------

describe('the refresh path', () => {
  const sources = [
    'attendee/AttendeeSchedulePanel.tsx',
    'attendee/ScheduleChangeBanner.tsx',
    'attendee/schedule-diff.ts',
    'attendee/staleness.ts',
    /*
     * The two that render the refreshed envelope, and the reason the behavioural test above exists.
     * They were missing from this list, so a `toLocaleTimeString` in `timeRange` - the function that
     * formats every Session time an Attendee reads - passed this guard untouched. A file list is
     * only as good as its longest omission.
     */
    'attendee/ScheduleView.tsx',
    'attendee/schedule-view-model.ts',
  ].map((relative) => ({
    relative,
    code: readFileSync(join(webSrc, relative), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, ''),
  }));

  /**
   * The Final Validation Checklist, asserted rather than assumed. The banner is the in-app channel
   * and is client-local by construction; anything here that reached for a device token would be the
   * deferred push story arriving by the back door.
   */
  it('introduces no push surface of any kind', () => {
    for (const { relative, code } of sources) {
      expect(
        /apns|fcm|firebase|device[_-]?token|push[_-]?(token|subscription|notification)|serviceWorker|Notification\(/i.test(
          code,
        ),
        relative,
      ).toBe(false);
    }
  });

  /**
   * The watermark is an instant and must never be rendered as a time of day: deriving one needs a
   * timezone the product does not carry, and on a device set away from the venue it would
   * contradict every Session time on the same screen.
   */
  it('converts no timezone and constructs no Date from a session or watermark value', () => {
    for (const { relative, code } of sources) {
      expect(/toLocaleTimeString|toLocaleDateString|toLocaleString/.test(code), relative).toBe(
        false,
      );
      expect(/Intl\.DateTimeFormat/.test(code), relative).toBe(false);
      expect(/Date\.parse|new Date\(/.test(code), relative).toBe(false);
    }
  });

  /**
   * `Date.now()` is permitted and is not a conversion – it is a count of milliseconds since the
   * epoch, identical in every timezone. It is the one clock reading the refresh path makes.
   */
  it('reads the device clock only as an epoch count', () => {
    const panel = sources.find((entry) => entry.relative.endsWith('.tsx'))!;
    expect(panel.code).toMatch(/Date\.now\(\)/);
  });
});
