import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { webcrypto } from 'node:crypto';

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

if (globalThis.crypto?.subtle === undefined) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}

afterEach(() => {
  cleanup();
  delete window.__CONFAPP_CONFIG__;
  localStorage.clear();
  sessionStorage.clear();
});
