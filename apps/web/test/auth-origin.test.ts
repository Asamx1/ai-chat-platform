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
});
