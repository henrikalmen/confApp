import { useState } from 'react';
import type { ApiError, ConferenceDetailsInput } from '../api/client.ts';

/**
 * The create form.
 *
 * Its whole job on the refusal path is to put the server's own message next to the field the
 * server named. FR1 asks for the permitted range stated inline; the API already produces that
 * sentence, so rewording it here would only introduce a second, drifting copy.
 *
 * The date inputs are `type="date"`, whose value is a 'YYYY-MM-DD' string – the same naive
 * calendar day the column holds. It is passed straight through: no `new Date(value)` anywhere,
 * because that parses the string as UTC midnight and reads it back in local time, which is how a
 * conference starting on the 14th is submitted as the 13th.
 */

export interface ConferenceFormProps {
  onSubmit(details: ConferenceDetailsInput): Promise<void>;
  busy: boolean;
  /** The refusal from the last attempt, if it was refused. */
  error: ApiError | null;
}

const EMPTY: ConferenceDetailsInput = { name: '', startDate: '', endDate: '' };

export function ConferenceForm({ onSubmit, busy, error }: ConferenceFormProps): React.JSX.Element {
  const [details, setDetails] = useState<ConferenceDetailsInput>(EMPTY);

  const fieldError = (field: keyof ConferenceDetailsInput): string | undefined =>
    error?.messageFor(field);

  /** A refusal that named no field at all still has to be shown somewhere. */
  const formError = error !== null && error.details.length === 0 ? error.message : null;

  function update(field: keyof ConferenceDetailsInput, value: string): void {
    setDetails((current) => ({ ...current, [field]: value }));
  }

  return (
    <form
      className="conference-form"
      data-testid="conference-form"
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit(details);
      }}
    >
      <div className="field">
        <label className="field__label" htmlFor="conference-name">
          Conference name
        </label>
        <input
          className="field__input"
          id="conference-name"
          name="name"
          type="text"
          value={details.name}
          onChange={(event) => update('name', event.target.value)}
          aria-invalid={fieldError('name') !== undefined}
          aria-describedby={fieldError('name') !== undefined ? 'conference-name-error' : undefined}
        />
        {fieldError('name') !== undefined ? (
          <p className="field__error" id="conference-name-error" data-testid="error-name">
            {fieldError('name')}
          </p>
        ) : null}
      </div>

      <div className="field-row">
        <div className="field">
          <label className="field__label" htmlFor="conference-start">
            First day
          </label>
          <input
            className="field__input"
            id="conference-start"
            name="startDate"
            type="date"
            value={details.startDate}
            onChange={(event) => update('startDate', event.target.value)}
            aria-invalid={fieldError('startDate') !== undefined}
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="conference-end">
            Last day
          </label>
          <input
            className="field__input"
            id="conference-end"
            name="endDate"
            type="date"
            value={details.endDate}
            onChange={(event) => update('endDate', event.target.value)}
            aria-invalid={fieldError('endDate') !== undefined}
            aria-describedby={
              fieldError('endDate') !== undefined ? 'conference-dates-error' : undefined
            }
          />
        </div>
      </div>

      {/*
       * One message for the pair. The span is a property of both dates together, so repeating it
       * under each input would say the same thing twice and imply two separate problems.
       */}
      {fieldError('endDate') !== undefined ? (
        <p className="field__error" id="conference-dates-error" data-testid="error-dates">
          {fieldError('endDate')}
        </p>
      ) : null}

      {formError !== null ? (
        <div className="alert" role="alert" data-testid="form-error">
          {formError}
        </div>
      ) : null}

      <p className="panel__actions">
        <button className="button button--primary" type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create conference'}
        </button>
      </p>
    </form>
  );
}
