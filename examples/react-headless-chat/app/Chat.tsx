'use client';

import type { ApprovalRequest, Run } from '@uncage/protocol';
import {
  useApprovalActions,
  useApprovals,
  useMessages,
  useRun,
  useRuntimes,
  useSession,
  useSessions,
  useUncageError,
} from '@uncage/react';
import { useEffect, useState, type FormEvent, type KeyboardEvent } from 'react';

const RUN_LABEL: Record<Run['state'], string> = {
  queued: '正在启动…',
  running: '运行中…',
  waiting_approval: '等你确认…',
  completed: '完成',
  failed: '没成功，可以重新发送。',
  cancelled: '已停止：你取消了这次运行。',
  interrupted: '已中断：运行时停止了。可以重新发送。',
};

const RESOLVED_LABEL: Partial<Record<ApprovalRequest['state'], (a: ApprovalRequest) => string>> = {
  approved: () => '已允许',
  denied: (a) => `没继续：你拒绝了「${a.title}」`,
  expired: () => '确认已过期',
  cancelled: () => '已取消',
};

/** Opens `?session=<id>` on load and mirrors the open session into the URL (reload-safe). */
function useSessionInUrl(): void {
  const { activeSessionId, select } = useSessions();
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('session');
    if (id) void select(id);
  }, [select]);
  useEffect(() => {
    if (activeSessionId === undefined) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get('session') === activeSessionId) return;
    url.searchParams.set('session', activeSessionId);
    window.history.replaceState(null, '', url);
  }, [activeSessionId]);
}

function Approval({ approval }: { approval: ApprovalRequest }) {
  const { decide, pending } = useApprovalActions();
  const resolved = RESOLVED_LABEL[approval.state];
  if (resolved) {
    return (
      <p className="approval-line" data-state={approval.state}>
        {resolved(approval)}
      </p>
    );
  }
  const busy = pending[approval.id] !== undefined || approval.state !== 'pending';
  return (
    <section className="approval-card" data-state={approval.state} aria-label={`需要你确认：${approval.title}`}>
      <strong>需要你确认：{approval.title}</strong>
      {approval.target.command !== undefined && <pre>{approval.target.command}</pre>}
      {approval.description && <p>{approval.description}</p>}
      <div className="approval-actions">
        <button type="button" disabled={busy} onClick={() => void decide(approval.id, 'deny')}>
          拒绝
        </button>
        <button type="button" className="primary" disabled={busy} onClick={() => void decide(approval.id, 'allow')}>
          允许执行
        </button>
      </div>
    </section>
  );
}

/** A complete chat built only from `@uncage/react` hooks, with its own markup and plain CSS. */
export function Chat() {
  useSessionInUrl();
  const { runtimes } = useRuntimes();
  const { activeSessionId, create, select } = useSessions();
  const { session } = useSession();
  const { run, isActive, send, cancel } = useRun();
  const { timeline, messages, tools } = useMessages();
  const { all: approvals } = useApprovals();
  const { error, dismiss } = useUncageError();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  const runtime = runtimes.find((r) => r.status === 'available');
  const loading = activeSessionId !== undefined && session === undefined;
  const canSend = !loading && !isActive && !sending && text.trim() !== '' && (session !== undefined || runtime !== undefined);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!canSend) return;
    setSending(true);
    try {
      // No session yet: the first prompt creates one with the first available runtime.
      if (session === undefined && runtime) await select(await create({ runtime: runtime.id }));
      if (await send(text.trim())) setText('');
    } catch {
      // Recorded in the store's lastError and shown below.
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    void submit();
  };

  const approvalsById = new Map(approvals.map((a) => [a.id, a]));

  return (
    <main className="chat">
      <header>
        <h1>Uncage headless chat</h1>
        <span className="muted">{session ? session.runtimeId : (runtime?.displayName ?? '没有可用的运行时')}</span>
      </header>

      <div className="timeline" role="log" aria-label="对话">
        {timeline.map((item) => {
          if (item.kind === 'message') {
            const m = messages[item.id];
            if (!m) return null;
            return (
              <div key={item.id} className={m.role === 'user' ? 'msg-user' : 'msg-assistant'} data-streaming={m.streaming || undefined}>
                {m.text}
              </div>
            );
          }
          if (item.kind === 'tools') {
            return (
              <ul key={`tools-${item.runId}-${item.toolIds[0]}`} className="tools">
                {item.toolIds.map((id) => {
                  const t = tools[id];
                  return t ? (
                    <li key={id} className="tool" data-status={t.status}>
                      {t.title} · {t.status}
                    </li>
                  ) : null;
                })}
              </ul>
            );
          }
          const a = approvalsById.get(item.id);
          return a ? <Approval key={item.id} approval={a} /> : null;
        })}
      </div>

      {error && (
        <div className="error" role="alert">
          {error.message} {error.hint}
          <button type="button" onClick={dismiss}>
            关闭
          </button>
        </div>
      )}

      {run && (
        <p className="run-status" data-state={run.state} role="status">
          {RUN_LABEL[run.state]}
        </p>
      )}

      <form className="composer" onSubmit={(e) => void submit(e)}>
        <textarea
          aria-label="消息"
          rows={2}
          placeholder="输入消息，Enter 发送"
          value={text}
          disabled={loading}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {isActive ? (
          <button type="button" onClick={() => void cancel()}>
            停止
          </button>
        ) : (
          <button type="submit" className="primary" disabled={!canSend}>
            发送
          </button>
        )}
      </form>
    </main>
  );
}
