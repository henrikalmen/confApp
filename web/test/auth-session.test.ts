import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  createAuthSession,
  type AuthSession,
  type SessionClearedEvent,
} from '../src/auth/session.ts';
import type { WebAuthConfig } from '../src/config.ts';

/**
 * TI07–TI10, proving Acceptance Scenarios S01 (browser half), S06 and S07.
 *
 * Everything external is injected: where the browser would navigate, what the API answers, and
 * what time it is. The session's own logic – state comparison, storage, renewal, the clearing
 * hook – is the real thing under test.
 */

const config: WebAuthConfig = {
  clientId: 'web-111.apps.googleusercontent.example',
  authorizationEndpoint: 'https://accounts.google.example/o/oauth2/v2/auth',
  hostedDomain: 'ourcompany.example',
  redirectUri: 'http://localhost:8082/auth/callback',
};

const ANNA = { sub: 'google-sub-anna', email: 'anna@ourcompany.example', displayName: 'Anna' };
const BJORN = { sub: 'google-sub-bjorn', email: 'bjorn@ourcompany.example', displayName: 'Björn' };

interface Harness {
  session: AuthSession;
  navigations: string[];
  cleared: SessionClearedEvent[];
  /** Queued API answers for POST /api/auth/token, consumed in order. */
  queue(response: { status: number; body: unknown }): void;
  requests: { url: string; body: unknown }[];
  setNow(seconds: number): void;
}

function harness(): Harness {
  const navigations: string[] = [];
  const cleared: SessionClearedEvent[] = [];
  const responses: { status: number; body: unknown }[] = [];
  const requests: { url: string; body: unknown }[] = [];
  let nowSeconds = 1_800_000_000;

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init?.body ?? 'null')) });
    const next = responses.shift();
    if (next === undefined) throw new Error(`No queued response for ${url}`);
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  const session = createAuthSession({
    config,
    navigate: (url) => navigations.push(url),
    fetchImpl,
    now: () => nowSeconds,
    apiBaseUrl: '/api',
  });

  session.onSessionCleared((event) => cleared.push(event));

  return {
    session,
    navigations,
    cleared,
    requests,
    queue: (response) => responses.push(response),
    setNow: (seconds) => {
      nowSeconds = seconds;
    },
  };
}

/** Reads the attempt the SPA stored, so a test can play Google's redirect back correctly. */
function currentAttempt(): { state: string; nonce: string; codeVerifier: string } {
  const raw = sessionStorage.getItem('confapp.auth.attempt');
  expect(raw).not.toBeNull();
  return JSON.parse(raw!);
}

function authorizationParams(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('beginSignIn', () => {
  it('navigates top-level to Google with PKCE S256 and per-attempt state and nonce', async () => {
    const h = harness();

    await h.session.beginSignIn();

    expect(h.navigations).toHaveLength(1);
    const params = authorizationParams(h.navigations[0]!);

    expect(h.navigations[0]!.startsWith(config.authorizationEndpoint)).toBe(true);
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('response_type')).toBe('code');
    expect(params.get('scope')).toBe('openid email profile');
    expect(params.get('client_id')).toBe(config.clientId);
    expect(params.get('redirect_uri')).toBe(config.redirectUri);
    expect(params.get('code_challenge')).toBeTruthy();

    const attempt = currentAttempt();
    expect(params.get('state')).toBe(attempt.state);
    expect(params.get('nonce')).toBe(attempt.nonce);
    // The verifier is the one thing that must never travel in the authorization request.
    expect(h.navigations[0]).not.toContain(attempt.codeVerifier);
  });

  it('sends hd only as a UX hint, never as the app’s domain restriction', async () => {
    const h = harness();
    await h.session.beginSignIn();

    // Present, because it pre-fills Google's account chooser…
    expect(authorizationParams(h.navigations[0]!).get('hd')).toBe('ourcompany.example');
    // …and the SPA makes no domain decision of its own anywhere.
    expect(h.navigations[0]).not.toContain('prompt=');
  });

  it('gives two consecutive attempts different state and nonce values', async () => {
    const h = harness();

    await h.session.beginSignIn();
    const first = currentAttempt();
    await h.session.beginSignIn();
    const second = currentAttempt();

    expect(second.state).not.toBe(first.state);
    expect(second.nonce).not.toBe(first.nonce);
    expect(second.codeVerifier).not.toBe(first.codeVerifier);
  });
});

describe('completeRedirect', () => {
  /** Acceptance Scenario S01 – she returns signed in, and the next API call is accepted. */
  it('exchanges the code and establishes a signed-in session', async () => {
    const h = harness();
    await h.session.beginSignIn();
    const attempt = currentAttempt();

    h.queue({
      status: 200,
      body: { idToken: 'the-id-token', expiresAt: 1_800_003_600, user: ANNA },
    });

    const outcome = await h.session.completeRedirect(`?code=google-code&state=${attempt.state}`);

    expect(outcome).toMatchObject({ kind: 'signed-in', user: ANNA });
    expect(h.session.current()?.idToken).toBe('the-id-token');
    expect(await h.session.validToken()).toBe('the-id-token');

    // The verifier and nonce went to confApp's API, never to Google from the browser.
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]!.url).toBe('/api/auth/token');
    expect(h.requests[0]!.body).toEqual({
      code: 'google-code',
      codeVerifier: attempt.codeVerifier,
      nonce: attempt.nonce,
    });
  });

  /** Structural Criterion – a mismatched `state` stores no token. */
  it('refuses a mismatched state, stores no token, and never sends the code anywhere', async () => {
    const h = harness();
    await h.session.beginSignIn();

    const outcome = await h.session.completeRedirect('?code=google-code&state=not-the-state');

    expect(outcome).toMatchObject({ kind: 'failed', code: 'SIGN_IN_STATE_MISMATCH' });
    expect(h.session.current()).toBeNull();
    expect(localStorage.getItem('confapp.auth.session')).toBeNull();
    // The decisive part: a code arriving with the wrong state is not redeemed at all.
    expect(h.requests).toHaveLength(0);
  });

  it('refuses a redirect carrying no state at all', async () => {
    const h = harness();
    await h.session.beginSignIn();

    const outcome = await h.session.completeRedirect('?code=google-code');

    expect(outcome).toMatchObject({ kind: 'failed', code: 'SIGN_IN_STATE_MISMATCH' });
    expect(h.requests).toHaveLength(0);
  });

  /**
   * A code arriving with no attempt in this tab cannot be redeemed – the verifier that would
   * prove it belongs to us does not exist. Asserted with no session established, which is the
   * case that matters: someone feeding a stolen code into a fresh browser.
   */
  it('refuses a code with no attempt in this tab, and never sends it anywhere', async () => {
    const h = harness();

    const outcome = await h.session.completeRedirect('?code=stolen-code&state=some-state');

    expect(outcome).toMatchObject({ kind: 'failed', code: 'SIGN_IN_ATTEMPT_MISSING' });
    expect(h.session.current()).toBeNull();
    expect(h.requests).toHaveLength(0);
  });

  it('redeems one attempt exactly once, whatever arrives afterwards', async () => {
    const h = harness();
    await h.session.beginSignIn();
    const attempt = currentAttempt();

    h.queue({ status: 200, body: { idToken: 't', expiresAt: 1_800_003_600, user: ANNA } });
    await h.session.completeRedirect(`?code=google-code&state=${attempt.state}`);

    // The attempt is consumed, so a replay cannot reach the exchange a second time.
    await h.session.completeRedirect(`?code=google-code&state=${attempt.state}`);
    expect(h.requests).toHaveLength(1);
    expect(sessionStorage.getItem('confapp.auth.attempt')).toBeNull();
  });

  it('surfaces the API’s refusal message when the server rejects the sign-in', async () => {
    const h = harness();
    await h.session.beginSignIn();
    const attempt = currentAttempt();

    h.queue({
      status: 403,
      body: {
        error: {
          code: 'AUTH_DOMAIN_NOT_ALLOWED',
          message: 'confApp is limited to company Google Workspace accounts.',
        },
      },
    });

    const outcome = await h.session.completeRedirect(`?code=c&state=${attempt.state}`);

    expect(outcome).toMatchObject({
      kind: 'failed',
      code: 'AUTH_DOMAIN_NOT_ALLOWED',
      message: 'confApp is limited to company Google Workspace accounts.',
    });
    expect(h.session.current()).toBeNull();
  });

  it('does nothing when the page was not reached through a redirect', async () => {
    const h = harness();
    expect(await h.session.completeRedirect('')).toEqual({ kind: 'nothing-to-do' });
    expect(await h.session.completeRedirect('?verbose=true')).toEqual({ kind: 'nothing-to-do' });
  });

  /**
   * The callback being processed twice must not replace an established session with an error.
   * React StrictMode mounts effects twice, and reloading the callback URL does the same thing –
   * neither is a sign-in failure once a session exists.
   */
  it('reports nothing-to-do, not a failure, when the redirect is processed twice', async () => {
    const h = harness();
    await h.session.beginSignIn();
    const attempt = currentAttempt();
    h.queue({ status: 200, body: { idToken: 't', expiresAt: 1_800_003_600, user: ANNA } });

    const first = await h.session.completeRedirect(`?code=c&state=${attempt.state}`);
    const second = await h.session.completeRedirect(`?code=c&state=${attempt.state}`);

    expect(first.kind).toBe('signed-in');
    expect(second).toEqual({ kind: 'nothing-to-do' });
    // Still signed in, and the code was redeemed exactly once.
    expect(h.session.current()?.user).toEqual(ANNA);
    expect(h.requests).toHaveLength(1);
  });

  /**
   * A crafted `?error=` link must not be able to end someone's session. The refusal is only
   * honoured when its `state` matches the attempt this browser started.
   */
  it('ignores an error whose state does not match the attempt, keeping the session', async () => {
    const h = harness();
    await h.session.beginSignIn();
    const attempt = currentAttempt();
    h.queue({ status: 200, body: { idToken: 't', expiresAt: 1_800_003_600, user: ANNA } });
    await h.session.completeRedirect(`?code=c&state=${attempt.state}`);

    // Mid-renewal, so an attempt is in flight for the crafted link to target.
    h.setNow(1_800_090_000);
    await h.session.validToken();

    const outcome = await h.session.completeRedirect('?error=access_denied&state=attacker-chose');

    expect(outcome).toMatchObject({ kind: 'failed', code: 'SIGN_IN_STATE_MISMATCH' });
    // The session survived, and no clearing hook fired.
    expect(h.session.current()?.user).toEqual(ANNA);
    expect(h.cleared).toEqual([]);
  });
});

describe('renewal', () => {
  /** Acceptance Scenario S06 – the session survives expiry without re-entering credentials. */
  it('renews silently when the stored token is at its expiry margin', async () => {
    const h = harness();
    await h.session.beginSignIn();
    const first = currentAttempt();
    h.queue({
      status: 200,
      body: { idToken: 'day-1-token', expiresAt: 1_800_003_600, user: ANNA },
    });
    await h.session.completeRedirect(`?code=c&state=${first.state}`);
    h.navigations.length = 0;

    // Day 2: the stored token has passed its expiry.
    h.setNow(1_800_090_000);

    expect(await h.session.validToken()).toBeNull();
    expect(h.navigations).toHaveLength(1);

    const params = authorizationParams(h.navigations[0]!);
    // Silent: Google answers without showing anything if the Workspace session is alive.
    expect(params.get('prompt')).toBe('none');
    expect(params.get('login_hint')).toBe(ANNA.email);
    expect(params.get('code_challenge_method')).toBe('S256');

    // Completing that renewal yields a fresh token and the retried call succeeds.
    const renewal = currentAttempt();
    h.queue({
      status: 200,
      body: { idToken: 'day-2-token', expiresAt: 1_800_093_600, user: ANNA },
    });
    const outcome = await h.session.completeRedirect(`?code=fresh&state=${renewal.state}`);

    expect(outcome).toMatchObject({ kind: 'signed-in' });
    expect(await h.session.validToken()).toBe('day-2-token');
  });

  /**
   * A renewal is a top-level navigation, so only one may start. Several panels asking for a
   * credential at once on a stale token would otherwise each mint a PKCE attempt and each
   * overwrite the stored one, pairing the surviving attempt with a different navigation's
   * `state` – and the return leg would then fail the state check.
   */
  it('starts only one renewal when several callers hit a stale token at once', async () => {
    const h = harness();
    await h.session.beginSignIn();
    const attempt = currentAttempt();
    h.queue({ status: 200, body: { idToken: 't', expiresAt: 1_800_003_600, user: ANNA } });
    await h.session.completeRedirect(`?code=c&state=${attempt.state}`);
    h.navigations.length = 0;

    h.setNow(1_800_090_000);
    await Promise.all([
      h.session.validToken(),
      h.session.validToken(),
      h.session.validToken(),
      h.session.validToken(),
    ]);

    expect(h.navigations).toHaveLength(1);
    // The stored attempt is the one that belongs to the navigation that happened.
    const renewal = currentAttempt();
    expect(h.navigations[0]).toContain(`state=${renewal.state}`);
  });

  it('does not renew while the token is comfortably valid', async () => {
    const h = harness();
    await h.session.beginSignIn();
    const attempt = currentAttempt();
    h.queue({ status: 200, body: { idToken: 'fresh', expiresAt: 1_800_003_600, user: ANNA } });
    await h.session.completeRedirect(`?code=c&state=${attempt.state}`);
    h.navigations.length = 0;

    expect(await h.session.validToken()).toBe('fresh');
    expect(h.navigations).toHaveLength(0);
  });

  /**
   * Acceptance Scenario S06, second half – Google refuses the renewal because the account was
   * deprovisioned. She is signed out with the reason, not left on a silently failing screen.
   */
  it('ends the session with a displayable reason when Google refuses the renewal', async () => {
    const h = harness();
    await h.session.beginSignIn();
    const first = currentAttempt();
    h.queue({ status: 200, body: { idToken: 't', expiresAt: 1_800_003_600, user: ANNA } });
    await h.session.completeRedirect(`?code=c&state=${first.state}`);

    h.setNow(1_800_090_000);
    await h.session.validToken();
    const renewal = currentAttempt();

    // Google returns `state` with its errors too, and the session only ends for a refusal that
    // provably belongs to this attempt.
    const outcome = await h.session.completeRedirect(
      `?error=login_required&state=${renewal.state}`,
    );

    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(outcome.code).toBe('login_required');
    expect(outcome.message).toMatch(/no longer has access/i);
    expect(outcome.message).toMatch(/\.$/);

    expect(h.session.current()).toBeNull();
    // Signed out, and the clearing hook fired for the account that is going away.
    expect(h.cleared).toEqual([{ sub: ANNA.sub, reason: 'sign-out' }]);
  });
});

describe('sign-out and the user-switch hook', () => {
  async function signIn(h: Harness, user: typeof ANNA, idToken: string): Promise<void> {
    await h.session.beginSignIn();
    const attempt = currentAttempt();
    h.queue({ status: 200, body: { idToken, expiresAt: 1_800_003_600, user } });
    const outcome = await h.session.completeRedirect(`?code=c&state=${attempt.state}`);
    expect(outcome.kind).toBe('signed-in');
  }

  /**
   * Acceptance Scenario S07 – on a shared tablet, sign-out then a different person signing in
   * must each fire the hook exactly once, carrying the identity being cleared. This is the
   * seam S10's schedule cache registers with.
   */
  it('fires the hook once on sign-out and once on the switch to a different sub', async () => {
    const h = harness();
    await signIn(h, ANNA, 'anna-token');

    h.session.signOut();

    expect(h.session.current()).toBeNull();
    expect(await h.session.validToken()).toBeNull();
    expect(h.cleared).toEqual([{ sub: ANNA.sub, reason: 'sign-out' }]);

    await signIn(h, BJORN, 'bjorn-token');

    expect(h.cleared).toEqual([
      { sub: ANNA.sub, reason: 'sign-out' },
      // Anna's sub, not Björn's: the listener needs to know *whose* data to drop.
      { sub: ANNA.sub, reason: 'user-switch' },
    ]);
    expect(h.session.current()?.user).toEqual(BJORN);
    expect(await h.session.validToken()).toBe('bjorn-token');
  });

  it('does not fire the switch hook when the same person signs in again', async () => {
    const h = harness();
    await signIn(h, ANNA, 'anna-token');
    h.session.signOut();
    h.cleared.length = 0;

    await signIn(h, ANNA, 'anna-token-again');

    expect(h.cleared).toEqual([]);
  });

  it('fires nothing on a sign-out when nobody was signed in', () => {
    const h = harness();
    h.session.signOut();
    expect(h.cleared).toEqual([]);
  });

  it('lets a listener unsubscribe', async () => {
    const h = harness();
    const listener = vi.fn();
    const unsubscribe = h.session.onSessionCleared(listener);

    await signIn(h, ANNA, 'anna-token');
    h.session.signOut();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    await signIn(h, BJORN, 'bjorn-token');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('leaves no token behind after sign-out, so a later API call has nothing to send', async () => {
    const h = harness();
    await signIn(h, ANNA, 'anna-token');

    h.session.signOut();

    expect(localStorage.getItem('confapp.auth.session')).toBeNull();
    expect(sessionStorage.getItem('confapp.auth.attempt')).toBeNull();
    // Nothing anywhere in storage still holds the credential.
    const dump = (store: Storage): string =>
      Array.from({ length: store.length }, (_unused, index) =>
        store.getItem(store.key(index) ?? ''),
      ).join('|');
    expect(`${dump(localStorage)}|${dump(sessionStorage)}`).not.toContain('anna-token');
  });
});
