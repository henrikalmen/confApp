import { afterEach, beforeEach } from 'vitest';
import { cleanup, configure } from '@testing-library/react';
import { webcrypto } from 'node:crypto';
import { setTokenSource } from '../src/api/client.ts';

/**
 * jsdom does not implement Web Storage, and this build of it does not expose `crypto.subtle`
 * on every platform either. Both are ordinary browser capabilities the app is entitled to
 * assume, so they are provided here rather than being designed around: the session module is
 * tested against a real key-value store and the real SHA-256, not against stubs of its own.
 */

class MemoryStorage implements Storage {
  #entries = new Map<string, string>();

  get length(): number {
    return this.#entries.size;
  }

  key(index: number): string | null {
    return [...this.#entries.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.#entries.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.#entries.set(key, String(value));
  }

  removeItem(key: string): void {
    this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }

  [name: string]: unknown;
}

function installStorage(name: 'localStorage' | 'sessionStorage'): void {
  if (globalThis[name] !== undefined) return;
  const storage = new MemoryStorage();
  for (const target of [globalThis, window]) {
    Object.defineProperty(target, name, { value: storage, configurable: true, writable: true });
  }
}

installStorage('localStorage');
installStorage('sessionStorage');

/**
 * How long `findBy*` and `waitFor` are willing to wait.
 *
 * **Longer than the schedule poll's own interval, deliberately.** The attendee panel polls every
 * five seconds and keeps at most one poll in flight – a tick arriving while one is outstanding is
 * skipped rather than queued. So a test that waits for a reconnect to land has to be able to
 * outlast a skipped tick, and Testing Library's one-second default cannot: on a loaded machine the
 * prompt to refresh collides with the interval about as often as not, and the wait expires four
 * seconds before the next tick would have satisfied it. That is what a different reconnect test
 * failing on every run – and all of them passing in isolation – actually was.
 *
 * Raised rather than worked around per test, and paired with the `testTimeout` in
 * `vitest.config.ts`, which has to exceed it or a single wait consumes the whole test budget and
 * the failure is reported as a timeout rather than as the assertion that was unmet.
 *
 * It weakens nothing: a condition that never becomes true still fails, just later.
 */
configure({ asyncUtilTimeout: 15_000 });

if (globalThis.crypto?.subtle === undefined) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}

/**
 * A credential, because every one of these tests renders a **signed-in** app.
 *
 * `apiRequest` refuses to issue an authenticated request with no credential rather than sending
 * it anonymously and reading the resulting 401 as the server refusing
 * (`offline-session-expiry` TI07). The module default is `async () => null`, so without this a
 * schedule test would exercise the lapsed-sign-in path instead of the one it is about, and its
 * stubbed `fetch` would never be reached at all.
 *
 * Registered here rather than per file so a test that *is* about a lapsed sign-in has one obvious
 * thing to override – `setTokenSource(async () => null)` in its own `beforeEach`, which runs after
 * this one and therefore wins.
 */
beforeEach(() => {
  setTokenSource(async () => 'test-credential');
});

afterEach(() => {
  cleanup();
  delete window.__CONFAPP_CONFIG__;
  localStorage.clear();
  sessionStorage.clear();
});
