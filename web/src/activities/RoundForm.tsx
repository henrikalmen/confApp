import { useEffect, useState } from 'react';
import type { ApiError, Round, RoundDetailsInput, RoundKind } from '../api/client.ts';

/**
 * The add / edit form for one Round, mirroring `web/src/schedule/SessionForm.tsx`.
 *
 * Its whole job on the refusal path is to put the server's own message next to the field the server
 * named. FR1 asks for refusals "rejected inline", naming the limit or the rule; the API already
 * produces those sentences, so rewording them here would only introduce a second, drifting copy.
 *
 * **The two levels of the Activity model are visible in the controls**, because they are visible in
 * the domain: the kind chooses the Activity, and a Voting Round then chooses its purpose. Only Poll
 * exists today, so that control offers one value rather than being hidden – hiding it is how a
 * later Prioritization purpose becomes a new *kind* by the shortest path available.
 *
 * Typed values survive a refusal: the form is re-seeded only when the Round being edited changes,
 * never when a save comes back refused (`docs/LEARNINGS.md#react-state--refusals`).
 */

export interface RoundFormProps {
  /** Present when editing; absent when adding. */
  editing: Round | null;
  onSubmit(details: RoundDetailsInput): Promise<void>;
  onCancel(): void;
  busy: boolean;
  error: ApiError | null;
}

const KIND_LABELS: Record<RoundKind, string> = {
  PostItRound: 'Post-it round',
  VotingRound: 'Voting round',
};

const KINDS: readonly RoundKind[] = ['PostItRound', 'VotingRound'];

function emptyDetails(): RoundDetailsInput {
  return { kind: 'PostItRound', purpose: null, prompt: '', options: [] };
}

/**
 * What is actually sent.
 *
 * A Post-it Round carries no options and no purpose – participants write their own post-its, and a
 * purpose describes what a Voting Round is for. Built here rather than trusted from the form state,
 * so switching the kind back and forth cannot leave a stale half of the other kind in the body.
 */
function submitted(details: RoundDetailsInput): RoundDetailsInput {
  return details.kind === 'VotingRound'
    ? { ...details, purpose: details.purpose ?? 'Poll', options: details.options ?? [] }
    : { kind: 'PostItRound', purpose: null, prompt: details.prompt, options: [] };
}

function detailsOf(round: Round): RoundDetailsInput {
  return {
    kind: round.kind,
    purpose: round.purpose ?? null,
    prompt: round.prompt,
    options: (round.options ?? []).map((option) => option.label),
  };
}

export function RoundForm({
  editing,
  onSubmit,
  onCancel,
  busy,
  error,
}: RoundFormProps): React.JSX.Element {
  const [details, setDetails] = useState<RoundDetailsInput>(() =>
    editing === null ? emptyDetails() : detailsOf(editing),
  );

  // Reopening the form on a different round re-seeds it, so an edit never starts from the values of
  // whatever was open last. A refusal changes neither input, so the typed values stay put.
  useEffect(() => {
    setDetails(editing === null ? emptyDetails() : detailsOf(editing));
  }, [editing]);

  const fieldError = (field: string): string | undefined => error?.messageFor(field);
  const describedBy = (field: string): string | undefined =>
    fieldError(field) !== undefined ? `round-${field}-error` : undefined;

  const isPoll = details.kind === 'VotingRound';
  const options = details.options ?? [];

  function update<K extends keyof RoundDetailsInput>(field: K, value: RoundDetailsInput[K]): void {
    setDetails((current) => ({ ...current, [field]: value }));
  }

  /** Changing the kind carries its purpose with it – the two are only meaningful together. */
  function selectKind(kind: RoundKind): void {
    setDetails((current) => ({
      ...current,
      kind,
      purpose: kind === 'VotingRound' ? 'Poll' : null,
      // Two empty slots, because a poll needs at least two and an empty list teaches nothing.
      options:
        kind === 'VotingRound'
          ? (current.options ?? []).length >= 2
            ? (current.options ?? [])
            : ['', '']
          : [],
    }));
  }

  function setOption(index: number, label: string): void {
    setDetails((current) => ({
      ...current,
      options: (current.options ?? []).map((existing, at) => (at === index ? label : existing)),
    }));
  }

  return (
    <form
      className="session-form round-form"
      data-testid="round-form"
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit(submitted(details));
      }}
    >
      <h4 className="session-form__title">
        {editing === null ? 'Add a round' : `Edit “${editing.prompt}”`}
      </h4>

      <div className="field-row">
        <div className="field">
          <label className="field__label" htmlFor="round-kind">
            Kind
          </label>
          <select
            className="field__input"
            id="round-kind"
            name="kind"
            value={details.kind}
            /* The kind is what a Round *is*; changing it after the fact would leave any post-it or
             * vote pointing at something the Round never was, so the server refuses it and the
             * control is offered only while adding. */
            disabled={editing !== null}
            onChange={(event) => selectKind(event.target.value as RoundKind)}
            aria-invalid={fieldError('kind') !== undefined}
            aria-describedby={describedBy('kind')}
          >
            {KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {KIND_LABELS[kind]}
              </option>
            ))}
          </select>
          {fieldError('kind') !== undefined ? (
            <p className="field__error" id="round-kind-error" data-testid="error-kind">
              {fieldError('kind')}
            </p>
          ) : null}
        </div>

        {isPoll ? (
          <div className="field">
            <label className="field__label" htmlFor="round-purpose">
              Purpose
            </label>
            <select
              className="field__input"
              id="round-purpose"
              name="purpose"
              value={details.purpose ?? 'Poll'}
              disabled={editing !== null}
              onChange={(event) => update('purpose', event.target.value as 'Poll')}
              aria-invalid={fieldError('purpose') !== undefined}
              aria-describedby={describedBy('purpose')}
            >
              <option value="Poll">Poll</option>
            </select>
            {fieldError('purpose') !== undefined ? (
              <p className="field__error" id="round-purpose-error" data-testid="error-purpose">
                {fieldError('purpose')}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="field">
        <label className="field__label" htmlFor="round-prompt">
          {isPoll ? 'Question' : 'Prompt'}
        </label>
        <textarea
          className="field__input field__input--multiline"
          id="round-prompt"
          name="prompt"
          rows={2}
          value={details.prompt}
          onChange={(event) => update('prompt', event.target.value)}
          aria-invalid={fieldError('prompt') !== undefined}
          aria-describedby={describedBy('prompt')}
        />
        {fieldError('prompt') !== undefined ? (
          <p className="field__error" id="round-prompt-error" data-testid="error-prompt">
            {fieldError('prompt')}
          </p>
        ) : null}
      </div>

      {isPoll ? (
        <div className="field">
          <span className="field__label" id="round-options-label">
            Answer options
          </span>
          <ul className="round-form__options" aria-labelledby="round-options-label">
            {options.map((label, index) => (
              // Keyed by position, because that is what an option *is* here: an ordered slot the
              // facilitator types into. Nothing reorders the list, so the index is stable.
              <li className="round-form__option" key={index}>
                <label
                  className="field__label field__label--inline"
                  htmlFor={`round-option-${index}`}
                >
                  Option {index + 1}
                </label>
                <input
                  className="field__input"
                  id={`round-option-${index}`}
                  name={`option-${index}`}
                  type="text"
                  value={label}
                  onChange={(event) => setOption(index, event.target.value)}
                  aria-invalid={fieldError('options') !== undefined}
                  aria-describedby={describedBy('options')}
                />
              </li>
            ))}
          </ul>

          <p className="panel__actions">
            <button
              className="button button--small"
              type="button"
              data-testid="round-add-option"
              onClick={() => update('options', [...options, ''])}
            >
              Add an option
            </button>
            <button
              className="button button--small"
              type="button"
              data-testid="round-remove-option"
              disabled={options.length <= 1}
              onClick={() => update('options', options.slice(0, -1))}
            >
              Remove the last option
            </button>
          </p>

          {/*
           * One message for the list. The rules a poll's options break – too few, blank, repeated,
           * too long – are properties of the list as a whole, so repeating the sentence under every
           * input would say the same thing several times and imply several separate problems.
           */}
          {fieldError('options') !== undefined ? (
            <p className="field__error" id="round-options-error" data-testid="error-options">
              {fieldError('options')}
            </p>
          ) : null}
        </div>
      ) : null}

      <p className="panel__actions session-form__actions">
        <button className="button button--primary" type="submit" disabled={busy}>
          {busy ? 'Saving…' : editing === null ? 'Add round' : 'Save changes'}
        </button>
        <button className="button" type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </p>
    </form>
  );
}
