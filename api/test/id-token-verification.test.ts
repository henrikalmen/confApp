import { describe, expect, it, beforeAll } from 'vitest';
import type { AuthConfig } from '../src/auth/config.ts';
import { createDiscovery } from '../src/auth/discovery.ts';
import { createKeyStore } from '../src/auth/jwks.ts';
import { createIdTokenVerifier } from '../src/auth/verify-id-token.ts';
import {
  ANDROID_CLIENT_ID,
  DISCOVERY_URL,
  FOREIGN_CLIENT_ID,
  TEST_HOSTED_DOMAIN,
  TEST_ISSUER,
  WEB_CLIENT_ID,
  createSigningKey,
  mintIdToken,
  mintUnsignedToken,
  stubGoogle,
  type SigningKey,
  type StubEndpoints,
} from './auth-fixtures.ts';

/**
 * TI03 and TI04, proving Acceptance Scenarios S02 and S03 against the **real** verification
 * path – never a stubbed verifier. The wrong-domain and unsigned cases are the two that
 * silently pass if verification is mocked, so they are asserted here where only the signing
 * keys are local.
 */

const config: AuthConfig = {
  audienceAllowList: [WEB_CLIENT_ID, ANDROID_CLIENT_ID],
  hostedDomain: TEST_HOSTED_DOMAIN,
  issuer: TEST_ISSUER,
  redirectUri: 'http://localhost:8082/auth/callback',
  webClientId: WEB_CLIENT_ID,
  webClientSecret: 'not-a-real-secret',
};

let googleKey: SigningKey;
let attackerKey: SigningKey;

beforeAll(async () => {
  googleKey = await createSigningKey('google-key-1');
  attackerKey = await createSigningKey('attacker-key-1');
});

function verifierAgainst(stub: StubEndpoints) {
  const discovery = createDiscovery({ discoveryUrl: DISCOVERY_URL, fetchImpl: stub.fetchImpl });
  const keyStore = createKeyStore({ discovery, fetchImpl: stub.fetchImpl });
  return createIdTokenVerifier(config, keyStore);
}

describe('the ID-token verification service', () => {
  /**
   * The fixture matrix TI03 pins: eight tokens against a two-entry allow-list, yielding
   * exactly two acceptances and six refusals with distinct codes.
   */
  it('accepts both allow-list audiences and refuses six failure modes with distinct codes', async () => {
    const stub = stubGoogle([googleKey.publicJwk]);
    const verifier = verifierAgainst(stub);

    const cases = [
      { name: 'aud = allow-list entry one', token: await mintIdToken(googleKey) },
      {
        name: 'aud = allow-list entry two',
        token: await mintIdToken(googleKey, { audience: ANDROID_CLIENT_ID }),
      },
      {
        name: 'tampered signature',
        // Same kid Google publishes, different private key: the signature cannot verify.
        token: await mintIdToken({ ...attackerKey, kid: googleKey.kid }),
      },
      {
        name: 'wrong iss',
        token: await mintIdToken(googleKey, { issuer: 'https://evil.example' }),
      },
      {
        name: 'aud outside the allow-list',
        token: await mintIdToken(googleKey, { audience: FOREIGN_CLIENT_ID }),
      },
      { name: 'expired', token: await mintIdToken(googleKey, { expiresInSeconds: -60 }) },
      { name: 'hd absent (consumer account)', token: await mintIdToken(googleKey, { hd: null }) },
      {
        name: 'hd = othercompany.example',
        token: await mintIdToken(googleKey, { hd: 'othercompany.example' }),
      },
    ];

    const results = await Promise.all(
      cases.map(async ({ name, token }) => ({ name, result: await verifier.verify(token) })),
    );

    const accepted = results.filter((entry) => entry.result.ok);
    const refused = results.filter((entry) => !entry.result.ok);

    expect(accepted.map((entry) => entry.name)).toEqual([
      'aud = allow-list entry one',
      'aud = allow-list entry two',
    ]);
    expect(refused).toHaveLength(6);

    const codes = refused.map((entry) => (entry.result as { code: string }).code);
    expect(new Set(codes).size).toBe(6);
    expect(codes).toEqual([
      'AUTH_TOKEN_SIGNATURE_INVALID',
      'AUTH_TOKEN_ISSUER_INVALID',
      'AUTH_TOKEN_AUDIENCE_INVALID',
      'AUTH_TOKEN_EXPIRED',
      'AUTH_DOMAIN_CLAIM_MISSING',
      'AUTH_DOMAIN_NOT_ALLOWED',
    ]);

    // The only outbound traffic was key retrieval: no directory, no Admin SDK, no group lookup.
    expect(new Set(stub.requests)).toEqual(new Set([DISCOVERY_URL, `${TEST_ISSUER}/jwks`]));
  });

  /**
   * Acceptance Scenario S03 – an unsigned token must be refused, not accepted as unverified.
   * This is the case a verifier that trusts the header's own `alg` gets wrong.
   */
  it('refuses an alg: none token rather than accepting it unverified', async () => {
    const stub = stubGoogle([googleKey.publicJwk]);
    const verifier = verifierAgainst(stub);

    const result = await verifier.verify(mintUnsignedToken());

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ code: 'AUTH_TOKEN_MALFORMED' });
  });

  it.each([
    ['an empty string', ''],
    ['not a JWT at all', 'this-is-not-a-token'],
    ['a JWT with a truncated signature', 'a.b.c'],
  ])('refuses %s', async (_name, token) => {
    const stub = stubGoogle([googleKey.publicJwk]);
    const result = await verifierAgainst(stub).verify(token);

    expect(result.ok).toBe(false);
  });

  it('returns sub, hd, email and display name, and never the token itself', async () => {
    const stub = stubGoogle([googleKey.publicJwk]);
    const token = await mintIdToken(googleKey, {
      sub: 'google-sub-anna',
      email: 'anna@ourcompany.example',
    });
    const result = await verifierAgainst(stub).verify(token);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims).toMatchObject({
      sub: 'google-sub-anna',
      hd: TEST_HOSTED_DOMAIN,
      email: 'anna@ourcompany.example',
      displayName: 'Anna Andersson',
    });

    // Nothing about the token escapes the verifier except the named claims – no raw token and
    // no signature fragment travels onward for a later story to log by accident.
    const serialized = JSON.stringify(result.claims);
    expect(serialized).not.toContain(token);
    for (const segment of token.split('.')) {
      expect(serialized).not.toContain(segment);
    }
  });

  it('falls back to the email as display name when Google sends no name claim', async () => {
    const stub = stubGoogle([googleKey.publicJwk]);
    const token = await mintIdToken(googleKey, { name: '' });
    const result = await verifierAgainst(stub).verify(token);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims.displayName).toBe('anna@ourcompany.example');
  });

  /**
   * TI04 – the JWKS cache is an optimization, never a correctness assumption. A replica that
   * started a moment ago has an empty cache and must still verify (ADR-004: replicas are
   * interchangeable, requests are not sticky).
   */
  it('verifies against a cold, empty cache', async () => {
    const stub = stubGoogle([googleKey.publicJwk]);
    const verifier = verifierAgainst(stub);

    expect(stub.jwksFetchCount).toBe(0);
    const result = await verifier.verify(await mintIdToken(googleKey));

    expect(result.ok).toBe(true);
    expect(stub.jwksFetchCount).toBe(1);
  });

  it('refetches on an unknown kid, so a key rotation does not lock everyone out', async () => {
    const stub = stubGoogle([googleKey.publicJwk]);
    const verifier = verifierAgainst(stub);

    // Warm the cache with the pre-rotation key set.
    expect((await verifier.verify(await mintIdToken(googleKey))).ok).toBe(true);
    const afterWarm = stub.jwksFetchCount;
    expect(afterWarm).toBe(1);

    // Google rotates: a new key signs tokens, and the cached set does not contain it. The
    // refetch has to happen inside the cooldown window, or the first rotation would refuse
    // every user until the window elapsed.
    const rotatedKey = await createSigningKey('google-key-2');
    stub.publish([googleKey.publicJwk, rotatedKey.publicJwk]);

    const result = await verifier.verify(await mintIdToken(rotatedKey));

    expect(result.ok).toBe(true);
    expect(stub.jwksFetchCount).toBe(afterWarm + 1);
  });

  it('refuses a kid that is still unknown after a refetch, rather than accepting it', async () => {
    const stub = stubGoogle([googleKey.publicJwk]);
    const verifier = verifierAgainst(stub);

    const strangerKey = await createSigningKey('never-published');
    const result = await verifier.verify(await mintIdToken(strangerKey));

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ code: 'AUTH_SIGNING_KEY_UNKNOWN' });
  });

  /**
   * The load-bearing half of "bounded refetch": without a cooldown, a caller presenting tokens
   * with random `kid`s drives one JWKS fetch per request straight at Google, and being
   * rate-limited there breaks sign-in for everyone. The cache is per replica, so this bound has
   * to hold inside a single process.
   */
  it('does not fetch the JWKS once per request when many unknown kids arrive', async () => {
    const stub = stubGoogle([googleKey.publicJwk]);
    const verifier = verifierAgainst(stub);

    for (let attempt = 0; attempt < 25; attempt += 1) {
      const stranger = await createSigningKey(`forged-kid-${attempt}`);
      const result = await verifier.verify(await mintIdToken(stranger));
      expect(result.ok).toBe(false);
    }

    // Bounded by the cooldown, not by the number of requests.
    expect(stub.jwksFetchCount).toBeLessThanOrEqual(2);
  });

  /**
   * The allow-list is applied as one comparison for every caller. There is no platform-
   * conditional branch, which is what lets S11 add Android and iOS by configuration alone.
   */
  it('applies the same allow-list regardless of which platform minted the token', async () => {
    const stub = stubGoogle([googleKey.publicJwk]);
    const verifier = verifierAgainst(stub);

    for (const audience of [WEB_CLIENT_ID, ANDROID_CLIENT_ID]) {
      expect((await verifier.verify(await mintIdToken(googleKey, { audience }))).ok).toBe(true);
    }
    expect(
      (await verifier.verify(await mintIdToken(googleKey, { audience: FOREIGN_CLIENT_ID }))).ok,
    ).toBe(false);
  });

  it('refuses every audience when the allow-list holds a single entry the token does not match', async () => {
    const stub = stubGoogle([googleKey.publicJwk]);
    const discovery = createDiscovery({ discoveryUrl: DISCOVERY_URL, fetchImpl: stub.fetchImpl });
    const narrow = createIdTokenVerifier(
      { ...config, audienceAllowList: [WEB_CLIENT_ID] },
      createKeyStore({ discovery, fetchImpl: stub.fetchImpl }),
    );

    // The regression S11 would hit if the allow-list were ever collapsed to one value.
    const result = await narrow.verify(
      await mintIdToken(googleKey, { audience: ANDROID_CLIENT_ID }),
    );
    expect(result).toMatchObject({ ok: false, code: 'AUTH_TOKEN_AUDIENCE_INVALID' });
  });
});
