import 'fake-indexeddb/auto';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IDBFactory } from 'fake-indexeddb';
import { AuthProvider, useAuth } from '../src/auth/AuthProvider.tsx';
import { createAuthSession, type AuthSession, type StoredSession } from '../src/auth/session.ts';
import {
  adoptCacheOwner,
  cachedKeys,
  setCacheIdentity,
  writeCachedSchedule,
  type CachedSchedule,
} from '../src/offline/schedule-cache.ts';
import type { WebAuthConfig } from '../src/config.ts';
import type { AttendeeSchedule } from '../src/api/client.ts';

/**
 * TI01, TI03 and TI06 – the session lifetime bound as the app actually applies it, and the switch
 * control beside the identity.
 *
 * The **real** session module is driven rather than a stub, and the bound is reached the way a
 * launch reaches it: through `AuthProvider`'s restore path. A test that called the predicate itself
 * would prove the predicate works and nothing about whether a launch consults it – which is the
 * whole of TI03. The cache is inspected directly as well as the screen, because an expired bound is
 * specified as a data boundary and a screen that merely declines to draw is the failure mode.
 */

const config: WebAuthConfig = {
  clientId: 'web-111.apps.googleusercontent.example',
  authorizationEndpoint: 'https://accounts.google.example/o/oauth2/v2/auth',
  hostedDomain: 'ourcompany.example',
  redirectUri: 'http://localhost:8082/auth/callback',
};

const NADIA = { sub: 'google-sub-nadia', email: 'nadia@ourcompany.example', displayName: 'Nadia' };

const DAY = 86_400_000;
/** The instant Nadia signs in, in device-clock milliseconds. 15 September 2026. */
const SIGN_IN = Date.UTC(2026, 8, 15, 7, 40, 12, 345);

/** The ID token's lifetime, so a day later it is stale and a renewal is due. */
const TOKEN_EXPIRES_AT = Math.floor(SIGN_IN / 1000) + 3600;

interface Harness {
  session: AuthSession;
  queue(response: { status: number; body: unknown }): void;
  navigations: string[];
}

function harness(): Harness {
  const responses: { status: number; body: unknown }[] = [];
  const navigations: string[] = [];

  const fetchImpl = (async () => {
    const next = responses.shift();
    if (next === undefined) throw new Error('No queued response');
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  return {
    /*
     * The module's own `now` is left at its default, which reads `Date.now()` – the same source the
     * bound's device clock reads. `setNow` moves that one clock, so the session's view of expiry and
     * the bound's view of elapsed time can never drift apart inside a test the way two injected
     * clocks would let them.
     */
    session: createAuthSession({
      config,
      navigate: (url) => navigations.push(url),
      fetchImpl,
      apiBaseUrl: '/api',
    }),
    queue: (response) => responses.push(response),
    navigations,
  };
}

/** Moves the single clock every part of this feature reads. */
function setNow(millis: number): void {
  vi.spyOn(Date, 'now').mockReturnValue(millis);
}

function redirectFor(): string {
  const raw = sessionStorage.getItem('confapp.auth.attempt');
  const attempt = JSON.parse(raw!) as { state: string };
  return `?code=auth-code&state=${attempt.state}`;
}

/** A cached schedule for a conference ending on `endDate`, synced on `syncedOn`. */
function envelope(options: { endDate: string; syncedOn: string }): AttendeeSchedule {
  return {
    conference: {
      id: 'kickoff',
      name: 'Kickoff 2026',
      startDate: options.endDate,
      endDate: options.endDate,
      state: 'published',
      lastUpdatedAt: `${options.syncedOn}T08:00:00.000000Z`,
    },
    days: [{ date: options.endDate, dayNumber: 1, sessions: [] }],
    serverNow: {
      instant: `${options.syncedOn}T07:40:12.345678Z`,
      day: options.syncedOn,
      time: '09:40',
    },
  } as unknown as AttendeeSchedule;
}

/** Signs Nadia in through the real redirect exchange, leaving a stored session behind. */
async function signIn(h: Harness): Promise<void> {
  await h.session.beginSignIn();
  h.queue({ status: 200, body: { idToken: 'id-token', expiresAt: TOKEN_EXPIRES_AT, user: NADIA } });
  await h.session.completeRedirect(redirectFor());
  h.navigations.length = 0;
}

/** A cache entry for a conference ending on `endDate`, received at the sign-in reading. */
function cached(options: { endDate: string; syncedOn: string }): CachedSchedule {
  const value = envelope(options);
  return {
    envelope: value,
    watermark: value.conference.lastUpdatedAt,
    deviceClockAtReceipt: SIGN_IN,
  };
}

/**
 * Puts a cached schedule on the device the way the app does – **owner first**.
 *
 * `adoptCacheOwner` fails closed: a store with no recorded owner is purged on the next claim, on
 * the reasoning that an absent marker is not evidence the store is empty. So a test that writes an
 * entry without claiming ownership seeds a state production never reaches, and the launch it is
 * about to exercise deletes the entry before the assertion runs – leaving every "and the cache is
 * gone" assertion true for the wrong reason.
 */
async function seedCache(options: { endDate: string; syncedOn: string }): Promise<void> {
  setCacheIdentity(() => NADIA.sub);
  await adoptCacheOwner(NADIA.sub);
  await writeCachedSchedule(NADIA.sub, 'kickoff', cached(options));
  // Proven present before the scenario runs, so a later "length 0" cannot pass vacuously.
  expect(await cachedKeys()).toHaveLength(1);
}

function storedSession(): StoredSession | null {
  const raw = localStorage.getItem('confapp.auth.session');
  return raw === null ? null : (JSON.parse(raw) as StoredSession);
}

/** The shell reduced to what these scenarios assert on, plus the switch control from `App`. */
function Shell(): React.JSX.Element {
  const { state, signIn: startSignIn, signOut } = useAuth();
  const online = navigator.onLine;
  return (
    <>
      <span data-testid="who">{state.kind === 'signed-in' ? state.user.sub : 'nobody'}</span>
      <span data-testid="kind">{state.kind}</span>
      {state.kind === 'signed-out' && state.error !== undefined ? (
        <span data-testid="reason">{state.error.message}</span>
      ) : null}
      <button
        type="button"
        data-testid="switch-account"
        onClick={() => {
          if (!online) return;
          signOut();
          startSignIn();
        }}
      >
        Not you?
      </button>
    </>
  );
}

function renderApp(session: AuthSession) {
  return render(
    <AuthProvider session={session} initialSearch="">
      <Shell />
    </AuthProvider>,
  );
}

beforeEach(() => {
  setNow(SIGN_IN);
  globalThis.indexedDB = new IDBFactory();
  window.__CONFAPP_CONFIG__ = { apiBaseUrl: '/api' };
  localStorage.clear();
  sessionStorage.clear();
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  setCacheIdentity(() => null);
});

describe('the sign-in reading a session carries', () => {
  it('is stamped at sign-in and is not the token expiry', async () => {
    const h = harness();
    await signIn(h);

    const stored = storedSession();
    expect(stored?.signedInAt).toBe(SIGN_IN - (SIGN_IN % 1000));
    expect(stored?.signedInAt).not.toBe(stored?.expiresAt);
  });

  /**
   * The hole this closes: restamping on every silent renewal pushes the horizon out roughly hourly
   * for anyone using the app, which is an unbounded session wearing a bound's clothes.
   */
  it('survives a silent renewal rather than being pushed forward by it', async () => {
    const h = harness();
    await signIn(h);
    const original = storedSession()!.signedInAt;

    // A day later the token is stale, so a renewal runs and stores a fresh session.
    setNow(SIGN_IN + DAY);
    await h.session.renewSilently();
    h.queue({
      status: 200,
      body: { idToken: 'renewed', expiresAt: TOKEN_EXPIRES_AT + 3600, user: NADIA },
    });
    await h.session.completeRedirect(redirectFor());

    expect(storedSession()!.idToken).toBe('renewed');
    expect(storedSession()!.signedInAt).toBe(original);
  });

  it('is restamped by an interactive sign-in, which is somebody proving who they are', async () => {
    const h = harness();
    await signIn(h);
    const original = storedSession()!.signedInAt;

    setNow(SIGN_IN + DAY);
    await h.session.beginSignIn();
    h.queue({
      status: 200,
      body: { idToken: 'fresh', expiresAt: TOKEN_EXPIRES_AT + 3600, user: NADIA },
    });
    await h.session.completeRedirect(redirectFor());

    expect(storedSession()!.signedInAt).toBeGreaterThan(original);
  });

  /**
   * TI01's other half: devices already signed in when this shipped carry no reading at all. They
   * must not be signed out on deploy, and must not become unbounded either – so the value is
   * stamped once and written back, and every later read sees the same one.
   */
  it('is backfilled exactly once for a session written before the field existed', async () => {
    const h = harness();
    await signIn(h);

    // A session as an earlier build left it.
    const legacy = storedSession()! as StoredSession & { signedInAt?: number };
    delete legacy.signedInAt;
    localStorage.setItem('confapp.auth.session', JSON.stringify(legacy));

    setNow(SIGN_IN + DAY);
    const first = h.session.current()!.signedInAt;
    expect(Number.isFinite(first)).toBe(true);

    // Two further reads, with the clock moved on again: the stored value must not follow it.
    setNow(SIGN_IN + 3 * DAY);
    expect(h.session.current()!.signedInAt).toBe(first);
    setNow(SIGN_IN + 5 * DAY);
    expect(h.session.current()!.signedInAt).toBe(first);
    expect(storedSession()!.signedInAt).toBe(first);
  });
});

describe('a launch inside the bound', () => {
  it('restores the session and leaves the cached schedule alone', async () => {
    const h = harness();
    await signIn(h);
    await seedCache({ endDate: '2026-09-18', syncedOn: '2026-09-15' });

    // The 20th: two days past the conference, well inside the seven-day margin.
    setNow(SIGN_IN + 5 * DAY);
    renderApp(h.session);

    await waitFor(() => expect(screen.getByTestId('who').textContent).toBe(NADIA.sub));
    expect(await cachedKeys()).toHaveLength(1);
  });
});

describe('a launch past the bound', () => {
  /**
   * The expiry is specified as a data boundary, so the cache is asserted directly. A screen that
   * declines to draw while the entry survives in IndexedDB is the precise failure being excluded.
   */
  it('clears the session, purges the cache, and says why', async () => {
    const h = harness();
    await signIn(h);
    await seedCache({ endDate: '2026-09-18', syncedOn: '2026-09-15' });

    // The 26th: eight days past the conference's last day, so past end + margin.
    setNow(SIGN_IN + 11 * DAY);
    renderApp(h.session);

    await waitFor(() => expect(screen.getByTestId('kind').textContent).toBe('signed-out'));
    expect(screen.getByTestId('reason').textContent).toMatch(/sign-in has expired/i);
    expect(storedSession()).toBeNull();
    await waitFor(async () => expect(await cachedKeys()).toHaveLength(0));
  });

  it('signs out somebody who joined nothing once the sign-in margin has passed', async () => {
    const h = harness();
    await signIn(h);

    setNow(SIGN_IN + 8 * DAY);
    renderApp(h.session);

    await waitFor(() => expect(screen.getByTestId('kind').textContent).toBe('signed-out'));
    expect(storedSession()).toBeNull();
  });

  it('keeps a session alive on a conference that has not ended, however old the sign-in', async () => {
    const h = harness();
    await signIn(h);
    await seedCache({ endDate: '2026-10-30', syncedOn: '2026-09-15' });

    // Twenty days on: long past sign-in + 7, and the conference is still ahead.
    setNow(SIGN_IN + 20 * DAY);
    renderApp(h.session);

    await waitFor(() => expect(screen.getByTestId('who').textContent).toBe(NADIA.sub));
    expect(storedSession()).not.toBeNull();
  });
});

describe('the switch control', () => {
  it('signs the current person out, purges, and starts a fresh sign-in', async () => {
    const h = harness();
    await signIn(h);
    await seedCache({ endDate: '2026-09-18', syncedOn: '2026-09-15' });

    setNow(SIGN_IN + DAY);
    renderApp(h.session);
    await waitFor(() => expect(screen.getByTestId('who').textContent).toBe(NADIA.sub));

    await userEvent.click(screen.getByTestId('switch-account'));

    await waitFor(() => expect(storedSession()).toBeNull());
    await waitFor(async () => expect(await cachedKeys()).toHaveLength(0));
    await waitFor(() => expect(h.navigations).toHaveLength(1));
    expect(h.navigations[0]).toContain(config.authorizationEndpoint);
  });

  /**
   * Signing out with no connection would clear the session and then fail to reach Google for the
   * replacement – a device left with neither a session nor a way to get one, and the cached
   * schedule the previous person was reading gone with it.
   */
  it('refuses while offline and leaves the existing session exactly as it was', async () => {
    const h = harness();
    await signIn(h);
    await seedCache({ endDate: '2026-09-18', syncedOn: '2026-09-15' });

    setNow(SIGN_IN + DAY);
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    renderApp(h.session);
    await waitFor(() => expect(screen.getByTestId('who').textContent).toBe(NADIA.sub));

    await userEvent.click(screen.getByTestId('switch-account'));

    expect(storedSession()).not.toBeNull();
    expect(screen.getByTestId('who').textContent).toBe(NADIA.sub);
    expect(await cachedKeys()).toHaveLength(1);
    expect(h.navigations).toHaveLength(0);
  });
});
