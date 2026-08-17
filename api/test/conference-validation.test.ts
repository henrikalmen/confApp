import { describe, expect, it } from 'vitest';
import { AppError, ERROR_CODES } from '../src/errors.ts';
import {
  MAX_DAYS,
  NAME_MAX_LENGTH,
  validateConferenceDetails,
} from '../src/conferences/conference-validation.ts';

/**
 * TI03 – Acceptance Scenario S02: invalid Conference details are refused with the permitted range
 * stated, and the message is one an organizer can act on.
 *
 * Each assertion checks the *message*, not only the rejection. FR1's error handling is
 * user-facing prose – "rejected inline with the permitted range stated" – so a refusal that
 * merely returns 400 does not satisfy it.
 */

const valid = { name: 'Autumn Kickoff 2026', startDate: '2026-09-14', endDate: '2026-09-16' };

function refusalFrom(input: { name: string; startDate: string; endDate: string }): AppError {
  try {
    validateConferenceDetails(input);
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('Expected the details to be refused, but they were accepted.');
}

describe('conference date-span validation', () => {
  it('refuses a five-day span with the permitted 1-4 day range stated', () => {
    const refusal = refusalFrom({ ...valid, endDate: '2026-09-18' });

    expect(refusal.code).toBe(ERROR_CODES.CONFERENCE_DATE_SPAN_INVALID);
    expect(refusal.statusCode).toBe(400);
    // The range itself, in the message a person reads – not just "invalid".
    expect(refusal.message).toContain('1');
    expect(refusal.message).toContain(String(MAX_DAYS));
    expect(refusal.message).toContain('5');
  });

  it('names both date fields, because the span is a property of the pair', () => {
    const refusal = refusalFrom({ ...valid, endDate: '2026-09-18' });
    expect(refusal.details?.map((detail) => detail.field)).toEqual(['startDate', 'endDate']);
    for (const detail of refusal.details ?? []) {
      expect(detail.message).not.toBe('');
    }
  });

  it('accepts every span from one to four days', () => {
    const endDates = ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17'];
    for (const endDate of endDates) {
      expect(validateConferenceDetails({ ...valid, endDate }).endDate).toBe(endDate);
    }
  });

  it('refuses an end date before the start date', () => {
    const refusal = refusalFrom({ ...valid, startDate: '2026-09-16', endDate: '2026-09-14' });
    expect(refusal.code).toBe(ERROR_CODES.CONFERENCE_DATE_SPAN_INVALID);
    expect(refusal.message).toMatch(/on or after/i);
  });

  it('refuses dates that are not naive calendar dates', () => {
    for (const startDate of ['2026-09-14T00:00:00Z', '14/09/2026', '2026-9-14', '2026-02-30']) {
      const refusal = refusalFrom({ ...valid, startDate, endDate: startDate });
      expect(refusal.code).toBe(ERROR_CODES.CONFERENCE_DATE_SPAN_INVALID);
      expect(refusal.message).toContain('YYYY-MM-DD');
    }
  });

  /** The dates come back exactly as given – no reformatting, no offset, no Date round trip. */
  it('returns the dates unchanged', () => {
    const details = validateConferenceDetails(valid);
    expect(details.startDate).toBe('2026-09-14');
    expect(details.endDate).toBe('2026-09-16');
  });
});

describe('conference name validation', () => {
  it('refuses a blank name naming the name field', () => {
    const refusal = refusalFrom({ ...valid, name: '' });

    expect(refusal.code).toBe(ERROR_CODES.CONFERENCE_NAME_INVALID);
    expect(refusal.details?.map((detail) => detail.field)).toEqual(['name']);
    expect(refusal.message).toMatch(/name is required/i);
  });

  it('refuses a name that is only whitespace, because it is blank after trimming', () => {
    for (const name of ['   ', '\t', '\n  \t ']) {
      expect(refusalFrom({ ...valid, name }).code).toBe(ERROR_CODES.CONFERENCE_NAME_INVALID);
    }
  });

  it('accepts a 120-character name and refuses a 121-character one', () => {
    const at = 'x'.repeat(NAME_MAX_LENGTH);
    expect(validateConferenceDetails({ ...valid, name: at }).name).toBe(at);

    const over = refusalFrom({ ...valid, name: 'x'.repeat(NAME_MAX_LENGTH + 1) });
    expect(over.code).toBe(ERROR_CODES.CONFERENCE_NAME_INVALID);
    expect(over.message).toContain(String(NAME_MAX_LENGTH));
  });

  it('stores the trimmed name, so validation and persistence see the same value', () => {
    expect(validateConferenceDetails({ ...valid, name: '  Autumn Kickoff 2026  ' }).name).toBe(
      'Autumn Kickoff 2026',
    );
  });

  /** The length limit applies to what is stored – the trimmed name, not the padded input. */
  it('measures length after trimming', () => {
    const padded = `  ${'x'.repeat(NAME_MAX_LENGTH)}  `;
    expect(validateConferenceDetails({ ...valid, name: padded }).name.length).toBe(NAME_MAX_LENGTH);
  });
});

describe('the refusal envelope', () => {
  /**
   * Structural Criterion – a distinct machine code per refusal reason. Two different reasons
   * sharing one code is what forces a client back to parsing prose.
   */
  it('gives the name and the span refusals different codes', () => {
    const nameRefusal = refusalFrom({ ...valid, name: '' });
    const spanRefusal = refusalFrom({ ...valid, endDate: '2026-09-18' });

    expect(nameRefusal.code).not.toBe(spanRefusal.code);
  });

  it('emits through S01s envelope with a displayable message and field details', () => {
    const envelope = refusalFrom({ ...valid, name: '' }).toEnvelope();

    expect(envelope.error.code).toBe(ERROR_CODES.CONFERENCE_NAME_INVALID);
    // A complete sentence, because it is rendered to a person rather than logged.
    expect(envelope.error.message).toMatch(/^[A-Z].*\.$/);
    expect(envelope.error.details).toEqual([{ field: 'name', message: envelope.error.message }]);
  });

  /** The name is checked before the dates, so a form with two problems reports the first field. */
  it('reports the name refusal when both the name and the span are wrong', () => {
    expect(refusalFrom({ name: '', startDate: '2026-09-14', endDate: '2026-09-30' }).code).toBe(
      ERROR_CODES.CONFERENCE_NAME_INVALID,
    );
  });
});
