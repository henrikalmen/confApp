import { resolveWebBaseUrl } from '../config.ts';
import type { ServerNow } from '../clock/effective-clock.ts';
import { ApiError, apiRequest } from './request.ts';
import type { Category, PostIt, Uncategorised } from './board.ts';

/*
 * **The transport and the Board projection live next door, and are re-exported from here.**
 *
 * S07 lifted them out (2026-08-31, review H2): the projected Board View is downloaded by a room
 * machine with no Workspace session, and importing this module for one anonymous `GET` handed that
 * machine `castVote`, the Join Code helpers and every other authenticated endpoint in the chunk it
 * serves. The display surface now imports `./request.ts` and `./board.ts` directly and reaches
 * nothing it cannot call.
 *
 * Everything they export is re-exported here unchanged, so every existing importer of
 * `api/client.ts` keeps working and no other file had to move.
 */
export * from './request.ts';
export * from './board.ts';

export interface Health {
  status: string;
  schemaVersion: string | null;
  serverTime: string;
}

export interface Me {
  sub: string;
  userId: string;
  email: string;
  displayName: string;
  hd: string;
}

/**
 * Whether a body is recognisably **our** `/health`, rather than merely a 200.
 *
 * Shape, not value: `status` is checked for being a string and not for being `'ok'`. The question
 * this route answers for the renewal path is "did the API reply", and an API replying that it is
 * degraded has replied. Gating on the value would refuse a reachable-but-unhealthy server.
 */
function isHealth(body: unknown): body is Health {
  if (typeof body !== 'object' || body === null) return false;
  const candidate = body as { status?: unknown; serverTime?: unknown };
  return typeof candidate.status === 'string' && typeof candidate.serverTime === 'string';
}

/**
 * The one anonymous route: a readiness signal that must answer before anyone is signed in.
 *
 * **It validates its own answer, and it is the only endpoint helper that does.** That is not
 * fussiness – it is the app's reachability oracle, and `AuthProvider` fires a *top-level
 * navigation* to Google on the strength of it. A captive portal is the exact adversary the offline
 * work is built around, and a portal answers: it returns `200 text/html` for whatever is asked.
 * `apiRequest` casts response bodies without validating them and turns an unparseable body into
 * `null`, so without this the portal's login page reads as proof the API is up, and confApp leaves
 * a perfectly good cached schedule for a page that cannot load (review 2026-08-25, H-3).
 *
 * Every other endpoint can survive a portal's answer because its failure is recoverable – a bad
 * shape lands in a cache guard or a render fallback and the person can retry. Leaving the app is
 * not recoverable, which is why the check is here and not spread across the client.
 */
export async function fetchHealth(signal?: AbortSignal): Promise<Health> {
  const body = await apiRequest<unknown>('/health', {
    authenticated: false,
    ...(signal ? { signal } : {}),
  });

  if (!isHealth(body)) {
    // Status 0, like every other "this never reached our API" case, so the existing `unreachable`
    // classification keeps working and no caller needs a new branch.
    throw new ApiError(
      'UNRECOGNISED_RESPONSE',
      'Something answered on the network, but it was not the confApp API.',
      0,
    );
  }

  return body;
}

export async function fetchMe(signal?: AbortSignal): Promise<Me> {
  return apiRequest<Me>('/me', signal ? { signal } : {});
}

// ---------- conferences (S03) ----------

export type LifecycleState = 'draft' | 'published' | 'archived';

export interface Conference {
  id: string;
  name: string;
  /** Naive calendar dates, 'YYYY-MM-DD'. Never parsed through `new Date` – see below. */
  startDate: string;
  endDate: string;
  lifecycleState: LifecycleState;
  /** The row version S09 will send back as the base of an edit. */
  updatedAt: string;
}

export interface ConferenceDetailsInput {
  name: string;
  startDate: string;
  endDate: string;
}

/**
 * The **Organizer** list: the conferences the signed-in employee holds a role in, drafts included.
 *
 * The attendee's list of joined conferences is a different result set at `/me/conferences` and
 * belongs to S06 – two intended endpoints, not one overloaded one.
 */
export async function fetchConferences(signal?: AbortSignal): Promise<Conference[]> {
  const body = await apiRequest<{ conferences: Conference[] }>(
    '/conferences',
    signal ? { signal } : {},
  );
  return body.conferences;
}

export async function fetchConference(id: string, signal?: AbortSignal): Promise<Conference> {
  return apiRequest<Conference>(`/conferences/${id}`, signal ? { signal } : {});
}

export async function createConference(details: ConferenceDetailsInput): Promise<Conference> {
  return apiRequest<Conference>('/conferences', { method: 'POST', body: details });
}

export async function updateConference(
  id: string,
  details: ConferenceDetailsInput,
  base: WriteBase,
): Promise<Conference> {
  return apiRequest<Conference>(`/conferences/${id}`, {
    method: 'PATCH',
    body: { ...details, base },
  });
}

/**
 * Publish and archive send no body: what they mean is entirely in the endpoint, and the server
 * decides whether the move is legal from the conference's stored state. The client never asserts
 * that a transition is allowed – it asks, and renders the refusal if there is one.
 */
export async function publishConference(id: string): Promise<Conference> {
  return apiRequest<Conference>(`/conferences/${id}/publish`, { method: 'POST' });
}

export async function archiveConference(id: string): Promise<Conference> {
  return apiRequest<Conference>(`/conferences/${id}/archive`, { method: 'POST' });
}

// ---------- join code access (S05) ----------

/** What the server says when a code resolved: which conference the employee just joined. */
export interface JoinedConference {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  lifecycleState: LifecycleState;
}

/** The Organizer's view of their conference's code. `joinCode` is null until it is published. */
export interface ConferenceJoinCode {
  conferenceId: string;
  joinCode: string | null;
  lifecycleState: LifecycleState;
}

/**
 * Joining by code. Not nested under a conference id: the code is what *selects* the conference, so
 * the client has no id to send – which is the whole point of a code read off a slide.
 *
 * The value is sent as typed. Trimming, hyphens and case are the server's business (one
 * normalization, shared by the join, re-join and refusal paths), and a second copy of that rule here
 * is how "K7RM-4P works in the browser but not on the phone" happens.
 */
export async function joinConference(code: string): Promise<JoinedConference> {
  const body = await apiRequest<{ conference: JoinedConference }>('/join', {
    method: 'POST',
    body: { code },
  });
  return body.conference;
}

export async function fetchJoinCode(
  conferenceId: string,
  signal?: AbortSignal,
): Promise<ConferenceJoinCode> {
  return apiRequest<ConferenceJoinCode>(
    `/conferences/${conferenceId}/join-code`,
    signal ? { signal } : {},
  );
}

/**
 * A new code. Sends no body: what it means is entirely in the endpoint, and the previous code stops
 * working from the server's next request onwards. No attendee is removed.
 */
export async function regenerateJoinCode(conferenceId: string): Promise<ConferenceJoinCode> {
  return apiRequest<ConferenceJoinCode>(`/conferences/${conferenceId}/join-code/regenerate`, {
    method: 'POST',
  });
}

// ---------- schedule composition (S04) ----------

export type SessionKind = 'Presentation' | 'Workshop';

export interface Session {
  id: string;
  conferenceId: string;
  title: string;
  description: string | null;
  kind: SessionKind;
  /**
   * Naive wall-clock values: a calendar day and two 24-hour times, exactly as authored. Never
   * parsed through `new Date` – see `../schedule/wall-clock-time.ts` for why that would move a
   * 09:00 session for anyone whose browser is not in the API's timezone.
   */
  day: string;
  startTime: string;
  endTime: string;
  location: string;
  /** The row version S09 will send back as the base of an edit. This one *is* an instant. */
  lastUpdatedAt: string;
}

export interface SessionDetailsInput {
  title: string;
  description?: string | null;
  kind: SessionKind;
  day: string;
  startTime: string;
  endTime: string;
  location: string;
}

/** A Conference Day and the Sessions on it, in start-time order. Empty days are present. */
export interface ScheduleDay {
  day: string;
  sessions: Session[];
}

/** Two Sessions that run at the same time – a Parallel Track, not a problem. */
export interface OverlapPair {
  sessionIds: [string, string];
}

export interface OrganizerSchedule {
  conference: {
    id: string;
    name: string;
    startDate: string;
    endDate: string;
    lifecycleState: LifecycleState;
    /** The whole-schedule watermark. S10 will use it as a cache cursor. */
    lastUpdatedAt: string | null;
  };
  days: ScheduleDay[];
  overlaps: OverlapPair[];
}

/**
 * The warning that accompanies a **successful** save of an overlapping session.
 *
 * Never a refusal: parallel tracks are a supported option, so an overlapping session saves and is
 * reported, rather than being rejected (FR2).
 */
export interface OverlapWarning {
  code: string;
  message: string;
  sessions: { id: string; title: string; startTime: string; endTime: string }[];
}

export interface SavedSession {
  session: Session;
  overlapWarning: OverlapWarning | null;
}

/**
 * The **Organizer's** composition view. S06 owns the attendee read at `/conferences/{id}/schedule`
 * – same resource, two audiences, two intended endpoints.
 */
export async function fetchOrganizerSchedule(
  conferenceId: string,
  signal?: AbortSignal,
): Promise<OrganizerSchedule> {
  return apiRequest<OrganizerSchedule>(
    `/conferences/${conferenceId}/schedule/organizer`,
    signal ? { signal } : {},
  );
}

export async function createSession(
  conferenceId: string,
  details: SessionDetailsInput,
): Promise<SavedSession> {
  return apiRequest<SavedSession>(`/conferences/${conferenceId}/sessions`, {
    method: 'POST',
    body: details,
  });
}

/**
 * The version of the world an edit was composed against (S09 TI04, TI05).
 *
 * Both halves are sent on every edit and delete. `version` is the row version the editor loaded –
 * `session.lastUpdatedAt` or `conference.updatedAt` – and `conferenceState` is the lifecycle state
 * it was loaded in, which is the only way a publish or archive landing mid-edit can be told apart
 * from an ordinary version conflict. Neither has a default: a write with no base is refused rather
 * than treated as a force-write.
 */
export interface WriteBase {
  conferenceState: LifecycleState;
  version: string;
}

export async function updateSession(
  conferenceId: string,
  sessionId: string,
  details: SessionDetailsInput,
  base: WriteBase,
): Promise<SavedSession> {
  return apiRequest<SavedSession>(`/conferences/${conferenceId}/sessions/${sessionId}`, {
    method: 'PATCH',
    body: { ...details, base },
  });
}

export async function deleteSession(
  conferenceId: string,
  sessionId: string,
  base: WriteBase,
): Promise<void> {
  const query = `?conferenceState=${base.conferenceState}&version=${encodeURIComponent(base.version)}`;
  await apiRequest<{ deleted: string }>(
    `/conferences/${conferenceId}/sessions/${sessionId}${query}`,
    { method: 'DELETE' },
  );
}

// ---------- attendee schedule view (S06) ----------

/**
 * One Conference in the attendee's picker. A different result set from `fetchConferences` above,
 * from a different endpoint: joined conferences that are published or archived, never a draft.
 */
export interface AttendeeConference {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  state: LifecycleState;
}

/**
 * The list plus the server's choice of default.
 *
 * `defaultConferenceId` is named by the server rather than implied by list order: "the one running
 * today, else the most recently joined" is decided against the *server's* calendar day, and a
 * client re-deriving it would need the same rule in the browser, the Android shell and the iOS one.
 */
export interface AttendeeConferences {
  conferences: AttendeeConference[];
  defaultConferenceId: string | null;
}

/** One Session as an Attendee reads it – no row version, because an attendee edits nothing. */
export interface AttendeeSession {
  id: string;
  title: string;
  description: string | null;
  kind: SessionKind;
  /** Naive wall-clock strings, exactly as authored. Never parsed through a `Date`. */
  startTime: string;
  endTime: string;
  location: string;
  /**
   * The Sessions this one runs at the same time as – a Parallel Track. Symmetric, and computed by
   * the server on every read so it cannot go stale. Presentational only: there is no Personal
   * Agenda and nothing to choose between concurrent Sessions (FR4, FR6).
   */
  concurrentWith: string[];
}

export interface AttendeeScheduleDay {
  date: string;
  /** 1-based position in the span, so a day can be labelled without calendar arithmetic. */
  dayNumber: number;
  sessions: AttendeeSession[];
}

/**
 * The schedule envelope – the shared decision S06 produces, S09 replaces wholesale and S10 caches
 * verbatim.
 *
 * Self-contained on purpose: the whole view renders from this one object with no further request,
 * which is what lets S10 hand the same component tree a cached copy with no network available.
 *
 * `serverNow` carries the server's reading in both frames, and `conference.lastUpdatedAt` is an
 * **instant** – to be shown as an elapsed age ("updated 4 minutes ago"), never as an absolute wall
 * clock, because deriving one on the client needs the timezone conversion this whole representation
 * exists to avoid. This story carries it and acts on it in no other way.
 */
export interface AttendeeSchedule {
  conference: {
    id: string;
    name: string;
    startDate: string;
    endDate: string;
    state: LifecycleState;
    lastUpdatedAt: string | null;
  };
  days: AttendeeScheduleDay[];
  serverNow: ServerNow;
}

/**
 * The two scalars an open Schedule polls for (S09 TI01).
 *
 * Deliberately tiny: this is the request every attendee's phone makes every few seconds for the
 * length of a conference. The client compares `lastUpdatedAt` with the value on the envelope it is
 * already rendering and refetches the schedule only when it has moved, so the steady state costs
 * one small read per client per tick.
 */
export interface ScheduleWatermark {
  /** S04's schedule watermark – an instant, and the same value the envelope carries. */
  lastUpdatedAt: string | null;
  state: LifecycleState;
}

export async function fetchScheduleWatermark(
  conferenceId: string,
  signal?: AbortSignal,
): Promise<ScheduleWatermark> {
  return apiRequest<ScheduleWatermark>(
    `/conferences/${conferenceId}/schedule/watermark`,
    signal ? { signal } : {},
  );
}

export async function fetchMyConferences(signal?: AbortSignal): Promise<AttendeeConferences> {
  return apiRequest<AttendeeConferences>('/me/conferences', signal ? { signal } : {});
}

/**
 * The attendee read. `/schedule`, not `/schedule/organizer` – same resource, two audiences, two
 * intended endpoints.
 */
export async function fetchAttendeeSchedule(
  conferenceId: string,
  signal?: AbortSignal,
): Promise<AttendeeSchedule> {
  return apiRequest<AttendeeSchedule>(
    `/conferences/${conferenceId}/schedule`,
    signal ? { signal } : {},
  );
}

// ---------- per-conference roles (S07) ----------

/**
 * The three roles, exactly as the API names them. Presenter/Facilitator is **one** role – the two
 * words describe what the holder is doing, not different permissions – so there is one value here,
 * not two, and `roleLabel` below is the only place the slash appears.
 */
export type ConferenceRole = 'Admin' | 'PresenterFacilitator' | 'Attendee';

/** The two an Admin can hand out. Attendee is not granted: it *is* membership, written by joining. */
export type GrantableRole = 'Admin' | 'PresenterFacilitator';

export interface ConferenceMember {
  sub: string;
  displayName: string;
  /** Display data, so an Admin can tell two people apart. Never a key. */
  email: string;
  roles: ConferenceRole[];
  /** The sessions this member may run and edit. */
  sessionIds: string[];
}

/** One session as the roster sees it, with the members assigned to run it. */
export interface RosterSession {
  id: string;
  title: string;
  kind: SessionKind;
  day: string;
  startTime: string;
  endTime: string;
  holders: string[];
}

/**
 * The whole member surface in one payload: both directions of the same three tables.
 *
 * The server returns it from every mutation as well as the read, so what is on screen after a
 * grant is what the server holds rather than what the client assumed.
 */
export interface ConferenceRoster {
  conferenceId: string;
  lifecycleState: LifecycleState;
  members: ConferenceMember[];
  sessions: RosterSession[];
}

/** The one place the two words appear – as a label, never as two roles. */
export function roleLabel(role: ConferenceRole): string {
  return role === 'PresenterFacilitator' ? 'Presenter/Facilitator' : role;
}

export async function fetchRoster(
  conferenceId: string,
  signal?: AbortSignal,
): Promise<ConferenceRoster> {
  return apiRequest<ConferenceRoster>(
    `/conferences/${conferenceId}/members`,
    signal ? { signal } : {},
  );
}

/**
 * Granting, by the address the Admin types.
 *
 * The address is a lookup input only: the server resolves it to the person's stable `sub` and
 * stores that. It refuses with its own message when nobody has signed in under that address, when
 * more than one account uses it, and when the person has not joined the conference – three
 * different situations, so the panel renders whichever sentence comes back rather than one of its
 * own.
 */
export async function grantRole(
  conferenceId: string,
  email: string,
  role: GrantableRole,
): Promise<ConferenceRoster> {
  return apiRequest<ConferenceRoster>(`/conferences/${conferenceId}/members/roles`, {
    method: 'POST',
    body: { email, role },
  });
}

/** Revoking, by the `sub` the member list carries. The membership itself is untouched. */
export async function revokeRole(
  conferenceId: string,
  userSub: string,
  role: GrantableRole,
): Promise<ConferenceRoster> {
  return apiRequest<ConferenceRoster>(
    `/conferences/${conferenceId}/members/${encodeURIComponent(userSub)}/roles/${role}`,
    { method: 'DELETE' },
  );
}

export async function assignSessionHolder(
  conferenceId: string,
  sessionId: string,
  userSub: string,
): Promise<ConferenceRoster> {
  return apiRequest<ConferenceRoster>(
    `/conferences/${conferenceId}/sessions/${sessionId}/assignments`,
    { method: 'POST', body: { userSub } },
  );
}

export async function unassignSessionHolder(
  conferenceId: string,
  sessionId: string,
  userSub: string,
): Promise<ConferenceRoster> {
  return apiRequest<ConferenceRoster>(
    `/conferences/${conferenceId}/sessions/${sessionId}/assignments/${encodeURIComponent(userSub)}`,
    { method: 'DELETE' },
  );
}

// ---------- membership management (S08) ----------

/**
 * Ending your own membership of a conference.
 *
 * No target is sent, and there is nowhere to put one: the server revokes the *caller's* membership,
 * resolved from their verified `sub`. A client that could name somebody else would be one request
 * away from being an unauthorized removal endpoint.
 *
 * The confirmation the person gives before this is called lives entirely in the client. The API is
 * a horizontally replicated container with no request affinity (ADR-004), so a server-side "pending
 * leave" would be held on one replica and absent from the next.
 */
export async function leaveConference(conferenceId: string): Promise<void> {
  await apiRequest<{ conferenceId: string; membership: string }>(
    `/conferences/${conferenceId}/membership`,
    { method: 'DELETE' },
  );
}

/**
 * Removing a member, by the `sub` the member list carries.
 *
 * Answers with the whole roster like every other member mutation, so the list on screen is what the
 * server holds. Removing somebody who is not a member succeeds and changes nothing – a repeated or
 * mistaken removal is not an error (FR6 → Error Handling), so the roster simply comes back as it
 * was.
 */
export async function removeMember(
  conferenceId: string,
  userSub: string,
): Promise<ConferenceRoster> {
  return apiRequest<ConferenceRoster>(
    `/conferences/${conferenceId}/members/${encodeURIComponent(userSub)}`,
    { method: 'DELETE' },
  );
}

// ---------- session activities: rounds (S01) ----------

/**
 * The two Activities a Session can run, and what a Voting Round is *for*.
 *
 * `Poll` is a **purpose**, never a kind (`docs/UBIQUITOUS_LANGUAGE.md`). Keeping the two levels
 * apart here is what makes the deferred Prioritization and Rating purposes an addition to
 * `RoundPurpose` rather than a rewrite of `RoundKind`.
 */
export type RoundKind = 'PostItRound' | 'VotingRound';
export type RoundPurpose = 'Poll';
export type RoundState = 'open' | 'closed';

/** One answer option of a Poll. Ordered by the payload; nothing here re-sorts them. */
export interface RoundOption {
  id: string;
  label: string;
}

/**
 * One Round as the Session read returns it.
 *
 * `purpose` is present exactly on a `VotingRound` and `options` exactly on one too – the payload
 * says the same thing the table's own constraint says. The Board – `categories`, `uncategorised`
 * and `textMaxLength` – is present exactly on a `PostItRound`, for the same reason.
 *
 * **There is no cursor here, of any name.** Near-live propagation for Rounds is
 * `round.activity_watermark`, and it reaches this client as one Session-level scalar
 * (`SessionWithRounds.activityWatermark`) and the two-scalar poll beside the read. A cursor on
 * *this* type would be a per-Round one - the second mechanism the plan's shared decision removed.
 */
export interface Round {
  id: string;
  kind: RoundKind;
  purpose?: RoundPurpose;
  /** The Post-it Round's prompt, or the Poll's question. */
  prompt: string;
  state: RoundState;
  options?: RoundOption[];
  /**
   * The Board's Categories, **in the Facilitator's order**, each with the Post-its it holds.
   *
   * The order is the payload's order and nothing here re-sorts them - the same discipline as a
   * Poll's options. Present exactly on a `PostItRound` the Session read loaded a board for; `[]`
   * on a Board nobody has sorted yet, which is a real state and not a missing one.
   */
  categories?: Category[];
  /**
   * The holding area every Post-it arrives in, **always present beside `categories`** - including
   * when it is empty and when the Board has no Category at all.
   *
   * It carries no `id`, no `name` and no `position`, deliberately: Uncategorised is not a Category
   * and nothing addresses it, so there is no rename, reorder or remove for this client to offer and
   * no identifier it could send if there were.
   */
  uncategorised?: Uncategorised;
  /**
   * How long a Post-it may be, **as the server states it**.
   *
   * The client never carries this number. The cap has exactly one authoritative definition -
   * `POST_IT_MAX_LENGTH` on the API's Post-it validation module - and this field is how it reaches
   * the compose box. A literal here, or anywhere under `web/`, would be a second source that could
   * disagree with the rule actually being enforced.
   */
  textMaxLength?: number;
  /**
   * Whether **the signed-in viewer** has voted in this Poll. The server's answer, consumed rather
   * than re-derived, exactly as `canRun` and `mine` are.
   *
   * It is the only per-person fact about voting that exists anywhere on the wire, and it is about
   * the viewer alone. There is no field here - and no endpoint - that says whether somebody *else*
   * voted, let alone what they chose: a Vote is never linkable to its voter through any application
   * path (`AGENTS.md`;
   * `docs/adrs/ADR-006-vote-anonymity-holds-against-application-paths-not-database-credentials.md`).
   *
   * Present exactly on a `VotingRound` the Session read looked it up for; absent on the authoring
   * and run-control responses, which ask nothing of the vote tables.
   */
  hasVoted?: boolean;
  /**
   * Counts per option - the only Vote-shaped value this client can ever receive.
   *
   * Present only where the server permits it: to a Session Assignment holder while the Poll runs,
   * and to every Member once it has closed. For an Attendee looking at an open Poll the key is
   * simply **absent**, which is not the same as a tally of zeroes - a zero would be a statement
   * about the votes, and the client must not manufacture one.
   */
  tally?: OptionTally[];
}

/** One option's count. Nothing about who chose it, because nothing about that is knowable here. */
export interface OptionTally {
  optionId: string;
  votes: number;
}

/** What the authoring form sends. The acting identity is never in here – it is the credential. */
export interface RoundDetailsInput {
  kind: RoundKind;
  purpose?: RoundPurpose | null;
  prompt: string;
  options?: string[];
}

/**
 * A Session with its Rounds and this caller's authority over them, in **one** request.
 *
 * `canRun` is the server's answer, consumed rather than re-derived: the client never holds a second
 * opinion about who may work the run controls.
 */
export interface SessionWithRounds {
  session: Session;
  rounds: Round[];
  canRun: boolean;
  /**
   * Whether this caller may **permanently remove** a Post-it here (S06 FR5) – the server's answer,
   * consumed and never re-derived.
   *
   * A second flag rather than a widening of `canRun`, because `canRun` is true for an assigned
   * Facilitator and for an Admin alike and this act is the one they differ on. It folds the
   * Conference's editability in exactly as `canRun` does, so it means "this control will work"
   * rather than "you would be allowed if anything here were writable".
   *
   * The client holds no opinion about who is an Admin: there is no role name, no rank comparison
   * and no Admin test anywhere under `web/`. It renders from this and the API enforces the same
   * decision again on the write, which is what makes the rule server-side rather than hidden in a
   * UI (Binding Constraint FR5).
   */
  canRemovePermanently: boolean;
  /**
   * The Session's activity cursor, beside the payload it describes.
   *
   * The same arrangement as S06's schedule envelope, which carries `conference.lastUpdatedAt`
   * beside the Sessions it lists: a Member without a Session Assignment compares the poll's scalar
   * against this one and refetches only when the two differ. `null` for a Session with no Round at
   * all.
   *
   * **An opaque counter, and never a time.** The server sends the decimal digits of a database
   * sequence value; there is no instant in it to parse, format or subtract, and the name no longer
   * ends in `At` precisely so that nothing here reaches for `new Date`. It used to be a
   * microsecond timestamp, which handed every Member the instant of every Vote in a Poll they are
   * refused the running tally of - see
   * `db/migrations/20260829120000000_activity-watermark-counter.sql`.
   *
   * **And a Vote does not move it at all** (ADR-007,
   * `db/migrations/20260831090000000_vote-advances-no-cursor.sql`). The value is scoped to one
   * Session, so on a Session running only a Poll every movement of it was a ballot arriving,
   * whatever the value itself said. A holder's tally therefore has no change signal behind it and
   * is re-read on every tick instead - see `activities/SessionActivitiesPanel.tsx`.
   */
  activityWatermark: string | null;
}

/**
 * The two scalars an open Session view polls (S02 TI07).
 *
 * The same *shape* as `ScheduleWatermark`, for the same reasons: this is the request every phone in
 * a workshop makes every few seconds, so it carries no Round and no Post-it content and the client
 * pays for the Session payload only when the value has actually moved.
 *
 * Not the same *kind of value*, which is why the field is not called `lastUpdatedAt`. The
 * Schedule's is a real instant S09 also compares as a concurrency base; this one is a counter, and
 * the only question ever asked of it is whether it differs from the one already on screen.
 */
export interface ActivityWatermark {
  /** The highest `round.activity_watermark` across the Session's Rounds. Digits, never a time. */
  activityWatermark: string | null;
  state: LifecycleState;
}

export async function fetchActivityWatermark(
  conferenceId: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<ActivityWatermark> {
  return apiRequest<ActivityWatermark>(
    `/conferences/${conferenceId}/sessions/${sessionId}/activities/watermark`,
    signal ? { signal } : {},
  );
}

export async function fetchSessionActivities(
  conferenceId: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<SessionWithRounds> {
  return apiRequest<SessionWithRounds>(
    `/conferences/${conferenceId}/sessions/${sessionId}`,
    signal ? { signal } : {},
  );
}

/**
 * The live Display Link on one Post-it Round, as its own Facilitator reads it back.
 *
 * `null` where the Round has none, which is an ordinary state and not a failure: a Board is fully
 * usable with no link ever issued.
 */
export interface DisplayLink {
  /** The value itself. Copied, never typed - 43 base64url characters. */
  token: string;
  issuedAt: string;
}

function displayLinkPath(conferenceId: string, sessionId: string, roundId: string): string {
  return `/conferences/${conferenceId}/sessions/${sessionId}/rounds/${roundId}/display-link`;
}

/**
 * The URL to hand a projector, or `null` where this build cannot state one.
 *
 * Built here rather than sent by the API, because it is a fact about *where this SPA is served*
 * and the API does not know that - the same reason `/config.js` carries the API base URL rather
 * than the reverse. The token is a path segment, never a query parameter (see `fetchDisplayBoard`).
 *
 * **Not `window.location.origin`.** Inside the Capacitor shells that is `capacitor://localhost` or
 * `https://localhost`, so a link issued from a Facilitator's phone - the device the acceptance
 * scenario names - would come out unopenable by any room machine, in a field that looks fine
 * (review 2026-08-31, finding 2). `resolveWebBaseUrl` returns `null` there instead, and the caller
 * says so rather than showing a URL nobody can use.
 */
export function displayLinkUrl(token: string): string | null {
  const base = resolveWebBaseUrl();
  return base === null ? null : `${base}/display/${encodeURIComponent(token)}`;
}

export async function fetchDisplayLink(
  conferenceId: string,
  sessionId: string,
  roundId: string,
  signal?: AbortSignal,
): Promise<DisplayLink | null> {
  const body = await apiRequest<{ displayLink: DisplayLink | null }>(
    displayLinkPath(conferenceId, sessionId, roundId),
    signal ? { signal } : {},
  );
  return body.displayLink;
}

/**
 * Issues a link, **replacing** whatever live one the Round had.
 *
 * No body: a Round holds at most one live link, so there is nothing to name and nothing to choose.
 * The acting identity is the credential and is never sent.
 */
export async function issueDisplayLink(
  conferenceId: string,
  sessionId: string,
  roundId: string,
): Promise<DisplayLink> {
  const body = await apiRequest<{ displayLink: DisplayLink }>(
    displayLinkPath(conferenceId, sessionId, roundId),
    { method: 'POST' },
  );
  return body.displayLink;
}

/** Revokes this Round's live link. Names the Round, not a link; succeeds when there was none. */
export async function revokeDisplayLink(
  conferenceId: string,
  sessionId: string,
  roundId: string,
): Promise<void> {
  await apiRequest<{ displayLink: null }>(displayLinkPath(conferenceId, sessionId, roundId), {
    method: 'DELETE',
  });
}

export async function createRound(
  conferenceId: string,
  sessionId: string,
  details: RoundDetailsInput,
): Promise<Round> {
  const body = await apiRequest<{ round: Round }>(
    `/conferences/${conferenceId}/sessions/${sessionId}/rounds`,
    { method: 'POST', body: details },
  );
  return body.round;
}

export async function updateRound(
  conferenceId: string,
  sessionId: string,
  roundId: string,
  details: RoundDetailsInput,
): Promise<Round> {
  const body = await apiRequest<{ round: Round }>(
    `/conferences/${conferenceId}/sessions/${sessionId}/rounds/${roundId}`,
    { method: 'PATCH', body: details },
  );
  return body.round;
}

/**
 * Opening and closing send no body: what they mean is entirely in the endpoint, and the server
 * decides whether the move is legal from the Round's stored state. The client never asserts that a
 * transition is allowed – it asks, and renders the refusal if there is one.
 */
export async function openRound(
  conferenceId: string,
  sessionId: string,
  roundId: string,
): Promise<Round> {
  const body = await apiRequest<{ round: Round }>(
    `/conferences/${conferenceId}/sessions/${sessionId}/rounds/${roundId}/open`,
    { method: 'POST' },
  );
  return body.round;
}

export async function closeRound(
  conferenceId: string,
  sessionId: string,
  roundId: string,
): Promise<Round> {
  const body = await apiRequest<{ round: Round }>(
    `/conferences/${conferenceId}/sessions/${sessionId}/rounds/${roundId}/close`,
    { method: 'POST' },
  );
  return body.round;
}

/**
 * Contributing, correcting and removing a Post-it.
 *
 * **None of these sends an author.** Authorship is taken from the credential server-side and from
 * nowhere else (Binding Constraint FR3), so there is no author parameter to pass and no field on
 * the request the caller could get wrong. `text` is the whole body.
 */
function postItPath(
  conferenceId: string,
  sessionId: string,
  roundId: string,
  postItId?: string,
): string {
  const board = `/conferences/${conferenceId}/sessions/${sessionId}/rounds/${roundId}/post-its`;
  return postItId === undefined ? board : `${board}/${postItId}`;
}

/**
 * Casting a Vote.
 *
 * Carries the chosen option and nothing else. The voter is the credential on the request, decided
 * entirely server-side - there is no parameter here for one, which is the client half of "author
 * identity is taken from the authenticated credential, never from the request body".
 *
 * Resolves to nothing at all. The server answers that the Vote landed and never a tally, so there
 * is no value to return and no way for a cast to become a second, ungated route to the result. A
 * refused cast throws `ApiError`, whose `message` is the sentence the voter reads.
 */
export async function castVote(
  conferenceId: string,
  sessionId: string,
  roundId: string,
  optionId: string,
): Promise<void> {
  await apiRequest<{ voted: boolean }>(
    `/conferences/${conferenceId}/sessions/${sessionId}/rounds/${roundId}/votes`,
    { method: 'POST', body: { optionId } },
  );
}

/**
 * Which submission a contribution is, and how it reached the API (FR6).
 *
 * **`submissionId` is minted once per composed idea and rides every attempt at it** – the first
 * send *and* any retry after a queued wait. That is deliberate and it is the whole guarantee: the
 * client cannot tell "the request never left the phone" from "the request reached the API, the row
 * was written, and the answer was lost", because both arrive as the same transport failure. Minting
 * the identity only when the item is queued would leave the first of those two cases producing a
 * second Post-it under a real name on the retry, which is exactly what FR6's "a retried send
 * produces one Post-it, not two" forbids. The server refuses the repeat through a database
 * constraint and answers with the Post-it already stored.
 *
 * `offlineComposed` is present only on an attempt at an item that *was* held, and it is what
 * unlocks the closed-Round branch server-side. It says only how this contribution reached the API;
 * whether it is *marked* as having arrived late is the server's decision from the Round's own
 * state, never this client's.
 */
export interface Submission {
  submissionId: string;
  offlineComposed?: true;
}

export async function contributePostIt(
  conferenceId: string,
  sessionId: string,
  roundId: string,
  text: string,
  submission: Submission,
): Promise<PostIt | null> {
  const body = await apiRequest<{ postIt: PostIt | null }>(
    postItPath(conferenceId, sessionId, roundId),
    {
      method: 'POST',
      body: { text, ...submission },
    },
  );
  /*
   * `null` is a success with nothing to show: this submission reached the board once and its author
   * has since removed the Post-it. The caller's job is to stop retrying, which a resolved promise
   * already tells it - there is nothing to render and nothing to refuse.
   */
  return body.postIt;
}

export async function updatePostIt(
  conferenceId: string,
  sessionId: string,
  roundId: string,
  postItId: string,
  text: string,
): Promise<PostIt> {
  const body = await apiRequest<{ postIt: PostIt }>(
    postItPath(conferenceId, sessionId, roundId, postItId),
    { method: 'PATCH', body: { text } },
  );
  return body.postIt;
}

/**
 * Sorting: moving a Post-it into a Category, or back into Uncategorised (FR3).
 *
 * **`categoryId: null` is Uncategorised** - the absence of a placement, sent as an absence rather
 * than as a reserved id. There is no sentinel value anywhere on this path, which is why moving a
 * Post-it *out* of a Category needs no second function and no direction flag.
 *
 * The body carries `categoryId` and nothing else. Who is acting is the bearer credential and is
 * decided entirely server-side, so there is no parameter here for an actor - the client half of
 * "actor identity is taken from the authenticated credential, never from the request body" (Binding
 * Constraint FR6). This client carries no opinion about *who may* place either: it asks, and renders
 * the refusal if there is one.
 *
 * **Nothing on this path is ever queued.** Sorting is online-only (`docs/PRODUCT.md` -> Anti-Goals,
 * Binding Constraint FR3): a placement that cannot be delivered rejects here, the caller says so,
 * and the Post-it stays visibly where it was. There is no submission identity, no hold and no drain
 * - unlike `contributePostIt` above, which is the one write on this surface that has somewhere to
 * go.
 */
export async function placePostIt(
  conferenceId: string,
  sessionId: string,
  roundId: string,
  postItId: string,
  categoryId: string | null,
): Promise<PostIt> {
  const body = await apiRequest<{ postIt: PostIt }>(
    `${postItPath(conferenceId, sessionId, roundId, postItId)}/placement`,
    { method: 'PATCH', body: { categoryId } },
  );
  return body.postIt;
}

export async function deletePostIt(
  conferenceId: string,
  sessionId: string,
  roundId: string,
  postItId: string,
): Promise<void> {
  await apiRequest<{ removed: boolean }>(postItPath(conferenceId, sessionId, roundId, postItId), {
    method: 'DELETE',
  });
}

/**
 * One discarded Post-it as the Facilitator's reversal surface reads it (S05 FR4).
 *
 * Two names, because the trace is what makes this not an author deletion: whose idea it was, and who
 * took it off the board. `discardedAt` is a **display string the server formatted** - the product
 * carries no venue timezone, so nothing here parses it, converts it or constructs a `Date` from it
 * (`web/src/schedule/wall-clock-time.ts` holds the same line for the schedule's times).
 *
 * There is no `mine`, no `edited` and no permanent-removal field: this is not a board, and the
 * irreversible act is Admin-only and belongs to another story.
 */
export interface DiscardedPostIt {
  id: string;
  text: string;
  authorName: string;
  discardedByName: string;
  discardedAt: string;
}

/**
 * Discard, restore, and the one list a restore is made from (FR4).
 *
 * **None of these sends who is acting**: the discarder is the bearer credential and nothing else
 * (Binding Constraint FR6), so neither write carries a body at all. **And restore names no
 * destination** - a restore always returns a Post-it to Uncategorised, so there is no parameter here
 * one could arrive through even by mistake.
 *
 * **Nothing on this path is ever queued.** Discard and restore are online-only (`docs/PRODUCT.md` ->
 * Anti-Goals, Binding Constraint FR3): a request that cannot be delivered rejects here, the caller
 * says so, and the board stays exactly as it was. There is no submission identity, no hold and no
 * drain - unlike `contributePostIt` above, which is the one write on this surface with somewhere to
 * go.
 */
export async function fetchDiscardedPostIts(
  conferenceId: string,
  sessionId: string,
  roundId: string,
  signal?: AbortSignal,
): Promise<DiscardedPostIt[]> {
  const body = await apiRequest<{ discarded: DiscardedPostIt[] }>(
    `/conferences/${conferenceId}/sessions/${sessionId}/rounds/${roundId}/discarded-post-its`,
    signal ? { signal } : {},
  );
  return body.discarded;
}

export async function discardPostIt(
  conferenceId: string,
  sessionId: string,
  roundId: string,
  postItId: string,
): Promise<void> {
  await apiRequest<{ discarded: boolean }>(
    `${postItPath(conferenceId, sessionId, roundId, postItId)}/discard`,
    { method: 'POST' },
  );
}

export async function restorePostIt(
  conferenceId: string,
  sessionId: string,
  roundId: string,
  postItId: string,
): Promise<void> {
  await apiRequest<{ restored: boolean }>(
    `${postItPath(conferenceId, sessionId, roundId, postItId)}/restore`,
    { method: 'POST' },
  );
}

/**
 * **Permanent Removal**: the Admin act that takes a Post-it off every surface for good (S06 FR5).
 *
 * Its own address - `/permanent-removal` - and emphatically not `deletePostIt` above. That one is
 * the *author's* own deletion of their *own* Post-it while the Round is open; this one is an
 * Admin's, on anybody's Post-it, at any Round state, and it cannot be undone by anyone. Two
 * functions because they are two acts, and a shared one is how a client comes to send the wrong
 * one.
 *
 * **It sends no body at all.** The acting Admin is the bearer credential and nothing else (Binding
 * Constraint FR6), and nothing about the act is recorded anywhere in any case - FR5's "no trace"
 * leaves no "removed by" for a request to name.
 *
 * **Nothing on this path is ever queued.** Permanent Removal is online-only (`docs/PRODUCT.md` ->
 * Anti-Goals, Binding Constraint FR3): a request that cannot be delivered rejects here, the caller
 * says so, and the Post-it stays visibly where it was. There is no submission identity, no hold and
 * no drain.
 *
 * **Removing a Post-it that is already gone resolves rather than rejects.** The server treats the
 * requested end state as the answer, so a second removal - or one racing an author's own delete -
 * is a success with nothing to report.
 */
export async function removePostItPermanently(
  conferenceId: string,
  sessionId: string,
  roundId: string,
  postItId: string,
): Promise<void> {
  await apiRequest<{ removed: boolean }>(
    `${postItPath(conferenceId, sessionId, roundId, postItId)}/permanent-removal`,
    { method: 'POST' },
  );
}

/**
 * The Category writes, all four of them, on one address per Category.
 *
 * None of these sends who is acting: the actor is the bearer credential and nothing else (Binding
 * Constraint FR6). None of them touches the offline queue either - sorting is online-only, so a
 * Category write that cannot be delivered fails loudly and the Board stays as it was
 * (`docs/PRODUCT.md` → Anti-Goals).
 */
function categoryPath(
  conferenceId: string,
  sessionId: string,
  roundId: string,
  categoryId?: string,
): string {
  const base = `/conferences/${conferenceId}/sessions/${sessionId}/rounds/${roundId}/categories`;
  return categoryId === undefined ? base : `${base}/${categoryId}`;
}

/**
 * What a Category write answers with: the row as it now stands, and a warning where there is one.
 *
 * `warning` rides a **success**. Two Categories on one Board may share a name - names are labels,
 * not identifiers - so the server stores the duplicate and says so, and this surface shows the
 * sentence rather than treating it as a refusal.
 */
export interface CategoryWritten {
  category: { id: string; name: string; position: number };
  warning?: string;
}

export async function createCategory(
  conferenceId: string,
  sessionId: string,
  roundId: string,
  name: string,
): Promise<CategoryWritten> {
  return apiRequest<CategoryWritten>(categoryPath(conferenceId, sessionId, roundId), {
    method: 'POST',
    body: { name },
  });
}

/** Renaming, moving in the order, or both. The server clamps a position outside the range. */
export async function updateCategory(
  conferenceId: string,
  sessionId: string,
  roundId: string,
  categoryId: string,
  change: { name?: string; position?: number },
): Promise<CategoryWritten> {
  return apiRequest<CategoryWritten>(categoryPath(conferenceId, sessionId, roundId, categoryId), {
    method: 'PATCH',
    body: change,
  });
}

/**
 * Removing a Category, and where its Post-its go.
 *
 * `destinationCategoryId: null` is **Uncategorised** - the absence of a placement, sent as an
 * absence rather than as a reserved id. Omitting `destination` altogether is the empty-Category
 * case; against an occupied one the server refuses and names the count, which is what the surface
 * turns into the "say where these go" prompt.
 */
export async function deleteCategory(
  conferenceId: string,
  sessionId: string,
  roundId: string,
  categoryId: string,
  destination?: { categoryId: string | null },
): Promise<void> {
  await apiRequest<{ removed: boolean }>(
    categoryPath(conferenceId, sessionId, roundId, categoryId),
    {
      method: 'DELETE',
      body: destination === undefined ? {} : { destinationCategoryId: destination.categoryId },
    },
  );
}
