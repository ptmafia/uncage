import { useSessionSettings } from '@uncage/react';
import type { EffortLevel } from '@uncage/protocol';
import { Brain, ChevronDown } from 'lucide-react';
import type { JSX } from 'react';
import { useUi } from '../../context.js';
import { Popover } from './Popover.js';

/** Reasoning effort picker (brain icon). Hidden when the runtime offers no effort levels. */
export function EffortMenu({ disabled = false }: { disabled?: boolean }): JSX.Element | null {
  const { t } = useUi();
  const { settings, capabilities, update, pendingForNextRun } = useSessionSettings();
  const efforts = capabilities?.efforts ?? [];
  if (efforts.length === 0) return null;
  const current = settings.effort;
  const label = current ? t.efforts[current] : t.effortTitle;
  return (
    <Popover
      label={t.effortTitle}
      triggerLabel={t.labelled(t.effortTitle, current ? t.efforts[current] : t.defaultOption)}
      trigger={
        <>
          <Brain aria-hidden />
          <span className="uc-tool-label">{label}</span>
          <ChevronDown className="uc-tool-chevron" aria-hidden />
        </>
      }
      disabled={disabled}
      items={efforts.map((e) => ({ id: e, label: t.efforts[e], description: t.effortHints[e], checked: e === current }))}
      onSelect={(id) => {
        if (id !== current) void update({ effort: id as EffortLevel });
      }}
      {...(pendingForNextRun ? { footnote: t.appliesNextRun } : {})}
    />
  );
}
