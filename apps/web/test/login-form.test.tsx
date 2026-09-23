import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const replace = vi.fn();
const refresh = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, refresh }),
}));

vi.mock('@/lib/auth-client', () => ({
  signIn: {
    email: vi.fn(),
  },
}));

import LoginForm from '@/components/auth/LoginForm';
import {
  createLoginController,
  installLoginController,
  type LoginControllerSlot,
} from '@/components/auth/login-controller';

describe('LoginForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders an accessible login form without prefilling the password', () => {
    const markup = renderToStaticMarkup(<LoginForm />);

    expect(markup).toContain('<label for="login-email">邮箱</label>');
    expect(markup).toContain('id="login-email"');
    expect(markup).toContain('name="email"');
    expect(markup).toContain('type="email"');
    expect(markup).toContain('autoComplete="email"');

    expect(markup).toContain('<label for="login-password">密码</label>');
    expect(markup).toContain('id="login-password"');
    expect(markup).toContain('name="password"');
    expect(markup).toContain('type="password"');
    expect(markup).toContain('autoComplete="current-password"');
    expect(markup).not.toMatch(/name="password"[^>]*value="[^"\s]+"/);

    expect(markup).toContain('<button');
    expect(markup).toContain('type="submit"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('demo@example.com');
  });
});

describe('createLoginController', () => {
  it('trims the email, reports pending state, and surfaces authentication failures', async () => {
    const authenticate = vi.fn().mockResolvedValue({ ok: false, message: '邮箱或密码错误' });
    const setPending = vi.fn();
    const setError = vi.fn();
    const controller = createLoginController({
      authenticate,
      signInEmail: vi.fn(),
      replace: vi.fn(),
      refresh: vi.fn(),
      setPending,
      setError,
      scheduleRecovery: vi.fn(() => vi.fn()),
    });

    await controller.submit('  admin@example.com  ', 'secret');

    expect(authenticate).toHaveBeenCalledWith('admin@example.com', 'secret', expect.any(Function));
    expect(setPending.mock.calls).toEqual([[true], [false]]);
    expect(setError.mock.calls).toEqual([[''], ['邮箱或密码错误']]);
  });

  it('ignores duplicate submissions while authentication is pending', async () => {
    let finishAuthentication: ((result: { ok: false; message: string }) => void) | undefined;
    const authenticate = vi.fn().mockImplementation(
      () => new Promise((resolve) => {
        finishAuthentication = resolve;
      }),
    );
    const controller = createLoginController({
      authenticate,
      signInEmail: vi.fn(),
      replace: vi.fn(),
      refresh: vi.fn(),
      setPending: vi.fn(),
      setError: vi.fn(),
      scheduleRecovery: vi.fn(() => vi.fn()),
    });

    const firstSubmission = controller.submit('admin@example.com', 'secret');
    await controller.submit('second@example.com', 'different');

    expect(authenticate).toHaveBeenCalledTimes(1);
    finishAuthentication?.({ ok: false, message: '登录失败' });
    await firstSubmission;
  });

  it("navigates with replace('/') before refresh and recovers pending after a delay", async () => {
    const events: string[] = [];
    const setPending = vi.fn((pending: boolean) => events.push(`pending:${pending}`));
    let recover: (() => void) | undefined;
    const scheduleRecovery = vi.fn((callback: () => void) => {
      recover = callback;
      return vi.fn();
    });
    const controller = createLoginController({
      authenticate: vi.fn().mockResolvedValue({ ok: true }),
      signInEmail: vi.fn(),
      replace: vi.fn((path: string) => events.push(`replace:${path}`)),
      refresh: vi.fn(() => events.push('refresh')),
      setPending,
      setError: vi.fn(),
      scheduleRecovery,
    });

    await controller.submit('admin@example.com', 'secret');

    expect(events).toEqual(['pending:true', 'replace:/', 'refresh']);
    expect(scheduleRecovery).toHaveBeenCalledWith(expect.any(Function), 1500);

    recover?.();

    expect(events).toEqual(['pending:true', 'replace:/', 'refresh', 'pending:false']);

    await controller.submit('admin@example.com', 'secret');
    expect(events).toEqual([
      'pending:true',
      'replace:/',
      'refresh',
      'pending:false',
      'pending:true',
      'replace:/',
      'refresh',
    ]);
  });

  it('cancels pending recovery and suppresses state updates when disposed', async () => {
    const setPending = vi.fn();
    const cancelRecovery = vi.fn();
    let recover: (() => void) | undefined;
    const controller = createLoginController({
      authenticate: vi.fn().mockResolvedValue({ ok: true }),
      signInEmail: vi.fn(),
      replace: vi.fn(),
      refresh: vi.fn(),
      setPending,
      setError: vi.fn(),
      scheduleRecovery: vi.fn((callback: () => void) => {
        recover = callback;
        return cancelRecovery;
      }),
    });

    await controller.submit('admin@example.com', 'secret');
    controller.dispose();
    recover?.();

    expect(cancelRecovery).toHaveBeenCalledTimes(1);
    expect(setPending.mock.calls).toEqual([[true]]);
  });

  it('installs a fresh working controller after an effect cleanup cycle', async () => {
    const slot: LoginControllerSlot = { current: null };
    const firstAuthenticate = vi.fn().mockResolvedValue({ ok: false, message: 'first' });
    const secondAuthenticate = vi.fn().mockResolvedValue({ ok: false, message: 'second' });
    const baseDependencies = {
      signInEmail: vi.fn(),
      replace: vi.fn(),
      refresh: vi.fn(),
      setPending: vi.fn(),
      setError: vi.fn(),
      scheduleRecovery: vi.fn(() => vi.fn()),
    };

    const cleanupFirst = installLoginController(slot, {
      ...baseDependencies,
      authenticate: firstAuthenticate,
    });
    cleanupFirst();
    expect(slot.current).toBeNull();

    const cleanupSecond = installLoginController(slot, {
      ...baseDependencies,
      authenticate: secondAuthenticate,
    });
    await slot.current?.submit('admin@example.com', 'secret');

    expect(firstAuthenticate).not.toHaveBeenCalled();
    expect(secondAuthenticate).toHaveBeenCalledTimes(1);

    cleanupSecond();
    expect(slot.current).toBeNull();
  });
});
