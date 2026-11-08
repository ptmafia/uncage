import { updateAgentAcp } from '@uncage/agent';
import type { RuntimeAdapter, RuntimeCapabilities, RuntimeProbe, RuntimeStatus } from '@uncage/protocol';
import {
  ACP_PRESETS,
  acpName,
  bundledRegistry,
  describeConsent,
  downloadConsent,
  localConsent,
  createWhich,
  hostPlatform,
  localCommand,
  registryRuntimeId,
  type AcpCatalogEntry,
  type AcpConsent,
  type AcpRegistry,
  type Which,
} from '@uncage/runtime-acp';

/** Terminal-safe text: control characters (escape sequences) become spaces. */
const clean = (s: string): string => s.replace(/\p{Cc}+/gu, ' ');

export const RUNTIMES_HELP = `uncage runtimes - the agents this computer offers to websites

Usage:
  uncage runtimes [--json] [--all] [--refresh]   List runtimes (what "uncage agent" registers).
  uncage runtimes enable <id>                    Register an ACP registry agent (consent for npx/uvx).
  uncage runtimes disable <id>                   Never register an ACP agent.

Options:
  --json      Machine-readable output.
  --all       Also list ACP registry agents that are not installed here.
  --refresh   Download the latest ACP registry first (otherwise the cached or bundled copy).
  -h, --help  Show this help.

Installed ACP agents are detected from the official ACP registry and checked with a handshake.
After a registry refresh, an agent whose command changed waits for "uncage runtimes enable".
Agents distributed through npx/uvx download code, so they only run after "uncage runtimes enable"
(bound to that package: if the registry switches packages, enable it again).
Settings live in runtimes.acp of ~/.uncage/agent.yaml: agents, presets, enable/consented, disable,
and autoDetect (false: no detection or handshakes; only agents, presets and enabled agents run).`;

const STATUS_TEXT: Record<RuntimeStatus, string> = {
  available: 'available',
  not_installed: 'not installed',
  auth_required: 'sign-in needed',
  incompatible: 'incompatible',
  error: 'error',
};

interface Row {
  id: string;
  displayName: string;
  status: RuntimeStatus;
  version?: string;
  siteTools: boolean;
  resume: boolean;
  message?: string;
  hint?: string;
}

async function describe(a: RuntimeAdapter): Promise<Row> {
  let p: RuntimeProbe;
  try {
    p = await a.probe();
  } catch (e) {
    p = { status: 'error', message: e instanceof Error ? e.message : String(e) };
  }
  let caps: RuntimeCapabilities;
  try {
    caps = p.status === 'available' && a.refreshCapabilities ? await a.refreshCapabilities() : a.capabilities();
  } catch {
    caps = a.capabilities();
  }
  return {
    id: a.id,
    displayName: a.displayName,
    status: p.status,
    ...(p.version ? { version: p.version } : {}),
    siteTools: caps.siteTools,
    resume: caps.nativeResume,
    ...(p.message ? { message: p.message } : {}),
    ...(p.hint ? { hint: p.hint } : {}),
  };
}

function table(rows: string[][]): string[] {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]! + 2))).join('').trimEnd());
}

/** Registry agents shown by default: the ones a user can act on. */
const NOTEWORTHY = new Set<AcpCatalogEntry['status']>(['available', 'failed', 'disabled', 'duplicate']);

/**
 * Probes every runtime and prints id, name, status, version, site tools and resume (or JSON), then
 * the ACP registry agents that are not registered. Disposes every adapter (probing starts ACP agents).
 */
export async function runRuntimes(o: {
  adapters: RuntimeAdapter[];
  json: boolean;
  out: (s: string) => void;
  catalog?: AcpCatalogEntry[];
  all?: boolean;
}): Promise<number> {
  let rows: Row[];
  try {
    rows = await Promise.all(o.adapters.map(describe));
  } finally {
    await Promise.allSettled(o.adapters.map((a) => a.dispose?.()));
  }
  const catalog = (o.catalog ?? []).filter((c) => c.status !== 'enabled' && c.status !== 'manual');
  if (o.json) {
    o.out(JSON.stringify({ runtimes: rows, registry: o.catalog ?? [] }, null, 2));
    return 0;
  }
  if (rows.length === 0) o.out('No runtimes.');
  else {
    const yes = (b: boolean) => (b ? 'yes' : 'no');
    for (const line of table([
      ['ID', 'NAME', 'STATUS', 'VERSION', 'SITE TOOLS', 'RESUME'],
      ...rows.map((r) => [r.id, clean(r.displayName), STATUS_TEXT[r.status], clean(r.version ?? '-'), yes(r.siteTools), yes(r.resume)]),
    ])) {
      o.out(line);
    }
    for (const r of rows.filter((x) => x.status !== 'available' && (x.message || x.hint))) {
      o.out(`  ${r.id}: ${clean([r.message, r.hint].filter(Boolean).join(' '))}`);
    }
  }
  const shown = o.all ? catalog : catalog.filter((c) => NOTEWORTHY.has(c.status));
  if (shown.length > 0) {
    o.out('');
    o.out('ACP registry agents not registered (uncage runtimes enable <id>):');
    for (const line of table(
      shown.map((c) => [`  ${c.registryId}`, clean(c.name), `${c.status.replace('_', ' ')} (${c.distribution})`, clean(c.message ?? '')]),
    )) {
      o.out(line);
    }
  }
  const hidden = catalog.length - shown.length;
  if (hidden > 0) o.out(`${hidden} more ACP registry agent${hidden === 1 ? '' : 's'} not installed here (uncage runtimes --all).`);
  return 0;
}

/**
 * `uncage runtimes enable|disable <id>`: records consent (or refusal) in `runtimes.acp` of
 * agent.yaml. Accepts a registry id (`claude-acp`), a preset id (`claude`) or a runtime id
 * (`acp-claude`); enable needs an agent known to the registry or a preset. What will run is printed
 * before anything is written; a download consent is bound to the runner and package name.
 */
export async function toggleRuntime(o: {
  home: string;
  id: string;
  enable: boolean;
  out: (s: string) => void;
  registry?: AcpRegistry;
  /** Whether the agent is installed (defaults to PATH). */
  which?: Which;
}): Promise<void> {
  const registry = o.registry ?? bundledRegistry();
  const which = o.which ?? createWhich();
  const name = acpName(o.id.trim().toLowerCase());
  const preset = ACP_PRESETS.find((p) => p.id === name || p.registryId === name);
  const agent = registry.agents.find((a) => a.id === name || a.id === preset?.registryId || registryRuntimeId(a.id) === `acp-${name}`);
  const ref = agent?.id ?? preset?.registryId ?? name;
  if (o.enable && !agent && !preset) throw new Error(`Unknown ACP agent "${o.id}". See: uncage runtimes --all`);
  // Every spelling of this agent, so a stale entry in the other list never wins.
  const forms = new Set([name, ref, acpName(registryRuntimeId(ref)), ...(preset ? [preset.id, preset.registryId] : [])]);
  const drop = (list: string[]) => list.filter((x) => !forms.has(acpName(x)));
  const dropConsent = <T>(c: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(c).filter(([k]) => !forms.has(acpName(k))));
  const undo = `Undo: uncage runtimes disable ${ref}.`;

  // Exactly what is consented to: the installed command, else the npx/uvx package, with args and env.
  let consent: AcpConsent | undefined;
  if (o.enable) {
    const local = agent ? localCommand(agent, hostPlatform()) : undefined;
    const installed = local ? await which(local.cmd) : null;
    const download = agent ? downloadConsent(agent) : undefined;
    if (local && installed) {
      consent = localConsent(local);
      o.out(`Uncage will run ${clean([installed, ...local.args].join(' '))} whenever the agent starts. ${undo}`);
    } else if (download) {
      consent = download;
      const from = download.runner === 'npx' ? 'npm' : 'PyPI';
      o.out(`Uncage will download and run ${download.package} from ${from} now and whenever the agent starts. ${undo}`);
      o.out(`  Command: ${describeConsent(download)}`);
    } else if (local) {
      consent = localConsent(local);
      o.out(`Uncage will run ${describeConsent(consent)} once it is installed. ${undo}`);
    } else {
      o.out(`Uncage will run ${agent?.name ?? preset?.displayName ?? ref} once it is installed. ${undo}`);
    }
  }
  await updateAgentAcp(o.home, (acp) =>
    o.enable
      ? {
          ...acp,
          enable: [...drop(acp.enable), ref],
          consented: { ...dropConsent(acp.consented), ...(consent ? { [ref]: consent } : {}) },
          disable: drop(acp.disable),
        }
      : { ...acp, enable: drop(acp.enable), consented: dropConsent(acp.consented), disable: [...drop(acp.disable), ref] },
  );
  const label = agent?.name ?? preset?.displayName ?? ref;
  o.out(`✓ ${o.enable ? 'Enabled' : 'Disabled'} ${label} (${registryRuntimeId(ref)}).`);
}
