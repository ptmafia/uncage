import type { RuntimeInfo, RuntimeStatus } from '@uncage/protocol';
import { useRuntimes } from '@uncage/react';
import { ExternalLink } from 'lucide-react';
import { useId, useState, type JSX } from 'react';
import { useUi } from '../context.js';

const TONE: Record<RuntimeStatus, 'ok' | 'neutral' | 'warn' | 'err'> = {
  available: 'ok',
  not_installed: 'neutral',
  auth_required: 'warn',
  incompatible: 'warn',
  error: 'err',
};

/** The id a new session should use: `preferred` if listed, else the first available runtime. */
export function pickRuntime(runtimes: RuntimeInfo[], preferred?: string): string | undefined {
  if (preferred !== undefined && runtimes.some((r) => r.id === preferred)) return preferred;
  return (runtimes.find((r) => r.status === 'available') ?? runtimes[0])?.id;
}

export interface RuntimeSelectorProps {
  /** Selected runtime id (controlled). */
  value?: string;
  onChange?(id: string): void;
}

/**
 * Choose the runtime for the next new session. Every runtime is listed with a status pill;
 * unavailable ones are disabled and explain why (message, hint, install link).
 */
export function RuntimeSelector({ value, onChange }: RuntimeSelectorProps): JSX.Element {
  const { t } = useUi();
  const { runtimes, loading } = useRuntimes();
  const name = useId();
  const [own, setOwn] = useState<string>();
  const selected = value ?? own ?? pickRuntime(runtimes);

  if (runtimes.length === 0) {
    return <p className="uc-runtimes-empty">{loading ? '' : t.noRuntimes}</p>;
  }
  return (
    <fieldset className="uc-runtimes">
      <legend className="uc-sr-only">{t.runtimeLabel}</legend>
      {runtimes.map((r) => {
        const available = r.status === 'available';
        const helpId = `${name}-${r.id}-help`;
        const install = r.installUrl && /^https?:\/\//i.test(r.installUrl) ? r.installUrl : undefined;
        const help = !available && (r.message || r.hint || install);
        return (
          <div key={r.id} className="uc-runtime" data-checked={selected === r.id || undefined} data-disabled={!available || undefined}>
            <label className="uc-runtime-main">
              <input
                type="radio"
                className="uc-radio"
                name={name}
                value={r.id}
                checked={selected === r.id}
                disabled={!available}
                {...(help ? { 'aria-describedby': helpId } : {})}
                onChange={() => {
                  setOwn(r.id);
                  onChange?.(r.id);
                }}
              />
              <span className="uc-runtime-name">{r.displayName}</span>
              {r.version && <span className="uc-runtime-version">{r.version}</span>}
              <span className="uc-pill" data-tone={TONE[r.status]}>
                {t.runtimeStatus[r.status]}
              </span>
            </label>
            {help && (
              <div id={helpId} className="uc-runtime-help">
                {r.message && <p>{r.message}</p>}
                {r.hint && <p>{r.hint}</p>}
                {install && (
                  <a href={install} target="_blank" rel="noopener noreferrer">
                    {t.installGuide}
                    <ExternalLink aria-hidden />
                  </a>
                )}
              </div>
            )}
          </div>
        );
      })}
    </fieldset>
  );
}
