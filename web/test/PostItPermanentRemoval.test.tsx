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
 * **Permanent Removal** on the client (S06 TI05, FR5, US06).
 *
 * Four disciplines, inherited from `PostItDiscard.test.tsx` and `docs/LEARNINGS.md#testing`:
 *
 *   - **Every assertion is made on the rendered Board**, never on a request count alone. A guard on
 *     the request issued stays green while the payload is wrong. Where a request must *not* have
 *     been sent, that is asserted as well as the rendering - dismissing a confirmation has no
 *     visible effect other than the dialog closing, so the absence of the write is the claim.
 *   - **The whole path is driven by keyboard.** The irreversible control is held to the same rule
 *     as every other control on this surface: nothing here is reachable only by pointer.
 *   - **Nothing is queued.** The device's store is seeded *before* the failed removal and proved
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
const REMOVAL = `${BASE}/rounds/${ROUND_ID}/post-its/${POST_IT_ID}/permanent-removal`;
const DISCARDED = `${BASE}/rounds/${ROUND_ID}/discarded-post-its`;

/**
 * A Post-it a Facilitator has already discarded, sitting in the restore list (OC01's third place).
 *
 * It is on no other surface at all - not the Board, not the projected screen, not its author's
 * phone - which is exactly why the removal control has to be here: the only other route to it is a
 * restore, and a restore republishes the text to the whole room on the next tick.
 */
const DISCARDED_ID = 'p-discarded';
const DISCARDED_REMOVAL = `${BASE}/rounds/${ROUND_ID}/post-its/${DISCARDED_ID}/permanent-removal`;
const AWAITING_RESTORE = {
  id: DISCARDED_ID,
  text: 'something nobody should have written under a real name',
  authorName: 'Ada Lovelace',
  discardedByName: 'Ida Ek',
  discardedAt: '2026-08-30 14:02',
};
const DISPLAY_LINK = `${BASE}/rounds/${ROUND_ID}/display-link`;

const ADA = 'google-sub-ada';

const FIRST_WATERMARK = '4171';
const SECOND_WATERMARK = '4172';

const SERVER_CAP = 12;
const STAGING = 'we need a staging box';

/** The server's own sentence for a Facilitator who tried it anyway (FR5 -> Error Handling). */
const ADMIN_SENTENCE =
  'Only an admin can permanently remove a post-it. You can discard it instead.';

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

function round(
  categories: Category[],
  uncategorised: PostIt[],
  state: Round['state'] = 'open',
): Round {
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

/** Ada's post-it sitting in Tooling, beside one that stays there, and one in Uncategorised. */
function inTooling(): Round {
  return round(
    [
      category('cat-tooling', 'Tooling', [
        STAGING_POST_IT,
        postIt({ id: 'p-ci', text: 'flaky CI', authorName: 'Bo Nilsson' }),
      ]),
    ],
    [postIt({ id: 'p-loose', text: 'no rooms free', authorName: 'Bo Nilsson' })],
  );
}

/**
 * The same Board on a **closed** Round, with Ada's post-it now the viewer's own.
 *
 * Two things at once, deliberately. Permanent Removal is not gated on the Round being open - it is
 * aimed squarely at Rounds that have already closed, where nothing else can take a Post-it back -
 * while the author's own Remove *is*. Owning the post-it here is what makes the second half a real
 * assertion: `post-it-remove-*` would be rendered if the fixture's Round were open, so its absence
 * proves the Round really is closed and the removal control's presence is not vacuous.
 */
function closedRound(): Round {
  return round(
    [
      category('cat-tooling', 'Tooling', [
        postIt({ id: POST_IT_ID, text: STAGING, mine: true }),
        postIt({ id: 'p-ci', text: 'flaky CI', authorName: 'Bo Nilsson' }),
      ]),
    ],
    [],
    'closed',
  );
}

/** The same Board once Ada's post-it is gone: out of Tooling, out of the count, out of everything. */
function afterRemoval(): Round {
  return round(
    [
      category('cat-tooling', 'Tooling', [
        postIt({ id: 'p-ci', text: 'flaky CI', authorName: 'Bo Nilsson' }),
      ]),
    ],
    [postIt({ id: 'p-loose', text: 'no rooms free', authorName: 'Bo Nilsson' })],
  );
}

function payload(
  rounds: Round[],
  canRemovePermanently: boolean,
  watermark = FIRST_WATERMARK,
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
    /*
     * `canRun` is true throughout this file, deliberately. An assigned Facilitator holds it and so
     * does an Admin, so a control drawn from it would be offered to both - which is exactly the
     * mistake FR5 forbids. Everything below varies `canRemovePermanently` alone.
     */
    canRun: true,
    canRemovePermanently,
    activityWatermark: watermark,
  };
}

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
  for (let step = 0; step < 200; step += 1) {
    if (document.activeElement === target) {
      await user.keyboard('{Enter}');
      return;
    }
    await user.tab();
  }
  throw new Error(`${testId} was not reachable by keyboard within 200 tab stops.`);
}

function textsIn(testId: string): string[] {
  return [...screen.getByTestId(testId).querySelectorAll('[data-testid^="post-it-text-"]')].map(
    (node) => node.textContent ?? '',
  );
}

describe('permanently removing a post-it', () => {
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
      [`GET ${DISCARDED}`]: { status: 200, body: { discarded: [] } },
      ...routes,
    });
    render(<SessionActivitiesPanel conferenceId={CONFERENCE_ID} sessionId={SESSION_ID} />);
    await waitFor(() => expect(screen.queryByText(/Loading this session/)).toBeNull());
  }

  function watermarkAnswer(value: string): Route {
    return { status: 200, body: { activityWatermark: value, state: 'published' } };
  }

  function removalCalls(): number {
    return calls.filter((call) => call.method === 'POST' && call.path === REMOVAL).length;
  }

  // ---------- Acceptance Scenario S03, client half: the control is not offered ----------

  it('renders no removal control anywhere on the board when the flag is false', async () => {
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: { status: 200, body: payload([inTooling()], false) },
    });

    // Every region the board has, and every post-it in each of them.
    expect(screen.queryByTestId(`post-it-permanent-removal-${POST_IT_ID}`)).toBeNull();
    expect(screen.queryByTestId('post-it-permanent-removal-p-ci')).toBeNull();
    expect(screen.queryByTestId('post-it-permanent-removal-p-loose')).toBeNull();
    expect(document.querySelectorAll('[data-testid^="post-it-permanent-removal-"]').length).toBe(0);

    /*
     * And the sorting controls *are* there. Without this the test would pass on a board that failed
     * to render at all, which is the vacuous version of the same assertion.
     */
    expect(screen.getByTestId(`post-it-discard-${POST_IT_ID}`)).toBeTruthy();
  });

  it('renders one on every post-it, in every region, when the flag is true', async () => {
    const user = userEvent.setup();
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: { status: 200, body: payload([inTooling()], true) },
    });

    for (const id of [POST_IT_ID, 'p-ci', 'p-loose']) {
      expect(screen.getByTestId(`post-it-permanent-removal-${id}`)).toBeTruthy();
    }
    // Nothing is armed before anything has been pressed.
    expect(document.querySelectorAll('[data-testid^="permanent-removal-"]').length).toBe(0);

    /*
     * **Opening one does not open the others**: the confirmation is per post-it, and this is the
     * assertion that fails if it stops being. Pressing one control and counting what opened is the
     * only form that can - asserting "nothing is open" on a board nobody has touched passes whether
     * the dialog is keyed by post-it id or hard-coded to `true`
     * (`docs/LEARNINGS.md#testing`: a guard that cannot fail is not a guard).
     */
    await tabToAndPress(user, `post-it-permanent-removal-${POST_IT_ID}`);

    expect(screen.getByTestId(`permanent-removal-${POST_IT_ID}`)).toBeTruthy();
    expect(screen.queryByTestId('permanent-removal-p-ci')).toBeNull();
    expect(screen.queryByTestId('permanent-removal-p-loose')).toBeNull();
    // Exactly one confirmation on the whole board, counted by its own testid rather than a prefix.
    expect(
      [...document.querySelectorAll('[data-testid^="permanent-removal-"]')].filter(
        (node) =>
          !/^permanent-removal-(warning|confirm|cancel)-/.test(
            node.getAttribute('data-testid') ?? '',
          ),
      ).length,
    ).toBe(1);
  });

  // ---------- C7: the control is not gated on the Round being open ----------

  it('offers it on a closed round, where the author’s own remove is gone', async () => {
    const user = userEvent.setup();
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: { status: 200, body: payload([closedRound()], true) },
      [`POST ${REMOVAL}`]: { status: 200, body: { removed: true } },
    });

    /*
     * The author's own controls are gone because the Round has closed - which is what makes the
     * next line say something. Moderation is the act that cannot wait for a Round to be open, and a
     * later refactor nesting this control under the `open` branch would pass every other case in
     * this file.
     */
    expect(screen.queryByTestId(`post-it-remove-${POST_IT_ID}`)).toBeNull();
    expect(screen.queryByTestId(`post-it-correct-${POST_IT_ID}`)).toBeNull();

    expect(screen.getByTestId(`post-it-permanent-removal-${POST_IT_ID}`)).toBeTruthy();

    await tabToAndPress(user, `post-it-permanent-removal-${POST_IT_ID}`);
    await tabToAndPress(user, `permanent-removal-confirm-${POST_IT_ID}`);
    await settle();

    // And the write goes, on a closed Round, exactly as it does on an open one.
    expect(removalCalls()).toBe(1);
  });

  // ---------- Acceptance Scenario S06: the confirmation, and dismissing it ----------

  it('names the author and says it cannot be undone, and dismissing sends nothing', async () => {
    const user = userEvent.setup();
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: { status: 200, body: payload([inTooling()], true) },
    });

    await tabToAndPress(user, `post-it-permanent-removal-${POST_IT_ID}`);

    const confirmation = screen.getByTestId(`permanent-removal-${POST_IT_ID}`);
    expect(confirmation.textContent).toContain('Ada Lovelace');
    expect(screen.getByTestId(`permanent-removal-warning-${POST_IT_ID}`).textContent).toContain(
      'cannot be undone',
    );
    // Nothing has been sent by opening it.
    expect(removalCalls()).toBe(0);

    await tabToAndPress(user, `permanent-removal-cancel-${POST_IT_ID}`);
    await settle();

    // No request, and the post-it is exactly where it was.
    expect(removalCalls()).toBe(0);
    expect(screen.queryByTestId(`permanent-removal-${POST_IT_ID}`)).toBeNull();
    expect(textsIn('category-cat-tooling')).toEqual([STAGING, 'flaky CI']);
  });

  // ---------- Acceptance Scenario S01, client half: it leaves the board ----------

  it('removes it from the board after the re-read, by keyboard alone', async () => {
    const user = userEvent.setup();
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: [
        { status: 200, body: payload([inTooling()], true) },
        { status: 200, body: payload([afterRemoval()], true, SECOND_WATERMARK) },
      ],
      [`POST ${REMOVAL}`]: { status: 200, body: { removed: true } },
    });

    expect(textsIn('category-cat-tooling')).toEqual([STAGING, 'flaky CI']);

    await tabToAndPress(user, `post-it-permanent-removal-${POST_IT_ID}`);
    await tabToAndPress(user, `permanent-removal-confirm-${POST_IT_ID}`);
    await settle();

    expect(removalCalls()).toBe(1);
    // The write carries no body at all: the acting admin is the credential (Binding Constraint FR6).
    expect(calls.find((call) => call.path === REMOVAL)!.body).toBeUndefined();

    // Gone from the board the re-read brought back, and gone from the category's count.
    expect(textsIn('category-cat-tooling')).toEqual(['flaky CI']);
    expect(screen.getByTestId('category-count-cat-tooling').textContent).toBe('1 post-it');
    expect(screen.queryByTestId(`post-it-${POST_IT_ID}`)).toBeNull();
    // And the confirmation closed with it rather than standing over a post-it that is gone.
    expect(screen.queryByTestId(`permanent-removal-${POST_IT_ID}`)).toBeNull();
  });

  // ---------- Acceptance Scenario S02, client half: the already-Discarded post-it ----------

  /**
   * OC01's third place, and the operational path FR5 exists for.
   *
   * The Post-its most likely to need permanent removal are the ones a Facilitator has already
   * discarded to get them off the wall. Without a control on this surface an Admin's only route is
   * to **restore** the Post-it first - putting the abusive or confidential text back on every
   * Attendee's Board and the projected screen - and only then remove it. The restore assertion
   * below is the point of this test, not a detail of it.
   */
  it('removes an already-discarded post-it without restoring it to the board first', async () => {
    const user = userEvent.setup();
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: [
        { status: 200, body: payload([inTooling()], true) },
        { status: 200, body: payload([inTooling()], true, SECOND_WATERMARK) },
      ],
      [`GET ${DISCARDED}`]: [
        { status: 200, body: { discarded: [AWAITING_RESTORE] } },
        { status: 200, body: { discarded: [] } },
      ],
      [`POST ${DISCARDED_REMOVAL}`]: { status: 200, body: { removed: true } },
    });

    await tabToAndPress(user, `discarded-toggle-${ROUND_ID}`);
    expect(screen.getByTestId(`discarded-item-${DISCARDED_ID}`)).toBeTruthy();

    await tabToAndPress(user, `post-it-permanent-removal-${DISCARDED_ID}`);

    // The same confirmation, in the same words, naming the same author it does on the board.
    expect(screen.getByTestId(`permanent-removal-${DISCARDED_ID}`).textContent).toContain(
      'Ada Lovelace',
    );
    expect(screen.getByTestId(`permanent-removal-warning-${DISCARDED_ID}`).textContent).toContain(
      'cannot be undone',
    );

    await tabToAndPress(user, `permanent-removal-confirm-${DISCARDED_ID}`);
    await settle();

    expect(
      calls.filter((call) => call.method === 'POST' && call.path === DISCARDED_REMOVAL).length,
    ).toBe(1);
    /*
     * **Nothing was restored.** This is the assertion the whole surface exists for: the content
     * never went back in front of the room in order to be taken away from it.
     */
    expect(calls.filter((call) => /\/restore$/.test(call.path)).length).toBe(0);

    // Off the restore list after the re-read, with nothing left to offer.
    expect(screen.queryByTestId(`discarded-item-${DISCARDED_ID}`)).toBeNull();
    expect(screen.getByTestId(`discarded-empty-${ROUND_ID}`)).toBeTruthy();
  });

  /*
   * The confirmation quotes **what was clicked**, not what the board says now. Without this the
   * property is only true because every fixture happens to agree: rendering the dialog from the
   * live Post-it instead of the pinned record leaves the whole file green, and the two comments
   * asserting the protection go quietly false again.
   *
   * The scenario is real rather than contrived - a correction by the author, or another
   * Facilitator's edit, landing on the poll tick between arming an irreversible act and confirming
   * it. What the Admin agreed to destroy is what they read.
   */
  it('keeps the confirmation on what was clicked when the board changes underneath it', async () => {
    const user = userEvent.setup();
    const rewritten = round(
      [
        category('cat-tooling', 'Tooling', [
          postIt({ id: POST_IT_ID, text: 'something else entirely', authorName: 'Bo Nilsson' }),
          postIt({ id: 'p-ci', text: 'flaky CI', authorName: 'Bo Nilsson' }),
        ]),
      ],
      [postIt({ id: 'p-loose', text: 'no rooms free', authorName: 'Bo Nilsson' })],
    );

    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(SECOND_WATERMARK),
      [`GET ${BASE}`]: [
        { status: 200, body: payload([inTooling()], true) },
        { status: 200, body: payload([rewritten], true, SECOND_WATERMARK) },
      ],
    });

    await tabToAndPress(user, `post-it-permanent-removal-${POST_IT_ID}`);
    const armed = screen.getByTestId(`permanent-removal-${POST_IT_ID}`).textContent ?? '';
    expect(armed).toContain('Ada Lovelace');

    // The board moves under the armed dialog, on the watermark poll rather than on any write.
    await waitFor(async () => {
      await settle();
      expect(readsOf('GET', BASE)).toBe(2);
    });
    expect(screen.getByTestId(`post-it-${POST_IT_ID}`).textContent).toContain(
      'something else entirely',
    );

    // The dialog still names the author and the words the Admin actually read.
    const still = screen.getByTestId(`permanent-removal-${POST_IT_ID}`).textContent ?? '';
    expect(still).toContain('Ada Lovelace');
    expect(still).not.toContain('Bo Nilsson');
    expect(still).not.toContain('something else entirely');
  });

  /*
   * An armed irreversible confirmation must not survive the surface being hidden. `open` lives in
   * `DiscardedPostIts` while `permanentRemoval` lives in the panel, so without the disarm the two
   * clicks that hide and re-show the list bring the confirmation back unprompted, with no network
   * in between - a dialog nobody asked for the second time, over an act that cannot be undone.
   */
  it('disarms a removal confirmation when the discarded surface is hidden', async () => {
    const user = userEvent.setup();
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: { status: 200, body: payload([inTooling()], true) },
      [`GET ${DISCARDED}`]: { status: 200, body: { discarded: [AWAITING_RESTORE] } },
    });

    await tabToAndPress(user, `discarded-toggle-${ROUND_ID}`);
    await tabToAndPress(user, `post-it-permanent-removal-${DISCARDED_ID}`);
    expect(screen.getByTestId(`permanent-removal-${DISCARDED_ID}`)).toBeTruthy();

    // Hide, then show again. No request is made by either press.
    const before = calls.length;
    await tabToAndPress(user, `discarded-toggle-${ROUND_ID}`);
    await tabToAndPress(user, `discarded-toggle-${ROUND_ID}`);
    expect(calls.length).toBe(before);

    expect(screen.getByTestId(`discarded-item-${DISCARDED_ID}`)).toBeTruthy();
    expect(screen.queryByTestId(`permanent-removal-${DISCARDED_ID}`)).toBeNull();
  });

  /*
   * Restore is refused while this item's own removal confirmation is armed. `restore` awaits the
   * panel's Board re-read before its own, so without this the Post-it is on the Board *and* still
   * in this local list for one round trip - two live nodes carrying the same `permanent-removal`
   * testid, which is how a `getByTestId` starts throwing somewhere unrelated.
   */
  it('will not restore a post-it whose removal confirmation is armed', async () => {
    const user = userEvent.setup();
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: { status: 200, body: payload([inTooling()], true) },
      [`GET ${DISCARDED}`]: { status: 200, body: { discarded: [AWAITING_RESTORE] } },
    });

    await tabToAndPress(user, `discarded-toggle-${ROUND_ID}`);

    const restore = screen.getByTestId(`discarded-restore-${DISCARDED_ID}`) as HTMLButtonElement;
    expect(restore.disabled).toBe(false);

    await tabToAndPress(user, `post-it-permanent-removal-${DISCARDED_ID}`);
    expect(
      (screen.getByTestId(`discarded-restore-${DISCARDED_ID}`) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      document.querySelectorAll(`[data-testid="permanent-removal-${DISCARDED_ID}"]`).length,
    ).toBe(1);

    // Cancelling hands the reversible act back.
    await tabToAndPress(user, `permanent-removal-cancel-${DISCARDED_ID}`);
    expect(
      (screen.getByTestId(`discarded-restore-${DISCARDED_ID}`) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  /**
   * The concern the surface's own note is about: a Facilitator must not find the irreversible act
   * sitting beside the reversible one. It is the flag that keeps them apart, so the flag is what is
   * asserted - on the *same* fixture that offers the control above.
   */
  it('offers a facilitator the restore and nothing else on the discarded surface', async () => {
    const user = userEvent.setup();
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: { status: 200, body: payload([inTooling()], false) },
      [`GET ${DISCARDED}`]: { status: 200, body: { discarded: [AWAITING_RESTORE] } },
    });

    await tabToAndPress(user, `discarded-toggle-${ROUND_ID}`);

    expect(screen.getByTestId(`discarded-restore-${DISCARDED_ID}`)).toBeTruthy();
    expect(screen.queryByTestId(`post-it-permanent-removal-${DISCARDED_ID}`)).toBeNull();
  });

  // ---------- the refusal, and the one it must not become ----------

  it('shows the server’s own sentence at panel level and keeps the post-it drawn', async () => {
    const user = userEvent.setup();
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      // The board is re-read on the refusal branch too, and says the post-it is still there.
      [`GET ${BASE}`]: { status: 200, body: payload([inTooling()], true) },
      [`POST ${REMOVAL}`]: {
        status: 403,
        body: { error: { code: 'POST_IT_ADMIN_REQUIRED', message: ADMIN_SENTENCE } },
      },
    });

    await tabToAndPress(user, `post-it-permanent-removal-${POST_IT_ID}`);
    await tabToAndPress(user, `permanent-removal-confirm-${POST_IT_ID}`);
    await settle();

    /*
     * The server's words verbatim, and held at panel level - outside the subtree the re-read this
     * write triggers replaces, which is what stops the refusal disappearing the instant it appears
     * (`docs/LEARNINGS.md#react-state--refusals`).
     */
    expect(screen.getByTestId(`board-error-${ROUND_ID}`).textContent).toBe(ADMIN_SENTENCE);
    expect(textsIn('category-cat-tooling')).toEqual([STAGING, 'flaky CI']);
  });

  it('states an undelivered removal in its own words and queues nothing', async () => {
    const user = userEvent.setup();

    // Something already waiting on this device, so "unchanged" is stronger than "empty".
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
      [`GET ${BASE}`]: { status: 200, body: payload([inTooling()], true) },
      // Never answered: the request did not reach the API at all.
      [`POST ${REMOVAL}`]: { status: 0 },
    });

    await tabToAndPress(user, `post-it-permanent-removal-${POST_IT_ID}`);
    await tabToAndPress(user, `permanent-removal-confirm-${POST_IT_ID}`);
    await settle();

    /*
     * Its own sentence, not the Discard's. An admin who reads "couldn't discard that" after a
     * permanent removal is told the reversible act was attempted, which is the wrong thing to
     * believe about a request that may or may not have landed.
     */
    expect(screen.getByTestId(`board-error-${ROUND_ID}`).textContent).toBe(
      "Couldn't remove that – check your connection.",
    );
    expect(textsIn('category-cat-tooling')).toEqual([STAGING, 'flaky CI']);
    // And the device holds precisely what it held before - no removal was queued for later.
    expect(await listQueuedPostIts()).toEqual(before);
  });
});
