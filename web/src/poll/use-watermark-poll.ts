import { useEffect, useRef } from 'react';
import { foregroundTicked } from '../tick/foreground-tick.ts';

/**
 * The one watermark-poll loop in this application.
 *
 * It was written for the Schedule (S09) and lived inside `AttendeeSchedulePanel` until S02 moved it
 * here unchanged. It is a *loop*, not a fetch: what to ask the server, what to compare and what to
 * do about a difference all stay with the caller. The four decisions this module owns are the ones
 * every polling view needs to make identically, and the reason there is exactly one of it:
 *
 *   - **Cadence.** Five seconds meets the propagation row in the PRD's non-functional requirements
 *     without polling for its own sake. The request is two scalars, and at most one is ever in
 *     flight, so a hall of a hundred attendees costs the API a hundred tiny reads every five
 *     seconds - the capacity case the PRD actually names.
 *   - **At most one request in flight.** A tick arriving while one is outstanding is *skipped*,
 *     never queued: a slow network must not build a backlog that then arrives all at once.
 *   - **Nothing is asked while the view is not being read**, and becoming visible or focused
 *     refreshes **immediately** rather than waiting out the next tick. A phone in a pocket for an
 *     hour must not spend battery on a view nobody is looking at, and somebody returning to the app
 *     expects current data at once. `online` prompts an attempt for the same reason - the link
 *     returning is a *prompt* to try, never proof that anything is reachable; the request's own
 *     success is that.
 *   - **Abort on unmount, and the in-flight flag is left to the aborted poll's own `finally`.**
 *     Clearing the flag from the cleanup could release a flag a newly started poll already holds,
 *     which is precisely how the one-in-flight guarantee breaks.
 *
 * **Two call sites, and there are to be no more mechanisms - only more call sites**
 * (`plan.json#sharedDecisions` -> "Near-live propagation: one cursor"). The Schedule view it came
 * from, and the Session Activities view, whose own refresh S01 built and S02 retired onto this.
 * S03's tally is a third consumer of the same loop rather than a third loop.
 *
 * **And one consumer that is not a call site at all.** The Post-it queue's drain needs a moment to
 * try again on – `online` never fires on dead venue wifi, where the link stays up and only
 * reachability is gone – and a retry loop of its own would be the second mechanism this decision
 * forbids. So the tick is announced through `tick/foreground-tick.ts` and the drain subscribes:
 * still one cadence, one interval and one set of registrations, with one more thing listening.
 *
 * Nothing here knows what a watermark *is*. It calls `poll` and gets out of the way.
 */

/** How often an open view asks whether anything changed. See the cadence note above. */
export const POLL_INTERVAL_MS = 5_000;

/**
 * Runs `poll` on the shared cadence while `active`.
 *
 * `poll` is handed the loop's `AbortSignal` and is expected to swallow its own failures - a failed
 * poll changes nothing on screen and the next attempt tries again. A rejection is tolerated (the
 * in-flight flag is released either way) but nothing here reports it.
 *
 * The effect depends on `poll`'s identity, deliberately, so a call site that rebuilds its callback
 * for a different conference or session tears the loop down and **aborts** whatever that callback
 * had in flight. Memoize `poll` with `useCallback` over exactly the values it reads; a callback
 * rebuilt on every render would restart the cadence on every render.
 */
export function useWatermarkPoll(
  active: boolean,
  poll: (signal: AbortSignal) => Promise<void>,
): void {
  /** At most one poll in flight; a tick arriving while one is outstanding is skipped, not queued. */
  const inFlight = useRef(false);

  useEffect(() => {
    if (!active) return;

    const controller = new AbortController();
    const tick = (): void => {
      if (document.hidden) return;
      /*
       * The tick is announced to everything else that needs one, before this loop takes its own
       * turn at it (`tick/foreground-tick.ts`).
       *
       * Announced *past* the visibility check and *before* the in-flight one, deliberately. Past
       * visibility, because a view nobody is looking at is a view nothing should be spending
       * battery on, and that judgement is the same for every consumer. Before in-flight, because
       * that latch is about **this** loop's request overlapping itself, and a slow watermark read
       * is no reason for an unrelated consumer to miss its turn - every consumer guards its own
       * overlap, as the Post-it drain does with its device-wide lock.
       */
      foregroundTicked();
      if (inFlight.current) return;
      inFlight.current = true;
      void poll(controller.signal)
        .catch(() => {
          /*
           * A failed poll changes nothing on screen and the next attempt tries again - the call
           * sites own that decision and already swallow their own failures. Caught here as well so
           * that a call site which one day forgets cannot turn a dropped connection into an
           * unhandled rejection in a Capacitor shell with nothing to report it to.
           */
        })
        .finally(() => {
          inFlight.current = false;
        });
    };

    const timer = setInterval(tick, POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('focus', tick);
    window.addEventListener('online', tick);

    return () => {
      clearInterval(timer);
      // Any request still in flight belongs to the view being left, so it is cancelled rather than
      // allowed to resolve into the next one's. The in-flight flag is *not* cleared here - see the
      // module note.
      controller.abort();
      document.removeEventListener('visibilitychange', tick);
      window.removeEventListener('focus', tick);
      window.removeEventListener('online', tick);
    };
  }, [active, poll]);
}
