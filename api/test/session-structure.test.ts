import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildApp } from '../src/app.ts';
import { createScheduleGate } from '../src/conferences/schedule-gate.ts';
import { fakeDatabase } from './fake-db.ts';
import { fakeAuth } from './fake-auth.ts';

/**
 * S04's Structural Criteria – the ones that are properties of the source itself rather than of a
 * request.
 *
 * They read the files on disk on purpose. Each guards a decision a later story could undo by
 * writing perfectly working code: an inline role check, a cached schedule, a "tidied" pair of
 * timestamp columns, a re-stubbed publish gate. None of those would fail a behavioural test.
 */

const here = dirname(fileURLToPath(import.meta.url));
const apiSrc = join(here, '..', 'src');
const repoRoot = join(here, '..', '..');

function read(...parts: string[]): string {
  return readFileSync(join(...parts), 'utf8');
}

/** Comments explain the rules; matching them would make these tests assert their own prose. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function withoutSqlComments(source: string): string {
  return source.replace(/^\s*--.*$/gm, '');
}

// ---------- the migration (TI01, TI02) ----------

describe('the session migration', () => {
  const raw = read(repoRoot, 'db', 'migrations', '20260817150000000_session.sql');
  const sql = withoutSqlComments(raw);
  const [up, down] = raw.split(/^-- Down Migration$/m) as [string, string];

  /** Plain PostgreSQL only – portability is why PostgreSQL was chosen (ADR-003). */
  it('uses no extension and no provider-specific feature', () => {
    expect(sql).not.toMatch(/create\s+extension/i);
    expect(sql).not.toMatch(/pgcrypto|uuid-ossp|azure|citus|timescale|aurora/i);
  });

  /** Reversible: everything the up step creates, the down step drops. */
  it('is reversible – every table, function, trigger and column it adds is removed again', () => {
    const created = {
      tables: [...up.matchAll(/create table (\w+)/gi)].map((m) => m[1]),
      functions: [...up.matchAll(/create function (\w+)/gi)].map((m) => m[1]),
      triggers: [...up.matchAll(/create trigger (\w+)/gi)].map((m) => m[1]),
      columns: [...up.matchAll(/add column (\w+)/gi)].map((m) => m[1]),
    };
    const dropped = {
      tables: [...down.matchAll(/drop table (\w+)/gi)].map((m) => m[1]),
      functions: [...down.matchAll(/drop function (\w+)/gi)].map((m) => m[1]),
      triggers: [...down.matchAll(/drop trigger (\w+)/gi)].map((m) => m[1]),
      columns: [...down.matchAll(/drop column (\w+)/gi)].map((m) => m[1]),
    };

    expect(created.tables).toEqual(['sessions']);
    for (const kind of ['tables', 'functions', 'triggers', 'columns'] as const) {
      expect(created[kind].length, `${kind} should be created`).toBeGreaterThan(0);
      expect(new Set(dropped[kind]), kind).toEqual(new Set(created[kind]));
    }
  });

  /**
   * `now()` returns transaction-start time, so two writes in one transaction would be stamped
   * identically and S09 would not see the second. The stamping must use `clock_timestamp()`.
   */
  it('stamps the timestamps from clock_timestamp(), never now()', () => {
    const functions = sql.slice(sql.indexOf('CREATE FUNCTION'));
    expect(functions).toMatch(/clock_timestamp\(\)/);
    expect(functions).not.toMatch(/\bnow\(\)|CURRENT_TIMESTAMP/i);
  });

  /** Strict monotonicity per row, so no two writes to one row can compare equal. */
  it('enforces strict monotonicity with GREATEST(..., old + 1 microsecond)', () => {
    expect(sql).toMatch(
      /GREATEST\(clock_timestamp\(\),\s*OLD\.last_updated_at \+ interval '1 microsecond'\)/,
    );
    expect(sql).toMatch(
      /GREATEST\(clock_timestamp\(\),\s*schedule_watermark_at \+ interval '1 microsecond'\)/,
    );
  });

  /**
   * The load-bearing negative. `conference.updated_at` is S03's field and S09's concurrency base;
   * no trigger function in this migration may write it, or an Organizer's rename starts being
   * refused because somebody else moved a session.
   */
  it('never writes conference.updated_at from any trigger', () => {
    // The lookbehind is what distinguishes the two: `session.last_updated_at` is this story's own
    // row version and is assigned freely; a bare `updated_at` is the Conference column S03 owns.
    expect(sql).not.toMatch(/(?<!last_)updated_at\s*(:=|=[^=])/);
    expect(sql).not.toMatch(/SET\s+(?<!last_)updated_at/i);
  });

  /** …and the conference trigger is conditional, never an unconditional row-level touch. */
  it("guards the conference trigger with a WHEN clause on the conference's own columns", () => {
    const trigger =
      /CREATE TRIGGER conference_change_advances_watermark[\s\S]*?EXECUTE FUNCTION/.exec(sql)?.[0];
    expect(trigger, 'the conference watermark trigger should exist').toBeDefined();

    expect(trigger).toMatch(/BEFORE UPDATE ON conference/);
    expect(trigger).toMatch(/WHEN \(/);
    for (const column of ['name', 'start_date', 'end_date', 'lifecycle_state']) {
      expect(trigger, column).toContain(`OLD.${column} IS DISTINCT FROM NEW.${column}`);
    }
  });

  /** The session trigger covers deletes, or a removal is invisible to S10's offline diff. */
  it('advances the watermark on session insert, update and delete', () => {
    expect(sql).toMatch(
      /CREATE TRIGGER sessions_advance_conference_watermark\s+AFTER INSERT OR UPDATE OR DELETE ON sessions/,
    );
  });

  /** Two Conference timestamps, named so a reader cannot mistake one for the other. */
  it('names the conference watermark schedule_watermark_at, not last_updated_at', () => {
    expect(sql).toMatch(/ALTER TABLE conference\s+ADD COLUMN schedule_watermark_at timestamptz/);
    expect(sql).not.toMatch(/ALTER TABLE conference[\s\S]*ADD COLUMN last_updated_at/);
  });
});

// ---------- the schedule gate (TI11) ----------

describe("S03's publish gate is bound to the real session count", () => {
  const source = withoutComments(read(apiSrc, 'conferences', 'schedule-gate.ts'));

  /**
   * The exact shape S03 left behind: a body that answered a constant. Nothing about the publish
   * path may still short-circuit, whether as a literal, a flag or an environment switch.
   */
  it('returns no constant, and reads no feature flag', () => {
    expect(source).not.toMatch(/return\s+(false|true)\s*;/);
    expect(source).not.toMatch(/process\.env/);
    expect(source).not.toMatch(/\bstub|\bfake|\bTODO|\bflag\b/i);
  });

  it('queries the sessions table for the named conference', () => {
    expect(source).toMatch(/from sessions where conference_id = \$1/);
  });

  /** Proved by driving it, not only by reading it: it issues a query and uses the answer. */
  it('issues a real query and reports what the database returned', async () => {
    const empty = fakeDatabase(() => [{ present: false }]);
    expect(await createScheduleGate(empty).hasAtLeastOneSession('conf-1')).toBe(false);
    expect(empty.calls).toHaveLength(1);
    expect(empty.calls[0]!.text).toContain('sessions');
    expect(empty.calls[0]!.values).toEqual(['conf-1']);

    const populated = fakeDatabase(() => [{ present: true }]);
    expect(await createScheduleGate(populated).hasAtLeastOneSession('conf-1')).toBe(true);
  });

  /** The publish handler still asks the port, exactly as S03 wrote it. */
  it('is still consulted from the publish handler through the port', () => {
    const handlers = withoutComments(read(apiSrc, 'routes', 'conferences.ts'));
    expect(handlers).toMatch(/scheduleGate\.hasAtLeastOneSession\(/);
    // The handler counts nothing itself – it asks, and the state machine decides.
    expect(handlers).not.toMatch(/from sessions/);
    expect(handlers).toMatch(/assertPublishable\(/);
  });

  /** Production wires the real binding; nothing defaults the gate to a constant. */
  it('is the default binding the app builds with', () => {
    const app = withoutComments(read(apiSrc, 'app.ts'));
    expect(app).toMatch(/scheduleGate \?\? createScheduleGate\(db\)/);
  });
});

// ---------- the session routes (TI03) ----------

describe('the session routes', () => {
  const handlers = read(apiSrc, 'routes', 'sessions.ts');
  const code = withoutComments(handlers);

  /** S07 replaces one helper body; it cannot replace a comparison a handler grew for itself. */
  it('makes no inline creator or role comparison', () => {
    expect(code).not.toMatch(/createdBySub\s*===/);
    expect(code).not.toMatch(/===\s*caller\.sub/);
    expect(code).not.toMatch(/caller\.sub\s*===/);
    expect(code).not.toMatch(/\.role\s*===/);
    expect(code).not.toMatch(/lifecycleState\s*===/);
  });

  it('routes every per-conference check through requireConferenceRole', () => {
    expect(code).toContain('requireConferenceRole');
    // It reaches the role tables only through the helper, never directly.
    expect(code).not.toMatch(/role_assignment|membership/);
  });

  /** The archived-conference refusal is S03's guard, not a second definition of "archived". */
  it('refuses writes on an archived conference through the lifecycle guard', () => {
    expect(code).toMatch(/assertEditable\(/);
    expect(code).not.toMatch(/'archived'|"archived"/);
  });

  /**
   * No in-process state between requests. The API runs as several container replicas with no
   * request affinity (ADR-004), so a schedule cache, an overlap memo or a counter held here would
   * be absent — or stale — on the next request.
   */
  it.each([
    ['routes/sessions.ts', join(apiSrc, 'routes', 'sessions.ts')],
    ['sessions/session-repository.ts', join(apiSrc, 'sessions', 'session-repository.ts')],
    ['sessions/overlap.ts', join(apiSrc, 'sessions', 'overlap.ts')],
    ['sessions/session-validation.ts', join(apiSrc, 'sessions', 'session-validation.ts')],
    ['sessions/wall-clock-time.ts', join(apiSrc, 'sessions', 'wall-clock-time.ts')],
  ])('%s holds no mutable module-level state', (_name, path) => {
    const source = withoutComments(readFileSync(path, 'utf8'));

    // Module scope only – an indented `let` is a local inside a function.
    expect(source, 'a module-level let is request state waiting to happen').not.toMatch(
      /^(let|var)\s/m,
    );
    expect(source, 'a module-level Map/Set is a cache').not.toMatch(
      /^const\s+\w+\s*=\s*new (Map|Set|WeakMap|WeakSet)\b/m,
    );
  });

  /** Overlap is warning data. No write path may reject on it (FR2, REQ-029). */
  it('never refuses a save because of an overlap', () => {
    const sources = [code, withoutComments(read(apiSrc, 'sessions', 'session-validation.ts'))];
    for (const source of sources) {
      // No AppError is ever constructed anywhere near the overlap computation.
      expect(source).not.toMatch(/overlap[\s\S]{0,200}throw/i);
    }

    // …and validation cannot even see the rest of the schedule to compare against.
    const validation = withoutComments(read(apiSrc, 'sessions', 'session-validation.ts'));
    expect(validation).not.toMatch(/overlap/i);
  });
});

// ---------- registration and the error envelope ----------

describe('the schedule routes are registered and authenticated', () => {
  it('registers create, edit, delete and the organizer read, all through withAuth', async () => {
    const app = buildApp({ db: fakeDatabase(), auth: fakeAuth() });
    try {
      const urls = app.confappRoutes.map((route) => `${route.method} ${route.url}`);

      expect(urls).toContain('POST /api/conferences/:conferenceId/sessions');
      expect(urls).toContain('PATCH /api/conferences/:conferenceId/sessions/:sessionId');
      expect(urls).toContain('DELETE /api/conferences/:conferenceId/sessions/:sessionId');
      expect(urls).toContain('GET /api/conferences/:conferenceId/schedule/organizer');

      for (const route of app.confappRoutes.filter((entry) =>
        /\/sessions|\/schedule\//.test(entry.url),
      )) {
        expect(route.authenticated, `${route.method} ${route.url}`).toBe(true);
      }
    } finally {
      await app.close();
    }
  });

  /**
   * The Organizer read is a *different route* from S06's attendee read on the same resource. Two
   * audiences, two payloads – this story must not have taken the attendee one.
   */
  it("leaves S06's attendee schedule route unregistered", async () => {
    const app = buildApp({ db: fakeDatabase(), auth: fakeAuth() });
    try {
      const urls = app.confappRoutes.map((route) => `${route.method} ${route.url}`);
      expect(urls).not.toContain('GET /api/conferences/:conferenceId/schedule');
    } finally {
      await app.close();
    }
  });

  /** Every S04 refusal carries a displayable message and a machine code (S01's envelope). */
  it('declares every session refusal through the shared error envelope', () => {
    const errors = read(apiSrc, 'errors.ts');
    const sessionCodes = [...errors.matchAll(/^\s{2}(SESSION_\w+):/gm)].map((match) => match[1]);

    expect(sessionCodes.length).toBeGreaterThan(0);
    // Every code the session modules raise is declared in the shared list, so no route invents
    // a per-endpoint shape.
    const raised = new Set(
      [
        read(apiSrc, 'routes', 'sessions.ts'),
        read(apiSrc, 'sessions', 'session-validation.ts'),
        read(apiSrc, 'sessions', 'session-repository.ts'),
      ]
        .join('\n')
        .match(/ERROR_CODES\.(SESSION_\w+)/g)
        ?.map((match) => match.replace('ERROR_CODES.', '')) ?? [],
    );

    expect(raised.size).toBeGreaterThan(0);
    for (const code of raised) expect(sessionCodes).toContain(code);

    // Nothing constructs a bare response shape of its own.
    for (const file of ['routes/sessions.ts', 'sessions/session-repository.ts']) {
      const source = withoutComments(readFileSync(join(apiSrc, ...file.split('/')), 'utf8'));
      expect(source, file).not.toMatch(/reply\.(status|code|send)/);
    }
  });

  /** One `sessions` folder, and the schedule modules are the only ones that touch that table. */
  it('reaches the sessions table only from the sessions modules and the schedule gate', () => {
    const offenders: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;

        const relative = path.replace(apiSrc, '').replace(/\\/g, '/');
        if (relative.startsWith('/sessions/')) continue;
        if (relative === '/conferences/schedule-gate.ts') continue;

        if (/from sessions\b/.test(withoutComments(readFileSync(path, 'utf8')))) {
          offenders.push(relative);
        }
      }
    };
    walk(apiSrc);

    expect(offenders).toEqual([]);
  });
});
