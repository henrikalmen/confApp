import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IDBFactory } from 'fake-indexeddb';
import { SessionActivitiesPanel } from '../src/activities/SessionActivitiesPanel.tsx';
import { adoptCacheOwner, cachedKeys, setCacheIdentity } from '../src/offline/schedule-cache.ts';
import { listQueuedPostIts, queuedKeys } from '../src/offline/post-it-queue.ts';
import { PostItQueueDrain } from '../src/offline/use-post-it-queue.ts';
import type { PostIt, Round, SessionWithRounds } from '../src/api/client.ts';

/**
 * S04 on the client: a post-it that could not be delivered is held, shown, sent when it can be, and
 * brought back to its author when it never can.
 *
 * Three disciplines, all of them things this repository has already been bitten by:
 *
 *   - **Offline is a request failing**, never a stubbed flag. The transport throws, exactly as
 *     `fetch` does with no route to the host, and the panel has to notice for itself. A flag would
 *     pass while the captive-portal path still hung.
 *   - **Every assertion is on the rendered state and on the store**, not on a request count. A guard
 *     watching the request stays green while the payload is wrong
 *     (`docs/LEARNINGS.md#testing`). Where "it stopped retrying" is genuinely about requests, the
 *     rendered item is asserted first and the request count second.
 *   - **Ownership is claimed before anything is written.** `adoptCacheOwner` fails closed, so an
 *     entry written before the claim is deleted and every "the queue is empty" reading afterwards
 *     passes for the wrong reason.
 *
 * `web/` has no jest-dom, so assertions are on plain DOM properties.
 */

const CONFERENCE_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const BASE = `/conferences/${CONFERENCE_ID}/sessions/${SESSION_ID}`;
const WATERMARK = `${BASE}/activities/watermark`;
const ROUND_ID = 'round-post-it';
const POLL_ID = 'round-poll';
const BOARD = `${BASE}/rounds/${ROUND_ID}/post-its`;
const VOTES = `${BASE}/rounds/${POLL_ID}/votes`;

const NADIA = 'google-sub-nadia';
const BJORN = 'google-sub-bjorn';

const FIRST_WATERMARK = '4171';
const SECOND_WATERMARK = '4172';
/**
 * The cap as the **server** states it, and deliberately not the real one: no number under `web/`
 * is the client's own, so a fixture repeating 280 here would be the second source the whole
 * arrangement exists to prevent (`api/src/rounds/post-it-validation.ts`).
 */
const SERVER_CAP = 40;

const IDEA = 'Nobody owns the staging environment';

function postIt(overrides: Partial<PostIt> & { id: string; text: string }): PostIt {
  return {
    authorName: 'Nadia Ek',
    mine: true,
    edited: false,
    arrivedAfterClose: false,
    ...overrides,
  };
}

function board(state: 'open' | 'closed', postIts: PostIt[]): Round {
  return {
    id: ROUND_ID,
    kind: 'PostItRound',
    prompt: 'What slowed us down?',
    state,
    postIts,
    textMaxLength: SERVER_CAP,
  };
}

function poll(): Round {
  return {
    id: POLL_ID,
    kind: 'VotingRound',
    purpose: 'Poll',
    prompt: 'Where should we start?',
    state: 'open',
    options: [
      { id: 'option-tooling', label: 'Tooling' },
      { id: 'option-meetings', label: 'Meetings' },
    ],
    hasVoted: false,
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
    canRun: true,
    activityWatermark,
  };
}

/** A stubbed answer, or a transport that never reaches the host at all. */
type Route = { status: number; body: unknown } | 'unreachable';

const calls: { method: string; path: string; body: unknown }[] = [];

function routeFetch(routes: Record<string, Route | Route[]>): typeof fetch {
  return vi.fn(async (input: unknown, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = String(input)
      .replace(/^.*\/api/, '')
      .replace(/\?.*$/, '');
    const attempt = calls.filter((call) => call.method === method && call.path === path).length;
    calls.push({
      method,
      path,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });

    const entry = routes[`${method} ${path}`];
    if (entry === undefined) throw new Error(`No route stubbed for ${method} ${path}.`);

    const route = Array.isArray(entry)
      ? (entry[Math.min(attempt, entry.length - 1)] as Route)
      : entry;

    // Not a status and not a flag: the fetch itself rejects, which is what a dead spot does.
    if (route === 'unreachable') throw new TypeError('Failed to fetch');

    return new Response(JSON.stringify(route.body), {
      status: route.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

function sent(method: string, path: string): number {
  return calls.filter((call) => call.method === method && call.path === path).length;
}

function refusal(code: string, message: string): Route {
  return { status: code === 'ROUND_NOT_FOUND' ? 404 : 409, body: { error: { code, message } } };
}

function watermarkAnswer(activityWatermark: string): Route {
  return { status: 200, body: { activityWatermark, state: 'published' } };
}

/** Lets an answered request finish being handled, on the real clock. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
}

function textOnBoard(): string[] {
  return [...document.querySelectorAll('[data-testid^="post-it-text-"]')].map(
    (node) => node.textContent ?? '',
  );
}

function heldOnScreen(): string[] {
  return [...document.querySelectorAll('[data-testid^="held-text-"]')].map(
    (node) => node.textContent ?? '',
  );
}

describe('a post-it typed with no connection', () => {
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    window.__CONFAPP_CONFIG__ = { apiBaseUrl: '/api' };
    calls.length = 0;
    globalThis.indexedDB = new IDBFactory();
    setCacheIdentity(() => NADIA);
    // Claimed first, always: a write before the claim is purged by it.
    await adoptCacheOwner(NADIA);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /**
   * The panel **with the shell's drain beside it**, which is where the drain lives (product
   * decision, 2026-08-29): the panel renders what is held and no longer owns the loop that sends
   * it. `PostItQueueDrain` renders nothing, so what is on screen here is exactly the panel.
   *
   * That the drain runs with no panel mounted at all is the point of `PostItQueueDrain.test.tsx`;
   * what this file proves is the pair working together, which is what an attendee looking at the
   * board actually sees.
   */
  async function renderPanel(routes: Record<string, Route | Route[]>): Promise<void> {
    globalThis.fetch = routeFetch(routes);
    render(
      <>
        <PostItQueueDrain />
        <SessionActivitiesPanel conferenceId={CONFERENCE_ID} sessionId={SESSION_ID} />
      </>,
    );
    await waitFor(() => expect(screen.queryByText(/Loading this session/)).toBeNull());
  }

  async function compose(text: string): Promise<void> {
    await userEvent.type(screen.getByTestId(`compose-${ROUND_ID}`), text);
    await userEvent.click(screen.getByTestId(`compose-submit-${ROUND_ID}`));
    await settle();
  }

  // ---------- TI03: the request failing is what holds it ----------

  it('holds the typed text on the device when the submission cannot be delivered', async () => {
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: { status: 200, body: payload([board('open', [])]) },
      [`POST ${BOARD}`]: 'unreachable',
    });

    await compose(IDEA);

    const queued = await listQueuedPostIts(NADIA);
    expect(queued.map((item) => item.text)).toEqual([IDEA]);
    expect(queued[0]!.roundId).toBe(ROUND_ID);
    expect(queued[0]!.refusal).toBeNull();

    // On her own board, under her name, and reading as pending rather than posted.
    expect(heldOnScreen()).toEqual([IDEA]);
    const held = screen.getByTestId(`held-post-it-${queued[0]!.submissionId}`);
    expect(held.getAttribute('data-held')).toBe('pending');
    expect(screen.getByTestId(`held-pending-${queued[0]!.submissionId}`).textContent).toMatch(
      /waiting to be posted/i,
    );
    expect(screen.getByTestId(`held-by-${queued[0]!.submissionId}`).textContent).not.toBe('');

    // The box is empty: the text lives in the queue now, not in two places at once.
    expect((screen.getByTestId(`compose-${ROUND_ID}`) as HTMLTextAreaElement).value).toBe('');
    expect(screen.queryByTestId(`board-error-${ROUND_ID}`)).toBeNull();

    // The identity was minted before the attempt that failed, and the queued item carries that
    // same one - not a fresh one, which a retry could not be recognised by.
    const live = calls.find((call) => call.method === 'POST' && call.path === BOARD)!;
    expect((live.body as { submissionId: string }).submissionId).toBe(queued[0]!.submissionId);
  });

  it('holds nothing when the submission succeeds', async () => {
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: [
        { status: 200, body: payload([board('open', [])]) },
        { status: 200, body: payload([board('open', [postIt({ id: 'p1', text: IDEA })])]) },
      ],
      [`POST ${BOARD}`]: { status: 200, body: { postIt: postIt({ id: 'p1', text: IDEA }) } },
    });

    await compose(IDEA);

    expect(await queuedKeys()).toEqual([]);
    expect(heldOnScreen()).toEqual([]);
    expect(textOnBoard()).toEqual([IDEA]);
  });

  /**
   * A refusal is an answer, and answers are not held. The typed text stays in the box exactly where
   * it was, which is S02's rule and is not suspended because S04 exists.
   */
  it('does not hold a submission the server refused', async () => {
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: { status: 200, body: payload([board('open', [])]) },
      [`POST ${BOARD}`]: refusal(
        'POST_IT_ROUND_CLOSED',
        'This round is closed, so it is not taking post-its at the moment.',
      ),
    });

    await compose(IDEA);

    expect(await queuedKeys()).toEqual([]);
    expect(heldOnScreen()).toEqual([]);
    expect(screen.getByTestId(`board-error-${ROUND_ID}`).textContent).toMatch(/closed/i);
    expect((screen.getByTestId(`compose-${ROUND_ID}`) as HTMLTextAreaElement).value).toBe(IDEA);
  });

  // ---------- TI04: it survives the app being killed ----------

  it('still reads as pending, under its author, after the app is relaunched', async () => {
    const routes: Record<string, Route | Route[]> = {
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: { status: 200, body: payload([board('open', [])]) },
      [`POST ${BOARD}`]: 'unreachable',
    };
    await renderPanel(routes);
    await compose(IDEA);
    const [before] = await listQueuedPostIts(NADIA);

    // The force-quit: everything this component was holding in memory goes.
    cleanup();
    await renderPanel(routes);
    await settle();

    expect(heldOnScreen()).toEqual([IDEA]);
    const held = screen.getByTestId(`held-post-it-${before!.submissionId}`);
    expect(held.getAttribute('data-held')).toBe('pending');
    // The same submission identity as before, so the retry cannot become a second post-it.
    expect((await listQueuedPostIts(NADIA))[0]!.submissionId).toBe(before!.submissionId);
  });

  // ---------- TI05: the drain ----------

  it('sends it when the link returns, and the board is where it then appears', async () => {
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: [
        { status: 200, body: payload([board('open', [])]) },
        { status: 200, body: payload([board('open', [])]) },
        { status: 200, body: payload([board('open', [postIt({ id: 'p1', text: IDEA })])]) },
      ],
      [`POST ${BOARD}`]: [
        'unreachable',
        { status: 200, body: { postIt: postIt({ id: 'p1', text: IDEA }) } },
      ],
    });

    await compose(IDEA);
    expect(heldOnScreen()).toEqual([IDEA]);

    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    await waitFor(() => expect(textOnBoard()).toEqual([IDEA]));
    await settle();

    // Nothing left on the device, and nothing shown as pending any more.
    expect(await queuedKeys()).toEqual([]);
    expect(heldOnScreen()).toEqual([]);
    // The offline-composed marker and the stored identity rode with the attempt.
    const attempt = calls.filter((call) => call.method === 'POST' && call.path === BOARD).at(-1)!;
    expect((attempt.body as { offlineComposed: boolean }).offlineComposed).toBe(true);
    expect(typeof (attempt.body as { submissionId: string }).submissionId).toBe('string');
  });

  /**
   * The lost-response case (Acceptance Scenario S05).
   *
   * **The identity is minted before the *first* attempt**, so all three sends here carry the same
   * one. That is the whole guarantee: the client cannot tell a request that never left the phone
   * from one that reached the API, wrote the row and lost its answer, so the very first attempt has
   * to be idempotent too. Minting on the way into the queue instead would give the retry a new key,
   * the constraint would see two, and one idea would land twice under a real name.
   *
   * What this file proves is that the identity rides every attempt unchanged. That two such
   * attempts leave one row is a **database** property and is proved where it lives, in
   * `api/test/post-it.integration.test.ts`; the board reading below comes from a stub and could not
   * establish it.
   */
  it('sends one submission identity on every attempt, first send included', async () => {
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: [
        { status: 200, body: payload([board('open', [])]) },
        { status: 200, body: payload([board('open', [])]) },
        { status: 200, body: payload([board('open', [postIt({ id: 'p1', text: IDEA })])]) },
      ],
      [`POST ${BOARD}`]: [
        // The live submission. It may or may not have reached the API - the phone cannot tell,
        // which is exactly why it already carries the identity the sends below reuse.
        'unreachable',
        // The first send: it reached the API, and its answer did not come back.
        'unreachable',
        // The retry, which the API resolved onto the row it already had.
        { status: 200, body: { postIt: postIt({ id: 'p1', text: IDEA }) } },
      ],
    });

    await compose(IDEA);
    const [queued] = await listQueuedPostIts(NADIA);

    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    await settle();
    // Still here after the lost answer, which is what makes the next attempt a retry.
    expect(heldOnScreen()).toEqual([IDEA]);

    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    await waitFor(() => expect(textOnBoard()).toEqual([IDEA]));
    await settle();

    expect(textOnBoard()).toEqual([IDEA]);
    expect(heldOnScreen()).toEqual([]);
    expect(await queuedKeys()).toEqual([]);
    /*
     * Both *sends* carried one and the same identity - the one stored with the item rather than a
     * fresh one per attempt - which is what the API's constraint turns into one post-it. The live
     * submission before them carried none, because it was not a queued item.
     */
    const attempts = calls.filter((call) => call.method === 'POST' && call.path === BOARD);
    expect(attempts).toHaveLength(3);
    for (const attempt of attempts) {
      expect((attempt.body as { submissionId: string }).submissionId).toBe(queued!.submissionId);
    }
    // Only the two *sends* claim to have been composed offline; the live submission was not.
    expect(
      attempts.map((attempt) => (attempt.body as { offlineComposed?: true }).offlineComposed),
    ).toEqual([undefined, true, true]);
  });

  it('keeps it queued, pending and unchanged when the retry fails too, and says nothing', async () => {
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: { status: 200, body: payload([board('open', [])]) },
      [`POST ${BOARD}`]: 'unreachable',
    });

    await compose(IDEA);
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    await settle();

    const queued = await listQueuedPostIts(NADIA);
    expect(queued.map((item) => item.text)).toEqual([IDEA]);
    expect(queued[0]!.refusal).toBeNull();
    expect(
      screen.getByTestId(`held-post-it-${queued[0]!.submissionId}`).getAttribute('data-held'),
    ).toBe('pending');
    // A failure worth retrying says nothing at all: there is nothing for its author to do.
    expect(screen.queryByTestId(`held-refusal-${queued[0]!.submissionId}`)).toBeNull();
  });

  it('keeps it queued through a 5xx, which is a failure and not a refusal', async () => {
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: { status: 200, body: payload([board('open', [])]) },
      [`POST ${BOARD}`]: [
        'unreachable',
        { status: 503, body: { error: { code: 'DATABASE_UNAVAILABLE', message: 'Not now.' } } },
      ],
    });

    await compose(IDEA);
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    await settle();

    const queued = await listQueuedPostIts(NADIA);
    expect(queued.map((item) => item.text)).toEqual([IDEA]);
    expect(queued[0]!.refusal).toBeNull();
  });

  it('keeps it queued through a 401, which is a lapsed credential and not a refusal', async () => {
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: { status: 200, body: payload([board('open', [])]) },
      [`POST ${BOARD}`]: [
        'unreachable',
        {
          status: 401,
          body: { error: { code: 'AUTH_TOKEN_EXPIRED', message: 'Your sign-in has expired.' } },
        },
      ],
    });

    await compose(IDEA);
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    await settle();

    /*
     * A credential this client believed valid and the server did not is "not now", exactly like the
     * lapsed-credential case the client catches for itself. Stamping the post-it with a sign-in
     * message and never trying again would strand it even after its author signs straight back in.
     */
    const queued = await listQueuedPostIts(NADIA);
    expect(queued.map((item) => item.text)).toEqual([IDEA]);
    expect(queued[0]!.refusal).toBeNull();
    expect(screen.queryByTestId(`held-refusal-${queued[0]!.submissionId}`)).toBeNull();
  });

  /**
   * A drain that outlives the identity that started it stops rather than finishing under the next
   * one.
   *
   * A send can take as long as a dead spot lasts, and a shared tablet changes hands inside that
   * window. The first item's send is held open until Anna has been replaced by Björn and then
   * allowed to succeed, so the drain really does reach its second iteration with a different person
   * signed in — which is the only arrangement in which the check can be observed at all. Nothing of
   * Anna's may go up under Björn's credential, under his name, permanently (FIS Structural
   * Criterion: "no code path reads or **sends** an entry written under a different `sub`").
   */
  it('stops sending when the device changes hands mid-drain', async () => {
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: { status: 200, body: payload([board('open', [])]) },
      [`POST ${BOARD}`]: 'unreachable',
    });

    // Two items held, so the drain has a second iteration to reach - or not.
    await compose('First idea');
    await compose('Second idea');
    expect(await queuedKeys()).toHaveLength(2);

    const sendsBefore = sent('POST', BOARD);
    let sendReached: (() => void) | null = null;
    const firstSendOut = new Promise<void>((resolve) => {
      sendReached = resolve;
    });
    let allowFirstSend: (() => void) | null = null;
    const handoverDone = new Promise<void>((resolve) => {
      allowFirstSend = resolve;
    });

    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const path = String(input).replace(/^.*\/api/, '');
      calls.push({ method, path, body: undefined });

      if (method === 'POST' && path === BOARD) {
        // The first send is held open across the handover, then succeeds.
        if (sendReached !== null) {
          const reached = sendReached;
          sendReached = null;
          reached();
          await handoverDone;
        }
        return new Response(
          JSON.stringify({ postIt: postIt({ id: 'p-first', text: 'First idea' }) }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify(payload([board('open', [])])), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    // The whole handover inside one `act`, so nothing is left pending when this test ends.
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      await firstSendOut;
      // Anna signs out and Björn signs in while her first send is still out.
      setCacheIdentity(() => BJORN);
      allowFirstSend!();
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    await settle();

    /*
     * Exactly one further send: the one already in flight when the identity changed. The second
     * item was never attempted, so nothing of Anna's went up under Björn's credential - and her
     * remaining item is still hers, keyed under her own subject rather than deleted under his.
     */
    expect(sent('POST', BOARD) - sendsBefore).toBe(1);
    expect((await listQueuedPostIts(NADIA)).map((item) => item.text)).toEqual(['Second idea']);
    expect(await listQueuedPostIts(BJORN)).toEqual([]);
  });

  // ---------- TI09: a round that is gone ----------

  it('brings the text back to its author with a reason, and keeps it until they act', async () => {
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      /*
       * The Round is present on the first read - it has to be, or there would have been nothing to
       * compose against - and **gone from the second**, because an Admin deleted it while the phone
       * was out of coverage. That is why the send is refused, and it is the shape the earlier
       * version of this test could not produce: a payload still listing the round would have hidden
       * the item on a surface that no longer exists.
       */
      [`GET ${BASE}`]: [
        { status: 200, body: payload([board('open', [])]) },
        { status: 200, body: payload([]) },
      ],
      [`POST ${BOARD}`]: [
        'unreachable',
        refusal('ROUND_NOT_FOUND', 'That round is no longer part of this session.'),
      ],
    });

    await compose(IDEA);
    const [queued] = await listQueuedPostIts(NADIA);

    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    await settle();

    // The round is gone from the session, so there is no board to hang this on – and the text is
    // on screen anyway, whole, beside the server's own sentence rather than instead of it.
    expect(screen.queryByTestId(`board-${ROUND_ID}`)).toBeNull();
    expect(screen.getByTestId('held-post-its')).not.toBeNull();
    expect(heldOnScreen()).toEqual([IDEA]);
    expect(screen.getByTestId(`held-refusal-${queued!.submissionId}`).textContent).toMatch(
      /no longer part of this session/,
    );
    expect(
      screen.getByTestId(`held-post-it-${queued!.submissionId}`).getAttribute('data-held'),
    ).toBe('refused');
    expect((await listQueuedPostIts(NADIA))[0]!.text).toBe(IDEA);

    // And it stops retrying: a further reconnect leaves the item exactly as it is.
    const attemptsBefore = sent('POST', BOARD);
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    await settle();
    expect(heldOnScreen()).toEqual([IDEA]);
    expect(sent('POST', BOARD)).toBe(attemptsBefore);

    // It leaves the device on her action, and not before.
    await userEvent.click(screen.getByTestId(`held-dismiss-${queued!.submissionId}`));
    await settle();
    expect(heldOnScreen()).toEqual([]);
    expect(await queuedKeys()).toEqual([]);
  });

  // ---------- TI08: a late arrival says so ----------

  it('shows a late-arrival marking on a post-it that has one, and none on one that has not', async () => {
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: {
        status: 200,
        body: payload([
          board('closed', [
            postIt({ id: 'p-live', text: 'Typed while it was open' }),
            postIt({ id: 'p-late', text: IDEA, arrivedAfterClose: true }),
          ]),
        ]),
      },
    });

    expect(screen.getByTestId('post-it-late-p-late').textContent).toMatch(
      /arrived after this round closed/i,
    );
    expect(screen.queryByTestId('post-it-late-p-live')).toBeNull();
  });

  // ---------- TI10: the device gains this capability and no other ----------

  /**
   * Asserted **behaviourally**, by attempting each write with nothing reachable and reading what the
   * device holds afterwards – not by grepping a file list, which is only ever as good as its longest
   * omission (`docs/LEARNINGS.md#testing`).
   */
  it('queues nothing for a vote, a round transition, a correction or a removal', async () => {
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: {
        status: 200,
        body: payload([board('open', [postIt({ id: 'p-mine', text: 'Handover gaps' })]), poll()]),
      },
      [`POST ${VOTES}`]: 'unreachable',
      [`POST ${BASE}/rounds/${ROUND_ID}/close`]: 'unreachable',
      [`POST ${BASE}/rounds/${ROUND_ID}/open`]: 'unreachable',
      [`PATCH ${BOARD}/p-mine`]: 'unreachable',
      [`DELETE ${BOARD}/p-mine`]: 'unreachable',
    });

    const before = await cachedKeys();

    await userEvent.click(screen.getByTestId('poll-option-option-tooling'));
    await userEvent.click(screen.getByTestId(`poll-submit-${POLL_ID}`));
    await settle();

    await userEvent.click(screen.getByTestId(`round-close-${ROUND_ID}`));
    await settle();
    await userEvent.click(screen.getByTestId(`round-open-${ROUND_ID}`));
    await settle();

    await userEvent.click(screen.getByTestId('post-it-correct-p-mine'));
    await userEvent.type(screen.getByTestId('post-it-edit-p-mine'), ' and more');
    await userEvent.click(screen.getByTestId('post-it-save-p-mine'));
    await settle();

    // The correction was refused, so its box is still standing; close it to reach the remove
    // control underneath, which is the last of the four writes.
    await userEvent.click(screen.getByTestId('post-it-cancel-p-mine'));
    await userEvent.click(screen.getByTestId('post-it-remove-p-mine'));
    await settle();

    // Nothing was held for later by any of them, and the schedule cache is untouched.
    expect(await queuedKeys()).toEqual([]);
    expect(await cachedKeys()).toEqual(before);
    // Each of them said so instead – a refusal on screen, not a silent deferral.
    expect(screen.getByTestId(`poll-error-${POLL_ID}`).textContent).toMatch(/could not reach/i);
    expect(screen.getByTestId('activities-refusal').textContent).toMatch(/could not reach/i);
    expect(screen.getByTestId(`board-error-${ROUND_ID}`).textContent).toMatch(/could not reach/i);
  });

  /**
   * Acceptance Scenario S07, first half: the device gains **one** offline capability.
   *
   * With the Session read failing there is no Round on screen at all - no prompt, no compose box, no
   * choice list, no run control. What is offered is exactly what this device is holding: the text
   * its owner typed, so she can see it was not lost. A Round is composable against only once the app
   * has rendered it open from the server, which is what keeps this from becoming offline Round
   * browsing.
   */
  it('offers no round, no compose box and no vote affordance when the session cannot be read', async () => {
    // First launch, with a connection: the round is rendered open and the post-it is typed into it.
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: { status: 200, body: payload([board('open', []), poll()]) },
      [`POST ${BOARD}`]: 'unreachable',
    });
    await compose(IDEA);
    const [queued] = await listQueuedPostIts(NADIA);

    // The relaunch, in the dead spot: nothing is reachable, so the session read fails too.
    cleanup();
    await renderPanel({
      [`GET ${WATERMARK}`]: 'unreachable',
      [`GET ${BASE}`]: 'unreachable',
      [`POST ${BOARD}`]: 'unreachable',
    });
    await settle();

    // Her own text, still here and still pending.
    expect(heldOnScreen()).toEqual([IDEA]);
    expect(
      screen.getByTestId(`held-post-it-${queued!.submissionId}`).getAttribute('data-held'),
    ).toBe('pending');

    // And nothing else: no round content came from anywhere, so none is shown.
    expect(screen.queryByTestId('round-list')).toBeNull();
    expect(screen.queryByTestId(`compose-${ROUND_ID}`)).toBeNull();
    expect(screen.queryByTestId(`board-${ROUND_ID}`)).toBeNull();
    expect(screen.queryByTestId(`poll-${POLL_ID}`)).toBeNull();
    expect(screen.queryByTestId('poll-option-option-tooling')).toBeNull();
    expect(screen.queryByTestId(`round-open-${ROUND_ID}`)).toBeNull();
    expect(screen.getByTestId('activities-error').textContent).toMatch(/could not reach/i);
  });

  // ---------- Acceptance Scenario S04: a shared tablet ----------

  it('hands the next employee nothing of the previous one’s queued post-its', async () => {
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(SECOND_WATERMARK),
      [`GET ${BASE}`]: { status: 200, body: payload([board('open', [])]) },
      [`POST ${BOARD}`]: 'unreachable',
    });
    await compose(IDEA);
    expect(await queuedKeys()).toHaveLength(1);

    // Anna's session ended without a clean sign-out; Björn signs in on the next launch and the
    // store's own owner check is what covers it.
    cleanup();
    setCacheIdentity(() => BJORN);
    await adoptCacheOwner(BJORN);

    expect(await queuedKeys()).toEqual([]);
    expect(await listQueuedPostIts(BJORN)).toEqual([]);
    expect(await listQueuedPostIts(NADIA)).toEqual([]);

    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(SECOND_WATERMARK),
      [`GET ${BASE}`]: { status: 200, body: payload([board('open', [])]) },
    });
    await settle();
    expect(heldOnScreen()).toEqual([]);
    // Nothing of hers was ever sent under his credential either.
    expect(sent('POST', BOARD)).toBe(1);
  });
});
