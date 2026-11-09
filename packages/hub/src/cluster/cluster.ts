/**
 * Cross-instance messaging and machine presence. A machine's connection lives on one hub instance
 * (a WebSocket's node, or the instance serving its HTTP stream); browser requests may land on any
 * instance, so commands, wake-ups and events travel over the cluster. `memoryCluster()` is the
 * single-process default; several nodes or FaaS instances share `postgresCluster` or `redisCluster`.
 */
export interface ClusterAdapter {
  publish(channel: string, msg: string): Promise<void>;
  /** Resolves an unsubscribe function once the subscription is active. */
  subscribe(channel: string, fn: (msg: string) => void): Promise<() => void>;
  /** Records that `machineId` is connected to `nodeId`; expires after `ttlSec` unless refreshed. */
  setPresence(machineId: string, nodeId: string, ttlSec: number): Promise<void>;
  /**
   * Like `setPresence`, but only when the machine has no live presence or it already is `nodeId`;
   * resolves whether it was set. Atomic. Optional (the hub falls back to a check-then-set):
   * `memoryCluster`, `redisCluster` and `postgresCluster` implement it.
   */
  refreshPresence?(machineId: string, nodeId: string, ttlSec: number): Promise<boolean>;
  /** The node holding the machine's connection, or `null` when it is offline. */
  getPresence(machineId: string): Promise<string | null>;
  /** Removes the presence entry if (and only if) it still points at `nodeId`. */
  clearPresence(machineId: string, nodeId: string): Promise<void>;
  close(): Promise<void>;
}
