import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  createSession,
  deleteSession,
  fetchOrganizerSchedule,
  updateSession,
  type OrganizerSchedule,
  type OverlapWarning,
  type Session,
  type LifecycleState,
  type SessionDetailsInput,
  type WriteBase,
} from '../api/client.ts';
import { SessionForm } from './SessionForm.tsx';
import { dayLabel, formatTimeRange } from './wall-clock-time.ts';

/**
 * The Organizer's schedule composition view.
 *
 * Day navigation across the Conference span, the Sessions of the selected day in start-time order,
 * and add / edit / delete against the server's rules. Three things about it are load-bearing:
 *
 *   - **Ordering is the server's**, derived from start time (FR2). Nothing here sorts or
 *     repositions; the payload arrives ordered and is rendered in the order it arrives.
 *   - **Every Conference Day is offered**, including one with no Sessions, because a day the
 *     Organizer has not composed yet is exactly the day they need to find.
 *   - **The overlap indicator is driven by the payload**, not by the last save. It is recomputed
 *     server-side on every read, so it is on both Sessions of a pair after a plain reload by
 *     somebody who never saved anything – which is what the pre-publish "review overlap warnings"
 *     step depends on.
 *
 * Times are rendered as the strings they arrived as. Nothing here constructs a `Date`.
 */

export interface SchedulePanelProps {
  /**
   * The Conference's lifecycle state, as its owner currently holds it.
   *
   * Passed in rather than read from this panel's own fetched schedule, because that copy is loaded
   * once and refreshed only after a *session* save - so publishing from the detail panel above left
   * this one still believing 'draft', and the very next edit was refused as a lifecycle race that
   * had not happened. A solo Admin was told a colleague changed the conference under them.
   */
  lifecycleState: LifecycleState;
  conferenceId: string;
  /** Archived Conferences stay readable but accept no writes (FR9), so the actions are withheld. */
  readOnly: boolean;
}

type Loading = { kind: 'loading' };
type Failed = { kind: 'failed'; code: string; message: string };
type Ready = { kind: 'ready'; schedule: OrganizerSchedule };
type State = Loading | Failed | Ready;

type Editor = { open: false } | { open: true; editing: Session | null };

function messageOf(error: unknown): { code: string; message: string } {
  return error instanceof ApiError
    ? { code: error.code, message: error.message }
    : {
        code: 'NETWORK_UNREACHABLE',
        message: 'The app could not reach the server. Check your connection and try again.',
      };
}

/**
 * Is this the current Session representation a version conflict carries?
 *
 * Checked rather than cast: the payload arrives from the network, and a conflict whose body was not
 * what this expects must degrade to the plain refusal message rather than render `undefined` at the
 * organizer.
 */
function isSession(value: unknown): value is Session {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.title === 'string' &&
    typeof candidate.lastUpdatedAt === 'string'
  );
}

function asApiError(error: unknown): ApiError {
  return error instanceof ApiError
    ? error
    : new ApiError('NETWORK_UNREACHABLE', messageOf(error).message);
}

export function SchedulePanel({
  conferenceId,
  readOnly,
  lifecycleState,
}: SchedulePanelProps): React.JSX.Element {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor>({ open: false });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ApiError | null>(null);
  const [warning, setWarning] = useState<OverlapWarning | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  /**
   * The session as the server holds it now, after somebody else saved first (S09 TI10).
   *
   * Held beside the editor rather than replacing it: the admin's typed values stay in the form and
   * these are shown next to them, so re-applying the edit is a decision rather than a retype. It is
   * also the base the next save carries - which is what makes that second save succeed.
   */
  const [conflict, setConflict] = useState<Session | null>(null);
  /**
   * The Conference's lifecycle state as the *server* last reported it, after refusing a write for
   * having moved on.
   *
   * Null almost always: the `lifecycleState` prop is the parent's Conference and is normally the
   * fresher of the two. This exists for the one case the prop cannot cover - somebody else publishes
   * or archives while this panel is open. The prop will not move, because nothing on this page
   * learned about it, so without this the next save carries the same stale state and is refused for
   * the same reason, forever. Cleared whenever the prop does move, since the parent then holds a
   * newer read than this does.
   */
  const [observedState, setObservedState] = useState<LifecycleState | null>(null);

  /**
   * Re-reads the composition view.
   *
   * `keepOnFailure` is for the re-reads that are an *extra* rather than the panel's own load - the
   * recovery after a lifecycle refusal. Letting one of those replace the panel with an error box
   * would unmount the open editor, taking the admin's typed values and the refusal explaining what
   * happened with it: a network blip at exactly the wrong moment would turn a recoverable refusal
   * into silent data loss. The refusal already on screen is the useful thing; a failed extra read
   * simply leaves the base un-advanced, and the next save is refused the same way rather than
   * wrongly.
   */
  const load = useCallback(
    async (signal?: AbortSignal, keepOnFailure = false): Promise<OrganizerSchedule | null> => {
      try {
        const schedule = await fetchOrganizerSchedule(conferenceId, signal);
        setState({ kind: 'ready', schedule });
        return schedule;
      } catch (error) {
        if (signal?.aborted) return null;
        if (!keepOnFailure) setState({ kind: 'failed', ...messageOf(error) });
        return null;
      }
    },
    [conferenceId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const schedule = state.kind === 'ready' ? state.schedule : null;
  const days = useMemo(() => schedule?.days.map((entry) => entry.day) ?? [], [schedule]);

  const activeDay = selectedDay !== null && days.includes(selectedDay) ? selectedDay : days[0];
  const activeSessions = schedule?.days.find((entry) => entry.day === activeDay)?.sessions ?? [];

  /**
   * Every Session that is part of at least one overlapping pair. Derived from the payload's pairs
   * rather than recomputed here – one definition of "overlapping", on the server, where the rule
   * that touching boundaries do not count is also written down.
   */
  const overlapping = useMemo(() => {
    const ids = new Set<string>();
    for (const pair of schedule?.overlaps ?? []) for (const id of pair.sessionIds) ids.add(id);
    return ids;
  }, [schedule]);

  /** Which Sessions a given one runs alongside, so the indicator can name them. */
  const partnersOf = useCallback(
    (sessionId: string): string[] => {
      const partnerIds = (schedule?.overlaps ?? [])
        .filter((pair) => pair.sessionIds.includes(sessionId))
        .map((pair) => pair.sessionIds.find((id) => id !== sessionId));

      return (schedule?.days ?? [])
        .flatMap((entry) => entry.sessions)
        .filter((session) => partnerIds.includes(session.id))
        .map((session) => session.title);
    },
    [schedule],
  );

  /**
   * The base a write carries: the row version it was loaded with, and the conference's lifecycle
   * state at that moment (S09 TI04, TI05).
   *
   * After a conflict the base comes from the version the server handed back, not from the one the
   * form was opened with - that is precisely what "re-apply onto the newer version" means, and
   * without it the second save would be refused exactly like the first.
   *
   * The lifecycle half is the prop, unless a refusal has told this panel otherwise more recently.
   * The prop is the parent's copy of the Conference and nothing here can change it, so an editor
   * caught by a colleague's publish would resend the state they loaded with on every retry and be
   * refused identically until they reloaded the page. `observedState` is what the server said when
   * that refusal was re-read, and it is dropped the moment the parent learns something newer.
   */
  const baseFor = useCallback(
    (session: Session): WriteBase => ({
      conferenceState: observedState ?? lifecycleState,
      version: conflict?.id === session.id ? conflict.lastUpdatedAt : session.lastUpdatedAt,
    }),
    [lifecycleState, observedState, conflict],
  );

  /*
   * A lifecycle transition changes what this panel may offer and what the server will accept, so the
   * composition view is re-read when it happens rather than left showing the pre-transition schedule.
   */
  useEffect(() => {
    if (state.kind !== 'ready') return;
    // The parent has just read the Conference, so whatever this panel observed from a refusal is
    // now the older of the two.
    setObservedState(null);
    void load();
    // `load` is stable per conference; the transition is what this effect exists to react to.
  }, [lifecycleState]);

  const submit = useCallback(
    async (details: SessionDetailsInput): Promise<void> => {
      if (!editor.open) return;
      setSaving(true);
      setSaveError(null);
      setRefusal(null);
      try {
        const saved =
          editor.editing === null
            ? await createSession(conferenceId, details)
            : await updateSession(
                conferenceId,
                editor.editing.id,
                details,
                baseFor(editor.editing),
              );

        // Non-blocking: the save already happened. Parallel tracks are supported, so this names
        // what the session now runs alongside rather than asking for anything to be changed.
        setWarning(saved.overlapWarning);
        setEditor({ open: false });
        setConflict(null);
        setSelectedDay(saved.session.day);
        await load();
      } catch (error) {
        const refused = asApiError(error);

        /*
         * A version conflict is the one refusal that comes with something to act on. The editor
         * stays open with the admin's values, the server's current version is shown beside them,
         * and the next save carries that version as its base - the recovery path the PRD's
         * edge-case table asks for, rather than "reload and start again".
         */
        if (refused.code === 'EDIT_VERSION_CONFLICT' && isSession(refused.current)) {
          setConflict(refused.current);
        }

        /*
         * A lifecycle transition by somebody else is the other refusal with a way forward, and the
         * way forward is a re-read: the composition payload carries the Conference's current state,
         * which is what the next save must be based on. Without this the editor stays open with the
         * state they loaded with, every retry is refused for the same reason, and the only exit is
         * reloading the page - the dead end the Conference path already closes its own way, by
         * being handed the newer Conference to lift.
         */
        if (refused.code === 'CONFERENCE_STATE_CHANGED') {
          const reloaded = await load(undefined, true);
          if (reloaded !== null) setObservedState(reloaded.conference.lifecycleState);
        }

        // Held as the ApiError so the form can attach each field message to its own control.
        setSaveError(refused);
      } finally {
        setSaving(false);
      }
    },
    [conferenceId, editor, load, baseFor],
  );

  const remove = useCallback(
    async (session: Session): Promise<void> => {
      setRefusal(null);
      setWarning(null);
      try {
        await deleteSession(conferenceId, session.id, baseFor(session));
        await load();
      } catch (error) {
        const refused = asApiError(error);
        // The server's sentence, verbatim – it is the only thing that explains what to do next.
        setRefusal(refused.message);
        // A delete races a publish exactly as an edit does, and recovers the same way.
        if (refused.code === 'CONFERENCE_STATE_CHANGED') {
          const reloaded = await load(undefined, true);
          if (reloaded !== null) setObservedState(reloaded.conference.lifecycleState);
        }
      }
    },
    [conferenceId, load, baseFor],
  );

  return (
    <section className="panel schedule" aria-labelledby="schedule-title" data-testid="schedule">
      <div className="panel__header">
        <h2 className="panel__title" id="schedule-title">
          Schedule
        </h2>
        {schedule !== null && overlapping.size > 0 ? (
          <span className="badge badge--overlap" data-testid="overlap-summary">
            {schedule.overlaps.length} parallel{' '}
            {schedule.overlaps.length === 1 ? 'track' : 'tracks'}
          </span>
        ) : null}
      </div>

      {state.kind === 'loading' ? <p className="panel__hint">Loading the schedule…</p> : null}

      {state.kind === 'failed' ? (
        <div className="alert" role="alert" data-testid="schedule-error">
          {state.message}
          <code className="alert__code">{state.code}</code>
        </div>
      ) : null}

      {schedule !== null ? (
        <>
          {/* Day navigation across the whole span – every day, composed or not. */}
          <nav className="schedule__days" aria-label="Conference days" data-testid="day-nav">
            {days.map((day, index) => (
              <button
                key={day}
                className={`schedule__day${day === activeDay ? ' schedule__day--current' : ''}`}
                type="button"
                aria-current={day === activeDay ? 'true' : undefined}
                data-testid={`day-${day}`}
                onClick={() => {
                  setSelectedDay(day);
                  setEditor({ open: false });
                }}
              >
                {dayLabel(day, index)}
              </button>
            ))}
          </nav>

          {warning !== null ? (
            /*
             * `status`, not `alert`: the save succeeded and nothing is wrong. A parallel track is a
             * supported option, so this is information, not an error to be dismissed before
             * continuing.
             */
            <div className="notice" role="status" data-testid="overlap-warning">
              {warning.message}
            </div>
          ) : null}

          {refusal !== null ? (
            <div className="alert" role="alert" data-testid="schedule-refusal">
              {refusal}
            </div>
          ) : null}

          {activeSessions.length === 0 ? (
            <p className="panel__hint" data-testid="empty-day">
              Nothing is scheduled on {activeDay} yet.
              {readOnly ? '' : ' Add the first session below.'}
            </p>
          ) : (
            <ol className="session-list" data-testid="session-list">
              {activeSessions.map((session) => {
                const partners = overlapping.has(session.id) ? partnersOf(session.id) : [];
                return (
                  <li
                    key={session.id}
                    className={`session-card${partners.length > 0 ? ' session-card--overlapping' : ''}`}
                    data-testid={`session-${session.id}`}
                    data-overlapping={partners.length > 0 ? 'true' : 'false'}
                  >
                    <div className="session-card__when">
                      <span className="session-card__time">
                        {formatTimeRange(session.startTime, session.endTime)}
                      </span>
                      <span className={`badge badge--${session.kind.toLowerCase()}`}>
                        {session.kind}
                      </span>
                    </div>

                    <div className="session-card__what">
                      <h3 className="session-card__title">{session.title}</h3>
                      <p className="session-card__location">{session.location}</p>
                      {session.description !== null ? (
                        <p className="session-card__description">{session.description}</p>
                      ) : null}

                      {/*
                       * The persistent indicator. It is rendered from the payload on every read, so
                       * it is here after a plain reload by someone who saved nothing — a save-time
                       * toast alone would not survive that, and FR2 asks for exactly this.
                       */}
                      {partners.length > 0 ? (
                        <p className="session-card__overlap" data-testid={`overlap-${session.id}`}>
                          <span aria-hidden="true">⇄ </span>
                          Parallel track — runs at the same time as {partners.join(', ')}.
                        </p>
                      ) : null}
                    </div>

                    {readOnly ? null : (
                      <div className="session-card__actions">
                        <button
                          className="button"
                          type="button"
                          data-testid={`edit-${session.id}`}
                          onClick={() => {
                            setEditor({ open: true, editing: session });
                            setSaveError(null);
                          }}
                        >
                          Edit
                        </button>
                        <button
                          className="button"
                          type="button"
                          data-testid={`delete-${session.id}`}
                          onClick={() => void remove(session)}
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          )}

          {/*
           * What the server holds now, beside what the admin typed. Both are on screen at once on
           * purpose: the edit is re-applied by choice, and a notice that simply said "somebody
           * else changed this" would leave the newer values to be hunted for in the list.
           */}
          {conflict !== null && editor.open ? (
            <div className="edit-conflict" role="status" data-testid="session-conflict">
              <p className="edit-conflict__current">
                <strong>{conflict.title}</strong> now runs {conflict.startTime}–{conflict.endTime}
                {' on '}
                {conflict.day} in {conflict.location}. Your changes are still below – save again to
                apply them on top of this version.
              </p>
              <p className="edit-conflict__actions">
                <button
                  className="button button--quiet"
                  type="button"
                  data-testid="session-conflict-discard"
                  onClick={() => {
                    setConflict(null);
                    setEditor({ open: false });
                    setSaveError(null);
                  }}
                >
                  Discard my changes
                </button>
              </p>
            </div>
          ) : null}

          {readOnly || activeDay === undefined ? null : editor.open ? (
            <SessionForm
              days={days}
              editing={editor.editing}
              initialDay={activeDay}
              onSubmit={submit}
              onCancel={() => {
                setEditor({ open: false });
                setSaveError(null);
                setConflict(null);
              }}
              busy={saving}
              error={saveError}
            />
          ) : (
            <p className="panel__actions">
              <button
                className="button button--primary"
                type="button"
                data-testid="add-session"
                onClick={() => {
                  setEditor({ open: true, editing: null });
                  setSaveError(null);
                  setWarning(null);
                  setConflict(null);
                }}
              >
                Add a session
              </button>
            </p>
          )}
        </>
      ) : null}
    </section>
  );
}
