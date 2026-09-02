import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ApiError,
  castVote,
  closeRound,
  contributePostIt,
  createCategory,
  createRound,
  deleteCategory,
  deletePostIt,
  discardPostIt,
  fetchActivityWatermark,
  fetchSessionActivities,
  openRound,
  placePostIt,
  removePostItPermanently,
  restorePostIt,
  updateCategory,
  updatePostIt,
  updateRound,
  type Category,
  type PostIt,
  type Round,
  type RoundDetailsInput,
  type SessionWithRounds,
} from '../api/client.ts';
import { useWatermarkPoll } from '../poll/use-watermark-poll.ts';
import { onForegroundTick } from '../tick/foreground-tick.ts';
import { stalenessLabel } from '../attendee/staleness.ts';
import { useSignedInName } from '../auth/AuthProvider.tsx';
import { mintSubmissionId, type QueuedPostIt } from '../offline/post-it-queue.ts';
import {
  mayStillBeDelivered,
  useDeliveredPostIts,
  usePostItQueue,
} from '../offline/use-post-it-queue.ts';
import { RoundForm } from './RoundForm.tsx';
import { DisplayLinkControl } from './DisplayLinkControl.tsx';
import { DiscardedPostIts } from './DiscardedPostIts.tsx';
import {
  PermanentRemovalConfirmation,
  PermanentRemovalControl,
  shortened,
  type PermanentRemoval,
} from './PermanentRemoval.tsx';

/**
 * One Session's Activities: its Rounds, each Round's own open/closed state, the board of named
 * Post-its on every Post-it Round, and – for a holder – the run controls and the authoring form.
 *
 * Four things about it are load-bearing:
 *
 *   - **Authority is the server's answer.** `canRun` arrives on the payload and is rendered from,
 *     and so does `mine` on every Post-it. Nothing here re-derives who may work the run controls or
 *     whose Post-it this is, so there is no second, client-side opinion to drift out of step with
 *     the API's – which is the one that is actually enforced, in the write statement's predicate.
 *   - **The payload is replaced wholesale**, never merged (S09's discipline). A refresh that
 *     reconciled Rounds or Post-its field by field would be a second definition of what the Session
 *     holds, and a deletion would be the change it got wrong.
 *   - **The poll loop is the shared one** (`web/src/poll/use-watermark-poll.ts`, S02 TI08), and it
 *     is asked one of two questions per tick depending on whether this client holds a Session
 *     Assignment. A **non-holder** compares the Session's `activityWatermark` against the
 *     two-scalar poll's value and refetches the whole read when the two differ – the same
 *     compare-then-refetch rule as the Schedule, and no delta format. The value is an opaque
 *     counter, so *differs* is the only question asked of it; it is never ordered, subtracted or
 *     read as a time. A **holder** re-reads the Session on every tick instead, because a Vote
 *     advances no cursor at all and their tally therefore has no change signal behind it
 *     (ADR-007). Both are the same tick of the same loop: no second cadence, no second timer and
 *     no second cursor. S01 refreshed on a tick handed down from the attendee view boundary
 *     because the cursor did not exist yet; that call site is retired
 *     (`plan.json#sharedDecisions` → "Near-live propagation: one cursor").
 *   - **The compose box carries no length limit of its own.** The cap is `textMaxLength` on the
 *     payload, which is the API's single `POST_IT_MAX_LENGTH` interpolated. A number written here
 *     would be a second source that could disagree with the rule being enforced.
 *   - **A submission that could not be delivered is held on the device, and nothing else is**
 *     (S04, FR6). What decides it is the *request failing* – never `navigator.onLine`, which is
 *     true behind a captive portal. A submission the server *refused* is not held: it is a refusal,
 *     and it stays on screen with the typed text where it was. Held items render on their author's
 *     own board as pending and come from the store rather than from memory, so a relaunch still
 *     shows them. **Sending them is not this panel's job** – the drain lives in the app shell
 *     (`PostItQueueDrain`), so a held item goes up when the link returns wherever its author then
 *     is, and this surface reads the same shared store and re-reads the board when one lands.
 *     Nothing else here has a deferred path: a Vote, an open, a close and a correction all simply
 *     fail with no connection.
 *
 * Refusals and typed text both live in **this** component's state, outside anything a board refresh
 * replaces, so a refusal survives the re-read its own handler causes
 * (`docs/LEARNINGS.md#react-state--refusals`) and nobody loses what they typed to a poll landing at
 * the wrong moment.
 */

export interface SessionActivitiesPanelProps {
  conferenceId: string;
  sessionId: string;
  onClose?: () => void;
}

type State =
  | { kind: 'loading' }
  | { kind: 'failed'; code: string; message: string }
  /**
   * A payload that arrived, rendered until another one replaces it (S08 TI06).
   *
   * A refresh that fails leaves this exactly as it was, which is what keeps the Board a room is
   * working from on screen through a blip. The *age* beside it is anchored elsewhere - see
   * `contactAtRef` - because the last payload replacement and the last time this device heard from
   * the server are two different facts, and only the second one is what the age claims.
   */
  | { kind: 'ready'; payload: SessionWithRounds };

type Editor = { open: false } | { open: true; editing: Round | null };

/** The Post-it being corrected, and the text as it currently stands in its box. */
type PostItEditor = { postItId: string; roundId: string; text: string };

/** The Category being renamed, and the name as it currently stands in its box. */
type CategoryEditor = { categoryId: string; roundId: string; name: string };

/**
 * The occupied Category whose removal is waiting on a destination, and the destination so far.
 *
 * `destinationCategoryId` starts `null`, which is **Uncategorised** - the default the surface
 * offers, because it is where the Post-its came from and where nothing is lost
 * (`prd.md#fr1-categories-on-a-board`). `null` is the absence of a placement, not an id.
 */
type CategoryRemoval = {
  categoryId: string;
  roundId: string;
  destinationCategoryId: string | null;
};

/**
 * The sentence a Facilitator reads when a placement never reached the API (FR3 -> Error Handling).
 *
 * A **literal contract value**, quoted from `prd.md#edge-cases` character for character - straight
 * apostrophe and en dash included, which is why it does not carry the curly apostrophe the rest of
 * this surface's copy uses. It is the client's own sentence and the only one it ever invents: every
 * *server* refusal on this path shows the server's message verbatim, exactly as the shipped board
 * writes do.
 *
 * It says "check your connection" and not "we will send it later", because nothing is sent later.
 * Sorting is online-only: the Post-it is still drawn where it was, this says why, and the device
 * holds nothing.
 */
const PLACEMENT_UNDELIVERED = "Couldn't move that – check your connection.";

/**
 * The two sentences a Facilitator reads when a Discard or a restore never reached the API
 * (FR4 -> Error Handling: "the post-it stays where it was and the failure is stated; nothing is
 * queued").
 *
 * The client's own words and the only ones it invents on this path: every *server* refusal shows the
 * server's message verbatim, exactly as `PLACEMENT_UNDELIVERED` sits beside the placement's refusals.
 * Two sentences rather than one because the two acts are opposite and the Facilitator's next glance
 * is at a different place - the board, or the discarded list.
 *
 * Neither says "we will send it later", because nothing is sent later.
 */
const DISCARD_UNDELIVERED = "Couldn't discard that – check your connection.";
const RESTORE_UNDELIVERED = "Couldn't restore that – check your connection.";

/**
 * And the one an Admin reads when a **Permanent Removal** never reached the API (S06 FR5).
 *
 * Its own sentence rather than a reuse of the Discard's, because the two acts are not the same act
 * and the Admin needs to know *which* one did not go - a "couldn't discard that" after a permanent
 * removal would leave them believing the reversible one had been attempted.
 *
 * It does not say "we will send it later", because nothing is sent later: Permanent Removal is
 * online-only and the device holds nothing.
 */
const PERMANENT_REMOVAL_UNDELIVERED = "Couldn't remove that – check your connection.";

function messageOf(error: unknown): { code: string; message: string } {
  return error instanceof ApiError
    ? { code: error.code, message: error.message }
    : {
        code: 'NETWORK_UNREACHABLE',
        message: 'The app could not reach the server. Check your connection and try again.',
      };
}

function asApiError(error: unknown): ApiError {
  return error instanceof ApiError
    ? error
    : new ApiError('NETWORK_UNREACHABLE', messageOf(error).message);
}

/** A Post-it Round, or a Voting Round named by the purpose it is for. */
function kindLabel(round: Round): string {
  return round.kind === 'PostItRound' ? 'Post-it round' : (round.purpose ?? 'Voting round');
}

export function SessionActivitiesPanel({
  conferenceId,
  sessionId,
  onClose,
}: SessionActivitiesPanelProps): React.JSX.Element {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [editor, setEditor] = useState<Editor>({ open: false });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ApiError | null>(null);
  /** The server's sentence for a refused transition – the only thing that says what to do next. */
  const [refusal, setRefusal] = useState<string | null>(null);

  /**
   * What is typed in each Round's compose box, held **here** rather than in the box.
   *
   * A board refresh re-renders the list every few seconds, and a refused submission must leave the
   * typed text exactly where it was (Acceptance Scenario S06). Holding it at this level means the
   * text belongs to the panel rather than to a DOM node the list is free to replace, so neither a
   * poll nor a refusal can take it away.
   */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [postItEditor, setPostItEditor] = useState<PostItEditor | null>(null);

  /**
   * The option chosen but not yet submitted, per Poll – held **here** for the same reason the
   * post-it draft is.
   *
   * The round list re-renders on every poll tick, so a choice living in the radio group would be a
   * choice a refresh could take away mid-thought. It belongs to the panel, which nothing replaces.
   */
  const [choices, setChoices] = useState<Record<string, string>>({});
  /**
   * The server's sentence for a refused Vote, with the Poll it is about.
   *
   * Panel-level, outside the subtree the submit handler's own re-read replaces
   * (`docs/LEARNINGS.md#react-state--refusals`), so "you have already voted" stays on screen rather
   * than flashing and vanishing. It carries a message and never a count: the refusal body has none,
   * and this holds only what the body had.
   */
  const [voteError, setVoteError] = useState<{ roundId: string; message: string } | null>(null);
  /**
   * The Poll whose Vote is in flight, or `null` when none is.
   *
   * A Vote is single-use and the server says so, which is exactly why this matters: a double-tap on
   * a phone at the back of a room sends two casts for one intent, the second comes back "you have
   * already voted", and somebody who voted precisely once is shown a refusal beside "Your vote is
   * in". The submit is disabled while its own cast is out, so the second tap has nothing to press -
   * the same shape as `saving` on the round form, which is this panel's existing answer to a
   * double-submit.
   *
   * Per Round rather than one boolean, because a slow cast in one Poll must not disable the submit
   * of another. It is **not** a second opinion about whether this person has voted: the settled
   * state still comes from the server's `hasVoted` on the re-read, and this is cleared either way.
   */
  const [voteInFlight, setVoteInFlight] = useState<string | null>(null);
  /**
   * The board write that is currently out, as a namespaced key, or `null`.
   *
   * A board write is not idempotent from the person's side: a double-tap on `Add post-it` posts the
   * same idea twice **under their real name**, and a second `Remove` 404s, so the author whose
   * delete actually succeeded is told their post-it is no longer on this round. A phone at the back
   * of a room is where both happen.
   *
   * A **set** of keys rather than one key, so a slow write on one item never disables another *and*
   * never releases another's guard: `round:<id>` for a contribution, which is one compose box per
   * Round, `postit:<id>` for a correction or a removal, and `category:<id>` / `category-new:<id>`
   * for the Facilitator's sorting controls. A single slot looked equivalent while two writers shared
   * it and stopped being so at six - pressing a second control overwrote the first's key, which
   * re-enabled the first control mid-flight and let a double-tap post the same idea twice under a
   * real name. Save and Remove deliberately **share** the post-it key - hitting Remove while a Save
   * is still out is the same double-write, and the second would race the first's re-read.
   *
   * Cleared after the re-read rather than after the request, so the window stays closed while the
   * board is still catching up. Like `voteInFlight` this is never a second opinion about what is
   * stored: it gates the affordance only, and the board still renders the server's answer.
   */
  const [boardWriteInFlight, setBoardWriteInFlight] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  /** Is this control's write out right now? The one question anything asks of the set above. */
  const writing = useCallback(
    (key: string): boolean => boardWriteInFlight.has(key),
    [boardWriteInFlight],
  );

  /**
   * Marks a key as being written, or releases it. Both produce a copy, because the value is state.
   *
   * `out` rather than the obvious name: `inFlight` as a bare identifier is reserved to the poll
   * loop, and `web/test/watermark-poll.test.tsx` reads its absence here as evidence that this panel
   * owns no cadence of its own.
   */
  const markWriting = useCallback((key: string, out: boolean): void => {
    setBoardWriteInFlight((current) => {
      const next = new Set(current);
      if (out) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  /**
   * The server's sentence for a refused contribution, correction or removal, with the Round it is
   * about.
   *
   * Rendered beside that Round's compose box but stored at panel level, for the same reason the
   * draft is: it must outlive the re-read its own handler triggers.
   */
  const [boardError, setBoardError] = useState<{ roundId: string; message: string } | null>(null);

  /**
   * The destination chosen for each Post-it but not yet committed, keyed by Post-it id (S03 TI05).
   *
   * Held **here** for the same reason the compose draft and the Category editor are: the Board is
   * re-rendered by every poll tick, so a destination half-chosen in a select down there would be
   * taken away by a refresh landing at the wrong moment
   * (`docs/LEARNINGS.md#react-state--refusals`).
   *
   * `''` is Uncategorised - the value an HTML option carries when it names no id, converted back to
   * `null` on the way out. Nothing here is a sentinel *identifier* for the holding area: the empty
   * string never leaves this component, exactly as it does not in the Category-removal control.
   *
   * An absent entry means "wherever the server says it is", which is why a successful move clears
   * its entry rather than rewriting it: the select then re-derives its value from the Board that
   * came back, and no client-side belief about a placement can survive the read that settles it.
   */
  const [placements, setPlacements] = useState<Record<string, string>>({});
  /**
   * The Post-it whose destination control should take focus once the Board that follows a move has
   * rendered, or `null`.
   *
   * A successful move disables the button under the pointer and then re-parents the card into its
   * new region, so the focused element is unmounted and focus falls to `<body>`. A Facilitator
   * sorting by keyboard would tab from the top of the page again after every single move, on the
   * surface whose whole interaction model exists to be keyboard-operable (S01 -> OC02).
   */
  const [focusAfterMove, setFocusAfterMove] = useState<string | null>(null);

  /**
   * The Facilitator's Category work, all of it held **here** rather than in the Board.
   *
   * Same reason as the Post-it draft and the correction editor: the Board is re-rendered by every
   * poll tick, so a half-typed Category name, an open removal prompt or a refusal that lived down
   * there would be taken away by a refresh landing at the wrong moment
   * (`docs/LEARNINGS.md#react-state--refusals`). Nothing in this group is a second opinion about
   * what is stored - the Board still renders the server's answer, and these only decide what is
   * *offered*.
   */
  const [categoryDrafts, setCategoryDrafts] = useState<Record<string, string>>({});
  const [categoryEditor, setCategoryEditor] = useState<CategoryEditor | null>(null);
  const [categoryRemoval, setCategoryRemoval] = useState<CategoryRemoval | null>(null);
  const [permanentRemoval, setPermanentRemoval] = useState<PermanentRemoval | null>(null);
  /** The server's sentence for a refused Category write, with the Round it is about. */
  const [categoryError, setCategoryError] = useState<{ roundId: string; message: string } | null>(
    null,
  );
  /**
   * The duplicate-name warning, which rides a **successful** write and is not a refusal.
   *
   * Two Categories on one Board may share a name - names are labels, not identifiers, and the
   * Report groups by identity (`prd.md#fr1-categories-on-a-board`). The write landed; this is the
   * server's sentence saying so, shown until the next Category write replaces or clears it.
   */
  const [categoryWarning, setCategoryWarning] = useState<{
    roundId: string;
    message: string;
  } | null>(null);

  /**
   * This device's own clock at the **last exchange with the server about this Session**, which is
   * the one fact the age beside the Board is measured from (S08 TI06, owner decision 2026-09-02).
   *
   * Every exchange, not every payload replacement. For somebody who runs the Session the two are
   * the same thing, because a holder re-reads on every tick - but an Attendee's tick is a two-scalar
   * watermark poll, and the Board is re-read only when that cursor has actually moved. Anchored on
   * the read, a quiet room with nobody sorting ages exactly as an outage does, and the sentence
   * meant to make a dead connection visible fires all day during normal operation. What a reader
   * takes the age to mean is "are we still in touch with the server", so that is what it is
   * anchored on. The poll already runs on the shipped cadence: this adds no request and no timer.
   *
   * A device clock reading and never an instant off the payload. The activity watermark is an
   * opaque counter (ADR-007) with no time in it to subtract, and `session.lastUpdatedAt` describes
   * the Session's own editing rather than this exchange - so the only honest age available here is
   * the difference between two readings of one clock, exactly as `offline/cached-age.ts` established.
   *
   * A **ref** rather than state, and that is load-bearing: advancing it on every tick as state
   * would reconcile the whole Board - two hundred Post-its at the design ceiling - twelve times a
   * minute to produce a sentence that changes once a minute. The rendered sentence is the state;
   * this is the number behind it, and `restateAgeRef` is how a fresh exchange asks for it to be
   * recomputed without anything here knowing how the label is written.
   */
  const contactAtRef = useRef<number | null>(null);
  const restateAgeRef = useRef<() => void>(() => {});

  /** Records that the server just answered about this Session, and restates the age from it. */
  const noteContact = useCallback((): void => {
    contactAtRef.current = Date.now();
    restateAgeRef.current();
  }, []);

  /**
   * Re-reads the Session with its Rounds and their boards, replacing the payload wholesale.
   *
   * `keepOnFailure` is for the reads that are a *refresh* rather than this panel's own load. A
   * failed refresh must leave the last successful payload exactly as it was: replacing a board with
   * an error box because one tick did not get through is how a room loses the screen it is working
   * from.
   */
  const load = useCallback(
    async (signal?: AbortSignal, keepOnFailure = false): Promise<void> => {
      try {
        const payload = await fetchSessionActivities(conferenceId, sessionId, signal);
        noteContact();
        setState({ kind: 'ready', payload });
      } catch (error) {
        if (signal?.aborted) return;
        /*
         * `keepOnFailure` holds the screen a room is working from through a blip - but a revoked
         * role and a deleted Session are not blips. It used to hold the payload through **any**
         * failure, so both went on rendering as live data with their run controls intact, and the
         * only symptom was that nothing ever changed again.
         *
         * The distinction is **what the answer is about**, following `AttendeeSchedulePanel`'s
         * reading of the same problem. A 403 or a 404 is the server stating something about *this
         * caller's access to this Session*, and once it has said that, what is on screen is no
         * longer true. Everything else - a 5xx, a timeout, a request that never left the device -
         * says something about the server or the network and nothing about the caller, so the last
         * good board stays exactly where it was and the next tick tries again. Discarding a room's
         * screen because the database blipped is the harm `keepOnFailure` exists to prevent.
         */
        const accessAnswered =
          error instanceof ApiError && (error.status === 403 || error.status === 404);
        if (!keepOnFailure || accessAnswered) setState({ kind: 'failed', ...messageOf(error) });
      }
    },
    [conferenceId, sessionId, noteContact],
  );

  useEffect(() => {
    /*
     * Everything held here belongs to the Session on screen, so switching to another one drops it.
     * This component is not remounted when `sessionId` changes – both call sites toggle by id at the
     * same element position – so without this an open editor would keep the *previous* Session's
     * Round, and submitting it would PATCH that round id under this Session's path for a
     * ROUND_NOT_FOUND nobody could explain. A refusal from the Session just left would hang over the
     * new one's rounds for the same reason, and so would a half-typed post-it.
     */
    setEditor({ open: false });
    setSaveError(null);
    setRefusal(null);
    setDrafts({});
    setPostItEditor(null);
    setBoardError(null);
    setPlacements({});
    setCategoryDrafts({});
    setCategoryEditor(null);
    setCategoryRemoval(null);
    setPermanentRemoval(null);
    setCategoryError(null);
    setCategoryWarning(null);
    setChoices({});
    setVoteError(null);
    // The age belongs to the Session it dates, so switching Sessions starts it again from nothing.
    contactAtRef.current = null;
    setState({ kind: 'loading' });

    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const payload = state.kind === 'ready' ? state.payload : null;
  const canRun = payload?.canRun === true;
  /**
   * Whether the irreversible control is offered at all - the **server's** answer, off the payload
   * (S06 FR5, TI04).
   *
   * Read exactly as `canRun` is and never re-derived: this file, and every other file under
   * `web/`, holds no role name, no rank comparison and no Admin test. The API enforces the same
   * decision again on the write, so this decides what is *offered* and nothing else.
   */
  const canRemovePermanently = payload?.canRemovePermanently === true;

  /**
   * The cursor this view is rendering, readable without depending on it.
   *
   * Held in a ref as well as in state so the poll below can compare against it without being
   * rebuilt – and therefore restarting the cadence – every time the board changes, which is exactly
   * when the cadence matters most. The same reason `AttendeeSchedulePanel` keeps `renderedRef`.
   */
  const watermarkRef = useRef<string | null>(null);
  /**
   * And whether this client holds a Session Assignment, held the same way and for the same reason.
   *
   * The server's answer, off the payload – never a second client-side opinion about authority. It
   * decides which of the two questions below the tick asks, so keeping it out of the callback's
   * dependencies is what stops the cadence restarting the moment a holder's first payload lands.
   */
  const canRunRef = useRef(false);
  useEffect(() => {
    watermarkRef.current = payload?.activityWatermark ?? null;
    canRunRef.current = payload?.canRun === true;
  }, [payload]);

  /**
   * What to ask each tick, and what to do about the answer (TI10).
   *
   * **For a holder, the tick is the signal.** A cast Vote advances no cursor – the trigger that
   * used to do it made the Membership-gated watermark poll a vote-arrival oracle for every Member
   * who is deliberately refused the tally, and it was dropped rather than gated (ADR-007,
   * `db/migrations/20260831090000000_vote-advances-no-cursor.sql`). So a holder's building tally
   * has nothing to compare against, and the Session is re-read on every tick instead. One request
   * per tick rather than two: asking the two-scalar poll first would only be a scalar this branch
   * then ignores. The tally rides the Session read already, so nothing new is fetched.
   *
   * **For everyone else, compare then refetch.** Two scalars, compared against the value on the
   * payload already on screen; only a value that has actually moved is worth the Session payload.
   * There is no delta to merge – the read is refetched whole, which is the pattern S09 established
   * and the reason no delta format exists. This is the path every Attendee is on, and it is what
   * keeps a Post-it Board – and a Poll's reveal when the Round closes – near-live for them.
   *
   * Both branches ride the one shared loop's tick. Nothing here owns a cadence, a timer or a
   * listener (`plan.json#sharedDecisions` → "Near-live propagation: one cursor").
   *
   * A failed poll or refetch changes nothing on screen: `keepOnFailure` keeps the last successful
   * board exactly as it was and the next tick tries again.
   */
  const syncOnTick = useCallback(
    async (signal: AbortSignal): Promise<void> => {
      try {
        /*
         * A panel whose first load failed retries on the tick, rather than sitting dead.
         *
         * Gating the loop on `ready` meant one refused or dropped initial request left the view
         * showing its failure for the rest of the Session, with nothing on screen able to change it
         * - no retry, no poll, and no reason for the person to think reopening would help. S01's
         * tick fired regardless of panel state and self-healed; that behaviour was lost when the
         * loop moved here, and TI08 called the move behaviour-preserving.
         *
         * The full read, not the two-scalar poll: there is no watermark to compare against yet.
         * It is also the branch that recovers a role newly granted, or a Session that has only just
         * become readable.
         */
        if (state.kind === 'failed') {
          await load(signal);
          return;
        }
        if (canRunRef.current) {
          await load(signal, true);
          return;
        }
        const watermark = await fetchActivityWatermark(conferenceId, sessionId, signal);
        if (signal.aborted) return;
        /*
         * The poll answered, so this device is in touch with the server - whether or not the cursor
         * moved. That is what the age beside the Board reports, so the anchor advances here and not
         * only on the branch below that re-reads (owner decision 2026-09-02; see `contactAtRef`).
         */
        noteContact();
        if (watermark.activityWatermark === watermarkRef.current) return;
        await load(signal, true);
      } catch {
        // Deliberately swallowed. See the note above.
      }
    },
    [conferenceId, sessionId, load, noteContact, state.kind],
  );

  /*
   * Ticking while `failed` as well as while `ready` – the failed branch above is what makes that
   * worth doing. Still `loading` is deliberately excluded: the initial request is already in
   * flight, and a tick would only race it.
   */
  useWatermarkPoll(state.kind === 'ready' || state.kind === 'failed', syncOnTick);

  /**
   * The age beside the Board, and what makes it keep advancing (S08 TI06, OC04).
   *
   * **The age has to move while nothing is arriving, which is exactly when nothing re-renders this
   * panel.** A label computed from `Date.now()` freezes the moment reads stop landing, and it would
   * then be a lie: a phone that lost its connection four minutes ago would go on saying it updated
   * just now, which is the one thing somebody watching a Board being sorted must not be told.
   *
   * The nudge comes from the one loop's own tick, published through `tick/foreground-tick.ts` -
   * **a second consumer of the shared cadence, never a second cadence**
   * (`plan.json#sharedDecisions` -> "Near-live propagation: one cursor"). That seam owns no timer,
   * no interval constant and no event registration; a `setInterval` here would be the mechanism the
   * shared decision forbids. S07's projected surface hangs off the same seam.
   *
   * Subscribed whenever a payload is on screen rather than only once a read has failed. The label
   * is derived from the last **successful exchange** with the server (`contactAtRef`) and from
   * nothing else, so there is no failure to detect and no `navigator.onLine` to consult - which
   * reports the link and not reachability (`docs/LEARNINGS.md#offline`).
   *
   * **The sentence is held in state and computed in the tick, never read off the clock during
   * render.** Two reasons, and both are rules rather than preferences. Reading `Date.now()` while
   * rendering makes the component impure - the same props and state stop producing the same output,
   * which is what StrictMode's double render exists to catch - and it also detaches the label from
   * the tick entirely: it would then change on *any* re-render, including somebody typing in a
   * compose box. And the comparison before the write matters at the design ceiling: the tick is
   * five seconds and `stalenessLabel` is coarse to the minute, so eleven of every twelve nudges
   * would otherwise reconcile a tree of two hundred Post-its to produce byte-identical output, on a
   * phone, on battery, for the whole of a Session.
   */
  const [age, setAge] = useState<string | null>(null);
  const showsAge = state.kind === 'ready';
  /*
   * A **layout** effect, so the first reading lands in the same commit as the Board it describes.
   * With an ordinary effect there is a frame in which the Board is on screen and the sentence
   * saying how current it is has not appeared yet - a flicker in the application, and in a test a
   * genuine race between the assertion and the second commit.
   *
   * Keyed on whether there is a Board on screen at all rather than on the anchor: the anchor moves
   * every cadence and re-subscribing that often would be churn for nothing. A fresh exchange
   * restates through `restateAgeRef` instead, which is published here so `noteContact` never has to
   * know how the sentence is written.
   */
  useLayoutEffect(() => {
    const restate = (): void => {
      const contactAt = contactAtRef.current;
      // No Board on screen, no age: a refusal that replaced it left nothing for this to date.
      if (!showsAge || contactAt === null) {
        setAge(null);
        return;
      }
      const next = stalenessLabel(Math.max(0, Date.now() - contactAt));
      setAge((current) => (current === next ? current : next));
    };
    restateAgeRef.current = restate;
    // At once, so a Board that has just loaded says so without waiting out a cadence, and then on
    // every tick of the one loop.
    restate();
    return onForegroundTick(restate);
  }, [showsAge]);

  /**
   * What this device is still holding (S04).
   *
   * **This panel does not drain the queue.** The drain is mounted once in the app shell, so a
   * Post-it typed in a dead spot is sent as soon as the link returns wherever its author happens to
   * be standing – not when they next open this particular Session (product decision, 2026-08-29).
   * What this reads is the shared store the drain writes; the queue is device-wide and only this
   * Session's items are rendered below.
   *
   * When a drain has delivered something, the Session is re-read, so a Post-it that finally landed
   * appears on the board through the same read every other participant gets it from – there is no
   * local insertion and no second source for what is on the board. `keepOnFailure`, because the
   * write already succeeded and a blip on the read is not a reason to take the room's screen away.
   */
  const reread = useCallback((): void => {
    void load(undefined, true);
  }, [load]);
  const { queued, deliveries, hold, dismiss } = usePostItQueue();
  useDeliveredPostIts(deliveries, reread);
  const viewerName = useSignedInName();
  const heldFor = useCallback(
    (roundId: string): QueuedPostIt[] =>
      queued.filter((item) => item.sessionId === sessionId && item.roundId === roundId),
    [queued, sessionId],
  );
  const heldHere = queued.filter((item) => item.sessionId === sessionId);
  /**
   * Held items this Session's boards cannot show, because the Round they belong to is not on the
   * payload – or there is no payload at all.
   *
   * The second case is the offline relaunch; the **first** is Acceptance Scenario S06's actual
   * shape, and it is the one that is easy to lose. A Round deleted by an Admin is exactly why the
   * drain got its `ROUND_NOT_FOUND`, and after that the Session still reads perfectly well - it
   * simply no longer lists that Round. Rendered only per-Round, the returned-to-author item would
   * then have no surface at all: no text, no reason, and no reachable way to discard it, so it
   * would sit in device storage until sign-out. That is the silent drop FR6 forbids.
   */
  const heldElsewhere =
    payload === null
      ? heldHere
      : heldHere.filter((item) => !payload.rounds.some((round) => round.id === item.roundId));

  const submit = useCallback(
    async (details: RoundDetailsInput): Promise<void> => {
      if (!editor.open) return;
      setSaving(true);
      setSaveError(null);
      setRefusal(null);
      try {
        if (editor.editing === null) await createRound(conferenceId, sessionId, details);
        else await updateRound(conferenceId, sessionId, editor.editing.id, details);

        setEditor({ open: false });
        // `keepOnFailure`: the write already succeeded, so this read is an extra. A blip on it must
        // leave the round list on screen rather than replacing the surface a facilitator is running
        // the room from with an error box.
        await load(undefined, true);
      } catch (error) {
        // Held as the ApiError so the form can attach each field message to its own control, and
        // so the panel-level alert can show a refusal that named no field at all.
        setSaveError(asApiError(error));
      } finally {
        setSaving(false);
      }
    },
    [conferenceId, sessionId, editor, load],
  );

  const move = useCallback(
    async (round: Round, to: 'open' | 'close'): Promise<void> => {
      setRefusal(null);
      try {
        if (to === 'open') await openRound(conferenceId, sessionId, round.id);
        else await closeRound(conferenceId, sessionId, round.id);
        // Same reason as the save path: the transition landed, and a failed re-read is not a reason
        // to take the round list away in the middle of a session.
        await load(undefined, true);
      } catch (error) {
        // The server's sentence, verbatim - "a poll cannot be reopened once its results are shown"
        // is the one thing that explains why the control did nothing. Rendered at panel level, well
        // outside anything this handler replaces.
        setRefusal(asApiError(error).message);
        await load(undefined, true);
      }
    },
    [conferenceId, sessionId, load],
  );

  /**
   * Every write to a board, through one path.
   *
   * The four of them – contribute, correct, remove, place – differ only in the request and in what
   * to do on success, and they share every rule that matters: the refusal is the server's own
   * sentence, it is stored at panel level so the re-read cannot take it off the screen, **the typed
   * text is left exactly where it was on a refusal**, and the board is re-read either way so a
   * refused write leaves the room looking at what is actually stored.
   *
   * `undeliverable` is the one sentence a caller may supply, and only for a request that **never
   * reached the API**. FR3 states a placement's transport failure verbatim, and a Facilitator whose
   * move did not go needs to be told the move did not go rather than the generic "the app could not
   * reach the server". A *refusal* is untouched by it: the server answered, and its own words are
   * what say what to do next. Nothing here defers anything - `contribute` below is the one write on
   * this surface with somewhere to go, and it deliberately does not come through here.
   */
  const writeToBoard = useCallback(
    async (
      key: string,
      roundId: string,
      write: () => Promise<unknown>,
      onWritten: () => void,
      undeliverable?: string,
    ): Promise<void> => {
      if (writing(key)) return;
      markWriting(key, true);
      setBoardError(null);
      try {
        await write();
        onWritten();
      } catch (error) {
        /*
         * `instanceof ApiError` is the whole distinction, and it is the same one `mayStillBeDelivered`
         * draws from the other side: an `ApiError` is something the server said, and anything else
         * is a request that never got an answer. Only the second takes the caller's sentence.
         */
        const undelivered = undeliverable !== undefined && !(error instanceof ApiError);
        setBoardError({
          roundId,
          message: undelivered ? undeliverable : asApiError(error).message,
        });
      }
      try {
        await load(undefined, true);
      } finally {
        markWriting(key, false);
      }
    },
    [load, writing, markWriting],
  );

  /**
   * Adding to a board – the one write on this surface that has somewhere to go when it fails.
   *
   * It does not go through `writeToBoard`, because it is the one that does not simply refuse. The
   * order is the whole rule: **submit first, and hold only what could not be delivered**. Asking
   * `useOnline` instead would hold a submission the server was perfectly willing to take, and would
   * send one into a captive portal and call it delivered.
   *
   * A refusal the *server* produced is not held – too long, blank, the round is closed to a live
   * contribution. That is an answer, and answers stay on screen with the typed text exactly where it
   * was (Acceptance Scenario S06 of S02). Only "could not be delivered" is held.
   *
   * **The submission identity is minted here, before the first attempt, not when the item is
   * queued.** A transport failure looks identical whether the request never left the phone or
   * reached the API, wrote the row, and lost its answer on the way back. Minting on the way into the
   * queue would give the retry a *different* identity in that second case, the constraint would see
   * two keys, and one idea would land twice under a real name – which is precisely what FR6's "a
   * retried send produces one Post-it, not two" forbids.
   */
  const contribute = useCallback(
    async (roundId: string): Promise<void> => {
      const key = `round:${roundId}`;
      if (writing(key)) return;
      const text = drafts[roundId] ?? '';
      const clearBox = (): void => setDrafts((current) => ({ ...current, [roundId]: '' }));
      const submissionId = mintSubmissionId();

      markWriting(key, true);
      setBoardError(null);
      try {
        await contributePostIt(conferenceId, sessionId, roundId, text, { submissionId });
        clearBox();
      } catch (error) {
        // Held under the **same** identity this attempt carried, and the box is cleared: from here
        // on the text lives in the queue, and the pending post-it below is where its author sees
        // it. Leaving it in the box as well would offer them a second submission of the same idea.
        const held =
          mayStillBeDelivered(error) &&
          (await hold({ submissionId, conferenceId, sessionId, roundId, text }));
        if (held) clearBox();
        else setBoardError({ roundId, message: asApiError(error).message });
      }
      try {
        await load(undefined, true);
      } finally {
        markWriting(key, false);
      }
    },
    [conferenceId, sessionId, drafts, hold, load, writing, markWriting],
  );

  const saveCorrection = useCallback(async (): Promise<void> => {
    if (postItEditor === null) return;
    const { roundId, postItId, text } = postItEditor;
    await writeToBoard(
      `postit:${postItId}`,
      roundId,
      () => updatePostIt(conferenceId, sessionId, roundId, postItId, text),
      () => setPostItEditor(null),
    );
  }, [conferenceId, sessionId, postItEditor, writeToBoard]);

  const remove = useCallback(
    async (roundId: string, postItId: string): Promise<void> => {
      await writeToBoard(
        `postit:${postItId}`,
        roundId,
        () => deletePostIt(conferenceId, sessionId, roundId, postItId),
        () => setPostItEditor(null),
      );
    },
    [conferenceId, sessionId, writeToBoard],
  );

  /**
   * Sorting: moving one Post-it to the destination chosen for it (S03 TI05, TI06).
   *
   * Through `writeToBoard` like every other board write, so it inherits the four rules that seam
   * exists for - one write in flight per Post-it, the refusal held at panel level where the re-read
   * this triggers cannot reach it, the Board re-read on **both** branches, and no deferred path
   * anywhere. A refused or undelivered move therefore leaves the Post-it drawn where the server says
   * it is, which is where it was.
   *
   * It shares the `postit:` key with Save and Remove deliberately: a move issued while a correction
   * on the same Post-it is still out is the same double-write, and the second would race the first's
   * re-read.
   *
   * `''` is Uncategorised on the way in and `null` on the way out. Nothing about that conversion is
   * a sentinel: the empty string is what an HTML option carries when it names no id, and it stops
   * here.
   *
   * **Nothing is held.** No `hold`, no submission identity, no drain - sorting is online-only
   * (Binding Constraint FR3), so an undelivered placement says `PLACEMENT_UNDELIVERED` and the
   * device keeps nothing.
   */
  /**
   * Give focus back to the moved Post-it once the Board carrying it has rendered.
   *
   * Runs after the re-read because that is when the card exists in its new region - the element
   * that had focus is gone by then, so this is a restore rather than a steal. Keyed on the Post-it
   * rather than on a position, so it follows the card wherever the Facilitator sent it.
   *
   * The attempt is abandoned as soon as a Board has rendered without that control in it: the
   * Post-it may have been removed by its author, or this viewer may have lost the run controls
   * mid-move, and neither is a reason to hold a pending focus forever.
   */
  useEffect(() => {
    if (focusAfterMove === null || state.kind !== 'ready') return;
    const control = document.querySelector<HTMLSelectElement>(
      `[data-testid="move-to-${focusAfterMove}"]`,
    );
    control?.focus();
    setFocusAfterMove(null);
  }, [focusAfterMove, state]);

  const place = useCallback(
    async (roundId: string, postItId: string, destination: string): Promise<void> => {
      await writeToBoard(
        `postit:${postItId}`,
        roundId,
        () =>
          placePostIt(
            conferenceId,
            sessionId,
            roundId,
            postItId,
            destination === '' ? null : destination,
          ),
        /*
         * Cleared only on success, so the select falls back to where the Board that comes back says
         * the Post-it now is. A refused move leaves the chosen destination in the control the
         * Facilitator is still looking at, exactly as a refused name stays in its box.
         */
        () => {
          setPlacements((current) => {
            const next = { ...current };
            delete next[postItId];
            return next;
          });
          setFocusAfterMove(postItId);
        },
        PLACEMENT_UNDELIVERED,
      );
    },
    [conferenceId, sessionId, writeToBoard],
  );

  /**
   * Discard, and its reversal (S05 TI08, TI09, FR4).
   *
   * **Two calls, one path, and it is the same `writeToBoard` every other board write goes through** -
   * so both inherit the four rules that seam exists for: one write in flight per Post-it, the
   * refusal held at panel level where the re-read this triggers cannot reach it, the Board re-read on
   * **both** branches, and no deferred path anywhere. A Discard refused on an archived Conference
   * therefore leaves the Post-it drawn exactly where the server says it is, which is where it was.
   *
   * They share the `postit:` key with Save, Remove and Move deliberately: a Discard issued while a
   * correction on the same Post-it is still out is the same double-write, and the second would race
   * the first's re-read.
   *
   * **Nothing is held.** No `hold`, no submission identity, no drain - discarding and restoring are
   * online-only (Binding Constraint FR3), so an undelivered one says so and the device keeps
   * nothing. This is the one place the two acts differ from author deletion in the panel as well as
   * in the schema: the author's Remove is *their* write under Membership, and Discard is the
   * Facilitator's under sorting authority. They are two controls and never the same one.
   */
  const discard = useCallback(
    async (roundId: string, postItId: string): Promise<void> => {
      await writeToBoard(
        `postit:${postItId}`,
        roundId,
        () => discardPostIt(conferenceId, sessionId, roundId, postItId),
        // The correction box goes with it: a Post-it that has left the board has nothing to save.
        () => setPostItEditor(null),
        DISCARD_UNDELIVERED,
      );
    },
    [conferenceId, sessionId, writeToBoard],
  );

  const restore = useCallback(
    async (roundId: string, postItId: string): Promise<void> => {
      await writeToBoard(
        `postit:${postItId}`,
        roundId,
        () => restorePostIt(conferenceId, sessionId, roundId, postItId),
        () => {},
        RESTORE_UNDELIVERED,
      );
    },
    [conferenceId, sessionId, writeToBoard],
  );

  /**
   * **Permanent Removal**, once its confirmation has been confirmed (S06 TI05, FR5).
   *
   * Through the same `writeToBoard` every other board write goes through, so it inherits the four
   * rules that seam exists for: one write in flight per Post-it, the refusal held at panel level
   * where the re-read this triggers cannot reach it, the Board re-read on **both** branches, and no
   * deferred path anywhere. A removal refused on an archived Conference therefore leaves the Post-it
   * drawn exactly where the server says it is, which is where it was.
   *
   * It shares the `postit:` key with Save, Remove, Move and Discard deliberately: a removal issued
   * while another write on the same Post-it is still out is the same double-write.
   *
   * **Nothing is held.** No `hold`, no submission identity, no drain - Permanent Removal is
   * online-only (Binding Constraint FR3), so an undelivered one says so and the device keeps
   * nothing.
   *
   * The confirmation is dismissed on **both** branches, unlike a refused Category name that stays in
   * its box: there is nothing here to correct and retype, and a dialog left standing over a Board
   * the re-read has just changed would be pointing at a Post-it that may no longer be there.
   */
  const removePermanently = useCallback(
    async (roundId: string, postItId: string): Promise<void> => {
      await writeToBoard(
        `postit:${postItId}`,
        roundId,
        async () => {
          await removePostItPermanently(conferenceId, sessionId, roundId, postItId);
        },
        // The correction box goes with it: a Post-it that is gone has nothing to save.
        () => setPostItEditor(null),
        PERMANENT_REMOVAL_UNDELIVERED,
      );
      setPermanentRemoval(null);
    },
    [conferenceId, sessionId, writeToBoard],
  );

  /**
   * Every Category write, through one path (TI08).
   *
   * The same rules the Post-it writes hold to, for the same reasons: the refusal is the server's own
   * sentence, it is stored at panel level so the re-read this triggers cannot take it off the
   * screen, the typed name is left exactly where it was on a refusal, and the Board is re-read
   * either way so a refused write leaves the room looking at what is actually stored.
   *
   * **Nothing here is ever queued.** Sorting is online-only (`docs/PRODUCT.md` → Anti-Goals,
   * Binding Constraint FR3): a Category write that cannot be delivered fails visibly and the Board
   * stays as it was. There is no `hold`, no submission identity and no drain on this path - unlike
   * `contribute` above, which is the one write on this surface that has somewhere to go.
   *
   * One write in flight per control, keyed like the board writes are, so a double-tap on a phone at
   * the back of a room cannot create the same Category twice under one intent.
   */
  const writeCategory = useCallback(
    async (
      key: string,
      roundId: string,
      write: () => Promise<{ warning?: string } | void>,
      onWritten: () => void,
    ): Promise<void> => {
      if (writing(key)) return;
      markWriting(key, true);
      setCategoryError(null);
      setCategoryWarning(null);
      try {
        const written = await write();
        onWritten();
        // A warning is a *success* carrying a sentence - the duplicate name was stored. It is set
        // only after `onWritten`, so nothing below clears it.
        const warning = written === undefined ? undefined : written.warning;
        if (warning !== undefined) setCategoryWarning({ roundId, message: warning });
      } catch (error) {
        setCategoryError({ roundId, message: asApiError(error).message });
      }
      try {
        await load(undefined, true);
      } finally {
        markWriting(key, false);
      }
    },
    [load, writing, markWriting],
  );

  const addCategory = useCallback(
    async (roundId: string): Promise<void> => {
      const name = categoryDrafts[roundId] ?? '';
      await writeCategory(
        `category-new:${roundId}`,
        roundId,
        () => createCategory(conferenceId, sessionId, roundId, name),
        // Cleared only on success: a refused name stays in the box the person is still looking at.
        () => setCategoryDrafts((current) => ({ ...current, [roundId]: '' })),
      );
    },
    [conferenceId, sessionId, categoryDrafts, writeCategory],
  );

  const saveCategoryName = useCallback(async (): Promise<void> => {
    if (categoryEditor === null) return;
    const { roundId, categoryId, name } = categoryEditor;
    await writeCategory(
      `category:${categoryId}`,
      roundId,
      () => updateCategory(conferenceId, sessionId, roundId, categoryId, { name }),
      () => setCategoryEditor(null),
    );
  }, [conferenceId, sessionId, categoryEditor, writeCategory]);

  /**
   * Moving a Category in the order.
   *
   * The **resulting** position is what the control names and what is sent - never a direction the
   * server has to interpret against an order this client believes in. A position outside the range
   * is clamped rather than refused, so the ends of the order need no special case here either.
   */
  const moveCategory = useCallback(
    async (roundId: string, categoryId: string, position: number): Promise<void> => {
      await writeCategory(
        `category:${categoryId}`,
        roundId,
        () => updateCategory(conferenceId, sessionId, roundId, categoryId, { position }),
        /*
         * Nothing to do on success, and closing the rename box would be the wrong thing: the move
         * buttons sit above an open rename form and stay live while it is open, so discarding a
         * half-typed name because somebody reordered is precisely the loss the panel-level editor
         * state exists to prevent.
         */
        () => {},
      );
    },
    [conferenceId, sessionId, writeCategory],
  );

  /**
   * Removing a Category.
   *
   * An **empty** one goes with no prompt: `destination` is omitted, and the server's own count is
   * what decides whether that is allowed - this surface never counts for itself. An **occupied** one
   * is sent only once a destination has been chosen, and `null` is Uncategorised.
   */
  const removeCategory = useCallback(
    async (
      roundId: string,
      categoryId: string,
      destination?: { categoryId: string | null },
    ): Promise<void> => {
      await writeCategory(
        `category:${categoryId}`,
        roundId,
        async () => {
          await deleteCategory(conferenceId, sessionId, roundId, categoryId, destination);
        },
        () => {
          setCategoryRemoval(null);
          setCategoryEditor(null);
        },
      );
    },
    [conferenceId, sessionId, writeCategory],
  );

  /**
   * Submitting a Vote.
   *
   * The re-read afterwards is what moves the card into its settled state: `hasVoted` is the
   * server's answer, so nothing here flips a local flag that could disagree with it. A refusal
   * keeps the sentence and re-reads anyway, so the room is looking at what is actually stored -
   * and if the refusal was "you have already voted", that re-read is what shows them they had.
   */
  const vote = useCallback(
    async (roundId: string): Promise<void> => {
      const optionId = choices[roundId];
      if (optionId === undefined) return;
      // Belt to the disabled button's braces: a handler that has already been entered for this Poll
      // does not send a second cast, whatever managed to invoke it.
      if (voteInFlight === roundId) return;

      setVoteInFlight(roundId);
      setVoteError(null);
      try {
        await castVote(conferenceId, sessionId, roundId, optionId);
      } catch (error) {
        setVoteError({ roundId, message: asApiError(error).message });
      }
      try {
        await load(undefined, true);
      } finally {
        // Released only after the re-read, so the button stays unpressable until the card is showing
        // what the server actually stored rather than the state it was in before the cast.
        setVoteInFlight(null);
      }
    },
    [conferenceId, sessionId, choices, load, voteInFlight],
  );

  return (
    <section
      className="panel activities"
      aria-labelledby="session-activities-title"
      data-testid="session-activities"
      data-can-run={canRun ? 'true' : 'false'}
    >
      <div className="panel__header">
        <h3 className="panel__title" id="session-activities-title">
          Activities{payload === null ? '' : ` – ${payload.session.title}`}
        </h3>
        {onClose !== undefined ? (
          <button
            className="button button--small"
            type="button"
            data-testid="activities-close"
            onClick={onClose}
          >
            Close
          </button>
        ) : null}
      </div>

      {/*
       * How current what is on screen is - **beside what it describes, never instead of it** (OC04).
       *
       * A **panel-level** fact rather than a per-Board one, and deliberately: what it dates is this
       * screen's contact with the Session, not one Round's, so putting a copy inside each Board
       * would be the same sentence repeated with nothing to distinguish the repetitions. On a
       * Session running only a Poll it is still the honest age of what is on screen.
       *
       * It is derived from the last successful **exchange with the server** alone - the watermark
       * poll counts, not only the Board read it sometimes provokes - so a quiet room reads "Updated
       * just now" while a connection that dies leaves the Board exactly where it was and this
       * sentence ages honestly beside it; the next answer that arrives returns it to "Updated just
       * now". So in ordinary use it reads "Updated just now" for everybody, holder and Attendee
       * alike, and says anything else only when this device has genuinely stopped being answered -
       * which is the whole of what it is for. There is no retry control here and no error box:
       * the shared loop is already trying, and a dead connection says nothing about this caller's
       * access - a refusal that does is the branch that replaces the Board instead.
       *
       * `stalenessLabel` unchanged, and clamped at zero for the reason it is clamped everywhere
       * else: a device whose clock jumped backwards must not be told the Board updates in the
       * future. The age is a difference of two readings of one clock, so no timezone and no
       * `EffectiveClock` correction appears in it - there is nothing here to correct.
       *
       * Deliberately **not** a live region. It changes on its own every minute for as long as the
       * Session is open, and announcing that each time would interrupt somebody reading the Board
       * to tell them something they cannot act on. It is a standing fact, readable whenever it is
       * looked at.
       */}
      {age === null ? null : (
        <p className="panel__hint activities__age" data-testid="activities-age">
          {age}
        </p>
      )}

      {state.kind === 'loading' ? (
        <p className="panel__hint">Loading this session’s activities…</p>
      ) : null}

      {state.kind === 'failed' ? (
        <div className="alert" role="alert" data-testid="activities-error">
          {state.message}
          <code className="alert__code">{state.code}</code>
        </div>
      ) : null}

      {/*
       * What this device is still holding, shown when the session itself could not be read.
       *
       * Two cases, one list. The app came back with no connection and there is no board to hang a
       * pending post-it on (Acceptance Scenario S01); or the board is there and the item's Round is
       * not, because it was deleted while the item waited (Acceptance Scenario S06). Either way the
       * text is still here and its author must be able to see that it was not lost, and to discard
       * it once they have read why it could not be posted.
       *
       * It is **not** an offline view of the round: no prompt, no other participant's post-its,
       * nothing to compose with. Just what this person typed and has not yet managed to send.
       */}
      {heldElsewhere.length > 0 ? (
        <ul className="board__list board__list--held" data-testid="held-post-its">
          {heldElsewhere.map((item) => (
            <HeldPostIt
              key={item.submissionId}
              item={item}
              viewerName={viewerName}
              onDismiss={() => void dismiss(item.submissionId)}
              inUncategorised={false}
            />
          ))}
        </ul>
      ) : null}

      {/*
       * Outside the round list and outside the form, so neither a re-read nor a re-render of the
       * editor can take the sentence off the screen with it.
       */}
      {refusal !== null ? (
        <div className="alert" role="alert" data-testid="activities-refusal">
          {refusal}
        </div>
      ) : null}

      {saveError !== null && saveError.details.length === 0 ? (
        <div className="alert" role="alert" data-testid="activities-save-error">
          {saveError.message}
        </div>
      ) : null}

      {payload === null ? null : payload.rounds.length === 0 ? (
        <p className="panel__hint" data-testid="activities-empty">
          This session has no rounds yet.
          {canRun ? ' Add the first one below.' : ''}
        </p>
      ) : (
        <ol className="session-list" data-testid="round-list">
          {payload.rounds.map((round) => (
            <li
              key={round.id}
              className={`session-card round-card round-card--${round.state}`}
              data-testid={`round-${round.id}`}
              data-state={round.state}
              data-kind={round.kind}
            >
              <div className="session-card__when">
                <span className="badge badge--round-kind">{kindLabel(round)}</span>
                {/*
                 * `status`, not `alert`: a round being open is a standing fact about the session,
                 * not an event to interrupt someone with. Announced because a screen-reader user
                 * gets no benefit from a colour change.
                 */}
                <span
                  className={`badge badge--round-${round.state}`}
                  role="status"
                  data-testid={`round-state-${round.id}`}
                >
                  {round.state === 'open' ? 'Open' : 'Closed'}
                </span>
              </div>

              <div className="session-card__what">
                <p className="round-card__prompt" data-testid={`round-prompt-${round.id}`}>
                  {round.prompt}
                </p>
                {round.kind === 'VotingRound' ? (
                  <Poll
                    round={round}
                    choice={choices[round.id]}
                    onChoose={(optionId) =>
                      setChoices((current) => ({ ...current, [round.id]: optionId }))
                    }
                    onVote={() => void vote(round.id)}
                    busy={voteInFlight === round.id}
                    error={voteError?.roundId === round.id ? voteError.message : null}
                  />
                ) : null}

                {round.kind === 'PostItRound' ? (
                  <Board
                    round={round}
                    conferenceId={conferenceId}
                    sessionId={sessionId}
                    canRun={canRun}
                    draft={drafts[round.id] ?? ''}
                    onDraftChange={(text) =>
                      setDrafts((current) => ({ ...current, [round.id]: text }))
                    }
                    onContribute={() => void contribute(round.id)}
                    editor={postItEditor?.roundId === round.id ? postItEditor : null}
                    onEditorChange={setPostItEditor}
                    onSaveCorrection={() => void saveCorrection()}
                    onRemove={(postItId) => void remove(round.id, postItId)}
                    onDiscard={(postItId) => void discard(round.id, postItId)}
                    onRestore={(postItId) => restore(round.id, postItId)}
                    canRemovePermanently={canRemovePermanently}
                    permanentRemoval={
                      permanentRemoval?.roundId === round.id ? permanentRemoval : null
                    }
                    onPermanentRemovalChange={setPermanentRemoval}
                    onRemovePermanently={(postItId) => removePermanently(round.id, postItId)}
                    revision={payload?.activityWatermark ?? null}
                    placements={placements}
                    onPlacementChange={(postItId, destination) =>
                      setPlacements((current) => ({ ...current, [postItId]: destination }))
                    }
                    onPlace={(postItId, destination) => void place(round.id, postItId, destination)}
                    writeInFlight={writing}
                    error={boardError?.roundId === round.id ? boardError.message : null}
                    held={heldFor(round.id)}
                    viewerName={viewerName}
                    onDismiss={(submissionId) => void dismiss(submissionId)}
                    categoryDraft={categoryDrafts[round.id] ?? ''}
                    onCategoryDraftChange={(name) =>
                      setCategoryDrafts((current) => ({ ...current, [round.id]: name }))
                    }
                    onAddCategory={() => void addCategory(round.id)}
                    categoryEditor={categoryEditor?.roundId === round.id ? categoryEditor : null}
                    onCategoryEditorChange={setCategoryEditor}
                    onSaveCategoryName={() => void saveCategoryName()}
                    onMoveCategory={(categoryId, position) =>
                      void moveCategory(round.id, categoryId, position)
                    }
                    categoryRemoval={categoryRemoval?.roundId === round.id ? categoryRemoval : null}
                    onCategoryRemovalChange={setCategoryRemoval}
                    onRemoveCategory={(categoryId, destination) =>
                      void removeCategory(round.id, categoryId, destination)
                    }
                    categoryError={
                      categoryError?.roundId === round.id ? categoryError.message : null
                    }
                    categoryWarning={
                      categoryWarning?.roundId === round.id ? categoryWarning.message : null
                    }
                  />
                ) : null}
              </div>

              {/* The run controls exist only for a holder – `canRun` is the server's answer. */}
              {canRun ? (
                <div className="session-card__actions">
                  <button
                    className="button"
                    type="button"
                    data-testid={`round-open-${round.id}`}
                    onClick={() => void move(round, 'open')}
                  >
                    Open
                  </button>
                  <button
                    className="button"
                    type="button"
                    data-testid={`round-close-${round.id}`}
                    onClick={() => void move(round, 'close')}
                  >
                    Close
                  </button>
                  <button
                    className="button"
                    type="button"
                    data-testid={`round-edit-${round.id}`}
                    onClick={() => {
                      setEditor({ open: true, editing: round });
                      setSaveError(null);
                    }}
                  >
                    Edit
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      )}

      {payload === null || !canRun ? null : editor.open ? (
        <RoundForm
          editing={editor.editing}
          onSubmit={submit}
          onCancel={() => {
            setEditor({ open: false });
            setSaveError(null);
          }}
          busy={saving}
          error={saveError}
        />
      ) : (
        <p className="panel__actions">
          <button
            className="button button--primary"
            type="button"
            data-testid="add-round"
            onClick={() => {
              setEditor({ open: true, editing: null });
              setSaveError(null);
              setRefusal(null);
            }}
          >
            Add a round
          </button>
        </p>
      )}
    </section>
  );
}

interface PollProps {
  round: Round;
  choice: string | undefined;
  onChoose: (optionId: string) => void;
  onVote: () => void;
  /** True while this Poll's own cast is out. See `voteInFlight` on the panel. */
  busy: boolean;
  error: string | null;
}

/**
 * One Poll: its options, the single choice a Member makes once, and the result when they may see
 * it.
 *
 * Three states, and which one shows is decided entirely by what the **server** put on the payload:
 *
 *   - **not yet voted** – the options as a single-choice list with a submit, offered while the
 *     Round is open and `hasVoted` is false;
 *   - **voted** – a settled sentence and **no** control to change or withdraw it, because a Vote is
 *     final and there is no endpoint that would accept one;
 *   - **result** – counts per option, rendered whenever `tally` is on the payload. Its absence is
 *     rendered as nothing at all rather than as zeroes: a zero would be a claim about the votes,
 *     and the server withheld the tally precisely so no such claim is made.
 *
 * Nothing here re-derives any of that. There is no client-side rule about who may see a tally and
 * none about whether this person has voted - the server decides both, and a second opinion here
 * could only drift out of step with the one that is actually enforced.
 *
 * The option list keeps the `round-options-…` test id it had before this story, because it is the
 * same list: what changed is that its items became selectable. Counts are rendered in a *separate*
 * list so an option's own row still reads as its label and nothing else.
 */
function Poll({ round, choice, onChoose, onVote, busy, error }: PollProps): React.JSX.Element {
  const options = round.options ?? [];
  const voted = round.hasVoted === true;
  const open = round.state === 'open';
  const votable = open && !voted;
  const tally = round.tally;
  // Only ever used to scale the bars against each other. A poll nobody voted in has no widest bar,
  // and dividing by it would be a NaN on screen.
  const most = tally === undefined ? 0 : Math.max(0, ...tally.map((entry) => entry.votes));

  return (
    <div className="poll" data-testid={`poll-${round.id}`} data-voted={voted ? 'true' : 'false'}>
      <ol className="round-card__options" data-testid={`round-options-${round.id}`}>
        {options.map((option) => (
          <li key={option.id}>
            {votable ? (
              <label className="poll__choice">
                <input
                  type="radio"
                  /*
                   * Grouped per Round, so two Polls open on the same Session are two independent
                   * choices rather than one shared radio group - which is what a fixed name would
                   * make them.
                   */
                  name={`poll-choice-${round.id}`}
                  value={option.id}
                  data-testid={`poll-option-${option.id}`}
                  checked={choice === option.id}
                  onChange={() => onChoose(option.id)}
                />
                {option.label}
              </label>
            ) : (
              option.label
            )}
          </li>
        ))}
      </ol>

      {/*
       * Outside the option list and above the result, so neither a re-render of the choices nor a
       * tally arriving can take the sentence off the screen with it. It is the server's own words -
       * "you have already voted", "this poll has closed" - and it carries no counts because the
       * refusal it came from carried none.
       */}
      {error !== null ? (
        <div className="alert" role="alert" data-testid={`poll-error-${round.id}`}>
          {error}
        </div>
      ) : null}

      {votable ? (
        <p className="poll__actions">
          <button
            className="button button--primary"
            type="button"
            data-testid={`poll-submit-${round.id}`}
            /*
             * Nothing chosen is nothing to send. Disabled rather than refused by the server, because
             * "pick an option first" is not a rule the room needs a round trip to learn - every
             * refusal that *is* a rule still comes from the server.
             *
             * And nothing to send *again* while a cast is already out: `busy` is what stops a
             * double-tap turning one intent into two casts, the second of which the server rightly
             * refuses as a duplicate. This is not a client-side opinion about whether the Vote
             * landed - that answer still arrives on the re-read as `hasVoted`.
             */
            disabled={choice === undefined || busy}
            onClick={onVote}
          >
            {busy ? 'Sending…' : 'Vote'}
          </button>
        </p>
      ) : null}

      {/*
       * `status`, not `alert`: having voted is a standing fact about this poll, not an event to
       * interrupt somebody with. Announced because a settled card is otherwise only a visual change.
       * There is deliberately nothing beside it to press.
       */}
      {voted ? (
        <p className="poll__voted" role="status" data-testid={`poll-voted-${round.id}`}>
          Your vote is in. A vote is final, so it cannot be changed.
        </p>
      ) : null}

      {tally === undefined ? null : (
        <ul className="poll__results" data-testid={`poll-results-${round.id}`}>
          {options.map((option) => {
            const votes = tally.find((entry) => entry.optionId === option.id)?.votes ?? 0;
            return (
              <li key={option.id} className="poll__result">
                <span className="poll__result-label">{option.label}</span>
                {/*
                 * The bar is presentational; the number beside it is the fact. A width alone would
                 * leave the result unreadable to a screen reader and unreadable at all on a phone
                 * where every bar is a few pixels wide.
                 */}
                <span
                  className="poll__result-bar"
                  aria-hidden="true"
                  style={{ width: `${most === 0 ? 0 : (votes / most) * 100}%` }}
                />
                <span className="poll__result-count" data-testid={`poll-count-${option.id}`}>
                  {votes}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

interface BoardProps {
  round: Round;
  /** Named so the Display Link controls can address this Round. Nothing else on this Board needs it. */
  conferenceId: string;
  sessionId: string;
  draft: string;
  onDraftChange: (text: string) => void;
  onContribute: () => void;
  editor: PostItEditor | null;
  onEditorChange: (editor: PostItEditor | null) => void;
  onSaveCorrection: () => void;
  onRemove: (postItId: string) => void;
  /** The Facilitator's Discard, per Post-it (S05 TI08). */
  onDiscard: (postItId: string) => void;
  /** The reversal, per Post-it, made from this Board's discarded list (S05 TI09). */
  onRestore: (postItId: string) => Promise<void>;
  /**
   * Whether this viewer may **permanently remove** a Post-it here - the server's answer, off the
   * payload (S06 TI04). Separate from `canRun`, which an assigned Facilitator also holds.
   */
  canRemovePermanently: boolean;
  /** The Post-it on *this* Board whose removal confirmation is open, or `null`. */
  permanentRemoval: PermanentRemoval | null;
  /** Open the confirmation, or dismiss it. Dismissing sends nothing. */
  onPermanentRemovalChange: (removal: PermanentRemoval | null) => void;
  /**
   * Confirmed: the irreversible write itself.
   *
   * Awaitable, as `onRestore` is and for the same reason: the discarded list offers this act too
   * (OC01's third place) and has to re-read itself once the write and the Board re-read behind it
   * have settled.
   */
  onRemovePermanently: (postItId: string) => Promise<void>;
  /**
   * This Board's activity cursor, passed to the discarded list so it re-reads on the one shared
   * tick rather than owning a cadence of its own.
   */
  revision: string | null;
  /**
   * The destination chosen for each Post-it but not yet committed, keyed by Post-it id.
   *
   * An **absent** entry is the ordinary case and means "wherever the Board says it is", which is why
   * this is a sparse record rather than one entry per Post-it: the Board's own answer is the default,
   * and nothing here is a second opinion about where anything sits.
   */
  placements: Record<string, string>;
  onPlacementChange: (postItId: string, destination: string) => void;
  /** The chosen destination, committed. `''` is Uncategorised and becomes `null` on the wire. */
  onPlace: (postItId: string, destination: string) => void;
  /**
   * Is a write out for this key - `round:<id>`, `postit:<id>`, `category:<id>` or
   * `category-new:<id>`?
   *
   * Asked rather than compared, so the disabled control and the guard that refuses the second write
   * are the same fact. A key this answers `false` for stays live: one slow write must not freeze the
   * rest of the board, and - the reason this is a set behind the scenes - must not release another
   * control's guard either.
   */
  writeInFlight: (key: string) => boolean;
  error: string | null;
  /** This round's Post-its still waiting on this device, oldest first (S04). */
  held: QueuedPostIt[];
  viewerName: string | null;
  onDismiss: (submissionId: string) => void;
  /**
   * Whether this viewer runs the Session - the **server's** answer, off the payload.
   *
   * It is the same flag the run controls are drawn from, and it is not re-derived here: sorting
   * authority is a Session Assignment on this Round's Session or conference-wide Admin, decided per
   * request at the API (`prd.md#fr6-sorting-authority`). This decides only what is *offered*; the
   * API refuses every Category write regardless, which is what the tests prove.
   */
  canRun: boolean;
  categoryDraft: string;
  onCategoryDraftChange: (name: string) => void;
  onAddCategory: () => void;
  categoryEditor: CategoryEditor | null;
  onCategoryEditorChange: (editor: CategoryEditor | null) => void;
  onSaveCategoryName: () => void;
  /** The **resulting** position, never a direction: the control names its own outcome. */
  onMoveCategory: (categoryId: string, position: number) => void;
  categoryRemoval: CategoryRemoval | null;
  onCategoryRemovalChange: (removal: CategoryRemoval | null) => void;
  onRemoveCategory: (categoryId: string, destination?: { categoryId: string | null }) => void;
  categoryError: string | null;
  /** A sentence riding a successful write - the duplicate name was stored, not refused. */
  categoryWarning: string | null;
}

interface HeldPostItProps {
  item: QueuedPostIt;
  viewerName: string | null;
  onDismiss: () => void;
  /**
   * Whether this one is drawn **inside Uncategorised**, beside a count it is not part of (S08).
   *
   * The region's count is the server's, and the server has never seen this item - so the badge
   * above says six while seven cards are visible, and the discrepancy has to be explained in words
   * rather than left to be read as a bug. `false` where the item is rendered outside every region:
   * the panel's returned-to-author list has no count above it to be excluded from.
   */
  inUncategorised: boolean;
}

/**
 * One Post-it that is still on this device – pending, or come back with a reason it never will be.
 *
 * **Under its author's name and marked pending, and the marking is a sentence rather than a
 * colour**: a pale card says nothing to a screen-reader user, nothing on a projector, and nothing to
 * anybody who has not been told what pale means. `status` rather than `alert` while it is merely
 * waiting – having a post-it in hand is a standing fact, not an interruption.
 *
 * When it has been refused for good, the server's own sentence is shown **beside the full text**,
 * never instead of it: the text is the thing worth keeping, and somebody whose round was deleted
 * still has an idea they can put somewhere else. It leaves the device when they say so, not on the
 * refusal – which is what "not silently dropped" means in practice.
 */
function HeldPostIt({
  item,
  viewerName,
  onDismiss,
  inUncategorised,
}: HeldPostItProps): React.JSX.Element {
  return (
    <li
      className="post-it post-it--held"
      data-testid={`held-post-it-${item.submissionId}`}
      data-held={item.refusal === null ? 'pending' : 'refused'}
    >
      <p className="post-it__text" data-testid={`held-text-${item.submissionId}`}>
        {item.text}
      </p>
      {/*
       * Under its author's name, like every other post-it – that is what a post-it round is, and it
       * is not suspended because the thing has not been sent yet. `You` only where the name is not
       * known to this surface at all, which is a panel rendered outside the signed-in app.
       */}
      <p className="post-it__by" data-testid={`held-by-${item.submissionId}`}>
        {viewerName ?? 'You'}
      </p>
      {item.refusal === null ? (
        <p
          className="post-it__held"
          role="status"
          data-testid={`held-pending-${item.submissionId}`}
        >
          Waiting to be posted – it is still on this device.
          {inUncategorised ? ' It isn’t in the count above yet.' : ''}
        </p>
      ) : (
        <>
          <div className="alert" role="alert" data-testid={`held-refusal-${item.submissionId}`}>
            {item.refusal}
          </div>
          <p className="post-it__actions">
            {/*
             * Full size, not `button--small` like the correct and remove controls beside a post-it
             * on the board. Those two are conveniences with an obvious alternative; this is the
             * **only** way out of this state, offered to somebody who has just been told their
             * idea did not land - and it is reached one-handed on a 375px phone.
             */}
            <button
              className="button"
              type="button"
              data-testid={`held-dismiss-${item.submissionId}`}
              onClick={onDismiss}
            >
              Discard it
            </button>
          </p>
        </>
      )}
    </li>
  );
}

/**
 * How many Post-its a region holds, as a sentence rather than a bare number.
 *
 * The number is the **server's** count off the payload and is never `postIts.length` re-derived
 * here: a client that counted for itself would be a second opinion about what the Board holds, and
 * the projected screen and every Attendee's phone have to agree with this one.
 */
function countLabel(count: number): string {
  return count === 1 ? '1 post-it' : `${count} post-its`;
}

interface BoardPostItProps {
  postIt: PostIt;
  roundId: string;
  open: boolean;
  editor: PostItEditor | null;
  onEditorChange: (editor: PostItEditor | null) => void;
  onSaveCorrection: () => void;
  onRemove: (postItId: string) => void;
  /**
   * Discard – the Facilitator's removal, and never the author's (S05 TI08).
   *
   * A different control from `onRemove` on purpose, and drawn under a different condition: Remove is
   * offered on your own Post-it while the Round is open, Discard on **every** Post-it wherever it
   * sits and at any Round state, to whoever sorts this Board. Where both appear on the same
   * Post-it they are visibly distinct and say what each one does.
   */
  onDiscard: (postItId: string) => void;
  /**
   * Permanent Removal - the Admin's, and never the Facilitator's or the author's (S06 TI05).
   *
   * A third control on the same Post-it, under a third condition: Remove is offered on your own
   * Post-it while the Round is open, Discard to whoever sorts this Board, and this one only to a
   * conference-wide Admin. Where more than one appears they are visibly distinct and each says what
   * it does, because the three have different consequences and nothing about a button's shape can
   * carry that.
   *
   * Opening the confirmation and confirming it are two different callbacks on purpose: dismissing
   * the first sends nothing at all (FR5 -> Error Handling).
   */
  canRemovePermanently: boolean;
  /**
   * The removal this Post-it's confirmation is standing for, or `null` when none is.
   *
   * The whole record rather than a boolean, because the confirmation is rendered **from it**: the
   * author's name and the text it quotes are the ones captured when the control was pressed, so a
   * Board re-read landing mid-decision cannot rewrite the question underneath somebody.
   */
  confirmingRemoval: PermanentRemoval | null;
  onConfirmRemovalChange: (removal: PermanentRemoval | null) => void;
  onRemovePermanently: (postItId: string) => void;
  writeInFlight: (key: string) => boolean;
  /** Whether this viewer sorts this Board – the **server's** answer, off the payload. */
  canRun: boolean;
  /**
   * Every Category on this Board, in the Facilitator's order, as the destinations open to this
   * Post-it. Uncategorised is not among them: it is the absence of a placement and is offered as
   * the option that names no id.
   */
  categories: Category[];
  /**
   * Where this Post-it is **now**, as the Board that was read says: the id of the Category holding
   * it, or `null` for Uncategorised.
   *
   * Passed down from the region that is rendering it rather than read off the Post-it, which is what
   * preserves the unlisted-Category fallback S02 established: a Post-it whose Category is absent
   * from the same Board read is drawn in Uncategorised, and its control has to agree with where it
   * is drawn.
   */
  here: string | null;
  /** The chosen destination, or `undefined` for "wherever it is now". `''` is Uncategorised. */
  chosen: string | undefined;
  onPlacementChange: (postItId: string, destination: string) => void;
  onPlace: (postItId: string, destination: string) => void;
}

/**
 * One Post-it, wherever it sits.
 *
 * Extracted so Uncategorised and every Category render **the same** Post-it: its author, its
 * `(edited)` marker, its late-arrival sentence and its author's own controls do not depend on which
 * region it is in, and a second copy of this markup is how they would come to.
 *
 * Every Post-it is labelled with its author – that is what a Post-it Round is for, and it is never
 * a setting (`AGENTS.md`: post-its always carry the author's name). The correct and remove controls
 * appear only on the viewer's own Post-its and only while the Round is open, both read from the
 * payload: `mine` is the server's answer and `state` is the Round's, so nothing here decides who may
 * change what.
 */
function BoardPostIt({
  postIt,
  roundId,
  open,
  editor,
  onEditorChange,
  onSaveCorrection,
  onRemove,
  onDiscard,
  canRemovePermanently,
  confirmingRemoval,
  onConfirmRemovalChange,
  onRemovePermanently,
  writeInFlight,
  canRun,
  categories,
  here,
  chosen,
  onPlacementChange,
  onPlace,
}: BoardPostItProps): React.JSX.Element {
  const busy = writeInFlight(`postit:${postIt.id}`);
  /*
   * The control's value falls back to where the Board says the Post-it is, so it opens on the
   * truth rather than on a remembered choice. `??` and not `||`: `''` is Uncategorised, which is a
   * real chosen destination and must not be treated as "nothing chosen".
   *
   * A remembered choice is only honoured while it still names a Category on this Board. Category
   * removal lives on this same panel, so a destination chosen a moment ago can be gone by the next
   * Board read.
   *
   * The failure that makes this worth guarding is a **quiet** one, not a visibly broken control:
   * React's controlled-select reconciliation selects the first non-disabled option when the value
   * it is given matches none, so the control reads *Uncategorised* while the remembered dead id is
   * still what Move would commit. What is on screen and what is sent disagree, and nothing looks
   * wrong. (Assigning `select.value` natively would instead give `selectedIndex = -1`; React does
   * not do that, which is why the control never appears blank here.) Falling back to `here` reopens
   * it on the truth, which is what the line above already promises. `''` is Uncategorised and
   * always available, so it is never stale.
   */
  const chosenStillOffered =
    chosen === undefined || chosen === '' || categories.some((category) => category.id === chosen);
  const destination = (chosenStillOffered ? chosen : undefined) ?? here ?? '';
  const label = shortened(postIt.text);

  return (
    <li
      className="post-it"
      data-testid={`post-it-${postIt.id}`}
      data-mine={postIt.mine ? 'true' : 'false'}
    >
      {/*
       * The correction box is gated on the Round being open just as the controls that open it are.
       * A box left standing after the Round closed would offer a Save the API can only refuse, and
       * the board stops offering *both* affordances the moment it ends (OC02). The panel keeps the
       * editor across the board refresh that carried the close, so this branch is the only thing
       * that withdraws it.
       */}
      {open && editor?.postItId === postIt.id ? (
        <>
          <label className="field__label--inline" htmlFor={`post-it-edit-${postIt.id}`}>
            Your post-it
          </label>
          <textarea
            id={`post-it-edit-${postIt.id}`}
            className="input post-it__input"
            data-testid={`post-it-edit-${postIt.id}`}
            rows={2}
            value={editor.text}
            onChange={(event) => onEditorChange({ ...editor, text: event.target.value })}
          />
          <p className="post-it__actions">
            <button
              className="button button--small button--primary"
              type="button"
              data-testid={`post-it-save-${postIt.id}`}
              onClick={onSaveCorrection}
              disabled={busy}
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button
              className="button button--small"
              type="button"
              data-testid={`post-it-cancel-${postIt.id}`}
              onClick={() => onEditorChange(null)}
            >
              Cancel
            </button>
          </p>
        </>
      ) : (
        <>
          <p className="post-it__text" data-testid={`post-it-text-${postIt.id}`}>
            {postIt.text}
          </p>
          <p className="post-it__by" data-testid={`post-it-by-${postIt.id}`}>
            {postIt.authorName}
            {postIt.edited ? <span className="post-it__edited"> (edited)</span> : null}
          </p>
          {/*
           * A post-it that reached the board after its round had closed says so, wherever it
           * appears (S04, FR6) – the server's answer, on the same read model as the rest of the
           * post-it, so no surface can show a board without it. A sentence and not a shade: the
           * difference matters most on a projector and to a screen reader, and one is exactly where
           * a colour says nothing.
           */}
          {postIt.arrivedAfterClose ? (
            <p className="post-it__late" data-testid={`post-it-late-${postIt.id}`}>
              Arrived after this round closed
            </p>
          ) : null}
          {/*
           * Sorting: choose a destination by name, then commit it (S03 TI05).
           *
           * **The whole interaction, and there is no other one.** No drag handle, no drop target and
           * no pointer-only affordance exists at any width - a select and a button are reachable by
           * keyboard, announced by assistive technology and usable one-handed at 375px, which drag
           * is none of
           * (`docs/wireframes/facilitator-board-and-categorisation/design-decisions.md` → "The
           * non-drag placement interaction model"). The same three keystrokes place a Post-it out of
           * Uncategorised, move it between two Categories, and move it back.
           *
           * **Every control here names the Post-it it acts on.** The label says which Post-it and
           * what the control does; the options say where it can go and which one it is in now; the
           * commit button carries the same name of its own, because a page full of buttons all
           * reading "Move" says nothing to somebody hearing it.
           *
           * Offered only where the payload says this viewer runs the Session - the server's answer,
           * consumed rather than re-derived. It decides what is *offered*; the API refuses a
           * placement without sorting authority regardless, which is the decision that counts.
           *
           * Not gated on the Round being open: sorting is what happens **after** the room has
           * written, and it is permitted while the Round is open, once it has closed, and after a
           * reopen (FR3).
           */}
          {canRun ? (
            <div className="move" data-testid={`move-${postIt.id}`}>
              <label className="field__label--inline" htmlFor={`move-to-${postIt.id}`}>
                Move “{label}” to
              </label>
              <p className="move__row">
                {/*
                 * The empty value is the **absence** of a category id, which is what Uncategorised
                 * is - not a reserved identifier for it. It becomes `null` on the way out, and
                 * `null` is what the request carries.
                 *
                 * "where it is now" is said in words on the option itself rather than left to the
                 * select's own highlight, which is invisible to somebody hearing the page and
                 * unreadable at a glance on a phone.
                 */}
                <select
                  id={`move-to-${postIt.id}`}
                  className="input"
                  data-testid={`move-to-${postIt.id}`}
                  value={destination}
                  onChange={(event) => onPlacementChange(postIt.id, event.target.value)}
                >
                  <option value="">Uncategorised{here === null ? ' – where it is now' : ''}</option>
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                      {here === category.id ? ' – where it is now' : ''}
                    </option>
                  ))}
                </select>
                <button
                  className="button button--primary"
                  type="button"
                  data-testid={`move-submit-${postIt.id}`}
                  aria-label={`Move “${label}” to the destination chosen for it`}
                  onClick={() => onPlace(postIt.id, destination)}
                  disabled={busy}
                >
                  {busy ? 'Moving…' : 'Move'}
                </button>
              </p>
              {/*
               * Discard: the sorting act, on every Post-it, in Uncategorised and in every Category
               * alike (S05 TI08, FR4). An ordinary button beside the placement controls - reachable
               * by keyboard and announced like any other, never a pointer-only affordance
               * (`design-decisions.md` → "The non-drag placement interaction model").
               *
               * **Not gated on the Round being open**, exactly as the placement control above is
               * not: sorting is what happens after the room has written, and a Discard is permitted
               * while the Round runs, once it has closed and after a reopen.
               *
               * It names the Post-it it acts on, because a board full of buttons all reading
               * "Discard" says nothing to somebody hearing the page. It is reversible and its
               * neighbouring sentence says so; nothing here is worded as a deletion.
               */}
              <p className="controls">
                <button
                  className="button button--discard"
                  type="button"
                  data-testid={`post-it-discard-${postIt.id}`}
                  aria-label={`Discard “${label}” from this board`}
                  onClick={() => onDiscard(postIt.id)}
                  disabled={busy}
                >
                  {busy ? 'Discarding…' : 'Discard'}
                </button>
              </p>
            </div>
          ) : null}
          {/*
           * Offered on your own post-its, and only while the round is open. The API refuses both
           * anyway – the guards are in the write statements' predicates – so this is what the room
           * *sees*, never what decides.
           */}
          {postIt.mine && open ? (
            <p className="post-it__actions">
              <button
                className="button button--small"
                type="button"
                data-testid={`post-it-correct-${postIt.id}`}
                onClick={() => onEditorChange({ postItId: postIt.id, roundId, text: postIt.text })}
              >
                Correct
              </button>
              <button
                className="button button--small"
                type="button"
                data-testid={`post-it-remove-${postIt.id}`}
                onClick={() => onRemove(postIt.id)}
                disabled={busy}
              >
                {busy ? 'Removing…' : 'Remove'}
              </button>
            </p>
          ) : null}
          {/*
           * **Permanent Removal**: the Admin's act, on every Post-it, in Uncategorised and in every
           * Category alike (S06 TI05, FR5). Drawn from `canRemovePermanently` and from nothing else
           * - the server's answer, which folds the Conference's editability in, so this control is
           * absent on an archived Conference rather than present and refused.
           *
           * **Deliberately outside the `canRun` block above.** An Admin holds `canRun` too, so
           * nesting it there would work today and would quietly tie the irreversible act to the
           * sorting authority FR5 exists to keep it away from.
           *
           * **Not gated on the Round being open**, like the sorting controls and unlike the author's
           * own Remove: moderation cannot wait for a Round to be open.
           *
           * The control itself is `PermanentRemoval.tsx`'s, shared with the discarded Post-its
           * surface - the same act in the third place OC01 names, in the same words.
           */}
          {canRemovePermanently ? (
            <p className="controls">
              <PermanentRemovalControl
                subject={{
                  postItId: postIt.id,
                  roundId,
                  authorName: postIt.authorName,
                  text: postIt.text,
                }}
                busy={busy}
                onOpen={onConfirmRemovalChange}
              />
            </p>
          ) : null}
          {/*
           * The confirmation, rendered from the panel's own record of what was clicked and from
           * nothing on this Post-it: a Board re-read arriving mid-decision cannot swap what the
           * question is about underneath somebody. It is the same component the discarded Post-its
           * surface renders, so the two say the same thing in the same words.
           */}
          {canRemovePermanently && confirmingRemoval !== null ? (
            <PermanentRemovalConfirmation
              removal={confirmingRemoval}
              busy={busy}
              onConfirm={() => onRemovePermanently(postIt.id)}
              onCancel={() => onConfirmRemovalChange(null)}
            />
          ) : null}
          {/*
           * Said in words where both controls are on the same Post-it, because the two removals have
           * opposite consequences and nothing about a button's shape can carry that. Only where the
           * viewer is looking at their own Post-it *and* sorts this Board - anywhere else one of the
           * two controls is not there to be confused with the other.
           */}
          {postIt.mine && open && canRun ? (
            <p className="post-it__note" data-testid={`post-it-removal-note-${postIt.id}`}>
              <strong>Remove</strong> is your own deletion – it leaves no trace and only works while
              the round is open. <strong>Discard</strong> is the sorting act: it leaves a trace and
              you can put it back.
            </p>
          ) : null}
        </>
      )}
    </li>
  );
}

/**
 * One Post-it Round's board: Uncategorised, the Categories in the Facilitator's order, and the box
 * a Member adds to it from.
 *
 * Four things about it are load-bearing:
 *
 *   - **Uncategorised is always here** – on a board with no Categories and on a board with no
 *     Post-its at all. It is where every Post-it arrives and where a late-syncing one lands, and a
 *     Conference archived with Post-its still in it is a valid terminal state
 *     (`prd.md#fr2-the-uncategorised-holding-area`). It says in words that it carries no rename,
 *     reorder or remove, rather than leaving their absence to be read as an oversight.
 *   - **Every count is the server's**, off `postItCount`, never `postIts.length` re-derived here –
 *     which is also why a post-it still held on this device is drawn inside Uncategorised without
 *     being added to its number. It is where the item lands; it is not there yet.
 *   - **Nothing sorts by pointer.** Reorder is an explicit control that names its own outcome –
 *     `Move down – to position 2` – and each region states its position in words, because at 375px
 *     the regions are one across and layout cannot express order at the width that decides the
 *     interaction model (`docs/wireframes/facilitator-board-and-categorisation/design-decisions.md`
 *     → "The non-drag placement interaction model"). No drag handle exists at any width.
 *   - **The control at the end of the order is `aria-disabled`, never `disabled`.** A `disabled`
 *     button leaves the tab order, so the control sequence a keyboard user has learned would change
 *     shape exactly when a Category reaches the end of the order – the opposite of what this control
 *     set is for. It stays focusable and is announced as unavailable, and pressing it does nothing;
 *     the server clamps a position outside the range in any case, so no press can write a broken
 *     order.
 *
 * Nothing in here holds state. The draft, the open correction, the Category being renamed, the
 * removal waiting on a destination and every refusal all live in the panel above, outside the
 * subtree a board refresh replaces (`docs/LEARNINGS.md#react-state--refusals`).
 */
function Board({
  round,
  conferenceId,
  sessionId,
  canRun,
  draft,
  onDraftChange,
  onContribute,
  editor,
  onEditorChange,
  onSaveCorrection,
  onRemove,
  onDiscard,
  onRestore,
  canRemovePermanently,
  permanentRemoval,
  onPermanentRemovalChange,
  onRemovePermanently,
  revision,
  placements,
  onPlacementChange,
  onPlace,
  writeInFlight,
  error,
  held,
  viewerName,
  onDismiss,
  categoryDraft,
  onCategoryDraftChange,
  onAddCategory,
  categoryEditor,
  onCategoryEditorChange,
  onSaveCategoryName,
  onMoveCategory,
  categoryRemoval,
  onCategoryRemovalChange,
  onRemoveCategory,
  categoryError,
  categoryWarning,
}: BoardProps): React.JSX.Element {
  const categories: Category[] = round.categories ?? [];
  const uncategorised = round.uncategorised ?? { postIts: [], postItCount: 0 };
  const open = round.state === 'open';
  const onBoard =
    uncategorised.postItCount + categories.reduce((total, held) => total + held.postItCount, 0);
  /*
   * The limit as the **server** states it, on this payload. There is no fallback number: a literal
   * here would be a second definition of the cap that could disagree with the one being enforced,
   * and the hint is simply absent if the payload ever arrives without it.
   */
  const limit = round.textMaxLength;

  /**
   * The two halves of what this device is still holding for this Round, which belong in two places.
   *
   * A **pending** item is on its way to Uncategorised, so it is drawn there. A **returned** one -
   * refused for good, carrying the server's reason and the only control this surface offers a held
   * post-it - is going nowhere, so it stays below the Board where it was before the pending ones
   * moved into the region (S08 TI01). The two are the store's own distinction, off `refusal`, and
   * nothing here re-decides it.
   */
  const pendingHeld = held.filter((item) => item.refusal === null);
  const returnedHeld = held.filter((item) => item.refusal !== null);

  /**
   * One region's Post-its.
   *
   * `here` is passed by the **region that is drawing them**, not read off the Post-it: that is what
   * keeps the placement control agreeing with where the Post-it is actually rendered, including in
   * the case S02 settled where a Post-it naming a Category this read did not list is drawn in
   * Uncategorised.
   */
  const postItsOf = (postIts: PostIt[], here: string | null): React.JSX.Element => (
    <ul className="board__list">
      {postIts.map((postIt) => (
        <BoardPostIt
          key={postIt.id}
          postIt={postIt}
          roundId={round.id}
          open={open}
          editor={editor}
          onEditorChange={onEditorChange}
          onSaveCorrection={onSaveCorrection}
          onRemove={onRemove}
          onDiscard={onDiscard}
          canRemovePermanently={canRemovePermanently}
          confirmingRemoval={permanentRemoval?.postItId === postIt.id ? permanentRemoval : null}
          onConfirmRemovalChange={onPermanentRemovalChange}
          onRemovePermanently={(postItId) => void onRemovePermanently(postItId)}
          writeInFlight={writeInFlight}
          canRun={canRun}
          categories={categories}
          here={here}
          chosen={placements[postIt.id]}
          onPlacementChange={onPlacementChange}
          onPlace={onPlace}
        />
      ))}
    </ul>
  );

  return (
    <div className="board" data-testid={`board-${round.id}`}>
      {/*
       * Both sentences sit **above** the regions and are held by the panel, so neither is inside the
       * subtree the re-read its own handler triggers replaces. The refusal is an `alert`; the
       * duplicate-name warning is a `status`, because the write landed and there is nothing for the
       * Facilitator to fix.
       */}
      {categoryError !== null ? (
        <div className="alert" role="alert" data-testid={`category-error-${round.id}`}>
          {categoryError}
        </div>
      ) : null}
      {categoryWarning !== null ? (
        <p className="board__warning" role="status" data-testid={`category-warning-${round.id}`}>
          {categoryWarning}
        </p>
      ) : null}

      {/*
       * The Display Link (S04), offered only where sorting authority is already established for
       * this Session - the same `canRun` the run controls use, which is the server's answer rather
       * than a second client-side opinion about who may act. It sits **above** the regions and
       * holds its own state and its own refusal, so nothing the board's polling re-render replaces
       * can take either away.
       */}
      {canRun ? (
        <DisplayLinkControl conferenceId={conferenceId} sessionId={sessionId} roundId={round.id} />
      ) : null}

      {/*
       * The discarded Post-its of this Board, and the only place a Discard is reversed (S05 TI09).
       * Its entry point is permanent - it is here whether or not anything has just been discarded,
       * because the reversal window runs to archival and an affordance that appeared only at the
       * moment of discarding would leave a Facilitator with nowhere to start an hour later
       * (`design-decisions.md` → "The discarded Post-its surface").
       *
       * Above the regions and outside the subtree a board refresh replaces, like the two sentences
       * and the Display Link control, so nothing it holds is taken off screen by the re-read its own
       * restore triggers.
       */}
      {canRun ? (
        <DiscardedPostIts
          conferenceId={conferenceId}
          sessionId={sessionId}
          roundId={round.id}
          revision={revision}
          onRestore={onRestore}
          canRemovePermanently={canRemovePermanently}
          permanentRemoval={permanentRemoval}
          onPermanentRemovalChange={onPermanentRemovalChange}
          onRemovePermanently={onRemovePermanently}
          writeInFlight={writeInFlight}
        />
      ) : null}

      {onBoard === 0 && held.length === 0 ? (
        <p className="panel__hint" data-testid={`board-empty-${round.id}`}>
          {open ? 'No post-its yet. Add the first one.' : 'This round collected no post-its.'}
        </p>
      ) : null}

      <ul className="regions" data-testid={`regions-${round.id}`}>
        {/*
         * Uncategorised first and always, whatever else is on the board. It is not a Category: it
         * carries no name to change, no position to move and no control to remove it, and the
         * sentence below says so rather than leaving the absence to be inferred.
         */}
        <li
          className="region region--uncategorised"
          data-testid={`uncategorised-${round.id}`}
          data-count={uncategorised.postItCount}
        >
          <div className="region__head">
            <h5 className="region__name">Uncategorised</h5>
            <span className="region__count" data-testid={`uncategorised-count-${round.id}`}>
              {countLabel(uncategorised.postItCount)}
            </span>
          </div>
          <p className="region__note" data-testid={`uncategorised-note-${round.id}`}>
            Where every post-it arrives. It can’t be renamed, reordered or removed.
          </p>
          {/*
           * This person's own post-its, typed here and not yet delivered - **inside Uncategorised,
           * which is where they land** (S08 TI01; `attendee-board.html`).
           *
           * They used to sit in a list below the whole Board. Under the grouped shape that reads as
           * a fourth place a Post-it can be, and there are only three - Uncategorised, a Category,
           * or discarded - so somebody watching the room sort would be left to work out for
           * themselves where their own idea was heading. It is heading here.
           *
           * **They are not counted.** The number in the head above is the server's, off
           * `postItCount`, and the server has never seen these: adding them would make the count a
           * client-side derivation and put this phone in disagreement with the projected screen and
           * with every other Member's. The card says so in words instead.
           *
           * First, so the person who just typed one can see it without hunting: it is the only item
           * in this region that is theirs to do anything about. They come from the device's store
           * rather than from anything this component remembered, so a force-quit and relaunch shows
           * the same list (S04, Acceptance Scenario S01).
           *
           * **Only the ones still on their way.** The justification above - "it is where the item
           * lands" - is true of a pending item and false of one the server has refused for good:
           * that one is never arriving, and drawing it in the region for things that are on their
           * way says the opposite of what is true. It also carries the only pressable thing this
           * device offers a held post-it, worded *Discard it*, and `docs/UBIQUITOUS_LANGUAGE.md`
           * reserves **Discard** for the Facilitator's sorting act - a word that must not appear on
           * a Board region on the surface this story makes read-only. Returned-to-author items are
           * rendered below the Board instead, where they were before this story moved the pending
           * ones, and where the sentence beside them is the server's reason rather than a count.
           */}
          {pendingHeld.length === 0 ? null : (
            <ul className="board__list board__list--held" data-testid={`board-held-${round.id}`}>
              {pendingHeld.map((item) => (
                <HeldPostIt
                  key={item.submissionId}
                  item={item}
                  viewerName={viewerName}
                  onDismiss={() => onDismiss(item.submissionId)}
                  inUncategorised
                />
              ))}
            </ul>
          )}
          {uncategorised.postIts.length === 0 ? null : postItsOf(uncategorised.postIts, null)}
        </li>

        {categories.map((category, index) => {
          const first = index === 0;
          const last = index === categories.length - 1;
          const busy = writeInFlight(`category:${category.id}`);
          const renaming = categoryEditor?.categoryId === category.id;
          const removing = categoryRemoval?.categoryId === category.id;

          return (
            <li className="region" key={category.id} data-testid={`category-${category.id}`}>
              <div className="region__head">
                <h5 className="region__name" data-testid={`category-name-${category.id}`}>
                  {category.name}
                </h5>
                <span className="region__count" data-testid={`category-count-${category.id}`}>
                  {countLabel(category.postItCount)}
                </span>
              </div>
              {/*
               * The position, in words. At 375px the regions are one across, so order read from
               * layout alone would be unreadable – and it is unspeakable at every width to somebody
               * hearing the page rather than seeing it.
               */}
              <p className="region__position" data-testid={`category-position-${category.id}`}>
                Position {index + 1} of {categories.length}
              </p>

              {canRun ? (
                <p className="controls" data-testid={`category-controls-${category.id}`}>
                  <button
                    className="button"
                    type="button"
                    data-testid={`category-rename-${category.id}`}
                    aria-label={`Rename the category “${category.name}”`}
                    onClick={() =>
                      onCategoryEditorChange({
                        categoryId: category.id,
                        roundId: round.id,
                        name: category.name,
                      })
                    }
                  >
                    Rename
                  </button>
                  {/*
                   * `aria-disabled` and **not** the `disabled` attribute *for the end of the
                   * order*. See the component note: a disabled button leaves the tab order, and a
                   * category reaching the end must not change the tab sequence.
                   *
                   * `disabled={busy}` is a different rule about a different thing - this control's
                   * own write being out - and it is momentary rather than positional, exactly as it
                   * is on Remove and on Save name.
                   */}
                  <button
                    className="button"
                    type="button"
                    data-testid={`category-up-${category.id}`}
                    aria-label={`Move the category “${category.name}” up`}
                    aria-disabled={first ? 'true' : undefined}
                    disabled={busy}
                    onClick={() => {
                      if (first) return;
                      onMoveCategory(category.id, index);
                    }}
                  >
                    {busy ? 'Moving…' : first ? 'Move up' : `Move up – to position ${index}`}
                  </button>
                  <button
                    className="button"
                    type="button"
                    data-testid={`category-down-${category.id}`}
                    aria-label={`Move the category “${category.name}” down`}
                    aria-disabled={last ? 'true' : undefined}
                    disabled={busy}
                    onClick={() => {
                      if (last) return;
                      onMoveCategory(category.id, index + 2);
                    }}
                  >
                    {busy ? 'Moving…' : last ? 'Move down' : `Move down – to position ${index + 2}`}
                  </button>
                  {/*
                   * An empty Category goes with no prompt; an occupied one opens the destination
                   * question below. The count that decides it is the server's, and the server
                   * decides again when the request lands – this only chooses which control to offer.
                   */}
                  <button
                    className="button"
                    type="button"
                    data-testid={`category-remove-${category.id}`}
                    aria-label={`Remove the category “${category.name}”`}
                    disabled={busy}
                    onClick={() => {
                      if (category.postItCount === 0) {
                        onRemoveCategory(category.id);
                        return;
                      }
                      onCategoryRemovalChange({
                        categoryId: category.id,
                        roundId: round.id,
                        // Uncategorised, offered as the default: it is where they came from and
                        // where nothing is lost. `null` is the absence of a placement, not an id.
                        destinationCategoryId: null,
                      });
                    }}
                  >
                    {busy ? 'Working…' : 'Remove'}
                  </button>
                </p>
              ) : null}

              {canRun && renaming ? (
                <div className="inline-form" data-testid={`category-rename-form-${category.id}`}>
                  <label
                    className="field__label--inline"
                    htmlFor={`category-rename-input-${category.id}`}
                  >
                    Rename this category
                  </label>
                  <input
                    id={`category-rename-input-${category.id}`}
                    className="input"
                    data-testid={`category-rename-input-${category.id}`}
                    type="text"
                    value={categoryEditor.name}
                    onChange={(event) =>
                      onCategoryEditorChange({ ...categoryEditor, name: event.target.value })
                    }
                  />
                  <p className="panel__hint">Renaming moves no post-its.</p>
                  <p className="controls">
                    <button
                      className="button button--primary"
                      type="button"
                      data-testid={`category-rename-save-${category.id}`}
                      onClick={onSaveCategoryName}
                      disabled={busy}
                    >
                      {busy ? 'Saving…' : 'Save name'}
                    </button>
                    <button
                      className="button"
                      type="button"
                      data-testid={`category-rename-cancel-${category.id}`}
                      onClick={() => onCategoryEditorChange(null)}
                    >
                      Cancel
                    </button>
                  </p>
                </div>
              ) : null}

              {canRun && removing ? (
                <div className="inline-form" data-testid={`category-removal-${category.id}`}>
                  <p>
                    <strong>Remove “{category.name}”?</strong>
                  </p>
                  <p className="panel__hint" data-testid={`category-removal-count-${category.id}`}>
                    It holds {countLabel(category.postItCount)}. Say where they go – they are not
                    deleted.
                  </p>
                  <label
                    className="field__label--inline"
                    htmlFor={`category-destination-${category.id}`}
                  >
                    Move its {countLabel(category.postItCount)} to
                  </label>
                  {/*
                   * The empty value is the **absence** of a category id, which is what Uncategorised
                   * is – not a reserved identifier for it. It is converted back to `null` on the way
                   * out, and `null` is what the request carries.
                   */}
                  <select
                    id={`category-destination-${category.id}`}
                    className="input"
                    data-testid={`category-destination-${category.id}`}
                    value={categoryRemoval.destinationCategoryId ?? ''}
                    onChange={(event) =>
                      onCategoryRemovalChange({
                        ...categoryRemoval,
                        destinationCategoryId:
                          event.target.value === '' ? null : event.target.value,
                      })
                    }
                  >
                    <option value="">Uncategorised</option>
                    {categories
                      .filter((other) => other.id !== category.id)
                      .map((other) => (
                        <option key={other.id} value={other.id}>
                          {other.name}
                        </option>
                      ))}
                  </select>
                  <p className="controls">
                    <button
                      className="button button--primary"
                      type="button"
                      data-testid={`category-removal-confirm-${category.id}`}
                      onClick={() =>
                        onRemoveCategory(category.id, {
                          categoryId: categoryRemoval.destinationCategoryId,
                        })
                      }
                      disabled={busy}
                    >
                      {busy ? 'Moving…' : 'Move them and remove'}
                    </button>
                    <button
                      className="button"
                      type="button"
                      data-testid={`category-removal-cancel-${category.id}`}
                      onClick={() => onCategoryRemovalChange(null)}
                    >
                      Cancel
                    </button>
                  </p>
                </div>
              ) : null}

              {category.postIts.length === 0 ? (
                <p className="panel__hint" data-testid={`category-empty-${category.id}`}>
                  Nothing in here yet.
                </p>
              ) : (
                postItsOf(category.postIts, category.id)
              )}
            </li>
          );
        })}
      </ul>

      {/*
       * Below the Board: this person's own post-its that came back with a reason they never will be
       * posted (S04, Acceptance Scenario S06).
       *
       * **Outside the regions deliberately**, unlike the pending ones above. A returned item has no
       * placement because it has no row and never will have one, so drawing it in Uncategorised
       * would claim it was on its way to a Board state the server is never going to see. Here the
       * server's own sentence sits beside the whole of what was typed, with the one control that
       * takes it off the device - which is what "not silently dropped" means in practice.
       */}
      {returnedHeld.length === 0 ? null : (
        <ul className="board__list board__list--held" data-testid={`board-returned-${round.id}`}>
          {returnedHeld.map((item) => (
            <HeldPostIt
              key={item.submissionId}
              item={item}
              viewerName={viewerName}
              onDismiss={() => onDismiss(item.submissionId)}
              inUncategorised={false}
            />
          ))}
        </ul>
      )}

      {/*
       * The refusal sits between the board and the compose box, and both of those are re-rendered by
       * every poll – but the sentence itself is held by the panel, so it survives them
       * (`docs/LEARNINGS.md#react-state--refusals`).
       */}
      {error !== null ? (
        <div className="alert" role="alert" data-testid={`board-error-${round.id}`}>
          {error}
        </div>
      ) : null}

      {open ? (
        <div className="board__compose">
          <label className="field__label--inline" htmlFor={`compose-${round.id}`}>
            Your post-it
          </label>
          {/*
           * No `maxLength` attribute, deliberately. A box that refused the 281st keystroke would
           * make the over-length refusal unreachable, and the refusal is the thing that names the
           * limit and keeps the text on screen (Acceptance Scenario S06). The count below states
           * the limit; the server enforces it.
           */}
          <textarea
            id={`compose-${round.id}`}
            className="input"
            data-testid={`compose-${round.id}`}
            rows={2}
            placeholder="Add an idea…"
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
          />
          <p className="board__compose-foot">
            {limit === undefined ? null : (
              <span className="panel__hint" data-testid={`compose-limit-${round.id}`}>
                {[...draft.trim()].length} / {limit}
              </span>
            )}
            <button
              className="button button--primary"
              type="button"
              data-testid={`compose-submit-${round.id}`}
              onClick={onContribute}
              disabled={writeInFlight(`round:${round.id}`)}
            >
              {writeInFlight(`round:${round.id}`) ? 'Adding…' : 'Add post-it'}
            </button>
          </p>
        </div>
      ) : null}

      {/*
       * Creating the next Category: present at every width, in the same place, and offered only to
       * somebody the server says runs this Session.
       *
       * A Category can be created at **any** round state – open, closed or reopened – and whether or
       * not the board already holds post-its (`prd.md#fr1-categories-on-a-board`), which is why this
       * sits outside the `open` branch the compose box is in.
       *
       * No limit is written here. The name cap and the per-board cap each have exactly one
       * authoritative definition, on the API, and the refusal that names them is what this surface
       * shows – a number rendered here would be a second source that could disagree with the rule
       * being enforced.
       */}
      {canRun ? (
        <div className="new-category" data-testid={`new-category-${round.id}`}>
          <label className="field__label--inline" htmlFor={`new-category-name-${round.id}`}>
            New category name
          </label>
          <p className="new-category__row">
            <input
              id={`new-category-name-${round.id}`}
              className="input"
              data-testid={`new-category-name-${round.id}`}
              type="text"
              placeholder="Name it after what people wrote…"
              value={categoryDraft}
              onChange={(event) => onCategoryDraftChange(event.target.value)}
            />
            <button
              className="button button--primary"
              type="button"
              data-testid={`new-category-add-${round.id}`}
              onClick={onAddCategory}
              disabled={writeInFlight(`category-new:${round.id}`)}
            >
              {writeInFlight(`category-new:${round.id}`) ? 'Adding…' : 'Add category'}
            </button>
          </p>
          <p className="panel__hint" data-testid={`category-total-${round.id}`}>
            {categories.length === 1
              ? '1 category on this board.'
              : `${categories.length} categories on this board.`}
          </p>
        </div>
      ) : null}
    </div>
  );
}
