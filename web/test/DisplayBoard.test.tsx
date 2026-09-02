import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { DisplayBoardView } from '../src/display/DisplayBoardView.tsx';
import { displayTokenFrom } from '../src/display/display-token.ts';
import { setTokenSource } from '../src/api/client.ts';

/**
 * The projected Board on the room machine (S04 TI09, TI14).
 *
 * Two properties carry the whole story here, and both are asserted against what the *component*
 * does rather than against what it was told to do:
 *
 *   - **no credential is involved, in any direction.** The request carries no `Authorization`
 *     header, the token source is never consulted, and a refusal never becomes a sign-in prompt -
 *     there is no sign-in on this surface to prompt for. The token source is deliberately armed
 *     with a value that would be sent if anything asked for one, so "no header" is a fact rather
 *     than a consequence of there being nothing to send.
 *   - **revocation reaches the screen on the poll**, with nothing touching the machine.
 *
 * `web/` has no jest-dom, so assertions are on plain DOM properties.
 */

const TOKEN = 'wJq3B7nVYt1sK0pLmXcZaR8dEfGhIjKlMnOpQrStUvW';

const calls: { path: string; headers: Record<string, string>; method: string }[] = [];

interface Route {
  status: number;
  body?: unknown;
}

/** Answers in order; the last entry repeats, which is what makes a poll's Nth tick statable. */
function routeFetch(sequence: Route[]): typeof fetch {
  return vi.fn(async (input: unknown, init?: RequestInit) => {
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>),
    );
    calls.push({
      path: String(input).replace(/^.*\/api/, ''),
      headers,
      method: init?.method ?? 'GET',
    });
    const route = sequence[Math.min(calls.length - 1, sequence.length - 1)]!;
    if (route.status === 0) throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(route.body), {
      status: route.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

const BOARD = {
  prompt: 'What slowed us down this quarter?',
  categories: [
    {
      id: 'cat-tooling',
      name: 'Tooling',
      postIts: [
        { id: 'p-1', text: 'Review queue backed up on Fridays', authorName: 'Ada Lovelace' },
      ],
      postItCount: 1,
    },
  ],
  uncategorised: {
    postIts: [{ id: 'p-2', text: 'Waiting three days for test data', authorName: 'Bo Nilsson' }],
    postItCount: 1,
  },
};

const UNAVAILABLE = {
  error: { code: 'DISPLAY_LINK_UNAVAILABLE', message: 'This board is no longer available.' },
};

let tokenSourceAsked = 0;

beforeEach(() => {
  calls.length = 0;
  tokenSourceAsked = 0;
  /*
   * Armed with a real value on purpose. If anything on this path asked for a credential it would
   * get one, and the header assertion below would fail - which is what makes "no Authorization
   * header" a property of the request rather than of there being nothing available to send.
   */
  setTokenSource(async () => {
    tokenSourceAsked += 1;
    return 'a-signed-in-employees-id-token';
  });
});

afterEach(() => {
  setTokenSource(async () => null);
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe('reading the token out of the projected URL', () => {
  it('takes it from the path, and refuses nothing else', () => {
    expect(displayTokenFrom(`/display/${TOKEN}`)).toBe(TOKEN);
    expect(displayTokenFrom(`/display/${TOKEN}/`)).toBe(TOKEN);
    expect(displayTokenFrom('/display/')).toBeNull();
    expect(displayTokenFrom('/')).toBeNull();
    expect(displayTokenFrom('/conferences/abc')).toBeNull();
  });

  /**
   * A value that could not be a token is **not** refused for its shape - it is passed along and
   * reaches the same neutral answer a real-but-dead token does. Anything that told the two apart
   * would be an oracle handed to a browser holding no credential.
   */
  it('passes a wrong-shaped value along rather than judging it', () => {
    expect(displayTokenFrom('/display/nope')).toBe('nope');
    expect(displayTokenFrom('/display/%20%20')).toBe('  ');
  });
});

describe('the projected board', () => {
  it('renders the board for a viewer who has never signed in, with no credential sent', async () => {
    vi.stubGlobal('fetch', routeFetch([{ status: 200, body: BOARD }]));

    render(<DisplayBoardView token={TOKEN} />);
    await waitFor(() => expect(screen.getByTestId('display-board')).toBeTruthy());

    expect(screen.getByTestId('display-prompt').textContent).toBe(BOARD.prompt);
    expect(screen.getByTestId('display-post-it-p-1').textContent).toContain(
      'Review queue backed up on Fridays',
    );
    // Under the author's name: post-its always carry it, and that is the point of the projection.
    expect(screen.getByTestId('display-post-it-p-1').textContent).toContain('Ada Lovelace');
    // The count pill is the server's `postItCount`, drawn as the number S01's projected wireframe
    // draws - the one thing beside the Category name that never degrades at any detail tier.
    expect(screen.getByTestId('display-uncategorised-count').textContent).toBe('1');
    expect(screen.getByTestId('display-category-cat-tooling').textContent).toContain('Tooling');

    // The token travelled in the path, and nothing else travelled at all.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe(`/display/${TOKEN}`);
    expect(calls[0]!.method).toBe('GET');
    expect(Object.keys(calls[0]!.headers).map((key) => key.toLowerCase())).not.toContain(
      'authorization',
    );
    expect(tokenSourceAsked).toBe(0);
  });

  it('takes no input that could change the board', async () => {
    vi.stubGlobal('fetch', routeFetch([{ status: 200, body: BOARD }]));
    render(<DisplayBoardView token={TOKEN} />);
    await waitFor(() => expect(screen.getByTestId('display-board')).toBeTruthy());

    const board = screen.getByTestId('display-board');
    expect(board.querySelectorAll('button, input, select, textarea, a, form')).toHaveLength(0);
    expect(board.querySelectorAll('[contenteditable], [draggable="true"]')).toHaveLength(0);
    expect(board.querySelectorAll('[tabindex]')).toHaveLength(0);
  });

  it('renders the neutral message for a refused token, and never a sign-in prompt', async () => {
    vi.stubGlobal('fetch', routeFetch([{ status: 404, body: UNAVAILABLE }]));

    render(<DisplayBoardView token={'z'.repeat(43)} />);
    await waitFor(() => expect(screen.getByTestId('display-unavailable')).toBeTruthy());

    expect(screen.getByTestId('display-message').textContent).toBe(
      'This board is no longer available.',
    );
    expect(document.body.textContent).not.toMatch(/sign in|sign-in|google|log in/i);
    expect(tokenSourceAsked).toBe(0);
  });

  it('renders the neutral message when the URL named no token at all', async () => {
    vi.stubGlobal('fetch', routeFetch([{ status: 200, body: BOARD }]));
    render(<DisplayBoardView token={null} />);
    await settle();

    expect(screen.getByTestId('display-message').textContent).toBe(
      'This board is no longer available.',
    );
    // And nothing was asked of the API, because there is nothing to ask about.
    expect(calls).toHaveLength(0);
  });

  /**
   * Acceptance Scenario S02, on this side of the seam: the projected page carries **no cursor**.
   *
   * S07 gave this surface the room machine's re-read loop - a third call site of the one cadence in
   * `web/src` (`poll/use-watermark-poll.ts`), never a second mechanism - and its cadence, staleness
   * and refusal-versus-failure behaviour are proved in `ProjectedBoardView.test.tsx`. What stays
   * true here, and is what S04 actually settled, is that one mount produces exactly one resolution
   * request and asks for nothing else: no watermark, no activity cursor, no delta parameter. The
   * activity watermark is Membership-gated and a room machine has no Membership, which is why the
   * whole (cheap, one-Round) payload is re-read instead.
   */
  it('asks for the board and for no cursor of any kind', async () => {
    vi.stubGlobal('fetch', routeFetch([{ status: 200, body: BOARD }]));
    render(<DisplayBoardView token={TOKEN} />);
    await waitFor(() => expect(screen.getByTestId('display-board')).toBeTruthy());

    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe(`/display/${TOKEN}`);
    for (const call of calls) {
      expect(call.path).not.toMatch(/watermark|activities|since|cursor|after=/i);
      expect(Object.keys(call.headers).map((key) => key.toLowerCase())).not.toContain(
        'if-none-match',
      );
    }
  });

  /**
   * A server error is **not** allowed to reach the wall in its own words (review 2026-08-31, L5).
   *
   * The refusal branch used to render whatever message any answered failure carried, which would
   * put an internal-error string, or a proxy's 502 text, in front of a room. The discipline this
   * story turns on is that a dead link says one sentence and nothing else, and delegating that
   * entirely to the server means the day a second code reaches this route, the oracle appears on
   * the projector rather than being contained here.
   */
  it('renders the one neutral sentence for any answered failure, not the server’s words', async () => {
    for (const body of [
      {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'The server encountered an unexpected problem handling this request.',
        },
      },
      { error: { code: 'DATABASE_UNAVAILABLE', message: 'The database is not reachable.' } },
      null,
    ]) {
      vi.stubGlobal('fetch', routeFetch([{ status: body === null ? 502 : 500, body }]));
      const view = render(<DisplayBoardView token={TOKEN} />);
      await waitFor(() => expect(screen.getByTestId('display-message')).toBeTruthy());

      expect(screen.getByTestId('display-message').textContent).toBe(
        'This board is no longer available.',
      );
      expect(document.body.textContent).not.toMatch(/unexpected problem|database|502/i);
      view.unmount();
      calls.length = 0;
    }
  });

  /**
   * A transport failure is **not** the refusal. Collapsing the two would leave a room reading "no
   * longer available" through a Wi-Fi blip, and somebody would reissue a link that was never dead.
   */
  it('says something different when the network is gone', async () => {
    vi.stubGlobal('fetch', routeFetch([{ status: 0 }]));
    render(<DisplayBoardView token={TOKEN} />);
    await waitFor(() => expect(screen.getByTestId('display-message')).toBeTruthy());

    expect(screen.getByTestId('display-message').textContent).not.toBe(
      'This board is no longer available.',
    );
    expect(screen.getByTestId('display-message').textContent).toMatch(/cannot be reached/i);
  });

  /**
   * The Discovered Requirement propagated from S02: **do not inherit the SPA's absent-Board
   * default**. A payload that carries no board is not a board with nothing on it, and rendering
   * "no post-its" for one would be a positive claim the API deliberately declined to make.
   */
  it('refuses a payload with no board rather than rendering an empty one', async () => {
    vi.stubGlobal('fetch', routeFetch([{ status: 200, body: { prompt: 'Something' } }]));
    render(<DisplayBoardView token={TOKEN} />);
    await waitFor(() => expect(screen.getByTestId('display-message')).toBeTruthy());

    expect(screen.queryByTestId('display-board')).toBeNull();
    expect(screen.queryByTestId('display-uncategorised')).toBeNull();
    expect(document.body.textContent).not.toMatch(/0 post-its|no post-its/i);
  });

  /**
   * **Every half the surface renders, including the counts** (S07, 2026-08-31, review M3).
   *
   * The guard used to stop at "categories is an array" and "uncategorised has a postIts array", so a
   * payload carrying no `postItCount` reached the projection - whose most prominent, never-degrading
   * element *is* the count. The room would have read an empty pill and a band saying `NaN post-its`.
   * A guard that exists to refuse a payload rather than fill it in has to cover what is rendered.
   */
  it('refuses a board whose regions are missing the fields the projection renders', async () => {
    const cases: [string, unknown][] = [
      [
        'uncategorised with no count',
        { ...BOARD, uncategorised: { postIts: BOARD.uncategorised.postIts } },
      ],
      [
        'a category with no count',
        { ...BOARD, categories: [{ id: 'c-1', name: 'Tooling', postIts: [] }] },
      ],
      [
        'a category with no name',
        { ...BOARD, categories: [{ id: 'c-1', postIts: [], postItCount: 0 }] },
      ],
      [
        'a category with no id',
        { ...BOARD, categories: [{ name: 'Tooling', postIts: [], postItCount: 0 }] },
      ],
      [
        'a count that is not a number',
        { ...BOARD, uncategorised: { postIts: [], postItCount: null } },
      ],
    ];

    for (const [name, body] of cases) {
      vi.stubGlobal('fetch', routeFetch([{ status: 200, body }]));
      const view = render(<DisplayBoardView token={TOKEN} />);
      await waitFor(() => expect(screen.getByTestId('display-message')).toBeTruthy());

      expect(screen.queryByTestId('display-board'), name).toBeNull();
      expect(document.body.textContent, name).not.toMatch(/NaN/);
      view.unmount();
      calls.length = 0;
    }
  });

  /** An empty Board really is empty, and says so through the server's own counts. */
  it('renders a board that genuinely holds nothing', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch([
        {
          status: 200,
          body: {
            prompt: 'Nothing yet',
            categories: [],
            uncategorised: { postIts: [], postItCount: 0 },
          },
        },
      ]),
    );
    render(<DisplayBoardView token={TOKEN} />);
    await waitFor(() => expect(screen.getByTestId('display-board')).toBeTruthy());

    expect(screen.getByTestId('display-uncategorised-count').textContent).toBe('0');
  });

  /** Nothing vote-shaped can appear, because nothing on the path can produce one. */
  it('renders nothing vote-derived even if a payload smuggled one in', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch([
        {
          status: 200,
          body: {
            ...BOARD,
            tally: [{ optionId: 'o-1', votes: 7 }],
            hasVoted: true,
            options: [{ id: 'o-1', label: 'Tooling' }],
          },
        },
      ]),
    );
    render(<DisplayBoardView token={TOKEN} />);
    await waitFor(() => expect(screen.getByTestId('display-board')).toBeTruthy());

    expect(document.body.textContent).not.toMatch(/\b7\b|vote|tally/i);
  });
});
