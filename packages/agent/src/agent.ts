import { execFile } from 'node:child_process';
import { homedir, hostname, release } from 'node:os';
import { promisify } from 'node:util';
import type { RuntimeAdapter } from '@uncage/protocol';
import pino from 'pino';
import pkg from '../package.json' with { type: 'json' };
import { updateAgentSites, type AgentConfig } from './config.js';
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
}

/**
 * The Connected Mode daemon: one WebSocket per configured (non-revoked) site, each with its own
 * core instance, workspace root and activity log. Revocation (4401 / HTTP 401) marks the site in
 * `agent.yaml` and stops dialing it; replacement (4409) stops that connection without fighting;
 * `upgrade_required` runs `npm i -g @uncage/cli@latest` once and exits non-zero so launchd restarts.
 */
export async function createAgent(o: CreateAgentOptions): Promise<Agent> {
  const home = o.home ?? homedir();
  const logger = o.logger ?? createAgentLogger();
  const timing: AgentTiming = { ...DEFAULT_TIMING, ...o.timing };
  const exec = o.exec ?? defaultExec;
  const exit = o.exit ?? ((code: number) => process.exit(code));
  const machine = {
    name: o.machine?.name ?? hostname().replace(/\.local$/, ''),
    os: o.machine?.os ?? `${process.platform} ${release()}`,
  };
  const sites: SiteAgent[] = [];
  let upgrading: Promise<void> | undefined;
  let closed = false;

  const close = async () => {
    closed = true;
    await Promise.allSettled(sites.map((s) => s.close()));
  };

  const upgrade = (minAgentVersion: string | undefined) =>
    (upgrading ??= (async () => {
      logger.warn({ minAgentVersion, current: o.agentVersion ?? AGENT_VERSION }, 'website requires a newer agent; upgrading with npm');
      try {
        await exec(...SELF_UPGRADE);
        logger.info({}, 'upgrade installed; exiting so the service restarts with the new version');
      } catch (err) {
        logger.error({ err: (err as Error).message }, `self-upgrade failed; run: ${SELF_UPGRADE[0]} ${SELF_UPGRADE[1].join(' ')}`);
      }
      await close();
      exit(UPGRADE_EXIT_CODE);
    })());

  for (const site of o.config.sites) {
    if (site.revokedAt) {
      logger.info({ site: site.id }, 'site was revoked; skipping (run uncage setup to reconnect)');
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
      agentVersion: o.agentVersion ?? AGENT_VERSION,
      onStop: (reason, detail) => {
        if (closed) return;
        if (reason === 'revoked') {
          void updateAgentSites(home, (all) =>
            all.map((x) => (x.id === site.id && x.token === site.token ? { ...x, revokedAt: new Date().toISOString() } : x)),
          ).catch((err: unknown) => logger.error({ err, site: site.id }, 'could not mark the site revoked'));
        } else if (reason === 'upgrade') void upgrade(detail.minAgentVersion);
      },
    });
    try {
      await s.start();
      sites.push(s);
    } catch (err) {
      logger.error({ err, site: site.id }, 'could not start site');
      await close();
      throw err;
    }
  }
  if (sites.length === 0) logger.warn({}, 'no connected websites; run: uncage setup <url>');
  return { close };
}
