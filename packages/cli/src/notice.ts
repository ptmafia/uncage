import type { ExecFn } from '@uncage/agent';
import { findCommand as defaultFindCommand, systemTool } from '@uncage/protocol/node';
import type { DialogLocale } from './confirm-dialog.js';
import { plainText } from './text.js';

/** A short native message: how a link-launched `uncage connect` reports its outcome (it has no terminal). */
export interface Notice {
  ok: boolean;
  title: string;
  body: string;
}

/** The Windows notice closes by itself after this long. */
export const NOTICE_TIMEOUT_S = 60;
const MAX_REASON = 300;

const COPY: Record<DialogLocale, { ok(domain: string): [string, string]; failed(domain: string | undefined): string }> = {
  en: {
    ok: (d) => [`Connected to ${d}`, `${d} can now use this computer. See or disconnect it with: uncage dashboard`],
    failed: (d) => (d ? `Not connected to ${d}` : 'Uncage: not connected'),
  },
  zh: {
    ok: (d) => [`已连接到 ${d}`, `${d} 现在可以使用这台电脑。用 uncage dashboard 查看或断开连接。`],
    failed: (d) => (d ? `未连接到 ${d}` : 'Uncage：未连接'),
  },
  ja: {
    ok: (d) => [`${d} に接続しました`, `${d} はこのコンピュータを利用できるようになりました。uncage dashboard で確認・接続解除できます。`],
    failed: (d) => (d ? `${d} に接続できませんでした` : 'Uncage：接続できませんでした'),
  },
};

/** The notice for a connect outcome; the reason (English, from the error) is cleaned and capped. */
export function connectNotice(o: { ok: true; domain: string } | { ok: false; domain?: string; reason: string }, locale: DialogLocale): Notice {
  const c = COPY[locale];
  if (o.ok) {
    const [title, body] = c.ok(o.domain);
    return { ok: true, title, body };
  }
  const reason = plainText(o.reason);
  return { ok: false, title: c.failed(o.domain), body: reason.length > MAX_REASON ? `${reason.slice(0, MAX_REASON - 1)}…` : reason };
}

export interface NoticeDeps {
  platform: NodeJS.Platform;
  exec: ExecFn;
  /** PATH, SystemRoot. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Finds notify-send (Linux). Default `findCommand` from @uncage/protocol/node. */
  findCommand?: (cmd: string) => Promise<string | null>;
}

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

/**
 * Shows `n` natively, best effort (never throws): macOS `display notification` (texts in argv),
 * Linux `notify-send` when installed, Windows a WScript.Shell Popup (information or warning icon)
 * that closes after `NOTICE_TIMEOUT_S`.
 */
export async function showNotice(n: Notice, d: NoticeDeps): Promise<void> {
  const env = d.env ?? process.env;
  try {
    if (d.platform === 'darwin') {
      const script = ['on run argv', 'display notification (item 1 of argv) with title (item 2 of argv)', 'end run'];
      await d.exec('/usr/bin/osascript', [...script.flatMap((l) => ['-e', l]), '--', n.body, n.title]);
    } else if (d.platform === 'linux') {
      const find = d.findCommand ?? ((c: string) => defaultFindCommand(c, { platform: 'linux', env }));
      const notifySend = await find('notify-send');
      if (notifySend) await d.exec(notifySend, ['--app-name=Uncage', '--urgency=normal', '--', n.title, n.body]);
    } else if (d.platform === 'win32') {
      // Information 0x40 or warning 0x30, system modal 0x1000 (like the confirmation, so it is seen).
      const script = [
        `$body = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(n.body)}'))`,
        `$title = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(n.title)}'))`,
        `$null = (New-Object -ComObject WScript.Shell).Popup($body, ${NOTICE_TIMEOUT_S}, $title, ${n.ok ? '0x1040' : '0x1030'})`,
      ].join('\n');
      await d.exec(systemTool('powershell', { platform: 'win32', env }), [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ]);
    }
  } catch {
    // Best effort: the outcome is also printed (connect.log on macOS).
  }
}
