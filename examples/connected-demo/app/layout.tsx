import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { currentUser } from '../lib/session.ts';
import './demo.css';

export const metadata: Metadata = { title: 'Uncage · Connected demo' };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();
  return (
    <html lang="zh-CN">
      <body>
        <header className="demo-nav">
          <a className="demo-brand" href="/">
            Uncage Connected Demo
          </a>
          <nav>
            <a href="/">对话</a>
            <a href="/assets">素材</a>
          </nav>
          <span className="demo-spacer" />
          {user ? (
            <form action="/auth/logout" method="post" className="demo-user">
              <span data-testid="demo-user">{user.name}</span>
              <button type="submit">退出</button>
            </form>
          ) : (
            <a href="/login">登录</a>
          )}
        </header>
        <main className="demo-main">{children}</main>
      </body>
    </html>
  );
}
