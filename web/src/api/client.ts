import { resolveApiBaseUrl } from '../config.ts';

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

  constructor(code: string, message: string, status = 0, details: ApiErrorDetail[] = []) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
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
): Promise<Conference> {
  return apiRequest<Conference>(`/conferences/${id}`, { method: 'PATCH', body: details });
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

export async function updateSession(
  conferenceId: string,
  sessionId: string,
  details: SessionDetailsInput,
): Promise<SavedSession> {
  return apiRequest<SavedSession>(`/conferences/${conferenceId}/sessions/${sessionId}`, {
    method: 'PATCH',
    body: details,
  });
}

export async function deleteSession(conferenceId: string, sessionId: string): Promise<void> {
  await apiRequest<{ deleted: string }>(`/conferences/${conferenceId}/sessions/${sessionId}`, {
    method: 'DELETE',
  });
}
