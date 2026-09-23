'use client';

import { useRouter } from 'next/navigation';
import React, { type FormEvent, useEffect, useRef, useState } from 'react';

import { installLoginController, type LoginController } from '@/components/auth/login-controller';
import { signIn } from '@/lib/auth-client';
import { authenticateWithEmail } from '@/lib/login-flow';

export default function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const controllerRef = useRef<LoginController | null>(null);

  useEffect(() => {
    return installLoginController(controllerRef, {
      authenticate: authenticateWithEmail,
      signInEmail: signIn.email,
      replace: router.replace,
      refresh: router.refresh,
      setPending,
      setError,
      scheduleRecovery: (callback, delayMs) => {
        const timerId = window.setTimeout(callback, delayMs);
        return () => window.clearTimeout(timerId);
      },
    });
  }, [router]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await controllerRef.current?.submit(email, password);
  }

  return (
    <div className="login-shell">
      <section className="login-card" aria-labelledby="login-heading">
        <div className="login-brand">
          <h1 id="login-heading">登录 AI Chat</h1>
          <p>使用管理员账号继续</p>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="login-field">
            <label htmlFor="login-email">邮箱</label>
            <input
              className="input"
              id="login-email"
              name="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </div>

          <div className="login-field">
            <label htmlFor="login-password">密码</label>
            <input
              className="input"
              id="login-password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </div>

          <button className="btn btn-primary login-submit" type="submit" disabled={pending}>
            {pending ? '登录中…' : '登录'}
          </button>

          <div className="login-error" role="status" aria-live="polite">
            {error}
          </div>
        </form>

        <p className="login-hint">
          演示账号：<strong>admin@example.com</strong>
        </p>
      </section>
    </div>
  );
}
