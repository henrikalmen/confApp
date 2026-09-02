import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { DisplayBoardView } from '../src/display/DisplayBoardView.tsx';
import { detailTier, regionGrid } from '../src/display/board-layout.ts';
import { setTokenSource } from '../src/api/client.ts';
import { POLL_INTERVAL_MS } from '../src/poll/use-watermark-poll.ts';

/**
 * The projected Board View on the room machine (S07).
 *
 * Four properties carry this story, and each is asserted against what the surface *does* rather
 * than against what it was told to do:
 *
 *   - it renders **one Board** at the design ceiling, with every Category and every server-supplied
 *     count visible and no input needed to reveal anything;
 *   - it keeps itself current by **re-requesting the whole Board on the one shared cadence**,
 *     holding no Membership and no cursor;
 *   - a **refusal** replaces the Board and a **transport failure** does not - the split this story
 *     most has to get right; and
 *   - nothing on it is a control, and nothing it can reach is vote-shaped.
 *
 * `web/` has no jest-dom, so assertions are on plain DOM properties.
 */

const TOKEN = 'wJq3B7nVYt1sK0pLmXcZaR8dEfGhIjKlMnOpQrStUvW';

interface Call {
  path: string;
  headers: Record<string, string>;
  method: string;
}

const calls: Call[] = [];

type Answer = { status: number; body?: unknown } | 'unreachable' | 'hang';

/** The answer the next request gets. Reassigned between polls, exactly as the world changes. */
let answer: Answer = { status: 200, body: null };

function installFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      calls.push({
        path: String(input).replace(/^.*\/api/, ''),
        headers: Object.fromEntries(
          Object.entries((init?.headers ?? {}) as Record<string, string>),
        ),
        method: init?.method ?? 'GET',
      });
      const current = answer;
      if (current === 'hang') return new Promise<Response>(() => {});
      // A TypeError is what a browser throws when nothing answered at all: DNS gone, venue wifi
      // dead, captive portal refusing the connection. `navigator.onLine` stays true through it.
      if (current === 'unreachable') throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify(current.body), {
        status: current.status,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch,
  );
}

// ---------- fixtures ----------

function postIt(id: string, text: string, authorName: string): Record<string, unknown> {
  return { id, text, authorName, mine: false, edited: false, arrivedAfterClose: false };
}

/**
 * The design ceiling: 20 Categories plus Uncategorised, 200 Post-its.
 *
 * Deliberately uneven, so the per-Category detail tiers are actually exercised rather than all
 * landing on one - a Category holding two must stay rich while its neighbour holding eleven does
 * not, which is the whole of S01's settled degradation.
 */
const CEILING_SIZES = [2, 1, 14, 3, 20, 4, 9, 2, 17, 5, 11, 6, 8, 13, 7, 10, 12, 15, 16, 18];

/** An unbroken, non-hyphenated run: a hyphenated token breaks on its own and proves nothing. */
const UNBROKEN = 'HandoverBetweenPlatformAndProductWhereNobodyOwnsTheMiddleBit2026Q3Followup';

function ceilingBoard(): Record<string, unknown> {
  let next = 0;
  const categories = CEILING_SIZES.map((size, index) => {
    const postIts = Array.from({ length: size }, () => {
      next += 1;
      return postIt(
        `p-${next}`,
        next === 1 ? `Review queue backed up on Fridays ${UNBROKEN}` : `Post-it number ${next}`,
        `Author ${next}`,
      );
    });
    return {
      id: `cat-${index + 1}`,
      name:
        index === 0
          ? `Tooling and the handover in the middle ${UNBROKEN}`
          : `Category ${index + 1}`,
      postIts,
      postItCount: postIts.length,
    };
  });
  const held = Array.from({ length: 200 - next }, (_unused, index) =>
    postIt(`u-${index + 1}`, `Not sorted yet ${index + 1}`, `Author U${index + 1}`),
  );
  return {
    prompt: 'What slows you down most in a normal week?',
    categories,
    uncategorised: { postIts: held, postItCount: held.length },
  };
}

const SMALL = {
  prompt: 'What slowed us down this quarter?',
  categories: [
    {
      id: 'cat-tooling',
      name: 'Tooling',
      postIts: [postIt('p-1', 'Review queue backed up on Fridays', 'Ada Lovelace')],
      postItCount: 1,
    },
    { id: 'cat-people', name: 'People', postIts: [], postItCount: 0 },
  ],
  uncategorised: {
    postIts: [postIt('p-2', 'Waiting three days for test data', 'Bo Nilsson')],
    postItCount: 1,
  },
};

/** The same Board after a Facilitator sorted, discarded one Post-it and renamed a Category. */
const SMALL_AFTER = {
  prompt: SMALL.prompt,
  categories: [
    {
      id: 'cat-tooling',
      name: 'Tooling',
      postIts: [
        postIt('p-1', 'Review queue backed up on Fridays', 'Ada Lovelace'),
        postIt('p-2', 'Waiting three days for test data', 'Bo Nilsson'),
      ],
      postItCount: 2,
    },
    { id: 'cat-people', name: 'Process', postIts: [], postItCount: 0 },
  ],
  uncategorised: { postIts: [], postItCount: 0 },
};

const EMPTY = {
  prompt: 'What slows you down most in a normal week?',
  categories: [
    { id: 'c-1', name: 'Recognition and thanks', postIts: [], postItCount: 0 },
    { id: 'c-2', name: 'Tooling gaps', postIts: [], postItCount: 0 },
    { id: 'c-3', name: 'Meeting overload', postIts: [], postItCount: 0 },
  ],
  uncategorised: { postIts: [], postItCount: 0 },
};

const REFUSAL = {
  status: 404,
  body: {
    error: { code: 'DISPLAY_LINK_UNAVAILABLE', message: 'This board is no longer available.' },
  },
};

// ---------- harness ----------

beforeEach(() => {
  calls.length = 0;
  answer = { status: 200, body: SMALL };
  /*
   * The token source is armed with a real value on purpose. If anything on this path asked for a
   * credential it would get one, so "no Authorization header" is a property of the request rather
   * than of there being nothing available to send.
   */
  setTokenSource(async () => 'a-signed-in-employees-id-token');
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.setSystemTime(new Date('2026-09-15T09:00:00Z'));
  installFetch();
});

afterEach(() => {
  vi.useRealTimers();
  setTokenSource(async () => null);
  vi.unstubAllGlobals();
});

/** Advances the shared cadence by `ms`, letting every request it started settle. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Mounts and lets the mount-time read settle, without advancing the cadence at all. */
async function mount(): Promise<ReturnType<typeof render>> {
  const view = render(<DisplayBoardView token={TOKEN} />);
  await advance(0);
  return view;
}

// ---------- TI01: the Board at projection scale ----------

describe('the projected board at the design ceiling', () => {
  it('renders every category, every count and every post-it with nothing hidden behind input', async () => {
    const board = ceilingBoard();
    answer = { status: 200, body: board };
    await mount();

    const categories = board.categories as { id: string; name: string; postItCount: number }[];
    const uncategorised = board.uncategorised as { postItCount: number };
    expect(categories).toHaveLength(20);

    // Every Category, in the payload's order - which is the Facilitator's - with its own count.
    const regions = screen.getByTestId('display-regions');
    const rendered = [...regions.children].map((region) => region.getAttribute('data-testid'));
    expect(rendered).toEqual([
      'display-uncategorised',
      ...categories.map((category) => `display-category-${category.id}`),
    ]);

    for (const category of categories) {
      const region = screen.getByTestId(`display-category-${category.id}`);
      expect(region.textContent, category.id).toContain(category.name);
      expect(region.querySelector('.display-region__count')!.textContent, category.id).toBe(
        String(category.postItCount),
      );
      // Every Post-it in it is on the page - none is behind a "show more" or a page.
      expect(region.querySelectorAll('.display-post-it')).toHaveLength(category.postItCount);
    }

    // Uncategorised alongside, with its own count, and the whole 200 accounted for.
    expect(screen.getByTestId('display-uncategorised-count').textContent).toBe(
      String(uncategorised.postItCount),
    );
    expect(document.querySelectorAll('.display-post-it')).toHaveLength(200);
    expect(screen.getByTestId('display-meta').textContent).toBe('200 post-its · 20 categories');

    /*
     * The grid is sized to the number of regions, so every one of them is on screen at once. 21
     * regions is S01's 7-across-by-3-down, written onto the grid as custom properties.
     */
    expect(regions.getAttribute('style')).toContain('--display-regions-across: 7');
    expect(regions.getAttribute('style')).toContain('--display-regions-down: 3');

    // Nothing is revealed by input, because there is no input on this surface to give.
    expect(document.querySelectorAll('details, [hidden], [aria-expanded]')).toHaveLength(0);
  });

  /** Detail is the only thing that degrades, and it is chosen per Category by what it holds. */
  it('degrades post-it detail per category and never the category name, count or boundary', async () => {
    answer = { status: 200, body: ceilingBoard() };
    await mount();

    expect(screen.getByTestId('display-category-cat-1').getAttribute('data-tier')).toBe('full');
    expect(screen.getByTestId('display-category-cat-4').getAttribute('data-tier')).toBe('clamped');
    expect(screen.getByTestId('display-category-cat-3').getAttribute('data-tier')).toBe(
      'condensed',
    );

    // The name and count elements are the same elements at every tier - nothing swaps them out.
    for (const id of ['cat-1', 'cat-4', 'cat-3']) {
      const region = screen.getByTestId(`display-category-${id}`);
      expect(region.querySelector('.display-region__name'), id).not.toBeNull();
      expect(region.querySelector('.display-region__count'), id).not.toBeNull();
    }

    // And a Post-it always displays its author's name, at every tier including the condensed one.
    for (const item of document.querySelectorAll('.display-post-it')) {
      expect(item.querySelector('.display-post-it__by')!.textContent).toMatch(/\S/);
    }
  });

  it('lays the grid out from the number of regions, at both ends of the range S01 drew', () => {
    expect(regionGrid(21)).toEqual({ across: 7, down: 3 });
    expect(regionGrid(5)).toEqual({ across: 3, down: 2 });
    expect(regionGrid(1)).toEqual({ across: 1, down: 1 });
    expect(detailTier(0)).toBe('full');
    expect(detailTier(2)).toBe('full');
    expect(detailTier(3)).toBe('clamped');
    expect(detailTier(4)).toBe('clamped');
    expect(detailTier(5)).toBe('condensed');
  });

  /**
   * An empty Board is a legitimate pre-Round state - not an error, not a spinner, not "unavailable".
   * `uncategorised` is rendered whatever the Board holds, including when there are no Categories.
   */
  it('renders an empty board, and one with no categories at all', async () => {
    answer = { status: 200, body: EMPTY };
    await mount();

    expect(screen.getByTestId('display-board')).toBeTruthy();
    expect(screen.queryByTestId('display-unavailable')).toBeNull();
    expect(screen.getByTestId('display-uncategorised-count').textContent).toBe('0');
    for (const id of ['c-1', 'c-2', 'c-3']) {
      const region = screen.getByTestId(`display-category-${id}`);
      expect(region.querySelector('.display-region__count')!.textContent).toBe('0');
    }
    expect(document.querySelectorAll('.display-region__none')).toHaveLength(4);

    answer = {
      status: 200,
      body: {
        prompt: 'Nothing yet',
        categories: [],
        uncategorised: { postIts: [], postItCount: 0 },
      },
    };
    await advance(POLL_INTERVAL_MS);
    expect(screen.getByTestId('display-uncategorised')).toBeTruthy();
    expect(screen.getByTestId('display-uncategorised-count').textContent).toBe('0');
  });

  /**
   * The counts are the server's. S02 computes them precisely so no surface re-derives them, and a
   * re-derivation would drift the moment this projection ever rendered a subset - so a payload whose
   * count disagrees with its array must show the **count**.
   */
  it('renders the server count, never the length of the array beside it', async () => {
    answer = {
      status: 200,
      body: {
        prompt: 'Counts come from the server',
        categories: [
          { id: 'c-1', name: 'Tooling', postIts: [postIt('p-1', 'One', 'Ada')], postItCount: 9 },
        ],
        uncategorised: { postIts: [], postItCount: 4 },
      },
    };
    await mount();

    expect(
      screen.getByTestId('display-category-c-1').querySelector('.display-region__count')!
        .textContent,
    ).toBe('9');
    expect(screen.getByTestId('display-uncategorised-count').textContent).toBe('4');
    expect(screen.getByTestId('display-meta').textContent).toBe('13 post-its · 1 category');
  });
});

// ---------- TI02: the cadence ----------

describe('keeping itself current', () => {
  it('re-requests the whole board on the shared cadence, with no credential and no cursor', async () => {
    await mount();
    expect(calls).toHaveLength(1);

    await advance(POLL_INTERVAL_MS * 3);
    expect(calls.length).toBeGreaterThanOrEqual(4);

    for (const call of calls) {
      expect(call.method).toBe('GET');
      expect(call.path).toBe(`/display/${TOKEN}`);
      expect(Object.keys(call.headers).map((key) => key.toLowerCase())).not.toContain(
        'authorization',
      );
      expect(Object.keys(call.headers).map((key) => key.toLowerCase())).not.toContain(
        'if-none-match',
      );
    }
    // No activity cursor is read, and none exists to read: the watermark is Membership-gated.
    expect(calls.some((call) => /watermark|activities/i.test(call.path))).toBe(false);
  });

  it('keeps at most one request in flight, skipping a tick rather than queueing it', async () => {
    answer = 'hang';
    render(<DisplayBoardView token={TOKEN} />);
    await advance(0);
    expect(calls).toHaveLength(1);

    await advance(POLL_INTERVAL_MS * 5);
    expect(calls).toHaveLength(1);
  });

  it('puts a board changed between two polls on the wall, with nobody touching the machine', async () => {
    await mount();
    expect(screen.getByTestId('display-uncategorised-count').textContent).toBe('1');
    expect(screen.getByTestId('display-category-cat-people').textContent).toContain('People');

    answer = { status: 200, body: SMALL_AFTER };
    await advance(POLL_INTERVAL_MS);

    // The placement, the rename and the fallen counts, all within one interval.
    expect(
      screen.getByTestId('display-category-cat-tooling').querySelector('.display-region__count')!
        .textContent,
    ).toBe('2');
    expect(screen.getByTestId('display-uncategorised-count').textContent).toBe('0');
    expect(screen.getByTestId('display-category-cat-people').textContent).toContain('Process');
    expect(screen.getByTestId('display-category-cat-people').textContent).not.toContain('People');
  });

  it('stops asking once it is unmounted', async () => {
    const view = await mount();
    const atUnmount = calls.length;
    view.unmount();
    await advance(POLL_INTERVAL_MS * 4);
    expect(calls).toHaveLength(atUnmount);
  });
});

// ---------- TI03: a link that has stopped resolving ----------

describe('a link that has stopped resolving', () => {
  it('replaces the board at the next poll and leaves none of it rendered', async () => {
    await mount();
    expect(screen.getByTestId('display-board')).toBeTruthy();

    answer = REFUSAL;
    await advance(POLL_INTERVAL_MS);

    expect(screen.getByTestId('display-message').textContent).toBe(
      'This board is no longer available.',
    );
    expect(screen.queryByTestId('display-board')).toBeNull();
    expect(screen.queryByTestId('display-uncategorised')).toBeNull();
    // No Category, Post-it, count or author name survives anywhere on the page.
    expect(document.body.textContent).not.toMatch(/Tooling|People|Ada Lovelace|Bo Nilsson/);
    expect(document.querySelectorAll('.display-post-it')).toHaveLength(0);
  });

  /**
   * Revoked, past the Session day, a deleted Round and a token that never existed are one answer
   * with one code and one message. Nothing on the wall can tell a room which of them happened,
   * because nothing in the response says.
   */
  it('is indistinguishable across every reason a link can be dead', async () => {
    const seen = new Set<string>();
    for (const reason of ['revoked', 'past its session day', 'round deleted', 'never issued']) {
      answer = REFUSAL;
      const view = render(<DisplayBoardView token={TOKEN} />);
      await advance(0);
      const shown = screen.getByTestId('display-unavailable').textContent ?? '';
      expect(shown, reason).toContain('This board is no longer available.');
      seen.add(shown);
      view.unmount();
    }
    expect(seen.size).toBe(1);
    expect([...seen][0]).toContain('This board is no longer available.');
    expect([...seen][0]).not.toMatch(/revoked|expired|draft|deleted|unknown|404/i);
  });

  /** A Draft Conference's link needs no special handling: it simply starts resolving once Published. */
  it('starts rendering the board on its own once the link begins resolving, with no reload', async () => {
    answer = REFUSAL;
    await mount();
    expect(screen.getByTestId('display-unavailable')).toBeTruthy();

    answer = { status: 200, body: SMALL };
    await advance(POLL_INTERVAL_MS);

    expect(screen.getByTestId('display-board')).toBeTruthy();
    expect(screen.queryByTestId('display-unavailable')).toBeNull();
  });
});

// ---------- TI04: the wifi dies, and a refusal is not a failure ----------

describe('losing the venue network', () => {
  /**
   * The venue failure this story is written for keeps `navigator.onLine` **true** - the link stays
   * up and only reachability is gone - so it is left true here on purpose. What decides staleness is
   * whether the request succeeded, and nothing else.
   */
  it('keeps the last board on the wall and ages an honest indicator, then resumes', async () => {
    await mount();
    expect(navigator.onLine).toBe(true);
    expect(screen.queryByTestId('display-staleness')).toBeNull();

    answer = 'unreachable';
    await advance(POLL_INTERVAL_MS);

    // The board is still there, and now says it is not current.
    expect(screen.getByTestId('display-board')).toBeTruthy();
    expect(screen.getByTestId('display-post-it-p-1').textContent).toContain('Ada Lovelace');
    expect(screen.getByTestId('display-staleness')).toBeTruthy();
    expect(screen.getByTestId('display-staleness').textContent).toContain('lost its connection');
    const first = screen.getByTestId('display-staleness-age').textContent ?? '';
    expect(first).toContain('Updated just now');

    // Several polls in a row fail, and the age advances on the shared tick while they do - which is
    // exactly the window in which nothing else re-renders this surface.
    await advance(POLL_INTERVAL_MS * 24);
    const later = screen.getByTestId('display-staleness-age').textContent ?? '';
    expect(later).toContain('Updated 2 minutes ago');
    expect(later).not.toBe(first);
    expect(screen.getByTestId('display-board')).toBeTruthy();

    await advance(POLL_INTERVAL_MS * 60);
    expect(screen.getByTestId('display-staleness-age').textContent).toContain(
      'Updated 7 minutes ago',
    );

    // Connectivity returns; the first successful poll updates the board and clears the indicator.
    answer = { status: 200, body: SMALL_AFTER };
    await advance(POLL_INTERVAL_MS);
    expect(screen.queryByTestId('display-staleness')).toBeNull();
    expect(screen.getByTestId('display-uncategorised-count').textContent).toBe('0');
  });

  /**
   * The split this story most has to get right, from the other side: a **refusal** replaces the
   * Board even while `navigator.onLine` reads true, and a **transport failure** never does.
   */
  it('replaces the board on a refusal but never on a transport failure', async () => {
    await mount();

    answer = 'unreachable';
    await advance(POLL_INTERVAL_MS * 2);
    expect(screen.getByTestId('display-board')).toBeTruthy();
    expect(screen.queryByTestId('display-unavailable')).toBeNull();

    answer = REFUSAL;
    await advance(POLL_INTERVAL_MS);
    expect(navigator.onLine).toBe(true);
    expect(screen.queryByTestId('display-board')).toBeNull();
    expect(screen.getByTestId('display-message').textContent).toBe(
      'This board is no longer available.',
    );
  });

  /** The indicator is an indicator. Nothing is written, queued or reconciled from this surface. */
  it('offers no retry and writes nothing', async () => {
    await mount();
    answer = 'unreachable';
    await advance(POLL_INTERVAL_MS * 2);

    const stale = screen.getByTestId('display-staleness');
    expect(stale.querySelectorAll('button, a, input, [role="button"], [tabindex]')).toHaveLength(0);
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
    expect(document.body.textContent).not.toMatch(/retry|try again|queued|reconnecting…/i);
  });
});

// ---------- TI05: nothing on the surface is a control ----------

describe('the projected surface takes no input', () => {
  const states: [string, () => Promise<void>][] = [
    [
      'populated at the ceiling',
      async () => {
        answer = { status: 200, body: ceilingBoard() };
        await mount();
      },
    ],
    [
      'empty',
      async () => {
        answer = { status: 200, body: EMPTY };
        await mount();
      },
    ],
    [
      'unavailable',
      async () => {
        answer = REFUSAL;
        await mount();
      },
    ],
    [
      'stale',
      async () => {
        await mount();
        answer = 'unreachable';
        await advance(POLL_INTERVAL_MS);
      },
    ],
  ];

  for (const [name, arrange] of states) {
    it(`offers nothing that changes board state when ${name}`, async () => {
      await arrange();

      // Nothing that is interactive by tag, role or attribute exists on the page at all.
      expect(
        document.querySelectorAll(
          'button, input, select, textarea, a, form, [contenteditable], [draggable="true"], [tabindex], [role="button"], [role="link"], [onclick]',
        ),
      ).toHaveLength(0);

      // And activating every element anyway - by pointer and by keyboard - changes nothing.
      const before = document.body.innerHTML;
      const issued = calls.length;
      await act(async () => {
        for (const element of document.querySelectorAll('*')) {
          element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          element.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
        }
      });

      expect(calls.length).toBe(issued);
      expect(calls.every((call) => call.method === 'GET')).toBe(true);
      expect(document.body.innerHTML).toBe(before);
    });
  }
});

// ---------- TI06 / TI07 / TI10 ----------

describe('what the projected surface can and cannot show', () => {
  /**
   * The behavioural half of the vote guard. The payload genuinely carries a tally, an option set and
   * a cast-ballot flag - a fixture that merely omitted them would prove nothing - and the surface
   * renders none of it, and asks for nothing else that could.
   */
  it('renders nothing vote-derived, nothing from a sibling round and no member data but author names', async () => {
    answer = {
      status: 200,
      body: {
        ...SMALL,
        tally: [{ optionId: 'o-1', votes: 7 }],
        hasVoted: true,
        options: [{ id: 'o-1', label: 'Tooling' }],
        rounds: [{ id: 'round-2', prompt: 'The sibling post-it round' }],
        joinCode: 'JOIN-4821',
        members: [{ sub: 'google-oidc|17', displayName: 'Someone Else', role: 'Facilitator' }],
        sessions: [{ id: 'session-2', title: 'The other session' }],
      },
    };
    await mount();
    await advance(POLL_INTERVAL_MS * 2);

    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/\bvote|tally|ballot|option\b/i);
    expect(text).not.toContain('7');
    expect(text).not.toContain('JOIN-4821');
    expect(text).not.toContain('Someone Else');
    expect(text).not.toContain('Facilitator');
    expect(text).not.toContain('google-oidc|17');
    expect(text).not.toContain('The sibling post-it round');
    expect(text).not.toContain('The other session');

    // The only Member data present is the author display names the Board projection carries.
    expect(text).toContain('Ada Lovelace');
    expect(text).toContain('Bo Nilsson');

    // And every request it made was the one resolution GET.
    expect(calls.every((call) => call.path === `/display/${TOKEN}` && call.method === 'GET')).toBe(
      true,
    );
  });

  /**
   * A discarded Post-it, and a permanently removed one, are simply **absent**: no marker, no badge,
   * no notification. The exclusion is S05's statement-level anti-join and S06's removal of the row -
   * this surface filters nothing.
   */
  it('shows a discarded and a removed post-it as simply gone at the next poll', async () => {
    answer = {
      status: 200,
      body: {
        prompt: SMALL.prompt,
        categories: [
          {
            id: 'cat-people',
            name: 'People',
            postIts: [
              postIt('p-9', 'Onboarding buddy scheme works', 'Iben Krag'),
              postIt('p-10', 'Recruiting takes months', 'Tomas Berg'),
            ],
            postItCount: 2,
          },
        ],
        uncategorised: {
          postIts: [postIt('p-11', 'Stale staging data', 'Mia Holm')],
          postItCount: 1,
        },
      },
    };
    await mount();
    expect(screen.getByTestId('display-post-it-p-9')).toBeTruthy();
    expect(screen.getByTestId('display-post-it-p-11')).toBeTruthy();

    // The server's next answer simply does not carry them, and their counts have fallen with them.
    answer = {
      status: 200,
      body: {
        prompt: SMALL.prompt,
        categories: [
          {
            id: 'cat-people',
            name: 'People',
            postIts: [postIt('p-10', 'Recruiting takes months', 'Tomas Berg')],
            postItCount: 1,
          },
        ],
        uncategorised: { postIts: [], postItCount: 0 },
      },
    };
    await advance(POLL_INTERVAL_MS);

    expect(screen.queryByTestId('display-post-it-p-9')).toBeNull();
    expect(screen.queryByTestId('display-post-it-p-11')).toBeNull();
    expect(
      screen.getByTestId('display-category-cat-people').querySelector('.display-region__count')!
        .textContent,
    ).toBe('1');
    expect(screen.getByTestId('display-uncategorised-count').textContent).toBe('0');
    expect(document.body.textContent).not.toMatch(/set aside|discard|removed|deleted/i);
  });

  /**
   * A Post-it Round in a Presentation projects exactly as one in a Workshop. There is no
   * Session-kind branch on this surface - the projection is of a **Board**, and a Board belongs to a
   * Post-it Round in either Session kind.
   */
  it('renders identically whatever kind of session the round belongs to', async () => {
    answer = { status: 200, body: { ...SMALL, sessionKind: 'Presentation' } };
    const presentation = render(<DisplayBoardView token={TOKEN} />);
    await advance(0);
    const asPresentation = screen.getByTestId('display-board').innerHTML;
    presentation.unmount();

    answer = { status: 200, body: { ...SMALL, sessionKind: 'Workshop' } };
    const workshop = render(<DisplayBoardView token={TOKEN} />);
    await advance(0);
    expect(screen.getByTestId('display-board').innerHTML).toBe(asPresentation);
    workshop.unmount();
  });
});
