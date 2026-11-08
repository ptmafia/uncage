import { hostname, release } from 'node:os';
import {
  loadAgentConfig,
  newMachineKey,
  normalizeHubUrl,
  pollDeviceToken,
  requestDeviceCode,
  updateAgentSites,
  openUrlCommand,
  type AgentSite,
  type ExecFn,
} from '@uncage/agent';
import type { TransportKind } from '@uncage/protocol';
import { agentService, serviceSpec, type AgentService, type ServiceSpec } from './service/index.js';

export const SETUP_HELP = `uncage setup - connect this computer to a website (Connected Mode)

Usage:
  uncage setup <url> [--no-daemon] [--no-browser]

Opens the website so you can approve this computer, saves the machine token in
~/.uncage/agent.yaml (readable only by you), then installs and starts the background agent
("uncage agent install": launchd on macOS, a systemd user service on Linux, a scheduled
task on Windows).

Options:
  --no-daemon    Do not install/start the background agent (run "uncage agent" yourself).
  --no-browser   Do not open a browser; just print the code and link.
  -h, --help     Show this help.`;

export interface SetupDeps {
  url: string;
  home: string;
  fetch: typeof fetch;
  exec: ExecFn;
  out: (line: string) => void;
  noDaemon?: boolean;
  noBrowser?: boolean;
  platform?: NodeJS.Platform;
  uid?: number;
  /** The background service (default: the one for this platform, `agentService`). */
  service?: AgentService;
  /** What the service runs (default: `serviceSpec` for this Node and CLI). */
  spec?: ServiceSpec;
  /** Environment for service detection and the service PATH. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  machine?: { name?: string; os?: string };
  sleep?: (ms: number) => Promise<void>;
}

/** How the agent will connect, from the transports the website offers (the agent prefers WebSocket). */
export function transportLine(kinds: TransportKind[]): string {
  if (kinds.includes('ws') && kinds.includes('http')) return 'WebSocket (falls back to HTTP streaming if WebSocket is blocked)';
  if (kinds.includes('ws')) return 'WebSocket';
  return 'HTTP streaming (this website runs on a serverless platform)';
}

export async function runSetup(d: SetupDeps): Promise<AgentSite> {
  const hubUrl = normalizeHubUrl(d.url);
  const config = await loadAgentConfig(d.home);
  // One machineKey per (machine, site): reuse the key from an earlier pairing with this hub.
  const machineKey = config.sites.find((s) => s.url === hubUrl)?.machineKey ?? newMachineKey();
  const name = d.machine?.name ?? hostname().replace(/\.local$/, '');
  const os = d.machine?.os ?? `${process.platform} ${release()}`;

  const code = await requestDeviceCode(d.fetch, hubUrl, { name, os, machineKey });
  d.out(`To connect this computer, open:\n\n  ${code.verificationUri}\n\nand confirm the code:  ${code.userCode}\n`);
  const platform = d.platform ?? process.platform;
  if (!d.noBrowser) {
    await d.exec(...openUrlCommand(code.verificationUri, platform)).catch(() => d.out('(Could not open a browser; open the link above yourself.)'));
  }
  d.out('Waiting for approval…');
  const grant = await pollDeviceToken({ fetch: d.fetch, hubUrl, code, ...(d.sleep ? { sleep: d.sleep } : {}) });
  // Re-check the URL the hub hands back (a hub can only point us at https, or loopback in dev).
  const siteUrl = normalizeHubUrl(grant.site.url);

  const site: AgentSite = {
    id: grant.site.id,
    name: grant.site.name,
    url: siteUrl,
    machineId: grant.machineId,
    token: grant.machineToken,
    machineKey,
  };
  await updateAgentSites(d.home, (sites) => [...sites.filter((s) => s.id !== site.id && s.url !== siteUrl), site]);
  d.out(`✓ Connected to ${site.name} (${new URL(siteUrl).host}) as machine ${site.machineId}.`);
  d.out(`  Transport: ${transportLine(grant.transports.map((t) => t.kind))}`);

  if (d.noDaemon) {
    d.out('Background agent not installed (--no-daemon). Start it with: uncage agent');
  } else {
    await installAgentService({
      home: d.home,
      exec: d.exec,
      out: d.out,
      platform,
      ...(d.uid !== undefined ? { uid: d.uid } : {}),
      ...(d.service ? { service: d.service } : {}),
      ...(d.spec ? { spec: d.spec } : {}),
      ...(d.env ? { env: d.env } : {}),
    });
  }
  return site;
}

export interface InstallServiceDeps {
  home: string;
  exec: ExecFn;
  out: (line: string) => void;
  platform?: NodeJS.Platform;
  uid?: number;
  env?: NodeJS.ProcessEnv;
  service?: AgentService;
  spec?: ServiceSpec;
}

/**
 * `uncage agent install` (and the last step of setup): pins this Node and CLI in the service
 * definition and (re)starts it. Without a service manager it prints the foreground hint.
 */
export async function installAgentService(d: InstallServiceDeps): Promise<{ kind: AgentService['kind']; definitionPath: string }> {
  const platform = d.platform ?? process.platform;
  const env = d.env ?? process.env;
  const service =
    d.service ?? (await agentService({ platform, home: d.home, env, exec: d.exec, ...(d.uid !== undefined ? { uid: d.uid } : {}) }));
  if (service.kind === 'none') {
    const { notes } = await service.install(d.spec ?? ({} as ServiceSpec));
    for (const n of notes) d.out(n);
    return { kind: 'none', definitionPath: '' };
  }
  const spec = d.spec ?? (await serviceSpec({ home: d.home, execPath: process.execPath, argv1: process.argv[1] ?? 'uncage', env, platform }));
  const { definitionPath, notes } = await service.install(spec);
  const where = service.kind === 'launchd' ? 'launchd' : service.kind === 'systemd' ? 'systemd --user' : service.kind === 'schtasks' ? 'Task Scheduler' : 'Run key';
  d.out(`✓ Background agent running (${where}: ${definitionPath}). Node: ${spec.nodePath}. Logs: ${spec.logsDir}`);
  for (const n of notes) d.out(`! ${n}`);
  return { kind: service.kind, definitionPath };
}
