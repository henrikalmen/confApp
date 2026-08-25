import { useOnline } from './use-online.ts';
import { requestSignIn } from '../auth/session-actions.ts';

/**
 * What is shown when a cached Schedule is on the device but past the window its Conference bounds
 * it by.
 *
 * **A different sentence from "not available offline", because it is a different situation.** The
 * schedule is here; what has run out is the sign-in it was read under, and no amount of finding a
 * connection changes that on its own. Offering "try again" would be offering something that cannot
 * work (OC04).
 *
 * **Its own component so that the connectivity subscription is its own.** `useOnline` re-renders
 * whatever holds it every time the browser reports the link changing – and the `online` event is
 * also what prompts the attendee panel's poll. Holding the hook in the panel meant the poll's own
 * prompt re-rendered the panel underneath it, and the panel discards a poll whose render identity
 * moved while it was in flight. Down here the re-render stays local to a notice with nothing in
 * flight.
 */
export function SignInRequiredNotice(): React.JSX.Element {
  const online = useOnline();

  return (
    <div className="notice" role="status" data-testid="schedule-sign-in-required">
      <p>
        Your sign-in has expired, so this conference&rsquo;s saved schedule can no longer be shown.
        Sign in again to read it.
      </p>
      <p className="panel__actions">
        {/*
         * Shown and disabled, on the same `useOnline` seam `LeaveConferenceControl` and
         * `JoinConferencePanel` use. Enabled, it would navigate to Google and fail – which is
         * precisely the defect this feature exists to remove, reintroduced through a button (TI10).
         */}
        <button
          className="button button--primary"
          type="button"
          data-testid="attendee-sign-in-again"
          disabled={!online}
          onClick={() => requestSignIn()}
        >
          Sign in again
        </button>
      </p>
      {!online ? (
        <p className="panel__hint" data-testid="attendee-sign-in-offline-hint">
          Signing in needs a connection. Reconnect and this will become available.
        </p>
      ) : null}
    </div>
  );
}
