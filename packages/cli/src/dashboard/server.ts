import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openUrlCommand, type ExecFn } from '@uncage/agent';
import type { AcpRegistry, Which } from '@uncage/runtime-acp';
import { detectLocale, type DialogLocale } from '../confirm-dialog.js';
import type { AgentService } from '../service/index.js';
import { ActionError, dashboardData, disconnectSite, setRuntime, type DashboardDeps } from './actions.js';
import { dashboardPage } from './page.js';

export const DASHBOARD_HELP = `uncage dashboard - a local page for this computer's connected websites

Usage:
  uncage dashboard [--no-browser]

Opens a page (only on this computer, at 127.0.0.1) that shows every connected website with its
domain, machine id, status and recent activity, lets you disconnect a website (like
"uncage sites remove") and turn ACP agents on or off (like "uncage runtimes enable|disable").
The link works once (it carries a one-time secret, traded for a session in that browser); the
page stops when you close it or after 30 minutes idle. Run it again for a new link.

Options:
  --no-browser   Print the link instead of opening a browser.
  -h, --help     Show this help.`;

export interface StartDashboardDeps {
  home: string;
  exec: ExecFn;
  /** Open the browser (default true). */
  open?: boolean;
  /** Stop after this long without a request (default 30 min). */
  idleMs?: number;
  /** Stop this long after the page closed (`/api/bye`) unless it comes back (a reload). Default 10 s. */
  graceMs?: number;
  platform?: NodeJS.Platform;
  /** The background agent, restarted after changes (null: none). Default null. */
  service?: AgentService | null;
  fetch?: typeof fetch;
  locale?: DialogLocale;
  registry?: AcpRegistry;
  which?: Which;
}

export interface Dashboard {
  /** `http://127.0.0.1:<port>/?t=<token>`: the one link that opens the page. */
  url: string;
  /** Resolves once the server stopped (idle, page closed, or `close()`). */
  closed: Promise<void>;
  close(): Promise<void>;
}

const sameSecret = (a: string | undefined, b: string): boolean => {
  if (a === undefined) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** A path segment; a malformed escape is a bad request (400), not a server error. */
function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new ActionError(400, 'bad_request', 'Malformed path.');
  }
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
} as const;

/**
 * `uncage dashboard`: a page on 127.0.0.1 (random port). Every request must carry `Host:
 * 127.0.0.1:<port>` (DNS rebinding) and no foreign `Origin`. The link's 32-byte token works once:
 * it is traded for a separate session secret in an HttpOnly SameSite=Strict cookie, and `/api/*`
 * also needs the session's header token (`x-uncage-dashboard`, embedded in the page). State
 * changes are POSTs with both and this page's own `Origin`. No CORS headers, ever.
 */
export async function startDashboard(d: StartDashboardDeps): Promise<Dashboard> {
  /** The link's one-time token: void once traded for a session. */
  let token: string | null = randomBytes(32).toString('base64url');
  const linkToken = token;
  /** The session: a cookie secret, and a header token only the page's own script can read. */
  let session: { cookie: string; api: string } | null = null;
  const locale = d.locale ?? detectLocale(process.env);
  const deps: DashboardDeps = {
    home: d.home,
    service: d.service ?? null,
    fetch: d.fetch ?? fetch,
    ...(d.registry ? { registry: d.registry } : {}),
    ...(d.which ? { which: d.which } : {}),
  };
  const idleMs = d.idleMs ?? 1_800_000;
  const graceMs = d.graceMs ?? 10_000;
  let host = '';
  let self = '';
  let cookieName = '';

  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => (resolveClosed = r));
  let timer: NodeJS.Timeout | undefined;
  const arm = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => void close(), ms);
    timer.unref();
  };

  const send = (res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}) => {
    res.writeHead(status, { ...SECURITY_HEADERS, 'content-length': Buffer.byteLength(body), ...headers });
    res.end(body);
  };
  const json = (res: ServerResponse, status: number, v: unknown) => send(res, status, JSON.stringify(v), { 'content-type': 'application/json; charset=utf-8' });
  const deny = (res: ServerResponse) => send(res, 403, 'Forbidden', { 'content-type': 'text/plain; charset=utf-8' });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // DNS rebinding: a page on evil.com resolving to 127.0.0.1 sends its own Host.
    if (req.headers.host !== host) return deny(res);
    // Another origin (a web page, even another localhost port) never gets anything.
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== self) return deny(res);
    const url = new URL(req.url ?? '/', self);
    const method = req.method ?? 'GET';

    if (method === 'GET' && url.pathname === '/' && url.searchParams.has('t')) {
      if (token === null || !sameSecret(url.searchParams.get('t') ?? undefined, token)) return deny(res);
      // One time: trade the link's token for a fresh session secret in a cookie, and drop it from
      // the address bar (and history). The link opens nothing after this.
      token = null;
      session = { cookie: randomBytes(32).toString('base64url'), api: randomBytes(32).toString('base64url') };
      arm(idleMs);
      return send(res, 303, '', {
        location: '/',
        'set-cookie': `${cookieName}=${session.cookie}; HttpOnly; SameSite=Strict; Path=/`,
      });
    }
    if (!session || !sameSecret(cookieValue(req.headers.cookie, cookieName), session.cookie)) return deny(res);
    // Cookies ignore ports, so another 127.0.0.1 server could collect this one: the API also needs
    // the header token, which only the page (same origin) can read.
    if (url.pathname.startsWith('/api/')) {
      const header = req.headers['x-uncage-dashboard'];
      if (!sameSecret(typeof header === 'string' ? header : undefined, session.api)) return deny(res);
    }
    arm(idleMs);

    if (method === 'GET' && url.pathname === '/') {
      const nonce = randomBytes(16).toString('base64');
      return send(res, 200, dashboardPage(locale, nonce, session.api), {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      });
    }
    if (method === 'GET' && url.pathname === '/api/sites') return json(res, 200, await dashboardData(deps));
    if (method !== 'POST') return send(res, 404, 'Not found', { 'content-type': 'text/plain; charset=utf-8' });

    // State changes: the cookie (checked above) and this page's own Origin, never a missing one.
    if (origin !== self) return deny(res);
    if (url.pathname === '/api/bye') {
      arm(graceMs);
      return send(res, 204, '');
    }
    const site = /^\/api\/sites\/([^/]+)\/disconnect$/.exec(url.pathname);
    if (site) return json(res, 200, await disconnectSite(deps, decode(site[1]!)));
    const rt = /^\/api\/runtimes\/([^/]+)\/(enable|disable)$/.exec(url.pathname);
    if (rt) return json(res, 200, await setRuntime(deps, decode(rt[1]!), rt[2] === 'enable'));
    return json(res, 404, { error: { code: 'not_found', message: 'Not found.' } });
  }

  const server = createServer((req, res) => {
    // Bodies are never needed; drain whatever is sent.
    req.resume();
    handle(req, res).catch((e: unknown) => {
      if (res.headersSent) return res.destroy();
      if (e instanceof ActionError) json(res, e.status, { error: { code: e.code, message: e.message } });
      else json(res, 500, { error: { code: 'internal', message: e instanceof Error ? e.message : String(e) } });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  host = `127.0.0.1:${port}`;
  self = `http://${host}`;
  // Cookies ignore ports: one name per dashboard so two never clash.
  cookieName = `uncage_dashboard_${port}`;
  arm(idleMs);

  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    closing ??= new Promise<void>((resolve) => {
      clearTimeout(timer);
      server.close(() => resolve());
      server.closeAllConnections();
    }).then(resolveClosed);
    return closing;
  }

  const url = `${self}/?t=${linkToken}`;
  if (d.open !== false) {
    await d.exec(...openUrlCommand(url, d.platform ?? process.platform)).catch(() => undefined);
  }
  return { url, closed, close };
}
