import { UncageError } from '@uncage/core';
import {
  ApprovalDecisionSchema,
  CreateSessionBodySchema,
  DeviceCodeRequestSchema,
  MAX_ATTACHMENT_TRANSFER_BYTES,
  MAX_FRAME_BYTES,
  MAX_READ_EVENTS,
  parseEventId,
  SessionManifestSchema,
  StartRunBodySchema,
  UpdateSessionSettingsBodySchema,
  type ActiveRunInfo,
  type HealthResponse,
  type MachineInfo,
  type Session,
  type SessionManifest,
  type SessionSnapshot,
  type SkillSpec,
  type ToolSpec,
  type UncageEvent,
} from '@uncage/protocol';
import { downloadHeaders } from '@uncage/server/wire';
import { z } from 'zod';
import type { ClusterAdapter } from './cluster/cluster.js';
import { sha256, type DeviceFlow } from './device.js';
import { sessionChannel, type MachineHub } from './machines.js';
import { toSessionSnapshot } from './replica.js';
import { eventStreamResponse, readHistory, type EventSource } from './sse.js';
import type { HubStore, MachineRecord, ResourceKind, SessionRecord } from './store/store.js';
import type { HubOptions, HubUser } from './types.js';

/**
 * Largest attachment the hub relays to a machine (the attachment limit, 10 MiB; runtimes may
 * accept less, e.g. 5 MB images for Claude Code — the machine enforces that).
 */
export const HUB_ATTACHMENT_MAX_BYTES = MAX_ATTACHMENT_TRANSFER_BYTES;
/**
 * Up to this size an attachment travels as one `addAttachment` command (its base64 fits one wire
 * frame); larger ones use the chunked `attachment_*` transfer.
 */
export const SINGLE_FRAME_ATTACHMENT_BYTES = Math.floor(((MAX_FRAME_BYTES - 16 * 1024) * 3) / 4);
const MAX_JSON_BODY = 1024 * 1024;
const MAX_IDEMPOTENCY_KEY = 256;
const JSON_EVENTS_LIMIT = 1000;

export interface ApiContext {
  store: HubStore;
  cluster: ClusterAdapter;
  machines: MachineHub;
  device: DeviceFlow;
  getUser: HubOptions['getUser'];
  selectManifest: NonNullable<HubOptions['selectManifest']>;
  tools: Map<string, ToolSpec>;
  skills: Map<string, SkillSpec>;
  sessionStorage: 'machine' | 'site';
  publicOrigin: string;
  install: { install: string; setup: string; windows: null };
  installScript: string;
  version: string;
  sseHeartbeatMs: number;
  shutdown: AbortSignal;
}

type Params = Record<string, string>;
interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  /** Public routes skip `getUser` (machine-side device endpoints, the installer). */
  public?: boolean;
  run(c: Call): Promise<Response>;
}
interface Call {
  req: Request;
  url: URL;
  params: Params;
  user: HubUser;
  requestId: string;
  /** Rate-limit key for the caller (IP). */
  clientKey: string;
}

const json = (data: unknown, status = 200): Response => Response.json(data, { status });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new UncageError('invalid_request', {
      details: { issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
    });
  }
  return r.data;
}

/** Reads at most `limit` bytes of the body; `null` when it is longer. */
async function readBody(req: Request, limit: number): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

async function readJson(req: Request): Promise<unknown> {
  const bytes = await readBody(req, MAX_JSON_BODY);
  if (bytes === null) throw new UncageError('invalid_request', { message: 'The request body is too large.' });
  const text = new TextDecoder().decode(bytes);
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new UncageError('invalid_request', { message: 'The request body is not valid JSON.' });
  }
}

function idempotencyKey(req: Request): string {
  const key = req.headers.get('idempotency-key');
  if (!key || key.length > MAX_IDEMPOTENCY_KEY) {
    throw new UncageError('invalid_request', {
      message: 'The Idempotency-Key header is required.',
      hint: 'Send a unique Idempotency-Key header (for example a UUID) with this request.',
    });
  }
  return key;
}

function nonNegativeInt(value: string | null, name: string): number | undefined {
  if (value === null) return undefined;
  if (/^\d{1,15}$/.test(value)) return Number(value);
  throw new UncageError('invalid_request', { message: `${name} must be a non-negative integer.` });
}

const toBase64 = (b: Uint8Array): string => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('base64');

export function browserApi(ctx: ApiContext) {
  const { store, machines } = ctx;
  const site = ctx.sessionStorage === 'site';

  const sessionNotFound = (id: string) => new UncageError('not_found', { message: `Session ${id} not found.` });

  /** The user's session, or 404 — identical for "missing" and "someone else's". */
  async function ownedSession(user: HubUser, id: string): Promise<SessionRecord> {
    const rec = await store.getSession(id);
    if (!rec || rec.userId !== user.id) throw sessionNotFound(id);
    return rec;
  }

  async function ownedResource(user: HubUser, kind: ResourceKind, id: string): Promise<SessionRecord> {
    const notFound = new UncageError('not_found', { message: `${kind[0]!.toUpperCase()}${kind.slice(1)} ${id} not found.` });
    const ref = await store.getResource(id, kind);
    if (!ref) throw notFound;
    const rec = await store.getSession(ref.sessionId);
    if (!rec || rec.userId !== user.id) throw notFound;
    return rec;
  }

  async function ownedMachine(user: HubUser, id: string): Promise<MachineRecord> {
    const m = await store.getMachine(id);
    if (!m || m.userId !== user.id) throw new UncageError('machine_not_found', { message: `Machine ${id} not found.` });
    return m;
  }

  /** Explicit machine, else the most recently seen online one. */
  async function pickMachine(user: HubUser, machineId?: string): Promise<MachineRecord> {
    if (machineId !== undefined) {
      const m = await ownedMachine(user, machineId);
      if (!(await machines.isOnline(m.id))) throw new UncageError('machine_offline');
      return m;
    }
    const all = await store.listMachines(user.id);
    for (const m of all) if (await machines.isOnline(m.id)) return m;
    if (all.length === 0) {
      throw new UncageError('machine_not_found', {
        message: 'No computer is connected to this account yet.',
        hint: 'Connect your computer first (install the Uncage CLI and run `uncage setup`).',
      });
    }
    throw new UncageError('machine_offline');
  }

  const toMachineInfo = async (m: MachineRecord): Promise<MachineInfo> => ({
    id: m.id,
    name: m.name,
    os: m.os,
    agentVersion: m.agentVersion,
    runtimes: m.runtimes,
    online: await machines.isOnline(m.id),
    lastSeenAt: m.lastSeenAt,
  });

  async function snapshotOf(rec: SessionRecord): Promise<SessionSnapshot> {
    if (site) {
      const s = toSessionSnapshot(rec.snapshot);
      if (s) return s;
    }
    return machines.command(rec.machineId, 'snapshot', { sessionId: rec.id });
  }

  function eventSource(rec: SessionRecord): EventSource {
    return {
      history: (after, limit) =>
        site
          ? store.readEvents(rec.id, after, limit)
          : machines.command(rec.machineId, 'readEvents', { sessionId: rec.id, after, limit: Math.min(limit, MAX_READ_EVENTS) }),
      subscribe: (fn) =>
        ctx.cluster.subscribe(sessionChannel(rec.id), (raw) => {
          try {
            fn((JSON.parse(raw) as { events: UncageEvent[] }).events);
          } catch {
            // ignore a malformed broadcast
          }
        }),
    };
  }

  async function manifestFor(user: HubUser, prompt: string, sessionId: string): Promise<SessionManifest> {
    const pick = await ctx.selectManifest({ user, prompt, sessionId });
    const manifest = {
      tools: [...new Set(pick.tools)].flatMap((n) => (ctx.tools.has(n) ? [ctx.tools.get(n)!] : [])),
      skills: [...new Set(pick.skills)].flatMap((n) => (ctx.skills.has(n) ? [ctx.skills.get(n)!] : [])),
    };
    const r = SessionManifestSchema.safeParse(manifest);
    if (!r.success) {
      throw new UncageError('internal_error', {
        message: `selectManifest picked an invalid manifest: ${r.error.issues[0]?.message ?? 'bad shape'}`,
      });
    }
    return r.data;
  }

  const routes: Route[] = [];
  const add = (method: string, path: string, run: Route['run'], opts: { public?: boolean } = {}) => {
    const keys: string[] = [];
    const pattern = new RegExp(
      `^${path.replace(/:(\w+)/g, (_m, k: string) => {
        keys.push(k);
        return '([^/]+)';
      })}$`,
    );
    routes.push({ method, pattern, keys, run, ...opts });
  };

  // ---- Machine side (no website session) -------------------------------------------------------
  add('GET', '/install.sh', async () =>
    new Response(ctx.installScript, {
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' },
    }),
  { public: true });

  add('POST', '/device/code', async ({ req, clientKey }) => {
    const body = parse(DeviceCodeRequestSchema, (await readJson(req)) ?? {});
    return json(await ctx.device.createCode(body, clientKey));
  }, { public: true });

  add('POST', '/device/token', async ({ req }) => {
    const { deviceCode } = parse(z.object({ deviceCode: z.string().min(1).max(256) }), await readJson(req));
    const r = await ctx.device.poll(deviceCode);
    if (!r) throw new UncageError('not_found', { message: 'Unknown device code.', hint: 'Start the connection flow again.' });
    return json(r);
  }, { public: true });

  // `uncage sites remove`: the machine revokes itself with its own token.
  add('POST', '/machine/revoke', async ({ req }) => {
    const m = /^Bearer (\S+)$/i.exec(req.headers.get('authorization') ?? '');
    const machine = m ? await store.findMachineByTokenHash(sha256(m[1]!)) : null;
    if (!machine) throw new UncageError('unauthorized', { message: 'Unknown or revoked machine token.' });
    await store.deleteMachine(machine.id);
    await machines.kick(machine.id);
    return json({ ok: true });
  }, { public: true });

  // ---- Browser API (same shapes as the daemon's /v1) -------------------------------------------
  add('GET', '/health', async () =>
    json({ ok: true, protocol: '1.0', version: ctx.version } satisfies HealthResponse),
  );

  add('GET', '/runtimes', async ({ url, user }) => {
    const machineId = url.searchParams.get('machineId');
    if (machineId !== null) return json((await ownedMachine(user, machineId)).runtimes);
    const all = await store.listMachines(user.id);
    for (const m of all) if (await machines.isOnline(m.id)) return json(m.runtimes);
    return json(all[0]?.runtimes ?? []);
  });

  add('GET', '/machines', async ({ user }) =>
    json(await Promise.all((await store.listMachines(user.id)).map(toMachineInfo))),
  );
  add('GET', '/machines/install', async () => json(ctx.install));
  add('DELETE', '/machines/:id', async ({ params, user }) => {
    await revokeMachine(params.id!, user);
    return json({ ok: true });
  });

  add('GET', '/sessions', async ({ user }) => {
    const recs = await store.listSessions(user.id);
    if (site) return json(recs.flatMap((r) => (r.snapshot?.session ? [r.snapshot.session] : [])));
    const owned = new Map(recs.map((r) => [r.id, r]));
    const lists = await Promise.allSettled(
      (await store.listMachines(user.id)).map(async (m) =>
        (await machines.isOnline(m.id))
          ? (await machines.command(m.id, 'listSessions', {})).filter((s) => owned.get(s.id)?.machineId === m.id)
          : [],
      ),
    );
    const sessions: Session[] = lists.flatMap((l) => (l.status === 'fulfilled' ? l.value : []));
    sessions.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return json(sessions);
  });

  add('POST', '/sessions', async ({ req, user }) => {
    const body = parse(CreateSessionBodySchema.extend({ machineId: z.string().optional() }), await readJson(req));
    const machine = await pickMachine(user, body.machineId);
    // The machine chooses the session workspace; a browser-supplied `workspace` is ignored.
    const session = await machines.command(machine.id, 'createSession', {
      runtime: body.runtime,
      ...(body.title !== undefined ? { title: body.title } : {}),
    });
    const rec = await store.insertSession({
      id: session.id,
      userId: user.id,
      machineId: machine.id,
      createdAt: session.createdAt,
      title: session.title,
      lastSequence: 0,
      ...(site ? { snapshot: { session, runs: [], pendingApprovals: [], lastSequence: 0 } } : {}),
    });
    if (rec.userId !== user.id || rec.machineId !== machine.id) throw new UncageError('internal_error');
    return json(session, 201);
  });

  add('GET', '/sessions/:id', async ({ params, user }) => json(await snapshotOf(await ownedSession(user, params.id!))));

  add('PATCH', '/sessions/:id/settings', async ({ req, params, user }) => {
    const rec = await ownedSession(user, params.id!);
    const patch = parse(UpdateSessionSettingsBodySchema, await readJson(req));
    return json(await machines.command(rec.machineId, 'updateSettings', { sessionId: rec.id, patch }));
  });

  add('POST', '/sessions/:id/runs', async ({ req, params, user }) => {
    const key = idempotencyKey(req);
    const body = parse(StartRunBodySchema, await readJson(req));
    const rec = await ownedSession(user, params.id!);
    const manifest = await manifestFor(user, body.prompt, rec.id);
    // Record the offered tools before the machine can start the run: tool calls are accepted only
    // for tools in their run's manifest (bound to the run id once it is known).
    const manifestKey = `${rec.id}:${key}`;
    await store.putRunManifest({ key: manifestKey, sessionId: rec.id, tools: manifest.tools.map((t) => t.name), createdAt: new Date().toISOString() });
    let run;
    try {
      run = await machines.command(rec.machineId, 'startRun', {
        sessionId: rec.id,
        prompt: body.prompt,
        ...(body.attachmentIds !== undefined ? { attachmentIds: body.attachmentIds } : {}),
        idempotencyKey: key,
        manifest,
      });
    } catch (err) {
      // Refused by the machine: no run will use it. (A timeout may still have started one; a retry
      // with the same Idempotency-Key binds it.)
      if (!(err instanceof UncageError && err.code === 'machine_offline')) await store.deleteRunManifest(manifestKey).catch(() => undefined);
      throw err;
    }
    if (run.sessionId === rec.id) {
      await store.putResource(run.id, 'run', rec.id);
      await store.bindRunManifest(manifestKey, run.id);
    }
    return json(run, 202);
  });

  add('GET', '/sessions/:id/events', async ({ req, url, params, user, requestId }) => {
    let after: number;
    const lastEventId = req.headers.get('last-event-id');
    if (lastEventId) {
      const seq = parseEventId(lastEventId);
      if (seq === null) throw new UncageError('invalid_request', { message: 'Last-Event-ID is not a valid event id.' });
      after = seq;
    } else after = nonNegativeInt(url.searchParams.get('after'), 'after') ?? 0;
    const rec = await ownedSession(user, params.id!);
    const src = eventSource(rec);
    const accept = (req.headers.get('accept') ?? '').toLowerCase();
    if (accept.includes('application/json') && !accept.includes('text/event-stream')) {
      const limit = Math.min(nonNegativeInt(url.searchParams.get('limit'), 'limit') ?? JSON_EVENTS_LIMIT, JSON_EVENTS_LIMIT);
      return json(limit === 0 ? [] : await readHistory(src, after, limit));
    }
    return eventStreamResponse(src, { after, heartbeatMs: ctx.sseHeartbeatMs, signals: [req.signal, ctx.shutdown], requestId });
  });

  add('POST', '/sessions/:id/attachments', async ({ req, params, user }) => {
    const raw = req.headers.get('x-filename');
    if (!raw) {
      throw new UncageError('invalid_request', {
        message: 'The X-Filename header is required.',
        hint: 'Send the file name, URI-encoded (encodeURIComponent), in the X-Filename header.',
      });
    }
    let name: string;
    try {
      name = decodeURIComponent(raw);
    } catch {
      throw new UncageError('invalid_request', { message: 'The X-Filename header is not valid URI-encoded text.' });
    }
    const mime = (req.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    if (mime === '') throw new UncageError('invalid_request', { message: 'The Content-Type header is required.' });
    const rec = await ownedSession(user, params.id!);
    const tooLarge = () =>
      new UncageError('attachment_too_large', {
        message: `Attachments sent through the website can be at most ${HUB_ATTACHMENT_MAX_BYTES} bytes.`,
        details: { maxBytes: HUB_ATTACHMENT_MAX_BYTES },
      });
    if (Number(req.headers.get('content-length')) > HUB_ATTACHMENT_MAX_BYTES) throw tooLarge();
    const data = await readBody(req, HUB_ATTACHMENT_MAX_BYTES);
    if (data === null) throw tooLarge();
    const attachment =
      data.byteLength <= SINGLE_FRAME_ATTACHMENT_BYTES
        ? await machines.command(rec.machineId, 'addAttachment', { sessionId: rec.id, name, mime, data: toBase64(data) })
        : await machines.upload(rec.machineId, { sessionId: rec.id, name, mime }, data);
    if (attachment.sessionId !== rec.id) throw new UncageError('internal_error', { message: 'The machine sent an invalid response.' });
    await store.putResource(attachment.id, 'attachment', rec.id);
    await store.putAttachment({ attachment, userId: user.id, data });
    return json(attachment, 201);
  });

  add('GET', '/attachments/:id', async ({ params, user }) => {
    const rec = await store.getAttachment(params.id!);
    if (!rec || rec.userId !== user.id) throw new UncageError('not_found', { message: `Attachment ${params.id} not found.` });
    return new Response(rec.data, { headers: downloadHeaders(rec.attachment, rec.data.byteLength) });
  });

  add('GET', '/runs', async ({ url, user }) => {
    if (url.searchParams.get('active') !== '1') {
      throw new UncageError('invalid_request', { message: 'Only GET /runs?active=1 is supported.' });
    }
    const recs = await store.listSessions(user.id);
    return json(
      recs.flatMap((r): ActiveRunInfo[] =>
        r.activeRun
          ? [{ runId: r.activeRun.id, sessionId: r.id, sessionTitle: r.title, state: r.activeRun.state, ...(r.activeRun.startedAt ? { startedAt: r.activeRun.startedAt } : {}) }]
          : [],
      ),
    );
  });

  add('GET', '/runs/:id', async ({ params, user }) => {
    const rec = await ownedResource(user, 'run', params.id!);
    const run = (await snapshotOf(rec)).runs.find((r) => r.id === params.id);
    if (!run) throw new UncageError('not_found', { message: `Run ${params.id} not found.` });
    return json(run);
  });

  add('POST', '/runs/:id/cancel', async ({ params, user }) => {
    const rec = await ownedResource(user, 'run', params.id!);
    return json(await machines.command(rec.machineId, 'cancelRun', { runId: params.id! }), 202);
  });

  add('GET', '/approvals', async ({ url, user }) => {
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) throw new UncageError('invalid_request', { message: 'sessionId is required.' });
    return json((await snapshotOf(await ownedSession(user, sessionId))).pendingApprovals);
  });

  add('POST', '/approvals/:id/decision', async ({ req, params, user }) => {
    const key = idempotencyKey(req);
    const decision = parse(ApprovalDecisionSchema, await readJson(req));
    const rec = await ownedResource(user, 'approval', params.id!);
    return json(await machines.command(rec.machineId, 'decide', { approvalId: params.id!, decision, idempotencyKey: key }));
  });

  async function revokeMachine(machineId: string, user: HubUser): Promise<void> {
    await ownedMachine(user, machineId);
    await store.deleteMachine(machineId);
    await machines.kick(machineId);
  }

  /** Browser requests that change state must come from the website itself (cookie-auth CSRF guard). */
  function crossSite(req: Request): boolean {
    if (req.method === 'GET' || req.method === 'HEAD') return false;
    if (req.headers.get('sec-fetch-site') === 'cross-site') return true;
    const origin = req.headers.get('origin');
    if (origin === null) return false;
    if (origin === ctx.publicOrigin) return false;
    const host = req.headers.get('host');
    try {
      return host === null || new URL(origin).host !== host;
    } catch {
      return true;
    }
  }

  /** Routes a request whose path (below `basePath`) is `path`. */
  async function handle(req: Request, url: URL, path: string, requestId: string, clientKey: string): Promise<Response> {
    let matchedPath = false;
    for (const r of routes) {
      const m = r.pattern.exec(path);
      if (!m) continue;
      matchedPath = true;
      if (r.method !== req.method) continue;
      const params: Params = {};
      try {
        r.keys.forEach((k, i) => {
          params[k] = decodeURIComponent(m[i + 1]!);
        });
      } catch {
        throw new UncageError('not_found', { message: `No route for ${req.method} ${path}.` });
      }
      let user: HubUser = { id: '' };
      if (!r.public) {
        const u = await ctx.getUser(req);
        if (!u) {
          throw new UncageError('unauthorized', {
            message: 'You are not signed in.',
            hint: 'Sign in to the website and retry.',
          });
        }
        if (crossSite(req)) throw new UncageError('forbidden_origin', { message: 'Cross-site request refused.' });
        user = u;
      }
      return r.run({ req, url, params, user, requestId, clientKey });
    }
    throw new UncageError(matchedPath ? 'invalid_request' : 'not_found', {
      message: matchedPath ? `Method ${req.method} is not allowed for ${path}.` : `No route for ${req.method} ${path}.`,
    });
  }

  return { handle, revokeMachine };
}
