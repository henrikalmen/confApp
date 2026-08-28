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
/**
 * A silent renewal Google refused **without** the session being ended – set aside so the next page
 * load does not immediately try the same thing again.
 *
 * Persistent rather than per-tab: a lapsed Workspace cookie is a fact about the browser, not about
 * one tab, and the refusal arrives *as* a page load, so anything tab-scoped is reborn empty exactly
 * when it is needed.
 */
const RENEWAL_REFUSED_KEY = 'confapp.auth.renewalRefused';

/**
 * What a lapsed Google session is called on screen, in one place.
 *
 * It is produced twice from different directions – once as the outcome of the redirect that
 * carried the refusal, and again on any later page load that finds the refusal still standing –
 * and the person must not be told two different stories about one situation.
 */
const RENEWAL_LAPSED_MESSAGE =
  'Your sign-in has expired and could not be renewed automatically. Anything already saved on ' +
  'this device stays readable. Please sign in again.';

/** Renew this far ahead of expiry, so a call in flight does not race the clock. */
const RENEW_MARGIN_SECONDS = 120;

/**
 * The refusal codes that will **not** resolve on their own, and so must stop the app retrying.
 *
 * Not a judgement about entitlement — see the `error !== null` branch for why no such judgement is
 * possible. These are the codes that mean the Google session itself needs a person: retrying
 * silently cannot succeed until one signs in, and retrying anyway is the redirect loop.
 *
 * Everything else — `server_error`, `temporarily_unavailable`, anything unrecognised — is treated
 * as transient and left to retry on the next launch. Latching those off permanently meant one
 * Google blip disabled silent renewal for that user on that device forever, while showing a banner
 * saying their sign-in had expired when it had not (ADR-005 §3).
 */
const SESSION_LAPSED = new Set([
  'login_required',
  'interaction_required',
  'consent_required',
  'account_selection_required',
]);

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
  /**
   * Device-clock **milliseconds** at the sign-in that established this session.
   *
   * The second term of the session bound, and the only one available to somebody who has joined no
   * conference (`shared-device-session-lifetime`). Deliberately *not* `expiresAt`: that is the ID
   * token's roughly one-hour expiry, and bounding the session by it would sign attendees out hourly
   * and break S02 OC01. Milliseconds rather than seconds to match `ClockAnchor.deviceClockAtReceipt`
   * and `DeviceClock`, which the other term is evaluated against.
   *
   * **A silent renewal carries the existing value over rather than restamping it.** Restamping
   * would push the horizon out on every renewal, which for anyone opening the app inside the margin
   * is every hour – an unbounded session dressed as a bounded one, and the exact hole this feature
   * exists to close. An *interactive* sign-in does stamp fresh: somebody proved who they were.
   */
  signedInAt: number;
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
  /**
   * The redirect could not be trusted or Google refused it; `message` is displayable.
   *
   * `silent` says whether the attempt that failed was a **background renewal** rather than a
   * person pressing "Sign in". Only a renewal may leave the previous session standing: a failed
   * *interactive* sign-in on a shared tablet must land on the signed-out screen, not hand the
   * device back to whoever was signed in before.
   */
  | { kind: 'failed'; message: string; code: string; silent: boolean };

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
  /**
   * A silent renewal Google refused that did **not** end the session, still standing.
   *
   * Durable, so the shell can say so on a cold load. Without it a reload clears the banner from
   * React state while the refusal itself survives in storage, and the person is left on an app
   * whose every request fails with nothing on screen explaining why or offering a way out.
   */
  renewalRefusal(): { code: string; message: string } | null;
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
    const session = readJson<StoredSession>(store, SESSION_KEY);
    if (session === null) return null;
    if (Number.isFinite(session.signedInAt)) return session;

    /*
     * **A session written before this field existed, backfilled exactly once.**
     *
     * Storage outlives code: every device already signed in carries a session with no sign-in
     * reading, and failing those closed would sign out every current user the moment this shipped.
     * Failing them *open* is not available either – the clarification's Error Handling table is
     * explicit that the bound never silently becomes unbounded when data is missing.
     *
     * So the value is stamped and **written back**. The write is what makes this a one-time
     * backfill rather than a rolling reset: a value recomputed on each read would move the horizon
     * forward every launch and the session would never expire. The next read takes the branch above.
     */
    const backfilled: StoredSession = { ...session, signedInAt: now() * 1000 };
    store.setItem(SESSION_KEY, JSON.stringify(backfilled));
    return backfilled;
  }

  /**
   * The standing refusal, or `null` – and `null` for a refusal recorded against somebody else.
   *
   * Keyed by subject on purpose: on a shared device the previous person's lapsed Workspace session
   * says nothing about the one signing in now, and a marker left behind would block their renewals
   * for as long as it sat there.
   */
  function renewalRefusal(): { code: string; message: string } | null {
    const stored = readJson<{ sub: string; code: string }>(store, RENEWAL_REFUSED_KEY);
    if (stored === null) return null;
    if (stored.sub !== current()?.user.sub) return null;
    return { code: stored.code, message: RENEWAL_LAPSED_MESSAGE };
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
    // The refusal was about a session that no longer exists. Leaving it would block the next
    // person's renewals on this device for a lapse that was never theirs.
    store.removeItem(RENEWAL_REFUSED_KEY);
    if (sub !== null) fire({ sub, reason });
  }

  return {
    current,
    renewalRefusal,

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
          silent: false,
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
          // The redirect did not belong to this browser's attempt, so nothing about it may be
          // trusted – least of all a claim to be a renewal that keeps a session alive.
          silent: false,
          code: 'SIGN_IN_STATE_MISMATCH',
          message:
            'This sign-in did not match the request that started it, so it was not completed. ' +
            'Please sign in again.',
        };
      }

      /**
       * Google refused, and the refusal is provably ours. **The code does not tell us why, and
       * this is where confApp stopped pretending it does** (ADR-005).
       *
       * A suspended or deleted Workspace account and an ordinary expired Workspace cookie both
       * come back `login_required`: OIDC Core requires an error under `prompt=none` when the
       * end-user is not authenticated, and disabling an account terminates its sessions, so the
       * two are the same event on the wire. Google documents no code for the deprovisioned case
       * at all. `invalid_grant` cannot arrive here — it is a token-endpoint error (RFC 6749 §5.2)
       * and appears in neither the authorization-endpoint list nor OIDC's additions.
       * `access_denied` is a person declining, not an account ending. And Cross-Account
       * Protection, which Google recommends for exactly this, states it sends no events for
       * Workspace users.
       *
       * So no refusal ends a session here. What bounds a departed employee is time, not a code:
       * their token expires within the hour and cannot be reissued, so the API is closed to them
       * regardless of anything this branch does; the cached schedule is bounded by its readability
       * window; and the stored session is bounded by `shared-device-session-lifetime`.
       *
       * The one thing still classified is whether retrying could ever work — see `SESSION_LAPSED`.
       */
      if (error !== null) {
        const previous = current();

        /*
         * **The loop-breaker.** A refusal that leaves the session standing arrives *as* a page
         * load, so both of the "only once" guards – `renewalStarted` here and the shell's own
         * per-page ref – are reborn `false` by the very navigation that carried it. Without a
         * durable record the app comes straight back up, finds the same expired token, probes,
         * renews, and is refused again: a top-level trip to Google every few seconds, for exactly
         * the still-employed attendee the lenient default was written to protect.
         *
         * Recorded rather than retried on a timer, and **only for the codes that cannot resolve on
         * their own**. A delay would slow the loop rather than end it, because nothing about
         * waiting makes a lapsed Workspace cookie come back; what ends it is the person signing
         * in, and the banner this refusal raises is where they do that. That reasoning is true of
         * `login_required` and false of `server_error`, which is why `SESSION_LAPSED` gates this
         * and an unrecognised or transient code is left to retry on the next launch (ADR-005 §3).
         */
        if (attempt.silent && SESSION_LAPSED.has(error) && previous !== null) {
          store.setItem(
            RENEWAL_REFUSED_KEY,
            JSON.stringify({ sub: previous.user.sub, code: error }),
          );
        }

        return {
          kind: 'failed',
          silent: attempt.silent,
          code: error,
          message: attempt.silent
            ? RENEWAL_LAPSED_MESSAGE
            : 'Google did not complete the sign-in. Please try again.',
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
          // A renewal that got its code from Google and then could not reach the API is still a
          // renewal. Reporting it as interactive sends the shell to the signed-out screen and
          // takes the cached Schedule off a device that may have no network at all – which is
          // precisely the failure this feature exists to remove (review 2026-08-25, F-1).
          silent: attempt.silent,
          code: 'NETWORK_UNREACHABLE',
          message: 'The app could not reach the server to finish signing in. Please try again.',
        };
      }

      const body: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        const envelope = body as { error?: { code?: string; message?: string } } | null;
        return {
          kind: 'failed',
          // The code came back and the API refused to redeem it. Whatever started this, the
          // person is signed out – a half-completed exchange is not a session worth keeping.
          silent: false,
          code: envelope?.error?.code ?? 'UNEXPECTED_RESPONSE',
          message:
            envelope?.error?.message ??
            'The server refused the sign-in and gave no reason that can be shown.',
        };
      }

      const payload = body as Omit<StoredSession, 'signedInAt'>;
      const previous = current();

      // A different person on this device: whatever the previous user left behind goes now,
      // before the new session exists. S10's cache clears through this.
      const lastSub = store.getItem(LAST_SUB_KEY);
      if (lastSub !== null && lastSub !== payload.user.sub) {
        fire({ sub: lastSub, reason: 'user-switch' });
      }

      /*
       * A silent renewal is not a new sign-in, so it inherits the original reading; anything else –
       * an interactive sign-in, or the same person returning after a sign-out – starts the clock.
       * See `StoredSession.signedInAt` for why restamping on renewal would make the bound vacuous.
       */
      const session: StoredSession = {
        ...payload,
        signedInAt:
          attempt.silent && previous !== null && previous.user.sub === payload.user.sub
            ? previous.signedInAt
            : now() * 1000,
      };

      store.setItem(SESSION_KEY, JSON.stringify(session));
      store.setItem(LAST_SUB_KEY, payload.user.sub);
      // Google answered with a code, so whatever it refused before is over. This is the only thing
      // that lifts the block – which is why the banner's control starts an *interactive* sign-in.
      store.removeItem(RENEWAL_REFUSED_KEY);
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

      // Google has already refused this session once and nothing has changed since. Asking again
      // is the redirect loop; the way out is the interactive sign-in the banner offers.
      if (renewalRefusal() !== null) return;

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
