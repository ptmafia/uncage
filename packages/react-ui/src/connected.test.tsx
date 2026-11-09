import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { MachineInfo } from '@uncage/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentChat,
  AgentOutdatedNotice,
  ApproveDevice,
  Composer,
  ConnectMachine,
  UncageProvider,
  UncageUIProvider,
  type AgentChatProps,
  type ApproveDeviceProps,
} from './index.js';
import { clientError, fakeClient, INSTALL, machine, runtime, session, snapshot } from './test-fixtures.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
  window.localStorage.clear();
});

type Fake = ReturnType<typeof fakeClient>;

const renderChat = (f: Fake, props: AgentChatProps = {}) =>
  render(
    <UncageProvider client={f.client}>
      <AgentChat {...props} />
    </UncageProvider>,
  );

const textbox = () => screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;

/** Fakes only the interval timers (store polling), so RTL's waitFor keeps working. */
const fakeIntervals = () => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

describe('Local Mode (daemon without /machines)', () => {
  it('behaves exactly as before: no computer UI, no error, sessions created without machineId, no polling', async () => {
    fakeIntervals();
    const f = fakeClient();
    renderChat(f);
    await screen.findByRole('heading', { name: 'Start a session with Claude Code' });
    await waitFor(() => expect(f.client.machines).toHaveBeenCalledTimes(1));
    // No header in a draft, no machine picker, no connect dialog, no error banner.
    expect(screen.queryByRole('banner')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Computer:/ })).toBeNull();
    expect(screen.queryByText('Connect your computer')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(textbox().disabled).toBe(false);
    await advance(30_000);
    expect(f.client.machines).toHaveBeenCalledTimes(1);

    fireEvent.change(textbox(), { target: { value: 'hello' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send' })));
    await waitFor(() => expect(f.client.startRun).toHaveBeenCalled());
    expect(f.client.createSession).toHaveBeenCalledWith({ runtime: 'claude' });
    expect(Object.keys(f.client.createSession.mock.calls[0]![0])).not.toContain('machineId');
    // The open session's header is the same as before: title and runtime, no computer.
    const header = await screen.findByRole('banner');
    expect(within(header).getByRole('heading', { name: 'Fix the build' })).toBeTruthy();
    expect(within(header).getByText('Claude Code')).toBeTruthy();
    expect(within(header).queryByRole('button')).toBeNull();
  });
});

describe('connected mode: no computer yet', () => {
  it('the empty state is ConnectMachine with the hub commands; the composer is disabled', async () => {
    const f = fakeClient({ machines: [] });
    renderChat(f);
    const region = await screen.findByRole('region', { name: 'Connect your computer' });
    expect(within(region).getByText(/Run one command on the computer/)).toBeTruthy();
    await within(region).findByText(INSTALL.install);
    expect(within(region).getByText('Run this command on your computer')).toBeTruthy();
    expect(within(region).getByText(/asks before installing anything/)).toBeTruthy();
    expect(within(region).getByText('Already have the CLI?')).toBeTruthy();
    expect(within(region).getByText(INSTALL.setup)).toBeTruthy();
    expect(within(region).getByText('Waiting for your computer…')).toBeTruthy();
    // Inline: no Cancel.
    expect(within(region).queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(textbox().disabled).toBe(true);
    expect(screen.getByText('Connect your computer to start.')).toBeTruthy();
  });

  it('switches to "Connected: <name>" when the computer comes online, then to the new-session view', async () => {
    fakeIntervals();
    let list: MachineInfo[] = [];
    const f = fakeClient({ machines: () => list });
    renderChat(f);
    const region = await screen.findByRole('region', { name: 'Connect your computer' });
    await within(region).findByText(INSTALL.setup);
    list = [machine({ name: 'Studio Mac' })];
    await advance(3000);
    expect(within(region).getByText('Connected: Studio Mac')).toBeTruthy();
    // Shortly after, the regular empty state with the computer's runtime takes over.
    await screen.findByRole('heading', { name: 'Start a session with Claude Code' }, { timeout: 3000 });
    expect(screen.queryByRole('region', { name: 'Connect your computer' })).toBeNull();
    expect(textbox().disabled).toBe(false);
    expect(screen.getByRole('button', { name: 'Computer: Studio Mac (online)' })).toBeTruthy();
  });

  it('Windows tab shows the PowerShell command; tabs are keyboard operable', async () => {
    const f = fakeClient({ machines: [] });
    renderChat(f);
    const region = await screen.findByRole('region', { name: 'Connect your computer' });
    await within(region).findByText(INSTALL.install);
    const unix = within(region).getByRole('tab', { name: 'macOS / Linux' });
    expect(unix.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(unix, { key: 'ArrowRight' });
    const win = within(region).getByRole('tab', { name: 'Windows' });
    expect(win.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(win);
    expect(within(region).getByText(INSTALL.windows!)).toBeTruthy();
    expect(within(region).queryByText('Coming soon')).toBeNull();
    expect(within(region).queryByText(INSTALL.install)).toBeNull();
  });

  it('ConnectMachine shows one command, picks the Windows tab on Windows, and offers uncage setup for an installed CLI', async () => {
    const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32');
    try {
      const f = fakeClient({ machines: [] });
      renderChat(f);
      const region = await screen.findByRole('region', { name: 'Connect your computer' });
      await within(region).findByText(INSTALL.windows!);
      expect(within(region).getByRole('tab', { name: 'Windows' }).getAttribute('aria-selected')).toBe('true');
      expect(within(region).queryByText(INSTALL.install)).toBeNull();
      // One step only: no second "Start the agent" heading; the setup command is the secondary line.
      expect(within(region).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Run this command on your computer']);
      expect(within(region).getByText('Already have the CLI?')).toBeTruthy();
      expect(within(region).getByRole('button', { name: `Copy command: ${INSTALL.setup}` })).toBeTruthy();
      fireEvent.click(within(region).getByRole('tab', { name: 'macOS / Linux' }));
      expect(within(region).getByText(INSTALL.install)).toBeTruthy();
    } finally {
      platform.mockRestore();
    }
  });

  it('ConnectMachine links installInfo.connectUrl for one-click connect on every desktop OS tab', async () => {
    const connectUrl = 'uncage://connect?url=https%3A%2F%2Fsite.test%2Fapi%2Funcage';
    const f = fakeClient({ machines: [] });
    f.client.installInfo.mockResolvedValue({ ...INSTALL, connectUrl });
    renderChat(f);
    const region = await screen.findByRole('region', { name: 'Connect your computer' });
    for (const tab of ['macOS / Linux', 'Windows']) {
      fireEvent.click(await within(region).findByRole('tab', { name: tab }));
      const link = await within(region).findByRole('link', { name: 'Already use Uncage on this computer? Connect in one click' });
      expect(link.getAttribute('href')).toBe(connectUrl);
      expect(region.textContent).toContain('Your browser will ask to open Uncage.');
    }
  });

  it('hides one-click connect when connectUrl is absent or on a mobile user agent', async () => {
    const connectUrl = 'uncage://connect?url=https%3A%2F%2Fsite.test%2Fapi%2Funcage';
    const f = fakeClient({ machines: [] });
    renderChat(f);
    let region = await screen.findByRole('region', { name: 'Connect your computer' });
    await within(region).findByText(INSTALL.install);
    expect(within(region).queryByRole('link', { name: /Connect in one click/ })).toBeNull();
    cleanup();

    for (const ua of [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile',
    ]) {
      const spy = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua);
      const g = fakeClient({ machines: [] });
      g.client.installInfo.mockResolvedValue({ ...INSTALL, connectUrl });
      renderChat(g);
      region = await screen.findByRole('region', { name: 'Connect your computer' });
      await within(region).findByText(INSTALL.install);
      expect(within(region).queryByRole('link', { name: /Connect in one click/ })).toBeNull();
      cleanup();
      spy.mockRestore();
    }
  });

  it('Windows tab says the site offers no Windows command when the hub has none', async () => {
    const f = fakeClient({ machines: [] });
    f.client.installInfo.mockResolvedValue({ ...INSTALL, windows: null });
    renderChat(f);
    const region = await screen.findByRole('region', { name: 'Connect your computer' });
    await within(region).findByText(INSTALL.install);
    fireEvent.click(within(region).getByRole('tab', { name: 'Windows' }));
    expect(within(region).getByText("This site doesn't offer a Windows command.")).toBeTruthy();
    expect(within(region).queryByText('Coming soon')).toBeNull();
  });

  it('a failed copy says so and asks to select the text', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) }, configurable: true });
    Object.defineProperty(document, 'execCommand', { value: () => false, configurable: true });
    const f = fakeClient({ machines: [] });
    renderChat(f, { locale: 'zh-CN' });
    const btn = await screen.findByRole('button', { name: `复制命令：${INSTALL.setup}` });
    await act(async () => fireEvent.click(btn));
    expect(btn.getAttribute('title')).toBe('复制失败，请手动选择文本');
    expect(screen.getAllByRole('status').some((n) => n.textContent === '复制失败，请手动选择文本')).toBe(true);
  });

  it('copy buttons write the command to the clipboard and say Copied', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const f = fakeClient({ machines: [] });
    renderChat(f);
    const btn = await screen.findByRole('button', { name: `Copy command: ${INSTALL.setup}` });
    await act(async () => fireEvent.click(btn));
    expect(writeText).toHaveBeenCalledWith(INSTALL.setup);
    expect(btn.getAttribute('title')).toBe('Copied');
  });

  it('"That computer can\'t open a browser?" reveals the --no-browser command', async () => {
    const f = fakeClient({ machines: [] });
    renderChat(f);
    const region = await screen.findByRole('region', { name: 'Connect your computer' });
    await within(region).findByText(INSTALL.setup);
    expect(within(region).getByText("That computer can't open a browser?")).toBeTruthy();
    expect(within(region).getByText(`${INSTALL.setup} --no-browser`)).toBeTruthy();
    expect(within(region).getByText(/prints a link and a code/)).toBeTruthy();
  });

  it('a failed install-info request (rate_limited) shows a localized error and Retry', async () => {
    const f = fakeClient({ machines: [] });
    f.client.installInfo.mockRejectedValueOnce(clientError('rate_limited', 429, 'Too many requests.'));
    renderChat(f, { locale: 'zh-CN' });
    const region = await screen.findByRole('region', { name: '连接你的电脑' });
    await within(region).findByText('请求太频繁了，稍等一下再试。');
    await act(async () => fireEvent.click(within(region).getByRole('button', { name: '重试' })));
    await within(region).findByText(INSTALL.install);
    expect(f.client.installInfo).toHaveBeenCalledTimes(2);
  });

  it('zh-CN copy matches the reference dialog', async () => {
    const f = fakeClient({ machines: [] });
    renderChat(f, { locale: 'zh-CN' });
    const region = await screen.findByRole('region', { name: '连接你的电脑' });
    expect(within(region).getByText('在要连接的电脑上运行一条命令。守护进程一上线，这里就会自动识别。')).toBeTruthy();
    expect(within(region).getByText('在你的电脑上运行这条命令')).toBeTruthy();
    expect(within(region).getByText(/之前都会先征求你的同意；然后打开浏览器登录，并在后台保持守护进程运行。$/)).toBeTruthy();
    expect(within(region).getByText('等待你的电脑上线…')).toBeTruthy();
    expect(within(region).getByText('那台电脑打不开浏览器？')).toBeTruthy();
    expect(within(region).getByText('已经装好 CLI？')).toBeTruthy();
    fireEvent.click(within(region).getByRole('tab', { name: 'Windows' }));
    expect(within(region).getByText(INSTALL.windows!)).toBeTruthy();
  });
});

describe('connected mode: machine status and picker', () => {
  const two = () => [
    machine({ id: 'mac_1', name: 'MacBook Pro' }),
    machine({ id: 'mac_2', name: 'Linux Box', os: 'linux', online: false, runtimes: [runtime({ id: 'codex', displayName: 'Codex' })] }),
  ];

  it('the header shows the computer; the picker lists computers and sessions run on the chosen one', async () => {
    const f = fakeClient({ machines: two() });
    renderChat(f);
    const trigger = await screen.findByRole('button', { name: 'Computer: MacBook Pro (online)' });
    fireEvent.click(trigger);
    const menu = screen.getByRole('menu', { name: 'Choose a computer' });
    const items = within(menu).getAllByRole('menuitemradio');
    expect(items.map((i) => i.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    expect(within(menu).getByText(/macOS · Online/)).toBeTruthy();
    expect(within(menu).getByText(/Linux · Offline · seen/)).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: 'Connect another computer…' })).toBeTruthy();
    fireEvent.click(items[1]!);
    expect(screen.getByRole('button', { name: 'Computer: Linux Box (offline)' })).toBeTruthy();
    // The chosen computer's runtimes drive the empty state.
    await screen.findByRole('heading', { name: 'Start a session with Codex' });
  });

  it('sends create the session on the selected computer', async () => {
    const f = fakeClient({ machines: two() });
    renderChat(f);
    await screen.findByRole('button', { name: 'Computer: MacBook Pro (online)' });
    fireEvent.change(textbox(), { target: { value: 'hello' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send' })));
    await waitFor(() => expect(f.client.startRun).toHaveBeenCalled());
    expect(f.client.createSession).toHaveBeenCalledWith({ runtime: 'claude', machineId: 'mac_1' });
  });

  it('selected computer offline: composer disabled with the reconnect hint; back online re-enables it', async () => {
    fakeIntervals();
    let online = false;
    const f = fakeClient({ machines: () => [machine({ online })] });
    renderChat(f);
    await screen.findByRole('button', { name: 'Computer: MacBook Pro (offline)' });
    expect(textbox().disabled).toBe(true);
    const banner = screen.getByText(/Your computer is offline\. Waiting for it to reconnect…/).closest('[role="status"]')!;
    expect(within(banner as HTMLElement).getByText('uncage agent')).toBeTruthy();
    online = true;
    await advance(5000);
    expect(screen.getByRole('button', { name: 'Computer: MacBook Pro (online)' })).toBeTruthy();
    expect(textbox().disabled).toBe(false);
    expect(screen.queryByText(/Your computer is offline/)).toBeNull();
  });

  it('zh-CN offline copy', async () => {
    const f = fakeClient({ machines: [machine({ online: false })] });
    renderChat(f, { locale: 'zh-CN' });
    await screen.findByText(/你的电脑离线了，等待重新连接…/);
    expect(screen.getByText('uncage agent')).toBeTruthy();
  });

  it('AgentOutdatedNotice shows the upgrade command with the site setup command for an outdated computer', async () => {
    // A 0.2 agent refused by the hub: offline and outdated. One notice replaces the offline banner.
    const f = fakeClient({ machines: [machine({ agentOutdated: true, online: false, agentVersion: '0.2.0' })] });
    renderChat(f);
    const status = await screen.findByRole('status');
    expect(status.textContent).toContain("This computer's Uncage agent is too old for this website.");
    expect(status.textContent).toContain('npm i -g @uncage/cli@latest');
    await waitFor(() => expect(status.textContent).toContain(INSTALL.setup));
    expect(within(status).getByText('npm i -g @uncage/cli@latest').tagName).toBe('CODE');
    expect(within(status).getByText(INSTALL.setup).tagName).toBe('CODE');
    expect(screen.queryByText(/Your computer is offline/)).toBeNull();
    expect(screen.getAllByText('npm i -g @uncage/cli@latest')).toHaveLength(1);
    expect(textbox().disabled).toBe(true);
  });

  it('AgentOutdatedNotice zh-CN copy; nothing for an up-to-date computer', async () => {
    const f = fakeClient({ machines: [machine({ agentOutdated: true, online: false })] });
    renderChat(f, { locale: 'zh-CN' });
    const status = await screen.findByRole('status');
    await waitFor(() =>
      expect(status.textContent).toContain(
        `这台电脑上的 Uncage 守护进程版本过旧。请在那台电脑上运行 npm i -g @uncage/cli@latest，然后运行 ${INSTALL.setup} 重新连接。`,
      ),
    );
    cleanup();
    const g = fakeClient({ machines: [machine()] });
    renderChat(g);
    await screen.findByRole('button', { name: 'Computer: MacBook Pro (online)' });
    expect(screen.queryByText(/too old/)).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('a standalone <Composer> (custom layout) shows the same single explanation in its offline banner slot', async () => {
    const f = fakeClient({ machines: [machine({ agentOutdated: true, online: false })] });
    render(
      <UncageProvider client={f.client}>
        <UncageUIProvider>
          <Composer />
        </UncageUIProvider>
      </UncageProvider>,
    );
    await waitFor(() => expect(screen.getAllByRole('status')).toHaveLength(1));
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('npm i -g @uncage/cli@latest');
    await waitFor(() => expect(status.textContent).toContain(INSTALL.setup));
    expect(screen.queryByText(/Your computer is offline/)).toBeNull();
    expect(screen.getAllByText('npm i -g @uncage/cli@latest')).toHaveLength(1);
  });

  it('AgentOutdatedNotice renders nothing for an up-to-date machine (standalone)', () => {
    const { container } = render(
      <UncageProvider client={fakeClient().client}>
        <UncageUIProvider>
          <AgentOutdatedNotice machine={machine()} />
        </UncageUIProvider>
      </UncageProvider>,
    );
    expect(container.innerHTML).toBe('');
  });

  it('MachineStatus lists an outdated computer as "Agent update needed"', async () => {
    const f = fakeClient({ machines: [machine(), machine({ id: 'mac_2', name: 'Old Box', os: 'linux', online: false, agentOutdated: true })] });
    renderChat(f);
    fireEvent.click(await screen.findByRole('button', { name: 'Computer: MacBook Pro (online)' }));
    const menu = screen.getByRole('menu', { name: 'Choose a computer' });
    expect(within(menu).getByText('Linux · Agent update needed')).toBeTruthy();
    expect(within(menu).getByText('macOS · Online')).toBeTruthy();
    // Screen readers hear the runtime names (the icons are decorative).
    const item = within(menu).getByRole('menuitemradio', { name: 'MacBook Pro' });
    const desc = document.getElementById(item.getAttribute('aria-describedby') ?? '');
    expect(desc?.textContent).toBe(`macOS · Online · ${machine().runtimes[0]!.displayName}`);
    cleanup();
    const g = fakeClient({ machines: [machine({ online: false, agentOutdated: true })] });
    renderChat(g, { locale: 'zh-CN' });
    fireEvent.click(await screen.findByRole('button', { name: /^电脑：MacBook Pro/ }));
    expect(within(screen.getByRole('menu')).getByText('macOS · 需要更新守护进程')).toBeTruthy();
  });

  it('"Connect another computer…" opens the dialog; it polls every 3 s while open and Cancel / Esc close it', async () => {
    fakeIntervals();
    const f = fakeClient({ machines: [machine()] });
    renderChat(f);
    fireEvent.click(await screen.findByRole('button', { name: 'Computer: MacBook Pro (online)' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Connect another computer…' }));
    const dialog = screen.getByRole('dialog', { name: 'Connect your computer' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    await within(dialog).findByText(INSTALL.install);
    const n = f.client.machines.mock.calls.length;
    await advance(3000);
    expect(f.client.machines.mock.calls.length).toBe(n + 1);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    // Closed: only the 5 s status refresh remains.
    const m = f.client.machines.mock.calls.length;
    await advance(3000);
    expect(f.client.machines.mock.calls.length).toBe(m);

    fireEvent.click(screen.getByRole('button', { name: 'Computer: MacBook Pro (online)' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Connect another computer…' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('the dialog detects a new computer, selects it and offers Done', async () => {
    fakeIntervals();
    let list = [machine()];
    const f = fakeClient({ machines: () => list });
    const onConnected = vi.fn();
    const onClose = vi.fn();
    render(
      <UncageProvider client={f.client}>
        <ConnectMachine onConnected={onConnected} onClose={onClose} />
      </UncageProvider>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Connect your computer' });
    await within(dialog).findByText(INSTALL.install);
    await advance(0);
    list = [machine(), machine({ id: 'mac_9', name: 'New Box' })];
    await advance(3000);
    expect(within(dialog).getByText('Connected: New Box')).toBeTruthy();
    expect(onConnected).toHaveBeenCalledWith(expect.objectContaining({ id: 'mac_9' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('a known computer reconnecting counts as connected', async () => {
    fakeIntervals();
    let online = true;
    const f = fakeClient({ machines: () => [machine({ online })] });
    const onConnected = vi.fn();
    render(
      <UncageProvider client={f.client}>
        <ConnectMachine variant="inline" onConnected={onConnected} />
      </UncageProvider>,
    );
    await advance(0);
    online = false;
    await advance(3000);
    expect(onConnected).not.toHaveBeenCalled();
    online = true;
    await advance(3000);
    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  it('the open session\'s own computer drives the offline state, not the selected one (also after a reload)', async () => {
    const onB = session({ machineId: 'mac_2' });
    const f = fakeClient({ machines: two(), sessions: [onB], snapshot: () => snapshot({ session: onB }) });
    window.history.replaceState(null, '', '/?session=ses_1'); // a reload with the session in the URL
    renderChat(f);
    await screen.findByRole('heading', { name: 'Fix the build' });
    await screen.findByRole('button', { name: 'Computer: Linux Box (offline)' });
    await waitFor(() => expect(textbox().disabled).toBe(true));
    expect(screen.getByText(/Your computer is offline/)).toBeTruthy();
  });

  it('a computer connected from the dialog while a session runs elsewhere starts a new session draft', async () => {
    fakeIntervals();
    let list = [machine({ id: 'mac_1', name: 'MacBook Pro' })];
    const f = fakeClient({ machines: () => list, sessions: [session({ machineId: 'mac_1' })], snapshot: () => snapshot({ session: session({ machineId: 'mac_1' }) }) });
    renderChat(f);
    const item = await screen.findByRole('button', { name: /Fix the build/ });
    await act(async () => fireEvent.click(item));
    await screen.findByRole('heading', { name: 'Fix the build' });
    fireEvent.click(screen.getByRole('button', { name: 'Computer: MacBook Pro (online)' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Connect another computer…' }));
    const dialog = screen.getByRole('dialog');
    await within(dialog).findByText(INSTALL.install);
    list = [...list, machine({ id: 'mac_9', name: 'New Box', runtimes: [runtime({ id: 'codex', displayName: 'Codex' })] })];
    await advance(3000);
    expect(within(dialog).getByText('Connected: New Box')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    await screen.findByRole('heading', { name: 'Start a session with Codex' });
    expect(screen.getByRole('button', { name: 'Computer: New Box (online)' })).toBeTruthy();
  });

  it('the dialog focus trap skips the inactive tab (tabindex=-1)', async () => {
    const f = fakeClient({ machines: [machine()] });
    render(
      <UncageProvider client={f.client}>
        <ConnectMachine onClose={() => undefined} />
      </UncageProvider>,
    );
    const dialog = screen.getByRole('dialog');
    await within(dialog).findByText(INSTALL.install);
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    cancel.focus();
    fireEvent.keyDown(cancel, { key: 'Tab' });
    expect(document.activeElement).toBe(within(dialog).getByRole('tab', { name: 'macOS / Linux' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(cancel);
    // The inactive Windows tab is never a tab stop.
    expect(within(dialog).getByRole('tab', { name: 'Windows' }).getAttribute('tabindex')).toBe('-1');
  });

  it('picking another computer with a session open starts a new session draft', async () => {
    const f = fakeClient({ machines: two(), sessions: [session()] });
    renderChat(f);
    const item = await screen.findByRole('button', { name: /Fix the build/ });
    await act(async () => fireEvent.click(item));
    await screen.findByRole('heading', { name: 'Fix the build' });
    fireEvent.click(screen.getByRole('button', { name: 'Computer: MacBook Pro (online)' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Linux Box/ }));
    await screen.findByRole('heading', { name: 'Start a session with Codex' });
  });

  it('machine_offline from a send is shown localized', async () => {
    const f = fakeClient({ machines: [machine()] });
    f.client.createSession.mockRejectedValueOnce(clientError('machine_offline', 409, 'The machine is offline.'));
    renderChat(f, { locale: 'zh-CN' });
    await screen.findByRole('button', { name: '电脑：MacBook Pro（在线）' });
    fireEvent.change(textbox_zh(), { target: { value: 'hi' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '发送' })));
    await screen.findByText('你的电脑离线了。请确认那台电脑上的守护进程（`uncage agent`）正在运行。');
  });
});

const textbox_zh = () => screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement;

describe('ApproveDevice', () => {
  const base = (over: Partial<ApproveDeviceProps> = {}): ApproveDeviceProps => ({
    code: 'WDJB-MJHT',
    lookup: { name: 'Nathan’s MacBook', os: 'darwin', repairsMachine: null },
    onApprove: vi.fn(),
    onDeny: vi.fn(),
    ...over,
  });

  it('shows the computer, OS and code; Approve / Deny call back', () => {
    const p = base();
    render(<ApproveDevice {...p} />);
    expect(screen.getByRole('heading', { name: 'Connect this computer?' })).toBeTruthy();
    expect(screen.getByText('Nathan’s MacBook (macOS) wants to connect to your account.')).toBeTruthy();
    expect(screen.getByText('WDJB-MJHT')).toBeTruthy();
    expect(screen.getByText(/matches the one shown in the terminal/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(p.onApprove).toHaveBeenCalledTimes(1);
    expect(p.onDeny).toHaveBeenCalledTimes(1);
  });

  it('warns when approving re-pairs an existing computer', () => {
    render(<ApproveDevice {...base({ lookup: { name: 'Mac', repairsMachine: { id: 'mac_1', name: 'Old Mac' } } })} />);
    expect(screen.getByText(/This reconnects Old Mac/)).toBeTruthy();
  });

  it('in flight: both buttons disabled, the pressed one busy', () => {
    render(<ApproveDevice {...base({ state: 'approving' })} />);
    const approve = screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
    const deny = screen.getByRole('button', { name: 'Deny' }) as HTMLButtonElement;
    expect(approve.disabled && deny.disabled).toBe(true);
    expect(approve.getAttribute('aria-busy')).toBe('true');
  });

  it('done states and unusable codes replace the buttons', () => {
    const { rerender } = render(<ApproveDevice {...base({ state: 'approved' })} />);
    expect(screen.getByText(/Computer connected/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    rerender(<ApproveDevice {...base({ state: 'denied' })} />);
    expect(screen.getByText('Denied. Nothing was connected.')).toBeTruthy();
    rerender(<ApproveDevice {...base({ lookup: null })} />);
    expect(screen.getByRole('alert').textContent).toContain('invalid or has expired');
    rerender(<ApproveDevice {...base({ state: 'expired' })} />);
    expect(screen.getByRole('alert').textContent).toContain('This code has expired');
  });

  it('rate_limited: localized message, buttons stay enabled for a retry', () => {
    render(<ApproveDevice {...base({ error: { code: 'rate_limited', message: 'Too many requests.' } })} />);
    expect(screen.getByRole('alert').textContent).toBe('Too many requests. Wait a moment and try again.');
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('lookup failed (rate_limited, no lookup): the error banner, not "code not found"', () => {
    render(<ApproveDevice {...base({ lookup: null, error: { code: 'rate_limited', message: 'Too many requests.' } })} />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe('Too many requests. Wait a moment and try again.');
    expect(alert.textContent).not.toContain('invalid or has expired');
    expect(screen.queryByText(/invalid or has expired/)).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('lookup failed in zh-CN: localized error banner', () => {
    render(<ApproveDevice {...base({ lookup: null, locale: 'zh-CN', error: { code: 'rate_limited', message: 'x' } })} />);
    expect(screen.getByRole('alert').textContent).toBe('请求太频繁了，稍等一下再试。');
  });

  it('no lookup and no error: "code not found"', () => {
    render(<ApproveDevice {...base({ lookup: null })} />);
    expect(screen.getByRole('alert').textContent).toContain('invalid or has expired');
  });

  it('zh-CN via the locale prop or a surrounding provider', () => {
    const { unmount } = render(<ApproveDevice {...base({ locale: 'zh-CN' })} />);
    expect(screen.getByRole('heading', { name: '连接这台电脑？' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '批准' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '拒绝' })).toBeTruthy();
    unmount();
    render(
      <UncageUIProvider locale="zh-CN">
        <ApproveDevice {...base({ lookup: { repairsMachine: null } })} />
      </UncageUIProvider>,
    );
    expect(screen.getByText('一台未命名的电脑请求连接到你的账号。')).toBeTruthy();
  });
});
