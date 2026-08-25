import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  fetchHealth,
  fetchMyConferences,
  fetchScheduleWatermark,
  type AttendeeConference,
  type AttendeeSchedule,
} from '../api/client.ts';
import {
  clockFromSync,
  rehydrateClock,
  type EffectiveClock,
  type WallClockReading,
} from '../clock/effective-clock.ts';
import { ScheduleView } from './ScheduleView.tsx';
import { ScheduleChangeBanner } from './ScheduleChangeBanner.tsx';
import { LeaveConferenceControl } from '../members/LeaveConferenceControl.tsx';
import { defaultDay } from './schedule-view-model.ts';
import { diffSchedule, isEmptyDiff, type ScheduleDiff } from './schedule-diff.ts';
import { stalenessFor } from './staleness.ts';
import { anchorOf } from '../offline/schedule-cache.ts';
import {
  fetchAndCacheSchedule,
  forgetSchedule,
  listCachedConferences,
  readOfflineSchedule,
} from '../offline/schedule-data.ts';
import { cachedScheduleLabel } from '../offline/cached-age.ts';
import { ReconnectSummary } from '../offline/ReconnectSummary.tsx';
import { SignInRequiredNotice } from '../offline/SignInRequiredNotice.tsx';
import { requestRenewal } from '../auth/session-actions.ts';

/**
 * The Attendee's home: the conference picker, the Schedule, and every non-result state.
 *
 * This component is the **view boundary** – the one place in the attendee surface that fetches,
 * reads the device clock and holds a timer. Everything below it (`ScheduleView` and the view model)
 * is a pure function of `(envelope, now)`. The split is not tidiness: S10 must be able to hand that
 * same tree a cached envelope with no network available, and a tree that fetched anywhere inside
 * itself could not be handed anything.
 *
 * **S09 added the poll loop here, and here only.** The Schedule is fetched when the view opens, when
 * the conference changes, on an explicit retry, and now whenever the server's schedule watermark
 * has moved. All of that lives at this boundary because the tree below still must not fetch: S10
 * hands it a cached envelope with no network available, and a tree that fetched anywhere inside
 * itself could not be handed anything. Caching remains S10's; nothing here writes one.
 */

/**
 * How often an open Schedule asks whether anything changed.
 *
 * Five seconds meets the propagation row in the PRD's non-functional requirements without polling
 * for its own sake. The request is two scalars, and at most one is ever in flight, so a hall of a
 * hundred attendees costs the API a hundred tiny reads every five seconds - the capacity case the
 * PRD actually names.
 */
const POLL_INTERVAL_MS = 5_000;

/** A failure the person can act on: the server's own sentence, plus a way to try again. */
interface Failure {
  code: string;
  message: string;
}

function failureOf(error: unknown): Failure {
  return error instanceof ApiError
    ? { code: error.code, message: error.message }
    : {
        code: 'NETWORK_UNREACHABLE',
        message: 'The app could not reach the server. Check your connection and try again.',
      };
}

/**
 * Whether a failure means "the server said no" or "there was no server to ask".
 *
 * The distinction is what makes the offline fallback correct rather than merely convenient. A **4xx
 * is an answer** – a refusal, an archived conference, a membership that ended – and answering it
 * from a cache would show somebody a Schedule they are no longer entitled to. Everything else is
 * the request not having got through, and **a request that did not get through is the authoritative
 * offline signal**: `navigator.onLine` is `true` behind a captive portal and on dead venue wifi, so
 * it prompts an attempt and decides nothing (S10 → Constraints & Gotchas).
 *
 * A **5xx counts as unreachable**, and it has to. `apiRequest` wraps every non-ok response in an
 * `ApiError`, so the API container being down – which is exactly what the SPA container's 502 page
 * is for – would otherwise land on the failure screen with a perfectly good cached Schedule sitting
 * unread on the device. The Reliability requirement is that "a schedule loaded at least once always
 * renders" (FR8), and a gateway that cannot reach the API has not made a decision about anybody's
 * membership. `status === 0` is the same case reached by a different route: a transport failure the
 * client wrapped rather than threw.
 */
function unreachable(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  return error.status === 0 || error.status >= 500;
}

/**
 * Whether **anything answered at all** – the panel's second classifier, and not the same question
 * as `unreachable`.
 *
 * `unreachable` decides whether the cache may answer. This one decides what to say when the cache
 * has nothing: a server that answered, even with a 5xx, has a sentence of its own and a retry worth
 * offering, while a request that never got through leaves "not available offline" as the only
 * useful thing on screen.
 *
 * It cannot simply be `error instanceof ApiError` any more. A request refused for want of a
 * credential never leaves the device, and is reported as an `ApiError` with **status 0** precisely
 * so `unreachable` keeps working (TI07) – but that same wrapper would flip this test and send an
 * attendee with no cached copy to a failure alert instead of the offline notice. Status 0 is the
 * client's own wrapper around a request that did not happen; nothing answered it.
 */
function answered(error: unknown): boolean {
  return error instanceof ApiError && error.status !== 0;
}

/**
 * Whether the request was never issued because there was no credential to issue it with (TI07).
 *
 * Distinguished from an ordinary transport failure because the two need opposite things: a dead
 * network needs waiting, and a lapsed sign-in needs renewing. Both are `unreachable`, and neither
 * takes the Schedule off the screen.
 */
function credentialMissing(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'CREDENTIAL_UNAVAILABLE';
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'failed'; failure: Failure }
  | { kind: 'ready'; schedule: AttendeeSchedule; clock: EffectiveClock }
  /**
   * Read from the cache because the request could not be made (S10 TI04). Both inputs of S06's
   * `render(envelope, effectiveWallClockNow)` are here: the envelope as it was stored, and a clock
   * **rehydrated** from the persisted `(serverNow anchor, deviceClockAtReceipt)` pair – so the
   * running-Session highlight still works after a force-quit with nothing left in memory.
   */
  | {
      kind: 'cached';
      schedule: AttendeeSchedule;
      clock: EffectiveClock;
      deviceClockAtReceipt: number;
    }
  /** Offline with nothing stored for this Conference – a terminal state, never a spinner (TI05). */
  | { kind: 'unavailable-offline' }
  /**
   * Offline with a copy on the device that may no longer be rendered: its Conference's span plus
   * the shared margin has passed. Distinct from `unavailable-offline` on purpose – the schedule is
   * *here*, and what unblocks it is signing in again, not finding a connection once
   * (`offline-session-expiry` OC04).
   */
  | { kind: 'sign-in-required' };

export function AttendeeSchedulePanel(): React.JSX.Element {
  const [conferences, setConferences] = useState<AttendeeConference[] | null>(null);
  const [conferencesFailure, setConferencesFailure] = useState<Failure | null>(null);
  const [conferenceId, setConferenceId] = useState<string | null>(null);
  /**
   * The current selection, readable without depending on it.
   *
   * `loadConferences` has to know whether something is already open so a re-read does not move it,
   * but it is `useCallback(…, [])` on purpose – binding it to `conferenceId` would rebuild it on
   * every pick and re-drive the list effect below with it, turning each change of conference into
   * a fresh `/me/conferences` request.
   */
  const conferenceIdRef = useRef<string | null>(null);
  conferenceIdRef.current = conferenceId;

  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  /** What the last refresh changed, until the attendee dismisses it. */
  const [changes, setChanges] = useState<ScheduleDiff | null>(null);
  /**
   * What moved while the device was offline – S10's own surface, and the only one that can reach
   * an attendee S09's banner could not, because there was no open view to put a banner on.
   */
  const [reconnected, setReconnected] = useState<ScheduleDiff | null>(null);
  /** Bumped by the retry control, which is what makes a failed fetch re-issue the request. */
  const [attempt, setAttempt] = useState(0);
  /**
   * Bumped once a minute for its side effect alone – re-rendering, so the corrected clock is read
   * again below. The value is never read, which is why it is not bound: what advances is the
   * *clock*, and this is only what asks React to look at it.
   */
  const [, reevaluateHighlight] = useState(0);

  // ---------- which conferences, and which one to open ----------

  const loadConferences = useCallback(async (signal?: AbortSignal): Promise<void> => {
    setConferencesFailure(null);
    try {
      const body = await fetchMyConferences(signal);
      setConferences(body.conferences);
      /*
       * The server's choice, not a re-derivation of the rule. Falls back to the first entry only
       * where the server named none – which is the empty list.
       *
       * **An open conference is kept open.** This runs again on reconnect, to hand back the list
       * the cache was standing in for, and an attendee reading a schedule offline must not have it
       * swapped for the server's default at the moment the connection returns – that is exactly
       * when she is looking at the screen. The server's choice applies when nothing is open yet, or
       * when what was open is no longer hers: `handleLeft` clears the selection before re-reading
       * for precisely that reason, and a membership revoked elsewhere drops out of the list here.
       */
      const open = conferenceIdRef.current;
      const stillMine = open !== null && body.conferences.some((entry) => entry.id === open);
      setConferenceId(
        stillMine ? open : (body.defaultConferenceId ?? body.conferences[0]?.id ?? null),
      );
    } catch (error) {
      if (signal?.aborted) return;

      /*
       * The list could not be fetched. Offline it is rebuilt from the cached Schedules themselves –
       * every stored envelope carries the Conference it belongs to, so the picker is a projection
       * of the schedule read model rather than a second cached payload. Without this, an attendee
       * who launched the app with no connection would have no conference selected and therefore
       * never reach the offline schedule at all.
       */
      if (unreachable(error)) {
        const { conferences: cached, withheld } = await listCachedConferences();
        if (signal?.aborted) return;
        if (cached.length > 0) {
          setConferences(cached);
          // Same rule as the success branch above, and needed for the same reason: this path is
          // also reached from the reconnect re-drive, where only the *list* request failed while
          // the schedule itself refreshed. Selecting `cached[0]` there – the alphabetically first
          // entry, not the open one – would switch conference under the attendee and re-run the
          // schedule effect, which clears the reconnect summary she has not read yet (S04).
          const open = conferenceIdRef.current;
          const stillCached = open !== null && cached.some((entry) => entry.id === open);
          setConferenceId(stillCached ? open : cached[0]!.id);
          return;
        }
        /*
         * Nothing to offer, but not because nothing was ever stored: every cached Conference on
         * this device is past its window. Saying "not available offline" here would be the one
         * sentence that is untrue – the schedules are on the device – so the state that names the
         * actual remedy is rendered instead (OC04). The schedule effect below never runs, because
         * there is no Conference selected for it to ask about, so this branch has to say it.
         */
        if (withheld) {
          setConferences([]);
          setPhase({ kind: 'sign-in-required' });
          return;
        }
        /*
         * Nothing was ever stored on this device. With no server answer either there is nothing to
         * quote, so the offline state is the most useful thing on screen (OC03) – but a server that
         * did answer, even with a 5xx, has a sentence and a retry of its own, and that is better
         * than a generic one.
         */
        if (!answered(error)) {
          setConferences([]);
          setPhase({ kind: 'unavailable-offline' });
          return;
        }
      }

      setConferencesFailure(failureOf(error));
      setConferences([]);
    }
  }, []);

  /*
   * `attempt` is a dependency here as well as of the schedule effect below, so one retry control
   * re-drives whichever request failed. It has to be: the venue network drops both, and
   * `/me/conferences` is the one that goes first – without this the list failure was a dead end with
   * no way back, and on the Capacitor shells there is no address bar to reload from (Acceptance
   * Scenario S07).
   */
  useEffect(() => {
    const controller = new AbortController();
    void loadConferences(controller.signal);
    return () => controller.abort();
  }, [loadConferences, attempt]);

  /**
   * What is left after a membership ends.
   *
   * The conference is cleared *before* the list is re-read, so the schedule effect below has
   * nothing to ask for in between: reloading with the old id still selected would fire one request
   * for a conference the person is no longer in and put its refusal on screen for a moment, which
   * is a worse answer than the correct one arriving a fraction later.
   */
  const handleLeft = useCallback((): void => {
    /*
     * The cached copy goes with the membership. Leaving says "its schedule will stop being
     * available to you", and an entry left in storage would make that true online and false
     * offline – and would put the conference back in the offline picker on the next launch with no
     * connection. Read from state before it is cleared below.
     */
    if (conferenceId !== null) void forgetSchedule(conferenceId);

    setConferenceId(null);
    setConferences(null);
    setSelectedDay(null);
    setChanges(null);
    setReconnected(null);
    setPhase({ kind: 'loading' });
    setAttempt((value) => value + 1);
  }, [conferenceId]);

  // ---------- the schedule itself ----------

  useEffect(() => {
    if (conferenceId === null) return;

    const controller = new AbortController();
    setPhase({ kind: 'loading' });
    /*
     * Whatever changed about the *previous* conference is not news about this one. Without this a
     * banner naming a session from the conference just switched away from would sit above a
     * schedule it has nothing to do with.
     */
    setChanges(null);
    setReconnected(null);

    void (async () => {
      try {
        /*
         * Caching is a property of the read, not a separate opt-in (S10 TI02): the envelope, its
         * watermark and the device clock at receipt are stored by the same call that fetched them.
         * "At receipt" is read inside that call, at the moment the response arrives – reading it
         * later would fold whatever happened in between into the offset.
         */
        const { schedule, deviceClockAtReceipt } = await fetchAndCacheSchedule(
          conferenceId,
          controller.signal,
        );
        if (controller.signal.aborted) return;

        setPhase({
          kind: 'ready',
          schedule,
          clock: clockFromSync(schedule.serverNow, deviceClockAtReceipt),
        });
        // Cleared so the new conference opens on its own default day rather than on a date from
        // the previous one, which may not even exist in this span.
        setSelectedDay(null);
      } catch (error) {
        if (controller.signal.aborted) return;

        // The server answered and its answer was no. A cache must not overrule it.
        if (!unreachable(error)) {
          setPhase({ kind: 'failed', failure: failureOf(error) });
          return;
        }

        const offline = await readOfflineSchedule(conferenceId);
        if (controller.signal.aborted) return;

        /*
         * On the device, but past its Conference's span plus the shared margin. Withheld and said
         * so: the remedy is a sign-in, not a connection, and S10's offline notice would claim the
         * schedule is absent when it is sitting in storage (OC04).
         */
        if (offline.kind === 'lapsed') {
          setPhase({ kind: 'sign-in-required' });
          return;
        }

        if (offline.kind === 'absent') {
          /*
           * Nothing stored. An evicted entry and one that never existed are the same outcome, and
           * both are ordinary: iOS WebKit clears IndexedDB for unused origins and quota pressure
           * drops entries, so nothing about correctness may depend on one having survived (TI05).
           *
           * What to say depends on whether anything answered. A 5xx came from a server that has a
           * sentence of its own and a retry worth offering; only a request that never got through
           * leaves "this conference is not available offline" as the most useful thing on screen –
           * and a request refused for want of a credential never got through either (TI07).
           */
          setPhase(
            answered(error)
              ? { kind: 'failed', failure: failureOf(error) }
              : { kind: 'unavailable-offline' },
          );
          return;
        }

        const cached = offline.entry;
        setPhase({
          kind: 'cached',
          schedule: cached.envelope,
          /*
           * The second render input, reconstituted from the two values stored at the last
           * successful sync. Not the raw device clock, and not an offset recomputed against the
           * clock as it reads now – that would cancel to zero and silently put the device's own
           * time back in charge of the highlight.
           */
          clock: rehydrateClock(anchorOf(cached)),
          deviceClockAtReceipt: cached.deviceClockAtReceipt,
        });
        setSelectedDay(null);
      }
    })();

    return () => controller.abort();
  }, [conferenceId, attempt]);

  // ---------- the near-live refresh (S09 TI02) ----------

  /**
   * The envelope currently on screen, in a ref as well as in state.
   *
   * The poll reads it to decide whether anything moved, and holding it here is what keeps the
   * interval from being torn down and rebuilt on every refresh - which would reset the cadence
   * each time the schedule changed, exactly when it matters most.
   */
  const renderedRef = useRef<{ schedule: AttendeeSchedule; cached: boolean } | null>(null);
  useEffect(() => {
    renderedRef.current =
      phase.kind === 'ready'
        ? { schedule: phase.schedule, cached: false }
        : // A cached Schedule is polled too – that poll *is* the reconnect detector (S10 TI06).
          phase.kind === 'cached'
          ? { schedule: phase.schedule, cached: true }
          : null;
  }, [phase]);

  /** At most one poll in flight; a tick arriving while one is outstanding is skipped, not queued. */
  const pollingRef = useRef(false);

  /**
   * Whether this view has already asked for a renewal.
   *
   * A renewal is a top-level navigation, and asking twice is asking to leave the app twice. The
   * session refuses a second one of its own accord, but the *decision* to ask belongs here and
   * must be made once: without this the poll would probe reachability on every five-second tick
   * for as long as the credential stayed lapsed.
   */
  const renewalAskedRef = useRef(false);

  const syncIfChanged = useCallback(
    async (signal: AbortSignal): Promise<void> => {
      const rendered = renderedRef.current;
      if (conferenceId === null || rendered === null || pollingRef.current) return;

      pollingRef.current = true;
      try {
        const watermark = await fetchScheduleWatermark(conferenceId, signal);

        /*
         * The whole point of the watermark: an unchanged value costs two scalars and stops here.
         * Only a value that has actually moved is worth the schedule payload.
         *
         * A **cached** view is the exception and always refetches. Its watermark being unchanged
         * means nothing moved while the device was away, not that there is nothing to do: the
         * cached-data label has to be replaced by the live state, and the entry's `serverNow`
         * anchor and `deviceClockAtReceipt` have to be rewritten so staleness and the clock offset
         * both re-anchor to this sync rather than to one from three days ago (S10 TI06).
         */
        if (
          !rendered.cached &&
          watermark.lastUpdatedAt === rendered.schedule.conference.lastUpdatedAt
        ) {
          return;
        }

        // The same fetch-and-cache path the initial read uses, so a refresh cannot leave the cache
        // holding an older envelope than the screen. "At receipt" is read inside it.
        const { schedule: refreshed, deviceClockAtReceipt } = await fetchAndCacheSchedule(
          conferenceId,
          signal,
        );

        /*
         * Two round trips have happened since this poll started, and the person may have moved on.
         * Without these guards a slow poll for the conference just left resolves last and paints
         * its schedule under the new conference's name - and then diffs across two different
         * conferences, announcing every session of one as removed and every session of the other as
         * added. Aborting is not enough on its own: the abort races the resolution, so the identity
         * of what came back is checked too.
         */
        if (signal.aborted) return;
        if (renderedRef.current !== rendered) return;
        if (refreshed.conference.id !== rendered.schedule.conference.id) return;

        /*
         * The one moment both envelopes are in hand, which is the entire reason "what changed" is
         * derived on the client. The outgoing one is read from the ref before the swap.
         *
         * **S09's diff, called – not reimplemented.** The base is whichever envelope was on screen,
         * which offline is the one that came out of the cache; the comparison itself is the same
         * function, so the reconnect summary and the in-app banner cannot disagree about an edit.
         */
        const diff = diffSchedule(rendered.schedule, refreshed);
        // Gated on the **Conference** watermark, which S04 advances on Session insert, update *and*
        // delete – a cursor taken from the newest Session timestamp could not see a deletion, the
        // one change class most likely to strand somebody outside a room that no longer exists.
        const moved =
          refreshed.conference.lastUpdatedAt !== rendered.schedule.conference.lastUpdatedAt;

        setPhase({
          kind: 'ready',
          schedule: refreshed,
          clock: clockFromSync(refreshed.serverNow, deviceClockAtReceipt),
        });

        if (rendered.cached) {
          // Reconnect. An unmoved watermark means nothing changed while the device was away, and
          // an empty summary is never shown as a change (S10 Acceptance Scenario S05).
          if (moved && !isEmptyDiff(diff)) setReconnected(diff);

          /*
           * The list was projected from the cache while the device was offline, and nothing else
           * ever hands it back. Without this the schedule goes live while everything around it
           * stays frozen: a Conference joined but never cached is missing from the picker, and a
           * Conference renamed or archived while the device was away keeps its old name beside an
           * enabled Leave control, over a schedule that has already refreshed. Re-driven here
           * rather than through `attempt`, which the schedule effect also depends on - bumping it
           * would restart the load that just resolved and race this reconnect, discarding the
           * summary set above.
           */
          void loadConferences();
        } else if (!isEmptyDiff(diff)) {
          // An unchanged poll never reaches here, so a dismissed banner is not re-raised by one.
          setChanges(diff);
        }
      } catch (error) {
        /*
         * A failed poll or refetch changes nothing on screen (Acceptance Scenario S07). The last
         * successfully synced Schedule stays exactly as it was, its age keeps counting up, and the
         * next attempt tries again - the PRD's rule that the view as of its last successful sync is
         * the source of truth. Replacing it with an error would take the schedule away from someone
         * standing in a corridor deciding where to go next.
         *
         * **Except when the server answered.** S09 could swallow everything here because it only
         * ever polled a live view; S10 polls a *cached* one, and there the same rule the initial
         * load follows has to apply - a cache must not overrule an answer. An attendee removed from
         * the Conference would otherwise keep reading its Schedule from storage for as long as the
         * view stayed open, told they were offline while the server was in fact refusing them. The
         * entry goes with the refusal, for the same reason leaving takes it.
         */
        if (rendered.cached && !unreachable(error)) {
          void forgetSchedule(conferenceId);
          if (!signal.aborted && renderedRef.current === rendered) {
            setPhase({ kind: 'failed', failure: failureOf(error) });
          }
          return;
        }

        /*
         * **The reconnect that a lapsed sign-in would otherwise never see.**
         *
         * With no credential, `apiRequest` refuses to issue the poll at all (TI07), so the poll
         * can no longer be what notices the connection returning – it fails identically on a dead
         * network and on a live one. Something still has to notice, or an attendee whose token
         * lapsed on day two reads a cached schedule for the rest of the conference and is never
         * offered the silent renewal that would put her back online.
         *
         * So this asks the one route that needs no credential – `/health`, the readiness signal
         * that already exists for exactly this "is the API there" question – and only a **reply**
         * starts the renewal. Not `navigator.onLine`, which is `true` behind a captive portal and
         * on dead venue wifi, and not the link event: a request that answered is the only proof
         * that a top-level navigation to Google has anywhere to go (Acceptance Scenario S04).
         *
         * Nothing about the refresh itself changes. It stays the ordinary authenticated request it
         * has always been; this adds no route by which a Schedule could be read.
         */
        if (rendered.cached && !renewalAskedRef.current && credentialMissing(error)) {
          try {
            await fetchHealth(signal);
          } catch {
            // Still nothing there. The cached view stands and the next tick tries again.
            return;
          }
          if (signal.aborted || renderedRef.current !== rendered) return;

          renewalAskedRef.current = true;
          void requestRenewal();
        }
      } finally {
        pollingRef.current = false;
      }
    },
    [conferenceId, loadConferences],
  );

  useEffect(() => {
    // A cached view polls on the same loop. That poll is the whole reconnect mechanism: the first
    // watermark request that succeeds is the connection coming back, and a request that fails is
    // the connection still being gone – neither is decided by `navigator.onLine` (S10 TI06).
    if (phase.kind !== 'ready' && phase.kind !== 'cached') return;

    /*
     * Nothing is asked of the network while the tab is hidden or the app is backgrounded: a phone
     * in a pocket for an hour must not spend battery on a schedule nobody is reading. Becoming
     * visible or focused refreshes **immediately** rather than waiting for the next tick, because
     * an attendee returning to the app expects current data at once.
     */
    const controller = new AbortController();
    const tick = (): void => {
      if (!document.hidden) void syncIfChanged(controller.signal);
    };

    const timer = setInterval(tick, POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('focus', tick);
    // The link returning is a *prompt* to try, never the proof that anything is reachable – the
    // request's own success is that. Without it, an attendee whose wifi came back would wait out
    // the next tick for no reason.
    window.addEventListener('online', tick);

    return () => {
      clearInterval(timer);
      // Any request still in flight belongs to the conference being left, so it is cancelled rather
      // than allowed to resolve into the next one's view. The in-flight flag is *not* cleared here:
      // the aborted poll's own `finally` owns it, and clearing it from the cleanup could release a
      // flag a newly started poll already holds, breaking the one-in-flight guarantee.
      controller.abort();
      document.removeEventListener('visibilitychange', tick);
      window.removeEventListener('focus', tick);
      window.removeEventListener('online', tick);
    };
  }, [phase.kind, conferenceId, syncIfChanged]);

  /**
   * The way out of the terminal offline state.
   *
   * `unavailable-offline` has nothing cached to poll against, so the loop above does not run for
   * it. Re-driving the whole load when the link returns is what keeps it from being a dead end on
   * a Capacitor shell, where there is no address bar to reload from.
   */
  useEffect(() => {
    if (phase.kind !== 'unavailable-offline') return;
    const retry = (): void => setAttempt((value) => value + 1);
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [phase.kind]);

  // ---------- the highlight's heartbeat ----------

  /*
   * Minute granularity, because that is the resolution the schedule is written at – a Session
   * starts at 09:00, not at 09:00:30, so re-evaluating more often would burn battery to produce
   * the same answer. It re-renders only: nothing here fetches. Keeping the *content* fresh is the
   * poll loop's job above, and this tick is what re-reads the corrected clock so the highlight and
   * the staleness age both move on without one.
   */
  useEffect(() => {
    // Offline too: the highlight is the one thing the clock feeds, and a cached Schedule left open
    // through 10:30 must stop calling the keynote current just because nothing can be fetched.
    if (phase.kind !== 'ready' && phase.kind !== 'cached') return;
    const timer = setInterval(() => reevaluateHighlight((value) => value + 1), 60_000);
    return () => clearInterval(timer);
  }, [phase.kind]);

  /*
   * Read on every render rather than memoized. It is integer arithmetic over four scalars, so the
   * memo would cost more than it saved – and a memo is exactly how a highlight comes to be computed
   * from a clock reading taken minutes ago.
   *
   * The **second render input** of S06's `render(envelope, effectiveWallClockNow)`. Offline it comes
   * from the rehydrated clock rather than the live one, and from nowhere else: no branch below
   * renders the Schedule with this absent, null or defaulted, and none reads the raw device clock
   * as "now" (S10 Structural Criteria).
   */
  const rendering = phase.kind === 'ready' || phase.kind === 'cached' ? phase : null;
  const now: WallClockReading | null = rendering?.clock.effectiveWallClockNow() ?? null;

  /*
   * Instant minus instant, corrected for device skew - no timezone is involved and none could be.
   * Recomputed on every render for the same reason the highlight is: a memoized age is an age
   * measured at some earlier render.
   */
  const staleness =
    phase.kind === 'ready'
      ? stalenessFor(phase.schedule.conference.lastUpdatedAt, phase.clock, Date.now())
      : null;

  /*
   * Offline, the age is the difference between two readings of the *same* device clock – now, and
   * the reading taken when the response landed. Any error in that clock cancels, so no timezone and
   * no conversion of the watermark instant is involved. An absolute time is never shown (TI04).
   */
  const cachedLabel =
    phase.kind === 'cached' ? cachedScheduleLabel(phase.deviceClockAtReceipt, Date.now()) : null;

  const activeConference = conferences?.find((entry) => entry.id === conferenceId) ?? null;
  const openDay =
    rendering !== null && now !== null
      ? (selectedDay ?? defaultDay(rendering.schedule, now))
      : null;

  return (
    <section
      className="panel"
      aria-labelledby="attendee-schedule-title"
      data-testid="attendee-panel"
    >
      <div className="panel__header">
        <h2 className="panel__title" id="attendee-schedule-title">
          {activeConference?.name ?? 'Schedule'}
        </h2>
        {activeConference?.state === 'archived' ? (
          <span className="badge badge--archived">Archived</span>
        ) : null}
      </div>

      {/*
       * The list failed, so there is no conference to ask for a schedule for and the schedule
       * failure state below never renders. This branch therefore carries its own retry, or the
       * screen would be an error message with nothing to do about it.
       */}
      {conferencesFailure !== null ? (
        <div className="alert" role="alert" data-testid="attendee-conferences-error">
          {conferencesFailure.message}
          <code className="alert__code">{conferencesFailure.code}</code>
          <p className="panel__actions">
            <button
              className="button button--primary"
              type="button"
              data-testid="attendee-retry"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Try again
            </button>
          </p>
        </div>
      ) : null}

      {/*
       * An empty list means "you have joined nothing" only when the server said so. Offline the
       * list is unknown – all that is known is that nothing was cached – so this sentence is
       * suppressed rather than told to somebody who may well be a member of three conferences.
       */}
      {conferences !== null &&
      conferences.length === 0 &&
      conferencesFailure === null &&
      phase.kind !== 'unavailable-offline' &&
      phase.kind !== 'sign-in-required' ? (
        <p className="panel__hint" data-testid="attendee-no-conferences">
          You have not joined a conference yet. Enter the code the organizer is showing to join one.
        </p>
      ) : null}

      {/*
       * The picker appears only where there is genuinely a choice. Being asked to pick from a list
       * of one is a step that costs an attendee a tap and tells them nothing (TI10).
       */}
      {conferences !== null && conferences.length > 1 ? (
        <p className="attendee-picker">
          <label className="field__label" htmlFor="attendee-conference">
            Conference
          </label>
          <select
            className="field__input"
            id="attendee-conference"
            data-testid="attendee-conference-picker"
            value={conferenceId ?? ''}
            onChange={(event) => setConferenceId(event.target.value)}
          >
            {conferences.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {/* Archived ones stay selectable and are marked, not hidden – FR9. */}
                {entry.state === 'archived' ? `${entry.name} (archived)` : entry.name}
              </option>
            ))}
          </select>
        </p>
      ) : null}

      {conferenceId !== null && phase.kind === 'loading' ? (
        <p className="panel__hint" data-testid="attendee-loading">
          Loading the schedule…
        </p>
      ) : null}

      {/*
       * The failure state. It carries the server's own sentence – a refusal knows which conference
       * and why, and rewording it here would discard exactly that – and a control that re-issues
       * the request. Never a blank screen, a spinner that never ends, or an empty schedule
       * fabricated to fill the space. The cache is consulted first whenever the request was merely
       * unreachable, so reaching this branch means either an answer the cache may not overrule – a
       * 4xx is the server refusing, not the network failing – or an unreachable request with no
       * cached copy to fall back to.
       */}
      {phase.kind === 'failed' ? (
        <div className="alert" role="alert" data-testid="attendee-schedule-error">
          {phase.failure.message}
          <code className="alert__code">{phase.failure.code}</code>
          <p className="panel__actions">
            <button
              className="button button--primary"
              type="button"
              data-testid="attendee-retry"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Try again
            </button>
          </p>
        </div>
      ) : null}

      {/*
       * A Conference that was never read on this device, opened with no connection. A terminal
       * state: the attempt has resolved, there is no spinner left behind it, and it says the one
       * thing that resolves the situation rather than reporting a network error somebody standing
       * in a corridor can do nothing with (TI05).
       */}
      {phase.kind === 'unavailable-offline' ? (
        <div className="notice" role="status" data-testid="schedule-unavailable-offline">
          <p>
            This conference is not available offline. Open it once while you have a connection and
            it will be readable without one afterwards.
          </p>
          <p className="panel__actions">
            <button
              className="button button--primary"
              type="button"
              data-testid="attendee-retry"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Try again
            </button>
          </p>
        </div>
      ) : null}

      {/*
       * On the device, and past the window its Conference bounds it by – a different situation from
       * the notice above and a different sentence, in its own component so that its connectivity
       * subscription does not re-render this one mid-poll.
       */}
      {phase.kind === 'sign-in-required' ? <SignInRequiredNotice /> : null}

      {/*
       * A Schedule with no day to open. `usable` refuses such an entry on the way out of the cache,
       * but the same envelope can arrive live – `apiRequest` casts the response body without
       * validating it – and then every branch below is skipped while `ready` also suppresses the
       * loading hint and the failure state, leaving a heading over nothing. OC03 rules out a blank
       * screen whatever produced it, so this is the terminating outcome for that shape rather than
       * a second validation layer: the server derives days from a 1–4 day span and should never
       * send one, and if it does the attendee is told, not shown an empty panel.
       */}
      {rendering !== null && now !== null && (openDay === undefined || openDay === null) ? (
        <div className="alert" role="alert" data-testid="attendee-schedule-empty">
          This conference has no schedule days to show yet.
          <p className="panel__actions">
            <button
              className="button button--primary"
              type="button"
              data-testid="attendee-retry"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Try again
            </button>
          </p>
        </div>
      ) : null}

      {rendering !== null && now !== null && openDay !== undefined && openDay !== null ? (
        <>
          {/*
           * An elapsed age, never a clock time (S09 → Constraints & Gotchas). It keeps counting up
           * through a failed refresh, which is what tells an attendee in a dead spot that the
           * screen has stopped being current - the one thing a silently stale schedule cannot say.
           */}
          {staleness !== null ? (
            <p className="schedule__staleness" role="status" data-testid="schedule-staleness">
              {staleness}
            </p>
          ) : null}

          {/*
           * The cached statement. Shown however old the entry is: a three-day-old Schedule is
           * labelled with its age, never hidden, blanked or replaced by a "too old" refusal (OC03).
           */}
          {cachedLabel !== null ? (
            <p
              className="schedule__staleness schedule__staleness--cached"
              role="status"
              data-testid="schedule-cached-label"
            >
              {cachedLabel}
            </p>
          ) : null}

          {reconnected !== null ? (
            <ReconnectSummary diff={reconnected} onDismiss={() => setReconnected(null)} />
          ) : null}

          {changes !== null ? (
            <ScheduleChangeBanner diff={changes} onDismiss={() => setChanges(null)} />
          ) : null}

          <ScheduleView
            schedule={rendering.schedule}
            now={now}
            selectedDay={openDay}
            onSelectDay={setSelectedDay}
          />
        </>
      ) : null}

      {/*
       * Leaving sits at the foot of the conference it is about, after the schedule rather than
       * beside the picker: it is the least likely thing an attendee came here to do, and putting a
       * destructive action next to the control they use to switch conferences is how the wrong one
       * gets tapped. It appears only where there is a membership to end.
       */}
      {activeConference !== null ? (
        <LeaveConferenceControl
          conferenceId={activeConference.id}
          conferenceName={activeConference.name}
          archived={activeConference.state === 'archived'}
          onLeft={handleLeft}
        />
      ) : null}
    </section>
  );
}
