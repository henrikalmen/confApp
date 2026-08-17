/**
 * The auth configuration surface.
 *
 * Every value here is environment configuration, never a compiled-in constant: the same API
 * image runs against any Google Cloud project and any hosted domain without a rebuild
 * (ADR-004, S13). Startup validation is deliberately strict and *fails closed* – a missing
 * hosted domain or an empty audience allow-list must stop the server, because the failure
 * mode of defaulting is "any Google account gets in", which is exactly what ADR-002 exists
 * to prevent.
 */

/** Google's OIDC discovery document. Both the issuer and jwks_uri are read from it. */
export const GOOGLE_DISCOVERY_URL = 'https://accounts.google.com/.well-known/openid-configuration';

export interface AuthConfig {
  /**
   * confApp's **own** OAuth client IDs – one per platform. Google issues a distinct client ID
   * for web, for Android (bound to package name + signing fingerprint) and for iOS (bound to
   * bundle ID), and the token minted for a platform carries that platform's ID in `aud`. A
   * single expected value would therefore refuse every mobile sign-in the moment S11 lands.
   */
  readonly audienceAllowList: readonly string[];
  /** The Workspace domain the `hd` claim must equal. Never derived from the request. */
  readonly hostedDomain: string;
  readonly issuer: string;
  /**
   * Where the OIDC discovery document lives. Configurable for the same reason `issuer` is –
   * so the running API can be exercised against a local fixture issuer during verification –
   * and it defaults to Google. Pointing it anywhere else in a deployed environment would move
   * the trust anchor, so it is documented as a local-verification knob only.
   */
  readonly discoveryUrl: string;
  readonly redirectUri: string;
  /**
   * The web client ID + secret used for the server-side code exchange (DR01). Google's token
   * endpoint requires a secret for the Web application client type even under PKCE, so the
   * exchange is brokered here rather than in the SPA, where a secret must never ship.
   */
  readonly webClientId: string;
  readonly webClientSecret: string;
}

/** Base class so a caller can catch every startup misconfiguration as one kind. */
export class AuthConfigError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

export class MissingHostedDomainError extends AuthConfigError {
  constructor() {
    super(
      'MissingHostedDomainError',
      'GOOGLE_HOSTED_DOMAIN is not set. Without it every Google account would be accepted, so ' +
        'the API refuses to start rather than serving with the domain check disabled.',
    );
  }
}

export class EmptyAudienceAllowListError extends AuthConfigError {
  constructor() {
    super(
      'EmptyAudienceAllowListError',
      'GOOGLE_AUDIENCE_ALLOWLIST is empty. It must list confApp’s own OAuth client IDs, one ' +
        'per platform, comma-separated. An empty list cannot accept any token, and defaulting ' +
        'to "any audience" would accept tokens minted for a different application entirely.',
    );
  }
}

export class WildcardAudienceError extends AuthConfigError {
  constructor(entry: string) {
    super(
      'WildcardAudienceError',
      `GOOGLE_AUDIENCE_ALLOWLIST entry "${entry}" is a wildcard or pattern. Every entry must be ` +
        'a literal OAuth client ID; a pattern would widen the allow-list to clients that are ' +
        'not confApp’s.',
    );
  }
}

export class MissingAuthSettingError extends AuthConfigError {
  constructor(variable: string) {
    super('MissingAuthSettingError', `Required auth environment variable ${variable} is not set.`);
  }
}

/**
 * Anything that is not a literal identifier. Google client IDs look like
 * `1234-abc.apps.googleusercontent.com`; none of these characters occur in one, and every one
 * of them is how a "match everything" entry would be smuggled in.
 */
const PATTERN_CHARACTERS = /[*?%\s]|\.\*|^\/|\[|\]|\(|\)|\||\+|\$|\^/;

function requiredValue(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (value === undefined || value === '') throw new MissingAuthSettingError(name);
  return value;
}

/**
 * Splits the allow-list on commas. Written as a list rather than a single value on purpose –
 * see the type doc above; this is the seam that lets S11 add Android and iOS by configuration
 * alone, changing no verification code.
 */
function parseAudienceAllowList(raw: string | undefined): readonly string[] {
  const entries = (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

  if (entries.length === 0) throw new EmptyAudienceAllowListError();

  for (const entry of entries) {
    if (PATTERN_CHARACTERS.test(entry)) throw new WildcardAudienceError(entry);
  }

  // Duplicates are harmless but make the configuration misleading to read.
  return Object.freeze([...new Set(entries)]);
}

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const hostedDomain = env.GOOGLE_HOSTED_DOMAIN?.trim();
  if (hostedDomain === undefined || hostedDomain === '') throw new MissingHostedDomainError();

  return {
    audienceAllowList: parseAudienceAllowList(env.GOOGLE_AUDIENCE_ALLOWLIST),
    hostedDomain,
    // Google's issuer, overridable only so tests can point at a fixture issuer.
    issuer: env.GOOGLE_ISSUER?.trim() || 'https://accounts.google.com',
    discoveryUrl: env.GOOGLE_DISCOVERY_URL?.trim() || GOOGLE_DISCOVERY_URL,
    redirectUri: requiredValue(env, 'GOOGLE_REDIRECT_URI'),
    webClientId: requiredValue(env, 'GOOGLE_WEB_CLIENT_ID'),
    webClientSecret: requiredValue(env, 'GOOGLE_WEB_CLIENT_SECRET'),
  };
}
