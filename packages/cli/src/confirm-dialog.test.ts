import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ExecFn } from '@uncage/agent';
import { describe, expect, it, vi } from 'vitest';
import { confirmConnect, confirmText, detectLocale, DIALOG_TIMEOUT_S, powershellScript } from './confirm-dialog.js';
import type { SiteIdentity } from './site-identity.js';

const plain: SiteIdentity = { origin: 'https://app.example.com', url: 'https://app.example.com/api/uncage', registrableDomain: 'example.com', displayHost: 'app.example.com', warnings: [] };
const risky: SiteIdentity = {
  origin: 'https://xn--exmple-4nf.com',
  url: 'https://xn--exmple-4nf.com/api/uncage',
  registrableDomain: 'xn--exmple-4nf.com',
  displayHost: 'xn--exmple-4nf.com',
  warnings: ['idn', 'first_time', 'lookalike'],
  lookalikeOf: 'example.com',
};

const ok = (stdout = '') => vi.fn<ExecFn>(async () => ({ stdout, stderr: '' }));
/** The dialog's own "no": osascript -128, zenity / kdialog exit 1 or 2, PowerShell never rejects on Cancel. */
const cancelled = () =>
  vi.fn<ExecFn>(async () => {
    throw Object.assign(new Error('exit 1'), { code: 1, stderr: 'execution error: User canceled. (-128)' });
  });
/** The dialog could not be shown (no GUI session, stale DISPLAY, broken tool). */
const broken = () =>
  vi.fn<ExecFn>(async () => {
    throw Object.assign(new Error('exit 255'), { code: 255, stderr: 'cannot open display' });
  });
const noFind = async () => null;

describe('confirmText', () => {
  it('English copy, verbatim: what the operator can do, and to connect only trusted sites', () => {
    const t = confirmText(plain, 'en');
    expect(t.title).toBe('Connect this computer?');
    expect(t.body).toBe(
      [
        'Connect this computer to example.com?',
        'https://app.example.com/api/uncage',
        'Whoever runs example.com can then start coding-agent sessions on this computer at any time and answer their approval prompts, within your local policy. Only connect sites you trust.',
      ].join('\n'),
    );
    expect(t.connect).toBe('Connect');
    expect(t.cancel).toBe('Cancel');
  });

  it('warnings come right under the domain line (before the URL), one line each, naming the punycode host and the lookalike', () => {
    const t = confirmText(risky, 'en');
    const lines = t.body.split('\n');
    expect(lines).toHaveLength(6);
    expect(lines[1]).toContain('xn--exmple-4nf.com');
    expect(lines[2]).toMatch(/never connected/i);
    expect(lines[3]).toContain('example.com');
    expect(lines[4]).toBe('https://xn--exmple-4nf.com/api/uncage');
    expect(confirmText({ ...plain, warnings: ['ip'] }, 'en').body.split('\n')).toHaveLength(4);
  });

  it('a path warning names the domain and the URL, in every locale', () => {
    const i: SiteIdentity = { ...plain, url: 'https://script.google.com/macros/s/X/exec', registrableDomain: 'google.com', warnings: ['path'] };
    const lines = confirmText(i, 'en').body.split('\n');
    expect(lines[1]).toBe(
      'This link points to a specific page on google.com: https://script.google.com/macros/s/X/exec. Only continue if you started this from that site.',
    );
    expect(lines[2]).toBe('https://script.google.com/macros/s/X/exec');
    for (const loc of ['zh', 'ja'] as const) expect(confirmText(i, loc).body.split('\n')[1]).toContain('https://script.google.com/macros/s/X/exec');
  });

  it('a long URL is middle-truncated in the dialog (warnings stay visible); the terminal gets the full URL', () => {
    const url = `https://app.example.com/${'a'.repeat(1500)}/end`;
    const i: SiteIdentity = { ...plain, url, warnings: ['path', 'first_time'] };
    const t = confirmText(i, 'en');
    const lines = t.body.split('\n');
    expect(lines[2]).toMatch(/never connected/i);
    expect(lines[3]!.length).toBeLessThanOrEqual(120);
    expect(lines[3]).toMatch(/^https:\/\/app\.example\.com\/a+…a*\/end$/);
    expect(t.body).not.toContain(url);
    expect(t.body.length).toBeLessThan(800);
    expect(confirmText(i, 'en', { fullUrl: true }).body).toContain(url);
  });

  it('zh-CN and ja variants keep the domain and origin', () => {
    for (const loc of ['zh', 'ja'] as const) {
      const t = confirmText(risky, loc);
      expect(t.title).not.toBe('Connect this computer?');
      expect(t.body).toContain('xn--exmple-4nf.com');
      expect(t.body).toContain('https://xn--exmple-4nf.com/api/uncage');
      expect(t.body).toContain('example.com');
      expect(t.body.split('\n')).toHaveLength(6);
    }
    expect(confirmText(plain, 'zh').title).toBe('连接这台电脑？');
    expect(confirmText(plain, 'zh').body).toContain('随时');
    expect(confirmText(plain, 'zh').body).toContain('本地策略');
    expect(confirmText(plain, 'ja').body).toContain('いつでも');
    expect(confirmText(plain, 'ja').body).toContain('ローカルポリシー');
    expect(confirmText(plain, 'ja').title).toBe('このコンピュータを接続しますか？');
  });

  it('detectLocale reads LC_ALL / LC_MESSAGES / LANG, then Intl', () => {
    expect(detectLocale({ LANG: 'zh_CN.UTF-8' })).toBe('zh');
    expect(detectLocale({ LC_ALL: 'ja_JP.UTF-8', LANG: 'en_US.UTF-8' })).toBe('ja');
    expect(detectLocale({ LC_MESSAGES: 'zh_TW.UTF-8' })).toBe('zh');
    expect(detectLocale({ LANG: 'en_US.UTF-8' })).toBe('en');
    expect(detectLocale({ LANG: 'C' }, 'ja-JP')).toBe('ja');
    expect(detectLocale({}, 'zh-Hans-CN')).toBe('zh');
    expect(detectLocale({}, 'de-DE')).toBe('en');
  });
});

describe('confirmConnect', () => {
  it('macOS: /usr/bin/osascript display dialog, Cancel default, text passed as arguments (never in the script)', async () => {
    const exec = ok('button returned:Connect\n');
    expect(await confirmConnect(risky, { platform: 'darwin', exec, isTTY: false, env: { LANG: 'en_US.UTF-8' } })).toBe(true);
    const [file, args] = exec.mock.calls[0]!;
    expect(file).toBe('/usr/bin/osascript');
    const script = args.slice(0, args.indexOf('--')).join('\n');
    expect(script).toContain('display dialog');
    expect(script).toMatch(/buttons \{\(item 3 of argv\), \(item 4 of argv\)\} default button \(item 3 of argv\)/);
    expect(script).not.toContain('example.com');
    const rest = args.slice(args.indexOf('--') + 1);
    expect(rest).toEqual([confirmText(risky, 'en').body, 'Connect this computer?', 'Cancel', 'Connect']);
  });

  it('macOS: Cancel (osascript exits -128), a timeout, or any other answer → false', async () => {
    const prompt = vi.fn(async () => 'y');
    expect(await confirmConnect(plain, { platform: 'darwin', exec: cancelled(), isTTY: true, prompt, out: () => undefined })).toBe(false);
    expect(prompt).not.toHaveBeenCalled(); // Cancel stays cancel: no second chance in the terminal
    expect(await confirmConnect(plain, { platform: 'darwin', exec: ok('button returned:, gave up:true'), isTTY: false })).toBe(false);
    expect(await confirmConnect(plain, { platform: 'darwin', exec: ok('button returned:Cancel'), isTTY: false })).toBe(false);
  });

  it('Windows: powershell.exe via systemTool, -EncodedCommand, MessageBox OKCancel with Cancel (Button2) default', async () => {
    const exec = ok('connect\r\n');
    const env = { SystemRoot: 'D:\\Win', LANG: 'en_US.UTF-8' };
    expect(await confirmConnect(risky, { platform: 'win32', exec, isTTY: false, env })).toBe(true);
    const [file, args] = exec.mock.calls[0]!;
    expect(file).toBe('D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(args.slice(0, 4)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']);
    expect(args[4]).toBe('-EncodedCommand');
    const script = Buffer.from(args[5]!, 'base64').toString('utf16le');
    // WScript.Shell Popup: OK/Cancel (1) + warning (0x30) + Cancel default (0x100) + system modal (0x1000), 600 s timeout.
    expect(script).toContain('.Popup($body, 600, $title, 0x1131)');
    expect(script).toContain("if ($r -eq 1) { 'connect' } else { 'cancel' }");
    expect(script).not.toContain('example.com'); // text travels base64-encoded inside the script
    const b64 = [...script.matchAll(/FromBase64String\('([A-Za-z0-9+/=]*)'\)/g)].map((m) => Buffer.from(m[1]!, 'base64').toString('utf8'));
    expect(b64[0]).toContain(confirmText(risky, 'en').body);
    expect(b64[1]).toBe('Connect this computer?');
    expect(await confirmConnect(plain, { platform: 'win32', exec: ok('cancel'), isTTY: false, env })).toBe(false);
    expect(await confirmConnect(plain, { platform: 'win32', exec: broken(), isTTY: false, env, out: () => undefined })).toBe(false);
  });

  it('Linux: zenity --question (Cancel default, no markup) when found and a display is set', async () => {
    const exec = ok();
    const find = vi.fn(async (c: string) => (c === 'zenity' ? '/usr/bin/zenity' : null));
    expect(await confirmConnect(plain, { platform: 'linux', exec, isTTY: false, env: { DISPLAY: ':0', LANG: 'en_US.UTF-8' }, findCommand: find })).toBe(true);
    const [file, args] = exec.mock.calls[0]!;
    expect(file).toBe('/usr/bin/zenity');
    expect(args).toEqual([
      '--question',
      '--title=Connect this computer?',
      `--text=${confirmText(plain, 'en').body}`,
      '--ok-label=Connect',
      '--cancel-label=Cancel',
      '--default-cancel',
      '--no-markup',
      '--width=440',
      '--timeout=600',
    ]);
    expect(await confirmConnect(plain, { platform: 'linux', exec: cancelled(), isTTY: false, env: { DISPLAY: ':0' }, findCommand: find })).toBe(false);
  });

  it('Linux: zenity is preferred over kdialog when both exist', async () => {
    const exec = ok();
    const find = vi.fn(async (c: string) => `/usr/bin/${c}`);
    await confirmConnect(plain, { platform: 'linux', exec, isTTY: false, env: { DISPLAY: ':0' }, findCommand: find });
    expect(exec.mock.calls[0]![0]).toBe('/usr/bin/zenity');
  });

  it('Linux: kdialog (no zenity) asks with "Don\'t connect" as the default button: Enter / Esc / timeout never connect', async () => {
    const find = vi.fn(async (c: string) => (c === 'kdialog' ? '/usr/bin/kdialog' : null));
    const env = { WAYLAND_DISPLAY: 'wayland-0', LANG: 'en_US.UTF-8' };
    const exitWith = (code: number) =>
      vi.fn<ExecFn>(async () => {
        throw Object.assign(new Error(`exit ${code}`), { code, stderr: '' });
      });
    // Exit 0 is the default button (Yes, labelled "Don't connect"): Enter means no.
    const enter = ok();
    expect(await confirmConnect(plain, { platform: 'linux', exec: enter, isTTY: false, env, findCommand: find })).toBe(false);
    expect(enter).toHaveBeenCalledWith('/usr/bin/kdialog', [
      '--title',
      'Connect this computer?',
      '--warningyesnocancel',
      confirmText(plain, 'en').body,
      '--yes-label',
      "Don't connect",
      '--no-label',
      'Connect',
      '--cancel-label',
      'Cancel',
    ]);
    // Exit 1 (No, labelled Connect) is the only yes; 2 (Cancel / Esc) is no.
    expect(await confirmConnect(plain, { platform: 'linux', exec: exitWith(1), isTTY: false, env, findCommand: find })).toBe(true);
    const prompt = vi.fn(async () => 'y');
    expect(await confirmConnect(plain, { platform: 'linux', exec: exitWith(2), isTTY: true, prompt, env, findCommand: find })).toBe(false);
    expect(prompt).not.toHaveBeenCalled();
  });

  it('a dialog that could not be shown (not Cancel) falls back to the terminal, else explains and refuses', async () => {
    for (const [platform, env, find] of [
      ['darwin', {}, undefined],
      ['win32', { SystemRoot: 'C:\\Windows' }, undefined],
      ['linux', { DISPLAY: ':9' }, async () => '/usr/bin/zenity'],
    ] as const) {
      const out = vi.fn();
      const prompt = vi.fn(async () => 'yes');
      const base = { platform, env, ...(find ? { findCommand: find } : {}) };
      expect(await confirmConnect(plain, { ...base, exec: broken(), isTTY: true, prompt, out })).toBe(true);
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(out.mock.calls.flat().join('\n')).toMatch(/dialog could not be shown/i);
      const out2 = vi.fn();
      expect(await confirmConnect(plain, { ...base, exec: broken(), isTTY: false, out: out2 })).toBe(false);
      expect(out2.mock.calls.flat().join('\n')).toMatch(/could not ask/i);
    }
  });

  it('Linux without a display skips the GUI tools and asks in the terminal', async () => {
    const exec = ok();
    const find = vi.fn(async () => '/usr/bin/zenity');
    const prompt = vi.fn(async () => 'y');
    const out = vi.fn();
    expect(await confirmConnect(plain, { platform: 'linux', exec, isTTY: true, env: {}, findCommand: find, prompt, out })).toBe(true);
    expect(exec).not.toHaveBeenCalled();
    expect(out.mock.calls.flat().join('\n')).toContain('Connect this computer to example.com?');
    expect(prompt).toHaveBeenCalledWith(expect.stringMatching(/\[y\/N\]/), expect.any(AbortSignal));
  });

  it('every prompt gives up like the macOS dialog (600 s); giving up is a cancel', async () => {
    expect(DIALOG_TIMEOUT_S).toBe(600);
    // kdialog has no timeout of its own: coreutils timeout(1) wraps it; 124 (timed out) is a no.
    const find = vi.fn(async (c: string) => (c === 'kdialog' ? '/usr/bin/kdialog' : c === 'timeout' ? '/usr/bin/timeout' : null));
    const exec = vi.fn<ExecFn>(async () => {
      throw Object.assign(new Error('exit 1'), { code: 1, stderr: '' });
    });
    expect(await confirmConnect(plain, { platform: 'linux', exec, isTTY: false, env: { DISPLAY: ':0', LANG: 'en_US.UTF-8' }, findCommand: find })).toBe(true);
    expect(exec.mock.calls[0]![0]).toBe('/usr/bin/timeout');
    expect(exec.mock.calls[0]![1].slice(0, 3)).toEqual(['600', '/usr/bin/kdialog', '--title']);
    const timedOut = vi.fn<ExecFn>(async () => {
      throw Object.assign(new Error('exit 124'), { code: 124, stderr: '' });
    });
    const prompt = vi.fn(async () => 'y');
    expect(await confirmConnect(plain, { platform: 'linux', exec: timedOut, isTTY: true, prompt, env: { DISPLAY: ':0' }, findCommand: find, out: () => undefined })).toBe(false);
    expect(prompt).not.toHaveBeenCalled(); // a timeout is a cancel, not "could not be shown"

    // Any dialog that never returns (kdialog without timeout(1), a stuck PowerShell) is cut off: no.
    const hang = vi.fn<ExecFn>(() => new Promise(() => undefined));
    const kdOnly = async (c: string) => (c === 'kdialog' ? '/usr/bin/kdialog' : null);
    for (const [platform, env, findCommand] of [
      ['linux', { DISPLAY: ':0' }, kdOnly],
      ['win32', { SystemRoot: 'C:\\Windows' }, undefined],
      ['darwin', {}, undefined],
    ] as const) {
      const p2 = vi.fn(async () => 'y');
      expect(await confirmConnect(plain, { platform, exec: hang, isTTY: true, prompt: p2, env, ...(findCommand ? { findCommand } : {}), timeoutMs: 30, out: () => undefined })).toBe(false);
      expect(p2).not.toHaveBeenCalled();
    }

    // The terminal question too: no answer in time is a no, and the question is aborted.
    let signal: AbortSignal | undefined;
    const silent = vi.fn((_q: string, s?: AbortSignal) => {
      signal = s;
      return new Promise<string>(() => undefined);
    });
    const out = vi.fn();
    expect(await confirmConnect(plain, { platform: 'freebsd', exec: ok(), isTTY: true, prompt: silent, env: {}, timeoutMs: 30, out })).toBe(false);
    expect(signal?.aborted).toBe(true);
    expect(out.mock.calls.flat().join('\n')).toMatch(/no answer/i);
  });

  it('the terminal fallback prints the full URL (no truncation there)', async () => {
    const url = `https://app.example.com/${'b'.repeat(400)}`;
    const out = vi.fn();
    await confirmConnect({ ...plain, url, warnings: ['path'] }, { platform: 'freebsd', exec: ok(), isTTY: true, prompt: async () => 'n', env: {}, out });
    expect(out.mock.calls.flat().join('\n')).toContain(url);
  });

  it('terminal prompt: only y / yes connects (default No)', async () => {
    for (const [answer, want] of [
      ['y', true],
      ['YES', true],
      ['', false],
      ['n', false],
      ['connect', false],
    ] as const) {
      expect(await confirmConnect(plain, { platform: 'freebsd', exec: ok(), isTTY: true, prompt: async () => answer, env: {}, out: () => undefined })).toBe(want);
    }
  });

  it('returns false when nothing can ask (no GUI tool, no TTY)', async () => {
    const exec = ok();
    const out = vi.fn();
    expect(await confirmConnect(plain, { platform: 'linux', exec, isTTY: false, env: { DISPLAY: ':0' }, findCommand: noFind, out })).toBe(false);
    expect(await confirmConnect(plain, { platform: 'freebsd', exec, isTTY: false, env: {}, out })).toBe(false);
    expect(await confirmConnect(plain, { platform: 'linux', exec, isTTY: true, env: {}, findCommand: noFind, out })).toBe(false); // TTY but no prompt function
    expect(exec).not.toHaveBeenCalled();
    expect(out.mock.calls.flat().join('\n')).toMatch(/could not ask/i);
  });
});

/**
 * The REAL Windows Popup, on a CI runner only (CI + UNCAGE_URL_HANDLER_TESTS=1, like the real
 * handler tests; never on a developer machine): the same script with a 1-second timeout must give
 * up (-1) and print `cancel`, proving the COM call and the timeout mapping.
 */
const realWindows = process.platform === 'win32' && !!process.env.CI && process.env.UNCAGE_URL_HANDLER_TESTS === '1';
describe.runIf(realWindows)('real Windows Popup (CI runner only)', () => {
  it('a Popup nobody answers gives up after 1 s and maps to cancel', async () => {
    const script = powershellScript('Uncage CI', 'Nobody answers this (CI smoke test).', 1);
    const t0 = Date.now();
    const { stdout } = await promisify(execFile)(
      `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { encoding: 'utf8', windowsHide: true, timeout: 60_000 },
    );
    console.log(`::notice title=confirm-dialog Windows::Popup returned ${JSON.stringify(stdout.trim())} after ${Date.now() - t0} ms`);
    expect(stdout.trim()).toBe('cancel');
  }, 90_000);
});
