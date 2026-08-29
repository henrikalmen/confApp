import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AttendeeSchedulePanel } from '../src/attendee/AttendeeSchedulePanel.tsx';
import type { AttendeeSchedule, AttendeeSession } from '../src/api/client.ts';

/**
 * TI06–TI10 – the attendee schedule view.
 *
 * The API is driven at the `fetch` boundary, so the real client module – the envelope's shape, the
 * error envelope, the request path – is exercised rather than mocked past. The **device clock** is
 * driven the same way, with a real fake timer rather than a stubbed formatter: an implementation
 * that highlighted from the raw device clock would pass any formatter-level assertion.
 */

const KICKOFF = '11111111-1111-4111-8111-111111111111';
const PRODUCT_DAYS = '22222222-2222-4222-8222-222222222222';

/** The server is at 09:40 on day 2 of Kickoff 2026 – mid-keynote. */
const SERVER_NOW = {
  instant: '2026-09-15T07:40:12.345678Z',
  day: '2026-09-15',
  time: '09:40',
};

const SYNC_INSTANT_MILLIS = Date.UTC(2026, 8, 15, 7, 40, 12, 345);
const THREE_HOURS = 3 * 60 * 60 * 1000;

function session(overrides: Partial<AttendeeSession> = {}): AttendeeSession {
  return {
    id: 'keynote',
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

const KEYNOTE = session();
const DESIGN = session({
  id: 'design',
  title: 'Design Workshop',
  kind: 'Workshop',
  startTime: '10:00',
  endTime: '11:00',
  location: 'Room 2',
  concurrentWith: ['architecture', 'keynote'],
});
const ARCHITECTURE = session({
  id: 'architecture',
  title: 'Architecture Deep Dive',
  startTime: '10:00',
  endTime: '11:00',
  location: 'Room 3',
  concurrentWith: ['design', 'keynote'],
});
const RETRO = session({
  id: 'retro',
  title: 'Retrospective',
  kind: 'Workshop',
  startTime: '15:00',
  endTime: '16:00',
  location: 'Room B',
});

/** The schedule watermark the fixture envelope carries – S09 polls for exactly this value. */
const WATERMARK = '2026-09-15T07:00:00.123456Z';

function schedule(overrides: Partial<AttendeeSchedule> = {}): AttendeeSchedule {
  return {
    conference: {
      id: KICKOFF,
      name: 'Kickoff 2026',
      startDate: '2026-09-14',
      endDate: '2026-09-16',
      state: 'published',
      lastUpdatedAt: WATERMARK,
    },
    days: [
      { date: '2026-09-14', dayNumber: 1, sessions: [] },
      {
        date: '2026-09-15',
        dayNumber: 2,
        sessions: [
          { ...KEYNOTE, concurrentWith: ['design', 'architecture'] },
          ARCHITECTURE,
          DESIGN,
          RETRO,
        ],
      },
      { date: '2026-09-16', dayNumber: 3, sessions: [] },
    ],
    serverNow: SERVER_NOW,
    ...overrides,
  };
}

const ONE_CONFERENCE = {
  conferences: [
    {
      id: KICKOFF,
      name: 'Kickoff 2026',
      startDate: '2026-09-14',
      endDate: '2026-09-16',
      state: 'published',
    },
  ],
  defaultConferenceId: KICKOFF,
};

const THREE_CONFERENCES = {
  conferences: [
    ...ONE_CONFERENCE.conferences,
    {
      id: PRODUCT_DAYS,
      name: 'Product Days',
      startDate: '2026-11-02',
      endDate: '2026-11-03',
      state: 'published',
    },
    {
      id: '33333333-3333-4333-8333-333333333333',
      name: 'Retro 2025',
      startDate: '2025-11-18',
      endDate: '2025-11-20',
      state: 'archived',
    },
  ],
  defaultConferenceId: KICKOFF,
};

interface Route {
  status: number;
  body: unknown;
}

/** Routes by path suffix, so a test states only the calls it cares about. */
function routeFetch(routes: Record<string, Route | (() => Route)>): typeof fetch {
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    const match = Object.keys(routes).find((path) => url.endsWith(path));
    if (match === undefined) throw new Error(`unrouted request: ${url}`);

    const entry = routes[match]!;
    const route = typeof entry === 'function' ? entry() : entry;
    return {
      ok: route.status < 400,
      status: route.status,
      json: async () => route.body,
    } as Response;
  }) as unknown as typeof fetch;
}

/** The device clock, three hours fast, under the test's control. */
function skewedDeviceClock(skew = THREE_HOURS): void {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.setSystemTime(new Date(SYNC_INSTANT_MILLIS + skew));
}

beforeEach(() => {
  window.__CONFAPP_CONFIG__ = { apiBaseUrl: '/api', googleClientId: 'x', googleRedirectUri: 'x' };
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function renderPanel(routes: Record<string, Route | (() => Route)>): void {
  vi.stubGlobal('fetch', routeFetch(routes));
  render(<AttendeeSchedulePanel />);
}

// ---------- Acceptance Scenario S01 (TI03, TI06, TI08) ----------

describe('opening the schedule', () => {
  it('lands on the current Conference Day without being asked to choose it', async () => {
    renderPanel({
      '/me/conferences': { status: 200, body: ONE_CONFERENCE },
      [`/conferences/${KICKOFF}/schedule`]: { status: 200, body: schedule() },
    });

    const nav = await screen.findByTestId('attendee-day-nav');
    await waitFor(() =>
      expect(within(nav).getByTestId('attendee-day-2026-09-15').getAttribute('aria-current')).toBe(
        'true',
      ),
    );
  });

  it('lists the day’s Sessions in the order the server sent, with time, location and kind', async () => {
    renderPanel({
      '/me/conferences': { status: 200, body: ONE_CONFERENCE },
      [`/conferences/${KICKOFF}/schedule`]: { status: 200, body: schedule() },
    });

    const list = await screen.findByTestId('attendee-session-list');
    const items = within(list).getAllByRole('listitem');
    expect(items.map((item) => within(item).getByRole('heading').textContent)).toEqual([
      'Opening Keynote',
      'Architecture Deep Dive',
      'Design Workshop',
      'Retrospective',
    ]);

    const keynote = screen.getByTestId('attendee-session-keynote');
    expect(keynote.textContent).toContain('09:00–10:30');
    expect(keynote.textContent).toContain('Main Hall');
    expect(keynote.textContent).toContain('Presentation');
  });

  /** No selection step where there is only one thing to select (TI10). */
  it('takes a caller with exactly one Conference straight to it', async () => {
    renderPanel({
      '/me/conferences': { status: 200, body: ONE_CONFERENCE },
      [`/conferences/${KICKOFF}/schedule`]: { status: 200, body: schedule() },
    });

    await screen.findByTestId('attendee-session-list');
    expect(screen.queryByTestId('attendee-conference-picker')).toBeNull();
  });
});

// ---------- Acceptance Scenario S03 (TI06, TI09) ----------

describe('day navigation', () => {
  it('offers every Conference Day of the span', async () => {
    renderPanel({
      '/me/conferences': { status: 200, body: ONE_CONFERENCE },
      [`/conferences/${KICKOFF}/schedule`]: { status: 200, body: schedule() },
    });

    const nav = await screen.findByTestId('attendee-day-nav');
    for (const date of ['2026-09-14', '2026-09-15', '2026-09-16']) {
      expect(within(nav).getByTestId(`attendee-day-${date}`)).toBeDefined();
    }
  });

  it('opens on day 1 when the effective day falls outside the span', async () => {
    // A server that is a fortnight before the conference starts.
    const before = {
      ...schedule(),
      serverNow: { instant: '2026-09-01T07:40:12.345678Z', day: '2026-09-01', time: '09:40' },
    };
    renderPanel({
      '/me/conferences': { status: 200, body: ONE_CONFERENCE },
      [`/conferences/${KICKOFF}/schedule`]: { status: 200, body: before },
    });

    const nav = await screen.findByTestId('attendee-day-nav');
    await waitFor(() =>
      expect(within(nav).getByTestId('attendee-day-2026-09-14').getAttribute('aria-current')).toBe(
        'true',
      ),
    );
  });

  /** The scenario names two occasions for the day-1 default, and this is the second one. */
  it('opens on day 1 after the Conference has ended, as well as before it starts', async () => {
    const after = {
      ...schedule(),
      serverNow: { instant: '2026-10-01T07:40:12.345678Z', day: '2026-10-01', time: '09:40' },
    };
    renderPanel({
      '/me/conferences': { status: 200, body: ONE_CONFERENCE },
      [`/conferences/${KICKOFF}/schedule`]: { status: 200, body: after },
    });

    const nav = await screen.findByTestId('attendee-day-nav');
    await waitFor(() =>
      expect(within(nav).getByTestId('attendee-day-2026-09-14').getAttribute('aria-current')).toBe(
        'true',
      ),
    );
  });

  it('shows a named empty state for a day with no Sessions, not a blank area', async () => {
    renderPanel({
      '/me/conferences': { status: 200, body: ONE_CONFERENCE },
      [`/conferences/${KICKOFF}/schedule`]: { status: 200, body: schedule() },
    });

    await screen.findByTestId('attendee-session-list');
    await userEvent.click(screen.getByTestId('attendee-day-2026-09-16'));

    const empty = screen.getByTestId('attendee-empty-day');
    expect(empty.textContent).toContain('2026-09-16');
    expect(screen.queryByTestId('attendee-session-list')).toBeNull();
  });
});

// ---------- Acceptance Scenario S04 (TI07) ----------

describe('concurrent Sessions', () => {
  it('marks each of a concurrent pair as running at the same time as the others', async () => {
    renderPanel({
      '/me/conferences': { status: 200, body: ONE_CONFERENCE },
      [`/conferences/${KICKOFF}/schedule`]: { status: 200, body: schedule() },
    });

    await screen.findByTestId('attendee-session-list');

    expect(screen.getByTestId('concurrent-design').textContent).toContain('Architecture Deep Dive');
    expect(screen.getByTestId('concurrent-architecture').textContent).toContain('Design Workshop');
    // The keynote overlaps both, and is marked as such rather than listed as a step before them.
    expect(screen.getByTestId('concurrent-keynote').textContent).toContain('Design Workshop');
  });

  it('leaves a Session that runs alone unmarked', async () => {
    renderPanel({
      '/me/conferences': { status: 200, body: ONE_CONFERENCE },
      [`/conferences/${KICKOFF}/schedule`]: { status: 200, body: schedule() },
    });

    await screen.findByTestId('attendee-session-list');
    expect(screen.queryByTestId('concurrent-retro')).toBeNull();
    expect(screen.getByTestId('attendee-session-retro').dataset.concurrent).toBe('false');
  });

  /**
   * The product rule, asserted as an absence: Sessions are open, attendance is neither chosen nor
   * recorded, and there is no Personal Agenda (FR4, FR6). A control here would look helpful and be
   * a defect, so the test names every word one would plausibly carry.
   *
   * **Activities is the one permitted control** (S01), and it is not an exception to the rule: it
   * opens what the Session is *running*, selects nothing about the Session and records no
   * attendance. Named explicitly rather than loosening the assertion to "some buttons are fine",
   * so the next control added to a Session card still has to argue for itself here.
   */
  it('offers no control to pick, attend, star or add a Session, and writes nothing', async () => {
    const fetchMock = routeFetch({
      '/me/conferences': { status: 200, body: ONE_CONFERENCE },
      [`/conferences/${KICKOFF}/schedule`]: { status: 200, body: schedule() },
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<AttendeeSchedulePanel />);

    const list = await screen.findByTestId('attendee-session-list');
    expect(
      within(list)
        .queryAllByRole('button')
        .map((button) => button.getAttribute('data-testid')),
    ).toEqual(
      ['keynote', 'architecture', 'design', 'retro'].map((id) => `attendee-activities-${id}`),
    );
    expect(within(list).queryAllByRole('checkbox')).toEqual([]);
    expect(list.textContent).not.toMatch(/attend|going|star|add to|my agenda|select/i);

    // Viewing sends nothing: the two reads, and no request with a method at all.
    const calls = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls).toHaveLength(2);
    for (const [, init] of calls) {
      expect((init as RequestInit | undefined)?.method ?? 'GET').toBe('GET');
    }
  });
});

// ---------- Acceptance Scenario S05 (TI08) ----------

describe('the running-Session highlight', () => {
  it('highlights the Session the server clock says is running, on a device three hours fast', async () => {
    skewedDeviceClock();
    renderPanel({
      '/me/conferences': { status: 200, body: ONE_CONFERENCE },
      [`/conferences/${KICKOFF}/schedule`]: { status: 200, body: schedule() },
    });

    await vi.waitFor(() => expect(screen.queryByTestId('attendee-session-list')).not.toBeNull());

    // 09:40 falls inside 09:00–10:30 and inside nothing else.
    expect(screen.getByTestId('attendee-session-keynote').dataset.running).toBe('true');
    expect(screen.getByTestId('running-keynote')).toBeDefined();
    for (const id of ['design', 'architecture', 'retro']) {
      expect(screen.getByTestId(`attendee-session-${id}`).dataset.running).toBe('false');
    }
  });

  /**
   * The heart of OC02. The device jumps three hours *after* the sync, so the highlight is allowed to
   * move – and every time on screen must still be byte-identical to what was authored.
   */
  it('never alters a displayed time, even when a post-sync jump moves the highlight', async () => {
    skewedDeviceClock();
    renderPanel({
      '/me/conferences': { status: 200, body: ONE_CONFERENCE },
      [`/conferences/${KICKOFF}/schedule`]: { status: 200, body: schedule() },
    });

    await vi.waitFor(() => expect(screen.queryByTestId('attendee-session-list')).not.toBeNull());
    const before = screen.getByTestId('attendee-session-keynote').textContent;
    expect(before).toContain('09:00–10:30');

    // Three hours forward, then past the minute timer so the highlight is re-evaluated.
    vi.setSystemTime(new Date(SYNC_INSTANT_MILLIS + 2 * THREE_HOURS));
    await vi.advanceTimersByTimeAsync(61_000);

    // The highlight has moved off the keynote – 12:40 is inside nothing on this day.
    await vi.waitFor(() =>
      expect(screen.getByTestId('attendee-session-keynote').dataset.running).toBe('false'),
    );

    // …and not one displayed time changed. 09:00–10:30 was not re-rendered as 12:00–13:30.
    expect(screen.getByTestId('attendee-session-keynote').textContent).toContain('09:00–10:30');
    expect(screen.getByTestId('attendee-session-retro').textContent).toContain('15:00–16:00');
    expect(screen.getByTestId('attendee-schedule').textContent).not.toContain('12:00–13:30');
  });

  /**
   * The other half of TI08: the minute timer re-evaluates and does **not** re-fetch the schedule.
   *
   * S09 has since added a watermark poll at this same boundary, so "no request at all" is no longer
   * the assertion – what must stay true is that the *highlight* needs no data to move. The schedule
   * payload is therefore counted specifically, and an unchanged watermark must not provoke one.
   */
  it('re-evaluates on the minute timer without refetching the schedule', async () => {
    skewedDeviceClock();
    const fetchMock = routeFetch({
      '/me/conferences': { status: 200, body: ONE_CONFERENCE },
      [`/conferences/${KICKOFF}/schedule`]: { status: 200, body: schedule() },
      [`/conferences/${KICKOFF}/schedule/watermark`]: {
        status: 200,
        body: { lastUpdatedAt: WATERMARK, state: 'published' },
      },
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<AttendeeSchedulePanel />);

    await vi.waitFor(() => expect(screen.queryByTestId('attendee-session-list')).not.toBeNull());

    const calls = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const scheduleReads = (): number =>
      calls.filter((call) => String(call[0]).endsWith('/schedule')).length;
    expect(scheduleReads()).toBe(1);

    // Past the keynote's end, so the highlight genuinely has to change.
    vi.setSystemTime(new Date(SYNC_INSTANT_MILLIS + THREE_HOURS + 60 * 60_000));
    await vi.advanceTimersByTimeAsync(61_000);

    await vi.waitFor(() =>
      expect(screen.getByTestId('attendee-session-keynote').dataset.running).toBe('false'),
    );
    expect(screen.getByTestId('attendee-session-design').dataset.running).toBe('true');
    // The highlight moved, and no schedule payload was fetched to make it move - the watermark
    // never advanced, so the poll stopped at its two scalars every time.
    expect(scheduleReads()).toBe(1);
  });

  it('highlights every Session of a Parallel Track that is running, not just the first', async () => {
    skewedDeviceClock();
    // A server clock inside both 10:00–11:00 Sessions.
    const midMorning = {
      ...schedule(),
      serverNow: { ...SERVER_NOW, time: '10:30' },
    };
    renderPanel({
      '/me/conferences': { status: 200, body: ONE_CONFERENCE },
      [`/conferences/${KICKOFF}/schedule`]: { status: 200, body: midMorning },
    });

    await vi.waitFor(() => expect(screen.queryByTestId('attendee-session-list')).not.toBeNull());
    expect(screen.getByTestId('attendee-session-design').dataset.running).toBe('true');
    expect(screen.getByTestId('attendee-session-architecture').dataset.running).toBe('true');
    // 10:30 is the keynote's end time, and the rule is half-open, so it is no longer running.
    expect(screen.getByTestId('attendee-session-keynote').dataset.running).toBe('false');
  });
});

// ---------- Acceptance Scenarios S06 and S07 (TI09) ----------

describe('the non-result states', () => {
  it('shows the server’s own refusal message', async () => {
    renderPanel({
      '/me/conferences': { status: 200, body: ONE_CONFERENCE },
      [`/conferences/${KICKOFF}/schedule`]: {
        status: 409,
        body: {
          error: {
            code: 'CONFERENCE_NOT_READABLE',
            message: '"Draft Days" has not been published yet, so there is no schedule to show.',
          },
        },
      },
    });

    const error = await screen.findByTestId('attendee-schedule-error');
    expect(error.textContent).toContain('has not been published yet');
    expect(error.textContent).toContain('CONFERENCE_NOT_READABLE');
  });

  /**
   * Acceptance Scenario S07: a failed fetch is an explicit state with a working retry – never a
   * blank screen, a spinner that never ends, or a fabricated empty Schedule.
   */
  it('shows an error state whose retry re-issues the request and renders the Schedule', async () => {
    let attempt = 0;
    renderPanel({
      '/me/conferences': { status: 200, body: ONE_CONFERENCE },
      [`/conferences/${KICKOFF}/schedule`]: () => {
        attempt += 1;
        return attempt === 1
          ? { status: 503, body: { error: { code: 'X', message: 'no network' } } }
          : { status: 200, body: schedule() };
      },
    });

    const error = await screen.findByTestId('attendee-schedule-error');
    expect(error.textContent).toContain('no network');
    // Not a fabricated empty schedule, and not a spinner left running.
    expect(screen.queryByTestId('attendee-session-list')).toBeNull();
    expect(screen.queryByTestId('attendee-empty-day')).toBeNull();
    expect(screen.queryByTestId('attendee-loading')).toBeNull();

    await userEvent.click(screen.getByTestId('attendee-retry'));

    await screen.findByTestId('attendee-session-list');
    expect(screen.queryByTestId('attendee-schedule-error')).toBeNull();
    expect(attempt).toBe(2);
  });

  /**
   * Acceptance Scenario S07's Given is a dropped venue network, and `/me/conferences` is the request
   * that goes first – so this is the branch a real connection failure lands in. It shipped as a dead
   * end once: an error message, no retry control, and a loader that could not be re-driven. On the
   * Capacitor shells there is no address bar to reload from, so the control has to be on screen.
   */
  it('offers a working retry when the conference list itself fails', async () => {
    let attempt = 0;
    renderPanel({
      '/me/conferences': () => {
        attempt += 1;
        return attempt === 1
          ? { status: 503, body: { error: { code: 'NETWORK', message: 'no network' } } }
          : { status: 200, body: ONE_CONFERENCE };
      },
      [`/conferences/${KICKOFF}/schedule`]: { status: 200, body: schedule() },
    });

    const error = await screen.findByTestId('attendee-conferences-error');
    expect(error.textContent).toContain('no network');
    // Not a spinner that never ends, and not an empty schedule fabricated to fill the space.
    expect(screen.queryByTestId('attendee-loading')).toBeNull();
    expect(screen.queryByTestId('attendee-session-list')).toBeNull();

    await userEvent.click(within(error).getByTestId('attendee-retry'));

    await screen.findByTestId('attendee-session-list');
    expect(screen.queryByTestId('attendee-conferences-error')).toBeNull();
    expect(attempt).toBe(2);
  });

  it('says so when the caller has joined nothing at all', async () => {
    renderPanel({
      '/me/conferences': { status: 200, body: { conferences: [], defaultConferenceId: null } },
    });

    const hint = await screen.findByTestId('attendee-no-conferences');
    expect(hint.textContent).toContain('not joined');
  });
});

// ---------- Acceptance Scenario S02 (TI10) ----------

describe('switching between joined Conferences', () => {
  it('lists all of them, opens on the server’s default, and marks the archived one', async () => {
    renderPanel({
      '/me/conferences': { status: 200, body: THREE_CONFERENCES },
      [`/conferences/${KICKOFF}/schedule`]: { status: 200, body: schedule() },
    });

    const picker = (await screen.findByTestId('attendee-conference-picker')) as HTMLSelectElement;
    expect(picker.options).toHaveLength(3);
    expect(picker.value).toBe(KICKOFF);
    expect([...picker.options].map((option) => option.textContent)).toContain(
      'Retro 2025 (archived)',
    );
  });

  it('loads the selected Conference’s Schedule when another is chosen', async () => {
    const productDays: AttendeeSchedule = {
      ...schedule(),
      conference: {
        id: PRODUCT_DAYS,
        name: 'Product Days',
        startDate: '2026-11-02',
        endDate: '2026-11-03',
        state: 'published',
        lastUpdatedAt: null,
      },
      days: [
        {
          date: '2026-11-02',
          dayNumber: 1,
          sessions: [session({ id: 'roadmap', title: 'Roadmap Review' })],
        },
        { date: '2026-11-03', dayNumber: 2, sessions: [] },
      ],
    };

    renderPanel({
      '/me/conferences': { status: 200, body: THREE_CONFERENCES },
      [`/conferences/${KICKOFF}/schedule`]: { status: 200, body: schedule() },
      [`/conferences/${PRODUCT_DAYS}/schedule`]: { status: 200, body: productDays },
    });

    await screen.findByTestId('attendee-session-keynote');
    await userEvent.selectOptions(screen.getByTestId('attendee-conference-picker'), PRODUCT_DAYS);

    await screen.findByTestId('attendee-session-roadmap');
    expect(screen.queryByTestId('attendee-session-keynote')).toBeNull();
    // The new conference opens on its own default day, not on a date from the previous span.
    expect(screen.getByTestId('attendee-day-2026-11-02').getAttribute('aria-current')).toBe('true');
  });
});
