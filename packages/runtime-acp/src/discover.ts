import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RuntimeProbe } from '@uncage/protocol';
import { acpAdapter, type AcpAdapterOptions } from './adapter.js';
import { ACP_PRESETS, isDisabled, resolveAcpAgents, type AcpAgentsConfig } from './presets.js';
import { bundledRegistry, registryIcon, type AcpPlatform, type AcpRegistry, type AcpRegistryAgent } from './registry.js';
import type { Which } from './which.js';

export type AcpCatalogStatus =
  /** Registered: detected on PATH and answered the ACP handshake, or enabled by the user. */
  | 'enabled'
  /** Registered from `runtimes.acp.agents` or a preset (wins over the registry entry). */
  | 'manual'
  /** Runs through npx/uvx (downloads code): only after `uncage runtimes enable <id>`. */
  | 'available'
  | 'not_installed'
  /** On PATH but the ACP handshake failed. */
  | 'failed'
  | 'disabled'
  /** No distribution for this OS/CPU, or an id Uncage cannot use as a runtime id. */
  | 'unsupported';

export interface AcpCatalogEntry {
  registryId: string;
  runtimeId: string;
  name: string;
  /** The registry's version of the agent. */
  version: string;
  description?: string;
  /** How the agent is distributed; for `available`, how it would run (npx/uvx). */
  distribution: 'binary' | 'npx' | 'uvx';
  status: AcpCatalogStatus;
  /** How an `enabled` entry got there. */
  via?: 'detected' | 'consent';
  command?: string[];
  /** The version the agent reported in the handshake. */
  agentVersion?: string;
  message?: string;
  hint?: string;
}

/** Bins of npm packages in the registry, so an installed copy runs without npx. */
const KNOWN_NPM_BINS: Record<string, string> = {
  '@agentclientprotocol/claude-agent-acp': 'claude-agent-acp',
  '@agentclientprotocol/codex-acp': 'codex-acp',
  '@google/gemini-cli': 'gemini',
  '@kilocode/cli': 'kilo',
  '@qwen-code/qwen-code': 'qwen',
  '@github/copilot': 'copilot',
};
/** Adapter entries (an ACP wrapper around another CLI): the CLI they need. */
const UNDERLYING_CLI: Record<string, { cmd: string; name: string }> = {
  'claude-acp': { cmd: 'claude', name: 'Claude Code' },
  'codex-acp': { cmd: 'codex', name: 'Codex' },
};

const RUNTIME_ID = /^acp-[a-z][a-z0-9-]{0,31}$/;
const DETECT_TIMEOUT_MS = 10_000;

/** The registry platform key of this computer, or null when the registry has none for it. */
export function hostPlatform(platform: NodeJS.Platform = process.platform, arch: string = process.arch): AcpPlatform | null {
  const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : null;
  if (!cpu) return null;
  if (platform === 'darwin') return `darwin-${cpu}`;
  if (platform === 'win32') return `windows-${cpu}`;
  if (platform === 'linux') {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
    return report?.header && !report.header.glibcVersionRuntime ? `linux-${cpu}-musl` : `linux-${cpu}`;
  }
  return null;
}

/** `@scope/name@1.2.3` → `@scope/name`. */
const packageName = (spec: string): string => spec.replace(/^(@[^/]+\/[^@]+|[^@]+)@.*$/, '$1');

/** The runtime id of a registry entry: a preset's id when it is a preset's agent. */
export function registryRuntimeId(registryId: string): string {
  return `acp-${ACP_PRESETS.find((p) => p.registryId === registryId)?.id ?? registryId}`;
}

/** A command that runs the agent from what is installed on this computer (no download). */
function localCommand(a: AcpRegistryAgent, platform: AcpPlatform | null): { cmd: string; args: string[]; env: Record<string, string> } | undefined {
  const bin = platform ? a.distribution.binary?.[platform] : undefined;
  if (bin) return bin;
  const npx = a.distribution.npx;
  const npmBin = npx ? KNOWN_NPM_BINS[packageName(npx.package)] : undefined;
  return npx && npmBin ? { cmd: npmBin, args: npx.args, env: npx.env } : undefined;
}

/** The command that downloads and runs the agent (npx/uvx): only with the user's consent. */
function downloadCommand(a: AcpRegistryAgent): { command: string[]; env: Record<string, string> } | undefined {
  const { npx, uvx } = a.distribution;
  if (npx) return { command: ['npx', '-y', npx.package, ...npx.args], env: npx.env };
  if (uvx) return { command: ['uvx', uvx.package, ...uvx.args], env: uvx.env };
  return undefined;
}

const primaryDistribution = (a: AcpRegistryAgent): AcpCatalogEntry['distribution'] =>
  a.distribution.binary ? 'binary' : a.distribution.npx ? 'npx' : 'uvx';

interface DetectRecord {
  ok: boolean;
  version?: string;
  message?: string;
  checkedAt: string;
}
type DetectCache = Record<string, DetectRecord>;

async function readDetectCache(cacheDir: string | undefined): Promise<DetectCache> {
  if (!cacheDir) return {};
  try {
    const raw = JSON.parse(await readFile(join(cacheDir, 'detect.json'), 'utf8')) as unknown;
    return raw && typeof raw === 'object' ? (raw as DetectCache) : {};
  } catch {
    return {};
  }
}

async function writeDetectCache(cacheDir: string | undefined, cache: DetectCache): Promise<void> {
  if (!cacheDir) return;
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const path = join(cacheDir, 'detect.json');
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, `${JSON.stringify(cache)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

/** Starts the agent, waits for its `initialize` answer, and stops it again. */
export async function acpHandshake(o: AcpAdapterOptions): Promise<RuntimeProbe> {
  const a = acpAdapter({ initTimeoutMs: DETECT_TIMEOUT_MS, ...o });
  try {
    return await a.probe();
  } finally {
    await a.dispose?.();
  }
}

export interface DiscoverOptions {
  registry: AcpRegistry;
  config: AcpAgentsConfig;
  allowBypass: boolean;
  which: Which;
  /** Defaults to this computer's (`hostPlatform()`). */
  platform?: AcpPlatform | null;
  /** Where handshake results are cached (per agent path and file version). */
  cacheDir?: string;
  /** Runtime ids already registered (manual entries, presets): those registry entries are skipped. */
  taken?: ReadonlySet<string>;
  /** Replaces the ACP `initialize` handshake (tests). */
  handshake?(o: AcpAdapterOptions): Promise<RuntimeProbe>;
}

/**
 * Agents from the ACP registry: an agent installed on PATH (a binary distribution for this OS, or
 * a known npm bin) that answers the ACP handshake is enabled; npx/uvx distributions are never run
 * here (that downloads code) and are only enabled from `config.enable`. `config.disable` wins.
 */
export async function discoverAcpAgents(o: DiscoverOptions): Promise<{ adapters: AcpAdapterOptions[]; catalog: AcpCatalogEntry[] }> {
  const platform = o.platform === undefined ? hostPlatform() : o.platform;
  const handshake = o.handshake ?? acpHandshake;
  const consent = new Set(o.config.enable ?? []);
  const autoDetect = o.config.autoDetect !== false;
  const cache = await readDetectCache(o.cacheDir);
  let cacheChanged = false;

  const results = await Promise.all(
    o.registry.agents.map(async (a): Promise<{ entry: AcpCatalogEntry; adapter?: AcpAdapterOptions }> => {
      const runtimeId = registryRuntimeId(a.id);
      const preset = ACP_PRESETS.find((p) => p.registryId === a.id);
      const entry: AcpCatalogEntry = {
        registryId: a.id,
        runtimeId,
        name: a.name,
        version: a.version,
        ...(a.description ? { description: a.description } : {}),
        distribution: primaryDistribution(a),
        status: 'unsupported',
      };
      if (!RUNTIME_ID.test(runtimeId)) return { entry: { ...entry, message: `"${a.id}" cannot be used as a runtime id.` } };
      if (o.taken?.has(runtimeId)) return { entry: { ...entry, status: 'manual' } };
      if (isDisabled(o.config, a.id, runtimeId)) return { entry: { ...entry, status: 'disabled' } };
      const consented = consent.has(a.id) || consent.has(runtimeId) || (preset !== undefined && consent.has(preset.id));
      const icon = registryIcon(a);
      const options = (command: string[], env: Record<string, string>): AcpAdapterOptions => ({
        id: runtimeId,
        displayName: preset?.displayName ?? a.name,
        command,
        ...(Object.keys(env).length > 0 ? { env } : {}),
        mcp: 'auto',
        allowBypass: o.allowBypass,
        ...(preset ? { installHint: preset.installHint } : {}),
        ...(a.website || a.repository ? { installUrl: (a.website ?? a.repository)! } : {}),
        ...(icon ? { icon } : {}),
      });

      const local = localCommand(a, platform);
      const resolved = local ? await o.which(local.cmd) : null;
      if (local && resolved) {
        const adapter = options([resolved, ...local.args], local.env);
        if (consented) return { entry: { ...entry, status: 'enabled', via: 'consent', command: adapter.command }, adapter };
        if (!autoDetect) return { entry: { ...entry, status: 'available', command: adapter.command, hint: `uncage runtimes enable ${a.id}` } };
        const file = await stat(resolved).catch(() => undefined);
        const key = JSON.stringify([a.id, resolved, local.args, file?.mtimeMs ?? 0, file?.size ?? 0]);
        let rec = cache[key];
        if (!rec) {
          const p: RuntimeProbe = await handshake(adapter).catch((err: unknown) => ({ status: 'error', message: String(err) }));
          rec = {
            ok: p.status === 'available',
            ...(p.version ? { version: p.version } : {}),
            ...(p.message ? { message: p.message } : {}),
            checkedAt: new Date().toISOString(),
          };
          cache[key] = rec;
          cacheChanged = true;
        }
        const detected = { ...entry, command: adapter.command, ...(rec.version ? { agentVersion: rec.version } : {}) };
        if (rec.ok) return { entry: { ...detected, status: 'enabled', via: 'detected' }, adapter };
        return {
          entry: { ...detected, status: 'failed', message: rec.message ?? 'The ACP handshake failed.', hint: `uncage runtimes enable ${a.id}   # to register it anyway` },
        };
      }

      const download = downloadCommand(a);
      if (consented && download) {
        const adapter = options(download.command, download.env);
        return { entry: { ...entry, status: 'enabled', via: 'consent', command: adapter.command }, adapter };
      }
      if (download) {
        const cli = UNDERLYING_CLI[a.id];
        const cliFound = cli ? await o.which(cli.cmd) : null;
        return {
          entry: {
            ...entry,
            distribution: download.command[0] === 'npx' ? 'npx' : 'uvx',
            status: 'available',
            message: `Runs with ${download.command[0]} (downloads ${a.distribution.npx?.package ?? a.distribution.uvx?.package}).${cliFound ? ` ${cli!.name} is installed.` : ''}`,
            hint: `uncage runtimes enable ${a.id}`,
          },
        };
      }
      if (local) {
        return { entry: { ...entry, status: 'not_installed', hint: `Install ${a.name}${a.website || a.repository ? ` (${a.website ?? a.repository})` : ''} and put "${local.cmd}" on PATH.` } };
      }
      return { entry: { ...entry, message: `No ${a.name} build for this computer.` } };
    }),
  );
  if (cacheChanged) await writeDetectCache(o.cacheDir, cache).catch(() => undefined);
  return {
    adapters: results.flatMap((r) => (r.adapter ? [r.adapter] : [])),
    catalog: results.map((r) => r.entry),
  };
}

/**
 * Every ACP runtime to register: manual entries and presets (`resolveAcpAgents`), then registry
 * agents (`discoverAcpAgents`) whose runtime id is not taken by those.
 */
export async function buildAcpAgents(
  cfg: AcpAgentsConfig,
  o: Omit<DiscoverOptions, 'config' | 'registry' | 'taken'> & { registry?: AcpRegistry },
): Promise<{ adapters: AcpAdapterOptions[]; catalog: AcpCatalogEntry[] }> {
  const registry = o.registry ?? bundledRegistry();
  const manual = await resolveAcpAgents(cfg, { allowBypass: o.allowBypass, which: o.which, registry });
  const discovered = await discoverAcpAgents({ ...o, registry, config: cfg, taken: new Set(manual.map((a) => a.id)) });
  return { adapters: [...manual, ...discovered.adapters], catalog: discovered.catalog };
}
