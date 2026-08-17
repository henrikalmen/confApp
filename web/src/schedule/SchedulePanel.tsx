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
  type SessionDetailsInput,
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

function asApiError(error: unknown): ApiError {
  return error instanceof ApiError
    ? error
    : new ApiError('NETWORK_UNREACHABLE', messageOf(error).message);
}

export function SchedulePanel({ conferenceId, readOnly }: SchedulePanelProps): React.JSX.Element {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor>({ open: false });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ApiError | null>(null);
  const [warning, setWarning] = useState<OverlapWarning | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal): Promise<OrganizerSchedule | null> => {
      try {
        const schedule = await fetchOrganizerSchedule(conferenceId, signal);
        setState({ kind: 'ready', schedule });
        return schedule;
      } catch (error) {
        if (signal?.aborted) return null;
        setState({ kind: 'failed', ...messageOf(error) });
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
            : await updateSession(conferenceId, editor.editing.id, details);

        // Non-blocking: the save already happened. Parallel tracks are supported, so this names
        // what the session now runs alongside rather than asking for anything to be changed.
        setWarning(saved.overlapWarning);
        setEditor({ open: false });
        setSelectedDay(saved.session.day);
        await load();
      } catch (error) {
        // Held as the ApiError so the form can attach each field message to its own control.
        setSaveError(asApiError(error));
      } finally {
        setSaving(false);
      }
    },
    [conferenceId, editor, load],
  );

  const remove = useCallback(
    async (session: Session): Promise<void> => {
      setRefusal(null);
      setWarning(null);
      try {
        await deleteSession(conferenceId, session.id);
        await load();
      } catch (error) {
        // The server's sentence, verbatim – it is the only thing that explains what to do next.
        setRefusal(asApiError(error).message);
      }
    },
    [conferenceId, load],
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

          {readOnly || activeDay === undefined ? null : editor.open ? (
            <SessionForm
              days={days}
              editing={editor.editing}
              initialDay={activeDay}
              onSubmit={submit}
              onCancel={() => {
                setEditor({ open: false });
                setSaveError(null);
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
