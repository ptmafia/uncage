import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonRpcPeer } from './jsonrpc.js';

// A tiny JSONL child: echoes params, can notify, ask the client, split lines, report raw input, or die.
const ECHO_CHILD = String.raw`
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const waiting = new Map();
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const raw = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    const m = JSON.parse(raw);
    if (m.method === undefined) {
      const orig = waiting.get(m.id);
      waiting.delete(m.id);
      send({ id: orig, result: { answered: m.result } });
      continue;
    }
    switch (m.method) {
      case 'echo':
        send({ method: 'note/one', params: { n: 1 } });
        send({ method: 'note/two', params: { n: 2 } });
        send({ id: m.id, result: m.params });
        break;
      case 'ask':
        waiting.set('srv-1', m.id);
        send({ id: 'srv-1', method: 'client/decide', params: { q: m.params.q } });
        break;
      case 'split': {
        const line = JSON.stringify({ id: m.id, result: { split: true } }) + '\n';
        process.stdout.write(line.slice(0, 5));
        setTimeout(() => process.stdout.write(line.slice(5)), 30);
        break;
      }
      case 'raw':
        send({ id: m.id, result: { raw } });
        break;
      case 'die':
        process.exit(3);
    }
  }
});
`;

const peers: JsonRpcPeer[] = [];
function start(): JsonRpcPeer {
  const proc: ChildProcessWithoutNullStreams = spawn(process.execPath, ['-e', ECHO_CHILD]);
  const peer = new JsonRpcPeer(proc);
  peers.push(peer);
  return peer;
}

afterEach(async () => {
  await Promise.all(peers.splice(0).map((p) => p.close()));
});

describe('JsonRpcPeer', () => {
  it('request/response correlated by id with interleaved notifications', async () => {
    const peer = start();
    const notes: Array<[string, unknown]> = [];
    peer.onNotification((method, params) => notes.push([method, params]));
    const [a, b] = await Promise.all([peer.request('echo', { v: 'a' }), peer.request('echo', { v: 'b' })]);
    expect(a).toEqual({ v: 'a' });
    expect(b).toEqual({ v: 'b' });
    expect(notes).toEqual([
      ['note/one', { n: 1 }],
      ['note/two', { n: 2 }],
      ['note/one', { n: 1 }],
      ['note/two', { n: 2 }],
    ]);
  });

  it('notification listeners can be removed', async () => {
    const peer = start();
    const notes: string[] = [];
    const off = peer.onNotification((method) => notes.push(method));
    off();
    await peer.request('echo', {});
    expect(notes).toEqual([]);
  });

  it('server-initiated request answered with result', async () => {
    const peer = start();
    const seen: Array<[string, unknown, number | string]> = [];
    peer.onRequest((method, params, id) => {
      seen.push([method, params, id]);
      return Promise.resolve({ decision: 'accept' });
    });
    expect(await peer.request('ask', { q: 'run ls?' })).toEqual({ answered: { decision: 'accept' } });
    expect(seen).toEqual([['client/decide', { q: 'run ls?' }, 'srv-1']]);
  });

  it('partial lines buffered until newline', async () => {
    const peer = start();
    expect(await peer.request('split', {})).toEqual({ split: true });
  });

  it('outgoing messages contain no "jsonrpc" key', async () => {
    const peer = start();
    const { raw } = await peer.request<{ raw: string }>('raw', { x: 1 });
    const sent = JSON.parse(raw) as Record<string, unknown>;
    expect(sent).not.toHaveProperty('jsonrpc');
    expect(sent).toEqual({ id: expect.anything(), method: 'raw', params: { x: 1 } });
  });

  it('pending requests reject on child exit', async () => {
    const peer = start();
    const exits: Array<number | null> = [];
    peer.onExit((code) => exits.push(code));
    const pending = peer.request('echo', {}).then(() => peer.request('die', {}));
    await expect(pending).rejects.toThrow(/exited/);
    expect(exits).toEqual([3]);
    await expect(peer.request('echo', {})).rejects.toThrow(/exited/);
  });

  it('requests time out after requestTimeoutMs', async () => {
    const proc = spawn(process.execPath, ['-e', ECHO_CHILD]);
    const peer = new JsonRpcPeer(proc, { requestTimeoutMs: 50 });
    peers.push(peer);
    await expect(peer.request('nobody/answers', {})).rejects.toThrow(/timed out/);
  });
});
