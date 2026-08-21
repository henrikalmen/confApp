import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createAuthSession, type AuthSession, type SessionUser } from './session.ts';
import { setTokenSource } from '../api/client.ts';
import { resolveAuthConfig } from '../config.ts';
import {
  adoptCacheOwner,
  purgeScheduleCache,
  setCacheIdentity,
} from '../offline/schedule-cache.ts';

/**
 * Binds the session to React.
 *
 * The session module is the thing under test; this is the thin layer that renders it. It also
 * wires the credential into the API client once, here, so no component has to remember to
 * attach a token – the same reasoning as `withAuth` on the API side, applied to the browser.
 */

export type AuthState =
  | { kind: 'starting' }
  | { kind: 'unconfigured'; message: string }
  | { kind: 'signed-out'; error?: { code: string; message: string } }
  | { kind: 'signing-in' }
  | { kind: 'signed-in'; user: SessionUser };

interface AuthContextValue {
  state: AuthState;
  signIn(): void;
  signOut(): void;
  session: AuthSession | null;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export interface AuthProviderProps {
  children: React.ReactNode;
  /** Injected by tests; production builds one from runtime configuration. */
  session?: AuthSession;
  /** The redirect query string. Defaults to the live location. */
  initialSearch?: string;
}

export function AuthProvider({
  children,
  session: injected,
  initialSearch,
}: AuthProviderProps): React.JSX.Element {
  const [state, setState] = useState<AuthState>({ kind: 'starting' });

  // Built once. Rebuilding it per render would generate a new PKCE attempt mid-flow.
  const sessionRef = useRef<AuthSession | null>(null);
  const configErrorRef = useRef<string | null>(null);
  if (sessionRef.current === null && configErrorRef.current === null) {
    if (injected !== undefined) {
      sessionRef.current = injected;
    } else {
      try {
        sessionRef.current = createAuthSession({ config: resolveAuthConfig() });
      } catch (error) {
        configErrorRef.current = (error as Error).message;
      }
    }
  }
  const session = sessionRef.current;

  /**
   * A redirect is single-use, so it is processed once per page load and not once per effect
   * run. StrictMode deliberately mounts effects twice in development, and two concurrent
   * `completeRedirect` calls would race for the same one-shot PKCE attempt – the loser reporting
   * "this sign-in did not start in this tab" over a sign-in that had in fact just succeeded.
   * A ref, not state: it must survive the remount that causes the problem.
   */
  const redirectHandled = useRef(false);
  /**
   * Liveness has to be a ref rather than a per-run closure. The redirect is started by the first
   * effect run, and StrictMode's cleanup would clear a run-scoped flag before that one call
   * resolves – leaving the app on "Checking your sign-in…" forever. Set true whenever the effect
   * runs and false on cleanup, this is true again by the time the promise settles after a
   * remount, and stays false after a real unmount.
   */
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;

    if (session === null) {
      setState({
        kind: 'unconfigured',
        message: configErrorRef.current ?? 'Sign-in is not configured.',
      });
      return;
    }

    // The credential source for every authenticated request in the app.
    setTokenSource(() => session.validToken());
    /*
     * And the identity every cached Schedule is keyed under (S10 TI01). The `sub` claim, never the
     * email – emails change and `sub` does not (AGENTS.md). Supplied the same way as the token
     * source, so no panel has to reach for a session to read its own cache.
     */
    setCacheIdentity(() => session.current()?.user.sub ?? null);

    /*
     * **The privacy half of S10, wired to S02's one hook.** Sign-out and a different employee
     * signing in both clear user-scoped device state, and this story registers the schedule cache
     * on that hook rather than building a second auth teardown path (S02 TI10).
     */
    const unsubscribe = session.onSessionCleared(() => {
      void purgeScheduleCache();
    });

    /**
     * The other half of the purge, and the one an event cannot cover.
     *
     * A session that ended because the app was killed never ran the sign-out path, so the previous
     * employee's rows would still be there when the next one signs in. Here the store is asked whose
     * it is and empties itself when the answer is somebody else – driven by the identity presented
     * at sign-in differing, not by a sign-out having happened (S10 TI08).
     */
    const claim = (user: SessionUser): void => {
      void adoptCacheOwner(user.sub);
    };

    // A redirect is single-use, so it is processed once per page load and not once per effect
    // run. Two concurrent `completeRedirect` calls would race for the same one-shot PKCE
    // attempt, the loser reporting "this sign-in did not start in this tab" over a sign-in that
    // had in fact just succeeded.
    if (redirectHandled.current) return unsubscribe;
    redirectHandled.current = true;

    const search = initialSearch ?? (typeof location === 'undefined' ? '' : location.search);

    void session.completeRedirect(search).then((outcome) => {
      if (!mounted.current) return;

      if (outcome.kind === 'signed-in') {
        // Drop the code and state from the address bar: they are single-use and do not belong
        // in history, a bookmark, or a screenshot.
        if (typeof history !== 'undefined' && typeof location !== 'undefined') {
          history.replaceState(null, '', outcome.returnTo || location.pathname);
        }
        claim(outcome.user);
        setState({ kind: 'signed-in', user: outcome.user });
        return;
      }

      if (outcome.kind === 'failed') {
        if (typeof history !== 'undefined' && typeof location !== 'undefined') {
          history.replaceState(null, '', location.pathname);
        }
        setState({
          kind: 'signed-out',
          error: { code: outcome.code, message: outcome.message },
        });
        return;
      }

      const existing = session.current();
      // A session restored from storage on a cold launch claims the store too – that launch is
      // exactly the case where the previous session ended without a sign-out.
      if (existing !== null) claim(existing.user);
      setState(
        existing === null ? { kind: 'signed-out' } : { kind: 'signed-in', user: existing.user },
      );
    });

    return () => {
      mounted.current = false;
      unsubscribe();
    };
  }, [session, initialSearch]);

  const signIn = useCallback(() => {
    if (session === null) return;
    setState({ kind: 'signing-in' });
    void session.beginSignIn();
  }, [session]);

  const signOut = useCallback(() => {
    if (session === null) return;
    session.signOut();
    setState({ kind: 'signed-out' });
  }, [session]);

  const value = useMemo<AuthContextValue>(
    () => ({ state, signIn, signOut, session }),
    [state, signIn, signOut, session],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (value === null) throw new Error('useAuth must be used inside an AuthProvider.');
  return value;
}
