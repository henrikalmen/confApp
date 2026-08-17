import { useState } from 'react';
import { ApiError, archiveConference, publishConference, type Conference } from '../api/client.ts';
import { LifecycleBadge, formatSpan } from './lifecycle-display.tsx';

/**
 * One conference, with the lifecycle actions an Admin can take on it.
 *
 * The actions are offered according to what the server would accept, but offering is all the
 * client does. Every refusal here is reproducible by calling the endpoint directly, and when one
 * comes back the server's own message is rendered verbatim – the API is the only thing that knows
 * why a publish was refused, and a generic "something went wrong" would discard exactly the
 * sentence FR1 asks the organizer to be shown.
 */

export interface ConferenceDetailProps {
  conference: Conference;
  onChanged(conference: Conference): void;
  onBack(): void;
}

type Action = 'publish' | 'archive';

export function ConferenceDetail({
  conference,
  onChanged,
  onBack,
}: ConferenceDetailProps): React.JSX.Element {
  const [busy, setBusy] = useState<Action | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  const archived = conference.lifecycleState === 'archived';

  async function act(action: Action): Promise<void> {
    setBusy(action);
    setRefusal(null);
    try {
      const updated =
        action === 'publish'
          ? await publishConference(conference.id)
          : await archiveConference(conference.id);
      onChanged(updated);
    } catch (error) {
      // The server's sentence, not ours.
      setRefusal(
        error instanceof ApiError
          ? error.message
          : 'The app could not reach the server. Check your connection and try again.',
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <section
      className={`panel conference-detail${archived ? ' conference--archived' : ''}`}
      aria-labelledby="conference-detail-title"
      data-testid="conference-detail"
      data-lifecycle-state={conference.lifecycleState}
    >
      <p className="panel__actions">
        <button className="button" type="button" onClick={onBack} data-testid="back-to-list">
          ← All conferences
        </button>
      </p>

      <div className="panel__header">
        <h2 className="panel__title" id="conference-detail-title">
          {conference.name}
        </h2>
        <LifecycleBadge state={conference.lifecycleState} />
      </div>

      <dl className="facts">
        <div className="fact">
          <dt className="fact__label">Dates</dt>
          <dd className="fact__value" data-testid="detail-span">
            {formatSpan(conference)}
          </dd>
        </div>
        <div className="fact">
          <dt className="fact__label">Lifecycle</dt>
          <dd className="fact__value" data-testid="detail-state">
            {conference.lifecycleState}
          </dd>
        </div>
      </dl>

      {archived ? (
        <p className="panel__hint" data-testid="archived-note">
          This conference is archived. It stays readable, and nothing has been deleted, but it can
          no longer be changed or joined.
        </p>
      ) : null}

      {refusal !== null ? (
        <div className="alert" role="alert" data-testid="lifecycle-refusal">
          {refusal}
        </div>
      ) : null}

      {/*
       * Disabled where the transition is not one the state machine offers – an affordance that
       * cannot work should not look like it can. The server refuses independently regardless.
       */}
      <p className="panel__actions conference-detail__actions">
        <button
          className="button button--primary"
          type="button"
          data-testid="publish"
          disabled={busy !== null || conference.lifecycleState !== 'draft'}
          onClick={() => void act('publish')}
        >
          {busy === 'publish' ? 'Publishing…' : 'Publish'}
        </button>

        <button
          className="button"
          type="button"
          data-testid="archive"
          disabled={busy !== null || conference.lifecycleState !== 'published'}
          onClick={() => void act('archive')}
        >
          {busy === 'archive' ? 'Archiving…' : 'Archive'}
        </button>
      </p>
    </section>
  );
}
