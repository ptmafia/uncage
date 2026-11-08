/**
 * Node-routed ids: the reply to a command, file pull or upload goes to the hub node encoded in its
 * id, so whichever node receives the machine's answer can route it without shared state.
 */
import { randomHex } from './web.js';

const NODE_ID = /^node_[0-9a-f]{16}$/;
const ROUTED = /^(?:cmd|pull|upl)_(node_[0-9a-f]{16})_[0-9a-f]{24}$/;

/**
 * A hub node id: `node_` + 16 random hex (64 bits from `crypto.getRandomValues`), new for every
 * hub instance — never derived from hostname or pid, so FaaS instances on one host never collide
 * (the maintenance lease and routed ids rely on that).
 */
export function newNodeId(): string {
  return `node_${randomHex(8)}`;
}

/** `${prefix}_${nodeId}_${24 hex}`. */
export function routedId(prefix: 'cmd' | 'pull' | 'upl', nodeId: string): string {
  if (!NODE_ID.test(nodeId)) throw new Error(`routedId: invalid node id "${nodeId}"`);
  return `${prefix}_${nodeId}_${randomHex(12)}`;
}

/** The node an id routes to, or `null` when it is not a routed id. */
export function routeOf(id: string): string | null {
  return ROUTED.exec(id)?.[1] ?? null;
}
