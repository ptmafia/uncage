import { spawn } from 'node:child_process';
import { fakeCodexPath } from '@uncage/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonRpcPeer } from './jsonrpc.js';
import { CLIENT_REQUEST, INITIALIZED, NOTIFY, REQUEST, type ThreadResult, type TurnStartResult } from './protocol.js';

// The fake (in @uncage/testkit) cannot import protocol.ts; this guards the two against drifting apart.
const peers: JsonRpcPeer[] = [];
afterEach(async () => {
  await Promise.all(peers.splice(0).map((p) => p.close()));
});

/** Notifications Uncage does not route but the fake (like Codex) still sends. */
const UNROUTED = new Set(['thread/started', 'turn/started']);

describe('fake app-server speaks protocol.ts', () => {
  it('answers every CLIENT_REQUEST and sends only NOTIFY / REQUEST methods', async () => {
    const peer = new JsonRpcPeer(spawn(process.execPath, [fakeCodexPath]), { requestTimeoutMs: 5_000 });
    peers.push(peer);
    const notified = new Set<string>();
    const requested = new Set<string>();
    let turnCompleted: (() => void) | undefined;
    peer.onNotification((method) => {
      notified.add(method);
      if (method === NOTIFY.turnCompleted) turnCompleted?.();
    });
    peer.onRequest((method) => {
      requested.add(method);
      return Promise.resolve({ decision: 'accept' });
    });

    await peer.request(CLIENT_REQUEST.initialize, { clientInfo: { name: 'uncage', title: 'Uncage', version: '0.0.0' } });
    peer.notify(INITIALIZED, {});
    expect(await peer.request(CLIENT_REQUEST.accountRead, { refreshToken: false })).toHaveProperty('requiresOpenaiAuth');
    const { thread } = await peer.request<ThreadResult>(CLIENT_REQUEST.threadStart, { cwd: '/tmp' });
    await peer.request(CLIENT_REQUEST.threadResume, { threadId: thread.id });

    // Turns run one at a time, so the next turn/completed belongs to the turn just started.
    const turn = async (text: string, interrupt = false): Promise<void> => {
      const done = new Promise<void>((resolve) => (turnCompleted = resolve));
      const started = await peer.request<TurnStartResult>(CLIENT_REQUEST.turnStart, {
        threadId: thread.id,
        input: [{ type: 'text', text }],
      });
      if (interrupt) await peer.request(CLIENT_REQUEST.turnInterrupt, { threadId: thread.id, turnId: started.turn.id });
      await done;
    };
    await turn('approval');
    await turn('file');
    await turn('slow', true);

    expect([...requested].sort()).toEqual(Object.values(REQUEST).sort());
    for (const method of Object.values(NOTIFY)) expect(notified).toContain(method);
    for (const method of notified) expect([...Object.values(NOTIFY), ...UNROUTED]).toContain(method);
  });
});
