import React from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import LoginForm from '@/components/auth/LoginForm';
import { auth } from '@/lib/auth';

export default async function LoginPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (session?.user) redirect('/');
  return <LoginForm />;
}
