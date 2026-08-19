import { test, expect, type Page } from '@playwright/test';

/**
 * S09 TI11 – the four surfaces this story adds, at phone, tablet and desktop widths.
 *
 * The staleness indicator, the in-app change banner, the organizer's conflict view and the
 * conference detail edit form. All four are text-heavy in a way the rest of the app is not: they
 * carry session names, times, locations and a server-written sentence, any of which can be long
 * enough to push a 375px phone sideways. That is the failure this captures - a banner an attendee
 * has to scroll horizontally to read is a banner that does not tell them what changed.
 *
 * The API is served from fixtures. The subject is the layout, and the states that must be on screen
 * - a schedule that has just changed, a save refused by somebody else's save - are ones a live
 * database would have to be manoeuvred into anyway.
 */

const VIEWPORTS = [
  { name: 'phone-375', width: 375, height: 812 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'desktop-1280', width: 1280, height: 900 },
] as const;

const CONFERENCE_ID = '11111111-1111-4111-8111-111111111111';

const SERVER_NOW = {
  instant: '2026-09-15T07:40:12.345678Z',
  day: '2026-09-15',
  time: '09:40',
};

/** Four minutes before the server's now, so the age reads as a real elapsed duration. */
const FIRST_WATERMARK = '2026-09-15T07:36:12.000000Z';
const SECOND_WATERMARK = '2026-09-15T07:40:12.345678Z';

const LONG_TITLE = 'Design Workshop: shaping next year’s onboarding experience end to end';
const LONG_LOCATION = 'Room 2, second floor, east wing';

function attendeeSession(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    description: null,
    kind: 'Presentation',
    startTime: '09:00',
    endTime: '10:30',
    location: 'Main Hall, ground floor',
    concurrentWith: [],
    ...overrides,
  };
}

function envelope(
  sessions: Record<string, unknown>[],
  lastUpdatedAt: string,
): Record<string, unknown> {
  return {
    conference: {
      id: CONFERENCE_ID,
      name: 'Autumn Offsite',
      startDate: '2026-09-15',
      endDate: '2026-09-16',
      state: 'published',
      lastUpdatedAt,
    },
    days: [
      { date: '2026-09-15', dayNumber: 1, sessions },
      { date: '2026-09-16', dayNumber: 2, sessions: [] },
    ],
    serverNow: SERVER_NOW,
  };
}

const BEFORE = envelope(
  [
    attendeeSession({ id: 'keynote', title: 'Opening Keynote' }),
    attendeeSession({
      id: 'design',
      title: LONG_TITLE,
      kind: 'Workshop',
      startTime: '11:00',
      endTime: '12:00',
      location: LONG_LOCATION,
    }),
    attendeeSession({
      id: 'retro',
      title: 'Retrospective',
      startTime: '15:00',
      endTime: '16:00',
      location: 'Room B',
    }),
  ],
  FIRST_WATERMARK,
);

/** The keynote moved, the long-titled workshop moved room, and the retrospective is gone. */
const AFTER = envelope(
  [
    attendeeSession({
      id: 'keynote',
      title: 'Opening Keynote',
      startTime: '09:30',
      endTime: '11:00',
      location: 'Room B, first floor',
    }),
    attendeeSession({
      id: 'design',
      title: LONG_TITLE,
      kind: 'Workshop',
      startTime: '11:00',
      endTime: '12:00',
      location: 'Auditorium, west wing, third floor',
    }),
  ],
  SECOND_WATERMARK,
);

const MY_CONFERENCES = {
  conferences: [
    {
      id: CONFERENCE_ID,
      name: 'Autumn Offsite',
      startDate: '2026-09-15',
      endDate: '2026-09-16',
      state: 'published',
    },
  ],
  defaultConferenceId: CONFERENCE_ID,
};

const ORGANIZER_CONFERENCE = {
  id: CONFERENCE_ID,
  name: 'Autumn Offsite',
  startDate: '2026-09-15',
  endDate: '2026-09-16',
  lifecycleState: 'published',
  updatedAt: '2026-08-17T10:00:00.123456Z',
};

const ORGANIZER_SESSION = {
  id: 'keynote',
  conferenceId: CONFERENCE_ID,
  title: 'Opening Keynote',
  description: null,
  kind: 'Presentation',
  day: '2026-09-15',
  startTime: '09:00',
  endTime: '10:30',
  location: 'Main Hall, ground floor',
  lastUpdatedAt: '2026-08-17T10:00:00.123456Z',
};

const ORGANIZER_SCHEDULE = {
  conference: {
    id: CONFERENCE_ID,
    name: 'Autumn Offsite',
    startDate: '2026-09-15',
    endDate: '2026-09-16',
    lifecycleState: 'published',
    lastUpdatedAt: FIRST_WATERMARK,
  },
  days: [
    { day: '2026-09-15', sessions: [ORGANIZER_SESSION] },
    { day: '2026-09-16', sessions: [] },
  ],
  overlaps: [],
};

/** The refusal an admin reads when a colleague saved first - a long, real sentence. */
const CONFLICT = {
  error: {
    code: 'EDIT_VERSION_CONFLICT',
    message:
      'This session changed since you opened it, so your change was not saved. The current ' +
      'version is shown beside your edit – re-apply it and save again.',
    current: {
      ...ORGANIZER_SESSION,
      startTime: '09:30',
      endTime: '11:00',
      location: 'Auditorium, west wing, third floor',
      lastUpdatedAt: '2026-08-17T10:05:00.654321Z',
    },
  },
};

const SEED_SESSION = `
  window.localStorage.setItem('confapp.auth.session', JSON.stringify({
    idToken: 'layout-fixture-token',
    expiresAt: 4000000000,
    user: {
      sub: 'google-sub-ida',
      email: 'ida.andersson@ourcompany.example',
      displayName: 'Ida Andersson'
    }
  }));
`;

/**
 * Pins the device clock, so the staleness age is the same in every capture.
 *
 * `Date.now` only – the poll's `setInterval` is left alone, because the whole point of the attendee
 * capture is that the banner arrives on its own.
 */
const PIN_DEVICE_CLOCK = `
  const pinned = Date.parse('2026-09-15T07:40:12.345Z');
  Date.now = () => pinned;
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

// ---------- the attendee surfaces: staleness age and change banner ----------

async function stubAttendeeApi(page: Page): Promise<void> {
  let polls = 0;

  await page.route('**/api/me/conferences', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MY_CONFERENCES),
    }),
  );

  // The watermark advances on the second poll, which is what makes the schedule refresh itself.
  await page.route(`**/api/conferences/${CONFERENCE_ID}/schedule/watermark`, (route) => {
    polls += 1;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        lastUpdatedAt: polls === 1 ? FIRST_WATERMARK : SECOND_WATERMARK,
        state: 'published',
      }),
    });
  });

  await page.route(`**/api/conferences/${CONFERENCE_ID}/schedule`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(polls === 0 ? BEFORE : AFTER),
    }),
  );

  await page.route('**/api/conferences', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ conferences: [] }),
    }),
  );

  await page.route('**/api/health', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'ok',
        schemaVersion: '20260817210000000',
        serverTime: '2026-09-15T07:40:12.345678Z',
      }),
    }),
  );

  await page.addInitScript(SEED_SESSION);
  await page.addInitScript(PIN_DEVICE_CLOCK);
}

for (const viewport of VIEWPORTS) {
  test(`the staleness age and change banner stay legible at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await stubAttendeeApi(page);
    await page.goto('/');

    await expect(page.getByTestId('attendee-schedule')).toBeVisible();

    // An elapsed age, never a clock time.
    const staleness = page.getByTestId('schedule-staleness');
    await expect(staleness).toBeVisible();
    await expect(staleness).toContainText(/ago|just now/i);

    // The banner arrives on its own, from the poll - nothing here reloads or navigates.
    const banner = page.getByTestId('schedule-change-banner');
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toContainText('Opening Keynote');
    await expect(banner).toContainText('Retrospective');

    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    for (const testId of [
      'attendee-panel',
      'schedule-staleness',
      'schedule-change-banner',
      'attendee-session-list',
    ]) {
      await assertWithinViewport(page, testId, viewport.width);
    }

    // The dismiss control is genuinely tappable on the narrowest phone.
    const dismiss = await page.getByTestId('schedule-change-dismiss').boundingBox();
    expect(dismiss!.height).toBeGreaterThanOrEqual(40);

    await page.screenshot({
      path: `screenshots/live-editing-attendee-${viewport.name}.png`,
      fullPage: true,
    });
  });
}

// ---------- the organizer surfaces: conflict view and detail edit form ----------

async function stubOrganizerApi(page: Page): Promise<void> {
  await page.route('**/api/conferences', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ conferences: [ORGANIZER_CONFERENCE] }),
    }),
  );

  await page.route(`**/api/conferences/${CONFERENCE_ID}/schedule/organizer`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(ORGANIZER_SCHEDULE),
    }),
  );

  await page.route(`**/api/conferences/${CONFERENCE_ID}/sessions/keynote`, (route) =>
    route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify(CONFLICT),
    }),
  );

  // The member and join-code panels further down are not this capture's subject, but they must not
  // show an error that changes the layout above them.
  await page.route(`**/api/conferences/${CONFERENCE_ID}/members`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        conferenceId: CONFERENCE_ID,
        lifecycleState: 'published',
        members: [],
        sessions: [],
      }),
    }),
  );

  await page.route(`**/api/conferences/${CONFERENCE_ID}/join-code`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        conferenceId: CONFERENCE_ID,
        joinCode: 'K7RM4P',
        lifecycleState: 'published',
      }),
    }),
  );

  await page.route('**/api/health', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'ok',
        schemaVersion: '20260817210000000',
        serverTime: '2026-09-15T07:40:12.345678Z',
      }),
    }),
  );

  // The attendee panel shares this page; it is not the subject, but an error in it would change
  // the layout of everything below.
  await page.route('**/api/me/conferences', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ conferences: [], defaultConferenceId: null }),
    }),
  );

  await page.addInitScript(SEED_SESSION);
}

for (const viewport of VIEWPORTS) {
  test(`the conflict view and detail edit form stay legible at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await stubOrganizerApi(page);

    await page.goto('/');
    await page.getByText('Autumn Offsite').click();
    await expect(page.getByTestId('schedule')).toBeVisible();

    // The detail edit form - available because the conference is published, not despite it.
    await page.getByTestId('edit-conference').click();
    await expect(page.getByTestId('conference-form')).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await assertWithinViewport(page, 'conference-form', viewport.width);

    await page.screenshot({
      path: `screenshots/live-editing-detail-form-${viewport.name}.png`,
      fullPage: true,
    });

    await page.getByTestId('conference-form-cancel').click();

    // The conflict view: a refused save, with the newer version beside the typed values.
    await page.getByTestId('edit-keynote').click();
    await page.getByRole('button', { name: /save/i }).click();

    const conflict = page.getByTestId('session-conflict');
    await expect(conflict).toBeVisible();
    await expect(conflict).toContainText('09:30');
    await expect(conflict).toContainText('Auditorium, west wing, third floor');

    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    for (const testId of ['session-conflict', 'session-form']) {
      await assertWithinViewport(page, testId, viewport.width);
    }

    await page.screenshot({
      path: `screenshots/live-editing-conflict-${viewport.name}.png`,
      fullPage: true,
    });
  });
}

/**
 * The refusal that outlives its form, at all three widths.
 *
 * An archive landing under an in-flight edit closes the form - an archived Conference accepts no
 * edit - so the server's sentence and the organizer's typed values are re-rendered outside it. Both
 * are long: a full explanatory sentence, and a conference name the organizer chose. On a 375px
 * phone that is exactly the text that pushes a panel sideways, and this is the one surface in the
 * story with no form around it to constrain the line length.
 */
for (const viewport of VIEWPORTS) {
  test(`the archived-mid-edit refusal stays legible at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await stubOrganizerApi(page);

    await page.route(`**/api/conferences/${CONFERENCE_ID}`, (route) =>
      route.request().method() === 'PATCH'
        ? route.fulfill({
            status: 409,
            contentType: 'application/json',
            body: JSON.stringify({
              error: {
                code: 'CONFERENCE_STATE_CHANGED',
                message:
                  'This conference was archived while you were editing, so your change was not ' +
                  'saved. It is now archived. Reload it to see where that leaves your edit.',
                current: {
                  id: CONFERENCE_ID,
                  name: 'Autumn Offsite',
                  startDate: '2026-09-15',
                  endDate: '2026-09-16',
                  lifecycleState: 'archived',
                  updatedAt: '2026-09-15T07:41:00.000000Z',
                },
              },
            }),
          })
        : route.fallback(),
    );

    await page.goto('/');
    await page.getByText('Autumn Offsite').click();
    await expect(page.getByTestId('schedule')).toBeVisible();

    await page.getByTestId('edit-conference').click();
    const name = page.getByLabel('Conference name');
    await name.fill('Autumn Offsite: strategy, retrospective and planning days');
    await page.getByRole('button', { name: /save changes/i }).click();

    const notice = page.getByTestId('conference-edit-abandoned');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('archived');
    await expect(notice).toContainText('strategy, retrospective and planning days');

    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await assertWithinViewport(page, 'conference-edit-abandoned', viewport.width);

    await page.screenshot({
      path: `screenshots/live-editing-archived-mid-edit-${viewport.name}.png`,
      fullPage: true,
    });
  });
}
