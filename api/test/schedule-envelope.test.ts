import { describe, expect, it } from 'vitest';
import {
  buildScheduleEnvelope,
  type EnvelopeConference,
} from '../src/sessions/schedule-envelope.ts';
import type { Session } from '../src/sessions/session-repository.ts';
import type { ServerNow } from '../src/conferences/calendar-date.ts';

/**
 * TI03's envelope composition, as its own suite.
 *
 * `buildScheduleEnvelope` is a pure function of four arguments, and it is the artefact S09 and S10
 * are built on – so it gets coverage that does not evaporate on a machine with no PostgreSQL. The
 * integration suite proves the same rules end to end against the real database; this proves them
 * against the composition itself, where a day-grouping or concurrency bug is a one-line diff away
 * from being visible.
 */

const KICKOFF: EnvelopeConference = {
  id: 'kickoff',
  name: 'Kickoff 2026',
  startDate: '2026-09-14',
  endDate: '2026-09-16',
  lifecycleState: 'published',
};

const SERVER_NOW: ServerNow = {
  instant: '2026-09-15T07:40:12.345000Z',
  day: '2026-09-15',
  time: '09:40',
};

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'keynote',
    conferenceId: 'kickoff',
    title: 'Opening Keynote',
    description: null,
    kind: 'Presentation',
    day: '2026-09-15',
    startTime: '09:00',
    endTime: '10:30',
    location: 'Main Hall',
    lastUpdatedAt: '2026-09-15T07:00:00.123456Z',
    ...overrides,
  };
}

/** As the repository returns them: ordered by day, then start time, then title. */
const SCHEDULE = [
  session({
    id: 'earlier',
    title: 'Earlier',
    day: '2026-09-14',
    startTime: '09:00',
    endTime: '10:00',
  }),
  session({
    id: 'back-to-back',
    title: 'Back To Back',
    day: '2026-09-14',
    startTime: '10:00',
    endTime: '11:00',
  }),
  session(),
  session({
    id: 'architecture',
    title: 'Architecture Deep Dive',
    startTime: '10:00',
    endTime: '11:00',
  }),
  session({
    id: 'design',
    title: 'Design Workshop',
    kind: 'Workshop',
    startTime: '10:00',
    endTime: '11:00',
  }),
  session({
    id: 'retro',
    title: 'Retrospective',
    kind: 'Workshop',
    startTime: '15:00',
    endTime: '16:00',
  }),
];

const WATERMARK = '2026-09-15T07:05:00.987654Z';

function envelope(sessions = SCHEDULE) {
  return buildScheduleEnvelope(KICKOFF, sessions, WATERMARK, SERVER_NOW);
}

describe('the days of the envelope', () => {
  it('carries every Conference Day of the span, numbered from one', () => {
    expect(envelope().days.map((day) => [day.date, day.dayNumber])).toEqual([
      ['2026-09-14', 1],
      ['2026-09-15', 2],
      ['2026-09-16', 3],
    ]);
  });

  it('carries a day with no Sessions as an empty list rather than omitting it', () => {
    expect(envelope().days[2]).toEqual({ date: '2026-09-16', dayNumber: 3, sessions: [] });
  });

  it('carries a one-day Conference as a single day', () => {
    const oneDay = { ...KICKOFF, startDate: '2026-09-15', endDate: '2026-09-15' };
    const built = buildScheduleEnvelope(oneDay, [session()], WATERMARK, SERVER_NOW);
    expect(built.days).toHaveLength(1);
    expect(built.days[0]!.sessions.map((s) => s.id)).toEqual(['keynote']);
  });

  /**
   * The deliberate difference from the Organizer's composition view. S03 lets a span be shortened
   * past its Sessions and leaves refusing that to S09, so such a Session exists – the Organizer must
   * see it in order to move it, and an Attendee has no day to put it on and nothing to do about it.
   */
  it('drops a Session that falls outside the span rather than inventing a day for it', () => {
    const stray = session({ id: 'stray', title: 'Stray', day: '2026-09-20' });
    const built = envelope([...SCHEDULE, stray]);

    expect(built.days.map((day) => day.date)).toEqual(['2026-09-14', '2026-09-15', '2026-09-16']);
    expect(built.days.flatMap((day) => day.sessions).map((s) => s.id)).not.toContain('stray');
  });

  it('groups each Session onto its own day, preserving the order it arrived in', () => {
    expect(envelope().days[1]!.sessions.map((s) => s.title)).toEqual([
      'Opening Keynote',
      'Architecture Deep Dive',
      'Design Workshop',
      'Retrospective',
    ]);
    expect(envelope().days[0]!.sessions.map((s) => s.title)).toEqual(['Earlier', 'Back To Back']);
  });
});

// ---------- Acceptance Scenario S04 ----------

describe('concurrency marking', () => {
  function partners(id: string): string[] {
    return envelope()
      .days.flatMap((day) => day.sessions)
      .find((s) => s.id === id)!
      .concurrentWith.slice()
      .sort();
  }

  it('names every Session a given one runs alongside, symmetrically', () => {
    expect(partners('design')).toEqual(['architecture', 'keynote']);
    expect(partners('architecture')).toEqual(['design', 'keynote']);
    // 09:00–10:30 overlaps both 10:00–11:00 Sessions.
    expect(partners('keynote')).toEqual(['architecture', 'design']);
  });

  it('leaves a Session that runs alone with an empty list', () => {
    expect(partners('retro')).toEqual([]);
  });

  /** S04's half-open rule, reached by calling its function rather than restating it. */
  it('does not mark Sessions that merely touch at a boundary', () => {
    expect(partners('earlier')).toEqual([]);
    expect(partners('back-to-back')).toEqual([]);
  });

  it('never marks Sessions on different days as concurrent', () => {
    const sameTimeNextDay = session({ id: 'echo', title: 'Echo', day: '2026-09-16' });
    const built = envelope([session(), sameTimeNextDay]);
    const all = built.days.flatMap((day) => day.sessions);

    expect(all.find((s) => s.id === 'keynote')!.concurrentWith).toEqual([]);
    expect(all.find((s) => s.id === 'echo')!.concurrentWith).toEqual([]);
  });
});

describe('the conference block and serverNow', () => {
  it('carries the watermark through unmodified, under the wire name the envelope pins', () => {
    expect(envelope().conference.lastUpdatedAt).toBe(WATERMARK);
  });

  it('reports a Conference with no watermark as null rather than inventing one', () => {
    expect(
      buildScheduleEnvelope(KICKOFF, [], null, SERVER_NOW).conference.lastUpdatedAt,
    ).toBeNull();
  });

  it('marks the lifecycle state under the envelope’s own field name', () => {
    const archived = { ...KICKOFF, lifecycleState: 'archived' as const };
    expect(buildScheduleEnvelope(archived, [], WATERMARK, SERVER_NOW).conference.state).toBe(
      'archived',
    );
  });

  it('passes serverNow through in both frames, untouched', () => {
    expect(envelope().serverNow).toEqual(SERVER_NOW);
  });

  /** Every Session time leaves as the naive string it arrived as. No Z, no offset, anywhere. */
  it('serializes no Session time as an instant', () => {
    const body = JSON.stringify(envelope());

    expect(body).toContain('"startTime":"09:00"');
    expect(body).toContain('"endTime":"10:30"');
    expect(body).toContain('"date":"2026-09-15"');

    // Exactly two instants: the watermark and serverNow.instant.
    expect(body.match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g) ?? []).toHaveLength(2);
  });

  /** No row version reaches an attendee: there is nothing here for them to edit. */
  it('carries no per-Session row version', () => {
    for (const entry of envelope().days.flatMap((day) => day.sessions)) {
      expect(entry).not.toHaveProperty('lastUpdatedAt');
    }
  });
});
