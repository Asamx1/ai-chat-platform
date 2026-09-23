/** Returns a Chinese error message, or null on success. Never exposes server messages. */
export async function changePassword(currentPassword: string, newPassword: string, confirmation: string): Promise<string | null> {
  if (!currentPassword || !newPassword || !confirmation) return '请填写所有密码字段';
  if (newPassword !== confirmation) return '两次输入的新密码不一致';
  if (newPassword.length < 8 || newPassword.length > 128) return '新密码长度须为 8 至 128 个字符';
  try {
    const response = await fetch('/api/auth/change-password', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    if (response.ok) return null;
    const data = await response.json().catch(() => null) as { code?: string } | null;
    if (data?.code === 'INVALID_PASSWORD') return '当前密码不正确';
    if (data?.code === 'PASSWORD_TOO_SHORT') return '新密码至少需要 8 个字符';
    if (data?.code === 'PASSWORD_TOO_LONG') return '新密码不能超过 128 个字符';
    if (response.status === 401) return '登录已过期，请重新登录';
    if (response.status === 429) return '操作过于频繁，请稍后重试';
    return '修改密码失败，请稍后重试';
  } catch {
    return '网络异常，请稍后重试';
  }
}
