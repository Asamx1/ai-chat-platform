import { describe, expect, it } from 'vitest';

import { resolveAuthOriginConfig } from '../src/lib/auth-origin.ts';

describe('resolveAuthOriginConfig', () => {
  it('uses the local smoke origin and de-duplicates the trusted origins', () => {
    const config = resolveAuthOriginConfig({
      AICHAT_LOCAL_SMOKE: '1',
    });

    expect(config).toEqual({
      baseURL: 'http://127.0.0.1:3100',
      trustedOrigins: [
        'http://localhost:3000',
        'http://127.0.0.1:3000',
        'http://localhost:3100',
        'http://127.0.0.1:3100',
      ],
    });
    expect(new Set(config.trustedOrigins).size).toBe(config.trustedOrigins.length);
  });

  it('normalizes an explicit Better Auth URL and trusts its origin', () => {
    const config = resolveAuthOriginConfig({
      BETTER_AUTH_URL: 'https://chat.example.com/',
      NODE_ENV: 'production',
    });

    expect(config.baseURL).toBe('https://chat.example.com');
    expect(config.trustedOrigins).toContain('https://chat.example.com');
  });

  it('trusts only the configured origin in production', () => {
    const config = resolveAuthOriginConfig({
      BETTER_AUTH_URL: 'https://chat.example.com/',
      NODE_ENV: 'production',
    });

    expect(config.trustedOrigins).toEqual(['https://chat.example.com']);
  });

  it('requires HTTPS for a production Better Auth URL', () => {
    expect(() => resolveAuthOriginConfig({
      BETTER_AUTH_URL: 'http://chat.example.com',
      NODE_ENV: 'production',
    })).toThrow(/BETTER_AUTH_URL.*HTTPS/);
  });

  it('rejects non-loopback HTTP even in local smoke mode', () => {
    expect(() => resolveAuthOriginConfig({
      AICHAT_LOCAL_SMOKE: '1',
      BETTER_AUTH_URL: 'http://chat.example.com',
    })).toThrow(/BETTER_AUTH_URL.*loopback/);
  });

  it('rejects a public HTTPS origin when local smoke mode is enabled in production', () => {
    expect(() => resolveAuthOriginConfig({
      AICHAT_LOCAL_SMOKE: '1',
      BETTER_AUTH_URL: 'https://chat.example.com',
      NODE_ENV: 'production',
    })).toThrow(/BETTER_AUTH_URL.*loopback/);
  });

  it.each([
    'http://localhost:3100',
    'http://127.0.0.1:3100',
    'http://[::1]:3100',
  ])('allows the loopback HTTP origin in local smoke mode: %s', (BETTER_AUTH_URL) => {
    expect(resolveAuthOriginConfig({
      AICHAT_LOCAL_SMOKE: '1',
      BETTER_AUTH_URL,
    }).baseURL).toBe(BETTER_AUTH_URL);
  });

  it('requires BETTER_AUTH_URL in production outside local smoke mode', () => {
    expect(() => resolveAuthOriginConfig({ NODE_ENV: 'production' })).toThrow(
      /BETTER_AUTH_URL/,
    );
  });

  it.each(['not a URL', 'ftp://chat.example.com'])(
    'rejects an unsafe BETTER_AUTH_URL: %s',
    (BETTER_AUTH_URL) => {
      expect(() => resolveAuthOriginConfig({ BETTER_AUTH_URL })).toThrow(
        /BETTER_AUTH_URL.*valid HTTP\(S\) origin/,
      );
    },
  );

  it.each([
    ' https://chat.example.com',
    'https://chat.example.com ',
    'https://user@chat.example.com',
    'https://@chat.example.com',
    'https://chat.example.com/path',
    'https://chat.example.com?query=1',
    'https://chat.example.com#fragment',
    'https://chat.example.com?',
    'https://chat.example.com#',
    'https://chat.example.com/.',
    'https://chat.example.com/a/..',
    'https://chat.example.com/%2e',
    'https:\t//@chat.example.com',
  ])('rejects a non-origin BETTER_AUTH_URL: %s', (BETTER_AUTH_URL) => {
    expect(() => resolveAuthOriginConfig({ BETTER_AUTH_URL })).toThrow(
      /BETTER_AUTH_URL.*valid HTTP\(S\) origin/,
    );
  });
});
