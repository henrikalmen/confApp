import { changeLines } from '../attendee/schedule-change-lines.ts';
import type { ScheduleDiff } from '../attendee/schedule-diff.ts';

/**
 * "While you were offline" – what moved, once the connection came back (S10 TI07).
 *
 * **The compensating channel.** Push fan-out is deferred with REQ-005, and S09's in-app banner by
 * definition cannot reach an attendee whose device was offline while the Schedule moved – there was
 * no open view and no request to notice it with. This is the only surface that tells that person
 * what happened, which is why it names the deletion as plainly as the addition: somebody who was
 * out of signal all morning is exactly the person about to walk to a room that no longer has
 * anything in it.
 *
 * **It derives nothing.** The comparison is `diffSchedule`'s – S09's one envelope diff, applied by
 * the view boundary to the cached envelope and the freshly fetched one – and the wording is
 * `changeLines`', shared with S09's banner. There is no second added/edited/deleted comparison in
 * this story, here or anywhere else.
 */

export interface ReconnectSummaryProps {
  /** Never empty: the view boundary shows nothing at all rather than an empty summary. */
  diff: ScheduleDiff;
  onDismiss: () => void;
}

export function ReconnectSummary({ diff, onDismiss }: ReconnectSummaryProps): React.JSX.Element {
  // Both sides of a time change: this reader was offline while it moved and has the old time
  // written down. S09's banner deliberately does not, and keeps its own shorter sentence.
  const lines = changeLines(diff, true);

  return (
    <div
      className="schedule-changes schedule-changes--reconnect"
      /*
       * `status`, not `alert`: the Schedule on screen is already the current one and this explains
       * how it differs from what the attendee last saw. An `alert` would cut a screen-reader user
       * off mid-sentence to say something they can read at their own pace.
       */
      role="status"
      data-testid="reconnect-summary"
    >
      <div className="schedule-changes__body">
        <p className="schedule-changes__title">While you were offline, the schedule changed</p>
        <ul className="schedule-changes__list">
          {lines.map((line) => (
            <li key={line.key}>{line.text}</li>
          ))}
        </ul>
      </div>

      <button
        className="button button--quiet schedule-changes__dismiss"
        type="button"
        data-testid="reconnect-summary-dismiss"
        onClick={onDismiss}
      >
        Dismiss
      </button>
    </div>
  );
}
