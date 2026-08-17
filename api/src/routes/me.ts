import type { FastifyInstance } from 'fastify';
import type { WithAuth } from '../auth/with-auth.ts';

/**
 * `GET /api/me` – who the API believes is calling.
 *
 * The first route to go through `withAuth`, and the one that makes Acceptance Scenario S01
 * true end to end: after sign-in, the SPA's next API call carries the ID token and is
 * accepted. It also gives the deployed system a way to demonstrate the domain refusal against
 * a running API rather than only in unit tests.
 *
 * It answers *who is calling* and nothing more. Per-conference roles and every other
 * "what may they do" question belong to S07.
 */
export function registerMeRoute(app: FastifyInstance, withAuth: WithAuth): void {
  app.get(
    '/api/me',
    withAuth(async (_request, caller) => ({
      // `sub` is the identity every later story joins on; `userId` is confApp's own surrogate
      // key, exposed because the caller context carries it, not as an alternative join key.
      sub: caller.sub,
      userId: caller.userId,
      email: caller.email,
      displayName: caller.displayName,
      hd: caller.hd,
    })),
  );
}
