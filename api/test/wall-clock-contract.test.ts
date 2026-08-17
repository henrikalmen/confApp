import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { createDatabase, type Database } from '../src/db.ts';

/**
 * TI10 – the contract suite pinning the two shared decisions S06, S09 and S10 build on.
 *
 * These are guard rails rather than feature tests. Both produced contracts are consumed by three
 * later stories, and both fail *silently*: a UTC round trip shows the right time on the developer's
 * machine and the wrong one in Los Angeles, and a truncated timestamp compares equal to the value
 * it should have differed from. Neither would be caught by a test of the feature that introduced
 * it, so they are asserted here, on purpose, as their own suite.
 *
 * The suite must fail if a later story routes a schedule time through a `Date`, truncates a
 * timestamp to milliseconds, or lets `conference.updated_at` move on a Session write.
 */

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const apiSrc = join(here, '..', 'src');
const webSrc = join(repoRoot, 'web', 'src');
const testDatabaseUrl = process.env.TEST_DATABASE_URL;

async function serverReachable(url: string): Promise<boolean> {
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

const reachable = testDatabaseUrl !== undefined && (await serverReachable(testDatabaseUrl));

if (!reachable) {
  console.warn(
    '\n[integration] SKIPPED wall-clock contract – no PostgreSQL at TEST_DATABASE_URL.\n' +
      '[integration] Start the stack first: docker compose up -d\n',
  );
}

async function migrate(...args: string[]): Promise<void> {
  await run(process.execPath, [join(repoRoot, 'db', 'migrate.mjs'), ...args], {
    cwd: join(repoRoot, 'db'),
    env: { ...process.env, DATABASE_URL: testDatabaseUrl },
  });
}

interface Probe {
  timezone: string;
  offsetMinutes: number;
  conferenceId: string;
  rawBody: string;
  session: Record<string, string>;
  stored?: Record<string, string>;
}

/** Runs the probe in a fresh process whose `TZ` is what Node reads at start-up. */
async function probe(timezone: string, ...args: string[]): Promise<Probe> {
  const { stdout } = await run(process.execPath, [join(here, 'wall-clock-probe.ts'), ...args], {
    cwd: repoRoot,
    env: { ...process.env, TZ: timezone },
  });
  return JSON.parse(stdout) as Probe;
}

// ---------- Acceptance Scenario S06 (TI01, TI08, TI10) ----------

describe.skipIf(!reachable)('a session authored at 09:00 reads 09:00 in every timezone', () => {
  const url = testDatabaseUrl!;
  let client: pg.Client;
  let authored: Probe;

  beforeAll(async () => {
    await migrate('up');
    client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query('delete from conference');
    await client.query('delete from app_user');

    // Authored from a device in Europe/Stockholm – UTC+2 in September, so a UTC round trip would
    // move a 09:00 session to 07:00 and, at the day boundary, to the previous date.
    authored = await probe('Europe/Stockholm', 'author');
  }, 60_000);

  afterAll(async () => {
    await client.end();
  });

  it('was genuinely authored under a non-UTC timezone', () => {
    // If this fails the rest of the suite proves nothing, so it is asserted rather than assumed.
    expect(authored.timezone).toBe('Europe/Stockholm');
    expect(authored.offsetMinutes).toBe(120);
  });

  it('stores the naive day and time in the columns, with no offset', () => {
    expect(authored.stored).toEqual({
      day: '2026-09-15',
      start_time: '09:00:00',
      end_time: '10:30:00',
    });
  });

  it('returns the authored values unchanged in the create response', () => {
    expect(authored.session.day).toBe('2026-09-15');
    expect(authored.session.startTime).toBe('09:00');
    expect(authored.session.endTime).toBe('10:30');
  });

  /**
   * The heart of the scenario: the same stored Session, read by two devices seven and nine hours
   * either side of the authoring one.
   */
  it.each([
    ['America/Los_Angeles', -420],
    ['Asia/Tokyo', 540],
  ])('reads identically on a device set to %s', async (timezone, offsetMinutes) => {
    const read = await probe(timezone, 'read', authored.conferenceId);

    expect(read.timezone).toBe(timezone);
    expect(read.offsetMinutes).toBe(offsetMinutes);

    expect(read.session.day).toBe('2026-09-15');
    expect(read.session.startTime).toBe('09:00');
    expect(read.session.endTime).toBe('10:30');
  });

  /**
   * No `Z`, no offset suffix, no instant anywhere in the chain – asserted against the raw response
   * body rather than a parsed object, because a coerced value betrays itself in the serialization
   * and a parsed one has already lost the evidence.
   */
  it.each([['Europe/Stockholm'], ['America/Los_Angeles'], ['Asia/Tokyo']])(
    'carries no instant for a schedule time when read from %s',
    async (timezone) => {
      const read = await probe(timezone, 'read', authored.conferenceId);

      expect(read.rawBody).toContain('"day":"2026-09-15"');
      expect(read.rawBody).toContain('"startTime":"09:00"');
      expect(read.rawBody).toContain('"endTime":"10:30"');

      // What a coerced Date would have produced instead.
      expect(read.rawBody).not.toContain('2026-09-14');
      expect(read.rawBody).not.toContain('T09:00');
      expect(read.rawBody).not.toContain('07:00');
      expect(read.rawBody).not.toContain('09:00:00');

      /*
       * The only ISO-8601 instants in the payload are the timestamp fields, which genuinely are
       * instants. Every other `Z` would be a wall-clock value that had been through a Date.
       */
      const instants = read.rawBody.match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g) ?? [];
      const timestampFields = (read.rawBody.match(/"lastUpdatedAt":"[^"]*"/g) ?? []).length;
      expect(instants).toHaveLength(timestampFields);
    },
  );
});

// ---------- TI02 / TI10: the timestamp guarantees ----------

describe.skipIf(!reachable)('the timestamp fields S09 and S10 consume', () => {
  const url = testDatabaseUrl!;
  let db: Database;
  let client: pg.Client;
  let conferenceId: string;

  const AS_TEXT = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

  beforeAll(async () => {
    await migrate('up');
    db = createDatabase(url, { error: () => {} });
    client = new pg.Client({ connectionString: url });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
    await db.close();
  });

  beforeEach(async () => {
    await client.query('delete from conference');
    await client.query('delete from app_user');
    await client.query(
      `insert into app_user (sub, email, display_name)
       values ('contract-sub', 'contract@ourcompany.example', 'Contract')`,
    );
    const rows = await client.query(
      `insert into conference (name, start_date, end_date, created_by_sub)
       values ('Autumn Offsite', '2026-09-15', '2026-09-16', 'contract-sub') returning id`,
    );
    conferenceId = rows.rows[0].id;
  });

  async function insertSession(startTime = '09:00'): Promise<string> {
    const rows = await client.query(
      `insert into sessions (conference_id, title, kind, day, start_time, end_time, location)
       values ($1, 'Opening Keynote', 'Presentation', '2026-09-15', $2, '23:00', 'Main Hall')
       returning id`,
      [conferenceId, startTime],
    );
    return rows.rows[0].id;
  }

  async function sessionVersion(sessionId: string): Promise<string> {
    const rows = await client.query(
      `select to_char(last_updated_at at time zone 'utc', ${AS_TEXT}) as value
         from sessions where id = $1`,
      [sessionId],
    );
    return rows.rows[0].value;
  }

  async function watermark(): Promise<string> {
    const rows = await client.query(
      `select to_char(schedule_watermark_at at time zone 'utc', ${AS_TEXT}) as value
         from conference where id = $1`,
      [conferenceId],
    );
    return rows.rows[0].value;
  }

  it('are microsecond-granular, not second- or millisecond-granular', async () => {
    const sessionId = await insertSession();

    for (const value of [await sessionVersion(sessionId), await watermark()]) {
      // Six fractional digits present and not all zero – a value truncated to seconds or
      // milliseconds would carry '.000000' or '.123000'.
      const fraction = /\.(\d{6})Z$/.exec(value)?.[1];
      expect(fraction, value).toBeDefined();
      expect(fraction, value).not.toBe('000000');
      expect(fraction!.slice(3), `${value} looks truncated to milliseconds`).not.toBe('000');
    }
  });

  it('are strictly monotonic per row, even for two writes inside one transaction', async () => {
    const sessionId = await insertSession();
    const first = await sessionVersion(sessionId);

    /*
     * The case now() would fail. now() / CURRENT_TIMESTAMP return transaction-start time, so both
     * updates below would carry the identical stamp and S09's concurrency check would not see the
     * second one at all.
     */
    await client.query('begin');
    await client.query("update sessions set title = 'A' where id = $1", [sessionId]);
    const second = await sessionVersion(sessionId);
    await client.query("update sessions set title = 'B' where id = $1", [sessionId]);
    const third = await sessionVersion(sessionId);
    await client.query('commit');

    expect(second > first, `${second} should be after ${first}`).toBe(true);
    expect(third > second, `${third} should be after ${second}`).toBe(true);
  });

  it('advance the conference watermark on insert, update and delete alike', async () => {
    const before = await watermark();

    const sessionId = await insertSession();
    const afterInsert = await watermark();
    expect(afterInsert > before).toBe(true);

    await client.query("update sessions set title = 'Revised' where id = $1", [sessionId]);
    const afterUpdate = await watermark();
    expect(afterUpdate > afterInsert).toBe(true);

    // The delete is the one S10's offline diff cannot do without.
    await client.query('delete from sessions where id = $1', [sessionId]);
    const afterDelete = await watermark();
    expect(afterDelete > afterUpdate).toBe(true);
  });

  /**
   * The assertion the FIS asks to be written so that it *fails* if a later story adds a row-level
   * "touch updated_at on any update" trigger. It reads the column directly rather than inferring
   * from a payload: `updated_at` is S03's field and is not on S04's wire shape.
   */
  it('leave conference.updated_at unmoved by every session write', async () => {
    const stamp = async (): Promise<string> =>
      (
        await client.query(
          `select to_char(updated_at at time zone 'utc', ${AS_TEXT}) as value
             from conference where id = $1`,
          [conferenceId],
        )
      ).rows[0].value;

    const before = await stamp();

    const sessionId = await insertSession();
    expect(await stamp(), 'a session insert moved conference.updated_at').toBe(before);

    await client.query("update sessions set title = 'Revised' where id = $1", [sessionId]);
    expect(await stamp(), 'a session update moved conference.updated_at').toBe(before);

    await client.query('delete from sessions where id = $1', [sessionId]);
    expect(await stamp(), 'a session delete moved conference.updated_at').toBe(before);

    // …and it does still move for a change to the conference's own fields, so the assertion above
    // is not passing merely because nothing maintains the column at all.
    await client.query('update conference set name = $2, updated_at = now() where id = $1', [
      conferenceId,
      'Renamed',
    ]);
    expect((await stamp()) > before).toBe(true);
  });

  /** S09 compares the exact value it was given, so the wire must not round it. */
  it('reach the wire with their full precision intact', async () => {
    const sessionId = await insertSession();
    const stored = await sessionVersion(sessionId);

    const { createSessionRepository } = await import('../src/sessions/session-repository.ts');
    const sessions = await createSessionRepository(db).listForConference(conferenceId);

    expect(sessions[0]!.lastUpdatedAt).toBe(stored);
    // The failure mode being guarded: pg parses timestamptz into a JS Date, which holds only
    // milliseconds, so a repository that went through one would drop the last three digits.
    expect(new Date(stored).toISOString()).not.toBe(stored);
  });
});

// ---------- the source-level half: nothing may reintroduce a Date ----------

describe('no schedule time is routed through a Date anywhere in the chain', () => {
  function sources(root: string): string[] {
    const found: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry.name)) found.push(path);
      }
    };
    walk(root);
    return found;
  }

  /** Comments discuss the very constructs these assertions forbid. */
  function withoutComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  }

  /**
   * The modules that carry schedule times. Deliberately not "the whole codebase": `calendar-date`
   * does documented UTC-frame arithmetic, the auth modules deal in real instants, and forbidding
   * `Date` everywhere would be a rule people route around rather than one they keep.
   */
  const SCHEDULE_MODULES = [
    join(apiSrc, 'sessions'),
    join(apiSrc, 'routes', 'sessions.ts'),
    join(webSrc, 'schedule'),
  ];

  const FORBIDDEN = [
    /\bnew Date\b/,
    /\bDate\.parse\b/,
    /\btoLocaleTimeString\b/,
    /\btoLocaleDateString\b/,
    /\bIntl\.DateTimeFormat\b/,
    /\bgetTimezoneOffset\b/,
  ];

  it.each(SCHEDULE_MODULES)('%s constructs no Date and applies no locale formatter', (target) => {
    const files = /\.tsx?$/.test(target) ? [target] : sources(target);
    expect(files.length, `${target} should contain sources`).toBeGreaterThan(0);

    for (const file of files) {
      const code = withoutComments(readFileSync(file, 'utf8'));
      for (const pattern of FORBIDDEN) {
        expect(pattern.test(code), `${file} matches ${pattern}`).toBe(false);
      }
    }
  });

  /** No timezone-conversion library was reached for either, in any workspace. */
  it('depends on no timezone-conversion library', () => {
    for (const manifest of ['package.json', 'api/package.json', 'web/package.json']) {
      const contents = readFileSync(join(repoRoot, manifest), 'utf8');
      expect(contents).not.toMatch(/moment-timezone|luxon|date-fns-tz|dayjs|js-joda|spacetime/i);
    }
  });

  /** The wall-clock columns are `time without time zone`, in the schema itself. */
  it('stores session times in columns that have no offset to apply', () => {
    const migration = readFileSync(
      join(repoRoot, 'db', 'migrations', '20260817150000000_session.sql'),
      'utf8',
    ).replace(/^\s*--.*$/gm, '');

    expect(migration).toMatch(/start_time\s+time without time zone NOT NULL/);
    expect(migration).toMatch(/end_time\s+time without time zone NOT NULL/);
    expect(migration).toMatch(/day\s+date\s+NOT NULL/);

    // No timestamp of any kind for an authored session time, and no offset column.
    expect(migration).not.toMatch(/(start_time|end_time|day)\s+timestamp/i);
    expect(migration).not.toMatch(/timezone|utc_offset|tz_offset/i);
  });
});
