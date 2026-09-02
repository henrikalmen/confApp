import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  displayLinkUrl,
  fetchDisplayLink,
  issueDisplayLink,
  revokeDisplayLink,
  type DisplayLink,
} from '../api/client.ts';

/**
 * Issue, show, and take back the Display Link for one Post-it Round (S04 TI13, FR7, US01, US07).
 *
 * **Two controls and a value, on the Round surface the Facilitator is already looking at.** No
 * wireframe gates this story - the plan's wireframe list deliberately excludes S04 - so this is not
 * a new screen. The projected view's own design is S07's.
 *
 * **Rendered only where sorting authority is already established** for this Session (`canRun`). That
 * is a courtesy, not the boundary: the API refuses issue, revoke and read on its own authority, and
 * a Member calling it directly is refused whatever this component chooses to draw.
 *
 * **The refusal lives outside every subtree its own handler replaces**
 * (`docs/LEARNINGS.md#react-state--refusals`). Both messages are held in this component's own state
 * and rendered above the controls, so a failed issue leaves its sentence on screen rather than
 * unmounting with the thing that produced it.
 *
 * A Board is fully usable with no link ever issued: `null` here draws a single Issue button and
 * nothing else, and no other Board surface asks for a link.
 */

export interface DisplayLinkControlProps {
  conferenceId: string;
  sessionId: string;
  roundId: string;
}

export function DisplayLinkControl({
  conferenceId,
  sessionId,
  roundId,
}: DisplayLinkControlProps): React.JSX.Element {
  const [link, setLink] = useState<DisplayLink | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  /**
   * The live link, read once when the Round surface opens.
   *
   * Not polled. A Display Link changes only when this Facilitator changes it, and the Session's
   * activity cursor deliberately does not move when one is issued or revoked - the room must not be
   * able to notice that a Board is being projected, and every phone in the Session must not refetch
   * because somebody pressed Issue.
   */
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        setLink(await fetchDisplayLink(conferenceId, sessionId, roundId, controller.signal));
      } catch (failure) {
        if (controller.signal.aborted) return;
        // The read failing is not a reason to hide the controls: issuing still works, and the
        // sentence says which half is unavailable.
        setError(messageFor(failure));
      }
    })();
    return () => controller.abort();
  }, [conferenceId, sessionId, roundId]);

  const issue = useCallback(async () => {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      /*
       * Issuing again **replaces** what is shown. The request names no link - a Round holds at most
       * one live one, so there is nothing to disambiguate - and the value that comes back is
       * different every time, with the previous one dead from the room machine's next poll.
       */
      setLink(await issueDisplayLink(conferenceId, sessionId, roundId));
    } catch (failure) {
      setError(messageFor(failure));
    } finally {
      setBusy(false);
    }
  }, [conferenceId, sessionId, roundId]);

  const revoke = useCallback(async () => {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      await revokeDisplayLink(conferenceId, sessionId, roundId);
      setLink(null);
    } catch (failure) {
      setError(messageFor(failure));
    } finally {
      setBusy(false);
    }
  }, [conferenceId, sessionId, roundId]);

  const url = link === null ? null : displayLinkUrl(link.token);
  /*
   * A link exists but this build cannot say where a room machine would open it - the Capacitor
   * shells, whose WebView origin is not an address any other machine can reach. Showing the token
   * alone is the honest answer: it is still the thing that was issued, and revoking still works.
   */
  const unaddressable = link !== null && url === null;

  return (
    <section className="display-link" data-testid={`display-link-${roundId}`}>
      <h5 className="display-link__head">Projected board</h5>

      {/*
       * Held above the controls, so a refused issue leaves this sentence standing while the button
       * beneath it re-renders. `alert`, because the Facilitator's next move depends on reading it.
       */}
      {error !== null ? (
        <p className="alert" role="alert" data-testid={`display-link-error-${roundId}`}>
          {error}
        </p>
      ) : null}

      {link === null ? (
        <>
          <p className="display-link__hint" data-testid={`display-link-none-${roundId}`}>
            No link is live. The board is fully usable without one.
          </p>
          <p className="controls">
            <button
              className="button button--primary"
              type="button"
              data-testid={`display-link-issue-${roundId}`}
              disabled={busy}
              onClick={() => void issue()}
            >
              {busy ? 'Issuing…' : 'Create a link for the room screen'}
            </button>
          </p>
        </>
      ) : (
        <>
          {/*
           * The value, **presented for copying or opening** (FR7 -> Outputs). Read-only rather than
           * disabled so it stays selectable and reachable by keyboard, and `onFocus` selects the
           * whole of it because a 43-character token is not something anybody drags across
           * accurately on a phone.
           */}
          <label className="display-link__value" htmlFor={`display-link-url-${roundId}`}>
            <span className="display-link__label">
              {unaddressable ? 'Link code' : 'Open this on the room screen'}
            </span>
            <input
              id={`display-link-url-${roundId}`}
              className="input"
              type="text"
              readOnly
              value={url ?? link.token}
              data-testid={`display-link-url-${roundId}`}
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
          <p className="display-link__hint" data-testid={`display-link-issued-${roundId}`}>
            {unaddressable
              ? 'Live. This app cannot say what web address to open it at, so open confApp in a ' +
                'browser and copy the link from there.'
              : 'Live. Anyone with this link can read this board, with names, without signing in.'}
          </p>
          <p className="controls">
            <button
              className="button"
              type="button"
              data-testid={`display-link-copy-${roundId}`}
              onClick={() => void copy(url ?? link.token, setCopied, setError)}
            >
              {copied ? 'Copied' : 'Copy link'}
            </button>
            <button
              className="button"
              type="button"
              data-testid={`display-link-revoke-${roundId}`}
              disabled={busy}
              onClick={() => void revoke()}
            >
              {busy ? 'Revoking…' : 'Revoke'}
            </button>
            {/*
             * Issue again, from the state where one is already live. Same request, and the label
             * says what it does: the current link stops working.
             */}
            <button
              className="button"
              type="button"
              data-testid={`display-link-reissue-${roundId}`}
              disabled={busy}
              onClick={() => void issue()}
            >
              {busy ? 'Issuing…' : 'Replace with a new link'}
            </button>
          </p>
        </>
      )}
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
  return 'That could not be done just now. Try again in a moment.';
}

/**
 * Copies the URL, and says so where the clipboard is unavailable rather than silently doing nothing.
 *
 * The clipboard API is absent over plain HTTP and refused without a user gesture in some browsers,
 * which is a realistic state on a venue network - and the value is still selectable in the field
 * above, so the fallback is to say that.
 */
async function copy(
  url: string,
  setCopied: (copied: boolean) => void,
  setError: (message: string | null) => void,
): Promise<void> {
  try {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setError(null);
  } catch {
    setCopied(false);
    setError('This browser would not let the link be copied. Select it above and copy it by hand.');
  }
}
