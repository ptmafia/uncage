import type { ClusterAdapter } from './cluster.js';

/** In-process cluster for a single hub node (and tests running several hubs in one process). */
export function memoryCluster(): ClusterAdapter {
  const subs = new Map<string, Set<(msg: string) => void>>();
  const presence = new Map<string, { nodeId: string; expiresAt: number }>();
  return {
    async publish(channel, msg) {
      // Deliver asynchronously, like a real broker, so publishers never re-enter subscribers.
      for (const fn of [...(subs.get(channel) ?? [])]) queueMicrotask(() => fn(msg));
    },
    async subscribe(channel, fn) {
      let set = subs.get(channel);
      if (!set) subs.set(channel, (set = new Set()));
      const wrapped = (msg: string) => fn(msg);
      set.add(wrapped);
      return () => {
        set.delete(wrapped);
        if (set.size === 0 && subs.get(channel) === set) subs.delete(channel);
      };
    },
    async setPresence(machineId, nodeId, ttlSec) {
      presence.set(machineId, { nodeId, expiresAt: Date.now() + ttlSec * 1000 });
    },
    async getPresence(machineId) {
      const p = presence.get(machineId);
      if (!p) return null;
      if (p.expiresAt <= Date.now()) {
        presence.delete(machineId);
        return null;
      }
      return p.nodeId;
    },
    async clearPresence(machineId, nodeId) {
      if (presence.get(machineId)?.nodeId === nodeId) presence.delete(machineId);
    },
    async close() {
      subs.clear();
      presence.clear();
    },
  };
}
