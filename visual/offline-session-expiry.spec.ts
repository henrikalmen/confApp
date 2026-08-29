import { test, expect, type Page } from '@playwright/test';

/**
 * `offline-session-expiry` TI09 – the sign-in-required state at phone, tablet and desktop widths.
 *
 * The one surface this story adds. It is a sentence and a control, and the sentence is the longer
 * of the two things that can break: a message an attendee has to scroll sideways to read is a
 * message that does not tell them what to do, and somebody holding a phone in a corridor with no
 * signal is the last person who should have to.
 *
 * **Offline is produced by aborting the API routes**, as in S10's captures – the app has to notice
 * for itself that the requests failed. The lapse is produced the same way: a stored session whose
 * `expiresAt` is in the past, so the credential accessor genuinely returns nothing.
 */

const VIEWPORTS = [
  { name: 'phone-375', width: 375, height: 812 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'desktop-1280', width: 1280, height: 900 },
] as const;

const AUTUMN_OFFSITE = '22222222-2222-4222-8222-222222222222';

/** The device clock at capture time – 2026-09-15, matching S10's fixtures. */
const PINNED = Date.parse('2026-09-15T07:40:12.345Z');

/**
 * A stored session whose token expired hours ago.
 *
 * The session itself is intact – token expiry is not a lifetime bound – so the app is signed in and
 * simply has no credential to present. That is exactly the state an attendee is in on the second
 * morning of a conference.
 */
const SEED_LAPSED_SESSION = `
  window.localStorage.setItem('confapp.auth.session', JSON.stringify({
    idToken: 'layout-fixture-token',
    expiresAt: Math.floor(Date.parse('2026-09-15T05:00:00Z') / 1000),
    user: {
      sub: 'google-sub-nadia',
      email: 'nadia.nilsson@ourcompany.example',
      displayName: 'Nadia Nilsson'
    }
  }));
  window.localStorage.setItem('confapp.auth.lastSub', 'google-sub-nadia');
`;

const PIN_DEVICE_CLOCK = `
  const pinned = ${PINNED};
  Date.now = () => pinned;
`;

/**
 * The browser reporting no link.
 *
 * Stubbed rather than driven through `context.setOffline`, which would also cut the dev server that
 * is serving the app itself – the same reason S10's captures abort the API routes instead. What is
 * being captured here is the state of a device with no connection, and `navigator.onLine` is the
 * seam the control's disabled state reads (TI10).
 */
const REPORT_OFFLINE = `
  Object.defineProperty(navigator, 'onLine', { get: () => false, configurable: true });
`;

/**
 * The runtime configuration the SPA container writes from the environment at start.
 *
 * Served **in place of `config.js`** rather than through an init script, because `config.js` is a
 * real script the page loads and it assigns `window.__CONFAPP_CONFIG__` outright – an init script
 * would be overwritten by it a moment later, and the app would report that sign-in is not
 * configured. Replacing the file is also what the container itself does.
 *
 * Nothing here is used to reach anywhere: every API route is aborted and no sign-in is started.
 * It exists so the shell renders, which is the precondition for capturing anything at all.
 */
const RUNTIME_CONFIG_JS = `
  window.__CONFAPP_CONFIG__ = {
    apiBaseUrl: '/api',
    auth: {
      clientId: 'layout-fixture.apps.googleusercontent.example',
      authorizationEndpoint: 'https://accounts.google.example/o/oauth2/v2/auth',
      hostedDomain: 'ourcompany.example',
      redirectUri: window.location.origin + '/auth/callback'
    }
  };
`;

/**
 * A conference that ended on 2025-10-03, cached that day and never opened since.
 *
 * Its name and the elapsed span are both realistic rather than minimal: the state has to hold a
 * real sentence at 375px, and a fixture built to fit would not prove that.
 */
const LAPSED_ENVELOPE = {
  conference: {
    id: AUTUMN_OFFSITE,
    name: 'Autumn Offsite',
    startDate: '2025-10-02',
    endDate: '2025-10-03',
    state: 'published',
    lastUpdatedAt: '2025-10-03T08:00:00.000000Z',
  },
  days: [
    {
      date: '2025-10-02',
      dayNumber: 1,
      sessions: [
        {
          id: 'keynote',
          title: 'Opening Keynote',
          description: null,
          kind: 'Presentation',
          startTime: '09:00',
          endTime: '10:30',
          location: 'Main Hall, ground floor',
          concurrentWith: [],
        },
      ],
    },
  ],
  serverNow: {
    instant: '2025-10-03T07:40:12.345678Z',
    day: '2025-10-03',
    time: '09:40',
  },
};

/**
 * Elapsed time since that sync, in days – enough to carry the effective clock from 2025-10-03 to
 * mid-September 2026, well past the seven-day margin.
 */
const ELAPSED_DAYS = 348;

const isApiRequest = (url: URL): boolean => url.pathname.startsWith('/api/');

/**
 * Writes the lapsed entry straight into IndexedDB and waits for the transaction to commit.
 *
 * Seeded rather than fetched, for S10's reason: a warm-up fetch would have to be allowed through
 * and then blocked, and the entry it left would carry a receipt reading tied to when the test
 * happened to run.
 */
async function seedLapsedCache(page: Page): Promise<void> {
  await page.evaluate(
    async ({ envelopeValue, conferenceId, ageMillis }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open('confapp-offline');
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
            watermark: '2025-10-03T08:00:00.000000Z',
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
    {
      envelopeValue: LAPSED_ENVELOPE,
      conferenceId: AUTUMN_OFFSITE,
      ageMillis: ELAPSED_DAYS * 86_400_000,
    },
  );
}

/**
 * Waits until the app has finished claiming the store for the signed-in subject.
 *
 * A cold launch adopts the store and empties it when it cannot show that subject already owns it –
 * which on a first visit it cannot. That claim is fired and not awaited by the app, so waiting for
 * the panel to render does not mean it has finished; seeding into the gap leaves the entry deleted
 * some of the time, which is a flaky capture rather than a failing one. The owner marker is written
 * last, so its presence is the signal that the claim is done and the store is safe to write into.
 */
async function waitForCacheClaimed(page: Page): Promise<void> {
  await page.waitForFunction(async () => {
    const db = await new Promise<IDBDatabase | null>((resolve) => {
      const open = indexedDB.open('confapp-offline');
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => resolve(null);
      open.onblocked = () => resolve(null);
    });
    if (db === null) return false;
    if (!db.objectStoreNames.contains('meta')) {
      db.close();
      return false;
    }

    const owner = await new Promise<unknown>((resolve) => {
      const tx = db.transaction(['meta'], 'readonly');
      const request = tx.objectStore('meta').get('owner-sub');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(undefined);
    });
    db.close();
    return owner === 'google-sub-nadia';
  });
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

for (const viewport of VIEWPORTS) {
  test(`the sign-in-required state stays legible at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.route('**/config.js', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: RUNTIME_CONFIG_JS,
      }),
    );
    await page.addInitScript(SEED_LAPSED_SESSION);
    await page.addInitScript(PIN_DEVICE_CLOCK);
    await page.addInitScript(REPORT_OFFLINE);
    await page.route(isApiRequest, (route) => route.abort('failed'));

    // The origin has to exist before anything can be written to its storage, and the app has to
    // have finished claiming that storage – see `waitForCacheClaimed`.
    await page.goto('/');
    await expect(page.getByTestId('attendee-panel')).toBeVisible();
    await waitForCacheClaimed(page);
    await seedLapsedCache(page);
    await page.reload();

    const notice = page.getByTestId('schedule-sign-in-required');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(/sign-in has expired/i);
    // Distinct from S10's absent-cache state, which claims the opposite thing.
    await expect(page.getByTestId('schedule-unavailable-offline')).toHaveCount(0);
    // Terminal: no spinner left behind the message.
    await expect(page.getByTestId('attendee-loading')).toHaveCount(0);

    // The control is present and refuses to act, because signing in needs a connection (TI10).
    await expect(page.getByTestId('attendee-sign-in-again')).toBeDisabled();

    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    for (const testId of [
      'attendee-panel',
      'schedule-sign-in-required',
      'attendee-sign-in-again',
    ]) {
      await assertWithinViewport(page, testId, viewport.width);
    }

    await page.screenshot({
      path: `screenshots/offline-sign-in-required-${viewport.name}.png`,
      fullPage: true,
    });
  });
}
