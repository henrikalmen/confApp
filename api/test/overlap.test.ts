import { describe, expect, it } from 'vitest';
import { overlappingPairs, overlaps, overlapsWith } from '../src/sessions/overlap.ts';

/**
 * TI07 – which Sessions run at the same time as which.
 *
 * The boundary cases are the ones worth pinning: back-to-back Sessions are the ordinary shape of
 * a schedule and flagging them would make the indicator noise, while a one-minute genuine clash
 * has to be caught or the pre-publish overlap review misses it.
 */

const KEYNOTE = { id: 'keynote', day: '2026-09-15', startTime: '09:00', endTime: '10:30' };
const WORKSHOP = { id: 'workshop', day: '2026-09-15', startTime: '10:00', endTime: '11:00' };
/** Starts exactly where the keynote ends – the back-to-back boundary, not a clash. */
const AFTER = { id: 'after', day: '2026-09-15', startTime: '10:30', endTime: '11:30' };
/** Alone in its slot, so a schedule containing it has a session that clashes with nothing. */
const RETROSPECTIVE = { id: 'retro', day: '2026-09-15', startTime: '15:00', endTime: '16:00' };

describe('overlaps', () => {
  it('reports 09:00–10:30 and 10:00–11:00 on one day as overlapping', () => {
    expect(overlaps(KEYNOTE, WORKSHOP)).toBe(true);
    expect(overlaps(WORKSHOP, KEYNOTE)).toBe(true);
  });

  /** Half-open intervals: one ends exactly where the next begins, so they run back to back. */
  it('does not report 09:00–10:00 and 10:00–11:00 as overlapping', () => {
    expect(overlaps({ ...KEYNOTE, endTime: '10:00' }, { ...WORKSHOP, startTime: '10:00' })).toBe(
      false,
    );
    expect(overlaps(KEYNOTE, AFTER)).toBe(false);
  });

  it('catches a one-minute clash', () => {
    expect(overlaps(KEYNOTE, { ...AFTER, startTime: '10:29' })).toBe(true);
  });

  /** The same clock times on different Conference Days are not a Parallel Track. */
  it('never reports two sessions on different days as overlapping', () => {
    expect(overlaps(KEYNOTE, { ...WORKSHOP, day: '2026-09-16' })).toBe(false);
  });

  it('reports a session wholly inside another', () => {
    expect(
      overlaps(KEYNOTE, { id: 'inner', day: '2026-09-15', startTime: '09:15', endTime: '09:45' }),
    ).toBe(true);
  });
});

describe('overlappingPairs', () => {
  it('returns each overlapping pair exactly once, and no self-pairs', () => {
    expect(overlappingPairs([KEYNOTE, WORKSHOP, RETROSPECTIVE])).toEqual([
      { sessionIds: ['keynote', 'workshop'] },
    ]);
  });

  it('returns nothing for a schedule with no clashes', () => {
    expect(overlappingPairs([KEYNOTE, AFTER, RETROSPECTIVE])).toEqual([]);
    expect(overlappingPairs([])).toEqual([]);
    expect(overlappingPairs([KEYNOTE])).toEqual([]);
  });

  it('reports all three pairs when three sessions run at once', () => {
    const a = { id: 'a', day: '2026-09-15', startTime: '09:00', endTime: '12:00' };
    const b = { id: 'b', day: '2026-09-15', startTime: '10:00', endTime: '11:00' };
    const c = { id: 'c', day: '2026-09-15', startTime: '10:30', endTime: '13:00' };

    expect(overlappingPairs([a, b, c])).toEqual([
      { sessionIds: ['a', 'b'] },
      { sessionIds: ['a', 'c'] },
      { sessionIds: ['b', 'c'] },
    ]);
  });
});

describe('overlapsWith', () => {
  it('names the sessions one session runs alongside, excluding itself', () => {
    expect(overlapsWith(KEYNOTE, [KEYNOTE, WORKSHOP, RETROSPECTIVE])).toEqual([WORKSHOP]);
  });

  it('returns nothing when the session is alone in its slot', () => {
    expect(overlapsWith(RETROSPECTIVE, [KEYNOTE, WORKSHOP, RETROSPECTIVE])).toEqual([]);
    // Back to back with the keynote is not a clash either.
    expect(overlapsWith(AFTER, [KEYNOTE, AFTER])).toEqual([]);
  });
});
