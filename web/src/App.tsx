import { useState } from 'react';
import { useOnline } from './offline/use-online.ts';
import { HealthPanel } from './components/HealthPanel.tsx';
import { ConferencesPanel } from './components/ConferencesPanel.tsx';
import { JoinConferencePanel } from './components/JoinConferencePanel.tsx';
import { SignInScreen } from './components/SignInScreen.tsx';
import { AttendeeSchedulePanel } from './attendee/AttendeeSchedulePanel.tsx';
import { useAuth } from './auth/AuthProvider.tsx';
import { SessionRenewalNotice } from './auth/SessionRenewalNotice.tsx';

/**
 * The app shell.
 *
 * Signed out, there is one thing to do. Signed in, the person's identity and the way out are
 * both in the header, reachable one-handed at 375px – a shared tablet at a conference makes
 * "how do I sign out" a real question, not a settings-screen afterthought.
 */
/** Shown when the switch control is used with no connection – see `switchAccount`. */
const SWITCH_NEEDS_CONNECTION = 'You need a connection to sign in as someone else.';

export function App(): React.JSX.Element {
  const [navOpen, setNavOpen] = useState(false);
  const { state, signIn, signOut } = useAuth();
  const online = useOnline();
  const [switchRefused, setSwitchRefused] = useState<string | null>(null);

  const signedIn = state.kind === 'signed-in';

  /**
   * Hand the device to somebody else: an ordinary sign-out followed by an ordinary sign-in.
   *
   * Deliberately not a new teardown path – it goes through the same `signOut` the control beside it
   * uses, so the same S10 purge fires and the next identity starts on a clean device.
   *
   * **Offline it refuses instead, and the existing session is left alone.** Signing out with no
   * connection would clear the session and then fail to reach Google for the replacement, leaving
   * the device with neither a session nor a way to get one – and taking the cached schedule the
   * previous person was reading with it. `useOnline` is a link hint rather than proof of
   * reachability, which is exactly the right strength here: this is a mutating affordance that is
   * *certain* to fail without a link, which is one of the two things that hint is for.
   */
  const switchAccount = (): void => {
    if (!online) {
      setSwitchRefused(SWITCH_NEEDS_CONNECTION);
      return;
    }
    setSwitchRefused(null);
    signOut();
    signIn();
  };
  /** A silent renewal Google refused without ending the session – see `SessionRenewalNotice`. */
  const renewalFailed = state.kind === 'signed-in' ? (state.renewalFailed ?? null) : null;

  return (
    <div className="app">
      <header className="app__header">
        <div>
          <h1 className="app__brand">confApp</h1>
          <p className="app__tagline">Conference schedule and participation</p>
        </div>

        <div className="app__header-actions">
          {signedIn ? (
            <div className="identity" data-testid="signed-in-identity">
              <span className="identity__name">{state.user.displayName}</span>
              <span className="identity__email">{state.user.email}</span>
            </div>
          ) : null}

          {signedIn ? (
            <button
              className="button"
              type="button"
              onClick={switchAccount}
              data-testid="switch-account"
            >
              Not you?
            </button>
          ) : null}

          {signedIn ? (
            <button className="button" type="button" onClick={signOut} data-testid="sign-out">
              Sign out
            </button>
          ) : null}

          <button
            className="app__nav-toggle"
            type="button"
            aria-expanded={navOpen}
            aria-controls="app-nav"
            onClick={() => setNavOpen((open) => !open)}
          >
            <span aria-hidden="true">☰</span> Menu
          </button>
        </div>
      </header>

      {/*
       * Outside the header's action row rather than inside it: the row is a wrapping flex line at
       * 375px, and a sentence dropped into it competes with the controls for the same track.
       * Still outside anything `switchAccount` unmounts, which is the property that matters – the
       * refusal is only ever raised on the path that leaves the session, and the app, in place.
       */}
      {signedIn && switchRefused !== null ? (
        <div className="panel alert" role="alert" data-testid="switch-account-refused">
          {switchRefused}
        </div>
      ) : null}

      {navOpen ? (
        <nav className="app__nav" id="app-nav" aria-label="Main">
          <ul className="app__nav-list">
            {signedIn ? (
              <>
                <li>
                  <a href="#attendee-schedule-title">Schedule</a>
                </li>
                <li>
                  <a href="#conferences-title">Your conferences</a>
                </li>
              </>
            ) : null}
            <li>
              <a href="#health-title">Service health</a>
            </li>
          </ul>
        </nav>
      ) : null}

      <main className="app__main">
        {state.kind === 'starting' ? (
          <p className="panel panel__hint">Checking your sign-in…</p>
        ) : state.kind === 'unconfigured' ? (
          <div className="panel alert" role="alert">
            {state.message}
          </div>
        ) : signedIn ? (
          <>
            {renewalFailed !== null ? (
              <SessionRenewalNotice
                code={renewalFailed.code}
                message={renewalFailed.message}
                onSignIn={signIn}
              />
            ) : null}
            {/*
             * The attendee's home comes first. Nearly everyone signing in is here to read the
             * schedule of the conference they are standing in, and the organizer surfaces below are
             * for the few who are also running one (FR4).
             */}
            <AttendeeSchedulePanel />
            <ConferencesPanel />
            {/*
             * Joining is available to every signed-in employee, organizer or not – there is nothing
             * to pre-provision and no list to be on (FR3).
             */}
            <JoinConferencePanel />
            <HealthPanel />
          </>
        ) : (
          <SignInScreen />
        )}
      </main>

      <footer className="app__footer">Internal application – employees only.</footer>
    </div>
  );
}
