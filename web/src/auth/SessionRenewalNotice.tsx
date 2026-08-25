import { useOnline } from '../offline/use-online.ts';

/**
 * A silent renewal Google refused for a reason that did **not** end the session – the Workspace
 * session lapsed rather than the account losing access.
 *
 * Everything already on the device stays readable, which is the whole point of not clearing, so
 * this is a banner over a working app rather than a screen replacing it (Acceptance Scenario S05).
 *
 * **Its own component so the connectivity subscription is local to it.** `useOnline` re-renders its
 * holder on every link change, and the shell holds the attendee panel, which discards an in-flight
 * poll whose render identity moved. Held here, the re-render reaches this banner and nothing else.
 */
export function SessionRenewalNotice({
  code,
  message,
  onSignIn,
}: {
  code: string;
  message: string;
  onSignIn: () => void;
}): React.JSX.Element {
  const online = useOnline();

  return (
    <div className="panel alert" role="alert" data-testid="session-renewal-failed">
      {message}
      <code className="alert__code">{code}</code>
      <p className="panel__actions">
        {/* Signing in is a top-level trip to Google; offering it with no connection is a dead end. */}
        <button
          className="button button--primary"
          type="button"
          data-testid="session-sign-in-again"
          disabled={!online}
          onClick={onSignIn}
        >
          Sign in again
        </button>
      </p>
    </div>
  );
}
