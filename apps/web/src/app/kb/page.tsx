import React from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import KbPage from '@/components/kb/kb-page';
import { auth } from '@/lib/auth';

export default async function KnowledgeBasePage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) redirect('/login');
  return <KbPage />;
}
