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
/**
 * Is this the current Conference representation a version conflict carries?
 *
 * Checked rather than cast: the payload arrives from the network, and a conflict whose body was not
 * what this expects must degrade to the plain refusal message rather than render `undefined` at the
 * organizer.
 */
function isConference(value: unknown): value is Conference {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  // Every field the caller goes on to read, not a sample of them - the point of the guard is that
  // nothing `undefined` reaches the organizer's screen or the next request's base.
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.updatedAt === 'string' &&
    typeof candidate.startDate === 'string' &&
    typeof candidate.endDate === 'string' &&
    typeof candidate.lifecycleState === 'string'
  );
}

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
  /**
   * The conference as the server holds it now, after somebody else saved first.
   *
   * Held beside the form rather than replacing it: the organizer's typed values stay put and these
   * are shown next to them, so re-applying the edit is a decision rather than a retype. It is also
   * the base the next save carries - which is what makes that second save succeed. Without it the
   * refusal's own instruction ("re-apply it and save again") could never be followed: every retry
   * would resend the same stale version and be refused identically.
   */
  const [conflict, setConflict] = useState<Conference | null>(null);
  /**
   * What was typed, and why it was refused, when the form itself is about to go.
   *
   * Archiving closes a Conference to edits, so the edit branch below renders nothing at all once
   * the archived Conference is lifted - and the form was both the only place `saveError` was shown
   * and the only place the typed values existed. They disappeared together, leaving the organizer
   * watching the panel quietly turn archived with no statement of what happened to their save. Kept
   * here from the values `saveDetails` was already handed, so the refusal outlives the form.
   */
  const [abandoned, setAbandoned] = useState<{
    details: ConferenceDetailsInput;
    message: string;
  } | null>(null);

  const archived = conference.lifecycleState === 'archived';

  async function saveDetails(details: ConferenceDetailsInput): Promise<void> {
    setSaving(true);
    setSaveError(null);
    try {
      // After a conflict the base is the version the server handed back, not the one the form was
      // opened with - that is precisely what "re-apply onto the current version" means.
      const basis = conflict ?? conference;
      const updated = await updateConference(conference.id, details, {
        conferenceState: basis.lifecycleState,
        version: basis.updatedAt,
      });
      onChanged(updated);
      setEditing(false);
      setConflict(null);
    } catch (error) {
      /*
       * Held as the ApiError so the form attaches each message to the control it is about. A
       * version conflict and a span that would strand sessions are two different situations with
       * two different next actions, and the server's sentence is the only thing that says which.
       */
      const refused =
        error instanceof ApiError
          ? error
          : new ApiError(
              'NETWORK_UNREACHABLE',
              'The app could not reach the server. Check your connection and try again.',
            );

      if (refused.code === 'EDIT_VERSION_CONFLICT' && isConference(refused.current)) {
        setConflict(refused.current);
      }
      /*
       * A lifecycle transition is not a version conflict - there is no newer version of *this* edit
       * to re-apply onto - but the editor still has to be able to move. The refusal carries the
       * Conference as it now stands, so it is lifted to the owner: that re-renders this component
       * with the new state, and the next save carries a state the server will accept instead of
       * being refused identically forever.
       */
      if (refused.code === 'CONFERENCE_STATE_CHANGED' && isConference(refused.current)) {
        /*
         * The stale conflict goes with it. `basis` prefers `conflict` over `conference`, so a
         * version conflict followed by a publish would keep sending the pre-publish version as the
         * base forever - every later save refused identically, which is the dead end this branch
         * exists to close, reached by two steps instead of one.
         */
        setConflict(null);

        /*
         * An archive is where the form goes away, so what it held is captured first. There is no
         * re-apply for an archived Conference - it accepts no edit at any version - so the typed
         * values are kept to be read and copied, not to be resubmitted.
         */
        if (refused.current.lifecycleState === 'archived') {
          setAbandoned({ details, message: refused.message });
          setEditing(false);
        }

        onChanged(refused.current);
      }

      setSaveError(refused);
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
        {/*
         * What the server holds now, beside what the organizer typed. Both are on screen at once on
         * purpose: the edit is re-applied by choice, and a notice that only said "somebody else
         * changed this" would leave the newer values to be hunted for.
         */}
        {conflict !== null && editing ? (
          <div className="edit-conflict" role="status" data-testid="conference-conflict">
            <p className="edit-conflict__current">
              <strong>{conflict.name}</strong> now runs {conflict.startDate} – {conflict.endDate}.
              Your changes are still below – save again to apply them on top of this version.
            </p>
            <p className="edit-conflict__actions">
              <button
                className="button button--quiet"
                type="button"
                data-testid="conference-conflict-discard"
                onClick={() => {
                  setConflict(null);
                  setEditing(false);
                  setSaveError(null);
                }}
              >
                Discard my changes
              </button>
            </p>
          </div>
        ) : null}

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
              setConflict(null);
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
                setConflict(null);
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

        {/*
         * The refusal that outlived the form, with what was typed beside it. Rendered here rather
         * than inside the edit branch precisely because that branch is gone by now: an archive
         * landing under an in-flight edit is the one refusal whose form does not survive to show it.
         */}
        {abandoned !== null ? (
          <div className="alert" role="alert" data-testid="conference-edit-abandoned">
            <p>{abandoned.message}</p>
            <p className="edit-conflict__current">
              Your unsaved changes were: <strong>{abandoned.details.name}</strong>,{' '}
              {abandoned.details.startDate} – {abandoned.details.endDate}
            </p>
            <p className="edit-conflict__actions">
              <button
                className="button button--quiet"
                type="button"
                data-testid="conference-edit-abandoned-dismiss"
                onClick={() => {
                  setAbandoned(null);
                  setSaveError(null);
                }}
              >
                Dismiss
              </button>
            </p>
          </div>
        ) : null}

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
      <SchedulePanel
        conferenceId={conference.id}
        readOnly={archived}
        lifecycleState={conference.lifecycleState}
      />

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
