import type { ToolView } from '@uncage/react';
import { useApprovals, useMessages, useRun, useStoreSelector } from '@uncage/react';
import type { Run } from '@uncage/protocol';
import type { JSX } from 'react';
import { useNow, useUi } from '../context.js';
import { ApprovalCard as DefaultApprovalCard } from './ApprovalCard.js';
import { AssistantMessage as DefaultAssistantMessage, Byline } from './AssistantMessage.js';
import { ToolSteps as DefaultToolSteps } from './ToolSteps.js';
import { UserMessage as DefaultUserMessage } from './UserMessage.js';

const ACTIVE: ReadonlySet<Run['state']> = new Set(['queued', 'running', 'waiting_approval']);

/** "Thinking…" byline for the active run while nothing else shows that it is working. */
function ThinkingLine({ run }: { run: Run }): JSX.Element {
  const { t } = useUi();
  const now = useNow(true);
  return <Byline live status={t.thinking} elapsed={t.elapsed(now - Date.parse(run.startedAt ?? run.createdAt))} />;
}

/**
 * The conversation timeline: user bubbles, assistant answers, tool steps between them and
 * approval cards, in event order. Uses `components` overrides from `<AgentChat>`.
 */
export function MessageList(): JSX.Element {
  const { t, showTools, components } = useUi();
  const { timeline, messages, tools } = useMessages();
  const { all, pending } = useApprovals();
  const { run: latest, isActive } = useRun();
  const runs = useStoreSelector((s) => s.active?.runs);
  const UserMessage = components.UserMessage ?? DefaultUserMessage;
  const AssistantMessage = components.AssistantMessage ?? DefaultAssistantMessage;
  const ToolSteps = components.ToolSteps ?? DefaultToolSteps;
  const ApprovalCard = components.ApprovalCard ?? DefaultApprovalCard;

  const last = timeline.at(-1);
  const lastMessage = last?.kind === 'message' ? messages[last.id] : undefined;
  const thinking =
    latest !== undefined &&
    isActive &&
    latest.state !== 'waiting_approval' &&
    !pending.some((a) => a.runId === latest.id) &&
    !(lastMessage?.role === 'assistant' && lastMessage.streaming) &&
    !Object.values(tools).some((x) => x.runId === latest.id && x.status === 'running');

  return (
    <div className="uc-messages" role="log" aria-live="polite" aria-label={t.messagesLabel}>
      {timeline.map((item) => {
        if (item.kind === 'message') {
          const m = messages[item.id];
          if (!m) return null;
          return m.role === 'user' ? <UserMessage key={item.id} message={m} /> : <AssistantMessage key={item.id} message={m} />;
        }
        if (item.kind === 'tools') {
          if (!showTools) return null;
          const list = item.toolIds.map((id) => tools[id]).filter((x): x is ToolView => x !== undefined);
          if (list.length === 0) return null;
          const run = runs?.[item.runId];
          return (
            <ToolSteps
              key={`tools:${item.runId}:${item.toolIds[0]}`}
              tools={list}
              running={run !== undefined && ACTIVE.has(run.state)}
            />
          );
        }
        const a = all.find((x) => x.id === item.id);
        return a ? <ApprovalCard key={item.id} approval={a} /> : null;
      })}
      {thinking && <ThinkingLine key={`thinking:${latest.id}`} run={latest} />}
    </div>
  );
}
