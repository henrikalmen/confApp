import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import { AppError, internalError, routeNotFound } from './errors.ts';
import { toValidationError } from './validation.ts';
import { registerHealthRoute } from './routes/health.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerMeRoute } from './routes/me.ts';
import { registerConferenceRoutes } from './routes/conferences.ts';
import { registerSessionRoutes } from './routes/sessions.ts';
import { registerJoinCodeRoutes } from './routes/join-code.ts';
import { registerAttendeeRoutes } from './routes/attendee.ts';
import { createFailedJoinAttempts } from './conferences/failed-join-attempts.ts';
import { createWithAuth, installRouteAudit } from './auth/with-auth.ts';
import { createConferenceAuthorization } from './conferences/authorization.ts';
import { createConferenceRepository } from './conferences/conference-repository.ts';
import { createScheduleGate, type ScheduleGate } from './conferences/schedule-gate.ts';
import { createSessionRepository } from './sessions/session-repository.ts';
import { systemClock, type Clock } from './conferences/calendar-date.ts';
import { generateJoinCode, type JoinCodeMinter } from './conferences/join-code.ts';
import type { Verifier } from './auth/verify-id-token.ts';
import type { UserRepository } from './auth/users.ts';
import type { CodeExchange } from './auth/code-exchange.ts';
import type { Database } from './db.ts';

/**
 * Installs the error envelope on an instance: the catch-all for unknown routes and the
 * single exit through which every refusal leaves the server. Exported separately from
 * `buildApp` so the envelope can be exercised in isolation against arbitrary routes.
 */
export function installErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0] ?? request.url;
    const error = routeNotFound(request.method, path);
    void reply.status(error.statusCode).send(error.toEnvelope());
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    // Schema validation ran before the handler, so nothing downstream has executed.
    if (error.validation) {
      const refusal = toValidationError(error.validation);
      void reply.status(refusal.statusCode).send(refusal.toEnvelope());
      return;
    }

    if (error instanceof AppError) {
      void reply.status(error.statusCode).send(error.toEnvelope());
      return;
    }

    // Anything unanticipated is logged in full server-side and reported generically –
    // no exception message, driver text, or stack reaches the caller.
    request.log.error({ err: error }, 'Unhandled error while serving a request.');
    const refusal = internalError();
    void reply.status(refusal.statusCode).send(refusal.toEnvelope());
  });
}

/**
 * Everything the API needs to answer "who is calling". Injected rather than constructed here
 * so a test can drive the wrapper with locally-signed fixtures instead of reaching Google.
 */
export interface AuthDependencies {
  verifier: Verifier;
  users: UserRepository;
  codeExchange: CodeExchange;
}

export interface BuildAppOptions {
  db: Database;
  auth: AuthDependencies;
  /**
   * Whether a Conference has a Session yet. Production binds the real count over the `sessions`
   * table (S04 TI11); a test may still state the answer where the subject is the lifecycle rule
   * rather than the count itself.
   */
  scheduleGate?: ScheduleGate;
  /** The server's calendar date. Pinned by tests so the archive boundary can be stated. */
  clock?: Clock;
  /**
   * How a Join Code is minted. Production draws from the ambiguity-free alphabet; a test may pin
   * the value so a scenario can name the code an employee types (S05 TI02).
   */
  mintJoinCode?: JoinCodeMinter;
  loggerOptions?: FastifyServerOptions['logger'];
}

export function buildApp({
  db,
  auth,
  scheduleGate,
  clock = systemClock,
  mintJoinCode = generateJoinCode,
  loggerOptions = false,
}: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: loggerOptions });

  installErrorHandling(app);
  // Before any route is registered: the audit refuses startup for a route that is neither
  // wrapped nor on the written anonymous allow-list, so a later story cannot add an
  // unauthenticated route by forgetting the wrapper.
  installRouteAudit(app);

  const withAuth = createWithAuth({ verifier: auth.verifier, users: auth.users });

  registerHealthRoute(app, db);
  registerAuthRoutes(app, {
    codeExchange: auth.codeExchange,
    verifier: auth.verifier,
    users: auth.users,
  });
  registerMeRoute(app, withAuth);

  const conferences = createConferenceRepository(db, mintJoinCode);
  const authorization = createConferenceAuthorization(db);

  registerConferenceRoutes(app, {
    withAuth,
    repository: conferences,
    authorization,
    scheduleGate: scheduleGate ?? createScheduleGate(db),
    clock,
  });
  const sessions = createSessionRepository(db);

  registerSessionRoutes(app, {
    withAuth,
    conferences,
    sessions,
    authorization,
  });
  // The Attendee's read surface (S06) – a different result set from the Organizer's on both of its
  // routes, which is why it is registered separately rather than folded into the two above.
  registerAttendeeRoutes(app, {
    withAuth,
    conferences,
    sessions,
    authorization,
    clock,
  });
  registerJoinCodeRoutes(app, {
    withAuth,
    repository: conferences,
    authorization,
    // The limiter's counter is a table, not this object: nothing is retained here between requests,
    // so several replicas share one total (ADR-004).
    failedAttempts: createFailedJoinAttempts(db),
    clock,
  });

  return app;
}
