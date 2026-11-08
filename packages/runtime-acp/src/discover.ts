import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RuntimeProbe } from '@uncage/protocol';
import { acpAdapter, type AcpAdapterOptions } from './adapter.js';
import { ACP_PRESETS, isDisabled, resolveAcpAgents, type AcpAgentsConfig } from './presets.js';
import { bundledRegistry, registryIcon, type AcpPlatform, type AcpRegistry, type AcpRegistryAgent } from './registry.js';
import { spawnableCommand, type Which } from './which.js';

export type AcpCatalogStatus =
  /** Registered: detected on PATH and answered the ACP handshake, or enabled by the user. */
  | 'enabled'
  /** Registered from `runtimes.acp.agents` or a preset (wins over the registry entry). */
  | 'manual'
  /**
   * Needs `uncage runtimes enable <id>`: runs through npx/uvx (downloads code), its command changed
   * in a refreshed registry, its consent no longer matches, or `autoDetect` is off.
   */
  | 'available'
  | 'not_installed'
  /** On PATH but the ACP handshake failed. */
  | 'failed'
  | 'disabled'
  /** Runs the same command as a runtime already registered (e.g. `opencode` and `opencode-v2`). */
  | 'duplicate'
  /** No distribution for this OS/CPU, an id Uncage cannot use as a runtime id, or not runnable safely. */
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
/** A failed handshake is retried after this long (a timeout is never cached). */
const FAILED_TTL_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MESSAGE = /did not answer initialize within/;

/** Text that reaches a terminal: control characters (escape sequences) become spaces. */
const clean = (s: string): string => s.replace(/\p{Cc}+/gu, ' ').trim().slice(0, 500);

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

/** `@scope/name@1.2.3` → `@scope/name`; `name==1.2` / `name[extra]` → `name`. */
export const packageName = (spec: string): string =>
  spec.replace(/^(@[^/]+\/[^@]+|[^@]+)@.*$/, '$1').replace(/(\[.*\])?((==|>=|<=|~=).*)?$/, '');

/** The runtime id of a registry entry: a preset's id when it is a preset's agent. */
export function registryRuntimeId(registryId: string): string {
  return `acp-${ACP_PRESETS.find((p) => p.registryId === registryId)?.id ?? registryId}`;
}

export interface LocalCommand {
  cmd: string;
  args: string[];
  env: Record<string, string>;
}

/** A command that runs the agent from what is installed on this computer (no download). */
export function localCommand(a: AcpRegistryAgent, platform: AcpPlatform | null): LocalCommand | undefined {
  const bin = platform ? a.distribution.binary?.[platform] : undefined;
  if (bin) return bin;
  const npx = a.distribution.npx;
  const npmBin = npx ? KNOWN_NPM_BINS[packageName(npx.package)] : undefined;
  return npx && npmBin ? { cmd: npmBin, args: npx.args, env: npx.env } : undefined;
}

/** What a consent to download is bound to: the runner and package name (not the version). */
export function consentRef(a: Pick<AcpRegistryAgent, 'distribution'>): string | undefined {
  const { npx, uvx } = a.distribution;
  if (npx) return `npx:${packageName(npx.package)}`;
  if (uvx) return `uvx:${packageName(uvx.package)}`;
  return undefined;
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

const specKey = (l: LocalCommand): string => JSON.stringify([l.cmd, l.args, Object.entries(l.env).sort()]);

interface DetectRecord {
  ok: boolean;
  version?: string;
  message?: string;
  checkedAt: string;
}
interface DetectCache {
  v: 2;
  /** Handshake results by `[id, path, args, mtime, size]`. */
  handshakes: Record<string, DetectRecord>;
  /** Per registry id: the local command spec last handshaken successfully (trusted after a refresh). */
  trusted: Record<string, string>;
}

async function readDetectCache(cacheDir: string | undefined): Promise<DetectCache> {
  const empty: DetectCache = { v: 2, handshakes: {}, trusted: {} };
  if (!cacheDir) return empty;
  try {
    const raw = JSON.parse(await readFile(join(cacheDir, 'detect.json'), 'utf8')) as Partial<DetectCache> | null;
    if (raw?.v !== 2 || typeof raw.handshakes !== 'object' || typeof raw.trusted !== 'object') return empty;
    return { v: 2, handshakes: raw.handshakes ?? {}, trusted: raw.trusted ?? {} };
  } catch {
    return empty;
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

/** Starts the agent, waits for its `initialize` answer, and stops it (its whole process group) again. */
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
  /** Registry platform key; defaults to this computer's (`hostPlatform()`). */
  platform?: AcpPlatform | null;
  /** Operating system for spawning (`win32`: PATHEXT, npm `.cmd` shims). Defaults to process.platform. */
  os?: NodeJS.Platform;
  /** Where handshake results are cached (per agent path and file version). */
  cacheDir?: string;
  /**
   * The snapshot shipped with Uncage: a binary from a refreshed registry is handshaken only when its
   * command equals this snapshot's (or the one last handshaken). Defaults to `bundledRegistry()`.
   */
  bundled?: AcpRegistry;
  /** Runtime ids already registered (manual entries, presets): those registry entries are skipped. */
  taken?: ReadonlySet<string>;
  /** Commands already registered (spawnable argv, JSON): a registry entry running the same is a duplicate. */
  takenCommands?: ReadonlySet<string>;
  /** Replaces the ACP `initialize` handshake (tests). */
  handshake?(o: AcpAdapterOptions): Promise<RuntimeProbe>;
  now?: () => Date;
}

type Result = { entry: AcpCatalogEntry; adapter?: AcpAdapterOptions };

/**
 * Agents from the ACP registry:
 * - installed on PATH (a binary distribution for this OS, or a known npm bin) and answering the ACP
 *   handshake → enabled. After a registry refresh, only when the command (cmd, args, env) equals the
 *   bundled snapshot's or the one last handshaken; otherwise it waits for `enable`.
 * - npx/uvx distributions download code: never run here; enabled only by `config.enable` with a
 *   matching `config.consented` (runner + package name).
 * - `config.disable` wins; `autoDetect: false` handshakes nothing (only `enable`d agents register).
 */
export async function discoverAcpAgents(o: DiscoverOptions): Promise<{ adapters: AcpAdapterOptions[]; catalog: AcpCatalogEntry[] }> {
  const platform = o.platform === undefined ? hostPlatform() : o.platform;
  const os = o.os ?? process.platform;
  const handshake = o.handshake ?? acpHandshake;
  const enabled = new Set(o.config.enable ?? []);
  const consented = o.config.consented ?? {};
  const autoDetect = o.config.autoDetect !== false;
  const now = o.now?.() ?? new Date();
  const fromRefresh = o.registry.source === 'cache';
  const bundled = fromRefresh ? (o.bundled ?? bundledRegistry()) : undefined;
  const cache = await readDetectCache(o.cacheDir);
  const used: DetectCache = { v: 2, handshakes: {}, trusted: { ...cache.trusted } };
  let cacheChanged = false;

  const discover = async (a: AcpRegistryAgent): Promise<Result> => {
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
    const isEnabled = enabled.has(a.id) || enabled.has(runtimeId) || (preset !== undefined && enabled.has(preset.id));
    const enableHint = `uncage runtimes enable ${a.id}`;
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
      const command = await spawnableCommand([resolved, ...local.args], { which: o.which, platform: os });
      if (!command) return { entry: { ...entry, message: 'Its arguments cannot be passed safely to cmd.exe.' } };
      const adapter = options(command, local.env);
      const found = { ...entry, command };
      if (isEnabled) return { entry: { ...found, status: 'enabled', via: 'consent' }, adapter };
      if (!autoDetect) return { entry: { ...found, status: 'available', message: 'autoDetect is off.', hint: enableHint } };
      const spec = specKey(local);
      const bundledEntry = bundled?.agents.find((b) => b.id === a.id);
      const bundledLocal = bundledEntry ? localCommand(bundledEntry, platform) : undefined;
      const trusted = !fromRefresh || (bundledLocal !== undefined && specKey(bundledLocal) === spec) || cache.trusted[a.id] === spec;
      if (!trusted) {
        return {
          entry: {
            ...found,
            status: 'available',
            message: `Its command changed in the refreshed ACP registry (now: ${clean([local.cmd, ...local.args].join(' '))}).`,
            hint: enableHint,
          },
        };
      }
      const file = await stat(resolved).catch(() => undefined);
      const key = JSON.stringify([a.id, resolved, local.args, file?.mtimeMs ?? 0, file?.size ?? 0]);
      let rec: DetectRecord | undefined = cache.handshakes[key];
      if (rec && !rec.ok && now.getTime() - Date.parse(rec.checkedAt) > FAILED_TTL_MS) rec = undefined;
      if (!rec) {
        const p: RuntimeProbe = await handshake(adapter).catch((err: unknown) => ({ status: 'error', message: String(err) }));
        rec = {
          ok: p.status === 'available',
          ...(p.version ? { version: clean(p.version).slice(0, 64) } : {}),
          ...(p.message ? { message: clean(p.message) } : {}),
          checkedAt: now.toISOString(),
        };
        cacheChanged = true;
      }
      // Timeouts are not remembered: the next start tries again.
      if (rec.ok || !TIMEOUT_MESSAGE.test(rec.message ?? '')) used.handshakes[key] = rec;
      const detected = { ...found, ...(rec.version ? { agentVersion: rec.version } : {}) };
      if (rec.ok) {
        if (used.trusted[a.id] !== spec) {
          used.trusted[a.id] = spec;
          cacheChanged = true;
        }
        return { entry: { ...detected, status: 'enabled', via: 'detected' }, adapter };
      }
      return {
        entry: { ...detected, status: 'failed', message: rec.message ?? 'The ACP handshake failed.', hint: `${enableHint}   # to register it anyway` },
      };
    }

    const download = downloadCommand(a);
    const ref = consentRef(a);
    if (download && ref) {
      const kind = download.command[0] === 'npx' ? 'npx' : 'uvx';
      const pkg = a.distribution.npx?.package ?? a.distribution.uvx?.package;
      const given = consented[a.id];
      if (isEnabled && given === ref) {
        const command = await spawnableCommand(download.command, { which: o.which, platform: os });
        if (!command) return { entry: { ...entry, message: 'Its arguments cannot be passed safely to cmd.exe.' } };
        const adapter = options(command, download.env);
        return { entry: { ...entry, distribution: kind, status: 'enabled', via: 'consent', command }, adapter };
      }
      const cli = UNDERLYING_CLI[a.id];
      const cliFound = cli ? await o.which(cli.cmd) : null;
      const why =
        isEnabled && given !== undefined
          ? `You enabled ${given}; the registry now runs ${ref}. Enable it again to allow that.`
          : isEnabled
            ? 'Enabled without a recorded package; enable it again to allow the download.'
            : `Runs with ${kind} (downloads ${pkg}).${cliFound ? ` ${cli!.name} is installed.` : ''}`;
      return { entry: { ...entry, distribution: kind, status: 'available', message: why, hint: enableHint } };
    }
    if (local) {
      return { entry: { ...entry, status: 'not_installed', hint: `Install ${a.name}${a.website || a.repository ? ` (${a.website ?? a.repository})` : ''} and put "${local.cmd}" on PATH.` } };
    }
    return { entry: { ...entry, message: `No ${a.name} build for this computer.` } };
  };

  const results = await Promise.all(o.registry.agents.map(discover));
  // Same command as a runtime already registered (manual, preset or an earlier registry entry).
  const commands = new Set(o.takenCommands ?? []);
  const owners = new Map<string, string>();
  for (const r of results) {
    if (!r.adapter) continue;
    const key = JSON.stringify(r.adapter.command);
    if (commands.has(key)) {
      r.entry = { ...r.entry, status: 'duplicate', message: `Same command as ${owners.get(key) ?? 'a registered runtime'}.` };
      delete r.adapter;
      continue;
    }
    commands.add(key);
    owners.set(key, r.adapter.id);
  }
  // Prune: keep only the handshakes this run looked at (plus the trusted specs).
  if (cacheChanged || JSON.stringify(used) !== JSON.stringify(cache)) {
    await writeDetectCache(o.cacheDir, used).catch(() => undefined);
  }
  return {
    adapters: results.flatMap((r) => (r.adapter ? [r.adapter] : [])),
    catalog: results.map((r) => r.entry),
  };
}

/**
 * Every ACP runtime to register: manual entries and presets (`resolveAcpAgents`, made spawnable on
 * Windows), then registry agents (`discoverAcpAgents`) whose runtime id and command are not taken.
 */
export async function buildAcpAgents(
  cfg: AcpAgentsConfig,
  o: Omit<DiscoverOptions, 'config' | 'registry' | 'taken' | 'takenCommands'> & { registry?: AcpRegistry },
): Promise<{ adapters: AcpAdapterOptions[]; catalog: AcpCatalogEntry[] }> {
  const registry = o.registry ?? bundledRegistry();
  const os = o.os ?? process.platform;
  const manual: AcpAdapterOptions[] = [];
  const takenCommands = new Set<string>();
  for (const a of await resolveAcpAgents(cfg, { allowBypass: o.allowBypass, which: o.which, registry })) {
    const command = await spawnableCommand(a.command, { which: o.which, platform: os });
    if (!command) continue;
    manual.push({ ...a, command });
    // Compare by resolved executable so `opencode` and `/usr/local/bin/opencode` match.
    const first = (await o.which(command[0]!)) ?? command[0]!;
    takenCommands.add(JSON.stringify([first, ...command.slice(1)]));
  }
  const discovered = await discoverAcpAgents({ ...o, registry, config: cfg, taken: new Set(manual.map((a) => a.id)), takenCommands });
  return { adapters: [...manual, ...discovered.adapters], catalog: discovered.catalog };
}
