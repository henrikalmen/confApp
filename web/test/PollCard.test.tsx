import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionActivitiesPanel } from '../src/activities/SessionActivitiesPanel.tsx';
import { POLL_INTERVAL_MS } from '../src/poll/use-watermark-poll.ts';
import type { OptionTally, Round, SessionWithRounds } from '../src/api/client.ts';

/**
 * S03 on the client: the Poll card - choosing once, the settled state, the refusal, and the result
 * as it builds (TI09, TI10).
 *
 * Four disciplines, from `docs/LEARNINGS.md#testing` and the FIS's Testing Strategy:
 *
 *   - **Every propagation assertion is made on the rendered tally**, never on a request count or a
 *     fetch spy. A guard on the request issued stays green while the payload is wrong, which is the
 *     defect this project has already been bitten by.
 *   - **Nothing waits on the value it is about to assert.** The waits are on an answer count, which
 *     the defect each test guards against cannot produce, and the reading is taken afterwards.
 *   - **No reload, no remount and no test-only entry point.** A tick is provoked by dispatching the
 *     `focus` event the shipped poll loop genuinely listens for, so what is under test is S02's one
 *     loop with a third call site rather than anything this story invented.
 *   - **Nothing here decides who may see a tally or whether somebody has voted.** Both come off the
 *     payload, because the server is the only thing entitled to answer either.
 *
 * `web/` has no jest-dom, so assertions are on plain DOM properties.
 */

const CONFERENCE_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const BASE = `/conferences/${CONFERENCE_ID}/sessions/${SESSION_ID}`;
const WATERMARK = `${BASE}/activities/watermark`;
const POLL_ID = 'round-poll';
const VOTES = `${BASE}/rounds/${POLL_ID}/votes`;

/*
 * The Session's activity cursor, as the server actually sends it: an opaque counter, never a time.
 * Digits here rather than an ISO instant is the fixture's half of the guarantee - a timestamp told
 * every Member when each Vote landed. The view only ever asks whether the two differ.
 */
const FIRST_WATERMARK = '4171';
const SECOND_WATERMARK = '4172';

const YES = 'option-yes';
const NO = 'option-no';
const UNSURE = 'option-not-sure';

const OPTIONS = [
  { id: YES, label: 'Yes' },
  { id: NO, label: 'No' },
  { id: UNSURE, label: 'Not sure' },
];

function poll(overrides: Partial<Round> = {}): Round {
  return {
    id: POLL_ID,
    kind: 'VotingRound',
    purpose: 'Poll',
    prompt: 'Where should we start?',
    state: 'open',
    options: OPTIONS,
    hasVoted: false,
    ...overrides,
  };
}

function tally(yes: number, no: number, unsure: number): OptionTally[] {
  return [
    { optionId: YES, votes: yes },
    { optionId: NO, votes: no },
    { optionId: UNSURE, votes: unsure },
  ];
}

const BOARD: Round = {
  id: 'round-post-it',
  kind: 'PostItRound',
  prompt: 'What slows us down most?',
  state: 'open',
  postIts: [
    { id: 'p-1', text: 'Handovers', authorName: 'Ada Lovelace', mine: false, edited: false },
  ],
  textMaxLength: 40,
};

function payload(
  rounds: Round[],
  canRun = false,
  activityWatermark = FIRST_WATERMARK,
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
    canRun,
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

/** The counts as the room actually reads them, in option order. */
function countsOnScreen(): string[] {
  return [...document.querySelectorAll('[data-testid^="poll-count-"]')].map(
    (node) => node.textContent ?? '',
  );
}

function optionLabels(): string[] {
  return [...screen.getByTestId(`round-options-${POLL_ID}`).querySelectorAll('li')].map(
    (item) => item.textContent ?? '',
  );
}

describe('the poll card', () => {
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

  // ---------- Acceptance Scenario S01: one vote, and the card settles ----------

  it('sends the chosen option and settles with no way to change or withdraw it', async () => {
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`POST ${VOTES}`]: { status: 200, body: { voted: true } },
      [`GET ${BASE}`]: [
        { status: 200, body: payload([poll()]) },
        { status: 200, body: payload([poll({ hasVoted: true })]) },
      ],
    });

    expect(optionLabels()).toEqual(['Yes', 'No', 'Not sure']);
    // Nothing chosen is nothing to send.
    expect((screen.getByTestId(`poll-submit-${POLL_ID}`) as HTMLButtonElement).disabled).toBe(true);

    await userEvent.click(screen.getByTestId(`poll-option-${UNSURE}`));
    expect((screen.getByTestId(`poll-option-${UNSURE}`) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId(`poll-submit-${POLL_ID}`) as HTMLButtonElement).disabled).toBe(
      false,
    );

    await userEvent.click(screen.getByTestId(`poll-submit-${POLL_ID}`));
    await settle();

    // The option that was chosen, and nothing that names a voter.
    const cast = calls.find((call) => call.method === 'POST' && call.path === VOTES);
    expect(cast?.body).toEqual({ optionId: UNSURE });

    /*
     * The settled state comes from the server's `hasVoted` on the re-read, not from a local flag -
     * so what is asserted is what the server says, which is the thing that is actually enforced.
     */
    expect(screen.getByTestId(`poll-${POLL_ID}`).dataset.voted).toBe('true');
    expect(screen.getByTestId(`poll-voted-${POLL_ID}`).textContent).toMatch(/vote is in/i);

    // No control to change it, withdraw it, or vote again - a Vote is final.
    expect(screen.queryByTestId(`poll-submit-${POLL_ID}`)).toBeNull();
    expect(screen.queryByTestId(`poll-option-${YES}`)).toBeNull();
    expect(optionLabels()).toEqual(['Yes', 'No', 'Not sure']);
  });

  // ---------- Acceptance Scenario S02: the refusal reveals nothing ----------

  it('keeps a duplicate-vote refusal on screen, with the card intact and no counts', async () => {
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`POST ${VOTES}`]: {
        status: 409,
        body: {
          error: {
            code: 'VOTE_ALREADY_CAST',
            message: 'You have already voted in this poll. A vote is final once it is cast.',
          },
        },
      },
      [`GET ${BASE}`]: [
        { status: 200, body: payload([poll()]) },
        // The re-read the refusal triggers: the server says she had voted after all.
        { status: 200, body: payload([poll({ hasVoted: true })]) },
      ],
    });

    await userEvent.click(screen.getByTestId(`poll-option-${YES}`));
    await userEvent.click(screen.getByTestId(`poll-submit-${POLL_ID}`));
    await settle();

    /*
     * The sentence survives the re-read its own handler caused - it lives at panel level, outside
     * the subtree the refreshed payload replaces (`docs/LEARNINGS.md#react-state--refusals`).
     */
    const refusal = screen.getByTestId(`poll-error-${POLL_ID}`);
    expect(refusal.textContent).toMatch(/already voted/i);
    expect(refusal.getAttribute('role')).toBe('alert');

    // The card is intact, and no tally appeared anywhere on it.
    expect(screen.getByTestId(`poll-${POLL_ID}`)).not.toBeNull();
    expect(optionLabels()).toEqual(['Yes', 'No', 'Not sure']);
    expect(screen.queryByTestId(`poll-results-${POLL_ID}`)).toBeNull();
    expect(countsOnScreen()).toEqual([]);
    expect(screen.getByTestId(`poll-${POLL_ID}`).textContent).not.toMatch(/\d/);
  });

  /**
   * **A double-tap is one intent, so it must be one cast.**
   *
   * A Vote is single-use and the server enforces that, which is exactly what makes the second tap
   * harmful rather than harmless: it comes back "you have already voted", and somebody who voted
   * precisely once is left reading a refusal beside "Your vote is in" - on a phone, at the back of
   * a room, with no way to tell which of the two sentences is about them.
   *
   * The cast is **held open** here rather than answered immediately, because that is the only state
   * in which the second tap exists at all. The stub then answers a real 409 to a second POST, so a
   * missing guard fails this test the way the room would experience it, rather than on a count.
   */
  it('sends one cast for a double-tap, and shows no refusal for a vote made once', async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const routed = routeFetch({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`POST ${VOTES}`]: [
        { status: 200, body: { voted: true } },
        // What the server really answers a second cast from the same person.
        {
          status: 409,
          body: {
            error: {
              code: 'VOTE_ALREADY_CAST',
              message: 'You have already voted in this poll. A vote is final once it is cast.',
            },
          },
        },
      ],
      [`GET ${BASE}`]: [
        { status: 200, body: payload([poll()]) },
        { status: 200, body: payload([poll({ hasVoted: true })]) },
      ],
    });
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') await held;
      return routed(input as RequestInfo, init);
    }) as unknown as typeof fetch;

    render(<SessionActivitiesPanel conferenceId={CONFERENCE_ID} sessionId={SESSION_ID} />);
    await waitFor(() => expect(screen.queryByText(/Loading this session/)).toBeNull());

    await userEvent.click(screen.getByTestId(`poll-option-${YES}`));
    const submit = screen.getByTestId(`poll-submit-${POLL_ID}`) as HTMLButtonElement;

    // The first tap. Its cast is out and unanswered, which is when a second tap happens.
    await act(async () => {
      submit.click();
    });
    expect(submit.disabled).toBe(true);

    // The second tap, on the control as it now actually is. `click()` is the DOM's own activation
    // path, so a disabled control declines it exactly as a phone would.
    await act(async () => {
      submit.click();
    });

    release?.();
    await settle();

    expect(calls.filter((call) => call.method === 'POST' && call.path === VOTES)).toHaveLength(1);
    expect(screen.getByTestId(`poll-voted-${POLL_ID}`).textContent).toMatch(/vote is in/i);
    expect(screen.queryByTestId(`poll-error-${POLL_ID}`)).toBeNull();
  });

  // ---------- Acceptance Scenario S04: the facilitator sees it build, the attendee does not ----

  it('shows the tally to a caller the payload carries one for, and to nobody else', async () => {
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: { status: 200, body: payload([poll({ tally: tally(3, 1, 0) })], true) },
    });

    expect(countsOnScreen()).toEqual(['3', '1', '0']);
    // Rendered against the option labels, so a count is never shown against the wrong answer.
    expect(
      [
        ...screen.getByTestId(`poll-results-${POLL_ID}`).querySelectorAll('.poll__result-label'),
      ].map((node) => node.textContent),
    ).toEqual(['Yes', 'No', 'Not sure']);
  });

  it('renders no tally at all where the payload carries none – never a zeroed one', async () => {
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: { status: 200, body: payload([poll()]) },
    });

    /*
     * The whole point of the server refusing rather than answering an empty tally: the client must
     * not manufacture the zeroes it was deliberately not given, because a zero is a claim about the
     * votes and absence must carry no information at all.
     */
    expect(screen.queryByTestId(`poll-results-${POLL_ID}`)).toBeNull();
    expect(countsOnScreen()).toEqual([]);
  });

  // ---------- Acceptance Scenarios S05 and S06: the closed result ----------

  it('renders a closed poll’s counts, including a poll nobody voted in', async () => {
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: {
        status: 200,
        body: payload([poll({ state: 'closed', hasVoted: true, tally: tally(0, 0, 0) })]),
      },
    });

    // Zero against every option renders normally – it is a result, not an error and not an absence.
    expect(countsOnScreen()).toEqual(['0', '0', '0']);
    // A closed poll offers nothing to press, whatever the viewer has or has not done.
    expect(screen.queryByTestId(`poll-submit-${POLL_ID}`)).toBeNull();
    expect(screen.queryByTestId(`poll-option-${YES}`)).toBeNull();
  });

  // ---------- TI10: near-live, through S02's one loop ----------

  /**
   * A Vote cast elsewhere reaches a holder's screen with nobody touching it – **and with the
   * cursor standing still the whole time**.
   *
   * The watermark route answers the same value throughout, and both Session payloads carry that
   * same value. That fixture *is* ADR-007's contract: a cast Vote advances no cursor, because the
   * watermark poll is gated on Membership alone and its movement was therefore a "a ballot just
   * landed" signal readable by the very Attendees the running tally is withheld from. A holder's
   * tally has no change signal behind it any more, so it is delivered by re-reading the Session on
   * every tick – and a panel that still waited for a cursor to move would render `3 0 0` for ever.
   *
   * Driven by the shipped loop's own interval rather than by a dispatched `focus`, because the
   * claim is about the propagation target: **one tick of the one cadence**, which the assertion
   * below pins at or under the ~5s `prd.md#non-functional-requirements` asks for. Nothing here
   * introduces a cadence – `POLL_INTERVAL_MS` is imported from the loop that owns it.
   *
   * And the reading afterwards is the **rendered tally**, never the request that fetched it: a
   * guard on the request issued stays green while the payload is wrong, which is the defect this
   * project has already been bitten by (`docs/LEARNINGS.md#testing`).
   */
  it('moves a holder’s rendered tally on the next tick, with no user action and no cursor movement', async () => {
    vi.useFakeTimers();
    try {
      globalThis.fetch = routeFetch({
        [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
        [`GET ${BASE}`]: [
          { status: 200, body: payload([poll({ tally: tally(3, 0, 0) })], true) },
          { status: 200, body: payload([poll({ tally: tally(3, 1, 0) })], true) },
        ],
      });
      render(<SessionActivitiesPanel conferenceId={CONFERENCE_ID} sessionId={SESSION_ID} />);
      // The first read only – no timer has run yet, so this is the panel's own load and nothing
      // else.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(countsOnScreen()).toEqual(['3', '0', '0']);
      const cardBefore = screen.getByTestId(`poll-${POLL_ID}`);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      });

      expect(countsOnScreen()).toEqual(['3', '1', '0']);
      // The same card, updated in place: no reload and no remount.
      expect(screen.getByTestId(`poll-${POLL_ID}`)).toBe(cardBefore);
      // And that tick is inside the propagation target the PRD names.
      expect(POLL_INTERVAL_MS).toBeLessThanOrEqual(5_000);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * **No cursor movement, no refetch – for a Member who holds no Session Assignment.**
   *
   * This is every Attendee's path and ADR-007 leaves it exactly as it was: two scalars until
   * something has actually changed, and the Session payload only then. Scoped to a non-holder
   * deliberately. Stated over everybody it would now be false, since a holder re-reads on every
   * tick; dropped altogether it would leave unguarded the branch that carries the whole room, and
   * "everyone refetches unconditionally" is precisely the cost ADR-007 declined to pay.
   */
  it('does not refetch the session for a non-holder while the cursor has not moved', async () => {
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: { status: 200, body: payload([poll()]) },
    });

    await tick();
    await waitFor(() => expect(answersFor('GET', WATERMARK)).toBeGreaterThanOrEqual(1));
    await settle();

    expect(readsOf('GET', BASE)).toBe(1);
    // What she is actually reading is still on screen, and still carries no tally: an Attendee is
    // refused the running counts, so absence carries no information either way.
    expect(screen.getByTestId(`poll-option-${YES}`)).not.toBeNull();
    expect(countsOnScreen()).toEqual([]);
  });

  /**
   * **The reveal still travels on the cursor, and still reaches a non-holder near-live.**
   *
   * ADR-007 removed the ballot trigger and nothing else. Closing a Round is a change to the Round's
   * own `state`, which `round_change_advances_activity_watermark` fires on – so the close moves the
   * cursor, an Attendee's compare-then-refetch sees it move, and the result appears without anybody
   * touching the screen. That is the half of the near-live guarantee this decision had to leave
   * intact, and it is asserted on the **counts as rendered** rather than on the refetch.
   */
  it('reveals a closed poll’s result to a non-holder when the cursor moves', async () => {
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(SECOND_WATERMARK),
      [`GET ${BASE}`]: [
        { status: 200, body: payload([poll({ hasVoted: true })]) },
        {
          status: 200,
          body: payload(
            [poll({ state: 'closed', hasVoted: true, tally: tally(3, 1, 0) })],
            false,
            SECOND_WATERMARK,
          ),
        },
      ],
    });

    // Nothing while it runs: she voted, and the counts are withheld until voting ends.
    expect(countsOnScreen()).toEqual([]);

    await tick();
    await waitFor(() => expect(answersFor('GET', BASE)).toBe(2));
    await settle();

    expect(countsOnScreen()).toEqual(['3', '1', '0']);
  });

  // ---------- the Poll card sits beside S02's board without disturbing it ----------

  it('renders beside a post-it board on the same session, and neither takes the other over', async () => {
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: { status: 200, body: payload([BOARD, poll()]) },
    });

    // S02's board: its post-it, its author's name, and its compose box.
    expect(screen.getByTestId(`post-it-text-p-1`).textContent).toBe('Handovers');
    expect(screen.getByTestId(`post-it-by-p-1`).textContent).toBe('Ada Lovelace');
    expect(screen.getByTestId(`compose-${BOARD.id}`)).not.toBeNull();

    // The Poll's own card, with its own controls - and no board on it.
    expect(screen.getByTestId(`poll-${POLL_ID}`)).not.toBeNull();
    expect(screen.getByTestId(`poll-submit-${POLL_ID}`)).not.toBeNull();
    expect(screen.queryByTestId(`board-${POLL_ID}`)).toBeNull();
    // And no vote controls on the Post-it Round.
    expect(screen.queryByTestId(`poll-${BOARD.id}`)).toBeNull();
  });

  /**
   * Two Polls open at once are two independent choices.
   *
   * A radio group named for the card rather than for the Round would make the second Poll's answer
   * clear the first one's - visibly, mid-session, with no error to explain it.
   */
  it('keeps the choice in one poll independent of the choice in another', async () => {
    const second = poll({ id: 'round-poll-2', prompt: 'And after that?' });
    await renderPanel({
      [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
      [`GET ${BASE}`]: { status: 200, body: payload([poll(), second]) },
    });

    await userEvent.click(screen.getAllByTestId(`poll-option-${YES}`)[0]!);
    await userEvent.click(screen.getAllByTestId(`poll-option-${NO}`)[1]!);

    expect((screen.getAllByTestId(`poll-option-${YES}`)[0] as HTMLInputElement).checked).toBe(true);
    expect((screen.getAllByTestId(`poll-option-${NO}`)[1] as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId(`poll-submit-${POLL_ID}`) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  /**
   * **Nothing about a Vote is written to any client-side store.**
   *
   * Votes and tallies are online-only: offline support does not widen beyond schedule reads and
   * Post-it queueing (Binding Constraint FR6). Asserted by driving a whole vote with the storage
   * APIs watched, which is stronger than reading the source for a `localStorage` call.
   */
  it('writes no vote, has-voted fact or tally to any client-side store', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    /*
     * There is no IndexedDB in this environment at all, so one is *installed* for the length of the
     * test. That is the stronger arrangement rather than a workaround: a panel reaching for it would
     * find it and be recorded, where against an undefined global the call would throw and could be
     * mistaken for an unrelated failure.
     */
    const openDb = vi.fn();
    const hadIndexedDb = 'indexedDB' in globalThis;
    Object.defineProperty(globalThis, 'indexedDB', {
      value: { open: openDb },
      configurable: true,
      writable: true,
    });
    try {
      await renderPanel({
        [`GET ${WATERMARK}`]: watermarkAnswer(FIRST_WATERMARK),
        [`POST ${VOTES}`]: { status: 200, body: { voted: true } },
        [`GET ${BASE}`]: [
          { status: 200, body: payload([poll()]) },
          { status: 200, body: payload([poll({ hasVoted: true, tally: tally(1, 0, 0) })], true) },
        ],
      });

      await userEvent.click(screen.getByTestId(`poll-option-${YES}`));
      await userEvent.click(screen.getByTestId(`poll-submit-${POLL_ID}`));
      await settle();

      expect(countsOnScreen()).toEqual(['1', '0', '0']);
      expect(setItem).not.toHaveBeenCalled();
      expect(openDb).not.toHaveBeenCalled();
    } finally {
      setItem.mockRestore();
      if (!hadIndexedDb) Reflect.deleteProperty(globalThis, 'indexedDB');
    }
  });
});
