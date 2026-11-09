/**
 * A native Cloudflare Worker (no framework) serving Uncage Connected Mode:
 *
 * - `/api/uncage/*`: the hub (browser API, device login, `install.sh`, and the agents' HTTP
 *   streaming transport) through `fetchOnce`: one hub per request, closed after the response.
 * - `GET|POST /login`: DEMO sign-in, no password — refused unless the host is local or
 *   `ALLOW_DEMO_LOGIN=1` (see src/auth.ts; a real site uses its own auth in `getUser`, src/hub.ts).
 * - `GET|POST /device`: the page where a signed-in user approves `uncage setup`'s code.
 * - `GET /notes`: the signed-in user's notes (JSON), written by the `save_note` site tool.
 */
import { fetchOnce, type PgPoolLike } from '@uncage/hub';
import { demoLoginAllowed, loginCookie, secretProblem, signUser, userFromRequest, validUserName } from './auth.ts';
import { makeHub, newPool, type Env } from './hub.ts';
import { notesDb } from './tools.ts';

export type { Env } from './hub.ts';

/** The slice of Workers' `ExecutionContext` this Worker uses. */
export interface ExecutionContext {
  waitUntil(p: Promise<unknown>): void;
}

const API = '/api/uncage';

/** The database (or building a hub on it) failed: logged, and answered 503 without internals. */
class Unavailable extends Error {}

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

  /** `makeHub` on `pool`; a failure (database down, migrations) becomes `Unavailable`. */
  const hubOn = async (env: Env, pool: PgPoolLike) => {
    try {
      return await makeHub(env, pool);
    } catch (e) {
      throw new Unavailable('database unavailable', { cause: e });
    }
  };

  async function route(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === API || path.startsWith(`${API}/`)) {
      try {
        return await fetchOnce(
          async (defer) => {
            const pool = deps.pool(env);
            defer(() => pool.end()); // also runs if building the hub fails
            return hubOn(env, pool);
          },
          req,
          // Cloudflare sets cf-connecting-ip: the client address for the hub's per-IP rate limits.
          { waitUntil: ctx.waitUntil.bind(ctx), clientIp: req.headers.get('cf-connecting-ip') ?? undefined },
        );
      } catch (e) {
        // fetchOnce rethrows a failed `create` (after its cleanups ran): answer like the hub would.
        console.error('uncage hub unavailable:', e instanceof Unavailable ? e.cause : e);
        return Response.json(
          { error: { code: 'unavailable', message: 'The website cannot reach its database right now. Try again shortly.' } },
          { status: 503, headers: { 'retry-after': '5' } },
        );
      }
    }
    if (path === '/login' && (req.method === 'GET' || req.method === 'POST')) return login(req, url, env);
    if (path === '/device' && (req.method === 'GET' || req.method === 'POST')) {
      const user = await userFromRequest(req, env.DEMO_SECRET);
      if (!user) return page('Sign in', signInPrompt(req, env, `/device${url.search}`), 401);
      return withPool(env, ctx, async (pool) => {
        const { hub, close } = await hubOn(env, pool);
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
      if (!user) return Response.json({ error: 'Sign in first (/login).' }, { status: 401 });
      return withPool(env, ctx, async (pool) => {
        let notes;
        try {
          notes = await notesDb(pool, env.HYPERDRIVE.connectionString).list(user.id);
        } catch (e) {
          throw new Unavailable('database unavailable', { cause: e });
        }
        return Response.json(notes);
      });
    }
    if (path === '/' && req.method === 'GET') return home(req, env);
    return new Response('Not found', { status: 404 });
  }

  return {
    async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      // A setup mistake gets one clear answer instead of failing deep inside a route.
      const problem = secretProblem(env.DEMO_SECRET);
      if (problem) {
        console.error(`setup: ${problem}`);
        return new Response(`This Worker is not set up yet.\n\n${problem}\n`, { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }
      try {
        return await route(req, env, ctx);
      } catch (e) {
        if (e instanceof Unavailable) {
          console.error('database unavailable:', e.cause);
          return new Response('Database unavailable. Try again shortly.', { status: 503, headers: { 'retry-after': '5' } });
        }
        console.error('unexpected error:', e);
        return new Response('Something went wrong.', { status: 500 });
      }
    },
  };
}

export default createWorker();

const DEMO_LOGIN_WARNING =
  '<p style="background:#fef3c7;border:1px solid #f59e0b;padding:.75rem"><b>Demo sign-in:</b> anyone can sign in as any name, with no password. It only works on localhost or with <code>ALLOW_DEMO_LOGIN=1</code>. A real website returns its own signed-in user from <code>getUser</code> in <code>src/hub.ts</code>.</p>';

async function login(req: Request, url: URL, env: Env): Promise<Response> {
  if (!demoLoginAllowed(req, env.ALLOW_DEMO_LOGIN)) {
    return page(
      'Sign-in disabled',
      '<p>The demo sign-in lets anyone become any user, so it is off on a public host. Plug your real sign-in into <code>getUser</code> in <code>src/hub.ts</code>, or set <code>ALLOW_DEMO_LOGIN=1</code> for a throwaway demo.</p>',
      403,
    );
  }
  if (req.method === 'GET') return page('Sign in', DEMO_LOGIN_WARNING + signInForm(safeNext(url.searchParams.get('next'))));
  // POST only, from this site's own form: a cross-site page cannot sign a visitor in as someone else.
  const origin = req.headers.get('origin');
  if (origin !== null && origin !== url.origin && origin !== new URL(env.PUBLIC_URL).origin) return page('Sign in', '<p>Cross-site request refused.</p>', 403);
  const form = await req.formData();
  const name = String(form.get('user') ?? '');
  const next = safeNext(form.get('next')?.toString() ?? null);
  if (!validUserName(name)) return page('Sign in', `<p>Pick a user name: 1–32 letters, digits, "-" or "_".</p>${signInForm(next)}`, 400);
  return new Response(null, {
    status: 303,
    headers: { location: next, 'set-cookie': loginCookie(await signUser(name, env.DEMO_SECRET), req) },
  });
}

/** `next` when it is a path on this site, else `/` (no open redirect). */
function safeNext(next: string | null): string {
  const n = next ?? '/';
  return n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/\\') ? n : '/';
}

/** The sign-in form where the demo sign-in is allowed, else a pointer to the real seam. */
function signInPrompt(req: Request, env: Env, next: string): string {
  return demoLoginAllowed(req, env.ALLOW_DEMO_LOGIN)
    ? DEMO_LOGIN_WARNING + signInForm(next)
    : '<p>Sign in through the website first (this example\'s demo sign-in is off on a public host).</p>';
}

async function home(req: Request, env: Env): Promise<Response> {
  const user = await userFromRequest(req, env.DEMO_SECRET);
  const origin = new URL(req.url).origin;
  const body = user
    ? `${DEMO_LOGIN_WARNING}<p>Signed in as <b>${esc(user.name ?? user.id)}</b>.</p>
<ol><li>Connect your computer: <pre>curl -fsSL ${esc(origin)}${API}/install.sh | bash
uncage setup ${esc(origin)}</pre> and approve the code on <a href="/device">/device</a>.</li>
<li>Drive a run through the browser API under <code>${API}</code> (or <code>scripts/smoke.ts</code>).</li>
<li>Your notes: <a href="/notes">/notes</a>.</li></ol>`
    : signInPrompt(req, env, '/');
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
      // Too many wrong codes: the hub's message says when to retry. Anything else is our fault.
      if ((e as { code?: unknown } | null)?.code === 'rate_limited') {
        return page('Device', `<p>${esc(e instanceof Error ? e.message : String(e))}</p>`, 429);
      }
      console.error('device decision failed:', e);
      return page('Device', '<p>Something went wrong. Try again.</p>', 500);
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
      if ((e as { code?: unknown } | null)?.code !== 'rate_limited') {
        console.error('device lookup failed:', e);
        return page('Device', '<p>Something went wrong. Try again.</p>', 500);
      }
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
  return `<form method="post" action="/login">
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
