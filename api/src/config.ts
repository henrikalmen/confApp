/**
 * All configuration is read from the environment at startup – nothing environment-specific
 * is baked into the image, so the same API image runs in development and against any other
 * target without a rebuild (S13 depends on this).
 */

export interface ApiConfig {
  readonly host: string;
  readonly port: number;
  readonly databaseUrl: string;
  /** Milliseconds SIGTERM handling waits for in-flight requests before forcing exit. */
  readonly shutdownTimeoutMs: number;
}

class MissingConfigError extends Error {
  constructor(variable: string) {
    super(`Required environment variable ${variable} is not set.`);
    this.name = 'MissingConfigError';
  }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new MissingConfigError(name);
  }
  return value;
}

function numeric(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer, got "${raw}".`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return {
    host: env.HOST?.trim() || '0.0.0.0',
    port: numeric(env, 'PORT', 8080),
    databaseUrl: required(env, 'DATABASE_URL'),
    shutdownTimeoutMs: numeric(env, 'SHUTDOWN_TIMEOUT_MS', 10_000),
  };
}
