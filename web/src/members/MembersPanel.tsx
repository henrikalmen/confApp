import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  assignSessionHolder,
  fetchRoster,
  grantRole,
  removeMember,
  revokeRole,
  roleLabel,
  unassignSessionHolder,
  type ConferenceMember,
  type ConferenceRoster,
  type GrantableRole,
} from '../api/client.ts';

/**
 * The Admin's member surface: who is in this conference, what each of them may do, and which
 * sessions the presenters/facilitators are running.
 *
 * Two rules run through the whole panel.
 *
 * **The server's sentence, verbatim.** Every refusal here is a different situation with a different
 * next action – the last admin cannot be removed, this person has never signed in, that address
 * names two accounts, they have not joined yet – and the API is the only thing that knows which. A
 * generic "something went wrong" would discard exactly the sentence the organizer needs, so the
 * message is rendered as it arrives.
 *
 * **Affordances are hints, never the guard.** Controls are hidden or disabled where the server
 * would refuse, because an affordance that cannot work should not look like it can. But every
 * refusal is reproducible by calling the endpoint directly, which is what the API tests assert –
 * nothing here is load-bearing for authorization.
 */

export interface MembersPanelProps {
  conferenceId: string;
  /** Archived conferences stay readable; only their role changes are refused (FR9). */
  readOnly?: boolean;
}

type Loading = { kind: 'loading' };
type Failed = { kind: 'failed'; message: string };
type Ready = { kind: 'ready'; roster: ConferenceRoster };
type State = Loading | Failed | Ready;

function messageOf(error: unknown): string {
  return error instanceof ApiError
    ? error.message
    : 'The app could not reach the server. Check your connection and try again.';
}

/** Attendee comes from membership and is not revocable here – leaving is a separate action. */
const REVOCABLE: GrantableRole[] = ['Admin', 'PresenterFacilitator'];

function isRevocable(role: string): role is GrantableRole {
  return (REVOCABLE as string[]).includes(role);
}

export function MembersPanel({
  conferenceId,
  readOnly = false,
}: MembersPanelProps): React.JSX.Element {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * The member whose removal has been offered but not yet confirmed, by `sub`.
   *
   * Removing somebody from the conference is a different order of thing from taking a role off
   * them, and the two controls sit inches apart on a phone – so the destructive one takes a second,
   * differently-worded act. The server is the guard either way; this only stops a slip.
   */
  const [confirmingRemoval, setConfirmingRemoval] = useState<string | null>(null);

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<GrantableRole>('PresenterFacilitator');
  /** The session each member's assign control is pointing at, keyed by their `sub`. */
  const [chosenSession, setChosenSession] = useState<Record<string, string>>({});

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    fetchRoster(conferenceId, controller.signal)
      .then((roster) => {
        if (active) setState({ kind: 'ready', roster });
      })
      .catch((error: unknown) => {
        if (!active || controller.signal.aborted) return;
        setState({ kind: 'failed', message: messageOf(error) });
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [conferenceId]);

  /**
   * Every mutation answers with the whole roster, so the list reflects what the server holds rather
   * than a locally patched guess – which is what makes a role change visible immediately and
   * correctly, including the session assignments a revocation takes with it.
   */
  const apply = useCallback(async (action: () => Promise<ConferenceRoster>): Promise<void> => {
    setBusy(true);
    setRefusal(null);
    try {
      setState({ kind: 'ready', roster: await action() });
    } catch (error) {
      // The server's sentence, not ours.
      setRefusal(messageOf(error));
    } finally {
      setBusy(false);
    }
  }, []);

  const roster = state.kind === 'ready' ? state.roster : null;

  function sessionTitle(sessionId: string): string {
    return roster?.sessions.find((session) => session.id === sessionId)?.title ?? sessionId;
  }

  /** The sessions this member does not already cover – the only ones worth offering. */
  function assignable(member: ConferenceMember): ConferenceRoster['sessions'] {
    return (roster?.sessions ?? []).filter((session) => !member.sessionIds.includes(session.id));
  }

  return (
    <section className="panel" aria-labelledby="members-title" data-testid="members-panel">
      <div className="panel__header">
        <h2 className="panel__title" id="members-title">
          Members and roles
        </h2>
      </div>

      <p className="panel__hint">
        Everyone who joins this conference is an attendee. Admin and presenter/facilitator are added
        on top, and apply to this conference only – they say nothing about any other.
      </p>

      {state.kind === 'loading' ? <p className="panel__hint">Loading the members…</p> : null}

      {state.kind === 'failed' ? (
        <div className="alert" role="alert" data-testid="members-error">
          {state.message}
        </div>
      ) : null}

      {refusal !== null ? (
        <div className="alert" role="alert" data-testid="members-refusal">
          {refusal}
        </div>
      ) : null}

      {readOnly ? (
        <p className="panel__hint" data-testid="members-read-only">
          This conference is archived, so its roles can no longer be changed. Nothing has been
          deleted – who ran what is still here.
        </p>
      ) : null}

      {roster !== null ? (
        <ul className="member-list">
          {roster.members.map((member) => (
            <li className="member-card" key={member.sub} data-testid={`member-${member.sub}`}>
              <div className="member-card__who">
                <span className="member-card__name">{member.displayName}</span>
                <span className="member-card__email">{member.email}</span>
              </div>

              <ul className="member-card__roles">
                {member.roles.map((held) => (
                  <li key={held}>
                    <span className={`badge badge--role-${held.toLowerCase()}`}>
                      {roleLabel(held)}
                    </span>
                    {isRevocable(held) && !readOnly ? (
                      <button
                        className="button button--small"
                        type="button"
                        disabled={busy}
                        data-testid={`revoke-${member.sub}-${held}`}
                        onClick={() => void apply(() => revokeRole(conferenceId, member.sub, held))}
                      >
                        Remove
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>

              {/*
               * Removing the person from the conference, as opposed to taking a role off them.
               * Offered on every member: the last admin is refused by the server, not hidden here,
               * because hiding it would leave an organizer with no explanation of why they cannot.
               */}
              {readOnly ? null : confirmingRemoval === member.sub ? (
                <div
                  className="confirm"
                  role="group"
                  aria-label="Confirm removal"
                  data-testid={`remove-confirm-${member.sub}`}
                >
                  <p className="confirm__question">
                    Remove {member.displayName} from this conference? They will lose access to it
                    and any roles they hold here. Nothing they contributed is deleted, and they can
                    join again with the code.
                  </p>
                  <p className="confirm__actions">
                    <button
                      className="button button--small button--danger"
                      type="button"
                      disabled={busy}
                      data-testid={`remove-member-confirm-${member.sub}`}
                      onClick={() => {
                        setConfirmingRemoval(null);
                        void apply(() => removeMember(conferenceId, member.sub));
                      }}
                    >
                      Yes, remove
                    </button>
                    <button
                      className="button button--small"
                      type="button"
                      disabled={busy}
                      data-testid={`remove-member-cancel-${member.sub}`}
                      onClick={() => setConfirmingRemoval(null)}
                    >
                      Cancel
                    </button>
                  </p>
                </div>
              ) : (
                <p className="member-card__remove">
                  <button
                    className="button button--small"
                    type="button"
                    disabled={busy}
                    data-testid={`remove-member-${member.sub}`}
                    onClick={() => {
                      setRefusal(null);
                      setConfirmingRemoval(member.sub);
                    }}
                  >
                    Remove from conference
                  </button>
                </p>
              )}

              {/*
               * A member's session assignments, on their own row. Shown for everybody who has any –
               * revoking the role takes them with it, so an empty list here is the honest answer
               * rather than a hidden one.
               */}
              <div className="member-card__sessions">
                <span className="member-card__label">Sessions</span>
                {member.sessionIds.length === 0 ? (
                  <span className="member-card__none" data-testid={`sessions-${member.sub}`}>
                    None
                  </span>
                ) : (
                  <ul className="member-card__session-list" data-testid={`sessions-${member.sub}`}>
                    {member.sessionIds.map((sessionId) => (
                      <li key={sessionId}>
                        <span>{sessionTitle(sessionId)}</span>
                        {readOnly ? null : (
                          <button
                            className="button button--small"
                            type="button"
                            disabled={busy}
                            data-testid={`unassign-${member.sub}-${sessionId}`}
                            onClick={() =>
                              void apply(() =>
                                unassignSessionHolder(conferenceId, sessionId, member.sub),
                              )
                            }
                          >
                            Remove
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/*
               * Offered only to holders of the role, because that is the server's precondition –
               * assigning anybody else is refused, and offering it would be an affordance that
               * cannot work. Assignment is not gated on publishing: a session may be assigned at
               * any point during the conference.
               */}
              {!readOnly &&
              member.roles.includes('PresenterFacilitator') &&
              assignable(member).length > 0 ? (
                <p className="member-card__assign">
                  <label className="field__label" htmlFor={`assign-${member.sub}`}>
                    Assign a session
                  </label>
                  <select
                    className="field__input"
                    id={`assign-${member.sub}`}
                    value={chosenSession[member.sub] ?? ''}
                    onChange={(event) =>
                      setChosenSession((current) => ({
                        ...current,
                        [member.sub]: event.target.value,
                      }))
                    }
                  >
                    <option value="">Choose a session…</option>
                    {assignable(member).map((session) => (
                      <option key={session.id} value={session.id}>
                        {session.title} – {session.day} {session.startTime}
                      </option>
                    ))}
                  </select>
                  <button
                    className="button"
                    type="button"
                    disabled={busy || !chosenSession[member.sub]}
                    data-testid={`assign-${member.sub}`}
                    onClick={() => {
                      const sessionId = chosenSession[member.sub];
                      if (sessionId === undefined || sessionId === '') return;
                      void apply(() => assignSessionHolder(conferenceId, sessionId, member.sub));
                    }}
                  >
                    Assign
                  </button>
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {roster !== null && !readOnly ? (
        <form
          className="grant-form"
          data-testid="grant-form"
          onSubmit={(event) => {
            event.preventDefault();
            void apply(() => grantRole(conferenceId, email, role)).then(() => setEmail(''));
          }}
        >
          <div className="field">
            <label className="field__label" htmlFor="grant-email">
              Company email address
            </label>
            <input
              className="field__input"
              id="grant-email"
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            {/*
             * The address identifies the person; it is not what gets stored. The server resolves it
             * to their account and keys the role on that, so a later address change leaves the role
             * exactly where it was.
             */}
            <p className="field__hint">
              They must have signed in to confApp at least once, and already joined this conference.
            </p>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="grant-role">
              Role
            </label>
            <select
              className="field__input"
              id="grant-role"
              value={role}
              onChange={(event) => setRole(event.target.value as GrantableRole)}
            >
              <option value="PresenterFacilitator">Presenter/Facilitator</option>
              <option value="Admin">Admin</option>
            </select>
          </div>

          <p className="grant-form__actions">
            <button
              className="button button--primary"
              type="submit"
              disabled={busy}
              data-testid="grant-role"
            >
              {busy ? 'Working…' : 'Give role'}
            </button>
          </p>
        </form>
      ) : null}
    </section>
  );
}
