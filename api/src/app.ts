import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import { AppError, internalError, routeNotFound } from './errors.ts';
import { toValidationError } from './validation.ts';
import { registerHealthRoute } from './routes/health.ts';
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

export interface BuildAppOptions {
  db: Database;
  loggerOptions?: FastifyServerOptions['logger'];
}

export function buildApp({ db, loggerOptions = false }: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: loggerOptions });

  installErrorHandling(app);
  registerHealthRoute(app, db);

  return app;
}
