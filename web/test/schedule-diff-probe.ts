import { diffSchedule } from '../src/attendee/schedule-diff.ts';
import type { AttendeeSchedule } from '../src/api/client.ts';

/**
 * Runs `diffSchedule` in a fresh process whose `TZ` is whatever Node read at start-up, and prints
 * the result as JSON.
 *
 * A separate process because `TZ` is read once when Node starts: setting `process.env.TZ` inside a
 * running test changes nothing that matters and would let a timezone leak pass unnoticed. The
 * envelopes below are fixed, so any difference between two runs of this probe is the timezone
 * reaching a comparison it must never reach.
 */

function envelope(sessions: { id: string; day: string; startTime: string }[]): AttendeeSchedule {
  const days = ['2026-09-15', '2026-09-16'];
  return {
    conference: {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Autumn Offsite',
      startDate: days[0]!,
      endDate: days[1]!,
      state: 'published',
      lastUpdatedAt: '2026-09-15T07:40:12.345678Z',
    },
    days: days.map((date, index) => ({
      date,
      dayNumber: index + 1,
      sessions: sessions
        .filter((session) => session.day === date)
        .map((session) => ({
          id: session.id,
          title: `Session ${session.id}`,
          description: null,
          kind: 'Presentation' as const,
          startTime: session.startTime,
          endTime: '23:00',
          location: 'Room A',
          concurrentWith: [],
        })),
    })),
    serverNow: {
      instant: '2026-09-15T07:40:12.345678Z',
      day: '2026-09-15',
      time: '09:40',
    },
  };
}

const previous = envelope([
  { id: 'a', day: '2026-09-15', startTime: '09:00' },
  { id: 'b', day: '2026-09-15', startTime: '15:00' },
]);

const current = envelope([
  // Moved to the next day and later in it – one changed session, never a remove plus an add.
  { id: 'a', day: '2026-09-16', startTime: '09:30' },
  { id: 'c', day: '2026-09-15', startTime: '13:00' },
]);

process.stdout.write(
  JSON.stringify({
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    offsetMinutes: new Date('2026-09-15T00:00:00Z').getTimezoneOffset(),
    diff: diffSchedule(previous, current),
  }),
);
