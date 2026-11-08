/**
 * A native Cloudflare Worker (no framework) serving Uncage Connected Mode:
 *
 * - `/api/uncage/*`: the hub (browser API, device login, `install.sh`, and the agents' HTTP
 *   streaming transport) through `fetchOnce`: one hub per request, closed after the response.
 * - `GET /login?user=<name>`: demo sign-in (a signed cookie; use your real auth instead).
 * - `GET|POST /device`: the page where a signed-in user approves `uncage setup`'s code.
 * - `GET /notes`: the signed-in user's notes (JSON), written by the `save_note` site tool.
 */
import { fetchOnce, type PgPoolLike } from '@uncage/hub';
import { loginCookie, signUser, userFromRequest, validUserName } from './auth.ts';
import { makeHub, newPool, type Env } from './hub.ts';
import { notesDb } from './tools.ts';

export type { Env } from './hub.ts';

/** The slice of Workers' `ExecutionContext` this Worker uses. */
export interface ExecutionContext {
  waitUntil(p: Promise<unknown>): void;
}

const API = '/api/uncage';

export function createWorker(deps: { pool(env: Env): PgPoolLike } = { pool: newPool }) {
  /** Runs `fn` on a pool of its own, ended once `fn` settles (in the background through waitUntil). */
  const withPool = async <T>(env: Env, ctx: ExecutionContext, fn: (pool: PgPoolLike) => Promise<T>): Promise<T> => {
    const pool = deps.pool(env);
    try {
      return await fn(pool);
    } finally {
      ctx.waitUntil(pool.end().catch((e: unknown) => console.error('ending the pool failed:', e)));
    }
  };

  return {
    async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;
      if (path === API || path.startsWith(`${API}/`)) {
        return fetchOnce(
          async (defer) => {
            const pool = deps.pool(env);
            defer(() => pool.end()); // also runs if building the hub fails
            return makeHub(env, pool);
          },
          req,
          // Cloudflare sets cf-connecting-ip: the client address for the hub's per-IP rate limits.
          { waitUntil: ctx.waitUntil.bind(ctx), clientIp: req.headers.get('cf-connecting-ip') ?? undefined },
        );
      }
      if (path === '/login' && req.method === 'GET') return login(req, env);
      if (path === '/device' && (req.method === 'GET' || req.method === 'POST')) {
        const user = await userFromRequest(req, env.DEMO_SECRET);
        if (!user) return page('Sign in', signInForm(`/device${url.search}`), 401);
        return withPool(env, ctx, async (pool) => {
          const { hub, close } = await makeHub(env, pool);
          try {
            return await device(req, url, env, user, hub);
          } finally {
            await hub.close();
            await close();
          }
        });
      }
      if (path === '/notes' && req.method === 'GET') {
        const user = await userFromRequest(req, env.DEMO_SECRET);
        if (!user) return Response.json({ error: 'Sign in first: /login?user=<name>' }, { status: 401 });
        return withPool(env, ctx, async (pool) => Response.json(await notesDb(pool, env.HYPERDRIVE.connectionString).list(user.id)));
      }
      if (path === '/' && req.method === 'GET') return home(req, env);
      return new Response('Not found', { status: 404 });
    },
  };
}

export default createWorker();

async function login(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const name = url.searchParams.get('user') ?? '';
  if (!validUserName(name)) return page('Sign in', `<p>Pick a user name: 1–32 letters, digits, "-" or "_".</p>${signInForm(safeNext(url))}`, 400);
  return new Response(null, {
    status: 303,
    headers: { location: safeNext(url), 'set-cookie': loginCookie(await signUser(name, env.DEMO_SECRET), req) },
  });
}

/** `next` when it is a path on this site, else `/` (no open redirect). */
function safeNext(url: URL): string {
  const next = url.searchParams.get('next') ?? '/';
  return next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/';
}

async function home(req: Request, env: Env): Promise<Response> {
  const user = await userFromRequest(req, env.DEMO_SECRET);
  const origin = new URL(req.url).origin;
  const body = user
    ? `<p>Signed in as <b>${esc(user.name ?? user.id)}</b>.</p>
<ol><li>Connect your computer: <pre>curl -fsSL ${esc(origin)}${API}/install.sh | bash
uncage setup ${esc(origin)}</pre> and approve the code on <a href="/device">/device</a>.</li>
<li>Drive a run through the browser API under <code>${API}</code> (or <code>scripts/smoke.ts</code>).</li>
<li>Your notes: <a href="/notes">/notes</a>.</li></ol>`
    : signInForm('/');
  return page('Uncage on Cloudflare Workers', body);
}

type DemoHub = Awaited<ReturnType<typeof makeHub>>['hub'];

async function device(req: Request, url: URL, env: Env, user: { id: string; name?: string }, hub: DemoHub): Promise<Response> {
  if (req.method === 'POST') {
    // Only this site's own form may approve (the cookie is SameSite=Lax; this checks Origin too).
    const origin = req.headers.get('origin');
    if (origin !== null && origin !== new URL(env.PUBLIC_URL).origin && origin !== url.origin) {
      return page('Device', '<p>Cross-site request refused.</p>', 403);
    }
    const form = await req.formData();
    const code = String(form.get('code') ?? '').trim().toUpperCase();
    const deny = form.get('decision') === 'deny';
    let result: string;
    try {
      result = deny ? await hub.denyDevice(code, user) : await hub.approveDevice(code, user);
    } catch (e) {
      return page('Device', `<p>${esc(e instanceof Error ? e.message : String(e))}</p>`, 429);
    }
    const text =
      result === 'ok'
        ? deny
          ? 'Denied. The computer was not connected.'
          : 'Approved. Your computer is connecting; you can close this page.'
        : result === 'expired'
          ? 'This code has expired. Run uncage setup again.'
          : 'Unknown code. Check it and try again.';
    return page('Device', `<p data-result="${esc(result)}">${esc(text)}</p>`, result === 'ok' ? 200 : 400);
  }
  const code = (url.searchParams.get('code') ?? '').trim().toUpperCase();
  let about = '';
  if (code) {
    try {
      const d = await hub.lookupDevice(code, user);
      about = d
        ? `<p>Computer: <b>${esc(d.name ?? 'unnamed')}</b>${d.os ? ` (${esc(d.os)})` : ''}${
            d.repairsMachine ? ` — re-pairs <b>${esc(d.repairsMachine.name)}</b>` : ''
          }</p>`
        : '<p>Unknown or expired code.</p>';
    } catch (e) {
      about = `<p>${esc(e instanceof Error ? e.message : String(e))}</p>`;
    }
  }
  return page(
    'Connect a computer',
    `<p>Signed in as <b>${esc(user.name ?? user.id)}</b>. Approve only a code you started with <code>uncage setup</code>.</p>${about}
<form method="post" action="/device">
  <label>Code <input name="code" value="${esc(code)}" autocomplete="off" required></label>
  <button name="decision" value="approve">Approve</button>
  <button name="decision" value="deny">Deny</button>
</form>`,
  );
}

function signInForm(next: string): string {
  return `<form method="get" action="/login">
  <input type="hidden" name="next" value="${esc(next)}">
  <label>User name <input name="user" pattern="[A-Za-z0-9_-]{1,32}" required></label>
  <button>Sign in</button>
</form>`;
}

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem}pre{background:#f4f4f5;padding:.75rem;overflow:auto}</style>
</head><body><h1>${esc(title)}</h1>${body}</body></html>`;
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
