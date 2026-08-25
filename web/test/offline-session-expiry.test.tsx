import 'fake-indexeddb/auto';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import { AttendeeSchedulePanel } from '../src/attendee/AttendeeSchedulePanel.tsx';
import {
  cachedKeys,
  readCachedSchedule,
  setCacheIdentity,
  writeCachedSchedule,
} from '../src/offline/schedule-cache.ts';
import { listCachedConferences } from '../src/offline/schedule-data.ts';
import { setTokenSource } from '../src/api/client.ts';
import { createAuthSession, type AuthSession } from '../src/auth/session.ts';
import { setSessionActions } from '../src/auth/session-actions.ts';
import type { WebAuthConfig } from '../src/config.ts';
import type { AttendeeSchedule, AttendeeSession } from '../src/api/client.ts';

/**
 * `offline-session-expiry` – reading a cached Schedule when the sign-in has lapsed, and stopping
 * once the conference it belongs to is far enough behind.
 *
 * **The session here is real.** These tests build an actual `createAuthSession` with an injected
 * clock, sign in through it, and then move that clock past expiry – so `validToken()` is genuinely
 * the thing returning no credential, and `apiRequest` genuinely refuses to issue the request. A
 * stubbed token source would prove nothing about the join between them, which is where the defect
 * lived: a missing token became an anonymous request, the 401 read as the server refusing, and the
 * attendee's cached Schedule was deleted on the strength of it.
 *
 * **Nothing asserts on rendered output where the claim is about a navigation.** jsdom ignores a
 * `location.assign`, so "the schedule appeared" is true whether or not confApp tried to leave for
 * Google. Where the claim is "nothing navigated", the navigation seam itself is spied.
 */

const config: WebAuthConfig = {
  clientId: 'web-111.apps.googleusercontent.example',
  authorizationEndpoint: 'https://accounts.google.example/o/oauth2/v2/auth',
  hostedDomain: 'ourcompany.example',
  redirectUri: 'http://localhost:8082/auth/callback',
};

const NADIA = {
  sub: 'google-sub-nadia',
  email: 'nadia@ourcompany.example',
  displayName: 'Nadia',
};

const KICKOFF = '11111111-1111-4111-8111-111111111111';
const AUTUMN_OFFSITE = '22222222-2222-4222-8222-222222222222';
const RETRO_DAY = '33333333-3333-4333-8333-333333333333';

const DAY = 86_400_000;
/** The device clock's reading when the last cached response landed. */
const RECEIPT = Date.UTC(2026, 8, 15, 7, 40, 12, 345);

/** Seconds since the epoch at sign-in, and an hour later – Google's ID token lifetime. */
const SIGNED_IN_AT = 1_800_000_000;
const TOKEN_EXPIRES_AT = SIGNED_IN_AT + 3600;

function session(overrides: Partial<AttendeeSession> & { id: string }): AttendeeSession {
  return {
    title: 'Opening Keynote',
    description: null,
    kind: 'Presentation',
    startTime: '09:00',
    endTime: '10:30',
    location: 'Main Hall',
    concurrentWith: [],
    ...overrides,
  };
}

const KEYNOTE = session({ id: 'keynote' });

/**
 * One cached envelope, as it looked at its last successful sync.
 *
 * `syncedOn` is the server's calendar day at that sync – the day the anchor advances "now" from –
 * and `endDate` is what the readability window is measured against.
 */
function envelope(options: {
  id: string;
  name: string;
  syncedOn: string;
  startDate: string;
  endDate: string;
}): AttendeeSchedule {
  return {
    conference: {
      id: options.id,
      name: options.name,
      startDate: options.startDate,
      endDate: options.endDate,
      state: 'published',
      lastUpdatedAt: `${options.syncedOn}T08:00:00.000000Z`,
    },
    days: [{ date: options.startDate, dayNumber: 1, sessions: [KEYNOTE] }],
    serverNow: {
      instant: `${options.syncedOn}T07:40:12.345678Z`,
      day: options.syncedOn,
      time: '09:40',
    },
  } as unknown as AttendeeSchedule;
}

/**
 * Stores one entry, with the device clock's reading at the moment it was written.
 *
 * `receipt` is what makes "how long ago" real rather than asserted: the effective clock advances
 * the entry's own `serverNow` by `Date.now() - receipt`, so an entry last synced eleven months ago
 * is one whose receipt reading is eleven months behind the current one. Nothing here sets a
 * "today"; time passes because the device clock moved.
 */
async function cache(entry: AttendeeSchedule, receipt = RECEIPT): Promise<void> {
  await writeCachedSchedule(NADIA.sub, entry.conference.id, {
    envelope: entry,
    watermark: entry.conference.lastUpdatedAt,
    deviceClockAtReceipt: receipt,
  });
}

/** "Kickoff 2026", 15–18 September 2026, synced on the 15th – the conference she is at. */
const KICKOFF_2026 = envelope({
  id: KICKOFF,
  name: 'Kickoff 2026',
  syncedOn: '2026-09-15',
  startDate: '2026-09-15',
  endDate: '2026-09-18',
});

/** "Autumn Offsite", ended 2025-10-03 and never opened since – long past its margin. */
const AUTUMN = envelope({
  id: AUTUMN_OFFSITE,
  name: 'Autumn Offsite',
  syncedOn: '2025-10-03',
  startDate: '2025-10-02',
  endDate: '2025-10-03',
});

/**
 * The device clock's reading when Autumn Offsite was last synced – 2025-10-03, on a device whose
 * clock now reads a day past `RECEIPT`. Eleven and a half months of elapsed time, so its effective
 * "now" lands in mid-September 2026 exactly as Acceptance Scenario S02 states it.
 */
const AUTUMN_RECEIPT = RECEIPT - 348 * DAY;

// ---------- the transport ----------

type Answer = { status: number; body: unknown } | 'offline';

/** Requests actually issued, so "no request was sent" is a fact rather than an inference. */
interface Issued {
  url: string;
  authorization: string | undefined;
}

let issued: Issued[] = [];

function routeFetch(routes: () => Record<string, Answer>): typeof fetch {
  return vi.fn(async (input: unknown, init?: RequestInit) => {
    if (init?.signal?.aborted === true) throw new DOMException('Aborted', 'AbortError');

    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    issued.push({ url, authorization: headers.authorization });

    const table = routes();
    const match = Object.keys(table)
      .sort((a, b) => b.length - a.length)
      .find((path) => url.endsWith(path));

    const answer = match === undefined ? 'offline' : table[match]!;
    // What the browser throws with no route to the host. Never an API refusal – an API refusal is
    // an answer, and a cache must not overrule one.
    if (answer === 'offline') throw new TypeError('Failed to fetch');

    return {
      ok: answer.status < 400,
      status: answer.status,
      json: async () => answer.body,
    } as Response;
  }) as unknown as typeof fetch;
}

function setOnLine(value: boolean): void {
  Object.defineProperty(navigator, 'onLine', { value, configurable: true });
}

/**
 * Lets an in-flight poll finish.
 *
 * The panel keeps at most one poll in flight and **skips** a prompt that arrives while one is
 * outstanding rather than queueing it. So a test that fires two prompts back to back exercises one
 * of them, and would report the second as "nothing happened" when the truth is "nothing was asked".
 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

// ---------- a real session, signed in and then left to expire ----------

interface Lapsed {
  session: AuthSession;
  /** Where the browser was told to go. Empty is the assertion S01 turns on. */
  navigations: string[];
  /** Calls to the renewal entry point, counted at the seam the panel invokes. */
  readonly renewals: number;
  readonly signIns: number;
}

/**
 * Signs Nadia in for real, then moves the session's clock a day forward.
 *
 * The stored session survives – token expiry is not a session lifetime bound, and treating it as
 * one would sign every attendee out roughly hourly (Structural Criteria). What lapses is only the
 * credential.
 */
async function lapsedSignIn(): Promise<Lapsed> {
  const navigations: string[] = [];
  let seconds = SIGNED_IN_AT;

  const tokenFetch = (async () =>
    new Response(
      JSON.stringify({ idToken: 'nadia-token', expiresAt: TOKEN_EXPIRES_AT, user: NADIA }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;

  const auth = createAuthSession({
    config,
    navigate: (url) => navigations.push(url),
    fetchImpl: tokenFetch,
    now: () => seconds,
    apiBaseUrl: '/api',
  });

  await auth.beginSignIn();
  const attempt = JSON.parse(sessionStorage.getItem('confapp.auth.attempt')!) as { state: string };
  const outcome = await auth.completeRedirect(`?code=c&state=${attempt.state}`);
  expect(outcome.kind).toBe('signed-in');

  // The next morning. The token is hours past its expiry; the session is not.
  seconds = SIGNED_IN_AT + 86_400;
  navigations.length = 0;
  expect(auth.current()?.user.sub).toBe(NADIA.sub);
  expect(await auth.validToken()).toBeNull();

  const counters = { renewals: 0, signIns: 0 };
  setTokenSource(() => auth.validToken());
  setCacheIdentity(() => NADIA.sub);
  setSessionActions({
    renew: () => {
      counters.renewals += 1;
      // Delegated to the real entry point, so a navigation that should not have happened shows up
      // in `navigations` rather than being swallowed by a counter.
      return auth.renewSilently();
    },
    signIn: () => {
      counters.signIns += 1;
      void auth.beginSignIn();
    },
  });

  return {
    session: auth,
    navigations,
    get renewals() {
      return counters.renewals;
    },
    get signIns() {
      return counters.signIns;
    },
  };
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  window.__CONFAPP_CONFIG__ = { apiBaseUrl: '/api' };
  issued = [];
  setOnLine(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  setCacheIdentity(() => null);
  setSessionActions({ renew: () => {}, signIn: () => {} });
  setOnLine(true);
});

// ---------- Acceptance Scenario S01: offline with a lapsed sign-in ----------

describe('an attendee on day two whose sign-in lapsed overnight, with no connection', () => {
  it('reads the cached schedule, and confApp never leaves for the authorization endpoint', async () => {
    // The 16th: one day after the sync, inside Kickoff's 15–18 September span.
    vi.spyOn(Date, 'now').mockReturnValue(RECEIPT + DAY);
    const lapsed = await lapsedSignIn();
    await cache(KICKOFF_2026);

    setOnLine(false);
    vi.stubGlobal(
      'fetch',
      routeFetch(() => ({})),
    );

    render(<AttendeeSchedulePanel />);

    // S10's cached path, unchanged: the ordinary schedule view with its cached-data label.
    const list = await screen.findByTestId('attendee-session-list');
    expect(list.textContent).toContain('Opening Keynote');
    expect(screen.getByTestId('attendee-session-keynote').textContent).toContain('09:00–10:30');
    const label = screen.getByTestId('schedule-cached-label');
    expect(label.textContent).toMatch(/saved on this device/i);
    expect(label.textContent).toMatch(/ago/i);

    // The claim this scenario exists for, asserted where it can actually be observed.
    expect(lapsed.navigations).toEqual([]);
    expect(lapsed.renewals).toBe(0);
    // And the session was never cleared on the way, so the cache is still hers to read.
    expect(lapsed.session.current()?.user.sub).toBe(NADIA.sub);
    expect(await readCachedSchedule(NADIA.sub, KICKOFF)).not.toBeNull();
  });
});

// ---------- Acceptance Scenarios S02 and S06: withheld, and why ----------

describe('a cached conference whose span plus the margin has passed', () => {
  it('is withheld behind a sign-in-required state, not shown and not called absent', async () => {
    // Nearly a year after Autumn Offsite ended.
    vi.spyOn(Date, 'now').mockReturnValue(RECEIPT + DAY);
    await lapsedSignIn();
    await cache(AUTUMN, AUTUMN_RECEIPT);

    setOnLine(false);
    vi.stubGlobal(
      'fetch',
      routeFetch(() => ({})),
    );

    render(<AttendeeSchedulePanel />);

    const notice = await screen.findByTestId('schedule-sign-in-required');
    expect(notice.textContent).toMatch(/sign-in has expired/i);
    // Distinguishable in the DOM from S10's absent-cache state, which claims the opposite thing.
    expect(screen.queryByTestId('schedule-unavailable-offline')).toBeNull();
    // And the schedule itself is not displayed.
    expect(screen.queryByTestId('attendee-session-list')).toBeNull();

    // The entry is still on the device – withheld is not deleted. Nothing here purges.
    expect(await readCachedSchedule(NADIA.sub, AUTUMN_OFFSITE)).not.toBeNull();
  });
});

describe('a conference joined but never opened, with a lapsed sign-in and no connection', () => {
  /**
   * S06 – and the regression TI07 most easily causes. The read now fails with an `ApiError`
   * rather than a raw `TypeError`, and the branch that selects this state used to test exactly
   * `error instanceof ApiError`. Left alone it would have sent this case to the failure alert.
   */
  it('still reports an absent cache, not a lapsed sign-in and not a failure alert', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(RECEIPT + DAY);
    await lapsedSignIn();

    // Retro Day was joined and cached once, and has since been evicted – the ordinary case: iOS
    // WebKit clears IndexedDB for unused origins and quota pressure drops entries.
    await cache(
      envelope({
        id: RETRO_DAY,
        name: 'Retro Day',
        syncedOn: '2026-09-15',
        startDate: '2026-09-15',
        endDate: '2026-09-18',
      }),
    );
    expect(await cachedKeys()).toHaveLength(1);
    globalThis.indexedDB = new IDBFactory();
    expect(await cachedKeys()).toEqual([]);

    setOnLine(false);
    vi.stubGlobal(
      'fetch',
      routeFetch(() => ({})),
    );

    render(<AttendeeSchedulePanel />);

    await screen.findByTestId('schedule-unavailable-offline');
    expect(screen.queryByTestId('attendee-schedule-error')).toBeNull();
    expect(screen.queryByTestId('attendee-conferences-error')).toBeNull();
    expect(screen.queryByTestId('schedule-sign-in-required')).toBeNull();
  });
});

// ---------- Acceptance Scenario S03: two conferences, lapsing independently ----------

describe('two cached conferences with different spans', () => {
  it('offers only the one inside its window, and lands her on it', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(RECEIPT + DAY);
    await lapsedSignIn();
    await cache(KICKOFF_2026);
    await cache(AUTUMN, AUTUMN_RECEIPT);
    expect(await cachedKeys()).toHaveLength(2);

    setOnLine(false);
    vi.stubGlobal(
      'fetch',
      routeFetch(() => ({})),
    );

    /*
     * Asserted on the candidate set rather than on the picker control, which does not render at
     * all once the filter leaves a single candidate – so a picker-based assertion would pass just
     * as well against a filter that removed both.
     */
    const candidates = await listCachedConferences();
    expect(candidates.conferences.map((entry) => entry.name)).toEqual(['Kickoff 2026']);
    // And the removal is reported, so a device left holding only lapsed entries can say why.
    expect(candidates.withheld).toBe(true);

    render(<AttendeeSchedulePanel />);

    // And the conference she lands on is the one that renders.
    expect(await screen.findByTestId('attendee-session-list')).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'Kickoff 2026' })).not.toBeNull();
    expect(screen.queryByText(/Autumn Offsite/)).toBeNull();
  });
});

// ---------- Acceptance Scenario S04: renewal only once the API has answered ----------

describe('a captive portal that reports a link and answers nothing', () => {
  it('starts no renewal until a request actually succeeds, and then exactly one', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(RECEIPT + DAY);
    const lapsed = await lapsedSignIn();
    await cache(KICKOFF_2026);

    // The link is up, as far as the browser is concerned. Nothing answers.
    setOnLine(true);
    let table: Record<string, Answer> = {};
    vi.stubGlobal(
      'fetch',
      routeFetch(() => table),
    );

    render(<AttendeeSchedulePanel />);
    await screen.findByTestId('attendee-session-list');

    // Several prompts to try, each one a request that genuinely goes out and genuinely fails.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = issued.length;
      fireEvent(window, new Event('online'));
      await waitFor(() => expect(issued.length).toBeGreaterThan(before));
      await settle();
    }
    // `navigator.onLine` decided nothing. No renewal, and above all no navigation away from a
    // screen that is currently showing the attendee her schedule.
    expect(lapsed.renewals).toBe(0);
    expect(lapsed.navigations).toEqual([]);

    // The venue wifi comes back for real: the API answers.
    table = {
      '/health': { status: 200, body: { status: 'ok', schemaVersion: '1', serverTime: 'x' } },
    };
    fireEvent(window, new Event('online'));

    await waitFor(() => expect(lapsed.renewals).toBe(1));
    // DR04's mechanism, unchanged: one silent top-level navigation, no iframe and no refresh token.
    await waitFor(() => expect(lapsed.navigations).toHaveLength(1));
    const params = new URL(lapsed.navigations[0]!).searchParams;
    expect(params.get('prompt')).toBe('none');
    expect(params.get('login_hint')).toBe(NADIA.email);
    expect(params.get('code_challenge_method')).toBe('S256');

    // And asking again does not ask twice: a renewal is a navigation away from the app, and the
    // decision to make one belongs to this view once.
    fireEvent(window, new Event('online'));
    await settle();
    fireEvent(window, new Event('online'));
    await settle();
    expect(lapsed.renewals).toBe(1);
    expect(lapsed.navigations).toHaveLength(1);
  });
});

// ---------- Acceptance Scenario S07: no credential is not an anonymous request ----------

describe('the panel’s next scheduled refresh with no usable credential', () => {
  it('sends no request without an Authorization header, and forgets nothing', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(RECEIPT + DAY);
    await lapsedSignIn();
    await cache(KICKOFF_2026);

    setOnLine(true);
    vi.stubGlobal(
      'fetch',
      routeFetch(() => ({})),
    );

    render(<AttendeeSchedulePanel />);
    await screen.findByTestId('attendee-session-list');

    fireEvent(window, new Event('online'));
    await waitFor(() => expect(issued.length).toBeGreaterThan(0));

    /*
     * The defect in one line. An authenticated route reached without a credential answers 401,
     * the panel reads an answer as authoritative, and the cached entry is deleted – so the request
     * must not be made at all. `/health` is the one anonymous route and is allowed to be issued.
     */
    const authenticated = issued.filter((request) => !request.url.endsWith('/health'));
    expect(authenticated).toEqual([]);
    // Whatever was issued carried no credential, and needed none.
    expect(issued.every((request) => request.authorization === undefined)).toBe(true);

    // The schedule is still on screen, from the cache, and the entry is still in storage.
    expect(screen.getByTestId('attendee-session-list').textContent).toContain('Opening Keynote');
    expect(screen.getByTestId('schedule-cached-label')).not.toBeNull();
    expect(screen.queryByTestId('attendee-schedule-error')).toBeNull();
    expect(await readCachedSchedule(NADIA.sub, KICKOFF)).not.toBeNull();
  });
});

// ---------- TI10: the sign-in control cannot navigate from an offline device ----------

describe('the sign-in control in the sign-in-required state', () => {
  it('is present, disabled and inert while the device is offline', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(RECEIPT + DAY);
    const lapsed = await lapsedSignIn();
    await cache(AUTUMN, AUTUMN_RECEIPT);

    setOnLine(false);
    vi.stubGlobal(
      'fetch',
      routeFetch(() => ({})),
    );

    render(<AttendeeSchedulePanel />);
    await screen.findByTestId('schedule-sign-in-required');

    const button = screen.getByTestId('attendee-sign-in-again') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    // Said, not merely implied by a greyed control.
    expect(screen.getByTestId('attendee-sign-in-offline-hint').textContent).toMatch(
      /needs a connection/i,
    );

    // An enabled control here would navigate to Google and fail – the defect this feature removes,
    // reintroduced through a button.
    fireEvent.click(button);
    expect(lapsed.signIns).toBe(0);
    expect(lapsed.navigations).toEqual([]);
  });

  it('becomes available when the link returns', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(RECEIPT + DAY);
    const lapsed = await lapsedSignIn();
    await cache(AUTUMN, AUTUMN_RECEIPT);

    setOnLine(false);
    vi.stubGlobal(
      'fetch',
      routeFetch(() => ({})),
    );

    render(<AttendeeSchedulePanel />);
    await screen.findByTestId('schedule-sign-in-required');

    setOnLine(true);
    fireEvent(window, new Event('online'));

    const button = await waitFor(() => {
      const control = screen.getByTestId('attendee-sign-in-again') as HTMLButtonElement;
      expect(control.disabled).toBe(false);
      return control;
    });
    expect(screen.queryByTestId('attendee-sign-in-offline-hint')).toBeNull();

    fireEvent.click(button);
    expect(lapsed.signIns).toBe(1);
    await waitFor(() => expect(lapsed.navigations).toHaveLength(1));
  });
});
