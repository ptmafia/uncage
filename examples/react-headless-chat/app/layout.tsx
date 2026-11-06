import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './chat.css';

export const metadata: Metadata = { title: 'Uncage · headless chat' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
