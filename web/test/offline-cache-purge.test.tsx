import 'fake-indexeddb/auto';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IDBFactory } from 'fake-indexeddb';
import { AuthProvider, useAuth } from '../src/auth/AuthProvider.tsx';
import { createAuthSession, type AuthSession } from '../src/auth/session.ts';
import { AttendeeSchedulePanel } from '../src/attendee/AttendeeSchedulePanel.tsx';
import {
  cacheIdentity,
  cacheOwner,
  cachedKeys,
  readCachedSchedule,
  setCacheIdentity,
  writeCachedSchedule,
} from '../src/offline/schedule-cache.ts';
import type { WebAuthConfig } from '../src/config.ts';
import type { AttendeeSchedule } from '../src/api/client.ts';

/**
 * S10 Acceptance Scenario S06 – a shared tablet shows the next employee nothing of the previous one.
 *
 * **A privacy requirement, not cleanup.** The assertions therefore inspect the underlying store as
 * well as the screen: a rendering that merely hides Anna's conference while the entry survives in
 * IndexedDB is exactly the failure this scenario exists to catch, and it would pass a UI-only test
 * (FIS → Testing Strategy).
 *
 * The **real** session module is driven, not a stub, and the purge is registered the way the app
 * registers it – through `AuthProvider`, on S02's own sign-out / user-switch hook. A test that
 * called the purge itself would prove the purge works and nothing about whether anything calls it.
 */

const config: WebAuthConfig = {
  clientId: 'web-111.apps.googleusercontent.example',
  authorizationEndpoint: 'https://accounts.google.example/o/oauth2/v2/auth',
  hostedDomain: 'ourcompany.example',
  redirectUri: 'http://localhost:8082/auth/callback',
};

const ANNA = { sub: 'google-sub-anna', email: 'anna@ourcompany.example', displayName: 'Anna' };
const BJORN = { sub: 'google-sub-bjorn', email: 'bjorn@ourcompany.example', displayName: 'Björn' };

const KICKOFF = '11111111-1111-4111-8111-111111111111';

function envelope(): AttendeeSchedule {
  return {
    conference: {
      id: KICKOFF,
      name: 'Kickoff 2026',
      startDate: '2026-09-15',
      endDate: '2026-09-16',
      state: 'published',
      lastUpdatedAt: '2026-09-15T08:00:00.000000Z',
    },
    days: [
      {
        date: '2026-09-15',
        dayNumber: 1,
        sessions: [
          {
            id: 'keynote',
            title: 'Opening Keynote',
            description: null,
            kind: 'Presentation',
            startTime: '09:00',
            endTime: '10:30',
            location: 'Main Hall',
            concurrentWith: [],
          },
        ],
      },
    ],
    serverNow: { instant: '2026-09-15T07:40:12.345678Z', day: '2026-09-15', time: '09:40' },
  };
}

interface Harness {
  session: AuthSession;
  queue(response: { status: number; body: unknown }): void;
}

function harness(): Harness {
  const responses: { status: number; body: unknown }[] = [];

  const fetchImpl = (async () => {
    const next = responses.shift();
    if (next === undefined) throw new Error('No queued response');
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  return {
    session: createAuthSession({
      config,
      navigate: () => {},
      fetchImpl,
      now: () => 1_800_000_000,
      apiBaseUrl: '/api',
    }),
    queue: (response) => responses.push(response),
  };
}

/** The redirect Google would send back, played into the attempt the SPA just stored. */
function redirectFor(): string {
  const raw = sessionStorage.getItem('confapp.auth.attempt');
  const attempt = JSON.parse(raw!) as { state: string };
  return `?code=auth-code&state=${attempt.state}`;
}

function tokenResponse(user: typeof ANNA): { status: number; body: unknown } {
  return { status: 200, body: { idToken: 'id-token', expiresAt: 1_900_000_000, user } };
}

/** The shell, with the way out in it – so sign-out is the app's own path and not a direct call. */
function Shell(): React.JSX.Element {
  const { state, signOut } = useAuth();
  return (
    <>
      <button type="button" data-testid="sign-out" onClick={signOut}>
        Sign out
      </button>
      <span data-testid="who">{state.kind === 'signed-in' ? state.user.sub : 'nobody'}</span>
      <AttendeeSchedulePanel />
    </>
  );
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  window.__CONFAPP_CONFIG__ = { apiBaseUrl: '/api' };
  Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  setCacheIdentity(() => null);
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

describe('signing out on a shared tablet', () => {
  it('leaves no cached schedule in storage and nothing on screen', async () => {
    const { session, queue } = harness();

    // Anna signs in, and her Kickoff schedule is cached and readable offline.
    await session.beginSignIn();
    queue(tokenResponse(ANNA));

    render(
      <AuthProvider session={session} initialSearch={redirectFor()}>
        <Shell />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('who').textContent).toBe(ANNA.sub));
    // The identity the cache keys on comes from the session, through the provider.
    expect(cacheIdentity()).toBe(ANNA.sub);

    await writeCachedSchedule(ANNA.sub, KICKOFF, {
      envelope: envelope(),
      watermark: '2026-09-15T08:00:00.000000Z',
      deviceClockAtReceipt: Date.now(),
    });
    expect(await cachedKeys()).toHaveLength(1);

    await userEvent.click(screen.getByTestId('sign-out'));

    // The store, not the screen: an entry that survived here is the failure.
    await waitFor(async () => expect(await cachedKeys()).toEqual([]));
    expect(await readCachedSchedule(ANNA.sub, KICKOFF)).toBeNull();
    expect(screen.getByTestId('who').textContent).toBe('nobody');
  });
});

describe('a different employee signing in after the app was killed', () => {
  it('finds no conference name, session title or timestamp of the previous signer', async () => {
    // Anna's session ended without a clean sign-out: her rows are in the store and the device
    // remembers her as the last subject, exactly as a killed app leaves things.
    localStorage.setItem('confapp.auth.lastSub', ANNA.sub);
    await writeCachedSchedule(ANNA.sub, KICKOFF, {
      envelope: envelope(),
      watermark: '2026-09-15T08:00:00.000000Z',
      deviceClockAtReceipt: Date.now(),
    });
    expect(await cachedKeys()).toHaveLength(1);

    const { session, queue } = harness();
    await session.beginSignIn();
    queue(tokenResponse(BJORN));

    render(
      <AuthProvider session={session} initialSearch={redirectFor()}>
        <Shell />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('who').textContent).toBe(BJORN.sub));

    // Driven by the signed-in identity differing, not by a sign-out having happened.
    await waitFor(async () => expect(await cachedKeys()).toEqual([]));
    expect(await readCachedSchedule(ANNA.sub, KICKOFF)).toBeNull();

    /*
     * And the store now names Björn. The owner record is what makes this trigger work at all - if
     * the purge and the claim raced and left it empty, the *next* different employee to sign in
     * would find nothing to compare against and this whole path would silently disarm.
     */
    await waitFor(async () => expect(await cacheOwner()).toBe(BJORN.sub));

    // And nothing of Anna's is discoverable anywhere Björn can see, offline included.
    await screen.findByTestId('schedule-unavailable-offline');
    expect(document.body.textContent).not.toContain('Kickoff 2026');
    expect(document.body.textContent).not.toContain('Opening Keynote');
    expect(document.body.textContent).not.toContain('2026-09-15');
  });
});
