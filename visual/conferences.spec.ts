import { test, expect, type Page } from '@playwright/test';

/**
 * TI12 – the organizer surfaces at phone, tablet and desktop widths.
 *
 * The list, the create form and the detail view are each captured at all three, because
 * "responsive" here means the layout reflows rather than being clipped: a card grid, a two-column
 * date row and a pair of lifecycle buttons are exactly the things that overflow a 375px phone.
 *
 * The conference API is served from fixtures rather than the live one. The subject is the layout,
 * and reaching the real endpoints would need a genuine Google sign-in – whereas the states that
 * actually have to be seen (an archived conference beside an active one, a field-level refusal)
 * are ones a live database would have to be manoeuvred into anyway. `/api/health` is deliberately
 * left alone, so the shell below still renders against the real service.
 */

const VIEWPORTS = [
  { name: 'phone-375', width: 375, height: 812 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'desktop-1280', width: 1280, height: 900 },
] as const;

const CONFERENCES = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Autumn Kickoff 2026',
    startDate: '2026-09-14',
    endDate: '2026-09-16',
    lifecycleState: 'draft',
    updatedAt: '2026-08-17T10:00:00.000Z',
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Summer Strategy Days 2026',
    startDate: '2026-06-02',
    endDate: '2026-06-05',
    lifecycleState: 'published',
    updatedAt: '2026-06-01T10:00:00.000Z',
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    // A deliberately long name: the phone case where a card pushes the page sideways.
    name: 'Spring Retrospective and Planning Offsite 2025',
    startDate: '2025-04-01',
    endDate: '2025-04-02',
    lifecycleState: 'archived',
    updatedAt: '2025-04-03T10:00:00.000Z',
  },
] as const;

const SPAN_REFUSAL = {
  error: {
    code: 'CONFERENCE_DATE_SPAN_INVALID',
    message: 'A conference runs for between 1 and 4 consecutive days, and these dates span 5.',
    details: [
      {
        field: 'startDate',
        message: 'A conference runs for between 1 and 4 consecutive days, and these dates span 5.',
      },
      {
        field: 'endDate',
        message: 'A conference runs for between 1 and 4 consecutive days, and these dates span 5.',
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

async function stubConferenceApi(page: Page): Promise<void> {
  // The create attempt is refused, so the field-level message is on screen in the capture.
  await page.route('**/api/conferences', async (route) => {
    const refused = route.request().method() === 'POST';
    await route.fulfill({
      status: refused ? 400 : 200,
      contentType: 'application/json',
      body: JSON.stringify(refused ? SPAN_REFUSAL : { conferences: CONFERENCES }),
    });
  });

  await page.addInitScript(SEED_SESSION);
}

for (const viewport of VIEWPORTS) {
  test(`conference list and create form render without horizontal scrolling at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await stubConferenceApi(page);
    await page.goto('/');

    await expect(page.getByTestId('conference-list')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Your conferences' })).toBeVisible();

    // An archived conference sits beside active ones and is distinguished by its own treatment.
    const archived = page.getByTestId(`conference-${CONFERENCES[2].id}`);
    await expect(archived).toHaveClass(/conference--archived/);
    await expect(page.getByTestId('badge-archived')).toBeVisible();
    await expect(page.getByTestId('badge-draft')).toBeVisible();
    await expect(page.getByTestId('badge-published')).toBeVisible();

    // The create form, and its controls at a real tappable size on the narrowest phone.
    await expect(page.getByTestId('conference-form')).toBeVisible();
    const nameInput = page.getByLabel('Conference name');
    const nameBox = await nameInput.boundingBox();
    expect(nameBox!.height).toBeGreaterThanOrEqual(40);
    expect(nameBox!.width).toBeLessThanOrEqual(viewport.width);

    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    for (const testId of ['conference-list', 'conference-form', `conference-${CONFERENCES[2].id}`]) {
      await assertWithinViewport(page, testId, viewport.width);
    }

    await page.screenshot({
      path: `screenshots/conferences-list-${viewport.name}.png`,
      fullPage: true,
    });
  });

  test(`the create form shows a field-level refusal without overflowing at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await stubConferenceApi(page);
    await page.goto('/');

    await page.getByLabel('Conference name').fill('Autumn Kickoff 2026');
    await page.getByLabel('First day').fill('2026-09-14');
    await page.getByLabel('Last day').fill('2026-09-18');
    await page.getByRole('button', { name: 'Create conference' }).click();

    // The permitted range, against the date field, in the server's own words.
    const error = page.getByTestId('error-dates');
    await expect(error).toBeVisible();
    await expect(error).toContainText('between 1 and 4 consecutive days');

    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await assertWithinViewport(page, 'error-dates', viewport.width);

    await page.screenshot({
      path: `screenshots/conferences-create-error-${viewport.name}.png`,
      fullPage: true,
    });
  });

  test(`the conference detail view renders without horizontal scrolling at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await stubConferenceApi(page);
    await page.goto('/');

    await page.getByText('Autumn Kickoff 2026').click();

    const detail = page.getByTestId('conference-detail');
    await expect(detail).toBeVisible();
    await expect(page.getByTestId('detail-span')).toHaveText('2026-09-14 – 2026-09-16');

    // Both lifecycle controls are present and full-size; the draft offers publish, not archive.
    for (const testId of ['publish', 'archive']) {
      const box = await page.getByTestId(testId).boundingBox();
      expect(box!.height, testId).toBeGreaterThanOrEqual(40);
    }
    await expect(page.getByTestId('publish')).toBeEnabled();
    await expect(page.getByTestId('archive')).toBeDisabled();

    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    for (const testId of ['conference-detail', 'publish', 'archive', 'back-to-list']) {
      await assertWithinViewport(page, testId, viewport.width);
    }

    await page.screenshot({
      path: `screenshots/conferences-detail-${viewport.name}.png`,
      fullPage: true,
    });
  });
}
