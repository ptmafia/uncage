import type { ExecFn } from '@uncage/agent';
import { findCommand as defaultFindCommand, systemTool } from '@uncage/protocol/node';
import type { IdentityWarning, SiteIdentity } from './site-identity.js';

export type DialogLocale = 'en' | 'zh' | 'ja';

/** The UI language: LC_ALL, LC_MESSAGES, LANG (`zh_CN.UTF-8`), then `intlLocale` (Intl's default). */
export function detectLocale(env: NodeJS.ProcessEnv, intlLocale: string = Intl.DateTimeFormat().resolvedOptions().locale): DialogLocale {
  const pick = (v: string | undefined): DialogLocale | null => {
    if (!v || v === 'C' || v === 'POSIX' || v.startsWith('C.')) return null;
    const l = v.toLowerCase();
    if (l.startsWith('zh')) return 'zh';
    if (l.startsWith('ja')) return 'ja';
    return 'en';
  };
  return pick(env.LC_ALL) ?? pick(env.LC_MESSAGES) ?? pick(env.LANG) ?? pick(intlLocale) ?? 'en';
}

interface Copy {
  title: string;
  body(i: SiteIdentity): string;
  warning(w: IdentityWarning, i: SiteIdentity): string;
  connect: string;
  cancel: string;
  /** Windows MessageBox buttons are OK / Cancel (in the system language). */
  pressOk: string;
  question: string;
}

const COPY: Record<DialogLocale, Copy> = {
  en: {
    title: 'Connect this computer?',
    body: (i) =>
      `Connect this computer to ${i.registrableDomain}?\n${i.url}\nIt will be able to start coding-agent sessions on this computer when you use that site.`,
    warning: (w, i) =>
      ({
        idn: `Warning: the address uses international characters (${i.displayHost}). Make sure it is the site you expect.`,
        ip: `Warning: this site is a bare IP address (${i.displayHost}), not a domain name.`,
        path: `This link points to a specific page on ${i.registrableDomain}: ${i.url}. Only continue if you started this from that site.`,
        first_time: `This computer has never connected to ${i.registrableDomain} before.`,
        lookalike: `Warning: ${i.registrableDomain} looks like ${i.lookalikeOf ?? 'a site'} you already connected. It may be an imitation.`,
      })[w],
    connect: 'Connect',
    cancel: 'Cancel',
    pressOk: 'Press OK to connect.',
    question: 'Connect? [y/N] ',
  },
  zh: {
    title: '连接这台电脑？',
    body: (i) => `要将这台电脑连接到 ${i.registrableDomain} 吗？\n${i.url}\n连接后，你在该网站上使用时，它可以在这台电脑上启动 coding agent 会话。`,
    warning: (w, i) =>
      ({
        idn: `警告：该地址包含国际化字符（${i.displayHost}），请确认这是你要连接的网站。`,
        ip: `警告：该网站是一个 IP 地址（${i.displayHost}），而不是域名。`,
        path: `该链接指向 ${i.registrableDomain} 上的一个特定页面：${i.url}。只有当你是从该网站发起的连接时才继续。`,
        first_time: `这台电脑以前从未连接过 ${i.registrableDomain}。`,
        lookalike: `警告：${i.registrableDomain} 与你已连接的 ${i.lookalikeOf ?? '网站'} 很像，可能是仿冒网站。`,
      })[w],
    connect: '连接',
    cancel: '取消',
    pressOk: '点击“确定”以连接。',
    question: '连接？[y/N] ',
  },
  ja: {
    title: 'このコンピュータを接続しますか？',
    body: (i) =>
      `このコンピュータを ${i.registrableDomain} に接続しますか？\n${i.url}\n接続すると、そのサイトを使うときに、このコンピュータでコーディングエージェントのセッションを開始できるようになります。`,
    warning: (w, i) =>
      ({
        idn: `警告：このアドレスには国際化文字が含まれています（${i.displayHost}）。目的のサイトか確認してください。`,
        ip: `警告：このサイトはドメイン名ではなく IP アドレス（${i.displayHost}）です。`,
        path: `このリンクは ${i.registrableDomain} 上の特定のページを指しています：${i.url}。そのサイトから操作を始めた場合のみ続行してください。`,
        first_time: `このコンピュータは ${i.registrableDomain} に接続したことがありません。`,
        lookalike: `警告：${i.registrableDomain} は接続済みの ${i.lookalikeOf ?? 'サイト'} に似ています。なりすましの可能性があります。`,
      })[w],
    connect: '接続',
    cancel: 'キャンセル',
    pressOk: '接続するには［OK］を押してください。',
    question: '接続しますか？ [y/N] ',
  },
};

/** The dialog's title, body (domain, origin, consequence, one line per warning) and button labels. */
export function confirmText(i: SiteIdentity, locale: DialogLocale): { title: string; body: string; connect: string; cancel: string; pressOk: string; question: string } {
  const c = COPY[locale];
  const body = [c.body(i), ...i.warnings.map((w) => c.warning(w, i))].join('\n');
  return { title: c.title, body, connect: c.connect, cancel: c.cancel, pressOk: c.pressOk, question: c.question };
}

export interface ConfirmDeps {
  platform: NodeJS.Platform;
  exec: ExecFn;
  /** Is there a terminal to ask in (the fallback when no dialog tool is available)? */
  isTTY: boolean;
  /** Asks one line in the terminal; the answer. */
  prompt?: (question: string) => Promise<string>;
  /** Locale variables, DISPLAY / WAYLAND_DISPLAY, PATH, SystemRoot. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Finds zenity / kdialog on PATH (default `findCommand` from @uncage/protocol/node). */
  findCommand?: (cmd: string) => Promise<string | null>;
  /** Where the terminal fallback prints the question and refusals are explained. */
  out?: (line: string) => void;
  locale?: DialogLocale;
}

/** AppleScript that reads every text from argv: nothing user-controlled is ever parsed as script. */
const OSASCRIPT = [
  'on run argv',
  'activate',
  'display dialog (item 1 of argv) with title (item 2 of argv) buttons {(item 3 of argv), (item 4 of argv)} default button (item 3 of argv) cancel button (item 3 of argv) with icon caution giving up after 600',
  'end run',
];

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

/** The PowerShell script (texts base64-encoded, so no quoting can break out). */
function powershellScript(title: string, body: string): string {
  return [
    'Add-Type -AssemblyName System.Windows.Forms',
    `$body = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(body)}'))`,
    `$title = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(title)}'))`,
    '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }',
    "$r = [System.Windows.Forms.MessageBox]::Show($owner, $body, $title, 'OKCancel', 'Warning', 'Button2')",
    "if ($r -eq 'OK') { 'connect' } else { 'cancel' }",
  ].join('\n');
}

type Answer = 'yes' | 'no' | 'error';

const exitCode = (e: unknown): number | undefined => {
  const c = (e as { code?: unknown }).code;
  return typeof c === 'number' ? c : undefined;
};
const stderrOf = (e: unknown): string => String((e as { stderr?: unknown }).stderr ?? '').trim();

/** The native dialog's answer; `null` when this platform has no dialog tool here. */
async function nativeDialog(t: ReturnType<typeof confirmText>, d: ConfirmDeps, env: NodeJS.ProcessEnv): Promise<{ answer: Answer; detail?: string } | null> {
  if (d.platform === 'darwin') {
    return d.exec('/usr/bin/osascript', [...OSASCRIPT.flatMap((l) => ['-e', l]), '--', t.body, t.title, t.cancel, t.connect]).then(
      ({ stdout }) => ({ answer: stdout.split(/[,\n]/).some((part) => part.trim() === `button returned:${t.connect}`) ? 'yes' : 'no' }),
      // Cancel / Esc is AppleScript error -128; anything else means the dialog was never shown.
      (e: unknown) => (/-128\b/.test(stderrOf(e)) ? { answer: 'no' } : { answer: 'error', detail: stderrOf(e) || String(e) }),
    );
  }
  if (d.platform === 'win32') {
    const script = powershellScript(t.title, `${t.body}\n\n${t.pressOk}`);
    return d
      .exec(systemTool('powershell', { platform: 'win32', env }), [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ])
      .then(
        ({ stdout }) => ({ answer: stdout.trim() === 'connect' ? 'yes' : stdout.trim() === 'cancel' ? 'no' : 'error', detail: stdout.trim() }),
        (e: unknown) => ({ answer: 'error', detail: stderrOf(e) || String(e) }),
      );
  }
  if (d.platform === 'linux' && (env.DISPLAY || env.WAYLAND_DISPLAY)) {
    const find = d.findCommand ?? ((c: string) => defaultFindCommand(c, { platform: d.platform, env }));
    // zenity: 0 OK, 1 Cancel, 5 timeout. kdialog: 0 Continue, 1 / 2 No / Cancel. Anything else: not shown.
    const run = (file: string, args: string[], noCodes: number[]) =>
      d.exec(file, args).then(
        (): { answer: Answer } => ({ answer: 'yes' }),
        (e: unknown): { answer: Answer; detail?: string } => {
          const c = exitCode(e);
          return c !== undefined && noCodes.includes(c) ? { answer: 'no' } : { answer: 'error', detail: stderrOf(e) || String(e) };
        },
      );
    const zenity = await find('zenity');
    if (zenity) {
      return run(
        zenity,
        ['--question', `--title=${t.title}`, `--text=${t.body}`, `--ok-label=${t.connect}`, `--cancel-label=${t.cancel}`, '--default-cancel', '--no-markup', '--width=440'],
        [1, 5],
      );
    }
    const kdialog = await find('kdialog');
    // warningcontinuecancel: Cancel is the default button.
    if (kdialog) return run(kdialog, ['--title', t.title, '--warningcontinuecancel', t.body, '--continue-label', t.connect, '--cancel-label', t.cancel], [1, 2]);
  }
  return null;
}

/**
 * Asks the person at this computer whether to connect to the site, with its registrable domain,
 * full hub URL and warnings. Native dialog first (macOS osascript, Windows MessageBox, Linux zenity /
 * kdialog with a display); Cancel is the default everywhere and stays a no. When no dialog tool
 * exists, or the dialog could not be shown (no GUI session, stale DISPLAY), the terminal asks if
 * there is one; otherwise false with an explanation.
 */
export async function confirmConnect(i: SiteIdentity, d: ConfirmDeps): Promise<boolean> {
  const env = d.env ?? process.env;
  const t = confirmText(i, d.locale ?? detectLocale(env));
  const out = d.out ?? (() => undefined);
  const native = await nativeDialog(t, d, env);
  if (native?.answer === 'yes') return true;
  if (native?.answer === 'no') return false;
  if (native?.answer === 'error') out(`The confirmation dialog could not be shown (${native.detail?.split('\n')[0] ?? 'unknown error'}).`);
  if (d.isTTY && d.prompt) {
    out(`${t.title}\n\n${t.body}\n`);
    const answer = (await d.prompt(t.question).catch(() => '')).trim();
    return /^y(es)?$/i.test(answer);
  }
  out('Could not ask for confirmation on this computer (no dialog and no terminal), so it was not connected. Run "uncage connect <url>" in a terminal.');
  return false;
}
