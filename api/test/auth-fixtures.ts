import { SignJWT, exportJWK, generateKeyPair, type JWK, type CryptoKey } from 'jose';

/**
 * Locally-signed ID tokens and a stub JWKS.
 *
 * No test in this suite may call Google. Signature, `iss`, `aud`, `exp` and `hd` each have to
 * be provable in isolation, and `hd` in particular must never be satisfiable by accident from
 * a real account – so every token here is minted from a key pair generated in-process, and
 * the "JWKS" is served by a fetch stub that also counts what it was asked for.
 */

export const TEST_ISSUER = 'https://accounts.google.example';
export const TEST_HOSTED_DOMAIN = 'ourcompany.example';

/** confApp's own per-platform client IDs. Two entries, because one proves nothing (TI01). */
export const WEB_CLIENT_ID = 'web-111.apps.googleusercontent.example';
export const ANDROID_CLIENT_ID = 'android-222.apps.googleusercontent.example';
/** A third party's client ID – structurally identical, and never on the allow-list. */
export const FOREIGN_CLIENT_ID = 'someone-else-999.apps.googleusercontent.example';

export const DISCOVERY_URL = `${TEST_ISSUER}/.well-known/openid-configuration`;
const JWKS_URI = `${TEST_ISSUER}/jwks`;
const TOKEN_ENDPOINT = `${TEST_ISSUER}/token`;

export interface SigningKey {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: JWK;
}

export async function createSigningKey(kid: string): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  return { kid, privateKey, publicJwk };
}

export interface TokenOverrides {
  issuer?: string;
  audience?: string;
  sub?: string;
  email?: string;
  name?: string;
  hd?: string | null;
  nonce?: string;
  /** Seconds from now. Negative mints an already-expired token. */
  expiresInSeconds?: number;
}

export async function mintIdToken(
  key: SigningKey,
  overrides: TokenOverrides = {},
): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiresIn = overrides.expiresInSeconds ?? 3600;

  const claims: Record<string, unknown> = {
    email: overrides.email ?? 'anna@ourcompany.example',
    name: overrides.name ?? 'Anna Andersson',
  };
  // `null` means "a consumer account": the claim is absent entirely, not empty.
  if (overrides.hd !== null) claims.hd = overrides.hd ?? TEST_HOSTED_DOMAIN;
  if (overrides.nonce !== undefined) claims.nonce = overrides.nonce;

  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: key.kid })
    .setIssuer(overrides.issuer ?? TEST_ISSUER)
    .setAudience(overrides.audience ?? WEB_CLIENT_ID)
    .setSubject(overrides.sub ?? 'google-sub-anna')
    .setIssuedAt(nowSeconds - 60)
    .setExpirationTime(nowSeconds + expiresIn)
    .sign(key.privateKey);
}

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

/**
 * An `alg: none` token: well-formed, correct claims, no signature at all. A verifier that
 * trusts the header's algorithm rather than pinning its own accepts this, which is the whole
 * reason it is in the fixture set.
 */
export function mintUnsignedToken(overrides: TokenOverrides = {}): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      iss: overrides.issuer ?? TEST_ISSUER,
      aud: overrides.audience ?? WEB_CLIENT_ID,
      sub: overrides.sub ?? 'google-sub-anna',
      email: overrides.email ?? 'anna@ourcompany.example',
      hd: overrides.hd ?? TEST_HOSTED_DOMAIN,
      exp: nowSeconds + 3600,
      iat: nowSeconds - 60,
    }),
  );
  return `${header}.${payload}.`;
}

export interface StubEndpoints {
  fetchImpl: typeof fetch;
  /** Every URL the code under test requested, in order – lets a test prove what it did not call. */
  readonly requests: string[];
  get jwksFetchCount(): number;
  /** Replaces the published key set, standing in for Google rotating its signing keys. */
  publish(keys: JWK[]): void;
  /** Queued responses for the token endpoint, consumed in order. */
  queueTokenResponse(response: { status: number; body: unknown }): void;
}

/**
 * Serves the discovery document and JWKS from memory. Anything else is a hard failure rather
 * than a silent pass-through, so a test can assert that nothing reached the real internet.
 */
export function stubGoogle(keys: JWK[]): StubEndpoints {
  const requests: string[] = [];
  let published = keys;
  let jwksFetchCount = 0;
  const tokenResponses: { status: number; body: unknown }[] = [];

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requests.push(url);

    if (url === DISCOVERY_URL) {
      return json({
        issuer: TEST_ISSUER,
        jwks_uri: JWKS_URI,
        token_endpoint: TOKEN_ENDPOINT,
        authorization_endpoint: `${TEST_ISSUER}/authorize`,
      });
    }

    if (url === JWKS_URI) {
      jwksFetchCount += 1;
      return json({ keys: published });
    }

    if (url === TOKEN_ENDPOINT) {
      const queued = tokenResponses.shift();
      if (queued === undefined) throw new Error('No token-endpoint response was queued.');
      return json(queued.body, queued.status);
    }

    throw new Error(`Unexpected outbound request to ${url} (init: ${JSON.stringify(init ?? {})}).`);
  }) as unknown as typeof fetch;

  return {
    fetchImpl,
    requests,
    get jwksFetchCount() {
      return jwksFetchCount;
    },
    publish(next: JWK[]) {
      published = next;
    },
    queueTokenResponse(response) {
      tokenResponses.push(response);
    },
  };
}
