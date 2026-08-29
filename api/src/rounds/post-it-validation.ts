import { AppError, ERROR_CODES } from '../errors.ts';

/**
 * The Post-it text rule (FR3), and the refusal a person reads when it is broken.
 *
 * **This module is the single authoritative definition of the length cap.** The number appears
 * here once and is interpolated everywhere it is needed: into the refusal message the route emits,
 * into the Session payload so the compose box can render the limit, and into the boundary
 * assertions that pin the migration's `CHECK` to it. Nothing under `web/` carries a copy - it
 * cannot import from `api/src` (its `rootDir` is `src`), so a mirrored client constant would be a
 * second source rather than the same one, and the payload is what closes that gap.
 *
 * Shaped after `api/src/sessions/session-validation.ts#TITLE_MAX_LENGTH`, which established the
 * idiom: one exported constant, interpolated into a message that names the limit it enforces and
 * the value that broke it, so the person mid-typing knows what to change rather than being told
 * "invalid input".
 *
 * The route's JSON schema has already established that `text` is present and is a string by the
 * time anything here runs; this is the business rule on top of that shape.
 */

/**
 * How long a Post-it may be, in characters.
 *
 * 280, confirmed by preflight on 2026-08-28 (`s02-named-post-it-contribution.md` -> DECISION NOTE:
 * post-it-length-cap). The PRD specifies only "a length cap in the low hundreds of characters"; 280
 * keeps a projected board scannable and keeps a Post-it a single idea rather than a paragraph.
 *
 * The migration's `CHECK` is the storage backstop and is the one unavoidable second copy of this
 * number. It is pinned here by test, not by comment.
 */
export const POST_IT_MAX_LENGTH = 280;

export interface PostItTextInput {
  text: string;
}

/**
 * Length as PostgreSQL counts it.
 *
 * `char_length` counts **code points**; JavaScript's `.length` counts UTF-16 code units, so a
 * string of 300 emoji measures 600 there and 300 here. The two layers have to state the same limit
 * for stating it twice to mean anything - and a refusal naming a number the person cannot see on
 * their own screen is worse than no number at all (the same reasoning as
 * `round-validation.ts#characters`).
 */
function characters(value: string): number {
  return [...value].length;
}

/**
 * The trimmed text that should actually be stored, or the refusal that names why not.
 *
 * Trimmed before it is measured, so trailing whitespace never costs somebody their last word, and
 * whitespace-only text is blank rather than 12 characters long.
 */
export function validatePostItText(input: PostItTextInput): string {
  const text = input.text.trim();

  if (text === '') {
    throw refusal('A post-it needs some text before it can go on the board.');
  }

  if (characters(text) > POST_IT_MAX_LENGTH) {
    throw refusal(
      `A post-it can be at most ${POST_IT_MAX_LENGTH} characters, and this one is ` +
        `${characters(text)}.`,
    );
  }

  return text;
}

/** Field-level, because the compose box attaches it to the box the typed text is still sitting in. */
function refusal(message: string): AppError {
  return new AppError(ERROR_CODES.POST_IT_TEXT_INVALID, 400, message, [{ field: 'text', message }]);
}
