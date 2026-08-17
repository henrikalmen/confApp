import { describe, expect, it, beforeAll, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import type { AuthConfig } from '../src/auth/config.ts';
import { createDiscovery } from '../src/auth/discovery.ts';
import { createKeyStore } from '../src/auth/jwks.ts';
import { createIdTokenVerifier } from '../src/auth/verify-id-token.ts';
import { createCodeExchange } from '../src/auth/code-exchange.ts';
import { fakeDatabase } from './fake-db.ts';
import { inMemoryUsers } from './fake-auth.ts';
import {
  ANDROID_CLIENT_ID,
  DISCOVERY_URL,
  TEST_HOSTED_DOMAIN,
  TEST_ISSUER,
  WEB_CLIENT_ID,
  createSigningKey,
  mintIdToken,
  stubGoogle,
  type SigningKey,
} from './auth-fixtures.ts';

/**
 * `POST /api/auth/token` – the brokered code exchange (DR01) and its server-side nonce check
 * (DR02).
 *
 * The point under test is that being anonymous costs nothing: the route puts Google's answer
 * through the same verification module as every other credential, so a wrong-domain sign-in
 * is refused here exactly as it would be at any other route, and still creates no user.
 */

const config: AuthConfig = {
  audienceAllowList: [WEB_CLIENT_ID, ANDROID_CLIENT_ID],
  hostedDomain: TEST_HOSTED_DOMAIN,
  issuer: TEST_ISSUER,
  redirectUri: 'http://localhost:8082/auth/callback',
  webClientId: WEB_CLIENT_ID,
  webClientSecret: 'not-a-real-secret',
};

const VALID_VERIFIER = 'a'.repeat(64);

let googleKey: SigningKey;

beforeAll(async () => {
  googleKey = await createSigningKey('google-key-1');
});

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function harness() {
  const stub = stubGoogle([googleKey.publicJwk]);
  const discovery = createDiscovery({ discoveryUrl: DISCOVERY_URL, fetchImpl: stub.fetchImpl });
  const verifier = createIdTokenVerifier(
    config,
    createKeyStore({ discovery, fetchImpl: stub.fetchImpl }),
  );
  const users = inMemoryUsers();
  const app = buildApp({
    db: fakeDatabase(),
    auth: {
      verifier,
      users,
      codeExchange: createCodeExchange({ config, discovery, fetchImpl: stub.fetchImpl }),
    },
  });
  apps.push(app);
  return { app, users, stub };
}

async function post(app: FastifyInstance, body: unknown) {
  return app.inject({ method: 'POST', url: '/api/auth/token', payload: body });
}

describe('POST /api/auth/token', () => {
  it('exchanges a code and returns the ID token, creating the user row', async () => {
    const { app, users, stub } = harness();
    const idToken = await mintIdToken(googleKey, { nonce: 'nonce-abc', sub: 'google-sub-anna' });
    stub.queueTokenResponse({ status: 200, body: { id_token: idToken, access_token: 'opaque' } });

    const response = await post(app, {
      code: 'google-auth-code',
      codeVerifier: VALID_VERIFIER,
      nonce: 'nonce-abc',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.idToken).toBe(idToken);
    expect(body.user).toEqual({
      sub: 'google-sub-anna',
      email: 'anna@ourcompany.example',
      displayName: 'Anna Andersson',
    });
    expect(users.rows.get('google-sub-anna')).toBeDefined();

    // Google's opaque access token is discarded: it carries no `hd` and can never be the
    // API's credential.
    expect(response.payload).not.toContain('opaque');
  });

  it('discovers the token endpoint rather than hardcoding it', async () => {
    const { app, stub } = harness();
    stub.queueTokenResponse({
      status: 200,
      body: { id_token: await mintIdToken(googleKey, { nonce: 'n' }) },
    });

    await post(app, { code: 'c', codeVerifier: VALID_VERIFIER, nonce: 'n' });

    // The endpoint used is the one the discovery document named, read before it was called.
    expect(stub.requests.indexOf(DISCOVERY_URL)).toBeLessThan(
      stub.requests.indexOf(`${TEST_ISSUER}/token`),
    );
    expect(stub.requests).toContain(`${TEST_ISSUER}/token`);
  });

  /** DR02 – replay protection lives here, because checking it means reading a token claim. */
  it('refuses a nonce that does not match the initiating request, creating no user', async () => {
    const { app, users, stub } = harness();
    const idToken = await mintIdToken(googleKey, { nonce: 'nonce-from-somewhere-else' });
    stub.queueTokenResponse({ status: 200, body: { id_token: idToken } });

    const response = await post(app, {
      code: 'c',
      codeVerifier: VALID_VERIFIER,
      nonce: 'nonce-this-browser-started',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('AUTH_NONCE_MISMATCH');
    expect(users.rows.size).toBe(0);
  });

  it('refuses a token carrying no nonce at all', async () => {
    const { app, stub } = harness();
    stub.queueTokenResponse({ status: 200, body: { id_token: await mintIdToken(googleKey) } });

    const response = await post(app, {
      code: 'c',
      codeVerifier: VALID_VERIFIER,
      nonce: 'expected',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('AUTH_NONCE_MISMATCH');
  });

  /**
   * The route is anonymous, so this is the assertion that being anonymous is not a hole: the
   * domain check applies here exactly as it does everywhere else.
   */
  it('refuses a wrong-domain sign-in and creates no user, despite being an anonymous route', async () => {
    const { app, users, stub } = harness();
    const idToken = await mintIdToken(googleKey, {
      hd: 'othercompany.example',
      nonce: 'n',
      sub: 'google-sub-outsider',
    });
    stub.queueTokenResponse({ status: 200, body: { id_token: idToken } });

    const response = await post(app, { code: 'c', codeVerifier: VALID_VERIFIER, nonce: 'n' });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('AUTH_DOMAIN_NOT_ALLOWED');
    expect(users.rows.size).toBe(0);
  });

  it('refuses when Google rejects the code, without leaking Google’s reason', async () => {
    const { app, users, stub } = harness();
    stub.queueTokenResponse({
      status: 400,
      body: { error: 'invalid_grant', error_description: 'Code was already redeemed by anna@x' },
    });

    const response = await post(app, { code: 'stale', codeVerifier: VALID_VERIFIER, nonce: 'n' });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('AUTH_EXCHANGE_FAILED');
    expect(response.payload).not.toContain('invalid_grant');
    expect(response.payload).not.toContain('already redeemed');
    expect(users.rows.size).toBe(0);
  });

  it.each([
    ['a missing code', { codeVerifier: VALID_VERIFIER, nonce: 'n' }],
    ['a missing verifier', { code: 'c', nonce: 'n' }],
    ['a missing nonce', { code: 'c', codeVerifier: VALID_VERIFIER }],
    ['a too-short verifier', { code: 'c', codeVerifier: 'short', nonce: 'n' }],
  ])('rejects %s through the shared validation envelope', async (_name, body) => {
    const { app } = harness();

    const response = await post(app, body);

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  });

  /**
   * A caller-supplied redirect URI must not reach Google – honouring one would let an attacker
   * complete an exchange against a redirect they control. The schema declares
   * `additionalProperties: false`, which Fastify's ajv applies by *stripping* the field, so the
   * assertion is that it is ignored rather than that it is rejected.
   */
  it('ignores a caller-supplied redirect URI and sends the configured one', async () => {
    const stub = stubGoogle([googleKey.publicJwk]);
    stub.queueTokenResponse({
      status: 200,
      body: { id_token: await mintIdToken(googleKey, { nonce: 'n' }) },
    });

    // Wraps the stub so the exact form body sent to Google's token endpoint can be inspected.
    const bodies: string[] = [];
    const recordingFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body === 'string') bodies.push(init.body);
      return stub.fetchImpl(input as string, init);
    }) as unknown as typeof fetch;

    const discovery = createDiscovery({
      discoveryUrl: DISCOVERY_URL,
      fetchImpl: recordingFetch,
    });
    const app = buildApp({
      db: fakeDatabase(),
      auth: {
        verifier: createIdTokenVerifier(
          config,
          createKeyStore({ discovery, fetchImpl: recordingFetch }),
        ),
        users: inMemoryUsers(),
        codeExchange: createCodeExchange({ config, discovery, fetchImpl: recordingFetch }),
      },
    });
    apps.push(app);

    const response = await post(app, {
      code: 'c',
      codeVerifier: VALID_VERIFIER,
      nonce: 'n',
      redirectUri: 'https://evil.example/steal',
    });

    expect(response.statusCode).toBe(200);
    const exchangeBody = bodies.find((body) => body.includes('grant_type='));
    expect(exchangeBody).toBeDefined();
    expect(exchangeBody).toContain(encodeURIComponent(config.redirectUri));
    expect(exchangeBody).not.toContain('evil.example');
    // The app never accepts a client-chosen audience or client ID either.
    expect(exchangeBody).toContain(encodeURIComponent(config.webClientId));
  });

  /**
   * A hung Google token endpoint must fail the request, not hold it open: a hundred people sign
   * in within the same minute at the start of a conference, and stalled requests would exhaust
   * capacity while the API still reported healthy.
   */
  it('refuses rather than hanging when Google never answers', async () => {
    const stub = stubGoogle([googleKey.publicJwk]);
    const discovery = createDiscovery({ discoveryUrl: DISCOVERY_URL, fetchImpl: stub.fetchImpl });

    const neverAnswers = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.endsWith('/token')) {
        // Resolves only when the caller's own timeout aborts it.
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
      return stub.fetchImpl(url, init);
    }) as unknown as typeof fetch;

    const app = buildApp({
      db: fakeDatabase(),
      auth: {
        verifier: createIdTokenVerifier(
          config,
          createKeyStore({ discovery, fetchImpl: stub.fetchImpl }),
        ),
        users: inMemoryUsers(),
        codeExchange: createCodeExchange({ config, discovery, fetchImpl: neverAnswers }),
      },
    });
    apps.push(app);

    // The timeout is 5s; the assertion is that this resolves at all rather than hanging.
    const response = await post(app, { code: 'c', codeVerifier: VALID_VERIFIER, nonce: 'n' });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.payload).not.toContain(config.webClientSecret);
  }, 15_000);

  it('never returns the client secret, whatever happens', async () => {
    const { app, stub } = harness();
    stub.queueTokenResponse({ status: 500, body: { error: 'server_error' } });

    const response = await post(app, { code: 'c', codeVerifier: VALID_VERIFIER, nonce: 'n' });

    expect(response.payload).not.toContain(config.webClientSecret);
  });
});
