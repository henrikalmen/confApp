/**
 * The application's one foreground tick, as something other than a poll can listen to.
 *
 * `poll/use-watermark-poll.ts` owns the cadence, the interval and the visibility/focus/online
 * registrations, and it stays the only module that does (`plan.json#sharedDecisions` – "Near-live
 * propagation: one cursor"). What lives here is the seam that lets a **second consumer** hang off
 * that same tick without owning a timer, a cadence or a listener of its own: the loop announces
 * each tick, and anything that needs a periodic nudge subscribes. One cadence, one registration,
 * one more consumer – not a second mechanism.
 *
 * **It is deliberately not a scheduler.** Nothing here starts anything, holds an interval or knows
 * a cadence; with no watermark poll mounted, nothing ticks. A consumer that must act on its own
 * arrival has to do that for itself, exactly as the poll's call sites do.
 *
 * It sits outside `poll/` so a consumer can subscribe without importing the loop. S03's structural
 * guard keeps every source under `offline/` clear of the poll module, and the Post-it queue's drain
 * – the first consumer of this – is one of them.
 */

const listeners = new Set<() => void>();

/**
 * Subscribes to the shared tick, and returns the unsubscribe for an effect's cleanup.
 *
 * A listener is told that a moment worth acting on has arrived, and nothing else: no argument, no
 * answer read, no promise awaited. What that is worth doing about belongs to the consumer.
 */
export function onForegroundTick(listener: () => void): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

/**
 * Announces a tick. Called by the one loop, and by nothing else.
 *
 * Over a copy of the set, so a listener unsubscribing while being told does not disturb the
 * iteration – the same rule the Post-it queue's own watcher list follows. Each listener is isolated
 * as well: a consumer that throws must not take out the other consumers, nor the poll whose tick
 * this is.
 */
export function foregroundTicked(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // A consumer's failure is the consumer's own. The tick carries on.
    }
  }
}
