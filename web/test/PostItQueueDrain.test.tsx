import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import { App } from '../src/App.tsx';
import { AuthProvider } from '../src/auth/AuthProvider.tsx';
import { setTokenSource } from '../src/api/client.ts';
import { adoptCacheOwner, setCacheIdentity } from '../src/offline/schedule-cache.ts';
import {
  holdPostIt,
  listQueuedPostIts,
  mintSubmissionId,
  queuedKeys,
} from '../src/offline/post-it-queue.ts';
import { PostItQueueDrain } from '../src/offline/use-post-it-queue.ts';
import { POLL_INTERVAL_MS, useWatermarkPoll } from '../src/poll/use-watermark-poll.ts';
import type { AuthSession, StoredSession } from '../src/auth/session.ts';

/**
 * S04's drain, where it now lives: **the app shell, not the Session panel** (product decision,
 * 2026-08-29).
 *
 * The story shipped with the drain mounted on `SessionActivitiesPanel`, which meant a Post-it typed
 * in a dead spot went up only once its author navigated back to that one Session. Somebody who
 * types, walks out of the room and reconnects at the coffee table kept a pending item indefinitely,
 * which is not what FR6 and US09 promise. So the property under test here is deliberately negative
 * about the panel: **nothing that can render a Round is on screen in any of these tests**, and the
 * queue still empties.
 *
 * Two disciplines carried over from `PostItQueueing.test.tsx`, for the same reasons:
 *
 *   - **Ownership is claimed before anything is seeded.** `adoptCacheOwner` fails closed, so an
 *     entry written before the claim is purged by it and "the queue is empty" then passes for the
 *     wrong reason.
 *   - **The assertion is on the store and on the request the API actually received**, never on a
 *     stubbed offline flag. Offline here is a transport that throws, exactly as `fetch` does with no
 *     route to the host.
 */

const CONFERENCE_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const ROUND_ID = 'round-post-it';
const BOARD = `/conferences/${CONFERENCE_ID}/sessions/${SESSION_ID}/rounds/${ROUND_ID}/post-its`;

const IDEA = 'Nobody owns the staging environment';
const SECOND_IDEA = 'The projector cable is a shared secret';

const NADIA = {
  sub: 'google-sub-nadia',
  email: 'nadia@ourcompany.example',
  displayName: 'Nadia Ek',
};

const calls: { method: string; path: string; body: unknown }[] = [];

function sent(method: string, path: string): number {
  return calls.filter((call) => call.method === method && call.path === path).length;
}

/**
 * Everything unreachable except the board, which takes what it is given.
 *
 * The shell mounts the attendee schedule, the conference list, the join panel and the health panel,
 * and every one of them reads on mount. None of that is what is under test, so all of it fails the
 * way a dead spot fails and the panels say so on screen; the single route that answers is the one
 * the drain uses.
 */
function boardTakesEverything(send: (body: unknown) => Promise<Response>): typeof fetch {
  return vi.fn(async (input: unknown, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = String(input)
      .replace(/^.*\/api/, '')
      .replace(/\?.*$/, '');
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ method, path, body });

    if (method === 'POST' && path === BOARD) return send(body);
    throw new TypeError('Failed to fetch');
  }) as unknown as typeof fetch;
}

function accepted(id: string, text: string): Response {
  return new Response(
    JSON.stringify({
      postIt: {
        id,
        text,
        authorName: NADIA.displayName,
        mine: true,
        edited: false,
        arrivedAfterClose: false,
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function stubSession(stored: StoredSession | null): AuthSession {
  return {
    current: () => stored,
    beginSignIn: vi.fn(async () => {}),
    completeRedirect: vi.fn(async () => ({ kind: 'nothing-to-do' }) as const),
    validToken: vi.fn(async () => (stored === null ? null : stored.idToken)),
    renewSilently: vi.fn(async () => {}),
    renewalRefusal: () => null,
    signOut: vi.fn(),
    onSessionCleared: () => () => {},
  };
}

function signedIn(): AuthSession {
  return stubSession({
    idToken: 'nadia-token',
    expiresAt: 4_000_000_000,
    user: NADIA,
    signedInAt: Date.now(),
  });
}

/**
 * Seeds one held Post-it, the way a failed submission would have left it.
 *
 * `heldAt` is taken from a counter rather than the clock. Two items seeded in the same millisecond
 * would be ordered by their random submission identities instead of by when they were typed, and a
 * test about *which* item was sent first would then pass or fail by coin toss.
 */
let seeded = 0;

async function seedHeldPostIt(text: string): Promise<string> {
  const submissionId = mintSubmissionId();
  const held = await holdPostIt({
    submissionId,
    conferenceId: CONFERENCE_ID,
    sessionId: SESSION_ID,
    roundId: ROUND_ID,
    text,
    heldAt: (seeded += 1),
  });
  expect(held).toBe(true);
  return submissionId;
}

/** Lets the mount's own drain finish, on the real clock. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
}

/**
 * The call site of the shared poll that is mounted beside the drain for every signed-in employee -
 * `AttendeeSchedulePanel` - reduced to the only part of it this test needs.
 *
 * Stood in for rather than rendered, because what is under test is the drain's *trigger*: the real
 * panel would drag a schedule load, a conference list and a clock into a test about one held
 * Post-it, and none of that decides anything here. The cadence is the real one either way - this is
 * `useWatermarkPoll` itself, unmodified, with a poll that asks for nothing.
 */
function ShellTick(): null {
  useWatermarkPoll(true, async () => {
    // Nothing to fetch: this stands in for the cadence, not for the schedule.
  });
  return null;
}

const realFetch = globalThis.fetch;

describe('the post-it queue drains from the app shell', () => {
  beforeEach(async () => {
    window.__CONFAPP_CONFIG__ = { apiBaseUrl: '/api' };
    calls.length = 0;
    globalThis.indexedDB = new IDBFactory();
    setCacheIdentity(() => NADIA.sub);
    await adoptCacheOwner(NADIA.sub);
    /*
     * A credential, for the tests that mount the drain on its own.
     *
     * `apiRequest` does not issue an authenticated request without one - it reports status 0, the
     * same shape as a transport failure - so a drain with no token source would retry forever and
     * never reach the board. The shell tests get theirs from `AuthProvider`, which registers the
     * session's; these ones have no provider to do it.
     */
    setTokenSource(async () => 'nadia-token');
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    setTokenSource(async () => null);
  });

  /**
   * The move itself, and the reason for it.
   *
   * Nadia typed her idea in the workshop, walked out, and reconnects somewhere else in the venue
   * with the schedule on screen. No Session is open – `SessionActivitiesPanel` is not mounted, and
   * the assertion below says so – and her Post-it goes up anyway.
   */
  it('sends a held post-it with no session panel anywhere on screen', async () => {
    await seedHeldPostIt(IDEA);
    globalThis.fetch = boardTakesEverything(async () => accepted('p1', IDEA));

    render(
      <AuthProvider session={signedIn()} initialSearch="">
        <App />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.queryByTestId('signed-in-identity')).not.toBeNull());
    await waitFor(async () => expect(await queuedKeys()).toEqual([]));
    await settle();

    // Nothing that could render a Round – or a pending item – was ever on screen.
    expect(screen.queryByTestId('round-list')).toBeNull();
    expect(screen.queryByTestId(`compose-${ROUND_ID}`)).toBeNull();
    expect(screen.queryByTestId('held-post-its')).toBeNull();

    // It went up as a queued item: the stored identity and the offline-composed marker both rode
    // with it, so the API can recognise a retry of this same contribution.
    expect(sent('POST', BOARD)).toBe(1);
    const attempt = calls.find((call) => call.method === 'POST' && call.path === BOARD)!;
    const body = attempt.body as { text: string; submissionId: string; offlineComposed: boolean };
    expect(body.text).toBe(IDEA);
    expect(body.offlineComposed).toBe(true);
    expect(typeof body.submissionId).toBe('string');
    expect(await listQueuedPostIts(NADIA.sub)).toEqual([]);
  });

  /** And again on the `online` event, which is the moment the venue's wifi actually comes back. */
  it('sends a post-it held after the shell was already running, when the link returns', async () => {
    globalThis.fetch = boardTakesEverything(async () => accepted('p1', IDEA));
    render(
      <AuthProvider session={signedIn()} initialSearch="">
        <App />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.queryByTestId('signed-in-identity')).not.toBeNull());
    await settle();
    expect(sent('POST', BOARD)).toBe(0);

    await seedHeldPostIt(IDEA);
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    await waitFor(async () => expect(await queuedKeys()).toEqual([]));
    await settle();

    expect(sent('POST', BOARD)).toBe(1);
  });

  /**
   * The case `online` cannot reach: **dead venue wifi, where the link never drops.**
   *
   * `navigator.onLine` reports the link and not reachability (`use-online.ts`) - it is `true`
   * behind a captive portal and on an access point that has stopped forwarding - so no `online`
   * event is ever fired for the outage that ends here. With mount and `online` as the only two
   * triggers, a Post-it typed in that state is held and then never tried again for as long as the
   * app stays loaded, which under Capacitor means until a force-quit. That is the primary case FR6
   * exists for, so it is the one asserted.
   *
   * Nothing below dispatches `online`, and `navigator.onLine` is read at both ends to say so. What
   * retries instead is the application's one foreground tick, whose cadence, interval and
   * registrations all stay in `use-watermark-poll.ts`: the drain is one more consumer of that tick,
   * never a loop of its own.
   *
   * Only `setInterval` is faked, so the tick can be advanced while React, `fake-indexeddb` and the
   * drain's own awaits all keep running on the real clock.
   */
  it('retries on the shared tick, with the link never dropping and no online event', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      await seedHeldPostIt(IDEA);

      let reachable = false;
      globalThis.fetch = boardTakesEverything(async () => {
        if (!reachable) throw new TypeError('Failed to fetch');
        return accepted('p1', IDEA);
      });

      expect(navigator.onLine).toBe(true);
      render(
        <>
          <PostItQueueDrain />
          <ShellTick />
        </>,
      );
      await settle();

      // The mount's own attempt met the dead spot. Her idea is still on the device.
      expect(sent('POST', BOARD)).toBe(1);
      expect((await listQueuedPostIts(NADIA.sub)).map((item) => item.text)).toEqual([IDEA]);

      // The access point starts forwarding again. Nothing announces it - no event, no flag.
      reachable = true;
      await act(async () => {
        vi.advanceTimersByTime(POLL_INTERVAL_MS);
      });
      await settle();

      expect(await queuedKeys()).toEqual([]);
      expect(sent('POST', BOARD)).toBe(2);
      const retry = calls.filter((call) => call.method === 'POST' && call.path === BOARD)[1]!;
      const body = retry.body as { text: string; offlineComposed: boolean };
      expect(body.text).toBe(IDEA);
      expect(body.offlineComposed).toBe(true);
      expect(navigator.onLine).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * One drain for the device, not one per mounted surface.
   *
   * Two drains are mounted in the same commit, and the first item's send is held open across the
   * second one's mount – so if the loop were per component the second would list the same item,
   * send it again, and one idea would land twice under a real name. The lock is module-level for
   * exactly this reason: two surfaces are still one queue.
   */
  it('runs one drain at a time however many surfaces are mounted', async () => {
    await seedHeldPostIt(IDEA);

    let sendReached: (() => void) | null = null;
    const firstSendOut = new Promise<void>((resolve) => {
      sendReached = resolve;
    });
    let releaseFirstSend: (() => void) | null = null;
    const released = new Promise<void>((resolve) => {
      releaseFirstSend = resolve;
    });

    globalThis.fetch = boardTakesEverything(async () => {
      if (sendReached !== null) {
        const reached = sendReached;
        sendReached = null;
        reached();
        await released;
      }
      return accepted('p1', IDEA);
    });

    // Mounted outside the `act` below, because that is what starts the drain: an `act` waiting on a
    // promise its own callback has not caused yet would simply never be resolved.
    render(
      <>
        <PostItQueueDrain />
        <PostItQueueDrain />
      </>,
    );

    await act(async () => {
      await firstSendOut;
      releaseFirstSend!();
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    await settle();

    expect(sent('POST', BOARD)).toBe(1);
    expect(await queuedKeys()).toEqual([]);
  });

  /**
   * Nothing is sent for a device with nobody on it.
   *
   * The drain is mounted inside the signed-in branch, so a signed-out shell has no loop at all –
   * and the store's own "no subject, no key" rule is the second half of the same guarantee.
   */
  it('does not drain for a signed-out device', async () => {
    await seedHeldPostIt(IDEA);
    globalThis.fetch = boardTakesEverything(async () => accepted('p1', IDEA));

    render(
      <AuthProvider session={stubSession(null)} initialSearch="">
        <App />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.queryByTestId('sign-in')).not.toBeNull());
    await settle();

    expect(sent('POST', BOARD)).toBe(0);
    expect((await listQueuedPostIts(NADIA.sub)).map((item) => item.text)).toEqual([IDEA]);
  });

  /**
   * The identity discipline, from the shell.
   *
   * A send outlives a handover on a shared tablet: the first item is still out when Nadia is
   * replaced, and the drain stops rather than posting her second idea under the next signer's
   * credential. Proved here as well as at the panel because the loop that has to do this is now the
   * shell's, and a drain that outlives the person who started it is precisely what the shell mount
   * makes more likely.
   */
  it('stops sending when the device changes hands mid-drain', async () => {
    await seedHeldPostIt(IDEA);
    await seedHeldPostIt(SECOND_IDEA);

    let sendReached: (() => void) | null = null;
    const firstSendOut = new Promise<void>((resolve) => {
      sendReached = resolve;
    });
    let handoverDone: (() => void) | null = null;
    const handed = new Promise<void>((resolve) => {
      handoverDone = resolve;
    });

    globalThis.fetch = boardTakesEverything(async () => {
      if (sendReached !== null) {
        const reached = sendReached;
        sendReached = null;
        reached();
        await handed;
      }
      return accepted('p1', IDEA);
    });

    render(<PostItQueueDrain />);

    await act(async () => {
      await firstSendOut;
      // Nadia signs out and Björn signs in while her first send is still in flight.
      setCacheIdentity(() => 'google-sub-bjorn');
      handoverDone!();
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    await settle();

    // Only the send that was already out. The second item was never attempted, and it is still
    // hers – keyed under her own subject rather than sent or deleted under his.
    expect(sent('POST', BOARD)).toBe(1);
    expect((await listQueuedPostIts('google-sub-nadia')).map((item) => item.text)).toEqual([
      SECOND_IDEA,
    ]);
    expect(await listQueuedPostIts('google-sub-bjorn')).toEqual([]);
  });
});
