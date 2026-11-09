import type { ExecFn } from '@uncage/agent';
import { describe, expect, it, vi } from 'vitest';
import { confirmConnect, confirmText, detectLocale } from './confirm-dialog.js';
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
  it('English copy, verbatim', () => {
    const t = confirmText(plain, 'en');
    expect(t.title).toBe('Connect this computer?');
    expect(t.body).toBe(
      'Connect this computer to example.com?\nhttps://app.example.com/api/uncage\nIt will be able to start coding-agent sessions on this computer when you use that site.',
    );
    expect(t.connect).toBe('Connect');
    expect(t.cancel).toBe('Cancel');
  });

  it('one line per warning, naming the punycode host and the lookalike', () => {
    const t = confirmText(risky, 'en');
    const lines = t.body.split('\n').slice(3);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('xn--exmple-4nf.com');
    expect(lines[1]).toMatch(/never connected/i);
    expect(lines[2]).toContain('example.com');
    expect(confirmText({ ...plain, warnings: ['ip'] }, 'en').body.split('\n')).toHaveLength(4);
  });

  it('a path warning names the domain and the full URL, in every locale', () => {
    const i: SiteIdentity = { ...plain, url: 'https://script.google.com/macros/s/X/exec', registrableDomain: 'google.com', warnings: ['path'] };
    const lines = confirmText(i, 'en').body.split('\n');
    expect(lines[1]).toBe('https://script.google.com/macros/s/X/exec');
    expect(lines[3]).toBe(
      'This link points to a specific page on google.com: https://script.google.com/macros/s/X/exec. Only continue if you started this from that site.',
    );
    for (const loc of ['zh', 'ja'] as const) expect(confirmText(i, loc).body.split('\n')[3]).toContain('https://script.google.com/macros/s/X/exec');
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
    expect(script).toContain('[System.Windows.Forms.MessageBox]::Show(');
    expect(script).toContain("'OKCancel'");
    expect(script).toContain("'Button2'");
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
    ]);
    expect(await confirmConnect(plain, { platform: 'linux', exec: cancelled(), isTTY: false, env: { DISPLAY: ':0' }, findCommand: find })).toBe(false);
  });

  it('Linux: kdialog --warningcontinuecancel (Cancel default) when zenity is missing (Wayland display)', async () => {
    const exec = ok();
    const find = vi.fn(async (c: string) => (c === 'kdialog' ? '/usr/bin/kdialog' : null));
    expect(await confirmConnect(plain, { platform: 'linux', exec, isTTY: false, env: { WAYLAND_DISPLAY: 'wayland-0', LANG: 'en_US.UTF-8' }, findCommand: find })).toBe(true);
    expect(exec).toHaveBeenCalledWith('/usr/bin/kdialog', [
      '--title',
      'Connect this computer?',
      '--warningcontinuecancel',
      confirmText(plain, 'en').body,
      '--continue-label',
      'Connect',
      '--cancel-label',
      'Cancel',
    ]);
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
    expect(prompt).toHaveBeenCalledWith(expect.stringMatching(/\[y\/N\]/));
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
