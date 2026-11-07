import { execFile } from 'node:child_process';
import { homedir, hostname, release } from 'node:os';
import { promisify } from 'node:util';
import type { RuntimeAdapter } from '@uncage/protocol';
import pino from 'pino';
import pkg from '../package.json' with { type: 'json' };
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { agentDir, ensureAgentDir, updateAgentSites, type AgentConfig } from './config.js';
import { DEFAULT_TIMING, SiteAgent, type AgentLogger, type AgentTiming } from './site.js';

export const AGENT_VERSION: string = pkg.version;

/** Never log secrets: tokens and auth headers are censored wherever they appear. */
export const AGENT_REDACT_PATHS = ['token', '*.token', 'authorization', '*.authorization', 'headers.authorization', 'machineKey', '*.machineKey'];

export function createAgentLogger(level = process.env.UNCAGE_LOG_LEVEL ?? 'info'): AgentLogger {
  return pino({ level, redact: { paths: AGENT_REDACT_PATHS, censor: '[redacted]' } }, pino.destination(2));
}

export type ExecFn = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
const execFileAsync = promisify(execFile);
export const defaultExec: ExecFn = async (file, args) => {
  const r = await execFileAsync(file, args, { encoding: 'utf8' });
  return { stdout: r.stdout, stderr: r.stderr };
};

/** The self-upgrade command run on `upgrade_required`: `npm i -g @uncage/cli@latest`. */
export const SELF_UPGRADE: [string, string[]] = ['npm', ['i', '-g', '@uncage/cli@latest']];

/** Exit code after a self-upgrade: non-zero so launchd (KeepAlive on failure) restarts the new version. */
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
  /** Called after a self-upgrade attempt. Default `process.exit`. */
  exit?: (code: number) => void;
}

export interface Agent {
  close(): Promise<void>;
  /** Per configured site: running, failed (could not start), revoked, replaced, upgrade_failed. */
  status(): Record<string, SiteStatus>;
}

/**
 * The Connected Mode daemon: one WebSocket per configured (non-revoked) site, each with its own
 * core instance, workspace root and activity log. Revocation (4401 / HTTP 401) marks the site in
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
      try {
        await exec(...SELF_UPGRADE);
      } catch (err) {
        logger.error({ err: (err as Error).message }, `self-upgrade failed; run: ${SELF_UPGRADE[0]} ${SELF_UPGRADE[1].join(' ')}`);
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
        status.set(site.site.id, 'upgrade_failed');
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
      onStop: (reason) => {
        if (closed) return;
        status.set(site.id, reason);
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
      status.set(site.id, 'running');
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
  return { close, status: () => Object.fromEntries(status) };
}

export type SiteStatus = 'running' | 'failed' | 'revoked' | 'replaced' | 'upgrade_failed';

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
