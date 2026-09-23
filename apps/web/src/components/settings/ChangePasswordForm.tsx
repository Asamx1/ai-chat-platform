'use client';

import React, { useRef, useState } from 'react';
import { changePassword } from './change-password';

export default function ChangePasswordForm() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  return <section className="settings-card" aria-labelledby="password-title">
    <div className="settings-card-title"><h2 id="password-title">修改密码</h2></div>
    <form className="settings-form" noValidate onSubmit={async (event) => {
      event.preventDefault();
      if (submitting.current) return;
      submitting.current = true;
      setPending(true);
      setError(null);
      setSuccess(false);
      try {
        const message = await changePassword(currentPassword, newPassword, confirmation);
        setError(message);
        if (!message) {
          setCurrentPassword('');
          setNewPassword('');
          setConfirmation('');
          setSuccess(true);
        }
      } finally {
        submitting.current = false;
        setPending(false);
      }
    }}>
      {[
        { id: 'current-password', label: '当前密码', value: currentPassword, set: setCurrentPassword, autocomplete: 'current-password' },
        { id: 'new-password', label: '新密码', value: newPassword, set: setNewPassword, autocomplete: 'new-password' },
        { id: 'confirm-password', label: '确认新密码', value: confirmation, set: setConfirmation, autocomplete: 'new-password' },
      ].map(field => <div className="login-field" key={field.id}>
        <label htmlFor={field.id}>{field.label}</label>
        <input id={field.id} name={field.id} className="login-input" type="password" required
          autoComplete={field.autocomplete} value={field.value} disabled={pending}
          onChange={event => { field.set(event.target.value); setError(null); setSuccess(false); }} />
      </div>)}
      <p className="settings-hint">新密码长度须为 8 至 128 个字符。</p>
      {error && <p className="settings-error" role="alert">{error}</p>}
      {success && <p role="status">密码修改成功</p>}
      <button className="btn-primary" type="submit" disabled={pending}>{pending ? '修改中…' : '修改密码'}</button>
    </form>
  </section>;
}
