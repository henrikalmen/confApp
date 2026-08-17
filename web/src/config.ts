declare global {
  interface Window {
    __CONFAPP_CONFIG__?: { apiBaseUrl?: string };
  }
}

/**
 * The one place the API base URL is resolved.
 *
 * It comes from runtime configuration rather than a build-time constant so a single built
 * image serves every environment. It defaults to the same-origin `/api`, which the static
 * container reverse-proxies to the API service; the Capacitor shell (S11) and any
 * split-origin deployment (S13) supply an absolute URL instead.
 */
export function resolveApiBaseUrl(w: Pick<Window, '__CONFAPP_CONFIG__'> = window): string {
  const configured = w.__CONFAPP_CONFIG__?.apiBaseUrl?.trim();
  const base = configured && configured !== '' ? configured : '/api';
  // Trailing slashes would produce //health when joined with a path.
  return base.replace(/\/+$/, '');
}

export {};
