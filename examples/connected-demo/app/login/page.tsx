import { safeNext } from '../../lib/session-utils.ts';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { next, error } = await searchParams;
  return (
    <form className="demo-login" action="/auth/login" method="post">
      <h1>登录</h1>
      <p className="demo-warning">
        演示专用登录：只填用户名，没有密码，任何人都可以用任意用户名登录。真实网站请换成你自己的登录系统。
      </p>
      <input type="hidden" name="next" value={safeNext(next)} />
      <label htmlFor="username">用户名</label>
      <input id="username" name="username" autoComplete="username" required pattern="[A-Za-z0-9][A-Za-z0-9_\-]{0,31}" />
      {error ? <p role="alert">用户名只能包含字母、数字、下划线和短横线（最多 32 个字符）。</p> : null}
      <button className="demo-btn" type="submit">
        登录
      </button>
    </form>
  );
}
