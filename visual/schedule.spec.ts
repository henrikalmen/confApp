import { test, expect, type Page } from '@playwright/test';

/**
 * TI09 – the Organizer's schedule composition view at phone, tablet and desktop widths.
 *
 * All three are captured because "responsive" here means the layout reflows rather than being
 * clipped, and a schedule is exactly the shape that overflows a 375px phone: a time column beside
 * a title, a row of per-day navigation buttons, a two-column time-range form, and Edit/Delete
 * beside every session.
 *
 * The schedule API is served from fixtures rather than the live one. The subject is the layout,
 * and the states that have to be visible – an overlapping pair, a field-level refusal – are ones a
 * live database would have to be manoeuvred into anyway.
 */

const VIEWPORTS = [
  { name: 'phone-375', width: 375, height: 812 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'desktop-1280', width: 1280, height: 900 },
] as const;

const CONFERENCE_ID = '11111111-1111-4111-8111-111111111111';

const CONFERENCES = [
  {
    id: CONFERENCE_ID,
    name: 'Autumn Offsite',
    startDate: '2026-09-15',
    endDate: '2026-09-18',
    lifecycleState: 'draft',
    updatedAt: '2026-08-17T10:00:00.000Z',
  },
] as const;

function session(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'keynote',
    conferenceId: CONFERENCE_ID,
    title: 'Opening Keynote',
    description: null,
    kind: 'Presentation',
    day: '2026-09-15',
    startTime: '09:00',
    endTime: '10:30',
    location: 'Main Hall',
    lastUpdatedAt: '2026-08-17T10:00:00.123456Z',
    ...overrides,
  };
}

const KEYNOTE = session({});
const WORKSHOP = session({
  id: 'workshop',
  // A deliberately long title and location: the phone case where a card pushes the page sideways.
  title: 'Design Workshop: shaping next year’s onboarding experience end to end',
  kind: 'Workshop',
  startTime: '10:00',
  endTime: '11:00',
  location: 'Room 2, second floor, east wing',
});

const SCHEDULE = {
  conference: {
    id: CONFERENCE_ID,
    name: 'Autumn Offsite',
    startDate: '2026-09-15',
    endDate: '2026-09-18',
    lifecycleState: 'draft',
    lastUpdatedAt: '2026-08-17T10:05:00.987654Z',
  },
  days: [
    { day: '2026-09-15', sessions: [KEYNOTE, WORKSHOP] },
    { day: '2026-09-16', sessions: [] },
    { day: '2026-09-17', sessions: [] },
    { day: '2026-09-18', sessions: [] },
  ],
  // Both sessions carry the persistent indicator.
  overlaps: [{ sessionIds: ['keynote', 'workshop'] }],
};

const TIME_REFUSAL = {
  error: {
    code: 'SESSION_TIME_RANGE_INVALID',
    message:
      "A session's end time must be after its start time on the same conference day, and " +
      '23:15–00:45 is not. A session cannot run past midnight; split it across two sessions instead.',
    details: [
      { field: 'startTime', message: 'end after start' },
      {
        field: 'endTime',
        message:
          "A session's end time must be after its start time on the same conference day, and " +
          '23:15–00:45 is not. A session cannot run past midnight; split it across two sessions instead.',
      },
    ],
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

async function stubApi(page: Page, options: { refuseSave?: boolean } = {}): Promise<void> {
  await page.route('**/api/conferences', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ conferences: CONFERENCES }),
    });
  });

  await page.route(`**/api/conferences/${CONFERENCE_ID}/schedule/organizer`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(SCHEDULE),
    });
  });

  await page.route(`**/api/conferences/${CONFERENCE_ID}/sessions`, async (route) => {
    const refused = options.refuseSave === true;
    await route.fulfill({
      status: refused ? 400 : 200,
      contentType: 'application/json',
      body: JSON.stringify(refused ? TIME_REFUSAL : { session: KEYNOTE, overlapWarning: null }),
    });
  });

  await page.addInitScript(SEED_SESSION);
}

/** Opens the conference detail view, which is where the schedule panel lives. */
async function openSchedule(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByText('Autumn Offsite').click();
  await expect(page.getByTestId('schedule')).toBeVisible();
}

for (const viewport of VIEWPORTS) {
  test(`the organizer schedule renders without horizontal scrolling at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await stubApi(page);
    await openSchedule(page);

    // Every conference day is reachable – four of them, wrapping rather than scrolling sideways.
    await expect(page.getByTestId('day-nav')).toBeVisible();
    for (const day of ['2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18']) {
      await expect(page.getByTestId(`day-${day}`)).toBeVisible();
    }

    // Sessions in start-time order, with the times rendered exactly as they arrived.
    const list = page.getByTestId('session-list');
    await expect(list).toBeVisible();
    await expect(list.getByRole('listitem').first()).toContainText('09:00–10:30');

    // The persistent overlap indicator is on both sessions of the pair.
    for (const id of ['keynote', 'workshop']) {
      await expect(page.getByTestId(`overlap-${id}`)).toBeVisible();
      await expect(page.getByTestId(`overlap-${id}`)).toContainText('Parallel track');
    }

    // Day buttons and session actions stay genuinely tappable on the narrowest phone.
    for (const testId of ['day-2026-09-15', 'add-session', 'edit-keynote']) {
      const box = await page.getByTestId(testId).boundingBox();
      expect(box!.height, testId).toBeGreaterThanOrEqual(40);
    }

    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    for (const testId of [
      'schedule',
      'day-nav',
      'session-list',
      'session-keynote',
      'session-workshop',
    ]) {
      await assertWithinViewport(page, testId, viewport.width);
    }

    await page.screenshot({
      path: `screenshots/schedule-${viewport.name}.png`,
      fullPage: true,
    });
  });

  test(`the session form shows a field-level refusal without overflowing at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await stubApi(page, { refuseSave: true });
    await openSchedule(page);

    await page.getByTestId('add-session').click();
    await expect(page.getByTestId('session-form')).toBeVisible();

    await page.getByLabel('Title', { exact: true }).fill('Night Session');
    await page.getByLabel('Location', { exact: true }).fill('Main Hall');
    await page.getByLabel('Start time', { exact: true }).fill('23:15');
    await page.getByLabel('End time', { exact: true }).fill('00:45');
    await page.getByRole('button', { name: 'Add session' }).click();

    // The violated rule, against the time fields, in the server's own words.
    const error = page.getByTestId('error-times');
    await expect(error).toBeVisible();
    await expect(error).toContainText('after its start time on the same conference day');

    /*
     * The two-column time row must stack rather than clip on a phone. `exact` because the day
     * navigation is labelled "Conference days" and a substring match would find it too.
     */
    for (const label of ['Start time', 'End time', 'Conference day', 'Kind']) {
      const box = await page.getByLabel(label, { exact: true }).boundingBox();
      expect(box!.height, label).toBeGreaterThanOrEqual(40);
      expect(box!.x + box!.width, label).toBeLessThanOrEqual(viewport.width + 1);
    }

    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    for (const testId of ['session-form', 'error-times']) {
      await assertWithinViewport(page, testId, viewport.width);
    }

    await page.screenshot({
      path: `screenshots/schedule-form-error-${viewport.name}.png`,
      fullPage: true,
    });
  });
}
