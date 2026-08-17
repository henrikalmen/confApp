import type { FastifyBaseLogger } from 'fastify';
import { loadConfig } from './config.ts';
import { createDatabase } from './db.ts';
import { buildApp } from './app.ts';
import { loadAuthConfig } from './auth/config.ts';
import { createDiscovery } from './auth/discovery.ts';
import { createKeyStore } from './auth/jwks.ts';
import { createIdTokenVerifier } from './auth/verify-id-token.ts';
import { createCodeExchange } from './auth/code-exchange.ts';
import { createUserRepository } from './auth/users.ts';

const config = loadConfig();
// Validated before anything starts listening. A missing hosted domain or an empty audience
// allow-list throws here and the process exits – the API must never serve with the domain or
// audience check effectively disabled (ADR-002).
const authConfig = loadAuthConfig();

// The pool is built before the app so the app can be handed its data-access seam, but its
// logging has to reach the app's logger. The holder lets the pool log through the app once
// the app exists; nothing logs before that point.
const logHolder: { logger?: FastifyBaseLogger } = {};
const db = createDatabase(config.databaseUrl, {
  error(detail, message) {
    logHolder.logger?.error(detail, message);
  },
});

const discovery = createDiscovery({ discoveryUrl: authConfig.discoveryUrl });
const keyStore = createKeyStore({ discovery });

const app = buildApp({
  db,
  auth: {
    verifier: createIdTokenVerifier(authConfig, keyStore),
    users: createUserRepository(db),
    codeExchange: createCodeExchange({
      config: authConfig,
      discovery,
      logger: {
        error(detail, message) {
          logHolder.logger?.error(detail, message);
        },
      },
    }),
  },
  loggerOptions: { level: process.env.LOG_LEVEL?.trim() || 'info' },
});
logHolder.logger = app.log;

let shuttingDown = false;

/**
 * A long-running container must drain, not be killed mid-request: SIGTERM stops accepting
 * new connections and lets in-flight requests finish before the process exits, which is what
 * makes a rolling restart or a rollback safe.
 */
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'Signal received; draining in-flight requests.');

  const forceExit = setTimeout(() => {
    app.log.error(
      { timeoutMs: config.shutdownTimeoutMs },
      'Drain exceeded its timeout; exiting without waiting further.',
    );
    process.exit(1);
  }, config.shutdownTimeoutMs);
  forceExit.unref();

  try {
    await app.close();
    await db.close();
    app.log.info('Shutdown complete.');
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, 'Shutdown failed.');
    process.exit(1);
  }
}

process.on('SIGTERM', (signal) => void shutdown(signal));
process.on('SIGINT', (signal) => void shutdown(signal));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error({ err: error }, 'Failed to start the API server.');
  process.exit(1);
}
