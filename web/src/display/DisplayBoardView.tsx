import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
/*
 * **Not `api/client.ts`.** The transport and the Board projection are imported from the two narrow
 * modules they live in, so this bundle reaches no authenticated endpoint helper at all - no
 * `castVote`, no Join Code, no Membership list. See `api/request.ts` for why that is structural
 * rather than tidiness (S07, review H2).
 */
import { ApiError } from '../api/request.ts';
import {
  DISPLAY_LINK_UNAVAILABLE_CODE,
  fetchDisplayBoard,
  type DisplayBoard,
  type PostIt,
} from '../api/board.ts';
import { useWatermarkPoll } from '../poll/use-watermark-poll.ts';
import { onForegroundTick } from '../tick/foreground-tick.ts';
import { stalenessLabel } from '../attendee/staleness.ts';
import { detailTier, postItsAreLegible, regionGrid } from './board-layout.ts';

/**
 * The projected Board, as the room machine renders it (S07).
 *
 * **A mirror, and nothing else.** This surface takes no pointer or keyboard input that could change
 * anything the Board holds: there is no control, no form, no link and no handler bound to any
 * element, at any of its four states. It issues exactly one kind of request in its life - S04's
 * credential-free `GET /api/display/:token` - and it reaches no Vote data by any path, because the
 * route it reads cannot produce any (ADR-006, Binding Constraint FR8).
 *
 * **Revocation and expiry are free, and that is a property of the loop's shape.** The surface
 * subscribes to nothing and remembers nothing but its token. Every poll re-asks the same question
 * and S04's predicate answers it fresh, so a link that has stopped resolving - revoked, past its
 * Session day, its Round deleted, its Conference still Draft, or never issued at all - simply
 * returns the neutral refusal and the Board is replaced, with nobody touching the room machine.
 * `Cache-Control: no-store` on the response is the other half; anything answering from a copy would
 * defeat it, which is why nothing here caches a response and the service worker excludes
 * `/display/` outright.
 *
 * **No cursor, deliberately.** The activity watermark is Session-scoped and Membership-gated
 * (`plan.json#sharedDecisions`), and a room machine holds no Membership. Giving this screen a cursor
 * would mean a second, anonymously reachable change signal over attributed content; re-reading a
 * payload the PRD caps at ~200 Post-its every five seconds is strictly less surface. The token in
 * the path is the only state carried between polls.
 *
 * The Post-it wire shape carries `mine`, and nothing here reads it: there is no viewer for anything
 * to be *mine* to.
 */

/**
 * The one sentence a dead link produces, whatever killed it - revoked, past its Session day,
 * Conference still Draft, Round deleted, never issued, or never a token at all.
 *
 * Byte-identical across all of them, because there is nothing in the refusal that says more and
 * nothing here that could invent it. Anything that told those cases apart would be an oracle over
 * confApp's data handed to a browser holding no credential.
 */
const UNAVAILABLE = 'This board is no longer available.';

/** S01's projected wireframe puts this under it. It is a statement, not a way back in. */
const UNAVAILABLE_DETAIL = 'Ask the facilitator for a new link.';

/**
 * The room's honest answer to a network that is not answering, **before** it ever had a Board.
 *
 * Once a Board has been rendered, a transport failure keeps it on the wall behind the staleness
 * indicator instead - see `Screen` below. This is only the cold-start case.
 */
const UNREACHABLE =
  'This board cannot be reached at the moment. It will reappear when the connection returns.';

const STALE_LEAD = 'Not updating – this screen has lost its connection';
const STALE_TAIL = 'It will catch up on its own when the connection returns.';

/**
 * What the room machine currently knows.
 *
 * **`refused` and `unreachable` are different fields on purpose, and the split is load-bearing.** A
 * *resolved refusal* means the link is dead and the Board is replaced; a *transport failure* means
 * the venue wifi is gone and the last Board stays on the wall with an honest indicator. Collapsing
 * the two either blanks a working room on a network blip - and somebody goes and reissues a link
 * that was never dead - or leaves a revoked Board projected until a human notices. Both failures
 * come from one omission, so the branch is on whether the response *resolved*, never on
 * `navigator.onLine` and never on a timeout.
 */
interface Screen {
  /** The last Board that arrived, kept across failed polls so the wall does not blank. */
  board: DisplayBoard | null;
  /** The link no longer resolves. Clears the Board; nothing else can set this. */
  refused: boolean;
  /** The last poll did not reach the API at all. */
  unreachable: boolean;
  /** `Date.now()` at the last **successful** poll - the anchor the staleness age is measured from. */
  lastSuccessAt: number | null;
}

export interface DisplayBoardViewProps {
  /** `null` when the URL named no token at all. Renders the same neutral sentence. */
  token: string | null;
}

export function DisplayBoardView({ token }: DisplayBoardViewProps): React.JSX.Element {
  const [screen, setScreen] = useState<Screen>({
    board: null,
    refused: token === null,
    unreachable: false,
    lastSuccessAt: null,
  });

  /**
   * The request currently outstanding, if any - **the surface's own one-in-flight latch**.
   *
   * The shared loop keeps at most one of *its* requests in flight, but this surface has a second
   * caller: the read at mount, which must not wait five seconds for the first tick. Without a latch
   * spanning both, a slow first read and the loop's first tick overlap, and a room machine on a bad
   * network builds exactly the pile-up of requests `useWatermarkPoll` exists to prevent.
   *
   * The latch holds the **signal**, not a boolean, and an *aborted* request is not in flight any
   * more. A boolean would deadlock the mount read under React's development double-invoke: the
   * effect's cleanup aborts the first attempt and re-runs synchronously, long before the aborted
   * fetch rejects and could release a boolean - so the second attempt would be skipped and the wall
   * would stay blank until the first tick.
   */
  const outstanding = useRef<AbortSignal | null>(null);

  /**
   * One poll: re-request the **whole Board**, and classify the answer.
   *
   * Memoized over the token alone, which is the only thing it reads - so the loop is built once and
   * is not restarted by a render.
   */
  const read = useCallback(
    async (signal: AbortSignal): Promise<void> => {
      if (token === null) return;
      // Skipped, never queued - the same rule the shared loop applies to its own requests.
      if (outstanding.current !== null && !outstanding.current.aborted) return;
      outstanding.current = signal;
      try {
        const board = await fetchDisplayBoard(token, signal);
        if (signal.aborted) return;
        setScreen({ board, refused: false, unreachable: false, lastSuccessAt: Date.now() });
      } catch (error) {
        if (signal.aborted) return;
        /*
         * **Answered** - so the link is dead, and the Board is replaced.
         *
         * The designed case is the neutral refusal, named here rather than inferred from a status.
         * Every other answered failure reaches the same sentence below, and the server's own words
         * are deliberately discarded in both: rendering whatever message a `status > 0` failure
         * carried would put an internal-error string, or a proxy's 502 text, on a wall in front of a
         * room. A dead link says one sentence and nothing else, and containing that here means the
         * day a second code reaches this route the oracle does not appear on the projector.
         *
         * A transient 5xx therefore blanks the wall for one interval and comes back on its own at
         * the next poll - which is the trade S04 settled, and the poll is what makes it survivable.
         */
        if (
          error instanceof ApiError &&
          (error.code === DISPLAY_LINK_UNAVAILABLE_CODE || error.status > 0)
        ) {
          setScreen((previous) => ({
            ...previous,
            board: null,
            refused: true,
            unreachable: false,
          }));
          return;
        }
        /*
         * **Not answered** - the venue network, not the link. The Board stays exactly as it was and
         * the indicator says so. `navigator.onLine` is not consulted here and must not be: it stays
         * `true` on dead venue wifi and behind captive portals, which is precisely the failure this
         * surface is written for (`web/src/offline/use-online.ts`). What decides is whether the
         * request succeeded.
         */
        setScreen((previous) => ({ ...previous, unreachable: true }));
      } finally {
        // Only ever released by the request that took it, so a newly started poll cannot have its
        // latch cleared out from under it by the one it replaced.
        if (outstanding.current === signal) outstanding.current = null;
      }
    },
    [token],
  );

  /*
   * The first read, at mount. The shared loop below announces its first tick one interval in, and a
   * room screen that stayed blank for five seconds after the link was opened would read as broken.
   */
  useEffect(() => {
    if (token === null) return;
    const controller = new AbortController();
    void read(controller.signal);
    return () => controller.abort();
  }, [token, read]);

  /*
   * **A third call site of the one cadence loop - never a second mechanism**
   * (`plan.json#sharedDecisions` -> "there are to be no more mechanisms, only more call sites").
   * Five seconds, at most one request in flight, a tick arriving while one is outstanding skipped
   * rather than queued, and abort on unmount. It skips while `document.hidden`, which is correct
   * here - a projected tab is visible by definition - and refreshes immediately on becoming visible
   * again rather than waiting out a full interval.
   */
  useWatermarkPoll(token !== null, read);

  const stale = screen.board !== null && screen.unreachable && screen.lastSuccessAt !== null;

  /*
   * **The indicator's age has to keep advancing while polls are failing - which is exactly when
   * nothing else re-renders this surface.** A label computed from `Date.now()` freezes without a
   * named re-render source, and the label would then be a lie: a screen that lost its connection an
   * hour ago would go on claiming it updated just now.
   *
   * The source is the one loop's own tick, published through `tick/foreground-tick.ts`. That seam
   * owns no timer, no cadence constant and no event registration - it is the same five seconds with
   * one more consumer, which is why subscribing to it is not the second interval this story's scope
   * forbids. A `setInterval` here would be. (S08's staleness indicator hangs off the same seam.)
   *
   * Subscribed only while the indicator is actually on screen, so a healthy wall re-renders on
   * arriving data and on nothing else.
   */
  const [, setTicked] = useState(0);
  useEffect(() => {
    if (!stale) return;
    return onForegroundTick(() => setTicked((count) => count + 1));
  }, [stale]);

  /*
   * A re-render when the window changes size, so each region re-takes the legibility measurement
   * against the tile it now has. Not a cadence and not a timer - it fires only when the viewport
   * actually changes, which on a room machine is never and on the Facilitator's laptop preview is
   * exactly when the answer would otherwise be wrong.
   */
  const [, setResized] = useState(0);
  useEffect(() => {
    const remeasure = (): void => setResized((count) => count + 1);
    window.addEventListener('resize', remeasure);
    return () => window.removeEventListener('resize', remeasure);
  }, []);

  if (screen.refused)
    return <Notice testId="display-unavailable" lead={UNAVAILABLE} detail={UNAVAILABLE_DETAIL} />;
  if (screen.board === null) {
    if (screen.unreachable) return <Notice testId="display-unreachable" lead={UNREACHABLE} />;
    return (
      <main className="display-notice-screen" data-testid="display-loading">
        <div className="display-notice">
          <p className="display-notice__lead" role="status">
            Loading the board…
          </p>
        </div>
      </main>
    );
  }

  const { board } = screen;
  /*
   * Uncategorised first, then the Categories in the **payload's** order - which is the Facilitator's
   * order. Nothing here re-sorts, and Uncategorised is not one more Category: it carries no id, no
   * name and no position, because it is the *absence* of a placement rather than a row.
   */
  const regions = board.categories.length + 1;
  const grid = regionGrid(regions);

  /*
   * The counts are the server's (`postItCount`), summed - never `postIts.length`. S02 computes them
   * server-side precisely so no surface re-derives them, and a re-derivation would drift the moment
   * this projection ever rendered a subset.
   */
  const totalPostIts =
    board.uncategorised.postItCount +
    board.categories.reduce((running, category) => running + category.postItCount, 0);

  return (
    <main className="display" data-testid="display-board">
      {stale && screen.lastSuccessAt !== null && <Staleness lastSuccessAt={screen.lastSuccessAt} />}

      <div className="display__head">
        <h1 className="display__prompt" data-testid="display-prompt">
          {board.prompt}
        </h1>
        <p className="display__meta" data-testid="display-meta">
          {countWord(totalPostIts)} · {board.categories.length}{' '}
          {board.categories.length === 1 ? 'category' : 'categories'}
        </p>
      </div>

      <ul
        className="display-regions"
        data-testid="display-regions"
        style={
          {
            '--display-regions-across': grid.across,
            '--display-regions-down': grid.down,
          } as React.CSSProperties
        }
      >
        <Region
          testId="display-uncategorised"
          countTestId="display-uncategorised-count"
          name="Uncategorised"
          postIts={board.uncategorised.postIts}
          postItCount={board.uncategorised.postItCount}
          uncategorised
        />
        {board.categories.map((category) => (
          <Region
            key={category.id}
            testId={`display-category-${category.id}`}
            name={category.name}
            postIts={category.postIts}
            postItCount={category.postItCount}
          />
        ))}
      </ul>
    </main>
  );
}

/** "1 post-it" / "12 post-its" - the band's own phrasing, spelled the way the product spells it. */
function countWord(count: number): string {
  return count === 1 ? '1 post-it' : `${count} post-its`;
}

/**
 * One region - a Category, or Uncategorised beside them.
 *
 * The name, the count and the boundary hold their size at every tier: they are what a reader at the
 * back of the room is actually reading, and S01's decision is that they never degrade. Only the
 * Post-it detail below them does, and only as far as the tier its own count earns.
 */
function Region({
  testId,
  countTestId,
  name,
  postIts,
  postItCount,
  uncategorised = false,
}: {
  testId: string;
  countTestId?: string;
  name: string;
  postIts: PostIt[];
  postItCount: number;
  uncategorised?: boolean;
}): React.JSX.Element {
  const tier = detailTier(postItCount);

  /**
   * **Whether this region may draw its Post-its at all** - the 2026-09-01 amendment to S01's
   * overflow decision (`design-decisions.md#the-projected-views-overflow-behaviour`).
   *
   * The stylesheet caps Post-it type at the height a row can actually have, and below a floor that
   * cap stops producing type: at eighty in one tile it drew about a fifth of a pixel, a grey band
   * beside a count pill of 80. So the size the tier is about to use, and the floor it must clear,
   * are both read straight off the rendered list - the two lengths the stylesheet publishes - and a
   * region that cannot clear the floor draws **none** of its Post-its and states how many it holds
   * instead. Every other part of S01's rule is untouched: the Category, its name, its count and its
   * boundary all stay exactly as they were, nothing scrolls, nothing pages, and no input is offered
   * or needed.
   *
   * Read rather than recomputed, deliberately. The tile's height is not knowable in TypeScript - it
   * falls out of a grid sized to the number of regions - and re-deriving the type scale here would
   * be a second copy of `display.css`'s arithmetic, drifting the first time either changed.
   */
  const listRef = useRef<HTMLUListElement>(null);
  const [drawsPostIts, setDrawsPostIts] = useState(true);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list === null) return;
    const styles = getComputedStyle(list);
    setDrawsPostIts(
      postItsAreLegible(
        Number.parseFloat(styles.getPropertyValue('--display-post-it-size')),
        Number.parseFloat(styles.getPropertyValue('--display-post-it-floor')),
      ),
    );
    /*
     * No dependency list: the tile's height changes for reasons that are not this region's props -
     * the staleness band appearing and taking its height out of every row of the grid is the one
     * that actually happens on a wall - so the measurement is re-taken after every commit. It sets
     * the same value it read on a healthy screen, which React drops without re-rendering.
     */
  });

  return (
    <li
      className={`display-region${uncategorised ? ' display-region--uncategorised' : ''}`}
      data-testid={testId}
      data-tier={tier}
      data-count={postItCount}
    >
      <div className="display-region__head">
        <h2 className="display-region__name">{name}</h2>
        <span
          className="display-region__count"
          {...(countTestId === undefined ? {} : { 'data-testid': countTestId })}
          aria-label={countWord(postItCount)}
        >
          {postItCount}
        </span>
      </div>
      <div className="display-region__body">
        {postIts.length === 0 ? (
          /*
           * A Board with nothing on it is a legitimate pre-Round state, not an error, a spinner or
           * an "unavailable" message. This says so where the Post-its would be.
           */
          <p className="display-region__none">No post-its yet</p>
        ) : (
          <>
            <ul
              ref={listRef}
              className={`display-post-its display-post-its--${tier}${drawsPostIts ? '' : ' display-post-its--undrawn'}`}
              /*
               * The number of rows this region has to fit, from the **server's** count. The
               * stylesheet divides the tile's own height by it, so the richest tier that lets all of
               * them fit is what renders - S01's rule stated as its sentence rather than as its
               * count-keyed table (`display.css`, and S07 review H1). `postIts.length` is used here
               * and not `postItCount` on purpose: this is a statement about how many rows are being
               * laid out, not about how many Post-its the Category holds.
               */
              style={{ '--display-rows': postIts.length } as React.CSSProperties}
            >
              {drawsPostIts &&
                postIts.map((postIt) => (
                  <li
                    className="display-post-it"
                    key={postIt.id}
                    data-testid={`display-post-it-${postIt.id}`}
                  >
                    <p className="display-post-it__text">{postIt.text}</p>
                    {/*
                     * Under the author's name, always. That is the product's load-bearing distinction
                     * rather than a rendering choice: post-its always carry the author's name, votes
                     * are always anonymous, and named ideas are what a room discusses and follows up.
                     */}
                    <p className="display-post-it__by">{postIt.authorName}</p>
                  </li>
                ))}
            </ul>
            {/*
             * **The honest statement that replaces them.** It names the number, because that is what
             * the region still holds and what the room needs from the tile - and the count pill above
             * it says the same thing, unchanged, at the size it has always been. The list itself stays
             * in the document with its row count intact, and only that: it is what the measurement
             * above reads, so the region can start drawing again by itself the moment the tile has
             * room - a Post-it discarded out of it, or the staleness band clearing.
             */}
            {!drawsPostIts && (
              <p className="display-region__too-many" data-testid={`${testId}-too-many`}>
                {countWord(postItCount)} – too many to show at this size
              </p>
            )}
          </>
        )}
      </div>
    </li>
  );
}

/**
 * The staleness indicator - **an indicator, never a retry control**.
 *
 * S01 settled that no control appears on this class at all, and a retry would be the one pressable
 * thing on a surface that has none; there is nobody at the machine to press it, and the surface
 * recovers on its own at the next successful poll anyway.
 *
 * The age is the elapsed time between two events on the *same machine*, so `stalenessLabel` is
 * reused exactly as it is: no envelope watermark, no `EffectiveClock`, no timezone and no skew
 * correction, because none of those has anything to correct here. Clamped at zero for the same
 * reason it is elsewhere - a device whose clock jumped backwards must not be told the wall updates
 * in the future.
 */
function Staleness({ lastSuccessAt }: { lastSuccessAt: number }): React.JSX.Element {
  return (
    <div className="display-staleness" data-testid="display-staleness" role="status">
      <p className="display-staleness__lead">{STALE_LEAD}</p>
      <p className="display-staleness__detail" data-testid="display-staleness-age">
        {stalenessLabel(Math.max(0, Date.now() - lastSuccessAt))}. {STALE_TAIL}
      </p>
    </div>
  );
}

/** The one neutral screen, in the two shapes that can produce one. Nothing on it is pressable. */
function Notice({
  testId,
  lead,
  detail,
}: {
  testId: string;
  lead: string;
  detail?: string;
}): React.JSX.Element {
  return (
    <main className="display-notice-screen" data-testid={testId}>
      <div className="display-notice">
        {/*
         * `role="status"` rather than `alert`: on a projector nobody is going to act on this, and it
         * is the steady state of the page rather than an interruption of it.
         */}
        <p className="display-notice__lead" role="status" data-testid="display-message">
          {lead}
        </p>
        {detail !== undefined && <p className="display-notice__detail">{detail}</p>}
      </div>
    </main>
  );
}
