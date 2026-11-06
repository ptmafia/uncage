import { useSessionSettings } from '@uncage/react';
import { ChevronDown, Sparkles } from 'lucide-react';
import type { JSX } from 'react';
import { useUi } from '../../context.js';
import { Popover } from './Popover.js';

/** Model picker (sparkle icon). Hidden when the runtime lists no models. */
export function ModelMenu({ disabled = false }: { disabled?: boolean }): JSX.Element | null {
  const { t } = useUi();
  const { settings, capabilities, update, pendingForNextRun } = useSessionSettings();
  const models = capabilities?.models ?? [];
  if (models.length === 0) return null;
  // No stored model: the runtime's default, shown as its `default` entry when it lists one.
  const currentId = settings.model ?? (models.some((m) => m.id === 'default') ? 'default' : undefined);
  const label = models.find((m) => m.id === currentId)?.label ?? settings.model ?? t.defaultOption;
  return (
    <Popover
      label={t.modelTitle}
      triggerLabel={t.labelled(t.modelTitle, label)}
      trigger={
        <>
          <Sparkles aria-hidden />
          <span className="uc-tool-label">{label}</span>
          <ChevronDown className="uc-tool-chevron" aria-hidden />
        </>
      }
      disabled={disabled}
      items={models.map((m) => ({
        id: m.id,
        label: m.label,
        ...(m.description ? { description: m.description } : {}),
        checked: m.id === currentId,
      }))}
      onSelect={(id) => {
        if (id !== currentId) void update({ model: id });
      }}
      {...(pendingForNextRun ? { footnote: t.appliesNextRun } : {})}
    />
  );
}
