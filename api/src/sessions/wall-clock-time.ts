/**
 * Naive wall-clock times – 'HH:mm' and nothing else.
 *
 * A Session authored at 09:00 reads 09:00 on every device, whatever timezone that device is set
 * to (PRD → Constraints, Binding Constraint FR4). Three layers must each independently refuse to
 * convert, and this module is the API's half of that:
 *
 *   - the **database** stores `time without time zone`, which has no offset to apply;
 *   - the **query layer** asks PostgreSQL for the wire form directly (`to_char(..., 'HH24:MI')`),
 *     so the value is already a string before it reaches JavaScript and `JSON.stringify` has
 *     nothing to render as a UTC instant;
 *   - the **client** keeps it a string all the way to the screen.
 *
 * Nothing here constructs a `Date`, and nothing may. `new Date('09:00')` is not even a coherent
 * question – it needs a day and a zone to answer, and inventing both is precisely the coercion
 * this representation exists to make impossible. Comparison is a plain text compare: zero-padded
 * 24-hour times sort chronologically as strings, so the representation does the work.
 *
 * The timestamp fields (`lastUpdatedAt`) are the deliberate exception – those genuinely *are*
 * instants and are serialized as ISO-8601 UTC. See `instantExpression` below.
 */

/** A time known to be well-formed: 24-hour, zero-padded, no seconds, no offset. */
export type WallClockTime = string;

const SHAPE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isWallClockTime(value: unknown): value is WallClockTime {
  return typeof value === 'string' && SHAPE.test(value);
}

/** Negative when `a` is earlier. Text comparison – see the module note. */
export function compareTimes(a: WallClockTime, b: WallClockTime): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The SQL that produces the wire form of a `time` column: `'09:00'`, never `'09:00:00'` and never
 * anything a driver could hand back as a `Date`.
 */
export function wallClockExpression(column: string, alias: string): string {
  return `to_char(${column}, 'HH24:MI') as ${alias}`;
}

/**
 * The SQL that produces the wire form of a `timestamptz` column: ISO-8601 UTC with full
 * microsecond precision.
 *
 * Formatted in PostgreSQL rather than in JavaScript because `node-postgres` parses `timestamptz`
 * into a JS `Date`, which holds **milliseconds** – so `.586195` arrives as `.586` and three
 * digits of the value S09 compares against are gone before any code here could preserve them.
 * `to_char` with `US` keeps all six.
 */
export function instantExpression(column: string, alias: string): string {
  return `to_char(${column} at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ${alias}`;
}
