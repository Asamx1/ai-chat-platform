import React from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import AdminConsole from '@/components/admin/AdminConsole';

export default async function AdminPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) redirect('/login');
  if (session.user.role !== 'ADMIN' || ('disabled' in session.user && session.user.disabled === true)) {
    return <main className="admin-page"><h1>403 · 无权访问</h1><p>仅管理员可访问后台控制台。</p><a className="settings-back" href="/">返回聊天</a></main>;
  }
  return <AdminConsole currentUserId={session.user.id} />;
}
