import { describe, expect, it } from 'vitest';
import { AppError } from '../src/errors.ts';
import {
  assertSessionDeletable,
  isSessionDeletable,
  sessionDeletionRefusalReason,
} from '../src/sessions/session-deletion.ts';

/**
 * S05 TI01 – the deletion guard as a pure function, with no database anywhere near it.
 *
 * The rule is small enough that the interesting half is the *sentence*: FR7 fixes the wording, and
 * US10 adds that the refusal must name what would be lost, which is why these assertions read the
 * message rather than only the code.
 */

const NOTHING = { postIts: 0, votes: 0 };

function refusalFor(contributions: { postIts: number; votes: number }): AppError {
  try {
    assertSessionDeletable(contributions);
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error(`assertSessionDeletable did not refuse ${JSON.stringify(contributions)}`);
}

describe('the session deletion guard', () => {
  // ---------- Acceptance Scenario S03 (the guard's half): nothing collected, nothing to refuse ----

  it('refuses nothing when a session has collected nothing', () => {
    expect(sessionDeletionRefusalReason(NOTHING)).toBeNull();
    expect(isSessionDeletable(NOTHING)).toBe(true);
    expect(() => assertSessionDeletable(NOTHING)).not.toThrow();
  });

  // ---------- Acceptance Scenario S01: a Board of post-its ----------

  it('refuses a session holding post-its, naming how many', () => {
    const refused = refusalFor({ postIts: 12, votes: 0 });

    expect(refused.code).toBe('SESSION_HOLDS_CONTRIBUTIONS');
    expect(refused.statusCode).toBe(409);
    expect(refused.message).toBe(
      'This session has collected 12 post-its and cannot be deleted. ' +
        'Edit the session, or move it to another day or time, instead.',
    );
  });

  // ---------- Acceptance Scenario S02: anonymous votes alone refuse just as firmly ----------

  it('refuses a session whose only contribution is votes, naming how many', () => {
    const refused = refusalFor({ postIts: 0, votes: 8 });

    expect(refused.code).toBe('SESSION_HOLDS_CONTRIBUTIONS');
    expect(refused.message).toContain('8 votes');
    expect(refused.message).not.toContain('post-it');
  });

  it('names both when a session holds both', () => {
    expect(refusalFor({ postIts: 12, votes: 8 }).message).toBe(
      'This session has collected 12 post-its and 8 votes and cannot be deleted. ' +
        'Edit the session, or move it to another day or time, instead.',
    );
  });

  /** One of each is the case that reads wrong if the counts are pluralized blindly. */
  it('reads correctly for a single post-it and a single vote', () => {
    expect(refusalFor({ postIts: 1, votes: 0 }).message).toContain(
      'collected 1 post-it and cannot',
    );
    expect(refusalFor({ postIts: 0, votes: 1 }).message).toContain('collected 1 vote and cannot');
  });

  /**
   * FR7 fixes both halves of the refusal: what happened, and what to do instead. The Organizer's
   * alternatives are editing and rescheduling – there is no restore path to offer them.
   */
  it('offers the edit and the reschedule paths, and nothing else', () => {
    const message = refusalFor({ postIts: 3, votes: 0 }).message;

    expect(message).toMatch(/^This session has collected .* and cannot be deleted\./);
    expect(message).toContain('Edit the session');
    expect(message).toMatch(/move it to another day or time/);
    expect(message).not.toMatch(/restore|undo|recover|archive|discard/i);
  });

  /**
   * The refusal carries a sentence and a code, and nothing a caller could read data out of.
   * `AppError.current` is the one channel the envelope has for a payload, and this refusal has no
   * payload – a Session holding ballots must not answer a delete with anything ballot-shaped.
   */
  it('carries no payload beside the sentence', () => {
    const refused = refusalFor({ postIts: 0, votes: 8 });

    expect(refused.current).toBeUndefined();
    expect(refused.details).toBeUndefined();
    expect(refused.toEnvelope().error).toEqual({
      code: 'SESSION_HOLDS_CONTRIBUTIONS',
      message: refused.message,
    });
  });
});
