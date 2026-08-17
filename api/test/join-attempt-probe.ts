import './setup.ts';
import { buildApp } from '../src/app.ts';
import { createDatabase } from '../src/db.ts';
import { createUserRepository } from '../src/auth/users.ts';
import { fixedClock } from '../src/conferences/calendar-date.ts';
import { createFailedJoinAttempts } from '../src/conferences/failed-join-attempts.ts';
import { subjectVerifier, tokenFor, unusedCodeExchange } from './fake-auth.ts';

/**
 * One failed join attempt, made by a **separate API process** against the shared database, printing
 * what the store then holds for that `sub`.
 *
 * **Why a child process rather than a second `buildApp` in the same test.** The defect this guards
 * against is a counter kept in module, static or per-instance scope. Two app instances inside one
 * Node process still share module state, so an in-process counter would pass such a test and
 * enforce nothing across replicas – which is the only configuration production runs in (ADR-004).
 * A fresh process has no module state to inherit, so the total this prints can only have come from
 * PostgreSQL.
 *
 *   node api/test/join-attempt-probe.ts <sub> <code>
 */

const url = process.env.TEST_DATABASE_URL;
if (url === undefined) {
  console.error('TEST_DATABASE_URL is not set.');
  process.exit(2);
}

const [, , sub, code] = process.argv;
if (sub === undefined || code === undefined) {
  console.error('Usage: join-attempt-probe.ts <sub> <code>');
  process.exit(2);
}

const db = createDatabase(url, { error: () => {} });

const app = buildApp({
  db,
  auth: {
    verifier: subjectVerifier(),
    users: createUserRepository(db),
    codeExchange: unusedCodeExchange(),
  },
  clock: fixedClock('2026-09-15'),
});

interface Probe {
  /** This process's own id, so the harness can prove it really was a different one. */
  pid: number;
  status: number;
  errorCode: string | null;
  /** What the store holds for this `sub` afterwards, read back through the same module. */
  attempts: number;
}

try {
  const response = await app.inject({
    method: 'POST',
    url: '/api/join',
    headers: { authorization: `Bearer ${tokenFor(sub)}` },
    payload: { code },
  });

  const { attempts } = await createFailedJoinAttempts(db).window(sub);

  const probe: Probe = {
    pid: process.pid,
    status: response.statusCode,
    errorCode: (response.json() as { error?: { code?: string } }).error?.code ?? null,
    attempts,
  };
  process.stdout.write(JSON.stringify(probe));
} finally {
  await app.close();
  await db.close();
}
