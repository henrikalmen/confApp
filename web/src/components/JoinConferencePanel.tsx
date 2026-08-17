import { useState } from 'react';
import { ApiError, joinConference, type JoinedConference } from '../api/client.ts';

/**
 * The join-code entry screen.
 *
 * Its whole job on the refusal path is to leave the employee able to try again *on the spot*. PRD
 * User Flow 5 ends "refused with a clear message **and the option to retry**", and this is the
 * screen where that either happens or does not:
 *
 *   - the field keeps what was typed, so a single mistyped character is a single correction rather
 *     than the whole code again;
 *   - the field and the submit control are both re-enabled the instant the answer arrives;
 *   - the previous refusal is *replaced* on the next attempt, never stacked, so what is on screen is
 *     always about the code currently in the box.
 *
 * The one exception is the rate-limit refusal. There, offering a control that is certain to fail
 * would be worse than not offering one: the message says when to come back and the submit stays
 * disabled, while the field stays editable so the employee can still check the code against the
 * slide.
 *
 * Every message rendered here is the server's own sentence. The API is the only thing that knows
 * *which* conference a code was for and why it was refused, and rewording it here would discard
 * exactly the detail FR3 asks the employee to be shown.
 */

/** The rate-limit refusal is the only one that does not invite an immediate retry. */
const RATE_LIMITED = 'JOIN_ATTEMPTS_RATE_LIMITED';

type Refusal = { code: string; message: string };

function refusalOf(error: unknown): Refusal {
  return error instanceof ApiError
    ? { code: error.code, message: error.message }
    : {
        code: 'NETWORK_UNREACHABLE',
        message: 'The app could not reach the server. Check your connection and try again.',
      };
}

export function JoinConferencePanel(): React.JSX.Element {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [joined, setJoined] = useState<JoinedConference | null>(null);

  const rateLimited = refusal?.code === RATE_LIMITED;
  // Nothing to submit while the box is empty, and nothing worth submitting while paused.
  const canSubmit = !busy && code.trim() !== '' && !rateLimited;

  async function submit(): Promise<void> {
    setBusy(true);
    // Cleared before the attempt, not after it: one refusal at a time, and never a stale one
    // sitting above a fresh answer.
    setRefusal(null);
    setJoined(null);
    try {
      setJoined(await joinConference(code));
      // Only a success clears the box – a refusal leaves it exactly as typed to be corrected.
      setCode('');
    } catch (error) {
      setRefusal(refusalOf(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" aria-labelledby="join-title" data-testid="join-panel">
      <div className="panel__header">
        <h2 className="panel__title" id="join-title">
          Join a conference
        </h2>
      </div>

      <p className="panel__hint">
        Enter the code the organizer is showing. Capitals and spacing do not matter.
      </p>

      <form
        className="join-form"
        data-testid="join-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) void submit();
        }}
      >
        <div className="field">
          <label className="field__label" htmlFor="join-code">
            Join code
          </label>
          <input
            className="field__input field__input--code"
            id="join-code"
            name="code"
            type="text"
            /*
             * `autoComplete="off"` because a code is per-conference and a remembered one is always
             * the wrong one. `autoCapitalize`/`spellCheck` keep a phone keyboard from fighting the
             * value; normalization on the server is what actually makes case irrelevant.
             */
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            inputMode="text"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            /*
             * Never disabled – not while a request is in flight and not while the limiter is
             * counting down. The employee's next action is to check the code against the slide, and
             * a read-only box is exactly the wrong affordance for that.
             */
            aria-invalid={refusal !== null}
            aria-describedby={refusal !== null ? 'join-refusal' : undefined}
            data-testid="join-code-input"
          />
        </div>

        <p className="panel__actions join-form__actions">
          <button
            className="button button--primary"
            type="submit"
            disabled={!canSubmit}
            data-testid="join-submit"
          >
            {busy ? 'Joining…' : 'Join'}
          </button>
        </p>
      </form>

      {/*
       * One region, replaced rather than appended. `role="alert"` announces each new refusal, and
       * because it is the same element the previous one is gone rather than pushed down the page.
       */}
      {refusal !== null ? (
        <div className="alert" role="alert" id="join-refusal" data-testid="join-refusal">
          {refusal.message}
          <code className="alert__code">{refusal.code}</code>
        </div>
      ) : null}

      {joined !== null ? (
        <div className="notice" role="status" data-testid="join-success">
          You have joined <strong>{joined.name}</strong> ({joined.startDate} – {joined.endDate}).
        </div>
      ) : null}
    </section>
  );
}
