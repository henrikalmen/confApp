declare global {
  interface Window {
    __CONFAPP_CONFIG__?: {
      apiBaseUrl?: string;
      /** Where *this SPA* is served from, for building links other machines have to open. */
      webBaseUrl?: string;
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

/**
 * The origin **another machine** can open this SPA at – not the origin this code is running at.
 *
 * The two differ exactly where it matters most. Inside the Capacitor shells the WebView origin is
 * `capacitor://localhost` (iOS) or `https://localhost` (Android) – see `web/capacitor.config.ts`,
 * which records both – so a Display Link built from `location.origin` on a Facilitator's phone
 * comes out as `capacitor://localhost/display/<token>`: a URL no room machine can open, in a field
 * that looks perfectly plausible. That is the same reason `resolveApiBaseUrl` exists rather than
 * assuming same-origin (review 2026-08-31, finding 2).
 *
 * `null` means "this build cannot state a URL another machine could open". The caller must say so
 * rather than render a broken one – silently emitting an unusable link is the failure being
 * prevented, and a wrong URL is worse than an absent one because nobody checks it until the room
 * is waiting.
 *
 * The fallback to `location.origin` is deliberately narrow: an http(s) origin only. A browser
 * served over http or https genuinely is reachable at its own origin, which keeps local
 * development and the composed stack configuration-free; every other scheme is a shell.
 */
export function resolveWebBaseUrl(w: ConfigWindow = window): string | null {
  const configured = w.__CONFAPP_CONFIG__?.webBaseUrl?.trim();
  if (configured !== undefined && configured !== '') return configured.replace(/\/+$/, '');

  if (typeof location === 'undefined') return null;
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return null;
  return location.origin;
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
