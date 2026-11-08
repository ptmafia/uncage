import { execFile } from 'node:child_process';
import { access, constants, mkdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { redactForExport } from '@uncage/core';
import type { RuntimeAdapter } from '@uncage/protocol';
import { DEFAULT_PORT, type UncageConfig } from './config.js';
import { tokenPath } from './token.js';

export interface DoctorCheck {
  id: string;
  label: string;
  ok: boolean;
  /** A non-fatal problem: printed with `!` and never affects the exit code. */
  warn?: boolean;
  detail?: string;
  fix?: string;
}

export interface DoctorDeps {
  config: UncageConfig;
  adapters: RuntimeAdapter[];
  fetch: typeof fetch;
  home: string;
  /** Overrides the data dir (`--data-dir`). Defaults to `<home>/.uncage/data`. */
  dataDir?: string;
  /** Overrides the token file (`--token-file`). Defaults to `<home>/.uncage/token`. */
  tokenFile?: string;
  /** The git executable used for the `.uncage/` ignore check. Defaults to `git`. */
  gitCommand?: string;
  /** The daemon's base URL (`--url`, `--port`, `UNCAGE_URL`). Defaults to `http://127.0.0.1:<config port>`. */
  serverUrl?: string;
  /**
   * Workspaces for the `.uncage/` git-ignore check (`--workspace`). Defaults to the workspace the
   * running daemon reports in `/v1/health`, else the config's (what `uncage serve` here would use).
   */
  workspaces?: string[];
}

export const DOCTOR_HELP = `uncage doctor - check the local Uncage setup

Usage:
  uncage doctor [--port <n> | --url <url>] [--workspace <dir>] [--data-dir <dir>] [--token-file <file>]
  uncage doctor --export-events <sessionId> [--out <file>] [--include-content] [--port <n> | --url <url>]

Options:
  --port <n>          Port of the running daemon (same as "uncage serve --port").
  --url <url>         Base URL of the running daemon (e.g. http://127.0.0.1:4800).
  --workspace <dir>   Workspace for the .uncage/ git-ignore check (default: the one the daemon reports).
  --data-dir <dir>    Data directory to check (same as "uncage serve --data-dir").
  --token-file <file> Token file to check and use (same as "uncage serve --token-file").
  -h, --help          Show this help.

Env: UNCAGE_URL (the daemon URL, as used by the proxy), UNCAGE_PORT.
Precedence: --url, --port, UNCAGE_URL, UNCAGE_PORT, uncage.config.yaml, ${DEFAULT_PORT}.`;

export interface DoctorArgs {
  help: boolean;
  serverUrl: string;
  workspace?: string;
  dataDir?: string;
  tokenFile?: string;
  exportEvents?: string;
  out?: string;
  includeContent: boolean;
}

const trimUrl = (u: string): string => u.replace(/\/+$/, '');

/** Parses `uncage doctor` arguments (paths resolved against `cwd`). Throws on unknown options. */
export function parseDoctorArgs(args: string[], env: NodeJS.ProcessEnv, config: UncageConfig, cwd: string): DoctorArgs {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      port: { type: 'string' },
      url: { type: 'string' },
      workspace: { type: 'string' },
      'export-events': { type: 'string' },
      out: { type: 'string' },
      'include-content': { type: 'boolean', default: false },
      'data-dir': { type: 'string' },
      'token-file': { type: 'string' },
    },
  });
  let serverUrl: string;
  if (values.url) {
    try {
      serverUrl = trimUrl(new URL(values.url).href);
    } catch {
      throw new Error(`--url must be an absolute URL such as http://127.0.0.1:4800 (got "${values.url}").`);
    }
  } else if (values.port !== undefined) {
    const port = Number(values.port);
    if (!/^\d+$/.test(values.port) || port < 1 || port > 65535) {
      throw new Error(`--port must be an integer between 1 and 65535 (got "${values.port}").`);
    }
    serverUrl = `http://127.0.0.1:${port}`;
  } else if (env.UNCAGE_URL) serverUrl = trimUrl(env.UNCAGE_URL);
  else serverUrl = `http://127.0.0.1:${config.server.port}`;
  return {
    help: values.help ?? false,
    serverUrl,
    includeContent: values['include-content'] ?? false,
    ...(values.workspace ? { workspace: resolve(cwd, values.workspace) } : {}),
    ...(values['data-dir'] ? { dataDir: resolve(cwd, values['data-dir']) } : {}),
    ...(values['token-file'] ? { tokenFile: resolve(cwd, values['token-file']) } : {}),
    ...(values['export-events'] ? { exportEvents: values['export-events'] } : {}),
    ...(values.out ? { out: values.out } : {}),
  };
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * A warning when `serverUrl` is not a loopback address: doctor sends the daemon token there, and
 * the daemon itself only ever listens on loopback.
 */
export function nonLoopbackWarning(serverUrl: string): string | undefined {
  let host: string;
  try {
    host = new URL(serverUrl).hostname;
  } catch {
    return undefined;
  }
  if (LOOPBACK.has(host)) return undefined;
  return `${serverUrl} is not a loopback address; doctor will send the Uncage daemon token to ${host}. The daemon only listens on 127.0.0.1, so make sure this is a tunnel or proxy you trust.`;
}

/** `uncage serve` with the port of `serverUrl` when it is a non-default loopback port. */
function serveFix(serverUrl: string): string {
  try {
    const u = new URL(serverUrl);
    const loopback = LOOPBACK.has(u.hostname);
    if (loopback && u.port && Number(u.port) !== DEFAULT_PORT) return `uncage serve --port ${u.port}`;
    if (!loopback) return `start the Uncage daemon reachable at ${serverUrl}`;
  } catch {
    // fall through
  }
  return 'uncage serve';
}

/** The workspace config a running daemon reports in `/v1/health` (absent on older daemons). */
function reportedWorkspaces(body: unknown): string[] | undefined {
  const ws = (body as { workspace?: { default?: unknown; allowedRoots?: unknown } } | null)?.workspace;
  if (!ws || typeof ws.default !== 'string') return undefined;
  const roots = Array.isArray(ws.allowedRoots) ? ws.allowedRoots.filter((r): r is string => typeof r === 'string') : [];
  return [ws.default, ...roots];
}

const RUNTIME_FIX: Record<string, string> = {
  claude: 'npm i -g @anthropic-ai/claude-code',
  codex: 'npm i -g @openai/codex && codex login',
};
/** A codex problem alone never fails doctor. */
const OPTIONAL_RUNTIMES = new Set(['codex']);

async function readToken(path: string): Promise<string | undefined> {
  try {
    return (await readFile(path, 'utf8')).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Exit code of `git <args>` run in `cwd`, or null when git cannot be started (e.g. not installed). */
function gitExit(git: string, args: string[], cwd: string): Promise<number | null> {
  return new Promise((done) => {
    execFile(git, args, { cwd, timeout: 5000 }, (err) => {
      if (!err) return done(0);
      const code = (err as NodeJS.ErrnoException & { code?: unknown }).code;
      done(typeof code === 'number' ? code : null);
    });
  });
}

/**
 * Warns (non-fatal) for each configured workspace that is a git repo where `.uncage/` (attachment
 * storage) is not ignored. Probes `.uncage/attachments`: `git check-ignore .uncage` misses both a
 * root `.uncage/` pattern before the directory exists and the `.uncage/.gitignore` Uncage writes.
 * Skipped when git is missing or the workspace is not a repo.
 */
async function uncageIgnoreChecks(workspaces: string[], git: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  for (const ws of new Set(workspaces)) {
    if ((await gitExit(git, ['rev-parse', '--is-inside-work-tree'], ws)) !== 0) continue;
    const ignored = await gitExit(git, ['check-ignore', '-q', '.uncage/attachments'], ws);
    if (ignored === null) continue;
    const label = 'Attachments ignored by git';
    if (ignored === 0) checks.push({ id: `gitignore.${ws}`, label, ok: true, detail: `${ws}/.uncage/` });
    else {
      checks.push({
        id: `gitignore.${ws}`,
        label,
        ok: false,
        warn: true,
        detail: `${ws} is a git repo and .uncage/ (uploaded attachments) is not ignored`,
        fix: `mkdir -p '${ws}/.uncage' && printf '*\\n' > '${ws}/.uncage/.gitignore'   # Uncage also writes it on the first upload`,
      });
    }
  }
  return checks;
}

export async function runDoctor(deps: DoctorDeps): Promise<DoctorCheck[]> {
  const { config, adapters, home } = deps;
  const checks: DoctorCheck[] = [];

  const major = Number(process.versions.node.split('.')[0]);
  checks.push({
    id: 'node',
    label: 'Node.js >= 22',
    ok: major >= 22,
    detail: `v${process.versions.node}`,
    ...(major >= 22 ? {} : { fix: 'brew install node@22' }),
  });

  const dataDir = deps.dataDir ?? join(home, '.uncage', 'data');
  try {
    await mkdir(dataDir, { recursive: true });
    await access(dataDir, constants.W_OK);
    checks.push({ id: 'dataDir', label: 'Data directory writable', ok: true, detail: dataDir });
  } catch (e) {
    checks.push({
      id: 'dataDir',
      label: 'Data directory writable',
      ok: false,
      detail: `${dataDir}: ${e instanceof Error ? e.message : String(e)}`,
      fix: `mkdir -p '${dataDir}' && chmod u+rwx '${dataDir}'`,
    });
  }

  const tp = deps.tokenFile ?? tokenPath(home);
  try {
    const mode = (await stat(tp)).mode & 0o777;
    if (mode === 0o600) checks.push({ id: 'token', label: 'Token file', ok: true, detail: `${tp} (mode 600)` });
    else {
      checks.push({
        id: 'token',
        label: 'Token file',
        ok: false,
        detail: `${tp} has mode ${mode.toString(8)}, expected 600`,
        fix: `chmod 600 '${tp}'`,
      });
    }
  } catch {
    checks.push({ id: 'token', label: 'Token file', ok: false, detail: `${tp} not found`, fix: 'uncage serve' });
  }

  const serverUrl = trimUrl(deps.serverUrl ?? `http://127.0.0.1:${config.server.port}`);
  const url = `${serverUrl}/v1/health`;
  const serve = serveFix(serverUrl);
  let daemonWorkspaces: string[] | undefined;
  const remote = nonLoopbackWarning(serverUrl);
  if (remote) {
    checks.push({ id: 'serverUrl', label: 'Server URL is loopback', ok: false, warn: true, detail: remote });
  }
  try {
    const token = await readToken(tp);
    const res = await deps.fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    if (res.ok) {
      checks.push({ id: 'server', label: 'Server reachable', ok: true, detail: url });
      daemonWorkspaces = reportedWorkspaces(await res.json().catch(() => undefined));
    } else {
      checks.push({
        id: 'server',
        label: 'Server reachable',
        ok: false,
        detail: `${url} returned HTTP ${res.status}${res.status === 401 ? ' (token mismatch: pass the daemon\'s --token-file)' : ''}`,
        fix: res.status === 401 ? `chmod 600 '${tp}' && ${serve}` : serve,
      });
    }
  } catch {
    checks.push({
      id: 'server',
      label: 'Server reachable',
      ok: false,
      detail: `nothing listening at ${url} (daemon on another port? uncage doctor --port <n>, or set UNCAGE_URL)`,
      fix: serve,
    });
  }

  for (const a of adapters) {
    const label = `Runtime ${a.id}`;
    const id = `runtime.${a.id}`;
    try {
      const p = await a.probe();
      if (p.status === 'available') {
        const detail = [p.version, p.message].filter(Boolean).join(' · ');
        checks.push({ id, label, ok: true, ...(detail ? { detail } : {}) });
        continue;
      }
      const detail = p.status === 'not_installed' ? 'not installed' : [p.status, p.message].filter(Boolean).join(': ');
      const fix =
        p.status === 'not_installed'
          ? (RUNTIME_FIX[a.id] ?? `see ${p.installUrl ?? 'the runtime install docs'}`)
          : p.status === 'auth_required' || /log ?in|auth/i.test(p.message ?? '')
            ? a.id === 'claude'
              ? 'claude   # then type /login'
              : `${a.id} login`
            : (p.hint ?? `uncage doctor   # re-run after resolving: ${p.message ?? p.status}`);
      checks.push({ id, label, ok: false, detail, fix });
    } catch (e) {
      checks.push({
        id,
        label,
        ok: false,
        detail: e instanceof Error ? e.message : String(e),
        fix: RUNTIME_FIX[a.id] ?? 'uncage doctor',
      });
    }
  }
  const workspaces = deps.workspaces ?? daemonWorkspaces ?? [config.workspace.default, ...config.workspace.allowedRoots];
  checks.push(...(await uncageIgnoreChecks(workspaces, deps.gitCommand ?? 'git')));
  return checks;
}

/** 1 if any required check failed; codex failures and warnings are not required. */
export function doctorExitCode(checks: DoctorCheck[]): number {
  return checks.some((c) => !c.ok && !c.warn && !OPTIONAL_RUNTIMES.has(c.id.replace(/^runtime\./, ''))) ? 1 : 0;
}

export function formatChecks(checks: DoctorCheck[]): string {
  return checks
    .map((c) => {
      const line = `${c.ok ? '✓' : c.warn ? '!' : '✗'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`;
      return c.fix && !c.ok ? `${line}\n    fix: ${c.fix}` : line;
    })
    .join('\n');
}

const PAGE = 1000;

export interface ExportEventsOptions {
  sessionId: string;
  config: UncageConfig;
  home: string;
  fetch: typeof fetch;
  includeContent: boolean;
  /** Overrides the token file (`--token-file`). Defaults to `<home>/.uncage/token`. */
  tokenFile?: string;
  /** The daemon's base URL. Defaults to `http://127.0.0.1:<config port>`. */
  serverUrl?: string;
}

/** Pulls a session's events over the HTTP JSON endpoint (never touches PGlite). Redacted unless includeContent. */
export async function exportEvents(o: ExportEventsOptions): Promise<unknown[]> {
  const tp = o.tokenFile ?? tokenPath(o.home);
  const token = await readToken(tp);
  if (!token) throw new Error(`No token at ${tp}. Run: uncage serve`);
  const base = trimUrl(o.serverUrl ?? `http://127.0.0.1:${o.config.server.port}`);
  const all: Array<{ sequence: number; payload?: unknown } & Record<string, unknown>> = [];
  let after = 0;
  for (;;) {
    let res: Response;
    try {
      res = await o.fetch(`${base}/v1/sessions/${encodeURIComponent(o.sessionId)}/events?after=${after}&limit=${PAGE}`, {
        headers: { authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
    } catch {
      throw new Error(`Cannot reach the server at ${base}. Run: ${serveFix(base)} (or pass --port / --url)`);
    }
    if (!res.ok) throw new Error(`Server returned HTTP ${res.status} for session ${o.sessionId}.`);
    const page = (await res.json()) as typeof all;
    all.push(...page);
    if (page.length < PAGE) break;
    after = page[page.length - 1]?.sequence ?? after;
  }
  return o.includeContent ? all : all.map((e) => redactForExport(e));
}

