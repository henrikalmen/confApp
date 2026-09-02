import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionActivitiesPanel } from '../src/activities/SessionActivitiesPanel.tsx';
import type { Round, SessionWithRounds } from '../src/api/client.ts';

/**
 * The Session Activities panel: S01's Round list and run controls, and S02's own poll (TI08, TI10).
 *
 * The API is driven at the `fetch` boundary, so the real client module – envelope parsing, field
 * details, the request shape – is exercised rather than mocked past. The **real** shared poll loop
 * runs too: a tick is provoked by dispatching the `focus` event the loop genuinely listens for,
 * rather than by calling anything the component exports, so what is under test is the loop as
 * shipped.
 *
 * **Nothing here waits on the value it then asserts** (`docs/LEARNINGS.md#testing`): the refresh
 * tests wait on a request count, which the defect they guard against cannot touch, and assert the
 * rendered state afterwards.
 */

const CONFERENCE_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const BASE = `/conferences/${CONFERENCE_ID}/sessions/${SESSION_ID}`;
const WATERMARK = `${BASE}/activities/watermark`;

/*
 * The Session's activity cursor, as the server actually sends it: an opaque counter, never a time.
 * Digits here rather than an ISO instant is the fixture's half of the guarantee - a timestamp told
 * every Member when each Vote landed. The view only ever asks whether the two differ.
 */
const FIRST_WATERMARK = '4171';
const SECOND_WATERMARK = '4172';

const POST_IT: Round = {
  id: 'round-post-it',
  kind: 'PostItRound',
  prompt: 'What slows us down most?',
  state: 'closed',
};

const POLL: Round = {
  id: 'round-poll',
  kind: 'VotingRound',
  purpose: 'Poll',
  prompt: 'Where should we start?',
  state: 'open',
  options: [
    { id: 'option-tooling', label: 'Tooling' },
    { id: 'option-meetings', label: 'Meetings' },
    { id: 'option-handovers', label: 'Handovers' },
  ],
};

function payload(
  rounds: Round[],
  canRun: boolean,
  activityWatermark: string | null = FIRST_WATERMARK,
): SessionWithRounds {
  return {
    session: {
      id: SESSION_ID,
      conferenceId: CONFERENCE_ID,
      title: 'Ways of Working',
      description: null,
      kind: 'Workshop',
      day: '2026-09-15',
      startTime: '13:00',
      endTime: '15:00',
      location: 'Room 2',
      lastUpdatedAt: '2026-08-17T10:00:00.123456Z',
    },
    rounds,
    canRun,
    canRemovePermanently: false,
    activityWatermark,
  };
}

/** The two-scalar poll's answer, as the endpoint returns it. */
function watermarkAnswer(activityWatermark: string | null): Route {
  return { status: 200, body: { activityWatermark, state: 'published' } };
}

/**
 * One tick of the shared poll loop, provoked the way the loop is genuinely provoked.
 *
 * `focus` is one of the three events `useWatermarkPoll` registers for an immediate refresh, so this
 * drives the shipped loop rather than a test-only entry point – a panel that registered no
 * listener, or polled through some private path, would not answer this.
 */
async function tick(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
  });
}

interface Route {
  status: number;
  body: unknown;
}

const calls: { method: string; path: string; body: unknown }[] = [];
/**
 * Requests whose **response has been built**, which is a different moment from the request being
 * issued.
 *
 * The distinction is the whole reason this exists. Counting requests lets a test synchronise on a
 * point *before* the component has seen the answer, so the assertions that follow are true whether
 * or not the code under test handles it – the vacuous guard `docs/LEARNINGS.md#testing` warns
 * about. Nothing here waits on a value it then asserts either.
 */
const answered: { method: string; path: string }[] = [];

/** Routes by `METHOD /path`; a route may be a list, consumed one response per call. */
function routeFetch(routes: Record<string, Route | Route[]>): typeof fetch {
  return vi.fn(async (input: unknown, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = String(input)
      .replace(/^.*\/api/, '')
      .replace(/\?.*$/, '');
    calls.push({
      method,
      path,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });

    const entry = routes[`${method} ${path}`];
    if (entry === undefined) throw new Error(`No route stubbed for ${method} ${path}.`);

    const route = Array.isArray(entry)
      ? (entry[Math.min(readsOf(method, path) - 1, entry.length - 1)] as Route)
      : entry;

    answered.push({ method, path });
    return new Response(JSON.stringify(route.body), {
      status: route.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

function readsOf(method: string, path: string): number {
  return calls.filter((call) => call.method === method && call.path === path).length;
}

function answersFor(method: string, path: string): number {
  return answered.filter((call) => call.method === method && call.path === path).length;
}

/**
 * Lets an answered request finish being handled.
 *
 * A response resolving is not the component having rendered it: the body is parsed in a further
 * microtask and the state update lands after that. Waited out on the real clock rather than by
 * polling for the expected value, so the reading is captured whether or not it is the one wanted.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

describe('SessionActivitiesPanel', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    window.__CONFAPP_CONFIG__ = { apiBaseUrl: '/api' };
    calls.length = 0;
    answered.length = 0;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  async function renderPanel(
    routes: Record<string, Route | Route[]>,
  ): Promise<(sessionId: string) => void> {
    globalThis.fetch = routeFetch(routes);
    const view = render(
      <SessionActivitiesPanel conferenceId={CONFERENCE_ID} sessionId={SESSION_ID} />,
    );
    // Waits for the load to settle, not for anything a test then asserts: an empty session has no
    // round list to find, and a payload with rounds has no "add" control unless canRun is true.
    await waitFor(() => expect(screen.queryByText(/Loading this session/)).toBeNull());
    return (sessionId: string) =>
      view.rerender(<SessionActivitiesPanel conferenceId={CONFERENCE_ID} sessionId={sessionId} />);
  }

  // ---------- Acceptance Scenario S03: what a member sees, and what a holder sees ----------

  it('shows every member both rounds and their states, and offers no controls', async () => {
    await renderPanel({
      [`GET ${BASE}`]: { status: 200, body: payload([POST_IT, POLL], false) },
    });

    expect(screen.getByTestId(`round-state-${POST_IT.id}`).textContent).toBe('Closed');
    expect(screen.getByTestId(`round-state-${POLL.id}`).textContent).toBe('Open');
    expect(screen.getByTestId(`round-${POST_IT.id}`).dataset.state).toBe('closed');
    expect(screen.getByTestId(`round-${POLL.id}`).dataset.state).toBe('open');

    // The Poll's options, in the order the payload returned them.
    expect(
      [...screen.getByTestId(`round-options-${POLL.id}`).querySelectorAll('li')].map(
        (item) => item.textContent,
      ),
    ).toEqual(['Tooling', 'Meetings', 'Handovers']);

    // No run controls and no authoring form anywhere on the session.
    expect(screen.queryByTestId(`round-open-${POST_IT.id}`)).toBeNull();
    expect(screen.queryByTestId(`round-close-${POLL.id}`)).toBeNull();
    expect(screen.queryByTestId('add-round')).toBeNull();
    expect(screen.queryByTestId('round-form')).toBeNull();
  });

  it('offers the run controls and the authoring form when the server says the caller may run', async () => {
    await renderPanel({
      [`GET ${BASE}`]: { status: 200, body: payload([POST_IT, POLL], true) },
    });

    expect(screen.getByTestId(`round-open-${POST_IT.id}`)).not.toBeNull();
    expect(screen.getByTestId(`round-close-${POST_IT.id}`)).not.toBeNull();
    expect(screen.getByTestId('add-round')).not.toBeNull();
    expect(screen.getByTestId('session-activities').dataset.canRun).toBe('true');
  });

  // ---------- Acceptance Scenario S05: the refusal a poll gives, kept on screen ----------

  it('shows the server’s sentence when a poll refuses to reopen, and keeps the panel', async () => {
    await renderPanel({
      [`GET ${BASE}`]: { status: 200, body: payload([{ ...POLL, state: 'closed' }], true) },
      [`POST ${BASE}/rounds/${POLL.id}/open`]: {
        status: 409,
        body: {
          error: {
            code: 'ROUND_TRANSITION_NOT_PERMITTED',
            message: 'A poll cannot be reopened once its results are shown.',
          },
        },
      },
    });

    await userEvent.click(screen.getByTestId(`round-open-${POLL.id}`));

    const refusal = await screen.findByTestId('activities-refusal');
    expect(refusal.textContent).toBe('A poll cannot be reopened once its results are shown.');
    // The round list is still on screen, still closed – the refusal replaced nothing.
    expect(screen.getByTestId(`round-state-${POLL.id}`).textContent).toBe('Closed');
    expect(screen.getByTestId('round-list')).not.toBeNull();
  });

  // ---------- Acceptance Scenario S07: a field-level refusal keeps what was typed ----------

  it('keeps the typed prompt and options in the form, with the field message beside them', async () => {
    await renderPanel({
      [`GET ${BASE}`]: { status: 200, body: payload([], true) },
      [`POST ${BASE}/rounds`]: {
        status: 400,
        body: {
          error: {
            code: 'ROUND_OPTIONS_INVALID',
            message: 'A poll needs at least 2 answer options, and this one has 1.',
            details: [
              {
                field: 'options',
                message: 'A poll needs at least 2 answer options, and this one has 1.',
              },
            ],
          },
        },
      },
    });

    await userEvent.click(screen.getByTestId('add-round'));
    await userEvent.selectOptions(screen.getByLabelText('Kind'), 'VotingRound');
    await userEvent.type(screen.getByLabelText('Question'), 'Where should we start?');
    await userEvent.type(screen.getByLabelText('Option 1'), 'Tooling');
    await userEvent.click(screen.getByRole('button', { name: /add round/i }));

    const message = await screen.findByTestId('error-options');
    expect(message.textContent).toContain('at least 2');

    // The panel is still mounted and the typed values are still in the form.
    expect(screen.getByTestId('session-activities')).not.toBeNull();
    expect(screen.getByTestId('round-form')).not.toBeNull();
    expect((screen.getByLabelText('Question') as HTMLTextAreaElement).value).toBe(
      'Where should we start?',
    );
    expect((screen.getByLabelText('Option 1') as HTMLInputElement).value).toBe('Tooling');

    // Nothing was sent that names who is acting - the credential decides that (FR3).
    const create = calls.find((call) => call.method === 'POST');
    expect(Object.keys(create!.body as object).sort()).toEqual(
      ['kind', 'options', 'prompt', 'purpose'].sort(),
    );
  });

  it('sends a post-it round with no options and no purpose', async () => {
    await renderPanel({
      [`GET ${BASE}`]: { status: 200, body: payload([], true) },
      [`POST ${BASE}/rounds`]: { status: 200, body: { round: POST_IT } },
    });

    await userEvent.click(screen.getByTestId('add-round'));
    await userEvent.type(screen.getByLabelText('Prompt'), 'What slows us down most?');
    await userEvent.click(screen.getByRole('button', { name: /add round/i }));

    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    expect(calls.find((call) => call.method === 'POST')!.body).toEqual({
      kind: 'PostItRound',
      purpose: null,
      prompt: 'What slows us down most?',
      options: [],
    });
  });

  // ---------- TI08 / TI10: the panel's own watermark poll ----------

  /**
   * The state changes with no user interaction and no remount – the property OC02 names.
   *
   * The wait is on the **number of reads**, which the defect this guards against (a panel that
   * ignores a moved cursor) cannot satisfy, and never on the state being asserted.
   */
  it('follows the round state when the server’s watermark moves, without a reload', async () => {
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(SECOND_WATERMARK),
      [`GET ${BASE}`]: [
        { status: 200, body: payload([POST_IT], false) },
        { status: 200, body: payload([{ ...POST_IT, state: 'open' }], false, SECOND_WATERMARK) },
      ],
    });

    const before = screen.getByTestId(`round-${POST_IT.id}`);
    expect(before.dataset.state).toBe('closed');

    await tick();

    // Synchronised on the second answer landing – something the defect this guards against cannot
    // produce – and then on nothing at all.
    await waitFor(() => expect(answersFor('GET', BASE)).toBe(2));
    await settle();

    expect(screen.getByTestId(`round-${POST_IT.id}`).dataset.state).toBe('open');
    expect(screen.getByTestId(`round-state-${POST_IT.id}`).textContent).toBe('Open');
    // The same element, not a remounted one: nothing about this was a navigation.
    expect(screen.getByTestId(`round-${POST_IT.id}`)).toBe(before);
  });

  /**
   * The whole point of the two-scalar poll: an unchanged cursor costs two scalars and stops there.
   *
   * A panel that refetched the Session on every tick would pass every propagation test in this file
   * while costing the API a full payload per phone per five seconds.
   */
  it('refetches nothing while the watermark is unchanged', async () => {
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: { status: 200, body: payload([POST_IT], false) },
    });

    await tick();
    await waitFor(() => expect(answersFor('GET', WATERMARK)).toBe(1));
    await settle();

    expect(readsOf('GET', BASE)).toBe(1);
  });

  /** A failed refresh leaves the last successful payload exactly as it was. */
  it('keeps the rendered rounds when a refresh fails', async () => {
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(SECOND_WATERMARK),
      [`GET ${BASE}`]: [
        { status: 200, body: payload([POST_IT, POLL], true) },
        { status: 503, body: { error: { code: 'DATABASE_UNAVAILABLE', message: 'Not now.' } } },
      ],
    });

    await tick();
    await waitFor(() => expect(answersFor('GET', BASE)).toBe(2));
    await settle();

    expect(screen.getByTestId('round-list')).not.toBeNull();
    expect(screen.getByTestId(`round-state-${POST_IT.id}`).textContent).toBe('Closed');
    expect(screen.getByTestId(`round-state-${POLL.id}`).textContent).toBe('Open');
    expect(screen.queryByTestId('activities-error')).toBeNull();
  });

  /**
   * The panel is not remounted when the Session changes – both call sites toggle by id at the same
   * element position – so everything held for the Session being left has to be dropped explicitly.
   */
  it('drops the open editor and any refusal when the session changes', async () => {
    const OTHER_ID = '33333333-3333-4333-8333-333333333333';
    const OTHER = `/conferences/${CONFERENCE_ID}/sessions/${OTHER_ID}`;

    const rerender = await renderPanel({
      [`GET ${BASE}`]: { status: 200, body: payload([{ ...POLL, state: 'closed' }], true) },
      [`POST ${BASE}/rounds/${POLL.id}/open`]: {
        status: 409,
        body: {
          error: {
            code: 'ROUND_TRANSITION_NOT_PERMITTED',
            message: 'A poll cannot be reopened once its results are shown.',
          },
        },
      },
      [`GET ${OTHER}`]: { status: 200, body: payload([POST_IT], true) },
    });

    // Both kinds of leftover state: an open editor holding this Session's round, and a refusal.
    await userEvent.click(screen.getByTestId(`round-edit-${POLL.id}`));
    await userEvent.click(screen.getByTestId(`round-open-${POLL.id}`));
    await screen.findByTestId('activities-refusal');
    expect(screen.getByTestId('round-form')).not.toBeNull();

    rerender(OTHER_ID);
    await waitFor(() => expect(answersFor('GET', OTHER)).toBe(1));
    await settle();

    expect(screen.queryByTestId('round-form')).toBeNull();
    expect(screen.queryByTestId('activities-refusal')).toBeNull();
    expect(screen.getByTestId(`round-${POST_IT.id}`)).not.toBeNull();
    expect(screen.queryByTestId(`round-${POLL.id}`)).toBeNull();
  });

  /**
   * The re-read after a *successful* transition is an extra, not the panel's own load. A blip on it
   * must not take the round list away in the middle of a session.
   */
  it('keeps the round list when the re-read after a successful transition fails', async () => {
    await renderPanel({
      [`GET ${BASE}`]: [
        { status: 200, body: payload([POST_IT], true) },
        { status: 503, body: { error: { code: 'DATABASE_UNAVAILABLE', message: 'Not now.' } } },
      ],
      [`POST ${BASE}/rounds/${POST_IT.id}/open`]: {
        status: 200,
        body: { round: { ...POST_IT, state: 'open' } },
      },
    });

    await userEvent.click(screen.getByTestId(`round-open-${POST_IT.id}`));
    await waitFor(() => expect(answersFor('GET', BASE)).toBe(2));
    await settle();

    expect(screen.getByTestId('round-list')).not.toBeNull();
    expect(screen.getByTestId(`round-state-${POST_IT.id}`)).not.toBeNull();
    expect(screen.queryByTestId('activities-error')).toBeNull();
  });

  /**
   * The panel owns no cadence of its own: nothing is asked between ticks of the shared loop.
   *
   * Sixty milliseconds is far inside the shared five-second cadence, so a panel that had kept a
   * timer, or that re-read eagerly, is exactly what would show up here.
   */
  it('issues no request between ticks', async () => {
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: { status: 200, body: payload([POST_IT], false) },
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(readsOf('GET', BASE)).toBe(1);
    expect(readsOf('GET', WATERMARK)).toBe(0);
  });
});
