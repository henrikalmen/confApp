import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConferencesPanel } from '../src/components/ConferencesPanel.tsx';
import type { Conference } from '../src/api/client.ts';

/**
 * TI11 – the organizer surfaces: the list marks archived conferences, the create form shows the
 * server's field-level messages inline, and a refused lifecycle action shows the server's own
 * sentence rather than a generic error.
 *
 * The API is driven at the `fetch` boundary, so the real client module – envelope parsing, field
 * details, the request shape – is exercised rather than mocked past.
 */

const DRAFT: Conference = {
  id: 'conf-draft',
  name: 'Autumn Kickoff 2026',
  startDate: '2026-09-14',
  endDate: '2026-09-16',
  lifecycleState: 'draft',
  updatedAt: '2026-08-17T10:00:00.000Z',
};

const ARCHIVED: Conference = {
  id: 'conf-archived',
  name: 'Spring Retro 2025',
  startDate: '2025-04-01',
  endDate: '2025-04-02',
  lifecycleState: 'archived',
  updatedAt: '2025-04-03T10:00:00.000Z',
};

interface Route {
  status: number;
  body: unknown;
}

/** Routes by `METHOD /path`, so a test states only the calls it cares about. */
function routeFetch(routes: Record<string, Route>): typeof fetch {
  return vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const path = url.replace(/^.*\/api/, '');
    const route = routes[`${method} ${path}`];

    if (route === undefined) {
      throw new Error(`No route stubbed for ${method} ${path}.`);
    }
    return new Response(JSON.stringify(route.body), {
      status: route.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

function listing(...conferences: Conference[]): Record<string, Route> {
  return { 'GET /conferences': { status: 200, body: { conferences } } };
}

describe('ConferencesPanel', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    window.__CONFAPP_CONFIG__ = { apiBaseUrl: '/api' };
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  describe('the list', () => {
    it('shows the organizer their conferences, drafts included', async () => {
      globalThis.fetch = routeFetch(listing(DRAFT));
      render(<ConferencesPanel />);

      expect(await screen.findByText('Autumn Kickoff 2026')).toBeTruthy();
      expect(screen.getByTestId('badge-draft').textContent).toBe('Draft');
    });

    /**
     * FR9 – archived conferences are visually distinguished from active ones. The distinction has
     * to survive somebody who cannot read the badge, so it is asserted as a class the stylesheet
     * gives a different treatment, not only as the word "Archived".
     */
    it('distinguishes an archived conference from an active one by more than its label', async () => {
      globalThis.fetch = routeFetch(listing(DRAFT, ARCHIVED));
      render(<ConferencesPanel />);

      const archived = await screen.findByTestId(`conference-${ARCHIVED.id}`);
      const draft = screen.getByTestId(`conference-${DRAFT.id}`);

      expect(archived.className).toContain('conference--archived');
      expect(draft.className).not.toContain('conference--archived');

      // And the label is there too – the treatment is in addition to it, not instead of it.
      expect(screen.getByTestId('badge-archived').textContent).toBe('Archived');
    });

    /**
     * A calendar day has no timezone. Rendering through `new Date('2025-04-01')` would show 31
     * March to anyone west of UTC, so the naive string is displayed as it arrived.
     */
    it('renders the date span exactly as the API sent it', async () => {
      globalThis.fetch = routeFetch(listing(ARCHIVED));
      render(<ConferencesPanel />);

      expect(await screen.findByText('2025-04-01 – 2025-04-02')).toBeTruthy();
    });

    it('tells an organizer with no conferences what to do next', async () => {
      globalThis.fetch = routeFetch(listing());
      render(<ConferencesPanel />);

      expect((await screen.findByTestId('no-conferences')).textContent).toContain('Create one');
    });

    it('shows the envelope message when the list is refused', async () => {
      globalThis.fetch = routeFetch({
        'GET /conferences': {
          status: 503,
          body: {
            error: {
              code: 'DATABASE_UNAVAILABLE',
              message: 'The service is temporarily unable to reach its database.',
            },
          },
        },
      });
      render(<ConferencesPanel />);

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain('temporarily unable to reach its database');
    });
  });

  describe('the create form', () => {
    /**
     * Acceptance Scenario S02 (browser half) – the permitted range is shown against the date
     * field, in the server's own words. A form-level "invalid input" would satisfy neither FR1's
     * "inline" nor its "with the permitted range stated".
     */
    it('shows the permitted-range message on the date field when the span is refused', async () => {
      const message =
        'A conference runs for between 1 and 4 consecutive days, and these dates span 5.';
      globalThis.fetch = routeFetch({
        ...listing(),
        'POST /conferences': {
          status: 400,
          body: {
            error: {
              code: 'CONFERENCE_DATE_SPAN_INVALID',
              message,
              details: [
                { field: 'startDate', message },
                { field: 'endDate', message },
              ],
            },
          },
        },
      });

      render(<ConferencesPanel />);
      await screen.findByTestId('conference-form');

      await userEvent.type(screen.getByLabelText('Conference name'), 'Autumn Kickoff 2026');
      await userEvent.click(screen.getByRole('button', { name: 'Create conference' }));

      const error = await screen.findByTestId('error-dates');
      expect(error.textContent).toBe(message);
      // Attached to the control, so a screen reader reaches it from the input itself.
      expect(screen.getByLabelText('Last day').getAttribute('aria-invalid')).toBe('true');
    });

    it('shows the name message on the name field when the name is refused', async () => {
      const message = 'A conference name is required.';
      globalThis.fetch = routeFetch({
        ...listing(),
        'POST /conferences': {
          status: 400,
          body: {
            error: {
              code: 'CONFERENCE_NAME_INVALID',
              message,
              details: [{ field: 'name', message }],
            },
          },
        },
      });

      render(<ConferencesPanel />);
      await screen.findByTestId('conference-form');
      await userEvent.click(screen.getByRole('button', { name: 'Create conference' }));

      expect((await screen.findByTestId('error-name')).textContent).toBe(message);
      expect(screen.queryByTestId('error-dates')).toBeNull();
    });

    it('sends the naive date strings unchanged and adds the created conference to the list', async () => {
      const fetchSpy = routeFetch({
        ...listing(),
        'POST /conferences': { status: 200, body: DRAFT },
      });
      globalThis.fetch = fetchSpy;

      render(<ConferencesPanel />);
      await screen.findByTestId('conference-form');

      await userEvent.type(screen.getByLabelText('Conference name'), 'Autumn Kickoff 2026');
      await userEvent.type(screen.getByLabelText('First day'), '2026-09-14');
      await userEvent.type(screen.getByLabelText('Last day'), '2026-09-16');
      await userEvent.click(screen.getByRole('button', { name: 'Create conference' }));

      await waitFor(() => {
        expect(screen.getByTestId(`conference-${DRAFT.id}`)).toBeTruthy();
      });

      const post = vi
        .mocked(fetchSpy)
        .mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === 'POST');
      // No offset, no reformatting: exactly the day the organizer picked.
      expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual({
        name: 'Autumn Kickoff 2026',
        startDate: '2026-09-14',
        endDate: '2026-09-16',
      });
    });
  });

  describe('the detail view', () => {
    async function openDetail(routes: Record<string, Route>): Promise<void> {
      globalThis.fetch = routeFetch(routes);
      render(<ConferencesPanel />);
      await userEvent.click(await screen.findByText('Autumn Kickoff 2026'));
    }

    /**
     * Acceptance Scenario S03 (browser half) – the server's refusal is what the organizer reads.
     * Substituting a generic message here would discard the only explanation of what to do next.
     */
    it('renders the server refusal verbatim when a publish is refused', async () => {
      const message =
        'This conference cannot be published yet because its schedule is empty. ' +
        'Add at least one session first.';
      await openDetail({
        ...listing(DRAFT),
        'POST /conferences/conf-draft/publish': {
          status: 409,
          body: { error: { code: 'CONFERENCE_SCHEDULE_REQUIRED', message } },
        },
      });

      await userEvent.click(screen.getByTestId('publish'));

      expect((await screen.findByTestId('lifecycle-refusal')).textContent).toBe(message);
      // The conference did not move, because the server said it did not.
      expect(screen.getByTestId('detail-state').textContent).toBe('draft');
    });

    it('reflects the new state when a publish succeeds', async () => {
      await openDetail({
        ...listing(DRAFT),
        'POST /conferences/conf-draft/publish': {
          status: 200,
          body: { ...DRAFT, lifecycleState: 'published' },
        },
      });

      await userEvent.click(screen.getByTestId('publish'));

      await waitFor(() => {
        expect(screen.getByTestId('detail-state').textContent).toBe('published');
      });
      expect(screen.getByTestId('badge-published')).toBeTruthy();
    });

    /**
     * The UI may disable an affordance, but it never decides – the server refuses independently,
     * which is what Acceptance Scenario S07 checks by calling the endpoint directly.
     */
    it('offers only the transition the current state allows', async () => {
      await openDetail(listing(DRAFT));

      expect(screen.getByTestId('publish').hasAttribute('disabled')).toBe(false);
      expect(screen.getByTestId('archive').hasAttribute('disabled')).toBe(true);
    });

    it('marks an archived conference read-only and offers neither action', async () => {
      globalThis.fetch = routeFetch(listing(ARCHIVED));
      render(<ConferencesPanel />);
      await userEvent.click(await screen.findByText('Spring Retro 2025'));

      const detail = screen.getByTestId('conference-detail');
      expect(detail.className).toContain('conference--archived');
      expect(screen.getByTestId('archived-note').textContent).toContain('nothing has been deleted');

      expect(screen.getByTestId('publish').hasAttribute('disabled')).toBe(true);
      expect(screen.getByTestId('archive').hasAttribute('disabled')).toBe(true);
    });
  });
});
