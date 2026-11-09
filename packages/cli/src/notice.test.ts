import type { ExecFn } from '@uncage/agent';
import { describe, expect, it, vi } from 'vitest';
import { connectNotice, NOTICE_TIMEOUT_S, showNotice } from './notice.js';

const ok = () => vi.fn<ExecFn>(async () => ({ stdout: '', stderr: '' }));

describe('connectNotice', () => {
  it('connected / not connected with the reason, in every locale', () => {
    expect(connectNotice({ ok: true, domain: 'example.com' }, 'en')).toEqual({
      ok: true,
      title: 'Connected to example.com',
      body: 'example.com can now use this computer. See or disconnect it with: uncage dashboard',
    });
    expect(connectNotice({ ok: false, domain: 'example.com', reason: 'The approval expired.' }, 'en')).toEqual({
      ok: false,
      title: 'Not connected to example.com',
      body: 'The approval expired.',
    });
    expect(connectNotice({ ok: false, reason: 'Bad link.' }, 'en').title).toBe('Uncage: not connected');
    expect(connectNotice({ ok: true, domain: 'example.com' }, 'zh').title).toBe('已连接到 example.com');
    expect(connectNotice({ ok: false, domain: 'example.com', reason: 'x' }, 'ja').title).toBe('example.com に接続できませんでした');
  });

  it('strips control / escape characters and caps the reason', () => {
    const n = connectNotice({ ok: false, domain: 'example.com', reason: `bad\u001b]0;pwned\u0007 ${'r'.repeat(1000)}` }, 'en');
    expect(n.body).not.toMatch(/\p{Cc}/u);
    expect(n.body.length).toBeLessThanOrEqual(300);
  });
});

describe('showNotice', () => {
  const n = { ok: false, title: 'Not connected to example.com', body: 'The approval expired.' };

  it('macOS: osascript display notification, texts only in argv', async () => {
    const exec = ok();
    await showNotice(n, { platform: 'darwin', exec, env: {} });
    const [file, args] = exec.mock.calls[0]!;
    expect(file).toBe('/usr/bin/osascript');
    const script = args.slice(0, args.indexOf('--')).filter((a) => a !== '-e');
    expect(script).toEqual(['on run argv', 'display notification (item 1 of argv) with title (item 2 of argv)', 'end run']);
    expect(args.slice(args.indexOf('--') + 1)).toEqual([n.body, n.title]);
  });

  it('Linux: notify-send when present (options end before the texts), nothing otherwise', async () => {
    const exec = ok();
    await showNotice(n, { platform: 'linux', exec, env: {}, findCommand: async (c) => (c === 'notify-send' ? '/usr/bin/notify-send' : null) });
    expect(exec).toHaveBeenCalledWith('/usr/bin/notify-send', ['--app-name=Uncage', '--urgency=normal', '--', n.title, n.body]);
    const none = ok();
    await showNotice(n, { platform: 'linux', exec: none, env: {}, findCommand: async () => null });
    expect(none).not.toHaveBeenCalled();
  });

  it('Windows: a PowerShell Popup that closes by itself, texts base64-encoded', async () => {
    const exec = ok();
    await showNotice(n, { platform: 'win32', exec, env: { SystemRoot: 'C:\\Windows' } });
    const [file, args] = exec.mock.calls[0]!;
    expect(file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(args.slice(0, 5)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
    const script = Buffer.from(args[5]!, 'base64').toString('utf16le');
    expect(script).toContain(`.Popup($body, ${NOTICE_TIMEOUT_S}, $title, 0x1030)`);
    expect(script).not.toContain('example.com');
    const okScript = Buffer.from((await (async () => {
      const e = ok();
      await showNotice({ ...n, ok: true }, { platform: 'win32', exec: e, env: { SystemRoot: 'C:\\Windows' } });
      return e.mock.calls[0]![1][5]!;
    })()), 'base64').toString('utf16le');
    expect(okScript).toContain(`0x1040)`);
  });

  it('never throws (a notice is best effort)', async () => {
    const broken = vi.fn<ExecFn>(async () => {
      throw new Error('no GUI');
    });
    await expect(showNotice(n, { platform: 'darwin', exec: broken, env: {} })).resolves.toBeUndefined();
    await expect(showNotice(n, { platform: 'freebsd', exec: broken, env: {} })).resolves.toBeUndefined();
    expect(broken).toHaveBeenCalledTimes(1);
  });
});
