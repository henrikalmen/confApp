import './setup.ts';
import pg from 'pg';
import { buildApp } from '../src/app.ts';
import { createDatabase } from '../src/db.ts';
import { createUserRepository } from '../src/auth/users.ts';
import { fixedClock } from '../src/conferences/calendar-date.ts';
import { subjectVerifier, tokenFor, unusedCodeExchange } from './fake-auth.ts';

/**
 * One authoring or reading of a Session, in a process whose timezone is stated on the command
 * line. Prints a single JSON line on stdout and nothing else.
 *
 * **Why a child process rather than a mock.** The coercion this story exists to prevent happens
 * inside the driver and inside `Date`, both of which read the process timezone once. A test that
 * stubbed a formatter would prove that the stub was not called; only genuinely running the whole
 * DB → API → JSON path under `TZ=Asia/Tokyo` can show that a Session authored at 09:00 is still
 * 09:00 there. Node reads `TZ` at start, so "under a different timezone" means a new process.
 *
 *   node api/test/wall-clock-probe.ts author
 *   node api/test/wall-clock-probe.ts read <conferenceId>
 */

const ORGANIZER = 'google-sub-ida';

const AUTUMN = { name: 'Autumn Offsite', startDate: '2026-09-15', endDate: '2026-09-16' };

const KEYNOTE = {
  title: 'Opening Keynote',
  description: 'How the year went.',
  kind: 'Presentation',
  day: '2026-09-15',
  startTime: '09:00',
  endTime: '10:30',
  location: 'Main Hall',
};

const url = process.env.TEST_DATABASE_URL;
if (url === undefined) {
  console.error('TEST_DATABASE_URL is not set.');
  process.exit(2);
}

const [, , mode, conferenceIdArgument] = process.argv;

const db = createDatabase(url, { error: () => {} });
const client = new pg.Client({ connectionString: url });
await client.connect();

const app = buildApp({
  db,
  auth: {
    verifier: subjectVerifier(),
    users: createUserRepository(db),
    codeExchange: unusedCodeExchange(),
  },
  clock: fixedClock('2026-09-15'),
});

const headers = { authorization: `Bearer ${tokenFor(ORGANIZER)}` };

interface Probe {
  /** The timezone this process actually ran under, so the harness can prove it took effect. */
  timezone: string;
  /** The offset that timezone applies, in minutes – non-zero for every case that matters. */
  offsetMinutes: number;
  conferenceId: string;
  /** The response body exactly as it left the server, before anything parsed it. */
  rawBody: string;
  session: Record<string, unknown>;
  /** What the columns themselves hold, cast to text inside PostgreSQL. */
  stored?: Record<string, string>;
}

function environment(): Pick<Probe, 'timezone' | 'offsetMinutes'> {
  return {
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    // Negated so it reads the way people say it: UTC+9 is +540, UTC-7 is -420.
    offsetMinutes: -new Date('2026-09-15T09:00:00Z').getTimezoneOffset(),
  };
}

try {
  if (mode === 'author') {
    const created = await app.inject({
      method: 'POST',
      url: '/api/conferences',
      headers,
      payload: AUTUMN,
    });
    if (created.statusCode !== 200) throw new Error(`create conference: ${created.body}`);
    const conferenceId = created.json().id as string;

    const saved = await app.inject({
      method: 'POST',
      url: `/api/conferences/${conferenceId}/sessions`,
      headers,
      payload: KEYNOTE,
    });
    if (saved.statusCode !== 200) throw new Error(`create session: ${saved.body}`);

    const stored = await client.query(
      `select day::text as day, start_time::text as start_time, end_time::text as end_time
         from sessions where conference_id = $1`,
      [conferenceId],
    );

    const probe: Probe = {
      ...environment(),
      conferenceId,
      rawBody: saved.body,
      session: saved.json().session as Record<string, unknown>,
      stored: stored.rows[0] as Record<string, string>,
    };
    process.stdout.write(JSON.stringify(probe));
  } else if (mode === 'read') {
    if (conferenceIdArgument === undefined) throw new Error('read needs a conference id');

    const schedule = await app.inject({
      method: 'GET',
      url: `/api/conferences/${conferenceIdArgument}/schedule/organizer`,
      headers,
    });
    if (schedule.statusCode !== 200) throw new Error(`read schedule: ${schedule.body}`);

    const days = schedule.json().days as { day: string; sessions: Record<string, unknown>[] }[];
    const session = days.flatMap((entry) => entry.sessions)[0];
    if (session === undefined) throw new Error('the schedule carried no session');

    const probe: Probe = {
      ...environment(),
      conferenceId: conferenceIdArgument,
      rawBody: schedule.body,
      session,
    };
    process.stdout.write(JSON.stringify(probe));
  } else {
    throw new Error(`unknown mode "${mode}"; use "author" or "read <conferenceId>"`);
  }
} finally {
  await app.close();
  await client.end();
  await db.close();
}
