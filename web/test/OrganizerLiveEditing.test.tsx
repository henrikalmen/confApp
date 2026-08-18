import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SchedulePanel } from '../src/schedule/SchedulePanel.tsx';
import { ConferenceDetail } from '../src/components/ConferenceDetail.tsx';
import type { Conference, OrganizerSchedule, Session } from '../src/api/client.ts';

/**
 * S09 TI10 – the Organizer's side of live editing.
 *
 * Post-publish add, edit and delete, and the two refusals that only happen because somebody else is
 * working at the same time: a version conflict, which is recoverable by re-applying the edit, and a
 * lifecycle transition, which is not. Both are rendered as the server's own sentence – it is the
 * only thing that knows which of the two happened and what to do about it.
 *
 * Driven at the `fetch` boundary, so the real client module builds the request: whether the base
 * actually reaches the server is part of what is under test.
 */

const CONFERENCE_ID = '11111111-1111-4111-8111-111111111111';
const LOADED_VERSION = '2026-08-17T10:00:00.123456Z';
const NEWER_VERSION = '2026-08-17T10:05:00.654321Z';

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
    lastUpdatedAt: LOADED_VERSION,
    ...overrides,
  };
}

const KEYNOTE = session();

function schedule(lifecycleState: Conference['lifecycleState'] = 'published'): OrganizerSchedule {
  return {
    conference: {
      id: CONFERENCE_ID,
      name: 'Autumn Offsite',
      startDate: '2026-09-15',
      endDate: '2026-09-16',
      lifecycleState,
      lastUpdatedAt: LOADED_VERSION,
    },
    days: [
      { day: '2026-09-15', sessions: [KEYNOTE] },
      { day: '2026-09-16', sessions: [] },
    ],
    overlaps: [],
  };
}

interface Route {
  status: number;
  body: unknown;
}

/** Every request made, so a test can assert what the client actually sent. */
interface Sent {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

function routeFetch(routes: Record<string, Route | (() => Route)>, sent: Sent[]): typeof fetch {
  return vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const full = url.replace(/^.*\/api/, '');
    const path = full.replace(/\?.*$/, '');

    sent.push({
      method,
      path: full,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    });

    const entry = routes[`${method} ${path}`];
    if (entry === undefined) throw new Error(`No route stubbed for ${method} ${path}.`);
    const route = typeof entry === 'function' ? entry() : entry;

    return new Response(JSON.stringify(route.body), {
      status: route.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

const SCHEDULE_PATH = `GET /conferences/${CONFERENCE_ID}/schedule/organizer`;
const EDIT_PATH = `PATCH /conferences/${CONFERENCE_ID}/sessions/${KEYNOTE.id}`;

beforeEach(() => {
  window.__CONFAPP_CONFIG__ = { apiBaseUrl: '/api', googleClientId: 'x', googleRedirectUri: 'x' };
});

afterEach(() => vi.restoreAllMocks());

async function openEditor(routes: Record<string, Route | (() => Route)>): Promise<Sent[]> {
  const sent: Sent[] = [];
  globalThis.fetch = routeFetch(routes, sent);
  render(<SchedulePanel conferenceId={CONFERENCE_ID} readOnly={false} />);

  await screen.findByTestId(`session-${KEYNOTE.id}`);
  await userEvent.click(screen.getByTestId(`edit-${KEYNOTE.id}`));
  return sent;
}

// ---------- Acceptance Scenario S03 (browser half): the conflict, and the re-apply ----------

describe('a save refused because somebody else saved first', () => {
  const conflict = {
    status: 409,
    body: {
      error: {
        code: 'EDIT_VERSION_CONFLICT',
        message: 'This session changed since you opened it, so your change was not saved.',
        current: session({ startTime: '09:30', lastUpdatedAt: NEWER_VERSION }),
      },
    },
  };

  it('shows the newer version beside the typed values, and re-applying succeeds', async () => {
    let refuse = true;
    const sent = await openEditor({
      [SCHEDULE_PATH]: { status: 200, body: schedule() },
      [EDIT_PATH]: () =>
        refuse
          ? conflict
          : {
              status: 200,
              body: {
                session: session({ location: 'Room C', lastUpdatedAt: NEWER_VERSION }),
                overlapWarning: null,
                conference: { lastUpdatedAt: NEWER_VERSION },
              },
            },
    });

    const location = screen.getByLabelText('Location');
    await userEvent.clear(location);
    await userEvent.type(location, 'Room C');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    // The server's own sentence, and the version it handed back.
    const notice = await screen.findByTestId('session-conflict');
    expect(notice.textContent).toContain('09:30');
    expect(notice.textContent).toContain('Opening Keynote');

    // The typed value is still in the form – nothing has to be retyped.
    expect((screen.getByLabelText('Location') as HTMLInputElement).value).toBe('Room C');

    // The first save carried the version the form was opened with.
    const first = sent.find((call) => call.method === 'PATCH');
    expect((first!.body!.base as { version: string }).version).toBe(LOADED_VERSION);

    refuse = false;
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    await screen.findByTestId(`session-${KEYNOTE.id}`);

    // The second save carried the version the refusal returned – which is what makes it succeed.
    const patches = sent.filter((call) => call.method === 'PATCH');
    expect(patches).toHaveLength(2);
    expect((patches[1]!.body!.base as { version: string }).version).toBe(NEWER_VERSION);
    expect(screen.queryByTestId('session-conflict')).toBeNull();
  });

  it('offers discarding the edit as the other way out', async () => {
    await openEditor({
      [SCHEDULE_PATH]: { status: 200, body: schedule() },
      [EDIT_PATH]: conflict,
    });

    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    await screen.findByTestId('session-conflict');

    await userEvent.click(screen.getByTestId('session-conflict-discard'));

    expect(screen.queryByTestId('session-conflict')).toBeNull();
    expect(screen.queryByTestId('session-form')).toBeNull();
  });
});

// ---------- Acceptance Scenario S04 (browser half): the lifecycle race ----------

describe('a save refused because the conference moved on', () => {
  it('shows the state-named message rather than a generic error', async () => {
    await openEditor({
      [SCHEDULE_PATH]: { status: 200, body: schedule() },
      [EDIT_PATH]: {
        status: 409,
        body: {
          error: {
            code: 'CONFERENCE_STATE_CHANGED',
            message:
              'This conference was archived while you were editing, so your change was not ' +
              'saved. It is now archived.',
          },
        },
      },
    });

    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    const shown = await screen.findByTestId('session-form-error');
    expect(shown.textContent).toContain('archived');
    // Not offered as a re-appliable conflict: there is nothing to re-apply onto.
    expect(screen.queryByTestId('session-conflict')).toBeNull();
  });
});

// ---------- post-publish editing is offered at all ----------

describe('a published conference', () => {
  it('still offers add, edit and delete on its schedule', async () => {
    const sent: Sent[] = [];
    globalThis.fetch = routeFetch({ [SCHEDULE_PATH]: { status: 200, body: schedule() } }, sent);
    render(<SchedulePanel conferenceId={CONFERENCE_ID} readOnly={false} />);

    await screen.findByTestId(`session-${KEYNOTE.id}`);

    expect(screen.queryByTestId('add-session')).not.toBeNull();
    expect(screen.queryByTestId(`edit-${KEYNOTE.id}`)).not.toBeNull();
    expect(screen.queryByTestId(`delete-${KEYNOTE.id}`)).not.toBeNull();
  });

  it('sends its lifecycle state as part of the base, so a race can be told from a conflict', async () => {
    const sent = await openEditor({
      [SCHEDULE_PATH]: { status: 200, body: schedule('published') },
      [EDIT_PATH]: {
        status: 200,
        body: {
          session: session({ lastUpdatedAt: NEWER_VERSION }),
          overlapWarning: null,
          conference: { lastUpdatedAt: NEWER_VERSION },
        },
      },
    });

    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    await screen.findByTestId(`session-${KEYNOTE.id}`);

    const patch = sent.find((call) => call.method === 'PATCH')!;
    expect(patch.body!.base).toEqual({ conferenceState: 'published', version: LOADED_VERSION });
  });
});

// ---------- the conference detail edit form (TI06's browser half) ----------

describe("the conference's name and dates after publish", () => {
  const CONFERENCE: Conference = {
    id: CONFERENCE_ID,
    name: 'Autumn Offsite',
    startDate: '2026-09-15',
    endDate: '2026-09-17',
    lifecycleState: 'published',
    updatedAt: LOADED_VERSION,
  };

  const DETAIL_PATH = `PATCH /conferences/${CONFERENCE_ID}`;

  function renderDetail(routes: Record<string, Route | (() => Route)>): {
    sent: Sent[];
    changed: Conference[];
  } {
    const sent: Sent[] = [];
    const changed: Conference[] = [];
    globalThis.fetch = routeFetch(
      { [SCHEDULE_PATH]: { status: 200, body: schedule() }, ...routes },
      sent,
    );
    render(
      <ConferenceDetail
        conference={CONFERENCE}
        onChanged={(next) => changed.push(next)}
        onBack={() => {}}
      />,
    );
    return { sent, changed };
  }

  it('are editable, and the save carries the conference row version as its base', async () => {
    const { sent, changed } = renderDetail({
      [DETAIL_PATH]: {
        status: 200,
        body: { ...CONFERENCE, name: 'Autumn Offsite 2026', updatedAt: NEWER_VERSION },
      },
    });

    await userEvent.click(screen.getByTestId('edit-conference'));

    const name = screen.getByLabelText('Conference name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Autumn Offsite 2026');
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await vi.waitFor(() => expect(changed).toHaveLength(1));

    const patch = sent.find((call) => call.method === 'PATCH')!;
    // The Conference row's own version, never the schedule watermark.
    expect(patch.body!.base).toEqual({ conferenceState: 'published', version: LOADED_VERSION });
    expect(changed[0]!.name).toBe('Autumn Offsite 2026');
  });

  it('refuse a shortened span inline, naming the sessions it would strand', async () => {
    const message =
      'These dates would leave "Retrospective" on 2026-09-17 outside the conference. ' +
      'Move or delete them first.';

    renderDetail({
      [DETAIL_PATH]: {
        status: 409,
        body: {
          error: {
            code: 'CONFERENCE_SPAN_ORPHANS_SESSIONS',
            message,
            details: [
              { field: 'startDate', message },
              { field: 'endDate', message },
            ],
          },
        },
      },
    });

    await userEvent.click(screen.getByTestId('edit-conference'));

    const end = screen.getByLabelText('Last day');
    await userEvent.clear(end);
    await userEvent.type(end, '2026-09-16');
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    // Beside the date inputs the refusal is about, not as a banner at the top of the page.
    const shown = await screen.findByTestId('error-dates');
    expect(shown.textContent).toContain('Retrospective');
    expect(shown.textContent).toContain('2026-09-17');
  });

  it('are not offered once the conference is archived', () => {
    const sent: Sent[] = [];
    globalThis.fetch = routeFetch({ [SCHEDULE_PATH]: { status: 200, body: schedule() } }, sent);
    render(
      <ConferenceDetail
        conference={{ ...CONFERENCE, lifecycleState: 'archived' }}
        onChanged={() => {}}
        onBack={() => {}}
      />,
    );

    expect(screen.queryByTestId('edit-conference')).toBeNull();
  });
});
