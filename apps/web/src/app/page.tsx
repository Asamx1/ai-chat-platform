import React from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import ChatApp from '@/components/chat/ChatApp';
import { auth } from '@/lib/auth';

export default async function HomePage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) redirect('/login');
  return <ChatApp isAdmin={session.user.role === 'ADMIN' && !('disabled' in session.user && session.user.disabled === true)} />;
}
