import type { AuthConfig } from './config.ts';
import type { Discovery } from './discovery.ts';

/**
 * The authorization-code exchange, brokered by the API (DR01).
 *
 * Google's token endpoint requires `client_secret` for the **Web application** OAuth client
 * type even when a PKCE `code_verifier` is supplied. The SPA must never ship a secret, so the
 * exchange happens here instead of in the browser. PKCE is preserved end to end regardless:
 * the verifier is generated in the browser, never leaves it until this one call, and binds the
 * code to the attempt that started it.
 *
 * This module performs no trust decision. It hands back whatever Google returned; the ID token
 * is then verified by the same module every other route's credential goes through.
 */

/** Matches jose's own JWKS fetch timeout, so both outbound legs fail in comparable time. */
const EXCHANGE_TIMEOUT_MS = 5_000;

export interface CodeExchangeResult {
  ok: boolean;
  idToken?: string;
}

export interface CodeExchange {
  exchange(input: { code: string; codeVerifier: string }): Promise<CodeExchangeResult>;
}

export interface CodeExchangeOptions {
  config: AuthConfig;
  discovery: Discovery;
  fetchImpl?: typeof fetch;
  /** Where refusals are recorded. Google's error body may name the account, so it stays here. */
  logger?: { error(detail: unknown, message: string): void };
}

export function createCodeExchange({
  config,
  discovery,
  fetchImpl = fetch,
  logger,
}: CodeExchangeOptions): CodeExchange {
  return {
    async exchange({ code, codeVerifier }): Promise<CodeExchangeResult> {
      const { token_endpoint: tokenEndpoint } = await discovery.get();

      // The redirect URI is the configured one, never a value the caller supplied: accepting
      // it from the request would let an attacker complete an exchange against their own
      // redirect. The client ID is likewise ours, not the caller's.
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: codeVerifier,
        client_id: config.webClientId,
        client_secret: config.webClientSecret,
        redirect_uri: config.redirectUri,
      });

      const response = await fetchImpl(tokenEndpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: body.toString(),
        // Bounded, because a hundred people sign in within the same minute at the start of a
        // conference. Without this a hung token endpoint holds every one of those requests open
        // and the API runs out of capacity while appearing healthy.
        signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
      });

      if (!response.ok) {
        // Google's reason is useful to an operator and must not reach the caller: it can name
        // the account and echo request parameters.
        const detail = await response.text().catch(() => '');
        logger?.error(
          { status: response.status, detail },
          'Google refused the authorization-code exchange.',
        );
        return { ok: false };
      }

      const payload = (await response.json()) as { id_token?: unknown };
      if (typeof payload.id_token !== 'string' || payload.id_token === '') {
        logger?.error({}, 'Google’s token response carried no id_token.');
        return { ok: false };
      }

      // Google's access token is deliberately discarded. It is opaque and carries no `hd`, so
      // it can never be this API's credential – the ID token is (FIS, Constraints & Gotchas).
      return { ok: true, idToken: payload.id_token };
    },
  };
}
