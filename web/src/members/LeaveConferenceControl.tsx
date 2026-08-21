import { useState } from 'react';
import { ApiError, leaveConference } from '../api/client.ts';
import { useOnline } from '../offline/use-online.ts';

/**
 * Leaving a conference, as two deliberate acts.
 *
 * The confirmation is not politeness. The PRD's reason is a mis-tap during a session – somebody
 * holding a phone in a crowded room, one-handed – so the first tap only *offers* to leave and the
 * request is issued by a second, differently-labelled act that names the conference being left.
 * Neither an undo window nor a toast satisfies that: both revoke first and rely on the person
 * noticing in time, which is precisely what a distracted attendee will not do.
 *
 * Nothing is remembered on the server between the two taps. The API runs as several container
 * replicas with no request affinity (ADR-004), so a "pending leave" would live on one replica and
 * be absent from the next; the whole first step is the client's, and the endpoint it eventually
 * calls is authorized, guarded and atomic on its own.
 *
 * **Offline, this is unavailable and nothing is queued.** Offline scope is read-only (FR8): the
 * schedule can be read without a connection, but a revocation that was typed into a dead network
 * and applied twenty minutes later – possibly after somebody changed their mind, possibly after an
 * admin already removed them – is sync behaviour the product does not have. The control says so
 * instead of pretending to work.
 */

export interface LeaveConferenceControlProps {
  conferenceId: string;
  /** Named in the confirmation, so nobody confirms leaving the wrong one. */
  conferenceName: string;
  /**
   * Archived conferences refuse every membership change (FR9). The control is disabled and says
   * why, but the refusal is the server's – calling the endpoint directly is refused identically.
   */
  archived?: boolean;
  /** Called once the membership is gone, so the surrounding view can reload what is left. */
  onLeft(): void;
}

type Step = 'idle' | 'confirming' | 'leaving';

export function LeaveConferenceControl({
  conferenceId,
  conferenceName,
  archived = false,
  onLeft,
}: LeaveConferenceControlProps): React.JSX.Element {
  const [step, setStep] = useState<Step>('idle');
  const [refusal, setRefusal] = useState<string | null>(null);
  const online = useOnline();

  const unavailable = archived || !online;

  async function confirm(): Promise<void> {
    setStep('leaving');
    setRefusal(null);
    try {
      await leaveConference(conferenceId);
      onLeft();
    } catch (error) {
      // The server's sentence, not ours: it knows whether this was the last admin, an archived
      // conference, or something else, and each is a different thing for the person to do next.
      setRefusal(
        error instanceof ApiError
          ? error.message
          : 'The app could not reach the server, so nothing was changed. Try again when you have a connection.',
      );
      setStep('idle');
    }
  }

  return (
    <div className="leave-conference" data-testid="leave-conference-control">
      {refusal !== null ? (
        <div className="alert" role="alert" data-testid="leave-refusal">
          {refusal}
        </div>
      ) : null}

      {step === 'idle' ? (
        <>
          <button
            className="button button--small"
            type="button"
            data-testid="leave-conference"
            disabled={unavailable}
            onClick={() => {
              setRefusal(null);
              setStep('confirming');
            }}
          >
            Leave this conference
          </button>
          {/*
           * Why it cannot be used, rather than a control that silently does nothing. Offline is the
           * common case at a venue and "the button does not work" is not something an attendee can
           * act on.
           */}
          {!online ? (
            <p className="panel__hint" data-testid="leave-offline">
              You are offline, so you cannot leave a conference right now. Nothing is saved to send
              later – try again when you have a connection.
            </p>
          ) : archived ? (
            <p className="panel__hint" data-testid="leave-archived">
              This conference has been archived, so its membership can no longer be changed. Nothing
              you contributed has been deleted.
            </p>
          ) : null}
        </>
      ) : (
        /*
         * The second act. It names the conference, because somebody with three of them in the
         * picker is one tap away from leaving the wrong one, and it says what leaving costs and
         * what it does not – no historical record goes with it.
         */
        <div
          className="confirm"
          role="group"
          aria-label="Confirm leaving"
          data-testid="leave-confirm"
        >
          <p className="confirm__question">
            Leave “{conferenceName}”? Its schedule will stop being available to you. You can join
            again with the code the organizer shares. Nothing you contributed is deleted.
          </p>
          <p className="confirm__actions">
            <button
              className="button button--danger"
              type="button"
              data-testid="leave-confirm-yes"
              disabled={step === 'leaving'}
              onClick={() => void confirm()}
            >
              {step === 'leaving' ? 'Leaving…' : 'Yes, leave'}
            </button>
            <button
              className="button"
              type="button"
              data-testid="leave-cancel"
              disabled={step === 'leaving'}
              onClick={() => setStep('idle')}
            >
              Cancel
            </button>
          </p>
        </div>
      )}
    </div>
  );
}
