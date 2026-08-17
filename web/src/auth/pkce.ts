/**
 * PKCE, and the two per-attempt values that make a redirect verifiable.
 *
 * The SPA is a public client: it holds no secret, so nothing about it proves that the code
 * coming back belongs to the sign-in *this browser* started. Three separately generated random
 * values do that job instead:
 *
 * - `codeVerifier` proves the code is redeemed by whoever requested it (PKCE, RFC 7636);
 * - `state` proves the redirect belongs to this attempt, and is compared in the browser
 *   because it is an opaque round-tripped value rather than a token claim;
 * - `nonce` proves the *token* belongs to this attempt, and is compared server-side, because
 *   comparing it means reading a token claim and no client code parses a JWT (DR02).
 *
 * All three come from the CSPRNG. `Math.random()` would be a security defect here, not a
 * style preference.
 */

/** 32 bytes → 43 base64url characters, comfortably inside RFC 7636's 43–128 range. */
const RANDOM_BYTES = 32;

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomToken(bytes = RANDOM_BYTES): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return base64url(buffer);
}

/**
 * S256 only. `plain` is permitted by the spec and by Google, and is worthless: it puts the
 * verifier itself in the authorization request, which is exactly what PKCE exists to avoid.
 */
export async function codeChallengeOf(codeVerifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
  return base64url(new Uint8Array(digest));
}

export interface PkceAttempt {
  state: string;
  nonce: string;
  codeVerifier: string;
  codeChallenge: string;
}

export async function createPkceAttempt(): Promise<PkceAttempt> {
  const codeVerifier = randomToken();
  return {
    // Three independent values: deriving one from another would let knowledge of the one that
    // travels in the URL predict the ones that must not.
    state: randomToken(16),
    nonce: randomToken(16),
    codeVerifier,
    codeChallenge: await codeChallengeOf(codeVerifier),
  };
}
