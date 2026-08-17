import { jwtVerify, type JWTPayload } from 'jose';
import { ERROR_CODES, type AuthRefusalCode } from '../errors.ts';
import type { AuthConfig } from './config.ts';
import type { KeyStore } from './jwks.ts';

/**
 * **The** ID-token verification module.
 *
 * This is the only place in confApp that turns a JWT into a trust decision – no route handler
 * and no client code parses one. Everything a caller can be trusted for comes out of this
 * function, and every way a token can fail leaves through its typed refusal rather than an
 * exception a caller might swallow.
 *
 * The decision is made from the token's own claims and Google's published keys. No directory,
 * no Admin SDK, no group lookup: ADR-002 puts confApp's roles in confApp's own data (S07), and
 * this function has no business asking Google who someone *is* beyond what they signed.
 *
 * Order matters for the domain check. `hd` is verified **after** the signature, because an
 * unverified claim is just an attacker-supplied string; and it is verified *here* rather than
 * trusting the `hd` request parameter, which only pre-fills Google's account chooser and
 * restricts nothing (AGENTS.md, ADR-002).
 */

/** Google signs ID tokens with RS256. Pinning it is what makes `alg: none` unreachable. */
const PERMITTED_ALGORITHMS = ['RS256'] as const;

export interface VerifiedClaims {
  /** The stable user key. Never the email – emails change and are reissued. */
  sub: string;
  hd: string;
  email: string;
  displayName: string;
  /** Present only when the token was minted for a sign-in that supplied one. */
  nonce: string | undefined;
  /** Seconds since the epoch, as Google minted it. */
  expiresAt: number;
}

export type VerificationResult =
  { ok: true; claims: VerifiedClaims } | { ok: false; code: AuthRefusalCode };

function refuse(code: AuthRefusalCode): VerificationResult {
  return { ok: false, code };
}

/**
 * `jose` reports every failure as a coded error. Mapping them here – rather than letting a
 * generic "invalid token" cover all of them – is what gives each failure mode its own machine
 * code, which is what lets the SPA tell "sign in again" from "wrong company".
 */
function codeForJoseError(error: unknown): AuthRefusalCode {
  const code = (error as { code?: unknown }).code;
  switch (code) {
    case 'ERR_JWT_EXPIRED':
      return ERROR_CODES.AUTH_TOKEN_EXPIRED;
    case 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED':
      return ERROR_CODES.AUTH_TOKEN_SIGNATURE_INVALID;
    case 'ERR_JWKS_NO_MATCHING_KEY':
    case 'ERR_JWKS_MULTIPLE_MATCHING_KEYS':
      return ERROR_CODES.AUTH_SIGNING_KEY_UNKNOWN;
    case 'ERR_JWT_CLAIM_VALIDATION_FAILED': {
      // Which claim failed decides the code – "wrong app" and "not Google" are different
      // answers to the user, and S03 asserts they stay distinguishable.
      const claim = (error as { claim?: unknown }).claim;
      if (claim === 'iss') return ERROR_CODES.AUTH_TOKEN_ISSUER_INVALID;
      if (claim === 'aud') return ERROR_CODES.AUTH_TOKEN_AUDIENCE_INVALID;
      return ERROR_CODES.AUTH_TOKEN_MALFORMED;
    }
    default:
      // Unparseable input, an unpermitted `alg` (including `none`), a missing signature.
      return ERROR_CODES.AUTH_TOKEN_MALFORMED;
  }
}

function stringClaim(payload: JWTPayload, name: string): string | undefined {
  const value = payload[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export interface Verifier {
  verify(token: string): Promise<VerificationResult>;
}

export function createIdTokenVerifier(config: AuthConfig, keyStore: KeyStore): Verifier {
  return {
    async verify(token: string): Promise<VerificationResult> {
      if (typeof token !== 'string' || token.trim() === '') {
        return refuse(ERROR_CODES.AUTH_TOKEN_MALFORMED);
      }

      let payload: JWTPayload;
      try {
        // One comparison against the whole allow-list, with no platform-conditional branch:
        // `jose` accepts an array for `audience` and requires `aud` to match some entry. This
        // is the seam that lets S11 add Android and iOS as configuration alone.
        ({ payload } = await jwtVerify(token, (header) => keyStore.resolve(header), {
          algorithms: [...PERMITTED_ALGORITHMS],
          issuer: config.issuer,
          audience: [...config.audienceAllowList],
        }));
      } catch (error) {
        return refuse(codeForJoseError(error));
      }

      // Signature, issuer, audience and expiry are settled. Only now is a claim worth reading.
      const hd = stringClaim(payload, 'hd');
      if (hd === undefined) return refuse(ERROR_CODES.AUTH_DOMAIN_CLAIM_MISSING);
      if (hd !== config.hostedDomain) return refuse(ERROR_CODES.AUTH_DOMAIN_NOT_ALLOWED);

      const sub = stringClaim(payload, 'sub');
      const email = stringClaim(payload, 'email');
      if (sub === undefined || email === undefined || payload.exp === undefined) {
        return refuse(ERROR_CODES.AUTH_TOKEN_MALFORMED);
      }

      return {
        ok: true,
        claims: {
          sub,
          hd,
          email,
          // `name` is optional in Google's claim set; the email is a usable last resort and
          // keeps the caller contract's displayName non-optional for every later story.
          displayName: stringClaim(payload, 'name') ?? email,
          nonce: stringClaim(payload, 'nonce'),
          expiresAt: payload.exp,
        },
      };
    },
  };
}
