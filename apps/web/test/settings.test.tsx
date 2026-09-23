import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { changePassword } from '../src/components/settings/change-password';
import ChangePasswordForm from '../src/components/settings/ChangePasswordForm';
import ModelPrefForm from '../src/components/settings/ModelPrefForm';

const request = vi.fn();
beforeEach(() => { vi.stubGlobal('fetch', request); request.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('settings password change', () => {
  it.each([
    ['', 'new-password', 'new-password', '请填写所有密码字段'],
    ['old', 'new-password', 'different', '两次输入的新密码不一致'],
    ['old', 'short', 'short', '新密码长度须为 8 至 128 个字符'],
    ['old', 'x'.repeat(129), 'x'.repeat(129), '新密码长度须为 8 至 128 个字符'],
  ])('rejects invalid input before sending a request', async (current, next, confirm, error) => {
    expect(await changePassword(current!, next!, confirm!)).toBe(error);
    expect(request).not.toHaveBeenCalled();
  });

  it('posts only the unmodified credentials to the built-in endpoint', async () => {
    request.mockResolvedValue(new Response('{}'));
    expect(await changePassword(' old password ', ' new password ', ' new password ')).toBeNull();
    expect(request).toHaveBeenCalledExactlyOnceWith('/api/auth/change-password', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: ' old password ', newPassword: ' new password ' }),
    });
  });

  it.each([
    [400, 'INVALID_PASSWORD', '当前密码不正确'],
    [400, 'PASSWORD_TOO_SHORT', '新密码至少需要 8 个字符'],
    [400, 'PASSWORD_TOO_LONG', '新密码不能超过 128 个字符'],
    [401, 'UNAUTHORIZED', '登录已过期，请重新登录'],
    [429, '', '操作过于频繁，请稍后重试'],
    [500, 'INTERNAL_ERROR', '修改密码失败，请稍后重试'],
  ])('translates status %s / %s into Chinese', async (status, code, error) => {
    request.mockResolvedValue(new Response(JSON.stringify({ code, message: 'internal details' }), { status }));
    expect(await changePassword('old', 'new-password', 'new-password')).toBe(error);
  });

  it('handles non-JSON failures and network errors', async () => {
    request.mockResolvedValue(new Response('bad gateway', { status: 502 }));
    expect(await changePassword('old', 'new-password', 'new-password')).toBe('修改密码失败，请稍后重试');
    request.mockRejectedValue(new Error('offline'));
    expect(await changePassword('old', 'new-password', 'new-password')).toBe('网络异常，请稍后重试');
  });

  it('renders three labeled password fields with password manager hints', () => {
    const html = renderToStaticMarkup(<ChangePasswordForm />);
    expect(html.match(/type="password"/g)).toHaveLength(3);
    for (const id of ['current-password', 'new-password', 'confirm-password']) {
      expect(html).toContain(`for="${id}"`);
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('autoComplete="current-password"');
    expect(html.match(/autoComplete="new-password"/g)).toHaveLength(2);
  });
});

describe('settings model preference', () => {
  it('renders a disabled loading picker and explains when the preference takes effect', () => {
    const html = renderToStaticMarkup(<ModelPrefForm />);
    expect(html).toContain('for="default-model"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('新会话生效');
  });

  it('shares the picker storage key and reads saved preferences', async () => {
    const { STORAGE_KEY, getStoredModel } = await import('../src/components/chat/ModelPicker');
    const getItem = vi.fn().mockReturnValue('cloud-model');
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', { getItem });
    expect(getStoredModel()).toBe('cloud-model');
    expect(getItem).toHaveBeenCalledWith(STORAGE_KEY);
    expect(STORAGE_KEY).toBe('chat:modelKey');
  });

  it('reuses model fetching, fallback options and the shared cache', async () => {
    vi.resetModules();
    const { fetchModelOptions, MODEL_OPTIONS } = await import('../src/components/chat/ModelPicker');
    request.mockRejectedValueOnce(new Error('offline'));
    expect(await fetchModelOptions()).toEqual(MODEL_OPTIONS);
    request.mockResolvedValueOnce(new Response(JSON.stringify({ models: [] })));
    expect(await fetchModelOptions()).toEqual(MODEL_OPTIONS);
    request.mockResolvedValueOnce(new Response(JSON.stringify({ models: [{ id: 'cloud-model' }, { id: 'local-model' }] })));
    expect(await fetchModelOptions()).toEqual(['cloud-model', 'local-model']);
    expect(await fetchModelOptions()).toEqual(['cloud-model', 'local-model']);
    expect(request).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenLastCalledWith('/api/models', { credentials: 'include' });
  });
});
