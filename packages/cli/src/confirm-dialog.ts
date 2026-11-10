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
  /** The first line: the question, with the registrable domain. */
  head(i: SiteIdentity): string;
  /** The last line: what whoever runs the site can do once connected. */
  consequence(i: SiteIdentity): string;
  /** `url` is the (possibly shortened) URL shown in this text. */
  warning(w: IdentityWarning, i: SiteIdentity, url: string): string;
  connect: string;
  cancel: string;
  /** kdialog's default (Enter) button: a no. */
  dontConnect: string;
  /** Windows Popup buttons are OK / Cancel (in the system language). */
  pressOk: string;
  question: string;
}

const COPY: Record<DialogLocale, Copy> = {
  en: {
    title: 'Connect this computer?',
    head: (i) => `Connect this computer to ${i.registrableDomain}?`,
    consequence: (i) =>
      `Whoever runs ${i.registrableDomain} can then start coding-agent sessions on this computer at any time and answer their approval prompts, within your local policy. Only connect sites you trust.`,
    warning: (w, i, url) =>
      ({
        idn: `Warning: the address uses international characters (${i.displayHost}). Make sure it is the site you expect.`,
        ip: `Warning: this site is a bare IP address (${i.displayHost}), not a domain name.`,
        path: `This link points to a specific page on ${i.registrableDomain}: ${url}. Only continue if you started this from that site.`,
        first_time: `This computer has never connected to ${i.registrableDomain} before.`,
        lookalike: `Warning: ${i.registrableDomain} looks like ${i.lookalikeOf ?? 'a site'} you already connected. It may be an imitation.`,
      })[w],
    connect: 'Connect',
    cancel: 'Cancel',
    dontConnect: "Don't connect",
    pressOk: 'Press OK to connect.',
    question: 'Connect? [y/N] ',
  },
  zh: {
    title: '连接这台电脑？',
    head: (i) => `要将这台电脑连接到 ${i.registrableDomain} 吗？`,
    consequence: (i) => `连接后，${i.registrableDomain} 的运营者可以随时在这台电脑上启动 coding agent 会话，并在你的本地策略范围内回答它们的审批请求。只连接你信任的网站。`,
    warning: (w, i, url) =>
      ({
        idn: `警告：该地址包含国际化字符（${i.displayHost}），请确认这是你要连接的网站。`,
        ip: `警告：该网站是一个 IP 地址（${i.displayHost}），而不是域名。`,
        path: `该链接指向 ${i.registrableDomain} 上的一个特定页面：${url}。只有当你是从该网站发起的连接时才继续。`,
        first_time: `这台电脑以前从未连接过 ${i.registrableDomain}。`,
        lookalike: `警告：${i.registrableDomain} 与你已连接的 ${i.lookalikeOf ?? '网站'} 很像，可能是仿冒网站。`,
      })[w],
    connect: '连接',
    cancel: '取消',
    dontConnect: '不连接',
    pressOk: '点击“确定”以连接。',
    question: '连接？[y/N] ',
  },
  ja: {
    title: 'このコンピュータを接続しますか？',
    head: (i) => `このコンピュータを ${i.registrableDomain} に接続しますか？`,
    consequence: (i) =>
      `接続すると、${i.registrableDomain} の運営者は、このコンピュータでいつでもコーディングエージェントのセッションを開始し、ローカルポリシーの範囲内でその承認の確認に応答できます。信頼できるサイトだけを接続してください。`,
    warning: (w, i, url) =>
      ({
        idn: `警告：このアドレスには国際化文字が含まれています（${i.displayHost}）。目的のサイトか確認してください。`,
        ip: `警告：このサイトはドメイン名ではなく IP アドレス（${i.displayHost}）です。`,
        path: `このリンクは ${i.registrableDomain} 上の特定のページを指しています：${url}。そのサイトから操作を始めた場合のみ続行してください。`,
        first_time: `このコンピュータは ${i.registrableDomain} に接続したことがありません。`,
        lookalike: `警告：${i.registrableDomain} は接続済みの ${i.lookalikeOf ?? 'サイト'} に似ています。なりすましの可能性があります。`,
      })[w],
    connect: '接続',
    cancel: 'キャンセル',
    dontConnect: '接続しない',
    pressOk: '接続するには［OK］を押してください。',
    question: '接続しますか？ [y/N] ',
  },
};

/** The longest URL a dialog shows; longer ones are cut in the middle (the full URL is still the one checked). */
export const DIALOG_URL_MAX = 120;

/** `url` cut in the middle to `max` characters (origin and end kept), with an ellipsis. */
export function shortUrl(url: string, max: number = DIALOG_URL_MAX): string {
  const chars = [...url];
  if (chars.length <= max) return url;
  const head = Math.ceil((max - 1) / 2);
  const tail = max - 1 - head;
  return `${chars.slice(0, head).join('')}…${chars.slice(chars.length - tail).join('')}`;
}

export interface ConfirmText {
  title: string;
  body: string;
  connect: string;
  cancel: string;
  dontConnect: string;
  pressOk: string;
  question: string;
}

/**
 * The dialog's title, body and button labels. Body: the question with the domain, one line per
 * warning (first, so a long URL cannot push them out of view), the URL (middle-truncated unless
 * `fullUrl`, as in the terminal), then what the site's operator can do once connected.
 */
export function confirmText(i: SiteIdentity, locale: DialogLocale, o: { fullUrl?: boolean } = {}): ConfirmText {
  const c = COPY[locale];
  const url = o.fullUrl ? i.url : shortUrl(i.url);
  const body = [c.head(i), ...i.warnings.map((w) => c.warning(w, i, url)), url, c.consequence(i)].join('\n');
  return { title: c.title, body, connect: c.connect, cancel: c.cancel, dontConnect: c.dontConnect, pressOk: c.pressOk, question: c.question };
}

export interface ConfirmDeps {
  platform: NodeJS.Platform;
  exec: ExecFn;
  /** Is there a terminal to ask in (the fallback when no dialog tool is available)? */
  isTTY: boolean;
  /** Asks one line in the terminal; the answer. `signal` aborts the question (no answer in time). */
  prompt?: (question: string, signal?: AbortSignal) => Promise<string>;
  /** Locale variables, DISPLAY / WAYLAND_DISPLAY, PATH, SystemRoot. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Finds zenity / kdialog on PATH (default `findCommand` from @uncage/protocol/node). */
  findCommand?: (cmd: string) => Promise<string | null>;
  /** Where the terminal fallback prints the question and refusals are explained. */
  out?: (line: string) => void;
  locale?: DialogLocale;
  /** How long any prompt waits for an answer (default `DIALOG_TIMEOUT_S`); no answer is a cancel. */
  timeoutMs?: number;
}

/** Every confirmation gives up after this long (macOS `giving up after`, zenity, timeout(1), Popup); giving up is a cancel. */
export const DIALOG_TIMEOUT_S = 600;
/** Extra time a dialog process gets past its own timeout before it is treated as a cancel anyway. */
const CUTOFF_MARGIN_MS = 30_000;

/** `p`, or `fallback` once `ms` passed (the slower side is ignored). */
function bounded<T>(p: Promise<T>, ms: number, fallback: () => T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback()), ms);
    timer.unref?.();
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** AppleScript that reads every text from argv: nothing user-controlled is ever parsed as script. */
const OSASCRIPT = [
  'on run argv',
  'activate',
  `display dialog (item 1 of argv) with title (item 2 of argv) buttons {(item 3 of argv), (item 4 of argv)} default button (item 3 of argv) cancel button (item 3 of argv) with icon caution giving up after ${DIALOG_TIMEOUT_S}`,
  'end run',
];

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

/** The PowerShell script (texts base64-encoded, so no quoting can break out). Prints `connect` or `cancel`. */
export function powershellScript(title: string, body: string, timeoutS: number = DIALOG_TIMEOUT_S): string {
  return [
    `$body = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(body)}'))`,
    `$title = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(title)}'))`,
    // WScript.Shell Popup: OK/Cancel 0x1, warning 0x30, Cancel default 0x100, system modal 0x1000; gives
    // up after DIALOG_TIMEOUT_S (-1). Only OK (1) connects.
    `$r = (New-Object -ComObject WScript.Shell).Popup($body, ${timeoutS}, $title, 0x1131)`,
    "if ($r -eq 1) { 'connect' } else { 'cancel' }",
  ].join('\n');
}

type Answer = 'yes' | 'no' | 'error';

const exitCode = (e: unknown): number | undefined => {
  const c = (e as { code?: unknown }).code;
  return typeof c === 'number' ? c : undefined;
};
const stderrOf = (e: unknown): string => String((e as { stderr?: unknown }).stderr ?? '').trim();

/** The native dialog's answer; `null` when this platform has no dialog tool here. */
async function nativeDialog(t: ConfirmText, d: ConfirmDeps, env: NodeJS.ProcessEnv): Promise<{ answer: Answer; detail?: string } | null> {
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
    // zenity: 0 OK, 1 Cancel, 5 timeout. Anything else: not shown.
    const run = (file: string, args: string[], answers: Partial<Record<number, Answer>>) =>
      d.exec(file, args).then(
        (): { answer: Answer; detail?: string } => ({ answer: answers[0] ?? 'error' }),
        (e: unknown): { answer: Answer; detail?: string } => {
          const c = exitCode(e);
          const a = c === undefined ? undefined : answers[c];
          return a ? { answer: a } : { answer: 'error', detail: stderrOf(e) || String(e) };
        },
      );
    // zenity first: it has a real default-Cancel option.
    const zenity = await find('zenity');
    if (zenity) {
      return run(
        zenity,
        ['--question', `--title=${t.title}`, `--text=${t.body}`, `--ok-label=${t.connect}`, `--cancel-label=${t.cancel}`, '--default-cancel', '--no-markup', '--width=440', `--timeout=${DIALOG_TIMEOUT_S}`],
        { 0: 'yes', 1: 'no', 5: 'no' },
      );
    }
    const kdialog = await find('kdialog');
    // kdialog cannot make Cancel the default of a continue/cancel box, and Esc in a yes/no box is
    // "No". So: yes/no/cancel, where the default Yes button is "Don't connect" (exit 0 = no), No is
    // Connect (exit 1, the only yes) and Cancel / Esc is exit 2 (no). kdialog has no timeout:
    // coreutils timeout(1) ends it (exit 124 = gave up = no); without it the cut-off below applies.
    if (kdialog) {
      const args = ['--title', t.title, '--warningyesnocancel', t.body, '--yes-label', t.dontConnect, '--no-label', t.connect, '--cancel-label', t.cancel];
      const answers = { 0: 'no', 1: 'yes', 2: 'no', 124: 'no' } as const;
      const timeout = await find('timeout');
      return timeout ? run(timeout, [String(DIALOG_TIMEOUT_S), kdialog, ...args], answers) : run(kdialog, args, answers);
    }
  }
  return null;
}

/**
 * Asks the person at this computer whether to connect to the site, with its registrable domain,
 * hub URL and warnings. Native dialog first (macOS osascript, Windows WScript.Shell Popup, Linux
 * zenity, else kdialog, with a display); Cancel is the default everywhere and stays a no. When no dialog tool
 * exists, or the dialog could not be shown (no GUI session, stale DISPLAY), the terminal asks if
 * there is one; otherwise false with an explanation.
 */
export async function confirmConnect(i: SiteIdentity, d: ConfirmDeps): Promise<boolean> {
  const env = d.env ?? process.env;
  const locale = d.locale ?? detectLocale(env);
  const t = confirmText(i, locale);
  const out = d.out ?? (() => undefined);
  const timeoutMs = d.timeoutMs ?? DIALOG_TIMEOUT_S * 1000;
  // A dialog that never returns (its own timeout failed, a stuck process) counts as a cancel.
  const native = await bounded(nativeDialog(t, d, env), d.timeoutMs ?? timeoutMs + CUTOFF_MARGIN_MS, () => ({ answer: 'no' as const }));
  if (native?.answer === 'yes') return true;
  if (native?.answer === 'no') return false;
  if (native?.answer === 'error') out(`The confirmation dialog could not be shown (${native.detail?.split('\n')[0] ?? 'unknown error'}).`);
  if (d.isTTY && d.prompt) {
    // The terminal has room: the full URL.
    out(`${t.title}\n\n${confirmText(i, locale, { fullUrl: true }).body}\n`);
    const ac = new AbortController();
    const answer = await bounded(d.prompt(t.question, ac.signal).catch(() => ''), timeoutMs, () => {
      ac.abort();
      out(`No answer in ${Math.round(timeoutMs / 1000)} s; not connected.`);
      return '';
    });
    return /^y(es)?$/i.test(answer.trim());
  }
  out('Could not ask for confirmation on this computer (no dialog and no terminal), so it was not connected. Run "uncage connect <url>" in a terminal.');
  return false;
}
