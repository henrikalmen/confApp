import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../src/App.tsx';
import { AuthProvider } from '../src/auth/AuthProvider.tsx';
import { apiRequest, setTokenSource } from '../src/api/client.ts';
import type { AuthSession, StoredSession } from '../src/auth/session.ts';

/**
 * TI11 and the shell's half of Acceptance Scenarios S01 and S07: signed out there is one
 * thing to do, signed in the person's identity and the way out are both present.
 *
 * The session is a stand-in here because its own behaviour is proved in auth-session.test.ts;
 * what is under test is what the shell renders and which session calls it makes.
 */

const ANNA = {
  sub: 'google-sub-anna',
  email: 'anna@ourcompany.example',
  displayName: 'Anna Andersson',
};

function stubSession(overrides: Partial<AuthSession> = {}): AuthSession {
  const stored: StoredSession | null = null;
  return {
    current: () => stored,
    beginSignIn: vi.fn(async () => {}),
    completeRedirect: vi.fn(async () => ({ kind: 'nothing-to-do' }) as const),
    validToken: vi.fn(async () => null),
    // `AuthProvider` registers this as the renewal seam on every mount, so a stub without it
    // hands the app an `undefined` to call. Tests are outside `tsconfig`'s `include`, so nothing
    // type-checks this file – the omission was invisible until it was looked for.
    renewSilently: vi.fn(async () => {}),
    signOut: vi.fn(),
    onSessionCleared: () => () => {},
    ...overrides,
  };
}

/** A stub that is already signed in as `user` – what a shared device looks like mid-conference. */
function signedInStub(overrides: Partial<AuthSession> = {}): AuthSession {
  const stored: StoredSession = {
    idToken: 'anna-token',
    expiresAt: 4_000_000_000,
    user: ANNA,
  };
  return stubSession({ current: () => stored, ...overrides });
}

function renderApp(session: AuthSession, search = '') {
  return render(
    <AuthProvider session={session} initialSearch={search}>
      <App />
    </AuthProvider>,
  );
}

const realFetch = globalThis.fetch;

beforeEach(() => {
  window.__CONFAPP_CONFIG__ = { apiBaseUrl: '/api' };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setTokenSource(async () => null);
});

describe('the signed-out shell', () => {
  it('offers exactly one primary action: sign in with Google', async () => {
    renderApp(stubSession());

    const button = await screen.findByTestId('sign-in');
    expect(button.textContent).toMatch(/sign in with google/i);
    expect(screen.queryByTestId('sign-out')).toBeNull();
    expect(screen.queryByTestId('signed-in-identity')).toBeNull();
    // The health panel is behind sign-in; a signed-out person sees the sign-in screen only.
    expect(screen.queryByTestId('schema-version')).toBeNull();
  });

  it('starts the sign-in flow when the button is used', async () => {
    const session = stubSession();
    renderApp(session);

    await userEvent.click(await screen.findByTestId('sign-in'));

    await waitFor(() => expect(session.beginSignIn).toHaveBeenCalledTimes(1));
  });

  it('shows the reason when a redirect failed, so nobody is left on a silent screen', async () => {
    const session = stubSession({
      completeRedirect: vi.fn(async () => ({
        kind: 'failed' as const,
        code: 'AUTH_DOMAIN_NOT_ALLOWED',
        message: 'confApp is limited to company Google Workspace accounts.',
        silent: false,
      })),
    });

    renderApp(session, '?code=c&state=s');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('limited to company Google Workspace accounts');
    expect(alert.textContent).toContain('AUTH_DOMAIN_NOT_ALLOWED');
    expect(screen.getByTestId('sign-in')).toBeTruthy();
  });
});

describe('the signed-in shell', () => {
  function signedInSession(): AuthSession {
    return stubSession({
      completeRedirect: vi.fn(async () => ({
        kind: 'signed-in' as const,
        user: ANNA,
        returnTo: '/',
      })),
      current: () => ({ idToken: 'anna-token', expiresAt: 9_999_999_999, user: ANNA }),
      validToken: vi.fn(async () => 'anna-token'),
    });
  }

  /** Acceptance Scenario S01 – she is returned to confApp showing her name and email. */
  it('shows the signed-in person’s name and email', async () => {
    renderApp(signedInSession(), '?code=c&state=s');

    const identity = await screen.findByTestId('signed-in-identity');
    expect(identity.textContent).toContain('Anna Andersson');
    expect(identity.textContent).toContain('anna@ourcompany.example');
  });

  /** Acceptance Scenario S07 – the way out is present and reachable, not buried. */
  it('offers a sign-out control that ends the session', async () => {
    const session = signedInSession();
    renderApp(session, '?code=c&state=s');

    const signOut = await screen.findByTestId('sign-out');
    await userEvent.click(signOut);

    expect(session.signOut).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByTestId('sign-in')).toBeTruthy());
    expect(screen.queryByTestId('signed-in-identity')).toBeNull();
  });

  it('wires the session as the credential source for API requests', async () => {
    const session = signedInSession();
    renderApp(session, '?code=c&state=s');
    await screen.findByTestId('signed-in-identity');

    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ sub: ANNA.sub }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;

    await apiRequest('/me');

    const init = vi.mocked(fetchSpy).mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer anna-token');
  });

  it('never attaches a credential to the anonymous health route', async () => {
    const session = signedInSession();
    renderApp(session, '?code=c&state=s');
    await screen.findByTestId('signed-in-identity');

    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ status: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;

    await apiRequest('/health', { authenticated: false });

    const init = vi.mocked(fetchSpy).mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });
});

// ---------- review 2026-08-25, H-2: whose session survives a failed redirect ----------

describe('a redirect that failed while somebody was already signed in', () => {
  /**
   * **The shared-tablet case.** Anna is signed in; Björn taps "Sign in with Google", picks the
   * wrong account, and the API refuses the domain. The app must land on the signed-out screen.
   *
   * Keying the surviving-session branch on `current() !== null` alone put Björn in *Anna's*
   * session, under her name, with her conferences – the precise failure
   * `docs/specs/shared-device-session-lifetime/` exists to prevent.
   */
  it('does not hand the previous person’s session to a refused interactive sign-in', async () => {
    const session = signedInStub({
      completeRedirect: vi.fn(async () => ({
        kind: 'failed' as const,
        code: 'AUTH_DOMAIN_NOT_ALLOWED',
        message: 'That account is not on this company’s domain.',
        silent: false,
      })),
    });

    renderApp(session, '?code=c&state=s');

    await screen.findByTestId('sign-in');
    // Not signed in as anybody, and above all not as Anna.
    expect(screen.queryByTestId('signed-in-identity')).toBeNull();
    expect(screen.queryByText(ANNA.displayName)).toBeNull();
    expect(screen.queryByTestId('session-renewal-failed')).toBeNull();
  });

  /**
   * The other direction, and the one this feature exists for: a *silent renewal* Google refused
   * without ending the session leaves the app signed in, with a banner asking for a sign-in – so
   * whatever is already on the device stays readable (Acceptance Scenario S05).
   */
  it('keeps the app signed in with a banner when a silent renewal was refused', async () => {
    const session = signedInStub({
      completeRedirect: vi.fn(async () => ({
        kind: 'failed' as const,
        code: 'login_required',
        message: 'Your sign-in has expired and could not be renewed automatically.',
        silent: true,
      })),
    });

    renderApp(session, '?code=c&state=s');

    const banner = await screen.findByTestId('session-renewal-failed');
    expect(banner.textContent).toMatch(/could not be renewed/i);
    // Still signed in, so the attendee panel below it still renders its cached schedule.
    expect(screen.getByTestId('signed-in-identity').textContent).toContain(ANNA.displayName);
    expect(screen.queryByTestId('sign-in')).toBeNull();
    expect(screen.getByTestId('session-sign-in-again')).not.toBeNull();
  });
});
