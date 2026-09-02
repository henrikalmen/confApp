import { AppError, ERROR_CODES } from '../errors.ts';

/**
 * The Category name rule (FR1), and the refusal a person reads when it is broken.
 *
 * **This module is the single authoritative definition of the name cap.** The number appears here
 * once and is interpolated everywhere it is needed: into the refusal message the route emits, and
 * into the boundary assertions that pin the migration's `CHECK` to it. Nothing under `web/` carries
 * a copy - it cannot import from `api/src` (its `rootDir` is `src`), so a mirrored client constant
 * would be a second source rather than the same one, and the surface simply renders the server's
 * refusal instead of restating the limit.
 *
 * Shaped exactly after `api/src/rounds/post-it-validation.ts#validatePostItText`, which established
 * the idiom: one exported constant, interpolated into a field-level message that names the limit it
 * enforces *and* the value that broke it, so the person mid-typing knows what to change rather than
 * being told "invalid input".
 *
 * The route's JSON schema has already established that `name` is present and is a string by the
 * time anything here runs; this is the business rule on top of that shape.
 */

/**
 * How long a Category name may be, in characters.
 *
 * 60, from `prd.md#fr1-categories-on-a-board`: "at most 60 characters, counted in Unicode code
 * points and measured after the trim". A Category name is a label a room reads at a glance and a
 * projector renders at several metres, not a sentence.
 *
 * The migration's `CHECK` is the storage backstop and is the one unavoidable second copy of this
 * number. It is pinned here by test, not by comment.
 */
export const CATEGORY_NAME_MAX_LENGTH = 60;

/**
 * How many Categories one Board may hold.
 *
 * 20, from `prd.md#fr1-categories-on-a-board`. It is **not enforced here**: a `select count(*)`
 * followed by an `insert` is precisely the check two container replicas both pass (ADR-004), and
 * `prd.md#non-functional-requirements` requires that the cap cannot be raced past. The enforcement
 * is `CHECK (position BETWEEN 1 AND 20)` plus a deferred `UNIQUE (round_id, position)` in
 * `db/migrations/20260902090000000_category-and-placement.sql`, and that CHECK's literal is the one
 * permitted second copy of this number - pinned to it by test, never by comment.
 *
 * What this constant is for is the *sentence*: the refusal names the limit alongside the count read
 * fresh at the moment it was refused, so a Facilitator reads "at most 20, and this board holds 20"
 * rather than a bare failure.
 */
export const CATEGORY_LIMIT_PER_BOARD = 20;

export interface CategoryNameInput {
  name: string;
}

/**
 * Length as PostgreSQL counts it.
 *
 * `char_length` counts **code points**; JavaScript's `.length` counts UTF-16 code units, so a name
 * of 60 emoji measures 120 there and 60 here. The two layers have to state the same limit for
 * stating it twice to mean anything - and a refusal naming a number the person cannot see on their
 * own screen is worse than no number at all.
 */
function characters(value: string): number {
  return [...value].length;
}

/**
 * The trimmed name that should actually be stored, or the refusal that names why not.
 *
 * Trimmed before it is measured, so trailing whitespace never costs somebody their last word, and
 * a whitespace-only name is blank rather than three characters long.
 */
export function validateCategoryName(input: CategoryNameInput): string {
  const name = input.name.trim();

  if (name === '') {
    throw refusal('A category needs a name.');
  }

  if (characters(name) > CATEGORY_NAME_MAX_LENGTH) {
    throw refusal(
      `Category names are at most ${CATEGORY_NAME_MAX_LENGTH} characters, and this one is ` +
        `${characters(name)}.`,
    );
  }

  return name;
}

/** Field-level, because the surface attaches it to the box the typed name is still sitting in. */
function refusal(message: string): AppError {
  return new AppError(ERROR_CODES.CATEGORY_NAME_INVALID, 400, message, [
    { field: 'name', message },
  ]);
}
