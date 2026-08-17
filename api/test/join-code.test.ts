import { describe, expect, it } from 'vitest';
import {
  JOIN_CODE_ALPHABET,
  JOIN_CODE_LENGTH,
  generateJoinCode,
  isCanonicalJoinCode,
  normalizeJoinCode,
} from '../src/conferences/join-code.ts';
import { assertJoinable, isJoinable, joinRefusalReason } from '../src/conferences/lifecycle.ts';
import { AppError } from '../src/errors.ts';

/**
 * The two pure halves of the Join Code – how one is minted, and how what an employee typed becomes
 * comparable to it – plus the reasons the joinability predicate reports.
 *
 * Nothing here needs a database or a request: these are the rules a person's fingers meet.
 */

describe('minting a join code (TI02)', () => {
  /** The characters a person mistakes for one another, absent by construction. */
  it('excludes 0, 1, I, L, O and U from the alphabet', () => {
    for (const excluded of ['0', '1', 'I', 'L', 'O', 'U']) {
      expect(JOIN_CODE_ALPHABET, excluded).not.toContain(excluded);
    }
    expect(JOIN_CODE_ALPHABET).toBe('23456789ABCDEFGHJKMNPQRSTVWXYZ');
  });

  it('draws every character of every code from that alphabet, at the canonical length', () => {
    // Enough draws that a single stray character would show up rather than being a coin flip.
    for (let draw = 0; draw < 500; draw += 1) {
      const code = generateJoinCode();
      expect(code).toHaveLength(JOIN_CODE_LENGTH);
      for (const character of code) {
        expect(JOIN_CODE_ALPHABET, code).toContain(character);
      }
      expect(isCanonicalJoinCode(code)).toBe(true);
    }
  });

  /**
   * Not a uniqueness guarantee – the database constraint is that – but a generator returning the
   * same value repeatedly would make every publish collide, and would do so only in production
   * where two replicas start from the same seed.
   */
  it('does not return the same code twice over a large sample', () => {
    const codes = new Set<string>();
    for (let draw = 0; draw < 1000; draw += 1) codes.add(generateJoinCode());
    expect(codes.size).toBe(1000);
  });

  /** Every character of the alphabet is reachable – a biased draw would leave some unused. */
  it('can produce every character in the alphabet', () => {
    const seen = new Set<string>();
    for (let draw = 0; draw < 5000; draw += 1) {
      for (const character of generateJoinCode()) seen.add(character);
    }
    expect([...seen].sort().join('')).toBe([...JOIN_CODE_ALPHABET].sort().join(''));
  });
});

describe('normalizing what the employee typed (TI03)', () => {
  /** The Acceptance Scenario's own four spellings of one code. */
  it('resolves lowercase, padded, and hyphenated spellings to the one canonical form', () => {
    for (const submitted of [' k7rm4p ', 'k7rm4p', 'K7RM-4P', 'K7RM4P', 'k7rm 4p', '  K7RM-4P  ']) {
      expect(normalizeJoinCode(submitted), submitted).toBe('K7RM4P');
    }
  });

  it('strips whitespace wherever it falls, not only at the ends', () => {
    expect(normalizeJoinCode('K 7 R M 4 P')).toBe('K7RM4P');
    expect(normalizeJoinCode('\tK7RM\n4P ')).toBe('K7RM4P');
  });

  /**
   * A value that cannot be a code normalizes to something harmless rather than throwing: the join
   * path refuses it as unknown, which is the honest answer and keeps one refusal for "no such code".
   */
  it('leaves an unusable value unusable rather than repairing it', () => {
    expect(normalizeJoinCode('0OIL11')).toBe('0OIL11');
    expect(isCanonicalJoinCode(normalizeJoinCode('0OIL11'))).toBe(false);
    expect(isCanonicalJoinCode(normalizeJoinCode('abc'))).toBe(false);
    expect(isCanonicalJoinCode(normalizeJoinCode(''))).toBe(false);
  });
});

describe('the one joinability predicate reports its reason (TI05)', () => {
  const published = { lifecycleState: 'published' as const, endDate: '2026-09-16', name: 'Kickoff' };

  it('names not-published, archived and ended as three distinct reasons', () => {
    expect(joinRefusalReason({ ...published, lifecycleState: 'draft' }, '2026-09-15')).toBe(
      'not-published',
    );
    expect(joinRefusalReason({ ...published, lifecycleState: 'archived' }, '2026-09-15')).toBe(
      'archived',
    );
    expect(joinRefusalReason(published, '2026-09-17')).toBe('ended');
    expect(joinRefusalReason(published, '2026-09-16')).toBeNull();
  });

  /**
   * A draft is reported as not-published whatever its dates. Its Organizer's next action is to
   * publish it, and "it ended" would send them looking at a calendar instead.
   */
  it('reports a draft as not-published even after its end date has passed', () => {
    expect(joinRefusalReason({ ...published, lifecycleState: 'draft' }, '2027-01-01')).toBe(
      'not-published',
    );
  });

  /** The boolean form is the same rule, so the two can never disagree. */
  it('keeps isJoinable as the reason-free view of the same decision', () => {
    expect(isJoinable(published, '2026-09-16')).toBe(true);
    expect(isJoinable(published, '2026-09-17')).toBe(false);
    expect(isJoinable({ ...published, lifecycleState: 'draft' }, '2026-09-16')).toBe(false);
  });

  it('refuses through the shared envelope with a distinct code per reason, naming the conference', () => {
    const cases = [
      { conference: { ...published, lifecycleState: 'draft' as const, name: 'Draft Days' } },
      { conference: { ...published, lifecycleState: 'archived' as const, name: 'Retro 2025' } },
    ];

    const refusals = cases.map(({ conference }) => {
      try {
        assertJoinable(conference, '2026-09-15');
        throw new Error(`${conference.name} was not refused.`);
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        return error as AppError;
      }
    });

    let ended: AppError;
    try {
      assertJoinable({ ...published, name: 'Summer Jam' }, '2026-09-17');
      throw new Error('Summer Jam was not refused.');
    } catch (error) {
      ended = error as AppError;
    }

    const all = [...refusals, ended];
    expect(all.map((error) => error.code)).toEqual([
      'JOIN_CONFERENCE_NOT_PUBLISHED',
      'JOIN_CONFERENCE_ARCHIVED',
      'JOIN_CONFERENCE_ENDED',
    ]);

    // Each names its own reason, and each names the conference the code was for.
    expect(all[0]!.message).toMatch(/not been published/i);
    expect(all[0]!.message).toContain('Draft Days');
    expect(all[1]!.message).toMatch(/archived/i);
    expect(all[1]!.message).toContain('Retro 2025');
    expect(all[2]!.message).toMatch(/ended on 2026-09-16/i);
    expect(all[2]!.message).toContain('Summer Jam');

    // No two are the same envelope, and none is a generic refusal.
    expect(new Set(all.map((error) => error.message)).size).toBe(3);
    for (const error of all) expect(error.message).not.toMatch(/invalid|not allowed/i);
  });

  it('returns without throwing for a joinable conference', () => {
    expect(() => assertJoinable(published, '2026-09-14')).not.toThrow();
  });
});
