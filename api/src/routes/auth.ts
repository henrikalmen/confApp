import type { FastifyInstance } from 'fastify';
import { authRefusal, ERROR_CODES } from '../errors.ts';
import type { CodeExchange } from '../auth/code-exchange.ts';
import type { Verifier } from '../auth/verify-id-token.ts';
import type { UserRepository } from '../auth/users.ts';

/**
 * `POST /api/auth/token` – the sign-in code exchange (DR01).
 *
 * Anonymous by necessity: this is how a caller *obtains* a credential, so requiring one would
 * make sign-in impossible. It is listed in `ANONYMOUS_ROUTES` with that reason, not left
 * unwrapped by omission.
 *
 * It is not a hole in the trust boundary. The route cannot mint anything – it forwards a code
 * to Google and then puts the resulting ID token through the *same* verification module every
 * other route's credential goes through, including the `hd` domain check. A caller who somehow
 * obtained a valid code for a different domain still gets nothing, and still gets no user row.
 *
 * The `nonce` is compared here rather than in the browser (DR02): checking it means reading a
 * token claim, and no client code parses a JWT to make a trust decision.
 */

interface TokenExchangeBody {
  code: string;
  codeVerifier: string;
  nonce: string;
}

const bodySchema = {
  type: 'object',
  required: ['code', 'codeVerifier', 'nonce'],
  additionalProperties: false,
  properties: {
    code: { type: 'string', minLength: 1, maxLength: 2048 },
    codeVerifier: { type: 'string', minLength: 43, maxLength: 128 },
    nonce: { type: 'string', minLength: 1, maxLength: 256 },
  },
} as const;

export interface AuthRouteDependencies {
  codeExchange: CodeExchange;
  verifier: Verifier;
  users: UserRepository;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  { codeExchange, verifier, users }: AuthRouteDependencies,
): void {
  app.post<{ Body: TokenExchangeBody }>(
    '/api/auth/token',
    { schema: { body: bodySchema } },
    async (request) => {
      const { code, codeVerifier, nonce } = request.body;

      const exchanged = await codeExchange.exchange({ code, codeVerifier });
      if (!exchanged.ok || exchanged.idToken === undefined) {
        throw authRefusal(ERROR_CODES.AUTH_EXCHANGE_FAILED);
      }

      const result = await verifier.verify(exchanged.idToken);
      if (!result.ok) {
        throw authRefusal(result.code);
      }

      // Replay protection: the token must belong to the sign-in attempt that started in this
      // browser. Compared after verification, because before it the claim is just a string an
      // attacker chose.
      if (result.claims.nonce !== nonce) {
        throw authRefusal(ERROR_CODES.AUTH_NONCE_MISMATCH);
      }

      // Verified and domain-checked: only now does a user row come into existence.
      const user = await users.upsertFromClaims(result.claims);

      return {
        // The SPA presents this verbatim as its bearer credential and never inspects it.
        idToken: exchanged.idToken,
        expiresAt: result.claims.expiresAt,
        user: {
          sub: user.sub,
          email: user.email,
          displayName: user.displayName,
        },
      };
    },
  );
}
