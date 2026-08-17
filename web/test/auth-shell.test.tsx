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
    signOut: vi.fn(),
    onSessionCleared: () => () => {},
    ...overrides,
  };
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
