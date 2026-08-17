import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ScheduleView } from '../src/attendee/ScheduleView.tsx';
import { rehydrateClock, type ClockAnchor } from '../src/clock/effective-clock.ts';
import type { AttendeeSchedule } from '../src/api/client.ts';

/**
 * TI12 – the contract suite pinning the shared decision S06 produces.
 *
 * These are guard rails, not feature tests. Both halves of the decision – the envelope and the clock
 * anchor – are consumed by S09 and S10, and both fail *silently*: an envelope that needs a second
 * request renders perfectly until the connection is gone, and an anchor missing its device reading
 * gives a plausible wall clock that is quietly three hours out. Neither would be caught by a test of
 * the feature that introduced it, so they are asserted here as their own suite.
 *
 * The suite must fail if `serverNow`'s wall-clock fields are dropped, if the anchor loses
 * `deviceClockAtReceipt` or stops round-tripping through JSON, if a Session time is routed through a
 * `Date` on the way to the screen, or if rendering the view comes to require a network call.
 */

const here = dirname(fileURLToPath(import.meta.url));
const webSrc = join(here, '..', 'src');

const ANCHOR: ClockAnchor = {
  serverNowInstant: '2026-09-15T07:40:12.345678Z',
  serverNowDay: '2026-09-15',
  serverNowTime: '09:40',
  deviceClockAtReceipt: Date.UTC(2026, 8, 15, 10, 40, 12, 345),
};

const ENVELOPE: AttendeeSchedule = {
  conference: {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Kickoff 2026',
    startDate: '2026-09-14',
    endDate: '2026-09-16',
    state: 'published',
    lastUpdatedAt: '2026-09-15T07:00:00.123456Z',
  },
  days: [
    { date: '2026-09-14', dayNumber: 1, sessions: [] },
    {
      date: '2026-09-15',
      dayNumber: 2,
      sessions: [
        {
          id: 'keynote',
          title: 'Opening Keynote',
          description: 'How the year went.',
          kind: 'Presentation',
          startTime: '09:00',
          endTime: '10:30',
          location: 'Main Hall',
          concurrentWith: ['design'],
        },
        {
          id: 'design',
          title: 'Design Workshop',
          description: null,
          kind: 'Workshop',
          startTime: '10:00',
          endTime: '11:00',
          location: 'Room 2',
          concurrentWith: ['keynote'],
        },
      ],
    },
    { date: '2026-09-16', dayNumber: 3, sessions: [] },
  ],
  serverNow: { instant: ANCHOR.serverNowInstant, day: '2026-09-15', time: '09:40' },
};

// ---------- the envelope ----------

describe('the schedule envelope', () => {
  it('carries serverNow in both frames – an instant and a naive wall clock', () => {
    expect(ENVELOPE.serverNow.instant).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/);
    expect(ENVELOPE.serverNow.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(ENVELOPE.serverNow.time).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
    // The wall-clock half carries no offset. Dropping it would leave the client with an instant it
    // could only turn into a wall clock by converting a timezone, which is the banned operation.
    expect(ENVELOPE.serverNow.time).not.toMatch(/Z|[+-]\d{2}:?\d{2}/);
  });

  it('carries every Conference Day of the span, including the empty ones', () => {
    expect(ENVELOPE.days.map((day) => day.date)).toEqual([
      '2026-09-14',
      '2026-09-15',
      '2026-09-16',
    ]);
    expect(ENVELOPE.days.map((day) => day.dayNumber)).toEqual([1, 2, 3]);
    expect(ENVELOPE.days.filter((day) => day.sessions.length === 0)).toHaveLength(2);
  });

  it('carries every Session time as a naive wall-clock string, and no instant', () => {
    for (const session of ENVELOPE.days.flatMap((day) => day.sessions)) {
      for (const value of [session.startTime, session.endTime]) {
        expect(value).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
      }
    }
    // Serialized, the only ISO instants are the two fields that genuinely are instants.
    const instants = JSON.stringify(ENVELOPE).match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g) ?? [];
    expect(instants).toHaveLength(2);
  });

  it('marks concurrency symmetrically, as data rather than as an affordance', () => {
    const [keynote, design] = ENVELOPE.days[1]!.sessions as [
      { id: string; concurrentWith: string[] },
      { id: string; concurrentWith: string[] },
    ];
    expect(keynote.concurrentWith).toContain(design.id);
    expect(design.concurrentWith).toContain(keynote.id);
  });

  /** An instant, for elapsed-age display only. This story carries it and reads it no further. */
  it('carries lastUpdatedAt at full microsecond precision', () => {
    expect(ENVELOPE.conference.lastUpdatedAt).toMatch(/\.\d{6}Z$/);
    expect(new Date(ENVELOPE.conference.lastUpdatedAt!).toISOString()).not.toBe(
      ENVELOPE.conference.lastUpdatedAt,
    );
  });
});

// ---------- the property S10 is built on ----------

describe('rendering the view', () => {
  /**
   * The whole point of the envelope. `fetch` is replaced with something that throws, so a component
   * that reached for the network fails loudly here rather than in an airport with no signal.
   */
  it('renders a complete Schedule from the envelope alone, with the network unavailable', () => {
    vi.stubGlobal('fetch', () => {
      throw new Error('the schedule tree must render with no network call');
    });

    const clock = rehydrateClock(ANCHOR);
    render(
      <ScheduleView
        schedule={ENVELOPE}
        now={clock.effectiveWallClockNow()}
        selectedDay="2026-09-15"
        onSelectDay={() => {}}
      />,
    );

    const list = screen.getByTestId('attendee-session-list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(list.textContent).toContain('09:00–10:30');
    expect(list.textContent).toContain('Main Hall');
    // Every day of the span is navigable without a further request.
    for (const date of ['2026-09-14', '2026-09-15', '2026-09-16']) {
      expect(screen.getByTestId(`attendee-day-${date}`)).toBeDefined();
    }

    vi.unstubAllGlobals();
  });

  /**
   * The corrected clock reaches the highlight and nothing else. The anchor here is +3h skewed, so a
   * device-clock-driven implementation would highlight the wrong Session – and either way not one
   * displayed time may differ from what was authored.
   */
  it('lets the corrected clock move the highlight and never a displayed time', () => {
    // The device clock, still +3h skewed, read at the moment of the sync. A device-clock-driven
    // implementation would make this 12:40 and highlight nothing.
    const clock = rehydrateClock(ANCHOR, () => ANCHOR.deviceClockAtReceipt);
    render(
      <ScheduleView
        schedule={ENVELOPE}
        now={clock.effectiveWallClockNow()}
        selectedDay="2026-09-15"
        onSelectDay={() => {}}
      />,
    );

    expect(screen.getByTestId('attendee-session-keynote').dataset.running).toBe('true');
    expect(screen.getByTestId('attendee-session-design').dataset.running).toBe('false');
    expect(screen.getByTestId('attendee-session-keynote').textContent).toContain('09:00–10:30');
    expect(screen.getByTestId('attendee-session-design').textContent).toContain('10:00–11:00');
  });
});

// ---------- the source-level half ----------

describe('the attendee surface routes no schedule time through a Date', () => {
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

  const FORBIDDEN = [
    /\bnew Date\b/,
    /\bDate\.parse\b/,
    /\btoLocaleTimeString\b/,
    /\btoLocaleDateString\b/,
    /\bIntl\.DateTimeFormat\b/,
    /\bgetTimezoneOffset\b/,
  ];

  /**
   * The clock module is held to the same bar as the schedule modules, deliberately – it would have
   * been the natural place to reach for a `Date`, since it is the one part that handles instants at
   * all. It does the civil-date arithmetic in integers instead, so the only `Date` reference it may
   * carry is `Date.now()`: a count of milliseconds since the epoch, identical in every timezone, and
   * injected so a test can replace it.
   */
  it.each([join(webSrc, 'attendee'), join(webSrc, 'clock')])(
    '%s constructs no Date and applies no locale formatter',
    (target) => {
      const files = sources(target);
      expect(files.length, `${target} should contain sources`).toBeGreaterThan(0);

      for (const file of files) {
        const code = withoutComments(readFileSync(file, 'utf8'));
        for (const pattern of FORBIDDEN) {
          expect(pattern.test(code), `${file} matches ${pattern}`).toBe(false);
        }
        // Any other `Date.` member would be a conversion sneaking back in.
        for (const reference of code.match(/\bDate\.\w+/g) ?? []) {
          expect(reference, `${file} reaches for ${reference}`).toBe('Date.now');
        }
      }
    },
  );

  /**
   * The purity S10 depends on, asserted at the source rather than inferred from a passing render:
   * a fetch added inside the tree would work perfectly online and be discovered offline.
   */
  it.each(['ScheduleView.tsx', 'schedule-view-model.ts'])(
    '%s issues no request and reads no clock',
    (name) => {
      const code = withoutComments(readFileSync(join(webSrc, 'attendee', name), 'utf8'));
      for (const pattern of [/\bfetch\s*\(/, /\bapiRequest\b/, /\bDate\.now\b/, /\buseEffect\b/]) {
        expect(pattern.test(code), `${name} matches ${pattern}`).toBe(false);
      }
    },
  );
});
