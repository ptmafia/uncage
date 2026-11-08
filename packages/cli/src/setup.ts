import { hostname, release } from 'node:os';
import {
  loadAgentConfig,
  newMachineKey,
  normalizeHubUrl,
  pollDeviceToken,
  requestDeviceCode,
  updateAgentSites,
  type AgentSite,
  type ExecFn,
} from '@uncage/agent';
import { installLaunchAgent } from './launchd.js';

export const SETUP_HELP = `uncage setup - connect this computer to a website (Connected Mode)

Usage:
  uncage setup <url> [--no-daemon] [--no-browser]

Opens the website so you can approve this computer, saves the machine token in
~/.uncage/agent.yaml (0600), then installs and starts the background agent
(launchd: ~/Library/LaunchAgents/dev.uncage.agent.plist).

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
  /** How launchd starts the agent: `[node, bin.js, 'agent']`. */
  programArguments?: string[];
  path?: string;
  machine?: { name?: string; os?: string };
  sleep?: (ms: number) => Promise<void>;
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
  if (!d.noBrowser) {
    await d.exec('open', [code.verificationUri]).catch(() => d.out('(Could not open a browser; open the link above yourself.)'));
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

  const platform = d.platform ?? process.platform;
  if (d.noDaemon) {
    d.out('Background agent not installed (--no-daemon). Start it with: uncage agent');
  } else if (platform !== 'darwin') {
    d.out('Background service setup is only automated on macOS. Start the agent with: uncage agent');
  } else {
    const plist = await installLaunchAgent({
      home: d.home,
      uid: d.uid ?? process.getuid?.() ?? 501,
      exec: d.exec,
      programArguments: d.programArguments ?? [process.execPath, process.argv[1] ?? 'uncage', 'agent'],
      path: d.path ?? process.env.PATH ?? '/usr/bin:/bin',
    });
    d.out(`✓ Background agent running (launchd: ${plist}). Logs: ~/.uncage/logs`);
  }
  return site;
}
