import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionActivitiesPanel } from '../src/activities/SessionActivitiesPanel.tsx';
import type { Category, PostIt, Round, SessionWithRounds } from '../src/api/client.ts';

/**
 * The Facilitator's Category controls on the client: the regions, the counts, and the four writes
 * that are all operable without a pointer (TI07, TI08).
 *
 * Three disciplines, from `docs/LEARNINGS.md#testing` and the FIS's Testing Strategy:
 *
 *   - **Every assertion is made on the rendered surface**, never on a request count alone. A guard
 *     on the request issued stays green while the payload is wrong.
 *   - **Every control is driven by keyboard**, through `userEvent.tab()` and `{Enter}`, because
 *     "sorting is operable without drag-and-drop" is an accessibility requirement rather than a
 *     styling preference (`prd.md#non-functional-requirements`).
 *   - **No reload, no remount, no navigation, and no test-only entry point.**
 *
 * `web/` has no jest-dom, so assertions are on plain DOM properties.
 */

const CONFERENCE_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const BASE = `/conferences/${CONFERENCE_ID}/sessions/${SESSION_ID}`;
const WATERMARK = `${BASE}/activities/watermark`;
const ROUND_ID = 'round-post-it';
const CATEGORIES = `${BASE}/rounds/${ROUND_ID}/categories`;

const FIRST_WATERMARK = '4171';

/** The cap as the *server* states it. No number here is the client's own – that is the point. */
const SERVER_CAP = 12;

function postIt(overrides: Partial<PostIt> & { id: string; text: string }): PostIt {
  return {
    authorName: 'Ada Lovelace',
    mine: false,
    edited: false,
    arrivedAfterClose: false,
    ...overrides,
  };
}

function category(id: string, name: string, postIts: PostIt[], postItCount?: number): Category {
  return { id, name, postIts, postItCount: postItCount ?? postIts.length };
}

function round(
  categories: Category[],
  uncategorised: PostIt[],
  uncategorisedCount?: number,
): Round {
  return {
    id: ROUND_ID,
    kind: 'PostItRound',
    prompt: 'What slowed us down this quarter?',
    state: 'closed',
    categories,
    uncategorised: {
      postIts: uncategorised,
      postItCount: uncategorisedCount ?? uncategorised.length,
    },
    textMaxLength: SERVER_CAP,
  };
}

function payload(rounds: Round[], canRun = true): SessionWithRounds {
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
    activityWatermark: FIRST_WATERMARK,
  };
}

/**
 * One stubbed answer - or, with `status: 0`, a request that never got one.
 *
 * The distinction is load-bearing for the queueing rule: `mayStillBeDelivered` holds a submission
 * only for a transport failure, a 401 or a 5xx, so a test that stubs a 409 to prove "nothing is
 * queued" proves nothing at all - a 409 is unqueueable by every path in this codebase.
 */
interface Route {
  status: number;
  body?: unknown;
}

const calls: { method: string; path: string; body: unknown }[] = [];
const answered: { method: string; path: string }[] = [];

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
    // The shape of a request that never reached the server: `fetch` rejects, and the client turns
    // that into its own NETWORK_UNREACHABLE sentence rather than into a server refusal.
    if (route.status === 0) throw new TypeError('Failed to fetch');
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

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

/**
 * Puts keyboard focus on one control by tabbing to it, and presses Enter.
 *
 * Deliberately not `userEvent.click`: what is being proved is that the control is **reachable** in
 * the tab order and operable from the keyboard, which a click proves nothing about. The loop is
 * bounded so a control that is not reachable fails rather than hanging.
 */
async function tabToAndPress(user: ReturnType<typeof userEvent.setup>, testId: string) {
  const target = screen.getByTestId(testId);
  for (let step = 0; step < 80; step += 1) {
    if (document.activeElement === target) {
      await user.keyboard('{Enter}');
      return;
    }
    await user.tab();
  }
  throw new Error(`${testId} was not reachable by keyboard within 80 tab stops.`);
}

const TOOLING = category('cat-tooling', 'Tooling', [
  postIt({ id: 'p-build', text: 'The build takes 22 minutes' }),
]);
const PROCESS = category('cat-process', 'Process', [
  postIt({ id: 'p-standups', text: 'Standups run 40 minutes' }),
  postIt({ id: 'p-signoff', text: 'Sign-off takes a week' }),
]);
/** A Post-it nobody has placed yet - it is in Uncategorised, which is not a category. */
const WAITING = postIt({ id: 'p-coffee', text: 'The coffee machine is broken' });

describe('the facilitator’s categories and the uncategorised holding area', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    window.__CONFAPP_CONFIG__ = { apiBaseUrl: '/api' };
    calls.length = 0;
    answered.length = 0;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  async function renderPanel(routes: Record<string, Route | Route[]>): Promise<void> {
    globalThis.fetch = routeFetch(routes);
    render(<SessionActivitiesPanel conferenceId={CONFERENCE_ID} sessionId={SESSION_ID} />);
    await waitFor(() => expect(screen.queryByText(/Loading this session/)).toBeNull());
  }

  function only(payloadBody: SessionWithRounds): Record<string, Route | Route[]> {
    return {
      [`GET ${WATERMARK}`]: {
        status: 200,
        body: { activityWatermark: FIRST_WATERMARK, state: 'published' },
      },
      [`GET ${BASE}`]: { status: 200, body: payloadBody },
    };
  }

  // ---------- TI07: Uncategorised is always there, and every count is the server's ----------

  it('renders uncategorised with a count of zero on a board with no categories at all', async () => {
    await renderPanel(only(payload([round([], [])])));

    const region = screen.getByTestId(`uncategorised-${ROUND_ID}`);
    expect(region).not.toBeNull();
    expect(screen.getByTestId(`uncategorised-count-${ROUND_ID}`).textContent).toBe('0 post-its');
    // And it says in words that it is not a Category, rather than leaving the absence to be read
    // as an oversight.
    expect(screen.getByTestId(`uncategorised-note-${ROUND_ID}`).textContent).toMatch(
      /can’t be renamed, reordered or removed/,
    );
    expect(screen.queryByTestId(`category-total-${ROUND_ID}`)!.textContent).toBe(
      '0 categories on this board.',
    );
  });

  it('renders the categories in payload order, each with its own server-supplied count', async () => {
    await renderPanel(only(payload([round([TOOLING, PROCESS], [WAITING])])));

    const names = [...document.querySelectorAll('[data-testid^="category-name-"]')].map(
      (node) => node.textContent,
    );
    expect(names).toEqual(['Tooling', 'Process']);

    expect(screen.getByTestId('category-count-cat-tooling').textContent).toBe('1 post-it');
    expect(screen.getByTestId('category-count-cat-process').textContent).toBe('2 post-its');
    expect(screen.getByTestId(`uncategorised-count-${ROUND_ID}`).textContent).toBe('1 post-it');

    // Every post-it is rendered once, in the region that holds it.
    expect(
      [
        ...screen
          .getByTestId('category-cat-process')
          .querySelectorAll('[data-testid^="post-it-text-"]'),
      ].map((node) => node.textContent),
    ).toEqual(['Standups run 40 minutes', 'Sign-off takes a week']);
    expect(document.querySelectorAll('[data-testid="post-it-p-build"]').length).toBe(1);

    // The order is stated in words, not left to where a region happens to sit.
    expect(screen.getByTestId('category-position-cat-tooling').textContent).toBe('Position 1 of 2');
    expect(screen.getByTestId('category-position-cat-process').textContent).toBe('Position 2 of 2');
  });

  /**
   * The count is the **server's**, not `postIts.length`.
   *
   * A payload whose count disagrees with the list beside it is not a state the API produces - it is
   * the one thing that tells a client that re-derives from a client that consumes, and only the
   * second is what the projected screen and every Attendee's phone will agree with.
   */
  it('renders the payload’s count rather than counting the post-its it was sent', async () => {
    await renderPanel(only(payload([round([category('cat-a', 'Tooling', [], 7)], [], 4)])));

    expect(screen.getByTestId('category-count-cat-a').textContent).toBe('7 post-its');
    expect(screen.getByTestId(`uncategorised-count-${ROUND_ID}`).textContent).toBe('4 post-its');
  });

  // ---------- TI08: Uncategorised is offered none of the three controls ----------

  it('offers uncategorised no rename, reorder or remove control', async () => {
    await renderPanel(only(payload([round([TOOLING], [WAITING])])));

    const region = screen.getByTestId(`uncategorised-${ROUND_ID}`);
    /*
     * Scoped to the *category* controls, not to every button in the region: a post-it sitting in
     * Uncategorised still offers its own author the correct-and-remove pair, which is a different
     * rule and belongs to whoever wrote it.
     */
    expect(
      region.querySelectorAll(
        '[data-testid^="category-rename-"], [data-testid^="category-up-"], ' +
          '[data-testid^="category-down-"], [data-testid^="category-remove-"]',
      ).length,
    ).toBe(0);
    // The controls exist on the Category beside it, so their absence here is a decision rather
    // than a payload that simply carried nothing.
    expect(screen.getByTestId('category-controls-cat-tooling')).not.toBeNull();
  });

  /*
   * S02 ticks a Structural Criterion claiming Category reorder is operable by keyboard **and
   * assistive technology**. It was half true: the controls were reachable and their labels read
   * “Rename”, “Move up”, “Remove” - identical on every Category on the board, so a screen-reader
   * user heard four controls per region and nothing saying which region (gap review 2026-09-02,
   * G03). The Post-it controls in the same component already named their subject.
   *
   * Asserted through the accessibility tree by role and name, because that is the thing the
   * criterion is about; a `data-testid` query would pass whether or not a name existed.
   */
  it('names the category each management control acts on, in the accessibility tree', async () => {
    await renderPanel(only(payload([round([TOOLING, PROCESS], [WAITING])])));

    for (const name of ['Tooling', 'Process']) {
      expect(screen.getByRole('button', { name: `Rename the category “${name}”` })).not.toBeNull();
      expect(screen.getByRole('button', { name: `Move the category “${name}” up` })).not.toBeNull();
      expect(
        screen.getByRole('button', { name: `Move the category “${name}” down` }),
      ).not.toBeNull();
      expect(screen.getByRole('button', { name: `Remove the category “${name}”` })).not.toBeNull();
    }

    /*
     * `getByRole` throws on more than one match, so the loop above already proves the names are
     * unique across a two-Category board - which is the property that was missing.
     */
  });
  it('offers no category control at all to a viewer the server says does not run the session', async () => {
    await renderPanel(only(payload([round([TOOLING], [WAITING])], false)));

    expect(screen.queryByTestId('category-controls-cat-tooling')).toBeNull();
    expect(screen.queryByTestId(`new-category-${ROUND_ID}`)).toBeNull();
    // The board itself still renders in full: authority decides the controls, not the reading.
    expect(screen.getByTestId('category-name-cat-tooling').textContent).toBe('Tooling');
    expect(screen.getByTestId(`uncategorised-${ROUND_ID}`)).not.toBeNull();
  });

  // ---------- TI08: every control is operable by keyboard alone ----------

  it('creates a category from the keyboard and clears the box only on success', async () => {
    const user = userEvent.setup();
    await renderPanel({
      ...only(payload([round([], [WAITING])])),
      [`POST ${CATEGORIES}`]: {
        status: 200,
        body: { category: { id: 'cat-new', name: 'Tooling', position: 1 } },
      },
    });

    const box = screen.getByTestId(`new-category-name-${ROUND_ID}`) as HTMLInputElement;
    await user.click(box);
    await user.keyboard('Tooling');
    await tabToAndPress(user, `new-category-add-${ROUND_ID}`);
    await waitFor(() => expect(answersFor('POST', CATEGORIES)).toBe(1));
    await settle();

    expect(calls.find((call) => call.method === 'POST')!.body).toEqual({ name: 'Tooling' });
    expect(box.value).toBe('');
    // The board is re-read afterwards, so the room is looking at what is actually stored.
    expect(answersFor('GET', BASE)).toBeGreaterThan(1);
  });

  it('keeps the typed name and shows the server’s sentence when a create is refused', async () => {
    const user = userEvent.setup();
    await renderPanel({
      ...only(payload([round([], [])])),
      [`POST ${CATEGORIES}`]: {
        status: 409,
        body: {
          error: {
            code: 'CATEGORY_LIMIT_REACHED',
            message: 'A board can hold at most 20 categories, and this one already holds 20.',
          },
        },
      },
    });

    const box = screen.getByTestId(`new-category-name-${ROUND_ID}`) as HTMLInputElement;
    await user.click(box);
    await user.keyboard('One too many');
    await tabToAndPress(user, `new-category-add-${ROUND_ID}`);
    await waitFor(() => expect(answersFor('POST', CATEGORIES)).toBe(1));
    await settle();

    /*
     * The refusal is the server's own sentence - it is what names the limit and the count, which is
     * why no number is written on this surface - and it survives the re-read its own handler
     * triggers (`docs/LEARNINGS.md#react-state--refusals`).
     */
    expect(screen.getByTestId(`category-error-${ROUND_ID}`).textContent).toMatch(
      /at most 20 categories, and this one already holds 20/,
    );
    // And the typed name is still exactly where it was.
    expect(box.value).toBe('One too many');
  });

  it('shows the duplicate-name warning that rides a successful create', async () => {
    const user = userEvent.setup();
    await renderPanel({
      ...only(payload([round([TOOLING], [])])),
      [`POST ${CATEGORIES}`]: {
        status: 200,
        body: {
          category: { id: 'cat-second', name: 'Tooling', position: 2 },
          warning: 'Another category on this board already has that name. Both are kept.',
        },
      },
    });

    await user.click(screen.getByTestId(`new-category-name-${ROUND_ID}`));
    await user.keyboard('Tooling');
    await tabToAndPress(user, `new-category-add-${ROUND_ID}`);
    await waitFor(() => expect(answersFor('POST', CATEGORIES)).toBe(1));
    await settle();

    const warning = screen.getByTestId(`category-warning-${ROUND_ID}`);
    expect(warning.textContent).toMatch(/already has that name/);
    // A warning, not a refusal: it is announced as status and no error box appears beside it.
    expect(warning.getAttribute('role')).toBe('status');
    expect(screen.queryByTestId(`category-error-${ROUND_ID}`)).toBeNull();
  });

  it('renames a category from the keyboard, sending only the new name', async () => {
    const user = userEvent.setup();
    await renderPanel({
      ...only(payload([round([TOOLING, PROCESS], [])])),
      [`PATCH ${CATEGORIES}/cat-tooling`]: {
        status: 200,
        body: { category: { id: 'cat-tooling', name: 'Tooling & CI', position: 1 } },
      },
    });

    await tabToAndPress(user, 'category-rename-cat-tooling');
    const box = screen.getByTestId('category-rename-input-cat-tooling') as HTMLInputElement;
    // The box opens holding the current name, so a small correction is a small edit.
    expect(box.value).toBe('Tooling');
    await user.clear(box);
    await user.keyboard('Tooling & CI');
    await tabToAndPress(user, 'category-rename-save-cat-tooling');
    await waitFor(() => expect(answersFor('PATCH', `${CATEGORIES}/cat-tooling`)).toBe(1));
    await settle();

    // A rename is a name and nothing else: no position rides along, so nothing moves.
    expect(calls.find((call) => call.method === 'PATCH')!.body).toEqual({ name: 'Tooling & CI' });
  });

  /**
   * Reorder names its own outcome and sends the **resulting position**.
   *
   * Not a direction the server has to interpret against an order this client believes in: the
   * control says `Move down — to position 2`, and 2 is what the request carries.
   */
  it('moves a category by naming the resulting position, from the keyboard', async () => {
    const user = userEvent.setup();
    await renderPanel({
      ...only(payload([round([TOOLING, PROCESS], [])])),
      [`PATCH ${CATEGORIES}/cat-tooling`]: {
        status: 200,
        body: { category: { id: 'cat-tooling', name: 'Tooling', position: 2 } },
      },
    });

    expect(screen.getByTestId('category-down-cat-tooling').textContent).toBe(
      'Move down – to position 2',
    );
    expect(screen.getByTestId('category-up-cat-process').textContent).toBe(
      'Move up – to position 1',
    );

    await tabToAndPress(user, 'category-down-cat-tooling');
    await waitFor(() => expect(answersFor('PATCH', `${CATEGORIES}/cat-tooling`)).toBe(1));
    await settle();

    expect(calls.find((call) => call.method === 'PATCH')!.body).toEqual({ position: 2 });
  });

  /**
   * **The control at the end of the order is `aria-disabled`, never `disabled`.**
   *
   * `disabled` removes the control from the tab order, so the sequence a keyboard user has learned
   * would change shape exactly when a Category reaches the end of the order - the opposite of what
   * this control set is for
   * (`docs/wireframes/facilitator-board-and-categorisation/design-decisions.md`). It stays
   * focusable, is announced as unavailable, and pressing it writes nothing.
   */
  it('keeps the end-of-order control focusable, announced unavailable, and inert', async () => {
    const user = userEvent.setup();
    await renderPanel(only(payload([round([TOOLING, PROCESS], [])])));

    const up = screen.getByTestId('category-up-cat-tooling') as HTMLButtonElement;
    const down = screen.getByTestId('category-down-cat-process') as HTMLButtonElement;

    for (const [control, label] of [
      [up, 'Move up'],
      [down, 'Move down'],
    ] as const) {
      expect(control.getAttribute('aria-disabled')).toBe('true');
      expect(control.hasAttribute('disabled')).toBe(false);
      expect(control.textContent).toBe(label);
    }

    // Still in the tab order, which is the whole reason it is not `disabled` – and pressing it
    // writes nothing, so no press can produce a broken order.
    await tabToAndPress(user, 'category-up-cat-tooling');
    await settle();
    expect(calls.filter((call) => call.method === 'PATCH').length).toBe(0);
  });

  // ---------- TI08: the removal flow ----------

  it('removes an empty category with no prompt and no destination', async () => {
    const user = userEvent.setup();
    const empty = category('cat-empty', 'People', []);
    await renderPanel({
      ...only(payload([round([empty], [])])),
      [`DELETE ${CATEGORIES}/cat-empty`]: { status: 200, body: { removed: true } },
    });

    await tabToAndPress(user, 'category-remove-cat-empty');
    await waitFor(() => expect(answersFor('DELETE', `${CATEGORIES}/cat-empty`)).toBe(1));
    await settle();

    expect(screen.queryByTestId('category-removal-cat-empty')).toBeNull();
    // No destination is named at all, which is what makes the empty case promptless.
    expect(calls.find((call) => call.method === 'DELETE')!.body).toEqual({});
  });

  it('asks where an occupied category’s post-its go, defaulting to uncategorised and naming the count', async () => {
    const user = userEvent.setup();
    await renderPanel({
      ...only(payload([round([TOOLING, PROCESS], [])])),
      [`DELETE ${CATEGORIES}/cat-process`]: { status: 200, body: { removed: true } },
    });

    await tabToAndPress(user, 'category-remove-cat-process');
    await settle();

    // Nothing was sent: an occupied category asks first.
    expect(calls.filter((call) => call.method === 'DELETE').length).toBe(0);

    const prompt = screen.getByTestId('category-removal-cat-process');
    expect(prompt.textContent).toMatch(/It holds 2 post-its/);
    expect(prompt.textContent).toMatch(/they are not\s+deleted/);

    const destination = screen.getByTestId('category-destination-cat-process') as HTMLSelectElement;
    // Uncategorised, pre-selected - and it is the absence of a category id, not an id of its own.
    expect(destination.value).toBe('');
    expect(destination.options[0]!.textContent).toBe('Uncategorised');
    // The other categories on this board are offered too; the one being removed is not.
    expect([...destination.options].map((option) => option.textContent)).toEqual([
      'Uncategorised',
      'Tooling',
    ]);

    await tabToAndPress(user, 'category-removal-confirm-cat-process');
    await waitFor(() => expect(answersFor('DELETE', `${CATEGORIES}/cat-process`)).toBe(1));
    await settle();

    expect(calls.find((call) => call.method === 'DELETE')!.body).toEqual({
      destinationCategoryId: null,
    });
  });

  it('sends the chosen category when the facilitator picks one instead of uncategorised', async () => {
    const user = userEvent.setup();
    await renderPanel({
      ...only(payload([round([TOOLING, PROCESS], [])])),
      [`DELETE ${CATEGORIES}/cat-process`]: { status: 200, body: { removed: true } },
    });

    await tabToAndPress(user, 'category-remove-cat-process');
    await settle();
    await user.selectOptions(screen.getByTestId('category-destination-cat-process'), 'cat-tooling');
    await tabToAndPress(user, 'category-removal-confirm-cat-process');
    await waitFor(() => expect(answersFor('DELETE', `${CATEGORIES}/cat-process`)).toBe(1));
    await settle();

    expect(calls.find((call) => call.method === 'DELETE')!.body).toEqual({
      destinationCategoryId: 'cat-tooling',
    });
  });

  it('cancels a removal without sending anything', async () => {
    const user = userEvent.setup();
    await renderPanel(only(payload([round([PROCESS], [])])));

    await tabToAndPress(user, 'category-remove-cat-process');
    await settle();
    await tabToAndPress(user, 'category-removal-cancel-cat-process');
    await settle();

    expect(screen.queryByTestId('category-removal-cat-process')).toBeNull();
    expect(calls.filter((call) => call.method === 'DELETE').length).toBe(0);
  });

  /**
   * **One control's write in flight never releases another's guard.**
   *
   * The six writers on this surface share one in-flight marker. While that marker was a single
   * slot, pressing a second control overwrote the first's key - which re-enabled the first control
   * mid-flight and let a double-tap send the same write twice. On the contribute path that is two
   * Post-its under one real name, because a retry mints a fresh submission identity.
   *
   * Driven with a deferred answer so the first write is genuinely still out when the second and
   * third presses happen.
   */
  it('keeps a control disabled while its own write is out, whatever else is pressed', async () => {
    const user = userEvent.setup();
    let releaseCreate: () => void = () => {};
    const createLanded = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });

    globalThis.fetch = ((input: unknown, init?: RequestInit) => {
      const inner = routeFetch({
        ...only(payload([round([category('cat-empty', 'People', [])], [])])),
        [`POST ${CATEGORIES}`]: {
          status: 200,
          body: { category: { id: 'cat-new', name: 'Tooling', position: 2 } },
        },
        [`DELETE ${CATEGORIES}/cat-empty`]: { status: 200, body: { removed: true } },
      });
      const path = String(input).replace(/^.*\/api/, '');
      if ((init?.method ?? 'GET') === 'POST' && path.endsWith('/categories')) {
        return createLanded.then(() => inner(input as RequestInfo, init));
      }
      return inner(input as RequestInfo, init);
    }) as typeof fetch;

    render(<SessionActivitiesPanel conferenceId={CONFERENCE_ID} sessionId={SESSION_ID} />);
    await waitFor(() => expect(screen.queryByText(/Loading this session/)).toBeNull());

    await user.click(screen.getByTestId(`new-category-name-${ROUND_ID}`));
    await user.keyboard('Tooling');
    const add = screen.getByTestId(`new-category-add-${ROUND_ID}`) as HTMLButtonElement;
    await user.click(add);
    await settle();

    // The create is still out, so its own control is unpressable and says so.
    expect(add.disabled).toBe(true);
    expect(add.textContent).toBe('Adding…');

    // A different control is pressed and completes. The create's guard must survive it.
    await user.click(screen.getByTestId('category-remove-cat-empty'));
    await waitFor(() => expect(answersFor('DELETE', `${CATEGORIES}/cat-empty`)).toBe(1));
    await settle();

    expect((screen.getByTestId(`new-category-add-${ROUND_ID}`) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await user.click(screen.getByTestId(`new-category-add-${ROUND_ID}`));
    await settle();

    releaseCreate();
    await waitFor(() => expect(answersFor('POST', CATEGORIES)).toBe(1));
    await settle();

    // Exactly one create was ever sent, however many times the control was pressed.
    expect(calls.filter((call) => call.method === 'POST').length).toBe(1);
  });

  /**
   * A failed Category write is **not queued** (Binding Constraint FR3).
   *
   * Sorting is online-only, so the refusal is what the person reads and the Board stays exactly as
   * it was. Nothing is held on the device and nothing offers to retry later - unlike a Post-it
   * typed in a dead spot, which is the one write on this surface that has somewhere to go.
   */
  it('surfaces a failed category write and queues nothing', async () => {
    const user = userEvent.setup();
    await renderPanel({
      ...only(payload([round([TOOLING], [])])),
      /*
       * A request that never reached the server - status 0, the one case in which the Post-it path
       * *would* hold a submission on the device. A refusal is unqueueable by construction, so
       * stubbing one would leave this guard unable to fail.
       */
      [`DELETE ${CATEGORIES}/cat-tooling`]: { status: 0 },
    });

    await tabToAndPress(user, 'category-remove-cat-tooling');
    await settle();
    await tabToAndPress(user, 'category-removal-confirm-cat-tooling');
    await waitFor(() => expect(answersFor('DELETE', `${CATEGORIES}/cat-tooling`)).toBe(1));
    await settle();

    // The client's own sentence for a request that never landed, not a server refusal.
    expect(screen.getByTestId(`category-error-${ROUND_ID}`).textContent).toMatch(
      /could not reach the server/i,
    );
    // The board is unchanged, and there is no pending item and no retry control anywhere.
    expect(screen.getByTestId('category-name-cat-tooling').textContent).toBe('Tooling');
    expect(screen.queryByTestId(`board-held-${ROUND_ID}`)).toBeNull();
    expect(screen.queryByText(/retry|try again later|waiting to be/i)).toBeNull();
  });
});
