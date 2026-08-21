import { useState } from 'react';
import { ApiError, joinConference, type JoinedConference } from '../api/client.ts';
import { primeScheduleCache } from '../offline/schedule-data.ts';
import { useOnline } from '../offline/use-online.ts';

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
  const online = useOnline();

  const rateLimited = refusal?.code === RATE_LIMITED;
  /*
   * Nothing to submit while the box is empty, nothing worth submitting while paused, and **nothing
   * to submit later** while offline. Joining is a write, and offline scope is read-only (FR8): the
   * control says a connection is required rather than accepting a code into a queue nobody would
   * be told about. No outbox, no replay, no deferred submission – an anti-goal, not a shortcut
   * (`docs/PRODUCT.md#anti-goals`).
   */
  const canSubmit = !busy && code.trim() !== '' && !rateLimited && online;

  /**
   * Editing the code lifts a rate-limit pause.
   *
   * This is load-bearing, not a convenience. The pause is the one state that disables the submit
   * control, so without something outside `submit()` clearing it the screen would be a dead end –
   * and the allowance draining server-side would not bring the button back, because nothing would
   * ask the server again. OC04 is explicit that the allowance returns by itself with no unlock step,
   * and on the Capacitor shell there is no address bar to reload from, so "reload the app" is not an
   * escape hatch that exists.
   *
   * Retyping the code is also exactly the gesture the refusal asks for ("check the code with the
   * organizer"), so the recovery is the action the employee was already going to take. The server
   * stays the authority: if the window has not in fact drained, the next submission is refused again
   * with a freshly computed wait.
   *
   * Other refusals are deliberately left on screen while the code is edited – they name a reason the
   * employee is reading as they correct it, and they never disable anything.
   */
  function updateCode(next: string): void {
    setCode(next);
    if (rateLimited) setRefusal(null);
  }

  async function submit(): Promise<void> {
    setBusy(true);
    // Cleared before the attempt, not after it: one refusal at a time, and never a stale one
    // sitting above a fresh answer.
    setRefusal(null);
    setJoined(null);
    try {
      const conference = await joinConference(code);
      setJoined(conference);
      // Only a success clears the box – a refusal leaves it exactly as typed to be corrected.
      setCode('');
      /*
       * Joining online is enough to read the Schedule offline afterwards (S10 TI03). The Schedule
       * is fetched and cached here rather than waiting for the employee to open the schedule view –
       * somebody who joins in the lobby and loses signal in the hall has still never opened it, and
       * that is precisely the person the offline story is for. Quiet on failure: the cache warms
       * itself on the next online read, and nothing is queued for later.
       */
      void primeScheduleCache(conference.id);
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
            onChange={(event) => updateCode(event.target.value)}
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
       * Why the control cannot be used, rather than a button that silently does nothing. Offline is
       * the common case at a venue, and an attendee needs to know the code is not lost and nothing
       * is waiting to be sent on their behalf.
       */}
      {!online ? (
        <p className="panel__hint" data-testid="join-offline">
          You are offline, so you cannot join a conference right now. Nothing is saved to send later
          – try again when you have a connection.
        </p>
      ) : null}

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
