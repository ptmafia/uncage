import { join } from 'node:path';
import { agentDir, type AcpRuntimesConfig } from '@uncage/agent';
import type { RuntimeAdapter, RuntimeIcon, RuntimeProbe } from '@uncage/protocol';
import {
  buildAcpAgents,
  createWhich,
  loadRegistry,
  registryIcon,
  type AcpAdapterOptions,
  type AcpCatalogEntry,
  type AcpPlatform,
  type AcpRegistry,
} from '@uncage/runtime-acp';

/** Registry cache and handshake results: `~/.uncage/acp/` (UNCAGE_HOME in tests). */
export const acpCacheDir = (home: string): string => join(agentDir(home), 'acp');

/** Official icons of the native runtimes, from their ACP registry entries. */
export interface NativeIcons {
  claude?: RuntimeIcon;
  codex?: RuntimeIcon;
}

export function nativeIcons(registry: AcpRegistry): NativeIcons {
  const icon = (id: string) => {
    const a = registry.agents.find((x) => x.id === id);
    return a ? registryIcon(a) : undefined;
  };
  const claude = icon('claude-acp');
  const codex = icon('codex-acp');
  return { ...(claude ? { claude } : {}), ...(codex ? { codex } : {}) };
}

/** The adapter with an icon (adapters are plain objects of closures, so a spread copy is safe). */
export function withIcon(a: RuntimeAdapter, icon: RuntimeIcon | undefined): RuntimeAdapter {
  return icon ? { ...a, icon } : a;
}

export interface AcpSetup {
  adapters: AcpAdapterOptions[];
  catalog: AcpCatalogEntry[];
  registry: AcpRegistry;
  nativeIcons: NativeIcons;
}

/**
 * ACP runtimes for `runtimes.acp`: manual entries, presets on PATH, and registry agents detected on
 * PATH (handshake-checked, cached under `~/.uncage/acp`). Uses the cached registry when a refresh
 * downloaded one, else the bundled snapshot; never touches the network.
 */
export async function setupAcp(o: {
  acp: AcpRuntimesConfig;
  allowBypass: boolean;
  home: string;
  /** PATH lookups (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  platform?: AcpPlatform | null;
  handshake?(o: AcpAdapterOptions): Promise<RuntimeProbe>;
}): Promise<AcpSetup> {
  const cacheDir = acpCacheDir(o.home);
  const registry = await loadRegistry(cacheDir);
  const { adapters, catalog } = await buildAcpAgents(o.acp, {
    registry,
    allowBypass: o.allowBypass,
    which: createWhich(o.env ?? process.env),
    cacheDir,
    ...(o.platform !== undefined ? { platform: o.platform } : {}),
    ...(o.handshake ? { handshake: o.handshake } : {}),
  });
  return { adapters, catalog, registry, nativeIcons: nativeIcons(registry) };
}
