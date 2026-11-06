import { execFile } from 'node:child_process';
import { access, constants, mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { RuntimeAdapter } from '@uncage/protocol';
import type { UncageConfig } from './config.js';
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

  const url = `http://127.0.0.1:${config.server.port}/v1/health`;
  try {
    const token = await readToken(tp);
    const res = await deps.fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    if (res.ok) checks.push({ id: 'server', label: 'Server reachable', ok: true, detail: url });
    else {
      checks.push({
        id: 'server',
        label: 'Server reachable',
        ok: false,
        detail: `${url} returned HTTP ${res.status}`,
        fix: res.status === 401 ? `chmod 600 '${tp}' && uncage serve` : 'uncage serve',
      });
    }
  } catch {
    checks.push({ id: 'server', label: 'Server reachable', ok: false, detail: `nothing listening at ${url}`, fix: 'uncage serve' });
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
  checks.push(...(await uncageIgnoreChecks([config.workspace.default, ...config.workspace.allowedRoots], deps.gitCommand ?? 'git')));
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

const SAFE_KEYS = new Set([
  'id', 'type', 'state', 'status', 'sequence', 'eventId', 'occurredAt', 'createdAt', 'startedAt', 'endedAt',
  'expiresAt', 'durationMs', 'category', 'name', 'chunkIndex', 'version', 'code', 'retryable', 'decision',
  'scope', 'runtimeId', 'schemaVersion', 'readOnly', 'allowedScopes', 'availableDecisions', 'capabilities',
]);

/** Arbitrary user/tool data: never recursed into, so nested key names cannot leak. */
const OPAQUE_KEYS = new Set(['input', 'output', 'extensions']);

const isSafeKey = (k: string): boolean => SAFE_KEYS.has(k) || k.endsWith('Id');

/** Allowlist redaction: every string not under a known-safe key becomes a length placeholder. Structure is kept. */
function redact(v: unknown, key = ''): unknown {
  if (OPAQUE_KEYS.has(key) && v !== undefined && v !== null) {
    return typeof v === 'string' ? `[redacted ${v.length} chars]` : `[redacted ${Array.isArray(v) ? 'array' : typeof v}]`;
  }
  if (typeof v === 'string') return isSafeKey(key) ? v : `[redacted ${v.length} chars]`;
  if (Array.isArray(v)) return v.map((x) => redact(x, key));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redact(x, k)]));
  return v;
}

export interface ExportEventsOptions {
  sessionId: string;
  config: UncageConfig;
  home: string;
  fetch: typeof fetch;
  includeContent: boolean;
  /** Overrides the token file (`--token-file`). Defaults to `<home>/.uncage/token`. */
  tokenFile?: string;
}

/** Pulls a session's events over the HTTP JSON endpoint (never touches PGlite). Redacted unless includeContent. */
export async function exportEvents(o: ExportEventsOptions): Promise<unknown[]> {
  const tp = o.tokenFile ?? tokenPath(o.home);
  const token = await readToken(tp);
  if (!token) throw new Error(`No token at ${tp}. Run: uncage serve`);
  const base = `http://127.0.0.1:${o.config.server.port}`;
  const all: Array<{ sequence: number; payload?: unknown } & Record<string, unknown>> = [];
  let after = 0;
  for (;;) {
    let res: Response;
    try {
      res = await o.fetch(`${base}/v1/sessions/${encodeURIComponent(o.sessionId)}/events?after=${after}&limit=${PAGE}`, {
        headers: { authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
    } catch {
      throw new Error(`Cannot reach the server at ${base}. Run: uncage serve`);
    }
    if (!res.ok) throw new Error(`Server returned HTTP ${res.status} for session ${o.sessionId}.`);
    const page = (await res.json()) as typeof all;
    all.push(...page);
    if (page.length < PAGE) break;
    after = page[page.length - 1]?.sequence ?? after;
  }
  return o.includeContent ? all : all.map((e) => redact(e));
}

