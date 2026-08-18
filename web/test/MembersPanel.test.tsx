import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MembersPanel } from '../src/members/MembersPanel.tsx';

/**
 * TI11 – the Admin's member surface, in the browser.
 *
 * The server side is settled in `api/test/role-authorization.integration.test.ts`: who may change
 * what, the last-Admin rule, the three target refusals. What is left for this suite is what the
 * Admin is actually *told* and *offered* – that a role change shows immediately because the server
 * said so, that a refusal arrives in the server's own words rather than a generic banner, and that
 * an affordance which cannot work is not presented as though it can.
 *
 * The API is driven at the `fetch` boundary, so the real client module is exercised rather than
 * mocked past.
 */

interface Route {
  status: number;
  body: unknown;
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}

interface Harness {
  calls: Call[];
}

/** Routes by `METHOD /path`; a list is consumed in order with the last answer sticking. */
function routeFetch(routes: Record<string, Route | Route[]>, harness: Harness): typeof fetch {
  const queues = new Map<string, Route[]>(
    Object.entries(routes).map(([key, value]) => [
      key,
      Array.isArray(value) ? [...value] : [value],
    ]),
  );

  return vi.fn(async (input: unknown, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = String(input).replace(/^.*\/api/, '');
    harness.calls.push({
      method,
      path,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });

    const queue = queues.get(`${method} ${path}`);
    if (queue === undefined || queue.length === 0) {
      throw new Error(`No route stubbed for ${method} ${path}.`);
    }
    const route = queue.length > 1 ? queue.shift()! : queue[0]!;

    return new Response(JSON.stringify(route.body), {
      status: route.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

const CONFERENCE_ID = '11111111-1111-4111-8111-111111111111';
const KEYNOTE = '22222222-2222-4222-8222-222222222222';
const WORKSHOP = '33333333-3333-4333-8333-333333333333';
const MEMBERS_PATH = `GET /conferences/${CONFERENCE_ID}/members`;
const GRANT_PATH = `POST /conferences/${CONFERENCE_ID}/members/roles`;

const SESSIONS = [
  {
    id: KEYNOTE,
    title: 'Opening Keynote',
    kind: 'Presentation',
    day: '2026-09-14',
    startTime: '09:00',
    endTime: '10:00',
    holders: [],
  },
  {
    id: WORKSHOP,
    title: 'Design Workshop',
    kind: 'Workshop',
    day: '2026-09-14',
    startTime: '11:00',
    endTime: '12:30',
    holders: [],
  },
];

const PRIYA = {
  sub: 'google-sub-priya',
  displayName: 'Priya Raman',
  email: 'priya@ourcompany.example',
  roles: ['Admin', 'Attendee'],
  sessionIds: [] as string[],
};

const BJORN = {
  sub: 'google-sub-bjorn',
  displayName: 'Björn Lind',
  email: 'bjorn@ourcompany.example',
  roles: ['PresenterFacilitator', 'Attendee'],
  sessionIds: [KEYNOTE],
};

function roster(members: unknown[] = [PRIYA, BJORN], lifecycleState = 'published'): Route {
  return {
    status: 200,
    body: { conferenceId: CONFERENCE_ID, lifecycleState, members, sessions: SESSIONS },
  };
}

function refused(status: number, code: string, message: string): Route {
  return { status, body: { error: { code, message } } };
}

function renderPanel(routes: Record<string, Route | Route[]>, readOnly = false): Harness {
  const harness: Harness = { calls: [] };
  globalThis.fetch = routeFetch(routes, harness);
  render(<MembersPanel conferenceId={CONFERENCE_ID} readOnly={readOnly} />);
  return harness;
}

describe('MembersPanel', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    window.__CONFAPP_CONFIG__ = { apiBaseUrl: '/api' };
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  // ---------- TI11: the list shows every member's roles ----------

  it('lists every member with the roles they hold here', async () => {
    renderPanel({ [MEMBERS_PATH]: roster() });

    const priya = await screen.findByTestId(`member-${PRIYA.sub}`);
    expect(priya.textContent).toContain('Priya Raman');
    expect(priya.textContent).toContain('Admin');
    expect(priya.textContent).toContain('Attendee');

    const bjorn = screen.getByTestId(`member-${BJORN.sub}`);
    // One role, shown with both words – never as two separate roles.
    expect(bjorn.textContent).toContain('Presenter/Facilitator');
  });

  /** A member's session assignments are visible on their row. */
  it('shows each member’s session assignments on their own row', async () => {
    renderPanel({ [MEMBERS_PATH]: roster() });

    const bjorn = await screen.findByTestId(`sessions-${BJORN.sub}`);
    expect(bjorn.textContent).toContain('Opening Keynote');

    // Somebody covering nothing is told so, rather than shown an empty gap.
    expect(screen.getByTestId(`sessions-${PRIYA.sub}`).textContent).toContain('None');
  });

  // ---------- TI11: a change shows immediately, on the server's authority ----------

  it('reflects a role change as soon as it is applied', async () => {
    const granted = {
      ...PRIYA,
      // What the server reports after the grant.
      roles: ['Admin', 'PresenterFacilitator', 'Attendee'],
    };

    const harness = renderPanel({
      [MEMBERS_PATH]: roster(),
      [GRANT_PATH]: roster([granted, BJORN]),
    });

    await screen.findByTestId(`member-${PRIYA.sub}`);
    expect(screen.getByTestId(`member-${PRIYA.sub}`).textContent).not.toContain(
      'Presenter/Facilitator',
    );

    await userEvent.type(screen.getByLabelText('Company email address'), PRIYA.email);
    await userEvent.click(screen.getByTestId('grant-role'));

    // The row now shows what the server returned, not a locally patched guess.
    const priya = await screen.findByTestId(`member-${PRIYA.sub}`);
    expect(priya.textContent).toContain('Presenter/Facilitator');

    // The address is what was sent; the server is what resolves it to a person.
    expect(harness.calls[1]).toMatchObject({
      method: 'POST',
      path: `/conferences/${CONFERENCE_ID}/members/roles`,
      body: { email: PRIYA.email, role: 'PresenterFacilitator' },
    });
  });

  it('revokes a role by the member’s stable id, never by their address', async () => {
    const harness = renderPanel({
      [MEMBERS_PATH]: roster(),
      [`DELETE /conferences/${CONFERENCE_ID}/members/${BJORN.sub}/roles/PresenterFacilitator`]:
        roster([PRIYA, { ...BJORN, roles: ['Attendee'], sessionIds: [] }]),
    });

    await screen.findByTestId(`member-${BJORN.sub}`);
    await userEvent.click(screen.getByTestId(`revoke-${BJORN.sub}-PresenterFacilitator`));

    const bjorn = await screen.findByTestId(`member-${BJORN.sub}`);
    expect(bjorn.textContent).not.toContain('Presenter/Facilitator');
    // Revoking the role took its session assignments with it, as the server reported.
    expect(screen.getByTestId(`sessions-${BJORN.sub}`).textContent).toContain('None');

    expect(harness.calls[1]!.path).toContain(BJORN.sub);
    expect(harness.calls[1]!.path).not.toContain('@');
  });

  /** Attendee comes from membership – leaving is a separate action and is not offered here. */
  it('offers no way to remove the attendee role', async () => {
    renderPanel({ [MEMBERS_PATH]: roster() });
    await screen.findByTestId(`member-${PRIYA.sub}`);

    expect(screen.queryByTestId(`revoke-${PRIYA.sub}-Attendee`)).toBeNull();
    expect(screen.queryByTestId(`revoke-${PRIYA.sub}-Admin`)).not.toBeNull();
  });

  // ---------- TI11: the server's sentence, verbatim ----------

  it('shows the server’s own message when the last admin cannot be removed', async () => {
    const message =
      'A conference must always have at least one admin, and this is the last one. ' +
      'Make somebody else an admin first, then remove this role.';

    renderPanel({
      [MEMBERS_PATH]: roster([PRIYA]),
      [`DELETE /conferences/${CONFERENCE_ID}/members/${PRIYA.sub}/roles/Admin`]: refused(
        409,
        'CONFERENCE_LAST_ADMIN',
        message,
      ),
    });

    await screen.findByTestId(`member-${PRIYA.sub}`);
    await userEvent.click(screen.getByTestId(`revoke-${PRIYA.sub}-Admin`));

    const refusal = await screen.findByTestId('members-refusal');
    // The whole sentence, not a generic "something went wrong".
    expect(refusal.textContent).toBe(message);

    // And the role is still on screen, because nothing changed.
    expect(screen.getByTestId(`member-${PRIYA.sub}`).textContent).toContain('Admin');
  });

  it('shows the server’s own message when the target has never signed in', async () => {
    const message =
      'Nobody has signed in to confApp as lars@ourcompany.example yet. Ask them to sign in ' +
      'once with their company Google account, then assign the role.';

    renderPanel({
      [MEMBERS_PATH]: roster(),
      [GRANT_PATH]: refused(409, 'ROLE_TARGET_NOT_SIGNED_IN', message),
    });

    await screen.findByTestId('grant-form');
    await userEvent.type(screen.getByLabelText('Company email address'), 'lars@ourcompany.example');
    await userEvent.click(screen.getByTestId('grant-role'));

    expect((await screen.findByTestId('members-refusal')).textContent).toBe(message);
  });

  it('shows the server’s own message when an address names two accounts', async () => {
    const message =
      'More than one confApp account currently uses shared@ourcompany.example, so it does not ' +
      'identify one person. Pick them from the member list instead.';

    renderPanel({
      [MEMBERS_PATH]: roster(),
      [GRANT_PATH]: refused(409, 'ROLE_TARGET_AMBIGUOUS', message),
    });

    await screen.findByTestId('grant-form');
    await userEvent.type(
      screen.getByLabelText('Company email address'),
      'shared@ourcompany.example',
    );
    await userEvent.click(screen.getByTestId('grant-role'));

    expect((await screen.findByTestId('members-refusal')).textContent).toBe(message);
  });

  it('reports an unreachable server without inventing a refusal reason', async () => {
    globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') {
        return new Response(
          JSON.stringify({
            conferenceId: CONFERENCE_ID,
            lifecycleState: 'published',
            members: [PRIYA, BJORN],
            sessions: SESSIONS,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      void input;
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;

    render(<MembersPanel conferenceId={CONFERENCE_ID} />);
    await screen.findByTestId(`member-${PRIYA.sub}`);

    await userEvent.click(screen.getByTestId(`revoke-${PRIYA.sub}-Admin`));

    const refusal = await screen.findByTestId('members-refusal');
    expect(refusal.textContent).toMatch(/could not reach the server/i);
  });

  // ---------- TI11: affordances that cannot work are not offered ----------

  /**
   * Assigning a session requires the presenter/facilitator role, so it is offered only to holders.
   * The server refuses anybody else regardless – this is a hint, not the guard.
   */
  it('offers the assign control only to presenter/facilitators', async () => {
    renderPanel({ [MEMBERS_PATH]: roster() });
    await screen.findByTestId(`member-${BJORN.sub}`);

    expect(screen.queryByTestId(`assign-${BJORN.sub}`)).not.toBeNull();
    expect(screen.queryByTestId(`assign-${PRIYA.sub}`)).toBeNull();
  });

  it('assigns the chosen session and reflects the server’s answer', async () => {
    const assigned = { ...BJORN, sessionIds: [KEYNOTE, WORKSHOP] };
    const harness = renderPanel({
      [MEMBERS_PATH]: roster(),
      [`POST /conferences/${CONFERENCE_ID}/sessions/${WORKSHOP}/assignments`]: roster([
        PRIYA,
        assigned,
      ]),
    });

    await screen.findByTestId(`member-${BJORN.sub}`);

    // Only the session they do not already cover is offered.
    const select = screen.getByLabelText('Assign a session') as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual(['', WORKSHOP]);

    await userEvent.selectOptions(select, WORKSHOP);
    await userEvent.click(screen.getByTestId(`assign-${BJORN.sub}`));

    const sessions = await screen.findByTestId(`sessions-${BJORN.sub}`);
    expect(sessions.textContent).toContain('Design Workshop');

    expect(harness.calls[1]).toMatchObject({
      method: 'POST',
      body: { userSub: BJORN.sub },
    });
  });

  // ---------- an archived conference stays readable ----------

  it('shows the roster of an archived conference but offers no changes', async () => {
    renderPanel({ [MEMBERS_PATH]: roster([PRIYA, BJORN], 'archived') }, true);

    // Nothing has been deleted – who ran what is still on screen.
    const bjorn = await screen.findByTestId(`member-${BJORN.sub}`);
    expect(bjorn.textContent).toContain('Presenter/Facilitator');
    expect(screen.getByTestId(`sessions-${BJORN.sub}`).textContent).toContain('Opening Keynote');

    expect(screen.getByTestId('members-read-only').textContent).toMatch(/archived/i);
    expect(screen.queryByTestId('grant-form')).toBeNull();
    expect(screen.queryByTestId(`revoke-${BJORN.sub}-PresenterFacilitator`)).toBeNull();
    expect(screen.queryByTestId(`assign-${BJORN.sub}`)).toBeNull();
    // Removing somebody is a membership change, and archiving refuses those too (S08, FR9).
    expect(screen.queryByTestId(`remove-member-${BJORN.sub}`)).toBeNull();
  });

  // ---------- S08 TI08: removing a member from the conference ----------

  describe('removing a member from the conference', () => {
    const REMOVE_PATH = `DELETE /conferences/${CONFERENCE_ID}/members/${BJORN.sub}`;

    it('takes a second, explicit act – the first tap sends nothing', async () => {
      const harness = renderPanel({ [MEMBERS_PATH]: roster() });

      await userEvent.click(await screen.findByTestId(`remove-member-${BJORN.sub}`));

      // The confirmation names the person, because two member cards are a thumb-width apart.
      const confirmation = await screen.findByTestId(`remove-confirm-${BJORN.sub}`);
      expect(confirmation.textContent).toContain('Björn Lind');
      // Only the roster read has happened.
      expect(harness.calls).toHaveLength(1);
      expect(harness.calls[0]).toMatchObject({ method: 'GET' });
    });

    it('sends nothing when the confirmation is cancelled', async () => {
      const harness = renderPanel({ [MEMBERS_PATH]: roster() });

      await userEvent.click(await screen.findByTestId(`remove-member-${BJORN.sub}`));
      await userEvent.click(screen.getByTestId(`remove-member-cancel-${BJORN.sub}`));

      expect(harness.calls).toHaveLength(1);
      expect(screen.getByTestId(`remove-member-${BJORN.sub}`)).toBeTruthy();
    });

    it('removes the member on confirmation and shows the roster the server returned', async () => {
      const harness = renderPanel({
        [MEMBERS_PATH]: roster(),
        // What the server answers with: the whole roster, without him.
        [REMOVE_PATH]: roster([PRIYA]),
      });

      await userEvent.click(await screen.findByTestId(`remove-member-${BJORN.sub}`));
      await userEvent.click(screen.getByTestId(`remove-member-confirm-${BJORN.sub}`));

      await waitFor(() => expect(screen.queryByTestId(`member-${BJORN.sub}`)).toBeNull());
      // Priya is still there – only the named member went.
      expect(screen.getByTestId(`member-${PRIYA.sub}`)).toBeTruthy();

      expect(harness.calls[1]).toMatchObject({ method: 'DELETE', path: REMOVE_PATH.slice(7) });
    });

    /** The last admin is refused by the server, and the organizer reads why, word for word. */
    it('renders the server’s refusal verbatim and keeps the member on the list', async () => {
      const message =
        'A conference must always have at least one admin, and this is the last one. ' +
        'Make somebody else an admin first, then remove this person from the conference.';

      renderPanel({
        [MEMBERS_PATH]: roster(),
        [`DELETE /conferences/${CONFERENCE_ID}/members/${PRIYA.sub}`]: refused(
          409,
          'CONFERENCE_LAST_ADMIN',
          message,
        ),
      });

      await userEvent.click(await screen.findByTestId(`remove-member-${PRIYA.sub}`));
      await userEvent.click(screen.getByTestId(`remove-member-confirm-${PRIYA.sub}`));

      const refusal = await screen.findByTestId('members-refusal');
      expect(refusal.textContent).toBe(message);
      expect(screen.getByTestId(`member-${PRIYA.sub}`)).toBeTruthy();
    });

    /**
     * The control is offered on every member, the last admin included.
     *
     * Hiding it would leave an organizer with no explanation of why they cannot – and the client is
     * not the guard in any case: the server refuses the request whether or not a button was shown.
     */
    it('is offered on every member, and the server decides', async () => {
      renderPanel({ [MEMBERS_PATH]: roster() });

      await screen.findByTestId(`member-${PRIYA.sub}`);
      for (const member of [PRIYA, BJORN]) {
        expect(screen.getByTestId(`remove-member-${member.sub}`)).toBeTruthy();
      }
    });
  });
});
