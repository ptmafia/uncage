import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ApprovalRequest, Session, SessionSettings } from '@uncage/protocol';
import { UncageClientError } from '@uncage/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentChat, UncageProvider, type AgentChatProps } from './index.js';
import {
  approval,
  attachment,
  clientError,
  eventFactory,
  fakeClient,
  richCaps,
  run,
  runtime,
  session,
  snapshot,
} from './test-fixtures.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // `persistSession` (default 'url') writes `?session=`; start every test from a clean URL.
  window.history.replaceState(null, '', '/');
  window.localStorage.clear();
});

type Fake = ReturnType<typeof fakeClient>;

function renderChat(f: Fake, props: AgentChatProps = {}) {
  return render(
    <UncageProvider client={f.client}>
      <AgentChat {...props} />
    </UncageProvider>,
  );
}

/** Renders AgentChat, opens `ses_1` from the sidebar and marks the stream live. */
async function openSession(f: Fake, props: AgentChatProps = {}) {
  const view = renderChat(f, props);
  const item = await screen.findByRole('button', { name: /Fix the build/ });
  await act(async () => fireEvent.click(item));
  await waitFor(() => expect(f.client.subscribe).toHaveBeenCalled());
  act(() => f.live());
  return view;
}

function startRunWithApproval(f: Fake, a: ApprovalRequest = approval()) {
  const ev = eventFactory();
  act(() => {
    f.emit(ev('run.started', { run: run({ state: 'running' }) }));
    f.emit(ev('approval.requested', { approval: a }));
  });
  return ev;
}

const textbox = () => screen.getByRole('textbox') as HTMLTextAreaElement;

describe('ApprovalCard', () => {
  it('ApprovalCard pending renders target command and two buttons', async () => {
    const f = fakeClient();
    await openSession(f);
    startRunWithApproval(f);
    const card = screen.getByRole('region', { name: 'Needs your OK: Bash' });
    expect(within(card).getByText('rm -rf build')).toBeTruthy();
    expect(within(card).getByText('Remove the build folder')).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Deny' })).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Allow once' })).toBeTruthy();
    expect(within(card).getByText(/nothing runs if you don't respond/)).toBeTruthy();
  });

  it("clicking Allow disables both and calls decide(id,'allow')", async () => {
    const f = fakeClient();
    let resolve!: (a: ApprovalRequest) => void;
    f.client.decide.mockImplementation(() => new Promise((r) => (resolve = r)));
    await openSession(f);
    startRunWithApproval(f);
    const card = screen.getByRole('region', { name: 'Needs your OK: Bash' });
    const allow = within(card).getByRole('button', { name: 'Allow once' }) as HTMLButtonElement;
    const deny = within(card).getByRole('button', { name: 'Deny' }) as HTMLButtonElement;
    act(() => fireEvent.click(allow));
    expect(f.client.decide).toHaveBeenCalledWith('apr_1', { decision: 'allow', scope: 'once' });
    expect(allow.disabled).toBe(true);
    expect(deny.disabled).toBe(true);
    // The spinner is decorative; the button is aria-busy and keeps its accessible name.
    expect(allow.getAttribute('aria-busy')).toBe('true');
    expect(deny.getAttribute('aria-busy')).toBeNull();
    expect(within(card).getByRole('button', { name: 'Allow once' })).toBe(allow);
    await act(async () => resolve(approval({ state: 'approved', decision: 'allow', version: 2 })));
    expect(screen.getByText('Allowed')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Allow once' })).toBeNull();
  });

  it('Enter allows only when focus is inside the card', async () => {
    const f = fakeClient();
    await openSession(f);
    startRunWithApproval(f);
    fireEvent.keyDown(textbox(), { key: 'Enter' });
    expect(f.client.decide).not.toHaveBeenCalled();
    const card = screen.getByRole('region', { name: 'Needs your OK: Bash' });
    act(() => fireEvent.keyDown(card, { key: 'Enter' }));
    expect(f.client.decide).toHaveBeenCalledWith('apr_1', { decision: 'allow', scope: 'once' });
  });

  it('expired approval renders one line, no buttons', async () => {
    const f = fakeClient();
    await openSession(f);
    const ev = startRunWithApproval(f);
    act(() => f.emit(ev('approval.resolved', { approval: approval({ state: 'expired', version: 2 }) })));
    expect(screen.getByText('Approval expired')).toBeTruthy();
    expect(screen.queryByRole('region', { name: /Needs your OK/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Allow once' })).toBeNull();
  });

  it('denied approval says so honestly', async () => {
    const f = fakeClient();
    await openSession(f);
    const ev = startRunWithApproval(f);
    act(() => f.emit(ev('approval.resolved', { approval: approval({ state: 'denied', decision: 'deny', version: 2 }) })));
    expect(screen.getByText('Denied — Bash')).toBeTruthy();
  });

  it('components.ApprovalCard override replaces default', async () => {
    const f = fakeClient();
    await openSession(f, {
      components: { ApprovalCard: ({ approval: a }) => <div data-testid="custom">custom {a.title}</div> },
    });
    startRunWithApproval(f);
    expect(screen.getByTestId('custom').textContent).toBe('custom Bash');
    expect(screen.queryByRole('button', { name: 'Allow once' })).toBeNull();
  });

  it('zh-CN copy renders 允许执行', async () => {
    const f = fakeClient();
    await openSession(f, { locale: 'zh-CN' });
    startRunWithApproval(f);
    expect(screen.getByRole('region', { name: '需要你确认：Bash' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '允许执行' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '拒绝' })).toBeTruthy();
    expect(screen.getByText(/前没处理会过期，不执行/)).toBeTruthy();
  });
});

describe('ToolSteps', () => {
  it('ToolSteps collapses after run.completed', async () => {
    const f = fakeClient();
    await openSession(f);
    const ev = eventFactory();
    act(() => {
      f.emit(ev('run.started', { run: run({ state: 'running' }) }));
      f.emit(ev('tool.started', { toolId: 't1', name: 'Read', title: 'Read package.json', category: 'file' }));
      f.emit(ev('tool.started', { toolId: 't2', name: 'Bash', title: 'Run the tests', category: 'shell' }));
    });
    const toggle = screen.getByRole('button', { name: /2 steps/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Read package.json')).toBeTruthy();
    act(() => {
      f.emit(ev('tool.completed', { toolId: 't1', durationMs: 20 }));
      f.emit(ev('tool.completed', { toolId: 't2', durationMs: 900 }));
      f.emit(ev('run.completed', { runId: 'run_1', durationMs: 1000 }));
    });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Read package.json')).toBeNull();
    act(() => fireEvent.click(toggle));
    expect(screen.getByText('Read package.json')).toBeTruthy();
  });

  it('shows Thinking… on the active run before any assistant text', async () => {
    const f = fakeClient();
    await openSession(f);
    const ev = eventFactory();
    act(() => f.emit(ev('run.started', { run: run({ state: 'running' }) })));
    expect(screen.getByText('Thinking…')).toBeTruthy();
    act(() => {
      f.emit(ev('message.started', { messageId: 'm1', role: 'assistant' }));
      f.emit(ev('message.delta', { messageId: 'm1', chunkIndex: 0, text: 'Hello **there**' }));
    });
    expect(screen.queryByText('Thinking…')).toBeNull();
    expect(screen.getByText('there').tagName).toBe('STRONG');
  });
});

describe('Composer', () => {
  it('Composer Enter sends, Shift+Enter newline, Enter during IME composition ignored', async () => {
    const f = fakeClient();
    await openSession(f);
    const input = textbox();
    fireEvent.change(input, { target: { value: '你好' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    expect(f.client.startRun).not.toHaveBeenCalled();
    const shift = fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(shift).toBe(true); // not prevented: the browser inserts the newline
    expect(f.client.startRun).not.toHaveBeenCalled();
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
    expect(f.client.startRun).toHaveBeenCalledWith('ses_1', { prompt: '你好' });
    expect(input.value).toBe('');
  });

  it('Send turns into Stop while run active', async () => {
    const f = fakeClient();
    await openSession(f);
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
    const ev = eventFactory();
    act(() => f.emit(ev('run.started', { run: run({ state: 'running' }) })));
    const stop = screen.getByRole('button', { name: 'Stop' });
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    await act(async () => fireEvent.click(stop));
    expect(f.client.cancelRun).toHaveBeenCalledWith('run_1');
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
  });

  it('a failed send keeps the text and shows the error', async () => {
    const f = fakeClient();
    f.client.startRun.mockRejectedValueOnce(
      clientError('runtime_unavailable', 503, 'Claude Code is not available.', 'Install the runtime CLI.'),
    );
    await openSession(f);
    const input = textbox();
    fireEvent.change(input, { target: { value: 'keep me' } });
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
    expect(f.client.startRun).toHaveBeenCalledTimes(1);
    expect(input.value).toBe('keep me');
    // Localized headline; the server's hint (the install command) is kept under it.
    expect(screen.getByRole('alert').textContent).toBe("The runtime isn't available. Install the runtime CLI.");
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send' })));
    expect(f.client.startRun).toHaveBeenCalledTimes(2);
    expect(input.value).toBe('');
  });

  it('an open session uses its own runtime, not the draft pick', async () => {
    const f = fakeClient({
      runtimes: [
        runtime(),
        runtime({ id: 'codex', displayName: 'Codex', status: 'not_installed', message: 'Codex CLI was not found on PATH.' }),
      ],
      snapshot: () => snapshot({ session: session({ runtimeId: 'codex' }) }),
    });
    await openSession(f, { defaultRuntime: 'claude' });
    await screen.findByText('Codex CLI was not found on PATH.');
    expect(textbox().disabled).toBe(true);
    expect(textbox().placeholder).toBe('Message Codex…');
  });

  it('is disabled while the selected session is still loading', async () => {
    const f = fakeClient();
    f.client.snapshot.mockImplementation(() => new Promise(() => {}));
    renderChat(f);
    // Find outside act(): findBy* toggles the act environment off while it polls.
    const item = await screen.findByRole('button', { name: /Fix the build/ });
    await act(async () => fireEvent.click(item));
    expect(textbox().disabled).toBe(true);
  });

  it('is disabled with a banner for a read-only session', async () => {
    const f = fakeClient({ snapshot: () => snapshot({ session: session({ readOnly: true }) }) });
    await openSession(f);
    expect(textbox().disabled).toBe(true);
    const banner = document.querySelector('.uc-readonly') as HTMLElement;
    expect(banner.getAttribute('role')).toBe('status');
    expect(banner.textContent).toContain("This session can't be continued. Its history is still available.");
    expect(within(banner).getByRole('button', { name: 'New session' })).toBeTruthy();
  });

  it('a session that turns read-only mid-session shows the zh-CN banner; 新建会话 opens a draft', async () => {
    const f = fakeClient();
    await openSession(f, { locale: 'zh-CN' });
    expect(textbox().disabled).toBe(false);
    const ev = eventFactory();
    act(() => f.emit(ev('session.updated', { session: session({ readOnly: true }) })));
    expect(textbox().disabled).toBe(true);
    const banner = document.querySelector('.uc-readonly') as HTMLElement;
    expect(banner.textContent).toContain('这个会话无法继续了，历史仍可查看。');
    // The history stays on screen until the user leaves it.
    expect(screen.getByRole('heading', { name: 'Fix the build' })).toBeTruthy();
    await act(async () => fireEvent.click(within(banner).getByRole('button', { name: '新建会话' })));
    expect(document.querySelector('.uc-readonly')).toBeNull();
    expect(textbox().disabled).toBe(false);
  });
});

describe('RunStatusBar', () => {
  it('reports running time and waiting approvals, then honest interrupted copy', async () => {
    const f = fakeClient();
    await openSession(f);
    const ev = startRunWithApproval(f);
    expect(document.querySelector('.uc-runstatus')?.textContent).toMatch(/^Running · \d+s · 1 waiting for you$/);
    act(() => f.emit(ev('run.interrupted', { runId: 'run_1', reason: 'crash' })));
    expect(screen.getByText('Interrupted — the runtime stopped. Send again to retry.')).toBeTruthy();
  });
});

describe('RuntimeSelector and EmptyState', () => {
  it('RuntimeSelector shows not_installed hint and install link', async () => {
    const f = fakeClient({
      runtimes: [
        runtime(),
        runtime({
          id: 'codex',
          displayName: 'Codex',
          status: 'not_installed',
          message: 'Codex CLI was not found on PATH.',
          hint: 'Install it with npm i -g @openai/codex.',
          installUrl: 'https://github.com/openai/codex',
        }),
      ],
    });
    renderChat(f);
    const codex = (await screen.findByRole('radio', { name: /Codex/ })) as HTMLInputElement;
    expect(codex.disabled).toBe(true);
    expect(screen.getByText('Not installed')).toBeTruthy();
    expect(screen.getByText('Codex CLI was not found on PATH.')).toBeTruthy();
    expect(screen.getByText('Install it with npm i -g @openai/codex.')).toBeTruthy();
    const link = screen.getByRole('link', { name: /Install guide/ });
    expect(link.getAttribute('href')).toBe('https://github.com/openai/codex');
    expect((screen.getByRole('radio', { name: /Claude Code/ }) as HTMLInputElement).checked).toBe(true);
  });

  it('first prompt from the empty state creates a session with the chosen runtime, then sends', async () => {
    const f = fakeClient({ sessions: [] });
    renderChat(f, { starterPrompts: ['Explain this repo'] });
    expect(await screen.findByText('Start a session with Claude Code')).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Explain this repo' })));
    await waitFor(() => expect(f.client.startRun).toHaveBeenCalledWith('ses_new', { prompt: 'Explain this repo' }));
    expect(f.client.createSession).toHaveBeenCalledWith({ runtime: 'claude' });
  });
});

/** A client whose runtime and session offer every composer control; PATCH merges like core. */
function richClient(o: { bypass?: boolean; settings?: SessionSettings; sessions?: [] } = {}) {
  const caps = richCaps(o.bypass);
  let settings: SessionSettings = o.settings ?? { permissionMode: 'default' };
  const f = fakeClient({
    runtimes: [runtime({ capabilities: caps })],
    ...(o.sessions ? { sessions: o.sessions } : {}),
    snapshot: () => snapshot({ session: session({ capabilities: caps, settings }) }),
  });
  f.client.updateSettings.mockImplementation(async (id: string, patch: Partial<SessionSettings>) => {
    settings = { ...settings, ...patch };
    return session({ id, capabilities: caps, settings });
  });
  f.client.createSession.mockImplementation(async (b: { runtime: string }) =>
    session({ id: 'ses_new', runtimeId: b.runtime, title: 'New', capabilities: caps, settings: { permissionMode: 'default' } }),
  );
  return f;
}

const png = (name = 'image.png') => new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' });
const box = () => document.querySelector('.uc-composer') as HTMLElement;

describe('Composer toolbar', () => {
  it('toolbar renders model/effort/permission from capabilities', async () => {
    await openSession(richClient());
    expect(screen.getByRole('button', { name: 'Model: Default' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Effort/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Permissions: Ask every time' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Attach files' })).toBeTruthy();
    const input = screen.getByLabelText('Attach files', { selector: 'input' }) as HTMLInputElement;
    expect(input.multiple).toBe(true);
    expect(input.accept).toContain('.png');
    expect(input.accept).toContain('.pdf');
    expect(textbox().placeholder).toBe('Message Claude Code, attach files…');
  });

  it('controls are hidden when the capability lists are empty', async () => {
    await openSession(fakeClient());
    expect(screen.queryByRole('button', { name: /^Model/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Effort/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Attach files' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Permissions: Ask every time' })).toBeTruthy();
  });

  it('selecting model calls update and shows label', async () => {
    const f = richClient();
    await openSession(f);
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Model: Default' })));
    const menu = screen.getByRole('menu', { name: 'Model' });
    const opus = within(menu).getByRole('menuitemradio', { name: 'Opus' });
    expect(within(menu).getByRole('menuitemradio', { name: 'Default' }).getAttribute('aria-checked')).toBe('true');
    expect(within(menu).getByText('Most capable')).toBeTruthy();
    await act(async () => fireEvent.click(opus));
    expect(f.client.updateSettings).toHaveBeenCalledWith('ses_1', { model: 'opus' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('button', { name: 'Model: Opus' }).textContent).toContain('Opus');
  });

  it('shows "Applies to the next run" while a run started before the change is active', async () => {
    const f = richClient();
    await openSession(f);
    act(() => f.emit(eventFactory()('run.started', { run: run({ state: 'running' }) })));
    act(() => fireEvent.click(screen.getByRole('button', { name: /^Effort/ })));
    await act(async () => fireEvent.click(screen.getByRole('menuitemradio', { name: 'High' })));
    expect(f.client.updateSettings).toHaveBeenCalledWith('ses_1', { effort: 'high' });
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Effort: High' })));
    const note = screen.getByText('Applies to the next run');
    expect(screen.getByRole('menu').getAttribute('aria-describedby')).toBe(note.id);
  });

  it('bypass hidden when not in permissionModes', async () => {
    await openSession(richClient());
    act(() => fireEvent.click(screen.getByRole('button', { name: /^Permissions/ })));
    const names = screen.getAllByRole('menuitemradio').map((i) => i.getAttribute('aria-label') ?? i.textContent);
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(4);
    expect(names.join('|')).not.toMatch(/Bypass/);
    expect(screen.queryByRole('menuitemradio', { name: 'Bypass permissions' })).toBeNull();
  });

  it('choosing bypass requires confirm; cancel keeps mode', async () => {
    const f = richClient({ bypass: true });
    await openSession(f);
    const trigger = screen.getByRole('button', { name: 'Permissions: Ask every time' });
    act(() => fireEvent.click(trigger));
    act(() => fireEvent.click(screen.getByRole('menuitemradio', { name: 'Bypass permissions' })));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('Agent will run any command without asking. Continue?');
    expect(f.client.updateSettings).not.toHaveBeenCalled();
    expect(dialog.tabIndex).toBe(-1);
    // Clicking the dialog text moves focus off the buttons; Esc must still cancel.
    act(() => (document.activeElement as HTMLElement).blur());
    act(() => fireEvent.keyDown(document.body, { key: 'Escape' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(f.client.updateSettings).not.toHaveBeenCalled();
    act(() => fireEvent.click(screen.getByRole('button', { name: /^Permissions/ })));
    act(() => fireEvent.click(screen.getByRole('menuitemradio', { name: 'Bypass permissions' })));
    const again = screen.getByRole('alertdialog');
    // Tab from outside the dialog lands back inside it.
    act(() => (document.activeElement as HTMLElement).blur());
    act(() => fireEvent.keyDown(document.body, { key: 'Tab' }));
    expect(again.contains(document.activeElement)).toBe(true);
    act(() => fireEvent.click(within(again).getByRole('button', { name: 'Cancel' })));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(f.client.updateSettings).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Permissions: Ask every time' })).toBeTruthy();

    act(() => fireEvent.click(screen.getByRole('button', { name: /^Permissions/ })));
    act(() => fireEvent.click(screen.getByRole('menuitemradio', { name: 'Bypass permissions' })));
    await act(async () => fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Enable' })));
    expect(f.client.updateSettings).toHaveBeenCalledWith('ses_1', { permissionMode: 'bypassPermissions' });
    expect(screen.getByRole('button', { name: 'Permissions: Bypass permissions' })).toBeTruthy();
    expect(document.querySelector('.uc-bypass-banner')).toBeTruthy();
  });

  it('BypassBanner shows when mode bypass', async () => {
    await openSession(richClient({ bypass: true, settings: { permissionMode: 'bypassPermissions' } }));
    const banner = document.querySelector('.uc-bypass-banner') as HTMLElement;
    expect(banner.textContent).toContain('Bypass permissions is on');
    expect(screen.getByRole('button', { name: 'Permissions: Bypass permissions' }).getAttribute('data-tone')).toBe('err');
  });

  it('menus keyboard: ArrowDown/Enter selects, Esc closes', async () => {
    const f = richClient();
    await openSession(f);
    const trigger = screen.getByRole('button', { name: /^Permissions/ });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    act(() => fireEvent.keyDown(trigger, { key: 'ArrowDown' }));
    const menu = screen.getByRole('menu', { name: 'Permissions' });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(within(menu).getByRole('menuitemradio', { name: 'Ask every time' }));
    act(() => fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' }));
    expect(document.activeElement).toBe(within(menu).getByRole('menuitemradio', { name: 'Accept edits' }));
    act(() => fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' }));
    act(() => fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' }));
    expect(document.activeElement).toBe(within(menu).getByRole('menuitemradio', { name: 'Auto mode' }));
    act(() => fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' }));
    act(() => fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' }));
    await act(async () => fireEvent.keyDown(document.activeElement!, { key: 'Enter' }));
    expect(f.client.updateSettings).toHaveBeenCalledWith('ses_1', { permissionMode: 'acceptEdits' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Permissions: Accept edits' }));

    act(() => fireEvent.click(screen.getByRole('button', { name: /^Permissions/ })));
    act(() => fireEvent.keyDown(document.activeElement!, { key: 'Escape' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Permissions/ }));
    act(() => fireEvent.click(screen.getByRole('button', { name: /^Permissions/ })));
    act(() => fireEvent.pointerDown(document.body));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(f.client.updateSettings).toHaveBeenCalledTimes(1);
  });

  it('a menu that would overflow the viewport is shifted back inside it', async () => {
    await openSession(richClient());
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('uc-popover')
        ? ({ left: window.innerWidth - 100, right: window.innerWidth + 140, top: 0, bottom: 0, width: 240, height: 0 } as DOMRect)
        : ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 } as DOMRect);
    });
    act(() => fireEvent.click(screen.getByRole('button', { name: /^Permissions/ })));
    const panel = document.querySelector('.uc-popover') as HTMLElement;
    expect(panel.style.getPropertyValue('--uc-popover-shift')).toBe('-148px');
  });

  it('zh-CN copy for the five permission labels and the bypass confirm', async () => {
    await openSession(richClient({ bypass: true }), { locale: 'zh-CN' });
    act(() => fireEvent.click(screen.getByRole('button', { name: '权限：每次询问' })));
    for (const name of ['每次询问', '自动接受编辑', '计划模式', '自动模式', '完全放行']) {
      expect(screen.getByRole('menuitemradio', { name })).toBeTruthy();
    }
    act(() => fireEvent.click(screen.getByRole('menuitemradio', { name: '完全放行' })));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('Agent 将不经询问执行任何命令，确定开启？');
    expect(within(dialog).getByRole('button', { name: '取消' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: '开启' })).toBeTruthy();
    expect(textbox().placeholder).toBe('给 Claude Code 发消息，可添加附件…');
  });

  it('Stop button is red-styled class uc-stop', async () => {
    const f = fakeClient();
    await openSession(f);
    act(() => f.emit(eventFactory()('run.started', { run: run({ state: 'running' }) })));
    const stop = screen.getByRole('button', { name: 'Stop' });
    expect(stop.classList.contains('uc-stop')).toBe(true);
    expect(document.querySelector('.uc-composer-running')).toBeTruthy();
  });

  it('Enter during IME composition never sends (regression)', async () => {
    const f = richClient();
    await openSession(f);
    const input = textbox();
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: 'にほんご' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    fireEvent.compositionEnd(input);
    expect(f.client.startRun).not.toHaveBeenCalled();
    expect(input.value).toBe('にほんご');
  });
});

describe('ConnectionBanner errors (zh-CN)', () => {
  it.each([
    ['session_busy', 409, '这个会话正在运行，等它结束或先停止，再发送。'],
    ['policy_denied', 403, '服务器策略不允许这个操作。'],
    ['session_read_only', 409, '这个会话是只读的，无法继续。请新建一个会话。'],
    ['internal_error', 500, '服务出错了，请稍后重试。'],
  ] as const)('%s → localized message, no English server hint', async (code, status, text) => {
    const f = fakeClient();
    f.client.startRun.mockRejectedValueOnce(clientError(code, status, 'English server message.', 'English hint.'));
    await openSession(f, { locale: 'zh-CN' });
    fireEvent.change(textbox(), { target: { value: 'hi' } });
    await act(async () => fireEvent.keyDown(textbox(), { key: 'Enter' }));
    expect(screen.getByRole('alert').textContent).toBe(text);
  });

  const sendFailing = async (err: UncageClientError) => {
    const f = fakeClient();
    f.client.startRun.mockRejectedValueOnce(err);
    await openSession(f, { locale: 'zh-CN' });
    fireEvent.change(textbox(), { target: { value: 'hi' } });
    await act(async () => fireEvent.keyDown(textbox(), { key: 'Enter' }));
    return screen.getByRole('alert').textContent;
  };
  const err = (code: UncageClientError['code'], status: number, details?: Record<string, unknown>, hint?: string) =>
    new UncageClientError({ code, message: 'English server message.', retryable: false, ...(hint ? { hint } : {}), ...(details ? { details } : {}) }, status);

  it('daemon_unreachable (proxy: daemon stopped) → start `uncage serve`, not the runtime install text', async () => {
    expect(await sendFailing(err('runtime_unavailable', 503, { reason: 'daemon_unreachable' }, 'Run `uncage serve` first.'))).toBe(
      'Uncage 服务没有运行，先在终端执行 `uncage serve`。',
    );
  });

  it('runtime_unavailable / auth_required name the runtime and keep the server hint', async () => {
    expect(await sendFailing(err('runtime_unavailable', 503, { runtime: 'claude' }, 'npm i -g @anthropic-ai/claude-code'))).toBe(
      'Claude Code 现在用不了。 npm i -g @anthropic-ai/claude-code',
    );
    cleanup();
    expect(await sendFailing(err('auth_required', 401, { runtime: 'claude' }, 'Run `claude` and log in'))).toBe(
      'Claude Code 需要登录。 Run `claude` and log in',
    );
    cleanup();
    expect(await sendFailing(err('runtime_unavailable', 503))).toBe('运行时现在用不了。');
  });

  it('unsupported_capability names the refused setting from details', async () => {
    expect(await sendFailing(err('unsupported_capability', 422, { effort: 'max' }))).toBe('当前运行时不支持推理强度「最高」。');
    cleanup();
    expect(await sendFailing(err('unsupported_capability', 422, { model: 'opus-9' }))).toBe('当前运行时不支持模型「opus-9」。');
    cleanup();
    expect(await sendFailing(err('unsupported_capability', 422))).toBe('当前运行时不支持这个功能或选项。');
  });

  it('client-side transport failures say the server is unreachable', async () => {
    expect(await sendFailing(err('internal_error', 0, { reason: 'network' }))).toBe('连不上服务器，请确认应用仍在运行后重试。');
    cleanup();
    expect(await sendFailing(err('internal_error', 502, { reason: 'http_status', status: 502 }))).toBe('连不上服务器（HTTP 502）。');
  });

  it('an unknown code falls back to the server message and hint', async () => {
    const f = fakeClient();
    f.client.startRun.mockRejectedValueOnce(clientError('invalid_request', 400, 'Prompt is empty.', 'Type something.'));
    await openSession(f, { locale: 'zh-CN' });
    fireEvent.change(textbox(), { target: { value: 'hi' } });
    await act(async () => fireEvent.keyDown(textbox(), { key: 'Enter' }));
    expect(screen.getByRole('alert').textContent).toBe('Prompt is empty. Type something.');
  });
});

describe('Composer attachments', () => {
  it('paste image adds attachment chip', async () => {
    const f = richClient();
    await openSession(f);
    const file = png();
    await act(async () => fireEvent.paste(textbox(), { clipboardData: { files: [file], types: ['Files'], getData: () => '' } }));
    expect(f.client.uploadAttachment).toHaveBeenCalledWith('ses_1', file, expect.anything());
    const chip = screen.getByRole('listitem', { name: /image\.png/ });
    expect(within(chip).getByRole('button', { name: 'Remove image.png' })).toBeTruthy();
    fireEvent.change(textbox(), { target: { value: 'look' } });
    await act(async () => fireEvent.keyDown(textbox(), { key: 'Enter' }));
    expect(f.client.startRun).toHaveBeenCalledWith('ses_1', { prompt: 'look', attachmentIds: ['att_1'] });
    expect(screen.queryByRole('listitem', { name: /image\.png/ })).toBeNull();
  });

  it('paste with text/plain keeps the default text paste and attaches nothing', async () => {
    const f = richClient();
    await openSession(f);
    let notPrevented = true;
    await act(async () => {
      notPrevented = fireEvent.paste(textbox(), {
        clipboardData: { files: [png()], types: ['Files', 'text/plain'], getData: () => 'some text' },
      });
    });
    expect(notPrevented).toBe(true);
    expect(f.client.uploadAttachment).not.toHaveBeenCalled();
    expect(document.querySelector('.uc-attachment')).toBeNull();
    let prevented = false;
    await act(async () => {
      prevented = !fireEvent.paste(textbox(), { clipboardData: { files: [png()], types: ['Files'], getData: () => '' } });
    });
    expect(prevented).toBe(true);
    expect(screen.getByRole('listitem', { name: /image\.png/ })).toBeTruthy();
  });

  it('drop files adds chips; unsupported shows caption', async () => {
    const f = richClient();
    await openSession(f);
    act(() => fireEvent.dragEnter(box(), { dataTransfer: { types: ['Files'], files: [] } }));
    expect(screen.getByText('Drop files to attach')).toBeTruthy();
    const notes = new File(['# hi'], 'notes.md', { type: 'text/markdown' });
    const exe = new File(['MZ'], 'x.exe', { type: 'application/octet-stream' });
    await act(async () => fireEvent.drop(box(), { dataTransfer: { types: ['Files'], files: [notes, exe] } }));
    expect(screen.queryByText('Drop files to attach')).toBeNull();
    expect(screen.getByRole('listitem', { name: /notes\.md/ })).toBeTruthy();
    expect(screen.getByText('Unsupported file type: x.exe')).toBeTruthy();
    const big = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'big.log', { type: 'text/plain' });
    await act(async () => fireEvent.drop(box(), { dataTransfer: { types: ['Files'], files: [big] } }));
    expect(screen.getByText('File too large (max 10 MB): big.log')).toBeTruthy();
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Remove notes.md' })));
    expect(screen.queryByRole('listitem', { name: /notes\.md/ })).toBeNull();
  });

  it('a failed upload shows a red chip', async () => {
    const f = richClient();
    f.client.uploadAttachment.mockRejectedValueOnce(clientError('attachment_too_large', 413, 'Too large.'));
    await openSession(f);
    await act(async () => fireEvent.paste(textbox(), { clipboardData: { files: [png()], types: ['Files'], getData: () => '' } }));
    expect(screen.getByRole('listitem', { name: /image\.png/ }).getAttribute('data-status')).toBe('error');
  });

  it('zh-CN: a failed upload shows a localized reason (chip title + caption); sending shows the localized banner', async () => {
    const f = richClient();
    f.client.uploadAttachment.mockRejectedValueOnce(
      new UncageClientError({ code: 'attachment_too_large', message: 'Attachment too large.', retryable: false, details: { maxBytes: 5 * 1024 * 1024 } }, 413),
    );
    await openSession(f, { locale: 'zh-CN' });
    await act(async () => fireEvent.paste(textbox(), { clipboardData: { files: [png()], types: ['Files'], getData: () => '' } }));
    const chip = screen.getByRole('listitem', { name: /image\.png/ });
    expect(chip.getAttribute('title')).toBe('附件太大了（单个上限 5 MB）。');
    expect(screen.getByText('「image.png」上传失败：附件太大了（单个上限 5 MB）。')).toBeTruthy();
    fireEvent.change(textbox(), { target: { value: 'look' } });
    await act(async () => fireEvent.keyDown(textbox(), { key: 'Enter' }));
    expect(f.client.startRun).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('附件「image.png」上传失败，移除后再发送。');
  });

  it('zh-CN: an unsupported type from the server is localized on the chip', async () => {
    const f = richClient();
    f.client.uploadAttachment.mockRejectedValueOnce(clientError('attachment_type_unsupported', 415, 'Unsupported attachment type.'));
    await openSession(f, { locale: 'zh-CN' });
    await act(async () => fireEvent.paste(textbox(), { clipboardData: { files: [png()], types: ['Files'], getData: () => '' } }));
    expect(screen.getByRole('listitem', { name: /image\.png/ }).getAttribute('title')).toBe('不支持这种文件类型。');
  });

  it('UserMessage renders image thumbnails and file chips from run.attachments', async () => {
    const f = richClient();
    await openSession(f);
    const ev = eventFactory();
    act(() =>
      f.emit(
        ev('run.started', {
          run: run({
            state: 'running',
            attachments: [attachment(), attachment({ id: 'att_2', name: 'notes.md', mime: 'text/markdown', kind: 'file', size: 1229 })],
          }),
        }),
      ),
    );
    const img = screen.getByRole('img', { name: 'shot.png' }) as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/api/uncage/attachments/att_1');
    const link = img.closest('a') as HTMLAnchorElement;
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    const file = screen.getByText('notes.md').closest('.uc-file-chip') as HTMLElement;
    expect(file.textContent).toContain('1.2 KB');
  });
});

describe('Composer voice and running sessions', () => {
  it('mic hidden without SpeechRecognition; with fake shows and fills text', async () => {
    await openSession(fakeClient());
    expect(screen.queryByRole('button', { name: 'Voice input' })).toBeNull();
    cleanup();

    const instances: FakeRecognizer[] = [];
    class FakeRecognizer {
      lang = '';
      interimResults = false;
      continuous = false;
      onresult: ((e: unknown) => void) | null = null;
      onerror: ((e: { error: string }) => void) | null = null;
      onend: (() => void) | null = null;
      start = vi.fn();
      stop = vi.fn(() => this.onend?.());
      abort = vi.fn();
      constructor() {
        instances.push(this);
      }
      say(text: string, isFinal: boolean) {
        const result = Object.assign([{ transcript: text }], { isFinal });
        this.onresult?.({ resultIndex: 0, results: [result] });
      }
    }
    (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition = FakeRecognizer;
    localStorage.removeItem('uncage.speechNoticeShown');
    try {
      await openSession(fakeClient());
      fireEvent.change(textbox(), { target: { value: 'Note:' } });
      act(() => fireEvent.click(screen.getByRole('button', { name: 'Voice input' })));
      expect(instances).toHaveLength(1);
      expect(instances[0]!.lang).toBe('en-US');
      expect(screen.getByText("Audio is processed by your browser vendor's speech service.")).toBeTruthy();
      expect(localStorage.getItem('uncage.speechNoticeShown')).toBe('1');
      const mic = screen.getByRole('button', { name: 'Stop voice input' });
      expect(mic.getAttribute('aria-pressed')).toBe('true');
      act(() => instances[0]!.say('hello wor', false));
      expect(textbox().value).toBe('Note: hello wor');
      // A final result without new interim text must replace the interim preview.
      act(() => instances[0]!.say('hello world', true));
      expect(textbox().value).toBe('Note: hello world');
      // Typing in front of the interim preview keeps dictating; the preview is not baked in.
      act(() => instances[0]!.say('again', false));
      expect(textbox().value).toBe('Note: hello world again');
      act(() => fireEvent.change(textbox(), { target: { value: '> Note: hello world again' } }));
      act(() => instances[0]!.say('again and more', true));
      expect(textbox().value).toBe('> Note: hello world again and more');
      // Editing the interim text itself ends dictation: later results never duplicate it.
      act(() => instances[0]!.say('tail', false));
      act(() => fireEvent.change(textbox(), { target: { value: '> Note: hello world again and more tail!' } }));
      expect(instances[0]!.stop).toHaveBeenCalledTimes(1);
      act(() => instances[0]!.say('tail', true));
      expect(textbox().value).toBe('> Note: hello world again and more tail!');
      expect(screen.getByRole('button', { name: 'Voice input' })).toBeTruthy();
      act(() => fireEvent.click(screen.getByRole('button', { name: 'Voice input' })));
      const mic2 = screen.getByRole('button', { name: 'Stop voice input' });
      expect(instances).toHaveLength(2);
      act(() => fireEvent.click(mic2));
      expect(instances[1]!.stop).toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Voice input' }).getAttribute('aria-pressed')).toBe('false');
      // The privacy note shows only on first use.
      expect(screen.getAllByText("Audio is processed by your browser vendor's speech service.")).toHaveLength(1);
    } finally {
      delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
      localStorage.removeItem('uncage.speechNoticeShown');
    }
  });

  it('RunningChip shows count and hides at 0', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const f = fakeClient();
    await openSession(f);
    await waitFor(() => expect(f.client.listActiveRuns).toHaveBeenCalled());
    expect(document.querySelector('.uc-running-chip')).toBeNull();
    f.client.listActiveRuns.mockResolvedValue([
      { runId: 'run_9', sessionId: 'ses_2', sessionTitle: 'Other session', state: 'running', startedAt: run().createdAt },
      { runId: 'run_1', sessionId: 'ses_1', sessionTitle: 'Fix the build', state: 'running' },
    ]);
    act(() => f.emit(eventFactory()('run.started', { run: run({ state: 'running' }) })));
    const chip = await screen.findByRole('button', { name: '2 running' });
    act(() => fireEvent.click(chip));
    await act(async () => fireEvent.click(screen.getByRole('menuitem', { name: /Other session/ })));
    expect(f.client.snapshot).toHaveBeenLastCalledWith('ses_2');
    f.client.listActiveRuns.mockResolvedValue([]);
    act(() => f.emit(eventFactory(100)('run.completed', { runId: 'run_1', durationMs: 1 })));
    await waitFor(() => expect(document.querySelector('.uc-running-chip')).toBeNull());
  });

  it('zh-CN running chip copy', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const f = fakeClient();
    f.client.listActiveRuns.mockResolvedValue([{ runId: 'run_9', sessionId: 'ses_2', sessionTitle: 'x', state: 'running' }]);
    await openSession(f, { locale: 'zh-CN' });
    expect(await screen.findByRole('button', { name: '1 个运行中' })).toBeTruthy();
  });
});

describe('Composer drafts and warnings', () => {
  it('a draft applies its settings and queued files when the first prompt creates the session', async () => {
    const f = richClient({ sessions: [] });
    renderChat(f);
    await screen.findByText('Start a session with Claude Code');
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Model: Default' })));
    await act(async () => fireEvent.click(screen.getByRole('menuitemradio', { name: 'Opus' })));
    expect(f.client.updateSettings).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Model: Opus' })).toBeTruthy();
    const file = png('draft.png');
    await act(async () => fireEvent.paste(textbox(), { clipboardData: { files: [file], types: ['Files'], getData: () => '' } }));
    expect(screen.getByRole('listitem', { name: /draft\.png/ })).toBeTruthy();
    expect(f.client.uploadAttachment).not.toHaveBeenCalled();
    fireEvent.change(textbox(), { target: { value: 'go' } });
    await act(async () => fireEvent.keyDown(textbox(), { key: 'Enter' }));
    await waitFor(() => expect(f.client.startRun).toHaveBeenCalledWith('ses_new', { prompt: 'go', attachmentIds: ['att_1'] }));
    expect(f.client.createSession).toHaveBeenCalledWith({ runtime: 'claude' });
    expect(f.client.updateSettings).toHaveBeenCalledWith('ses_new', { model: 'opus' });
    expect(f.client.uploadAttachment).toHaveBeenCalledWith('ses_new', file, expect.anything());
    expect(textbox().value).toBe('');
  });

  it('the composer is disabled while the draft is being committed', async () => {
    const f = richClient({ sessions: [] });
    let resolve!: (v: Session) => void;
    f.client.createSession.mockImplementation(() => new Promise((r) => (resolve = r)));
    renderChat(f);
    await screen.findByText('Start a session with Claude Code');
    fireEvent.change(textbox(), { target: { value: 'go' } });
    await act(async () => fireEvent.keyDown(textbox(), { key: 'Enter' }));
    expect(textbox().disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Attach files' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => fireEvent.paste(textbox(), { clipboardData: { files: [png()], types: ['Files'], getData: () => '' } }));
    await act(async () => fireEvent.drop(box(), { dataTransfer: { types: ['Files'], files: [png('drop.png')] } }));
    expect(document.querySelector('.uc-attachment')).toBeNull();
    expect(screen.queryByText('Drop files to attach')).toBeNull();
    await act(async () => resolve(session({ id: 'ses_new', capabilities: richCaps() })));
    await waitFor(() => expect(f.client.startRun).toHaveBeenCalledWith('ses_new', { prompt: 'go' }));
  });

  it('a setting_reset warning shows a caption under the composer', async () => {
    const f = richClient();
    await openSession(f, { locale: 'zh-CN' });
    const ev = eventFactory();
    act(() => {
      f.emit(ev('run.started', { run: run({ state: 'running' }) }));
      f.emit(ev('system.warning', { code: 'setting_reset', message: 'reset' }));
    });
    expect(screen.getByText('某项设置已重置：运行时不再提供该选项')).toBeTruthy();
  });

  it('a setting_reset warning without a run clears when the next run starts', async () => {
    const f = richClient();
    await openSession(f);
    const ev = eventFactory();
    const warning = ev('system.warning', { code: 'setting_reset', message: 'reset' });
    act(() => f.emit({ ...warning, runId: undefined } as typeof warning));
    expect(screen.getByText('A setting was reset: the runtime no longer offers it')).toBeTruthy();
    act(() => f.emit(ev('run.started', { run: run({ state: 'running' }) })));
    expect(screen.queryByText('A setting was reset: the runtime no longer offers it')).toBeNull();
  });
});

describe('persistSession', () => {
  const sessionParam = () => new URL(window.location.href).searchParams.get('session');

  it("default 'url': the open session goes to ?session= and a reload reopens it", async () => {
    const f = fakeClient();
    const first = await openSession(f);
    await waitFor(() => expect(sessionParam()).toBe('ses_1'));
    first.unmount();

    // "Reload": a fresh provider/store on the same URL reopens the session without any click.
    const g = fakeClient();
    renderChat(g);
    await waitFor(() => expect(g.client.snapshot).toHaveBeenCalledWith('ses_1'));
    await waitFor(() => expect(g.client.subscribe).toHaveBeenCalledWith('ses_1', expect.anything()));
    expect(await screen.findByRole('heading', { name: 'Fix the build' })).toBeTruthy();
    expect(sessionParam()).toBe('ses_1');
  });

  it('keeps other query params and uses replaceState (no history entries)', async () => {
    window.history.replaceState(null, '', '/chat?tab=2');
    const before = window.history.length;
    await openSession(fakeClient());
    await waitFor(() => expect(sessionParam()).toBe('ses_1'));
    expect(new URL(window.location.href).searchParams.get('tab')).toBe('2');
    expect(window.location.pathname).toBe('/chat');
    expect(window.history.length).toBe(before);
  });

  it('"New session" clears ?session=', async () => {
    await openSession(fakeClient());
    await waitFor(() => expect(sessionParam()).toBe('ses_1'));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'New session' })));
    await waitFor(() => expect(sessionParam()).toBeNull());
  });

  it('an unknown ?session= id falls back to a new draft without an error banner', async () => {
    window.history.replaceState(null, '', '/?session=ses_gone');
    const f = fakeClient();
    f.client.snapshot.mockRejectedValue(clientError('not_found', 404, 'Session ses_gone not found.'));
    renderChat(f);
    await waitFor(() => expect(sessionParam()).toBeNull());
    expect(await screen.findByText('Start a session with Claude Code')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it("'localStorage' restores from storage and leaves the URL alone", async () => {
    const first = await openSession(fakeClient(), { persistSession: 'localStorage' });
    await waitFor(() => expect(window.localStorage.getItem('uncage:session')).toBe('ses_1'));
    expect(sessionParam()).toBeNull();
    first.unmount();
    const g = fakeClient();
    renderChat(g, { persistSession: 'localStorage' });
    await waitFor(() => expect(g.client.snapshot).toHaveBeenCalledWith('ses_1'));
  });

  it('false: nothing is read or written', async () => {
    window.history.replaceState(null, '', '/?session=ses_1');
    const f = fakeClient();
    renderChat(f, { persistSession: false });
    expect(await screen.findByRole('button', { name: /Fix the build/ })).toBeTruthy();
    expect(f.client.snapshot).not.toHaveBeenCalled();
    window.history.replaceState(null, '', '/');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /Fix the build/ })));
    await waitFor(() => expect(f.client.subscribe).toHaveBeenCalled());
    expect(sessionParam()).toBeNull();
  });
});
