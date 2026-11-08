import type { SkillSpec } from '@uncage/protocol';
import type { ClusterAdapter } from './cluster/cluster.js';
import type { InstallScriptExtension } from './install/render.js';
import type { HubLogger, MachineHub } from './machines.js';
import type { HubStore } from './store/store.js';
import type { SiteTool } from './tools.js';

export interface HubUser {
  id: string;
  name?: string;
}

export interface HubOptions {
  /** The website's public origin, e.g. `https://app.example.com`. */
  publicUrl: string;
  /** Where `fetch` is mounted. Defaults to `/api/uncage`. */
  basePath?: string;
  /** Website auth: the signed-in user for a browser request, or `null`. */
  getUser(req: Request): Promise<HubUser | null>;
  /**
   * Required. `pgliteHubStore({ dataDir })` from `@uncage/hub/node` for a single Node process;
   * `postgresHubStore` (or `sqlHubStore` on any SQL client) for several nodes or serverless
   * platforms. The hub never closes it: close it yourself after `hub.close()`.
   */
  store: HubStore;
  /** Defaults to `memoryCluster()` (single node). Several nodes share one `redisCluster`. */
  cluster?: ClusterAdapter;
  /**
   * Site tools (`defineTool`) offered to runs as MCP tools. They execute on the hub node holding
   * the machine's connection, as the session's owner; every call is audited in the store
   * (`listToolCalls`) and shows in the session's events as the runtime's `tool.*` events.
   */
  tools?: SiteTool[];
  skills?: SkillSpec[];
  /**
   * Picks the tools and skills (by name) offered to a run. Defaults to all. `runtime` is the
   * session's runtime id (`claude-code`, `codex`, …). Whatever you pick, tools are dropped for a
   * runtime the machine reports without `capabilities.siteTools` (Codex today): the run still
   * starts, with its skills, and shows a `system.warning` with code `site_tools_unsupported`.
   */
  selectManifest?(ctx: { user: HubUser; prompt: string; sessionId: string; runtime: string }): Promise<{ tools: string[]; skills: string[] }>;
  /**
   * `'machine'` (default): session history lives only on the machine (offline machine → no history).
   * `'site'`: the hub keeps a replica of every session's events and snapshot, readable while the
   * machine is offline. In site mode the hub only records sessions it created itself; events a
   * machine reports for any other session id are ignored (and logged).
   *
   * In either mode the hub keeps a copy of each attachment sent through the website (it shows in
   * the chat history), deleted after `attachmentRetentionDays` or when the machine is revoked.
   */
  sessionStorage?: 'machine' | 'site';
  /**
   * Days the hub keeps attachment bytes sent through the website (a periodic sweep deletes older
   * ones — `attachWebSocket` runs it hourly in a long-running process; the machine keeps its own copy). Default 30. `Infinity` keeps them until the machine is
   * revoked.
   */
  attachmentRetentionDays?: number;
  /** Agents older than this are told to upgrade. Defaults to this package's version. */
  minAgentVersion?: string;
  /** `install.sh` installs `@uncage/cli@<range>`. Defaults to `^<major.minor>` of this package. */
  cliVersionRange?: string;
  /**
   * Extends the installers served at `install.sh` (and `install.ps1`): a step run after the CLI
   * install and/or your own "no agent found" help. Static text only, fixed when the hub starts
   * (never request data); validated by `createHub`.
   */
  installScript?: InstallScriptExtension;
  /** Site identity sent to machines at pairing. Default id/name are derived from `publicUrl`'s host. */
  site?: { id?: string; name?: string };
  /** Page on the website where users approve a device code. Defaults to `/device`. */
  verificationPath?: string;
  /**
   * Machine heartbeat: ping every `pingIntervalMs` (10 000), offline after `missedPings` (2)
   * unanswered, so a silent machine shows offline within ~30 s.
   */
  heartbeat?: { pingIntervalMs?: number; missedPings?: number };
  /** SSE comment heartbeat for browser event streams. Defaults to 15 000 ms. */
  sseHeartbeatMs?: number;
  /** How long a browser request waits for the machine. Defaults to 30 000 ms. */
  commandTimeoutMs?: number;
  /** A site tool handler still running after this fails with `tool_failed`. Defaults to 120 000 ms. */
  toolTimeoutMs?: number;
  /**
   * Site tool calls one machine connection may have executing at once. Further calls fail at once
   * with `tool_failed` (`details.reason: 'too_many_concurrent'`). Defaults to 8.
   */
  maxConcurrentToolCalls?: number;
  /**
   * Abuse limits, counted in memory per hub node (with several nodes each counts on its own until
   * limits are shared through the cluster adapter). Exceeding one → 429 `rate_limited`.
   */
  rateLimits?: {
    /** `POST /device/code` per client IP per minute. Default 20. */
    deviceCodesPerMinute?: number;
    /** Failed `approveDevice` / `denyDevice` / `lookupDevice` attempts (unknown codes) per user per window. Default 10. */
    userCodeFailures?: number;
    /** Window for `userCodeFailures`. Default 600 000 ms (10 min). */
    userCodeWindowMs?: number;
    /**
     * Client IP for per-IP limits. When set it wins over everything else. Otherwise: `info.clientIp`
     * passed to `fetch` (`toNodeHandler` passes Express's `req.ip`, which honours `trust proxy`,
     * else the socket address); else, only with `trustForwardedFor`, the rightmost
     * `X-Forwarded-For` entry; else one bucket shared by all callers.
     *
     * Behind a reverse proxy / load balancer: with Express set `app.set('trust proxy', 1)` (number
     * of proxies in front); with a Fetch-style host (e.g. Next route handlers) set
     * `trustForwardedFor: true` only if your proxy appends the client address to X-Forwarded-For,
     * or supply `clientIp` (e.g. from your platform's client-IP header).
     */
    clientIp?(req: Request): string | undefined;
    /** Use the rightmost `X-Forwarded-For` entry when no client IP is known. Default false. */
    trustForwardedFor?: boolean;
  };
}

/** Key of the hub's internals, read by `@uncage/hub/node` only. */
export const HUB_INTERNALS: unique symbol = Symbol.for('uncage.hub.internals') as never;

/** @internal What `@uncage/hub/node` needs from a hub. */
export interface HubInternalsHandle {
  machines: MachineHub;
  basePath: string;
  logger: HubLogger;
  /** This process serves machine WebSockets (at `path`, default `<basePath>/agent`): offer them and listen for commands. */
  enableWebSocket(o?: { path?: string }): void;
  /** Machine heartbeat for WebSocket links. */
  heartbeat: { pingIntervalMs: number; missedPings: number };
  /** Retention sweep (run manifests, attachment copies) a long-running process runs every `intervalMs`. */
  maintenance: { intervalMs: number; run(): Promise<void> };
}

export interface Hub {
  /** Normalized mount path, e.g. `/api/uncage`. */
  readonly basePath: string;
  /**
   * Browser API, device endpoints and `install.sh`, all under `basePath`, as a Fetch handler.
   * Pass `info.clientIp` (the client address) when known; `toNodeHandler` does. `info.waitUntil`
   * is the platform's hook for work that may outlive the response (e.g. Workers' `ctx.waitUntil`).
   */
  fetch(req: Request, info?: { clientIp?: string; waitUntil?(p: Promise<unknown>): void }): Promise<Response>;
  /**
   * Approve / deny / look up a user code on the website's approve page. Unknown codes count as
   * failed guesses: after `rateLimits.userCodeFailures` in the window these throw an `UncageError`
   * with code `rate_limited` (status 429, `details.retryAfterSec`).
   */
  approveDevice(userCode: string, user: HubUser): Promise<'ok' | 'not_found' | 'expired'>;
  denyDevice(userCode: string, user: HubUser): Promise<'ok' | 'not_found' | 'expired'>;
  /**
   * What the approve page shows about a pending code, or `null` if unknown / no longer pending.
   * `repairsMachine` is set when approving would re-pair one of `user`'s existing machines (warn
   * "re-pairing <name>"): it keeps its id and sessions and its old token stops working.
   */
  lookupDevice(
    userCode: string,
    user: HubUser,
  ): Promise<{ name?: string; os?: string; expiresAt: string; repairsMachine: { id: string; name: string } | null } | null>;
  /** Deletes the machine (its token stops working) and disconnects it. Throws `machine_not_found`. */
  revokeMachine(machineId: string, user: HubUser): Promise<void>;
  /**
   * Disconnects machines and stops serving. Never closes `store` (it is yours); closes the cluster
   * only when the hub created it (no `cluster` option).
   */
  close(): Promise<void>;
  /** @internal */
  readonly [HUB_INTERNALS]: HubInternalsHandle;
}
