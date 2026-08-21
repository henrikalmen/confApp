import 'fake-indexeddb/auto';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { JoinConferencePanel } from '../src/components/JoinConferencePanel.tsx';
import { readCachedSchedule, setCacheIdentity } from '../src/offline/schedule-cache.ts';

/**
 * TI10 – the join-code entry screen, and what it leaves an employee able to do after a refusal.
 *
 * PRD User Flow 5 ends "refused with a clear message **and the option to retry**", so the assertions
 * here are mostly about the state of the *controls* after an answer arrives, not about the message
 * text: a screen that shows a perfect refusal and then clears the box or leaves the button disabled
 * has failed the flow while looking fine in a screenshot.
 *
 * The API is driven at the `fetch` boundary, so the real client module – envelope parsing, the
 * request shape, the `/join` path – is exercised rather than mocked past.
 */

interface Route {
  status: number;
  body: unknown;
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}

interface Harness {
  calls: Call[];
}

/**
 * Routes by `METHOD /path`. A key may carry a **list** of answers, which are consumed in order with
 * the last one answering every further call – that is what lets one test refuse, then accept, which
 * is exactly the retry Acceptance Scenario S09 describes.
 */
function routeFetch(routes: Record<string, Route | Route[]>, harness: Harness): typeof fetch {
  const queues = new Map<string, Route[]>(
    Object.entries(routes).map(([key, value]) => [
      key,
      Array.isArray(value) ? [...value] : [value],
    ]),
  );

  return vi.fn(async (input: unknown, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = String(input).replace(/^.*\/api/, '');
    harness.calls.push({
      method,
      path,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });

    const queue = queues.get(`${method} ${path}`);
    if (queue === undefined || queue.length === 0) {
      throw new Error(`No route stubbed for ${method} ${path}.`);
    }
    const route = queue.length > 1 ? queue.shift()! : queue[0]!;

    return new Response(JSON.stringify(route.body), {
      status: route.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

const KICKOFF = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Kickoff 2026',
  startDate: '2026-09-14',
  endDate: '2026-09-16',
  lifecycleState: 'published' as const,
};

const JOINED: Route = { status: 200, body: { conference: KICKOFF } };

const NADIA = 'google-sub-nadia';

/** A real schedule envelope, so the priming write has something the cache will accept. */
const ENVELOPE = {
  conference: {
    id: KICKOFF.id,
    name: KICKOFF.name,
    startDate: KICKOFF.startDate,
    endDate: KICKOFF.endDate,
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
  serverNow: { instant: '2026-09-15T07:40:12.345678Z', day: '2026-09-15', time: '09:40' },
};

/** The server's own envelope, in the server's own words – this suite never invents a message. */
function refused(status: number, code: string, message: string): Route {
  return { status, body: { error: { code, message } } };
}

const UNKNOWN = refused(404, 'JOIN_CODE_UNKNOWN', 'No conference found with that code.');

const ARCHIVED = refused(
  409,
  'JOIN_CONFERENCE_ARCHIVED',
  'That code is for "Retro 2025", which has been archived and can no longer be joined.',
);

const THROTTLED = refused(
  429,
  'JOIN_ATTEMPTS_RATE_LIMITED',
  'That is 10 incorrect codes in a row, so joining is paused for a moment. Check the code with ' +
    'the organizer and try again in about 7 minutes.',
);

function renderPanel(routes: Record<string, Route | Route[]>): Harness {
  const harness: Harness = { calls: [] };
  globalThis.fetch = routeFetch(routes, harness);
  render(<JoinConferencePanel />);
  return harness;
}

/**
 * Only the join attempts.
 *
 * A successful join now also primes the offline Schedule cache (S10 TI03), which is a second,
 * deliberately quiet request on the same path. These assertions are about what the *employee's*
 * submission sent, so the cache warm-up is filtered out rather than being allowed to make the code
 * this panel posted harder to read.
 */
const joinCalls = (harness: Harness): Call[] =>
  harness.calls.filter((call) => call.method === 'POST' && call.path === '/join');

const input = (): HTMLInputElement => screen.getByTestId('join-code-input') as HTMLInputElement;
const submitButton = (): HTMLButtonElement =>
  screen.getByTestId('join-submit') as HTMLButtonElement;

describe('JoinConferencePanel', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    window.__CONFAPP_CONFIG__ = { apiBaseUrl: '/api' };
    globalThis.indexedDB = new IDBFactory();
    setCacheIdentity(() => NADIA);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    setCacheIdentity(() => null);
    vi.restoreAllMocks();
  });

  // ---------- Acceptance Scenario S01 (browser half) ----------

  describe('joining', () => {
    it('offers nothing to submit while the box is empty', () => {
      renderPanel({ 'POST /join': JOINED });
      expect(submitButton().disabled).toBe(true);
    });

    it('sends the code exactly as typed and names the conference joined', async () => {
      const harness = renderPanel({ 'POST /join': JOINED });

      await userEvent.type(input(), 'k7rm4p');
      expect(submitButton().disabled).toBe(false);
      await userEvent.click(submitButton());

      // Sent verbatim: trimming, hyphens and case are the server's single normalization, and a
      // second copy here is how "works in the browser, not on the phone" happens.
      expect(joinCalls(harness)).toEqual([
        { method: 'POST', path: '/join', body: { code: 'k7rm4p' } },
      ]);

      const success = await screen.findByTestId('join-success');
      expect(success.textContent).toContain('Kickoff 2026');
      expect(success.textContent).toContain('2026-09-14');
      expect(screen.queryByTestId('join-refusal')).toBeNull();
    });

    /** Only a success clears the box – there is nothing left to correct. */
    it('clears the box once the join succeeded', async () => {
      renderPanel({ 'POST /join': JOINED });

      await userEvent.type(input(), 'K7RM4P');
      await userEvent.click(submitButton());
      await screen.findByTestId('join-success');

      expect(input().value).toBe('');
    });
  });

  // ---------- Acceptance Scenario S09 (TI10): refused, then corrected on the spot ----------

  describe('after a refusal', () => {
    it('keeps the typed value, keeps the controls usable, and shows the server sentence', async () => {
      renderPanel({ 'POST /join': UNKNOWN });

      await userEvent.type(input(), 'ZZZ999');
      await userEvent.click(submitButton());

      const refusal = await screen.findByTestId('join-refusal');
      // The server's exact sentence, not a rewording.
      expect(refusal.textContent).toContain('No conference found with that code.');

      // The three things the retry depends on.
      expect(input().value).toBe('ZZZ999');
      expect(input().disabled).toBe(false);
      expect(input().readOnly).toBe(false);
      expect(submitButton().disabled).toBe(false);
    });

    /**
     * The scenario end to end: Nadia mistypes, is refused, corrects the code **without reloading the
     * app or signing out**, and joins.
     */
    it('accepts a corrected resubmission from the same screen', async () => {
      const harness = renderPanel({ 'POST /join': [UNKNOWN, JOINED] });

      await userEvent.type(input(), 'K7RM4X');
      await userEvent.click(submitButton());
      await screen.findByTestId('join-refusal');

      // One character corrected, not the whole code retyped.
      await userEvent.type(input(), '{backspace}P');
      expect(input().value).toBe('K7RM4P');

      await userEvent.click(submitButton());

      const success = await screen.findByTestId('join-success');
      expect(success.textContent).toContain('Kickoff 2026');
      // The refusal is gone, replaced by the answer to the code now in the box.
      expect(screen.queryByTestId('join-refusal')).toBeNull();

      expect(joinCalls(harness).map((call) => call.body)).toEqual([
        { code: 'K7RM4X' },
        { code: 'K7RM4P' },
      ]);
    });

    /** Replaced, never stacked: what is on screen is always about the code currently in the box. */
    it('replaces the previous refusal rather than adding to it', async () => {
      renderPanel({ 'POST /join': [UNKNOWN, ARCHIVED] });

      await userEvent.type(input(), 'ZZZ999');
      await userEvent.click(submitButton());
      await screen.findByTestId('join-refusal');

      await userEvent.clear(input());
      await userEvent.type(input(), 'EF45GH');
      await userEvent.click(submitButton());

      await screen.findByText(/Retro 2025/);
      const refusals = screen.getAllByTestId('join-refusal');
      expect(refusals).toHaveLength(1);
      expect(refusals[0]!.textContent).toContain('archived');
      expect(refusals[0]!.textContent).not.toContain('No conference found');
    });

    /** A non-joinable refusal names its own reason and its own conference, in the server's words. */
    it('renders the reason a non-joinable conference was refused for', async () => {
      renderPanel({ 'POST /join': ARCHIVED });

      await userEvent.type(input(), 'EF45GH');
      await userEvent.click(submitButton());

      const refusal = await screen.findByTestId('join-refusal');
      expect(refusal.textContent).toContain('Retro 2025');
      expect(refusal.textContent).toContain('archived');
      // The machine code is surfaced too, so a refusal can be reported without quoting prose.
      expect(refusal.textContent).toContain('JOIN_CONFERENCE_ARCHIVED');
    });

    it('clears a refusal once a later attempt succeeds', async () => {
      renderPanel({ 'POST /join': [UNKNOWN, JOINED] });

      await userEvent.type(input(), 'ZZZ999');
      await userEvent.click(submitButton());
      await screen.findByTestId('join-refusal');

      await userEvent.clear(input());
      await userEvent.type(input(), 'K7RM4P');
      await userEvent.click(submitButton());

      await screen.findByTestId('join-success');
      expect(screen.queryByTestId('join-refusal')).toBeNull();
    });

    it('reports an unreachable server without pretending it was a bad code', async () => {
      // Stubbed directly rather than through `routeFetch`: the subject is a transport failure, which
      // is not a response and therefore not something a route table can express.
      globalThis.fetch = vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }) as unknown as typeof fetch;
      render(<JoinConferencePanel />);

      await userEvent.type(input(), 'K7RM4P');
      await userEvent.click(submitButton());

      const refusal = await screen.findByTestId('join-refusal');
      expect(refusal.textContent).toMatch(/could not reach the server/i);
      // And the value survives, so the attempt is repeatable once the connection is back.
      expect(input().value).toBe('K7RM4P');
      expect(submitButton().disabled).toBe(false);
    });
  });

  // ---------- Acceptance Scenario S09, second half (TI06/TI10): the rate-limit refusal ----------

  describe('when the refusal is the rate-limit one', () => {
    it('states when to try again instead of offering a control certain to fail', async () => {
      renderPanel({ 'POST /join': THROTTLED });

      await userEvent.type(input(), 'ZZZ999');
      await userEvent.click(submitButton());

      const refusal = await screen.findByTestId('join-refusal');
      expect(refusal.textContent).toMatch(/try again in about 7 minutes/i);

      // The one case where the submit is *not* re-enabled at the moment of refusal: pressing it
      // again straight away is certain to fail. That it comes back is asserted below – the pause
      // being momentary is the whole difference between this and a dead end.
      expect(submitButton().disabled).toBe(true);
    });

    /**
     * The pause must lift without a reload.
     *
     * This is the assertion that separates "paused" from "locked out". OC04 states the allowance
     * returns by itself with no unlock step, and on the Capacitor shell there is no address bar to
     * reload from – so a submit control that only a fresh page load could restore would strand the
     * employee exactly when FR3 says not to.
     */
    it('restores the submit control as soon as the code is edited', async () => {
      const harness = renderPanel({ 'POST /join': [THROTTLED, JOINED] });

      await userEvent.type(input(), 'ZZZ999');
      await userEvent.click(submitButton());
      await screen.findByTestId('join-refusal');
      expect(submitButton().disabled).toBe(true);

      // The gesture the refusal itself asks for: check the code, retype it.
      await userEvent.clear(input());
      await userEvent.type(input(), 'K7RM4P');

      // The control is back, and the stale pause message is gone with it.
      expect(submitButton().disabled).toBe(false);
      expect(screen.queryByTestId('join-refusal')).toBeNull();

      // And it genuinely works – the attempt reaches the server rather than being swallowed.
      await userEvent.click(submitButton());
      await screen.findByTestId('join-success');
      expect(joinCalls(harness).map((call) => call.body)).toEqual([
        { code: 'ZZZ999' },
        { code: 'K7RM4P' },
      ]);
    });

    /**
     * The server stays the authority on whether the pause still holds. Editing lifts the *control*,
     * not the limit – if the window has not drained, the next attempt is refused again with a
     * freshly computed wait rather than being allowed through by the client.
     */
    it('is refused again, with an updated wait, if the window has not drained', async () => {
      const later = refused(
        429,
        'JOIN_ATTEMPTS_RATE_LIMITED',
        'That is 10 incorrect codes in a row, so joining is paused for a moment. Check the code ' +
          'with the organizer and try again in about 2 minutes.',
      );
      renderPanel({ 'POST /join': [THROTTLED, later] });

      await userEvent.type(input(), 'ZZZ999');
      await userEvent.click(submitButton());
      await screen.findByText(/in about 7 minutes/i);

      await userEvent.clear(input());
      await userEvent.type(input(), 'K7RM4P');
      await userEvent.click(submitButton());

      await screen.findByText(/in about 2 minutes/i);
      expect(screen.getAllByTestId('join-refusal')).toHaveLength(1);
      expect(submitButton().disabled).toBe(true);
    });

    /**
     * The field stays editable even then. The employee's next action is to check the code against the
     * slide, and a read-only box is exactly the wrong affordance for that.
     */
    it('leaves the field editable so the code can still be checked and corrected', async () => {
      renderPanel({ 'POST /join': THROTTLED });

      await userEvent.type(input(), 'ZZZ999');
      await userEvent.click(submitButton());
      await screen.findByTestId('join-refusal');

      expect(input().disabled).toBe(false);
      expect(input().readOnly).toBe(false);

      await userEvent.clear(input());
      await userEvent.type(input(), 'K7RM4P');
      expect(input().value).toBe('K7RM4P');
    });

    /**
     * Pressing the disabled control changes nothing – it does not queue an attempt that would spend
     * the allowance the employee is waiting to get back. Editing the code is the way out, not this.
     */
    it('issues no request when the paused control is pressed again', async () => {
      const harness = renderPanel({ 'POST /join': THROTTLED });

      await userEvent.type(input(), 'ZZZ999');
      await userEvent.click(submitButton());
      await screen.findByTestId('join-refusal');

      await userEvent.click(submitButton());
      expect(joinCalls(harness)).toHaveLength(1);
    });
  });

  // ---------- S10 TI03 and TI09: priming the cache, and refusing to queue anything ----------

  describe('a successful join', () => {
    /**
     * Joining online has to be enough to read the Schedule offline afterwards, so the join primes
     * the cache instead of waiting for the employee to open the schedule view. Somebody who joins in
     * the lobby and loses signal in the hall has still never opened it, and is exactly the person
     * the offline story exists for.
     */
    it('caches the schedule, so joining online is enough to read it offline', async () => {
      const harness = renderPanel({
        'POST /join': JOINED,
        [`GET /conferences/${KICKOFF.id}/schedule`]: { status: 200, body: ENVELOPE },
      });

      await userEvent.type(input(), 'K7RM4P');
      await userEvent.click(submitButton());
      await screen.findByTestId('join-success');

      await waitFor(() =>
        expect(
          harness.calls.some(
            (call) => call.method === 'GET' && call.path === `/conferences/${KICKOFF.id}/schedule`,
          ),
        ).toBe(true),
      );

      /*
       * The request alone proves nothing - the whole claim is that an *entry* exists afterwards, so
       * an attendee who never opens the schedule view can still read it with no connection. An
       * earlier version of this test stubbed an empty body, which the cache quietly refused, and it
       * stayed green with the write removed entirely.
       */
      await waitFor(async () => {
        const cached = await readCachedSchedule(NADIA, KICKOFF.id);
        expect(cached).not.toBeNull();
        expect(cached!.envelope.days[0]!.sessions[0]!.startTime).toBe('09:00');
      });
    });

    /** A failure to warm a cache nobody asked for is not something to put on the join screen. */
    it('still reports the join when the cache could not be warmed', async () => {
      renderPanel({ 'POST /join': JOINED });

      await userEvent.type(input(), 'K7RM4P');
      await userEvent.click(submitButton());

      const success = await screen.findByTestId('join-success');
      expect(success.textContent).toContain('Kickoff 2026');
      expect(screen.queryByTestId('join-refusal')).toBeNull();
    });
  });

  describe('while the device is offline', () => {
    beforeEach(() => {
      Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    });

    afterEach(() => {
      Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    });

    /**
     * Joining is a write, and offline scope is read-only (FR8). The control says a connection is
     * required rather than accepting a code into a queue nobody would be told about - a queue is
     * the first step into sync and conflict resolution, which the product rejects outright.
     */
    it('refuses to join, says a connection is required, and queues nothing', async () => {
      const harness = renderPanel({ 'POST /join': JOINED });

      await userEvent.type(input(), 'K7RM4P');

      expect(submitButton().disabled).toBe(true);
      expect(screen.getByTestId('join-offline').textContent).toMatch(
        /nothing is saved to send later/i,
      );

      await userEvent.click(submitButton());
      expect(harness.calls).toEqual([]);

      // And the connection returning submits nothing that was typed while it was gone.
      Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
      window.dispatchEvent(new Event('online'));
      await waitFor(() => expect(submitButton().disabled).toBe(false));
      expect(harness.calls).toEqual([]);
    });
  });
});
