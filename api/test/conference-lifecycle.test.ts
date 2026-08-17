import { describe, expect, it } from 'vitest';
import { AppError } from '../src/errors.ts';
import {
  addDays,
  compareDates,
  daySpan,
  isCalendarDate,
  systemClock,
} from '../src/conferences/calendar-date.ts';
import {
  LIFECYCLE_STATES,
  assertArchivable,
  assertEditable,
  assertPublishable,
  assertTransitionPermitted,
  earliestArchiveDate,
  isEditable,
  isJoinable,
  isTransitionPermitted,
  type LifecycleState,
} from '../src/conferences/lifecycle.ts';

/**
 * TI02 and TI10 – the lifecycle module is the single authority on legal transitions, on
 * editability and on joinability.
 *
 * These run as pure functions against stated states and dates. That is the point: the rules are
 * decidable without a database, so a handler cannot be the place one of them gets re-derived.
 */

const conference = (
  lifecycleState: LifecycleState,
  endDate = '2026-09-16',
): { lifecycleState: LifecycleState; endDate: string } => ({ lifecycleState, endDate });

function refusalFrom(act: () => void): AppError {
  try {
    act();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('Expected the call to be refused, but it was permitted.');
}

describe('conference lifecycle transitions', () => {
  const PERMITTED: readonly [LifecycleState, LifecycleState][] = [
    ['draft', 'published'],
    ['published', 'archived'],
  ];

  it('permits exactly draft to published and published to archived', () => {
    for (const [from, to] of PERMITTED) {
      expect(isTransitionPermitted(from, to)).toBe(true);
      expect(() => assertTransitionPermitted(from, to)).not.toThrow();
    }
  });

  /**
   * Every pair the machine does not permit, enumerated rather than sampled – including each
   * state to itself. A hand-picked list is how "published → published" quietly becomes legal.
   */
  it('refuses every other pair, naming the current and the requested state', () => {
    const permitted = new Set(PERMITTED.map(([from, to]) => `${from}->${to}`));

    for (const from of LIFECYCLE_STATES) {
      for (const to of LIFECYCLE_STATES) {
        if (permitted.has(`${from}->${to}`)) continue;

        expect(isTransitionPermitted(from, to)).toBe(false);
        const refusal = refusalFrom(() => assertTransitionPermitted(from, to));

        expect(refusal.code).toBe('CONFERENCE_TRANSITION_NOT_PERMITTED');
        // Both states named: "not allowed" alone leaves an organizer nothing to act on.
        expect(refusal.message).toContain(from);
        expect(refusal.message).toContain(to);
      }
    }
  });

  it('never allows a return to draft, from either later state', () => {
    expect(isTransitionPermitted('published', 'draft')).toBe(false);
    expect(isTransitionPermitted('archived', 'draft')).toBe(false);
  });

  it('treats archived as terminal – no transition leaves it', () => {
    for (const to of LIFECYCLE_STATES) {
      expect(isTransitionPermitted('archived', to)).toBe(false);
    }
  });
});

describe('the editability guard', () => {
  it('reports a draft and a published conference editable', () => {
    expect(isEditable(conference('draft'))).toBe(true);
    expect(isEditable(conference('published'))).toBe(true);
  });

  it('reports an archived conference not editable, and refuses naming the archived state', () => {
    expect(isEditable(conference('archived'))).toBe(false);

    const refusal = refusalFrom(() => assertEditable(conference('archived')));
    expect(refusal.code).toBe('CONFERENCE_NOT_EDITABLE');
    expect(refusal.message).toContain('archived');
  });
});

describe('the joinability guard', () => {
  /**
   * The whole invariant, in one predicate: state AND end date. The second half is the one that
   * gets forgotten – a conference still marked published but finished yesterday is closed,
   * whether or not anyone has archived it.
   */
  it('reports joinable only for a published conference within its span', () => {
    expect(isJoinable(conference('published', '2026-09-16'), '2026-09-14')).toBe(true);
    // Still joinable on the final day itself.
    expect(isJoinable(conference('published', '2026-09-16'), '2026-09-16')).toBe(true);
  });

  it('reports a published conference past its end date not joinable, with no archive step', () => {
    expect(isJoinable(conference('published', '2026-09-16'), '2026-09-17')).toBe(false);
  });

  it('reports a draft and an archived conference not joinable', () => {
    expect(isJoinable(conference('draft', '2026-09-16'), '2026-09-14')).toBe(false);
    expect(isJoinable(conference('archived', '2026-09-16'), '2026-09-14')).toBe(false);
  });

  /**
   * The joinable and archivable windows are complements with no overlap and no gap: the last
   * joinable day is the day before the first archivable one.
   */
  it('closes joining on exactly the day archiving opens', () => {
    const published = conference('published', '2026-09-16');
    const earliest = earliestArchiveDate(published);

    expect(earliest).toBe('2026-09-17');
    expect(isJoinable(published, addDays(earliest, -1))).toBe(true);
    expect(isJoinable(published, earliest)).toBe(false);
  });
});

describe('the archive guard', () => {
  it('refuses on and before the end date, stating the earliest permitted date', () => {
    const published = conference('published', '2026-09-16');

    for (const today of ['2026-09-15', '2026-09-16']) {
      const refusal = refusalFrom(() => assertArchivable(published, today));
      expect(refusal.code).toBe('CONFERENCE_ARCHIVE_TOO_EARLY');
      expect(refusal.message).toContain('2026-09-17');
    }
  });

  it('permits archiving the day after the end date', () => {
    expect(() =>
      assertArchivable(conference('published', '2026-09-16'), '2026-09-17'),
    ).not.toThrow();
  });

  /**
   * A draft is refused whatever the date – it never became visible to anyone, so archiving it
   * would produce a record with no join code and no viewers (FR9). The refusal is about the
   * state, not about a date that does not apply.
   */
  it('refuses a draft on any date, as a transition refusal rather than a date one', () => {
    for (const today of ['2026-09-01', '2026-09-17', '2027-01-01']) {
      const refusal = refusalFrom(() => assertArchivable(conference('draft', '2026-09-16'), today));
      expect(refusal.code).toBe('CONFERENCE_TRANSITION_NOT_PERMITTED');
    }
  });

  it('refuses an already-archived conference', () => {
    const refusal = refusalFrom(() =>
      assertArchivable(conference('archived', '2026-09-16'), '2026-09-30'),
    );
    expect(refusal.code).toBe('CONFERENCE_TRANSITION_NOT_PERMITTED');
  });
});

describe('the publish guard', () => {
  it('refuses a draft with no session, explaining that a session is required', () => {
    const refusal = refusalFrom(() => assertPublishable(conference('draft'), false));
    expect(refusal.code).toBe('CONFERENCE_SCHEDULE_REQUIRED');
    expect(refusal.message).toMatch(/session/i);
  });

  it('permits a draft once the schedule gate reports a session', () => {
    expect(() => assertPublishable(conference('draft'), true)).not.toThrow();
  });

  /** A session count cannot rescue an illegal transition – the state is checked first. */
  it('still refuses a published conference even when the gate reports a session', () => {
    const refusal = refusalFrom(() => assertPublishable(conference('published'), true));
    expect(refusal.code).toBe('CONFERENCE_TRANSITION_NOT_PERMITTED');
  });
});

/**
 * TI01's testing-strategy note – the naive frame is asserted directly, because a day-boundary
 * shift is invisible until it is in front of somebody.
 */
describe('naive calendar dates', () => {
  it('accepts real dates and rejects well-formed impossible ones', () => {
    expect(isCalendarDate('2026-09-14')).toBe(true);
    expect(isCalendarDate('2028-02-29')).toBe(true);

    expect(isCalendarDate('2026-02-30')).toBe(false);
    expect(isCalendarDate('2026-13-01')).toBe(false);
    expect(isCalendarDate('2026-9-14')).toBe(false);
    expect(isCalendarDate('14/09/2026')).toBe(false);
    expect(isCalendarDate('2026-09-14T00:00:00Z')).toBe(false);
    expect(isCalendarDate(20260914)).toBe(false);
  });

  it('counts an inclusive span, so a single-day conference spans one day', () => {
    expect(daySpan('2026-09-14', '2026-09-14')).toBe(1);
    expect(daySpan('2026-09-14', '2026-09-17')).toBe(4);
    expect(daySpan('2026-09-14', '2026-09-18')).toBe(5);
    // Across a month and a leap day, where naive arithmetic on day numbers would be wrong.
    expect(daySpan('2026-08-31', '2026-09-01')).toBe(2);
    expect(daySpan('2028-02-28', '2028-03-01')).toBe(3);
  });

  it('adds days across month and year boundaries', () => {
    expect(addDays('2026-09-16', 1)).toBe('2026-09-17');
    expect(addDays('2026-08-31', 1)).toBe('2026-09-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('orders dates chronologically', () => {
    expect(compareDates('2026-09-14', '2026-09-16')).toBeLessThan(0);
    expect(compareDates('2026-09-16', '2026-09-14')).toBeGreaterThan(0);
    expect(compareDates('2026-09-14', '2026-09-14')).toBe(0);
  });

  /**
   * The server's own calendar date, not a UTC instant formatted after the fact. Asserted against
   * the local components directly, so a machine running east or west of UTC still agrees.
   */
  it('reads today as the server wall-clock calendar date', () => {
    const now = new Date();
    const expected = [
      String(now.getFullYear()).padStart(4, '0'),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
    ].join('-');

    expect(systemClock.today()).toBe(expected);
    expect(isCalendarDate(systemClock.today())).toBe(true);
  });
});
