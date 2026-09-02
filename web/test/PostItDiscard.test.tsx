import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IDBFactory } from 'fake-indexeddb';
import { SessionActivitiesPanel } from '../src/activities/SessionActivitiesPanel.tsx';
import { adoptCacheOwner, setCacheIdentity } from '../src/offline/schedule-cache.ts';
import { holdPostIt, listQueuedPostIts } from '../src/offline/post-it-queue.ts';
import type { Category, PostIt, Round, SessionWithRounds } from '../src/api/client.ts';

/**
 * Discard and restore on the client (S05 TI08, TI09, FR4, US05).
 *
 * Four disciplines, inherited from `PostItPlacement.test.tsx` and `docs/LEARNINGS.md#testing`:
 *
 *   - **Every assertion is made on the rendered Board and the rendered list**, never on a request
 *     count alone. A guard on the request issued stays green while the payload is wrong.
 *   - **The whole path is driven by keyboard**, through `userEvent.tab()` and `{Enter}`. Discard and
 *     restore sit beside the placement controls and are held to the same rule: no control on this
 *     surface is reachable only by pointer.
 *   - **Nothing is queued.** The device's store is seeded *before* the failed Discard and proved
 *     byte-identical afterwards, which is stronger than asserting it is empty.
 *   - **No reload, no remount, no navigation, and no test-only entry point.**
 *
 * `web/` has no jest-dom, so assertions are on plain DOM properties.
 */

const CONFERENCE_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const BASE = `/conferences/${CONFERENCE_ID}/sessions/${SESSION_ID}`;
const WATERMARK = `${BASE}/activities/watermark`;
const ROUND_ID = 'round-post-it';
const POST_IT_ID = 'p-staging';
const DISCARD = `${BASE}/rounds/${ROUND_ID}/post-its/${POST_IT_ID}/discard`;
const RESTORE = `${BASE}/rounds/${ROUND_ID}/post-its/${POST_IT_ID}/restore`;
const DISCARDED = `${BASE}/rounds/${ROUND_ID}/discarded-post-its`;
const DISPLAY_LINK = `${BASE}/rounds/${ROUND_ID}/display-link`;

const ADA = 'google-sub-ada';

const FIRST_WATERMARK = '4171';
const SECOND_WATERMARK = '4172';

const SERVER_CAP = 12;
const STAGING = 'we need a staging box';

function postIt(overrides: Partial<PostIt> & { id: string; text: string }): PostIt {
  return {
    authorName: 'Ada Lovelace',
    mine: false,
    edited: false,
    arrivedAfterClose: false,
    ...overrides,
  };
}

const STAGING_POST_IT = postIt({ id: POST_IT_ID, text: STAGING });

function category(id: string, name: string, postIts: PostIt[]): Category {
  return { id, name, postIts, postItCount: postIts.length };
}

function round(categories: Category[], uncategorised: PostIt[]): Round {
  return {
    id: ROUND_ID,
    kind: 'PostItRound',
    prompt: 'What slowed us down this quarter?',
    state: 'open',
    categories,
    uncategorised: { postIts: uncategorised, postItCount: uncategorised.length },
    textMaxLength: SERVER_CAP,
  };
}

/** Ada's post-it sitting in Tooling, beside one that stays there. */
function inTooling(): Round {
  return round(
    [
      category('cat-tooling', 'Tooling', [
        STAGING_POST_IT,
        postIt({ id: 'p-ci', text: 'flaky CI', authorName: 'Bo Nilsson' }),
      ]),
    ],
    [],
  );
}

/** The same Board once Ada's post-it has been discarded: gone from Tooling, gone from the counts. */
function afterDiscard(): Round {
  return round(
    [
      category('cat-tooling', 'Tooling', [
        postIt({ id: 'p-ci', text: 'flaky CI', authorName: 'Bo Nilsson' }),
      ]),
    ],
    [],
  );
}

/** And once it has been restored: back in **Uncategorised**, never in Tooling. */
function afterRestore(): Round {
  return round(
    [
      category('cat-tooling', 'Tooling', [
        postIt({ id: 'p-ci', text: 'flaky CI', authorName: 'Bo Nilsson' }),
      ]),
    ],
    [STAGING_POST_IT],
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

const TRACE = {
  id: POST_IT_ID,
  text: STAGING,
  authorName: 'Ada Lovelace',
  discardedByName: 'Ida Andersson',
  discardedAt: '2026-11-12 14:32 UTC',
};

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

/**
 * Puts keyboard focus on one control by tabbing to it, and presses Enter.
 *
 * Deliberately not `userEvent.click`: what is being proved is that the control is **reachable** in
 * the tab order and operable from the keyboard, which a click proves nothing about.
 */
async function tabToAndPress(
  user: ReturnType<typeof userEvent.setup>,
  testId: string,
): Promise<void> {
  const target = screen.getByTestId(testId);
  for (let step = 0; step < 160; step += 1) {
    if (document.activeElement === target) {
      await user.keyboard('{Enter}');
      return;
    }
    await user.tab();
  }
  throw new Error(`${testId} was not reachable by keyboard within 160 tab stops.`);
}

function textsIn(testId: string): string[] {
  return [...screen.getByTestId(testId).querySelectorAll('[data-testid^="post-it-text-"]')].map(
    (node) => node.textContent ?? '',
  );
}

describe('discarding a post-it and putting it back', () => {
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    window.__CONFAPP_CONFIG__ = { apiBaseUrl: '/api' };
    calls.length = 0;
    answered.length = 0;
    globalThis.indexedDB = new IDBFactory();
    setCacheIdentity(() => ADA);
    await adoptCacheOwner(ADA);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  async function renderPanel(routes: Record<string, Route | Route[]>): Promise<void> {
    globalThis.fetch = routeFetch({
      [`GET ${DISPLAY_LINK}`]: { status: 200, body: { displayLink: null } },
      ...routes,
    });
    render(<SessionActivitiesPanel conferenceId={CONFERENCE_ID} sessionId={SESSION_ID} />);
    await waitFor(() => expect(screen.queryByText(/Loading this session/)).toBeNull());
  }

  function watermarkAnswer(value: string): Route {
    return { status: 200, body: { activityWatermark: value, state: 'published' } };
  }

  // ---------- Acceptance Scenario S01: the board loses it, and the category's count falls ----------

  it('takes the post-it off the board and drops its category’s count, by keyboard alone', async () => {
    const user = userEvent.setup();
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: [
        { status: 200, body: payload([inTooling()]) },
        { status: 200, body: payload([afterDiscard()], true, SECOND_WATERMARK) },
      ],
      [`GET ${DISCARDED}`]: [
        { status: 200, body: { discarded: [] } },
        { status: 200, body: { discarded: [TRACE] } },
      ],
      [`POST ${DISCARD}`]: { status: 200, body: { discarded: true } },
    });

    expect(textsIn('category-cat-tooling')).toEqual([STAGING, 'flaky CI']);
    expect(screen.getByTestId('category-count-cat-tooling').textContent).toBe('2 post-its');

    await tabToAndPress(user, `post-it-discard-${POST_IT_ID}`);
    await waitFor(() => expect(answersFor('POST', DISCARD)).toBe(1));
    await settle();

    // No body at all: the discarder is the credential and there is no field one could arrive through.
    expect(
      calls.find((call) => call.method === 'POST' && call.path === DISCARD)!.body,
    ).toBeUndefined();

    // The Board re-renders from the server's answer. Nothing here is derived on the client.
    expect(textsIn('category-cat-tooling')).toEqual(['flaky CI']);
    expect(screen.getByTestId('category-count-cat-tooling').textContent).toBe('1 post-it');
    expect(screen.getByTestId(`uncategorised-count-${ROUND_ID}`).textContent).toBe('0 post-its');
    expect(screen.queryByTestId(`post-it-text-${POST_IT_ID}`)).toBeNull();
  });

  // ---------- Acceptance Scenario S03: restore, and where it lands ----------

  it('lists the discarded post-it with both names and restores it to uncategorised', async () => {
    const user = userEvent.setup();
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: [
        { status: 200, body: payload([afterDiscard()]) },
        { status: 200, body: payload([afterRestore()], true, SECOND_WATERMARK) },
      ],
      [`GET ${DISCARDED}`]: [
        { status: 200, body: { discarded: [TRACE] } },
        { status: 200, body: { discarded: [] } },
      ],
      [`POST ${RESTORE}`]: { status: 200, body: { restored: true } },
    });

    /*
     * The entry point is permanent and carries the count - it is not the aftermath of a Discard and
     * it is not a timed undo (`design-decisions.md` → "The discarded Post-its surface").
     */
    await waitFor(() =>
      expect(screen.getByTestId(`discarded-toggle-${ROUND_ID}`).textContent).toBe(
        'Discarded post-its (1)',
      ),
    );

    await tabToAndPress(user, `discarded-toggle-${ROUND_ID}`);
    await settle();

    // The trace, and both names: whose idea it was, and who took it off the board.
    expect(screen.getByTestId(`discarded-by-${POST_IT_ID}`).textContent).toBe('Ada Lovelace');
    expect(screen.getByTestId(`discarded-trace-${POST_IT_ID}`).textContent).toBe(
      'Discarded by Ida Andersson · 2026-11-12 14:32 UTC',
    );
    // The control names its destination, so the rule is read before it is exercised.
    expect(screen.getByTestId(`discarded-restore-${POST_IT_ID}`).textContent).toBe(
      'Restore to Uncategorised',
    );
    // And nothing on this surface is worded as a removal that cannot be undone (S06 is elsewhere).
    expect(screen.getByTestId(`discarded-panel-${ROUND_ID}`).textContent).not.toMatch(
      /delete|permanent|cannot be undone/i,
    );

    await tabToAndPress(user, `discarded-restore-${POST_IT_ID}`);
    await waitFor(() => expect(answersFor('POST', RESTORE)).toBe(1));
    await settle();

    // No body: a restore names no destination, because it always has exactly one.
    expect(
      calls.find((call) => call.method === 'POST' && call.path === RESTORE)!.body,
    ).toBeUndefined();

    // Back in Uncategorised, and not in the category it came from.
    expect(textsIn(`uncategorised-${ROUND_ID}`)).toEqual([STAGING]);
    expect(screen.getByTestId('category-count-cat-tooling').textContent).toBe('1 post-it');
    expect(textsIn('category-cat-tooling')).toEqual(['flaky CI']);
    expect(screen.queryByTestId(`discarded-item-${POST_IT_ID}`)).toBeNull();
  });

  // ---------- Acceptance Scenario S05: the refusal is the server's own sentence ----------

  it('renders the archived refusal and leaves the post-it listed', async () => {
    const user = userEvent.setup();
    const archived =
      'This conference has been archived, so it is read-only and can no longer be changed.';
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: { status: 200, body: payload([afterDiscard()]) },
      /*
       * The list is read **before** the archive lands and refused afterwards, which is what the real
       * API does: the read goes through the same `authorizeWrite` gate as the writes, so once the
       * Conference is archived every one of the three answers `CONFERENCE_NOT_EDITABLE`. Stubbing a
       * 200 list beside a 409 restore would be a pairing no server can produce, and the scenario
       * would prove nothing about the surface.
       */
      [`GET ${DISCARDED}`]: [
        { status: 200, body: { discarded: [TRACE] } },
        {
          status: 409,
          body: { error: { code: 'CONFERENCE_NOT_EDITABLE', message: archived } },
        },
      ],
      [`POST ${RESTORE}`]: {
        status: 409,
        body: { error: { code: 'CONFERENCE_NOT_EDITABLE', message: archived } },
      },
    });

    await tabToAndPress(user, `discarded-toggle-${ROUND_ID}`);
    await settle();
    await tabToAndPress(user, `discarded-restore-${POST_IT_ID}`);
    await waitFor(() => expect(answersFor('POST', RESTORE)).toBe(1));
    await settle();

    // The server's sentence verbatim, held at panel level where the re-read cannot take it away.
    expect(screen.getByTestId(`board-error-${ROUND_ID}`).textContent).toBe(archived);
    /*
     * And the item is **still listed**, which is TI09's verify and the whole point: the list this
     * surface is already showing survives a refused re-read, so the Discard visibly still stands
     * rather than the Post-it disappearing from the one place it can be reversed from.
     */
    expect(screen.getByTestId(`discarded-item-${POST_IT_ID}`)).toBeTruthy();
    expect(screen.getByTestId(`discarded-restore-${POST_IT_ID}`)).toBeTruthy();
  });

  // ---------- FR4 error handling: online-only, and nothing is held ----------

  it('states an undelivered discard, leaves the post-it drawn, and queues nothing', async () => {
    const user = userEvent.setup();
    // Seeded *before* the failure, and proved byte-identical afterwards - stronger than "empty".
    await holdPostIt({
      submissionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      conferenceId: CONFERENCE_ID,
      sessionId: SESSION_ID,
      roundId: ROUND_ID,
      text: 'an idea still waiting on this device',
    });
    const before = await listQueuedPostIts();

    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: { status: 200, body: payload([inTooling()]) },
      [`GET ${DISCARDED}`]: { status: 200, body: { discarded: [] } },
      // Never answered: the request did not reach the API at all.
      [`POST ${DISCARD}`]: { status: 0 },
    });

    await tabToAndPress(user, `post-it-discard-${POST_IT_ID}`);
    await settle();

    expect(screen.getByTestId(`board-error-${ROUND_ID}`).textContent).toBe(
      "Couldn't discard that – check your connection.",
    );
    // The post-it is still drawn exactly where the board says it is.
    expect(textsIn('category-cat-tooling')).toEqual([STAGING, 'flaky CI']);
    // And the device holds precisely what it held before - no discard was queued for later.
    expect(await listQueuedPostIts()).toEqual(before);
  });

  // ---------- FR4: the two removals are two controls, and never the same one ----------

  it('offers discard on every post-it and the author’s own remove only on theirs', async () => {
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: {
        status: 200,
        body: payload([
          round(
            [],
            [
              postIt({ id: POST_IT_ID, text: STAGING, mine: true }),
              postIt({ id: 'p-ci', text: 'flaky CI', authorName: 'Bo Nilsson' }),
            ],
          ),
        ]),
      },
      [`GET ${DISCARDED}`]: { status: 200, body: { discarded: [] } },
    });

    // Discard sits on both, wherever they are and whoever wrote them.
    expect(screen.getByTestId(`post-it-discard-${POST_IT_ID}`)).toBeTruthy();
    expect(screen.getByTestId('post-it-discard-p-ci')).toBeTruthy();
    // The author's own deletion sits only on their own.
    expect(screen.getByTestId(`post-it-remove-${POST_IT_ID}`)).toBeTruthy();
    expect(screen.queryByTestId('post-it-remove-p-ci')).toBeNull();
    // And where both are offered, the difference is said in words rather than left to the shapes.
    expect(screen.getByTestId(`post-it-removal-note-${POST_IT_ID}`).textContent).toMatch(
      /leaves no trace[\s\S]*leaves a trace/i,
    );
    expect(screen.queryByTestId('post-it-removal-note-p-ci')).toBeNull();
  });

  // ---------- FR4: an attendee is offered none of it ----------

  it('offers no discard control and no discarded list to a member who does not sort', async () => {
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: {
        status: 200,
        body: payload([round([], [postIt({ id: POST_IT_ID, text: STAGING, mine: true })])], false),
      },
    });

    expect(screen.queryByTestId(`post-it-discard-${POST_IT_ID}`)).toBeNull();
    expect(screen.queryByTestId(`discarded-${ROUND_ID}`)).toBeNull();
    // Not even read: the list is a facilitator's surface and this client never asks for it.
    expect(calls.some((call) => call.path === DISCARDED)).toBe(false);
  });
});
