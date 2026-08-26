import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  createAuthSession,
  type AuthSession,
  type SessionClearedEvent,
  type SignInOutcome,
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
  /** So a rebuilt session can be placed at the same moment – see `reopened`. */
  nowSeconds(): number;
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
    nowSeconds: () => nowSeconds,
  };
}

/**
 * The next page load: a fresh session object over the **same** storage.
 *
 * A renewal refusal comes back as a top-level navigation, so nothing held in the module's closure
 * survives it. Building a second session is the only faithful way to test what happens next.
 */
function reopened(previous: Harness): Harness {
  const rebuilt = harness();
  rebuilt.setNow(previous.nowSeconds());
  return rebuilt;
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

    // Mid-renewal, so an attempt is in flight for the crafted link to target. Started explicitly:
    // reading the credential no longer begins one (`offline-session-expiry` TI01).
    h.setNow(1_800_090_000);
    await h.session.renewSilently();

    const outcome = await h.session.completeRedirect('?error=access_denied&state=attacker-chose');

    expect(outcome).toMatchObject({ kind: 'failed', code: 'SIGN_IN_STATE_MISMATCH' });
    // The session survived, and no clearing hook fired.
    expect(h.session.current()?.user).toEqual(ANNA);
    expect(h.cleared).toEqual([]);
  });
});

describe('renewal', () => {
  /**
   * Acceptance Scenario S06 – the session survives expiry without re-entering credentials.
   *
   * **Moved, not relaxed** (`offline-session-expiry` TI01). Every assertion below is S02's: one
   * navigation, `prompt=none`, a `login_hint`, S256. What has changed is which call makes it –
   * reading the credential used to, and now only an explicit renewal does, because a navigation
   * fired from the credential path takes an attendee reading a cached schedule offline out of the
   * app entirely. DR04's request shape is asserted positively here so the move cannot quietly
   * become a deletion.
   */
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

    await h.session.renewSilently();
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
  it('starts only one renewal when several callers ask for one at once', async () => {
    const h = harness();
    await h.session.beginSignIn();
    const attempt = currentAttempt();
    h.queue({ status: 200, body: { idToken: 't', expiresAt: 1_800_003_600, user: ANNA } });
    await h.session.completeRedirect(`?code=c&state=${attempt.state}`);
    h.navigations.length = 0;

    h.setNow(1_800_090_000);
    await Promise.all([
      h.session.renewSilently(),
      h.session.renewSilently(),
      h.session.renewSilently(),
      h.session.renewSilently(),
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
    // Nor does asking for one: a fresh token must not spend a navigation on every reconnect.
    await h.session.renewSilently();
    expect(h.navigations).toHaveLength(0);
  });

  /**
   * `offline-session-expiry` Acceptance Scenario S01, browser half – **the negative that makes the
   * whole feature true**. An expired token yields no credential and nothing else happens.
   *
   * Asserted on the navigation seam rather than on anything rendered. A test that checked "the
   * schedule still appeared" would pass just as well against a `location.assign` that jsdom
   * silently ignored, which is precisely how this defect survived S10.
   */
  it('never navigates from the credential accessor, however stale the stored token is', async () => {
    const h = harness();
    await h.session.beginSignIn();
    const attempt = currentAttempt();
    h.queue({ status: 200, body: { idToken: 't', expiresAt: 1_800_003_600, user: ANNA } });
    await h.session.completeRedirect(`?code=c&state=${attempt.state}`);
    h.navigations.length = 0;

    // A day later: long past expiry, and past the renewal margin.
    h.setNow(1_800_090_000);

    expect(await h.session.validToken()).toBeNull();
    expect(await h.session.validToken()).toBeNull();
    expect(h.navigations).toEqual([]);
    // And no PKCE attempt was minted either – a navigation that had been prepared and not taken.
    expect(sessionStorage.getItem('confapp.auth.attempt')).toBeNull();
    // The session itself is untouched: expiry is not a lifetime bound (Structural Criteria).
    expect(h.session.current()?.user).toEqual(ANNA);
    expect(h.cleared).toEqual([]);
  });

  /**
   * A refused renewal, played back for a given error code.
   *
   * Google returns `state` with its errors too, and a refusal only counts when it provably belongs
   * to the attempt this browser started – so the renewal is driven through the real entry point
   * and its own `state` is echoed back.
   */
  async function refusedRenewal(code: string): Promise<{ h: Harness; outcome: SignInOutcome }> {
    const h = harness();
    await h.session.beginSignIn();
    const first = currentAttempt();
    h.queue({ status: 200, body: { idToken: 't', expiresAt: 1_800_003_600, user: ANNA } });
    await h.session.completeRedirect(`?code=c&state=${first.state}`);

    h.setNow(1_800_090_000);
    await h.session.renewSilently();
    const renewal = currentAttempt();

    return {
      h,
      outcome: await h.session.completeRedirect(`?error=${code}&state=${renewal.state}`),
    };
  }

  /**
   * Acceptance Scenario S06, second half – Google refuses the **grant**, because the account was
   * deprovisioned. She is signed out with the reason, not left on a silently failing screen, and
   * the clearing hook fires so the cached schedules go with the access.
   *
   * This is `prd.md#edge-cases`' "access ends" row, and `offline-session-expiry` S08. It is the
   * direction the refusal split most easily loses: a change that simply stopped clearing would
   * leave every other test in this file green while deleting the deprovisioning behaviour
   * entirely, so it is asserted in both directions rather than one.
   */
  it('ends the session with a displayable reason when Google refuses the grant', async () => {
    const { h, outcome } = await refusedRenewal('invalid_grant');

    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(outcome.code).toBe('invalid_grant');
    expect(outcome.message).toMatch(/no longer has access/i);
    expect(outcome.message).toMatch(/\.$/);

    expect(h.session.current()).toBeNull();
    // Signed out, and the clearing hook fired for the account that is going away.
    expect(h.cleared).toEqual([{ sub: ANNA.sub, reason: 'sign-out' }]);
  });

  it('ends the session when the grant is refused outright', async () => {
    const { h, outcome } = await refusedRenewal('access_denied');

    expect(outcome.kind).toBe('failed');
    expect(h.session.current()).toBeNull();
    expect(h.cleared).toEqual([{ sub: ANNA.sub, reason: 'sign-out' }]);
  });

  /**
   * `offline-session-expiry` Acceptance Scenario S05 – the *Google session* lapsed, not the
   * employment. Nadia is still an employee and her Workspace cookie has simply expired.
   *
   * Clearing here would purge her cached schedules through the hook `AuthProvider` registers,
   * mid-conference, over something that says nothing about her access. So the stored session and
   * everything keyed to it stand, and she is asked to sign in again.
   */
  it('keeps the session and the cache when the Google session merely lapsed', async () => {
    const { h, outcome } = await refusedRenewal('login_required');

    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(outcome.code).toBe('login_required');
    // Says what to do, and does not claim access has ended.
    expect(outcome.message).toMatch(/sign in again/i);
    expect(outcome.message).not.toMatch(/no longer has access/i);

    expect(h.session.current()?.user).toEqual(ANNA);
    // The one thing that would have purged the schedule cache never fired.
    expect(h.cleared).toEqual([]);
  });

  it('keeps the session when Google needs an interaction it could not show', async () => {
    const { h, outcome } = await refusedRenewal('interaction_required');

    expect(outcome.kind).toBe('failed');
    expect(h.session.current()?.user).toEqual(ANNA);
    expect(h.cleared).toEqual([]);
  });

  /**
   * `offline-session-expiry` Acceptance Scenario S09 – the lenient default, and the reason the
   * classification is a closed list of two rather than a list of exceptions.
   *
   * `server_error` is transient far more often than it is a deprovisioning, and the two mistakes
   * do not cost the same: guessing "lapsed" wrongly leaves one departed employee reading a cached
   * schedule until its readability window closes, while guessing "deprovisioned" wrongly deletes
   * every attendee's offline schedule at once, in the middle of a conference.
   */
  it('keeps the session and the cache on an unrecognised refusal code', async () => {
    const { h, outcome } = await refusedRenewal('server_error');

    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(outcome.code).toBe('server_error');
    expect(outcome.message).toMatch(/sign in again/i);

    expect(h.session.current()?.user).toEqual(ANNA);
    expect(h.cleared).toEqual([]);
  });

  /**
   * Review 2026-08-25, H-1 – **the redirect loop, closed.**
   *
   * A refused renewal arrives *as* a page load, so `renewalStarted` and the shell's per-page ref
   * are both reborn `false` by the navigation that carried it. Reproduced the way production does
   * it: a second `createAuthSession` over the same storage, which is what the next page load
   * builds. Before the marker, that second session renews again immediately and Google refuses
   * again — to Google and back every few seconds.
   */
  it('does not start another silent renewal on the page load that follows a refusal', async () => {
    const h = harness();
    await h.session.beginSignIn();
    const first = currentAttempt();
    h.queue({ status: 200, body: { idToken: 't', expiresAt: 1_800_003_600, user: ANNA } });
    await h.session.completeRedirect(`?code=c&state=${first.state}`);

    h.setNow(1_800_090_000);
    await h.session.renewSilently();
    const renewal = currentAttempt();
    await h.session.completeRedirect(`?error=login_required&state=${renewal.state}`);
    expect(h.session.current()?.user).toEqual(ANNA);

    // The next page load: a brand-new session object over the same storage, exactly as the
    // browser produces after the refusal redirect lands.
    const next = reopened(h);
    next.navigations.length = 0;
    await next.session.renewSilently();

    expect(next.navigations).toEqual([]);
    // And it is still reported, so the shell can keep saying so rather than failing silently.
    expect(next.session.renewalRefusal()).toMatchObject({ code: 'login_required' });
  });

  /** The way out: an interactive sign-in that Google completes lifts the block. */
  it('renews again once an interactive sign-in has succeeded', async () => {
    const h = harness();
    await h.session.beginSignIn();
    const first = currentAttempt();
    h.queue({ status: 200, body: { idToken: 't', expiresAt: 1_800_003_600, user: ANNA } });
    await h.session.completeRedirect(`?code=c&state=${first.state}`);

    h.setNow(1_800_090_000);
    await h.session.renewSilently();
    const renewal = currentAttempt();
    await h.session.completeRedirect(`?error=login_required&state=${renewal.state}`);

    // She presses "Sign in again" and Google completes it.
    const next = reopened(h);
    await next.session.beginSignIn();
    const interactive = currentAttempt();
    next.queue({
      status: 200,
      body: { idToken: 'fresh', expiresAt: 1_800_180_000, user: ANNA },
    });
    await next.session.completeRedirect(`?code=c&state=${interactive.state}`);

    expect(next.session.renewalRefusal()).toBeNull();

    // And a later expiry renews silently once more, as it always did.
    next.setNow(1_800_300_000);
    next.navigations.length = 0;
    await next.session.renewSilently();
    expect(next.navigations).toHaveLength(1);
  });

  /**
   * A refusal recorded against one person must not block the next one on a shared device – and
   * signing out drops it outright, because it described a session that no longer exists.
   */
  it('does not carry one person’s refusal into the next person’s session', async () => {
    const h = harness();
    await h.session.beginSignIn();
    const first = currentAttempt();
    h.queue({ status: 200, body: { idToken: 't', expiresAt: 1_800_003_600, user: ANNA } });
    await h.session.completeRedirect(`?code=c&state=${first.state}`);

    h.setNow(1_800_090_000);
    await h.session.renewSilently();
    const renewal = currentAttempt();
    await h.session.completeRedirect(`?error=login_required&state=${renewal.state}`);
    expect(h.session.renewalRefusal()).not.toBeNull();

    h.session.signOut();
    expect(localStorage.getItem('confapp.auth.renewalRefused')).toBeNull();
  });

  /** An interactive sign-in Google refused is still just a failed sign-in – there is no session. */
  it('reports a refused interactive sign-in without inventing a renewal message', async () => {
    const h = harness();
    await h.session.beginSignIn();
    const attempt = currentAttempt();

    const outcome = await h.session.completeRedirect(`?error=access_denied&state=${attempt.state}`);

    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(outcome.message).toMatch(/did not complete the sign-in/i);
    expect(h.cleared).toEqual([]);
  });

  /**
   * Review 2026-08-25, M-2. **Cancelling a dialog is not a refused grant.**
   *
   * `access_denied` is what Google returns when somebody closes the account chooser or declines
   * consent – and it is reachable from the two "Sign in again" controls this feature adds. Treating
   * it as a deprovisioning would clear the session and fire the hook `AuthProvider` purges the
   * whole schedule cache on, destroying every offline schedule on the device because a person
   * changed their mind. Only a *silent renewal* refused this way means access has ended.
   */
  it('keeps an established session when an interactive sign-in is cancelled', async () => {
    const h = harness();
    await h.session.beginSignIn();
    const first = currentAttempt();
    h.queue({ status: 200, body: { idToken: 't', expiresAt: 1_800_003_600, user: ANNA } });
    await h.session.completeRedirect(`?code=c&state=${first.state}`);

    // She is signed in and presses "Sign in again", then backs out of Google's chooser.
    await h.session.beginSignIn();
    const second = currentAttempt();
    const outcome = await h.session.completeRedirect(`?error=access_denied&state=${second.state}`);

    expect(outcome.kind).toBe('failed');
    // The session stands, and the cache-purging hook never fired.
    expect(h.session.current()?.user).toEqual(ANNA);
    expect(h.cleared).toEqual([]);
  });

  /**
   * Review 2026-08-25, H-2. The flag `AuthProvider` needs to tell the two events apart.
   *
   * Without it the shell keys "may the previous session stand?" on whether a session happens to
   * exist – which is true for every failure, including a stranger's refused sign-in on a shared
   * tablet.
   */
  it('marks a failed renewal as silent and every other failure as not', async () => {
    const h = harness();
    await h.session.beginSignIn();
    const first = currentAttempt();
    h.queue({ status: 200, body: { idToken: 't', expiresAt: 1_800_003_600, user: ANNA } });
    await h.session.completeRedirect(`?code=c&state=${first.state}`);

    h.setNow(1_800_090_000);
    await h.session.renewSilently();
    const renewal = currentAttempt();
    const renewalRefusal = await h.session.completeRedirect(
      `?error=login_required&state=${renewal.state}`,
    );
    expect(renewalRefusal).toMatchObject({ kind: 'failed', silent: true });

    // An interactive attempt refused the same way is not.
    await h.session.beginSignIn();
    const interactive = currentAttempt();
    const interactiveRefusal = await h.session.completeRedirect(
      `?error=login_required&state=${interactive.state}`,
    );
    expect(interactiveRefusal).toMatchObject({ kind: 'failed', silent: false });
  });

  /**
   * A crafted link arriving *while a renewal is genuinely in flight* is still not a renewal
   * outcome — the mismatch is rejected on the `state` check before `silent` is ever consulted.
   *
   * Its own harness, and deliberately so: only one renewal may start per page load
   * (`renewalStarted`), so a second `renewSilently()` in the test above is a no-op and would leave
   * no attempt for the crafted link to miss. Starting it with `beginSignIn()` instead would leave
   * `attempt.silent` false already, and the assertion would pass whatever the branch did.
   */
  it('does not let a crafted refusal pass itself off as the renewal in flight', async () => {
    const h = harness();
    await h.session.beginSignIn();
    const first = currentAttempt();
    h.queue({ status: 200, body: { idToken: 't', expiresAt: 1_800_003_600, user: ANNA } });
    await h.session.completeRedirect(`?code=c&state=${first.state}`);

    h.setNow(1_800_090_000);
    await h.session.renewSilently();
    // An attempt with `silent: true` is now stored, and this link does not match it.
    expect(JSON.parse(sessionStorage.getItem('confapp.auth.attempt')!).silent).toBe(true);

    const mismatched = await h.session.completeRedirect('?error=login_required&state=attacker');

    expect(mismatched).toMatchObject({
      kind: 'failed',
      code: 'SIGN_IN_STATE_MISMATCH',
      silent: false,
    });
    expect(h.session.current()?.user).toEqual(ANNA);
    expect(h.cleared).toEqual([]);
  });

  /**
   * Review 2026-08-25, F-1. A renewal that reaches Google and then cannot reach **our** API.
   *
   * It is still a renewal, and saying otherwise sends the shell to the signed-out screen and takes
   * the cached Schedule off a device that may have no network — on Capacitor the SPA is served from
   * the local bundle, so the redirect can complete with no connectivity at all.
   */
  it('reports a renewal whose token exchange could not reach the API as silent', async () => {
    const h = harness();
    await h.session.beginSignIn();
    const first = currentAttempt();
    h.queue({ status: 200, body: { idToken: 't', expiresAt: 1_800_003_600, user: ANNA } });
    await h.session.completeRedirect(`?code=c&state=${first.state}`);

    h.setNow(1_800_090_000);
    await h.session.renewSilently();
    const renewal = currentAttempt();

    // Nothing queued, so the harness's fetch rejects – the transport failing, not the API refusing.
    const outcome = await h.session.completeRedirect(`?code=fresh&state=${renewal.state}`);

    expect(outcome).toMatchObject({ kind: 'failed', code: 'NETWORK_UNREACHABLE', silent: true });
    // The session was never cleared, so the shell has something to keep rendering.
    expect(h.session.current()?.user).toEqual(ANNA);
    expect(h.cleared).toEqual([]);
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
