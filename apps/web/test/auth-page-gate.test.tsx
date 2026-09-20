import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const redirectSentinel = new Error('NEXT_REDIRECT_SENTINEL');

  return {
    session: null as { user: { id: string } } | null,
    requestHeaders: new Headers({ cookie: 'session=test' }),
    redirectSentinel,
    redirect: vi.fn(() => {
      throw redirectSentinel;
    }),
    getSession: vi.fn(),
    chatApp: vi.fn(() => <div>Chat app</div>),
    loginForm: vi.fn(() => <form>Login form</form>),
  };
});

vi.mock('next/headers', () => ({
  headers: vi.fn(async () => mocks.requestHeaders),
}));

vi.mock('next/navigation', () => ({
  redirect: mocks.redirect,
}));

vi.mock('@/lib/auth', () => ({
  auth: {
    api: {
      getSession: mocks.getSession,
    },
  },
}));

vi.mock('@/components/chat/ChatApp', () => ({
  default: mocks.chatApp,
}));

vi.mock('@/components/auth/LoginForm', () => ({
  default: mocks.loginForm,
}));

import HomePage from '@/app/page';
import LoginPage from '@/app/login/page';

describe('server-side auth page gates', () => {
  beforeEach(() => {
    mocks.session = null;
    vi.clearAllMocks();
    mocks.getSession.mockImplementation(async () => mocks.session);
  });

  it('redirects an anonymous HomePage request to /login without rendering ChatApp', async () => {
    await expect(HomePage()).rejects.toBe(mocks.redirectSentinel);

    expect(mocks.getSession).toHaveBeenCalledWith({ headers: mocks.requestHeaders });
    expect(mocks.redirect).toHaveBeenCalledWith('/login');
    expect(mocks.chatApp).not.toHaveBeenCalled();
  });

  it('returns ChatApp for an authenticated HomePage request', async () => {
    mocks.session = { user: { id: 'user-1' } };

    const markup = renderToStaticMarkup(await HomePage());

    expect(markup).toContain('Chat app');
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.chatApp).toHaveBeenCalledTimes(1);
  });

  it('returns LoginForm for an anonymous LoginPage request', async () => {
    const markup = renderToStaticMarkup(await LoginPage());

    expect(markup).toContain('Login form');
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.loginForm).toHaveBeenCalledTimes(1);
  });

  it('redirects an authenticated LoginPage request to / without rendering LoginForm', async () => {
    mocks.session = { user: { id: 'user-1' } };

    await expect(LoginPage()).rejects.toBe(mocks.redirectSentinel);

    expect(mocks.getSession).toHaveBeenCalledWith({ headers: mocks.requestHeaders });
    expect(mocks.redirect).toHaveBeenCalledWith('/');
    expect(mocks.loginForm).not.toHaveBeenCalled();
  });
});
