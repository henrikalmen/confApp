import { describe, expect, it } from 'vitest';
import { withinSessionBound } from '../src/auth/session-bound.ts';
import {
  READABILITY_MARGIN_DAYS,
  withinReadabilityWindow,
} from '../src/offline/readability-window.ts';
import type { CachedSchedule } from '../src/offline/schedule-cache.ts';
import type { StoredSession } from '../src/auth/session.ts';
import type { AttendeeSchedule } from '../src/api/client.ts';

/**
 * TI02, TI04 and TI07 – how long a stored session lives, and the one relationship it must keep with
 * the offline readability window.
 *
 * Driven the same way `readability-window.test.ts` drives its predicate: the device clock is moved
 * forward from a fixed receipt reading rather than a "today" being stubbed, because the conference
 * term is evaluated on the entry's rehydrated effective clock and a stubbed today would test
 * arithmetic the production path never performs.
 */

const DAY = 86_400_000;
/** The device clock's reading when the cached response landed, and when the sign-in happened. */
const RECEIPT = Date.UTC(2026, 8, 15, 7, 40, 12, 345);

function entry(options: { syncedOn: string; endDate: string }): CachedSchedule {
  const envelope = {
    conference: {
      id: `conf-${options.endDate}`,
      name: `Conference ending ${options.endDate}`,
      startDate: options.endDate,
      endDate: options.endDate,
      state: 'published',
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

function session(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    idToken: 'id-token',
    // Long expired, on purpose: every case here must hold with a stale token, because token expiry
    // is not a session lifetime and conflating them is the rejected design.
    expiresAt: 1,
    user: { sub: 'google-sub-nadia', email: 'nadia@ourcompany.example', displayName: 'Nadia' },
    signedInAt: RECEIPT,
    ...overrides,
  };
}

/** The device clock, `days` after the receipt reading – the only thing that moves "now". */
function daysLater(days: number): () => number {
  return () => RECEIPT + days * DAY;
}

describe('the conference term', () => {
  it('keeps a session alive through the conference and the margin that follows it', () => {
    // "Kickoff 2026" ends on the 18th; the margin is 7 days, so the 25th is still inside it.
    const kickoff = entry({ syncedOn: '2026-09-15', endDate: '2026-09-18' });

    expect(withinSessionBound(session(), [kickoff], daysLater(10))).toBe(true);
  });

  it('ends the session once the last conference has been over for longer than the margin', () => {
    const kickoff = entry({ syncedOn: '2026-09-15', endDate: '2026-09-18' });

    // The 26th: eleven days on from the 15th, and eight past the conference's last day.
    expect(withinSessionBound(session(), [kickoff], daysLater(11))).toBe(false);
  });

  it('takes the later of two joined conferences, so an ended one never shortens the bound', () => {
    const ended = entry({ syncedOn: '2026-09-15', endDate: '2025-10-03' });
    const current = entry({ syncedOn: '2026-09-15', endDate: '2026-09-18' });

    // Order must not matter: the rule is "latest of", not "first found".
    expect(withinSessionBound(session(), [ended, current], daysLater(5))).toBe(true);
    expect(withinSessionBound(session(), [current, ended], daysLater(5))).toBe(true);
  });

  it('outlives the sign-in term, so a long conference does not expire mid-event', () => {
    // Signed in on the receipt day, conference running well past sign-in + 7 days.
    const long = entry({ syncedOn: '2026-09-15', endDate: '2026-10-30' });

    // Day 20 is past sign-in + 7, and the session stands entirely on the conference term.
    expect(withinSessionBound(session(), [long], daysLater(20))).toBe(true);
  });
});

describe('the sign-in term', () => {
  it('bounds somebody who has joined no conference', () => {
    expect(withinSessionBound(session(), [], daysLater(5))).toBe(true);
    expect(withinSessionBound(session(), [], daysLater(8))).toBe(false);
  });

  it('is exactly the margin the readability window uses', () => {
    // The boundary itself is inside the bound; a millisecond past it is not.
    const atBoundary = () => RECEIPT + READABILITY_MARGIN_DAYS * DAY;
    const justPast = () => RECEIPT + READABILITY_MARGIN_DAYS * DAY + 1;

    expect(withinSessionBound(session(), [], atBoundary)).toBe(true);
    expect(withinSessionBound(session(), [], justPast)).toBe(false);
  });

  it('catches an attendee who left every conference they had joined', () => {
    // Nothing cached any more, and the sign-in is old: the fallback is what ends this session.
    expect(withinSessionBound(session(), [], daysLater(30))).toBe(false);
  });
});

describe('token expiry is not a session lifetime', () => {
  /**
   * The rejected design, asserted directly because it is the intuitive thing to implement by
   * mistake and it breaks S02 OC01 – an attendee signed out roughly hourly, all conference.
   */
  it('ignores expiresAt entirely, however long ago the token lapsed', () => {
    const kickoff = entry({ syncedOn: '2026-09-15', endDate: '2026-09-18' });
    const stale = session({ expiresAt: 1 });
    const future = session({ expiresAt: 4_000_000_000 });

    expect(withinSessionBound(stale, [kickoff], daysLater(2))).toBe(true);
    // And moving expiry does not move the bound in either direction.
    expect(withinSessionBound(stale, [kickoff], daysLater(2))).toBe(
      withinSessionBound(future, [kickoff], daysLater(2)),
    );
    expect(withinSessionBound(stale, [], daysLater(30))).toBe(
      withinSessionBound(future, [], daysLater(30)),
    );
  });
});

describe('inputs that cannot be trusted', () => {
  /**
   * TI04. The clarification's Error Handling table is explicit that the bound never silently
   * becomes unbounded when data is missing – so every one of these must resolve to a *shorter*
   * life, never a longer one.
   */
  it('does not let a malformed conference date extend the bound', () => {
    const broken = entry({ syncedOn: '2026-09-15', endDate: 'not-a-date' });

    // Falls through to the sign-in term rather than answering "still inside some horizon".
    expect(withinSessionBound(session(), [broken], daysLater(5))).toBe(true);
    expect(withinSessionBound(session(), [broken], daysLater(8))).toBe(false);
  });

  it('does not let a corrupt receipt reading extend the bound', () => {
    const broken = { ...entry({ syncedOn: '2026-09-15', endDate: '2026-09-18' }) };
    broken.deviceClockAtReceipt = Number.NaN;

    // A NaN receipt yields the day string '0NaN-NaN-NaN', which sorts before every real date and
    // would answer "inside the horizon" without the shape check.
    expect(withinSessionBound(session(), [broken], daysLater(8))).toBe(false);
  });

  it('treats a session carrying no sign-in reading as expired, not as forever', () => {
    const noReading = { ...session() } as StoredSession & { signedInAt?: number };
    delete noReading.signedInAt;

    expect(withinSessionBound(noReading as StoredSession, [], daysLater(0))).toBe(false);
  });

  it('treats a non-finite sign-in reading as expired', () => {
    expect(withinSessionBound(session({ signedInAt: Number.NaN }), [], daysLater(0))).toBe(false);
    expect(withinSessionBound(session({ signedInAt: Infinity }), [], daysLater(0))).toBe(false);
  });

  it('never answers true for an entry it cannot read at all', () => {
    const rubbish = { envelope: null, watermark: null, deviceClockAtReceipt: RECEIPT };

    expect(
      withinSessionBound(session({ signedInAt: 0 }), [rubbish as unknown as CachedSchedule], () =>
        Date.now(),
      ),
    ).toBe(false);
  });
});

describe('a cached schedule can never outlive the session it was read under', () => {
  /**
   * TI07, and the reason `session-bound.ts` calls `withinConferenceHorizon` rather than restating
   * the arithmetic. Readability is that predicate **and** the sync horizon, so anything readable
   * satisfies it, and anything satisfying it holds the session open.
   *
   * A matrix rather than a scenario: what this guards is a relationship between two constants and
   * two predicates, and it must fail if a later edit moves either horizon independently.
   */
  it('holds across every combination of end date, sync date and sign-in age', () => {
    const days = [-400, -40, -8, -7, -1, 0, 1, 7, 40, 400];
    const dayString = (offsetFromReceipt: number): string =>
      new Date(RECEIPT + offsetFromReceipt * DAY).toISOString().slice(0, 10);

    let readableCases = 0;

    for (const endOffset of days) {
      for (const syncOffset of days) {
        for (const elapsed of [0, 1, 7, 8, 30, 31, 400]) {
          const candidate = entry({
            syncedOn: dayString(syncOffset),
            endDate: dayString(endOffset),
          });
          const clock = daysLater(elapsed);

          if (!withinReadabilityWindow(candidate, clock)) continue;
          readableCases += 1;

          expect(
            withinSessionBound(session({ signedInAt: RECEIPT }), [candidate], clock),
            `readable at end=${endOffset} sync=${syncOffset} elapsed=${elapsed} but session expired`,
          ).toBe(true);
        }
      }
    }

    // The implication is vacuous if nothing was ever readable – pin that the matrix has substance.
    expect(readableCases).toBeGreaterThan(0);
  });
});
