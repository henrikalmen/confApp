import { useState } from 'react';
import {
  ApiError,
  archiveConference,
  publishConference,
  updateConference,
  type Conference,
  type ConferenceDetailsInput,
} from '../api/client.ts';
import { ConferenceForm } from './ConferenceForm.tsx';
import { LifecycleBadge, formatSpan } from './lifecycle-display.tsx';
import { JoinCodePanel } from './JoinCodePanel.tsx';
import { SchedulePanel } from '../schedule/SchedulePanel.tsx';
import { MembersPanel } from '../members/MembersPanel.tsx';

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

/**
 * The name and dates stay editable after publish (FR1, FR7) - a conference gets renamed and a day
 * gets added while it is running, and only an archive closes it to changes.
 *
 * The form carries the conference's `updatedAt` as its base, so a second admin who saved first
 * wins and this save is refused with its own sentence rather than overwriting them (S09 TI06).
 * Shortening the span past a session is refused too, naming the sessions that would be stranded -
 * and because that refusal names both date fields, the message lands beside the inputs it is about.
 */
function detailsOf(conference: Conference): ConferenceDetailsInput {
  return {
    name: conference.name,
    startDate: conference.startDate,
    endDate: conference.endDate,
  };
}

export function ConferenceDetail({
  conference,
  onChanged,
  onBack,
}: ConferenceDetailProps): React.JSX.Element {
  const [busy, setBusy] = useState<Action | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ApiError | null>(null);

  const archived = conference.lifecycleState === 'archived';

  async function saveDetails(details: ConferenceDetailsInput): Promise<void> {
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await updateConference(conference.id, details, {
        conferenceState: conference.lifecycleState,
        version: conference.updatedAt,
      });
      onChanged(updated);
      setEditing(false);
    } catch (error) {
      /*
       * Held as the ApiError so the form attaches each message to the control it is about. A
       * version conflict and a span that would strand sessions are two different situations with
       * two different next actions, and the server's sentence is the only thing that says which.
       */
      setSaveError(
        error instanceof ApiError
          ? error
          : new ApiError(
              'NETWORK_UNREACHABLE',
              'The app could not reach the server. Check your connection and try again.',
            ),
      );
    } finally {
      setSaving(false);
    }
  }

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
    <>
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

        {/*
         * Editing is offered while the conference is not archived - draft and published alike.
         * Archiving makes it read-only, so the control is absent rather than present-and-refused.
         */}
        {archived ? null : editing ? (
          <ConferenceForm
            onSubmit={saveDetails}
            busy={saving}
            error={saveError}
            initial={detailsOf(conference)}
            submitLabel="Save changes"
            onCancel={() => {
              setEditing(false);
              setSaveError(null);
            }}
          />
        ) : (
          <p className="panel__actions">
            <button
              className="button"
              type="button"
              data-testid="edit-conference"
              onClick={() => {
                setEditing(true);
                setSaveError(null);
              }}
            >
              Edit name and dates
            </button>
          </p>
        )}

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

      {/*
       * The code panel sits directly under the lifecycle actions because that is where it becomes
       * relevant: publishing is what mints the code, and sharing it is the Organizer's very next
       * action (PRD User Flow 1 ends "publish → share the join code").
       *
       * An archived conference still shows its code, read-only in effect: the code is retained –
       * archiving deletes nothing (FR9) – and any attempt to use it is refused as archived, so
       * hiding it would leave an Organizer unable to see what the code on last year's slide was.
       */}
      <JoinCodePanel
        conferenceId={conference.id}
        published={conference.lifecycleState !== 'draft'}
      />

      {/*
       * The composition surface itself. It sits below the lifecycle actions because that is the
       * order the work happens in: a conference is created, its schedule is composed, and only then
       * can it be published – the Publish button above is refused until this panel holds a session.
       */}
      <SchedulePanel conferenceId={conference.id} readOnly={archived} />

      {/*
       * Members and roles come last because that is the order the work happens in: the schedule has
       * to exist before a session can be assigned to anybody. An archived conference still shows
       * the whole roster – archiving deletes nothing (FR9), and who ran what is exactly what an
       * organizer looks back at – but its role changes are refused, here and on the server.
       */}
      <MembersPanel conferenceId={conference.id} readOnly={archived} />
    </>
  );
}
