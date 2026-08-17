import { test, expect, type Page } from '@playwright/test';

/**
 * TI09 – the join-code entry screen and the Organizer code panel at phone, tablet and desktop widths.
 *
 * The three widths are checked with the same assertions, because "responsive" here means the layout
 * reflows rather than being clipped. The specific things that overflow a 375px phone are the ones
 * captured: a monospaced code with wide letter-spacing sitting beside a long conference name, a field
 * and a button on one row, and a refusal sentence long enough to wrap several times.
 *
 * A refusal is deliberately on screen in the entry capture. An empty form tells you nothing about the
 * state a person actually spends time looking at, and the refusal is the state PRD User Flow 5 is
 * about – it has to be legible and leave the controls reachable at 375px, not just exist.
 *
 * The API is served from fixtures rather than the live one. The subject is the layout, and reaching the
 * real endpoints would need a genuine Google sign-in – whereas the states that have to be seen (a
 * refused code, a conference with a code to share) are ones a live database would have to be
 * manoeuvred into anyway. `/api/health` is left alone, so the shell below still renders against the
 * real service.
 */

const VIEWPORTS = [
  { name: 'phone-375', width: 375, height: 812 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'desktop-1280', width: 1280, height: 900 },
] as const;

const CONFERENCE_ID = '22222222-2222-4222-8222-222222222222';

const CONFERENCES = [
  {
    id: CONFERENCE_ID,
    // A deliberately long name: the phone case where the code and the name share a row.
    name: 'Autumn Kickoff and Strategy Offsite 2026',
    startDate: '2026-09-14',
    endDate: '2026-09-16',
    lifecycleState: 'published',
    updatedAt: '2026-08-17T10:00:00.000Z',
  },
] as const;

const JOIN_REFUSAL = {
  error: {
    code: 'JOIN_CONFERENCE_ARCHIVED',
    message:
      'That code is for "Spring Retrospective and Planning Offsite 2025", which has been archived ' +
      'and can no longer be joined.',
  },
};

const SEED_SESSION = `
  window.localStorage.setItem('confapp.auth.session', JSON.stringify({
    idToken: 'layout-fixture-token',
    expiresAt: 4000000000,
    user: {
      sub: 'google-sub-priya',
      email: 'priya.patel@ourcompany.example',
      displayName: 'Priya Patel'
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

async function stubApi(page: Page): Promise<void> {
  await page.route('**/api/conferences', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ conferences: CONFERENCES }),
    });
  });

  // The join attempt is refused, so the refusal is on screen in the capture.
  await page.route('**/api/join', async (route) => {
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify(JOIN_REFUSAL),
    });
  });

  await page.route(`**/api/conferences/${CONFERENCE_ID}/join-code`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        conferenceId: CONFERENCE_ID,
        joinCode: 'K7RM4P',
        lifecycleState: 'published',
      }),
    });
  });

  // The Organizer's schedule read is not this story's subject, but the detail view renders it.
  await page.route(`**/api/conferences/${CONFERENCE_ID}/schedule/organizer`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        conference: {
          id: CONFERENCE_ID,
          name: CONFERENCES[0].name,
          startDate: CONFERENCES[0].startDate,
          endDate: CONFERENCES[0].endDate,
          lifecycleState: 'published',
          lastUpdatedAt: '2026-08-17T10:00:00.000Z',
        },
        days: [
          { day: '2026-09-14', sessions: [] },
          { day: '2026-09-15', sessions: [] },
          { day: '2026-09-16', sessions: [] },
        ],
        overlaps: [],
      }),
    });
  });

  await page.addInitScript(SEED_SESSION);
}

for (const viewport of VIEWPORTS) {
  test(`the join-code entry screen carries a refusal without overflowing at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await stubApi(page);
    await page.goto('/');

    const input = page.getByTestId('join-code-input');
    await expect(input).toBeVisible();

    // A real tappable target on the narrowest phone, and never wider than the viewport.
    const inputBox = await input.boundingBox();
    expect(inputBox!.height).toBeGreaterThanOrEqual(40);
    expect(inputBox!.width).toBeLessThanOrEqual(viewport.width);

    await input.fill('EF45GH');
    await page.getByTestId('join-submit').click();

    // The refusal, in the server's own words, fully on screen.
    const refusal = page.getByTestId('join-refusal');
    await expect(refusal).toBeVisible();
    await expect(refusal).toContainText('has been archived');

    // TI10's affordances, verified as *rendered* rather than only as state: the value survives and
    // the submit is reachable at this width.
    await expect(input).toHaveValue('EF45GH');
    await expect(input).toBeEditable();
    const submitBox = await page.getByTestId('join-submit').boundingBox();
    expect(submitBox!.height).toBeGreaterThanOrEqual(40);

    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    for (const testId of ['join-panel', 'join-code-input', 'join-submit', 'join-refusal']) {
      await assertWithinViewport(page, testId, viewport.width);
    }

    await page.screenshot({
      path: `screenshots/join-code-entry-${viewport.name}.png`,
      fullPage: true,
    });
  });

  test(`the organizer code panel renders without overflowing at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await stubApi(page);
    await page.goto('/');

    // Into the conference detail, which is where the code panel lives.
    await page.getByText(CONFERENCES[0].name).click();

    const code = page.getByTestId('join-code-value');
    await expect(code).toBeVisible();
    await expect(code).toHaveText('K7RM4P');

    // The regenerate control is a real target, and the warning about it is readable beside it.
    const regenerate = page.getByTestId('regenerate-join-code');
    await expect(regenerate).toBeVisible();
    const regenerateBox = await regenerate.boundingBox();
    expect(regenerateBox!.height).toBeGreaterThanOrEqual(40);
    await expect(page.getByTestId('join-code-panel')).toContainText('old one stops working');

    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    for (const testId of ['join-code-panel', 'join-code-value', 'regenerate-join-code']) {
      await assertWithinViewport(page, testId, viewport.width);
    }

    await page.screenshot({
      path: `screenshots/join-code-panel-${viewport.name}.png`,
      fullPage: true,
    });
  });
}
