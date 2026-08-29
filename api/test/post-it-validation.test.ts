import { describe, expect, it } from 'vitest';
import type { AppError } from '../src/errors.ts';
import { POST_IT_MAX_LENGTH, validatePostItText } from '../src/rounds/post-it-validation.ts';

/**
 * The Post-it text rule, at the unit the route calls (TI01, TI04).
 *
 * The boundary cases are written **against the exported constant**, never against the number 280.
 * A test that hard-coded the number would be a third copy of the cap and would pass while the
 * constant, the message and the migration's CHECK disagreed with each other.
 */

function refusalFor(text: string): AppError {
  try {
    validatePostItText({ text });
  } catch (error) {
    return error as AppError;
  }
  throw new Error(`"${text}" was accepted; a refusal was expected.`);
}

describe('post-it text validation', () => {
  it('trims before it stores, so trailing whitespace never costs somebody their last word', () => {
    expect(validatePostItText({ text: '  Waiting three days for test data \n' })).toBe(
      'Waiting three days for test data',
    );
  });

  it('refuses blank and whitespace-only text at field level', () => {
    for (const text of ['', '   ', '\n\t ']) {
      const refusal = refusalFor(text);
      expect(refusal.code).toBe('POST_IT_TEXT_INVALID');
      expect(refusal.statusCode).toBe(400);
      // Field-level, because the compose box attaches it to the box the text is still sitting in.
      expect(refusal.details).toEqual([{ field: 'text', message: refusal.message }]);
    }
  });

  it('accepts exactly the cap and refuses one character more, naming the limit and the length', () => {
    const exact = 'x'.repeat(POST_IT_MAX_LENGTH);
    expect(validatePostItText({ text: exact })).toBe(exact);

    const refusal = refusalFor('x'.repeat(POST_IT_MAX_LENGTH + 1));
    expect(refusal.code).toBe('POST_IT_TEXT_INVALID');
    // Both numbers, so the person knows what the rule is and how far past it they are.
    expect(refusal.message).toContain(String(POST_IT_MAX_LENGTH));
    expect(refusal.message).toContain(String(POST_IT_MAX_LENGTH + 1));
  });

  /**
   * The cap is measured the way PostgreSQL measures it.
   *
   * `char_length` counts **code points**; JavaScript's `.length` counts UTF-16 code units, so a
   * string of astral-plane characters measures twice as long there. Counting the JS way would refuse
   * a Post-it of half the stated length and name a number nobody could see on their own screen.
   */
  it('counts code points, not UTF-16 code units', () => {
    const emoji = '🙂'.repeat(POST_IT_MAX_LENGTH);
    expect([...emoji].length).toBe(POST_IT_MAX_LENGTH);
    expect(emoji.length).toBe(POST_IT_MAX_LENGTH * 2);

    expect(validatePostItText({ text: emoji })).toBe(emoji);
    expect(refusalFor('🙂'.repeat(POST_IT_MAX_LENGTH + 1)).code).toBe('POST_IT_TEXT_INVALID');
  });

  /** Trimmed *before* it is measured, so trailing spaces cannot push a legal post-it over. */
  it('measures the trimmed text, not what was sent', () => {
    const padded = `${'x'.repeat(POST_IT_MAX_LENGTH)}      `;
    expect(validatePostItText({ text: padded })).toBe('x'.repeat(POST_IT_MAX_LENGTH));
  });
});
