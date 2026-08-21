import { test, expect, type Page } from '@playwright/test';

/**
 * S10 TI11 – the three surfaces this story adds, at phone, tablet and desktop widths.
 *
 * The cached-with-elapsed-age label, the "not available offline" state, and the reconnect summary.
 * All three are sentences rather than controls, and all three carry values that can be long: a
 * session title an organizer typed, a room name, a duration. That is the failure this captures – a
 * summary an attendee has to scroll sideways to read is a summary that does not tell them what
 * moved, and somebody standing in a corridor with no signal is the last person who should have to.
 *
 * **Offline is produced by aborting the API routes**, not by a flag: the app has to notice for
 * itself that the requests failed, exactly as it does on dead venue wifi. The static assets still
 * come from the dev server, which is what a Capacitor shell and a service-worker-warmed browser
 * both look like on a cold offline launch.
 */

const VIEWPORTS = [
  { name: 'phone-375', width: 375, height: 812 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'desktop-1280', width: 1280, height: 900 },
] as const;

const CONFERENCE_ID = '11111111-1111-4111-8111-111111111111';
const LEADERSHIP_ID = '33333333-3333-4333-8333-333333333333';

const SERVER_NOW = {
  instant: '2026-09-15T07:40:12.345678Z',
  day: '2026-09-15',
  time: '09:40',
};

const FIRST_WATERMARK = '2026-09-15T07:36:12.000000Z';
const SECOND_WATERMARK = '2026-09-15T09:15:00.000000Z';

/** Long enough that a layout which does not wrap will push a 375px phone sideways. */
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
      startTime: '13:00',
      endTime: '14:00',
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

/** One added, one moved, one removed – the three-item summary the criterion names. */
const AFTER = envelope(
  [
    attendeeSession({ id: 'keynote', title: 'Opening Keynote' }),
    attendeeSession({
      id: 'lightning',
      title: 'Lightning Talks: five things we learned shipping the new onboarding flow',
      startTime: '11:00',
      endTime: '11:30',
      location: LONG_LOCATION,
    }),
    attendeeSession({
      id: 'design',
      title: LONG_TITLE,
      kind: 'Workshop',
      startTime: '14:30',
      endTime: '15:30',
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

const SEED_SESSION = `
  window.localStorage.setItem('confapp.auth.session', JSON.stringify({
    idToken: 'layout-fixture-token',
    expiresAt: 4000000000,
    user: {
      sub: 'google-sub-nadia',
      email: 'nadia.nilsson@ourcompany.example',
      displayName: 'Nadia Nilsson'
    }
  }));
  window.localStorage.setItem('confapp.auth.lastSub', 'google-sub-nadia');
`;

/**
 * The device clock, pinned before anything runs, so every capture shows the same elapsed age.
 *
 * `Date.now` only – the poll's `setInterval` is left alone, because the reconnect capture depends
 * on that poll arriving by itself.
 */
const PIN_DEVICE_CLOCK = `
  const pinned = Date.parse('2026-09-15T07:40:12.345Z');
  Date.now = () => pinned;
`;

/**
 * Writes the cache entry the offline states render from, straight into IndexedDB, and **waits for
 * the transaction to commit** before returning.
 *
 * Seeded rather than fetched, because these captures are of the *offline* screens: a warm-up fetch
 * would have to be allowed through and then blocked, and the entry it left would carry a receipt
 * reading tied to when the test happened to run. Fixing it here fixes the age in every capture.
 *
 * It runs as an evaluated step followed by a reload rather than as an init script, because an init
 * script cannot be awaited: the app would race the write and find the cache empty about as often as
 * not, which is a flaky capture rather than a failing one.
 */
async function seedCache(
  page: Page,
  envelopeValue: Record<string, unknown>,
  watermark: string,
  ageMillis: number,
): Promise<void> {
  await page.evaluate(
    async ({ envelopeValue, watermark, ageMillis, conferenceId }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open('confapp-offline', 1);
        open.onupgradeneeded = () => {
          const database = open.result;
          if (!database.objectStoreNames.contains('schedules')) {
            database.createObjectStore('schedules');
          }
          if (!database.objectStoreNames.contains('meta')) database.createObjectStore('meta');
        };
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });

      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['schedules', 'meta'], 'readwrite');
        tx.objectStore('schedules').put(
          {
            envelope: envelopeValue,
            watermark,
            deviceClockAtReceipt: Date.now() - ageMillis,
          },
          ['google-sub-nadia', conferenceId],
        );
        tx.objectStore('meta').put('google-sub-nadia', 'owner-sub');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { envelopeValue, watermark, ageMillis, conferenceId: CONFERENCE_ID },
  );
}

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

/**
 * Matches the API and only the API.
 *
 * A glob on `api` is not the same thing under the dev server: it also matches
 * `/src/api/client.ts`, which Vite serves unbundled, so the app never loads and every offline
 * assertion fails against a blank page rather than against the state it was written for. The
 * pathname prefix is the only form that means "the API" in both the dev server and the built app.
 */
const isApiRequest = (url: URL): boolean => url.pathname.startsWith('/api/');

/** Every API route dead. The state an attendee is in when the venue wifi stops answering. */
async function cutTheNetwork(page: Page): Promise<void> {
  await page.route(isApiRequest, (route) => route.abort('failed'));
}

// ---------- the cached label, and the schedule beneath it ----------

for (const viewport of VIEWPORTS) {
  test(`the cached-with-age label stays legible at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.addInitScript(SEED_SESSION);
    await page.addInitScript(PIN_DEVICE_CLOCK);
    await cutTheNetwork(page);

    // The origin has to exist before anything can be written to its storage, so the first visit is
    // only what opens it. Four minutes of age, so the label reads a duration and not "just now".
    await page.goto('/');
    await seedCache(page, BEFORE, FIRST_WATERMARK, 4 * 60_000);
    await page.reload();

    const label = page.getByTestId('schedule-cached-label');
    await expect(label).toBeVisible();
    // An elapsed age, never a clock time converted from the watermark instant.
    await expect(label).toContainText(/ago|just now/i);
    await expect(label).toContainText(/saved on this device/i);

    // The normal schedule view, from the cache – same component tree, same authored times.
    await expect(page.getByTestId('attendee-schedule')).toBeVisible();
    await expect(page.getByTestId('attendee-session-keynote')).toContainText('09:00–10:30');

    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    for (const testId of ['attendee-panel', 'schedule-cached-label', 'attendee-session-list']) {
      await assertWithinViewport(page, testId, viewport.width);
    }

    await page.screenshot({
      path: `screenshots/offline-cached-${viewport.name}.png`,
      fullPage: true,
    });
  });
}

// ---------- the terminal "not available offline" state ----------

for (const viewport of VIEWPORTS) {
  test(`the not-available-offline state stays legible at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.addInitScript(SEED_SESSION);

    // The list is known; the schedule is the request that cannot be made, and nothing is cached.
    await page.route('**/api/me/conferences', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          conferences: [
            {
              id: LEADERSHIP_ID,
              name: 'Leadership Day',
              startDate: '2026-09-15',
              endDate: '2026-09-15',
              state: 'published',
            },
          ],
          defaultConferenceId: LEADERSHIP_ID,
        }),
      }),
    );
    await page.route(`**/api/conferences/${LEADERSHIP_ID}/**`, (route) => route.abort('failed'));
    await page.route('**/api/conferences', (route) => route.abort('failed'));
    await page.route('**/api/health', (route) => route.abort('failed'));

    await page.goto('/');

    const state = page.getByTestId('schedule-unavailable-offline');
    await expect(state).toBeVisible();
    await expect(state).toContainText(/not available offline/i);
    // Terminal: no spinner left behind the message.
    await expect(page.getByTestId('attendee-loading')).toHaveCount(0);

    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await assertWithinViewport(page, 'schedule-unavailable-offline', viewport.width);

    await page.screenshot({
      path: `screenshots/offline-unavailable-${viewport.name}.png`,
      fullPage: true,
    });
  });
}

// ---------- the reconnect summary ----------

for (const viewport of VIEWPORTS) {
  test(`the three-item what-changed summary stays legible at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.addInitScript(SEED_SESSION);
    await page.addInitScript(PIN_DEVICE_CLOCK);

    /*
     * Offline first, so the view opens on the cache; then the routes answer, so the poll that is
     * already running finds the connection back. Nothing in this test reloads or presses anything -
     * the summary has to arrive on its own, which is the whole claim.
     */
    let reachable = false;
    await page.route(isApiRequest, async (route) => {
      if (!reachable) return route.abort('failed');

      const url = route.request().url();
      const body = url.includes('/schedule/watermark')
        ? { lastUpdatedAt: SECOND_WATERMARK, state: 'published' }
        : url.includes('/schedule')
          ? AFTER
          : url.includes('/me/conferences')
            ? MY_CONFERENCES
            : { conferences: [] };

      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    });

    await page.goto('/');
    await seedCache(page, BEFORE, FIRST_WATERMARK, 19 * 60_000);
    await page.reload();
    await expect(page.getByTestId('schedule-cached-label')).toBeVisible();

    reachable = true;

    const summary = page.getByTestId('reconnect-summary');
    await expect(summary).toBeVisible({ timeout: 20_000 });
    // One added, one moved with both times named, one removed.
    await expect(summary).toContainText('Lightning Talks');
    await expect(summary).toContainText('14:30–15:30');
    await expect(summary).toContainText('13:00–14:00');
    await expect(summary).toContainText('Retrospective was removed');

    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    for (const testId of ['attendee-panel', 'reconnect-summary', 'attendee-session-list']) {
      await assertWithinViewport(page, testId, viewport.width);
    }

    // The dismiss control is genuinely tappable on the narrowest phone.
    const dismiss = await page.getByTestId('reconnect-summary-dismiss').boundingBox();
    expect(dismiss!.height).toBeGreaterThanOrEqual(40);

    await page.screenshot({
      path: `screenshots/offline-reconnect-${viewport.name}.png`,
      fullPage: true,
    });
  });
}
