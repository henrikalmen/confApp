import { resolveApiBaseUrl } from '../config.ts';
import type { ServerNow } from '../clock/effective-clock.ts';

/** Mirrors the API's error envelope – the shared contract in api/src/errors.ts. */
export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: { field: string; message: string }[];
  };
}

export interface ApiErrorDetail {
  field: string;
  message: string;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  /**
   * Field-level messages, when the refusal was about particular inputs. The create form attaches
   * each one to its own control, which is what "rejected inline" in FR1 means – a form-level
   * banner would leave the organizer hunting for which field to fix.
   */
  readonly details: ApiErrorDetail[];
  /**
   * What the refused thing looks like **now**, present only on a version conflict (S09 TI04).
   *
   * This is what makes "re-apply your edit onto the current version" a real recovery path rather
   * than advice: the organizer's typed values stay in the form and the server's newer values are
   * shown beside them, so nothing has to be retyped from memory.
   */
  readonly current: unknown;

  constructor(
    code: string,
    message: string,
    status = 0,
    details: ApiErrorDetail[] = [],
    current: unknown = undefined,
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.current = current;
  }

  /** The message for one field, or undefined when the refusal did not name it. */
  messageFor(field: string): string | undefined {
    return this.details.find((detail) => detail.field === field)?.message;
  }
}

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

function isEnvelope(body: unknown): body is ApiErrorEnvelope {
  if (typeof body !== 'object' || body === null) return false;
  const error = (body as { error?: unknown }).error;
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string' &&
    typeof (error as { message?: unknown }).message === 'string'
  );
}

/**
 * How a credential is obtained for a request. Supplied by the session rather than read from
 * storage here, so this module never has to know where a token lives or when it expires –
 * and so a test can drive request behaviour without a session at all.
 */
export type TokenSource = () => Promise<string | null>;

let tokenSource: TokenSource = async () => null;

export function setTokenSource(source: TokenSource): void {
  tokenSource = source;
}

export interface RequestOptions {
  signal?: AbortSignal;
  /** Anonymous routes (`/health`) skip the credential entirely rather than sending an empty one. */
  authenticated?: boolean;
  method?: string;
  body?: unknown;
}

/**
 * Every refusal arrives in one envelope, so the UI can always show `error.message` rather
 * than inventing its own wording per endpoint.
 */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { signal, authenticated = true, method = 'GET', body } = options;

  const headers: Record<string, string> = { accept: 'application/json' };

  if (authenticated) {
    const token = await tokenSource();
    if (token !== null) headers.authorization = `Bearer ${token}`;
  }
  if (body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(`${resolveApiBaseUrl()}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(signal ? { signal } : {}),
  });

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    if (isEnvelope(payload)) {
      throw new ApiError(
        payload.error.code,
        payload.error.message,
        response.status,
        payload.error.details ?? [],
        (payload.error as { current?: unknown }).current,
      );
    }
    throw new ApiError(
      'UNEXPECTED_RESPONSE',
      `The server responded with status ${response.status} and no readable error.`,
      response.status,
    );
  }

  return payload as T;
}

export async function fetchHealth(signal?: AbortSignal): Promise<Health> {
  // The one anonymous route: it is a readiness signal and must answer before anyone is signed in.
  return apiRequest<Health>('/health', { authenticated: false, ...(signal ? { signal } : {}) });
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
