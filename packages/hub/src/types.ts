import type { Server } from 'node:http';
import type { SkillSpec } from '@uncage/protocol';
import type { ClusterAdapter } from './cluster/cluster.js';
import type { HubStore } from './store/store.js';
import type { SiteTool } from './tools.js';

export interface HubUser {
  id: string;
  name?: string;
}

export interface HubOptions {
  /** The website's public origin, e.g. `https://app.example.com`. */
  publicUrl: string;
  /** Where `handler` is mounted. Defaults to `/api/uncage`. */
  basePath?: string;
  /** Website auth: the signed-in user for a browser request, or `null`. */
  getUser(req: Request): Promise<HubUser | null>;
  /**
   * Defaults to `pgliteHubStore({ dataDir: './.uncage-hub' })` (single node). Several nodes share
   * one `postgresHubStore`.
   */
  store?: HubStore;
  /** Defaults to `memoryCluster()` (single node). Several nodes share one `redisCluster`. */
  cluster?: ClusterAdapter;
  /**
   * Site tools (`defineTool`) offered to runs as MCP tools. They execute on the hub node holding
   * the machine's connection, as the session's owner; every call is audited in the store
   * (`listToolCalls`) and shows in the session's events as the runtime's `tool.*` events.
   */
  tools?: SiteTool[];
  skills?: SkillSpec[];
  /** Picks the tools and skills (by name) offered to a run. Defaults to all. */
  selectManifest?(ctx: { user: HubUser; prompt: string; sessionId: string }): Promise<{ tools: string[]; skills: string[] }>;
  /**
   * `'machine'` (default): session history lives only on the machine (offline machine → no history).
   * `'site'`: the hub keeps a replica of every session's events and snapshot, readable while the
   * machine is offline.
   */
  sessionStorage?: 'machine' | 'site';
  /** Agents older than this are told to upgrade. Defaults to this package's version. */
  minAgentVersion?: string;
  /** `install.sh` installs `@uncage/cli@<range>`. Defaults to `^<major.minor>` of this package. */
  cliVersionRange?: string;
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
     * passed to `handler` (`toNodeHandler` passes Express's `req.ip`, which honours `trust proxy`,
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

export interface Hub {
  /** Normalized mount path, e.g. `/api/uncage`. */
  readonly basePath: string;
  /**
   * Browser API, device endpoints and `install.sh`, all under `basePath`. Pass `info.clientIp`
   * (the socket address) when known; `toNodeHandler` does.
   */
  handler(req: Request, info?: { clientIp?: string }): Promise<Response>;
  /** Accepts machine WebSockets on `server` at `path` (default `<basePath>/agent`). */
  attach(server: Server, opts?: { path?: string }): void;
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
  close(): Promise<void>;
}
