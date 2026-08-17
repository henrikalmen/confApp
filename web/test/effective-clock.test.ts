import { describe, expect, it } from 'vitest';
import {
  clockFromSync,
  instantToMillis,
  rehydrateClock,
  wallClockPlusMillis,
  type ClockAnchor,
  type ServerNow,
} from '../src/clock/effective-clock.ts';

/**
 * TI05 – the corrected clock.
 *
 * The device clock is **injected**, never mocked at a formatter. That is the whole design of these
 * tests: an implementation that read the raw device clock would still call whatever formatter a
 * mock was attached to, so a formatter assertion proves nothing. Handing the module a clock that is
 * genuinely three hours out and asserting the wall clock it reports is the only thing that
 * distinguishes a corrected clock from an uncorrected one.
 */

/** The server is at 09:40 on 2026-09-15; the instant is the same moment in UTC. */
const SERVER_NOW: ServerNow = {
  instant: '2026-09-15T07:40:12.345678Z',
  day: '2026-09-15',
  time: '09:40',
};

const SYNC_INSTANT_MILLIS = Date.UTC(2026, 8, 15, 7, 40, 12, 345);
const THREE_HOURS = 3 * 60 * 60 * 1000;

/** A device clock the test moves by hand, so "elapsed" is a stated number rather than real time. */
function movableClock(start: number): { read: () => number; advance: (millis: number) => void } {
  let value = start;
  return {
    read: () => value,
    advance: (millis: number) => {
      value += millis;
    },
  };
}

describe('reading an instant', () => {
  it('parses a microsecond-precision instant to milliseconds, discarding the rest', () => {
    expect(instantToMillis('2026-09-15T07:40:12.345678Z')).toBe(SYNC_INSTANT_MILLIS);
  });

  it('reads a shorter fraction by position, not by digit count', () => {
    // '.5' is half a second, not five milliseconds. Slicing a shorter string would say 5.
    expect(instantToMillis('2026-09-15T07:40:12.5Z')).toBe(Date.UTC(2026, 8, 15, 7, 40, 12, 500));
    expect(instantToMillis('2026-09-15T07:40:12Z')).toBe(Date.UTC(2026, 8, 15, 7, 40, 12, 0));
  });

  it('refuses a value that is not an instant rather than guessing one', () => {
    expect(() => instantToMillis('2026-09-15 07:40')).toThrow(/expected form/);
  });
});

describe('advancing a naive wall clock', () => {
  it('adds elapsed time without touching the day', () => {
    expect(wallClockPlusMillis('2026-09-15', '09:40', 20 * 60_000)).toEqual({
      day: '2026-09-15',
      time: '10:00',
    });
  });

  it('rolls forward over midnight', () => {
    expect(wallClockPlusMillis('2026-09-15', '23:50', 20 * 60_000)).toEqual({
      day: '2026-09-16',
      time: '00:10',
    });
  });

  /** A device clock that went *backwards* after sync must roll into the previous day, not to zero. */
  it('rolls backward over midnight', () => {
    expect(wallClockPlusMillis('2026-09-16', '00:10', -20 * 60_000)).toEqual({
      day: '2026-09-15',
      time: '23:50',
    });
  });

  it('crosses a month, a year and a leap day correctly', () => {
    expect(wallClockPlusMillis('2026-09-30', '23:00', 2 * 3_600_000).day).toBe('2026-10-01');
    expect(wallClockPlusMillis('2026-12-31', '23:00', 2 * 3_600_000).day).toBe('2027-01-01');
    expect(wallClockPlusMillis('2028-02-28', '23:00', 2 * 3_600_000).day).toBe('2028-02-29');
  });
});

// ---------- Acceptance Scenario S05 ----------

describe('a device clock three hours fast', () => {
  it('reports the server wall clock, advanced only by elapsed time', () => {
    const device = movableClock(SYNC_INSTANT_MILLIS + THREE_HOURS);
    const clock = clockFromSync(SERVER_NOW, device.read(), device.read);

    // At the moment of sync: the server's own wall clock, not the device's idea of it.
    expect(clock.effectiveWallClockNow()).toEqual({ day: '2026-09-15', time: '09:40' });

    device.advance(20 * 60_000);
    expect(clock.effectiveWallClockNow()).toEqual({ day: '2026-09-15', time: '10:00' });
  });

  it('derives an offset that names the skew', () => {
    const device = movableClock(SYNC_INSTANT_MILLIS + THREE_HOURS);
    const clock = clockFromSync(SERVER_NOW, device.read(), device.read);

    // The device is ahead, so the server instant is behind it: a negative correction.
    expect(clock.offsetMillis()).toBe(-THREE_HOURS);
  });

  /**
   * The accepted failure mode, asserted so it stays the accepted one: a jump *after* sync skews
   * elapsed time and may move the highlight. What it may never do is alter a displayed time, and
   * that is guaranteed structurally – this module returns no Session time at all.
   */
  it('lets a jump after sync skew elapsed time, which is the recorded trade', () => {
    const device = movableClock(SYNC_INSTANT_MILLIS);
    const clock = clockFromSync(SERVER_NOW, device.read(), device.read);

    device.advance(THREE_HOURS);
    expect(clock.effectiveWallClockNow()).toEqual({ day: '2026-09-15', time: '12:40' });
  });

  it('absorbs a device clock that is behind just as it absorbs one ahead', () => {
    const device = movableClock(SYNC_INSTANT_MILLIS - THREE_HOURS);
    const clock = clockFromSync(SERVER_NOW, device.read(), device.read);

    expect(clock.offsetMillis()).toBe(THREE_HOURS);
    expect(clock.effectiveWallClockNow()).toEqual({ day: '2026-09-15', time: '09:40' });
  });
});

// ---------- the contract this leaves on S10 ----------

describe('the anchor S10 persists', () => {
  it('is four plain scalars and nothing else', () => {
    const clock = clockFromSync(SERVER_NOW, SYNC_INSTANT_MILLIS + THREE_HOURS);

    expect(Object.keys(clock.anchor).sort()).toEqual([
      'deviceClockAtReceipt',
      'serverNowDay',
      'serverNowInstant',
      'serverNowTime',
    ]);
    for (const value of Object.values(clock.anchor)) {
      expect(['string', 'number']).toContain(typeof value);
    }
  });

  /**
   * The scenario S10 must survive: force-quit, relaunch offline. The rehydrated module performs no
   * fetch – there is nothing in this test that could serve one – and must agree with the original
   * for the same device clock reading, including a skewed one.
   */
  it('survives a JSON round trip and rehydrates into an equivalent clock with no fetch', () => {
    const deviceAtReceipt = SYNC_INSTANT_MILLIS + THREE_HOURS;
    const original = clockFromSync(SERVER_NOW, deviceAtReceipt);

    const stored = JSON.parse(JSON.stringify(original.anchor)) as ClockAnchor;
    expect(stored).toEqual(original.anchor);

    // A device clock still +3h skewed, and forty minutes further on than the sync.
    const later = deviceAtReceipt + 40 * 60_000;
    const rehydrated = rehydrateClock(stored, () => later);

    expect(rehydrated.effectiveWallClockNow()).toEqual({ day: '2026-09-15', time: '10:20' });
    expect(rehydrated.effectiveWallClockNow()).toEqual(
      rehydrateClock(original.anchor, () => later).effectiveWallClockNow(),
    );
    expect(rehydrated.offsetMillis()).toBe(original.offsetMillis());
  });

  /** Dropping `deviceClockAtReceipt` is the specific way S10 could silently break the offset. */
  it('cannot rehydrate a corrected clock from a partial anchor', () => {
    const { serverNowDay, serverNowTime, serverNowInstant } = clockFromSync(
      SERVER_NOW,
      SYNC_INSTANT_MILLIS,
    ).anchor;

    const partial = { serverNowDay, serverNowTime, serverNowInstant } as unknown as ClockAnchor;
    const clock = rehydrateClock(partial, () => SYNC_INSTANT_MILLIS + THREE_HOURS);

    // With no receipt reading the "elapsed" term is meaningless, and the result is visibly wrong
    // rather than plausibly wrong – which is what makes the omission catchable at all.
    expect(clock.effectiveWallClockNow()).not.toEqual({ day: '2026-09-15', time: '09:40' });
  });
});
