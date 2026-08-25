import { createPkceAttempt } from './pkce.ts';
import { resolveApiBaseUrl, type WebAuthConfig } from '../config.ts';

/**
 * The SPA's sign-in session: starting a flow, completing the redirect, renewing, signing out.
 *
 * Two things are deliberately *not* here. The session holds no client secret – the code
 * exchange goes through confApp's own API (DR01). And nothing in this file parses the ID
 * token: it is an opaque string the SPA presents as a bearer credential, and every claim
 * decision – domain, audience, expiry, nonce – is made server-side. `expiresAt` is a scheduling
 * hint the API returned, not a trust decision; presenting a stale token simply gets refused.
 */

const SESSION_KEY = 'confapp.auth.session';
const ATTEMPT_KEY = 'confapp.auth.attempt';
/**
 * Survives sign-out on purpose. It is how "a *different* person signed in on this shared
 * tablet" is detectable at all – if sign-out erased it, the user-switch hook could never fire.
 */
const LAST_SUB_KEY = 'confapp.auth.lastSub';

/** Renew this far ahead of expiry, so a call in flight does not race the clock. */
const RENEW_MARGIN_SECONDS = 120;

/**
 * The refusal codes that mean **the grant itself was refused**, and so that access has ended.
 *
 * Deliberately a closed list of two rather than "everything except the lapse codes". An
 * unrecognised code is far more likely to be a transient or new Google condition than a
 * deprovisioning, and the cost of the two mistakes is not symmetric: guessing "lapsed" wrongly
 * leaves a departed employee reading a cached schedule until its readability window closes,
 * while guessing "deprovisioned" wrongly deletes every attendee's offline schedule at once the
 * first time Google answers `server_error` (`offline-session-expiry` → Decisions Log).
 */
const GRANT_REFUSED = new Set(['invalid_grant', 'access_denied']);

export interface SessionUser {
  sub: string;
  email: string;
  displayName: string;
}

export interface StoredSession {
  idToken: string;
  /** Seconds since the epoch, as Google minted it and the API reported it back. */
  expiresAt: number;
  user: SessionUser;
}

interface StoredAttempt {
  state: string;
  nonce: string;
  codeVerifier: string;
  /** Where to send the person once the redirect completes. */
  returnTo: string;
  /** A renewal rather than a first sign-in: on failure, say why instead of looping. */
  silent: boolean;
}

/**
 * Fired when user-scoped device state must be discarded. **S10's schedule cache registers
 * here**; this story owns the hook and its firing, not what is registered on it.
 *
 * `sub` is the identity being cleared – not the one signing in – so a listener knows whose
 * data to drop.
 */
export interface SessionClearedEvent {
  sub: string;
  reason: 'sign-out' | 'user-switch';
}

export type SessionClearedListener = (event: SessionClearedEvent) => void;

export type SignInOutcome =
  | { kind: 'signed-in'; user: SessionUser; returnTo: string }
  | { kind: 'nothing-to-do' }
  /** The redirect could not be trusted or Google refused it; `message` is displayable. */
  | { kind: 'failed'; message: string; code: string };

export interface AuthSession {
  current(): StoredSession | null;
  beginSignIn(options?: { returnTo?: string }): Promise<void>;
  completeRedirect(search: string): Promise<SignInOutcome>;
  /**
   * The credential to attach, or `null` when there is none to attach.
   *
   * **A pure accessor: it never navigates.** A stale token yields `null` and nothing else
   * happens. Renewal is `renewSilently()`, invoked deliberately by a caller that has just
   * proven the API answers – because a renewal is a top-level navigation, and firing one from
   * the credential path takes an attendee reading a cached schedule offline away from the app
   * and onto a page that cannot load (`offline-session-expiry` OC01).
   */
  validToken(): Promise<string | null>;
  /**
   * Starts DR04's silent renewal – a `prompt=none` top-level navigation, no refresh token and
   * no iframe, exactly as S02 specified it. Only *when* it fires has moved.
   *
   * A no-op while the stored token is comfortably valid, when there is no session, and after a
   * renewal has already started in this page: it is a navigation, so only one may ever begin.
   */
  renewSilently(): Promise<void>;
  signOut(): void;
  onSessionCleared(listener: SessionClearedListener): () => void;
}

export interface AuthSessionOptions {
  config: WebAuthConfig;
  /** Persistent, so a multi-day conference does not mean signing in every morning. */
  store?: Storage;
  /** Per-tab, because an in-flight attempt belongs to the tab that started it. */
  attemptStore?: Storage;
  navigate?: (url: string) => void;
  fetchImpl?: typeof fetch;
  /** Seconds since the epoch. Injectable so expiry is testable without waiting. */
  now?: () => number;
  apiBaseUrl?: string;
}

function readJson<T>(store: Storage, key: string): T | null {
  const raw = store.getItem(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // Corrupt or half-written state is not a credential. Drop it and make the person sign in.
    store.removeItem(key);
    return null;
  }
}

export function createAuthSession({
  config,
  store = localStorage,
  attemptStore = sessionStorage,
  navigate = (url: string) => {
    // A **top-level** navigation. Never an iframe and never an embedded WebView: Google blocks
    // those and they are a credential-interception risk (ADR-002).
    location.assign(url);
  },
  fetchImpl = fetch,
  now = () => Math.floor(Date.now() / 1000),
  apiBaseUrl,
}: AuthSessionOptions): AuthSession {
  const listeners = new Set<SessionClearedListener>();
  const baseUrl = apiBaseUrl ?? resolveApiBaseUrl();

  /**
   * A renewal is a top-level navigation, so only one may ever start. Several panels calling
   * `validToken()` at once on a stale token would otherwise each generate a PKCE attempt and
   * each overwrite the stored one – leaving the attempt from the *last* call paired with the
   * URL of whichever navigation the browser committed to, and a `state` mismatch on return.
   */
  let renewalStarted = false;

  function fire(event: SessionClearedEvent): void {
    for (const listener of [...listeners]) listener(event);
  }

  function current(): StoredSession | null {
    return readJson<StoredSession>(store, SESSION_KEY);
  }

  /**
   * Builds the authorization request and leaves. `prompt=none` turns the same request into a
   * silent renewal: Google answers immediately with a code while the Workspace session is
   * alive, and refuses with `login_required` once it is not.
   */
  async function authorize(options: {
    returnTo: string;
    silent: boolean;
    loginHint?: string;
  }): Promise<void> {
    const attempt = await createPkceAttempt();

    const stored: StoredAttempt = {
      state: attempt.state,
      nonce: attempt.nonce,
      codeVerifier: attempt.codeVerifier,
      returnTo: options.returnTo,
      silent: options.silent,
    };
    // Written before navigating: after the redirect this tab is the only place the verifier
    // exists, and without it the code cannot be redeemed by anyone, including us.
    attemptStore.setItem(ATTEMPT_KEY, JSON.stringify(stored));

    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state: attempt.state,
      nonce: attempt.nonce,
      code_challenge: attempt.codeChallenge,
      code_challenge_method: 'S256',
      // A hint to Google's account chooser and nothing else. The domain is enforced by the
      // API against the `hd` *claim*; this parameter restricts nobody (AGENTS.md, ADR-002).
      hd: config.hostedDomain,
    });
    if (options.silent) params.set('prompt', 'none');
    if (options.loginHint !== undefined) params.set('login_hint', options.loginHint);

    navigate(`${config.authorizationEndpoint}?${params.toString()}`);
  }

  function clearSession(reason: SessionClearedEvent['reason'], sub: string | null): void {
    store.removeItem(SESSION_KEY);
    attemptStore.removeItem(ATTEMPT_KEY);
    if (sub !== null) fire({ sub, reason });
  }

  return {
    current,

    async beginSignIn(options = {}): Promise<void> {
      await authorize({
        returnTo: options.returnTo ?? '/',
        silent: false,
      });
    },

    async completeRedirect(search: string): Promise<SignInOutcome> {
      const params = new URLSearchParams(search);
      const code = params.get('code');
      const state = params.get('state');
      const error = params.get('error');

      if (code === null && error === null) return { kind: 'nothing-to-do' };

      const attempt = readJson<StoredAttempt>(attemptStore, ATTEMPT_KEY);
      // One attempt, one redemption. Removed before anything can fail, so a replayed redirect
      // finds nothing to redeem.
      attemptStore.removeItem(ATTEMPT_KEY);

      if (attempt === null) {
        // Already consumed. Under React StrictMode the mount effect runs twice, and a person
        // who reloads the callback URL hits the same path – neither is a sign-in failure when a
        // session is already established, so it must not replace one with an error screen. With
        // no session there is genuinely nothing to redeem and the refusal stands.
        if (current() !== null) return { kind: 'nothing-to-do' };
        return {
          kind: 'failed',
          code: 'SIGN_IN_ATTEMPT_MISSING',
          message:
            'This sign-in did not start in this tab, so it was not completed. Please sign in again.',
        };
      }

      // The redirect must belong to the attempt this browser started – for a refusal just as
      // much as for a success, so a crafted `?error=` link cannot force someone's session to
      // end. Checked before the code is sent anywhere, and a mismatch stores no token.
      if (state === null || state !== attempt.state) {
        return {
          kind: 'failed',
          code: 'SIGN_IN_STATE_MISMATCH',
          message:
            'This sign-in did not match the request that started it, so it was not completed. ' +
            'Please sign in again.',
        };
      }

      /**
       * Google refused, and the refusal is provably ours. **The code decides what that means.**
       *
       * This is the one place in the tree that classifies a refusal, and it has to be: the
       * clearing hook fires `purgeScheduleCache()`, so by the time any view is involved the
       * store is already empty and there is nothing left to preserve. A second classifier
       * downstream could only disagree with this one.
       *
       * `invalid_grant` / `access_denied` are the grant itself being refused – a deprovisioned
       * account, the case `prd.md#edge-cases` means by "access ends". The session ends and the
       * cached schedules go with it.
       *
       * Everything else – `login_required` and `interaction_required` above all, but equally an
       * unrecognised or transient `server_error` – means the *Google session* lapsed, not the
       * employment. Clearing there would take a still-employed attendee's offline schedule away
       * mid-conference over an expired Workspace cookie. So the stored session and the cache
       * both stand and the person is asked to sign in again. It is the lenient default on
       * purpose, and it is safe because the readability window still bounds how long a
       * misclassified deprovisioning can read anything offline.
       */
      if (error !== null) {
        const previous = current();
        const grantRefused = GRANT_REFUSED.has(error);
        if (grantRefused && previous !== null) clearSession('sign-out', previous.user.sub);

        return {
          kind: 'failed',
          code: error,
          message: !attempt.silent
            ? 'Google did not complete the sign-in. Please try again.'
            : grantRefused
              ? 'Your session has ended because Google would not renew it. This usually means ' +
                'the account no longer has access. Please sign in again.'
              : 'Your sign-in has expired and could not be renewed automatically. Anything ' +
                'already saved on this device stays readable. Please sign in again.',
        };
      }

      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/auth/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          // The nonce travels for the API to compare against the token's claim (DR02).
          body: JSON.stringify({
            code,
            codeVerifier: attempt.codeVerifier,
            nonce: attempt.nonce,
          }),
        });
      } catch {
        return {
          kind: 'failed',
          code: 'NETWORK_UNREACHABLE',
          message: 'The app could not reach the server to finish signing in. Please try again.',
        };
      }

      const body: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        const envelope = body as { error?: { code?: string; message?: string } } | null;
        return {
          kind: 'failed',
          code: envelope?.error?.code ?? 'UNEXPECTED_RESPONSE',
          message:
            envelope?.error?.message ??
            'The server refused the sign-in and gave no reason that can be shown.',
        };
      }

      const payload = body as StoredSession;

      // A different person on this device: whatever the previous user left behind goes now,
      // before the new session exists. S10's cache clears through this.
      const lastSub = store.getItem(LAST_SUB_KEY);
      if (lastSub !== null && lastSub !== payload.user.sub) {
        fire({ sub: lastSub, reason: 'user-switch' });
      }

      store.setItem(SESSION_KEY, JSON.stringify(payload));
      store.setItem(LAST_SUB_KEY, payload.user.sub);
      // A completed redirect is a fresh page: the next expiry may start its own renewal.
      renewalStarted = false;

      return { kind: 'signed-in', user: payload.user, returnTo: attempt.returnTo };
    },

    async validToken(): Promise<string | null> {
      const session = current();
      if (session === null) return null;

      /*
       * At or past the margin there is simply no credential to present. This used to start the
       * renewal navigation from here, which made every read of a cached schedule on a device
       * with an hour-old token navigate to Google – offline, that leaves the app entirely for a
       * page that cannot load, and the schedule sitting in storage is never rendered. Renewal is
       * `renewSilently()` now, and only a caller that has proven the API answers invokes it.
       */
      if (session.expiresAt - RENEW_MARGIN_SECONDS > now()) return session.idToken;
      return null;
    },

    async renewSilently(): Promise<void> {
      const session = current();
      if (session === null) return;
      // Nothing to renew. Asked on every reconnect, so a fresh token must not spend a navigation.
      if (session.expiresAt - RENEW_MARGIN_SECONDS > now()) return;

      // A top-level navigation, so nothing after it in this tab will run – and only the first
      // caller may start it (see `renewalStarted`).
      if (renewalStarted) return;
      renewalStarted = true;

      await authorize({
        returnTo: `${location.pathname}${location.search}`,
        silent: true,
        loginHint: session.user.email,
      });
    },

    signOut(): void {
      const session = current();
      // `lastSub` deliberately survives, so the next different sign-in is still a *switch*.
      clearSession('sign-out', session?.user.sub ?? null);
    },

    onSessionCleared(listener: SessionClearedListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
