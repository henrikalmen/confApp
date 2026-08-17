import type { Database } from '../src/db.ts';

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

  return {
    calls,
    async query<T extends Record<string, unknown>>(
      text: string,
      values: readonly unknown[] = [],
    ): Promise<T[]> {
      calls.push({ text, values });
      return respond(text, values) as T[];
    },
    async close(): Promise<void> {},
  };
}
