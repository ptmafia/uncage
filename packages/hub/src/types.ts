import type { SkillSpec, TransportKind } from '@uncage/protocol';
import type { OnAttention } from './attention.js';
import type { ClusterAdapter } from './cluster/cluster.js';
import type { InstallScriptExtension } from './install/render.js';
import type { HubLogger, MachineHub } from './machines.js';
import type { MaintenanceReport } from './maintenance.js';
import type { HubStore } from './store/store.js';
import type { SiteTool } from './tools.js';

export interface HubUser {
  id: string;
  name?: string;
}

export interface HubOptions {
  /**
   * The website's public origin, e.g. `https://app.example.com`. It is embedded in install.sh and install.ps1 for
   * `uncage setup`, so it must be https (plain http only for localhost / 127.0.0.1 / [::1]) with no
   * IPv6 literal other than `[::1]`: `createHub` refuses a plain-http LAN address.
   */
  publicUrl: string;
  /** Where `fetch` is mounted. Defaults to `/api/uncage`. */
  basePath?: string;
  /**
   * Website auth: the signed-in user for a browser request, or `null`. Native apps send their own
   * credentials (e.g. `Authorization: Bearer …`) and no `Origin`; `getUser` reads whichever it trusts.
   */
  getUser(req: Request): Promise<HubUser | null>;
  /**
   * Extra origins allowed past the cross-site guard on state-changing requests, e.g. your browser
   * extension `chrome-extension://<id>`. Only origins you control: exact `scheme://host[:port]`
   * strings (no wildcards, paths, credentials or trailing slash); https, browser-extension schemes,
   * or plain http on localhost / 127.0.0.1 / [::1] only. Checked by `createHub`.
   */
  trustedOrigins?: string[];
  /**
   * Required. `pgliteHubStore({ dataDir })` from `@uncage/hub/node` for a single Node process;
   * `postgresHubStore` (or `sqlHubStore` on any SQL client) for several nodes or serverless
   * platforms. The hub never closes it: close it yourself after `hub.close()`.
   */
  store: HubStore;
  /**
   * Defaults to `memoryCluster()` (one process). Several nodes, or FaaS function instances, share one
   * `postgresCluster` (the FaaS default) or `redisCluster`; without one, presence and command replies
   * stay inside each instance.
   */
  cluster?: ClusterAdapter;
  /**
   * Site tools (`defineTool`) offered to runs as MCP tools. They execute as the session's owner on
   * the hub instance that receives the call: over WebSocket the node holding the machine's socket,
   * over HTTP whichever instance gets the agent's POST. Every call is audited in the store
   * (`listToolCalls`) and shows in the session's events as the runtime's `tool.*` events.
   */
  tools?: SiteTool[];
  skills?: SkillSpec[];
  /**
   * Picks the tools and skills (by name) offered to a run. Defaults to all. `runtime` is the
   * session's runtime id (`claude`, `codex`, …). Whatever you pick, tools are dropped for a
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
   * Days the hub keeps attachment bytes sent through the website (maintenance deletes older ones,
   * at most every `maintenance.intervalMs`; the machine keeps its own copy). Default 30. `Infinity`
   * keeps them until the machine is revoked.
   */
  attachmentRetentionDays?: number;
  /**
   * Agents older than this are told to upgrade. Defaults to `MIN_AGENT_VERSION` from
   * `@uncage/protocol` (0.3.0), the oldest agent this hub's protocol works with, so a hub patch
   * release never locks out agents of the same minor.
   */
  minAgentVersion?: string;
  /** `install.sh` and `install.ps1` install `@uncage/cli@<range>`. Defaults to `^<major.minor>` of this package. */
  cliVersionRange?: string;
  /**
   * Extends the installers served at `install.sh` and `install.ps1`: a step run after the CLI
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
  /**
   * Transports offered to agents (device token and `GET <basePath>/agent/info`). Default: `http`
   * (the HTTP streaming transport, served by `fetch` on any platform), plus `ws` first when
   * `attachWebSocket` runs in this process. List `ws` when WebSockets are served by another
   * process at `<basePath>/agent`; leave `http` out to offer WebSockets only.
   */
  transports?: TransportKind[];
  /**
   * Long-lived responses end on the server's initiative after `maxDurationMs` (default 250 000)
   * and the client reconnects at once: the agent's HTTP stream (a `rotate` line) and browser event
   * streams (an `event: reconnect` frame; `@uncage/client` resumes with Last-Event-ID, without a
   * gap, a duplicate or a state change). Keep it below your platform's function duration limit
   * (e.g. Vercel `maxDuration`).
   */
  stream?: { maxDurationMs?: number };
  /**
   * How often an agent's HTTP stream polls the machine's outbox: every `activeMs` (300) while
   * something was delivered within `activeWindowMs` (30 000) or the machine reports work in flight,
   * otherwise backing off (doubling) to `idleMs` (2 000). A command written by another instance
   * wakes the stream at once through the cluster.
   */
  polling?: { activeMs?: number; idleMs?: number; activeWindowMs?: number };
  /**
   * A request body that stalls (no bytes arrive) for this long is refused with 400 (an idle timeout,
   * re-armed on every chunk, so a large upload on a slow link still gets through). A body is also
   * refused once it has taken 4 × this long in total. Defaults to 30 000 ms.
   */
  bodyTimeoutMs?: number;
  /**
   * Where the hub reports warnings (e.g. no client IP for per-IP rate limits, events for an unknown
   * session) and errors (a request that failed with 500, maintenance failures, a tool result that
   * could not be stored). Defaults to the console (`console.warn` / `console.error`, prefixed
   * `[uncage]`). Pass your own (pino and most loggers fit) or `{ warn() {}, error() {} }` to silence it.
   */
  logger?: HubLogger;
  /**
   * Called when a user's computer needs them or finished something: an approval was requested, a
   * run completed or failed (e.g. to send a push notification; `expoPushNotifier` is one). Fired
   * once per event after the hub accepted it, in both `sessionStorage` modes, however often the
   * agent resends it and however many hub nodes see it (deduped through `store.claimOnce`, kept a
   * day; a custom store without it gets per-node in-memory dedupe, best effort). Not fired for
   * events older than 10 minutes (an agent backfilling after a reconnect) nor, in `'site'` mode,
   * for an approval the stored snapshot already shows answered. "Older" compares the event's time
   * from the computer's clock with this hub's clock: keep both within a few minutes (NTP); a
   * computer whose clock is over 10 minutes behind never notifies (the hub logs a warning, at most
   * hourly per machine). Never blocks or fails ingest: errors (thrown or rejected) go to
   * `logger.error`. Delivery is at most once: if your handler fails, the event is not retried. When `hub.fetch` got `info.waitUntil` the
   * call runs under it, and `ctx.waitUntil` hands further work to the same request context.
   */
  onAttention?: OnAttention;
  /** SSE comment heartbeat for browser event streams. Defaults to 15 000 ms. */
  sseHeartbeatMs?: number;
  /** How long a browser request waits for the machine. Defaults to 30 000 ms. */
  commandTimeoutMs?: number;
  /**
   * A site tool handler still running after this fails with `tool_failed`. Defaults to 120 000 ms.
   * Keep it below your platform's function duration limit: a call whose instance is stopped mid-handler
   * fails with "Site tool "<name>" timed out on the website. Please try again." (it is never re-run).
   *
   * Over HTTP a tool call is handled during the agent's upstream POST. When `hub.fetch` gets
   * `info.waitUntil`, the handler runs under it, so a dropped POST does not cancel it even on runtimes
   * that cancel a request's work when the client disconnects (Cloudflare Workers): its result is stored
   * and the agent's resend gets it (exactly-once). Pass it there (`ctx.waitUntil.bind(ctx)`; Next's
   * `after`). Without `waitUntil` such a runtime may stop the handler with the POST, and the call is
   * at-most-once (the interrupted error). The platform's own `waitUntil` limit still applies: Workers
   * keep `waitUntil` work alive only about 30 s after the client went away, so on Workers keep
   * handlers well under ~30 s (help site: Deploy → Cloudflare Workers → FAQ).
   */
  toolTimeoutMs?: number;
  /**
   * `hub.close()` lets site tool handlers still running finish for up to this long, then aborts
   * them (they fail with the "timed out on the website" error). Defaults to 5 000 ms.
   */
  toolDrainMs?: number;
  /**
   * Site tool calls one machine may have executing at once on one hub instance. Further calls fail at
   * once with `tool_failed` (`details.reason: 'too_many_concurrent'`). Defaults to 8.
   */
  maxConcurrentToolCalls?: number;
  /**
   * Abuse limits, counted in the store (fixed windows), so every hub instance — several nodes or
   * FaaS function instances — shares one count. Exceeding one → 429 `rate_limited`.
   *
   * Per-IP limits need the client IP. FaaS deployments must supply it (pass `info.clientIp` to
   * `fetch`, set `clientIp`, or `trustForwardedFor: true` where the platform appends the client to
   * X-Forwarded-For, as Vercel does); without one every caller shares a single bucket, so one client
   * can use up `deviceCodesPerMinute` for everyone (the hub logs a warning once).
   */
  rateLimits?: {
    /** `POST /device/code` per client IP per minute. Default 20. */
    deviceCodesPerMinute?: number;
    /** Failed `approveDevice` / `denyDevice` / `lookupDevice` attempts (unknown codes) per user per window. Default 10. */
    userCodeFailures?: number;
    /**
     * Requests to the agent routes (`<basePath>/agent/*`) with a missing or wrong machine token,
     * per client IP per minute. Default 60. Valid tokens are never limited.
     */
    agentAuthFailuresPerMinute?: number;
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
  /**
   * Retention (old run manifests, attachment copies, expired outbox items, finished inbox rows,
   * old rate-limit windows, expired device codes), and failing site tool calls whose instance died
   * mid-handler (their lease, `toolTimeoutMs` + 10 s, ran out: the machine gets the "timed out on
   * the website" error; reported as `interruptedToolCalls`), and dropping stored tool results a
   * day after their call finished (the audit row and status stay; a resend that late gets a
   * generic "already finished" error). It runs at most once per `intervalMs` across
   * every instance (a store lease): `attachWebSocket` runs it on a timer in a long-running process;
   * otherwise requests trigger it (in the background through `info.waitUntil` when the platform
   * provides it). A platform cron can also call `GET|POST <basePath>/maintenance`.
   *
   * Retention: unbound run manifests (startRun never answered) 1 h, bound ones 7 days; hub copies
   * of attachments `attachmentRetentionDays` (30); finished upstream-dedupe (inbox) rows 24 h
   * (beyond any agent resend window); outbox items when they expire; rate-limit windows once older
   * than the longest window (`userCodeWindowMs`, at least 60 s); device codes an hour after expiry;
   * `onAttention` dedupe claims once expired (a day).
   */
  maintenance?: {
    /** Default 60 000 ms. */
    intervalMs?: number;
    /**
     * Enables `GET|POST <basePath>/maintenance` with `Authorization: Bearer <secret>` (what Vercel
     * Cron sends with `CRON_SECRET`). Without it the endpoint is a 404.
     */
    secret?: string;
    /** Your own cleanup, called after each maintenance run. */
    onRun?(): Promise<void>;
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
  /** The WebSocket server was detached: stop offering `ws` (unless `HubOptions.transports` lists it). */
  disableWebSocket(): void;
  /** Machine heartbeat for WebSocket links. */
  heartbeat: { pingIntervalMs: number; missedPings: number };
  /** Maintenance interval: a long-running process calls `hub.maintain()` this often. */
  maintenance: { intervalMs: number };
  /**
   * Counts one failed machine-token check for the caller (the same `agent_auth` limit as the HTTP
   * agent routes); throws `rate_limited` once over it.
   */
  agentAuthFailed(req: Request, info?: { clientIp?: string }): Promise<void>;
  /** No `cluster` option: presence and command replies stay inside this instance (`memoryCluster`). */
  defaultCluster: boolean;
}

export interface Hub {
  /** Normalized mount path, e.g. `/api/uncage`. */
  readonly basePath: string;
  /**
   * Browser API, device endpoints, `install.sh` and `install.ps1`, and the agents' HTTP streaming
   * transport (`<basePath>/agent/*`), all under `basePath`, as a Fetch handler.
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
  /**
   * Runs maintenance now unless another instance holds the maintenance lease or the hub is closed
   * (`ran: false`). You rarely need it: see `HubOptions.maintenance`.
   */
  maintain(): Promise<MaintenanceReport>;
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
