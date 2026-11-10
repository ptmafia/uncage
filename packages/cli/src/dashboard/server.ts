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
The link works once (it carries a one-time secret after "#", traded for a session in that browser
tab); the page stops when you close it or after 30 minutes idle. Run it again for a new link.

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
  /** `http://127.0.0.1:<port>/#t=<token>`: the one link that opens the page (the token is never sent in a request line). */
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
 * 127.0.0.1:<port>` (DNS rebinding) and no foreign `Origin`. No cookies (they ignore ports, so any
 * other 127.0.0.1 server could collect one). The link's 32-byte token sits in the URL fragment,
 * which browsers never send: `GET /` serves a page with no secret, whose script trades the token
 * once (`POST /api/session`, header `x-uncage-link`, this page's own `Origin`) for an API token it
 * keeps in `sessionStorage` (per origin, so per port). Every other `/api/*` needs that token in
 * `x-uncage-dashboard`; state changes are POSTs that also carry this page's own `Origin`. No CORS
 * headers, ever.
 */
export async function startDashboard(d: StartDashboardDeps): Promise<Dashboard> {
  /** The link's one-time token: void once traded for a session. */
  let token: string | null = randomBytes(32).toString('base64url');
  const linkToken = token;
  /** The session's API token (header `x-uncage-dashboard`), once the link was traded. */
  let api: string | null = null;
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
  const header = (req: IncomingMessage, name: string): string | undefined => {
    const v = req.headers[name];
    return typeof v === 'string' ? v : undefined;
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // DNS rebinding: a page on evil.com resolving to 127.0.0.1 sends its own Host.
    if (req.headers.host !== host) return deny(res);
    // Another origin (a web page, even another localhost port) never gets anything.
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== self) return deny(res);
    const url = new URL(req.url ?? '/', self);
    const method = req.method ?? 'GET';

    // The page itself holds no secret: anyone who can reach it learns nothing.
    if (method === 'GET' && url.pathname === '/') {
      const nonce = randomBytes(16).toString('base64');
      return send(res, 200, dashboardPage(locale, nonce), {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      });
    }
    if (!url.pathname.startsWith('/api/')) return send(res, 404, 'Not found', { 'content-type': 'text/plain; charset=utf-8' });

    // One time: the link's token (from the fragment, read by the page script) becomes the API token.
    if (url.pathname === '/api/session') {
      if (method !== 'POST' || origin !== self || token === null || !sameSecret(header(req, 'x-uncage-link'), token)) return deny(res);
      token = null;
      api = randomBytes(32).toString('base64url');
      arm(idleMs);
      return json(res, 200, { apiToken: api });
    }
    if (api === null || !sameSecret(header(req, 'x-uncage-dashboard'), api)) return deny(res);
    arm(idleMs);

    if (method === 'GET' && url.pathname === '/api/sites') return json(res, 200, await dashboardData(deps));
    if (method !== 'POST') return send(res, 404, 'Not found', { 'content-type': 'text/plain; charset=utf-8' });

    // State changes: the API token (checked above) and this page's own Origin, never a missing one.
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

  const url = `${self}/#t=${linkToken}`;
  if (d.open !== false) {
    await d.exec(...openUrlCommand(url, d.platform ?? process.platform)).catch(() => undefined);
  }
  return { url, closed, close };
}
