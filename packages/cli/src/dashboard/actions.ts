import { DEFAULT_ACP_RUNTIMES, loadAgentConfig, readActivity, type ActivityEntry, type AgentSite } from '@uncage/agent';
import { ACP_PRESETS, acpName, loadRegistry, type AcpRegistry, type Which } from '@uncage/runtime-acp';
import { acpCacheDir } from '../acp.js';
import { toggleRuntime } from '../runtimes-cmd.js';
import type { AgentService, ServiceKind } from '../service/index.js';
import { registrableDomain } from '../site-identity.js';
import { NotRevokedError, removeSite, type RevokeOutcome } from '../sites.js';

/** How many activity entries each site shows (newest first). */
export const ACTIVITY_LIMIT = 20;

export interface DashboardDeps {
  home: string;
  /** The background agent (null: none, e.g. a foreground run with UNCAGE_HOME): restarted after changes. */
  service: AgentService | null;
  fetch: typeof fetch;
  /** The ACP registry (default: the cached or bundled copy, like `uncage runtimes`). */
  registry?: AcpRegistry;
  /** Whether an agent is installed (default PATH), for runtime consent. */
  which?: Which;
}

export interface AgentView {
  kind: ServiceKind;
  installed: boolean;
  /** null when the service manager cannot tell, or there is no service. */
  running: boolean | null;
}

export type RuntimeState = 'builtin' | 'enabled' | 'disabled' | 'auto' | 'configured';

export interface RuntimeView {
  /** What `uncage runtimes enable|disable` takes (registry id for ACP agents). */
  id: string;
  name: string;
  state: RuntimeState;
  /** Whether enable / disable apply (registry and preset ACP agents). */
  toggle: boolean;
}

export type SiteState = 'online' | 'offline' | 'revoked';

export interface SiteView {
  id: string;
  name: string;
  /** `https://app.example.com` */
  origin: string;
  /** The registrable domain (`example.com`): who owns the site. */
  domain: string;
  machineId: string;
  connectedAt?: string;
  revokedAt?: string;
  state: SiteState;
  /** The transport of the last connection (`ws` / `http`). */
  transport?: string;
  /** Runtime ids this computer offers to the site. */
  runtimes: string[];
  /** The last entries of the site's (already redacted) activity log, newest first. */
  activity: ActivityEntry[];
}

export interface DashboardData {
  agent: AgentView;
  policy: { allowBypass: boolean; allowedPermissionModes?: string[] };
  runtimes: RuntimeView[];
  sites: SiteView[];
}

/** Why an action was refused: the page translates the code; `message` is the English detail. */
export type ActionErrorCode = 'not_found' | 'not_revoked' | 'revoke_failed' | 'unknown_agent' | 'builtin' | 'bad_request';

/** A client error (unknown id, refused change): answered with this HTTP status, code and message. */
export class ActionError extends Error {
  constructor(
    readonly status: number,
    readonly code: ActionErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Whether the background agent was restarted after a change. */
export type RestartOutcome = 'restarted' | 'not_installed' | 'failed' | 'none';

/** Every action's result: a code (with parameters) the page translates, plus the CLI's English lines. */
export type ActionResult =
  | { code: 'disconnected'; name: string; domain: string; revoke: RevokeOutcome; restart: RestartOutcome; messages: string[] }
  | { code: 'runtime_enabled' | 'runtime_disabled'; name: string; runs?: string; download?: 'npm' | 'PyPI'; restart: RestartOutcome; messages: string[] };

async function agentView(service: AgentService | null): Promise<AgentView> {
  if (!service) return { kind: 'none', installed: false, running: null };
  const st = await service.status().catch(() => null);
  return { kind: service.kind, installed: st?.installed ?? false, running: st ? st.running : null };
}

const CONNECTION_KINDS = new Set<ActivityEntry['kind']>(['connected', 'disconnected', 'revoked', 'replaced']);

/**
 * Online when the last connection entry of the activity log is `connected` and the agent is not
 * known to be stopped (a killed agent never logs `disconnected`, so a stopped service wins).
 */
function siteState(site: AgentSite, log: ActivityEntry[], agent: AgentView): { state: SiteState; transport?: string } {
  if (site.revokedAt) return { state: 'revoked' };
  const last = log.findLast((e) => CONNECTION_KINDS.has(e.kind));
  if (last?.kind === 'revoked') return { state: 'revoked' };
  const transport = log.findLast((e) => e.kind === 'connected')?.name;
  const online = last?.kind === 'connected' && agent.running !== false;
  return { state: online ? 'online' : 'offline', ...(transport ? { transport } : {}) };
}

const inList = (list: string[], ...names: string[]): boolean => {
  const set = new Set(list.map(acpName));
  return names.some((n) => set.has(acpName(n)));
};

function runtimeViews(acp: typeof DEFAULT_ACP_RUNTIMES, registry: AcpRegistry): RuntimeView[] {
  const rows: RuntimeView[] = [
    { id: 'claude', name: 'Claude Code', state: 'builtin', toggle: false },
    { id: 'codex', name: 'Codex', state: 'builtin', toggle: false },
  ];
  const seen = new Set<string>();
  const add = (id: string, name: string, toggle = true) => {
    if (seen.has(acpName(id))) return;
    seen.add(acpName(id));
    const preset = ACP_PRESETS.find((p) => p.registryId === id || p.id === id);
    const names = [id, ...(preset ? [preset.id, preset.registryId] : [])];
    const state: RuntimeState = inList(acp.disable, ...names) ? 'disabled' : inList(acp.enable, ...names) ? 'enabled' : 'auto';
    rows.push({ id, name, state, toggle });
  };
  const nameOf = (id: string) => ACP_PRESETS.find((p) => p.registryId === id || p.id === id)?.displayName ?? registry.agents.find((a) => a.id === id)?.name ?? id;
  if (acp.presets !== 'off') for (const p of ACP_PRESETS) add(p.registryId, p.displayName);
  for (const id of [...acp.enable, ...acp.disable]) add(acpName(id), nameOf(acpName(id)));
  for (const a of acp.agents) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    rows.push({ id: a.id, name: a.displayName ?? a.id, state: a.enabled && !inList(acp.disable, a.id) ? 'configured' : 'disabled', toggle: false });
  }
  return rows;
}

/** A site URL's origin and registrable domain; a malformed or host-less URL in agent.yaml shows as is, domain `?`. */
function siteWhere(url: string): { origin: string; domain: string } {
  try {
    const u = new URL(url);
    if (u.hostname) return { origin: u.origin, domain: registrableDomain(u.hostname) };
  } catch {
    // shown as is below
  }
  return { origin: url, domain: '?' };
}

/** `GET /api/sites`: every connected site with its domain, status, runtimes and recent activity. */
export async function dashboardData(d: DashboardDeps): Promise<DashboardData> {
  const config = await loadAgentConfig(d.home);
  const acp = config.runtimes?.acp ?? DEFAULT_ACP_RUNTIMES;
  const [agent, registry] = await Promise.all([agentView(d.service), d.registry ?? loadRegistry(acpCacheDir(d.home))]);
  const runtimes = runtimeViews(acp, registry);
  const offered = runtimes.filter((r) => r.state !== 'disabled').map((r) => r.id);
  const sites = await Promise.all(
    config.sites.map(async (site): Promise<SiteView> => {
      const log = await readActivity(d.home, site.id).catch(() => []);
      const where = siteWhere(site.url);
      const firstConnected = log.find((e) => e.kind === 'connected')?.at;
      const connectedAt = site.connectedAt ?? firstConnected;
      return {
        id: site.id,
        name: site.name,
        ...where,
        machineId: site.machineId,
        ...(connectedAt ? { connectedAt } : {}),
        ...(site.revokedAt ? { revokedAt: site.revokedAt } : {}),
        ...siteState(site, log, agent),
        runtimes: offered,
        activity: log.slice(-ACTIVITY_LIMIT).reverse(),
      };
    }),
  );
  return {
    agent,
    policy: { allowBypass: config.localPolicy.allowBypass, ...(config.localPolicy.allowedPermissionModes ? { allowedPermissionModes: config.localPolicy.allowedPermissionModes } : {}) },
    runtimes,
    sites,
  };
}

/** Restarts the background agent so it picks up a change (like the CLI commands do). */
async function restart(d: DashboardDeps, messages: string[]): Promise<RestartOutcome> {
  if (!d.service) return 'none';
  try {
    if (!(await d.service.restart())) return 'not_installed';
    messages.push('✓ Background agent restarted.');
    return 'restarted';
  } catch (e) {
    messages.push(`! Could not restart the background agent: ${e instanceof Error ? e.message : String(e)}`);
    return 'failed';
  }
}

/**
 * `POST /api/sites/:id/disconnect`: exactly `uncage sites remove <id>` (revoke on the hub with the
 * machine's own token, remove from agent.yaml; a proxy's 401 keeps the token), then restarts the agent.
 */
export async function disconnectSite(d: DashboardDeps, id: string): Promise<ActionResult> {
  const config = await loadAgentConfig(d.home);
  const site = config.sites.find((s) => s.id === id);
  if (!site) throw new ActionError(404, 'not_found', `No connected website "${id}".`);
  const messages: string[] = [];
  let revoke: RevokeOutcome;
  try {
    revoke = await removeSite({ home: d.home, id, fetch: d.fetch, out: (l) => messages.push(l) });
  } catch (e) {
    throw new ActionError(502, e instanceof NotRevokedError ? 'not_revoked' : 'revoke_failed', e instanceof Error ? e.message : String(e));
  }
  const restarted = await restart(d, messages);
  return { code: 'disconnected', name: site.name, domain: siteWhere(site.url).domain, revoke, restart: restarted, messages };
}

/**
 * `POST /api/runtimes/:id/enable|disable`: exactly `uncage runtimes enable|disable <id>` (consent
 * bound to the command or npx/uvx package; unknown agents refused), then restarts the agent.
 */
export async function setRuntime(d: DashboardDeps, id: string, enable: boolean): Promise<ActionResult> {
  if (id === 'claude' || id === 'codex') throw new ActionError(400, 'builtin', `${id} is built in; it is not an ACP agent.`);
  const messages: string[] = [];
  let r: Awaited<ReturnType<typeof toggleRuntime>>;
  try {
    r = await toggleRuntime({
      home: d.home,
      id,
      enable,
      out: (l) => messages.push(l),
      registry: d.registry ?? (await loadRegistry(acpCacheDir(d.home))),
      ...(d.which ? { which: d.which } : {}),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new ActionError(400, /^Unknown ACP agent/.test(message) ? 'unknown_agent' : 'bad_request', message);
  }
  const restarted = await restart(d, messages);
  return {
    code: enable ? 'runtime_enabled' : 'runtime_disabled',
    name: r.label,
    ...(r.runs ? { runs: r.runs } : {}),
    ...(r.download ? { download: r.download } : {}),
    restart: restarted,
    messages,
  };
}
