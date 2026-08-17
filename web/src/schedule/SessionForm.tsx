import { useEffect, useState } from 'react';
import type { ApiError, Session, SessionDetailsInput, SessionKind } from '../api/client.ts';

/**
 * The add / edit form for one Session.
 *
 * Its whole job on the refusal path is to put the server's own message next to the field the
 * server named. FR2 asks for refusals "rejected inline", naming the valid days and the violated
 * rule; the API already produces those sentences, so rewording them here would only introduce a
 * second, drifting copy.
 *
 * The day input is `type="date"` and the time inputs are `type="time"`, whose values are the same
 * naive strings the columns hold – 'YYYY-MM-DD' and 'HH:mm'. They are passed straight through. No
 * `new Date(value)` anywhere: that would parse the day as UTC midnight and read it back in local
 * time, which is how a session on the 15th is submitted as the 14th.
 */

export interface SessionFormProps {
  /** The Conference Day the form opens on, and the days it may be moved to. */
  days: readonly string[];
  /** Present when editing; absent when adding. */
  editing: Session | null;
  initialDay: string;
  onSubmit(details: SessionDetailsInput): Promise<void>;
  onCancel(): void;
  busy: boolean;
  error: ApiError | null;
}

const KINDS: readonly SessionKind[] = ['Presentation', 'Workshop'];

function emptyDetails(day: string): SessionDetailsInput {
  return {
    title: '',
    description: '',
    kind: 'Presentation',
    day,
    startTime: '',
    endTime: '',
    location: '',
  };
}

function detailsOf(session: Session): SessionDetailsInput {
  return {
    title: session.title,
    description: session.description ?? '',
    kind: session.kind,
    day: session.day,
    startTime: session.startTime,
    endTime: session.endTime,
    location: session.location,
  };
}

export function SessionForm({
  days,
  editing,
  initialDay,
  onSubmit,
  onCancel,
  busy,
  error,
}: SessionFormProps): React.JSX.Element {
  const [details, setDetails] = useState<SessionDetailsInput>(() =>
    editing === null ? emptyDetails(initialDay) : detailsOf(editing),
  );

  // Reopening the form on a different session – or on a different day – re-seeds it, so an edit
  // never starts from the values of whatever was open last.
  useEffect(() => {
    setDetails(editing === null ? emptyDetails(initialDay) : detailsOf(editing));
  }, [editing, initialDay]);

  const fieldError = (field: string): string | undefined => error?.messageFor(field);

  /** A refusal that named no field at all still has to be shown somewhere. */
  const formError = error !== null && error.details.length === 0 ? error.message : null;

  function update<K extends keyof SessionDetailsInput>(
    field: K,
    value: SessionDetailsInput[K],
  ): void {
    setDetails((current) => ({ ...current, [field]: value }));
  }

  const describedBy = (field: string): string | undefined =>
    fieldError(field) !== undefined ? `session-${field}-error` : undefined;

  return (
    <form
      className="session-form"
      data-testid="session-form"
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit(details);
      }}
    >
      <h3 className="session-form__title">
        {editing === null ? 'Add a session' : `Edit “${editing.title}”`}
      </h3>

      <div className="field">
        <label className="field__label" htmlFor="session-title">
          Title
        </label>
        <input
          className="field__input"
          id="session-title"
          name="title"
          type="text"
          value={details.title}
          onChange={(event) => update('title', event.target.value)}
          aria-invalid={fieldError('title') !== undefined}
          aria-describedby={describedBy('title')}
        />
        {fieldError('title') !== undefined ? (
          <p className="field__error" id="session-title-error" data-testid="error-title">
            {fieldError('title')}
          </p>
        ) : null}
      </div>

      <div className="field">
        <label className="field__label" htmlFor="session-description">
          Description <span className="field__optional">(optional)</span>
        </label>
        <textarea
          className="field__input field__input--multiline"
          id="session-description"
          name="description"
          rows={2}
          value={details.description ?? ''}
          onChange={(event) => update('description', event.target.value)}
        />
      </div>

      <div className="field-row">
        <div className="field">
          <label className="field__label" htmlFor="session-kind">
            Kind
          </label>
          <select
            className="field__input"
            id="session-kind"
            name="kind"
            value={details.kind}
            onChange={(event) => update('kind', event.target.value as SessionKind)}
            aria-invalid={fieldError('kind') !== undefined}
            aria-describedby={describedBy('kind')}
          >
            {KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
          {fieldError('kind') !== undefined ? (
            <p className="field__error" id="session-kind-error" data-testid="error-kind">
              {fieldError('kind')}
            </p>
          ) : null}
        </div>

        <div className="field">
          <label className="field__label" htmlFor="session-day">
            Conference day
          </label>
          {/*
           * A select over the Conference's own days rather than a free date input: the days are
           * derived from the span and are the only permitted values, so offering anything else
           * invites a refusal the Organizer did not need to see. The server still validates it —
           * the client never decides, it only avoids asking a question with a wrong answer.
           */}
          <select
            className="field__input"
            id="session-day"
            name="day"
            value={details.day}
            onChange={(event) => update('day', event.target.value)}
            aria-invalid={fieldError('day') !== undefined}
            aria-describedby={describedBy('day')}
          >
            {days.map((day) => (
              <option key={day} value={day}>
                {day}
              </option>
            ))}
          </select>
          {fieldError('day') !== undefined ? (
            <p className="field__error" id="session-day-error" data-testid="error-day">
              {fieldError('day')}
            </p>
          ) : null}
        </div>
      </div>

      <div className="field-row">
        <div className="field">
          <label className="field__label" htmlFor="session-start">
            Start time
          </label>
          <input
            className="field__input"
            id="session-start"
            name="startTime"
            type="time"
            value={details.startTime}
            onChange={(event) => update('startTime', event.target.value)}
            aria-invalid={fieldError('startTime') !== undefined}
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="session-end">
            End time
          </label>
          <input
            className="field__input"
            id="session-end"
            name="endTime"
            type="time"
            value={details.endTime}
            onChange={(event) => update('endTime', event.target.value)}
            aria-invalid={fieldError('endTime') !== undefined}
            aria-describedby={describedBy('endTime')}
          />
        </div>
      </div>

      {/*
       * One message for the pair. The range is a property of both times together, so repeating it
       * under each input would say the same thing twice and imply two separate problems.
       */}
      {fieldError('endTime') !== undefined ? (
        <p className="field__error" id="session-endTime-error" data-testid="error-times">
          {fieldError('endTime')}
        </p>
      ) : null}

      <div className="field">
        <label className="field__label" htmlFor="session-location">
          Location
        </label>
        <input
          className="field__input"
          id="session-location"
          name="location"
          type="text"
          placeholder="Main Hall"
          value={details.location}
          onChange={(event) => update('location', event.target.value)}
          aria-invalid={fieldError('location') !== undefined}
          aria-describedby={describedBy('location')}
        />
        {fieldError('location') !== undefined ? (
          <p className="field__error" id="session-location-error" data-testid="error-location">
            {fieldError('location')}
          </p>
        ) : null}
      </div>

      {formError !== null ? (
        <div className="alert" role="alert" data-testid="session-form-error">
          {formError}
        </div>
      ) : null}

      <p className="panel__actions session-form__actions">
        <button className="button button--primary" type="submit" disabled={busy}>
          {busy ? 'Saving…' : editing === null ? 'Add session' : 'Save changes'}
        </button>
        <button className="button" type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </p>
    </form>
  );
}
