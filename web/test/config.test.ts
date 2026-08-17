import { describe, expect, it } from 'vitest';
import {
  MissingAuthConfigError,
  isAuthConfigured,
  resolveApiBaseUrl,
  resolveAuthConfig,
} from '../src/config.ts';

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

/**
 * TI01 (browser half) – auth settings arrive at run time for the same reason the API base URL
 * does: one built image per environment would otherwise be needed.
 */
describe('resolveAuthConfig', () => {
  const complete = {
    __CONFAPP_CONFIG__: {
      auth: {
        clientId: 'web-111.apps.googleusercontent.example',
        hostedDomain: 'ourcompany.example',
        redirectUri: 'http://localhost:8082/auth/callback',
      },
    },
  };

  it('reads the client ID, hosted domain and redirect URI supplied at run time', () => {
    expect(resolveAuthConfig(complete)).toEqual({
      clientId: 'web-111.apps.googleusercontent.example',
      hostedDomain: 'ourcompany.example',
      redirectUri: 'http://localhost:8082/auth/callback',
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    });
  });

  it.each(['clientId', 'hostedDomain'])('fails loudly when %s is missing', (field) => {
    const auth = { ...complete.__CONFAPP_CONFIG__.auth, [field]: '' };
    expect(() => resolveAuthConfig({ __CONFAPP_CONFIG__: { auth } })).toThrow(
      MissingAuthConfigError,
    );
    expect(isAuthConfigured({ __CONFAPP_CONFIG__: { auth } })).toBe(false);
  });

  it('reports unconfigured rather than throwing when nothing is supplied at all', () => {
    expect(isAuthConfigured({ __CONFAPP_CONFIG__: undefined })).toBe(false);
  });

  /**
   * Structural Criterion – no client secret ships in the SPA bundle. There is no field for one
   * because Google's token endpoint needs it and the exchange therefore happens on the API
   * (DR01); a `clientSecret` here would be a defect, not a convenience.
   */
  it('exposes no client-secret field of any kind', () => {
    const resolved = resolveAuthConfig(complete) as unknown as Record<string, unknown>;
    for (const key of Object.keys(resolved)) {
      expect(key.toLowerCase()).not.toContain('secret');
    }
  });
});
