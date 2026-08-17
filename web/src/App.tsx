import { useState } from 'react';
import { HealthPanel } from './components/HealthPanel.tsx';
import { ConferencesPanel } from './components/ConferencesPanel.tsx';
import { JoinConferencePanel } from './components/JoinConferencePanel.tsx';
import { SignInScreen } from './components/SignInScreen.tsx';
import { useAuth } from './auth/AuthProvider.tsx';

/**
 * The app shell.
 *
 * Signed out, there is one thing to do. Signed in, the person's identity and the way out are
 * both in the header, reachable one-handed at 375px – a shared tablet at a conference makes
 * "how do I sign out" a real question, not a settings-screen afterthought.
 */
export function App(): React.JSX.Element {
  const [navOpen, setNavOpen] = useState(false);
  const { state, signOut } = useAuth();

  const signedIn = state.kind === 'signed-in';

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

      {navOpen ? (
        <nav className="app__nav" id="app-nav" aria-label="Main">
          <ul className="app__nav-list">
            {signedIn ? (
              <li>
                <a href="#conferences-title">Your conferences</a>
              </li>
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
            <ConferencesPanel />
            {/*
             * Joining is available to every signed-in employee, organizer or not – there is nothing
             * to pre-provision and no list to be on (FR3). It sits after the organizer surfaces
             * because the shell is still one page: S06 owns the attendee's home and the navigation
             * that will give each audience its own view.
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
