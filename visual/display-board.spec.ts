import { test, expect, type Page } from '@playwright/test';

/**
 * The projected Board's own document (S04 TI09), at phone, tablet and desktop widths.
 *
 * A room screen is a desktop-shaped surface, but this document is served from the same origin as
 * the app and a facilitator will open the link on their phone to check it before it goes on the
 * wall - so it is held to the same standing criterion as every other surface. The
 * projection-**scale** design, and the overflow behaviour at the ~200 post-it / ~20 category
 * ceiling, are S07's and are captured in the projection-class block at the bottom of this file;
 * what is captured *here* is that the entry point resolves and renders at all three widths without
 * pushing the page sideways. Neither of these three captures discharges S07 (see that block).
 *
 * The API is stubbed. The subject is the document and the layout, and the two states worth seeing -
 * a board with named post-its, and the one neutral sentence a dead link produces - are exactly the
 * two this story ships.
 */

const VIEWPORTS = [
  { name: 'phone-375', width: 375, height: 812 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'desktop-1280', width: 1280, height: 900 },
] as const;

const TOKEN = 'wJq3B7nVYt1sK0pLmXcZaR8dEfGhIjKlMnOpQrStUvW';

/** An unbroken token is what actually pushes a 375px phone sideways, so the fixture carries one. */
const UNBROKEN = 'HandoverBetweenPlatformAndProductWhereNobodyOwnsTheMiddleBit2026Q3Followup';

const BOARD = {
  prompt:
    'What slows us down most between an idea being agreed in a workshop and it actually reaching ' +
    'the people it was meant to help?',
  categories: [
    {
      id: 'cat-tooling',
      name: `Tooling and the handover in the middle – ${UNBROKEN}`,
      postItCount: 2,
      postIts: [
        {
          id: 'p-1',
          text: `Review queue backed up on Fridays. ${UNBROKEN}`,
          authorName: 'Ada Lovelace',
        },
        { id: 'p-2', text: 'Nobody owns the deploy checklist', authorName: 'Dev Patel' },
      ],
    },
  ],
  uncategorised: {
    postItCount: 1,
    postIts: [{ id: 'p-3', text: 'Waiting three days for test data', authorName: 'Bo Nilsson' }],
  },
};

const UNAVAILABLE = {
  error: { code: 'DISPLAY_LINK_UNAVAILABLE', message: 'This board is no longer available.' },
};

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

for (const viewport of VIEWPORTS) {
  test(`the projected board renders from its own entry point at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.route(`**/api/display/${TOKEN}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(BOARD),
      }),
    );

    await page.goto(`/display/${TOKEN}`);
    await expect(page.getByTestId('display-board')).toBeVisible();

    // The board, under its authors' names, with no signed-in session anywhere in this document.
    await expect(page.getByTestId('display-post-it-p-1')).toContainText('Ada Lovelace');
    // The count is the server's `postItCount`, drawn as the number S01's projected wireframe draws.
    await expect(page.getByTestId('display-uncategorised-count')).toHaveText('1');
    // No application shell: nothing to navigate to, and nothing to sign in with.
    await expect(page.locator('#root')).toHaveCount(0);
    await expect(page.getByRole('button')).toHaveCount(0);

    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

    await page.screenshot({
      path: `screenshots/display-board-${viewport.name}.png`,
      fullPage: true,
    });
  });
}

test('a dead link renders the one neutral sentence', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route('**/api/display/**', (route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify(UNAVAILABLE),
    }),
  );

  await page.goto(`/display/${TOKEN}`);
  await expect(page.getByTestId('display-message')).toHaveText(
    'This board is no longer available.',
  );
  // Nothing about why, and nothing offering a way in.
  await expect(page.getByRole('button')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(/sign in|revoked|expired|draft/i);

  await page.screenshot({ path: 'screenshots/display-board-unavailable.png', fullPage: true });
});

/**
 * ---------------------------------------------------------------------------------------------
 * The projection viewport class (S07 TI09) – **1920×1080, and its own class**.
 *
 * Deliberately separate from the three tests above, which hold the display *document* to the
 * standing 375/768/1280 bar. Neither those captures nor the 1280px layout at a larger root font
 * discharges this story: reading distance here is metres, there is no pointer, and the content is
 * fixed at the design ceiling rather than scrollable, which is a different design problem from a
 * desktop window (`prd.md#non-functional-requirements`, `plan.json#executionNotes`).
 *
 * The checks are the ones S01's own validation run made against the wireframes
 * (`docs/wireframes/facilitator-board-and-categorisation/validation-report.md`), so the
 * implementation is measured against the design on the same terms:
 *
 *   - one screen, with **no scroll extent in either axis** – there is no scrollbar to reach for,
 *     because there is nobody at the machine to reach for one;
 *   - **every region on screen** with a non-empty name and a non-empty count;
 *   - **every declared post-it laid out**, and none of them outside the region holding it – the
 *     geometric reading, which a container cannot satisfy merely by reporting its content's height;
 *   - **no author name clipped**: only post-it *text* ever gives up its tail;
 *   - **no element clipped that is not clipped on purpose** – measured per element, because the
 *     page's own `scrollWidth - clientWidth` misses text overflowing its own box
 *     (`docs/LEARNINGS.md#css--responsive-layout`); and
 *   - **no control of any kind**, on any of the four states.
 */

const PROJECTION = { name: 'projection-1920', width: 1920, height: 1080 } as const;

/**
 * The design ceiling as S01 drew it: 20 Categories plus Uncategorised, 200 post-its, distributed
 * the way the wireframe distributes them – 16 Categories of 11, then 2, 3, 4 and 4, with 11 held in
 * Uncategorised. Measuring against a different distribution would be measuring a different design.
 */
const CEILING_SIZES = [11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 2, 3, 4, 4];

function ceilingBoard() {
  let next = 0;
  const postIt = (): { id: string; text: string; authorName: string } => {
    next += 1;
    return {
      id: `p-${next}`,
      // One post-it carries an unbroken, non-hyphenated run: a hyphenated token breaks on its own
      // and proves nothing about the layout (`docs/LEARNINGS.md#css--responsive-layout`).
      text:
        next === 1
          ? `Review queue backed up on Fridays ${UNBROKEN}`
          : `Post-it number ${next} – something a person actually wrote in the room that week.`,
      authorName: `Author Name ${next}`,
    };
  };
  const categories = CEILING_SIZES.map((size, index) => {
    const postIts = Array.from({ length: size }, postIt);
    return {
      id: `cat-${index + 1}`,
      name: index === 0 ? `Tooling and the handover – ${UNBROKEN}` : `Category number ${index + 1}`,
      postIts,
      postItCount: postIts.length,
    };
  });
  const held = Array.from({ length: 200 - next }, postIt);
  return {
    prompt: 'What slows you down most in a normal week?',
    categories,
    uncategorised: { postIts: held, postItCount: held.length },
  };
}

/** The same 200 Post-its across the same 20 Categories, distributed however a session left them. */
function skewedBoard(sizes: number[]) {
  let next = 0;
  const postIt = () => {
    next += 1;
    return {
      id: `p-${next}`,
      text: `Post-it number ${next} - something a person actually wrote in the room that week.`,
      authorName: `Author Name ${next}`,
    };
  };
  const categories = sizes.map((size, index) => {
    const postIts = Array.from({ length: size }, postIt);
    return {
      id: `cat-${index + 1}`,
      name: `Category number ${index + 1}`,
      postIts,
      postItCount: postIts.length,
    };
  });
  const held = Array.from({ length: Math.max(0, 200 - next) }, postIt);
  return {
    prompt: 'What slows you down most in a normal week?',
    categories,
    uncategorised: { postIts: held, postItCount: held.length },
  };
}

const EMPTY_BOARD = {
  prompt: 'What slows you down most in a normal week?',
  categories: [
    { id: 'c-1', name: 'Recognition and thanks', postIts: [], postItCount: 0 },
    { id: 'c-2', name: 'Tooling gaps', postIts: [], postItCount: 0 },
    { id: 'c-3', name: 'Meeting overload', postIts: [], postItCount: 0 },
    { id: 'c-4', name: 'Release process', postIts: [], postItCount: 0 },
  ],
  uncategorised: { postIts: [], postItCount: 0 },
};

/** Elements whose own box is narrower than their content, excluding the ones clipped by design. */
async function clippedUnintentionally(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const offenders: string[] = [];
    for (const element of document.querySelectorAll<HTMLElement>('body *')) {
      /*
       * **Only Post-it text is exempt**, because it is the only thing S01's decision allows to give
       * up its tail. Exempting everything with `overflow-x: hidden` would have quietly excused the
       * Category name, the count and the region body too - all of which clip for their own reasons -
       * and a newly clipping element would then never be seen (S07, 2026-08-31, review L3).
       */
      if (element.classList.contains('display-post-it__text')) continue;
      if (element.scrollWidth > element.clientWidth + 1) {
        offenders.push(
          `${element.className || element.tagName} ${element.scrollWidth}>${element.clientWidth}`,
        );
      }
    }
    return offenders;
  });
}

/**
 * The projection class's one-screen reading, as S01's own validation harness made it.
 *
 * Two independent readings, because a container can satisfy a box reading merely by reporting its
 * content's height: the geometric one compares each post-it's rectangle against the rectangle of
 * the region holding it, and the scroll one asks whether the document has any extent to scroll at
 * all. Author names, Category names and counts are measured separately - only post-it *text* is
 * ever allowed to give up its tail.
 */
async function measureOneScreen(page: Page) {
  return page.evaluate(() => {
    const regions = [...document.querySelectorAll<HTMLElement>('.display-region')];
    return {
      /*
       * **Nothing is drawn below the legibility floor** (the 2026-09-01 amendment to S01's overflow
       * decision). The floor and the size the tier is about to use are both published by
       * `display.css` as registered `<length>` properties, so this reads the same two numbers the
       * surface itself compares rather than guessing a threshold: a region either draws its
       * Post-its at or above the floor, or draws none of them and says what it holds.
       */
      belowFloor: regions
        .filter((region) => region.querySelectorAll('.display-post-it').length > 0)
        .map((region) => {
          const list = region.querySelector('.display-post-its');
          if (list === null) return null;
          const styles = getComputedStyle(list);
          return {
            name: region.querySelector('.display-region__name')?.textContent ?? '',
            count: region.dataset.count ?? '',
            size: Number.parseFloat(styles.getPropertyValue('--display-post-it-size')),
            floor: Number.parseFloat(styles.getPropertyValue('--display-post-it-floor')),
          };
        })
        .filter((read) => read !== null && read.size < read.floor)
        .map((read) => `${read?.name} (${read?.count}) drawn at ${read?.size}px`),
      /** Regions that said what they hold instead of drawing it, and the sentence each said. */
      stated: regions
        .filter((region) => region.querySelector('.display-region__too-many') !== null)
        .map((region) => ({
          count: Number(region.dataset.count ?? '0'),
          text: region.querySelector('.display-region__too-many')?.textContent ?? '',
        })),
      /** How many Post-its are actually on the wall, across every region. */
      drawn: document.querySelectorAll('.display-post-it').length,
      namedAndCounted: regions.every(
        (region) =>
          (region.querySelector('.display-region__name')?.textContent ?? '').trim() !== '' &&
          (region.querySelector('.display-region__count')?.textContent ?? '').trim() !== '',
      ),
      escaped: regions.flatMap((region) => {
        const box = region.getBoundingClientRect();
        return [...region.querySelectorAll<HTMLElement>('.display-post-it')]
          .filter((item) => {
            const own = item.getBoundingClientRect();
            return own.bottom > box.bottom + 1 || own.right > box.right + 1;
          })
          .map((item) => item.textContent?.slice(0, 30) ?? '');
      }),
      namesClipped: [...document.querySelectorAll<HTMLElement>('.display-post-it__by')].filter(
        (name) => name.scrollWidth > name.clientWidth + 1,
      ).length,
      /*
       * **And no author name pushed out of the visible tile.** Rows clip inside their own box, so a
       * rect-only check on the Post-it would be satisfied by a layout that hides half of it. A
       * Post-it always displays its author's name - that is what a Post-it is - so the name's own
       * rectangle has to sit inside the body it was drawn in.
       */
      namesHidden: regions.flatMap((region) => {
        const body = region.querySelector('.display-region__body');
        if (body === null) return [];
        const box = body.getBoundingClientRect();
        return [...region.querySelectorAll<HTMLElement>('.display-post-it__by')]
          .filter((name) => {
            const own = name.getBoundingClientRect();
            return own.bottom > box.bottom + 1 || own.top < box.top - 1 || own.height === 0;
          })
          .map((name) => name.textContent ?? '');
      }),
      headsClipped: [
        ...document.querySelectorAll<HTMLElement>('.display-region__name, .display-region__count'),
      ].filter((head) => head.scrollWidth > head.clientWidth + 1).length,
      scroll: {
        x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        y: document.documentElement.scrollHeight - document.documentElement.clientHeight,
      },
    };
  });
}

/** Nothing on this class is pressable, on any of its four states. */
const CONTROLS =
  'button, a, input, select, textarea, form, details, summary, [onclick], [tabindex], [role="button"], [contenteditable], [draggable="true"]';

test.describe('the projected board view at its own viewport class', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: PROJECTION.width, height: PROJECTION.height });
  });

  test('projects the whole board at the design ceiling on one screen', async ({ page }) => {
    const board = ceilingBoard();
    await page.route(`**/api/display/${TOKEN}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(board),
      }),
    );

    await page.goto(`/display/${TOKEN}`);
    await expect(page.getByTestId('display-board')).toBeVisible();

    // Every region, with a name and a count, and every declared post-it laid out.
    await expect(page.locator('.display-region')).toHaveCount(21);
    await expect(page.locator('.display-post-it')).toHaveCount(200);
    await expect(page.getByTestId('display-meta')).toHaveText('200 post-its · 20 categories');

    const measured = await measureOneScreen(page);

    /*
     * S01's own ceiling is drawn in full: at about eleven to a tile the type is above the floor, so
     * nothing is replaced by a statement. This assertion passes with the floor and without it -
     * which is exactly why it is not enough on its own, and why the skewed fixtures below exist.
     */
    expect(measured.belowFloor).toEqual([]);
    expect(measured.stated).toEqual([]);
    expect(measured.drawn).toBe(200);
    expect(measured.namedAndCounted).toBe(true);
    expect(measured.escaped).toEqual([]);
    expect(measured.namesClipped).toBe(0);
    expect(measured.namesHidden).toEqual([]);
    expect(measured.headsClipped).toBe(0);
    // One screen: no scroll extent in either axis, and nothing to reveal by scrolling.
    expect(measured.scroll.x).toBeLessThanOrEqual(0);
    expect(measured.scroll.y).toBeLessThanOrEqual(0);

    expect(await clippedUnintentionally(page)).toEqual([]);
    await expect(page.locator(CONTROLS)).toHaveCount(0);

    await page.screenshot({ path: `screenshots/display-board-${PROJECTION.name}.png` });
  });

  /**
   * **The invariant, not the table** (S07, 2026-08-31, review H1).
   *
   * S01's decision says each region renders its Post-its at the richest tier *that lets all of them
   * fit its tile*, and gives a count-keyed table as the approximation. At the near-uniform
   * distribution S01 drew, the two agree. At the distribution a real sorting session produces - one
   * or two Categories accumulating most of the Board - they do not: the tier is chosen, the rows do
   * not fit, and on a surface with no scroll, no pointer and no input the surplus Post-its are
   * simply unreachable.
   *
   * Both fixtures hold **exactly 200 Post-its across 20 Categories** - inside the design ceiling,
   * only redistributed - so what is being measured is the layout rule and not the size of the
   * Board. Reverting the `--display-rows` fit cap in `display.css` makes this fail with dozens of
   * escaped Post-its; the shipped near-uniform fixture above does not notice at all, which is why
   * it is not enough on its own.
   *
   * **And the fit rule alone is not the whole answer either** (2026-09-01 amendment to S01's
   * decision). Fitting is geometric; being worth projecting is not. The cap had no floor, so the
   * 80-in-one-region tile fitted all eighty at about a fifth of a pixel and read as a grey band
   * beside a count pill of 80. Each of these three fixtures now also asserts that nothing is drawn
   * below the floor and that a region which cannot reach it says how many it holds instead -
   * removing the floor from `DisplayBoardView.tsx` makes `belowFloor` non-empty here.
   */
  for (const [name, sizes] of [
    [
      'most of the board in one category',
      [40, 20, 15, 12, 10, 10, 9, 8, 8, 7, 7, 6, 6, 5, 5, 5, 5, 4, 4, 4],
    ],
    ['almost all of it in one', [80, 10, 8, 8, 7, 7, 6, 6, 5, 5, 5, 5, 4, 4, 4, 4, 4, 4, 4, 4]],
    /*
     * Past about a hundred rows in one region the **gaps alone** used to exceed the tile, and the
     * type cap could not recover it - the Post-its were pushed back out (S07 second-pass review F1).
     * The gap is now capped against the tile height too, and this is what holds it there.
     */
    [
      'nearly the whole board in one',
      [150, 4, 4, 4, 3, 3, 3, 3, 3, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1],
    ],
  ] as const) {
    test(`keeps every post-it inside its region with ${name}`, async ({ page }) => {
      const board = skewedBoard([...sizes]);
      await page.route(`**/api/display/${TOKEN}`, (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(board),
        }),
      );

      await page.goto(`/display/${TOKEN}`);
      await expect(page.getByTestId('display-board')).toBeVisible();

      // Still 200 across 20, and still 21 regions: this is the ceiling, redistributed.
      await expect(page.locator('.display-region')).toHaveCount(21);
      await expect(page.getByTestId('display-meta')).toHaveText('200 post-its · 20 categories');

      const measured = await measureOneScreen(page);
      expect(measured.escaped, 'no post-it may be pushed out of its region').toEqual([]);

      /*
       * **The legibility floor** (2026-09-01 amendment). Every Post-it on the wall is drawn at or
       * above it; a region that could not reach it drew none of them and said what it holds instead,
       * naming the number. Without the floor this list is where the 80-in-one-region tile turns up,
       * drawn at about a fifth of a pixel.
       */
      expect(measured.belowFloor, 'no post-it may be drawn below the legibility floor').toEqual([]);
      for (const statement of measured.stated) {
        expect(statement.text).toContain(`${statement.count} post-its`);
      }
      /*
       * And every one of the 200 is still accounted for on the screen - drawn, or named in the
       * count of the region that holds it. Nothing is silently missing, and nothing needs an input
       * to reveal: the count pill on every region is unchanged and never degrades.
       */
      const accountedFor =
        measured.drawn + measured.stated.reduce((running, one) => running + one.count, 0);
      expect(accountedFor).toBe(200);
      expect(measured.namedAndCounted).toBe(true);
      expect(measured.namesClipped).toBe(0);
      expect(measured.namesHidden).toEqual([]);
      expect(measured.headsClipped).toBe(0);
      expect(measured.scroll.x).toBeLessThanOrEqual(0);
      expect(measured.scroll.y).toBeLessThanOrEqual(0);

      /*
       * And the Category name and its count keep their size whatever the region holds. They are
       * what a reader at the back of the room is actually reading, and S01's ordering is that they
       * never degrade - only Post-it detail does.
       */
      const headSizes = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('.display-region__name')].map(
          (name) => getComputedStyle(name).fontSize,
        ),
      );
      expect(new Set(headSizes).size).toBe(1);

      /*
       * Captured so the degradation can be *judged* rather than only measured: at forty in one
       * Category the type is small, which is the honest cost of "every Category on screen, nothing
       * unreachable, no input" at a skew the ceiling permits.
       */
      await page.screenshot({
        path: `screenshots/display-board-${PROJECTION.name}-skewed-${sizes[0]}.png`,
      });
    });
  }

  /**
   * **Both sides of the floor, in one layout** (2026-09-01 amendment to S01's overflow decision).
   *
   * A threshold is only honest if it is checked from both directions: a rule that hid everything, or
   * nothing, would satisfy a one-sided test. So this fixture puts two neighbouring Categories either
   * side of the line - thirteen and fourteen Post-its in tiles of identical height - and asserts that
   * the first still draws all thirteen and the second draws none and says what it holds.
   *
   * The counts are not written into this test as magic numbers to be believed: the two lengths
   * `display.css` publishes are read back off each region, so the test also states *why* each region
   * did what it did. If the type scale or the grid ever changes, the boundary moves and this fails
   * with the two sizes in the message rather than silently measuring a line that is no longer there.
   */
  test('draws a region at the legibility floor and states the one just past it', async ({
    page,
  }) => {
    const board = skewedBoard([
      13, 14, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 9, 9, 9, 8, 8, 8,
    ]);
    await page.route(`**/api/display/${TOKEN}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(board),
      }),
    );

    await page.goto(`/display/${TOKEN}`);
    await expect(page.getByTestId('display-board')).toBeVisible();

    const sides = await page.evaluate(() =>
      ['cat-1', 'cat-2'].map((id) => {
        const region = document.querySelector<HTMLElement>(
          `[data-testid="display-category-${id}"]`,
        );
        const list = region?.querySelector('.display-post-its') ?? null;
        const styles = list === null ? null : getComputedStyle(list);
        return {
          count: region?.dataset.count ?? '',
          pill: region?.querySelector('.display-region__count')?.textContent ?? '',
          drawn: region?.querySelectorAll('.display-post-it').length ?? -1,
          stated: region?.querySelector('.display-region__too-many')?.textContent ?? null,
          size:
            styles === null
              ? NaN
              : Number.parseFloat(styles.getPropertyValue('--display-post-it-size')),
          floor:
            styles === null
              ? NaN
              : Number.parseFloat(styles.getPropertyValue('--display-post-it-floor')),
        };
      }),
    );
    const [atFloor, pastFloor] = sides;

    // The region that clears the floor draws every one of its post-its, and says nothing extra.
    expect(atFloor?.count).toBe('13');
    expect(atFloor?.size).toBeGreaterThanOrEqual(atFloor?.floor ?? Infinity);
    expect(atFloor?.drawn).toBe(13);
    expect(atFloor?.stated).toBeNull();

    // The one just past it draws none of them and states what it holds, naming the number.
    expect(pastFloor?.count).toBe('14');
    expect(pastFloor?.size).toBeLessThan(pastFloor?.floor ?? 0);
    expect(pastFloor?.drawn).toBe(0);
    expect(pastFloor?.stated).toBe('14 post-its – too many to show at this size');

    /*
     * And S01's rule is intact across the line: both Categories are on screen, both keep their name
     * and their count pill at the size every other region has, nothing scrolls, and no input is
     * offered on either.
     */
    expect(atFloor?.pill).toBe('13');
    expect(pastFloor?.pill).toBe('14');
    const measured = await measureOneScreen(page);
    expect(measured.belowFloor).toEqual([]);
    expect(measured.namedAndCounted).toBe(true);
    expect(measured.escaped).toEqual([]);
    expect(measured.namesClipped).toBe(0);
    expect(measured.namesHidden).toEqual([]);
    expect(measured.headsClipped).toBe(0);
    expect(measured.scroll.x).toBeLessThanOrEqual(0);
    expect(measured.scroll.y).toBeLessThanOrEqual(0);
    expect(await clippedUnintentionally(page)).toEqual([]);
    await expect(page.locator(CONTROLS)).toHaveCount(0);

    await page.screenshot({ path: `screenshots/display-board-${PROJECTION.name}-floor.png` });
  });

  test('projects an empty board as the legitimate pre-round state it is', async ({ page }) => {
    await page.route(`**/api/display/${TOKEN}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(EMPTY_BOARD),
      }),
    );

    await page.goto(`/display/${TOKEN}`);
    await expect(page.getByTestId('display-board')).toBeVisible();

    // Its Categories and Uncategorised, all at zero - not an error, not a spinner, not unavailable.
    await expect(page.locator('.display-region')).toHaveCount(5);
    await expect(page.getByTestId('display-uncategorised-count')).toHaveText('0');
    await expect(page.getByTestId('display-unavailable')).toHaveCount(0);
    expect(await clippedUnintentionally(page)).toEqual([]);
    await expect(page.locator(CONTROLS)).toHaveCount(0);

    await page.screenshot({ path: `screenshots/display-board-${PROJECTION.name}-empty.png` });
  });

  test('projects the one neutral sentence when the link has stopped resolving', async ({
    page,
  }) => {
    await page.route('**/api/display/**', (route) =>
      route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify(UNAVAILABLE),
      }),
    );

    await page.goto(`/display/${TOKEN}`);
    await expect(page.getByTestId('display-message')).toHaveText(
      'This board is no longer available.',
    );
    await expect(page.locator('body')).not.toContainText(/sign in|revoked|expired|draft|deleted/i);
    expect(await clippedUnintentionally(page)).toEqual([]);
    await expect(page.locator(CONTROLS)).toHaveCount(0);

    await page.screenshot({
      path: `screenshots/display-board-${PROJECTION.name}-unavailable.png`,
    });
  });

  /**
   * **The cold start, which S01 never drew** (S07, 2026-08-31, review M2).
   *
   * A room machine opened on the link before the venue network is up has no last Board to keep, so
   * neither the populated screen nor the staleness band applies: it says the connection is missing
   * and that the Board will appear when it returns. It is genuinely reachable in a room, so it is
   * signed off at the projection class like the four states S01 did draw, rather than shipping
   * uncaptured. It is still not a control - there is nothing to press, and it recovers on its own.
   */
  test('projects an honest cold start when the network was never there', async ({ page }) => {
    await page.route(`**/api/display/${TOKEN}`, (route) => route.abort('failed'));

    await page.goto(`/display/${TOKEN}`);
    await expect(page.getByTestId('display-unreachable')).toBeVisible();
    await expect(page.getByTestId('display-message')).toContainText('cannot be reached');
    // Not the refusal: a link that was never asked must not be reported as a dead one.
    await expect(page.locator('body')).not.toContainText('This board is no longer available.');
    expect(await clippedUnintentionally(page)).toEqual([]);
    await expect(page.locator(CONTROLS)).toHaveCount(0);

    await page.screenshot({
      path: `screenshots/display-board-${PROJECTION.name}-unreachable.png`,
    });
  });

  /** The moment before the first answer arrives. Also never drawn, also on a wall, also captured. */
  test('projects the moment before the first answer arrives', async ({ page }) => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`**/api/display/${TOKEN}`, async (route) => {
      await held;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(EMPTY_BOARD),
      });
    });

    await page.goto(`/display/${TOKEN}`, { waitUntil: 'commit' });
    await expect(page.getByTestId('display-loading')).toBeVisible();
    expect(await clippedUnintentionally(page)).toEqual([]);
    await expect(page.locator(CONTROLS)).toHaveCount(0);

    await page.screenshot({ path: `screenshots/display-board-${PROJECTION.name}-loading.png` });

    // And it resolves into the Board on its own, with nobody touching the machine.
    release();
    await expect(page.getByTestId('display-board')).toBeVisible();
  });

  /**
   * The venue network fails the way it actually fails: the link stays up and only reachability is
   * gone, so `navigator.onLine` never goes false. The last board stays on the wall behind an honest
   * indicator - which is a statement, never a retry control.
   */
  test('keeps the last board on the wall with a staleness indicator when the network dies', async ({
    page,
  }) => {
    /*
     * The venue network is taken away *after* the board is on the wall, which is the sequence this
     * state is about - rather than after a fixed number of requests, which would depend on how many
     * the mount happened to make.
     */
    let reachable = true;
    await page.route(`**/api/display/${TOKEN}`, async (route) => {
      if (!reachable) return route.abort('failed');
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(ceilingBoard()),
      });
    });

    await page.goto(`/display/${TOKEN}`);
    await expect(page.getByTestId('display-board')).toBeVisible();

    reachable = false;
    await expect(page.getByTestId('display-staleness')).toBeVisible({ timeout: 20_000 });

    /*
     * The board is still all there behind it, and **the indicator costs no content**: the last row's
     * regions shrink by exactly the band's height, so a post-it must not be pushed out of one. There
     * is no scroll on this class and nobody at the machine, so a pushed-out post-it is an unreachable
     * one - which is precisely what S01's overflow decision forbids.
     */
    await expect(page.locator('.display-post-it')).toHaveCount(200);
    const stale = await measureOneScreen(page);
    expect(stale.namedAndCounted).toBe(true);
    expect(stale.escaped).toEqual([]);
    expect(stale.namesClipped).toBe(0);
    expect(stale.namesHidden).toEqual([]);
    expect(stale.headsClipped).toBe(0);
    expect(stale.scroll.x).toBeLessThanOrEqual(0);
    expect(stale.scroll.y).toBeLessThanOrEqual(0);
    await expect(page.getByTestId('display-staleness-age')).toContainText('Updated');
    expect(await page.evaluate(() => navigator.onLine)).toBe(true);
    expect(await clippedUnintentionally(page)).toEqual([]);
    await expect(page.locator(CONTROLS)).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(/retry|try again/i);

    await page.screenshot({ path: `screenshots/display-board-${PROJECTION.name}-stale.png` });
  });
});
