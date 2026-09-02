import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IDBFactory } from 'fake-indexeddb';
import { SessionActivitiesPanel } from '../src/activities/SessionActivitiesPanel.tsx';
import { adoptCacheOwner, setCacheIdentity } from '../src/offline/schedule-cache.ts';
import { holdPostIt, listQueuedPostIts, queuedKeys } from '../src/offline/post-it-queue.ts';
import type { Category, PostIt, Round, SessionWithRounds } from '../src/api/client.ts';

/**
 * Sorting on the client: a Facilitator places a Post-it, from their own device, without a pointer
 * (S03 TI05, TI06).
 *
 * Four disciplines, from `docs/LEARNINGS.md#testing` and the FIS's Testing Strategy:
 *
 *   - **Every assertion is made on the rendered Board**, never on a request count alone. A guard on
 *     the request issued stays green while the payload is wrong.
 *   - **The whole path is driven by keyboard**, through `userEvent.tab()` and `{Enter}`, and the
 *     four pointer events the PRD's constraint names are counted across every interaction and
 *     asserted at zero. "Sorting must not require drag-and-drop" is an accessibility requirement,
 *     not a styling preference (`prd.md#constraints`).
 *   - **Nothing is queued.** The device's store is seeded *before* the failed placement and proved
 *     byte-identical afterwards, which is stronger than asserting it is empty - and the cache
 *     ownership claim is made first, because `adoptCacheOwner` fails closed and an entry written
 *     before the claim is purged by it.
 *   - **No reload, no remount, no navigation, and no test-only entry point.**
 *
 * `web/` has no jest-dom, so assertions are on plain DOM properties.
 */

const CONFERENCE_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_SESSION_ID = '33333333-3333-4333-8333-333333333333';
const BASE = `/conferences/${CONFERENCE_ID}/sessions/${SESSION_ID}`;
const WATERMARK = `${BASE}/activities/watermark`;
const ROUND_ID = 'round-post-it';
const POST_IT_ID = 'p-waiting';
const PLACEMENT = `${BASE}/rounds/${ROUND_ID}/post-its/${POST_IT_ID}/placement`;

const ADA = 'google-sub-ada';

const FIRST_WATERMARK = '4171';
const SECOND_WATERMARK = '4172';

/** The cap as the *server* states it. No number here is the client's own – that is the point. */
const SERVER_CAP = 12;

const WAITING = 'Waiting three days for test data';

function postIt(overrides: Partial<PostIt> & { id: string; text: string }): PostIt {
  return {
    authorName: 'Ada Lovelace',
    mine: false,
    edited: false,
    arrivedAfterClose: false,
    ...overrides,
  };
}

function category(id: string, name: string, postIts: PostIt[]): Category {
  return { id, name, postIts, postItCount: postIts.length };
}

const WAITING_POST_IT = postIt({ id: POST_IT_ID, text: WAITING });

function round(categories: Category[], uncategorised: PostIt[], state: 'open' | 'closed'): Round {
  return {
    id: ROUND_ID,
    kind: 'PostItRound',
    prompt: 'What slowed us down this quarter?',
    state,
    categories,
    uncategorised: { postIts: uncategorised, postItCount: uncategorised.length },
    textMaxLength: SERVER_CAP,
  };
}

/** The Board before anything is sorted: two Categories, one Post-it waiting in Uncategorised. */
function unsorted(state: 'open' | 'closed' = 'closed'): Round {
  return round(
    [category('cat-handovers', 'Handovers', []), category('cat-tooling', 'Tooling', [])],
    [WAITING_POST_IT],
    state,
  );
}

/** The same Board with the Post-it placed into the named Category. */
function sortedInto(id: 'cat-handovers' | 'cat-tooling'): Round {
  return round(
    [
      category('cat-handovers', 'Handovers', id === 'cat-handovers' ? [WAITING_POST_IT] : []),
      category('cat-tooling', 'Tooling', id === 'cat-tooling' ? [WAITING_POST_IT] : []),
    ],
    [],
    'closed',
  );
}

function payload(rounds: Round[], canRun = true, watermark = FIRST_WATERMARK): SessionWithRounds {
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
    activityWatermark: watermark,
  };
}

/**
 * One stubbed answer – or, with `status: 0`, a request that never got one.
 *
 * The distinction is the whole of Acceptance Scenario S07: a placement the *server* refused is an
 * answer and shows the server's sentence, and only a request that never reached it shows the
 * client's own. Stubbing a 409 to prove "nothing is queued" would prove nothing at all.
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

/** One tick of the shipped poll loop, provoked through the `focus` event it registers for. */
async function tick(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
  });
}

/**
 * Puts keyboard focus on one control by tabbing to it, and presses Enter.
 *
 * Deliberately not `userEvent.click`: what is being proved is that the control is **reachable** in
 * the tab order and operable from the keyboard, which a click proves nothing about. The loop is
 * bounded so a control that is not reachable fails rather than hanging.
 */
async function tabToAndPress(
  user: ReturnType<typeof userEvent.setup>,
  testId: string,
): Promise<void> {
  const target = screen.getByTestId(testId);
  for (let step = 0; step < 120; step += 1) {
    if (document.activeElement === target) {
      await user.keyboard('{Enter}');
      return;
    }
    await user.tab();
  }
  throw new Error(`${testId} was not reachable by keyboard within 120 tab stops.`);
}

/**
 * Tabs to a `<select>` and chooses one of its options, using no pointer.
 *
 * `fireEvent.change` and **not** `userEvent.selectOptions`, and the difference is the point:
 * `selectOptions` opens the list by clicking it, which is exactly the pointer path this scenario
 * forbids. A native `<select>` is navigated with the arrow keys in every real browser and jsdom
 * implements none of that behaviour, so what is driven here is the one observable a keyboard
 * selection produces - the `change` event - after proving the control was reached by `Tab` and
 * holds focus. Reachability and the handler are both real; only the arrow keys are simulated.
 */
async function tabToAndChoose(
  user: ReturnType<typeof userEvent.setup>,
  testId: string,
  value: string,
): Promise<void> {
  const target = screen.getByTestId(testId) as HTMLSelectElement;
  for (let step = 0; step < 120; step += 1) {
    if (document.activeElement === target) {
      fireEvent.change(target, { target: { value } });
      return;
    }
    await user.tab();
  }
  throw new Error(`${testId} was not reachable by keyboard within 120 tab stops.`);
}

/**
 * The four events the PRD's constraint names, plus the two that always accompany them.
 *
 * `click` is deliberately absent: pressing Enter on a focused button dispatches one, in jsdom and
 * in every browser, and forbidding it would forbid the keyboard path itself. What is forbidden is
 * the *pointer* path - a press, a drag or a drop.
 */
const POINTER_EVENTS = [
  'pointerdown',
  'pointerup',
  'mousedown',
  'mouseup',
  'dragstart',
  'dragover',
  'drop',
] as const;

const pointerEventsSeen: string[] = [];

/**
 * Scoped to one test, and that is not tidiness.
 *
 * `document` outlives a test in jsdom, so listeners registered without a scope accumulate across
 * the file and every event is then counted once per test that ever installed them - which reads as
 * a pointer path where there is none. The controller is aborted after each test.
 */
let pointerWatch: AbortController | null = null;

function watchForPointerEvents(): void {
  pointerWatch?.abort();
  pointerWatch = new AbortController();
  for (const name of POINTER_EVENTS) {
    document.addEventListener(name, () => pointerEventsSeen.push(name), {
      capture: true,
      signal: pointerWatch.signal,
    });
  }
}

function textsIn(testId: string): string[] {
  return [...screen.getByTestId(testId).querySelectorAll('[data-testid^="post-it-text-"]')].map(
    (node) => node.textContent ?? '',
  );
}

describe('placing a post-it into a category', () => {
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    window.__CONFAPP_CONFIG__ = { apiBaseUrl: '/api' };
    calls.length = 0;
    answered.length = 0;
    pointerEventsSeen.length = 0;
    globalThis.indexedDB = new IDBFactory();
    setCacheIdentity(() => ADA);
    // Claimed first, always: a write before the claim is purged by it.
    await adoptCacheOwner(ADA);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    pointerWatch?.abort();
    pointerWatch = null;
  });

  async function renderPanel(routes: Record<string, Route | Route[]>): Promise<void> {
    globalThis.fetch = routeFetch(routes);
    render(<SessionActivitiesPanel conferenceId={CONFERENCE_ID} sessionId={SESSION_ID} />);
    await waitFor(() => expect(screen.queryByText(/Loading this session/)).toBeNull());
  }

  function watermarkAnswer(value: string): Route {
    return { status: 200, body: { activityWatermark: value, state: 'published' } };
  }

  // ---------- Acceptance Scenario S01: out of Uncategorised, by keyboard alone ----------

  it('places a post-it into a category by keyboard alone, with no pointer event on the path', async () => {
    const user = userEvent.setup();
    watchForPointerEvents();
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: [
        { status: 200, body: payload([unsorted()]) },
        { status: 200, body: payload([sortedInto('cat-handovers')]) },
      ],
      [`PATCH ${PLACEMENT}`]: {
        status: 200,
        body: { postIt: { ...WAITING_POST_IT } },
      },
    });

    // Where it starts: in Uncategorised, with both counts saying so.
    expect(textsIn(`uncategorised-${ROUND_ID}`)).toEqual([WAITING]);
    expect(screen.getByTestId(`uncategorised-count-${ROUND_ID}`).textContent).toBe('1 post-it');
    expect(screen.getByTestId('category-count-cat-handovers').textContent).toBe('0 post-its');

    await tabToAndChoose(user, `move-to-${POST_IT_ID}`, 'cat-handovers');
    await tabToAndPress(user, `move-submit-${POST_IT_ID}`);
    await waitFor(() => expect(answersFor('PATCH', PLACEMENT)).toBe(1));
    await settle();

    // The body carries the destination and nothing else - no author, no actor, no authority.
    expect(calls.find((call) => call.method === 'PATCH')!.body).toEqual({
      categoryId: 'cat-handovers',
    });

    // The Board re-renders from the server's answer, with the post-it under Handovers and both
    // counts moved. Nothing here is derived on the client.
    expect(textsIn('category-cat-handovers')).toEqual([WAITING]);
    expect(screen.getByTestId('category-count-cat-handovers').textContent).toBe('1 post-it');
    expect(screen.getByTestId(`uncategorised-count-${ROUND_ID}`).textContent).toBe('0 post-its');
    expect(textsIn(`uncategorised-${ROUND_ID}`)).toEqual([]);

    // And the whole path was traversed without a single pointer event.
    expect(pointerEventsSeen).toEqual([]);
  });

  /**
   * Every control the placement path adds says which Post-it it acts on.
   *
   * A page of controls all reading "Move" says nothing to somebody hearing it, and a Board at the
   * design ceiling has two hundred of them. The label names the Post-it and the act; the options
   * name where it can go and which one it is in **in words**, because a select's own highlight is
   * invisible to a screen reader and unreadable at a glance on a phone.
   */
  it('names the post-it it moves, and says where it is now in words', async () => {
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: { status: 200, body: payload([sortedInto('cat-tooling')]) },
    });

    const select = screen.getByTestId(`move-to-${POST_IT_ID}`) as HTMLSelectElement;
    const label = document.querySelector(`label[for="move-to-${POST_IT_ID}"]`);
    expect(label!.textContent).toBe(`Move “${WAITING}” to`);

    // Uncategorised and every Category by name, with the current home marked in words.
    expect([...select.options].map((option) => option.textContent)).toEqual([
      'Uncategorised',
      'Handovers',
      'Tooling – where it is now',
    ]);
    // The control opens on where the post-it actually is, not on a remembered choice.
    expect(select.value).toBe('cat-tooling');

    // The commit control carries a name of its own that names the same post-it.
    expect(screen.getByTestId(`move-submit-${POST_IT_ID}`).getAttribute('aria-label')).toBe(
      `Move “${WAITING}” to the destination chosen for it`,
    );
  });

  it('marks uncategorised as where it is now for a post-it nobody has placed', async () => {
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: { status: 200, body: payload([unsorted()]) },
    });

    const select = screen.getByTestId(`move-to-${POST_IT_ID}`) as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(select.options[0]!.textContent).toBe('Uncategorised – where it is now');
  });

  // ---------- Acceptance Scenario S02: on to a second Category, and back ----------

  it('moves a post-it on to a second category and back to uncategorised, one board read each', async () => {
    const user = userEvent.setup();
    watchForPointerEvents();
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: [
        { status: 200, body: payload([sortedInto('cat-handovers')]) },
        { status: 200, body: payload([sortedInto('cat-tooling')]) },
        { status: 200, body: payload([unsorted()]) },
      ],
      [`PATCH ${PLACEMENT}`]: { status: 200, body: { postIt: { ...WAITING_POST_IT } } },
    });

    const readsBefore = answersFor('GET', BASE);

    await tabToAndChoose(user, `move-to-${POST_IT_ID}`, 'cat-tooling');
    await tabToAndPress(user, `move-submit-${POST_IT_ID}`);
    await waitFor(() => expect(answersFor('PATCH', PLACEMENT)).toBe(1));
    await settle();

    expect(textsIn('category-cat-tooling')).toEqual([WAITING]);
    expect(textsIn('category-cat-handovers')).toEqual([]);
    expect(screen.getByTestId('category-count-cat-tooling').textContent).toBe('1 post-it');
    expect(screen.getByTestId('category-count-cat-handovers').textContent).toBe('0 post-its');

    await tabToAndChoose(user, `move-to-${POST_IT_ID}`, '');
    await tabToAndPress(user, `move-submit-${POST_IT_ID}`);
    await waitFor(() => expect(answersFor('PATCH', PLACEMENT)).toBe(2));
    await settle();

    // `null` is Uncategorised - the absence of a placement, sent as an absence.
    expect(calls.filter((call) => call.method === 'PATCH').map((call) => call.body)).toEqual([
      { categoryId: 'cat-tooling' },
      { categoryId: null },
    ]);

    expect(textsIn(`uncategorised-${ROUND_ID}`)).toEqual([WAITING]);
    expect(screen.getByTestId(`uncategorised-count-${ROUND_ID}`).textContent).toBe('1 post-it');
    expect(screen.getByTestId('category-count-cat-tooling').textContent).toBe('0 post-its');

    /*
     * **One Board read per move**, not one per Category and not one per Post-it. The Board is
     * re-read once after each write - which is the seam's own rule - and nothing on this path asks
     * for a Category or a count of its own.
     */
    expect(answersFor('GET', BASE) - readsBefore).toBe(2);
    /*
     * The Display Link read (S04) is the one other GET this surface makes, and it is a **mount**
     * read rather than a per-write one: a link changes only when this facilitator changes it, and
     * issuing or revoking deliberately does not move the Session's activity cursor. Asserting its
     * count here is what keeps it from quietly becoming another per-move request.
     */
    const displayLinkReads = calls.filter(
      (call) => call.method === 'GET' && /\/display-link$/.test(call.path),
    );
    expect(displayLinkReads.length).toBe(1);
    /*
     * The discarded post-its read (S05) is the other one, and it is **cursor-keyed** rather than
     * per-write: the surface re-reads when the Board's activity watermark moves and at no other
     * time, so a move that leaves the cursor where it was - which is what these stubbed payloads
     * do - costs exactly the one mount read. Asserted here for the same reason the Display Link's
     * count is: to keep it from quietly becoming another per-move request.
     */
    const discardedReads = calls.filter(
      (call) => call.method === 'GET' && /\/discarded-post-its$/.test(call.path),
    );
    expect(discardedReads.length).toBe(1);
    expect(
      calls.filter(
        (call) =>
          call.method === 'GET' &&
          call.path !== BASE &&
          call.path !== WATERMARK &&
          !/\/display-link$/.test(call.path) &&
          !/\/discarded-post-its$/.test(call.path),
      ),
    ).toEqual([]);

    expect(pointerEventsSeen).toEqual([]);
  });

  // ---------- Acceptance Scenario S03: it reaches an already-open board ----------

  /**
   * Bo's Board re-renders into the new arrangement on the shared poll's tick.
   *
   * The panel under test is Bo's: the server says he does not run the Session, nobody interacted
   * with it, and the only thing that happened is that the cursor moved. The wait is on the second
   * **answer** - which a panel that ignored the moved cursor could not produce - and the reading of
   * the Board is taken after it, never waited on.
   */
  it('re-renders another member’s open board into the new arrangement, with no reload', async () => {
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(SECOND_WATERMARK),
      [`GET ${BASE}`]: [
        { status: 200, body: payload([unsorted()], false) },
        { status: 200, body: payload([sortedInto('cat-handovers')], false, SECOND_WATERMARK) },
      ],
    });

    expect(textsIn(`uncategorised-${ROUND_ID}`)).toEqual([WAITING]);

    await tick();
    await waitFor(() => expect(answersFor('GET', BASE)).toBe(2));
    await settle();

    expect(textsIn('category-cat-handovers')).toEqual([WAITING]);
    expect(screen.getByTestId('category-count-cat-handovers').textContent).toBe('1 post-it');
    expect(screen.getByTestId(`uncategorised-count-${ROUND_ID}`).textContent).toBe('0 post-its');
  });

  // ---------- Acceptance Scenario S05: the control is not offered to a non-sorter ----------

  it('offers no placement control to a viewer the server says does not run the session', async () => {
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: { status: 200, body: payload([unsorted()], false) },
    });

    expect(screen.queryByTestId(`move-${POST_IT_ID}`)).toBeNull();
    expect(screen.queryByTestId(`move-to-${POST_IT_ID}`)).toBeNull();
    expect(screen.queryByTestId(`move-submit-${POST_IT_ID}`)).toBeNull();
    // The Board itself still renders in full: authority decides the controls, not the reading.
    expect(textsIn(`uncategorised-${ROUND_ID}`)).toEqual([WAITING]);
  });

  // ---------- Acceptance Scenario S07: undelivered is surfaced, never deferred ----------

  it('leaves the post-it where it was, says so, and queues nothing when the move cannot be delivered', async () => {
    const user = userEvent.setup();

    /*
     * Seeded **before** the failed placement, so what is proved afterwards is that the store is
     * *unchanged* rather than merely empty - a strictly stronger claim, and one an empty store
     * could satisfy for the wrong reason. It belongs to another Session so it is not rendered here
     * and cannot interfere with the Board being asserted.
     */
    const held = {
      submissionId: '44444444-4444-4444-8444-444444444444',
      conferenceId: CONFERENCE_ID,
      sessionId: OTHER_SESSION_ID,
      roundId: 'round-elsewhere',
      text: 'Typed in a dead spot, on another session',
      heldAt: 1,
    };
    expect(await holdPostIt(held)).toBe(true);
    const before = await queuedKeys();
    expect(before).toHaveLength(1);

    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: { status: 200, body: payload([sortedInto('cat-handovers')]) },
      // A request that never got an answer, which is what a dead connection looks like to `fetch`.
      [`PATCH ${PLACEMENT}`]: { status: 0 },
    });

    await tabToAndChoose(user, `move-to-${POST_IT_ID}`, 'cat-tooling');
    await tabToAndPress(user, `move-submit-${POST_IT_ID}`);
    await waitFor(() => expect(screen.queryByTestId(`board-error-${ROUND_ID}`)).not.toBeNull());
    await settle();

    // The post-it is still drawn where it was.
    expect(textsIn('category-cat-handovers')).toEqual([WAITING]);
    expect(textsIn('category-cat-tooling')).toEqual([]);

    /*
     * The sentence is FR3's own, verbatim, and it is **still on screen after the Board re-read the
     * handler itself caused** - it lives in panel state, outside the subtree that re-read replaces
     * (`docs/LEARNINGS.md#react-state--refusals`).
     */
    expect(answersFor('GET', BASE)).toBeGreaterThan(1);
    expect(screen.getByTestId(`board-error-${ROUND_ID}`).textContent).toBe(
      "Couldn't move that – check your connection.",
    );

    // The device holds nothing new: sorting is online-only and nothing on this path may queue.
    expect(await queuedKeys()).toEqual(before);
    const queued = await listQueuedPostIts(ADA);
    expect(queued.map((item) => item.text)).toEqual([held.text]);
  });

  it('shows the server’s own sentence when a placement is refused, and re-reads the board', async () => {
    const user = userEvent.setup();
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: { status: 200, body: payload([sortedInto('cat-handovers')]) },
      [`PATCH ${PLACEMENT}`]: {
        status: 404,
        body: {
          error: {
            code: 'CATEGORY_NOT_FOUND',
            message:
              'That category is not on this board, so the post-it was not moved. The board has ' +
              'changed since you last read it.',
          },
        },
      },
    });

    await tabToAndChoose(user, `move-to-${POST_IT_ID}`, 'cat-tooling');
    await tabToAndPress(user, `move-submit-${POST_IT_ID}`);
    await waitFor(() => expect(screen.queryByTestId(`board-error-${ROUND_ID}`)).not.toBeNull());
    await settle();

    // The server's words, not the client's connection sentence: this was an answer.
    expect(screen.getByTestId(`board-error-${ROUND_ID}`).textContent).toMatch(
      /not on this board.*board has changed/s,
    );
    expect(screen.getByTestId(`board-error-${ROUND_ID}`).textContent).not.toMatch(
      /check your connection/,
    );
    expect(textsIn('category-cat-handovers')).toEqual([WAITING]);
    expect(await queuedKeys()).toEqual([]);

    // The chosen destination stays in the control the facilitator is still looking at.
    expect((screen.getByTestId(`move-to-${POST_IT_ID}`) as HTMLSelectElement).value).toBe(
      'cat-tooling',
    );
  });

  // ---------- the interaction model has no pointer-only half ----------

  it('renders no drag affordance and registers no drag handler on the placement path', async () => {
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: { status: 200, body: payload([unsorted()]) },
    });

    const board = screen.getByTestId(`board-${ROUND_ID}`);
    expect(board.querySelectorAll('[draggable]').length).toBe(0);
    expect(board.querySelectorAll('[data-drag-handle], .drag-handle, [aria-grabbed]').length).toBe(
      0,
    );

    // And a drag started on the post-it reaches nothing: no handler is registered for one.
    watchForPointerEvents();
    const card = screen.getByTestId(`post-it-${POST_IT_ID}`);
    await act(async () => {
      card.dispatchEvent(new Event('dragstart', { bubbles: true }));
      card.dispatchEvent(new Event('drop', { bubbles: true }));
    });
    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([]);
    // The two events this test dispatched itself are the only ones anything saw.
    expect(pointerEventsSeen).toEqual(['dragstart', 'drop']);
  });

  /*
   * Category removal lives on this same panel, so a destination chosen a moment ago can be gone by
   * the next Board read. A remembered id that no option carries does **not** blank the control:
   * React's controlled-select reconciliation selects the first non-disabled option when the value
   * matches none, which here is Uncategorised. So the screen quietly reads "Uncategorised" while
   * the remembered id is what Move would actually commit. The displayed destination and the
   * committed one disagree, which is worse than a blank control because nothing looks wrong -
   * and it is why this asserts the PATCH body rather than anything about how the control renders.
   */
  it('commits the destination it is showing after the chosen category is removed', async () => {
    const user = userEvent.setup();
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(SECOND_WATERMARK),
      [`GET ${BASE}`]: [
        { status: 200, body: payload([unsorted()]) },
        // Tooling is gone. The Post-it has not moved: it is still in Uncategorised.
        {
          status: 200,
          body: payload(
            [round([category('cat-handovers', 'Handovers', [])], [WAITING_POST_IT], 'closed')],
            true,
            SECOND_WATERMARK,
          ),
        },
      ],
      [`PATCH ${PLACEMENT}`]: { status: 200, body: { postIt: { ...WAITING_POST_IT } } },
    });

    const select = screen.getByTestId(`move-to-${POST_IT_ID}`) as HTMLSelectElement;
    await user.selectOptions(select, 'cat-tooling');
    expect(select.value).toBe('cat-tooling');

    await tick();
    await waitFor(() => expect(answersFor('GET', BASE)).toBe(2));
    await settle();

    // What the Facilitator now sees: Tooling is not offered, and the control reads Uncategorised.
    const reread = screen.getByTestId(`move-to-${POST_IT_ID}`) as HTMLSelectElement;
    expect([...reread.options].map((option) => option.value)).toEqual(['', 'cat-handovers']);
    expect(reread.value).toBe('');

    await user.click(screen.getByTestId(`move-submit-${POST_IT_ID}`));
    await waitFor(() => expect(answersFor('PATCH', PLACEMENT)).toBe(1));

    /*
     * `categoryId: null` is Uncategorised, which is what the control was showing. Sending
     * `cat-tooling` here is the defect: a dead id the Facilitator was never shown and did not
     * choose from what was on screen.
     */
    expect(calls.find((call) => call.method === 'PATCH')!.body).toEqual({ categoryId: null });
  });

  /*
   * The keyboard path has to survive *repetition*, not just work once. A successful move disables
   * the button under the keyboard and re-parents the card into its new region, so the focused
   * element is unmounted and focus falls to `<body>` - and a Facilitator sorting a pile would tab
   * from the top of the page again after every move, on the one surface whose interaction model
   * exists to be keyboard-operable (S01 -> OC02).
   */
  it('returns focus to the moved post-it once the board carrying it has rendered', async () => {
    const user = userEvent.setup();
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: [
        { status: 200, body: payload([unsorted()]) },
        { status: 200, body: payload([sortedInto('cat-handovers')]) },
      ],
      [`PATCH ${PLACEMENT}`]: { status: 200, body: { postIt: { ...WAITING_POST_IT } } },
    });

    await tabToAndChoose(user, `move-to-${POST_IT_ID}`, 'cat-handovers');
    await tabToAndPress(user, `move-submit-${POST_IT_ID}`);
    await waitFor(() => expect(answersFor('PATCH', PLACEMENT)).toBe(1));
    await settle();

    // The card really did move region, so the element that had focus is gone, not merely re-rendered.
    expect(textsIn('category-cat-handovers')).toEqual([WAITING]);

    /*
     * Focus is on the moved Post-it's own destination control, not on `<body>`. Asserting the
     * active element by test id rather than "not body" so that landing on some other arbitrary
     * control would fail too.
     */
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId(`move-to-${POST_IT_ID}`)),
    );
  });

  // ---------- placement is offered whatever the round is doing ----------

  /*
   * Two **different** boards, not the same one read twice. The watermark answer has to name the
   * second payload's own cursor, or the panel sees nothing to re-read and the closed half of this
   * guard asserts against the open board again - green, and proving only that the first assertion
   * still holds.
   */
  it('offers the placement control on an open round and on a closed one alike', async () => {
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(SECOND_WATERMARK),
      [`GET ${BASE}`]: [
        { status: 200, body: payload([unsorted('open')]) },
        { status: 200, body: payload([unsorted('closed')], true, SECOND_WATERMARK) },
      ],
    });
    expect(screen.getByTestId(`round-state-${ROUND_ID}`).textContent).toBe('Open');
    expect(screen.getByTestId(`move-submit-${POST_IT_ID}`)).not.toBeNull();

    await tick();
    await waitFor(() => expect(answersFor('GET', BASE)).toBe(2));
    await settle();

    // The closed board is the one sorting actually happens on, and it carries the same control.
    expect(screen.getByTestId(`round-state-${ROUND_ID}`).textContent).toBe('Closed');
    expect(screen.getByTestId(`move-submit-${POST_IT_ID}`)).not.toBeNull();
  });
});
