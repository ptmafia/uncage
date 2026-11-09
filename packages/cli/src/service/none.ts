import type { AgentService, ServiceStatus } from './types.js';

export const FOREGROUND_HINT =
  'No per-user service manager here (systemd --user is not running), so the agent is not installed as a service. ' +
  'Run it in the foreground (e.g. in tmux or screen): uncage agent';

/** No service manager (e.g. Linux without a user systemd, containers, WSL1): the agent runs in the foreground. */
export function noneService(detail = FOREGROUND_HINT): AgentService {
  const status: ServiceStatus = {
    kind: 'none',
    installed: false,
    running: null,
    spec: null,
    nodeExists: null,
    nodeVersion: null,
    definitionPath: null,
    detail,
  };
  return {
    kind: 'none',
    install: async () => ({ definitionPath: '', notes: [detail] }),
    uninstall: async () => ({ removed: false }),
    restart: async () => false,
    status: async () => ({ ...status }),
  };
}
