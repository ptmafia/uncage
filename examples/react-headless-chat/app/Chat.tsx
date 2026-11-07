'use client';

import type { ApprovalRequest, Attachment, EffortLevel, PermissionMode, Run } from '@uncage/protocol';
import {
  isDraft,
  useApprovalActions,
  useApprovals,
  useAttachments,
  useAttachmentUrl,
  useMessages,
  useRun,
  useRuntimes,
  useSession,
  useSessions,
  useSessionSettings,
  usePersistSession,
  useStoreSelector,
  useUncageError,
  useUncageStore,
  type AttachmentRejection,
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

const EFFORT_LABEL: Record<EffortLevel, string> = { low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高' };
const MODE_LABEL: Record<PermissionMode, string> = {
  default: '每次询问',
  acceptEdits: '自动接受编辑',
  plan: '计划模式',
  auto: '自动模式',
  bypassPermissions: '完全放行',
};
const REJECTED_LABEL: Record<AttachmentRejection['reason'], string> = {
  type: '不支持的文件类型',
  size: '文件太大',
  count: '每条消息最多 10 个附件',
};

/**
 * Model, effort and permission-mode pickers over `useSessionSettings`. Before the first prompt they
 * edit the draft (applied when the session is created); afterwards they apply from the next run.
 * Only what the runtime (and the server's allowBypass policy) offers is listed.
 */
function SettingsBar({ disabled }: { disabled: boolean }) {
  const { settings, capabilities, update, pendingForNextRun } = useSessionSettings();
  const models = capabilities?.models ?? [];
  const efforts = capabilities?.efforts ?? [];
  const modes = capabilities?.permissionModes ?? [];
  const model = settings.model ?? (models.some((m) => m.id === 'default') ? 'default' : '');
  return (
    <div className="settings">
      {models.length > 0 && (
        <label>
          模型
          <select aria-label="模型" value={model} disabled={disabled} onChange={(e) => void update({ model: e.target.value })}>
            {model === '' && <option value="">默认</option>}
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {efforts.length > 0 && (
        <label>
          推理强度
          <select
            aria-label="推理强度"
            value={settings.effort ?? ''}
            disabled={disabled}
            onChange={(e) => void update({ effort: e.target.value as EffortLevel })}
          >
            {settings.effort === undefined && <option value="">默认</option>}
            {efforts.map((e) => (
              <option key={e} value={e}>
                {EFFORT_LABEL[e]}
              </option>
            ))}
          </select>
        </label>
      )}
      {modes.length > 0 && (
        <label>
          权限
          <select
            aria-label="权限"
            value={settings.permissionMode}
            disabled={disabled}
            onChange={(e) => {
              const mode = e.target.value as PermissionMode;
              // Bypass is only listed when the server allows it, and still needs an explicit yes.
              if (mode === 'bypassPermissions' && !window.confirm('Agent 将不经询问执行任何命令，确定开启？')) return;
              void update({ permissionMode: mode });
            }}
          >
            {modes.map((m) => (
              <option key={m} value={m}>
                {MODE_LABEL[m]}
              </option>
            ))}
          </select>
        </label>
      )}
      {pendingForNextRun && <span className="muted">下一次运行生效</span>}
      {settings.permissionMode === 'bypassPermissions' && (
        <p className="bypass-banner" role="status">
          已开启完全放行：Agent 会不经询问执行任何命令。
        </p>
      )}
    </div>
  );
}

/** Pending attachments (picker + chips) over `useAttachments`. */
function AttachmentPicker({ disabled }: { disabled: boolean }) {
  const { capabilities } = useSessionSettings();
  const { items, add, remove, rejected } = useAttachments();
  const caps = capabilities?.attachments;
  if (!caps || (!caps.images && !caps.files)) return null;
  return (
    <div className="attachments">
      <input
        type="file"
        aria-label="添加附件"
        multiple
        disabled={disabled}
        onChange={(e) => {
          add(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
      {items.length > 0 && (
        <ul className="attachment-list" aria-label="附件">
          {items.map((item) => (
            <li key={item.localId} className="attachment-chip" data-status={item.status}>
              {item.previewUrl && <img src={item.previewUrl} alt="" />}
              <span>{item.name}</span>
              <button type="button" aria-label={`移除 ${item.name}`} disabled={disabled} onClick={() => remove(item.localId)}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {rejected.map((r, i) => (
        <p key={i} className="attachment-rejected" role="status">
          {REJECTED_LABEL[r.reason]}：{r.name}
        </p>
      ))}
    </div>
  );
}

function SentImage({ attachment }: { attachment: Attachment }) {
  const url = useAttachmentUrl(attachment.id);
  return <img className="sent-image" src={url} alt={attachment.name} />;
}

/** The attachments a run was sent with (persisted with the run, so they survive a reload). */
function SentAttachments({ runId }: { runId: string }) {
  const attachments = useStoreSelector((s) => s.active?.runs[runId]?.attachments);
  if (!attachments || attachments.length === 0) return null;
  return (
    <div className="msg-attachments">
      {attachments.map((a) =>
        a.kind === 'image' ? (
          <SentImage key={a.id} attachment={a} />
        ) : (
          <span key={a.id} className="file-chip">
            {a.name}
          </span>
        ),
      )}
    </div>
  );
}

/** A complete chat built only from `@uncage/react` hooks, with its own markup and plain CSS. */
export function Chat() {
  // Opens `?session=<id>` on load and mirrors the open session into the URL (reload-safe).
  usePersistSession('url');
  const store = useUncageStore();
  const { runtimes } = useRuntimes();
  const { activeSessionId, select } = useSessions();
  const { session } = useSession();
  const { run, isActive, send, cancel } = useRun();
  const { timeline, messages, tools } = useMessages();
  const { all: approvals } = useApprovals();
  const { error, dismiss } = useUncageError();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const { ready: attachmentsReady } = useAttachments();
  const draft = useStoreSelector(isDraft);
  const draftRuntime = useStoreSelector((s) => s.draft.runtimeId);

  const runtime = runtimes.find((r) => r.status === 'available');
  const loading = activeSessionId !== undefined && session === undefined;
  const canSend =
    !loading && !isActive && !sending && attachmentsReady && text.trim() !== '' && (session !== undefined || runtime !== undefined);

  // No session open: a draft on the first available runtime, so settings and files can be picked
  // before the first prompt. Not while sending: the committed draft is closed until the new session
  // is selected, and reopening it then would drop the files moving to that session.
  useEffect(() => {
    if (draft && !sending && runtime && draftRuntime !== runtime.id && activeSessionId === undefined) {
      store.actions.openDraft(runtime.id);
    }
  }, [store, draft, sending, runtime, draftRuntime, activeSessionId]);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!canSend) return;
    setSending(true);
    try {
      const prompt = text.trim();
      // A draft: create the session (applying the draft's settings, uploading its files), open it, send.
      if (draft) await select(await store.actions.commitDraft());
      if (await send(prompt)) setText('');
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
            if (m.role === 'assistant') {
              return (
                <div key={item.id} className="msg-assistant" data-streaming={m.streaming || undefined}>
                  {m.text}
                </div>
              );
            }
            return (
              <div key={item.id} className="msg-user-wrap">
                <SentAttachments runId={m.runId} />
                <div className="msg-user">{m.text}</div>
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

      <SettingsBar disabled={loading || sending} />
      <AttachmentPicker disabled={loading || sending} />

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
