import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  fetchAttendeeSchedule,
  fetchMyConferences,
  type AttendeeConference,
  type AttendeeSchedule,
} from '../api/client.ts';
import {
  clockFromSync,
  type EffectiveClock,
  type WallClockReading,
} from '../clock/effective-clock.ts';
import { ScheduleView } from './ScheduleView.tsx';
import { defaultDay } from './schedule-view-model.ts';

/**
 * The Attendee's home: the conference picker, the Schedule, and every non-result state.
 *
 * This component is the **view boundary** – the one place in the attendee surface that fetches,
 * reads the device clock and holds a timer. Everything below it (`ScheduleView` and the view model)
 * is a pure function of `(envelope, now)`. The split is not tidiness: S10 must be able to hand that
 * same tree a cached envelope with no network available, and a tree that fetched anywhere inside
 * itself could not be handed anything.
 *
 * What this story deliberately does **not** do: consult a cache, poll, or refresh on change. The
 * Schedule is fetched when the view opens, when the conference changes, and on an explicit retry.
 * Caching and staleness are S10's; near-live propagation is S09's; `lastUpdatedAt` is carried in the
 * envelope and acted on by neither of them here.
 */

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

  // ---------- the schedule itself ----------

  useEffect(() => {
    if (conferenceId === null) return;

    const controller = new AbortController();
    setPhase({ kind: 'loading' });

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

  // ---------- the highlight's heartbeat ----------

  /*
   * Minute granularity, because that is the resolution the schedule is written at – a Session
   * starts at 09:00, not at 09:00:30, so re-evaluating more often would burn battery to produce
   * the same answer. It re-evaluates the highlight only: nothing here re-fetches, which is
   * deliberate, because keeping the *content* fresh is S09's job and doing it here would duplicate
   * it.
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
        <ScheduleView
          schedule={phase.schedule}
          now={now}
          selectedDay={openDay}
          onSelectDay={setSelectedDay}
        />
      ) : null}
    </section>
  );
}
