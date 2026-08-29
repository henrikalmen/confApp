import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SchedulePanel } from '../src/schedule/SchedulePanel.tsx';
import { compareByStart, dayLabel, formatTimeRange } from '../src/schedule/wall-clock-time.ts';
import type { OrganizerSchedule, Session } from '../src/api/client.ts';

/**
 * TI09 – the Organizer's schedule composition view.
 *
 * The API is driven at the `fetch` boundary, so the real client module – envelope parsing, field
 * details, the request shape – is exercised rather than mocked past.
 */

const CONFERENCE_ID = '11111111-1111-4111-8111-111111111111';

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-keynote',
    conferenceId: CONFERENCE_ID,
    title: 'Opening Keynote',
    description: null,
    kind: 'Presentation',
    day: '2026-09-15',
    startTime: '09:00',
    endTime: '10:30',
    location: 'Main Hall',
    lastUpdatedAt: '2026-08-17T10:00:00.123456Z',
    ...overrides,
  };
}

const KEYNOTE = session();
const WORKSHOP = session({
  id: 'session-workshop',
  title: 'Design Workshop',
  kind: 'Workshop',
  startTime: '10:00',
  endTime: '11:00',
  location: 'Room 2',
});
const RETROSPECTIVE = session({
  id: 'session-retro',
  title: 'Retrospective',
  kind: 'Workshop',
  day: '2026-09-16',
  startTime: '15:00',
  endTime: '16:00',
  location: 'Room 2',
});

function schedule(overrides: Partial<OrganizerSchedule> = {}): OrganizerSchedule {
  return {
    conference: {
      id: CONFERENCE_ID,
      name: 'Autumn Offsite',
      startDate: '2026-09-15',
      endDate: '2026-09-16',
      lifecycleState: 'draft',
      lastUpdatedAt: '2026-08-17T10:00:00.123456Z',
    },
    days: [
      { day: '2026-09-15', sessions: [KEYNOTE] },
      { day: '2026-09-16', sessions: [] },
    ],
    overlaps: [],
    ...overrides,
  };
}

interface Route {
  status: number;
  body: unknown;
}

/** Routes by `METHOD /path`, so a test states only the calls it cares about. */
function routeFetch(routes: Record<string, Route>): typeof fetch {
  return vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    // The query string carries S09's write base; routes are stated by path alone.
    const path = url.replace(/^.*\/api/, '').replace(/\?.*$/, '');
    const route = routes[`${method} ${path}`];

    if (route === undefined) throw new Error(`No route stubbed for ${method} ${path}.`);
    return new Response(JSON.stringify(route.body), {
      status: route.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

const SCHEDULE_PATH = `GET /conferences/${CONFERENCE_ID}/schedule/organizer`;

function serving(payload: OrganizerSchedule): Record<string, Route> {
  return { [SCHEDULE_PATH]: { status: 200, body: payload } };
}

async function renderPanel(routes: Record<string, Route>, readOnly = false): Promise<void> {
  globalThis.fetch = routeFetch(routes);
  render(<SchedulePanel conferenceId={CONFERENCE_ID} readOnly={readOnly} lifecycleState="draft" />);
  await screen.findByTestId('day-nav');
}

describe('the wall-clock helpers', () => {
  /**
   * The client half of the naive representation. Rendering through `new Date('2026-09-15')` would
   * show the 14th to anyone west of UTC, so the strings are formatted as strings.
   */
  it('formats a time range without constructing a Date', () => {
    expect(formatTimeRange('09:00', '10:30')).toBe('09:00–10:30');
    expect(formatTimeRange('00:00', '23:59')).toBe('00:00–23:59');
  });

  it('orders by day then start time as a text compare', () => {
    const early = { day: '2026-09-15', startTime: '09:00' };
    const late = { day: '2026-09-15', startTime: '15:00' };
    const nextDay = { day: '2026-09-16', startTime: '08:00' };

    expect(compareByStart(early, late)).toBeLessThan(0);
    expect(compareByStart(late, early)).toBeGreaterThan(0);
    expect(compareByStart(early, early)).toBe(0);
    // A later clock time on an earlier day still sorts first.
    expect(compareByStart(late, nextDay)).toBeLessThan(0);
  });

  it('labels a conference day by its position in the span and its date', () => {
    expect(dayLabel('2026-09-15', 0)).toBe('Day 1 · 2026-09-15');
    expect(dayLabel('2026-09-16', 1)).toBe('Day 2 · 2026-09-16');
  });
});

describe('SchedulePanel', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    window.__CONFAPP_CONFIG__ = { apiBaseUrl: '/api' };
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  // ---------- Acceptance Scenario S01 (browser half) ----------

  describe('the day navigation and session list', () => {
    it('offers every conference day, including one with no sessions', async () => {
      await renderPanel(serving(schedule()));

      expect(screen.getByTestId('day-2026-09-15').textContent).toBe('Day 1 · 2026-09-15');
      expect(screen.getByTestId('day-2026-09-16').textContent).toBe('Day 2 · 2026-09-16');
    });

    it('renders sessions in the order the server returned them, with time, kind and location', async () => {
      await renderPanel(
        serving(
          schedule({
            days: [
              { day: '2026-09-15', sessions: [KEYNOTE, WORKSHOP] },
              { day: '2026-09-16', sessions: [] },
            ],
          }),
        ),
      );

      const cards = within(screen.getByTestId('session-list')).getAllByRole('listitem');
      expect(cards.map((card) => within(card).getByRole('heading').textContent)).toEqual([
        'Opening Keynote',
        'Design Workshop',
      ]);

      const keynote = screen.getByTestId(`session-${KEYNOTE.id}`);
      expect(keynote.textContent).toContain('09:00–10:30');
      expect(keynote.textContent).toContain('Presentation');
      expect(keynote.textContent).toContain('Main Hall');
    });

    /** The empty day is a state to show, not a day to omit – it is the one still to compose. */
    it('shows an explicit empty state for a day with no sessions', async () => {
      await renderPanel(serving(schedule()));

      await userEvent.click(screen.getByTestId('day-2026-09-16'));

      expect(screen.getByTestId('empty-day').textContent).toContain('2026-09-16');
      expect(screen.queryByTestId('session-list')).toBeNull();
    });

    it('switches the visible sessions when another day is selected', async () => {
      await renderPanel(
        serving(
          schedule({
            days: [
              { day: '2026-09-15', sessions: [KEYNOTE] },
              { day: '2026-09-16', sessions: [RETROSPECTIVE] },
            ],
          }),
        ),
      );

      expect(screen.getByTestId(`session-${KEYNOTE.id}`)).toBeTruthy();

      await userEvent.click(screen.getByTestId('day-2026-09-16'));

      expect(screen.getByTestId(`session-${RETROSPECTIVE.id}`)).toBeTruthy();
      expect(screen.queryByTestId(`session-${KEYNOTE.id}`)).toBeNull();
    });

    /** A calendar day and a wall-clock time have no timezone, so neither is reformatted. */
    it('renders days and times exactly as the API sent them', async () => {
      await renderPanel(serving(schedule()));

      expect(screen.getByText('09:00–10:30')).toBeTruthy();
      expect(screen.getByTestId('day-2026-09-15').textContent).toContain('2026-09-15');
    });
  });

  // ---------- Acceptance Scenario S07 (browser half) ----------

  describe('the overlap indicator', () => {
    const OVERLAPPING = schedule({
      days: [
        { day: '2026-09-15', sessions: [KEYNOTE, WORKSHOP] },
        { day: '2026-09-16', sessions: [] },
      ],
      overlaps: [{ sessionIds: [KEYNOTE.id, WORKSHOP.id] }],
    });

    /**
     * The persistent half of FR2. This render performs no save at all – it is a fresh load, driven
     * only by the payload – so an indicator that existed solely as a save-time toast would not be
     * here. The pre-publish "review overlap warnings" step depends on this.
     */
    it('marks both sessions of a pair after a fresh load with no prior save', async () => {
      await renderPanel(serving(OVERLAPPING));

      for (const marked of [KEYNOTE, WORKSHOP]) {
        const card = screen.getByTestId(`session-${marked.id}`);
        expect(card.getAttribute('data-overlapping'), marked.title).toBe('true');
        expect(card.className).toContain('session-card--overlapping');
      }
    });

    /** Named, not merely flagged – "this overlaps something" leaves the Organizer hunting. */
    it('names the session each one runs alongside', async () => {
      await renderPanel(serving(OVERLAPPING));

      expect(screen.getByTestId(`overlap-${KEYNOTE.id}`).textContent).toContain('Design Workshop');
      expect(screen.getByTestId(`overlap-${WORKSHOP.id}`).textContent).toContain('Opening Keynote');
    });

    /** The wording is a parallel track, not a fault – it is a supported option. */
    it('describes the overlap as a parallel track rather than an error', async () => {
      await renderPanel(serving(OVERLAPPING));

      const indicator = screen.getByTestId(`overlap-${KEYNOTE.id}`);
      expect(indicator.textContent).toContain('Parallel track');
      // Not in the alert role: nothing is wrong and nothing needs fixing.
      expect(indicator.getAttribute('role')).toBeNull();
      expect(screen.getByTestId('overlap-summary').textContent).toContain('1 parallel track');
    });

    it('marks nothing when the schedule has no overlapping pair', async () => {
      await renderPanel(
        serving(
          schedule({
            days: [
              { day: '2026-09-15', sessions: [KEYNOTE, WORKSHOP] },
              { day: '2026-09-16', sessions: [] },
            ],
          }),
        ),
      );

      expect(screen.getByTestId(`session-${KEYNOTE.id}`).getAttribute('data-overlapping')).toBe(
        'false',
      );
      expect(screen.queryByTestId('overlap-summary')).toBeNull();
    });

    /** Saved, with a warning: the non-blocking half of the same scenario. */
    it('shows the server warning as a status beside a save that succeeded', async () => {
      const message =
        'Saved. On 2026-09-15 this session runs at the same time as "Opening Keynote" (09:00–10:30).';
      await renderPanel({
        ...serving(schedule()),
        [`POST /conferences/${CONFERENCE_ID}/sessions`]: {
          status: 200,
          body: {
            session: WORKSHOP,
            overlapWarning: {
              code: 'SESSION_OVERLAPS',
              message,
              sessions: [
                {
                  id: KEYNOTE.id,
                  title: 'Opening Keynote',
                  startTime: '09:00',
                  endTime: '10:30',
                },
              ],
            },
          },
        },
      });

      await userEvent.click(screen.getByTestId('add-session'));
      await userEvent.type(screen.getByLabelText('Title'), 'Design Workshop');
      await userEvent.type(screen.getByLabelText('Location'), 'Room 2');
      await userEvent.click(screen.getByRole('button', { name: 'Add session' }));

      const warning = await screen.findByTestId('overlap-warning');
      expect(warning.textContent).toBe(message);
      // A status, not an alert – the save succeeded and nothing is being asked of anyone.
      expect(warning.getAttribute('role')).toBe('status');
    });
  });

  // ---------- Acceptance Scenarios S04 / S05 (browser half): inline refusals ----------

  describe('the add and edit form', () => {
    it("shows the server's day message against the day field, naming the valid days", async () => {
      const message =
        "A session must fall on one of this conference's days. Autumn Offsite runs on " +
        '2026-09-15 and 2026-09-16, and 2026-09-17 is not one of them.';
      await renderPanel({
        ...serving(schedule()),
        [`POST /conferences/${CONFERENCE_ID}/sessions`]: {
          status: 400,
          body: {
            error: {
              code: 'SESSION_DAY_OUT_OF_SPAN',
              message,
              details: [{ field: 'day', message }],
            },
          },
        },
      });

      await userEvent.click(screen.getByTestId('add-session'));
      await userEvent.type(screen.getByLabelText('Title'), 'Late Session');
      await userEvent.type(screen.getByLabelText('Location'), 'Main Hall');
      await userEvent.click(screen.getByRole('button', { name: 'Add session' }));

      const error = await screen.findByTestId('error-day');
      expect(error.textContent).toBe(message);
      // Attached to the control, so a screen reader reaches it from the input itself.
      expect(screen.getByLabelText('Conference day').getAttribute('aria-invalid')).toBe('true');
    });

    it('shows the time-range message against the time fields', async () => {
      const message =
        "A session's end time must be after its start time on the same conference day, and " +
        '23:15–00:45 is not. A session cannot run past midnight; split it across two sessions instead.';
      await renderPanel({
        ...serving(schedule()),
        [`POST /conferences/${CONFERENCE_ID}/sessions`]: {
          status: 400,
          body: {
            error: {
              code: 'SESSION_TIME_RANGE_INVALID',
              message,
              details: [
                { field: 'startTime', message },
                { field: 'endTime', message },
              ],
            },
          },
        },
      });

      await userEvent.click(screen.getByTestId('add-session'));
      await userEvent.type(screen.getByLabelText('Title'), 'Night Session');
      await userEvent.type(screen.getByLabelText('Location'), 'Main Hall');
      await userEvent.click(screen.getByRole('button', { name: 'Add session' }));

      expect((await screen.findByTestId('error-times')).textContent).toBe(message);
      expect(screen.getByLabelText('Start time').getAttribute('aria-invalid')).toBe('true');
      expect(screen.getByLabelText('End time').getAttribute('aria-invalid')).toBe('true');
    });

    it('shows the title message against the title field and nothing against the others', async () => {
      const message = 'A session title is required.';
      await renderPanel({
        ...serving(schedule()),
        [`POST /conferences/${CONFERENCE_ID}/sessions`]: {
          status: 400,
          body: {
            error: {
              code: 'SESSION_TITLE_INVALID',
              message,
              details: [{ field: 'title', message }],
            },
          },
        },
      });

      await userEvent.click(screen.getByTestId('add-session'));
      await userEvent.click(screen.getByRole('button', { name: 'Add session' }));

      expect((await screen.findByTestId('error-title')).textContent).toBe(message);
      expect(screen.queryByTestId('error-day')).toBeNull();
      expect(screen.queryByTestId('error-times')).toBeNull();
    });

    /** The naive strings are sent exactly as the Organizer picked them – no offset, no rewrite. */
    it('sends the day and times unchanged', async () => {
      const routes = {
        ...serving(schedule()),
        [`POST /conferences/${CONFERENCE_ID}/sessions`]: {
          status: 200,
          body: { session: KEYNOTE, overlapWarning: null },
        },
      };
      const fetchSpy = routeFetch(routes);
      globalThis.fetch = fetchSpy;
      render(
        <SchedulePanel conferenceId={CONFERENCE_ID} readOnly={false} lifecycleState="draft" />,
      );
      await screen.findByTestId('day-nav');

      await userEvent.click(screen.getByTestId('add-session'));
      await userEvent.type(screen.getByLabelText('Title'), 'Opening Keynote');
      await userEvent.type(screen.getByLabelText('Location'), 'Main Hall');
      await userEvent.type(screen.getByLabelText('Start time'), '09:00');
      await userEvent.type(screen.getByLabelText('End time'), '10:30');
      await userEvent.click(screen.getByRole('button', { name: 'Add session' }));

      await waitFor(() => {
        const post = vi
          .mocked(fetchSpy)
          .mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === 'POST');
        expect(post).toBeDefined();
        expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({
          title: 'Opening Keynote',
          description: '',
          kind: 'Presentation',
          day: '2026-09-15',
          startTime: '09:00',
          endTime: '10:30',
          location: 'Main Hall',
        });
      });
    });

    /** Editing opens on the session's own values, so nothing has to be retyped to change one. */
    it('opens the edit form seeded with the session being edited', async () => {
      await renderPanel(serving(schedule()));

      await userEvent.click(screen.getByTestId(`edit-${KEYNOTE.id}`));

      expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Opening Keynote');
      expect((screen.getByLabelText('Location') as HTMLInputElement).value).toBe('Main Hall');
      expect((screen.getByLabelText('Start time') as HTMLInputElement).value).toBe('09:00');
      expect((screen.getByLabelText('End time') as HTMLInputElement).value).toBe('10:30');
      expect((screen.getByLabelText('Conference day') as HTMLSelectElement).value).toBe(
        '2026-09-15',
      );
    });

    /** The day select offers the conference's own days and nothing else. */
    it('offers only the conference days as the day options', async () => {
      await renderPanel(serving(schedule()));
      await userEvent.click(screen.getByTestId('add-session'));

      const options = within(screen.getByLabelText('Conference day')).getAllByRole('option');
      expect(options.map((option) => option.textContent)).toEqual(['2026-09-15', '2026-09-16']);
    });
  });

  // ---------- Acceptance Scenario S03 (browser half): the delete refusal ----------

  it("renders the server's refusal verbatim when the last session cannot be deleted", async () => {
    const message =
      'A published conference must keep at least one session, and this is the last one. ' +
      'Add another session first, then remove this one.';
    await renderPanel({
      ...serving(schedule()),
      [`DELETE /conferences/${CONFERENCE_ID}/sessions/${KEYNOTE.id}`]: {
        status: 409,
        body: { error: { code: 'SESSION_LAST_IN_PUBLISHED_CONFERENCE', message } },
      },
    });

    await userEvent.click(screen.getByTestId(`delete-${KEYNOTE.id}`));

    expect((await screen.findByTestId('schedule-refusal')).textContent).toBe(message);
    // The session is still on screen, because the server said it still exists.
    expect(screen.getByTestId(`session-${KEYNOTE.id}`)).toBeTruthy();
  });

  // ---------- S05 Acceptance Scenario S01 (browser half): the contribution refusal (TI07) --------

  /**
   * The server's sentence, verbatim, with **no code-specific branch added to `remove()`**.
   *
   * S05 adds a refusal the client has never seen before, and this is what proves it needs no client
   * work: the panel renders `refused.message` whatever the code is. The alert also lives outside
   * the subtree a failed re-read would replace (`docs/LEARNINGS.md` – "a refusal rendered only
   * inside a component its own handler unmounts is lost"), so the sentence survives the reload the
   * handler does not do here.
   */
  it("renders the server's contribution refusal verbatim and keeps the session listed", async () => {
    const message =
      'This session has collected 12 post-its and cannot be deleted. ' +
      'Edit the session, or move it to another day or time, instead.';
    await renderPanel({
      ...serving(schedule()),
      [`DELETE /conferences/${CONFERENCE_ID}/sessions/${KEYNOTE.id}`]: {
        status: 409,
        body: { error: { code: 'SESSION_HOLDS_CONTRIBUTIONS', message } },
      },
    });

    await userEvent.click(screen.getByTestId(`delete-${KEYNOTE.id}`));

    expect((await screen.findByTestId('schedule-refusal')).textContent).toBe(message);
    expect(screen.getByTestId(`session-${KEYNOTE.id}`)).toBeTruthy();
  });

  /** …and the panel branches on no delete refusal code except the lifecycle race it already did. */
  it('adds no code-specific branch to the delete handler', async () => {
    /*
     * Read from the repository root: under jsdom the panel's own module URL is an http one, so
     * `import.meta.url` cannot be resolved to a file, and `process.cwd()` is the root the whole
     * workspace run starts from rather than the `web` package.
     */
    const relative = join('src', 'schedule', 'SchedulePanel.tsx');
    const candidates = [join(process.cwd(), 'web', relative), join(process.cwd(), relative)];
    const path = candidates.find((candidate) => existsSync(candidate));
    expect(
      path,
      `SchedulePanel.tsx should be found under one of ${candidates.join(' or ')}`,
    ).toBeDefined();
    const source = readFileSync(path!, 'utf8');
    const at = source.indexOf('const remove = useCallback(');
    expect(at, 'the remove handler should be found').toBeGreaterThan(-1);
    const remove = source.slice(at, source.indexOf('return (', at));

    expect(remove).toContain('setRefusal(refused.message)');
    expect(remove).not.toMatch(/SESSION_HOLDS_CONTRIBUTIONS|post-it|contribution/i);
    // The one code it does branch on is the lifecycle race S09 gave it, and there is only one.
    expect([...remove.matchAll(/refused\.code === '(\w+)'/g)].map((match) => match[1])).toEqual([
      'CONFERENCE_STATE_CHANGED',
    ]);
  });

  // ---------- read-only and failure states ----------

  it('offers no composition actions on an archived conference, but still shows the schedule', async () => {
    await renderPanel(serving(schedule()), true);

    expect(screen.getByTestId(`session-${KEYNOTE.id}`)).toBeTruthy();
    expect(screen.queryByTestId('add-session')).toBeNull();
    expect(screen.queryByTestId(`edit-${KEYNOTE.id}`)).toBeNull();
    expect(screen.queryByTestId(`delete-${KEYNOTE.id}`)).toBeNull();
  });

  it('shows the envelope message when the schedule cannot be loaded', async () => {
    globalThis.fetch = routeFetch({
      [SCHEDULE_PATH]: {
        status: 503,
        body: {
          error: {
            code: 'DATABASE_UNAVAILABLE',
            message: 'The service is temporarily unable to reach its database.',
          },
        },
      },
    });
    render(<SchedulePanel conferenceId={CONFERENCE_ID} readOnly={false} lifecycleState="draft" />);

    const alert = await screen.findByTestId('schedule-error');
    expect(alert.textContent).toContain('temporarily unable to reach its database');
    expect(alert.textContent).toContain('DATABASE_UNAVAILABLE');
  });
});
