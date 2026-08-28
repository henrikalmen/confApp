import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  createAuthSession,
  type AuthSession,
  type SessionUser,
  type StoredSession,
} from './session.ts';
import { withinSessionBound } from './session-bound.ts';
import { fetchHealth, setCredentialMissingListener, setTokenSource } from '../api/client.ts';
import { setSessionActions } from './session-actions.ts';
import { resolveAuthConfig } from '../config.ts';
import {
  adoptCacheOwner,
  purgeScheduleCache,
  readCachedSchedulesFor,
  setCacheIdentity,
} from '../offline/schedule-cache.ts';

/** What the sign-in screen says when a session was cleared for passing its lifetime. */
const SESSION_EXPIRED = {
  code: 'SESSION_EXPIRED',
  message: 'Your sign-in has expired. Sign in again to continue.',
} as const;

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
  /**
   * `renewalFailed` is present when a silent renewal was refused for a reason that did **not**
   * end the session – a lapsed Google session rather than a refused grant. The app carries on
   * with everything already on the device readable, and says a sign-in is needed.
   */
  | { kind: 'signed-in'; user: SessionUser; renewalFailed?: { code: string; message: string } };

interface AuthContextValue {
  state: AuthState;
  signIn(): void;
  signOut(): void;
  session: AuthSession | null;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * How long the reachability probe may take before it is treated as unanswered.
 *
 * Generous, because a slow answer is still an answer and a needless retry costs a request; bounded,
 * because a connection that accepts and never replies would otherwise hold the one probe slot open
 * for the life of the page.
 */
const REACHABILITY_PROBE_MS = 10_000;

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
  /**
   * The renewal has been asked for on this page load, so it will not be asked for again.
   *
   * Set only once `renewSilently()` has resolved without throwing – a renewal that failed to
   * start (no `crypto.subtle`, a storage refusal writing the PKCE attempt) must not burn the one
   * attempt this page gets.
   */
  const renewalAsked = useRef(false);
  /** A probe is outstanding; further refusals are the same event and do not start a second one. */
  const probing = useRef(false);

  const redirectHandled = useRef(false);
  /**
   * Liveness has to be a ref rather than a per-run closure. The redirect is started by the first
   * effect run, and StrictMode's cleanup would clear a run-scoped flag before that one call
   * resolves – leaving the app on "Checking your sign-in…" forever. Set true whenever the effect
   * runs and false on cleanup, this is true again by the time the promise settles after a
   * remount, and stays false after a real unmount.
   */
  const mounted = useRef(false);

  /** One definition of "start an interactive sign-in", used by the context and by the seam below. */
  const startSignIn = useCallback((): void => {
    if (session === null) return;
    setState({ kind: 'signing-in' });
    void session.beginSignIn();
  }, [session]);

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
     * And the two session actions a view may need to invoke. Renewal is here rather than inside
     * `validToken()` because it is a top-level navigation: fired from the credential path it
     * takes an attendee reading a cached schedule with no connection out of the app and onto a
     * page that cannot load. Only a caller that has just seen the API answer invokes it
     * (`offline-session-expiry` TI05).
     */
    setSessionActions({ signIn: startSignIn });

    /*
     * **What renews the credential, for the whole app.**
     *
     * `validToken()` no longer navigates (`offline-session-expiry` TI01), so something has to
     * decide when a renewal may fire. The rule is unchanged and is the whole point of the story:
     * **only after the API has actually answered.** A renewal is a top-level navigation, and one
     * fired on a hunch takes an attendee reading a cached schedule with no connection out of the
     * app entirely, to a page that cannot load.
     *
     * With a lapsed credential no *authenticated* request can leave the device (TI07), so their
     * failure proves nothing about the network – it is identical on dead venue wifi and on a
     * perfect connection. The only available proof is the one route that needs no credential:
     * `/health`, the readiness signal that already exists for exactly this question. A reply
     * starts the renewal; a failure means the next refused request will ask again.
     *
     * Registered here rather than in a view because every surface needs it. Held in the attendee
     * panel it covered one branch of one component, and an organizer working past the token's
     * one-hour life hit a wall no screen offered a way out of.
     */
    setCredentialMissingListener(() => {
      if (renewalAsked.current || probing.current) return;
      probing.current = true;

      void (async () => {
        // The probe cannot be allowed to hang: a black-holed connection is the ordinary venue-wifi
        // failure, and an outstanding probe blocks every later attempt for the life of the page.
        const controller = new AbortController();
        const deadline = setTimeout(() => controller.abort(), REACHABILITY_PROBE_MS);
        try {
          await fetchHealth(controller.signal);
          await session.renewSilently();
          renewalAsked.current = true;
        } catch {
          // Nothing answered, or the renewal could not start. The next refused request tries again.
        } finally {
          clearTimeout(deadline);
          probing.current = false;
        }
      })();
    });
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

    /**
     * **The session lifetime bound, evaluated once per launch** (`shared-device-session-lifetime`).
     *
     * Here rather than inside `session.current()` because the conference term's inputs live in
     * IndexedDB, which is async, while `current()` is synchronous and read on every credential
     * path – and here rather than anywhere later because a session past its bound must not render
     * one frame of the previous person's data before it goes.
     *
     * Reads the **raw** rows for the subject. `listCachedConferences` would apply the readability
     * window and evict what it filters, and an entry withheld by the 30-day sync horizon can carry
     * the largest `endDate` on the device – dropping it here would sign an attendee out because a
     * conference they joined early had not been synced recently, before it had even started.
     * Nothing on this path evicts, and it runs before the panels that do are mounted.
     *
     * A cache that cannot be read at all yields no conference term, leaving the sign-in term to
     * bound the session – never "unbounded because the data was missing".
     */
    const stillWithinBound = async (candidate: StoredSession): Promise<boolean> => {
      let entries: Awaited<ReturnType<typeof readCachedSchedulesFor>> = [];
      try {
        entries = await readCachedSchedulesFor(candidate.user.sub);
      } catch {
        // Left empty on purpose – see above.
      }
      return withinSessionBound(candidate, entries);
    };

    void session.completeRedirect(search).then(async (outcome) => {
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

        /*
         * **A refused *renewal* no longer implies a signed-out app.** The session module
         * classifies the refusal code and clears the session only for a refused *grant*; a lapsed
         * Google session leaves it standing (`offline-session-expiry` TI06). Where it stands, the
         * app stays where it was – with its cached Schedule on screen – and asks for a sign-in
         * instead of replacing the screen with one. Dropping to `signed-out` here would hide the
         * schedule the whole feature exists to keep readable, and it would do so on a device that
         * may have no connection to sign in with.
         *
         * **Gated on `silent`, not merely on a session existing.** A failed *interactive* sign-in
         * is a different event with the opposite answer: on a shared conference tablet, somebody
         * whose sign-in was refused must reach the signed-out screen, not be handed back the
         * previous person's session under their name. Keying this on `current() !== null` alone
         * did exactly that for every non-renewal failure – a state mismatch, a refused domain, a
         * network drop mid-exchange.
         */
        const surviving = outcome.silent ? session.current() : null;
        if (surviving !== null) {
          // Claimed first, for the ordering reason spelled out on the cold-launch branch below.
          claim(surviving.user);
          // A session that survives a refused renewal is still a session restored on this launch,
          // so it faces the same bound as one restored without a redirect.
          if (!(await stillWithinBound(surviving))) {
            session.signOut();
            if (!mounted.current) return;
            setState({ kind: 'signed-out', error: SESSION_EXPIRED });
            return;
          }
          if (!mounted.current) return;
          setState({
            kind: 'signed-in',
            user: surviving.user,
            renewalFailed: { code: outcome.code, message: outcome.message },
          });
          return;
        }

        setState({
          kind: 'signed-out',
          error: { code: outcome.code, message: outcome.message },
        });
        return;
      }

      const existing = session.current();

      if (existing === null) {
        setState({ kind: 'signed-out' });
        return;
      }

      /*
       * A session restored from storage on a cold launch claims the store too – that launch is
       * exactly the case where the previous session ended without a sign-out.
       *
       * **Kept ahead of the bound, where it already was.** The claim is what purges a store found
       * to belong to somebody else, and that is a privacy guarantee (S10 TI08); putting the bound's
       * IndexedDB read in front of it would delay the purge behind an extra async hop for no gain.
       * Claiming a store for a session about to be signed out costs nothing – both paths end in a
       * purge and the owner marker is rewritten at the next sign-in – so the ordering that changes
       * least is the one to keep.
       */
      claim(existing.user);

      /*
       * The bound is evaluated before the app settles signed-in: past it, the sign-out path clears
       * the session and fires the hook S10's purge is registered on, so the expiry is a real data
       * boundary rather than a screen that declines to draw.
       */
      if (!(await stillWithinBound(existing))) {
        session.signOut();
        if (!mounted.current) return;
        setState({ kind: 'signed-out', error: SESSION_EXPIRED });
        return;
      }
      if (!mounted.current) return;

      /*
       * **A refusal outlives the render that reported it.** A silent renewal Google refused
       * without ending the session blocks further silent renewals until an interactive sign-in
       * clears it, and that block is stored – so on this load the app would otherwise come up
       * looking ordinary while every request failed for want of a credential, with nothing on
       * screen saying why and nothing offering the sign-in that fixes it.
       *
       * Restoring the banner from the stored refusal is what keeps the block and its remedy
       * together: the same durable fact that stops the loop is the thing that explains it.
       */
      const standing = session.renewalRefusal();
      setState({
        kind: 'signed-in',
        user: existing.user,
        ...(standing !== null ? { renewalFailed: standing } : {}),
      });
    });

    return () => {
      mounted.current = false;
      unsubscribe();
    };
  }, [session, initialSearch, startSignIn]);

  const signOut = useCallback(() => {
    if (session === null) return;
    session.signOut();
    setState({ kind: 'signed-out' });
  }, [session]);

  const value = useMemo<AuthContextValue>(
    () => ({ state, signIn: startSignIn, signOut, session }),
    [state, startSignIn, signOut, session],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (value === null) throw new Error('useAuth must be used inside an AuthProvider.');
  return value;
}
