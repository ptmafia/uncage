import type { JSX } from 'react';
import { useChatController, useRuntimeInfo, useUi } from '../context.js';
import { RuntimeSelector } from './RuntimeSelector.js';

/** No session yet: serif greeting, runtime choice and starter prompts (2-column grid). */
export function EmptyState(): JSX.Element {
  const { t } = useUi();
  const { runtimeId, setRuntimeId, starterPrompts, send } = useChatController();
  const { info, name } = useRuntimeInfo(runtimeId);
  const ready = info?.status === 'available';
  return (
    <div className="uc-empty">
      <h1 className="uc-empty-title">{t.startWith(name)}</h1>
      <RuntimeSelector {...(runtimeId !== undefined ? { value: runtimeId } : {})} onChange={setRuntimeId} />
      {starterPrompts.length > 0 && (
        <section className="uc-starters" aria-label={t.starterPrompts}>
          {starterPrompts.map((p) => (
            <button key={p} type="button" className="uc-starter" disabled={!ready} onClick={() => void send(p)}>
              {p}
            </button>
          ))}
        </section>
      )}
    </div>
  );
}
