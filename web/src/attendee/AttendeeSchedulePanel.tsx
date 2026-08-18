import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  fetchAttendeeSchedule,
  fetchMyConferences,
  fetchScheduleWatermark,
  type AttendeeConference,
  type AttendeeSchedule,
} from '../api/client.ts';
import {
  clockFromSync,
  type EffectiveClock,
  type WallClockReading,
} from '../clock/effective-clock.ts';
import { ScheduleView } from './ScheduleView.tsx';
import { ScheduleChangeBanner } from './ScheduleChangeBanner.tsx';
import { LeaveConferenceControl } from '../members/LeaveConferenceControl.tsx';
import { defaultDay } from './schedule-view-model.ts';
import { diffSchedule, isEmptyDiff, type ScheduleDiff } from './schedule-diff.ts';
import { stalenessFor } from './staleness.ts';

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

type Phase =
  | { kind: 'loading' }
  | { kind: 'failed'; failure: Failure }
  | { kind: 'ready'; schedule: AttendeeSchedule; clock: EffectiveClock };

export function AttendeeSchedulePanel(): React.JSX.Element {
  const [conferences, setConferences] = useState<AttendeeConference[] | null>(null);
  const [conferencesFailure, setConferencesFailure] = useState<Failure | null>(null);
  const [conferenceId, setConferenceId] = useState<string | null>(null);

  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  /** What the last refresh changed, until the attendee dismisses it. */
  const [changes, setChanges] = useState<ScheduleDiff | null>(null);
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
      // The server's choice, not a re-derivation of the rule. Falls back to the first entry only
      // where the server named none – which is the empty list.
      setConferenceId(body.defaultConferenceId ?? body.conferences[0]?.id ?? null);
    } catch (error) {
      if (signal?.aborted) return;
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
    setConferenceId(null);
    setConferences(null);
    setSelectedDay(null);
    setChanges(null);
    setPhase({ kind: 'loading' });
    setAttempt((value) => value + 1);
  }, []);

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

    void (async () => {
      try {
        const schedule = await fetchAttendeeSchedule(conferenceId, controller.signal);
        /*
         * The device clock, read here and not inside the clock module, because "at receipt" is a
         * fact about this moment – the response has just arrived. Reading it later would fold
         * whatever happened in between into the offset. This is also the value S10 must persist as
         * its "fetched-at": the *device* clock at receipt, never a server timestamp.
         */
        const deviceClockAtReceipt = Date.now();
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
        setPhase({ kind: 'failed', failure: failureOf(error) });
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
  const renderedRef = useRef<AttendeeSchedule | null>(null);
  useEffect(() => {
    renderedRef.current = phase.kind === 'ready' ? phase.schedule : null;
  }, [phase]);

  /** At most one poll in flight; a tick arriving while one is outstanding is skipped, not queued. */
  const pollingRef = useRef(false);

  const syncIfChanged = useCallback(async (): Promise<void> => {
    const rendered = renderedRef.current;
    if (conferenceId === null || rendered === null || pollingRef.current) return;

    pollingRef.current = true;
    try {
      const watermark = await fetchScheduleWatermark(conferenceId);

      /*
       * The whole point of the watermark: an unchanged value costs two scalars and stops here. Only
       * a value that has actually moved is worth the schedule payload.
       */
      if (watermark.lastUpdatedAt === rendered.conference.lastUpdatedAt) return;

      const refreshed = await fetchAttendeeSchedule(conferenceId);
      // The device clock at receipt, read here for the same reason the initial fetch does: "at
      // receipt" is a fact about this moment, and reading it later folds the wait into the offset.
      const deviceClockAtReceipt = Date.now();

      /*
       * The one moment both envelopes are in hand, which is the entire reason "what changed" is
       * derived on the client. The outgoing one is read from the ref before the swap.
       */
      const diff = diffSchedule(rendered, refreshed);

      setPhase({
        kind: 'ready',
        schedule: refreshed,
        clock: clockFromSync(refreshed.serverNow, deviceClockAtReceipt),
      });
      // An unchanged poll never reaches here, so a dismissed banner is not re-raised by one.
      if (!isEmptyDiff(diff)) setChanges(diff);
    } catch {
      /*
       * A failed poll or refetch changes nothing on screen (Acceptance Scenario S07). The last
       * successfully synced Schedule stays exactly as it was, its age keeps counting up, and the
       * next attempt tries again - the PRD's rule that the view as of its last successful sync is
       * the source of truth. Replacing it with an error would take the schedule away from someone
       * standing in a corridor deciding where to go next.
       */
    } finally {
      pollingRef.current = false;
    }
  }, [conferenceId]);

  useEffect(() => {
    if (phase.kind !== 'ready') return;

    /*
     * Nothing is asked of the network while the tab is hidden or the app is backgrounded: a phone
     * in a pocket for an hour must not spend battery on a schedule nobody is reading. Becoming
     * visible or focused refreshes **immediately** rather than waiting for the next tick, because
     * an attendee returning to the app expects current data at once.
     */
    const tick = (): void => {
      if (!document.hidden) void syncIfChanged();
    };

    const timer = setInterval(tick, POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('focus', tick);

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
      window.removeEventListener('focus', tick);
    };
  }, [phase.kind, syncIfChanged]);

  // ---------- the highlight's heartbeat ----------

  /*
   * Minute granularity, because that is the resolution the schedule is written at – a Session
   * starts at 09:00, not at 09:00:30, so re-evaluating more often would burn battery to produce
   * the same answer. It re-renders only: nothing here fetches. Keeping the *content* fresh is the
   * poll loop's job above, and this tick is what re-reads the corrected clock so the highlight and
   * the staleness age both move on without one.
   */
  useEffect(() => {
    if (phase.kind !== 'ready') return;
    const timer = setInterval(() => reevaluateHighlight((value) => value + 1), 60_000);
    return () => clearInterval(timer);
  }, [phase.kind]);

  /*
   * Read on every render rather than memoized. It is integer arithmetic over four scalars, so the
   * memo would cost more than it saved – and a memo is exactly how a highlight comes to be computed
   * from a clock reading taken minutes ago.
   */
  const now: WallClockReading | null =
    phase.kind === 'ready' ? phase.clock.effectiveWallClockNow() : null;

  /*
   * Instant minus instant, corrected for device skew - no timezone is involved and none could be.
   * Recomputed on every render for the same reason the highlight is: a memoized age is an age
   * measured at some earlier render.
   */
  const staleness =
    phase.kind === 'ready'
      ? stalenessFor(phase.schedule.conference.lastUpdatedAt, phase.clock, Date.now())
      : null;

  const activeConference = conferences?.find((entry) => entry.id === conferenceId) ?? null;
  const openDay =
    phase.kind === 'ready' && now !== null
      ? (selectedDay ?? defaultDay(phase.schedule, now))
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

      {conferences !== null && conferences.length === 0 && conferencesFailure === null ? (
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
       * fabricated to fill the space. No cached copy is consulted: caching arrives with S10.
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

      {phase.kind === 'ready' && now !== null && openDay !== undefined && openDay !== null ? (
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

          {changes !== null ? (
            <ScheduleChangeBanner diff={changes} onDismiss={() => setChanges(null)} />
          ) : null}

          <ScheduleView
            schedule={phase.schedule}
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
