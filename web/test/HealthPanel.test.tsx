import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { HealthPanel } from '../src/components/HealthPanel.tsx';

function respondWith(status: number, body: unknown): typeof fetch {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  ) as unknown as typeof fetch;
}

describe('HealthPanel', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    window.__CONFAPP_CONFIG__ = { apiBaseUrl: '/api' };
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /**
   * Acceptance Scenario S01 (browser half) – the page displays the schema version and server
   * timestamp the API returned, which is the visible end of the SPA -> API -> PostgreSQL path.
   */
  it('renders the schema version and server time the API returned', async () => {
    globalThis.fetch = respondWith(200, {
      status: 'ok',
      schemaVersion: '42',
      serverTime: '2026-08-16T10:20:30.000Z',
    });

    render(<HealthPanel />);

    await waitFor(() => {
      expect(screen.getByTestId('schema-version').textContent).toBe('42');
    });
    expect(screen.getByTestId('server-time').textContent).toBe('2026-08-16T10:20:30.000Z');
  });

  it('requests the API through the runtime-configured base URL', async () => {
    window.__CONFAPP_CONFIG__ = { apiBaseUrl: 'https://api.example.com/api' };
    const fetchSpy = respondWith(200, {
      status: 'ok',
      schemaVersion: '1',
      serverTime: '2026-08-16T10:20:30.000Z',
    });
    globalThis.fetch = fetchSpy;

    render(<HealthPanel />);

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });
    expect(vi.mocked(fetchSpy).mock.calls[0]?.[0]).toBe('https://api.example.com/api/health');
  });

  /**
   * Acceptance Scenario S04 (browser half) – the envelope's `message` is what the user sees,
   * which is why it has to be a displayable sentence rather than a status word.
   */
  it('shows the error envelope message when the API refuses', async () => {
    globalThis.fetch = respondWith(503, {
      error: {
        code: 'DATABASE_UNAVAILABLE',
        message:
          'The service is temporarily unable to reach its database. Please try again shortly.',
      },
    });

    render(<HealthPanel />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('temporarily unable to reach its database');
    expect(alert.textContent).toContain('DATABASE_UNAVAILABLE');
    expect(screen.queryByTestId('schema-version')).toBeNull();
  });

  it('shows a displayable message when the API cannot be reached at all', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;

    render(<HealthPanel />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('could not reach the server');
  });
});
