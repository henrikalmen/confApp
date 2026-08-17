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
