import type { AuthDependencies } from '../src/app.ts';
import type { AppUser, UserRepository } from '../src/auth/users.ts';
import type { CodeExchange } from '../src/auth/code-exchange.ts';
import type { Verifier } from '../src/auth/verify-id-token.ts';
import type { VerifiedClaims } from '../src/auth/verify-id-token.ts';

/**
 * Auth stand-ins for tests whose subject is something other than verification.
 *
 * The verifier is only ever stubbed where the assertion is about something else entirely –
 * the health route, the error envelope. Every test that asserts an *authentication* outcome
 * runs the real verification path against locally-signed fixtures, because a mocked verifier
 * is exactly what makes the wrong-domain and unsigned cases pass silently.
 */

export interface InMemoryUsers extends UserRepository {
  /** Current rows, keyed by `sub`, so a test can assert what the table would hold. */
  readonly rows: Map<string, AppUser>;
  readonly upsertCount: number;
}

export function inMemoryUsers(): InMemoryUsers {
  const rows = new Map<string, AppUser>();
  let upsertCount = 0;

  return {
    rows,
    get upsertCount() {
      return upsertCount;
    },
    async upsertFromClaims(claims: VerifiedClaims): Promise<AppUser> {
      upsertCount += 1;
      const existing = rows.get(claims.sub);
      // Mirrors the SQL: conflict on sub refreshes display data and keeps the surrogate id.
      const user: AppUser = {
        id: existing?.id ?? `row-${rows.size + 1}`,
        sub: claims.sub,
        email: claims.email,
        displayName: claims.displayName,
      };
      rows.set(claims.sub, user);
      return user;
    },
  };
}

/**
 * Turns a `sub` into a bearer token this suite's verifier will accept.
 *
 * Only for tests whose subject is what a *known* caller may do – the conference authorization and
 * lifecycle rules. Whether a real Google token is genuine, correctly audienced and from the right
 * Workspace domain is settled in the S02 suite against locally-signed fixtures, and stubbing the
 * verifier there would make exactly those cases pass for the wrong reason.
 */
export function tokenFor(sub: string): string {
  return `test-token:${sub}`;
}

/**
 * Accepts `tokenFor(sub)` and refuses anything else, so a test can still assert that an
 * unauthenticated or malformed credential never reaches a handler.
 */
export function subjectVerifier(hd = 'ourcompany.example'): Verifier {
  return {
    async verify(token: string) {
      const prefix = 'test-token:';
      if (!token.startsWith(prefix)) {
        return { ok: false, code: 'AUTH_TOKEN_MALFORMED' } as const;
      }

      const sub = token.slice(prefix.length);
      return {
        ok: true,
        claims: {
          sub,
          hd,
          email: `${sub}@${hd}`,
          displayName: sub,
          nonce: undefined,
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        },
      } as const;
    },
  };
}

/** Refuses everything. The default for suites that never intend to authenticate. */
export function refusingVerifier(): Verifier {
  return {
    async verify() {
      return { ok: false, code: 'AUTH_TOKEN_MALFORMED' } as const;
    },
  };
}

export function unusedCodeExchange(): CodeExchange {
  return {
    async exchange() {
      throw new Error('The code exchange was not expected to be called in this test.');
    },
  };
}

/** Auth dependencies for a suite whose subject is not authentication. */
export function fakeAuth(overrides: Partial<AuthDependencies> = {}): AuthDependencies {
  return {
    verifier: overrides.verifier ?? refusingVerifier(),
    users: overrides.users ?? inMemoryUsers(),
    codeExchange: overrides.codeExchange ?? unusedCodeExchange(),
  };
}
