import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  castVote,
  closeRound,
  contributePostIt,
  createRound,
  deletePostIt,
  fetchActivityWatermark,
  fetchSessionActivities,
  openRound,
  updatePostIt,
  updateRound,
  type Round,
  type RoundDetailsInput,
  type SessionWithRounds,
} from '../api/client.ts';
import { useWatermarkPoll } from '../poll/use-watermark-poll.ts';
import { useSignedInName } from '../auth/AuthProvider.tsx';
import { mintSubmissionId, type QueuedPostIt } from '../offline/post-it-queue.ts';
import {
  mayStillBeDelivered,
  useDeliveredPostIts,
  usePostItQueue,
} from '../offline/use-post-it-queue.ts';
import { RoundForm } from './RoundForm.tsx';

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
  | { kind: 'ready'; payload: SessionWithRounds };

type Editor = { open: false } | { open: true; editing: Round | null };

/** The Post-it being corrected, and the text as it currently stands in its box. */
type PostItEditor = { postItId: string; roundId: string; text: string };

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
   * Keyed rather than boolean, so a slow write on one item never disables another: `round:<id>` for
   * a contribution, which is one compose box per Round, and `postit:<id>` for a correction or a
   * removal. Save and Remove deliberately **share** the post-it key - hitting Remove while a Save is
   * still out is the same double-write, and the second would race the first's re-read.
   *
   * Cleared after the re-read rather than after the request, so the window stays closed while the
   * board is still catching up. Like `voteInFlight` this is never a second opinion about what is
   * stored: it gates the affordance only, and the board still renders the server's answer.
   */
  const [boardWriteInFlight, setBoardWriteInFlight] = useState<string | null>(null);
  /**
   * The server's sentence for a refused contribution, correction or removal, with the Round it is
   * about.
   *
   * Rendered beside that Round's compose box but stored at panel level, for the same reason the
   * draft is: it must outlive the re-read its own handler triggers.
   */
  const [boardError, setBoardError] = useState<{ roundId: string; message: string } | null>(null);

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
    [conferenceId, sessionId],
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
    setChoices({});
    setVoteError(null);
    setState({ kind: 'loading' });

    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const payload = state.kind === 'ready' ? state.payload : null;
  const canRun = payload?.canRun === true;

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
        if (watermark.activityWatermark === watermarkRef.current) return;
        await load(signal, true);
      } catch {
        // Deliberately swallowed. See the note above.
      }
    },
    [conferenceId, sessionId, load, state.kind],
  );

  /*
   * Ticking while `failed` as well as while `ready` – the failed branch above is what makes that
   * worth doing. Still `loading` is deliberately excluded: the initial request is already in
   * flight, and a tick would only race it.
   */
  useWatermarkPoll(state.kind === 'ready' || state.kind === 'failed', syncOnTick);

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
   * The three of them – contribute, correct, remove – differ only in the request and in what to do
   * on success, and they share every rule that matters: the refusal is the server's own sentence,
   * it is stored at panel level so the re-read cannot take it off the screen, **the typed text is
   * left exactly where it was on a refusal**, and the board is re-read either way so a refused write
   * leaves the room looking at what is actually stored.
   */
  const writeToBoard = useCallback(
    async (
      key: string,
      roundId: string,
      write: () => Promise<unknown>,
      onWritten: () => void,
    ): Promise<void> => {
      if (boardWriteInFlight === key) return;
      setBoardWriteInFlight(key);
      setBoardError(null);
      try {
        await write();
        onWritten();
      } catch (error) {
        setBoardError({ roundId, message: asApiError(error).message });
      }
      try {
        await load(undefined, true);
      } finally {
        setBoardWriteInFlight(null);
      }
    },
    [load, boardWriteInFlight],
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
      if (boardWriteInFlight === key) return;
      const text = drafts[roundId] ?? '';
      const clearBox = (): void => setDrafts((current) => ({ ...current, [roundId]: '' }));
      const submissionId = mintSubmissionId();

      setBoardWriteInFlight(key);
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
        setBoardWriteInFlight(null);
      }
    },
    [conferenceId, sessionId, drafts, hold, load, boardWriteInFlight],
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
                    draft={drafts[round.id] ?? ''}
                    onDraftChange={(text) =>
                      setDrafts((current) => ({ ...current, [round.id]: text }))
                    }
                    onContribute={() => void contribute(round.id)}
                    editor={postItEditor?.roundId === round.id ? postItEditor : null}
                    onEditorChange={setPostItEditor}
                    onSaveCorrection={() => void saveCorrection()}
                    onRemove={(postItId) => void remove(round.id, postItId)}
                    writeInFlight={boardWriteInFlight}
                    error={boardError?.roundId === round.id ? boardError.message : null}
                    held={heldFor(round.id)}
                    viewerName={viewerName}
                    onDismiss={(submissionId) => void dismiss(submissionId)}
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
  draft: string;
  onDraftChange: (text: string) => void;
  onContribute: () => void;
  editor: PostItEditor | null;
  onEditorChange: (editor: PostItEditor | null) => void;
  onSaveCorrection: () => void;
  onRemove: (postItId: string) => void;
  /**
   * The board write currently out, as `round:<id>` or `postit:<id>`, or `null`.
   *
   * Read rather than derived, so the disabled control and the guard that refuses the second write
   * are the same fact. A control this does not name stays live: one slow write must not freeze the
   * rest of the board.
   */
  writeInFlight: string | null;
  error: string | null;
  /** This round's Post-its still waiting on this device, oldest first (S04). */
  held: QueuedPostIt[];
  viewerName: string | null;
  onDismiss: (submissionId: string) => void;
}

interface HeldPostItProps {
  item: QueuedPostIt;
  viewerName: string | null;
  onDismiss: () => void;
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
function HeldPostIt({ item, viewerName, onDismiss }: HeldPostItProps): React.JSX.Element {
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
 * One Post-it Round's board, and the box a Member adds to it from.
 *
 * Every Post-it is labelled with its author – that is what a Post-it Round is for, and it is never
 * a setting (`AGENTS.md`: post-its always carry the author's name). The correct and remove controls
 * appear only on the viewer's own Post-its and only while the Round is open, both read from the
 * payload: `mine` is the server's answer and `state` is the Round's, so nothing here decides who
 * may change what. A closed Round renders its prompt and its whole board and offers nothing to
 * press.
 *
 * Nothing in here holds state. The draft, the open correction and the refusal all live in the panel
 * above, outside the subtree a board refresh replaces.
 */
function Board({
  round,
  draft,
  onDraftChange,
  onContribute,
  editor,
  onEditorChange,
  onSaveCorrection,
  onRemove,
  writeInFlight,
  error,
  held,
  viewerName,
  onDismiss,
}: BoardProps): React.JSX.Element {
  const postIts = round.postIts ?? [];
  const open = round.state === 'open';
  /*
   * The limit as the **server** states it, on this payload. There is no fallback number: a literal
   * here would be a second definition of the cap that could disagree with the one being enforced,
   * and the hint is simply absent if the payload ever arrives without it.
   */
  const limit = round.textMaxLength;

  return (
    <div className="board" data-testid={`board-${round.id}`}>
      {postIts.length === 0 && held.length === 0 ? (
        <p className="panel__hint" data-testid={`board-empty-${round.id}`}>
          {open ? 'No post-its yet. Add the first one.' : 'This round collected no post-its.'}
        </p>
      ) : postIts.length === 0 ? null : (
        <ul className="board__list">
          {postIts.map((postIt) => (
            <li
              key={postIt.id}
              className="post-it"
              data-testid={`post-it-${postIt.id}`}
              data-mine={postIt.mine ? 'true' : 'false'}
            >
              {/*
               * The correction box is gated on the Round being open just as the controls that
               * open it are. A box left standing after the Round closed would offer a Save the API
               * can only refuse, and the board stops offering *both* affordances the moment it ends
               * (OC02). The panel keeps the editor across the board refresh that carried the close,
               * so this branch is the only thing that withdraws it.
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
                      disabled={writeInFlight === `postit:${postIt.id}`}
                    >
                      {writeInFlight === `postit:${postIt.id}` ? 'Saving…' : 'Save'}
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
                   * A post-it that reached the board after its round had closed says so, wherever
                   * it appears (S04, FR6) – the server's answer, on the same read model as the rest
                   * of the post-it, so no surface can show a board without it. A sentence and not a
                   * shade: the difference matters most on a projector and to a screen reader, and
                   * one is exactly where a colour says nothing.
                   */}
                  {postIt.arrivedAfterClose ? (
                    <p className="post-it__late" data-testid={`post-it-late-${postIt.id}`}>
                      Arrived after this round closed
                    </p>
                  ) : null}
                  {/*
                   * Offered on your own post-its, and only while the round is open. The API refuses
                   * both anyway – the guards are in the write statements' predicates – so this is
                   * what the room *sees*, never what decides.
                   */}
                  {postIt.mine && open ? (
                    <p className="post-it__actions">
                      <button
                        className="button button--small"
                        type="button"
                        data-testid={`post-it-correct-${postIt.id}`}
                        onClick={() =>
                          onEditorChange({
                            postItId: postIt.id,
                            roundId: round.id,
                            text: postIt.text,
                          })
                        }
                      >
                        Correct
                      </button>
                      <button
                        className="button button--small"
                        type="button"
                        data-testid={`post-it-remove-${postIt.id}`}
                        onClick={() => onRemove(postIt.id)}
                        disabled={writeInFlight === `postit:${postIt.id}`}
                      >
                        {writeInFlight === `postit:${postIt.id}` ? 'Removing…' : 'Remove'}
                      </button>
                    </p>
                  ) : null}
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {/*
       * Below the board and above the compose box: this person's own post-its, typed here and not
       * yet delivered. They are on the author's board under her name and marked pending, and they
       * come from the device's store rather than from anything this component remembered – so a
       * force-quit and relaunch shows the same list (Acceptance Scenario S01).
       *
       * Nobody else's board has them, because nobody else's device does. There is nothing to
       * reconcile and nothing to merge: an item is here, or it is on the board above.
       */}
      {held.length === 0 ? null : (
        <ul className="board__list board__list--held" data-testid={`board-held-${round.id}`}>
          {held.map((item) => (
            <HeldPostIt
              key={item.submissionId}
              item={item}
              viewerName={viewerName}
              onDismiss={() => onDismiss(item.submissionId)}
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
              disabled={writeInFlight === `round:${round.id}`}
            >
              {writeInFlight === `round:${round.id}` ? 'Adding…' : 'Add post-it'}
            </button>
          </p>
        </div>
      ) : null}
    </div>
  );
}
