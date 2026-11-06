import type { RuntimeAdapter, RuntimeCapabilities, RuntimeInfo } from '@uncage/protocol';
import { UncageError } from './errors.js';
import { applyPolicy, type SecurityPolicy } from './settings.js';

const PROBE_TTL_MS = 30_000;

/**
 * Registered adapters plus a 30 s probe cache. A probe also refreshes the adapter's dynamic
 * capabilities (`refreshCapabilities`, falling back to `capabilities()`); the security policy is
 * applied to every capability set handed out.
 */
export class AdapterRegistry {
  private readonly adapters = new Map<string, RuntimeAdapter>();
  private readonly cache = new Map<string, { at: number; info: Promise<RuntimeInfo> }>();

  constructor(
    adapters: RuntimeAdapter[],
    private readonly policy: SecurityPolicy = { allowBypass: false },
  ) {
    for (const a of adapters) {
      if (this.adapters.has(a.id)) throw new Error(`Duplicate runtime adapter id: ${a.id}`);
      this.adapters.set(a.id, a);
    }
  }

  find(id: string): RuntimeAdapter | undefined {
    return this.adapters.get(id);
  }

  require(id: string): RuntimeAdapter {
    const a = this.adapters.get(id);
    if (!a) throw new UncageError('not_found', { message: `Runtime ${id} not found.` });
    return a;
  }

  list(): Promise<RuntimeInfo[]> {
    return Promise.all([...this.adapters.keys()].map((id) => this.info(id)));
  }

  async info(id: string): Promise<RuntimeInfo> {
    const adapter = this.require(id);
    const hit = this.cache.get(id);
    if (hit && Date.now() - hit.at < PROBE_TTL_MS) return hit.info;
    const info = probe(adapter, this.policy);
    this.cache.set(id, { at: Date.now(), info });
    return info;
  }

  /** The runtime's current capabilities: the probed set when available, else its static set. */
  async capabilities(id: string): Promise<RuntimeCapabilities> {
    const info = await this.info(id);
    return info.capabilities ?? applyPolicy(this.require(id).capabilities(), this.policy);
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([...this.adapters.values()].map((a) => a.dispose?.()));
  }
}

async function refreshed(a: RuntimeAdapter): Promise<RuntimeCapabilities> {
  if (!a.refreshCapabilities) return a.capabilities();
  try {
    return await a.refreshCapabilities();
  } catch {
    return a.capabilities();
  }
}

async function probe(a: RuntimeAdapter, policy: SecurityPolicy): Promise<RuntimeInfo> {
  const base = { id: a.id, displayName: a.displayName };
  try {
    const p = await a.probe();
    return {
      ...base,
      status: p.status,
      ...(p.version !== undefined ? { version: p.version } : {}),
      // Only an available runtime is asked to re-detect (e.g. list models).
      capabilities: applyPolicy(p.status === 'available' ? await refreshed(a) : a.capabilities(), policy),
      ...(p.message !== undefined ? { message: p.message } : {}),
      ...(p.hint !== undefined ? { hint: p.hint } : {}),
      ...(p.installUrl !== undefined ? { installUrl: p.installUrl } : {}),
    };
  } catch (e) {
    return { ...base, status: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}
