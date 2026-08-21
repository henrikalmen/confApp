import 'fake-indexeddb/auto';
import { readCachedSchedule, writeCachedSchedule } from '../src/offline/schedule-cache.ts';
import { anchorOf } from '../src/offline/schedule-cache.ts';
import { rehydrateClock } from '../src/clock/effective-clock.ts';
import { runningSessionIds } from '../src/attendee/schedule-view-model.ts';
import { timeRange } from '../src/attendee/schedule-view-model.ts';
import type { AttendeeSchedule } from '../src/api/client.ts';

/**
 * Writes a Schedule through the cache, reads it back, and prints what an attendee would see – in a
 * fresh process whose `TZ` is whatever Node read at start-up.
 *
 * **A separate process because `TZ` is read once when Node starts.** Setting `process.env.TZ` inside
 * a running test changes nothing that matters and would let a timezone leak pass unnoticed, which
 * is why S04, S06 and S09 all do exactly this. The FIS asks for it here too (Testing Strategy):
 * IndexedDB's structured clone is a **new serialization boundary** for S04's naive wall-clock
 * strings, and a coercion introduced there is invisible on a UTC runner.
 *
 * The values below are fixed, so any difference between two runs of this probe is a timezone
 * reaching something it must never reach – the stored strings, the rendered range, or the
 * running-Session decision the rehydrated clock drives.
 */

const SUB = 'google-sub-nadia';
const CONFERENCE = '11111111-1111-4111-8111-111111111111';

/** 09:40 at the venue, and the device clock read three hours fast when this landed. */
const SERVER_NOW = {
  instant: '2026-09-15T07:40:12.345678Z',
  day: '2026-09-15',
  time: '09:40',
};
const SYNC_INSTANT_MILLIS = Date.UTC(2026, 8, 15, 7, 40, 12, 345);
const DEVICE_CLOCK_AT_RECEIPT = SYNC_INSTANT_MILLIS + 3 * 3_600_000;

const envelope: AttendeeSchedule = {
  conference: {
    id: CONFERENCE,
    name: 'Autumn Offsite',
    startDate: '2026-09-15',
    endDate: '2026-09-16',
    state: 'published',
    lastUpdatedAt: '2026-09-15T08:00:00.000000Z',
  },
  days: [
    {
      date: '2026-09-15',
      dayNumber: 1,
      sessions: [
        {
          id: 'keynote',
          title: 'Opening Keynote',
          description: null,
          kind: 'Presentation',
          startTime: '09:00',
          endTime: '10:30',
          location: 'Main Hall',
          concurrentWith: [],
        },
        {
          id: 'design',
          title: 'Design Workshop',
          description: null,
          kind: 'Workshop',
          // Just after midnight, where a westward offset would roll the day back if one were applied.
          startTime: '00:15',
          endTime: '01:00',
          location: 'Room B',
          concurrentWith: [],
        },
      ],
    },
    { date: '2026-09-16', dayNumber: 2, sessions: [] },
  ],
  serverNow: SERVER_NOW,
};

async function main(): Promise<void> {
  await writeCachedSchedule(SUB, CONFERENCE, {
    envelope,
    watermark: envelope.conference.lastUpdatedAt,
    deviceClockAtReceipt: DEVICE_CLOCK_AT_RECEIPT,
  });

  const cached = await readCachedSchedule(SUB, CONFERENCE);
  if (cached === null) throw new Error('the probe wrote an entry the store would not return');

  const day = cached.envelope.days[0]!;
  // Twenty minutes on from the sync, by the device's own (three-hours-fast) clock.
  const clock = rehydrateClock(anchorOf(cached), () => DEVICE_CLOCK_AT_RECEIPT + 20 * 60_000);
  const now = clock.effectiveWallClockNow();

  process.stdout.write(
    JSON.stringify({
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      offsetMinutes: new Date('2026-09-15T00:00:00Z').getTimezoneOffset(),
      // The stored strings, straight out of structured clone.
      date: day.date,
      sessions: day.sessions.map((session) => ({
        id: session.id,
        startTime: session.startTime,
        endTime: session.endTime,
        range: timeRange(session),
      })),
      // And the two things the rehydrated clock decides.
      now,
      running: [...runningSessionIds(cached.envelope, now)],
    }),
  );
}

void main();
