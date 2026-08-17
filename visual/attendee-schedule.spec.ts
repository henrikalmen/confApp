import { test, expect, type Page } from '@playwright/test';

/**
 * TI11 – the Attendee's Schedule at phone, tablet and desktop widths.
 *
 * All three are captured because "responsive" here means the layout reflows rather than being
 * clipped, and this screen is the shape that overflows a 375px phone: a time column beside a title,
 * a row of per-day navigation buttons, a conference picker, a long session title, and two extra
 * markings – the parallel-track note and the running highlight – that both have to stay legible.
 *
 * It is also the screen the whole conference is consumed through, held one-handed in a corridor, so
 * "reachable at 375px" is an acceptance criterion rather than a nicety (OC04).
 *
 * The API is served from fixtures. The subject is the layout, and the states that must be visible –
 * a concurrent pair, a Session running *now*, a picker with three conferences – are ones a live
 * database would have to be manoeuvred into anyway. The clock is pinned for the same reason: a
 * running highlight that depended on the wall-clock time of the test run would be a screenshot that
 * looked different every hour.
 */

const VIEWPORTS = [
  { name: 'phone-375', width: 375, height: 812 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'desktop-1280', width: 1280, height: 900 },
] as const;

const KICKOFF = '11111111-1111-4111-8111-111111111111';
const PRODUCT_DAYS = '22222222-2222-4222-8222-222222222222';
const RETRO = '33333333-3333-4333-8333-333333333333';

/** 09:40 on day 2 – mid-keynote, so the running highlight is on screen in every capture. */
const SERVER_NOW = {
  instant: '2026-09-15T07:40:12.345678Z',
  day: '2026-09-15',
  time: '09:40',
};

const MY_CONFERENCES = {
  conferences: [
    {
      id: KICKOFF,
      name: 'Kickoff 2026',
      startDate: '2026-09-14',
      endDate: '2026-09-16',
      state: 'published',
    },
    {
      id: PRODUCT_DAYS,
      name: 'Product Days',
      startDate: '2026-11-02',
      endDate: '2026-11-03',
      state: 'published',
    },
    {
      id: RETRO,
      name: 'Retro 2025',
      startDate: '2025-11-18',
      endDate: '2025-11-20',
      state: 'archived',
    },
  ],
  defaultConferenceId: KICKOFF,
};

const SCHEDULE = {
  conference: {
    id: KICKOFF,
    name: 'Kickoff 2026',
    startDate: '2026-09-14',
    endDate: '2026-09-16',
    state: 'published',
    lastUpdatedAt: '2026-09-15T07:00:00.123456Z',
  },
  days: [
    { date: '2026-09-14', dayNumber: 1, sessions: [] },
    {
      date: '2026-09-15',
      dayNumber: 2,
      sessions: [
        {
          id: 'keynote',
          // Deliberately long: the phone case where a card pushes the page sideways.
          title: 'Opening Keynote: where the company got to this year and what comes next',
          description: null,
          kind: 'Presentation',
          startTime: '09:00',
          endTime: '10:30',
          location: 'Main Hall, ground floor',
          concurrentWith: ['design', 'architecture'],
        },
        {
          id: 'architecture',
          title: 'Architecture Deep Dive',
          description: null,
          kind: 'Presentation',
          startTime: '10:00',
          endTime: '11:00',
          location: 'Room 3',
          concurrentWith: ['keynote', 'design'],
        },
        {
          id: 'design',
          title: 'Design Workshop: shaping next year’s onboarding experience end to end',
          description: null,
          kind: 'Workshop',
          startTime: '10:00',
          endTime: '11:00',
          location: 'Room 2, second floor, east wing',
          concurrentWith: ['keynote', 'architecture'],
        },
        {
          id: 'retro',
          title: 'Retrospective',
          description: null,
          kind: 'Workshop',
          startTime: '15:00',
          endTime: '16:00',
          location: 'Room B',
          concurrentWith: [],
        },
      ],
    },
    { date: '2026-09-16', dayNumber: 3, sessions: [] },
  ],
  serverNow: SERVER_NOW,
};

const SEED_SESSION = `
  window.localStorage.setItem('confapp.auth.session', JSON.stringify({
    idToken: 'layout-fixture-token',
    expiresAt: 4000000000,
    user: {
      sub: 'google-sub-ravi',
      email: 'ravi.kumar@ourcompany.example',
      displayName: 'Ravi Kumar'
    }
  }));
`;

/**
 * Pins the device clock to the moment of the sync.
 *
 * Not cosmetic: the highlight is the server wall clock advanced by elapsed *device* time, so
 * without this the capture would drift out of the keynote as the suite ran. Three hours fast on
 * purpose, which is also a live demonstration that the offset correction survives the real browser –
 * an uncorrected implementation highlights nothing here.
 */
const PIN_DEVICE_CLOCK = `
  const skewed = Date.parse('2026-09-15T10:40:12.345Z');
  const RealDate = Date;
  Date.now = () => skewed;
  window.Date = class extends RealDate {
    constructor(...args) {
      super(...(args.length === 0 ? [skewed] : args));
    }
  };
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

async function stubApi(page: Page): Promise<void> {
  await page.route('**/api/me/conferences', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MY_CONFERENCES),
    });
  });

  await page.route(`**/api/conferences/${KICKOFF}/schedule`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(SCHEDULE),
    });
  });

  // The organizer surfaces further down the page are not this capture's subject, but they must not
  // be left showing an error that changes the layout under it.
  await page.route('**/api/conferences', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ conferences: [] }),
    });
  });

  await page.addInitScript(SEED_SESSION);
  await page.addInitScript(PIN_DEVICE_CLOCK);
}

for (const viewport of VIEWPORTS) {
  test(`the attendee schedule renders without horizontal scrolling at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await stubApi(page);
    await page.goto('/');

    await expect(page.getByTestId('attendee-schedule')).toBeVisible();

    // Every conference day is reachable – three of them, wrapping rather than scrolling sideways.
    await expect(page.getByTestId('attendee-day-nav')).toBeVisible();
    for (const date of ['2026-09-14', '2026-09-15', '2026-09-16']) {
      await expect(page.getByTestId(`attendee-day-${date}`)).toBeVisible();
    }

    // The times, exactly as authored, and the location and kind beside them.
    const list = page.getByTestId('attendee-session-list');
    await expect(list).toBeVisible();
    await expect(list).toContainText('09:00–10:30');
    await expect(list).toContainText('Main Hall, ground floor');
    await expect(list).toContainText('Presentation');

    // The running highlight – present only because the offset correction worked in a real browser.
    await expect(page.getByTestId('running-keynote')).toBeVisible();

    // The concurrency marking, on every member of the parallel track, naming the others.
    for (const id of ['keynote', 'architecture', 'design']) {
      await expect(page.getByTestId(`concurrent-${id}`)).toBeVisible();
      await expect(page.getByTestId(`concurrent-${id}`)).toContainText('Parallel track');
    }

    // The picker, and day buttons, genuinely tappable on the narrowest phone.
    await expect(page.getByTestId('attendee-conference-picker')).toBeVisible();
    for (const testId of ['attendee-day-2026-09-15', 'attendee-conference-picker']) {
      const box = await page.getByTestId(testId).boundingBox();
      expect(box!.height, testId).toBeGreaterThanOrEqual(40);
    }

    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    for (const testId of [
      'attendee-panel',
      'attendee-day-nav',
      'attendee-session-list',
      'attendee-session-keynote',
      'attendee-session-design',
    ]) {
      await assertWithinViewport(page, testId, viewport.width);
    }

    await page.screenshot({
      path: `screenshots/attendee-schedule-${viewport.name}.png`,
      fullPage: true,
    });
  });

  /**
   * The same 375px promise, at a raised text size.
   *
   * Not a hypothetical setting: these assets run inside a Capacitor WebView (ADR-001), where the
   * OS font-scale preference drives every `rem` in the stylesheet. A time column that refused to
   * shrink used to push the "Now" badge – the one marking the corridor use-case exists for – clean
   * off a 375px screen at a 24px root, while every assertion at the default 16px stayed green. The
   * capture at 1280px is skipped: the failure is a narrow-viewport one.
   */
  if (viewport.width === 375) {
    for (const rootFontPx of [20, 24]) {
      test(`the schedule survives a ${rootFontPx}px root font at 375px`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await stubApi(page);
        await page.addInitScript(`
          document.addEventListener('DOMContentLoaded', () => {
            document.documentElement.style.fontSize = '${rootFontPx}px';
          });
        `);
        await page.goto('/');

        await expect(page.getByTestId('attendee-session-list')).toBeVisible();
        // The badge is still on screen, and still inside its own card.
        await expect(page.getByTestId('running-keynote')).toBeVisible();
        await assertWithinViewport(page, 'running-keynote', viewport.width);
        await assertWithinViewport(page, 'attendee-session-keynote', viewport.width);

        expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

        await page.screenshot({
          path: `screenshots/attendee-schedule-375-root${rootFontPx}.png`,
          fullPage: true,
        });
      });
    }
  }

  test(`the empty-day state stays within the viewport at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await stubApi(page);
    await page.goto('/');

    await expect(page.getByTestId('attendee-session-list')).toBeVisible();
    await page.getByTestId('attendee-day-2026-09-16').click();

    const empty = page.getByTestId('attendee-empty-day');
    await expect(empty).toBeVisible();
    await expect(empty).toContainText('2026-09-16');

    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await assertWithinViewport(page, 'attendee-empty-day', viewport.width);

    await page.screenshot({
      path: `screenshots/attendee-empty-day-${viewport.name}.png`,
      fullPage: true,
    });
  });
}
