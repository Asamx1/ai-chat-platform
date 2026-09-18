import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'ai-chat-platform',
  description: 'AI chat platform — multi-model conversations',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <main>{children}</main>
      </body>
    </html>
  );
}
