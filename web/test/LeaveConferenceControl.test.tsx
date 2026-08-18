import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LeaveConferenceControl } from '../src/members/LeaveConferenceControl.tsx';

/**
 * TI08 – leaving, in the browser.
 *
 * The server side is settled in `api/test/membership.integration.test.ts`: what a revocation does
 * to the rows, and who may ask for one. What is left for this suite is the half that only exists
 * here – that the destructive act takes two deliberate steps and that the *first* one sends
 * nothing, that no revocation is issued or stored while offline, and that a refusal arrives in the
 * server's own words.
 *
 * The API is driven at the `fetch` boundary, so the real client module is exercised rather than
 * mocked past: a test that stubbed `leaveConference` could not tell "issued no request" from
 * "issued one to the wrong path".
 */

const CONFERENCE_ID = '11111111-1111-4111-8111-111111111111';
const LEAVE_PATH = `/conferences/${CONFERENCE_ID}/membership`;

interface Call {
  method: string;
  path: string;
}

interface Harness {
  calls: Call[];
  left: number;
}

function renderControl(
  respond: { status: number; body: unknown } = { status: 200, body: { membership: 'ended' } },
  props: { archived?: boolean } = {},
): Harness {
  const harness: Harness = { calls: [], left: 0 };

  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    harness.calls.push({
      method: init?.method ?? 'GET',
      path: String(input).replace(/^.*\/api/, ''),
    });
    return new Response(JSON.stringify(respond.body), {
      status: respond.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  render(
    <LeaveConferenceControl
      conferenceId={CONFERENCE_ID}
      conferenceName="Kickoff 2026"
      archived={props.archived ?? false}
      onLeft={() => {
        harness.left += 1;
      }}
    />,
  );
  return harness;
}

/** jsdom reports the browser as online; both states have to be stated for the offline case. */
function setOnline(online: boolean): void {
  Object.defineProperty(navigator, 'onLine', { value: online, configurable: true });
  window.dispatchEvent(new Event(online ? 'online' : 'offline'));
}

describe('LeaveConferenceControl', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    window.__CONFAPP_CONFIG__ = { apiBaseUrl: '/api' };
    setOnline(true);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    setOnline(true);
    vi.restoreAllMocks();
  });

  // ---------- Acceptance Scenario S02: a leave that is not confirmed revokes nothing ----------

  it('sends nothing on the first tap – leaving takes a second, explicit act', async () => {
    const harness = renderControl();

    await userEvent.click(screen.getByTestId('leave-conference'));

    // The confirmation names the conference, so nobody confirms leaving the wrong one.
    const confirmation = await screen.findByTestId('leave-confirm');
    expect(confirmation.textContent).toContain('Kickoff 2026');

    // And the single tap that opened it reached the server with nothing at all.
    expect(harness.calls).toEqual([]);
    expect(harness.left).toBe(0);
  });

  it('issues no request when the confirmation is cancelled, and offers the step again', async () => {
    const harness = renderControl();

    await userEvent.click(screen.getByTestId('leave-conference'));
    await userEvent.click(screen.getByTestId('leave-cancel'));

    expect(harness.calls).toEqual([]);
    expect(harness.left).toBe(0);
    // Back where it started: cancelling is not a dead end.
    expect(screen.getByTestId('leave-conference')).toBeTruthy();
    expect(screen.queryByTestId('leave-confirm')).toBeNull();
  });

  // ---------- Acceptance Scenario S01: confirming ends the membership ----------

  it('revokes the membership only once the confirming act is taken', async () => {
    const harness = renderControl();

    await userEvent.click(screen.getByTestId('leave-conference'));
    await userEvent.click(screen.getByTestId('leave-confirm-yes'));

    // One request, to this conference's membership, and it is a delete.
    expect(harness.calls).toEqual([{ method: 'DELETE', path: LEAVE_PATH }]);
    // The surrounding view is told, so what is left can be reloaded.
    expect(harness.left).toBe(1);
  });

  // ---------- FR8: leaving is not available offline, and nothing is queued ----------

  it('is unavailable offline, sends nothing, and says nothing is saved for later', async () => {
    const harness = renderControl();
    setOnline(false);

    const leave = await screen.findByTestId('leave-conference');
    expect((leave as HTMLButtonElement).disabled).toBe(true);

    // The reason, not a control that silently does nothing.
    expect(screen.getByTestId('leave-offline').textContent).toMatch(
      /nothing is saved to send later/i,
    );

    await userEvent.click(leave);
    expect(screen.queryByTestId('leave-confirm')).toBeNull();
    expect(harness.calls).toEqual([]);
  });

  it('becomes available again when the connection comes back, having queued nothing', async () => {
    const harness = renderControl();

    setOnline(false);
    // Awaited, because the state change the event drives is flushed on the next render.
    await screen.findByTestId('leave-offline');
    expect((screen.getByTestId('leave-conference') as HTMLButtonElement).disabled).toBe(true);

    setOnline(true);
    const leave = await screen.findByTestId('leave-conference');
    expect((leave as HTMLButtonElement).disabled).toBe(false);
    // Nothing was held while offline: the connection returning sends no revocation of its own.
    expect(harness.calls).toEqual([]);

    await userEvent.click(leave);
    await userEvent.click(screen.getByTestId('leave-confirm-yes'));
    expect(harness.calls).toEqual([{ method: 'DELETE', path: LEAVE_PATH }]);
  });

  // ---------- Acceptance Scenario S07 / S04: the server's refusal, verbatim ----------

  it('renders the server’s refusal in its own words and leaves the membership alone', async () => {
    const message =
      'A conference must always have at least one admin, and this is the last one. ' +
      'Make somebody else an admin first, then leave this conference.';

    renderControl({ status: 409, body: { error: { code: 'CONFERENCE_LAST_ADMIN', message } } });

    await userEvent.click(screen.getByTestId('leave-conference'));
    await userEvent.click(screen.getByTestId('leave-confirm-yes'));

    const refusal = await screen.findByTestId('leave-refusal');
    // Word for word – the API is the only thing that knows which of several refusals this is.
    expect(refusal.textContent).toBe(message);
    // And the control is offered again rather than left in a confirming state nobody can escape.
    expect(screen.getByTestId('leave-conference')).toBeTruthy();
  });

  it('is unavailable on an archived conference, and says why', async () => {
    const harness = renderControl(undefined, { archived: true });

    const leave = screen.getByTestId('leave-conference');
    expect((leave as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('leave-archived').textContent).toMatch(/archived/i);

    await userEvent.click(leave);
    expect(harness.calls).toEqual([]);
  });
});
