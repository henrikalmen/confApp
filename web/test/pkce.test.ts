import { describe, expect, it } from 'vitest';
import { createPkceAttempt, codeChallengeOf, randomToken } from '../src/auth/pkce.ts';

/**
 * TI07 – PKCE and the per-attempt values.
 *
 * The assertions that matter are about *unpredictability and independence*: a public client
 * has nothing else standing between a stolen authorization code and a session.
 */
describe('PKCE attempt generation', () => {
  it('produces S256 challenges matching the published test vector', async () => {
    // RFC 7636 Appendix B – if this drifts, the challenge is being computed wrongly.
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(await codeChallengeOf(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('generates a verifier inside RFC 7636’s 43–128 character range', async () => {
    const attempt = await createPkceAttempt();

    expect(attempt.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(attempt.codeVerifier.length).toBeLessThanOrEqual(128);
    // base64url: no +, / or = to be mangled in a query string.
    expect(attempt.codeVerifier).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it('gives every attempt distinct state, nonce and verifier values', async () => {
    const attempts = await Promise.all(Array.from({ length: 25 }, () => createPkceAttempt()));

    for (const field of ['state', 'nonce', 'codeVerifier'] as const) {
      const values = new Set(attempts.map((attempt) => attempt[field]));
      expect(values.size).toBe(attempts.length);
    }
  });

  it('derives none of the three values from another', async () => {
    const attempt = await createPkceAttempt();

    // state travels in the URL; if nonce or verifier could be derived from it, seeing the
    // redirect would be enough to forge the rest.
    expect(attempt.nonce).not.toBe(attempt.state);
    expect(attempt.codeVerifier).not.toBe(attempt.state);
    expect(attempt.codeVerifier).not.toContain(attempt.state);
    expect(attempt.nonce).not.toContain(attempt.state);
    expect(await codeChallengeOf(attempt.state)).not.toBe(attempt.codeChallenge);
  });

  it('produces a challenge that is the hash of the verifier, not the verifier itself', async () => {
    const attempt = await createPkceAttempt();

    expect(attempt.codeChallenge).not.toBe(attempt.codeVerifier);
    expect(attempt.codeChallenge).toBe(await codeChallengeOf(attempt.codeVerifier));
  });

  it('draws from the CSPRNG rather than a predictable source', () => {
    const values = new Set(Array.from({ length: 200 }, () => randomToken(16)));
    expect(values.size).toBe(200);
  });
});
