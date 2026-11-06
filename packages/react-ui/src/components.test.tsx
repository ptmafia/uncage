import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ApprovalRequest } from '@uncage/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentChat, UncageProvider, type AgentChatProps } from './index.js';
import { approval, clientError, eventFactory, fakeClient, run, runtime, session, snapshot } from './test-fixtures.js';

afterEach(cleanup);

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
    expect(screen.getByRole('alert').textContent).toContain('Claude Code is not available.');
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
    expect(textbox().placeholder).toBe('Ask Codex…');
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
