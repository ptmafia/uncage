import { ATTACHMENT_LIMITS, type RuntimeCapabilities } from '@uncage/protocol';
import {
  useAttachments,
  useMachines,
  useRun,
  type AttachmentRejection,
  useSession,
  useSessionSettings,
  useSpeechInput,
  useStoreSelector,
  useUncageStore,
} from '@uncage/react';
import { ArrowUp, Lock, Square, WifiOff, X } from 'lucide-react';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type JSX,
  type KeyboardEvent,
} from 'react';
import { useChatController, useRuntimeInfo, useUi } from '../context.js';
import { errorText, formatBytes, type Strings } from '../i18n.js';
import { AttachmentList } from './AttachmentList.js';
import { AttachButton, acceptList } from './composer/AttachButton.js';
import { EffortMenu } from './composer/EffortMenu.js';
import { MicButton } from './composer/MicButton.js';
import { ModelMenu } from './composer/ModelMenu.js';
import { PermissionMenu } from './composer/PermissionMenu.js';
import { RunningChip } from './RunningChip.js';

/** localStorage key: the speech privacy note was shown once. */
const SPEECH_NOTICE_KEY = 'uncage.speechNoticeShown';

const IMAGE_EXT = new Set<string>(ATTACHMENT_LIMITS.imageExt);

/** The caption for a refused file, with the limit that applied to it. */
function rejectionText(t: Strings, r: AttachmentRejection, caps: RuntimeCapabilities['attachments'] | undefined): string {
  if (r.reason === 'type') return t.rejectedType(r.name);
  if (r.reason === 'count') return t.rejectedCount(r.name, ATTACHMENT_LIMITS.maxPerMessage);
  const general = caps && caps.maxBytes > 0 ? Math.min(caps.maxBytes, ATTACHMENT_LIMITS.maxBytes) : ATTACHMENT_LIMITS.maxBytes;
  const image = IMAGE_EXT.has(r.name.slice(r.name.lastIndexOf('.') + 1).toLowerCase());
  const max = image && caps?.maxImageBytes ? Math.min(caps.maxImageBytes, general) : general;
  return t.rejectedSize(r.name, formatBytes(max, { whole: true }));
}

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

function readNoticeShown(): boolean {
  try {
    return localStorage.getItem(SPEECH_NOTICE_KEY) === '1';
  } catch {
    return true;
  }
}

/**
 * Claude Code–style prompt box pinned under the conversation: a running-sessions chip above it;
 * the textarea, pending attachments and a toolbar (attach, model, effort, permission mode; run
 * indicator, dictation, Send/Stop) inside it. Enter sends, Shift+Enter inserts a newline, Enter
 * while an IME is composing is ignored. Files attach via the picker, drag-and-drop or paste.
 * Disabled (with a hint) when the runtime is unavailable, while a new session is being created,
 * or with a banner offering a new session when the session is read-only. In connected mode it is
 * also disabled while the conversation's computer is offline (with a reconnect hint) or none is
 * connected.
 */
export function Composer(): JSX.Element {
  const { t, locale } = useUi();
  const store = useUncageStore();
  const controller = useChatController();
  const { session } = useSession();
  const { run, isActive, cancel } = useRun();
  const { info, name } = useRuntimeInfo(controller.runtimeId);
  const { capabilities } = useSessionSettings();
  const attachments = useAttachments();
  const warning = useStoreSelector((s) => s.active?.lastWarning);
  const machines = useMachines();
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  const [sending, setSending] = useState(false);
  const active = !controller.draft && isActive;
  // A session is selected but its snapshot has not loaded yet: nothing to send to.
  const loading = !controller.draft && session === undefined;
  const readOnly = !controller.draft && session?.readOnly === true;
  // Connected mode: the computer that runs the conversation is offline, or none is connected yet.
  // (A session whose computer is no longer listed counts as offline too.)
  const machineOffline = machines.connected && machines.currentId !== undefined && machines.current?.online !== true;
  const noMachine = machines.connected && machines.machines.length === 0;
  const unavailable = info !== undefined && info.status !== 'available';
  const hint = noMachine
    ? t.noComputer
    : !readOnly && !machineOffline && unavailable
      ? [info.message ?? t.runtimeUnavailable(name), info.hint].filter(Boolean).join(' ')
      : undefined;
  const disabled = loading || readOnly || unavailable || machineOffline || noMachine || controller.committing === true;
  const canSend = !disabled && !active && !sending && text.trim().length > 0;
  const attachCaps = capabilities?.attachments;
  const canAttach = attachCaps !== undefined && (attachCaps.images || attachCaps.files);
  const attachDisabled = disabled || sending;

  // ---- dictation: interim text previews after `base` (the text so far, finals included); a final
  // result is appended to `base`. `preview` is the interim suffix currently shown after `base`.
  const dictation = useRef<{ base: string; preview: string } | null>(null);
  const join = (base: string, chunk: string) =>
    base === '' || /\s$/.test(base) || /^\s/.test(chunk) || locale === 'zh-CN' ? base + chunk : `${base} ${chunk}`;
  const speech = useSpeechInput({
    lang: locale === 'zh-CN' ? 'zh-CN' : 'en-US',
    onText(chunk, final) {
      const d = dictation.current;
      if (!d) return;
      const next = join(d.base, chunk);
      // A final result replaces the interim preview even when no new interim text follows.
      if (final) {
        d.base = next;
        d.preview = '';
      } else d.preview = next.slice(d.base.length);
      setText(next);
    },
  });
  useEffect(() => {
    if (!speech.listening) dictation.current = null;
  }, [speech.listening]);
  const [notice, setNotice] = useState(false);
  const toggleMic = () => {
    if (speech.listening) {
      speech.stop();
      return;
    }
    if (!readNoticeShown()) {
      setNotice(true);
      try {
        localStorage.setItem(SPEECH_NOTICE_KEY, '1');
      } catch {
        // Storage unavailable: the note simply shows again next time.
      }
    }
    dictation.current = { base: text, preview: '' };
    speech.start();
    ref.current?.focus();
  };

  // ---- rejected files: shown until dismissed, replaced by the next add.
  const [dismissedRejections, setDismissedRejections] = useState<AttachmentRejection[]>();
  const rejections = attachments.rejected !== dismissedRejections ? attachments.rejected : [];
  const addFiles = (files: File[]) => {
    if (attachDisabled || !canAttach || files.length === 0) return;
    attachments.add(files);
  };

  // ---- drag and drop over the box
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const dropAllowed = canAttach && !attachDisabled;
  const onDragEnter = (e: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current++;
    if (dropAllowed) setDragging(true);
  };
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(e)) return;
    // Always handled, so a refused drop never makes the browser open the file.
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = dropAllowed ? 'copy' : 'none';
  };
  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    addFiles(Array.from(e.dataTransfer?.files ?? []));
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    // Clipboards with text (e.g. from an office app, or a copied file's name) paste the text.
    const hasText = Array.from(e.clipboardData?.types ?? []).includes('text/plain');
    if (files.length === 0 || hasText || !canAttach) return;
    // Pasted files without text (e.g. a screenshot) become attachments.
    e.preventDefault();
    addFiles(files);
  };

  // ---- setting_reset: shown for the run it was raised at, until the next run starts.
  const settingReset = !controller.draft && warning?.code === 'setting_reset' && warning.runId === run?.id;

  // Auto-grow: reset, then fit the content (CSS caps it at 40vh and scrolls beyond).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  // The text is cleared only once the run started; a failed or refused send keeps it.
  const submit = async () => {
    if (!canSend) return;
    if (speech.listening) speech.stop();
    dictation.current = null;
    setSending(true);
    try {
      const sent = text;
      if (await controller.send(sent.trim())) {
        setText((now) => (now === sent ? '' : now));
        setDismissedRejections(attachments.rejected);
        setNotice(false);
      }
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    // IME candidate confirmation (keyCode 229 covers Safari, which reports isComposing late).
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    void submit();
  };

  const captions: { key: string; tone: 'err' | 'muted'; text: string; onDismiss?: () => void }[] = [
    ...rejections.map((r, i) => ({
      key: `rej-${i}`,
      tone: 'err' as const,
      text: rejectionText(t, r, attachCaps),
      onDismiss: () => setDismissedRejections(attachments.rejected),
    })),
    ...attachments.items.flatMap((item) =>
      item.status === 'error' && item.error
        ? [{ key: `upl-${item.localId}`, tone: 'err' as const, text: t.uploadFailedReason(item.name, errorText(t, item.error).message) }]
        : [],
    ),
    ...(speech.error && speech.error !== 'aborted' ? [{ key: 'mic', tone: 'err' as const, text: t.micError(speech.error) }] : []),
    ...(notice ? [{ key: 'notice', tone: 'muted' as const, text: t.speechNotice, onDismiss: () => setNotice(false) }] : []),
    ...(settingReset ? [{ key: 'reset', tone: 'muted' as const, text: t.settingReset }] : []),
  ];

  return (
    <div className="uc-composer-wrap">
      {readOnly && (
        <div className="uc-banner uc-readonly" data-tone="warn" role="status">
          <Lock aria-hidden />
          <span className="uc-banner-text">{t.readOnlyHint}</span>
          {controller.startNewSession && (
            <button type="button" className="uc-btn uc-btn-secondary uc-btn-sm" onClick={controller.startNewSession}>
              {t.newSession}
            </button>
          )}
        </div>
      )}
      {machineOffline && !readOnly && (
        <div className="uc-banner uc-machine-offline" data-tone="warn" role="status">
          <WifiOff aria-hidden />
          <span className="uc-banner-text">
            {t.computerOffline}{' '}
            <span className="uc-banner-hint">
              {t.computerOfflineHint} <code className="uc-inline-code">uncage agent</code>
            </span>
          </span>
        </div>
      )}
      {hint && (
        <p className="uc-composer-hint" role="note">
          {hint}
        </p>
      )}
      <div className="uc-composer-chips">
        <RunningChip onSelect={(id) => (controller.openSession ? controller.openSession(id) : void store.actions.selectSession(id))} />
      </div>
      <div
        className="uc-composer"
        data-disabled={disabled || undefined}
        data-dragging={dragging || undefined}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <textarea
          ref={ref}
          className="uc-composer-input"
          rows={1}
          value={text}
          disabled={disabled}
          aria-label={t.composerLabel}
          placeholder={t.placeholder(name, canAttach)}
          onChange={(e) => {
            const value = e.target.value;
            setText(value);
            const d = dictation.current;
            if (!d) return;
            // An edit that leaves the interim preview at the end keeps dictating with the preview
            // excluded from the base; any other edit (e.g. typing into the preview) ends dictation,
            // so later results can never repeat text already in the box.
            if (d.preview === '' || value.endsWith(d.preview)) d.base = value.slice(0, value.length - d.preview.length);
            else {
              dictation.current = null;
              speech.stop();
            }
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <AttachmentList disabled={attachDisabled} />
        <div className="uc-composer-bar">
          <div className="uc-composer-tools">
            {canAttach && <AttachButton accept={acceptList(attachCaps)} disabled={attachDisabled} onFiles={addFiles} />}
            <ModelMenu disabled={disabled} />
            <EffortMenu disabled={disabled} />
            <PermissionMenu disabled={disabled} />
          </div>
          <div className="uc-composer-actions">
            {active && (
              <span className="uc-composer-running" title={t.runActive} aria-hidden>
                <span className="uc-spinner" />
              </span>
            )}
            <MicButton supported={speech.supported} listening={speech.listening} disabled={disabled} onToggle={toggleMic} />
            {active ? (
              <button type="button" className="uc-btn uc-btn-icon uc-round uc-stop" aria-label={t.stop} onClick={() => void cancel()}>
                <Square className="uc-icon-stop" aria-hidden />
              </button>
            ) : (
              <button
                type="button"
                className="uc-btn uc-btn-primary uc-btn-icon uc-round uc-send"
                aria-label={t.send}
                disabled={!canSend}
                onClick={() => void submit()}
              >
                <ArrowUp aria-hidden />
              </button>
            )}
          </div>
        </div>
        {dragging && (
          <div className="uc-drop-overlay" aria-hidden>
            {t.dropToAttach}
          </div>
        )}
      </div>
      {captions.length > 0 && (
        <div className="uc-composer-captions" role="status">
          {captions.map((c) => (
            <p key={c.key} className="uc-composer-caption" data-tone={c.tone}>
              <span>{c.text}</span>
              {c.onDismiss && (
                <button type="button" className="uc-caption-dismiss" aria-label={t.dismiss} onClick={c.onDismiss}>
                  <X aria-hidden />
                </button>
              )}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
