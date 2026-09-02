import { ApiError, apiRequest } from './request.ts';

/**
 * The Board read projection, and the one anonymous read of it.
 *
 * **One shape, in one place, for every surface that renders a Board** - the Facilitator's phone,
 * the Attendee's live view and the projected wall, so that none of them can describe the same Round
 * differently (`plan.json#sharedDecisions` -> "Board read projection contract"). It mirrors the
 * server's own single projection in `api/src/rounds/board-wire.ts`.
 *
 * It is a **module of its own**, separate from `api/client.ts`, and that is structural rather than
 * tidiness (S07, 2026-08-31, review H2). The projected Board View is served to a room machine with
 * no Workspace session on shared hardware, and it must reach no vote, ballot, option or Join Code
 * endpoint by any path. `client.ts` carries all of them; importing it for one anonymous `GET` put
 * every one of them into the chunk that machine downloads. Here there is nothing to reach: this
 * file imports the transport and nothing else.
 */

/**
 * One Post-it on a Round's board, as the Session read returns it.
 *
 * `authorName` is joined from `app_user.display_name` server-side on every read, so a rename
 * reaches every Post-it its owner ever wrote. `mine` is the **server's** answer to "may I change
 * this one", consumed rather than re-derived - the same discipline as `canRun`, and the reason no
 * client-side opinion about authorship exists to drift out of step with the write predicate that
 * actually enforces it.
 *
 * There is no author `sub` and no timestamp here. The `sub` is an identity confApp has no reason to
 * publish to the room, and an instant is something this client could only render by converting a
 * timezone the product does not carry - `edited` is the flag the board shows instead.
 */
export interface PostIt {
  id: string;
  text: string;
  authorName: string;
  /** Whether the signed-in viewer wrote it. The server's answer. */
  mine: boolean;
  edited: boolean;
  /**
   * Whether it reached the board after its Round had closed - a Post-it composed with no
   * connection and sent when the signal returned (FR6).
   *
   * The **server's** answer, decided from the Round's state at the instant the row was written.
   * There is no client-side rule about lateness and none could exist here: the device does not
   * know what the Round was doing when its queued item finally landed.
   */
  arrivedAfterClose: boolean;
}

/**
 * One Category on a Board, as the Session read returns it.
 *
 * `postItCount` is the **server's** count, consumed rather than re-derived from `postIts.length` -
 * the same discipline as `canRun` and `mine`. A client that counted for itself would be a second
 * opinion about what the Board holds, and the surfaces this bundle adds all have to agree.
 */
export interface Category {
  id: string;
  name: string;
  /** The Post-its placed here, in Board order. */
  postIts: PostIt[];
  postItCount: number;
}

/**
 * Uncategorised: the Post-its nobody has placed yet, and how many there are.
 *
 * Shaped deliberately unlike `Category` - no `id`, no `name`, no `position` - so that no control
 * this client offers a Category can be offered to it by accident. It is the state of a Post-it
 * having no placement, not a Category with a reserved identifier.
 */
export interface Uncategorised {
  postIts: PostIt[];
  postItCount: number;
}

/**
 * One Post-it Round's Board as the **Display Link** returns it (FR7).
 *
 * The same `Category` and `Uncategorised` shapes the signed-in Session read uses - one Board
 * projection, server-side, so the projected wall and the Facilitator's phone cannot describe one
 * Round differently. `prompt` rides along because a room reading a wall of post-its needs the
 * question they answer.
 *
 * **Both halves are required, and that is deliberate.** They are optional on `Round`, where a
 * payload that never loaded a board omits them - and defaulting an absent board to an empty one
 * there would render "this round collected no post-its", a positive claim the API declined to make.
 * This endpoint always carries the board it resolved, so an absent half is a payload that is not
 * ours; `fetchDisplayBoard` refuses it rather than filling it in.
 *
 * **There is nothing vote-shaped here and there cannot be**: no tally, no option, no `hasVoted`.
 * The route this comes from reaches no vote table by any path
 * (`docs/adrs/ADR-006-vote-anonymity-holds-against-application-paths-not-database-credentials.md`).
 *
 * There is no cursor either. The projected surface uses no activity watermark, so the room machine
 * re-reads this whole (one-Round, cheap) payload on its poll.
 */
export interface DisplayBoard {
  prompt: string;
  categories: Category[];
  uncategorised: Uncategorised;
}

/**
 * The one sentence a dead Display Link produces, whatever killed it.
 *
 * Revoked, past its Session day, Conference still in draft, Round deleted and never issued are one
 * answer with one code and one message. This constant is the message the server sends, held here so
 * the display surface renders it without inventing a second wording - and so a *transport* failure
 * is visibly a different thing from a refusal.
 */
export const DISPLAY_LINK_UNAVAILABLE_CODE = 'DISPLAY_LINK_UNAVAILABLE';

/**
 * Whether a body is recognisably a Board. Shape, not value - see `DisplayBoard`.
 *
 * **Every half it renders, including the counts.** The check used to stop at "categories is an
 * array" and "uncategorised has a postIts array", which let a payload carrying no `postItCount`
 * through to a surface that renders `postItCount` as its most prominent, never-degrading element:
 * the room would have read an empty count pill and a band saying `NaN post-its` (S07, 2026-08-31,
 * review M3). A guard that refuses a payload "rather than filling it in" has to cover what the
 * renderer actually reads.
 */
function isRegion(region: unknown, named: boolean): boolean {
  if (typeof region !== 'object' || region === null) return false;
  const candidate = region as Partial<Category>;
  if (!Array.isArray(candidate.postIts)) return false;
  if (typeof candidate.postItCount !== 'number' || !Number.isFinite(candidate.postItCount)) {
    return false;
  }
  // A Category is addressed by id and read by name; Uncategorised has neither, and must not.
  return !named || (typeof candidate.id === 'string' && typeof candidate.name === 'string');
}

function isDisplayBoard(body: unknown): body is DisplayBoard {
  if (typeof body !== 'object' || body === null) return false;
  const candidate = body as Partial<DisplayBoard>;
  return (
    typeof candidate.prompt === 'string' &&
    Array.isArray(candidate.categories) &&
    candidate.categories.every((category) => isRegion(category, true)) &&
    isRegion(candidate.uncategorised, false)
  );
}

/**
 * Reads one Board through a Display Link – **with no credential of any kind** (FR7, US01).
 *
 * `authenticated: false`, so no `Authorization` header is sent, no token source is consulted, and
 * nothing session-derived reaches the request. That is the point of the whole surface: the room
 * machine has no Workspace session and must not acquire one on shared hardware. It also means a
 * refusal here can never be a sign-in prompt - there is no sign-in to prompt for.
 *
 * The token travels in the **path**, never a query string. A `Response` keeps its own URL and a
 * navigate-mode service-worker branch caches the query string, which is how the OIDC `?code=` once
 * reached Cache Storage (`docs/LEARNINGS.md#service-workers--cache-storage`); a bearer credential
 * in a query string is the same defect with a longer life, and query strings are where credentials
 * habitually end up in logs.
 *
 * An unrecognisable body is refused rather than rendered. Without that, a captive portal's `200
 * text/html` would read as a Board with no categories, and a projector would show "no post-its yet"
 * for a wall of them.
 */
export async function fetchDisplayBoard(
  token: string,
  signal?: AbortSignal,
): Promise<DisplayBoard> {
  const body = await apiRequest<unknown>(`/display/${encodeURIComponent(token)}`, {
    authenticated: false,
    ...(signal ? { signal } : {}),
  });

  if (!isDisplayBoard(body)) {
    // Status 0, like every other "this never reached our API" case, so a caller's existing
    // unreachable branch keeps working and no new classification has to be kept in step.
    throw new ApiError(
      'UNRECOGNISED_RESPONSE',
      'Something answered on the network, but it was not the confApp API.',
      0,
    );
  }

  return body;
}
