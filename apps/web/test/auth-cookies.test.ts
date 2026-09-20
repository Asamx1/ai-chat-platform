import { describe, expect, it } from 'vitest';

import { resolveUseSecureCookies } from '../src/lib/auth-cookies.ts';
import {
  resolveAuthOriginConfig,
  type AuthOriginEnvironment,
} from '../src/lib/auth-origin.ts';

function resolveCookies(env: AuthOriginEnvironment & {
  AICHAT_SECURE_COOKIES?: string;
}): boolean {
  return resolveUseSecureCookies(env, resolveAuthOriginConfig(env));
}

describe('resolveUseSecureCookies', () => {
  it('enables secure cookies when explicitly forced', () => {
    expect(resolveCookies({
      AICHAT_LOCAL_SMOKE: '1',
      AICHAT_SECURE_COOKIES: '1',
      BETTER_AUTH_URL: 'http://127.0.0.1:3100',
    })).toBe(true);
  });

  it('disables secure cookies for an HTTP loopback smoke origin', () => {
    expect(resolveCookies({
      AICHAT_LOCAL_SMOKE: '1',
      BETTER_AUTH_URL: 'http://127.0.0.1:3100',
      NODE_ENV: 'production',
    })).toBe(false);
  });

  it('enables secure cookies for an HTTPS loopback smoke origin', () => {
    expect(resolveCookies({
      AICHAT_LOCAL_SMOKE: '1',
      BETTER_AUTH_URL: 'https://localhost:3100',
      NODE_ENV: 'production',
    })).toBe(true);
  });

  it('enables secure cookies in production by default', () => {
    expect(resolveCookies({
      BETTER_AUTH_URL: 'https://chat.example.com',
      NODE_ENV: 'production',
    })).toBe(true);
  });

  it('disables secure cookies in development by default', () => {
    expect(resolveCookies({ NODE_ENV: 'development' })).toBe(false);
  });
});
