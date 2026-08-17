import pg from 'pg';
import { databaseUnavailable } from './errors.ts';

/**
 * The one pooled data-access seam every handler reaches PostgreSQL through.
 *
 * The pool is created once at startup and reused for the life of the process. That is a
 * reusable *resource*, not request state: nothing derived from a request – parsed input,
 * computed results, counters, per-caller caches – is retained here between requests
 * (`AGENTS.md#do-not--never`). The API scales horizontally across replicas, so anything
 * remembered in process would be wrong on the next replica anyway.
 */

/** errno values pg surfaces when the server cannot be reached at all. */
const CONNECTION_ERRNOS = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ECONNRESET',
  'EPIPE',
  'EAI_AGAIN',
]);

/** PostgreSQL SQLSTATE classes meaning "the server is up but cannot serve us". */
const UNAVAILABLE_SQLSTATES = new Set([
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
  '08000', // connection_exception
  '08003', // connection_does_not_exist
  '08006', // connection_failure
]);

function isUnavailable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== 'string') return false;
  return CONNECTION_ERRNOS.has(code) || UNAVAILABLE_SQLSTATES.has(code);
}

export interface Database {
  query<T extends pg.QueryResultRow>(text: string, values?: readonly unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

export interface DatabaseLogger {
  error(detail: unknown, message: string): void;
}

export function createDatabase(connectionString: string, logger: DatabaseLogger): Database {
  const pool = new pg.Pool({ connectionString });

  // An idle client failing (database restarted, network blip) emits on the pool. Without
  // this listener Node treats it as an unhandled 'error' event and kills the process – the
  // API must stay up and keep serving, refusing with DATABASE_UNAVAILABLE instead.
  pool.on('error', (error) => {
    logger.error({ err: error }, 'Idle PostgreSQL client errored; the pool will replace it.');
  });

  return {
    async query<T extends pg.QueryResultRow>(
      text: string,
      values: readonly unknown[] = [],
    ): Promise<T[]> {
      try {
        const result = await pool.query<T>(text, values as unknown[]);
        return result.rows;
      } catch (error) {
        if (isUnavailable(error)) {
          // Log the driver detail server-side; the caller gets a message with none of it.
          logger.error({ err: error }, 'PostgreSQL is unreachable.');
          throw databaseUnavailable();
        }
        throw error;
      }
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}
