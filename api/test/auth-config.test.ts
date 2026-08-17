import { describe, expect, it } from 'vitest';
import {
  loadAuthConfig,
  EmptyAudienceAllowListError,
  MissingAuthSettingError,
  MissingHostedDomainError,
  WildcardAudienceError,
} from '../src/auth/config.ts';

/**
 * TI01 – the auth configuration surface.
 *
 * Every case here is a *fail-closed* assertion. The failure mode these guard against is not a
 * crash but the opposite: a server that starts happily with the domain or audience check
 * effectively disabled, which is precisely the "anyone with a Google account gets in" outcome
 * ADR-002 exists to prevent.
 */

const COMPLETE = {
  GOOGLE_HOSTED_DOMAIN: 'ourcompany.example',
  GOOGLE_AUDIENCE_ALLOWLIST:
    'web-111.apps.googleusercontent.example,android-222.apps.googleusercontent.example',
  GOOGLE_REDIRECT_URI: 'http://localhost:8082/auth/callback',
  GOOGLE_WEB_CLIENT_ID: 'web-111.apps.googleusercontent.example',
  GOOGLE_WEB_CLIENT_SECRET: 'not-a-real-secret',
} satisfies NodeJS.ProcessEnv;

describe('loadAuthConfig', () => {
  it('accepts a two-entry allow-list and keeps both entries in order', () => {
    const config = loadAuthConfig({ ...COMPLETE });

    expect(config.audienceAllowList).toEqual([
      'web-111.apps.googleusercontent.example',
      'android-222.apps.googleusercontent.example',
    ]);
    expect(config.hostedDomain).toBe('ourcompany.example');
    expect(config.issuer).toBe('https://accounts.google.com');
    expect(config.discoveryUrl).toBe(
      'https://accounts.google.com/.well-known/openid-configuration',
    );
  });

  it('refuses to start when the hosted domain is unset, rather than accepting any domain', () => {
    const env = { ...COMPLETE, GOOGLE_HOSTED_DOMAIN: '' };
    expect(() => loadAuthConfig(env)).toThrow(MissingHostedDomainError);
  });

  it('refuses to start on an empty audience allow-list, rather than accepting any audience', () => {
    expect(() => loadAuthConfig({ ...COMPLETE, GOOGLE_AUDIENCE_ALLOWLIST: '' })).toThrow(
      EmptyAudienceAllowListError,
    );
    // A list of nothing but separators is empty too.
    expect(() => loadAuthConfig({ ...COMPLETE, GOOGLE_AUDIENCE_ALLOWLIST: ' , , ' })).toThrow(
      EmptyAudienceAllowListError,
    );
  });

  it.each(['*', '*.apps.googleusercontent.com', 'web-.*', 'client?id', 'a|b'])(
    'refuses the wildcard or pattern allow-list entry %s',
    (entry) => {
      expect(() => loadAuthConfig({ ...COMPLETE, GOOGLE_AUDIENCE_ALLOWLIST: entry })).toThrow(
        WildcardAudienceError,
      );
    },
  );

  it('rejects a pattern even when literal entries sit beside it', () => {
    const env = {
      ...COMPLETE,
      GOOGLE_AUDIENCE_ALLOWLIST: `${COMPLETE.GOOGLE_WEB_CLIENT_ID},*`,
    };
    expect(() => loadAuthConfig(env)).toThrow(WildcardAudienceError);
  });

  it('gives each configuration failure its own named error', () => {
    const named = (env: NodeJS.ProcessEnv): string => {
      try {
        loadAuthConfig(env);
      } catch (error) {
        return (error as Error).name;
      }
      throw new Error('Expected loadAuthConfig to throw.');
    };

    const names = [
      named({ ...COMPLETE, GOOGLE_HOSTED_DOMAIN: '' }),
      named({ ...COMPLETE, GOOGLE_AUDIENCE_ALLOWLIST: '' }),
      named({ ...COMPLETE, GOOGLE_AUDIENCE_ALLOWLIST: '*' }),
      named({ ...COMPLETE, GOOGLE_REDIRECT_URI: '' }),
    ];

    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([
      'MissingHostedDomainError',
      'EmptyAudienceAllowListError',
      'WildcardAudienceError',
      'MissingAuthSettingError',
    ]);
  });

  it.each(['GOOGLE_REDIRECT_URI', 'GOOGLE_WEB_CLIENT_ID', 'GOOGLE_WEB_CLIENT_SECRET'])(
    'requires %s',
    (variable) => {
      expect(() => loadAuthConfig({ ...COMPLETE, [variable]: '' })).toThrow(
        MissingAuthSettingError,
      );
    },
  );

  it('never carries a secret in a configuration error message', () => {
    try {
      loadAuthConfig({ ...COMPLETE, GOOGLE_HOSTED_DOMAIN: '' });
    } catch (error) {
      expect((error as Error).message).not.toContain(COMPLETE.GOOGLE_WEB_CLIENT_SECRET);
    }
  });
});
