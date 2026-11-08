import { updateAgentAcp } from '@uncage/agent';
import type { RuntimeAdapter, RuntimeCapabilities, RuntimeProbe, RuntimeStatus } from '@uncage/protocol';
import { ACP_PRESETS, acpName, bundledRegistry, registryRuntimeId, type AcpCatalogEntry, type AcpRegistry } from '@uncage/runtime-acp';

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
Agents distributed through npx/uvx download code, so they only run after "uncage runtimes enable".
Settings live in runtimes.acp of ~/.uncage/agent.yaml (agents, presets, autoDetect, enable, disable).`;

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
const NOTEWORTHY = new Set<AcpCatalogEntry['status']>(['available', 'failed', 'disabled']);

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
      ...rows.map((r) => [r.id, r.displayName, STATUS_TEXT[r.status], r.version ?? '-', yes(r.siteTools), yes(r.resume)]),
    ])) {
      o.out(line);
    }
    for (const r of rows.filter((x) => x.status !== 'available' && (x.message || x.hint))) {
      o.out(`  ${r.id}: ${[r.message, r.hint].filter(Boolean).join(' ')}`);
    }
  }
  const shown = o.all ? catalog : catalog.filter((c) => NOTEWORTHY.has(c.status));
  if (shown.length > 0) {
    o.out('');
    o.out('ACP registry agents not registered (uncage runtimes enable <id>):');
    for (const line of table(
      shown.map((c) => [`  ${c.registryId}`, c.name, `${c.status.replace('_', ' ')} (${c.distribution})`, c.message ?? '']),
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
 * (`acp-claude`); enable needs an agent known to the registry or a preset.
 */
export async function toggleRuntime(o: { home: string; id: string; enable: boolean; out: (s: string) => void; registry?: AcpRegistry }): Promise<void> {
  const registry = o.registry ?? bundledRegistry();
  const name = acpName(o.id.trim().toLowerCase());
  const preset = ACP_PRESETS.find((p) => p.id === name || p.registryId === name);
  const agent = registry.agents.find((a) => a.id === name || a.id === preset?.registryId || registryRuntimeId(a.id) === `acp-${name}`);
  const ref = agent?.id ?? preset?.registryId ?? name;
  if (o.enable && !agent && !preset) throw new Error(`Unknown ACP agent "${o.id}". See: uncage runtimes --all`);
  // Every spelling of this agent, so a stale entry in the other list never wins.
  const forms = new Set([name, ref, acpName(registryRuntimeId(ref)), ...(preset ? [preset.id, preset.registryId] : [])]);
  const drop = (list: string[]) => list.filter((x) => !forms.has(acpName(x)));
  await updateAgentAcp(o.home, (acp) =>
    o.enable ? { ...acp, enable: [...drop(acp.enable), ref], disable: drop(acp.disable) } : { ...acp, enable: drop(acp.enable), disable: [...drop(acp.disable), ref] },
  );
  const label = agent?.name ?? preset?.displayName ?? ref;
  if (!o.enable) {
    o.out(`✓ Disabled ${label} (${registryRuntimeId(ref)}).`);
    return;
  }
  o.out(`✓ Enabled ${label} (${registryRuntimeId(ref)}).`);
  const { npx, uvx } = agent?.distribution ?? {};
  if (npx || uvx) {
    const cmd = npx ? `npx -y ${npx.package} ${npx.args.join(' ')}` : `uvx ${uvx!.package} ${uvx!.args.join(' ')}`;
    o.out(`  If it is not installed, Uncage runs "${cmd.trim()}", which downloads and runs code from ${npx ? 'npm' : 'PyPI'}.`);
  }
}
