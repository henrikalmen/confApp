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

  /**
   * The order is the whole reason the module exists, so it is asserted on the source: an archive
   * landing under an in-flight edit must produce the state-named refusal, never a bare version
   * conflict with advice that cannot work.
   */
  it('checks the lifecycle state before the base version', () => {
    const stateCheck = preconditions.indexOf('conferenceState !== ');
    const editableCheck = preconditions.indexOf('assertEditable(');
    const versionCheck = preconditions.indexOf('base.version !== ');

    expect(stateCheck).toBeGreaterThan(-1);
    expect(editableCheck).toBeGreaterThan(-1);
    expect(versionCheck).toBeGreaterThan(-1);
    expect(stateCheck).toBeLessThan(versionCheck);
    expect(editableCheck).toBeLessThan(versionCheck);
  });

  it('is the single step both write paths use, rather than two copies of the order', () => {
    const callers = sourceFiles().filter(({ code }) => /assertWritePreconditions\(/.test(code));
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

// ---------- the two timestamp columns stay apart ----------

describe('the concurrency base and the poll comparison', () => {
  const conferenceRoutes = withoutComments(read(apiSrc, 'routes', 'conferences.ts'));
  const attendeeRoutes = withoutComments(read(apiSrc, 'routes', 'attendee.ts'));

  /**
   * `conference.updated_at` is the Conference edit's base; `schedule_watermark_at` is the poll
   * comparison. Swapping them is a defect either way round: the watermark advances on every Session
   * write and would refuse edits that conflict with nothing, and `updated_at` is untouched by
   * Session writes and would miss every schedule change.
   */
  it('bases a conference edit on the row version, never the schedule watermark', () => {
    expect(conferenceRoutes).toMatch(/currentVersion:\s*conference\.updatedAt/);

    /*
     * Scoped to the precondition call rather than the whole file. The route legitimately *reads*
     * the watermark for its response (TI09) – what it may never do is use it as the precondition,
     * because it advances on every Session write and would refuse a rename that conflicts with
     * nothing.
     */
    const call = conferenceRoutes.slice(
      conferenceRoutes.indexOf('assertWritePreconditions({'),
      conferenceRoutes.indexOf('});', conferenceRoutes.indexOf('assertWritePreconditions({')),
    );
    expect(call).toMatch(/currentVersion:/);
    expect(call).not.toMatch(/atermark/i);
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
