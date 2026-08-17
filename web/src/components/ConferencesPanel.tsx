import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  createConference,
  fetchConferences,
  type Conference,
  type ConferenceDetailsInput,
} from '../api/client.ts';
import { ConferenceForm } from './ConferenceForm.tsx';
import { ConferenceDetail } from './ConferenceDetail.tsx';
import { LifecycleBadge, formatSpan } from './lifecycle-display.tsx';

/**
 * The organizer's conferences: the list, the create form, and the detail view.
 *
 * The list is the Organizer one – it includes drafts, because a draft is visible to whoever holds
 * a role in it. Which conferences those are is the server's decision, not a filter applied here.
 */

type Loading = { kind: 'loading' };
type Failed = { kind: 'failed'; code: string; message: string };
type Ready = { kind: 'ready'; conferences: Conference[] };
type State = Loading | Failed | Ready;

function messageOf(error: unknown): { code: string; message: string } {
  return error instanceof ApiError
    ? { code: error.code, message: error.message }
    : {
        code: 'NETWORK_UNREACHABLE',
        message: 'The app could not reach the server. Check your connection and try again.',
      };
}

export function ConferencesPanel(): React.JSX.Element {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<ApiError | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    fetchConferences(controller.signal)
      .then((conferences) => {
        if (active) setState({ kind: 'ready', conferences });
      })
      .catch((error: unknown) => {
        if (!active || controller.signal.aborted) return;
        setState({ kind: 'failed', ...messageOf(error) });
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  /** Replaces one conference in place, so a lifecycle change is reflected without a refetch. */
  const replace = useCallback((updated: Conference) => {
    setState((current) =>
      current.kind === 'ready'
        ? {
            ...current,
            conferences: current.conferences.map((conference) =>
              conference.id === updated.id ? updated : conference,
            ),
          }
        : current,
    );
  }, []);

  const submit = useCallback(async (details: ConferenceDetailsInput): Promise<void> => {
    setCreating(true);
    setCreateError(null);
    try {
      const created = await createConference(details);
      setState((current) =>
        current.kind === 'ready'
          ? { ...current, conferences: [created, ...current.conferences] }
          : current,
      );
    } catch (error) {
      // Held as the ApiError so the form can attach each field message to its own control.
      setCreateError(
        error instanceof ApiError
          ? error
          : new ApiError('NETWORK_UNREACHABLE', messageOf(error).message),
      );
    } finally {
      setCreating(false);
    }
  }, []);

  const selected =
    state.kind === 'ready'
      ? (state.conferences.find((conference) => conference.id === selectedId) ?? null)
      : null;

  if (selected !== null) {
    return (
      <ConferenceDetail
        conference={selected}
        onChanged={replace}
        onBack={() => setSelectedId(null)}
      />
    );
  }

  return (
    <>
      <section className="panel" aria-labelledby="conferences-title" data-testid="conference-list">
        <div className="panel__header">
          <h2 className="panel__title" id="conferences-title">
            Your conferences
          </h2>
        </div>

        {state.kind === 'loading' ? <p className="panel__hint">Loading your conferences…</p> : null}

        {state.kind === 'failed' ? (
          <div className="alert" role="alert">
            {state.message}
            <code className="alert__code">{state.code}</code>
          </div>
        ) : null}

        {state.kind === 'ready' && state.conferences.length === 0 ? (
          <p className="panel__hint" data-testid="no-conferences">
            You are not organizing any conferences yet. Create one below.
          </p>
        ) : null}

        {state.kind === 'ready' && state.conferences.length > 0 ? (
          <ul className="conference-list">
            {state.conferences.map((conference) => (
              <li
                key={conference.id}
                /*
                 * Archived conferences are distinguished by a modifier class carrying a muted,
                 * dashed treatment, not by their label alone (FR9).
                 */
                className={`conference-card${
                  conference.lifecycleState === 'archived' ? ' conference--archived' : ''
                }`}
                data-testid={`conference-${conference.id}`}
                data-lifecycle-state={conference.lifecycleState}
              >
                <button
                  className="conference-card__open"
                  type="button"
                  onClick={() => setSelectedId(conference.id)}
                >
                  <span className="conference-card__name">{conference.name}</span>
                  <span className="conference-card__span">{formatSpan(conference)}</span>
                </button>
                <LifecycleBadge state={conference.lifecycleState} />
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="panel" aria-labelledby="create-conference-title">
        <div className="panel__header">
          <h2 className="panel__title" id="create-conference-title">
            Create a conference
          </h2>
        </div>
        <p className="panel__hint">
          A conference runs for between one and four consecutive days. It starts as a draft and can
          be published once its schedule has at least one session.
        </p>
        <ConferenceForm onSubmit={submit} busy={creating} error={createError} />
      </section>
    </>
  );
}
