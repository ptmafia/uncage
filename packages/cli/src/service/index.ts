import { launchdService } from './launchd.js';
import { noneService } from './none.js';
import { schtasksService } from './schtasks.js';
import { systemdService } from './systemd.js';
import type { AgentService, ServiceDeps, ServiceKind } from './types.js';

export type { AgentService, ServiceDeps, ServiceKind, ServiceSpec, ServiceStatus } from './types.js';
export { nodeMajor, probeNode, serviceSpec, servicePath } from './spec.js';
export { LAUNCHD_LABEL, launchctlInstallCommands, launchdPlist, launchdService, parsePlist, plistPath } from './launchd.js';
export { lingerEnabled, parseSystemdUnit, SYSTEMD_UNIT, systemdService, systemdUnit, systemdUnitPath } from './systemd.js';
export { parseTaskCsvStatus, parseTaskXml, RUN_KEY, runKeyCommand, schtasksService, TASK_NAME, taskXml, winQuote, winSplit } from './schtasks.js';
export { FOREGROUND_HINT, noneService } from './none.js';

/**
 * Which service manager runs the agent here: macOS launchd; Linux systemd iff
 * `systemctl --user show-environment` succeeds (a user manager is running), else none; Windows
 * Task Scheduler (the Run-key fallback is decided at install time); anything else none.
 */
export async function detectServiceKind(d: ServiceDeps): Promise<ServiceKind> {
  if (d.platform === 'darwin') return 'launchd';
  if (d.platform === 'win32') return 'schtasks';
  if (d.platform === 'linux') {
    try {
      await d.exec('systemctl', ['--user', 'show-environment']);
      return 'systemd';
    } catch {
      return 'none';
    }
  }
  return 'none';
}

/** The agent service for this computer. */
export async function agentService(d: ServiceDeps): Promise<AgentService> {
  switch (await detectServiceKind(d)) {
    case 'launchd':
      return launchdService(d);
    case 'systemd':
      return systemdService(d);
    case 'schtasks':
    case 'run-key':
      return schtasksService(d);
    default:
      return noneService();
  }
}
