import pg from 'pg';
import { databaseUnavailable } from './errors.ts';

/**
 * A PostgreSQL `date` reaches JS as the 'YYYY-MM-DD' string it is, not as a Date.
 *
 * By default the driver parses oid 1082 into a Date at **local** midnight, which then serialises
 * to an instant – so a conference starting 2026-09-14 leaves the API as 2026-09-13T22:00:00Z for
 * anyone east of UTC. Conference dates are naive calendar days end to end (S03), so the coercion
 * is disabled once, here, at the only place the driver is configured. Doing it per query would
 * leave the next story's SELECT to remember, and a day-boundary shift is invisible until it is
 * in front of an attendee.
 */
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

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

/** Anything a statement can be issued against – the pool, or one client inside a transaction. */
export interface Queryable {
  query<T extends pg.QueryResultRow>(text: string, values?: readonly unknown[]): Promise<T[]>;
}

export interface Database extends Queryable {
  /**
   * Runs `work` against a single client inside one transaction, committing on return and
   * rolling back on throw.
   *
   * Handed a `Queryable` rather than the Database so nothing inside a transaction can start a
   * nested one on a different client – the classic way three "atomic" writes turn out to have
   * been two.
   */
  transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T>;
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

    async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
      let client: pg.PoolClient;
      try {
        client = await pool.connect();
      } catch (error) {
        if (isUnavailable(error)) {
          logger.error({ err: error }, 'PostgreSQL is unreachable.');
          throw databaseUnavailable();
        }
        throw error;
      }

      try {
        await client.query('begin');
        const result = await work({
          async query<T2 extends pg.QueryResultRow>(
            text: string,
            values: readonly unknown[] = [],
          ): Promise<T2[]> {
            const rows = await client.query<T2>(text, values as unknown[]);
            return rows.rows;
          },
        });
        await client.query('commit');
        return result;
      } catch (error) {
        // A rollback that itself fails must not replace the error that caused it – that error is
        // the one the caller needs, and the client is released regardless either way.
        await client.query('rollback').catch(() => undefined);
        if (isUnavailable(error)) {
          logger.error({ err: error }, 'PostgreSQL is unreachable.');
          throw databaseUnavailable();
        }
        throw error;
      } finally {
        client.release();
      }
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}
