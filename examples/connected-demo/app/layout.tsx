import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { docsUrl, isPublicDemo } from '../lib/config.ts';
import { currentUser } from '../lib/session.ts';
import './demo.css';

export const metadata: Metadata = { title: 'Uncage · Connected demo' };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();
  const docs = docsUrl();
  return (
    <html lang="zh-CN">
      <body>
        {isPublicDemo() ? (
          <div className="demo-banner" role="note">
            临时体验环境：数据可能随时清空，请不要放重要内容。Claude Code 在你自己的电脑上运行，用你自己的 Claude 账号。
            {docs ? (
              <>
                {' '}
                <a href={docs}>了解 Uncage →</a>
              </>
            ) : null}
          </div>
        ) : null}
        <header className="demo-nav">
          <a className="demo-brand" href="/">
            Uncage Connected Demo
          </a>
          <nav>
            <a href="/">对话</a>
            <a href="/assets">素材</a>
          </nav>
          <span className="demo-spacer" />
          {user && isPublicDemo() ? (
            // Public demo: no log out. The guest identity is the only key to the linked computer and
            // the assets; signing in again would mint a new guest and orphan them.
            <span className="demo-user">
              <span data-testid="demo-user">{user.name}</span>
            </span>
          ) : user ? (
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
