import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DisplayLinkControl } from '../src/activities/DisplayLinkControl.tsx';
import { setTokenSource } from '../src/api/client.ts';

/**
 * The Facilitator's issue / show / revoke controls, on their own device (S04 TI13).
 *
 * Two disciplines from `docs/LEARNINGS.md`:
 *
 *   - **a refusal is rendered outside every subtree its own handler replaces**, so a failed issue
 *     leaves both the message and the control on screen. Asserted by failing the write and then
 *     reading the DOM, not by inspecting where the state lives.
 *   - **every assertion is on the rendered surface**, never on a request count alone.
 *
 * The panel's own gate - these controls exist only where `canRun` is true - is asserted in
 * `web/test/SessionActivitiesPanel.tsx`'s neighbourhood via the panel, and enforced server-side
 * regardless (`api/test/display-link.integration.test.ts`).
 *
 * `web/` has no jest-dom, so assertions are on plain DOM properties.
 */

const CONFERENCE_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const ROUND_ID = 'round-post-it';
const PATH = `/conferences/${CONFERENCE_ID}/sessions/${SESSION_ID}/rounds/${ROUND_ID}/display-link`;

const FIRST = 'wJq3B7nVYt1sK0pLmXcZaR8dEfGhIjKlMnOpQrStUvW';
const SECOND = 'QQ3B7nVYt1sK0pLmXcZaR8dEfGhIjKlMnOpQrStUvZ';

interface Route {
  status: number;
  body?: unknown;
}

const calls: { method: string; path: string; body: unknown }[] = [];

function routeFetch(routes: Record<string, Route | Route[]>): typeof fetch {
  return vi.fn(async (input: unknown, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = String(input).replace(/^.*\/api/, '');
    const seen = calls.filter((call) => call.method === method && call.path === path).length;
    calls.push({
      method,
      path,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });

    const entry = routes[`${method} ${path}`];
    if (entry === undefined) throw new Error(`No route stubbed for ${method} ${path}.`);
    const route = Array.isArray(entry) ? (entry[Math.min(seen, entry.length - 1)] as Route) : entry;

    if (route.status === 0) throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(route.body), {
      status: route.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

function link(token: string) {
  return { displayLink: { token, issuedAt: '2026-09-15T09:00:00.000000Z' } };
}

const WEB_ORIGIN = 'https://confapp.ourcompany.example';

beforeEach(() => {
  calls.length = 0;
  setTokenSource(async () => 'an-id-token');
  // The deployment's own address, as the container writes it at start. jsdom's origin is
  // http://localhost, so without this the assertions below would be reading the test harness.
  window.__CONFAPP_CONFIG__ = { ...window.__CONFAPP_CONFIG__, webBaseUrl: WEB_ORIGIN };
});

afterEach(() => {
  setTokenSource(async () => null);
  delete window.__CONFAPP_CONFIG__;
  vi.unstubAllGlobals();
});

function mount() {
  return render(
    <DisplayLinkControl conferenceId={CONFERENCE_ID} sessionId={SESSION_ID} roundId={ROUND_ID} />,
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe('the display link controls', () => {
  it('offers issue when no link is live, and says the board works without one', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch({ [`GET ${PATH}`]: { status: 200, body: { displayLink: null } } }),
    );
    mount();
    await settle();

    expect(screen.getByTestId(`display-link-issue-${ROUND_ID}`)).toBeTruthy();
    expect(screen.queryByTestId(`display-link-url-${ROUND_ID}`)).toBeNull();
    expect(screen.getByTestId(`display-link-none-${ROUND_ID}`).textContent).toMatch(
      /fully usable without one/i,
    );
  });

  it('shows a copyable value and a revoke control once issued', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      routeFetch({
        [`GET ${PATH}`]: { status: 200, body: { displayLink: null } },
        [`POST ${PATH}`]: { status: 200, body: link(FIRST) },
      }),
    );
    mount();
    await settle();

    await user.click(screen.getByTestId(`display-link-issue-${ROUND_ID}`));
    await waitFor(() => expect(screen.getByTestId(`display-link-url-${ROUND_ID}`)).toBeTruthy());

    const field = screen.getByTestId(`display-link-url-${ROUND_ID}`) as HTMLInputElement;
    /*
     * A **literal** expected origin, set by this test, not `window.location.origin`. Restating the
     * implementation's own expression is how the one assertion covering the story's user-visible
     * output stops being able to fail for the reason it exists (review 2026-08-31, finding 6): both
     * sides would move together under any origin, including one no room machine can open.
     */
    expect(field.value).toBe(`https://confapp.ourcompany.example/display/${FIRST}`);
    expect(field.value).not.toContain('?');
    expect(field.readOnly).toBe(true);

    expect(screen.getByTestId(`display-link-revoke-${ROUND_ID}`)).toBeTruthy();
    expect(screen.getByTestId(`display-link-issued-${ROUND_ID}`).textContent).toMatch(/live/i);

    /*
     * `userEvent.setup()` installs its own clipboard stub, which is the one the component reaches -
     * so this reads what actually landed there rather than what the component was asked to write.
     */
    await user.click(screen.getByTestId(`display-link-copy-${ROUND_ID}`));
    await waitFor(() =>
      expect(screen.getByTestId(`display-link-copy-${ROUND_ID}`).textContent).toBe('Copied'),
    );
    expect(await navigator.clipboard.readText()).toBe(field.value);

    // The request named no link and carried no actor - the credential is the actor.
    expect(calls.filter((call) => call.method === 'POST').map((call) => call.body)).toEqual([
      undefined,
    ]);
  });

  /**
   * Inside the Capacitor shells the WebView origin is `capacitor://localhost` (iOS) or
   * `https://localhost` (Android), and a link built from it is unopenable by any room machine -
   * in a field that looks entirely plausible (review 2026-08-31, finding 2). With no `webBaseUrl`
   * configured, the control must say so rather than show one.
   */
  it('shows the token and says why, when this build cannot state an openable address', async () => {
    delete window.__CONFAPP_CONFIG__;
    const original = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, protocol: 'capacitor:', origin: 'capacitor://localhost' },
    });

    try {
      vi.stubGlobal('fetch', routeFetch({ [`GET ${PATH}`]: { status: 200, body: link(FIRST) } }));
      mount();
      await waitFor(() => expect(screen.getByTestId(`display-link-url-${ROUND_ID}`)).toBeTruthy());

      const field = screen.getByTestId(`display-link-url-${ROUND_ID}`) as HTMLInputElement;
      expect(field.value).toBe(FIRST);
      expect(field.value).not.toContain('capacitor://');
      expect(field.value).not.toContain('localhost');
      expect(screen.getByTestId(`display-link-issued-${ROUND_ID}`).textContent).toMatch(
        /cannot say what web address/i,
      );
      // Revoking still works: withdrawal must never depend on being able to name the address.
      expect(screen.getByTestId(`display-link-revoke-${ROUND_ID}`)).toBeTruthy();
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });

  it('replaces the displayed value on a second issue', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      routeFetch({
        [`GET ${PATH}`]: { status: 200, body: link(FIRST) },
        [`POST ${PATH}`]: { status: 200, body: link(SECOND) },
      }),
    );
    mount();
    await waitFor(() =>
      expect(
        (screen.getByTestId(`display-link-url-${ROUND_ID}`) as HTMLInputElement).value,
      ).toContain(FIRST),
    );

    await user.click(screen.getByTestId(`display-link-reissue-${ROUND_ID}`));
    await waitFor(() =>
      expect(
        (screen.getByTestId(`display-link-url-${ROUND_ID}`) as HTMLInputElement).value,
      ).toContain(SECOND),
    );
    // One value at a time: the replaced one is nowhere on the surface any more.
    expect(document.body.textContent).not.toContain(FIRST);
  });

  it('clears the value on revoke and leaves issue available', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      routeFetch({
        [`GET ${PATH}`]: { status: 200, body: link(FIRST) },
        [`DELETE ${PATH}`]: { status: 200, body: { displayLink: null } },
      }),
    );
    mount();
    await waitFor(() => expect(screen.getByTestId(`display-link-revoke-${ROUND_ID}`)).toBeTruthy());

    await user.click(screen.getByTestId(`display-link-revoke-${ROUND_ID}`));
    await waitFor(() => expect(screen.getByTestId(`display-link-issue-${ROUND_ID}`)).toBeTruthy());

    expect(screen.queryByTestId(`display-link-url-${ROUND_ID}`)).toBeNull();
    expect(document.body.textContent).not.toContain(FIRST);
  });

  /**
   * The refusal stands where its own handler cannot take it away
   * (`docs/LEARNINGS.md#react-state--refusals`): the message and the control it belongs to are both
   * still on screen after a failed write.
   */
  it('leaves the panel and its message on screen after a failed issue', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      routeFetch({
        [`GET ${PATH}`]: { status: 200, body: { displayLink: null } },
        [`POST ${PATH}`]: {
          status: 403,
          body: {
            error: {
              code: 'CONFERENCE_ROLE_REQUIRED',
              message: 'You do not have permission to do this in this conference.',
            },
          },
        },
      }),
    );
    mount();
    await settle();

    await user.click(screen.getByTestId(`display-link-issue-${ROUND_ID}`));
    await waitFor(() => expect(screen.getByTestId(`display-link-error-${ROUND_ID}`)).toBeTruthy());

    // The server's own sentence, and the control is still there to try again with.
    expect(screen.getByTestId(`display-link-error-${ROUND_ID}`).textContent).toBe(
      'You do not have permission to do this in this conference.',
    );
    expect(screen.getByTestId(`display-link-issue-${ROUND_ID}`)).toBeTruthy();
    expect(screen.getByTestId(`display-link-${ROUND_ID}`)).toBeTruthy();
    // Nothing was shown as issued.
    expect(screen.queryByTestId(`display-link-url-${ROUND_ID}`)).toBeNull();
  });

  it('reaches every control by keyboard alone', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      routeFetch({
        [`GET ${PATH}`]: { status: 200, body: link(FIRST) },
        [`DELETE ${PATH}`]: { status: 200, body: { displayLink: null } },
      }),
    );
    mount();
    await waitFor(() => expect(screen.getByTestId(`display-link-revoke-${ROUND_ID}`)).toBeTruthy());

    const revoke = screen.getByTestId(`display-link-revoke-${ROUND_ID}`);
    let reached = false;
    for (let step = 0; step < 40 && !reached; step += 1) {
      await user.tab();
      reached = document.activeElement === revoke;
    }
    expect(reached, 'revoke should be reachable by keyboard').toBe(true);

    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByTestId(`display-link-issue-${ROUND_ID}`)).toBeTruthy());
  });
});
