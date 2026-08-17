import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.ts';
import { databaseNotMigrated } from '../errors.ts';

/**
 * `GET /api/health` – liveness and readiness.
 *
 * This route is **permanently unauthenticated by design**. S13 needs a health/readiness
 * signal per service and container-platform probes cannot present an OIDC token, so S02
 * authenticates every other route and leaves this one open. The cost is bounded by keeping
 * the payload to liveness/readiness facts only: it must never grow domain, personal, or
 * configuration data.
 */

interface HealthQuery {
  verbose?: 'true' | 'false';
}

const healthQuerySchema = {
  type: 'object',
  properties: {
    verbose: {
      type: 'string',
      enum: ['true', 'false'],
    },
  },
} as const;

interface AppMetaRow {
  value: string;
}

/** PostgreSQL `undefined_table`. */
const UNDEFINED_TABLE = '42P01';

/**
 * Readiness, not a defect: before migrate-up has run – on a first bring-up, or after a
 * `docker compose down -v` – app_meta does not exist yet. This is deliberately handled here
 * rather than in the shared error mapping, so a mistyped table name in a later story still
 * surfaces as INTERNAL_ERROR instead of being disguised as an outage.
 */
function isMissingSchema(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === UNDEFINED_TABLE
  );
}

export function registerHealthRoute(app: FastifyInstance, db: Database): void {
  app.get<{ Querystring: HealthQuery }>(
    '/api/health',
    { schema: { querystring: healthQuerySchema } },
    async (request) => {
      // Read per request; nothing from a previous request influences this one.
      const startedAt = process.hrtime.bigint();
      let rows: AppMetaRow[];
      try {
        rows = await db.query<AppMetaRow>('select value from app_meta where key = $1', [
          'schema_version',
        ]);
      } catch (error) {
        if (isMissingSchema(error)) throw databaseNotMigrated();
        throw error;
      }
      const queryMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

      const schemaVersion = rows[0]?.value ?? null;
      const verbose = request.query.verbose === 'true';

      return {
        status: 'ok',
        schemaVersion,
        serverTime: new Date().toISOString(),
        ...(verbose
          ? {
              database: {
                reachable: true,
                queryDurationMs: Math.round(queryMs * 1000) / 1000,
              },
              uptimeSeconds: Math.round(process.uptime()),
            }
          : {}),
      };
    },
  );
}
