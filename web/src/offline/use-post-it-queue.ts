import { useEffect, useRef, useSyncExternalStore } from 'react';
import { ApiError, contributePostIt } from '../api/client.ts';
import { onForegroundTick } from '../tick/foreground-tick.ts';
import { cacheIdentity } from './schedule-cache.ts';
import {
  dropQueuedPostIt,
  holdPostIt,
  listQueuedPostIts,
  markQueuedPostItRefused,
  type QueuedPostIt,
} from './post-it-queue.ts';

/**
 * Holding a Post-it that could not be delivered, and sending it when it can be.
 *
 * The storage half is `post-it-queue.ts`; this is the half that talks to the API, kept apart for
 * the same reason `schedule-data.ts` is kept apart from `schedule-cache.ts` – the store answers
 * questions about itself and knows nothing about requests.
 *
 * **A failing request is what queues, and a succeeding one is what drains.** `navigator.onLine` is
 * used for exactly one thing here: as a prompt to *attempt* a drain when the link comes back. It
 * decides nothing, because it is `true` behind a captive portal and on dead venue wifi, and an
 * offline path that trusted it would sit waiting for a request that never arrives
 * (`use-online.ts`). It is not the only prompt either, for the same reason – on the wifi that
 * never dropped there is no event to hear, so the drain also rides the application's shared
 * foreground tick. See `PostItQueueDrain` below.
 *
 * **Sequential, one item at a time.** Not for throughput – a queue here holds a handful of items at
 * most – but because a failure is information: the first item that cannot be delivered means the
 * link is still down, and firing the rest in parallel would turn one dead spot into a burst of
 * timeouts with the same outcome.
 *
 * **The drain belongs to the device, not to a screen** (product decision, 2026-08-29). It is
 * mounted once, in the app shell, as `PostItQueueDrain`, so somebody who types in a dead spot,
 * walks out of the room and reconnects at the coffee table has their Post-it sent there and then –
 * rather than when they happen to navigate back to the one Session panel that used to own the loop.
 * That is what FR6 and US09 promise, and a panel-scoped drain could not deliver it.
 *
 * Which is why the state below is **module-level and shared**, not per component: the queue is one
 * thing this device is holding, so `draining` is one flag rather than one per mount, and a Session
 * panel showing pending items reads the same store the shell's drain writes instead of starting a
 * second loop of its own. Nothing here is state kept between requests – it is a projection of what
 * IndexedDB holds, re-read from the store after every change.
 */

/**
 * Whether a failed attempt is worth trying again – and, at the compose box, whether the typed text
 * should be held at all.
 *
 * The distinction FR6's error handling turns on. A transport failure, a lapsed credential and a
 * 5xx are all "not now" – the item stays queued and pending, with no message, and the next
 * reconnect tries again. Anything the *server refused* is "not ever": the Round has been deleted,
 * the text is not acceptable, this person is no longer a Member. Those come back to their author
 * with the server's own sentence rather than retrying forever or being discarded.
 *
 * A transport throw is not an `ApiError` at all – `fetch` rejects and the error escapes the client
 * unwrapped – so the default is to retry, which is the safe direction: an item retried needlessly
 * is a duplicate the API's submission identity already refuses, while an item discarded wrongly is
 * gone.
 *
 * Exported so the compose box and the drain share **one** classification. Two copies would
 * eventually disagree, and the disagreement anybody would notice is the bad one: a submission the
 * server refused being held and retried under a real name.
 */
export function mayStillBeDelivered(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  /*
   * `401` is in here with the transport failures and the 5xx, and it is the one that is easy to
   * miss: a credential this client believed valid and the API did not - clock skew, a rotated key,
   * a token that expired between being read and being checked - is "not now", exactly like the
   * lapsed-credential case the client catches for itself as status 0. Treating it as a refusal
   * would stamp the post-it with a sign-in message and never try again, even after its author
   * signs straight back in.
   */
  return error.status === 0 || error.status === 401 || error.status >= 500;
}

export interface HeldPostIt {
  /** Minted before the *first* attempt, so a retry is the same submission - see `Submission`. */
  submissionId: string;
  conferenceId: string;
  sessionId: string;
  roundId: string;
  text: string;
}

export interface PostItQueue {
  /** Everything this device is holding for the signed-in employee, oldest first. */
  queued: QueuedPostIt[];
  /**
   * How many drains have delivered something, ever, on this device.
   *
   * A counter rather than a callback, because the drain no longer knows who is watching: a surface
   * showing a board compares this against what it last saw and re-reads when the two differ. It is
   * only ever compared for equality – never subtracted, and never read as a number of Post-its.
   */
  deliveries: number;
  /** Holds a Post-it whose submission could not be delivered. `false` if storage would not take it. */
  hold: (item: HeldPostIt) => Promise<boolean>;
  /** The author has read the reason their text could not be posted; it leaves the device now. */
  dismiss: (submissionId: string) => Promise<void>;
}

interface QueueState {
  /**
   * The subject this listing was read for.
   *
   * Carried so a surface can tell whether what is in memory is *its own* – a shared tablet changes
   * hands, and the projection of the previous signer's queue would otherwise still be here for the
   * first render after the next one opens a Session, showing their text under the new name. The
   * store on disk is already emptied by then (`adoptCacheOwner`); this is the same rule applied to
   * the copy held in memory.
   */
  owner: string | null;
  queued: QueuedPostIt[];
  deliveries: number;
}

/** Stable, so a surface with nothing held does not re-render on an unrelated publish. */
const NOTHING: QueuedPostIt[] = [];

let state: QueueState = { owner: null, queued: NOTHING, deliveries: 0 };
const watchers = new Set<() => void>();

function publish(next: QueueState): void {
  state = next;
  // A copy, so a watcher unsubscribing while being told does not disturb the iteration.
  for (const watcher of [...watchers]) watcher();
}

function watch(watcher: () => void): () => void {
  watchers.add(watcher);
  return (): void => {
    watchers.delete(watcher);
  };
}

function read(): QueueState {
  return state;
}

/**
 * Re-reads the store for **whoever is signed in now**, deliberately without a subject argument.
 *
 * A drain can outlive the person who started it on a shared tablet, and publishing the list it was
 * working from would then put the previous signer's text on the next signer's screen. Asking the
 * store fresh means a handover shows an empty queue, which is the only correct answer.
 */
async function reload(): Promise<void> {
  const sub = cacheIdentity();
  publish({ ...state, owner: sub, queued: await listQueuedPostIts(sub) });
}

/**
 * Whether a drain has anything to do – cheap enough to ask on every tick, which is why it exists.
 *
 * The projection answers this honestly because **every write to the store is followed by a
 * publish**: `hold` and `dismiss` reload, and the drain publishes its own final listing. So nothing
 * this device is holding is on disk without also being in here, and a tick that finds this `false`
 * is skipping a listing it already knows the answer to rather than guessing at one.
 *
 * A `null` owner is a reason to look, not a reason not to: it means nothing has been listed for
 * anybody yet – the drain has never completed, or completed with nobody signed in – and a drain
 * asked in that state costs nothing, because it stops at the first line when there is no subject.
 *
 * Deliberately **not** applied to the `online` handler. The link returning is rare, and it is the
 * one moment worth reading the store itself rather than a projection of it.
 */
function somethingToSend(): boolean {
  return state.owner === null || state.queued.some((item) => item.refusal === null);
}

/**
 * One drain at a time, for the whole device.
 *
 * Module-level rather than per component: two mounted surfaces are still one queue, and a second
 * loop would send an item again while the first attempt was still waiting for its answer.
 */
let draining = false;

async function drain(): Promise<void> {
  if (draining) return;
  /*
   * **Whose drain this is, decided once and carried through every step of it.**
   *
   * A send can hang for as long as a dead spot lasts, and a shared tablet can change hands in
   * that window: sign out, sign in as somebody else. Re-reading the signed-in subject per call
   * would then list, send and delete under the *new* identity - posting Anna's text under
   * Björn's credential, permanently, under his name. So the subject is captured here, passed
   * explicitly to every queue call below, and re-checked immediately before each send; the drain
   * simply stops when the device stops being this person's.
   */
  const sub = cacheIdentity();
  if (sub === null) return;

  draining = true;
  try {
    let delivered = false;
    for (const item of await listQueuedPostIts(sub)) {
      // Already refused for good. It is on screen with its reason and waits for its author.
      if (item.refusal !== null) continue;
      // Somebody else now owns this device. Nothing of this person's is sent under their name.
      if (cacheIdentity() !== sub) break;

      try {
        await contributePostIt(item.conferenceId, item.sessionId, item.roundId, item.text, {
          submissionId: item.submissionId,
          offlineComposed: true,
        });
        await dropQueuedPostIt(item.submissionId, sub);
        delivered = true;
      } catch (error) {
        if (mayStillBeDelivered(error)) {
          // Still queued, still pending, text unchanged – and no point trying the rest, because
          // whatever stopped this one will stop them too.
          break;
        }
        await markQueuedPostItRefused(
          item.submissionId,
          error instanceof ApiError
            ? error.message
            : 'This post-it could not be posted, and the reason is not known.',
          sub,
        );
      }
    }
    /*
     * One publish for both halves, so a board that re-reads itself on a delivery does so against
     * the emptied queue rather than one render behind it. The listing is for whoever is signed in
     * *now*, for the handover reason `reload` gives.
     */
    const owner = cacheIdentity();
    publish({
      owner,
      queued: await listQueuedPostIts(owner),
      deliveries: delivered ? state.deliveries + 1 : state.deliveries,
    });
  } finally {
    draining = false;
  }
}

async function hold(item: HeldPostIt): Promise<boolean> {
  /*
   * Never throws. The caller is in its own `catch` when it reaches here - the submission has
   * just failed - and a second throw from storage would escape it, leaving the person with a
   * submit that did nothing and said nothing. `false` routes them to the refusal instead, with
   * their text still in the box.
   */
  let held: boolean;
  try {
    held = await holdPostIt({ ...item, heldAt: Date.now() });
  } catch {
    held = false;
  }
  await reload();
  return held;
}

async function dismiss(submissionId: string): Promise<void> {
  await dropQueuedPostIt(submissionId);
  await reload();
}

/**
 * What this device is holding, for a surface that shows it.
 *
 * Read-only as far as sending goes: this **starts no drain**. More than one of these can be mounted
 * at a time – a Session panel, and whatever else grows a pending list later – and a drain per
 * subscriber is exactly the arrangement the shell-level mount replaced.
 */
export function usePostItQueue(): PostItQueue {
  const current = useSyncExternalStore(watch, read);
  useEffect(() => {
    // A surface can mount long after the last drain published anything - after a relaunch with no
    // connection there may never have been one at all - so it reads the store for itself.
    void reload();
  }, []);
  // Nothing read for somebody else is shown, not even for the render before the re-read lands.
  const mine =
    current.owner !== null && current.owner === cacheIdentity() ? current.queued : NOTHING;
  return { queued: mine, deliveries: current.deliveries, hold, dismiss };
}

/**
 * The drain itself, mounted **once, in the app shell**, for a signed-in employee.
 *
 * Renders nothing: it exists so the loop's lifetime is the signed-in app's rather than one panel's.
 * Mounting it inside the signed-in branch is what keeps it off a signed-out device, and the store's
 * own "no subject, no key" rule is the second half of that – a drain with nobody signed in has no
 * queue to read and stops before it sends anything.
 *
 * It runs on mount – the app arriving, or somebody signing in – whenever the link comes back, and
 * on the application's shared foreground tick. None of the three is a promise that the request will
 * get through; all three are just moments worth trying.
 *
 * **The tick is the one that carries FR6's actual case.** `online` fires when the link drops and
 * returns, and on dead venue wifi the link never drops: the access point stops forwarding,
 * `navigator.onLine` stays `true`, and no event is ever raised for the outage or for its end
 * (`use-online.ts`). Mount and `online` alone therefore leave a Post-it typed in that dead spot
 * held until the app is force-quit, which is the whole of what this story promises not to do.
 *
 * So the drain hangs off the tick the watermark poll already fires on interval, on
 * `visibilitychange`, on `focus` and on `online` (`tick/foreground-tick.ts`) – **subscribing to one
 * cadence rather than starting a second**, which is the standing rule for this application
 * (`plan.json#sharedDecisions`). The drain owns no timer, no cadence and no listener of its own,
 * and the tick asks it to look only while it is actually holding something.
 */
export function PostItQueueDrain(): null {
  useEffect(() => {
    void drain();
    const attempt = (): void => void drain();
    window.addEventListener('online', attempt);
    /*
     * Gated on the projection, so a tick costs nothing on the overwhelming majority of devices,
     * which are holding nothing: an empty queue makes this a comparison, not a read of the store
     * and not a publish that would re-render every surface watching it every few seconds.
     */
    const stopListening = onForegroundTick(() => {
      if (somethingToSend()) attempt();
    });
    return () => {
      window.removeEventListener('online', attempt);
      stopListening();
    };
  }, []);
  return null;
}

/**
 * Runs `onDelivery` when a drain has actually delivered something, and never on mount.
 *
 * The seam between the device-wide drain and a board that has to re-read itself once a held Post-it
 * finally lands. The count seen at mount is the baseline, so a surface opened after somebody else's
 * delivery does not re-read for a change it was never showing.
 */
export function useDeliveredPostIts(deliveries: number, onDelivery: () => void): void {
  const seen = useRef(deliveries);
  useEffect(() => {
    if (deliveries === seen.current) return;
    seen.current = deliveries;
    onDelivery();
  }, [deliveries, onDelivery]);
}
