import { AppError, ERROR_CODES } from '../errors.ts';
import { daySpan, isCalendarDate, type CalendarDate } from './calendar-date.ts';

/**
 * The Conference field rules (FR1), and the refusals a person reads when they are broken.
 *
 * Every message here is shown to an organizer, so each one names the field it is about and states
 * the permitted range rather than reporting that something was "invalid" – "between 1 and 4 days"
 * is actionable, "invalid date span" is not. Each distinct reason carries its own machine code so
 * the form can attach the message to the right input without parsing prose.
 *
 * The route's JSON schema has already established that the fields are present and are strings by
 * the time anything here runs; these are the business rules on top of that shape.
 */

export const NAME_MAX_LENGTH = 120;
export const MIN_DAYS = 1;
export const MAX_DAYS = 4;

export interface ConferenceDetailsInput {
  name: string;
  startDate: string;
  endDate: string;
}

export interface ConferenceDetails {
  name: string;
  startDate: CalendarDate;
  endDate: CalendarDate;
}

function nameRefusal(message: string): AppError {
  return new AppError(ERROR_CODES.CONFERENCE_NAME_INVALID, 400, message, [
    { field: 'name', message },
  ]);
}

/**
 * The offending field is reported as `startDate` and `endDate` together: the span is a property
 * of the pair, and blaming one of them would send the organizer to correct the wrong input.
 */
function spanRefusal(message: string): AppError {
  return new AppError(ERROR_CODES.CONFERENCE_DATE_SPAN_INVALID, 400, message, [
    { field: 'startDate', message },
    { field: 'endDate', message },
  ]);
}

/**
 * Validates and normalises, in that order, and returns the values that should actually be stored
 * – the name trimmed. Returning the normalised form is what stops a caller from validating one
 * value and persisting another.
 */
export function validateConferenceDetails(input: ConferenceDetailsInput): ConferenceDetails {
  const name = input.name.trim();

  if (name === '') {
    throw nameRefusal('A conference name is required.');
  }
  if (name.length > NAME_MAX_LENGTH) {
    throw nameRefusal(
      `A conference name can be at most ${NAME_MAX_LENGTH} characters, and this one is ${name.length}.`,
    );
  }

  if (!isCalendarDate(input.startDate) || !isCalendarDate(input.endDate)) {
    throw spanRefusal('Give the start and end dates as calendar dates in the form YYYY-MM-DD.');
  }

  const span = daySpan(input.startDate, input.endDate);

  if (span < MIN_DAYS) {
    throw spanRefusal('The end date must be on or after the start date.');
  }
  if (span > MAX_DAYS) {
    throw spanRefusal(
      `A conference runs for between ${MIN_DAYS} and ${MAX_DAYS} consecutive days, ` +
        `and these dates span ${span}.`,
    );
  }

  return { name, startDate: input.startDate, endDate: input.endDate };
}
