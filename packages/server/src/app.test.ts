import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUncage, type UncageOptions } from '@uncage/core';
import {
  ATTACHMENT_LIMITS,
  type ActiveRunInfo,
  type ApprovalRequest,
  type Attachment,
  type PermissionMode,
  type Run,
  type Session,
  type SessionSnapshot,
  type UncageEvent,
} from '@uncage/protocol';
import { createFakeAdapter, type FakeStep } from '@uncage/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import { createUncageServer, type ServerOptions } from './app.js';
import { auth, HOST, openSse, PORT, serverFactory, shellApproval, TOKEN, type TestServer } from './test-utils.js';

const servers = serverFactory();
afterEach(() => servers.closeAll());

const json = { ...auth, 'content-type': 'application/json' };

async function createSession(s: TestServer): Promise<Session> {
  const res = await s.app.inject({ method: 'POST', url: '/v1/sessions', headers: json, payload: { runtime: 'fake' } });
  expect(res.statusCode).toBe(201);
  return res.json<Session>();
}

async function startRun(s: TestServer, sessionId: string, key = 'k1'): Promise<Run> {
  const res = await s.app.inject({
    method: 'POST',
    url: `/v1/sessions/${sessionId}/runs`,
    headers: { ...json, 'idempotency-key': key },
    payload: { prompt: 'hello' },
  });
  expect(res.statusCode).toBe(202);
  return res.json<Run>();
}

/** Polls the pending-approvals list until one shows up. */
async function pendingApproval(s: TestServer, sessionId: string): Promise<ApprovalRequest> {
  for (let i = 0; i < 100; i++) {
    const res = await s.app.inject({ url: `/v1/approvals?sessionId=${sessionId}`, headers: auth });
    const [a] = res.json<ApprovalRequest[]>();
    if (a) return a;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('no pending approval');
}

describe('security', () => {
  it('401 without token (T11)', async () => {
    const s = await servers.make([]);
    const res = await s.app.inject({ url: '/v1/health', headers: { host: HOST } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'unauthorized', retryable: false } });
    expect(res.json().error.requestId).toMatch(/^req_/);

    const wrong = await s.app.inject({ url: '/v1/health', headers: { host: HOST, authorization: 'Bearer nope' } });
    expect(wrong.statusCode).toBe(401);
    const notBearer = await s.app.inject({ url: '/v1/health', headers: { host: HOST, authorization: TOKEN } });
    expect(notBearer.statusCode).toBe(401);
  });

  it('a rejected request does not execute the command (T11)', async () => {
    const s = await servers.make([{ text: 'hi' }]);
    const res = await s.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { host: HOST, 'content-type': 'application/json' },
      payload: { runtime: 'fake' },
    });
    expect(res.statusCode).toBe(401);
    expect(await s.uncage.sessions.list()).toEqual([]);
  });

  it('403 when Origin not allowed even with valid token (T11)', async () => {
    const s = await servers.make([]);
    const res = await s.app.inject({ url: '/v1/health', headers: { ...auth, origin: 'https://evil.example' } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'forbidden_origin' } });
    const nullOrigin = await s.app.inject({ url: '/v1/health', headers: { ...auth, origin: 'null' } });
    expect(nullOrigin.statusCode).toBe(403);
  });

  it('allowed Origin passes', async () => {
    const s = await servers.make([], { allowedOrigins: ['http://localhost:3000'] });
    const res = await s.app.inject({ url: '/v1/health', headers: { ...auth, origin: 'http://localhost:3000' } });
    expect(res.statusCode).toBe(200);
  });

  it('403 on foreign Host header', async () => {
    const s = await servers.make([]);
    for (const host of ['evil.example', `evil.example:${PORT}`, '127.0.0.1:1234', `127.0.0.1.evil.example:${PORT}`, '127.0.0.1']) {
      const res = await s.app.inject({ url: '/v1/health', headers: { ...auth, host } });
      expect(res.statusCode, host).toBe(403);
    }
    const local = await s.app.inject({ url: '/v1/health', headers: { ...auth, host: `localhost:${PORT}` } });
    expect(local.statusCode).toBe(200);
  });

  it('Host is checked before the token', async () => {
    const s = await servers.make([]);
    const res = await s.app.inject({ url: '/v1/health', headers: { host: 'evil.example' } });
    expect(res.statusCode).toBe(403);
  });

  it('no CORS headers on any response', async () => {
    const s = await servers.make([]);
    const responses = await Promise.all([
      s.app.inject({ url: '/v1/health', headers: auth }),
      s.app.inject({ url: '/v1/health', headers: { host: HOST } }),
      s.app.inject({ url: '/v1/health', headers: { ...auth, origin: 'https://evil.example' } }),
      s.app.inject({
        method: 'OPTIONS',
        url: '/v1/sessions',
        headers: { ...auth, origin: 'https://evil.example', 'access-control-request-method': 'POST' },
      }),
      s.app.inject({ url: '/v1/nope', headers: auth }),
    ]);
    for (const res of responses) {
      for (const name of Object.keys(res.headers)) expect(name).not.toMatch(/^access-control-/);
    }
  });
});

describe('routes', () => {
  it('health requires the token and reports version', async () => {
    const s = await servers.make([]);
    const res = await s.app.inject({ url: '/v1/health', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, protocol: '1.0', version: pkg.version });
  });

  it('runtimes, sessions list and snapshot', async () => {
    const s = await servers.make([]);
    const runtimes = await s.app.inject({ url: '/v1/runtimes', headers: auth });
    expect(runtimes.json()).toMatchObject([{ id: 'fake', status: 'available' }]);

    const session = await createSession(s);
    const list = await s.app.inject({ url: '/v1/sessions', headers: auth });
    expect(list.json()).toMatchObject([{ id: session.id }]);
    const snap = await s.app.inject({ url: `/v1/sessions/${session.id}`, headers: auth });
    expect(snap.json<SessionSnapshot>()).toMatchObject({ session: { id: session.id }, runs: [], pendingApprovals: [] });

    const missing = await s.app.inject({ url: '/v1/sessions/ses_nope', headers: auth });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('invalid body → 400 invalid_request', async () => {
    const s = await servers.make([]);
    const res = await s.app.inject({ method: 'POST', url: '/v1/sessions', headers: json, payload: { runtime: 42 } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'invalid_request' } });
    const broken = await s.app.inject({ method: 'POST', url: '/v1/sessions', headers: json, payload: '{not json' });
    expect(broken.statusCode).toBe(400);
    expect(broken.json()).toMatchObject({ error: { code: 'invalid_request' } });
  });

  it('POST runs without Idempotency-Key → 400', async () => {
    const s = await servers.make([{ text: 'hi' }]);
    const session = await createSession(s);
    const res = await s.app.inject({
      method: 'POST',
      url: `/v1/sessions/${session.id}/runs`,
      headers: json,
      payload: { prompt: 'hello' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'invalid_request' } });
    const snap = await s.app.inject({ url: `/v1/sessions/${session.id}`, headers: auth });
    expect(snap.json<SessionSnapshot>().runs).toEqual([]);
  });

  it('run idempotency, get and cancel', async () => {
    const s = await servers.make([{ waitMs: 5000 }]);
    const session = await createSession(s);
    const run = await startRun(s, session.id, 'same');
    expect(run).toMatchObject({ sessionId: session.id, prompt: 'hello' });
    expect((await startRun(s, session.id, 'same')).id).toBe(run.id);

    const got = await s.app.inject({ url: `/v1/runs/${run.id}`, headers: auth });
    expect(got.json<Run>().id).toBe(run.id);
    const cancel = await s.app.inject({ method: 'POST', url: `/v1/runs/${run.id}/cancel`, headers: auth });
    expect(cancel.statusCode).toBe(202);
    expect(cancel.json<Run>().state).toBe('cancelled');
  });

  it('decision twice with different keys → second 409 approval_already_resolved (T06)', async () => {
    const s = await servers.make([shellApproval]);
    const session = await createSession(s);
    await startRun(s, session.id);
    const approval = await pendingApproval(s, session.id);

    const decide = (key: string) =>
      s.app.inject({
        method: 'POST',
        url: `/v1/approvals/${approval.id}/decision`,
        headers: { ...json, 'idempotency-key': key },
        payload: { decision: 'allow', scope: 'once' },
      });
    const first = await decide('a');
    expect(first.statusCode).toBe(200);
    expect(first.json<ApprovalRequest>()).toMatchObject({ id: approval.id, state: 'approved', decision: 'allow' });
    const second = await decide('b');
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: { code: 'approval_already_resolved' } });
  });

  it('decision requires Idempotency-Key and a valid body', async () => {
    const s = await servers.make([shellApproval]);
    const session = await createSession(s);
    await startRun(s, session.id);
    const approval = await pendingApproval(s, session.id);
    const noKey = await s.app.inject({
      method: 'POST',
      url: `/v1/approvals/${approval.id}/decision`,
      headers: json,
      payload: { decision: 'allow', scope: 'once' },
    });
    expect(noKey.statusCode).toBe(400);
    const bad = await s.app.inject({
      method: 'POST',
      url: `/v1/approvals/${approval.id}/decision`,
      headers: { ...json, 'idempotency-key': 'x' },
      payload: { decision: 'maybe', scope: 'once' },
    });
    expect(bad.statusCode).toBe(400);
    expect((await pendingApproval(s, session.id)).state).toBe('pending');
  });

  it('GET approvals requires sessionId', async () => {
    const s = await servers.make([]);
    const res = await s.app.inject({ url: '/v1/approvals', headers: auth });
    expect(res.statusCode).toBe(400);
  });

  it('GET events Accept json returns array', async () => {
    const s = await servers.make([{ text: 'hi', chunks: 2 }]);
    const session = await createSession(s);
    await startRun(s, session.id);
    const sh = await s.uncage.sessions.get(session.id);
    // Wait for the run to finish so the log is stable.
    for await (const e of sh.events({ signal: AbortSignal.timeout(3000) })) if (e.type === 'run.completed') break;

    const res = await s.app.inject({
      url: `/v1/sessions/${session.id}/events?after=0`,
      headers: { ...auth, accept: 'application/json' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    const events = res.json<UncageEvent[]>();
    expect(events[0]?.type).toBe('session.created');
    expect(events.at(-1)?.type).toBe('run.completed');
    expect(events.map((e) => e.sequence)).toEqual(events.map((_, i) => i + 1));

    const page = await s.app.inject({
      url: `/v1/sessions/${session.id}/events?after=2&limit=3`,
      headers: { ...auth, accept: 'application/json' },
    });
    expect(page.json<UncageEvent[]>().map((e) => e.sequence)).toEqual([3, 4, 5]);

    const end = await s.app.inject({
      url: `/v1/sessions/${session.id}/events?after=${events.length}`,
      headers: { ...auth, accept: 'application/json' },
    });
    expect(end.json()).toEqual([]);

    const bad = await s.app.inject({
      url: `/v1/sessions/${session.id}/events?after=-1`,
      headers: { ...auth, accept: 'application/json' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('unknown route → 404 not_found body', async () => {
    const s = await servers.make([]);
    const res = await s.app.inject({ url: '/v1/nope', headers: auth });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('unexpected errors → 500 internal_error without stack', async () => {
    const s = await servers.make([]);
    s.uncage.runtimes.list = () => Promise.reject(new Error('secret internals at /some/path'));
    const res = await s.app.inject({ url: '/v1/runtimes', headers: auth });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body).toMatchObject({ error: { code: 'internal_error', retryable: false } });
    expect(JSON.stringify(body)).not.toContain('secret internals');
    expect(JSON.stringify(body)).not.toContain('stack');
  });
});

describe('over the network', () => {
  it('full flow: create session → run (202) → SSE receives run.completed', async () => {
    const s = await servers.make([{ text: 'Hello there', chunks: 3, delayMs: 5 }], { port: 0 });
    const base = await s.listen();
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

    const created = await fetch(`${base}/v1/sessions`, { method: 'POST', headers, body: JSON.stringify({ runtime: 'fake' }) });
    expect(created.status).toBe(201);
    const session = (await created.json()) as Session;

    const sse = await openSse(`${base}/v1/sessions/${session.id}/events`, { authorization: `Bearer ${TOKEN}` });
    expect(sse.res.status).toBe(200);
    expect(sse.res.headers.get('content-type')).toBe('text/event-stream');
    expect(sse.res.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(sse.res.headers.get('x-accel-buffering')).toBe('no');
    expect(sse.res.headers.get('access-control-allow-origin')).toBeNull();

    const run = await fetch(`${base}/v1/sessions/${session.id}/runs`, {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': 'k' },
      body: JSON.stringify({ prompt: 'hi' }),
    });
    expect(run.status).toBe(202);

    const frames = await sse.until((f) => f.event === 'run.completed');
    sse.close();
    const events = frames.filter((f) => f.event).map((f) => JSON.parse(f.data ?? '') as UncageEvent);
    expect(events[0]?.type).toBe('session.created');
    expect(events.map((e) => e.type)).toContain('message.completed');
    for (const f of frames.filter((x) => x.event)) {
      const e = JSON.parse(f.data ?? '') as UncageEvent;
      expect(f.id).toBe(e.eventId);
      expect(f.event).toBe(e.type);
    }
  });

  it('server restart with a pending approval: run interrupted, approval expired (review focus 2)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'uncage-server-'));
    try {
      const adapter = () => createFakeAdapter({ script: [shellApproval] });
      const u1 = await createUncage({ adapters: [adapter()], dataDir: dir });
      const s1 = { ...(await createUncageServer({ uncage: u1, token: TOKEN, port: PORT })), uncage: u1 };
      const session = await createSession(s1);
      const run = await startRun(s1, session.id);
      const approval = await pendingApproval(s1, session.id);
      await s1.close();
      await u1.close();

      const u2 = await createUncage({ adapters: [adapter()], dataDir: dir });
      const s2 = await createUncageServer({ uncage: u2, token: TOKEN, port: PORT });
      try {
        const r = await s2.app.inject({ url: `/v1/runs/${run.id}`, headers: auth });
        expect(r.json<Run>().state).toBe('interrupted');
        const snap = (await s2.app.inject({ url: `/v1/sessions/${session.id}`, headers: auth })).json<SessionSnapshot>();
        expect(snap.pendingApprovals).toEqual([]);
        const events = (
          await s2.app.inject({ url: `/v1/sessions/${session.id}/events`, headers: { ...auth, accept: 'application/json' } })
        ).json<UncageEvent[]>();
        const last = events.filter((e) => e.type === 'approval.updated').at(-1);
        expect(last?.type === 'approval.updated' && last.payload.approval.state).toBe('expired');
        const decide = await s2.app.inject({
          method: 'POST',
          url: `/v1/approvals/${approval.id}/decision`,
          headers: { ...json, 'idempotency-key': 'late' },
          payload: { decision: 'allow', scope: 'once' },
        });
        expect(decide.statusCode).toBe(410);
        expect(decide.json()).toMatchObject({ error: { code: 'approval_expired' } });
      } finally {
        await s2.close();
        await u2.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('composer endpoints', () => {
  const ATT_CAPS = {
    attachments: { images: true, files: true, maxBytes: ATTACHMENT_LIMITS.maxBytes },
    permissionModes: ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'] as PermissionMode[],
  };
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  let workspace: string;
  beforeEach(() => {
    workspace = realpathSync(mkdtempSync(join(tmpdir(), 'uncage-ws-')));
  });
  afterEach(() => rmSync(workspace, { recursive: true, force: true }));

  const make = (script: FakeStep[] = [], uncageExtra: Partial<UncageOptions> = {}, extra: Partial<ServerOptions> = {}) =>
    servers.make(script, extra, {
      adapters: [createFakeAdapter({ script, capabilities: ATT_CAPS })],
      workspace: { allowedRoots: [workspace], default: workspace },
      ...uncageExtra,
    });

  const upload = (s: TestServer, sessionId: string, name: string | undefined, type: string, body: Buffer) =>
    s.app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/attachments`,
      headers: { ...auth, 'content-type': type, ...(name === undefined ? {} : { 'x-filename': encodeURIComponent(name) }) },
      payload: body,
    });

  const attachmentDir = (sessionId: string) => join(workspace, '.uncage', 'attachments', sessionId);
  const filesIn = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);

  it('PATCH settings → 200 and session.updated over SSE', async () => {
    const s = await make([], {}, { port: 0 });
    const base = await s.listen();
    const session = await (await s.uncage.sessions.create({ runtime: 'fake' })).get();
    const sse = await openSse(`${base}/v1/sessions/${session.id}/events`, { authorization: `Bearer ${TOKEN}` });
    const res = await fetch(`${base}/v1/sessions/${session.id}/settings`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ permissionMode: 'plan' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Session).settings.permissionMode).toBe('plan');
    const frames = await sse.until((f) => f.event === 'session.updated');
    sse.close();
    const e = JSON.parse(frames.at(-1)?.data ?? '') as UncageEvent;
    expect(e.type === 'session.updated' && e.payload.session.settings.permissionMode).toBe('plan');
  });

  it('PATCH settings validates the body', async () => {
    const s = await make();
    const session = await createSession(s);
    for (const payload of [{}, { permissionMode: 'yolo' }, { effort: 'extreme' }]) {
      const res = await s.app.inject({ method: 'PATCH', url: `/v1/sessions/${session.id}/settings`, headers: json, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: 'invalid_request' } });
    }
  });

  it('PATCH bypass with allowBypass false → 403 policy_denied', async () => {
    const s = await make();
    const session = await createSession(s);
    const res = await s.app.inject({
      method: 'PATCH',
      url: `/v1/sessions/${session.id}/settings`,
      headers: json,
      payload: { permissionMode: 'bypassPermissions' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'policy_denied' } });
    const snap = (await s.app.inject({ url: `/v1/sessions/${session.id}`, headers: auth })).json<SessionSnapshot>();
    expect(snap.session.settings.permissionMode).not.toBe('bypassPermissions');
  });

  it('PATCH bypass with allowBypass true → 200', async () => {
    const s = await make([], { security: { allowBypass: true } });
    const session = await createSession(s);
    const res = await s.app.inject({
      method: 'PATCH',
      url: `/v1/sessions/${session.id}/settings`,
      headers: json,
      payload: { permissionMode: 'bypassPermissions' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<Session>().settings.permissionMode).toBe('bypassPermissions');
  });

  it('upload png → 201 Attachment kind image', async () => {
    const s = await make();
    const session = await createSession(s);
    const res = await upload(s, session.id, '设计稿 v2.png', 'image/png', PNG);
    expect(res.statusCode).toBe(201);
    const a = res.json<Attachment>();
    expect(a).toMatchObject({ sessionId: session.id, name: '设计稿 v2.png', mime: 'image/png', size: PNG.length, kind: 'image' });
    expect(a.sha256).toBe(createHash('sha256').update(PNG).digest('hex'));
    expect(a).not.toHaveProperty('absPath');
    expect(filesIn(attachmentDir(session.id))).toEqual([`${a.id}-设计稿 v2.png`]);
  });

  it('upload strips Content-Type parameters', async () => {
    const s = await make();
    const session = await createSession(s);
    const res = await upload(s, session.id, 'notes.md', 'Text/Markdown; charset=utf-8', Buffer.from('# hi'));
    expect(res.statusCode).toBe(201);
    expect(res.json<Attachment>()).toMatchObject({ kind: 'file', mime: 'text/markdown' });
  });

  it('upload without X-Filename or with a malformed one → 400', async () => {
    const s = await make();
    const session = await createSession(s);
    const missing = await upload(s, session.id, undefined, 'image/png', PNG);
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ error: { code: 'invalid_request' } });
    const malformed = await s.app.inject({
      method: 'POST',
      url: `/v1/sessions/${session.id}/attachments`,
      headers: { ...auth, 'content-type': 'image/png', 'x-filename': '%E0%A4%A.png' },
      payload: PNG,
    });
    expect(malformed.statusCode).toBe(400);
    expect(filesIn(attachmentDir(session.id))).toEqual([]);
  });

  it('upload is subject to the token check', async () => {
    const s = await make();
    const session = await createSession(s);
    const res = await s.app.inject({
      method: 'POST',
      url: `/v1/sessions/${session.id}/attachments`,
      headers: { host: HOST, 'content-type': 'image/png', 'x-filename': 'a.png' },
      payload: PNG,
    });
    expect(res.statusCode).toBe(401);
    expect(filesIn(attachmentDir(session.id))).toEqual([]);
  });

  it('upload with mismatched type (x.png as text/plain) → 415 (review focus 2)', async () => {
    const s = await make();
    const session = await createSession(s);
    for (const [name, type] of [['x.png', 'text/plain'], ['x.txt', 'image/png'], ['x.exe', 'application/octet-stream']] as const) {
      const res = await upload(s, session.id, name, type, PNG);
      expect(res.statusCode, name).toBe(415);
      expect(res.json()).toMatchObject({ error: { code: 'attachment_type_unsupported' } });
    }
    expect(filesIn(attachmentDir(session.id))).toEqual([]);
  });

  it('upload 10MB+1 → 413 and no file in dir (review focus 2)', async () => {
    const s = await make();
    const session = await createSession(s);
    const res = await upload(s, session.id, 'big.txt', 'text/plain', Buffer.alloc(ATTACHMENT_LIMITS.maxBytes + 1, 0x61));
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ error: { code: 'attachment_too_large' } });
    expect(filesIn(attachmentDir(session.id))).toEqual([]);
    const exact = await upload(s, session.id, 'max.txt', 'text/plain', Buffer.alloc(ATTACHMENT_LIMITS.maxBytes, 0x61));
    expect(exact.statusCode).toBe(201);
  });

  it('a streamed (chunked) upload over 10MB is rejected mid-stream with a 413 the client receives, and leaves no file (review focus 2)', async () => {
    const s = await make([], {}, { port: 0 });
    const base = await s.listen();
    const session = await (await s.uncage.sessions.create({ runtime: 'fake' })).get();
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    let sent = 0;
    // A streamed body has no Content-Length: the server only learns the size by reading it.
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 64) return controller.close();
        sent++;
        controller.enqueue(new Uint8Array(chunk));
      },
    });
    const res = await fetch(`${base}/v1/sessions/${session.id}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'text/plain', 'x-filename': 'big.txt' },
      body,
      duplex: 'half',
    } as RequestInit);
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: { code: 'attachment_too_large' } });
    expect(sent).toBeLessThan(64);
    expect(filesIn(attachmentDir(session.id))).toEqual([]);
  });

  it('upload to an unknown session → 404', async () => {
    const s = await make();
    const res = await upload(s, 'ses_nope', 'a.png', 'image/png', PNG);
    expect(res.statusCode).toBe(404);
  });

  it('GET attachment returns bytes with nosniff', async () => {
    const s = await make();
    const session = await createSession(s);
    const a = (await upload(s, session.id, '设计稿.png', 'image/png', PNG)).json<Attachment>();
    const res = await s.app.inject({ url: `/v1/attachments/${a.id}`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(PNG)).toBe(true);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-length']).toBe(String(PNG.length));
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(res.headers['content-disposition']).toBe(`inline; filename="_.png"; filename*=UTF-8''${encodeURIComponent('设计稿.png')}`);

    const f = (await upload(s, session.id, 'a "b".md', 'text/markdown', Buffer.from('# x'))).json<Attachment>();
    const file = await s.app.inject({ url: `/v1/attachments/${f.id}`, headers: auth });
    expect(file.body).toBe('# x');
    expect(file.headers['content-disposition']).toBe(`attachment; filename="a _b_.md"; filename*=UTF-8''a%20%22b%22.md`);
    expect(file.headers['x-content-type-options']).toBe('nosniff');
  });

  it('upload of an image whose mime differs from its extension (svg on .png) → 415', async () => {
    const s = await make();
    const session = await createSession(s);
    const res = await upload(s, session.id, 'x.png', 'image/svg+xml', Buffer.from('<svg/>'));
    expect(res.statusCode).toBe(415);
    expect(res.json()).toMatchObject({ error: { code: 'attachment_type_unsupported' } });
    expect(filesIn(attachmentDir(session.id))).toEqual([]);
  });

  it('GET attachment requires the token; unknown or deleted → 404', async () => {
    const s = await make();
    const session = await createSession(s);
    const a = (await upload(s, session.id, 'a.png', 'image/png', PNG)).json<Attachment>();
    const noToken = await s.app.inject({ url: `/v1/attachments/${a.id}`, headers: { host: HOST } });
    expect(noToken.statusCode).toBe(401);
    const missing = await s.app.inject({ url: '/v1/attachments/att_nope', headers: auth });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: 'not_found' } });
    rmSync(join(attachmentDir(session.id), readdirSync(attachmentDir(session.id))[0] ?? ''));
    const gone = await s.app.inject({ url: `/v1/attachments/${a.id}`, headers: auth });
    expect(gone.statusCode).toBe(404);
  });

  it('GET /v1/runs?active=1 lists running run', async () => {
    const s = await make([{ waitMs: 5000 }]);
    const session = await createSession(s);
    const empty = await s.app.inject({ url: '/v1/runs?active=1', headers: auth });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual([]);
    const run = await startRun(s, session.id);
    const res = await s.app.inject({ url: '/v1/runs?active=1', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json<ActiveRunInfo[]>()).toMatchObject([{ runId: run.id, sessionId: session.id }]);
    const all = await s.app.inject({ url: '/v1/runs', headers: auth });
    expect(all.statusCode).toBe(400);
    await s.app.inject({ method: 'POST', url: `/v1/runs/${run.id}/cancel`, headers: auth });
  });

  it('runs with attachmentIds → run.started carries attachments', async () => {
    const s = await make([{ text: 'seen' }]);
    const session = await createSession(s);
    const a = (await upload(s, session.id, 'a.png', 'image/png', PNG)).json<Attachment>();
    const res = await s.app.inject({
      method: 'POST',
      url: `/v1/sessions/${session.id}/runs`,
      headers: { ...json, 'idempotency-key': 'att' },
      payload: { prompt: 'look', attachmentIds: [a.id] },
    });
    expect(res.statusCode).toBe(202);
    const sh = await s.uncage.sessions.get(session.id);
    let started: UncageEvent | undefined;
    for await (const e of sh.events({ signal: AbortSignal.timeout(3000) })) {
      if (e.type === 'run.started') started = e;
      if (e.type === 'run.completed') break;
    }
    expect(started?.type === 'run.started' && started.payload.run.attachments).toEqual([a]);

    const other = await createSession(s);
    const foreign = await s.app.inject({
      method: 'POST',
      url: `/v1/sessions/${other.id}/runs`,
      headers: { ...json, 'idempotency-key': 'foreign' },
      payload: { prompt: 'look', attachmentIds: [a.id] },
    });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json()).toMatchObject({ error: { code: 'invalid_request' } });
  });
});
