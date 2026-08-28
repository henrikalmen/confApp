import { describe, expect, it } from 'vitest';
import {
  READABILITY_MARGIN_DAYS,
  SYNC_MARGIN_DAYS,
  withinReadabilityWindow,
} from '../src/offline/readability-window.ts';
import type { CachedSchedule } from '../src/offline/schedule-cache.ts';
import type { AttendeeSchedule, LifecycleState } from '../src/api/client.ts';

/**
 * TI02 – the one predicate that decides how long a cached Schedule stays readable offline.
 *
 * Every case here is driven through the **effective clock**, by moving the device clock forward
 * from the receipt reading rather than by stubbing a "today". That is the whole substance of the
 * rule: the entry carries the server's reading at its last sync, and elapsed real time is added to
 * it, so a device whose own clock is wrong cannot lengthen or shorten anybody's window.
 */

const DAY = 86_400_000;
/** The device clock's reading at the moment the cached response landed. Arbitrary, and fixed. */
const RECEIPT = Date.UTC(2026, 8, 15, 7, 40, 12, 345);

function entry(options: {
  /** The server's calendar day at the last successful sync. */
  syncedOn: string;
  endDate: string;
  startDate?: string;
  state?: LifecycleState;
}): CachedSchedule {
  const envelope = {
    conference: {
      id: 'kickoff',
      name: 'Kickoff 2026',
      startDate: options.startDate ?? options.endDate,
      endDate: options.endDate,
      state: options.state ?? 'published',
      lastUpdatedAt: `${options.syncedOn}T08:00:00.000000Z`,
    },
    days: [{ date: options.endDate, dayNumber: 1, sessions: [] }],
    serverNow: {
      instant: `${options.syncedOn}T07:40:12.345678Z`,
      day: options.syncedOn,
      time: '09:40',
    },
  } as unknown as AttendeeSchedule;

  return { envelope, watermark: envelope.conference.lastUpdatedAt, deviceClockAtReceipt: RECEIPT };
}

/** The device clock, `days` after the entry was written – the only thing that moves "now". */
function daysLater(days: number): () => number {
  return () => RECEIPT + days * DAY;
}

describe('the ratified margin', () => {
  it('is seven days, the number the session lifetime is bound by too', () => {
    // Co-owned with `docs/specs/shared-device-session-lifetime/`. If this changes, that changes.
    expect(READABILITY_MARGIN_DAYS).toBe(7);
  });
});

describe('a conference still running', () => {
  it('is readable inside its span', () => {
    // Kickoff 2026 runs 15–18 September; synced on the 15th, read on the 16th.
    const kickoff = entry({
      syncedOn: '2026-09-15',
      startDate: '2026-09-15',
      endDate: '2026-09-18',
    });
    expect(withinReadabilityWindow(kickoff, daysLater(1))).toBe(true);
  });

  it('is readable on its final day', () => {
    const kickoff = entry({
      syncedOn: '2026-09-15',
      startDate: '2026-09-15',
      endDate: '2026-09-18',
    });
    expect(withinReadabilityWindow(kickoff, daysLater(3))).toBe(true);
  });
});

describe('a conference that has ended', () => {
  const ended = entry({ syncedOn: '2026-09-18', endDate: '2026-09-18' });

  it('stays readable through the margin', () => {
    expect(withinReadabilityWindow(ended, daysLater(6))).toBe(true);
  });

  /** The boundary belongs to the attendee: the seventh day is still hers. */
  it('is readable on the margin day itself', () => {
    expect(withinReadabilityWindow(ended, daysLater(READABILITY_MARGIN_DAYS))).toBe(true);
  });

  it('is withheld the day after the margin', () => {
    expect(withinReadabilityWindow(ended, daysLater(READABILITY_MARGIN_DAYS + 1))).toBe(false);
  });

  /**
   * Acceptance Scenario S02 – "Autumn Offsite" ended on 2025-10-03 and it is 2026-09-16. This is
   * the case the window exists for: a departed employee's device that never reconnects, and so
   * never learns that anything about her access has changed.
   */
  it('is withheld a year later, with no reconnect ever having happened', () => {
    const offsite = entry({ syncedOn: '2025-10-03', endDate: '2025-10-03' });
    expect(withinReadabilityWindow(offsite, daysLater(348))).toBe(false);
  });
});

describe('an archived conference', () => {
  /**
   * Dates only – the predicate never reads `lifecycleState`. Archiving is an organizer's filing
   * decision and says nothing about who may read what offline (clarification → Decisions Log).
   */
  it('lapses on exactly the same rule as a published one', () => {
    const archived = entry({ syncedOn: '2026-09-18', endDate: '2026-09-18', state: 'archived' });
    const published = entry({ syncedOn: '2026-09-18', endDate: '2026-09-18' });

    expect(withinReadabilityWindow(archived, daysLater(2))).toBe(true);
    expect(withinReadabilityWindow(published, daysLater(2))).toBe(true);

    expect(withinReadabilityWindow(archived, daysLater(READABILITY_MARGIN_DAYS + 1))).toBe(false);
    expect(withinReadabilityWindow(published, daysLater(READABILITY_MARGIN_DAYS + 1))).toBe(false);
  });
});

describe('an entry whose window cannot be established', () => {
  /**
   * Storage outlives code and `apiRequest` casts its response body without validating it, so a
   * malformed `endDate` or `serverNow` can be written by one build and read by the next. It fails
   * closed: an entry whose exposure cannot be bounded is not rendered.
   */
  it('is withheld rather than throwing', () => {
    const noEndDate = entry({ syncedOn: '2026-09-18', endDate: '2026-09-18' });
    (noEndDate.envelope.conference as { endDate: unknown }).endDate = undefined;
    expect(withinReadabilityWindow(noEndDate, daysLater(0))).toBe(false);

    const badAnchor = entry({ syncedOn: '2026-09-18', endDate: '2026-09-18' });
    (badAnchor.envelope.serverNow as { instant: unknown }).instant = 'not-an-instant';
    expect(withinReadabilityWindow(badAnchor, daysLater(0))).toBe(false);
  });
});

describe('a device whose own clock is wrong', () => {
  /**
   * The correction that makes the window a statement about the *event* rather than about the
   * phone. A device set a year forward at the time of the sync is absorbed entirely by the anchor's
   * offset, so it neither expires an entry early nor extends one.
   */
  it('does not shorten or lengthen the window', () => {
    const wrongAtSync: CachedSchedule = {
      ...entry({ syncedOn: '2026-09-18', endDate: '2026-09-18' }),
      // The device believed it was a year later when the response landed.
      deviceClockAtReceipt: RECEIPT + 365 * DAY,
    };

    // Two days of real time later, by that same wrong clock. Still inside the margin.
    expect(withinReadabilityWindow(wrongAtSync, () => RECEIPT + 367 * DAY)).toBe(true);
    expect(withinReadabilityWindow(wrongAtSync, () => RECEIPT + (365 + 8) * DAY)).toBe(false);
  });

  /**
   * Review 2026-08-25, H-4 / N-6 – **the predicate has no memory of a reading it has already seen.**
   *
   * This is what makes OC02's bound advisory against a hostile device, and it is a property of the
   * *function*, not of any particular clock value: the answer depends only on the reading handed in
   * at the moment of the call, so a later call with an earlier reading is answered as though the
   * earlier reading were the present. Nothing in `entry` or in the module records that day 372 was
   * ever observed.
   *
   * Stated this way rather than as "a rollback returns `true`", which would be indistinguishable
   * from an ordinary read at sync time and would prove nothing. A monotonic high-water mark would
   * be persisted in the cache entry, so it is *this* assertion – no memory across calls – that
   * such a change would falsify.
   */
  it('answers from the reading handed in, carrying no memory of a later one', () => {
    const ended = entry({ syncedOn: '2026-09-18', endDate: '2026-09-18' });
    const clock = daysLater(372);

    expect(withinReadabilityWindow(ended, clock)).toBe(false);
    // The same entry object, after that observation, answered purely from the new reading.
    expect(withinReadabilityWindow(ended, daysLater(0))).toBe(true);
    // And the entry itself was not marked by having been seen past its window.
    expect(ended.deviceClockAtReceipt).toBe(RECEIPT);
    expect(Object.keys(ended).sort()).toEqual(['deviceClockAtReceipt', 'envelope', 'watermark']);
  });
});

// ---------- ADR-005: the second horizon, measured from the last sync ----------

describe('the horizon measured from the last successful sync', () => {
  it('is thirty days, and is deliberately not the conference margin', () => {
    // Two different questions – "how long since the event ended" and "how long since this device
    // was last shown to be entitled to it". Collapsing them breaks S10 OC01; see below.
    expect(SYNC_MARGIN_DAYS).toBe(30);
    expect(SYNC_MARGIN_DAYS).not.toBe(READABILITY_MARGIN_DAYS);
  });

  /**
   * The case the horizon exists for. A conference published eleven months out, cached the day it
   * was published, on a device that never speaks to the API again.
   */
  it('withholds a conference far in the future once the sync is stale', () => {
    const distant = entry({
      syncedOn: '2026-09-15',
      startDate: '2027-08-18',
      endDate: '2027-08-20',
    });

    // Inside the sync horizon, the conference is readable even though it has not started.
    expect(withinReadabilityWindow(distant, daysLater(25))).toBe(true);
    // Past it, withheld – even though `endDate + 7` is still eleven months away.
    expect(withinReadabilityWindow(distant, daysLater(40))).toBe(false);
  });

  /**
   * **S10 OC01, "joining online is enough", is why this margin is thirty and not seven.**
   *
   * Joining primes the cache; the attendee may never open the app online again before travelling.
   * A seven-day sync horizon would expire that primed entry before the conference it was primed
   * for even began, which is the guarantee the offline feature exists to provide.
   */
  it('leaves an ordinary early joiner alone', () => {
    const joinedEarly = entry({
      syncedOn: '2026-09-15',
      startDate: '2026-10-10',
      endDate: '2026-10-12',
    });

    // Joined 25 days before the conference, still offline: readable.
    expect(withinReadabilityWindow(joinedEarly, daysLater(25))).toBe(true);
    // The accepted cost: joined more than the sync margin ahead and never back online.
    expect(withinReadabilityWindow(joinedEarly, daysLater(35))).toBe(false);
  });

  it('still lets the conference horizon close first when it is the earlier one', () => {
    // Synced on the last day; the conference margin (7d) expires long before the sync margin (30d).
    const ended = entry({ syncedOn: '2026-09-18', endDate: '2026-09-18' });
    expect(withinReadabilityWindow(ended, daysLater(READABILITY_MARGIN_DAYS))).toBe(true);
    expect(withinReadabilityWindow(ended, daysLater(READABILITY_MARGIN_DAYS + 1))).toBe(false);
  });
});

// ---------- SEC-14: the documented fail-closed is now total ----------

describe('an entry whose day values are not comparable', () => {
  /**
   * Review 2026-08-26, SEC-14. `today <= horizon` is a lexicographic compare, which orders
   * chronologically only for four-digit zero-padded years. `civilFromDays` has no domain guard, so
   * a corrupt receipt reading yields '0NaN-NaN-NaN', '10000-01-01' or a negative year — and every
   * one of those sorts *before* a real date, i.e. answered **readable** for an entry whose window
   * could not be established.
   *
   * The `catch` only ever covered inputs that throw. These do not throw; they failed open. That was
   * a disclosure bug while the window merely gated rendering, and would be a data-destruction bug
   * now that a closed window evicts the entry — which is why this is fixed before eviction is
   * wired, not after.
   */
  it('is withheld rather than silently readable for a NaN receipt reading', () => {
    const lapsed = entry({ syncedOn: '2025-10-03', endDate: '2025-10-03' });
    const corrupt = { ...lapsed, deviceClockAtReceipt: Number.NaN };

    expect(withinReadabilityWindow(corrupt, daysLater(0))).toBe(false);
  });

  it('is withheld for effective days outside the four-digit-year range', () => {
    const lapsed = entry({ syncedOn: '2025-10-03', endDate: '2025-10-03' });

    // A receipt reading far in the future drives the effective day negative.
    const farFuture = { ...lapsed, deviceClockAtReceipt: RECEIPT + 1e15 };
    expect(withinReadabilityWindow(farFuture, () => RECEIPT)).toBe(false);

    // And one far in the past drives it past year 9999.
    const farPast = { ...lapsed, deviceClockAtReceipt: RECEIPT - 1e15 };
    expect(withinReadabilityWindow(farPast, () => RECEIPT)).toBe(false);
  });
});
