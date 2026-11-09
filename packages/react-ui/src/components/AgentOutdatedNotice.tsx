import type { MachineInfo } from '@uncage/protocol';
import { useMachines } from '@uncage/react';
import { CircleArrowUp } from 'lucide-react';
import { Fragment, useEffect, type JSX } from 'react';
import { useUi } from '../context.js';

/** Shown until the site's setup command has loaded (`GET /machines/install`). */
const SETUP_FALLBACK = 'uncage setup';

/** Renders `a \`cmd\` b` with the backticked parts as inline code. */
function withCode(text: string): JSX.Element[] {
  return text.split('`').map((part, i) =>
    i % 2 === 1 ? (
      <code key={i} className="uc-inline-code">
        {part}
      </code>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

/**
 * Connected mode: `machine`'s agent was refused by the hub as too old (`MachineInfo.agentOutdated`,
 * e.g. a 0.2 agent, which cannot connect to a 0.3 hub). Tells the user to upgrade the CLI on that
 * computer (`npm i -g @uncage/cli@latest`) and reconnect with this site's `uncage setup <url>`.
 * Renders nothing for an up-to-date computer. `<AgentChat>` shows it above the composer for the
 * conversation's computer.
 */
export function AgentOutdatedNotice({ machine }: { machine: MachineInfo }): JSX.Element | null {
  const { t } = useUi();
  const { install, loadInstallInfo } = useMachines();
  const outdated = machine.agentOutdated;
  useEffect(() => {
    if (outdated) void loadInstallInfo();
  }, [outdated, loadInstallInfo]);
  if (!outdated) return null;
  return (
    <div className="uc-banner uc-agent-outdated" data-tone="warn" role="status">
      <CircleArrowUp aria-hidden />
      <span className="uc-banner-text">{withCode(t.agentOutdated(install?.setup ?? SETUP_FALLBACK))}</span>
    </div>
  );
}
