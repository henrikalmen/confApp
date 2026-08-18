import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { diffSchedule, isEmptyDiff, TRACKED_FIELDS } from '../src/attendee/schedule-diff.ts';
import type { AttendeeSchedule, AttendeeSession } from '../src/api/client.ts';

/**
 * S09 TI03 – the envelope diff, tested directly against envelope pairs.
 *
 * Deliberately separate from the banner's rendering (FIS → Testing Strategy). **S10 depends on this
 * function, not on this story's view**, so it is proved as a function: a suite that only asserted
 * what the banner displayed would let a signature or semantics change slip past the story that has
 * to consume it offline.
 */

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const webSrc = join(here, '..', 'src');

const CONFERENCE = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Autumn Offsite',
  startDate: '2026-09-15',
  endDate: '2026-09-16',
  state: 'published' as const,
  lastUpdatedAt: '2026-09-15T07:40:12.345678Z',
};

const SERVER_NOW = {
  instant: '2026-09-15T07:40:12.345678Z',
  day: '2026-09-15',
  time: '09:40',
};

function session(overrides: Partial<AttendeeSession> & { id: string }): AttendeeSession {
  return {
    title: 'Opening Keynote',
    description: null,
    kind: 'Presentation',
    startTime: '09:00',
    endTime: '10:30',
    location: 'Room A',
    concurrentWith: [],
    ...overrides,
  };
}

/** An envelope whose days are the conference's span, each holding the sessions given for it. */
function envelope(byDay: Record<string, AttendeeSession[]>): AttendeeSchedule {
  const dates = ['2026-09-15', '2026-09-16'];
  return {
    conference: CONFERENCE,
    days: dates.map((date, index) => ({
      date,
      dayNumber: index + 1,
      sessions: byDay[date] ?? [],
    })),
    serverNow: SERVER_NOW,
  };
}

const KEYNOTE = session({ id: 'keynote' });
const RETRO = session({
  id: 'retro',
  title: 'Retrospective',
  startTime: '15:00',
  endTime: '16:00',
});

const BEFORE = envelope({ '2026-09-15': [KEYNOTE, RETRO] });

describe('the schedule diff', () => {
  it('reports nothing when the two envelopes hold the same sessions', () => {
    const diff = diffSchedule(BEFORE, envelope({ '2026-09-15': [KEYNOTE, RETRO] }));

    expect(diff).toEqual({ added: [], removed: [], changed: [] });
    expect(isEmptyDiff(diff)).toBe(true);
  });

  it('reports an added session', () => {
    const lightning = session({ id: 'lightning', title: 'Lightning Talks', startTime: '13:00' });
    const diff = diffSchedule(BEFORE, envelope({ '2026-09-15': [KEYNOTE, RETRO, lightning] }));

    expect(diff.added.map((entry) => entry.id)).toEqual(['lightning']);
    expect(diff.added[0]!.day).toBe('2026-09-15');
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
  });

  it('reports a removed session', () => {
    const diff = diffSchedule(BEFORE, envelope({ '2026-09-15': [KEYNOTE] }));

    expect(diff.removed.map((entry) => entry.id)).toEqual(['retro']);
    // Carried whole, so a renderer can name it without holding the old envelope itself.
    expect(diff.removed[0]!.title).toBe('Retrospective');
    expect(diff.added).toEqual([]);
    expect(diff.changed).toEqual([]);
  });

  it.each(
    // Every tracked field, one at a time, with the value it changes to.
    [
      ['startTime', '09:30'],
      ['endTime', '11:00'],
      ['location', 'Room B'],
      ['title', 'Opening Keynote, revised'],
      ['kind', 'Workshop'],
      ['description', 'Now with slides'],
    ] as const,
  )('reports a changed %s, naming the field', (field, value) => {
    const moved = session({ id: 'keynote', [field]: value });
    const diff = diffSchedule(BEFORE, envelope({ '2026-09-15': [moved, RETRO] }));

    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]!.fields).toEqual([field]);
    expect(diff.changed[0]!.session.id).toBe('keynote');
    // The previous value travels too, so a banner can say what it moved *from*.
    expect(diff.changed[0]!.previous[field]).not.toBe(value);
  });

  /**
   * A description-only edit is reported like any other. FR7's trivial-edit exemption exists to
   * shape push volume, and with no push channel it has nothing to govern (S09 → What We're NOT
   * Doing): silently swapping text under someone's eyes is the failure this story exists to stop.
   */
  it('reports a description-only edit rather than treating it as trivial', () => {
    const annotated = session({ id: 'keynote', description: 'Bring the roadmap' });
    const diff = diffSchedule(BEFORE, envelope({ '2026-09-15': [annotated, RETRO] }));

    expect(diff.changed.map((entry) => entry.fields)).toEqual([['description']]);
  });

  it('reports several changed fields on one session, in a stable order', () => {
    const moved = session({
      id: 'keynote',
      startTime: '09:30',
      endTime: '11:00',
      location: 'Room B',
    });
    const diff = diffSchedule(BEFORE, envelope({ '2026-09-15': [moved, RETRO] }));

    expect(diff.changed[0]!.fields).toEqual(['startTime', 'endTime', 'location']);
  });

  /**
   * The distinction the whole matching rule exists for. "Opening Keynote moved to Wednesday" is the
   * truth; "removed / added" would be two alarming half-truths about a session that never went
   * anywhere.
   */
  it('reports a session moved to another day as one change, not a removal plus an addition', () => {
    const diff = diffSchedule(BEFORE, envelope({ '2026-09-15': [RETRO], '2026-09-16': [KEYNOTE] }));

    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]!.fields).toEqual(['day']);
    expect(diff.changed[0]!.previous.day).toBe('2026-09-15');
    expect(diff.changed[0]!.session.day).toBe('2026-09-16');
  });

  it('reports an addition, a removal and a change together', () => {
    const moved = session({ id: 'keynote', startTime: '09:30', location: 'Room B' });
    const lightning = session({ id: 'lightning', title: 'Lightning Talks', startTime: '13:00' });
    const diff = diffSchedule(BEFORE, envelope({ '2026-09-15': [moved, lightning] }));

    expect(diff.added.map((entry) => entry.id)).toEqual(['lightning']);
    expect(diff.removed.map((entry) => entry.id)).toEqual(['retro']);
    expect(diff.changed.map((entry) => entry.session.id)).toEqual(['keynote']);
    expect(isEmptyDiff(diff)).toBe(false);
  });
});

// ---------- the properties S10 will depend on ----------

describe('the diff as a function', () => {
  const source = readFileSync(join(webSrc, 'attendee', 'schedule-diff.ts'), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('is a pure function of two envelopes – no network, no clock, no storage', () => {
    expect(code).not.toMatch(/fetch\(|XMLHttpRequest|apiRequest|navigator|window|localStorage/);
    expect(code).not.toMatch(/Date\.now\(|performance\.now\(/);
    // No module-level mutable state, so two calls cannot influence one another.
    expect(code).not.toMatch(/^\s*(let|var)\s/m);
  });

  /** The banned operations, restated for the file S10 will import. */
  it('constructs no Date and formats no time', () => {
    expect(code).not.toMatch(/new Date|Date\.parse|toLocaleTimeString|toLocaleDateString/);
    expect(code).not.toMatch(/Intl\.DateTimeFormat|toLocaleString/);
  });

  it('leaves both envelopes untouched', () => {
    const before = envelope({ '2026-09-15': [KEYNOTE, RETRO] });
    const after = envelope({ '2026-09-16': [KEYNOTE] });
    const snapshot = JSON.stringify([before, after]);

    diffSchedule(before, after);

    expect(JSON.stringify([before, after])).toBe(snapshot);
  });

  /**
   * S10 is bound to consume this function rather than write its own (S09 -> Execution Contract), so
   * "there is exactly one" is asserted rather than assumed: a second derivation would eventually
   * disagree with this one, and the two surfaces would tell the same person different stories about
   * the same change.
   */
  it('is the only "what changed" derivation in the web source', () => {
    const found: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;

        const body = readFileSync(full, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '');

        // A derivation that reports added, removed and changed sessions together.
        const derives =
          /added\s*:/.test(body) && /removed\s*:/.test(body) && /changed\s*:/.test(body);
        if (derives) found.push(full.slice(webSrc.length).split('\\').join('/'));
      }
    };
    walk(webSrc);

    expect(found).toEqual(['/attendee/schedule-diff.ts']);
  });

  it('tracks every field an attendee would notice moving', () => {
    expect([...TRACKED_FIELDS]).toEqual([
      'day',
      'startTime',
      'endTime',
      'location',
      'title',
      'kind',
      'description',
    ]);
  });
});

// ---------- the timezone contract ----------

/**
 * Run in fresh processes, because `TZ` is read once when Node starts. A wall-clock leak into the
 * comparison is invisible under UTC, which is exactly why S04's and S06's contract suites do the
 * same thing.
 */
describe('the diff under a device set away from the venue', () => {
  async function probe(
    timezone: string,
  ): Promise<{ timezone: string; offsetMinutes: number; diff: unknown }> {
    const { stdout } = await run(process.execPath, [join(here, 'schedule-diff-probe.ts')], {
      cwd: join(here, '..', '..'),
      env: { ...process.env, TZ: timezone },
    });
    return JSON.parse(stdout);
  }

  it('produces byte-identical results at UTC-7 and UTC+9', async () => {
    const [west, east] = await Promise.all([probe('America/Los_Angeles'), probe('Asia/Tokyo')]);

    // The processes really did run under two different offsets – otherwise this asserts nothing.
    expect(west.offsetMinutes).not.toBe(east.offsetMinutes);

    expect(JSON.stringify(west.diff)).toBe(JSON.stringify(east.diff));
  });

  it('reports the moved session identically in both, as a change and not a swap', async () => {
    const west = await probe('America/Los_Angeles');
    const diff = west.diff as {
      added: unknown[];
      removed: unknown[];
      changed: { fields: string[] }[];
    };

    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]!.fields).toEqual(['day', 'startTime']);
    expect(diff.added).toHaveLength(1);
    expect(diff.removed).toHaveLength(1);
  });
});
