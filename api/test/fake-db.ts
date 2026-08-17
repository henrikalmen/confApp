import type { Database, Queryable } from '../src/db.ts';

export interface FakeDatabase extends Database {
  /** Every query the code under test issued, in order. Lets a test prove none was issued. */
  readonly calls: { text: string; values: readonly unknown[] }[];
}

/**
 * A Database stand-in that records what it was asked for. Used only where the assertion is
 * about *whether* a query happened (S03) or about how a failure propagates; the behaviour of
 * the real SQL is covered by the integration tests against PostgreSQL.
 */
export function fakeDatabase(
  respond: (text: string, values: readonly unknown[]) => unknown[] = () => [{ value: '1' }],
): FakeDatabase {
  const calls: { text: string; values: readonly unknown[] }[] = [];

  const queryable: Queryable = {
    async query<T extends Record<string, unknown>>(
      text: string,
      values: readonly unknown[] = [],
    ): Promise<T[]> {
      calls.push({ text, values });
      return respond(text, values) as T[];
    },
  };

  return {
    calls,
    query: queryable.query,
    // No transaction semantics to fake: the assertions this stand-in serves are about *which*
    // statements were issued. Whether they commit atomically is a property of real PostgreSQL
    // and is proved against it in the integration suite, never here.
    async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
      return work(queryable);
    },
    async close(): Promise<void> {},
  };
}
