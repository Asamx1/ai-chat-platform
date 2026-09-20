import { describe, expect, it } from 'vitest';

import { resolveUseSecureCookies } from '../src/lib/auth-cookies.ts';

describe('resolveUseSecureCookies', () => {
  it('enables secure cookies when explicitly forced', () => {
    expect(resolveUseSecureCookies({
      AICHAT_LOCAL_SMOKE: '1',
      AICHAT_SECURE_COOKIES: '1',
    })).toBe(true);
  });

  it('disables secure cookies for local smoke mode', () => {
    expect(resolveUseSecureCookies({
      AICHAT_LOCAL_SMOKE: '1',
      NODE_ENV: 'production',
    })).toBe(false);
  });

  it('enables secure cookies in production by default', () => {
    expect(resolveUseSecureCookies({ NODE_ENV: 'production' })).toBe(true);
  });

  it('disables secure cookies in development by default', () => {
    expect(resolveUseSecureCookies({ NODE_ENV: 'development' })).toBe(false);
  });
});
