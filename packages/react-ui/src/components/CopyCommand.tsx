import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState, type JSX } from 'react';
import { useUi } from '../context.js';

const COPIED_MS = 2000;

/** Copies `text` to the clipboard (async API, else a hidden-textarea fallback). */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // denied or unavailable: fall back below
  }
  try {
    const el = document.createElement('textarea');
    el.value = text;
    el.setAttribute('readonly', '');
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand('copy');
    el.remove();
    return ok;
  } catch {
    return false;
  }
}

/** A one-line shell command in a mono block with a copy button ("Copied" for 2 s). */
export function CopyCommand({ command }: { command: string }): JSX.Element {
  const { t } = useUi();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const onCopy = async () => {
    if (!(await copyText(command))) return;
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  };
  return (
    <div className="uc-command">
      <code className="uc-command-text">{command}</code>
      <button
        type="button"
        className="uc-btn uc-btn-ghost uc-btn-icon-sm uc-command-copy"
        aria-label={t.copyCommand(command)}
        title={copied ? t.copied : t.copy}
        onClick={() => void onCopy()}
      >
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      </button>
      <span className="uc-sr-only" role="status">
        {copied ? t.copied : ''}
      </span>
    </div>
  );
}
