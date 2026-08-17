import { describe, expect, it } from 'vitest';
import { AppError } from '../src/errors.ts';
import {
  conferenceDays,
  validateSessionDetails,
  type SessionDetailsInput,
} from '../src/sessions/session-validation.ts';

/**
 * TI04 – the Session field rules, and the sentence an Organizer reads when one is broken.
 *
 * Each assertion checks the *message*, not only the code. FR2's error handling is user-facing
 * prose – "naming the valid days", "rejected inline" – so a refusal that carried the right code
 * and an unhelpful sentence would satisfy the status code and fail the requirement.
 */

const AUTUMN = { name: 'Autumn Offsite', startDate: '2026-09-15', endDate: '2026-09-16' };

const VALID: SessionDetailsInput = {
  title: 'Opening Keynote',
  description: 'How the year went.',
  kind: 'Presentation',
  day: '2026-09-15',
  startTime: '09:00',
  endTime: '10:30',
  location: 'Main Hall',
};

/** Returns the refusal rather than letting it escape, so each case can inspect it. */
function refusalFor(overrides: Partial<SessionDetailsInput>): AppError {
  try {
    validateSessionDetails({ ...VALID, ...overrides }, AUTUMN);
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('Expected the input to be refused, but it was accepted.');
}

describe('conferenceDays', () => {
  /** A Conference Day is derived from the span, never an independently created record. */
  it('derives every day in the span, inclusive of both ends', () => {
    expect(conferenceDays(AUTUMN)).toEqual(['2026-09-15', '2026-09-16']);
    expect(conferenceDays({ startDate: '2026-09-15', endDate: '2026-09-15' })).toEqual([
      '2026-09-15',
    ]);
    expect(conferenceDays({ startDate: '2026-09-29', endDate: '2026-10-02' })).toEqual([
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
    ]);
  });
});

describe('a valid session', () => {
  it('is returned normalised, with the values that should actually be stored', () => {
    expect(
      validateSessionDetails(
        { ...VALID, title: '  Opening Keynote  ', location: ' Main Hall ' },
        AUTUMN,
      ),
    ).toEqual({
      title: 'Opening Keynote',
      description: 'How the year went.',
      kind: 'Presentation',
      day: '2026-09-15',
      startTime: '09:00',
      endTime: '10:30',
      location: 'Main Hall',
    });
  });

  /** "No description" has one representation, not three. */
  it('stores a missing, empty or whitespace description identically as null', () => {
    for (const description of [undefined, null, '', '   ']) {
      expect(validateSessionDetails({ ...VALID, description }, AUTUMN).description).toBeNull();
    }
  });

  it('accepts both session kinds and nothing else', () => {
    expect(validateSessionDetails({ ...VALID, kind: 'Workshop' }, AUTUMN).kind).toBe('Workshop');
    expect(refusalFor({ kind: 'Presentation ' }).code).toBe('SESSION_KIND_INVALID');
  });
});

describe('the title and location rules', () => {
  it('refuses a blank title, naming the field', () => {
    const refusal = refusalFor({ title: '   ' });
    expect(refusal.statusCode).toBe(400);
    expect(refusal.code).toBe('SESSION_TITLE_INVALID');
    expect(refusal.message).toBe('A session title is required.');
    expect(refusal.details).toEqual([{ field: 'title', message: refusal.message }]);
  });

  it('refuses a title over 200 characters, stating the limit and the actual length', () => {
    const refusal = refusalFor({ title: 'x'.repeat(201) });
    expect(refusal.code).toBe('SESSION_TITLE_INVALID');
    expect(refusal.message).toContain('at most 200 characters');
    expect(refusal.message).toContain('201');
  });

  it('accepts a title of exactly 200 characters', () => {
    expect(validateSessionDetails({ ...VALID, title: 'x'.repeat(200) }, AUTUMN).title).toHaveLength(
      200,
    );
  });

  it('refuses a blank location and says it is free text', () => {
    const refusal = refusalFor({ location: '' });
    expect(refusal.code).toBe('SESSION_LOCATION_INVALID');
    expect(refusal.message).toContain('required');
    // Location is free text, not a bookable resource (FR2) – the message says so, because an
    // Organizer faced with a rejected "Room 2" would otherwise go looking for a room registry.
    expect(refusal.message).toContain('Main Hall');
  });

  it('refuses a location over 100 characters, stating the limit', () => {
    const refusal = refusalFor({ location: 'x'.repeat(101) });
    expect(refusal.code).toBe('SESSION_LOCATION_INVALID');
    expect(refusal.message).toContain('at most 100 characters');
    expect(refusal.details).toEqual([{ field: 'location', message: refusal.message }]);
  });
});

describe('the kind rule', () => {
  it('names both permitted kinds rather than reporting the value as invalid', () => {
    const refusal = refusalFor({ kind: 'Panel' });
    expect(refusal.code).toBe('SESSION_KIND_INVALID');
    expect(refusal.message).toContain('Presentation');
    expect(refusal.message).toContain('Workshop');
    expect(refusal.details).toEqual([{ field: 'kind', message: refusal.message }]);
  });
});

// ---------- Acceptance Scenario S04 (TI01, TI04) ----------

describe('the end time must be after the start time', () => {
  /**
   * The midnight-spanning case. It is refused because a Session names one Conference Day and its
   * end time is not later on that day – which is also why the shape makes it structurally
   * impossible rather than a rule someone has to remember.
   */
  it('refuses 23:15–00:45, naming the same-day rule and the midnight limit', () => {
    const refusal = refusalFor({ startTime: '23:15', endTime: '00:45' });
    expect(refusal.statusCode).toBe(400);
    expect(refusal.code).toBe('SESSION_TIME_RANGE_INVALID');
    expect(refusal.message).toContain('after its start time on the same conference day');
    expect(refusal.message).toContain('midnight');
    expect(refusal.details?.map((detail) => detail.field)).toEqual(['startTime', 'endTime']);
  });

  it('refuses a zero-length session at 10:00–10:00', () => {
    const refusal = refusalFor({ startTime: '10:00', endTime: '10:00' });
    expect(refusal.code).toBe('SESSION_TIME_RANGE_INVALID');
    expect(refusal.message).toContain('after its start time');
  });

  it('accepts a one-minute session, so "after" means strictly after and nothing more', () => {
    expect(
      validateSessionDetails({ ...VALID, startTime: '10:00', endTime: '10:01' }, AUTUMN).endTime,
    ).toBe('10:01');
  });

  it('refuses a time that is not a 24-hour wall-clock value', () => {
    for (const startTime of ['9:00', '09:00:00', '25:00', '09:60', '09:00Z', '09:00+02:00', '']) {
      const refusal = refusalFor({ startTime });
      expect(refusal.code, startTime).toBe('SESSION_TIME_RANGE_INVALID');
      expect(refusal.message, startTime).toContain('HH:MM');
    }
  });
});

// ---------- Acceptance Scenario S05 (TI04) ----------

describe('the session day must be one of the conference days', () => {
  it('refuses a day after the span and names the permitted days', () => {
    const refusal = refusalFor({ day: '2026-09-17' });
    expect(refusal.statusCode).toBe(400);
    expect(refusal.code).toBe('SESSION_DAY_OUT_OF_SPAN');
    // The whole point of this refusal: the Organizer is told which days *are* allowed.
    expect(refusal.message).toContain('2026-09-15');
    expect(refusal.message).toContain('2026-09-16');
    expect(refusal.message).toContain('Autumn Offsite');
    expect(refusal.details).toEqual([{ field: 'day', message: refusal.message }]);
  });

  it('refuses the day before the span too', () => {
    expect(refusalFor({ day: '2026-09-14' }).code).toBe('SESSION_DAY_OUT_OF_SPAN');
  });

  it('accepts both ends of the span', () => {
    for (const day of ['2026-09-15', '2026-09-16']) {
      expect(validateSessionDetails({ ...VALID, day }, AUTUMN).day).toBe(day);
    }
  });

  it('lists three or four days readably rather than as a bare array', () => {
    const refusal = refusalFor({
      day: '2026-09-20',
    });
    expect(refusal.message).toContain('2026-09-15 and 2026-09-16');

    const longer = { name: 'Week', startDate: '2026-09-15', endDate: '2026-09-18' };
    try {
      validateSessionDetails({ ...VALID, day: '2026-09-20' }, longer);
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as AppError).message).toContain(
        '2026-09-15, 2026-09-16, 2026-09-17 and 2026-09-18',
      );
    }
  });

  it('refuses a day that is not a calendar date at all', () => {
    const refusal = refusalFor({ day: '15/09/2026' });
    expect(refusal.code).toBe('SESSION_DAY_OUT_OF_SPAN');
    expect(refusal.message).toContain('YYYY-MM-DD');
  });
});

// ---------- the rule that is deliberately absent ----------

describe('overlap is never a validation failure', () => {
  /**
   * Parallel Tracks are a supported product option (FR2, REQ-029). There is no conference-schedule
   * argument to this function at all, which is the structural reason a validation path *cannot*
   * reject an overlapping Session: it cannot see the other Sessions to compare against.
   */
  it('accepts a session regardless of what else is scheduled at the same time', () => {
    expect(
      validateSessionDetails({ ...VALID, startTime: '09:00', endTime: '10:30' }, AUTUMN),
    ).toMatchObject({ startTime: '09:00', endTime: '10:30' });
    expect(validateSessionDetails.length).toBe(2);
  });
});
