import type { ChangedSession, DatedSession, ScheduleDiff } from './schedule-diff.ts';

/**
 * The in-app change banner (S09 TI03) – what changed, named, after a refresh.
 *
 * **This is the in-app channel, not push.** No device token, notification record or server call is
 * involved anywhere in this path: the banner is presentation over `diffSchedule`'s output, which
 * the view boundary computed from two payloads it already held. Push fan-out is deferred with
 * REQ-005, and an implementation that "helpfully" added it here would be scope drift (S09 → Final
 * Validation Checklist).
 *
 * Presentation only – it derives nothing. Which Sessions changed and which fields moved is the
 * diff's answer, so this component and S10's reconnect summary cannot disagree about the same edit.
 *
 * Times are the strings they arrived as. Nothing here parses or formats one.
 */

export interface ScheduleChangeBannerProps {
  diff: ScheduleDiff;
  onDismiss: () => void;
}

/** "09:30–11:00", from the authored strings. */
function timeRange(session: DatedSession): string {
  return `${session.startTime}–${session.endTime}`;
}

/**
 * What changed about one Session, in the words an attendee reads.
 *
 * Built from the named fields rather than from a generic "was updated", because the reason the
 * banner exists is that a silent swap is the failure: "Opening Keynote was updated" leaves someone
 * comparing the screen against their memory to find out what moved.
 */
function describeChange(change: ChangedSession): string {
  const { session, previous, fields } = change;
  const moved = fields.includes('startTime') || fields.includes('endTime');
  const clauses: string[] = [];

  if (fields.includes('day')) clauses.push(`moved to ${session.day}`);
  if (moved) clauses.push(`now runs ${timeRange(session)}`);
  if (fields.includes('location')) clauses.push(`now in ${session.location}`);
  if (fields.includes('title')) clauses.push(`is now called “${session.title}”`);
  if (fields.includes('kind')) clauses.push(`is now a ${session.kind}`);
  if (fields.includes('description')) clauses.push('has an updated description');

  // The title the attendee last saw, so a renamed Session is recognisable as the one they knew.
  const name = fields.includes('title') ? previous.title : session.title;
  return `${name} ${clauses.join(', ')}.`;
}

export function ScheduleChangeBanner({
  diff,
  onDismiss,
}: ScheduleChangeBannerProps): React.JSX.Element {
  const lines = [
    ...diff.changed.map((change) => ({
      key: `changed-${change.session.id}`,
      text: describeChange(change),
    })),
    ...diff.added.map((session) => ({
      key: `added-${session.id}`,
      text: `${session.title} was added on ${session.day} at ${timeRange(session)}.`,
    })),
    ...diff.removed.map((session) => ({
      key: `removed-${session.id}`,
      text: `${session.title} was removed.`,
    })),
  ];

  return (
    <div
      className="schedule-changes"
      /*
       * `status`, not `alert`: the schedule has already been updated on screen and this reports
       * what happened. An `alert` would interrupt a screen-reader user mid-sentence to tell them
       * something they can read at their own pace.
       */
      role="status"
      data-testid="schedule-change-banner"
    >
      <div className="schedule-changes__body">
        <p className="schedule-changes__title">The schedule changed</p>
        <ul className="schedule-changes__list">
          {lines.map((line) => (
            <li key={line.key}>{line.text}</li>
          ))}
        </ul>
      </div>

      <button
        className="button button--quiet schedule-changes__dismiss"
        type="button"
        data-testid="schedule-change-dismiss"
        onClick={onDismiss}
      >
        Dismiss
      </button>
    </div>
  );
}
