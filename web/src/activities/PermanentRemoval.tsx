/**
 * **Permanent Removal** on the client: the control an Admin presses, and the confirmation that
 * stands between it and an irreversible act (S06 TI05, FR5, US06).
 *
 * **One module because there is one act, offered in three places.** OC01 names all three: a Post-it
 * sitting in Uncategorised, sitting in a Category, or **already Discarded**. The first two are
 * regions of the Board; the third is the discarded Post-its surface, which S05 moved off the Board
 * entirely. A second copy of this markup on the second surface is exactly how the wording, the
 * testids and the irreversibility sentence come to disagree - and the sentence is the safeguard, so
 * both surfaces render these components and neither writes its own.
 *
 * **The confirmation renders the record of what was clicked, not the Post-it beside it.** Its props
 * are one `PermanentRemoval` - the pinned author name and text the panel captured at the moment the
 * control was pressed - so a Board re-read arriving mid-decision cannot swap what the question is
 * about underneath somebody. The *control* names the live Post-it, which is right: it describes
 * what is on screen now. The confirmation names what is being decided.
 *
 * **Neither component decides anything.** Whether the control is offered at all is the server's
 * answer, read off the payload by the panel and passed down; the API enforces the same decision
 * again on the write. Nothing here holds state, and nothing here is queued - Permanent Removal is
 * online-only (Binding Constraint FR3).
 */

/**
 * The Post-it whose **Permanent Removal** is waiting on its confirmation (S06 FR5).
 *
 * Held by the panel rather than by the surface that opened it, for the reason every other refusal
 * and open form on this surface is (`docs/LEARNINGS.md#react-state--refusals`): confirming triggers
 * a Board re-read, and a dialog living inside the subtree that re-read replaces would take its own
 * refusal off the screen with it.
 *
 * It carries the author's name and the text because the confirmation is rendered **from them** and
 * from nothing else: the Post-it it describes may be edited, discarded or gone by the next Board
 * read, and the confirmation must not go blank or, worse, name somebody else's Post-it, in the
 * moment it matters most.
 */
export type PermanentRemoval = {
  postItId: string;
  roundId: string;
  authorName: string;
  text: string;
};

/**
 * A Post-it's text, short enough to name it inside a control's label.
 *
 * Counted in **code points**, not `.length`: a text of emoji measures double in UTF-16 and would be
 * cut in half - through a surrogate pair - by a naive slice.
 *
 * The whole text is on screen immediately above the control, so the label's job is to say *which*
 * Post-it this control acts on rather than to repeat it. That is what makes the control usable by
 * somebody hearing the page rather than seeing it, where the spatial answer - "the one above" -
 * does not exist.
 */
export function shortened(text: string): string {
  const trimmed = text.trim();
  const points = [...trimmed];
  return points.length <= 32 ? trimmed : `${points.slice(0, 32).join('').trimEnd()}…`;
}

export interface PermanentRemovalControlProps {
  /** The Post-it as the surface drawing it has it now - which is what the control's label names. */
  subject: PermanentRemoval;
  /** A write already out on this Post-it, from this or any other of its controls. */
  busy: boolean;
  /** Opening the confirmation. Sends nothing at all (FR5 -> Error Handling). */
  onOpen: (removal: PermanentRemoval) => void;
}

/**
 * The Admin's control, wherever the Post-it is sitting.
 *
 * **Not gated on the Round being open**, unlike the sorting controls and unlike the author's own
 * Remove: moderation cannot wait for a Round to be open, and the Post-its most likely to need this
 * are on Rounds that have already closed.
 *
 * It names the Post-it and its author, because a board full of buttons all reading "Remove
 * permanently" says nothing to somebody hearing the page. An ordinary button, reachable by keyboard
 * and announced like any other.
 */
export function PermanentRemovalControl({
  subject,
  busy,
  onOpen,
}: PermanentRemovalControlProps): React.JSX.Element {
  return (
    <button
      className="button button--danger"
      type="button"
      data-testid={`post-it-permanent-removal-${subject.postItId}`}
      aria-label={`Permanently remove “${shortened(subject.text)}” by ${subject.authorName}`}
      onClick={() => onOpen(subject)}
      disabled={busy}
    >
      Remove permanently
    </button>
  );
}

export interface PermanentRemovalConfirmationProps {
  /**
   * What was clicked, as it stood when it was clicked. Every word below is rendered from this and
   * from nothing on the surface around it.
   */
  removal: PermanentRemoval;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The confirmation (FR5): it **names the author** and states that the act cannot be undone, and
 * dismissing it sends nothing at all.
 *
 * In place, in the region the Post-it is in, exactly as the occupied-Category removal question is -
 * not a modal. At 375px a modal is the pattern that hides the thing being decided about, and what
 * makes this decision safe is reading the Post-it while making it.
 */
export function PermanentRemovalConfirmation({
  removal,
  busy,
  onConfirm,
  onCancel,
}: PermanentRemovalConfirmationProps): React.JSX.Element {
  const label = shortened(removal.text);
  return (
    <div className="inline-form" data-testid={`permanent-removal-${removal.postItId}`}>
      <p>
        <strong>
          Permanently remove {removal.authorName}&rsquo;s post-it &ldquo;{label}&rdquo;?
        </strong>
      </p>
      <p className="panel__hint" data-testid={`permanent-removal-warning-${removal.postItId}`}>
        {removal.authorName} wrote it. It leaves every board, the projected view and the discarded
        list, and <strong>this cannot be undone</strong> &ndash; nobody can put it back, not even
        you. Discard it instead if you may want it later.
      </p>
      <p className="controls">
        <button
          className="button button--danger"
          type="button"
          data-testid={`permanent-removal-confirm-${removal.postItId}`}
          onClick={onConfirm}
          disabled={busy}
        >
          {busy ? 'Removing…' : 'Yes, remove permanently'}
        </button>
        <button
          className="button"
          type="button"
          data-testid={`permanent-removal-cancel-${removal.postItId}`}
          onClick={onCancel}
        >
          Cancel
        </button>
      </p>
    </div>
  );
}
