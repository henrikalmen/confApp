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
  activityWatermark: '4171',
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

  for (const testId of ['board-round-post-it', 'post-it-post-it-ada', 'compose-round-post-it']) {
    await assertWithinViewport(page, testId, width);
  }
  await assertWrapsInsideItsBox(page, 'post-it-text-post-it-ada');
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
          postIts: [
            ...(round.postIts ?? []),
            {
              id: 'post-it-late',
              text: `Sent from the car park once the signal came back. ${UNBROKEN_POST_IT}`,
              authorName: 'Ida Andersson',
              mine: true,
              edited: false,
              arrivedAfterClose: true,
            },
          ],
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
