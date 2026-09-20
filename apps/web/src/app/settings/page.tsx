import React from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import ApiKeyForm from '@/components/settings/apikey-form';
import { auth } from '@/lib/auth';

export default async function SettingsPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) redirect('/login');
  return <ApiKeyForm />;
}
