import { useCallback, useEffect, useState } from 'react';
import { ApiError, fetchDiscardedPostIts, type DiscardedPostIt } from '../api/client.ts';
import {
  PermanentRemovalConfirmation,
  PermanentRemovalControl,
  type PermanentRemoval,
} from './PermanentRemoval.tsx';

/**
 * The Facilitator's discarded Post-its for one Board, and the only place a Discard is reversed
 * (S05 TI09, FR4, US05).
 *
 * **Its shape is settled, not invented here.**
 * `docs/wireframes/facilitator-board-and-categorisation/design-decisions.md` → *"The discarded
 * Post-its surface"* and the wireframe it names (`discarded-postits.html`) fix all of it: a
 * permanent entry point on the Board's toolbar reading `Discarded post-its (3)` whether or not
 * anything has just been discarded, the three sentences that state what a restore does, and one
 * restore control per Post-it that **names its destination in the control itself**.
 *
 * **It is a place, not an undo.** The reversal window runs to archival - days, not seconds - so a
 * toast or a timed affordance would quietly convert a reversible act into an irreversible one, and a
 * Facilitator who wants something back an hour later would have nowhere to start from. The entry
 * point is therefore permanent and the surface can be left and returned to. The wireframe draws it
 * as a page with its own address; the SPA has no client-side router, so it is reached here by a
 * control that is always present on the Board rather than by a URL - the permanence and the
 * return-to-it-later property are what the decision is about, and both hold.
 *
 * **Every entry carries its trace** - who discarded it and when, beside the Post-it's own author.
 * That trace is the whole difference between a Discard and an author deleting their own Post-it,
 * which leaves nothing at all.
 *
 * **A Facilitator must never find the irreversible act sitting beside the reversible one - and does
 * not.** Permanent Removal is offered here, because OC01 names *already Discarded* as one of the
 * three places a Post-it can be sitting when it has to go, and this is the only surface a discarded
 * Post-it appears on at all. Without it the sole route to removing one is to **restore** it first,
 * which republishes the text to every Attendee's Board and the projected screen on the next tick -
 * putting the abusive or confidential content back in front of the room in order to get rid of it.
 *
 * What keeps the two apart is not their absence but the flag: the control renders only where
 * `canRemovePermanently` is true, which is the server's answer to a conference-wide Admin question
 * and nothing this file decides. A Facilitator sorting this Board sees the restore control and no
 * other. Where both do appear, they are the same two visibly distinct controls the Board draws, in
 * the same words, from the same components (`PermanentRemoval.tsx`) - and the restore control is
 * the primary one.
 *
 * **The refusal lives outside every subtree its own handler replaces**
 * (`docs/LEARNINGS.md#react-state--refusals`): it is held here and rendered above the list, so a
 * restore refused on an archived Conference leaves its sentence on screen while the list beneath it
 * re-renders with the item still in place.
 *
 * Rendered only where the payload says this viewer sorts this Board. That is what is *offered*; the
 * API refuses discard, restore and this very read without sorting authority regardless.
 *
 * **One consequence of that placement is worth stating.** Because this whole surface sits inside
 * the panel's `canRun` block, the permanent-removal control it carries is gated on sorting
 * authority *as well as* on `canRemovePermanently`. Nobody's access changes today - `canRun` is
 * true for an assigned Facilitator or a conference-wide Admin, so every Admin passes it - but the
 * control here is not gated on the capability flag alone the way the Board's is. That was settled
 * deliberately (owner, 2026-08-31): the discarded-Post-its surface is a Facilitator surface and
 * belongs behind `canRun`, and S06's Structural Criterion 5 was reworded to say so rather than the
 * gating being restructured to match a criterion written before this control existed.
 */

export interface DiscardedPostItsProps {
  conferenceId: string;
  sessionId: string;
  roundId: string;
  /**
   * The Board's activity cursor, as the payload on screen carries it.
   *
   * The list is re-read when this moves and at no other time - so a Discard taken on this device, a
   * restore taken on another, and an author's delete that took a trace with it all reach this
   * surface on the **one** shared poll tick, with no cadence, timer or cursor of its own
   * (`plan.json#sharedDecisions` → "Near-live propagation: one cursor").
   */
  revision: string | null;
  /**
   * Restore, through the panel's one board-write path - so it inherits the server's own sentence on
   * a refusal, the Board re-read on both branches, and the rule that nothing here is ever queued.
   */
  onRestore: (postItId: string) => Promise<void>;
  /**
   * Whether **Permanent Removal** is offered on this surface - the server's answer, off the Session
   * payload, passed down by the panel and never re-derived here (S06 TI04).
   *
   * The same flag the Board's control is drawn from, deliberately: one act, one question, one
   * answer. A Facilitator without conference-wide Admin gets `false` and sees restore alone.
   */
  canRemovePermanently: boolean;
  /** The removal on this Board whose confirmation is open, or `null`. Held by the panel. */
  permanentRemoval: PermanentRemoval | null;
  /** Open the confirmation, or dismiss it. Dismissing sends nothing at all. */
  onPermanentRemovalChange: (removal: PermanentRemoval | null) => void;
  /**
   * Confirmed: the irreversible write, through the panel's one board-write path exactly as restore
   * is - so it inherits the panel-level refusal in the server's own words, the Board re-read on both
   * branches, and the rule that nothing here is ever deferred.
   */
  onRemovePermanently: (postItId: string) => Promise<void>;
  writeInFlight: (key: string) => boolean;
}

export function DiscardedPostIts({
  conferenceId,
  sessionId,
  roundId,
  revision,
  onRestore,
  canRemovePermanently,
  permanentRemoval,
  onPermanentRemovalChange,
  onRemovePermanently,
  writeInFlight,
}: DiscardedPostItsProps): React.JSX.Element {
  const [discarded, setDiscarded] = useState<DiscardedPostIt[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reread = useCallback(
    async (signal: AbortSignal): Promise<void> => {
      try {
        setDiscarded(await fetchDiscardedPostIts(conferenceId, sessionId, roundId, signal));
        setError(null);
      } catch (failure) {
        if (signal.aborted) return;
        /*
         * The read failing is not a reason to take the entry point away: the count it carries is
         * simply the last one that was read, and the sentence says which half is unavailable. That
         * is what keeps a **refused restore** honest - the list already on screen stays exactly as
         * it was, so the Post-it is still listed and the Discard visibly still stands, which is
         * what FR4 asks for on an archived Conference.
         *
         * This route goes through the same `authorizeWrite` gate as the two writes (Structural
         * Criterion 4), so on an archived Conference it answers `CONFERENCE_NOT_EDITABLE` rather
         * than a connectivity failure - and a Facilitator opening the surface fresh after archival
         * reads that sentence instead of the list. Whether the list should stay readable after
         * archival is a decision the Report slice (REQ-023 / REQ-024) reopens; see this story's
         * Implementation Observations.
         */
        setError(messageFor(failure));
      }
    },
    [conferenceId, sessionId, roundId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void reread(controller.signal);
    return () => controller.abort();
  }, [reread, revision]);

  const restore = useCallback(
    async (postItId: string): Promise<void> => {
      /*
       * The panel owns the write and the Board re-read it triggers; the list here follows on the
       * cursor that write advanced. A refusal is stated by the panel in the server's own words and
       * the item stays listed, which is the honest outcome on an archived Conference - the Discard
       * still stands.
       */
      await onRestore(postItId);
      const controller = new AbortController();
      await reread(controller.signal);
    },
    [onRestore, reread],
  );

  const removePermanently = useCallback(
    async (postItId: string): Promise<void> => {
      /*
       * The same two steps a restore takes, and for the same reason: the panel owns the write and
       * the Board re-read it triggers, and this list follows by re-reading itself. It has to be
       * asked explicitly rather than left to the cursor - a removal that took the last discarded
       * Post-it must take it out of this list now, not on the next tick, and a refusal must leave it
       * listed exactly where it was.
       *
       * **The refusal sentence is not above this list.** The panel holds it and renders it in
       * `board-error-<roundId>`, below the Board's regions and so below this surface too - which on
       * a full Board can be a long way from the control that was pressed. This surface's *own* read
       * error renders above the list; a refused write's does not. Stated rather than implied,
       * because the difference is invisible from here and a reader would otherwise assume the two
       * behave alike.
       */
      await onRemovePermanently(postItId);
      const controller = new AbortController();
      await reread(controller.signal);
    },
    [onRemovePermanently, reread],
  );

  return (
    <section className="discarded" data-testid={`discarded-${roundId}`}>
      {/*
       * The permanent entry point. It is here whether or not anything has just been discarded and
       * whether or not anything is discarded at all - it is not the aftermath of a Discard.
       */}
      <p className="controls">
        <button
          className="button"
          type="button"
          data-testid={`discarded-toggle-${roundId}`}
          aria-expanded={open}
          aria-controls={`discarded-panel-${roundId}`}
          onClick={() =>
            setOpen((showing) => {
              /*
               * Collapsing disarms whatever this surface had armed. `open` lives here while
               * `permanentRemoval` lives in the panel, so without this the two clicks that hide and
               * re-show the list bring an armed *irreversible* confirmation back unprompted, with no
               * network in between - a dialog nobody asked for the second time, over a destructive
               * act. Only cleared when the armed item is one of ours: the Board may have armed its
               * own, and hiding this list says nothing about that one.
               */
              if (showing && permanentRemoval !== null) {
                const mine = discarded.some((entry) => entry.id === permanentRemoval.postItId);
                if (mine) onPermanentRemovalChange(null);
              }
              return !showing;
            })
          }
        >
          {open ? 'Hide discarded post-its' : `Discarded post-its (${discarded.length})`}
        </button>
      </p>

      {error !== null ? (
        <p className="alert" role="alert" data-testid={`discarded-error-${roundId}`}>
          {error}
        </p>
      ) : null}

      {open ? (
        <div id={`discarded-panel-${roundId}`} data-testid={`discarded-panel-${roundId}`}>
          {/*
           * The three facts that shape this surface, stated on it rather than left to be discovered:
           * where a restore goes, how long the window is, and that a discarded Post-it is on no
           * other surface at all - including its own author's.
           */}
          <ul className="discarded__rules" data-testid={`discarded-rules-${roundId}`}>
            <li>
              A restored post-it returns to <strong>Uncategorised</strong> – never to the category
              it was in. The discard is undone; the sorting decision is not assumed.
            </li>
            <li>
              You can restore one <strong>at any time until this conference is archived</strong>.
              Nothing here expires and there is no countdown.
            </li>
            <li>
              While they are here they are on no other surface – not on the board, not on the
              projected screen, not on anyone’s phone, and not on their own author’s, with no marker
              and no notification anywhere.
            </li>
          </ul>

          {discarded.length === 0 ? (
            <p className="panel__hint" data-testid={`discarded-empty-${roundId}`}>
              Nothing has been discarded from this board.
            </p>
          ) : (
            <ul className="discarded__list">
              {discarded.map((postIt) => {
                const busy = writeInFlight(`postit:${postIt.id}`);
                const armed = permanentRemoval?.postItId === postIt.id;
                return (
                  <li
                    className="discarded__item"
                    key={postIt.id}
                    data-testid={`discarded-item-${postIt.id}`}
                  >
                    <p className="discarded__text">{postIt.text}</p>
                    {/* Its own author, always. Post-its carry the author's name (`AGENTS.md`). */}
                    <p className="discarded__by" data-testid={`discarded-by-${postIt.id}`}>
                      {postIt.authorName}
                    </p>
                    {/*
                     * The trace. `discardedAt` is the server's formatted string, rendered as it
                     * arrived - nothing here parses it or converts a timezone the product does not
                     * carry.
                     */}
                    <p className="discarded__trace" data-testid={`discarded-trace-${postIt.id}`}>
                      Discarded by {postIt.discardedByName} · {postIt.discardedAt}
                    </p>
                    <p className="controls">
                      {/*
                       * The destination is in the control's own words, so the rule is read before it
                       * is exercised rather than discovered afterwards.
                       */}
                      <button
                        className="button button--primary"
                        type="button"
                        data-testid={`discarded-restore-${postIt.id}`}
                        /*
                         * Not restorable while this item's own removal confirmation is armed. Two
                         * reasons, and the second is the one that bites: an Admin who has armed an
                         * irreversible act should answer it before taking a different one, and
                         * `restore` awaits the panel's Board re-read before its own, so for one
                         * round trip the Post-it is on the Board *and* still in this local list -
                         * two live nodes carrying `permanent-removal-${postIt.id}`, which is how a
                         * `getByTestId` starts throwing somewhere unrelated.
                         */
                        disabled={busy || armed}
                        onClick={() => void restore(postIt.id)}
                      >
                        {busy ? 'Restoring…' : 'Restore to Uncategorised'}
                      </button>
                      {/*
                       * The third place OC01 names. Same component, same words and same testids as
                       * the Board's, so an Admin who has read the confirmation once has read it
                       * everywhere - and beside the restore control rather than instead of it, so
                       * the reversible act is the one offered first and this one is visibly the
                       * other kind.
                       */}
                      {canRemovePermanently ? (
                        <PermanentRemovalControl
                          subject={{
                            postItId: postIt.id,
                            roundId,
                            authorName: postIt.authorName,
                            text: postIt.text,
                          }}
                          busy={busy}
                          onOpen={onPermanentRemovalChange}
                        />
                      ) : null}
                    </p>
                    {canRemovePermanently && permanentRemoval?.postItId === postIt.id ? (
                      <PermanentRemovalConfirmation
                        removal={permanentRemoval}
                        busy={busy}
                        onConfirm={() => void removePermanently(postIt.id)}
                        onCancel={() => onPermanentRemovalChange(null)}
                      />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}

/**
 * The server's sentence where there is one, and an honest one where the request never landed.
 *
 * Never a second wording invented here: every refusal on this path arrives in the shared envelope
 * and the message it carries is the one written for a person to read.
 */
function messageFor(failure: unknown): string {
  if (failure instanceof ApiError) return failure.message;
  return 'The discarded post-its could not be read just now. Try again in a moment.';
}
