import type { FastifyInstance, FastifyReply, FastifyRequest, RouteOptions } from 'fastify';
import { authRefusal, ERROR_CODES } from '../errors.ts';
import type { Verifier } from './verify-id-token.ts';
import type { UserRepository } from './users.ts';

/**
 * The single door every later handler comes through.
 *
 * This is the artefact S03–S09 consume (`plan.json` → sharedDecisions → "Authenticated caller
 * context"). Its shape is pinned: one wrapper, the caller passed as an argument, and no way to
 * reach the handler body without one. A handler cannot forget to authenticate, because there
 * is nothing for it to forget – it simply is not called.
 *
 * `sub` is the join key it hands downstream. `userId` is confApp's own surrogate key for the
 * `app_user` row, carried for local convenience; it is never what a later story keys on.
 * Nothing keys on `email`, ever.
 *
 * The token itself stops here. Neither it nor the `Authorization` header value is logged,
 * returned, or attached to the request for a handler to find – `hd` is carried so a handler
 * can assert the domain without re-parsing anything, and nothing else about the token escapes.
 */

export interface AuthenticatedCaller {
  userId: string;
  sub: string;
  hd: string;
  email: string;
  displayName: string;
}

export type AuthedHandler = (
  request: FastifyRequest,
  caller: AuthenticatedCaller,
) => Promise<unknown>;

export type HttpHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/**
 * Brands a handler as wrapped. A symbol rather than a string property so nothing can set it by
 * accident, and so the route audit below is checking a fact rather than a naming convention.
 */
const WRAPPED = Symbol('confapp.withAuth');

type BrandedHandler = HttpHandler & { [WRAPPED]?: true };

function isWrapped(handler: unknown): boolean {
  return typeof handler === 'function' && (handler as BrandedHandler)[WRAPPED] === true;
}

/** `Bearer <token>` – case-insensitive scheme, exactly one space, non-empty token. */
const BEARER = /^Bearer[ ]+(?<token>[^\s]+)$/i;

export interface WithAuthDependencies {
  verifier: Verifier;
  users: UserRepository;
}

export function createWithAuth({ verifier, users }: WithAuthDependencies) {
  return function withAuth(handler: AuthedHandler): HttpHandler {
    const wrapped: BrandedHandler = async (request, _reply) => {
      const header = request.headers.authorization;
      if (header === undefined || header.trim() === '') {
        throw authRefusal(ERROR_CODES.AUTH_CREDENTIAL_MISSING);
      }

      const match = BEARER.exec(header.trim());
      const token = match?.groups?.token;
      if (token === undefined) {
        throw authRefusal(ERROR_CODES.AUTH_CREDENTIAL_MALFORMED);
      }

      const result = await verifier.verify(token);
      if (!result.ok) {
        // Only the code travels. The token that failed is never echoed or logged.
        throw authRefusal(result.code);
      }

      // Verified, and only now: the user row is touched after the domain check, never before.
      const user = await users.upsertFromClaims(result.claims);

      const caller: AuthenticatedCaller = {
        userId: user.id,
        sub: user.sub,
        hd: result.claims.hd,
        email: user.email,
        displayName: user.displayName,
      };

      return handler(request, caller);
    };

    wrapped[WRAPPED] = true;
    // `reply` is part of the wrapper's contract with Fastify, not with the inner handler.
    return wrapped;
  };
}

export type WithAuth = ReturnType<typeof createWithAuth>;

/**
 * Routes that answer without a credential, and the reason each one is allowed to.
 *
 * This list is the whole anonymous surface of the API. It is a literal, so adding to it is a
 * visible edit to a reviewed file rather than the silent side effect of registering a route
 * and forgetting the wrapper.
 */
export const ANONYMOUS_ROUTES: readonly { method: string; url: string; because: string }[] = [
  {
    method: 'GET',
    url: '/api/health',
    because:
      'Deployment health and readiness (S13). Container-platform probes cannot present an ' +
      'OIDC token, so this route is anonymous by decision and stays that way.',
  },
  {
    method: 'POST',
    url: '/api/auth/token',
    because:
      'The sign-in code exchange. It is how a caller *obtains* a credential, so requiring one ' +
      'would make sign-in impossible. It is not a trust decision: it verifies the resulting ' +
      'ID token through the same module every other route does before answering.',
  },
];

function isAnonymous(method: string, url: string): boolean {
  return ANONYMOUS_ROUTES.some(
    // HEAD is registered automatically alongside GET and inherits the same exposure.
    (route) =>
      route.url === url &&
      (route.method === method || (route.method === 'GET' && method === 'HEAD')),
  );
}

export class UnprotectedRouteError extends Error {
  constructor(method: string, url: string) {
    super(
      `Route ${method} ${url} is registered without withAuth and is not on the anonymous ` +
        'allow-list. Wrap it with withAuth, or add it to ANONYMOUS_ROUTES with a written ' +
        'reason. Refusing to start rather than serving an unauthenticated route.',
    );
    this.name = 'UnprotectedRouteError';
  }
}

export interface AuditedRoute {
  method: string;
  url: string;
  authenticated: boolean;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Every route registered on this instance and whether it goes through `withAuth`. */
    confappRoutes: AuditedRoute[];
  }
}

/**
 * Fails startup on any route that is neither wrapped nor explicitly anonymous, and records the
 * route table as it goes.
 *
 * A test asserting the table would catch an unwrapped route too, but only if someone
 * remembered to update the test. This catches it at registration, in every environment,
 * including the one where a later story adds a route and runs the app before the suite. The
 * recorded table is then what that assertion reads, so the test and the guard cannot disagree.
 *
 * Install this **before** registering any route – the hook only sees what follows it.
 */
export function installRouteAudit(app: FastifyInstance): void {
  const routes: AuditedRoute[] = [];
  app.decorate('confappRoutes', routes);

  app.addHook('onRoute', (route: RouteOptions) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      // Fastify's own CORS/plumbing verb is not an application route.
      if (method === 'OPTIONS') continue;

      const authenticated = isWrapped(route.handler);
      routes.push({ method, url: route.url, authenticated });

      if (authenticated) continue;
      if (isAnonymous(method, route.url)) continue;
      throw new UnprotectedRouteError(method, route.url);
    }
  });
}
