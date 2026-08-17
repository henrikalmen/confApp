import { describe, expect, it } from 'vitest';
import { chooseDefaultConference, isRunningOn } from '../src/conferences/attendee-conferences.ts';
import type { AttendeeConference } from '../src/conferences/conference-repository.ts';

/**
 * TI02's default-conference rule, as its own suite.
 *
 * It is pure logic over a list and a date, so it is tested as such rather than only through the
 * endpoint: the integration suite skips itself when no PostgreSQL is reachable, and a rule that
 * decides what an attendee sees when they open the app should not lose all its coverage on a
 * machine without a database. S04 shipped `overlap.test.ts` for comparable pure logic.
 */

function conference(overrides: Partial<AttendeeConference> = {}): AttendeeConference {
  return {
    id: 'kickoff',
    name: 'Kickoff 2026',
    startDate: '2026-09-14',
    endDate: '2026-09-16',
    lifecycleState: 'published',
    joinedAt: '2026-08-01T09:00:00.000Z',
    ...overrides,
  };
}

/** The list arrives ordered by joined_at descending – the repository's ORDER BY. */
const RETRO = conference({
  id: 'retro',
  name: 'Retro 2025',
  startDate: '2025-11-18',
  endDate: '2025-11-20',
  lifecycleState: 'archived',
  joinedAt: '2025-11-01T09:00:00.000Z',
});
const KICKOFF = conference();
const PRODUCT_DAYS = conference({
  id: 'product-days',
  name: 'Product Days',
  startDate: '2026-11-02',
  endDate: '2026-11-03',
  joinedAt: '2026-09-10T09:00:00.000Z',
});

/** Most recently joined first: Product Days, Kickoff, Retro. */
const RAVIS_THREE = [PRODUCT_DAYS, KICKOFF, RETRO];

describe('whether a Conference is running', () => {
  it('includes both endpoints of the span', () => {
    expect(isRunningOn(KICKOFF, '2026-09-14')).toBe(true);
    expect(isRunningOn(KICKOFF, '2026-09-16')).toBe(true);
  });

  it('excludes the day before and the day after', () => {
    expect(isRunningOn(KICKOFF, '2026-09-13')).toBe(false);
    expect(isRunningOn(KICKOFF, '2026-09-17')).toBe(false);
  });

  it('handles a one-day Conference', () => {
    const oneDay = conference({ startDate: '2026-09-15', endDate: '2026-09-15' });
    expect(isRunningOn(oneDay, '2026-09-15')).toBe(true);
    expect(isRunningOn(oneDay, '2026-09-16')).toBe(false);
  });
});

// ---------- Acceptance Scenario S02 ----------

describe('choosing the default Conference', () => {
  it('picks the one running today over more recently joined ones', () => {
    // Product Days was joined later, but Kickoff is the one Ravi is standing in.
    expect(chooseDefaultConference(RAVIS_THREE, '2026-09-15')?.id).toBe('kickoff');
  });

  it('picks the most recently joined when none is running', () => {
    expect(chooseDefaultConference(RAVIS_THREE, '2026-09-20')?.id).toBe('product-days');
  });

  it('picks the most recently joined among several running at once', () => {
    const parallel = conference({
      id: 'parallel',
      startDate: '2026-09-15',
      endDate: '2026-09-15',
      joinedAt: '2026-09-14T09:00:00.000Z',
    });
    // Ordered as the repository would: parallel joined most recently of the running pair.
    expect(
      chooseDefaultConference([PRODUCT_DAYS, parallel, KICKOFF, RETRO], '2026-09-15')?.id,
    ).toBe('parallel');
  });

  it('is content with an archived Conference when it is all there is', () => {
    expect(chooseDefaultConference([RETRO], '2026-09-15')?.id).toBe('retro');
  });

  it('names no default when the caller has joined nothing', () => {
    expect(chooseDefaultConference([], '2026-09-15')).toBeNull();
  });

  /**
   * The rule is decided against the *server's* day. A device in the wrong timezone, or with a wrong
   * clock, must not be shown a different conference than the person is standing in (OC02) – which
   * holds here structurally, because the day is an argument and this module reads no clock at all.
   */
  it('reads no clock of its own', () => {
    expect(chooseDefaultConference(RAVIS_THREE, '2026-09-15')?.id).toBe('kickoff');
    expect(chooseDefaultConference(RAVIS_THREE, '2026-11-02')?.id).toBe('product-days');
  });
});
