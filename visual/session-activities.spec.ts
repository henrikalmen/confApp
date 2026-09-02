import { test, expect, type Page } from '@playwright/test';

/**
 * S01 TI12 – the three surfaces this story adds, at phone, tablet and desktop widths.
 *
 * The Round list, the Facilitator's run controls, and the authoring form. All three are text-heavy
 * in a way the rest of the app is not: a prompt is free text somebody typed in a hurry and an
 * answer option can be a whole sentence, either of which can push a 375px phone sideways. That is
 * the failure this captures – a run control an organizer has to scroll horizontally to reach is a
 * control that is not there when the room is waiting.
 *
 * The API is served from fixtures. The subject is the layout, and the states that must be on screen
 * – a poll mid-run beside a closed post-it round, an authoring form with four options – are ones a
 * live database would have to be manoeuvred into anyway.
 */

const VIEWPORTS = [
  { name: 'phone-375', width: 375, height: 812 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'desktop-1280', width: 1280, height: 900 },
] as const;

const CONFERENCE_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';

/** The long values that make this capture worth taking. */
const LONG_PROMPT =
  'What slows us down most between an idea being agreed in a workshop and it actually reaching ' +
  'the people it was meant to help?';
const LONG_OPTION = 'Handovers between teams, especially where nobody owns the piece in the middle';

/**
 * An unbroken token, which is the failure `overflow-wrap: anywhere` exists for.
 *
 * A long *sentence* wraps at its spaces whatever the CSS says, so a fixture made only of sentences
 * proves nothing about the rule. A pasted identifier or URL is what actually pushes a 375px phone
 * sideways, and a facilitator typing in a hurry produces one.
 */
// No hyphens and no spaces: a hyphen is a legal break opportunity even at `overflow-wrap: normal`,
// so a hyphenated fixture wraps on its own and proves nothing.
const UNBROKEN = 'HandoverBetweenPlatformAndProductWhereNobodyOwnsTheMiddleBit2026Q3Followup';

const CONFERENCE = {
  id: CONFERENCE_ID,
  name: 'Autumn Offsite',
  startDate: '2026-09-15',
  endDate: '2026-09-16',
  lifecycleState: 'published',
  updatedAt: '2026-08-17T10:00:00.123456Z',
};

const SESSION = {
  id: SESSION_ID,
  conferenceId: CONFERENCE_ID,
  title: 'Ways of Working',
  description: null,
  kind: 'Workshop',
  day: '2026-09-15',
  startTime: '13:00',
  endTime: '15:00',
  location: 'Room 2, second floor, east wing',
  lastUpdatedAt: '2026-08-17T10:00:00.123456Z',
};

const ORGANIZER_SCHEDULE = {
  conference: {
    id: CONFERENCE_ID,
    name: 'Autumn Offsite',
    startDate: '2026-09-15',
    endDate: '2026-09-16',
    lifecycleState: 'published',
    lastUpdatedAt: '2026-09-15T07:36:12.000000Z',
  },
  days: [
    { day: '2026-09-15', sessions: [SESSION] },
    { day: '2026-09-16', sessions: [] },
  ],
  overlaps: [],
};

/**
 * The board's own unbroken token (S02).
 *
 * A post-it is free text somebody typed on a phone in a hurry, so it is the surface most likely to
 * carry a pasted identifier. The board is a grid, and a grid item's automatic minimum size is its
 * content - so without `min-width: 0` on the item this token pushes the whole grid, and the page,
 * sideways. That is the failure this fixture exists to catch.
 */
const UNBROKEN_POST_IT = 'WaitingOnTheDataPlatformTicketQueueSinceTheSecondWeekOfAugust2026';

const ACTIVITIES = {
  session: SESSION,
  rounds: [
    {
      id: 'round-post-it',
      kind: 'PostItRound',
      prompt: `${LONG_PROMPT} ${UNBROKEN}`,
      state: 'open',
      textMaxLength: 280,
      /*
       * The Board, grouped (facilitator-board S02). Uncategorised is always on the payload, and a
       * Category name is free text somebody typed in a hurry - so one of them carries the unbroken
       * token too, because a region head is a second place a pasted identifier can push the grid.
       */
      categories: [
        {
          id: 'category-tooling',
          name: `Tooling and continuous integration ${UNBROKEN}`,
          postItCount: 1,
          postIts: [
            {
              id: 'post-it-bo',
              text: 'Too many meetings',
              authorName: 'Bo Nilsson',
              mine: false,
              edited: false,
            },
          ],
        },
        {
          id: 'category-meetings',
          name: 'Meeting overload',
          postItCount: 0,
          postIts: [],
        },
      ],
      uncategorised: {
        postItCount: 2,
        postIts: [
          {
            id: 'post-it-ada',
            text: `Waiting three days for test data. ${UNBROKEN_POST_IT}`,
            authorName: 'Ada Lovelace',
            mine: false,
            edited: false,
          },
          {
            id: 'post-it-mine',
            text: 'Handovers between teams, especially where nobody owns the piece in the middle',
            authorName: 'Ida Andersson',
            mine: true,
            edited: true,
          },
        ],
      },
    },
    {
      id: 'round-poll',
      kind: 'VotingRound',
      purpose: 'Poll',
      prompt: 'Where should we start?',
      state: 'open',
      options: [
        { id: 'option-tooling', label: 'Tooling and continuous integration' },
        { id: 'option-meetings', label: 'Meetings' },
        { id: 'option-handovers', label: `${LONG_OPTION} ${UNBROKEN}` },
      ],
      /*
       * Not yet voted, so the widest of the three Poll states is what gets captured: the option
       * labels *and* a radio beside each of them, which is the arrangement that pushes a 375px
       * phone sideways if the choice row is given a width it can overflow.
       *
       * The running tally belongs to whoever runs the Session. `stubApi` leaves it here for the
       * organizer and `stubAttendeeApi` strips it, which is the same difference the API makes.
       */
      hasVoted: false,
      tally: [
        { optionId: 'option-tooling', votes: 12 },
        { optionId: 'option-meetings', votes: 3 },
        { optionId: 'option-handovers', votes: 0 },
      ],
    },
    {
      /*
       * A closed Poll, which every Member reads whatever their authority. Captured because the
       * result is a *different* layout from the choice list - a three-column row of label, bar and
       * count - and it is the one that has to hold a long unbroken label without pushing the page.
       */
      id: 'round-poll-closed',
      kind: 'VotingRound',
      purpose: 'Poll',
      prompt: 'And what did we decide last time?',
      state: 'closed',
      options: [
        { id: 'closed-yes', label: 'Yes, and we shipped it' },
        { id: 'closed-no', label: `${LONG_OPTION} ${UNBROKEN}` },
      ],
      hasVoted: true,
      tally: [
        { optionId: 'closed-yes', votes: 9 },
        { optionId: 'closed-no', votes: 4 },
      ],
    },
  ],
  canRun: true,
  /*
   * The viewer of this fixture is an Admin, so the irreversible control is on the payload
   * (facilitator-board S06 FR5). Deliberately a *second* flag rather than a reuse of `canRun`: a
   * Board carrying both the sorting controls and the Admin's own is the widest this surface ever
   * gets, and it is the one that has to hold at 375px.
   */
  canRemovePermanently: true,
  activityWatermark: '4171',
};

/**
 * This Board's discarded Post-its (facilitator-board S05).
 *
 * The text carries the unbroken token deliberately: a discarded Post-it's text is free text somebody
 * typed in a hurry, and the trace line beneath it carries two names and an instant, so this surface
 * has three separate places a pasted identifier can push a 375px phone sideways.
 */
const DISCARDED_POST_ITS = {
  discarded: [
    {
      id: 'post-it-discarded',
      text: `Same point as the one above, written twice. ${UNBROKEN_POST_IT}`,
      authorName: 'Erik Sandberg',
      discardedByName: 'Ida Andersson',
      discardedAt: '2026-09-15 14:32 UTC',
    },
  ],
};

/** The two-scalar poll the Session view runs. Stubbed unmoved, so no capture refetches under it. */
const ACTIVITY_WATERMARK = {
  activityWatermark: ACTIVITIES.activityWatermark,
  state: 'published',
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

/**
 * Nothing may **overflow its own box** either.
 *
 * A page-level overflow check is not enough for a long unbroken token: an ancestor that clips will
 * absorb it, so the document never scrolls and the text is simply cut off instead. Comparing an
 * element's `scrollWidth` with its `clientWidth` asks the question directly — did this text wrap, or
 * did it run past the edge of the thing meant to hold it.
 */
async function assertWrapsInsideItsBox(page: Page, testId: string): Promise<void> {
  const overflow = await page.getByTestId(testId).evaluate((node) => {
    const element = node as HTMLElement;
    return element.scrollWidth - element.clientWidth;
  });
  expect(overflow, `${testId} should wrap rather than overflow its own box`).toBeLessThanOrEqual(1);
}

/** Nothing may be clipped out of the viewport horizontally. */
async function assertWithinViewport(page: Page, testId: string, width: number): Promise<void> {
  const box = await page.getByTestId(testId).boundingBox();
  expect(box, `${testId} should have a layout box`).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
}

/**
 * The post-it board, at one width (S02 TI09).
 *
 * The board is a grid, so it is the one surface here whose *items* can push the page sideways
 * independently of the page itself: a grid item's automatic minimum size is its content unless
 * `min-width: 0` says otherwise, and a pasted identifier inside a post-it is exactly that content.
 *
 * Run on **both** surfaces, because both offer it: contributing needs Membership, not the run
 * authority, so an attendee reading a session with `canRun: false` still gets a compose box - and
 * the phone is the width that matters most for it.
 */
async function captureBoard(page: Page, width: number, label: string): Promise<void> {
  await expect(page.getByTestId('board-round-post-it')).toBeVisible();
  await expect(page.getByTestId('post-it-text-post-it-ada')).toContainText(UNBROKEN_POST_IT);
  // Every post-it carries its author's name - that is what a post-it round is.
  await expect(page.getByTestId('post-it-by-post-it-ada')).toContainText('Ada Lovelace');

  /*
   * Uncategorised is on the Board at every width and on both surfaces, with the server's count -
   * it is where every post-it arrives, and it renders whether or not any Category exists
   * (facilitator-board S02, FR2).
   */
  await expect(page.getByTestId('uncategorised-round-post-it')).toBeVisible();
  await expect(page.getByTestId('uncategorised-count-round-post-it')).toHaveText('2 post-its');
  await expect(page.getByTestId('category-name-category-tooling')).toContainText(UNBROKEN);
  await expect(page.getByTestId('category-count-category-meetings')).toHaveText('0 post-its');

  for (const testId of [
    'board-round-post-it',
    'post-it-post-it-ada',
    'compose-round-post-it',
    'regions-round-post-it',
    'uncategorised-round-post-it',
    'category-category-tooling',
    'category-category-meetings',
  ]) {
    await assertWithinViewport(page, testId, width);
  }
  await assertWrapsInsideItsBox(page, 'post-it-text-post-it-ada');
  // A category name is free text too, and a region head is a grid item like any other.
  await assertWrapsInsideItsBox(page, 'category-name-category-tooling');
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

  // The primary contribute control is genuinely tappable, and reachable one-handed on the narrowest
  // phone: at the trailing edge of the compose box, inside the thumb's arc.
  const contribute = await page.getByTestId('compose-submit-round-post-it').boundingBox();
  expect(contribute!.height, 'the contribute control').toBeGreaterThanOrEqual(40);
  expect(contribute!.x + contribute!.width).toBeLessThanOrEqual(width + 1);

  await page.screenshot({
    path: `screenshots/session-activities-board-${label}.png`,
    fullPage: true,
  });
}

/**
 * The Facilitator's Category controls, at one width (facilitator-board S02 TI12).
 *
 * Offered only where the payload says the viewer runs the Session, so this runs on the organizer
 * path alone - the attendee capture above proves the same Board renders without any of it.
 *
 * What is measured here is the thing the 375px case decides: four controls plus the create form,
 * all present, all tappable, none of them reachable only by scrolling sideways. The control at the
 * end of the order is `aria-disabled` rather than `disabled`, so it is still in the tab order and
 * still has a layout box to measure.
 */
async function captureCategories(page: Page, width: number, label: string): Promise<void> {
  /*
   * **Both Categories**, because the two ends of the order carry different controls: the first
   * region's "move up" is the one marked unavailable, and the last region's "move down" is - and
   * measuring only the first would leave the end-of-order case unproven at every width.
   *
   * A width floor as well as a height floor: a control squeezed to a few pixels is inside the
   * viewport and still unusable, which a containment assertion alone reports as a pass.
   */
  const controls = ['category-tooling', 'category-meetings'].flatMap((category) =>
    ['rename', 'up', 'down', 'remove'].map((action) => `category-${action}-${category}`),
  );
  for (const testId of controls) {
    await expect(page.getByTestId(testId)).toBeVisible();
    const box = await page.getByTestId(testId).boundingBox();
    expect(box!.height, testId).toBeGreaterThanOrEqual(40);
    expect(box!.width, testId).toBeGreaterThanOrEqual(64);
    expect(box!.x, testId).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, testId).toBeLessThanOrEqual(width + 1);
  }

  // Reorder names its own outcome, and the first region's "move up" is announced unavailable
  // rather than removed - the control set does not change shape as a category moves.
  await expect(page.getByTestId('category-down-category-tooling')).toHaveText(
    'Move down – to position 2',
  );
  // Both ends, laid out: the first region's "move up" and the last region's "move down".
  await expect(page.getByTestId('category-up-category-tooling')).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await expect(page.getByTestId('category-down-category-meetings')).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await expect(page.getByTestId('category-down-category-meetings')).toHaveText('Move down');
  await expect(page.getByTestId('category-position-category-tooling')).toHaveText(
    'Position 1 of 2',
  );

  /*
   * Uncategorised carries none of them, and says so in words.
   *
   * Scoped to the *category* controls rather than to every button in the region: a post-it in
   * Uncategorised still offers its own author the correct-and-remove pair, which is a different
   * rule and belongs to whoever wrote it.
   */
  expect(
    await page
      .getByTestId('uncategorised-round-post-it')
      .locator(
        '[data-testid^="category-rename-"], [data-testid^="category-up-"], ' +
          '[data-testid^="category-down-"], [data-testid^="category-remove-"]',
      )
      .count(),
  ).toBe(0);
  await expect(page.getByTestId('uncategorised-note-round-post-it')).toContainText(
    'renamed, reordered or removed',
  );

  // The create form is present at every width, in the same place.
  for (const testId of ['new-category-round-post-it', 'new-category-add-round-post-it']) {
    await assertWithinViewport(page, testId, width);
  }
  const add = await page.getByTestId('new-category-add-round-post-it').boundingBox();
  expect(add!.height, 'the create control').toBeGreaterThanOrEqual(40);

  // The occupied-category removal question, which is the widest thing this surface opens.
  await page.getByTestId('category-remove-category-tooling').click();
  const prompt = page.getByTestId('category-removal-category-tooling');
  await expect(prompt).toBeVisible();
  await expect(page.getByTestId('category-removal-count-category-tooling')).toContainText(
    '1 post-it',
  );
  await assertWithinViewport(page, 'category-removal-category-tooling', width);
  await assertWithinViewport(page, 'category-destination-category-tooling', width);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

  await page.screenshot({
    path: `screenshots/session-activities-categories-${label}.png`,
    fullPage: true,
  });

  await page.getByTestId('category-removal-cancel-category-tooling').click();
  await expect(prompt).toBeHidden();
}

/**
 * The Facilitator's placement control, at one width (facilitator-board S03 TI08).
 *
 * The 375px case is the one that decides the interaction model
 * (`docs/wireframes/facilitator-board-and-categorisation/design-decisions.md` → "The non-drag
 * placement interaction model"), and it decides it here: a destination list and a commit control on
 * every Post-it, in Uncategorised and in every Category alike, both tappable, neither reachable only
 * by scrolling sideways.
 *
 * Measured on **two** Post-its in two different regions, because the control's own label carries the
 * Post-it's text - free text somebody typed in a hurry, and the one with the pasted identifier in it
 * is the one that pushes a grid item sideways if the label is given a width it can overflow.
 */
async function captureSorting(page: Page, width: number, label: string): Promise<void> {
  const sorting = ['post-it-ada', 'post-it-bo'];

  for (const postIt of sorting) {
    await expect(page.getByTestId(`move-${postIt}`)).toBeVisible();

    // The destination list is a real control, not a few pixels of it.
    const select = await page.getByTestId(`move-to-${postIt}`).boundingBox();
    expect(select!.height, `the destination list on ${postIt}`).toBeGreaterThanOrEqual(40);
    expect(select!.width, `the destination list on ${postIt}`).toBeGreaterThanOrEqual(64);
    expect(select!.x, postIt).toBeGreaterThanOrEqual(0);
    expect(select!.x + select!.width, postIt).toBeLessThanOrEqual(width + 1);

    // And so is the control that commits it - the one reached one-handed on the narrowest phone.
    const commit = await page.getByTestId(`move-submit-${postIt}`).boundingBox();
    expect(commit!.height, `the move control on ${postIt}`).toBeGreaterThanOrEqual(40);
    expect(commit!.width, `the move control on ${postIt}`).toBeGreaterThanOrEqual(64);
    expect(commit!.x + commit!.width, postIt).toBeLessThanOrEqual(width + 1);

    await assertWithinViewport(page, `move-${postIt}`, width);
  }

  /*
   * The label names the Post-it and the act, and it wraps inside its own box - it carries free text,
   * so an ancestor clipping it would cut a Post-it's identity out of the one control that names it.
   */
  const naming = page.locator('label[for="move-to-post-it-ada"]');
  await expect(naming).toContainText('Move “');
  const labelOverflow = await naming.evaluate((node) => {
    const element = node as HTMLElement;
    return element.scrollWidth - element.clientWidth;
  });
  expect(labelOverflow, 'the placement label should wrap rather than overflow').toBeLessThanOrEqual(
    1,
  );

  // Uncategorised and every Category are offered by name, with the current home marked in words.
  const options = await page.getByTestId('move-to-post-it-ada').locator('option').allTextContents();
  expect(options[0]).toContain('Uncategorised');
  expect(options.some((option) => option.includes('where it is now'))).toBe(true);
  expect(options.length).toBeGreaterThan(1);

  // No drag affordance at any width, 1280px included.
  expect(await page.locator('[draggable]').count()).toBe(0);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

  await page.screenshot({
    path: `screenshots/session-activities-sorting-${label}.png`,
    fullPage: true,
  });
}

/**
 * The Facilitator's Discard control and the surface a Discard is reversed from (S05 TI11).
 *
 * **Two surfaces, one capture**, because the second is only reachable through the first: the
 * per-Post-it Discard control sits beside the placement controls on every Post-it, and the entry
 * point to the discarded list is permanent on the Board whether or not anything has been discarded
 * (`docs/wireframes/facilitator-board-and-categorisation/design-decisions.md` -> "The discarded
 * Post-its surface").
 *
 * The list is the harder of the two at 375px: each entry carries free text, its author's name, and a
 * trace line naming a second person and an instant, and the restore control's own label is the
 * longest on the surface - `Restore to Uncategorised`.
 */
async function captureDiscarded(page: Page, width: number, label: string): Promise<void> {
  // Discard is offered on every Post-it, wherever it sits - Uncategorised and every Category alike.
  for (const postIt of ['post-it-ada', 'post-it-bo']) {
    const box = await page.getByTestId(`post-it-discard-${postIt}`).boundingBox();
    expect(box!.height, `the discard control on ${postIt}`).toBeGreaterThanOrEqual(40);
    expect(box!.x, postIt).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, postIt).toBeLessThanOrEqual(width + 1);
  }

  // The entry point, always here and carrying the count.
  const entry = page.getByTestId('discarded-toggle-round-post-it');
  await expect(entry).toBeVisible();
  await expect(entry).toContainText('Discarded post-its (1)');
  const entryBox = await entry.boundingBox();
  expect(entryBox!.height, 'the discarded post-its entry point').toBeGreaterThanOrEqual(40);
  expect(entryBox!.x + entryBox!.width, 'the entry point').toBeLessThanOrEqual(width + 1);

  await entry.click();
  await expect(page.getByTestId('discarded-panel-round-post-it')).toBeVisible();

  // The trace, in full: the author, then who discarded it and when.
  await expect(page.getByTestId('discarded-by-post-it-discarded')).toContainText('Erik Sandberg');
  await expect(page.getByTestId('discarded-trace-post-it-discarded')).toContainText(
    'Discarded by Ida Andersson',
  );

  // Free text and a trace line, each wrapping inside its own box rather than pushing the page.
  for (const testId of [
    'discarded-item-post-it-discarded',
    'discarded-trace-post-it-discarded',
    'discarded-rules-round-post-it',
  ]) {
    await assertWrapsInsideItsBox(page, testId);
    await assertWithinViewport(page, testId, width);
  }

  // The restore control is genuinely tappable on the narrowest phone, and names its destination.
  const restore = page.getByTestId('discarded-restore-post-it-discarded');
  await expect(restore).toContainText('Restore to Uncategorised');
  const restoreBox = await restore.boundingBox();
  expect(restoreBox!.height, 'the restore control').toBeGreaterThanOrEqual(40);
  expect(restoreBox!.x, 'the restore control').toBeGreaterThanOrEqual(0);
  expect(restoreBox!.x + restoreBox!.width, 'the restore control').toBeLessThanOrEqual(width + 1);

  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

  await page.screenshot({
    path: `screenshots/session-activities-discarded-${label}.png`,
    fullPage: true,
  });

  // Left as it was found: the surface is a place that can be left and returned to.
  await entry.click();
}

/**
 * The Admin's **Permanent Removal** control and its confirmation (S06 TI08, FR5).
 *
 * The hardest thing on this surface at 375px, and for a reason nothing before it had: the
 * confirmation is an in-place block that opens *inside* a region, under a Post-it, beside the
 * region's own head - so at the narrowest width three wrapping blocks stack in a column that is
 * already indented twice. A modal would have dodged that and hidden the Post-it being decided
 * about, which is precisely the thing the person needs to read while deciding.
 *
 * It is opened on the Post-it whose text is the unbroken, non-hyphenated run: that card is what
 * sits immediately above the open confirmation, and it is the one that pushes a phone sideways if
 * anything on this path sets a width of its own.
 */
async function capturePermanentRemoval(page: Page, width: number, label: string): Promise<void> {
  /*
   * Offered on every Post-it, wherever it sits - Uncategorised and every Category alike, exactly as
   * Discard is. `post-it-bo` is the one inside the Category whose name carries the unbroken token,
   * so its control is the one measured against a region head that is already at full stretch.
   */
  for (const postIt of ['post-it-ada', 'post-it-bo']) {
    const box = await page.getByTestId(`post-it-permanent-removal-${postIt}`).boundingBox();
    expect(box!.height, `the removal control on ${postIt}`).toBeGreaterThanOrEqual(40);
    expect(box!.x, postIt).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, postIt).toBeLessThanOrEqual(width + 1);
  }

  await page.getByTestId('post-it-permanent-removal-post-it-ada').click();
  const confirmation = page.getByTestId('permanent-removal-post-it-ada');
  await expect(confirmation).toBeVisible();

  // It names the author and says the act cannot be undone - the two things FR5 requires of it.
  await expect(confirmation).toContainText('Ada Lovelace');
  await expect(page.getByTestId('permanent-removal-warning-post-it-ada')).toContainText(
    'cannot be undone',
  );

  // Every block of it wraps inside its own box rather than pushing the page.
  for (const testId of [
    'permanent-removal-post-it-ada',
    'permanent-removal-warning-post-it-ada',
    'post-it-text-post-it-ada',
  ]) {
    await assertWrapsInsideItsBox(page, testId);
    await assertWithinViewport(page, testId, width);
  }

  // Both controls are genuinely tappable on the narrowest phone, and neither is clipped.
  for (const testId of [
    'permanent-removal-confirm-post-it-ada',
    'permanent-removal-cancel-post-it-ada',
  ]) {
    const box = await page.getByTestId(testId).boundingBox();
    expect(box!.height, testId).toBeGreaterThanOrEqual(40);
    expect(box!.x, testId).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, testId).toBeLessThanOrEqual(width + 1);
  }

  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

  await page.screenshot({
    path: `screenshots/session-activities-permanent-removal-${label}.png`,
    fullPage: true,
  });

  // Dismissed: nothing is sent, and the surface is left as it was found.
  await page.getByTestId('permanent-removal-cancel-post-it-ada').click();
  await expect(page.getByTestId('permanent-removal-post-it-ada')).toHaveCount(0);
}

/**
 * The Poll card, at one width (S03 TI09).
 *
 * Two layouts on one card and both of them can push a page sideways for different reasons: the
 * choice list, where a radio sits beside a label long enough to wrap, and the result list, which is
 * a three-column grid whose items default to a minimum size of their own content. A pasted
 * identifier in an option label is exactly that content.
 *
 * `withTally` says whether this surface is entitled to see the running counts, so the capture
 * asserts the *absence* on the surface where the server withholds them rather than skipping the
 * question - a card that silently rendered zeroes would pass a check that only looked for overflow.
 */
async function capturePoll(
  page: Page,
  width: number,
  label: string,
  withTally: boolean,
): Promise<void> {
  await expect(page.getByTestId('poll-round-poll')).toBeVisible();
  await expect(page.getByTestId('round-options-round-poll')).toContainText(UNBROKEN);

  // The choice list: one radio per option, and nothing offered to change a vote already cast.
  await expect(page.getByTestId('poll-option-option-handovers')).toBeVisible();
  await expect(page.getByTestId('poll-voted-round-poll')).toHaveCount(0);

  // The closed Poll's result is on screen for everyone, and the open one's only where permitted.
  await expect(page.getByTestId('poll-results-round-poll-closed')).toBeVisible();
  await expect(page.getByTestId('poll-count-closed-yes')).toHaveText('9');
  await expect(page.getByTestId('poll-results-round-poll')).toHaveCount(withTally ? 1 : 0);

  const cards = [
    'poll-round-poll',
    'round-options-round-poll',
    'poll-round-poll-closed',
    'poll-results-round-poll-closed',
  ];
  for (const testId of cards) await assertWithinViewport(page, testId, width);
  for (const testId of ['round-options-round-poll', 'poll-results-round-poll-closed']) {
    await assertWrapsInsideItsBox(page, testId);
  }
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

  /*
   * The whole choice row is the tap target, not the radio dot: somebody answering from the back of
   * a room is doing it one-handed on a phone. Measured on the *label*, which is what wraps.
   */
  const choice = await page
    .getByTestId('poll-option-option-handovers')
    .locator('xpath=ancestor::label[1]')
    .boundingBox();
  expect(choice!.height, 'the choice row').toBeGreaterThanOrEqual(40);
  expect(choice!.x + choice!.width).toBeLessThanOrEqual(width + 1);

  const vote = await page.getByTestId('poll-submit-round-poll').boundingBox();
  expect(vote!.height, 'the vote control').toBeGreaterThanOrEqual(40);
  expect(vote!.x + vote!.width).toBeLessThanOrEqual(width + 1);

  await page.screenshot({
    path: `screenshots/session-activities-poll-${label}.png`,
    fullPage: true,
  });
}

function json(body: unknown): { status: number; contentType: string; body: string } {
  return { status: 200, contentType: 'application/json', body: JSON.stringify(body) };
}

async function stubApi(page: Page): Promise<void> {
  await page.route('**/api/conferences', (route) =>
    route.fulfill(json({ conferences: [CONFERENCE] })),
  );

  await page.route(`**/api/conferences/${CONFERENCE_ID}/schedule/organizer`, (route) =>
    route.fulfill(json(ORGANIZER_SCHEDULE)),
  );

  // Longest match first: the watermark poll must not be captured by the session read's pattern.
  await page.route(
    `**/api/conferences/${CONFERENCE_ID}/sessions/${SESSION_ID}/activities/watermark`,
    (route) => route.fulfill(json(ACTIVITY_WATERMARK)),
  );
  await page.route('**/rounds/round-post-it/discarded-post-its', (route) =>
    route.fulfill(json(DISCARDED_POST_ITS)),
  );
  await page.route(`**/api/conferences/${CONFERENCE_ID}/sessions/${SESSION_ID}`, (route) =>
    route.fulfill(json(ACTIVITIES)),
  );

  // The panels sharing this page are not the subject, but an error in one would change the layout
  // of everything below it.
  await page.route(`**/api/conferences/${CONFERENCE_ID}/members`, (route) =>
    route.fulfill(
      json({ conferenceId: CONFERENCE_ID, lifecycleState: 'published', members: [], sessions: [] }),
    ),
  );
  await page.route(`**/api/conferences/${CONFERENCE_ID}/join-code`, (route) =>
    route.fulfill(
      json({ conferenceId: CONFERENCE_ID, joinCode: 'K7RM4P', lifecycleState: 'published' }),
    ),
  );
  await page.route('**/api/me/conferences', (route) =>
    route.fulfill(json({ conferences: [], defaultConferenceId: null })),
  );
  await page.route('**/api/health', (route) =>
    route.fulfill(
      json({
        status: 'ok',
        schemaVersion: '20260828090000000',
        serverTime: '2026-09-15T07:40:12.345678Z',
      }),
    ),
  );

  await page.addInitScript(SEED_SESSION);
}

for (const viewport of VIEWPORTS) {
  test(`the round list, run controls and authoring form stay legible at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await stubApi(page);

    await page.goto('/');
    await page.getByText('Autumn Offsite').click();
    await expect(page.getByTestId('schedule')).toBeVisible();

    // The round list and the run controls, reached from the session the organizer is looking at.
    await page.getByTestId(`activities-${SESSION_ID}`).click();
    const list = page.getByTestId('round-list');
    await expect(list).toBeVisible();
    await expect(list).toContainText(LONG_PROMPT);
    await expect(list).toContainText(LONG_OPTION);
    // The unbroken token is on screen, so `overflow-wrap: anywhere` is what is being measured.
    await expect(list).toContainText(UNBROKEN);
    await expect(page.getByTestId('round-open-round-poll')).toBeVisible();

    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    for (const testId of ['session-activities', 'round-list', 'round-round-poll']) {
      await assertWithinViewport(page, testId, viewport.width);
    }
    // The unbroken token is in both places it can appear: a prompt and an option label.
    await assertWrapsInsideItsBox(page, 'round-prompt-round-post-it');
    await assertWrapsInsideItsBox(page, 'round-options-round-poll');

    // Every run control is genuinely tappable on the narrowest phone.
    for (const testId of ['round-open-round-poll', 'round-close-round-poll']) {
      const box = await page.getByTestId(testId).boundingBox();
      expect(box!.height, testId).toBeGreaterThanOrEqual(40);
    }

    await page.screenshot({
      path: `screenshots/session-activities-list-${viewport.name}.png`,
      fullPage: true,
    });

    await captureBoard(page, viewport.width, `organizer-${viewport.name}`);
    await captureCategories(page, viewport.width, viewport.name);
    await captureSorting(page, viewport.width, viewport.name);
    await captureDiscarded(page, viewport.width, viewport.name);
    await capturePermanentRemoval(page, viewport.width, viewport.name);
    // The organizer facilitates this Session, so the running tally is theirs to watch.
    await capturePoll(page, viewport.width, `organizer-${viewport.name}`, true);

    // The authoring form, with a poll's option list open and a long label typed into it.
    await page.getByTestId('add-round').click();
    const form = page.getByTestId('round-form');
    await expect(form).toBeVisible();

    await page.getByLabel('Kind').selectOption('VotingRound');
    await page.getByLabel('Question').fill(LONG_PROMPT);
    await page.getByTestId('round-add-option').click();
    await page.getByLabel('Option 1').fill('Tooling and continuous integration');
    await page.getByLabel('Option 2').fill('Meetings');
    await page.getByLabel('Option 3').fill(`${LONG_OPTION} ${UNBROKEN}`);

    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await assertWithinViewport(page, 'round-form', viewport.width);

    await page.screenshot({
      path: `screenshots/session-activities-form-${viewport.name}.png`,
      fullPage: true,
    });
  });
}

// ---------- the attendee surface: the same rounds, read-only, on a phone ----------

/**
 * The Round list as a Conference Member reads it, reached from the attendee schedule.
 *
 * A different surface with a different payload — `canRun: false`, so no run controls and no
 * authoring form — and it is the phone-first one. Capturing only the organizer path would leave the
 * narrower of the two surfaces unproven at the width that matters most.
 */
const ATTENDEE_ENVELOPE = {
  conference: {
    id: CONFERENCE_ID,
    name: 'Autumn Offsite',
    startDate: '2026-09-15',
    endDate: '2026-09-16',
    state: 'published',
    lastUpdatedAt: '2026-09-15T07:36:12.000000Z',
  },
  days: [
    {
      date: '2026-09-15',
      dayNumber: 1,
      sessions: [
        {
          id: SESSION_ID,
          title: 'Ways of Working',
          description: null,
          kind: 'Workshop',
          startTime: '13:00',
          endTime: '15:00',
          location: 'Room 2, second floor, east wing',
          concurrentWith: [],
        },
      ],
    },
    { date: '2026-09-16', dayNumber: 2, sessions: [] },
  ],
  serverNow: { instant: '2026-09-15T11:40:12.345678Z', day: '2026-09-15', time: '13:40' },
};

async function stubAttendeeApi(page: Page): Promise<void> {
  await page.route('**/api/me/conferences', (route) =>
    route.fulfill(
      json({
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
      }),
    ),
  );
  await page.route(`**/api/conferences/${CONFERENCE_ID}/schedule/watermark`, (route) =>
    route.fulfill(json({ lastUpdatedAt: '2026-09-15T07:36:12.000000Z', state: 'published' })),
  );
  await page.route(`**/api/conferences/${CONFERENCE_ID}/schedule`, (route) =>
    route.fulfill(json(ATTENDEE_ENVELOPE)),
  );
  await page.route(
    `**/api/conferences/${CONFERENCE_ID}/sessions/${SESSION_ID}/activities/watermark`,
    (route) => route.fulfill(json(ACTIVITY_WATERMARK)),
  );
  /*
   * The attendee's payload, shaped as the API shapes it: **no tally on an open Poll**. Absence, not
   * a zeroed result - the server withholds the key rather than answering an empty tally so that
   * absence carries no information, and the capture has to show a card that renders correctly
   * without one.
   */
  await page.route(`**/api/conferences/${CONFERENCE_ID}/sessions/${SESSION_ID}`, (route) =>
    route.fulfill(
      json({
        ...ACTIVITIES,
        canRun: false,
        canRemovePermanently: false,
        rounds: ACTIVITIES.rounds.map((round) =>
          round.kind === 'VotingRound' && round.state === 'open'
            ? { ...round, tally: undefined }
            : round,
        ),
      }),
    ),
  );
  await page.route('**/api/conferences', (route) => route.fulfill(json({ conferences: [] })));
  await page.route('**/api/health', (route) =>
    route.fulfill(
      json({
        status: 'ok',
        schemaVersion: '20260828090000000',
        serverTime: '2026-09-15T07:40:12.345678Z',
      }),
    ),
  );

  await page.addInitScript(SEED_SESSION);
}

for (const viewport of VIEWPORTS) {
  test(`the attendee's read-only round list stays legible at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await stubAttendeeApi(page);

    await page.goto('/');
    await expect(page.getByTestId('attendee-schedule')).toBeVisible();

    await page.getByTestId(`attendee-activities-${SESSION_ID}`).click();
    const list = page.getByTestId('round-list');
    await expect(list).toBeVisible();
    await expect(list).toContainText(UNBROKEN);

    // A member reads the state and is offered nothing to press.
    await expect(page.getByTestId('round-state-round-poll')).toHaveText('Open');
    await expect(page.getByTestId('round-open-round-poll')).toHaveCount(0);
    await expect(page.getByTestId('add-round')).toHaveCount(0);

    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    for (const testId of ['session-activities', 'round-list', 'round-round-post-it']) {
      await assertWithinViewport(page, testId, viewport.width);
    }
    await assertWrapsInsideItsBox(page, 'round-prompt-round-post-it');
    await assertWrapsInsideItsBox(page, 'round-options-round-poll');

    await captureBoard(page, viewport.width, `attendee-${viewport.name}`);
    // A Member with no Session Assignment: the closed Poll's result, and no running tally.
    await capturePoll(page, viewport.width, `attendee-${viewport.name}`, false);

    await page.screenshot({
      path: `screenshots/session-activities-attendee-${viewport.name}.png`,
      fullPage: true,
    });
  });
}

// ---------- S04 TI11: pending, late and returned-to-author, at every width ----------

/**
 * The three states a Post-it composed with no connection can be in, on one screen.
 *
 * All three are **sentences**, which is what makes them the widest thing on the board: a pending
 * marking, a late-arrival marking, and a returned-to-author state carrying the server's refusal
 * *and* the whole of what the person typed. The returned one is the case that matters most here –
 * an idea whose Round was deleted is only recoverable if its text is still readable in full, so a
 * capture that let it be truncated would be hiding the failure this state exists to prevent.
 */
const PENDING_SUBMISSION = 'aaaaaaa1-0000-4000-8000-000000000001';
const REFUSED_SUBMISSION = 'aaaaaaa1-0000-4000-8000-000000000002';

/** Long, and with an unbroken token in it: the returned text is the one that must not be clipped. */
const RETURNED_TEXT =
  'The handover between platform and product has no owner, so anything that lands in the middle ' +
  `waits for somebody to notice it. ${UNBROKEN}`;

const QUEUE_ACTIVITIES = {
  ...ACTIVITIES,
  rounds: ACTIVITIES.rounds.map((round) =>
    round.id === 'round-post-it'
      ? {
          ...round,
          uncategorised: {
            postItCount: (round.uncategorised?.postItCount ?? 0) + 1,
            postIts: [
              ...(round.uncategorised?.postIts ?? []),
              {
                id: 'post-it-late',
                text: `Sent from the car park once the signal came back. ${UNBROKEN_POST_IT}`,
                authorName: 'Ida Andersson',
                mine: true,
                edited: false,
                arrivedAfterClose: true,
              },
            ],
          },
        }
      : round,
  ),
};

/**
 * Waits until the app has claimed the offline store for the signed-in subject.
 *
 * Seeding before the claim lands leaves the entry deleted – `adoptCacheOwner` fails closed – and
 * every later assertion then passes against an empty screen. `page.goto` resolves long before this
 * (`docs/LEARNINGS.md#browser-testing--jsdom`), so the owner marker is what is waited for; it is
 * written last, so its presence means the claim is finished.
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
    return owner === 'google-sub-ida';
  });
}

/** One pending item and one that came back refused, written straight into the store. */
async function seedQueue(page: Page): Promise<void> {
  await waitForCacheClaimed(page);
  await page.evaluate(
    async ({ conferenceId, sessionId, pendingId, refusedId, returnedText }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open('confapp-offline');
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });

      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['post-it-queue'], 'readwrite');
        const store = tx.objectStore('post-it-queue');
        store.put(
          {
            submissionId: pendingId,
            conferenceId,
            sessionId,
            roundId: 'round-post-it',
            text: 'Nobody owns the staging environment, so nothing gets fixed there.',
            heldAt: 1,
            refusal: null,
          },
          ['google-sub-ida', pendingId],
        );
        store.put(
          {
            submissionId: refusedId,
            conferenceId,
            sessionId,
            roundId: 'round-post-it',
            text: returnedText,
            heldAt: 2,
            refusal: 'That round is no longer part of this session, so this could not be posted.',
          },
          ['google-sub-ida', refusedId],
        );
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    {
      conferenceId: CONFERENCE_ID,
      sessionId: SESSION_ID,
      pendingId: PENDING_SUBMISSION,
      refusedId: REFUSED_SUBMISSION,
      returnedText: RETURNED_TEXT,
    },
  );
}

for (const viewport of VIEWPORTS) {
  test(`pending, late and returned post-its stay legible at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await stubApi(page);
    // The board read carries the late arrival; the queue below carries the other two states.
    await page.route(`**/api/conferences/${CONFERENCE_ID}/sessions/${SESSION_ID}`, (route) =>
      route.fulfill(json(QUEUE_ACTIVITIES)),
    );
    /*
     * The drain fires on mount, and it must **fail at the transport** rather than reach anything:
     * an answer of any kind would either post the pending item or refuse it, and the state under
     * capture would be gone before the screenshot. `abort` is what a dead spot looks like to
     * `fetch`, which is exactly the condition these two items exist in.
     */
    await page.route(
      `**/api/conferences/${CONFERENCE_ID}/sessions/${SESSION_ID}/rounds/*/post-its`,
      (route) => route.abort(),
    );

    await page.goto('/');
    await page.getByText('Autumn Offsite').click();
    await expect(page.getByTestId('schedule')).toBeVisible();
    await page.getByTestId(`activities-${SESSION_ID}`).click();
    await expect(page.getByTestId('board-round-post-it')).toBeVisible();

    /*
     * Seeded **after** the app has finished signing in and rendering, not before.
     *
     * The claim is not the only thing that empties this store - the session-lifetime check on a cold
     * launch can clear the session and fire the purge too, and it lands at an unpredictable moment
     * relative to `page.goto`. Waiting for the owner marker rules out one race and not the other, so
     * the entries go in once the app has stopped touching storage, and the drain is then provoked
     * the way a returning signal provokes it. That is also the path a person actually takes here.
     */
    await seedQueue(page);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.getByTestId(`held-post-it-${PENDING_SUBMISSION}`)).toBeVisible();

    // Pending: on her own board, under her own name, said in words rather than in a shade.
    const pending = page.getByTestId(`held-post-it-${PENDING_SUBMISSION}`);
    await expect(pending).toBeVisible();
    await expect(page.getByTestId(`held-pending-${PENDING_SUBMISSION}`)).toContainText(
      /waiting to be posted/i,
    );
    await expect(page.getByTestId(`held-by-${PENDING_SUBMISSION}`)).toHaveText('Ida Andersson');

    // Late: stated on the post-it itself, wherever it appears.
    await expect(page.getByTestId('post-it-late-post-it-late')).toContainText(
      /arrived after this round closed/i,
    );

    // Returned to its author: the reason, and the whole of the text - not one at the cost of the
    // other. `toHaveText` is exact, so a truncated rendering fails here rather than looking fine.
    await expect(page.getByTestId(`held-refusal-${REFUSED_SUBMISSION}`)).toContainText(
      /no longer part of this session/,
    );
    await expect(page.getByTestId(`held-text-${REFUSED_SUBMISSION}`)).toHaveText(RETURNED_TEXT);

    for (const testId of [
      `held-post-it-${PENDING_SUBMISSION}`,
      `held-post-it-${REFUSED_SUBMISSION}`,
      'post-it-post-it-late',
    ]) {
      await assertWithinViewport(page, testId, viewport.width);
    }
    for (const testId of [`held-text-${REFUSED_SUBMISSION}`, 'post-it-text-post-it-late']) {
      await assertWrapsInsideItsBox(page, testId);
    }
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

    // The one control these states offer is genuinely tappable on the narrowest phone.
    const discard = await page.getByTestId(`held-dismiss-${REFUSED_SUBMISSION}`).boundingBox();
    expect(discard!.height, 'the discard control').toBeGreaterThanOrEqual(40);
    expect(discard!.x + discard!.width).toBeLessThanOrEqual(viewport.width + 1);

    await page.screenshot({
      path: `screenshots/session-activities-queued-${viewport.name}.png`,
      fullPage: true,
    });
  });
}

// ---------- facilitator-board S03 TI08: the sorting surface at the design ceiling --------------

/**
 * The Board at the bound the layout must not break: ~200 Post-its across 20 Categories.
 *
 * The ceiling is the **bound**, not the case the surface is tuned for
 * (`prd.md#non-functional-requirements`, `docs/wireframes/.../design-decisions.md`). A typical
 * Board holds nearer ten Post-its per Category; what this capture asks is whether the Facilitator's
 * own surface still holds together at the number the PRD names - twenty region heads, twenty
 * position sentences, four Category controls each, and a placement control on every one of two
 * hundred Post-its, each of whose destination lists carries twenty-one options.
 *
 * Its own test rather than an extra fixture on the one above, because it is a different question:
 * that one asks whether free text pushes the page sideways, and this one asks whether *volume*
 * does. Both are the 375px case in the end.
 */
const CEILING_CATEGORIES = 20;
const CEILING_POST_ITS = 200;

const CEILING_NAMES = [
  'Handovers between teams',
  'Tooling and continuous integration',
  'Meeting overload',
  'Recognition and thanks',
  'Onboarding',
  'Test data and staging',
  'Release process',
  'Documentation',
  'On-call and support',
  'Hiring and growth',
  'Planning and estimates',
  'Customer feedback loops',
  'Technical debt',
  'Security and compliance',
  'Remote and hybrid working',
  'Cross-team dependencies',
  'Product discovery',
  'Incident follow-ups',
  'Team rituals',
  'Everything else',
];

const CEILING_AUTHORS = ['Ada Lovelace', 'Bo Nilsson', 'Ida Andersson', 'Priya Raman'];

/**
 * Twenty Categories and two hundred Post-its, distributed unevenly on purpose.
 *
 * An even spread would give every region the same height and hide the case a real Board produces:
 * one Category collecting most of what the room wrote while its neighbour holds two. The first
 * region also carries the unbroken token, because a placement label repeats a Post-it's text and a
 * pasted identifier inside one is what pushes a grid item - and the page - sideways.
 */
function ceilingBoard(): {
  categories: {
    id: string;
    name: string;
    postItCount: number;
    postIts: Record<string, unknown>[];
  }[];
  uncategorised: { postItCount: number; postIts: Record<string, unknown>[] };
} {
  let issued = 0;
  const postIt = (index: number): Record<string, unknown> => {
    const author = CEILING_AUTHORS[index % CEILING_AUTHORS.length]!;
    return {
      id: `ceiling-post-it-${index}`,
      text:
        index === 0
          ? `Waiting three days for test data. ${UNBROKEN_POST_IT}`
          : `Idea number ${index}: something the room wrote down in a hurry and wants sorted.`,
      authorName: author,
      mine: index % 7 === 0,
      edited: index % 11 === 0,
      arrivedAfterClose: false,
    };
  };

  // Uneven by design: 1, 2, 3, … up to the ceiling, with the remainder left in Uncategorised.
  const categories = CEILING_NAMES.map((name, position) => {
    const held = Math.min(position + 1, CEILING_POST_ITS - issued);
    const postIts = Array.from({ length: Math.max(held, 0) }, () => postIt(issued++));
    return {
      id: `ceiling-category-${position}`,
      name: position === 0 ? `${name} ${UNBROKEN}` : name,
      postItCount: postIts.length,
      postIts,
    };
  });

  const rest = Array.from({ length: CEILING_POST_ITS - issued }, () => postIt(issued++));
  return {
    categories,
    uncategorised: { postItCount: rest.length, postIts: rest },
  };
}

const CEILING_ACTIVITIES = {
  ...ACTIVITIES,
  rounds: [
    {
      id: 'round-post-it',
      kind: 'PostItRound',
      prompt: 'What slowed us down this quarter?',
      state: 'closed',
      textMaxLength: 280,
      ...ceilingBoard(),
    },
  ],
};

for (const viewport of VIEWPORTS) {
  test(`the sorting surface holds at the design ceiling at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await stubApi(page);
    await page.route(`**/api/conferences/${CONFERENCE_ID}/sessions/${SESSION_ID}`, (route) =>
      route.fulfill(json(CEILING_ACTIVITIES)),
    );

    await page.goto('/');
    await page.getByText('Autumn Offsite').click();
    await expect(page.getByTestId('schedule')).toBeVisible();
    await page.getByTestId(`activities-${SESSION_ID}`).click();
    await expect(page.getByTestId('board-round-post-it')).toBeVisible();

    // The Board really is at the ceiling: twenty Categories plus Uncategorised, 200 Post-its, and
    // a placement control on every one of them.
    expect(await page.locator('[data-testid^="category-name-"]').count()).toBe(CEILING_CATEGORIES);
    expect(await page.locator('[data-testid^="post-it-text-"]').count()).toBe(CEILING_POST_ITS);
    expect(await page.locator('[data-testid^="move-submit-"]').count()).toBe(CEILING_POST_ITS);
    // Every destination list offers Uncategorised and all twenty Categories.
    expect(await page.getByTestId('move-to-ceiling-post-it-0').locator('option').count()).toBe(
      CEILING_CATEGORIES + 1,
    );

    /*
     * Nothing is clipped horizontally, and nothing overflows its own box - checked on the region
     * head and the placement label that carry the unbroken token, which are the two places volume
     * and free text meet.
     */
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    for (const testId of [
      'board-round-post-it',
      'regions-round-post-it',
      'uncategorised-round-post-it',
      'category-ceiling-category-0',
      'category-ceiling-category-19',
      'move-ceiling-post-it-0',
    ]) {
      await assertWithinViewport(page, testId, viewport.width);
    }
    await assertWrapsInsideItsBox(page, 'category-name-ceiling-category-0');
    await assertWrapsInsideItsBox(page, 'post-it-text-ceiling-post-it-0');

    // The primary sorting control is still a real control at the last Category on the Board, not a
    // sliver squeezed out by the nineteen above it.
    const last = await page.getByTestId('move-submit-ceiling-post-it-199').boundingBox();
    expect(last!.height, 'the move control on the last post-it').toBeGreaterThanOrEqual(40);
    expect(last!.x + last!.width).toBeLessThanOrEqual(viewport.width + 1);

    await page.screenshot({
      path: `screenshots/session-activities-ceiling-${viewport.name}.png`,
      fullPage: true,
    });
  });
}

// ---------- S08 TI09: the Attendee's Board at the design ceiling ----------

/**
 * The same twenty Categories and two hundred Post-its, on the surface that has to hold them on a
 * phone (S08 OC01, `prd.md#non-functional-requirements`).
 *
 * The Facilitator's ceiling capture above proves the *sorting* surface holds; this one proves the
 * surface with no sorting controls at all does, which is not the same layout: every card loses its
 * placement select, its Move button and its Discard, so the regions are shorter, denser and pack
 * differently, and the widest thing left on a card is a Post-it's own text.
 *
 * `canRun: false` and `canRemovePermanently: false` - the server's answers, which is the only thing
 * that decides what is offered here.
 */
const ATTENDEE_CEILING = {
  ...CEILING_ACTIVITIES,
  canRun: false,
  canRemovePermanently: false,
};

for (const viewport of VIEWPORTS) {
  test(`the attendee's board holds at the design ceiling at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await stubAttendeeApi(page);
    await page.route(`**/api/conferences/${CONFERENCE_ID}/sessions/${SESSION_ID}`, (route) =>
      route.fulfill(json(ATTENDEE_CEILING)),
    );

    await page.goto('/');
    await expect(page.getByTestId('attendee-schedule')).toBeVisible();
    await page.getByTestId(`attendee-activities-${SESSION_ID}`).click();
    await expect(page.getByTestId('board-round-post-it')).toBeVisible();

    // Every Category and Uncategorised are there, with every Post-it under its author's name.
    expect(await page.locator('[data-testid^="category-name-"]').count()).toBe(CEILING_CATEGORIES);
    expect(await page.locator('[data-testid^="post-it-text-"]').count()).toBe(CEILING_POST_ITS);
    expect(await page.locator('[data-testid^="post-it-by-"]').count()).toBe(CEILING_POST_ITS);
    await expect(page.getByTestId('uncategorised-round-post-it')).toBeVisible();

    /*
     * And not one lever on any of them - on this Member's own Post-its as much as anyone else's.
     * The ceiling fixture marks every seventh Post-it `mine`, so this is asserted over a Board that
     * really does hold some of theirs.
     */
    expect(await page.locator('[data-testid^="move-"]').count()).toBe(0);
    expect(await page.locator('[data-testid^="post-it-discard-"]').count()).toBe(0);
    expect(await page.locator('[data-testid^="post-it-permanent-removal-"]').count()).toBe(0);
    expect(await page.locator('[data-testid^="category-controls-"]').count()).toBe(0);
    await expect(page.getByTestId('new-category-round-post-it')).toHaveCount(0);

    // How current it is, beside it rather than instead of it.
    await expect(page.getByTestId('activities-age')).toBeVisible();

    /*
     * Nothing is clipped horizontally, and nothing overflows its own box - measured on each
     * element's own `scrollWidth` rather than the page's, which an ancestor that clips would
     * absorb (`docs/LEARNINGS.md#css--responsive-layout`).
     */
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    for (const testId of [
      'session-activities',
      'board-round-post-it',
      'regions-round-post-it',
      'uncategorised-round-post-it',
      'category-ceiling-category-0',
      'category-ceiling-category-19',
      'post-it-ceiling-post-it-0',
      'activities-age',
    ]) {
      await assertWithinViewport(page, testId, viewport.width);
    }
    await assertWrapsInsideItsBox(page, 'category-name-ceiling-category-0');
    await assertWrapsInsideItsBox(page, 'post-it-text-ceiling-post-it-0');
    await assertWrapsInsideItsBox(page, 'post-it-by-ceiling-post-it-0');

    await page.screenshot({
      path: `screenshots/session-activities-attendee-ceiling-${viewport.name}.png`,
      fullPage: true,
    });
  });
}

// ---------- the Display Link controls (S04 TI13) ----------

/**
 * A projected-board link is a **43-character token on the end of an origin**: one unbroken string
 * with nowhere to wrap, on a surface that has to hold at 375px.
 *
 * That is exactly the shape that pushes a phone sideways, and it is not hypothetical here - it is
 * every link this feature ever produces. The failure being captured is a facilitator who cannot
 * reach Revoke without scrolling the page horizontally while a room is watching the wall.
 */
const DISPLAY_TOKEN = 'wJq3B7nVYt1sK0pLmXcZaR8dEfGhIjKlMnOpQrStUvW';

const DISPLAY_LINK_ACTIVITIES = {
  ...ACTIVITIES,
  rounds: [
    {
      id: 'round-post-it',
      kind: 'PostItRound',
      prompt: LONG_PROMPT,
      state: 'closed',
      textMaxLength: 280,
      categories: [
        {
          id: 'cat-tooling',
          name: 'Tooling',
          postItCount: 1,
          postIts: [
            {
              id: 'p-1',
              text: 'Review queue backed up on Fridays',
              authorName: 'Ada Lovelace',
              mine: false,
              edited: false,
              arrivedAfterClose: false,
            },
          ],
        },
      ],
      uncategorised: { postItCount: 0, postIts: [] },
    },
  ],
};

for (const viewport of VIEWPORTS) {
  test(`the display link controls hold at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await stubApi(page);
    await page.route(`**/api/conferences/${CONFERENCE_ID}/sessions/${SESSION_ID}`, (route) =>
      route.fulfill(json(DISPLAY_LINK_ACTIVITIES)),
    );
    await page.route('**/rounds/round-post-it/display-link', (route) =>
      route.fulfill(
        json({ displayLink: { token: DISPLAY_TOKEN, issuedAt: '2026-09-15T09:00:00.000000Z' } }),
      ),
    );

    await page.goto('/');
    await page.getByText('Autumn Offsite').click();
    await expect(page.getByTestId('schedule')).toBeVisible();
    await page.getByTestId(`activities-${SESSION_ID}`).click();
    await expect(page.getByTestId('display-link-round-post-it')).toBeVisible();

    // The whole URL is on screen and inside its own box, at every width.
    const field = page.getByTestId('display-link-url-round-post-it');
    await expect(field).toHaveValue(new RegExp(`/display/${DISPLAY_TOKEN}$`));
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    for (const testId of [
      'display-link-round-post-it',
      'display-link-url-round-post-it',
      'display-link-issued-round-post-it',
      'display-link-revoke-round-post-it',
    ]) {
      await assertWithinViewport(page, testId, viewport.width);
    }

    /*
     * The controls are real controls at 375px, not slivers: a facilitator taking a room screen back
     * is doing it one-handed, standing up, in front of people.
     */
    for (const testId of [
      'display-link-copy-round-post-it',
      'display-link-revoke-round-post-it',
      'display-link-reissue-round-post-it',
    ]) {
      const box = await page.getByTestId(testId).boundingBox();
      expect(box!.height, testId).toBeGreaterThanOrEqual(40);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
    }

    await page.screenshot({
      path: `screenshots/session-activities-display-link-${viewport.name}.png`,
      fullPage: true,
    });
  });
}
