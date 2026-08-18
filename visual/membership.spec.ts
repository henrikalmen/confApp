import { test, expect, type Page } from '@playwright/test';

/**
 * TI08 – the two surfaces that end a Membership, at phone, tablet and desktop widths.
 *
 * Both are captured at all three because both are *confirmation* steps, and a confirmation is the
 * one thing in the app that must never be half off-screen: a question whose "Cancel" has been
 * pushed past the right edge is a question that gets answered by whichever button is reachable.
 * The attendee's leave step is also the one an employee meets one-handed in a corridor.
 *
 * A long conference name and a long display name are used on purpose. Both are arbitrary text
 * rendered inside a bordered block, so they are what pushes these two panels sideways at 375px.
 *
 * The API is served from fixtures. The subject is the layout, and reaching the real endpoints would
 * need a genuine Google sign-in – whereas the states that have to be seen (a confirmation open, a
 * last-admin refusal) are ones a live database would have to be manoeuvred into anyway.
 */

const VIEWPORTS = [
  { name: 'phone-375', width: 375, height: 812 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'desktop-1280', width: 1280, height: 900 },
] as const;

const KICKOFF = '11111111-1111-4111-8111-111111111111';
const KEYNOTE = '22222222-2222-4222-8222-222222222222';

/** Deliberately long: a conference name is arbitrary text and is quoted inside the question. */
const CONFERENCE_NAME = 'Autumn Kickoff 2026 – Strategy, Product and Everything After';

const CONFERENCE = {
  id: KICKOFF,
  name: CONFERENCE_NAME,
  startDate: '2026-09-14',
  endDate: '2026-09-16',
  lifecycleState: 'published',
  updatedAt: '2026-09-15T07:00:00.000Z',
};

const SERVER_NOW = {
  instant: '2026-09-15T07:40:12.345678Z',
  day: '2026-09-15',
  time: '09:40',
};

const MY_CONFERENCES = {
  conferences: [
    {
      id: KICKOFF,
      name: CONFERENCE_NAME,
      startDate: '2026-09-14',
      endDate: '2026-09-16',
      state: 'published',
    },
  ],
  defaultConferenceId: KICKOFF,
};

const SCHEDULE = {
  conference: {
    id: KICKOFF,
    name: CONFERENCE_NAME,
    startDate: '2026-09-14',
    endDate: '2026-09-16',
    state: 'published',
    lastUpdatedAt: '2026-09-15T07:00:00.123456Z',
  },
  days: [
    {
      date: '2026-09-15',
      dayNumber: 2,
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
  serverNow: SERVER_NOW,
};

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
];

const MEMBERS = [
  {
    sub: 'google-sub-priya',
    displayName: 'Priya Raman',
    email: 'priya.raman@ourcompany.example',
    roles: ['Admin', 'Attendee'],
    sessionIds: [] as string[],
  },
  {
    sub: 'google-sub-bjorn',
    // A long name and a long address together – the widest a member card's question gets.
    displayName: 'Björn Lindqvist-Andersson',
    email: 'bjorn.lindqvist.andersson@ourcompany.example',
    roles: ['PresenterFacilitator', 'Attendee'],
    sessionIds: [KEYNOTE],
  },
];

const LAST_ADMIN_REFUSAL = {
  error: {
    code: 'CONFERENCE_LAST_ADMIN',
    message:
      'A conference must always have at least one admin, and this is the last one. ' +
      'Make somebody else an admin first, then remove this person from the conference.',
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

function roster(members: unknown[] = MEMBERS): unknown {
  return {
    conferenceId: KICKOFF,
    lifecycleState: CONFERENCE.lifecycleState,
    members,
    sessions: SESSIONS,
  };
}

/**
 * Everything both surfaces ask for, so each panel renders beside its neighbours exactly as it does
 * in the app rather than on a page of its own.
 */
async function stubApi(page: Page, options: { refuseRemoval?: boolean } = {}): Promise<void> {
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
    if (path === '/me/conferences') return json(200, MY_CONFERENCES);
    if (path.endsWith('/schedule')) return json(200, SCHEDULE);
    if (path === '/conferences') return json(200, { conferences: [CONFERENCE] });
    if (path.endsWith('/join-code')) {
      return json(200, {
        conferenceId: KICKOFF,
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
              conferenceId: KICKOFF,
              description: null,
              lastUpdatedAt: '2026-09-14T08:00:00.000Z',
            })),
          },
        ],
        overlaps: [],
      });
    }
    if (path.endsWith('/members')) return json(200, roster());

    // The removal itself: either refused as the last admin, or answered with the roster it leaves.
    if (method === 'DELETE' && /\/members\/[^/]+$/.test(path)) {
      return options.refuseRemoval
        ? json(409, LAST_ADMIN_REFUSAL)
        : json(200, roster([MEMBERS[0]]));
    }
    if (method === 'DELETE' && path.endsWith('/membership')) {
      return json(200, { conferenceId: KICKOFF, membership: 'ended' });
    }

    // Anything else is a route this fixture did not anticipate; fail loudly rather than pretend.
    return json(500, { error: { code: 'UNSTUBBED', message: `No fixture for ${method} ${path}` } });
  });

  await page.addInitScript(SEED_SESSION);
}

/** The organizer's member list is reached the way an organizer reaches it: through their conference. */
async function openMembers(page: Page): Promise<void> {
  await page.goto('/');
  // By its card in the organizer list, not by its name: the attendee panel above shows the same
  // name for the same conference, and matching on text alone would open nothing.
  await page.getByTestId(`conference-${KICKOFF}`).click();
  await expect(page.getByTestId('members-panel')).toBeVisible();
}

for (const viewport of VIEWPORTS) {
  test(`the leave confirmation is fully legible at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await stubApi(page);
    await page.goto('/');

    // The control sits at the foot of the conference it is about.
    const leave = page.getByTestId('leave-conference');
    await expect(leave).toBeVisible();
    // A real tap target on the narrowest phone, not a decorative one.
    expect((await leave.boundingBox())!.height).toBeGreaterThanOrEqual(32);

    await leave.click();

    const confirmation = page.getByTestId('leave-confirm');
    await expect(confirmation).toBeVisible();
    // The conference is named in the question, wrapped rather than clipped.
    await expect(confirmation).toContainText('Autumn Kickoff 2026');
    await expect(page.getByTestId('leave-confirm-yes')).toBeVisible();
    await expect(page.getByTestId('leave-cancel')).toBeVisible();

    // Both answers are reachable – a confirmation with one button off-screen answers itself.
    for (const testId of ['leave-confirm', 'leave-confirm-yes', 'leave-cancel']) {
      await assertWithinViewport(page, testId, viewport.width);
    }
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

    await page.screenshot({
      path: `screenshots/membership-leave-${viewport.name}.png`,
      fullPage: true,
    });
  });

  test(`the member list's remove control stays usable at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await stubApi(page);
    await openMembers(page);

    // Every member can be removed; the server is what refuses the ones that cannot.
    for (const member of MEMBERS) {
      const control = page.getByTestId(`remove-member-${member.sub}`);
      await expect(control).toBeVisible();
      expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(32);
    }

    await page.getByTestId('remove-member-google-sub-bjorn').click();

    const confirmation = page.getByTestId('remove-confirm-google-sub-bjorn');
    await expect(confirmation).toBeVisible();
    await expect(confirmation).toContainText('Björn Lindqvist-Andersson');

    for (const testId of [
      'members-panel',
      'member-google-sub-bjorn',
      'remove-confirm-google-sub-bjorn',
      'remove-member-confirm-google-sub-bjorn',
      'remove-member-cancel-google-sub-bjorn',
    ]) {
      await assertWithinViewport(page, testId, viewport.width);
    }
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

    await page.screenshot({
      path: `screenshots/membership-remove-${viewport.name}.png`,
      fullPage: true,
    });
  });

  test(`a removal refusal reads in full at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await stubApi(page, { refuseRemoval: true });
    await openMembers(page);

    await page.getByTestId('remove-member-google-sub-priya').click();
    await page.getByTestId('remove-member-confirm-google-sub-priya').click();

    // The server's whole sentence, wrapped rather than clipped, and the member still listed.
    const refusal = page.getByTestId('members-refusal');
    await expect(refusal).toBeVisible();
    await expect(refusal).toContainText('at least one admin');
    await expect(refusal).toContainText('remove this person from the conference');
    await expect(page.getByTestId('member-google-sub-priya')).toBeVisible();

    await assertWithinViewport(page, 'members-refusal', viewport.width);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

    await page.screenshot({
      path: `screenshots/membership-refusal-${viewport.name}.png`,
      fullPage: true,
    });
  });
}
