/**
 * Cross-node messaging and machine presence. A machine's WebSocket lives on exactly one hub node;
 * browser requests may land on any node, so commands and events travel over the cluster.
 * `memoryCluster()` is the single-process default; multi-node deployments use a shared one (Redis).
 */
export interface ClusterAdapter {
  publish(channel: string, msg: string): Promise<void>;
  /** Resolves an unsubscribe function once the subscription is active. */
  subscribe(channel: string, fn: (msg: string) => void): Promise<() => void>;
  /** Records that `machineId` is connected to `nodeId`; expires after `ttlSec` unless refreshed. */
  setPresence(machineId: string, nodeId: string, ttlSec: number): Promise<void>;
  /** The node holding the machine's connection, or `null` when it is offline. */
  getPresence(machineId: string): Promise<string | null>;
  /** Removes the presence entry if (and only if) it still points at `nodeId`. */
  clearPresence(machineId: string, nodeId: string): Promise<void>;
  close(): Promise<void>;
}
