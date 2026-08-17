import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  fetchJoinCode,
  regenerateJoinCode,
  type ConferenceJoinCode,
} from '../api/client.ts';

/**
 * The Organizer's join-code panel: the code as it stands, and the way to replace it.
 *
 * The code is fetched from its own endpoint rather than read off the conference payload. That is
 * deliberate on the server's side – only this one surface discloses it – and it means this panel
 * shows what the *server* holds, so a regeneration is reflected because the server said so and not
 * because the client assumed.
 *
 * The consequence of regenerating is stated before it is taken, not after: a code is already on a
 * slide by the time anyone wants to change it, and "the previous code stops working immediately" is
 * the part an Organizer needs in advance. No attendee is removed, which is worth saying too, because
 * it is the thing they will worry about.
 */

export interface JoinCodePanelProps {
  conferenceId: string;
  /** Nothing to show or replace before the conference is published – a code exists from then on. */
  published: boolean;
}

type Loading = { kind: 'loading' };
type Failed = { kind: 'failed'; message: string };
type Ready = { kind: 'ready'; code: ConferenceJoinCode };
type State = Loading | Failed | Ready;

function messageOf(error: unknown): string {
  return error instanceof ApiError
    ? error.message
    : 'The app could not reach the server. Check your connection and try again.';
}

export function JoinCodePanel({ conferenceId, published }: JoinCodePanelProps): React.JSX.Element {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [regenerating, setRegenerating] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [replaced, setReplaced] = useState(false);

  useEffect(() => {
    if (!published) return;

    const controller = new AbortController();
    let active = true;

    fetchJoinCode(conferenceId, controller.signal)
      .then((code) => {
        if (active) setState({ kind: 'ready', code });
      })
      .catch((error: unknown) => {
        if (!active || controller.signal.aborted) return;
        setState({ kind: 'failed', message: messageOf(error) });
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [conferenceId, published]);

  const regenerate = useCallback(async (): Promise<void> => {
    setRegenerating(true);
    setRefusal(null);
    setReplaced(false);
    try {
      setState({ kind: 'ready', code: await regenerateJoinCode(conferenceId) });
      setReplaced(true);
    } catch (error) {
      // The server's sentence, not ours.
      setRefusal(messageOf(error));
    } finally {
      setRegenerating(false);
    }
  }, [conferenceId]);

  return (
    <section className="panel" aria-labelledby="join-code-title" data-testid="join-code-panel">
      <div className="panel__header">
        <h2 className="panel__title" id="join-code-title">
          Join code
        </h2>
      </div>

      {!published ? (
        <p className="panel__hint" data-testid="join-code-unpublished">
          This conference has no join code yet. Publishing it creates one, and attendees can join from
          that moment.
        </p>
      ) : null}

      {published && state.kind === 'loading' ? (
        <p className="panel__hint">Loading the join code…</p>
      ) : null}

      {published && state.kind === 'failed' ? (
        <div className="alert" role="alert" data-testid="join-code-error">
          {state.message}
        </div>
      ) : null}

      {published && state.kind === 'ready' ? (
        <>
          <dl className="facts">
            <div className="fact">
              <dt className="fact__label">Code to share</dt>
              {/*
               * Monospaced with generous tracking: this value is read aloud from a slide and typed
               * on a phone, so the characters have to be separable at a glance.
               */}
              <dd className="fact__value join-code" data-testid="join-code-value">
                {state.code.joinCode}
              </dd>
            </div>
          </dl>

          {replaced ? (
            <div className="notice" role="status" data-testid="join-code-replaced">
              This is the new code. The previous one no longer works – share this one instead. Nobody
              who had already joined was removed.
            </div>
          ) : null}

          {refusal !== null ? (
            <div className="alert" role="alert" data-testid="join-code-refusal">
              {refusal}
            </div>
          ) : null}

          <p className="panel__hint">
            Regenerating replaces the code straight away. The old one stops working from that moment,
            and everyone who has already joined stays joined.
          </p>

          <p className="panel__actions">
            <button
              className="button"
              type="button"
              disabled={regenerating}
              onClick={() => void regenerate()}
              data-testid="regenerate-join-code"
            >
              {regenerating ? 'Regenerating…' : 'Regenerate code'}
            </button>
          </p>
        </>
      ) : null}
    </section>
  );
}
