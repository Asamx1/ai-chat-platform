import { describe, expect, it, vi } from 'vitest';

import { authenticateWithEmail } from '../src/lib/login-flow.ts';

describe('authenticateWithEmail', () => {
  it('returns ok and passes only the email credentials to Better Auth', async () => {
    const signInEmail = vi.fn().mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    });

    const result = await authenticateWithEmail(
      'person@example.com',
      'secret-password',
      signInEmail,
    );

    expect(result).toEqual({ ok: true });
    expect(signInEmail).toHaveBeenCalledOnce();
    expect(signInEmail).toHaveBeenCalledWith({
      email: 'person@example.com',
      password: 'secret-password',
    });
  });

  it('returns the credential error message for a 401 response', async () => {
    const signInEmail = vi.fn().mockResolvedValue({
      data: null,
      error: { status: 401, message: 'Unauthorized' },
    });

    const result = await authenticateWithEmail(
      'person@example.com',
      'wrong-password',
      signInEmail,
    );

    expect(result).toEqual({ ok: false, message: '邮箱或密码错误' });
  });

  it('returns a generic message for other Better Auth errors without exposing details', async () => {
    const signInEmail = vi.fn().mockResolvedValue({
      data: null,
      error: { status: 500, message: 'sensitive backend detail' },
    });

    const result = await authenticateWithEmail(
      'person@example.com',
      'secret-password',
      signInEmail,
    );

    expect(result).toEqual({ ok: false, message: '登录失败，请稍后重试' });
    expect(JSON.stringify(result)).not.toContain('sensitive backend detail');
  });

  it('returns the availability message when the transport throws', async () => {
    const signInEmail = vi.fn().mockRejectedValue(new Error('fetch failed'));

    const result = await authenticateWithEmail(
      'person@example.com',
      'secret-password',
      signInEmail,
    );

    expect(result).toEqual({
      ok: false,
      message: '登录服务暂时不可用，请稍后重试',
    });
  });
});
