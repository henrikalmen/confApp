import { useCallback, useEffect, useState } from 'react';
import { ApiError, fetchHealth, type Health } from '../api/client.ts';

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; health: Health }
  | { kind: 'failed'; code: string; message: string };

/**
 * Renders the end of the tracer path: a value that started life as a row in PostgreSQL and
 * reached the browser through the API. The failure branch shows the envelope's own
 * `message`, which is why that message has to be a displayable sentence.
 */
export function HealthPanel(): React.JSX.Element {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [reloadToken, setReloadToken] = useState(0);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    setState({ kind: 'loading' });

    fetchHealth(controller.signal)
      .then((health) => {
        if (active) setState({ kind: 'ready', health });
      })
      .catch((error: unknown) => {
        if (!active || controller.signal.aborted) return;
        if (error instanceof ApiError) {
          setState({ kind: 'failed', code: error.code, message: error.message });
        } else {
          setState({
            kind: 'failed',
            code: 'NETWORK_UNREACHABLE',
            message: 'The app could not reach the server. Check your connection and try again.',
          });
        }
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [reloadToken]);

  return (
    <section className="panel" aria-labelledby="health-title">
      <div className="panel__header">
        <h2 className="panel__title" id="health-title">
          Service health
        </h2>
        <span className="status">
          <span className="status__dot" aria-hidden="true" />
          {state.kind === 'loading' ? 'Checking' : state.kind === 'ready' ? 'Reachable' : 'Refused'}
        </span>
      </div>

      <p className="panel__hint">
        Read live from PostgreSQL through the API – proof the whole path is joined up.
      </p>

      {state.kind === 'failed' ? (
        <div className="alert" role="alert">
          {state.message}
          <code className="alert__code">{state.code}</code>
        </div>
      ) : (
        <dl className="facts">
          <div className="fact">
            <dt className="fact__label">Schema version</dt>
            <dd className="fact__value" data-testid="schema-version">
              {state.kind === 'ready' ? (state.health.schemaVersion ?? 'unknown') : '–'}
            </dd>
          </div>
          <div className="fact">
            <dt className="fact__label">Server time</dt>
            <dd className="fact__value" data-testid="server-time">
              {state.kind === 'ready' ? state.health.serverTime : '–'}
            </dd>
          </div>
        </dl>
      )}

      <p className="panel__actions">
        <button
          className="button"
          type="button"
          onClick={reload}
          disabled={state.kind === 'loading'}
        >
          {state.kind === 'loading' ? 'Checking…' : 'Check again'}
        </button>
      </p>
    </section>
  );
}
