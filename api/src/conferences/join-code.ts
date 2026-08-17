import { randomInt } from 'node:crypto';

/**
 * The Join Code: how one is minted, and how whatever an employee typed becomes comparable to it.
 *
 * A Join Code is read off a slide and typed on a phone, so both halves of this module exist to
 * absorb that: the alphabet excludes the characters people mistake for one another, and
 * normalization forgives the case and the spacing they will inevitably introduce.
 *
 * It is **not a security boundary**. Google Workspace sign-in already restricts confApp to
 * employees (ADR-002); the code only selects *which* Conference to join. That is why the length is
 * chosen for transcribability rather than for entropy, and why a refusal names its reason instead
 * of being deliberately unhelpful.
 *
 * The module holds no state.
 */

/**
 * Digits 0 and 1 and letters I, L, O and U are absent, and each for a reason: 0/O and 1/I/L are
 * the classic transcription confusions, and U is excluded because it turns into V in handwriting
 * and because leaving it out keeps accidental words out of generated codes
 * (https://www.crockford.com/base32.html).
 *
 * 30 characters at length 6 is ~7.3e8 codes – far more than a company running one conference at a
 * time will ever mint, which is what makes a collision a retry rather than a design problem.
 */
export const JOIN_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

export const JOIN_CODE_LENGTH = 6;

/** The canonical stored form, as a shape. The same rule is a CHECK constraint on the column. */
const CANONICAL = new RegExp(`^[${JOIN_CODE_ALPHABET}]{${JOIN_CODE_LENGTH}}$`);

/** How a Conference's code is produced. Injected so a test can pin the value it expects. */
export type JoinCodeMinter = () => string;

/**
 * A fresh code from the alphabet above.
 *
 * `randomInt` rather than `Math.random`: the code is not a security boundary, but a predictable
 * sequence would still hand every employee the *same* code on a fresh replica, and an unbiased
 * draw costs nothing here. `randomInt(30)` is uniform – a modulo of a wider random value would
 * quietly favour the first characters of the alphabet.
 */
export function generateJoinCode(): string {
  let code = '';
  for (let index = 0; index < JOIN_CODE_LENGTH; index += 1) {
    code += JOIN_CODE_ALPHABET[randomInt(JOIN_CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * What the employee typed, reduced to the canonical form the column holds.
 *
 * Trimmed, stripped of *all* whitespace and hyphens wherever they fall, and uppercased. The
 * hyphens matter because a six-character code is naturally read aloud and written down in groups
 * ("K7RM-4P"), and the internal whitespace matters because a phone keyboard adds a space after a
 * pasted value as readily as before it.
 *
 * This is the one normalization in the codebase, and the join, re-join and refusal paths all go
 * through it – a second copy is how "K7RM-4P works but k7rm-4p does not" appears on day one.
 */
export function normalizeJoinCode(submitted: string): string {
  return submitted.replace(/[\s-]/g, '').toUpperCase();
}

/**
 * Whether a normalized value could name a code at all.
 *
 * Not a gate on the join path: a value that cannot be a code simply matches no Conference and is
 * refused as unknown, which is the honest answer and keeps one refusal for "no such code" rather
 * than two that a client would have to tell apart. It exists so the minter and the tests can
 * state the canonical shape once.
 */
export function isCanonicalJoinCode(value: string): boolean {
  return CANONICAL.test(value);
}
