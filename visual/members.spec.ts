import { test, expect, type Page } from '@playwright/test';

/**
 * TI12 – the Admin's member-and-roles surface at phone, tablet and desktop widths.
 *
 * Three things are captured at each width because each is a different way this panel can push the
 * page sideways: the member list (a name, an address and three role badges on one row), the
 * grant/revoke controls (a text field, a select and a button), and a refusal message (a long
 * sentence rendered verbatim from the server, which is the one string here nobody controls the
 * length of).
 *
 * The API is served from fixtures rather than the live one. The subject is the layout, and reaching
 * the real endpoints would need a genuine Google sign-in – whereas the states that actually have to
 * be seen (somebody holding three roles, a last-admin refusal) are ones a live database would have
 * to be manoeuvred into anyway.
 */

const VIEWPORTS = [
  { name: 'phone-375', width: 375, height: 812 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'desktop-1280', width: 1280, height: 900 },
] as const;

const CONFERENCE = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Autumn Kickoff 2026',
  startDate: '2026-09-14',
  endDate: '2026-09-16',
  lifecycleState: 'published',
  updatedAt: '2026-08-17T10:00:00.000Z',
};

const KEYNOTE = '22222222-2222-4222-8222-222222222222';
const WORKSHOP = '33333333-3333-4333-8333-333333333333';

const SESSIONS = [
  {
    id: KEYNOTE,
    title: 'Opening Keynote',
    kind: 'Presentation',
    day: '2026-09-14',
    startTime: '09:00',
    endTime: '10:00',
    holders: ['google-sub-bjorn'],
  },
  {
    id: WORKSHOP,
    // A deliberately long title: the phone case where a session name pushes the row sideways.
    title: 'Design Workshop – Service Blueprinting and Journey Mapping',
    kind: 'Workshop',
    day: '2026-09-14',
    startTime: '11:00',
    endTime: '12:30',
    holders: [],
  },
];

const MEMBERS = [
  {
    sub: 'google-sub-priya',
    displayName: 'Priya Raman',
    email: 'priya.raman@ourcompany.example',
    // Three badges on one row – the widest a member card gets.
    roles: ['Admin', 'PresenterFacilitator', 'Attendee'],
    sessionIds: [WORKSHOP],
  },
  {
    sub: 'google-sub-bjorn',
    displayName: 'Björn Lindqvist',
    // A deliberately long address: a single unbroken token, the thing most likely to overflow.
    email: 'bjorn.lindqvist.experience@ourcompany.example',
    roles: ['PresenterFacilitator', 'Attendee'],
    sessionIds: [KEYNOTE],
  },
  {
    sub: 'google-sub-nadia',
    displayName: 'Nadia Osman',
    email: 'nadia.osman@ourcompany.example',
    roles: ['Attendee'],
    sessionIds: [],
  },
];

const LAST_ADMIN_REFUSAL = {
  error: {
    code: 'CONFERENCE_LAST_ADMIN',
    message:
      'A conference must always have at least one admin, and this is the last one. ' +
      'Make somebody else an admin first, then remove this role.',
  },
};

const SEED_SESSION = `
  window.localStorage.setItem('confapp.auth.session', JSON.stringify({
    idToken: 'layout-fixture-token',
    expiresAt: 4000000000,
    user: {
      sub: 'google-sub-priya',
      email: 'priya.raman@ourcompany.example',
      displayName: 'Priya Raman'
    }
  }));
`;

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

/** Nothing may be clipped out of the viewport horizontally. */
async function assertWithinViewport(page: Page, testId: string, width: number): Promise<void> {
  const box = await page.getByTestId(testId).boundingBox();
  expect(box, `${testId} should have a layout box`).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
}

function roster(): unknown {
  return {
    conferenceId: CONFERENCE.id,
    lifecycleState: CONFERENCE.lifecycleState,
    members: MEMBERS,
    sessions: SESSIONS,
  };
}

/**
 * Everything the detail view asks for, so the members panel renders beside its neighbours exactly
 * as it does in the app rather than on a page of its own.
 */
async function stubApi(page: Page, options: { refuseRevoke?: boolean } = {}): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());

    /*
     * Only real API calls. The Vite dev server serves the app's own modules from paths like
     * `/src/api/client.ts`, which this glob also matches – answering one of those with JSON blanks
     * the page, and every assertion then fails somewhere far from the cause.
     */
    if (!url.pathname.startsWith('/api/')) return route.fallback();

    const path = url.pathname.slice('/api'.length);
    const method = route.request().method();

    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path === '/health') {
      return json(200, {
        status: 'ok',
        schemaVersion: '1',
        serverTime: '2026-09-15T09:00:00.000Z',
      });
    }
    if (path === '/conferences') return json(200, { conferences: [CONFERENCE] });
    if (path === '/me/conferences')
      return json(200, { conferences: [], defaultConferenceId: null });
    if (path.endsWith('/join-code')) {
      return json(200, {
        conferenceId: CONFERENCE.id,
        joinCode: 'K7RM4P',
        lifecycleState: CONFERENCE.lifecycleState,
      });
    }
    if (path.endsWith('/schedule/organizer')) {
      return json(200, {
        conference: { ...CONFERENCE, lastUpdatedAt: '2026-09-14T08:00:00.000Z' },
        days: [
          {
            day: '2026-09-14',
            sessions: SESSIONS.map((session) => ({
              ...session,
              conferenceId: CONFERENCE.id,
              description: null,
              lastUpdatedAt: '2026-09-14T08:00:00.000Z',
            })),
          },
        ],
        overlaps: [],
      });
    }
    if (path.endsWith('/members')) return json(200, roster());
    if (method === 'DELETE' && path.includes('/roles/')) {
      // The refusal a last admin gets, in the server's own words.
      return options.refuseRevoke ? json(409, LAST_ADMIN_REFUSAL) : json(200, roster());
    }

    if (path.endsWith('/assignments') || path.includes('/assignments/')) {
      return json(200, roster());
    }

    // Anything else is a route this fixture did not anticipate; fail loudly rather than pretend.
    return json(500, { error: { code: 'UNSTUBBED', message: `No fixture for ${method} ${path}` } });
  });

  await page.addInitScript(SEED_SESSION);
}

/** The detail view is reached the way an organizer reaches it: by opening their conference. */
async function openMembers(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByText(CONFERENCE.name).click();
  await expect(page.getByTestId('members-panel')).toBeVisible();
}

for (const viewport of VIEWPORTS) {
  test(`the member list renders without horizontal scrolling at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await stubApi(page);
    await openMembers(page);

    // Every member is on screen, with the roles they hold.
    for (const member of MEMBERS) {
      await expect(page.getByTestId(`member-${member.sub}`)).toBeVisible();
    }
    // One role, shown with both words – not two separate roles.
    await expect(page.getByTestId('members-panel')).toContainText('Presenter/Facilitator');

    // A member's session assignments are legible on their row.
    await expect(page.getByTestId('sessions-google-sub-bjorn')).toContainText('Opening Keynote');

    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    for (const member of MEMBERS) {
      await assertWithinViewport(page, `member-${member.sub}`, viewport.width);
    }

    await page.screenshot({
      path: `screenshots/members-list-${viewport.name}.png`,
      fullPage: true,
    });
  });

  test(`the grant and revoke controls stay usable at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await stubApi(page);
    await openMembers(page);

    // Real tap targets on the narrowest phone, not decorative ones.
    const grant = page.getByTestId('grant-role');
    const grantBox = await grant.boundingBox();
    expect(grantBox!.height).toBeGreaterThanOrEqual(40);

    const emailBox = await page.getByLabel('Company email address').boundingBox();
    expect(emailBox!.height).toBeGreaterThanOrEqual(40);
    expect(emailBox!.width).toBeLessThanOrEqual(viewport.width);

    // A revoke control sits beside its badge and is still tappable.
    const revoke = page.getByTestId('revoke-google-sub-priya-Admin');
    const revokeBox = await revoke.boundingBox();
    expect(revokeBox!.height).toBeGreaterThanOrEqual(32);

    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    for (const testId of ['grant-form', 'grant-role', 'revoke-google-sub-priya-Admin']) {
      await assertWithinViewport(page, testId, viewport.width);
    }

    await page.screenshot({
      path: `screenshots/members-controls-${viewport.name}.png`,
      fullPage: true,
    });
  });

  test(`a refusal message reads in full at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await stubApi(page, { refuseRevoke: true });
    await openMembers(page);

    await page.getByTestId('revoke-google-sub-priya-Admin').click();

    // The server's whole sentence, wrapped rather than clipped.
    const refusal = page.getByTestId('members-refusal');
    await expect(refusal).toBeVisible();
    await expect(refusal).toContainText('at least one admin');
    await expect(refusal).toContainText('Make somebody else an admin first');

    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await assertWithinViewport(page, 'members-refusal', viewport.width);

    await page.screenshot({
      path: `screenshots/members-refusal-${viewport.name}.png`,
      fullPage: true,
    });
  });
}
