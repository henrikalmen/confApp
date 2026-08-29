import { describe, expect, it } from 'vitest';
import { AppError } from '../src/errors.ts';
import {
  MINIMUM_POLL_OPTIONS,
  OPTION_LABEL_MAX_LENGTH,
  PROMPT_MAX_LENGTH,
  validateRoundDetails,
  type RoundDetailsInput,
} from '../src/rounds/round-validation.ts';

/**
 * The Round field rules on their own, with no database in the way.
 *
 * The same refusals are driven end to end through the API in `round.integration.test.ts`; these
 * exist because that suite skips where no PostgreSQL is reachable, and the field rules are exactly
 * the part that needs none.
 */

const POLL: RoundDetailsInput = {
  kind: 'VotingRound',
  purpose: 'Poll',
  prompt: 'Where should we start?',
  options: ['Tooling', 'Meetings'],
};

function refusalFor(input: RoundDetailsInput): AppError {
  try {
    validateRoundDetails(input);
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('The input was expected to be refused, and was accepted.');
}

describe('validateRoundDetails', () => {
  it('accepts a poll and keeps its options in the order they were authored', () => {
    const details = validateRoundDetails({
      ...POLL,
      options: ['  Tooling  ', 'Meetings', 'Handovers'],
    });
    expect(details).toEqual({
      kind: 'VotingRound',
      purpose: 'Poll',
      prompt: 'Where should we start?',
      options: ['Tooling', 'Meetings', 'Handovers'],
    });
  });

  it('accepts a post-it round with no options and no purpose', () => {
    expect(
      validateRoundDetails({ kind: 'PostItRound', prompt: '  What slows us down most?  ' }),
    ).toEqual({
      kind: 'PostItRound',
      purpose: null,
      prompt: 'What slows us down most?',
      options: [],
    });
  });

  /** Each refusal names the field the form attaches it to, and its own reason code. */
  it.each([
    ['a kind the domain does not name', { ...POLL, kind: 'Poll' }, 'ROUND_KIND_INVALID', 'kind'],
    [
      'a voting round with no purpose',
      { kind: 'VotingRound', prompt: 'Where?', options: ['A', 'B'] },
      'ROUND_KIND_INVALID',
      'purpose',
    ],
    ['a deferred purpose', { ...POLL, purpose: 'Rating' }, 'ROUND_KIND_INVALID', 'purpose'],
    [
      'a purpose on a post-it round',
      { kind: 'PostItRound', prompt: 'What?', purpose: 'Poll' },
      'ROUND_KIND_INVALID',
      'purpose',
    ],
    ['a blank question', { ...POLL, prompt: '   ' }, 'ROUND_PROMPT_INVALID', 'prompt'],
    [
      'an over-long question',
      { ...POLL, prompt: 'x'.repeat(PROMPT_MAX_LENGTH + 1) },
      'ROUND_PROMPT_INVALID',
      'prompt',
    ],
    ['a single option', { ...POLL, options: ['Tooling'] }, 'ROUND_OPTIONS_INVALID', 'options'],
    [
      'two identically-labelled options',
      { ...POLL, options: ['Tooling', ' Tooling '] },
      'ROUND_OPTIONS_INVALID',
      'options',
    ],
    [
      'a blank option label',
      { ...POLL, options: ['Tooling', ' '] },
      'ROUND_OPTIONS_INVALID',
      'options',
    ],
    [
      'an over-long option label',
      { ...POLL, options: ['Tooling', 'x'.repeat(OPTION_LABEL_MAX_LENGTH + 1)] },
      'ROUND_OPTIONS_INVALID',
      'options',
    ],
    [
      'options on a post-it round',
      { kind: 'PostItRound', prompt: 'What?', options: ['A'] },
      'ROUND_OPTIONS_INVALID',
      'options',
    ],
  ])('refuses %s field-level', (_what, input, code, field) => {
    const refusal = refusalFor(input as RoundDetailsInput);
    expect(refusal.code).toBe(code);
    expect(refusal.statusCode).toBe(400);
    expect(refusal.details?.map((detail) => detail.field)).toContain(field);
    // Distinct from the authority refusal, so a client can tell "fix this" from "you may not".
    expect(refusal.code).not.toBe('CONFERENCE_ROLE_REQUIRED');
  });

  /** The message names the limit or the rule, never "invalid input". */
  it('names the limit that was exceeded and the rule that was broken', () => {
    expect(refusalFor({ ...POLL, options: ['Tooling'] }).message).toContain(
      String(MINIMUM_POLL_OPTIONS),
    );
    expect(refusalFor({ ...POLL, prompt: 'x'.repeat(PROMPT_MAX_LENGTH + 1) }).message).toContain(
      String(PROMPT_MAX_LENGTH),
    );
    expect(refusalFor({ ...POLL, options: ['Tooling', 'Tooling'] }).message).toContain('Tooling');
  });
});
