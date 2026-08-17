declare global {
  interface Window {
    __CONFAPP_CONFIG__?: {
      apiBaseUrl?: string;
      auth?: {
        clientId?: string;
        authorizationEndpoint?: string;
        hostedDomain?: string;
        redirectUri?: string;
      };
    };
  }
}

type ConfigWindow = Pick<Window, '__CONFAPP_CONFIG__'>;

/**
 * The one place the API base URL is resolved.
 *
 * It comes from runtime configuration rather than a build-time constant so a single built
 * image serves every environment. It defaults to the same-origin `/api`, which the static
 * container reverse-proxies to the API service; the Capacitor shell (S11) and any
 * split-origin deployment (S13) supply an absolute URL instead.
 */
export function resolveApiBaseUrl(w: ConfigWindow = window): string {
  const configured = w.__CONFAPP_CONFIG__?.apiBaseUrl?.trim();
  const base = configured && configured !== '' ? configured : '/api';
  // Trailing slashes would produce //health when joined with a path.
  return base.replace(/\/+$/, '');
}

export interface WebAuthConfig {
  /** confApp's **web** OAuth client ID. Public by design – a client ID is not a secret. */
  clientId: string;
  authorizationEndpoint: string;
  /** Sent as the `hd` request parameter: a hint to Google's account chooser, nothing more. */
  hostedDomain: string;
  redirectUri: string;
}

/** Google's authorization endpoint, overridable so a test can point at a stub. */
const DEFAULT_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

export class MissingAuthConfigError extends Error {
  constructor(field: string) {
    super(
      `Sign-in is not configured: window.__CONFAPP_CONFIG__.auth.${field} is missing. The ` +
        'SPA container writes it from the environment at start; see .env.example.',
    );
    this.name = 'MissingAuthConfigError';
  }
}

/**
 * Runtime, never build-time – for the same reason as the API base URL. **No client secret is
 * resolved here and none exists in this bundle**: Google's token endpoint needs one for a web
 * client, so the code exchange is brokered by confApp's own API instead (DR01).
 */
export function resolveAuthConfig(w: ConfigWindow = window): WebAuthConfig {
  const auth = w.__CONFAPP_CONFIG__?.auth;

  const clientId = auth?.clientId?.trim();
  if (clientId === undefined || clientId === '') throw new MissingAuthConfigError('clientId');

  const hostedDomain = auth?.hostedDomain?.trim();
  if (hostedDomain === undefined || hostedDomain === '') {
    throw new MissingAuthConfigError('hostedDomain');
  }

  return {
    clientId,
    hostedDomain,
    authorizationEndpoint: auth?.authorizationEndpoint?.trim() || DEFAULT_AUTHORIZATION_ENDPOINT,
    // Defaulting to this origin's callback path keeps local development configuration-free
    // while still allowing a deployment to name an exact URI.
    redirectUri:
      auth?.redirectUri?.trim() ||
      (typeof location === 'undefined' ? '' : `${location.origin}/auth/callback`),
  };
}

export function isAuthConfigured(w: ConfigWindow = window): boolean {
  try {
    resolveAuthConfig(w);
    return true;
  } catch {
    return false;
  }
}

export {};
