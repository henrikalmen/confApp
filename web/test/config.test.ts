import { describe, expect, it } from 'vitest';
import { resolveApiBaseUrl } from '../src/config.ts';

/**
 * Structural Criterion – neither image bakes in environment-specific configuration. The SPA
 * is static, so its API base URL has to arrive at run time; if this resolved from a build-time
 * constant, S13 would need one image per environment.
 */
describe('resolveApiBaseUrl', () => {
  it('defaults to the same-origin /api the static container proxies', () => {
    expect(resolveApiBaseUrl({ __CONFAPP_CONFIG__: undefined })).toBe('/api');
  });

  it('takes an absolute base URL supplied at run time, for split-origin and Capacitor', () => {
    expect(
      resolveApiBaseUrl({ __CONFAPP_CONFIG__: { apiBaseUrl: 'https://api.example.com/api' } }),
    ).toBe('https://api.example.com/api');
  });

  it('trims a trailing slash so joining a path cannot produce //', () => {
    expect(
      resolveApiBaseUrl({ __CONFAPP_CONFIG__: { apiBaseUrl: 'https://example.com/api/' } }),
    ).toBe('https://example.com/api');
  });

  it('falls back to /api when the container supplied an empty value', () => {
    expect(resolveApiBaseUrl({ __CONFAPP_CONFIG__: { apiBaseUrl: '   ' } })).toBe('/api');
  });
});
