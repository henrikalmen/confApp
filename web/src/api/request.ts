import { resolveApiBaseUrl } from '../config.ts';

/**
 * The one HTTP request this application makes, and the error shape every refusal arrives in.
 *
 * Lifted out of `api/client.ts` by S07 (2026-08-31, review H2) so that the **projected Board View
 * can reach the transport without reaching the endpoints**. `client.ts` is the module carrying
 * every authenticated endpoint helper - `castVote`, the Join Code reads, the Membership list - and
 * a room machine that imported it downloaded all of them into the chunk it serves to an
 * unauthenticated, physically shared screen. No vote data was ever exposed (the resolution route
 * returns none and the surface holds no credential), but the Structural Criterion the display story
 * states about itself - *no module reachable from the display entry point is a vote, ballot, tally
 * or option module* - was not true in fact, and a guard reading file names could not see it.
 *
 * Nothing here knows an endpoint. It knows the base URL, the credential seam, and the envelope.
 */

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

/**
 * Told when an authenticated request could not be issued for want of a credential.
 *
 * **A notification, not a decision.** This module knows the fact – something needed a token and
 * there wasn't one – and knows nothing about what to do with it; renewing is a top-level
 * navigation and belongs to the auth layer, which registers here. Keeping the decision out of
 * `apiRequest` is deliberate: a request function that can navigate the page away is a surprising
 * thing to call.
 *
 * It exists because the credential accessor stopped renewing (`offline-session-expiry` TI01) and
 * for a while nothing took over: renewal was reachable from one branch of the attendee panel, so
 * an attendee reading a live schedule, and every organizer surface, silently lost API access an
 * hour after signing in and never got it back.
 */
export type CredentialMissingListener = () => void;

let credentialMissing: CredentialMissingListener = () => {};

export function setCredentialMissingListener(listener: CredentialMissingListener): void {
  credentialMissing = listener;
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
    /*
     * **Not sent at all**, rather than sent anonymously.
     *
     * An authenticated route with no `Authorization` header is answered with a 401 – an *answer*,
     * and callers that fall back to a cache are built to treat an answer as authoritative. So a
     * lapsed ID token used to read as "the server says you may not have this", and the attendee's
     * cached Schedule was forgotten on the strength of a request that was never entitled to be
     * made (`offline-session-expiry` TI07).
     *
     * Status 0 is the shape of a request that never reached the network – the same case as a
     * transport failure, which is what this is – so the caller's existing "unreachable" branch
     * handles it with no new classification to keep in step.
     */
    if (token === null) {
      // Announced before it is thrown, so a listener sees every refusal rather than only the ones
      // whose caller happens to inspect the error.
      credentialMissing();
      throw new ApiError(
        'CREDENTIAL_UNAVAILABLE',
        'Your sign-in has expired, so this could not be requested. Anything already saved on ' +
          'this device stays readable.',
        0,
      );
    }
    headers.authorization = `Bearer ${token}`;
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
