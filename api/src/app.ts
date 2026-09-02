import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';
import { AppError, internalError, malformedRequestUrl, routeNotFound } from './errors.ts';
import { displayLinkUnavailable } from './rounds/display-link.ts';
import { toValidationError } from './validation.ts';
import { registerHealthRoute } from './routes/health.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerMeRoute } from './routes/me.ts';
import { registerConferenceRoutes } from './routes/conferences.ts';
import { registerSessionRoutes } from './routes/sessions.ts';
import { registerRoundRoutes } from './routes/rounds.ts';
import { isDisplayPath, redactDisplayToken, registerDisplayRoute } from './routes/display.ts';
import { registerJoinCodeRoutes } from './routes/join-code.ts';
import { registerAttendeeRoutes } from './routes/attendee.ts';
import { registerMemberRoutes } from './routes/members.ts';
import { createFailedJoinAttempts } from './conferences/failed-join-attempts.ts';
import { createWithAuth, installRouteAudit } from './auth/with-auth.ts';
import { createConferenceAuthorization } from './conferences/authorization.ts';
import { createConferenceRepository } from './conferences/conference-repository.ts';
import { createRoleRepository } from './conferences/role-repository.ts';
import { createMembershipRepository } from './conferences/membership-repository.ts';
import { createScheduleGate, type ScheduleGate } from './conferences/schedule-gate.ts';
import { createSessionRepository } from './sessions/session-repository.ts';
import { createRoundRepository } from './rounds/round-repository.ts';
import { createPostItRepository } from './rounds/post-it-repository.ts';
import { createPostItDiscardRepository } from './rounds/post-it-discard-repository.ts';
import { createPermanentRemovalRepository } from './rounds/permanent-removal-repository.ts';
import { createCategoryRepository } from './rounds/category-repository.ts';
import { createDisplayLinkRepository } from './rounds/display-link-repository.ts';
import { createVoteRepository } from './votes/vote-repository.ts';
import { createBallotGate, type BallotGate } from './rounds/ballot-gate.ts';
import { systemClock, type Clock } from './conferences/calendar-date.ts';
import { generateJoinCode, type JoinCodeMinter } from './conferences/join-code.ts';
import { mintDisplayToken, type DisplayTokenMinter } from './rounds/display-link.ts';
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
    /*
     * **Anything under the Display Link prefix answers the one neutral sentence, never the
     * route-not-found one** (S04; review 2026-08-31, M1).
     *
     * `routeNotFound` builds its message from the path, which is helpful everywhere else and
     * actively wrong here: the path *is* a bearer credential. A `POST`, a `PUT`, a `DELETE` or a
     * trailing slash misses the single registered `GET /api/display/:token` route and would
     * otherwise put the token back into a response body - the shape most likely to be captured by
     * client-side error reporting and by proxies that log bodies but not paths - after this story
     * went to real lengths to keep it out of the request line and out of the query string
     * (Structural Criterion 4).
     *
     * It collapses the trailing-slash divergence into the same answer too, which is the property
     * this surface cares about most: every shape of every dead request under this prefix is one
     * indistinguishable refusal.
     */
    if (isDisplayPath(request.url)) {
      const refusal = displayLinkUnavailable();
      void reply
        .header('cache-control', 'no-store')
        .status(refusal.statusCode)
        .send(refusal.toEnvelope());
      return;
    }

    const error = routeNotFound(request.method);
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
  /**
   * Whether a Round has a Vote yet – the Poll-freeze rule's only question (S01 TI04).
   *
   * Production binds the real `exists` check over the ballot table (S03 TI08). Injectable still, so
   * a test whose subject is the freeze *rule* rather than the ballot storage can bind a port that
   * answers `true` without casting a Vote first.
   */
  ballotGate?: BallotGate;
  /** The server's calendar date. Pinned by tests so the archive boundary can be stated. */
  clock?: Clock;
  /**
   * How a Join Code is minted. Production draws from the ambiguity-free alphabet; a test may pin
   * the value so a scenario can name the code an employee types (S05 TI02).
   */
  mintJoinCode?: JoinCodeMinter;
  /**
   * How a Display Link's value is minted. Production draws 32 bytes from the CSPRNG; a test pins it
   * so a scenario can name the token it then opens anonymously (S04 TI02).
   */
  mintDisplayLinkToken?: DisplayTokenMinter;
  loggerOptions?: FastifyServerOptions['logger'];
}

/**
 * The logger options, with the Display Link token taken out of every request line.
 *
 * Fastify's default request serializer records `req.url`, so the bearer credential the anonymous
 * route is guarded by would otherwise be written to the log on **every poll from every room
 * machine** – several times a minute, for the length of a conference, in the one place nobody
 * thinks to look for credentials. This is the same discipline `withAuth` already applies to the
 * `Authorization` header, which it neither logs nor attaches to the request for a handler to find.
 *
 * Applied here rather than in `index.ts` so a test builds an app with the guarantee already on it,
 * and so no future entry point can construct the app without it.
 *
 * Every other field Fastify's own serializer records is kept, deliberately: this exists to remove
 * one credential from one path, not to quietly reduce what an operator can see about every request.
 */
type LoggerOptions = Exclude<FastifyServerOptions['logger'], undefined>;

interface LoggableRequest {
  method: string;
  url: string;
  host?: string;
  socket?: { remoteAddress?: string; remotePort?: number };
}

function withTokenRedaction(loggerOptions: LoggerOptions): LoggerOptions {
  if (loggerOptions === false) return loggerOptions;
  /*
   * `true` is Fastify's idiomatic "log with defaults", and it used to take an early return here -
   * which installed no serializer and wrote the full URL, token included, on every poll. A
   * one-word edit in a future entry point was all it would have taken, which is the same class of
   * silent bypass `installRouteAudit` exists to prevent for routes (review 2026-08-31, L4).
   */
  const base = loggerOptions === true ? {} : loggerOptions;

  return {
    ...base,
    serializers: {
      ...(base as { serializers?: Record<string, unknown> }).serializers,
      req(request: LoggableRequest) {
        return {
          method: request.method,
          url: redactDisplayToken(request.url),
          host: request.host,
          remoteAddress: request.socket?.remoteAddress,
          remotePort: request.socket?.remotePort,
        };
      },
    },
  } as LoggerOptions;
}

export function buildApp({
  db,
  auth,
  scheduleGate,
  ballotGate,
  clock = systemClock,
  mintJoinCode = generateJoinCode,
  mintDisplayLinkToken = mintDisplayToken,
  loggerOptions = false,
}: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger: withTokenRedaction(loggerOptions),
    /*
     * Errors find-my-way raises **before** any route is dispatched.
     *
     * A percent-malformed path (`/api/display/%zz`) is rejected by the router itself, so neither a
     * handler nor `setNotFoundHandler` ever runs, and Fastify answers in *its own* shape:
     * `400 {"error":"Bad Request","code":"FST_ERR_BAD_URL","message":"'/api/display/%zz' is not a
     * valid url component"}`. Two things are wrong with that (review 2026-08-31, finding 3).
     *
     * It escapes the single envelope every client parses - `errors.ts` calls itself "the single
     * exit through which every refusal leaves the server", and this was the one door around it.
     * And under the Display Link prefix it was a **seventh** answer, differing in status, code,
     * message, headers and shape from the six this story made byte-identical, while echoing the
     * requested path - the same leak the not-found branch closes.
     */
    frameworkErrors: (error: unknown, request: FastifyRequest, reply: FastifyReply) => {
      if (isDisplayPath(request.url)) {
        const refusal = displayLinkUnavailable();
        void reply
          .header('cache-control', 'no-store')
          .status(refusal.statusCode)
          .send(refusal.toEnvelope());
        return;
      }

      // Everywhere else: the shared envelope, saying only that the request could not be read.
      // The offending URL is not echoed - it is attacker-controlled and of no use to a caller
      // who already sent it.
      request.log.warn({ err: error }, 'A request could not be routed.');
      const refusal = malformedRequestUrl();
      void reply.status(refusal.statusCode).send(refusal.toEnvelope());
    },
  });

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

  const sessions = createSessionRepository(db);

  registerConferenceRoutes(app, {
    withAuth,
    repository: conferences,
    // S09's date-span edit has to know which Sessions a shortened span would strand, so the
    // Conference routes read the schedule as well now. Reading only – Sessions stay S04's.
    sessions,
    authorization,
    scheduleGate: scheduleGate ?? createScheduleGate(db),
    clock,
  });

  registerSessionRoutes(app, {
    withAuth,
    conferences,
    sessions,
    authorization,
  });
  // The Session Activities surface (S01): Rounds authored on a Session, run live, and read by every
  // Conference Member in one request. Registered beside the schedule routes because it is the same
  // resource seen from the room rather than from the composition view.
  const roundRepository = createRoundRepository(db);
  const postItRepository = createPostItRepository(db);
  const discardRepository = createPostItDiscardRepository(db);
  const permanentRemovalRepository = createPermanentRemovalRepository(db);
  const categoryRepository = createCategoryRepository(db);
  const displayLinks = createDisplayLinkRepository(db);

  registerRoundRoutes(app, {
    withAuth,
    conferences,
    sessions,
    rounds: roundRepository,
    postIts: postItRepository,
    categories: categoryRepository,
    votes: createVoteRepository(db),
    authorization,
    ballotGate: ballotGate ?? createBallotGate(),
    discards: discardRepository,
    permanentRemovals: permanentRemovalRepository,
    displayLinks,
    mintDisplayLinkToken,
  });
  /*
   * The projected Board's data path (S04) – confApp's **third** anonymous route and the first over
   * domain content. Registered as its own module rather than folded into the Round routes above,
   * because that module legitimately imports the vote repository and this one may reach no vote
   * table by any path (ADR-006). The Board projection they share lives in `rounds/board-wire.ts`
   * for exactly that reason, and no `RoundRepository` is passed here at all - that seam hydrates a
   * Round's `round_option` rows, so reaching the prompt through it would put the Poll's option
   * table on this route's graph.
   */
  registerDisplayRoute(app, {
    postIts: postItRepository,
    categories: categoryRepository,
    displayLinks,
    clock,
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
  // The Admin's member-and-roles surface (S07), and the two endpoints that end a Membership (S08).
  // S03 seeds the creator's row and S05's join endpoint writes the rest; leaving and removal are
  // the only paths that delete one, and both go through the single revocation operation below.
  registerMemberRoutes(app, {
    withAuth,
    conferences,
    sessions,
    roles: createRoleRepository(db),
    membership: createMembershipRepository(db),
    users: auth.users,
    authorization,
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
