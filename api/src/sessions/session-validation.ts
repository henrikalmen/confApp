import { AppError, ERROR_CODES } from '../errors.ts';
import {
  addDays,
  compareDates,
  isCalendarDate,
  type CalendarDate,
} from '../conferences/calendar-date.ts';
import { isWallClockTime, type WallClockTime } from './wall-clock-time.ts';

/**
 * The Session field rules (FR2), and the refusals a person reads when they are broken.
 *
 * Every message names the rule it enforces and what is permitted instead – "the end time must be
 * after the start time" and a list of the Conference's actual days, not "invalid input". The
 * Organizer is mid-composition and has to know which value to change.
 *
 * What is deliberately **not** here: any check on overlap. Two Sessions at the same time are a
 * Parallel Track (`docs/UBIQUITOUS_LANGUAGE.md`), an explicitly supported option, so a validation
 * path that refused one would be a defect. Overlap is computed on read and reported as a warning
 * beside a save that succeeded – see `overlap.ts`.
 *
 * The route's JSON schema has already established that the fields are present and are strings by
 * the time anything here runs; these are the business rules on top of that shape.
 */

export const TITLE_MAX_LENGTH = 200;
export const LOCATION_MAX_LENGTH = 100;

/** Exactly two kinds. `docs/UBIQUITOUS_LANGUAGE.md` – a Session is a Presentation or a Workshop. */
export const SESSION_KINDS = ['Presentation', 'Workshop'] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

export function isSessionKind(value: unknown): value is SessionKind {
  return typeof value === 'string' && (SESSION_KINDS as readonly string[]).includes(value);
}

export interface SessionDetailsInput {
  title: string;
  description?: string | null;
  kind: string;
  day: string;
  startTime: string;
  endTime: string;
  location: string;
}

/** Validated and normalised – the values that should actually be stored. */
export interface SessionDetails {
  title: string;
  description: string | null;
  kind: SessionKind;
  day: CalendarDate;
  startTime: WallClockTime;
  endTime: WallClockTime;
  location: string;
}

/** The Conference span a Session must land inside. */
export interface ConferenceSpan {
  name: string;
  startDate: CalendarDate;
  endDate: CalendarDate;
}

function refusal(
  code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES],
  message: string,
  ...fields: string[]
): AppError {
  return new AppError(
    code,
    400,
    message,
    fields.map((field) => ({ field, message })),
  );
}

/**
 * Every Conference Day, derived from the span rather than stored.
 *
 * A Conference Day is not an independently created record (PRD → Data Requirements): it *is* a
 * calendar day inside the Conference's dates. Deriving it is what guarantees the Organizer's
 * schedule shows an empty day rather than omitting it, and is what lets a refusal list the days
 * that are actually permitted.
 */
export function conferenceDays(
  span: Pick<ConferenceSpan, 'startDate' | 'endDate'>,
): CalendarDate[] {
  const days: CalendarDate[] = [];
  for (let day = span.startDate; compareDates(day, span.endDate) <= 0; day = addDays(day, 1)) {
    days.push(day);
  }
  return days;
}

/** "2026-09-15 and 2026-09-16"; "2026-09-15, 2026-09-16 and 2026-09-17" for a longer span. */
function listDays(days: readonly CalendarDate[]): string {
  if (days.length === 1) return days[0]!;
  return `${days.slice(0, -1).join(', ')} and ${days[days.length - 1]!}`;
}

export function validateSessionDetails(
  input: SessionDetailsInput,
  conference: ConferenceSpan,
): SessionDetails {
  const title = input.title.trim();

  if (title === '') {
    throw refusal(ERROR_CODES.SESSION_TITLE_INVALID, 'A session title is required.', 'title');
  }
  if (title.length > TITLE_MAX_LENGTH) {
    throw refusal(
      ERROR_CODES.SESSION_TITLE_INVALID,
      `A session title can be at most ${TITLE_MAX_LENGTH} characters, and this one is ${title.length}.`,
      'title',
    );
  }

  const location = input.location.trim();

  if (location === '') {
    throw refusal(
      ERROR_CODES.SESSION_LOCATION_INVALID,
      'A session location is required. It is free text, such as "Main Hall" or "Room 2".',
      'location',
    );
  }
  if (location.length > LOCATION_MAX_LENGTH) {
    throw refusal(
      ERROR_CODES.SESSION_LOCATION_INVALID,
      `A session location can be at most ${LOCATION_MAX_LENGTH} characters, and this one is ${location.length}.`,
      'location',
    );
  }

  if (!isSessionKind(input.kind)) {
    throw refusal(
      ERROR_CODES.SESSION_KIND_INVALID,
      `A session is either a ${SESSION_KINDS.join(' or a ')}.`,
      'kind',
    );
  }

  if (!isCalendarDate(input.day)) {
    throw refusal(
      ERROR_CODES.SESSION_DAY_OUT_OF_SPAN,
      'Give the session day as a calendar date in the form YYYY-MM-DD.',
      'day',
    );
  }

  const days = conferenceDays(conference);
  if (!days.includes(input.day)) {
    throw refusal(
      ERROR_CODES.SESSION_DAY_OUT_OF_SPAN,
      `A session must fall on one of this conference's days. ${conference.name} runs on ` +
        `${listDays(days)}, and ${input.day} is not one of them.`,
      'day',
    );
  }

  if (!isWallClockTime(input.startTime) || !isWallClockTime(input.endTime)) {
    throw refusal(
      ERROR_CODES.SESSION_TIME_RANGE_INVALID,
      'Give the start and end times as 24-hour wall-clock times in the form HH:MM.',
      'startTime',
      'endTime',
    );
  }

  /*
   * End strictly after start, on the one day the session names. This is also what refuses a
   * session spanning midnight: 23:15–00:45 has an end time earlier than its start time on the
   * same Conference Day, and there is no second day for it to run into. The message says so,
   * because "23:15 to 00:45 is invalid" would leave an Organizer trying to work out why.
   */
  if (input.endTime <= input.startTime) {
    throw refusal(
      ERROR_CODES.SESSION_TIME_RANGE_INVALID,
      `A session's end time must be after its start time on the same conference day, and ` +
        `${input.startTime}–${input.endTime} is not. A session cannot run past midnight; ` +
        'split it across two sessions instead.',
      'startTime',
      'endTime',
    );
  }

  const description = input.description?.trim();

  return {
    title,
    // An empty description and no description are the same fact, so both store as null rather
    // than leaving two representations of "there isn't one" for every reader to handle.
    description: description === undefined || description === '' ? null : description,
    kind: input.kind,
    day: input.day,
    startTime: input.startTime,
    endTime: input.endTime,
    location,
  };
}
