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
  /** Defaults to `pgliteHubStore({ dataDir: './.uncage-hub' })`. */
  store?: HubStore;
  /** Defaults to `memoryCluster()` (single node). */
  cluster?: ClusterAdapter;
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
  /** Machine heartbeat: ping every `pingIntervalMs` (25 000), offline after `missedPings` (2) unanswered. */
  heartbeat?: { pingIntervalMs?: number; missedPings?: number };
  /** SSE comment heartbeat for browser event streams. Defaults to 15 000 ms. */
  sseHeartbeatMs?: number;
  /** How long a browser request waits for the machine. Defaults to 30 000 ms. */
  commandTimeoutMs?: number;
}

export interface Hub {
  /** Browser API, device endpoints and `install.sh`, all under `basePath`. */
  handler(req: Request): Promise<Response>;
  /** Accepts machine WebSockets on `server` at `path` (default `<basePath>/agent`). */
  attach(server: Server, opts?: { path?: string }): void;
  approveDevice(userCode: string, user: HubUser): Promise<'ok' | 'not_found' | 'expired'>;
  denyDevice(userCode: string, user: HubUser): Promise<'ok' | 'not_found' | 'expired'>;
  /** What the approve page shows about a pending code, or `null` if unknown / no longer pending. */
  lookupDevice(userCode: string): Promise<{ name?: string; os?: string; expiresAt: string } | null>;
  /** Deletes the machine (its token stops working) and disconnects it. Throws `machine_not_found`. */
  revokeMachine(machineId: string, user: HubUser): Promise<void>;
  close(): Promise<void>;
}
