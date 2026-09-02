import { describe, expect, it, beforeAll, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { buildApp, installErrorHandling } from '../src/app.ts';
import type { AuthConfig } from '../src/auth/config.ts';
import { createDiscovery } from '../src/auth/discovery.ts';
import { createKeyStore } from '../src/auth/jwks.ts';
import { createIdTokenVerifier } from '../src/auth/verify-id-token.ts';
import {
  ANONYMOUS_ROUTES,
  UnprotectedRouteError,
  createWithAuth,
  installRouteAudit,
} from '../src/auth/with-auth.ts';
import { fakeDatabase } from './fake-db.ts';
import { inMemoryUsers, unusedCodeExchange } from './fake-auth.ts';
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
} from './auth-fixtures.ts';

/**
 * TI05 – Acceptance Scenario S05: a wrapped handler never executes without a verified caller.
 *
 * The verifier here is the real one, driven by locally-signed fixtures. Stubbing it would make
 * the wrong-domain case pass for the wrong reason, which is the failure the FIS's testing
 * strategy singles out.
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

beforeAll(async () => {
  googleKey = await createSigningKey('google-key-1');
});

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

interface Harness {
  app: FastifyInstance;
  users: ReturnType<typeof inMemoryUsers>;
  /** Every time the wrapped probe handler's body actually ran. */
  invocations: { sub: string }[];
  logLines: string[];
}

function harness(): Harness {
  const stub = stubGoogle([googleKey.publicJwk]);
  const discovery = createDiscovery({ discoveryUrl: DISCOVERY_URL, fetchImpl: stub.fetchImpl });
  const verifier = createIdTokenVerifier(
    config,
    createKeyStore({ discovery, fetchImpl: stub.fetchImpl }),
  );
  const users = inMemoryUsers();
  const invocations: { sub: string }[] = [];
  const logLines: string[] = [];

  const app = Fastify({
    logger: {
      level: 'info',
      // Capture everything the server logs, so "no token in log output" is a real assertion.
      stream: {
        write(line: string) {
          logLines.push(line);
        },
      },
    },
  });
  installErrorHandling(app);
  installRouteAudit(app);

  const withAuth = createWithAuth({ verifier, users });
  app.get(
    '/api/probe',
    withAuth(async (_request, caller) => {
      invocations.push({ sub: caller.sub });
      return { caller };
    }),
  );

  apps.push(app);
  return { app, users, invocations, logLines };
}

describe('withAuth', () => {
  it('refuses a request with no Authorization header before the handler body runs', async () => {
    const { app, invocations, users } = harness();

    const response = await app.inject({ method: 'GET', url: '/api/probe' });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('AUTH_CREDENTIAL_MISSING');
    expect(invocations).toHaveLength(0);
    expect(users.upsertCount).toBe(0);
  });

  it.each([
    ['a bare token with no scheme', 'just-a-token'],
    ['the wrong scheme', 'Basic YWJjOmRlZg=='],
    ['Bearer with no token', 'Bearer'],
    ['Bearer with an empty token', 'Bearer   '],
  ])('refuses %s before the handler body runs', async (_name, header) => {
    const { app, invocations } = harness();

    const response = await app.inject({
      method: 'GET',
      url: '/api/probe',
      headers: { authorization: header },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toMatch(/^AUTH_CREDENTIAL_(MISSING|MALFORMED)$/);
    expect(invocations).toHaveLength(0);
  });

  /**
   * Acceptance Scenario S02 – a structurally valid Google token from another domain is refused
   * and creates no user. Both halves matter: the refusal, and the empty table.
   */
  it('refuses a wrong-domain token, runs no handler body, and creates no user row', async () => {
    const { app, invocations, users } = harness();
    const token = await mintIdToken(googleKey, {
      hd: 'othercompany.example',
      sub: 'google-sub-outsider',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/probe',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('AUTH_DOMAIN_NOT_ALLOWED');
    expect(invocations).toHaveLength(0);
    expect(users.rows.size).toBe(0);
    expect(users.rows.has('google-sub-outsider')).toBe(false);
  });

  it('refuses a consumer account carrying no hd claim, and creates no user row', async () => {
    const { app, invocations, users } = harness();
    const token = await mintIdToken(googleKey, { hd: null, sub: 'google-sub-consumer' });

    const response = await app.inject({
      method: 'GET',
      url: '/api/probe',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('AUTH_DOMAIN_CLAIM_MISSING');
    expect(invocations).toHaveLength(0);
    expect(users.rows.size).toBe(0);
  });

  it.each([
    ['an unsigned alg: none token', () => mintUnsignedToken()],
    ['an expired token', () => mintIdToken(googleKey, { expiresInSeconds: -60 })],
    [
      'a token for another application',
      () => mintIdToken(googleKey, { audience: FOREIGN_CLIENT_ID }),
    ],
  ])('refuses %s before the handler body runs', async (_name, mint) => {
    const { app, invocations } = harness();

    const response = await app.inject({
      method: 'GET',
      url: '/api/probe',
      headers: { authorization: `Bearer ${await mint()}` },
    });

    expect(response.statusCode).toBe(401);
    expect(invocations).toHaveLength(0);
  });

  it('passes a verified caller to the handler, keyed on sub', async () => {
    const { app, invocations, users } = harness();
    const token = await mintIdToken(googleKey, {
      sub: 'google-sub-anna',
      email: 'anna@ourcompany.example',
      name: 'Anna Andersson',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/probe',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(invocations).toEqual([{ sub: 'google-sub-anna' }]);

    // The pinned AuthenticatedCaller shape S03–S09 consume – exactly these fields.
    const { caller } = response.json();
    expect(Object.keys(caller).sort()).toEqual(['displayName', 'email', 'hd', 'sub', 'userId']);
    expect(caller).toMatchObject({
      sub: 'google-sub-anna',
      hd: TEST_HOSTED_DOMAIN,
      email: 'anna@ourcompany.example',
      displayName: 'Anna Andersson',
    });
    expect(users.rows.get('google-sub-anna')).toBeDefined();
  });

  it('accepts a token minted for any allow-list entry, not only the web client ID', async () => {
    const { app } = harness();
    const token = await mintIdToken(googleKey, { audience: ANDROID_CLIENT_ID });

    const response = await app.inject({
      method: 'GET',
      url: '/api/probe',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
  });

  /**
   * Structural Criterion – no token, token fragment, or Authorization value in a log line or
   * a response body. These strings are the credential itself; leaking one is a compromise.
   */
  it('leaks neither the token nor the Authorization value into a response or the log', async () => {
    const { app, logLines } = harness();
    const good = await mintIdToken(googleKey);
    const bad = await mintIdToken(googleKey, { hd: 'othercompany.example' });

    const responses = [
      await app.inject({
        method: 'GET',
        url: '/api/probe',
        headers: { authorization: `Bearer ${good}` },
      }),
      await app.inject({
        method: 'GET',
        url: '/api/probe',
        headers: { authorization: `Bearer ${bad}` },
      }),
      await app.inject({
        method: 'GET',
        url: '/api/probe',
        headers: { authorization: 'Bearer not-a-real-token-at-all' },
      }),
    ];

    const everythingWritten = [...responses.map((r) => r.payload), ...logLines].join('\n');

    for (const token of [good, bad]) {
      expect(everythingWritten).not.toContain(token);
      // The signature segment alone is enough to matter.
      for (const segment of token.split('.')) {
        expect(everythingWritten).not.toContain(segment);
      }
    }
    expect(everythingWritten.toLowerCase()).not.toContain('bearer ');
  });
});

describe('the registered route table', () => {
  /**
   * Structural Criterion – every route goes through the wrapper except the written anonymous
   * allow-list, so a new anonymous route cannot be added silently.
   */
  it('has GET /api/health as its only route left anonymous for readiness', async () => {
    const anonymousForReadiness = ANONYMOUS_ROUTES.filter((route) =>
      /health|readiness/i.test(route.because),
    );

    expect(anonymousForReadiness).toHaveLength(1);
    expect(anonymousForReadiness[0]).toMatchObject({ method: 'GET', url: '/api/health' });
  });

  /**
   * The assertion over the real, fully-built route table: every route the application
   * registers is either wrapped or one of the two written anonymous entries. This is what a
   * later story trips if it adds a route and forgets the wrapper.
   */
  it('wraps every route the built app registers except the three written anonymous entries', async () => {
    const stub = stubGoogle([googleKey.publicJwk]);
    const discovery = createDiscovery({ discoveryUrl: DISCOVERY_URL, fetchImpl: stub.fetchImpl });
    const app = buildApp({
      db: fakeDatabase(),
      auth: {
        verifier: createIdTokenVerifier(
          config,
          createKeyStore({ discovery, fetchImpl: stub.fetchImpl }),
        ),
        users: inMemoryUsers(),
        codeExchange: unusedCodeExchange(),
      },
    });
    apps.push(app);
    await app.ready();

    // HEAD is registered automatically alongside each GET and inherits its exposure.
    const anonymous = app.confappRoutes
      .filter((route) => !route.authenticated && route.method !== 'HEAD')
      .map((route) => `${route.method} ${route.url}`)
      .sort();

    /*
     * Three, and the third is the one that changed the character of this list: S04's
     * `GET /api/display/:token` is confApp's first anonymous route over **domain content**. The
     * other two are bounded by having nothing to give - `/api/health` is deliberately factless and
     * `/api/auth/token` is how a credential is obtained. That one is bounded by the token and the
     * scope instead, which is why its `because` says so at length.
     */
    expect(anonymous).toEqual([
      'GET /api/display/:token',
      'GET /api/health',
      'POST /api/auth/token',
    ]);

    // Every anonymous entry is declared with a written reason, not unwrapped by omission.
    expect(ANONYMOUS_ROUTES.map((route) => `${route.method} ${route.url}`).sort()).toEqual(
      anonymous,
    );
    for (const route of ANONYMOUS_ROUTES) {
      expect(route.because.length).toBeGreaterThan(40);
    }

    // At least one wrapped route, so "everything is anonymous" cannot pass vacuously.
    expect(app.confappRoutes.some((route) => route.authenticated)).toBe(true);
  });

  it('refuses to start when a route is registered without the wrapper', async () => {
    const app = Fastify({ logger: false });
    installRouteAudit(app);

    expect(() => {
      app.get('/api/forgot-to-wrap', async () => ({ oops: true }));
    }).toThrow(UnprotectedRouteError);

    await app.close();
  });

  it('lets a wrapped route register cleanly', async () => {
    const app = Fastify({ logger: false });
    installRouteAudit(app);
    const withAuth = createWithAuth({
      verifier: {
        async verify() {
          return { ok: false, code: 'AUTH_TOKEN_MALFORMED' } as const;
        },
      },
      users: inMemoryUsers(),
    });

    expect(() => {
      app.get(
        '/api/properly-wrapped',
        withAuth(async () => ({ fine: true })),
      );
    }).not.toThrow();

    await app.close();
  });

  it('reports which routes are authenticated', async () => {
    const app = Fastify({ logger: false });
    installRouteAudit(app);
    const withAuth = createWithAuth({
      verifier: {
        async verify() {
          return { ok: false, code: 'AUTH_TOKEN_MALFORMED' } as const;
        },
      },
      users: inMemoryUsers(),
    });

    app.get('/api/health', async () => ({ status: 'ok' }));
    app.get(
      '/api/secret',
      withAuth(async () => ({})),
    );
    await app.ready();

    expect(app.confappRoutes.filter((route) => route.method === 'GET')).toEqual(
      expect.arrayContaining([
        { method: 'GET', url: '/api/health', authenticated: false },
        { method: 'GET', url: '/api/secret', authenticated: true },
      ]),
    );

    await app.close();
  });
});
