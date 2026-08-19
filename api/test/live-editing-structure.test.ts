import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * S09's Structural Criteria – the ones that are properties of the source rather than of a request.
 *
 * Each guards a decision a later story could undo by writing perfectly working code: a second copy
 * of the day-containment rule, a version check that runs before the lifecycle check, a watermark
 * endpoint that grows a schedule payload, a push notification "helpfully" added to the change
 * banner. None of those would fail a behavioural test.
 */

const here = dirname(fileURLToPath(import.meta.url));
const apiSrc = join(here, '..', 'src');

function read(...parts: string[]): string {
  return readFileSync(join(...parts), 'utf8');
}

/** Comments explain the rules; matching them would make these tests assert their own prose. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Every `.ts` file under `api/src`, as code with its commentary stripped. */
function sourceFiles(dir = apiSrc): { path: string; code: string }[] {
  const found: { path: string; code: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts'))
      found.push({ path: full, code: withoutComments(read(full)) });
  }
  return found;
}

// ---------- TI08: one day-containment rule, not two ----------

describe('the day-containment rule', () => {
  /**
   * S04 owns it. The post-publish edit path reaches it by calling `validateSessionDetails`, which
   * is why S09's handlers restate none of it – a second copy is how the composition form and the
   * post-publish form come to disagree about which days a Session may sit on.
   */
  it('has exactly one implementation, in S04s validator', () => {
    const owners = sourceFiles().filter(
      ({ code }) => /conferenceDays\s*\(/.test(code) && /SESSION_DAY_OUT_OF_SPAN/.test(code),
    );

    expect(owners.map((file) => file.path.replace(apiSrc, '').replace(/\\/g, '/'))).toEqual([
      '/sessions/session-validation.ts',
    ]);
  });

  it('is reached from the session edit path rather than re-derived there', () => {
    const routes = withoutComments(read(apiSrc, 'routes', 'sessions.ts'));

    // The edit path calls the validator...
    expect(routes).toMatch(/validateSessionDetails\(/);
    // ...and states no day rule of its own.
    expect(routes).not.toMatch(/SESSION_DAY_OUT_OF_SPAN/);
    expect(routes).not.toMatch(/startDate\s*<=|endDate\s*>=/);
  });
});

// ---------- TI05: lifecycle before base version, on every write path ----------

describe('the write precondition step', () => {
  const preconditions = withoutComments(read(apiSrc, 'conferences', 'write-preconditions.ts'));
  const sessionRepo = withoutComments(read(apiSrc, 'sessions', 'session-repository.ts'));
  const conferenceRepo = withoutComments(read(apiSrc, 'conferences', 'conference-repository.ts'));

  /**
   * The base-version comparison must live **in the write statement**, not ahead of it.
   *
   * Reading the row, comparing in JavaScript and then writing is three statements with nothing
   * holding between them: two concurrent saves both read the same version, both compare equal, and
   * both write - so the second silently overwrites the first while being told it succeeded. That is
   * last-write-wins reappearing inside the mechanism built to prevent it, and it was reachable in
   * exactly the two-Admin case this story is named for until the predicate moved into the SQL.
   */
  it('compares the base version inside the UPDATE, not in a separate round trip', () => {
    expect(sessionRepo).toMatch(/where[\s\S]{0,120}last_updated_at\s*=\s*\$\d+/);
    expect(conferenceRepo).toMatch(/where[\s\S]{0,120}updated_at\s*=\s*\$\d+/);

    // And the check-then-act shape is gone from the module that used to hold it.
    expect(preconditions).not.toMatch(/base\.version\s*!==/);
  });

  /** A delete races the same way, and its guard shares the transaction the row lock is taken in. */
  it('guards the delete path with the same version comparison, inside its transaction', () => {
    const remove = sessionRepo.slice(sessionRepo.indexOf('async remove('));
    expect(remove).toMatch(/for update/i);
    expect(remove).toMatch(/last_updated_at\s*!==\s*expectedVersion/);
  });

  /**
   * The lifecycle half stays ahead of the version half. An archive landing under an in-flight edit
   * must produce the state-named refusal, never a bare version conflict with advice that cannot
   * work - so it is decided before the write is even attempted.
   */
  it('checks the lifecycle state before the write is attempted', () => {
    const stateCheck = preconditions.indexOf('conferenceState !== ');
    const editableCheck = preconditions.indexOf('assertEditable(');
    expect(stateCheck).toBeGreaterThan(-1);
    expect(editableCheck).toBeGreaterThan(-1);
    expect(stateCheck).toBeLessThan(editableCheck);

    for (const route of ['sessions.ts', 'conferences.ts']) {
      const code = withoutComments(read(apiSrc, 'routes', route));
      const lifecycle = code.indexOf('assertLifecyclePreconditions(');
      const write = code.search(/(sessions|repository)\.(update|remove|updateDetails)\(/);
      expect(lifecycle, route).toBeGreaterThan(-1);
      expect(write, route).toBeGreaterThan(-1);
      expect(lifecycle, route).toBeLessThan(write);
    }
  });

  it('is the single step both write paths use, rather than two copies of the order', () => {
    const callers = sourceFiles().filter(({ code }) => /assertLifecyclePreconditions\(/.test(code));
    const paths = callers.map((file) => file.path.replace(apiSrc, '').replace(/\\/g, '/')).sort();

    expect(paths).toEqual([
      '/conferences/write-preconditions.ts',
      '/routes/conferences.ts',
      '/routes/sessions.ts',
    ]);
  });

  it('holds no state between requests', () => {
    // No module-level mutable binding: the API runs across replicas with no request affinity.
    expect(preconditions).not.toMatch(/^\s*(let|var)\s/m);
    expect(preconditions).not.toMatch(/new Map\(|new Set\(|\[\]\s*;/);
  });
});

/**
 * The watermark must be read **before** the session list it is shipped with.
 *
 * Read the other way round, an edit landing between the two statements binds a newer watermark to
 * an older list; the client stores that watermark as its comparison basis, every later poll compares
 * equal, and the change never arrives. Stale-low costs one wasted refetch and self-corrects;
 * stale-high is silent and permanent.
 */
describe('the schedule envelope reads', () => {
  /**
   * Sliced to the function that does the reading, not matched across the whole file.
   *
   * An earlier version compared `indexOf` over the entire module, and in `sessions.ts` the first
   * `scheduleWatermark(` sits in an unrelated helper far above the handler - so swapping the two
   * reads back to the defective order left the test green. A guard that cannot fail is not a guard.
   */
  function bodyOf(route: string, marker: string): string {
    const code = withoutComments(read(apiSrc, 'routes', route));
    const from = code.indexOf(marker);
    expect(from, `${route}: ${marker} not found`).toBeGreaterThan(-1);
    // Up to the next top-level declaration, which is enough to contain one function body.
    const rest = code.slice(from + marker.length);
    const stop = rest.search(/\n {0,2}(app\.|async function|function |\}\);)/);
    return rest.slice(0, stop === -1 ? rest.length : stop);
  }

  /** Both reads, and the name of the slice each one has to be found inside. */
  interface ReadOrder {
    route: string;
    /** The function that reads the watermark, and the call that follows it there. */
    watermark: { marker: string; then: string };
    /** The function that reads the session list, and what must already have happened there. */
    list: { marker: string; after: string };
  }

  /**
   * Stale-low is self-correcting - one wasted refetch, then agreement. Stale-high is silent and
   * permanent: the client stores a watermark newer than the data beside it, every later poll
   * compares equal, and the change never arrives. So the watermark must be read first.
   *
   * Each route names **both** slices explicitly. The previous version looked for the session list in
   * the same slice as the watermark and skipped the assertion when it was not there - which is
   * exactly the case in `attendee.ts`, where the list is read in the route handler and the watermark
   * inside `loadReadable`. Half of this test silently did nothing on one of the two routes it
   * claimed to cover; naming the second slice is what makes it run.
   */
  const ORDERS: ReadOrder[] = [
    {
      route: 'attendee.ts',
      watermark: { marker: 'async function loadReadable(', then: 'conferences.findById(' },
      // `loadReadable` is awaited whole, so it reading the watermark first is what puts the
      // watermark ahead of the list - provided the call itself comes first.
      list: {
        marker: "app.get('/api/conferences/:conferenceId/schedule'",
        after: 'loadReadable(',
      },
    },
    {
      route: 'sessions.ts',
      watermark: {
        marker: "app.get('/api/conferences/:conferenceId/schedule/organizer'",
        then: 'conferences.findById(',
      },
      list: {
        marker: "app.get('/api/conferences/:conferenceId/schedule/organizer'",
        after: 'scheduleWatermark(',
      },
    },
  ];

  it.each(ORDERS.map((order) => [order.route, order] as const))(
    'reads the watermark before the conference row in %s',
    (route, order) => {
      const body = bodyOf(route, order.watermark.marker);

      const watermark = body.indexOf('scheduleWatermark(');
      const then = body.indexOf(order.watermark.then);

      expect(watermark, `${route}: no watermark read in this slice`).toBeGreaterThan(-1);
      expect(then, `${route}: no ${order.watermark.then} in this slice`).toBeGreaterThan(-1);
      expect(watermark, `${route}: watermark must precede ${order.watermark.then}`).toBeLessThan(
        then,
      );
    },
  );

  it.each(ORDERS.map((order) => [order.route, order] as const))(
    'reads the watermark before the session list in %s',
    (route, order) => {
      const body = bodyOf(route, order.list.marker);

      const list = body.indexOf('listForConference(');
      const after = body.indexOf(order.list.after);

      // Asserted, never skipped: a marker that stops matching is a test that stopped testing.
      expect(list, `${route}: no session list read in this slice`).toBeGreaterThan(-1);
      expect(after, `${route}: no ${order.list.after} in this slice`).toBeGreaterThan(-1);
      expect(after, `${route}: ${order.list.after} must precede the session list`).toBeLessThan(
        list,
      );
    },
  );
});

// ---------- the two timestamp columns stay apart ----------

describe('the concurrency base and the poll comparison', () => {
  const conferenceRoutes = withoutComments(read(apiSrc, 'routes', 'conferences.ts'));
  const attendeeRoutes = withoutComments(read(apiSrc, 'routes', 'attendee.ts'));
  const conferenceRepository = withoutComments(
    read(apiSrc, 'conferences', 'conference-repository.ts'),
  );

  /**
   * `conference.updated_at` is the Conference edit's base; `schedule_watermark_at` is the poll
   * comparison. Swapping them is a defect either way round: the watermark advances on every Session
   * write and would refuse edits that conflict with nothing, and `updated_at` is untouched by
   * Session writes and would miss every schedule change.
   */
  it('bases a conference edit on the row version, never the schedule watermark', () => {
    // The value handed to the guarded write is the base the client sent, compared against
    // `updated_at` in the SQL - never the schedule watermark, which advances on every Session write
    // and would refuse a rename that conflicts with nothing.
    expect(conferenceRoutes).toMatch(/updateDetails\([^)]*base\.version/);
    expect(conferenceRepository).toMatch(/updated_at\s*=\s*\$\d+::timestamptz/);
    expect(conferenceRepository).not.toMatch(/schedule_watermark_at\s*=\s*\$\d+/);
  });

  /**
   * Every writer of the row advances `updated_at` the same guarded way.
   *
   * Asserted structurally because the failure is drift, not logic: `updateDetails` was guarded and
   * `updateLifecycleState`, `publish` and `regenerateJoinCode` were left on `now()`, so the column
   * was monotonic on one path and free to move backwards on the other three. `now()` is transaction
   * *start* time - a statement that waits for a row lock stamps a value from before the write it
   * waited on. A behavioural test catches one writer at a time; this catches the fourth one a later
   * story adds.
   */
  it('advances the conference row version the same guarded way from every writer', () => {
    expect(conferenceRepository).not.toMatch(/updated_at\s*=\s*now\(\)/);

    // Every `update conference` statement, whatever their number, stamps the column the same way.
    // Asserted per statement rather than as a count, so adding a fifth writer that gets it right
    // does not fail - and adding one that forgets does.
    const statements = conferenceRepository.split('update conference').slice(1);
    expect(statements.length).toBeGreaterThanOrEqual(4);
    for (const statement of statements) {
      const assignments = statement.slice(0, statement.indexOf('where'));
      expect(
        assignments,
        `an update conference without the guarded stamp: ${assignments.trim()}`,
      ).toContain('${ADVANCE_UPDATED_AT}');
    }
  });

  it('polls the schedule watermark, never the conference row version', () => {
    expect(attendeeRoutes).toMatch(/scheduleWatermark\(/);
    expect(attendeeRoutes).not.toMatch(/updatedAt|updated_at/);
  });
});

// ---------- TI01: the watermark endpoint stays cheap ----------

describe('the watermark endpoint', () => {
  const attendeeRoutes = read(apiSrc, 'routes', 'attendee.ts');

  it('returns the watermark and the lifecycle state, and builds no schedule payload', () => {
    // The handler body, from its route registration to the end of its block.
    const start = attendeeRoutes.indexOf("'/api/conferences/:conferenceId/schedule/watermark'");
    expect(start).toBeGreaterThan(-1);
    const handler = withoutComments(attendeeRoutes.slice(start));

    expect(handler).toMatch(/lastUpdatedAt:/);
    expect(handler).toMatch(/state:/);
    // Never the envelope, and never a Session list: the poll must not cost what the refetch costs.
    expect(handler).not.toMatch(/buildScheduleEnvelope|listForConference/);
  });
});

// ---------- Final Validation Checklist: no push surface was introduced ----------

describe('the API this story leaves behind', () => {
  it('contains no push-notification surface at all', () => {
    const offending = sourceFiles().filter(({ code }) =>
      /apns|fcm|firebase|device[_-]?token|push[_-]?(token|subscription|notification)|web-?push/i.test(
        code,
      ),
    );

    expect(offending.map((file) => file.path)).toEqual([]);
  });

  it('records no notification and schedules no per-session debounce', () => {
    const offending = sourceFiles().filter(({ code }) =>
      /notification_record|notificationRecord|debounce/i.test(code),
    );

    expect(offending.map((file) => file.path)).toEqual([]);
  });
});
