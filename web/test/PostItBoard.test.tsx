import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionActivitiesPanel } from '../src/activities/SessionActivitiesPanel.tsx';
import type { Category, PostIt, Round, SessionWithRounds } from '../src/api/client.ts';

/**
 * S02 on the client: the named board, the compose box, the author's own controls, and the
 * convergence that makes a Post-it Round worth running (TI09, TI10).
 *
 * Three disciplines, all of them from `docs/LEARNINGS.md#testing` and the FIS's Testing Strategy:
 *
 *   - **Every propagation assertion is made on the rendered board**, never on a request count or a
 *     fetch spy. A guard on the request issued stays green while the payload is wrong.
 *   - **Nothing waits on the value it is about to assert.** The waits are on an answer count, which
 *     the defect each test guards against cannot produce, and the reading is taken afterwards.
 *   - **No reload, no remount, no navigation, and no test-only entry point.** A tick is provoked by
 *     dispatching the `focus` event the shipped poll loop genuinely listens for.
 *
 * `web/` has no jest-dom, so assertions are on plain DOM properties.
 */

const CONFERENCE_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const BASE = `/conferences/${CONFERENCE_ID}/sessions/${SESSION_ID}`;
const WATERMARK = `${BASE}/activities/watermark`;
const ROUND_ID = 'round-post-it';
const BOARD = `${BASE}/rounds/${ROUND_ID}/post-its`;

/*
 * The Session's activity cursor, as the server actually sends it: an opaque counter, never a time.
 * Digits here rather than an ISO instant is the fixture's half of the guarantee - a timestamp told
 * every Member when each Vote landed. The view only ever asks whether the two differ.
 */
const FIRST_WATERMARK = '4171';
const SECOND_WATERMARK = '4172';

/** The cap as the *server* states it. No number here is the client's own – that is the point. */
const SERVER_CAP = 12;

function postIt(overrides: Partial<PostIt> & { id: string; text: string }): PostIt {
  return { authorName: 'Ada Lovelace', mine: false, edited: false, ...overrides };
}

const ADAS = postIt({ id: 'p-ada', text: 'Waiting three days for test data' });
const MINE = postIt({ id: 'p-mine', text: 'Handover gaps', authorName: 'Bo Nilsson', mine: true });

/**
 * A Round whose Board holds no Category, which is what every Board starts as.
 *
 * The Post-its are in **Uncategorised**, and its count comes from the payload rather than from the
 * list beside it - the surface consumes the server's count and never re-derives one
 * (facilitator-board S02, TI05).
 */
function round(
  state: 'open' | 'closed',
  postIts: PostIt[],
  textMaxLength: number = SERVER_CAP,
): Round {
  return {
    id: ROUND_ID,
    kind: 'PostItRound',
    prompt: 'What slowed us down this quarter?',
    state,
    categories: [],
    uncategorised: { postIts, postItCount: postIts.length },
    textMaxLength,
  };
}

function payload(rounds: Round[], activityWatermark = FIRST_WATERMARK): SessionWithRounds {
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
    canRun: false,
    canRemovePermanently: false,
    activityWatermark,
  };
}

interface Route {
  status: number;
  body: unknown;
}

function watermarkAnswer(activityWatermark: string | null): Route {
  return { status: 200, body: { activityWatermark, state: 'published' } };
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
    // that into its own NETWORK_UNREACHABLE sentence rather than into a server refusal. It is the
    // only honest way to write "the venue wifi died" - a stubbed flag would pass while the real
    // path still hung (`docs/LEARNINGS.md#offline`).
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

/** Lets an answered request finish being handled – on the real clock, not by polling for a value. */
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

function textOnBoard(): string[] {
  return [...document.querySelectorAll('[data-testid^="post-it-text-"]')].map(
    (node) => node.textContent ?? '',
  );
}

function authorsOnBoard(): string[] {
  return [...document.querySelectorAll('[data-testid^="post-it-by-"]')].map(
    (node) => node.textContent ?? '',
  );
}

/**
 * A Category on a Board, with the Post-its it holds and the **server's** count of them.
 *
 * `postItCount` defaults to the length of the list but is a separate argument on purpose: the two
 * are allowed to disagree in a fixture precisely so a surface that re-derived the count from
 * `postIts.length` would be caught by a test that states a different number
 * (facilitator-board S02, "Board read projection contract").
 */
function category(
  id: string,
  name: string,
  postIts: PostIt[],
  postItCount: number = postIts.length,
): Category {
  return { id, name, postIts, postItCount };
}

/** A Post-it Round whose Board has been sorted: Categories in the Facilitator's order. */
function sortedRound(
  categories: Category[],
  uncategorised: PostIt[],
  state: 'open' | 'closed' = 'open',
  uncategorisedCount: number = uncategorised.length,
): Round {
  return {
    id: ROUND_ID,
    kind: 'PostItRound',
    prompt: 'What slowed us down this quarter?',
    state,
    categories,
    uncategorised: { postIts: uncategorised, postItCount: uncategorisedCount },
    textMaxLength: SERVER_CAP,
  };
}

/** The Category names on the Board, in the order they are rendered in. */
function categoryNames(): string[] {
  return [...document.querySelectorAll('[data-testid^="category-name-"]')].map(
    (node) => node.textContent ?? '',
  );
}

/** The Post-it texts inside one region, in render order. */
function textsIn(testId: string): string[] {
  return [...screen.getByTestId(testId).querySelectorAll('[data-testid^="post-it-text-"]')].map(
    (node) => node.textContent ?? '',
  );
}

describe('the post-it board', () => {
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

  // ---------- Acceptance Scenario S01: it arrives on a board nobody touched ----------

  /**
   * Ada's post-it appears on Bo's already-open board, under Ada's name, with no reload.
   *
   * The panel under test is Bo's: it opened on an empty board, nobody interacted with it, and the
   * only thing that happened is that the server's cursor moved. The wait is on the second answer –
   * which a panel that ignored the moved cursor could not produce – and the reading is taken after.
   */
  it('shows another member’s contribution under their name, with no reload', async () => {
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(SECOND_WATERMARK),
      [`GET ${BASE}`]: [
        { status: 200, body: payload([round('open', [])]) },
        { status: 200, body: payload([round('open', [ADAS])], SECOND_WATERMARK) },
      ],
    });

    expect(textOnBoard()).toEqual([]);
    expect(screen.getByTestId(`board-empty-${ROUND_ID}`).textContent).toMatch(/No post-its yet/);
    const boardBefore = screen.getByTestId(`board-${ROUND_ID}`);

    await tick();
    await waitFor(() => expect(answersFor('GET', BASE)).toBe(2));
    await settle();

    expect(textOnBoard()).toEqual(['Waiting three days for test data']);
    expect(authorsOnBoard()).toEqual(['Ada Lovelace']);
    // The same element, not a remounted one: nothing about this was a navigation.
    expect(screen.getByTestId(`board-${ROUND_ID}`)).toBe(boardBefore);
    // Somebody else's post-it offers neither control (Acceptance Scenario S04, client half).
    expect(screen.queryByTestId(`post-it-correct-${ADAS.id}`)).toBeNull();
    expect(screen.queryByTestId(`post-it-remove-${ADAS.id}`)).toBeNull();
  });

  // ---------- Acceptance Scenario S03: a correction and a deletion reach the room ----------

  it('converges on a correction and on a deletion, the deletion leaving no trace', async () => {
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(SECOND_WATERMARK),
      [`GET ${BASE}`]: [
        { status: 200, body: payload([round('open', [ADAS, MINE])]) },
        {
          status: 200,
          body: payload(
            [round('open', [{ ...ADAS, text: 'Waiting three days for test data', edited: true }])],
            SECOND_WATERMARK,
          ),
        },
      ],
    });

    expect(textOnBoard()).toEqual(['Waiting three days for test data', 'Handover gaps']);

    await tick();
    await waitFor(() => expect(answersFor('GET', BASE)).toBe(2));
    await settle();

    // The correction landed, and the deleted one is gone – not a tombstone, not a placeholder.
    expect(textOnBoard()).toEqual(['Waiting three days for test data']);
    expect(screen.queryByTestId(`post-it-${MINE.id}`)).toBeNull();
    expect(screen.getByTestId(`post-it-by-${ADAS.id}`).textContent).toContain('(edited)');
  });

  /** A failed poll leaves the board exactly as it was. */
  it('keeps the board when a refresh fails', async () => {
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(SECOND_WATERMARK),
      [`GET ${BASE}`]: [
        { status: 200, body: payload([round('open', [ADAS])]) },
        { status: 503, body: { error: { code: 'DATABASE_UNAVAILABLE', message: 'Not now.' } } },
      ],
    });

    await tick();
    await waitFor(() => expect(answersFor('GET', BASE)).toBe(2));
    await settle();

    expect(textOnBoard()).toEqual(['Waiting three days for test data']);
    expect(screen.queryByTestId('activities-error')).toBeNull();
  });

  /**
   * **But a revoked role or a deleted Session is not a blip, and must not read as live data.**
   *
   * `keepOnFailure` exists so a room does not lose the screen it is working from to one dropped
   * tick. It used to hold the payload through *any* failure, including the two answers that are
   * specifically about this caller's access to this Session - after which somebody kept looking at
   * a board they could no longer read, with run controls that would refuse, and the only symptom
   * was that nothing ever changed again.
   *
   * A 5xx stays on the keep side, as the test above asserts: the server failing says nothing about
   * the caller.
   */
  it('replaces the board when the refresh is refused for this caller', async () => {
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(SECOND_WATERMARK),
      [`GET ${BASE}`]: [
        { status: 200, body: payload([round('open', [ADAS])]) },
        {
          status: 403,
          body: {
            error: {
              code: 'SESSION_NOT_READABLE',
              message: 'You can no longer read this session.',
            },
          },
        },
      ],
    });

    await tick();
    await waitFor(() => expect(answersFor('GET', BASE)).toBe(2));
    await settle();

    // The stale board is gone, and the server's sentence is what is on screen instead.
    expect(screen.queryByTestId(`board-${ROUND_ID}`)).toBeNull();
    expect(screen.getByTestId('activities-error').textContent).toContain('no longer read');
  });

  /**
   * **A panel whose first load failed heals itself on the next tick.**
   *
   * The loop was gated on `ready`, so one dropped or refused initial request left the failure on
   * screen for the rest of the Session: nothing polled, nothing retried, and nothing on the panel
   * could change it. Somebody whose phone lost a single request at the wrong moment had no way back
   * short of leaving the Session and returning, and no reason to think that would help.
   *
   * S01's tick fired regardless of panel state and recovered from exactly this; the behaviour was
   * lost when the loop moved to the shared one, in a task that called the move behaviour-preserving.
   *
   * Read on the rendered board, and provoked by the real `focus` tick the shipped loop listens for -
   * no remount, no navigation, no test-only entry point.
   */
  it('recovers from a failed first load on the next tick, with no remount', async () => {
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: [
        { status: 503, body: { error: { code: 'DATABASE_UNAVAILABLE', message: 'Not now.' } } },
        { status: 200, body: payload([round('open', [ADAS])]) },
      ],
    });

    // The first read failed, so there is no board at all - only the failure.
    expect(screen.queryByTestId(`board-${ROUND_ID}`)).toBeNull();
    expect(screen.getByTestId('activities-error')).not.toBeNull();

    await tick();
    await waitFor(() => expect(answersFor('GET', BASE)).toBe(2));
    await settle();

    // The tick alone brought it back.
    expect(textOnBoard()).toEqual(['Waiting three days for test data']);
    expect(screen.queryByTestId('activities-error')).toBeNull();
  });

  // ---------- Acceptance Scenario S06: a refusal keeps the typed text ----------

  /**
   * The over-length refusal is the server's, and the typed text stays where it is.
   *
   * The board is re-read after the refusal – which is the whole trap
   * (`docs/LEARNINGS.md#react-state--refusals`): a refusal or a draft rendered inside the subtree
   * that re-read replaces would be gone by the time anyone read it.
   */
  it('keeps the typed text and the board when a contribution is refused', async () => {
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: { status: 200, body: payload([round('open', [ADAS])]) },
      [`POST ${BOARD}`]: {
        status: 400,
        body: {
          error: {
            code: 'POST_IT_TEXT_INVALID',
            message: `A post-it can be at most ${SERVER_CAP} characters, and this one is 40.`,
            details: [{ field: 'text', message: 'too long' }],
          },
        },
      },
    });

    const typed = 'A very long idea that will not be accepted';
    const box = screen.getByTestId(`compose-${ROUND_ID}`) as HTMLTextAreaElement;
    await userEvent.type(box, typed);
    await userEvent.click(screen.getByTestId(`compose-submit-${ROUND_ID}`));

    // Synchronised on the re-read that follows the refusal – the very thing that could have taken
    // the sentence and the draft away – and only then read.
    await waitFor(() => expect(answersFor('GET', BASE)).toBe(2));
    await settle();

    const refusal = screen.getByTestId(`board-error-${ROUND_ID}`);
    expect(refusal.textContent).toContain(String(SERVER_CAP));
    expect((screen.getByTestId(`compose-${ROUND_ID}`) as HTMLTextAreaElement).value).toBe(typed);
    // The board is unchanged: nothing was persisted, so nothing appears.
    expect(textOnBoard()).toEqual(['Waiting three days for test data']);
  });

  /** A refused *blank* submission is the same rule: the server refuses, the box keeps what it has. */
  it('sends what was typed and clears the box only on success', async () => {
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: [
        { status: 200, body: payload([round('open', [])]) },
        { status: 200, body: payload([round('open', [MINE])]) },
      ],
      [`POST ${BOARD}`]: { status: 200, body: { postIt: MINE } },
    });

    await userEvent.type(screen.getByTestId(`compose-${ROUND_ID}`), 'Handover gaps');
    await userEvent.click(screen.getByTestId(`compose-submit-${ROUND_ID}`));
    await waitFor(() => expect(answersFor('GET', BASE)).toBe(2));
    await settle();

    /*
     * The request carried the text and **no author of any kind** – authorship is the credential's.
     *
     * Asserted key by key rather than as an exact object: S04 added `submissionId`, which names the
     * *submission* and not the person making it, and an equality check would have read that as a
     * violation of a rule it does not touch. What must stay true is that nothing on this body names
     * or influences who is contributing.
     */
    const sent = calls.find((call) => call.method === 'POST' && call.path === BOARD)!;
    const body = sent.body as Record<string, unknown>;
    expect(body.text).toBe('Handover gaps');
    for (const key of Object.keys(body)) {
      expect(key, `${key} should not name the acting identity`).not.toMatch(
        /author|\bsub\b|email|user/i,
      );
    }

    expect((screen.getByTestId(`compose-${ROUND_ID}`) as HTMLTextAreaElement).value).toBe('');
    expect(textOnBoard()).toEqual(['Handover gaps']);
  });

  // ---------- TI09: the limit comes from the payload, never from the client ----------

  /**
   * **The compose box states the server's cap, and has none of its own.**
   *
   * Two payloads, two caps, two readings – so a hardcoded number is what would fail here. There is
   * no assertion on any particular value: what is under test is that the box follows the payload.
   */
  it('renders whatever limit the payload states, and follows it when it changes', async () => {
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(SECOND_WATERMARK),
      [`GET ${BASE}`]: [
        { status: 200, body: payload([round('open', [], 40)]) },
        { status: 200, body: payload([round('open', [], 999)], SECOND_WATERMARK) },
      ],
    });

    expect(screen.getByTestId(`compose-limit-${ROUND_ID}`).textContent).toContain('40');

    await tick();
    await waitFor(() => expect(answersFor('GET', BASE)).toBe(2));
    await settle();

    expect(screen.getByTestId(`compose-limit-${ROUND_ID}`).textContent).toContain('999');
    expect(screen.getByTestId(`compose-limit-${ROUND_ID}`).textContent).not.toContain('40');
  });

  /**
   * The box does not stop somebody typing past the limit.
   *
   * A `maxLength` attribute would make the over-length refusal unreachable, and the refusal is what
   * names the limit and keeps the text on screen (Acceptance Scenario S06).
   */
  it('lets over-length text be typed, so the server can refuse it', async () => {
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: { status: 200, body: payload([round('open', [], 5)]) },
    });

    const box = screen.getByTestId(`compose-${ROUND_ID}`) as HTMLTextAreaElement;
    expect(box.maxLength).toBe(-1);
    await userEvent.type(box, 'far more than five');
    expect(box.value).toBe('far more than five');
  });

  // ---------- Acceptance Scenarios S02 / S05 / S07: what is offered, and to whom ----------

  it('offers correct and remove on your own post-it, and neither on anybody else’s', async () => {
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: { status: 200, body: payload([round('open', [ADAS, MINE])]) },
    });

    expect(screen.queryByTestId(`post-it-correct-${MINE.id}`)).not.toBeNull();
    expect(screen.queryByTestId(`post-it-remove-${MINE.id}`)).not.toBeNull();
    expect(screen.queryByTestId(`post-it-correct-${ADAS.id}`)).toBeNull();
    expect(screen.queryByTestId(`post-it-remove-${ADAS.id}`)).toBeNull();
    // The flag is the server's answer, rendered onto the element rather than re-derived.
    expect(screen.getByTestId(`post-it-${MINE.id}`).dataset.mine).toBe('true');
    expect(screen.getByTestId(`post-it-${ADAS.id}`).dataset.mine).toBe('false');
  });

  /**
   * A closed Round reads in full and offers nothing to press – not even to the author of the
   * post-its on it (Acceptance Scenario S07).
   */
  it('renders a closed round’s prompt and whole board with no compose, correct or remove control', async () => {
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: { status: 200, body: payload([round('closed', [ADAS, MINE])]) },
    });

    expect(screen.getByTestId(`round-prompt-${ROUND_ID}`).textContent).toBe(
      'What slowed us down this quarter?',
    );
    expect(textOnBoard()).toEqual(['Waiting three days for test data', 'Handover gaps']);
    expect(authorsOnBoard()).toEqual(['Ada Lovelace', 'Bo Nilsson']);

    expect(screen.queryByTestId(`compose-${ROUND_ID}`)).toBeNull();
    expect(screen.queryByTestId(`compose-submit-${ROUND_ID}`)).toBeNull();
    expect(screen.queryByTestId(`post-it-correct-${MINE.id}`)).toBeNull();
    expect(screen.queryByTestId(`post-it-remove-${MINE.id}`)).toBeNull();

    // The board arrives with the Session read – no per-round request of any kind is made.
    expect(calls.filter((call) => call.path.includes('/post-its'))).toEqual([]);
  });

  /**
   * The same rule, reached the way a workshop actually reaches it: the correction box is **already
   * open** when the Facilitator closes the Round (TI09).
   *
   * The test above renders a Round that was closed in its first payload, so no editor was ever
   * opened on it and it would stay green against a Save button that outlives the close. Here the
   * editor is opened first and the Round closes underneath it. After it closes neither correction
   * nor removal is offered (OC02) – a live Save on a closed Round is an offer the API will only
   * refuse.
   */
  it('withdraws an already-open correction box when the round closes underneath it', async () => {
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(SECOND_WATERMARK),
      [`GET ${BASE}`]: [
        { status: 200, body: payload([round('open', [MINE])]) },
        { status: 200, body: payload([round('closed', [MINE])], SECOND_WATERMARK) },
      ],
    });

    await userEvent.click(screen.getByTestId(`post-it-correct-${MINE.id}`));
    expect(screen.queryByTestId(`post-it-edit-${MINE.id}`)).not.toBeNull();
    expect(screen.queryByTestId(`post-it-save-${MINE.id}`)).not.toBeNull();

    await tick();
    await waitFor(() => expect(answersFor('GET', BASE)).toBe(2));
    await settle();

    expect(screen.queryByTestId(`post-it-edit-${MINE.id}`)).toBeNull();
    expect(screen.queryByTestId(`post-it-save-${MINE.id}`)).toBeNull();
    expect(screen.queryByTestId(`post-it-cancel-${MINE.id}`)).toBeNull();
    // The post-it itself is still read in full – closing stops changes, it hides nothing.
    expect(textOnBoard()).toEqual(['Handover gaps']);
    expect(screen.queryByTestId(`post-it-correct-${MINE.id}`)).toBeNull();
    expect(screen.queryByTestId(`post-it-remove-${MINE.id}`)).toBeNull();
  });

  // ---------- correcting and removing your own ----------

  it('corrects your own post-it, sending only the text', async () => {
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: [
        { status: 200, body: payload([round('open', [MINE])]) },
        {
          status: 200,
          body: payload([
            round('open', [{ ...MINE, text: 'Handover gaps, mostly', edited: true }]),
          ]),
        },
      ],
      [`PATCH ${BOARD}/${MINE.id}`]: { status: 200, body: { postIt: MINE } },
    });

    await userEvent.click(screen.getByTestId(`post-it-correct-${MINE.id}`));
    const box = screen.getByTestId(`post-it-edit-${MINE.id}`) as HTMLTextAreaElement;
    expect(box.value).toBe('Handover gaps');
    await userEvent.type(box, ', mostly');
    await userEvent.click(screen.getByTestId(`post-it-save-${MINE.id}`));

    await waitFor(() => expect(answersFor('GET', BASE)).toBe(2));
    await settle();

    const sent = calls.find((call) => call.method === 'PATCH')!;
    expect(sent.body).toEqual({ text: 'Handover gaps, mostly' });
    expect(textOnBoard()).toEqual(['Handover gaps, mostly']);
  });

  it('removes your own post-it and shows the server’s sentence when it refuses', async () => {
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: { status: 200, body: payload([round('open', [MINE])]) },
      [`DELETE ${BOARD}/${MINE.id}`]: {
        status: 409,
        body: {
          error: {
            code: 'POST_IT_ROUND_CLOSED',
            message: 'This round has ended, so its post-its can no longer be changed.',
          },
        },
      },
    });

    await userEvent.click(screen.getByTestId(`post-it-remove-${MINE.id}`));
    await waitFor(() => expect(answersFor('GET', BASE)).toBe(2));
    await settle();

    // The server's sentence, verbatim, and it survived the re-read its own handler triggered.
    expect(screen.getByTestId(`board-error-${ROUND_ID}`).textContent).toContain('has ended');
    // The post-it is still there, because the refusal means nothing was removed.
    expect(textOnBoard()).toEqual(['Handover gaps']);
  });

  // ---------- A double-tap is one intent, so it must be one write ----------

  /**
   * **A contribution is not idempotent from its author's side, and it carries their name.**
   *
   * Nothing about a Post-it is single-use, so unlike a Vote the server has no reason to refuse the
   * second tap - it takes it, and the same idea lands on the board twice under one real name. That
   * is the whole defect: the failure is silent and it is attributed.
   *
   * The POST is **held open**, because the window in which a second tap exists is exactly the window
   * in which the first is unanswered. The stub would happily answer twice; the guard is what makes
   * it one.
   */
  it('sends one contribution for a double-tap on Add post-it', async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const routed = routeFetch({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`POST ${BOARD}`]: { status: 200, body: { postIt: MINE } },
      [`GET ${BASE}`]: [
        { status: 200, body: payload([round('open', [])]) },
        { status: 200, body: payload([round('open', [MINE])]) },
      ],
    });
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') await held;
      return routed(input as RequestInfo, init);
    }) as unknown as typeof fetch;

    render(<SessionActivitiesPanel conferenceId={CONFERENCE_ID} sessionId={SESSION_ID} />);
    await waitFor(() => expect(screen.queryByText(/Loading this session/)).toBeNull());

    await userEvent.type(screen.getByTestId(`compose-${ROUND_ID}`), 'Handover gaps');
    const submit = screen.getByTestId(`compose-submit-${ROUND_ID}`) as HTMLButtonElement;

    await act(async () => {
      submit.click();
    });
    expect(submit.disabled).toBe(true);

    // The DOM's own activation path, so a disabled control declines it exactly as a phone would.
    await act(async () => {
      submit.click();
    });

    release?.();
    await settle();

    expect(calls.filter((call) => call.method === 'POST' && call.path === BOARD)).toHaveLength(1);
    // Read on the board, not on the count: one idea, once, under one name.
    expect(textOnBoard()).toEqual(['Handover gaps']);
  });

  /**
   * **The second Remove tells the wrong person their post-it is gone.**
   *
   * A repeated delete is not merely wasteful. The first succeeds; the second finds nothing and the
   * server answers `POST_IT_NOT_FOUND` - so the author whose removal actually worked is shown a
   * sentence saying their post-it is no longer on this round, which reads as a failure of the thing
   * that just succeeded.
   *
   * Also asserted here: the compose box stays live while a post-it write is out. The guard is keyed
   * per item precisely so one slow write does not freeze the rest of the board.
   */
  it('sends one delete for a double-tap on Remove, and leaves the compose box live', async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const routed = routeFetch({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`DELETE ${BOARD}/${MINE.id}`]: [
        { status: 200, body: { removed: true } },
        // What the server really answers a second delete of a row that is already gone.
        {
          status: 404,
          body: {
            error: {
              code: 'POST_IT_NOT_FOUND',
              message: 'That post-it is no longer on this round.',
            },
          },
        },
      ],
      [`GET ${BASE}`]: [
        { status: 200, body: payload([round('open', [MINE])]) },
        { status: 200, body: payload([round('open', [])]) },
      ],
    });
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'DELETE') await held;
      return routed(input as RequestInfo, init);
    }) as unknown as typeof fetch;

    render(<SessionActivitiesPanel conferenceId={CONFERENCE_ID} sessionId={SESSION_ID} />);
    await waitFor(() => expect(screen.queryByText(/Loading this session/)).toBeNull());

    const removeControl = screen.getByTestId(`post-it-remove-${MINE.id}`) as HTMLButtonElement;

    await act(async () => {
      removeControl.click();
    });
    expect(removeControl.disabled).toBe(true);
    // Keyed per item: a removal out on one post-it must not disable contributing to the round.
    expect((screen.getByTestId(`compose-submit-${ROUND_ID}`) as HTMLButtonElement).disabled).toBe(
      false,
    );

    await act(async () => {
      removeControl.click();
    });

    release?.();
    await settle();

    expect(
      calls.filter((call) => call.method === 'DELETE' && call.path === `${BOARD}/${MINE.id}`),
    ).toHaveLength(1);
    // The person whose delete succeeded is not told it did not.
    expect(screen.queryByTestId(`board-error-${ROUND_ID}`)).toBeNull();
    expect(textOnBoard()).toEqual([]);
  });

  // ---------- S08: the Attendee's live Board ----------

  /*
   * The three Categories the room's screen shows, and the six Post-its nobody has placed yet.
   *
   * Bo is a Member with no Session Assignment and no Admin - `payload()` answers `canRun: false`,
   * which is the server's answer and the only thing this surface reads about authority.
   */
  const BUILD = postIt({ id: 'p-build', text: 'The build takes 22 minutes' });
  const SIGNOFF = postIt({ id: 'p-signoff', text: 'Sign-off takes a week' });
  const INDUCTION = postIt({ id: 'p-induction', text: 'Nobody ran my induction' });
  const LAPTOP = postIt({ id: 'p-laptop', text: 'My laptop arrived on day four' });
  const UNPLACED = ['coffee', 'staging', 'tools', 'scripts', 'hiring', 'wifi'].map((slug, index) =>
    postIt({ id: `p-${slug}`, text: `Unplaced idea ${index + 1}: ${slug}` }),
  );

  /**
   * **Bo's phone shows the same Categories, in the same order, and follows the sorting**
   * (Acceptance Scenario S01, OC01).
   *
   * Bo touches nothing. The Facilitator places two Post-its into "Handovers" and moves "Onboarding"
   * above it, and the only thing that happens on this device is that the shared loop's cursor moved.
   * The wait is on the second answer - which a panel ignoring the moved cursor could not produce -
   * and every reading is taken afterwards, on the rendered Board.
   *
   * The counts asserted are the **server's**, off `postItCount`, and the request assertion at the
   * end is what a second shape could not survive: one shared tick, one Board read, and nothing
   * per-Category, per-Post-it or Attendee-specific.
   */
  it('shows the facilitator’s categories in their order and follows a re-sort, with no second request', async () => {
    const before = sortedRound(
      [
        category('cat-tooling', 'Tooling', [BUILD]),
        category('cat-handovers', 'Handovers', [SIGNOFF]),
        category('cat-onboarding', 'Onboarding', [INDUCTION, LAPTOP]),
      ],
      UNPLACED,
    );
    const after = sortedRound(
      [
        category('cat-tooling', 'Tooling', [BUILD]),
        category('cat-onboarding', 'Onboarding', [INDUCTION, LAPTOP]),
        /*
         * **Nine, against three cards.** The count and the list are allowed to disagree in a
         * fixture precisely so that a surface re-deriving the count from `postIts.length` fails
         * here - which is the whole of TI01's "server-supplied counts" clause. No payload the API
         * produces looks like this; that is what makes it discriminating.
         */
        category('cat-handovers', 'Handovers', [SIGNOFF, UNPLACED[0]!, UNPLACED[1]!], 9),
      ],
      UNPLACED.slice(2),
    );

    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(SECOND_WATERMARK),
      [`GET ${BASE}`]: [
        { status: 200, body: payload([before]) },
        { status: 200, body: payload([after], SECOND_WATERMARK) },
      ],
    });

    expect(categoryNames()).toEqual(['Tooling', 'Handovers', 'Onboarding']);
    expect(screen.getByTestId(`uncategorised-count-${ROUND_ID}`).textContent).toBe('6 post-its');
    const boardBefore = screen.getByTestId(`board-${ROUND_ID}`);

    await tick();
    await waitFor(() => expect(answersFor('GET', BASE)).toBe(2));
    await settle();

    // The Facilitator's new order, on Bo's phone, with no reload and no remount.
    expect(categoryNames()).toEqual(['Tooling', 'Onboarding', 'Handovers']);
    expect(screen.getByTestId(`board-${ROUND_ID}`)).toBe(boardBefore);
    // The payload's number, not the three cards beside it.
    expect(screen.getByTestId('category-count-cat-handovers').textContent).toBe('9 post-its');
    expect(screen.getByTestId(`uncategorised-count-${ROUND_ID}`).textContent).toBe('4 post-its');
    expect(textsIn('category-cat-handovers')).toEqual([
      SIGNOFF.text,
      UNPLACED[0]!.text,
      UNPLACED[1]!.text,
    ]);
    // Every Post-it under its author's name, wherever the Facilitator put it.
    expect(screen.getByTestId(`post-it-by-${SIGNOFF.id}`).textContent).toBe('Ada Lovelace');

    /*
     * **One read per Board, and no request this surface invented.** The whole exchange is the
     * shared loop's two-scalar poll and the one Session read a moved cursor prompted - no
     * per-Category request, no per-Post-it request, and no Attendee-specific endpoint.
     */
    expect(new Set(calls.map((call) => `${call.method} ${call.path}`))).toEqual(
      new Set([`GET ${WATERMARK}`, `GET ${BASE}`]),
    );
    /*
     * And the **volume**, which a Set discards: the load at mount, the tick's two-scalar poll, and
     * the one Board read that poll prompted. Three requests, and the Set above cannot tell three
     * from thirty - a per-Category read issued against the same path would hide inside it.
     */
    expect(answersFor('GET', BASE)).toBe(2);
    expect(answersFor('GET', WATERMARK)).toBe(1);
    expect(calls).toHaveLength(3);
  });

  /**
   * **Bo is offered no lever on the Board at all - on Bo's own Post-it as much as on anyone's**
   * (Acceptance Scenario S02, OC02).
   *
   * Gated on `canRun` off the payload, which is the server's answer; the API refuses every one of
   * these writes regardless, and that half is proved against real PostgreSQL in
   * `api/test/post-it.integration.test.ts`. What this proves is that the surface offers nothing to
   * try it with.
   *
   * And the two controls that must **survive**: Correct and Remove on Bo's own Post-it while the
   * Round is open. They are an author's edit of their own words and their own deletion, not
   * placement - read-only here means read-only about *where a Post-it sits*.
   */
  it('offers an attendee no placement, move, discard or restore control – their own post-it included', async () => {
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: {
        status: 200,
        body: payload([sortedRound([category('cat-tooling', 'Tooling', [MINE, ADAS])], UNPLACED)]),
      },
    });

    // The Board itself reads in full - authority decides the controls, never the reading.
    expect(textsIn('category-cat-tooling')).toEqual([MINE.text, ADAS.text]);
    expect(screen.getByTestId(`uncategorised-${ROUND_ID}`)).not.toBeNull();

    /*
     * Swept by prefix rather than named one Post-it at a time: a sorting control added to this
     * surface later would have to be on a list to be missed, and this is not such a list.
     */
    for (const prefix of [
      'move-',
      'post-it-discard-',
      'post-it-permanent-removal-',
      'permanent-removal-',
      'discarded-',
      'category-controls-',
      'category-rename-',
      'category-up-',
      'category-down-',
      'category-remove-',
      'new-category-',
    ]) {
      expect(
        document.querySelectorAll(`[data-testid^="${prefix}"]`).length,
        `no ${prefix} control should be rendered for a member without sorting authority`,
      ).toBe(0);
    }
    // Not even worded: nothing on this surface names a sorting act.
    expect(screen.queryByText(/discard|restore|set aside/i)).toBeNull();

    // But the author's own two controls are exactly where they were, on Bo's post-it and no other.
    expect(screen.queryByTestId(`post-it-correct-${MINE.id}`)).not.toBeNull();
    expect(screen.queryByTestId(`post-it-remove-${MINE.id}`)).not.toBeNull();
    expect(screen.queryByTestId(`post-it-correct-${ADAS.id}`)).toBeNull();
    expect(screen.queryByTestId(`post-it-remove-${ADAS.id}`)).toBeNull();
  });

  /**
   * **The connection dies mid-sort: the Board stays, ages honestly, and resumes**
   * (Acceptance Scenario S05, OC04).
   *
   * The clock is the device's own and is moved by hand, because what is under test is a difference
   * of two readings of it. `Date.now` alone is faked - the poll's real interval, the real `focus`
   * registration and the real tick all stay as they ship, so the re-render that makes the age
   * advance has to come from the shipped seam rather than from a timer this test installed.
   *
   * Nothing is waited *on* that the defect could produce: the reading is taken after ticks that
   * answered nothing at all, which is precisely the state in which a label anchored on arriving
   * data rather than on a clock would freeze at "Updated just now".
   */
  it('keeps the board and ages it while nothing arrives, and resets it on the next successful read', async () => {
    const start = Date.parse('2026-09-15T13:20:00.000Z');
    const now = vi.spyOn(Date, 'now').mockReturnValue(start);
    try {
      await renderPanel({
        /*
         * The link is gone entirely: neither the poll nor the read reaches the host. Three entries
         * against the three ticks this test dispatches, so the reconnect is delivered by a tick it
         * provokes - never left to the shipped five-second interval to deliver in real time, which
         * would make the shared cadence constant part of the assertion and cost the suite a
         * five-second sleep.
         */
        [`GET ${WATERMARK}`]: [
          { status: 0, body: null },
          { status: 0, body: null },
          watermarkAnswer(SECOND_WATERMARK),
        ],
        [`GET ${BASE}`]: [
          {
            status: 200,
            body: payload([sortedRound([category('cat-tooling', 'Tooling', [ADAS])], UNPLACED)]),
          },
          {
            status: 200,
            body: payload(
              [
                sortedRound(
                  [category('cat-tooling', 'Tooling', [ADAS, UNPLACED[0]!])],
                  UNPLACED.slice(1),
                ),
              ],
              SECOND_WATERMARK,
            ),
          },
        ],
      });

      expect(screen.getByTestId('activities-age').textContent).toBe('Updated just now');

      // Four minutes with nothing arriving. The ticks are real; the answers are not coming.
      now.mockReturnValue(start + 4 * 60_000);
      await tick();
      await settle();
      await tick();
      await settle();

      // The Board Bo was reading is still on screen - never replaced by an error box.
      expect(textsIn('category-cat-tooling')).toEqual([ADAS.text]);
      expect(screen.queryByTestId('activities-error')).toBeNull();
      // And the age is honest about how long ago that was.
      expect(screen.getByTestId('activities-age').textContent).toBe('Updated 4 minutes ago');

      // The link returns: the next poll replaces the Board and the age starts again.
      now.mockReturnValue(start + 5 * 60_000);
      await tick();
      await waitFor(() => expect(answersFor('GET', BASE)).toBe(2));
      await settle();

      expect(textsIn('category-cat-tooling')).toEqual([ADAS.text, UNPLACED[0]!.text]);
      expect(screen.getByTestId('activities-age').textContent).toBe('Updated just now');
    } finally {
      now.mockRestore();
    }
  });

  /**
   * **A healthy connection with nobody sorting stays "Updated just now"** (OC04, owner decision
   * 2026-09-02).
   *
   * The age answers "are we still in touch with the server", which is what a reader takes it to
   * mean - so it is anchored on the **watermark exchange**, the thing that happens every cadence,
   * and not on the last Board replacement, which for an Attendee happens only when somebody sorts.
   * Anchored on the read, a quiet room and a dead connection produce exactly the same sentence, and
   * an indicator that cries outage during normal operation is one people learn to ignore.
   *
   * The cursor never moves here, so the Board is never re-read - the assertion at the end is that
   * it was read exactly once. Every tick is answered; nothing is failing. Four minutes pass on the
   * device's own clock, which is more than enough for the 45-second "just now" threshold.
   */
  it('holds the age at “just now” while the watermark keeps answering and the cursor never moves', async () => {
    const start = Date.parse('2026-09-15T13:20:00.000Z');
    const now = vi.spyOn(Date, 'now').mockReturnValue(start);
    try {
      await renderPanel({
        // One entry, answered on every tick: the server is reachable and the Board has not changed.
        [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
        [`GET ${BASE}`]: {
          status: 200,
          body: payload([sortedRound([category('cat-tooling', 'Tooling', [ADAS])], UNPLACED)]),
        },
      });

      expect(screen.getByTestId('activities-age').textContent).toBe('Updated just now');

      // Ninety seconds of a quiet room: past the "just now" threshold, and nothing has gone wrong.
      now.mockReturnValue(start + 90_000);
      await tick();
      await waitFor(() => expect(answersFor('GET', WATERMARK)).toBe(1));
      await settle();

      expect(screen.getByTestId('activities-age').textContent).toBe('Updated just now');

      // Four minutes, still quiet, still reachable - the outage wording must not appear.
      now.mockReturnValue(start + 4 * 60_000);
      await tick();
      await waitFor(() => expect(answersFor('GET', WATERMARK)).toBe(2));
      await settle();

      expect(textsIn('category-cat-tooling')).toEqual([ADAS.text]);
      expect(screen.getByTestId('activities-age').textContent).toBe('Updated just now');
      // And none of that cost a second Board read: the cursor never moved.
      expect(answersFor('GET', BASE)).toBe(1);
    } finally {
      now.mockRestore();
    }
  });

  /**
   * **Membership ending replaces the Board; a dead connection does not** (Acceptance Scenario S06,
   * OC02, OC04).
   *
   * Both failures are run through one panel in one test, because the defect this guards against is
   * the *blurring* of them: a refusal about this caller's access has to take the Board away, and a
   * request that never left the device must not. The age goes with the Board, because there is no
   * longer anything on screen for it to be the age of.
   */
  it('replaces the board when membership ends, and keeps board and age through a dead connection', async () => {
    await renderPanel({
      [`GET ${WATERMARK}`]: [
        // The dead connection first, then the cursor that moves and brings the refusal with it.
        { status: 0, body: null },
        watermarkAnswer(SECOND_WATERMARK),
      ],
      [`GET ${BASE}`]: [
        {
          status: 200,
          body: payload([sortedRound([category('cat-tooling', 'Tooling', [ADAS])], [])]),
        },
        {
          status: 403,
          body: {
            error: {
              code: 'CONFERENCE_MEMBERSHIP_REQUIRED',
              message: 'You have not joined this conference.',
            },
          },
        },
      ],
    });

    // A dead connection first: the Board and its age both survive it.
    await tick();
    await settle();
    expect(textsIn('category-cat-tooling')).toEqual([ADAS.text]);
    expect(screen.getByTestId('activities-age')).not.toBeNull();

    // Then the revocation, which is the server answering about this caller.
    await tick();
    await waitFor(() => expect(answersFor('GET', BASE)).toBe(2));
    await settle();

    expect(screen.queryByTestId(`board-${ROUND_ID}`)).toBeNull();
    expect(screen.getByTestId('activities-error').textContent).toContain('not joined');
    // No age beside a refusal: there is nothing on screen for it to be the age of.
    expect(screen.queryByTestId('activities-age')).toBeNull();
  });
});
