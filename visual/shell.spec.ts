import { test, expect, type Page } from '@playwright/test';

/**
 * Acceptance Scenario S05 – the app shell is legible one-handed at 375px and rescales to
 * tablet and desktop. The three widths are checked with the same assertions, because
 * "responsive" here means the layout reflows rather than being clipped or letterboxed.
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

for (const viewport of VIEWPORTS) {
  test(`shell renders without horizontal scrolling at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/');

    // The panel shows the live database value, so this is the full path, not a static render.
    const schemaVersion = page.getByTestId('schema-version');
    await expect(schemaVersion).toBeVisible();
    await expect(schemaVersion).not.toHaveText('–');

    // Header, navigation affordance and the health panel are all present and readable.
    await expect(page.getByRole('heading', { name: 'confApp' })).toBeVisible();
    await expect(page.getByRole('button', { name: /menu/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Service health' })).toBeVisible();
    await expect(page.getByTestId('server-time')).toBeVisible();

    // Reflow, not clipping: nothing may push the document wider than the viewport.
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

    // Nothing is clipped out of the viewport horizontally either.
    for (const testId of ['schema-version', 'server-time']) {
      const box = await page.getByTestId(testId).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
    }

    await page.screenshot({
      path: `screenshots/${viewport.name}.png`,
      fullPage: true,
    });
  });
}
