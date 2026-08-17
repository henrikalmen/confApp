import { useAuth } from '../auth/AuthProvider.tsx';

/**
 * The signed-out screen.
 *
 * One primary action and nothing else to get wrong. It has to be legible and one-handed at
 * 375px – this is the first thing a hundred people see simultaneously at the start of a
 * conference, most of them holding a phone.
 */
export function SignInScreen(): React.JSX.Element {
  const { state, signIn } = useAuth();

  const error = state.kind === 'signed-out' ? state.error : undefined;
  const busy = state.kind === 'signing-in';

  return (
    <section className="panel signin" aria-labelledby="signin-title">
      <h2 className="panel__title" id="signin-title">
        Sign in to confApp
      </h2>

      <p className="panel__hint">
        confApp is an internal application. Sign in with your company Google account to see the
        conference schedule and take part.
      </p>

      {error ? (
        <div className="alert" role="alert">
          {error.message}
          <code className="alert__code">{error.code}</code>
        </div>
      ) : null}

      <p className="panel__actions">
        <button
          className="button button--primary"
          type="button"
          onClick={signIn}
          disabled={busy}
          data-testid="sign-in"
        >
          {busy ? 'Taking you to Google…' : 'Sign in with Google'}
        </button>
      </p>

      <p className="signin__note">
        You will be taken to Google to sign in, then brought back here.
      </p>
    </section>
  );
}
