import { execFile } from 'node:child_process';
import { homedir, hostname, release } from 'node:os';
import { promisify } from 'node:util';
import type { RuntimeAdapter, TransportKind } from '@uncage/protocol';
import { isCmdLine } from '@uncage/protocol/node';
import pino from 'pino';
import pkg from '../package.json' with { type: 'json' };
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execTarget, selfUpgradeCommand } from './exe.js';
import { agentDir, ensureAgentDir, updateAgentSites, type AgentConfig } from './config.js';
import { DEFAULT_TIMING, SiteAgent, type AgentLogger, type AgentTiming, type SiteState } from './site.js';

export const AGENT_VERSION: string = pkg.version;

/** Never log secrets: tokens and auth headers are censored wherever they appear. */
export const AGENT_REDACT_PATHS = ['token', '*.token', 'authorization', '*.authorization', 'headers.authorization', 'machineKey', '*.machineKey'];

/**
 * The agent's JSON logger: stderr, or appended to `logFile` (`uncage agent --log-file`; Windows
 * scheduled tasks have no stdout redirect, so the agent writes its own log there).
 */
export function createAgentLogger(level = process.env.UNCAGE_LOG_LEVEL ?? 'info', logFile?: string): AgentLogger {
  const dest = logFile ? pino.destination({ dest: logFile, append: true, mkdir: true, sync: true }) : pino.destination(2);
  return pino({ level, redact: { paths: AGENT_REDACT_PATHS, censor: '[redacted]' } }, dest);
}

export type ExecFn = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
const execFileAsync = promisify(execFile);
/**
 * Runs a command without a shell. On Windows the console window is hidden, a bare name never comes
 * from the current directory (system tools run from `System32`, anything else is resolved on PATH),
 * and a `cmd.exe /d /s /c "<line>"` from `resolveCommand` is passed verbatim (Node would otherwise
 * re-quote the line).
 */
export const defaultExec: ExecFn = async (file0, args0) => {
  const { file, args } = await execTarget(file0, args0);
  const verbatim = process.platform === 'win32' && isCmdLine(file, args);
  const r = await execFileAsync(file, args, { encoding: 'utf8', windowsHide: true, ...(verbatim ? { windowsVerbatimArguments: true } : {}) });
  return { stdout: r.stdout, stderr: r.stderr };
};

/**
 * The POSIX form of the self-upgrade command. The agent runs `selfUpgradeCommand()` instead, which
 * resolves npm for the Node in use (on Windows: `node npm-cli.js`, never `npm.cmd`).
 * @deprecated use `selfUpgradeCommand()`.
 */
export const SELF_UPGRADE: [string, string[]] = ['npm', ['i', '-g', '@uncage/cli@latest']];

/** Exit code after a self-upgrade: non-zero so the service manager (launchd / systemd / Task Scheduler) restarts the new version. */
export const UPGRADE_EXIT_CODE = 75;

export interface CreateAgentOptions {
  config: AgentConfig;
  /** Runtime adapters, or a factory called once per site (each site gets its own core instance). */
  adapters: RuntimeAdapter[] | ((siteId: string) => RuntimeAdapter[]);
  /** Defaults to the user's home directory (`~/.uncage`, `~/Uncage`). */
  home?: string;
  logger?: AgentLogger;
  timing?: Partial<AgentTiming>;
  /** Machine name / OS reported to websites. Default: host name, `darwin <release>`. */
  machine?: { name?: string; os?: string };
  /** Overrides the version sent in `hello` (tests). */
  agentVersion?: string;
  /** Runs commands (the self-upgrade). Injectable for tests. */
  exec?: ExecFn;
  /** The self-upgrade command. Default `selfUpgradeCommand()` (resolved when an upgrade is needed). */
  upgradeCommand?: [string, string[]];
  /** Called after a self-upgrade attempt. Default `process.exit`. */
  exit?: (code: number) => void;
  /** HTTP client for `/agent/info` and the HTTP streaming transport. Default: the global `fetch` (tests inject one). */
  fetch?: typeof fetch;
}

export interface Agent {
  close(): Promise<void>;
  /** Per configured site: connecting, connected, upgrade_failed, failed (could not start), revoked, replaced, closed. */
  status(): Record<string, SiteStatus>;
  /** Per running site: the transport of its live link (`ws` / `http`), `null` while not connected. */
  transports(): Record<string, TransportKind | null>;
}

/**
 * The Connected Mode daemon: one link per configured (non-revoked) site — WebSocket, or HTTP
 * streaming when the site only offers that or WebSocket keeps failing — each with its own core
 * instance, workspace root and activity log. Revocation (4401 / HTTP 401) marks the site in
 * `agent.yaml` and stops dialing it; replacement (4409) stops that connection without fighting;
 * `upgrade_required` runs `npm i -g @uncage/cli@latest` and, if that worked, exits non-zero so
 * launchd restarts (a failed upgrade keeps only that site offline, retried at most hourly). A site
 * that fails to start is logged and skipped; only if every site fails does this throw.
 */
export async function createAgent(o: CreateAgentOptions): Promise<Agent> {
  const home = o.home ?? homedir();
  const logger = o.logger ?? createAgentLogger();
  const timing: AgentTiming = { ...DEFAULT_TIMING, ...o.timing };
  const exec = o.exec ?? defaultExec;
  const exit = o.exit ?? ((code: number) => process.exit(code));
  const version = o.agentVersion ?? AGENT_VERSION;
  const machine = {
    name: o.machine?.name ?? hostname().replace(/\.local$/, ''),
    os: o.machine?.os ?? `${process.platform} ${release()}`,
  };
  await ensureAgentDir(home);
  const sites: SiteAgent[] = [];
  const status = new Map<string, SiteStatus>();
  let upgrading: Promise<number> | undefined;
  let closed = false;

  const close = async () => {
    closed = true;
    await Promise.allSettled(sites.map((s) => s.close()));
  };

  /**
   * Runs the self-upgrade at most once at a time. Success → close everything and exit non-zero
   * (launchd restarts the new version). Failure → persisted, so the same upgrade (same current
   * version and required version) is not retried for an hour, even across restarts; resolves the
   * wait before the next try.
   */
  const upgrade = (site: SiteAgent, minAgentVersion: string | undefined): Promise<number> => {
    const run = (upgrading ??= (async () => {
      const min = minAgentVersion ?? 'unknown';
      const last = await readUpgradeState(home);
      if (last && last.fromVersion === version && last.minAgentVersion === min) {
        const wait = Date.parse(last.failedAt) + UPGRADE_RETRY_MS - Date.now();
        if (wait > 0) {
          logger.warn({ minAgentVersion: min, retryInMs: wait }, 'self-upgrade failed recently; not retrying yet');
          return wait;
        }
      }
      logger.warn({ minAgentVersion: min, current: version }, 'website requires a newer agent; upgrading with npm');
      const cmd = o.upgradeCommand ?? (await selfUpgradeCommand());
      try {
        // Backstop: a test must never run the real global `npm i -g` (it happened once). Tests inject
        // `exec` or `upgradeCommand`; anything else under Vitest fails like a failed upgrade.
        if (!o.exec && !o.upgradeCommand && process.env.VITEST) throw new Error('self-upgrade refused under Vitest (inject exec or upgradeCommand)');
        await exec(...cmd);
      } catch (err) {
        logger.error({ err: (err as Error).message }, `self-upgrade failed; run: npm i -g @uncage/cli@latest`);
        await writeUpgradeState(home, { fromVersion: version, minAgentVersion: min, failedAt: new Date().toISOString() }).catch(
          (e: unknown) => logger.error({ err: e }, 'could not record the failed upgrade'),
        );
        return UPGRADE_RETRY_MS;
      }
      logger.info({}, 'upgrade installed; exiting so the service restarts with the new version');
      // Not awaited here: closing waits for the site loops, which are waiting on this promise.
      void close().finally(() => exit(UPGRADE_EXIT_CODE));
      return UPGRADE_RETRY_MS;
    })().finally(() => {
      upgrading = undefined;
    }));
    return run.then((wait) => {
      if (!closed) {
        void site.recordActivity({ kind: 'upgrade', ok: false, code: 'upgrade_failed', detail: { minAgentVersion: minAgentVersion ?? 'unknown', retryInMs: wait } });
      }
      return wait;
    });
  };

  for (const site of o.config.sites) {
    if (site.revokedAt) {
      logger.info({ site: site.id }, 'site was revoked; skipping (run uncage setup to reconnect)');
      status.set(site.id, 'revoked');
      continue;
    }
    const s: SiteAgent = new SiteAgent({
      site,
      home,
      adapters: typeof o.adapters === 'function' ? o.adapters(site.id) : o.adapters,
      localPolicy: o.config.localPolicy,
      logger,
      timing,
      machine,
      agentVersion: version,
      ...(o.fetch ? { fetch: o.fetch } : {}),
      onStop: (reason) => {
        if (closed) return;
        if (reason === 'revoked') {
          void updateAgentSites(home, (all) =>
            all.map((x) => (x.id === site.id && x.token === site.token ? { ...x, revokedAt: new Date().toISOString() } : x)),
          ).catch((err: unknown) => logger.error({ err, site: site.id }, 'could not mark the site revoked'));
        }
      },
      onUpgradeRequired: (min) => upgrade(s, min),
    });
    try {
      await s.start();
      sites.push(s);
    } catch (err) {
      // One broken site (corrupt data dir, lock held, …) must not take the others down.
      logger.error({ err, site: site.id }, 'could not start site; continuing with the others');
      status.set(site.id, 'failed');
    }
  }
  const attempted = o.config.sites.filter((x) => !x.revokedAt).length;
  if (attempted > 0 && sites.length === 0) {
    throw new Error(`No website could be started (${attempted} configured); see the log above.`);
  }
  if (attempted === 0) logger.warn({}, 'no connected websites; run: uncage setup <url>');
  return {
    close,
    status: () => ({ ...Object.fromEntries(status), ...Object.fromEntries(sites.map((x) => [x.site.id, x.state])) }),
    transports: () => Object.fromEntries(sites.map((x) => [x.site.id, x.transport])),
  };
}

/** `failed`: could not start; `revoked` here also covers sites skipped because agent.yaml marks them. */
export type SiteStatus = SiteState | 'failed';

/** Wait before retrying the same failed self-upgrade. */
export const UPGRADE_RETRY_MS = 60 * 60 * 1000;

export interface UpgradeState {
  fromVersion: string;
  minAgentVersion: string;
  failedAt: string;
}

export const upgradeStatePath = (home: string): string => join(agentDir(home), 'upgrade.json');

export async function readUpgradeState(home: string): Promise<UpgradeState | null> {
  try {
    const v = JSON.parse(await readFile(upgradeStatePath(home), 'utf8')) as Partial<UpgradeState>;
    return typeof v.fromVersion === 'string' && typeof v.minAgentVersion === 'string' && typeof v.failedAt === 'string'
      ? (v as UpgradeState)
      : null;
  } catch {
    return null;
  }
}

async function writeUpgradeState(home: string, st: UpgradeState): Promise<void> {
  await writeFile(upgradeStatePath(home), `${JSON.stringify(st)}\n`, { mode: 0o600 });
}
