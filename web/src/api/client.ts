import { resolveApiBaseUrl } from '../config.ts';

/** Mirrors the API's error envelope – the shared contract in api/src/errors.ts. */
export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: { field: string; message: string }[];
  };
}

export class ApiError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

export interface Health {
  status: string;
  schemaVersion: string | null;
  serverTime: string;
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
 * Every refusal arrives in one envelope, so the UI can always show `error.message` rather
 * than inventing its own wording per endpoint.
 */
export async function fetchHealth(signal?: AbortSignal): Promise<Health> {
  const response = await fetch(`${resolveApiBaseUrl()}/health`, {
    headers: { accept: 'application/json' },
    ...(signal ? { signal } : {}),
  });

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    if (isEnvelope(body)) {
      throw new ApiError(body.error.code, body.error.message);
    }
    throw new ApiError(
      'UNEXPECTED_RESPONSE',
      `The server responded with status ${response.status} and no readable error.`,
    );
  }

  return body as Health;
}
