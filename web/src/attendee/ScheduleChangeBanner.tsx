import type { ScheduleDiff } from './schedule-diff.ts';
import { changeLines } from './schedule-change-lines.ts';

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

export function ScheduleChangeBanner({
  diff,
  onDismiss,
}: ScheduleChangeBannerProps): React.JSX.Element {
  const lines = changeLines(diff);

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
