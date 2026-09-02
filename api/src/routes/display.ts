import type { FastifyInstance } from 'fastify';
import type { Clock } from '../conferences/calendar-date.ts';
import type { CategoryRepository } from '../rounds/category-repository.ts';
import type { PostItRepository } from '../rounds/post-it-repository.ts';
import { toBoardWire, NO_VIEWER } from '../rounds/board-wire.ts';
import { displayLinkUnavailable, resolveDisplayLink } from '../rounds/display-link.ts';
import type { DisplayLinkRepository } from '../rounds/display-link-repository.ts';

/**
 * `GET /api/display/:token` – **confApp's first unauthenticated route over domain content**, and the
 * projected Board's only data path (FR7, US01).
 *
 * The other two anonymous routes are bounded by having nothing to give: `/api/health` is
 * deliberately factless and documents that it must never grow domain, personal or configuration
 * data, and `POST /api/auth/token` is how a caller *obtains* a credential in the first place. This
 * one carries Post-its, and Post-its carry their authors' names. Its cost is therefore bounded by
 * two things instead, and both are properties to be proved rather than hardening to add later:
 *
 *   - **the token**, which is 256 bits of CSPRNG output derived from nothing (`display-link.ts`),
 *     and
 *   - **the scope**, which is one Post-it Round's Board and nothing else in the Conference.
 *
 * **The tables this route can reach, in full**: `display_link`, `round`, `sessions`, `conference`,
 * `category`, `post_it`, `post_it_delivery` and `app_user`. That list is not prose - it is the
 * allow-list `api/test/display-link-structure.test.ts` extracts table names against, over **every**
 * module reachable from this file, so a later edit that reaches a ninth table fails the build rather
 * than quietly widening this comment's meaning.
 *
 * It reaches **no vote or ballot table by any path**. Two decisions keep that structural rather than
 * incidental: the Board projection lives in `rounds/board-wire.ts` so importing it does not drag
 * `routes/rounds.ts`'s vote repository onto this graph, and the Round's prompt is read by
 * `findByToken`'s own statement rather than through `RoundRepository`, which would hydrate
 * `round_option` - the Poll's option set - on every poll from every room machine (ADR-006, Binding
 * Constraint FR8; review 2026-08-31, M2).
 *
 * What it cannot do: anything at all. Only `GET` is registered, no repository write seam is
 * injected, and nothing about the caller reaches a column - there is no caller.
 *
 * Nothing is remembered between requests (ADR-004). The room machine re-asks every few seconds and
 * every one of those requests re-reads the row, the lifecycle state and the day, which is the whole
 * mechanism behind "revocation takes effect at the next poll with nobody touching the room
 * machine".
 */

export interface DisplayRouteDependencies {
  postIts: PostItRepository;
  categories: CategoryRepository;
  displayLinks: DisplayLinkRepository;
  /** The server's calendar date, injected so a test can state the day the bound is judged on. */
  clock: Clock;
}

/** The one path this route owns. Exported so the log redaction and the audit can name it once. */
export const DISPLAY_ROUTE_PREFIX = '/api/display/';

export const DISPLAY_ROUTE_URL = `${DISPLAY_ROUTE_PREFIX}:token`;

/**
 * A request line with the token taken out of it.
 *
 * Fastify's default request logging records `req.url`, so without this the bearer credential this
 * whole story exists to protect would be written to the API's log on every poll from every room
 * machine - several times a minute, for the length of a conference, in the one place nobody
 * expects credentials to be. It is the same discipline `withAuth` already applies to the
 * `Authorization` header, which it neither logs nor attaches to the request.
 *
 * The path is replaced rather than dropped so an operator can still see that a display read
 * happened, and how often.
 */
/**
 * Is this URL a request for the display route, however it was spelled?
 *
 * **The comparison is on a normalised path, and that is load-bearing rather than tidy.** Three
 * separate sites decide "is this a display URL?" - this redaction, the not-found handler and the
 * framework-error handler - and every one of them used to ask `startsWith` of the raw path. Fastify
 * defaults to `ignoreDuplicateSlashes: false` and `caseSensitive: true`, so `//api/display/<token>`
 * and `/API/display/<token>` match no route *and* match none of the three guards: the request falls
 * through to `routeNotFound`, which builds its message from the path, putting the live bearer
 * credential into a response body - and into the request line every one of these exists to keep it
 * out of. One un-normalised prefix test defeated all three at once (gap review 2026-09-02, G29).
 *
 * Collapsing runs of `/` and lower-casing is enough for the two shapes Fastify itself will not
 * normalise. Percent-encoding is not decoded here: the router rejects a malformed escape before
 * any handler runs, and decoding attacker-controlled input to make a security decision is the
 * larger hazard.
 */
export function isDisplayPath(url: string): boolean {
  const raw = url.split('?')[0] ?? url;

  /*
   * Percent-escapes are decoded first, repeatedly and defensively. `find-my-way` decodes for
   * *matching* but hands the handler the raw `request.url`, so `/%61pi/display/<token>` and
   * `/api/display%2f<token>` are display requests that no raw prefix test recognises. A malformed
   * escape throws and stops the loop, which is the safe direction: it cannot make a display URL
   * look like something else.
   */
  let decoded = raw;
  for (let pass = 0; pass < 3; pass += 1) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      break;
    }
    if (next === decoded) break;
    decoded = next;
  }

  /*
   * Then the shapes the router resolves and a prefix test does not: duplicate separators, `.` and
   * `..` segments, control characters and case.
   *
   * **This predicate is deliberately generous, and the asymmetry is the point.** It decides only
   * whether a URL is *redacted*. A false positive costs one log line reading
   * `/api/display/<token>` for a request that was never a display request; a false negative
   * writes a live bearer credential to disk. So anything that could resolve to the display route
   * is treated as though it did (gap re-review 2026-09-02, G29).
   */
  const segments: string[] = [];
  // Whitespace and control characters, stripped without a control-character regex literal.
  const stripped = [...decoded].filter((ch) => ch.charCodeAt(0) > 0x20).join('');
  for (const segment of stripped.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  return ('/' + segments.join('/') + '/').toLowerCase().startsWith(DISPLAY_ROUTE_PREFIX);
}

export function redactDisplayToken(url: string): string {
  if (!isDisplayPath(url)) return url;
  return `${DISPLAY_ROUTE_PREFIX}<token>`;
}

export function registerDisplayRoute(
  app: FastifyInstance,
  { postIts, categories, displayLinks, clock }: DisplayRouteDependencies,
): void {
  /*
   * **No schema on `:token`, and that omission is load-bearing.**
   *
   * A `pattern` or `minLength` here would answer a wrong-shaped value with `VALIDATION_FAILED`
   * before the handler ran, while a real-but-dead token answered the neutral refusal. The
   * difference between those two responses is an oracle: it tells whoever is guessing "that was
   * not even a token" apart from "that was a token, and it is dead" - which is a fact about
   * confApp's data disclosed to somebody holding no credential at all. A malformed value simply
   * matches no row, which is the honest answer and the same one.
   *
   * The canonical shape still exists (`isCanonicalDisplayToken`) and is still a CHECK on the
   * column. It is a statement about what is *minted* and *stored*, never a gate on what may be
   * *asked*.
   */
  app.get<{ Params: { token: string } }>(DISPLAY_ROUTE_URL, async (request, reply) => {
    /*
     * `no-store`, not `no-cache`. Revocation "takes effect without user action on the room machine
     * … at the next poll" (NFR) is only true if nothing between this API and the projector is
     * allowed to answer from a copy - a proxy, a CDN, the browser's own HTTP cache, or a service
     * worker. `web/public/sw.js` refuses to store this path too (S04 TI12); both halves are needed,
     * because only one of them is under confApp's control on an arbitrary room machine's network.
     */
    void reply.header('cache-control', 'no-store');

    const { token } = request.params;

    /*
     * One predicate decides, and its failure result carries no reason for this handler to read.
     * There is deliberately nothing here to branch on: revoked, past the Session day, Draft
     * Conference, deleted Round and never-issued all arrive as the same value, so the byte-identical
     * refusal is structural rather than a discipline this handler has to keep.
     */
    const resolution = resolveDisplayLink(await displayLinks.findByToken(token), clock);
    if (!resolution.resolved) throw displayLinkUnavailable();

    const { conferenceId, roundId, prompt, roundKind } = resolution.link;

    /*
     * The Round's own facts came out of the **same statement** that found the link, so there is no
     * second read to disagree with the first and no window in which the Round could vanish between
     * them. A deleted Round takes its links with it (`ON DELETE CASCADE`), so it arrives here as an
     * unmatched token and reaches the identical refusal - which is what the edge case requires.
     *
     * The kind is re-asserted rather than trusted: the table's CHECK and composite foreign key make
     * a link on anything but a Post-it Round unwritable, and this is what turns "unwritable" into
     * "and if one ever existed, it would answer nothing".
     */
    if (roundKind !== 'PostItRound') throw displayLinkUnavailable();

    const [boardCategories, boardPostIts] = await Promise.all([
      categories.listForRound(conferenceId, roundId),
      postIts.listForRound(conferenceId, roundId),
    ]);

    /*
     * The Board, through the **same projection** the signed-in Session read uses - Categories in
     * the Facilitator's order with their Post-its and their author display names, plus Uncategorised
     * and the counts (`plan.json#sharedDecisions` -> "Board read projection contract"). Not a second
     * shape: the room's Board and the Facilitator's phone must not be able to describe one Round
     * differently.
     *
     * `NO_VIEWER` is the whole of what changes: there is no signed-in viewer, so nothing is `mine`.
     *
     * `prompt` rides along because the projection is only a Board - a room reading a wall of
     * post-its needs to see the question they answer. Nothing else about the Round is here, and
     * nothing at all about its Session, its Conference, the sibling Rounds, the Join Code, the
     * Membership list or the roles: the link is scoped to this Board and is powerless everywhere
     * else. There is no cursor either - the projected surface uses no activity watermark, so S07
     * polls this whole (cheap, one-Round) payload instead.
     */
    return {
      prompt,
      ...toBoardWire({ categories: boardCategories, postIts: boardPostIts }, NO_VIEWER),
    };
  });

  /*
   * **No `ConferenceRepository` is injected here, deliberately.** The lifecycle fact this route
   * needs came out of `findByToken`'s single statement, and a second read of the Conference could
   * disagree with the one the decision was made on. The dependency list above is meant to be read
   * as an honest statement of everything this anonymous route may touch.
   */
}
