import { GOOGLE_DISCOVERY_URL } from './config.ts';

/**
 * Google's OIDC discovery document.
 *
 * Neither `jwks_uri` nor `token_endpoint` is hardcoded anywhere in confApp: Google publishes
 * them here and is free to move them. Both the key store and the code exchange read from this
 * one place, so there is a single answer to "where does Google live" rather than two that can
 * drift.
 *
 * The document is cached per instance because it changes rarely, but – like the JWKS cache –
 * the cache is an optimization only. A freshly started replica fetches it on first use
 * (ADR-004: replicas are interchangeable and requests are not sticky).
 */

/** Matches jose's own JWKS fetch timeout, so both outbound legs fail in comparable time. */
const DISCOVERY_TIMEOUT_MS = 5_000;

export interface DiscoveryDocument {
  issuer: string;
  jwks_uri: string;
  token_endpoint: string;
  authorization_endpoint: string;
}

export interface Discovery {
  get(): Promise<DiscoveryDocument>;
}

export interface DiscoveryOptions {
  discoveryUrl?: string;
  fetchImpl?: typeof fetch;
}

export function createDiscovery(options: DiscoveryOptions = {}): Discovery {
  const url = options.discoveryUrl ?? GOOGLE_DISCOVERY_URL;
  const fetchImpl = options.fetchImpl ?? fetch;

  let cached: DiscoveryDocument | undefined;
  // A hundred people signing in at once is the expected load, so a cold start shares one
  // fetch rather than issuing one per request.
  let inFlight: Promise<DiscoveryDocument> | undefined;

  return {
    async get(): Promise<DiscoveryDocument> {
      if (cached !== undefined) return cached;

      inFlight ??= (async () => {
        try {
          const response = await fetchImpl(url, {
            headers: { accept: 'application/json' },
            // Bounded: every verification waits behind this on a cold start, so a hung
            // discovery fetch would stall authentication rather than fail it.
            signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
          });
          if (!response.ok) {
            throw new Error(`GET ${url} answered ${response.status}.`);
          }
          cached = (await response.json()) as DiscoveryDocument;
          return cached;
        } finally {
          inFlight = undefined;
        }
      })();

      return inFlight;
    },
  };
}
