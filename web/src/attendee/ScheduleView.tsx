import type { AttendeeSchedule } from '../api/client.ts';
import type { WallClockReading } from '../clock/effective-clock.ts';
import { concurrentTitles, dayLabel, runningSessionIds, timeRange } from './schedule-view-model.ts';

/**
 * The Attendee's Schedule, as a pure projection of `(envelope, now)`.
 *
 * Nothing below this component fetches, reads a clock, or needs a connection. Both inputs arrive as
 * props and every derived fact comes from `schedule-view-model.ts`, which is what makes the tree
 * renderable from a cached envelope with the network unavailable – the property S10 is built on and
 * cannot add later without rewriting this file.
 *
 * Times are rendered as the strings they arrived as. The clock is an input to the *highlight* only;
 * it never reaches a formatter that renders a Session time, which is the whole reason a device
 * three hours fast can move the highlight and still cannot move a single displayed time (OC02).
 *
 * **There is nothing here to choose.** No control selects, stars, attends or adds a Session to
 * anything, and rendering this view sends nothing to the server. Sessions are open, attendance is
 * neither chosen nor recorded, and there is no Personal Agenda – so a picker between two concurrent
 * Sessions would contradict the product even though it would look helpful (FR4, FR6,
 * `docs/UBIQUITOUS_LANGUAGE.md`).
 *
 * The one control that does exist – **Activities** (S01) – is not an exception to that. It selects
 * nothing about the Session and records no attendance: it asks the view boundary above to open what
 * the Session is *running*, and the boundary is where the request is made.
 */

export interface ScheduleViewProps {
  schedule: AttendeeSchedule;
  /** The effective wall clock, already corrected for device skew by the clock module. */
  now: WallClockReading;
  selectedDay: string;
  onSelectDay: (day: string) => void;
  /**
   * The Session whose Activities are open, and the way to open one (S01 TI10).
   *
   * Both optional, and both **decided above this component**. The Activities panel itself is
   * rendered at the view boundary, not here: this tree stays a pure projection of
   * `(envelope, now)`, which is the property that lets S10 hand it a cached envelope with no
   * network. Omitting `onOpenActivities` – which the offline branch does – simply means no control
   * is offered, because Rounds are read online and are deliberately not in the cache (FR6).
   */
  openActivitiesFor?: string | null;
  onOpenActivities?: (sessionId: string) => void;
}

export function ScheduleView({
  schedule,
  now,
  selectedDay,
  onSelectDay,
  openActivitiesFor = null,
  onOpenActivities,
}: ScheduleViewProps): React.JSX.Element {
  const running = runningSessionIds(schedule, now);
  const day = schedule.days.find((entry) => entry.date === selectedDay) ?? schedule.days[0];

  return (
    <div className="attendee-schedule" data-testid="attendee-schedule">
      {/* Every Conference Day of the span, composed or not – the empty ones included. */}
      <nav className="schedule__days" aria-label="Conference days" data-testid="attendee-day-nav">
        {schedule.days.map((entry) => (
          <button
            key={entry.date}
            className={`schedule__day${entry.date === day?.date ? ' schedule__day--current' : ''}`}
            type="button"
            aria-current={entry.date === day?.date ? 'true' : undefined}
            data-testid={`attendee-day-${entry.date}`}
            onClick={() => onSelectDay(entry.date)}
          >
            {dayLabel(entry)}
          </button>
        ))}
      </nav>

      {day === undefined || day.sessions.length === 0 ? (
        <p className="panel__hint" data-testid="attendee-empty-day">
          Nothing is scheduled on {day?.date ?? selectedDay}.
        </p>
      ) : (
        <ol className="session-list" data-testid="attendee-session-list">
          {day.sessions.map((session) => {
            const alongside = concurrentTitles(session, day);
            const isRunning = running.has(session.id);

            return (
              <li
                key={session.id}
                className={[
                  'session-card',
                  alongside.length > 0 ? 'session-card--concurrent' : '',
                  isRunning ? 'session-card--running' : '',
                ]
                  .filter((name) => name !== '')
                  .join(' ')}
                data-testid={`attendee-session-${session.id}`}
                data-concurrent={alongside.length > 0 ? 'true' : 'false'}
                data-running={isRunning ? 'true' : 'false'}
              >
                <div className="session-card__when">
                  {/* The authored strings, straight through. */}
                  <span className="session-card__time">{timeRange(session)}</span>
                  <span className={`badge badge--${session.kind.toLowerCase()}`}>
                    {session.kind}
                  </span>
                  {isRunning ? (
                    <span
                      className="badge badge--running"
                      data-testid={`running-${session.id}`}
                      /*
                       * `status`, not `alert`: it is a standing fact about the schedule, not an
                       * event to interrupt someone with. Announced because a screen-reader user
                       * gets no benefit from a colour change.
                       */
                      role="status"
                    >
                      Now
                    </span>
                  ) : null}
                </div>

                <div className="session-card__what">
                  <h3 className="session-card__title">{session.title}</h3>
                  <p className="session-card__location">{session.location}</p>
                  {session.description !== null ? (
                    <p className="session-card__description">{session.description}</p>
                  ) : null}

                  {/*
                   * The one control on this screen, and it chooses nothing about the Session: it
                   * opens what the Session is *running* (FR2). Attendance is still neither chosen
                   * nor recorded, and nothing here is sent to the server.
                   */}
                  {onOpenActivities !== undefined ? (
                    <p className="session-card__activities">
                      <button
                        className="button button--small"
                        type="button"
                        aria-expanded={openActivitiesFor === session.id}
                        data-testid={`attendee-activities-${session.id}`}
                        onClick={() => onOpenActivities(session.id)}
                      >
                        Activities
                      </button>
                    </p>
                  ) : null}

                  {/*
                   * The concurrency marking names the other Sessions rather than only flagging that
                   * there are some – "runs at the same time as something" would leave an attendee
                   * scanning the list to find out what. It is a statement, not an affordance.
                   */}
                  {alongside.length > 0 ? (
                    <p
                      className="session-card__concurrent"
                      data-testid={`concurrent-${session.id}`}
                    >
                      <span aria-hidden="true">⇄ </span>
                      Parallel track – runs at the same time as {alongside.join(', ')}.
                    </p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
