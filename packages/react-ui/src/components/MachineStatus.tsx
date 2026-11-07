import type { MachineInfo } from '@uncage/protocol';
import { useMachines } from '@uncage/react';
import { ChevronDown } from 'lucide-react';
import { useRef, useState, type JSX } from 'react';
import { useUi } from '../context.js';
import { ConnectMachine } from './ConnectMachine.js';
import { Popover } from './composer/Popover.js';

const CONNECT_ID = '__connect__';

export interface MachineStatusProps {
  /**
   * Called after a computer is picked, or connected from "Connect another computer…" (it is
   * already selected for new sessions). `<AgentChat>` opens a new draft when it differs from the
   * open session's computer.
   */
  onSelect?(machine: MachineInfo): void;
}

/**
 * Connected mode: the computer the conversation runs on (online dot + name) as a menu button.
 * The menu lists the user's computers with their status and "Connect another computer…", which
 * opens `<ConnectMachine>`. Renders nothing outside connected mode.
 */
export function MachineStatus({ onSelect }: MachineStatusProps): JSX.Element | null {
  const { t } = useUi();
  const { connected, machines, current, select } = useMachines();
  const [connecting, setConnecting] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  if (!connected) return null;
  const now = Date.now();
  const status = (m: MachineInfo) => (m.online ? t.machineOnline : t.machineOffline(t.ago(now - Date.parse(m.lastSeenAt))));
  const name = current?.name ?? t.machineLabel;
  const online = current?.online === true;
  return (
    <>
      <Popover
        label={t.machinePicker}
        triggerLabel={t.machineStatus(name, online)}
        triggerClassName="uc-machine-trigger"
        triggerRef={triggerRef}
        align="end"
        side="bottom"
        trigger={
          <>
            <span className="uc-machine-dot" data-online={online || undefined} aria-hidden />
            <span className="uc-machine-name">{name}</span>
            <ChevronDown className="uc-tool-chevron" aria-hidden />
          </>
        }
        items={[
          ...machines.map((m) => ({
            id: m.id,
            label: m.name,
            description: `${t.osName(m.os)} · ${status(m)}`,
            checked: m.id === current?.id,
          })),
          { id: CONNECT_ID, label: t.connectAnother, action: true },
        ]}
        onSelect={(id) => {
          if (id === CONNECT_ID) {
            setConnecting(true);
            return;
          }
          const m = machines.find((x) => x.id === id);
          if (!m) return;
          select(id);
          onSelect?.(m);
        }}
      />
      {connecting && <ConnectMachine onClose={() => setConnecting(false)} onConnected={(m) => onSelect?.(m)} />}
    </>
  );
}
