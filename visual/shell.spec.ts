import { test, expect, type Page } from '@playwright/test';

/**
 * The app shell is legible one-handed at 375px and rescales to tablet and desktop. The three
 * widths are checked with the same assertions, because "responsive" here means the layout
 * reflows rather than being clipped or letterboxed.
 *
 * Both auth states are captured. Signed out is now the landing view (S02), and the signed-in
 * shell carries an identity block and a sign-out control that a narrow phone must fit without
 * either being pushed off-screen – the case a desktop-only check would miss entirely.
 */
const VIEWPORTS = [
  { name: 'phone-375', width: 375, height: 812 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'desktop-1280', width: 1280, height: 900 },
] as const;

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
 * Puts a session in place the way a completed redirect would, so the signed-in shell can be
 * captured without driving Google's consent screen. The token is never presented to a
 * protected route here – what is under test is the layout, and the health panel it renders
 * reads the anonymous readiness route.
 */
const SEED_SESSION = `
  window.localStorage.setItem('confapp.auth.session', JSON.stringify({
    idToken: 'layout-fixture-token',
    expiresAt: 4000000000,
    user: {
      sub: 'google-sub-anna',
      email: 'anna.andersson@ourcompany.example',
      displayName: 'Anna Andersson'
    }
  }));
`;

for (const viewport of VIEWPORTS) {
  test(`signed-out shell renders without horizontal scrolling at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/');

    // One primary action, and it is reachable and full-size even on the narrowest phone.
    const signIn = page.getByTestId('sign-in');
    await expect(signIn).toBeVisible();
    const signInBox = await signIn.boundingBox();
    expect(signInBox!.height).toBeGreaterThanOrEqual(40);

    // `exact` matters: "Sign in to confApp" also contains the brand name.
    await expect(page.getByRole('heading', { name: 'confApp', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: /sign in to confApp/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /menu/i })).toBeVisible();

    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await assertWithinViewport(page, 'sign-in', viewport.width);

    await page.screenshot({ path: `screenshots/signed-out-${viewport.name}.png`, fullPage: true });
  });

  test(`signed-in shell renders without horizontal scrolling at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.addInitScript(SEED_SESSION);
    await page.goto('/');

    // Identity and the way out are both present, and neither is clipped.
    const identity = page.getByTestId('signed-in-identity');
    await expect(identity).toBeVisible();
    await expect(identity).toContainText('Anna Andersson');

    const signOut = page.getByTestId('sign-out');
    await expect(signOut).toBeVisible();
    const signOutBox = await signOut.boundingBox();
    // Reachable one-handed: a real target, not a compressed sliver.
    expect(signOutBox!.height).toBeGreaterThanOrEqual(40);

    // The panel shows the live database value, so this is the full path, not a static render.
    const schemaVersion = page.getByTestId('schema-version');
    await expect(schemaVersion).toBeVisible();
    await expect(schemaVersion).not.toHaveText('–');
    await expect(page.getByTestId('server-time')).toBeVisible();

    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    for (const testId of ['signed-in-identity', 'sign-out', 'schema-version', 'server-time']) {
      await assertWithinViewport(page, testId, viewport.width);
    }

    await page.screenshot({ path: `screenshots/signed-in-${viewport.name}.png`, fullPage: true });
  });
}
