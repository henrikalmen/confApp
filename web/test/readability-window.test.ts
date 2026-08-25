import { describe, expect, it } from 'vitest';
import {
  READABILITY_MARGIN_DAYS,
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
});
