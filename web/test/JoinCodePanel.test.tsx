import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { JoinCodePanel } from '../src/components/JoinCodePanel.tsx';

/**
 * TI07 / TI08 – the Organizer's code panel, in the browser.
 *
 * The server side of both tasks is settled in `api/test/join-code.integration.test.ts`: who may see a
 * code, that regenerating replaces it immediately, and that no Attendee is removed. What is left for
 * this suite is what the Organizer is actually *told* – that a draft has no code yet, that the value
 * on screen is the one the server holds rather than one the client assumed, and that the consequence
 * of regenerating is stated before the button is pressed rather than discovered afterwards.
 *
 * The API is driven at the `fetch` boundary, so the real client module is exercised rather than
 * mocked past.
 */

interface Route {
  status: number;
  body: unknown;
}

interface Call {
  method: string;
  path: string;
}

interface Harness {
  calls: Call[];
}

/** Routes by `METHOD /path`; a list is consumed in order with the last answer sticking. */
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
    harness.calls.push({ method, path });

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

const CONFERENCE_ID = '11111111-1111-4111-8111-111111111111';
const CODE_PATH = `GET /conferences/${CONFERENCE_ID}/join-code`;
const REGENERATE_PATH = `POST /conferences/${CONFERENCE_ID}/join-code/regenerate`;

function serving(joinCode: string | null, lifecycleState = 'published'): Route {
  return { status: 200, body: { conferenceId: CONFERENCE_ID, joinCode, lifecycleState } };
}

function refused(status: number, code: string, message: string): Route {
  return { status, body: { error: { code, message } } };
}

function renderPanel(routes: Record<string, Route | Route[]>, published = true): Harness {
  const harness: Harness = { calls: [] };
  globalThis.fetch = routeFetch(routes, harness);
  render(<JoinCodePanel conferenceId={CONFERENCE_ID} published={published} />);
  return harness;
}

const regenerateButton = (): HTMLButtonElement =>
  screen.getByTestId('regenerate-join-code') as HTMLButtonElement;

describe('JoinCodePanel', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    window.__CONFAPP_CONFIG__ = { apiBaseUrl: '/api' };
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  // ---------- TI07: the code exists from publication onwards, and not before ----------

  describe('a draft', () => {
    it('says there is no code yet and explains what creates one', () => {
      renderPanel({}, false);

      const hint = screen.getByTestId('join-code-unpublished');
      expect(hint.textContent).toMatch(/no join code yet/i);
      expect(hint.textContent).toMatch(/publishing/i);

      // No value, and nothing to regenerate.
      expect(screen.queryByTestId('join-code-value')).toBeNull();
      expect(screen.queryByTestId('regenerate-join-code')).toBeNull();
    });

    /** There is nothing to ask for, so it does not ask – an empty box would be the wrong answer. */
    it('requests no code at all', () => {
      const harness = renderPanel({}, false);
      expect(harness.calls).toEqual([]);
    });
  });

  // ---------- TI07: the Admin sees the current code ----------

  describe('a published conference', () => {
    it('shows the code the server holds', async () => {
      const harness = renderPanel({ [CODE_PATH]: serving('K7RM4P') });

      const value = await screen.findByTestId('join-code-value');
      expect(value.textContent).toBe('K7RM4P');

      // Read from its own endpoint – the code deliberately does not ride along on the conference
      // payload, so only this one authorized surface discloses it.
      expect(harness.calls).toEqual([
        { method: 'GET', path: `/conferences/${CONFERENCE_ID}/join-code` },
      ]);
      expect(screen.queryByTestId('join-code-unpublished')).toBeNull();
    });

    /** The consequence is stated before the action, because the code is already on a slide. */
    it('states up front that regenerating is immediate and removes nobody', async () => {
      renderPanel({ [CODE_PATH]: serving('K7RM4P') });
      await screen.findByTestId('join-code-value');

      const panel = screen.getByTestId('join-code-panel');
      expect(panel.textContent).toMatch(/old one stops working/i);
      expect(panel.textContent).toMatch(/stays joined|stay joined/i);

      // Said before the button is pressed, not only afterwards.
      expect(screen.queryByTestId('join-code-replaced')).toBeNull();
      expect(regenerateButton().disabled).toBe(false);
    });

    it('reports a failure to load the code without inventing a value', async () => {
      renderPanel({
        [CODE_PATH]: refused(
          403,
          'CONFERENCE_ROLE_REQUIRED',
          'You do not have permission to do this in this conference.',
        ),
      });

      const error = await screen.findByTestId('join-code-error');
      expect(error.textContent).toContain('You do not have permission');
      expect(screen.queryByTestId('join-code-value')).toBeNull();
      expect(screen.queryByTestId('regenerate-join-code')).toBeNull();
    });
  });

  // ---------- Acceptance Scenario S06 (TI08): regenerating ----------

  describe('regenerating', () => {
    it('replaces the displayed code with the new one and says the old is dead', async () => {
      renderPanel({
        [CODE_PATH]: serving('K7RM4P'),
        [REGENERATE_PATH]: serving('Q4XT8B'),
      });
      await screen.findByTestId('join-code-value');

      await userEvent.click(regenerateButton());

      // The value on screen is the server's new one, not a locally guessed one.
      const value = await screen.findByTestId('join-code-value');
      expect(value.textContent).toBe('Q4XT8B');

      const replaced = screen.getByTestId('join-code-replaced');
      expect(replaced.textContent).toMatch(/previous one no longer works/i);
      // The reassurance an Organizer actually wants at that moment.
      expect(replaced.textContent).toMatch(/nobody who had already joined was removed/i);
    });

    it('asks the server exactly once, at the regenerate endpoint', async () => {
      const harness = renderPanel({
        [CODE_PATH]: serving('K7RM4P'),
        [REGENERATE_PATH]: serving('Q4XT8B'),
      });
      await screen.findByTestId('join-code-value');

      await userEvent.click(regenerateButton());
      await screen.findByTestId('join-code-replaced');

      expect(harness.calls).toEqual([
        { method: 'GET', path: `/conferences/${CONFERENCE_ID}/join-code` },
        { method: 'POST', path: `/conferences/${CONFERENCE_ID}/join-code/regenerate` },
      ]);
    });

    it('renders the server refusal and leaves the existing code on screen', async () => {
      renderPanel({
        [CODE_PATH]: serving('K7RM4P'),
        [REGENERATE_PATH]: refused(
          403,
          'CONFERENCE_ROLE_REQUIRED',
          'You do not have permission to do this in this conference.',
        ),
      });
      await screen.findByTestId('join-code-value');

      await userEvent.click(regenerateButton());

      const refusal = await screen.findByTestId('join-code-refusal');
      expect(refusal.textContent).toContain('You do not have permission');

      // The refused request changed nothing, so the code the Organizer is sharing still shows.
      expect(screen.getByTestId('join-code-value').textContent).toBe('K7RM4P');
      expect(screen.queryByTestId('join-code-replaced')).toBeNull();
      // And the control is usable again rather than stuck mid-action.
      expect(regenerateButton().disabled).toBe(false);
    });

    it('reports an unreachable server and keeps the code visible', async () => {
      globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
        // The initial read succeeds; the regenerate is the call that cannot get through.
        if ((init?.method ?? 'GET') === 'GET') {
          return new Response(
            JSON.stringify({
              conferenceId: CONFERENCE_ID,
              joinCode: 'K7RM4P',
              lifecycleState: 'published',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        void input;
        throw new TypeError('Failed to fetch');
      }) as unknown as typeof fetch;

      render(<JoinCodePanel conferenceId={CONFERENCE_ID} published />);
      await screen.findByTestId('join-code-value');

      await userEvent.click(regenerateButton());

      const refusal = await screen.findByTestId('join-code-refusal');
      expect(refusal.textContent).toMatch(/could not reach the server/i);
      expect(screen.getByTestId('join-code-value').textContent).toBe('K7RM4P');
    });
  });

  /**
   * An archived conference keeps its code. Archiving deletes nothing (FR9), and an Organizer still
   * needs to see what the code on last year's slide was – any attempt to use it is refused as
   * archived by the server, which is where that decision belongs.
   */
  it('still shows the code of an archived conference', async () => {
    renderPanel({ [CODE_PATH]: serving('EF45GH', 'archived') });

    const value = await screen.findByTestId('join-code-value');
    expect(value.textContent).toBe('EF45GH');
  });
});
