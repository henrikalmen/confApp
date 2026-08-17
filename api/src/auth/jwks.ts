import { createRemoteJWKSet, customFetch, type JWSHeaderParameters, type CryptoKey } from 'jose';
import type { Discovery } from './discovery.ts';

/**
 * Google's signing keys, discovered rather than hardcoded.
 *
 * **The cache is an optimization and nothing else.** The API runs as horizontally scaled
 * container replicas with non-sticky requests (ADR-004), so correctness may not depend on any
 * process having warmed it: a replica that started one second ago with an empty cache must
 * verify exactly as well as one that has run for a week.
 *
 * Two requirements pull against each other here, and both have to hold.
 *
 * 1. **An unknown `kid` must refetch, not refuse.** On Google's key rotation the first replica
 *    to see the new key has to fetch it immediately; refusing until some window elapses would
 *    lock every user out of a running conference. `createRemoteJWKSet`'s own 30-second cooldown
 *    is too slow for this on its own, which is why the miss path calls `reload()` – documented
 *    as bypassing that cooldown deliberately.
 * 2. **The refetch must be bounded.** An unconditional refetch-on-miss is an outbound-request
 *    amplifier: a caller presenting tokens with random `kid`s would drive one JWKS fetch per
 *    request straight at Google, and being rate-limited there breaks sign-in for everyone.
 *
 * The two are reconciled by rate-limiting the *bypass* rather than the fetch: the first miss
 * refetches at once (rotation recovers immediately), and further misses inside the interval are
 * refused from the cached set without touching the network. A rotation therefore costs one
 * fetch, and ten thousand forged `kid`s also cost one.
 */

/**
 * Shortest gap between two cooldown-bypassing reloads. Short enough that a rotation recovers
 * effectively instantly; long enough that misses cannot be turned into fetch volume.
 */
const FORCED_RELOAD_INTERVAL_MS = 10_000;
/** Refresh at least this often even with no miss, so a rotation is picked up unprompted. */
const CACHE_MAX_AGE_MS = 600_000;

export interface KeyStore {
  /** Resolves the key for a JWS header, refetching on an unknown `kid` within the bound above. */
  resolve(header: JWSHeaderParameters): Promise<CryptoKey>;
}

export interface KeyStoreOptions {
  discovery: Discovery;
  fetchImpl?: typeof fetch;
}

function isNoMatchingKey(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ERR_JWKS_NO_MATCHING_KEY';
}

export function createKeyStore({ discovery, fetchImpl }: KeyStoreOptions): KeyStore {
  type RemoteSet = ReturnType<typeof createRemoteJWKSet>;

  let remoteSet: RemoteSet | undefined;
  let building: Promise<RemoteSet> | undefined;

  // Monotonic, so a system clock adjustment cannot widen or disable the bound.
  let lastForcedReload = 0;
  let reloading: Promise<void> | undefined;

  async function keySet(): Promise<RemoteSet> {
    if (remoteSet !== undefined) return remoteSet;

    // A hundred people signing in at once is the expected load, not the edge case: share one
    // construction rather than resolving discovery per request.
    building ??= (async () => {
      try {
        const { jwks_uri: jwksUri } = await discovery.get();
        remoteSet = createRemoteJWKSet(new URL(jwksUri), {
          cacheMaxAge: CACHE_MAX_AGE_MS,
          ...(fetchImpl === undefined
            ? {}
            : // jose's fetch-like signature is deliberately narrower than fetch's.
              { [customFetch]: fetchImpl as unknown as never }),
        });
        return remoteSet;
      } finally {
        building = undefined;
      }
    })();

    return building;
  }

  return {
    async resolve(header: JWSHeaderParameters): Promise<CryptoKey> {
      const set = await keySet();

      try {
        return await set(header);
      } catch (error) {
        // Only an unknown key is worth a network round trip. A bad signature, a wrong
        // algorithm, or a malformed header must fail here and now.
        if (!isNoMatchingKey(error)) throw error;

        const elapsed = performance.now();
        if (lastForcedReload !== 0 && elapsed - lastForcedReload < FORCED_RELOAD_INTERVAL_MS) {
          // Inside the bound: refuse from what is cached rather than fetching again.
          throw error;
        }
        // Stamped before awaiting, so concurrent misses cannot each start their own reload.
        lastForcedReload = elapsed;

        reloading ??= set.reload().finally(() => {
          reloading = undefined;
        });
        await reloading;

        // Still unknown after a genuine refetch: the key does not exist. The verifier maps
        // jose's error to its own refusal code.
        return await set(header);
      }
    },
  };
}
