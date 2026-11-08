/**
 * HTTP streaming transport (FaaS mode): machine routes under `<basePath>/agent`, served by any
 * instance through `hub.fetch` — no WebSocket, no state held between requests.
 *
 * - `GET  /agent/info` (public): protocol, minimum agent version and the offered transports.
 * - `POST /agent/connect`: the `hello`; opens the machine's link (`linkId`, starting `cursor`).
 * - `GET  /agent/stream?link=&cursor=`: NDJSON. Acknowledges `cursor`, then streams outbox items
 *   `> cursor` as `{seq,msg}` (polling the outbox adaptively; a `machineChannel` wake polls at
 *   once), `{ctl:'ping'}` every heartbeat, and ends with `{ctl:'rotate'}` at `stream.maxDurationMs`
 *   (or `replaced` / `revoked` when the link is no longer current).
 * - `POST /agent/events`: a batch of upstream messages with idempotent ids, deduped through the
 *   store inbox and processed strictly in order.
 * - `POST /agent/disconnect`: closes the link (the machine goes offline at once).
 *
 * The agent must resend an unprocessed upstream message only within a window far shorter than the
 * hub's inbox retention (24 h): a resend arriving after its dedupe row was pruned is processed again.
 */
import { UncageError } from '@uncage/core/errors';
import {
  CONNECTED_PROTOCOL,
  HTTP_STREAM_CONTENT_TYPE,
  LINK_ID,
  MAX_HTTP_BODY_BYTES,
  MIN_AGENT_VERSION,
  ProtocolFrameError,
  parseAgentFrame,
  parseHttpEventsRequest,
  type AgentInfo,
  type HttpConnectResponse,
  type HttpEventsRequest,
  type HttpEventsResponse,
  type HubFrame,
  type StreamLine,
} from '@uncage/protocol';
import type { ClusterAdapter } from './cluster/cluster.js';
import { compareVersions, machineChannel, type HubLogger, type MachineHub, type MachineLink } from './machines.js';
import type { HubStore, LinkState, MachineRecord } from './store/store.js';
import { randomHex, readBody, unrefTimer } from './web.js';

/** Outbox items read per poll. */
const POLL_PAGE = 32;
/**
 * An upstream message (other than a tool call) is claimed for this long: if the instance handling
 * it dies, another one may take it over after that.
 */
const MESSAGE_LEASE_MS = 30_000;

export interface HttpTransportContext {
  store: HubStore;
  cluster: ClusterAdapter;
  machines: MachineHub;
  logger: HubLogger;
  minAgentVersion: string;
  /** What `GET /agent/info` answers (the offered transports are read at each call). */
  agentInfo(): AgentInfo;
  stream: { maxDurationMs: number };
  polling: { activeMs: number; idleMs: number; activeWindowMs: number };
  pingIntervalMs: number;
  /** Inbox lease of a `tool_call` message: its handler may run this long. */
  toolLeaseMs: number;
  /** Aborts when the hub closes: open streams end with `rotate` (the agent reconnects elsewhere). */
  shutdown: AbortSignal;
}

const json = (data: unknown, status = 200): Response => Response.json(data, { status });
const iso = (ms: number): string => new Date(ms).toISOString();
const encoder = new TextEncoder();

const STREAM_HEADERS = {
  'content-type': HTTP_STREAM_CONTENT_TYPE,
  'cache-control': 'no-cache, no-transform',
  'x-accel-buffering': 'no',
};

const tooLarge = () => new UncageError('invalid_request', { message: `The request body is larger than ${MAX_HTTP_BODY_BYTES} bytes.` });

/** The body as text, at most `MAX_HTTP_BODY_BYTES` (checked before and while reading). */
async function readText(req: Request): Promise<string> {
  const bytes = await readBody(req, MAX_HTTP_BODY_BYTES);
  if (bytes === null) throw tooLarge();
  return new TextDecoder().decode(bytes);
}

function cursorParam(value: string | null): number {
  if (value === null || value === '') return 0;
  if (/^\d{1,15}$/.test(value)) return Number(value);
  throw new UncageError('invalid_request', { message: 'cursor must be a non-negative integer.' });
}

export function httpTransport(ctx: HttpTransportContext) {
  const { store, machines, logger } = ctx;
  /** The HTTP transport needs agent 0.3 (the first with it), whatever `minAgentVersion` says. */
  const requiredVersion = compareVersions(ctx.minAgentVersion, MIN_AGENT_VERSION) > 0 ? ctx.minAgentVersion : MIN_AGENT_VERSION;

  async function machineOf(req: Request): Promise<MachineRecord | null> {
    const m = /^Bearer (\S+)$/i.exec(req.headers.get('authorization') ?? '');
    return m?.[1] ? machines.authenticate(m[1]) : null;
  }

  async function authenticate(req: Request): Promise<MachineRecord> {
    const machine = await machineOf(req);
    if (!machine) {
      throw new UncageError('unauthorized', { message: 'Missing or invalid machine token.', hint: 'Run `uncage setup <site>` again to pair this machine.' });
    }
    return machine;
  }

  /** A link for one request: non-durable frames become the response's `replies`. */
  function requestLink(machine: MachineRecord, linkId: string, replies: HubFrame[]): MachineLink {
    return {
      kind: 'http',
      linkId,
      machine,
      // A dropped request must not abandon work the agent will retry (the retry is deduped).
      signal: ctx.shutdown,
      async send(f, o) {
        if (o?.durable) await machines.enqueue(machine.id, [{ msgId: `${linkId}:${randomHex(8)}`, msg: f, ttlMs: 600_000 }]);
        else replies.push(f);
      },
    };
  }

  /** `GET /agent` with `Upgrade: websocket` reached `fetch`: nobody serves WebSockets here (FaaS). */
  async function upgradeRefused(req: Request): Promise<never> {
    const machine = await machineOf(req);
    if (machine) await machines.markOutdated(machine.id);
    throw new UncageError('upgrade_required', {
      message: `This website needs Uncage agent ${requiredVersion} or newer. On this computer run: npm i -g @uncage/cli@latest`,
      hint: 'Then reconnect: the new agent connects over HTTP.',
    });
  }

  async function connect(req: Request): Promise<Response> {
    const machine = await authenticate(req);
    const text = await readText(req);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new UncageError('invalid_request', { message: 'The request body is not valid JSON.' });
    }
    const upgrade = (): Response => json({ t: 'upgrade_required', minAgentVersion: requiredVersion } satisfies HttpConnectResponse, 426);
    // An older agent's hello (protocol 1 had no `transport`): tell it to upgrade before validating.
    const r0 = raw as { t?: unknown; protocol?: unknown } | null;
    if (r0 && typeof r0 === 'object' && r0.t === 'hello' && typeof r0.protocol === 'number' && r0.protocol < CONNECTED_PROTOCOL) {
      await machines.markOutdated(machine.id);
      return upgrade();
    }
    let frame;
    try {
      frame = parseAgentFrame(text);
    } catch (err) {
      throw new UncageError('invalid_request', { message: err instanceof ProtocolFrameError ? err.message : 'Invalid hello.' });
    }
    if (frame.t !== 'hello' || frame.transport !== 'http') {
      throw new UncageError('invalid_request', { message: 'POST /agent/connect takes a hello with transport "http".' });
    }
    const replies: HubFrame[] = [];
    const link = requestLink(machine, `lnk_${randomHex(12)}`, replies);
    const r = await machines.hello(link, frame);
    if (r === 'upgrade') return upgrade();
    if (r === 'hub_too_old') {
      throw new UncageError('invalid_request', {
        message: `This website's Uncage hub speaks protocol ${CONNECTED_PROTOCOL}, older than this agent's ${frame.protocol}.`,
        hint: 'Ask the website to update @uncage/hub.',
        details: { reason: 'hub_too_old' },
      });
    }
    if (r === 'revoked') throw new UncageError('unauthorized', { message: 'This machine was revoked.' });
    return json({
      t: 'welcome',
      machineId: machine.id,
      protocol: CONNECTED_PROTOCOL,
      minAgentVersion: ctx.minAgentVersion,
      linkId: link.linkId,
      cursor: link.cursor ?? 0,
      replies: replies.filter((f) => f.t !== 'welcome'),
    } satisfies HttpConnectResponse);
  }

  async function stream(req: Request, url: URL): Promise<Response> {
    const machine = await authenticate(req);
    const linkId = url.searchParams.get('link') ?? '';
    if (!LINK_ID.test(linkId)) throw new UncageError('invalid_request', { message: 'link must be a link id from POST /agent/connect.' });
    const cursor = cursorParam(url.searchParams.get('cursor'));
    // Everything up to the cursor was processed by the agent: delete it.
    const state = await store.updateLink(machine.id, linkId, { ackedSeq: cursor, at: iso(Date.now()) });

    const ac = new AbortController();
    const abort = () => ac.abort();
    const signals = [req.signal, ctx.shutdown];
    for (const s of signals) {
      if (s.aborted) ac.abort();
      else s.addEventListener('abort', abort, { once: true });
    }
    /** Resolves when the consumer wants more (backpressure) or the stream is aborted. */
    let pulled: (() => void) | undefined;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
      pull() {
        pulled?.();
        pulled = undefined;
      },
      cancel() {
        ac.abort();
      },
    });
    const write = (line: StreamLine) => {
      if (ac.signal.aborted && !ctx.shutdown.aborted) return;
      try {
        controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
      } catch {
        // cancelled by the consumer
      }
    };
    const drained = (): Promise<void> =>
      (controller.desiredSize ?? 1) > 0 || ac.signal.aborted
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            pulled = resolve;
            ac.signal.addEventListener('abort', () => resolve(), { once: true });
          });

    void pump(machine, linkId, cursor, state, ac.signal, write, drained)
      .catch((err: unknown) => logger.error({ err, machineId: machine.id }, 'machine stream failed'))
      .finally(() => {
        for (const s of signals) s.removeEventListener('abort', abort);
        try {
          controller.close();
        } catch {
          // already cancelled
        }
      });
    return new Response(body, { status: 200, headers: STREAM_HEADERS });
  }

  async function pump(
    machine: MachineRecord,
    linkId: string,
    cursor: number,
    initial: LinkState,
    signal: AbortSignal,
    write: (l: StreamLine) => void,
    drained: () => Promise<void>,
  ): Promise<void> {
    const end: Record<Exclude<LinkState, 'current'>, StreamLine> = { replaced: { ctl: 'replaced' }, gone: { ctl: 'revoked' } };
    if (initial !== 'current') {
      write(end[initial]);
      return;
    }
    const { maxDurationMs } = ctx.stream;
    const { activeMs, idleMs, activeWindowMs } = ctx.polling;
    const started = Date.now();
    let last = cursor;
    let lastItemAt = -Infinity;
    let idleDelay = activeMs;
    let nextPing = started + ctx.pingIntervalMs;
    /** A wake-up arrived since the last poll started. */
    let woken: boolean;
    let wake: (() => void) | undefined;
    const notify = () => {
      woken = true;
      wake?.();
    };
    signal.addEventListener('abort', notify, { once: true });
    let unsubscribe: (() => void) | undefined;
    try {
      try {
        unsubscribe = await ctx.cluster.subscribe(machineChannel(machine.id), notify);
      } catch (err) {
        // Polling still delivers everything, only later.
        logger.error({ err, machineId: machine.id }, 'machine channel subscribe failed');
      }
      await machines.touchHttp(machine);
      while (!signal.aborted) {
        woken = false;
        const r = await store.pollLink(machine.id, linkId, { after: last, limit: POLL_PAGE, now: iso(Date.now()) });
        if (r.state !== 'current') {
          write(end[r.state]);
          return;
        }
        for (const it of r.items) {
          if (it.seq <= last) continue;
          write({ seq: it.seq, msg: it.msg });
          last = it.seq;
        }
        if (r.items.length > 0) {
          lastItemAt = Date.now();
          await drained();
          if (r.items.length === POLL_PAGE) continue;
        }
        const now = Date.now();
        if (now - started >= maxDurationMs) break;
        if (now >= nextPing) {
          write({ ctl: 'ping', at: now });
          nextPing = now + ctx.pingIntervalMs;
          await machines.touchHttp(machine).catch((err: unknown) => logger.error({ err }, 'heartbeat bookkeeping failed'));
        }
        // Fast while there is traffic or the machine has work in flight; otherwise back off.
        let delay: number;
        if (r.busy || now - lastItemAt < activeWindowMs) {
          delay = activeMs;
          idleDelay = activeMs;
        } else {
          delay = idleDelay;
          idleDelay = Math.min(idleDelay * 2, idleMs);
        }
        const until = Math.min(now + delay, started + maxDurationMs, nextPing);
        if (!woken && !signal.aborted && until > now) {
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, until - now);
            unrefTimer(t);
            wake = () => {
              clearTimeout(t);
              resolve();
            };
          });
          wake = undefined;
        }
      }
      // Rotation, or the hub is closing: the agent reconnects with its cursor at once.
      if (!signal.aborted || ctx.shutdown.aborted) write({ ctl: 'rotate' });
    } finally {
      signal.removeEventListener('abort', notify);
      unsubscribe?.();
    }
  }

  async function events(req: Request): Promise<Response> {
    const machine = await authenticate(req);
    let body: HttpEventsRequest;
    try {
      body = parseHttpEventsRequest(await readText(req));
    } catch (err) {
      if (err instanceof ProtocolFrameError) throw new UncageError('invalid_request', { message: err.message });
      throw err;
    }
    const state = await store.updateLink(machine.id, body.linkId, { ...(body.ack !== undefined ? { ackedSeq: body.ack } : {}), busy: body.busy, at: iso(Date.now()) });
    if (state === 'replaced') {
      throw new UncageError('invalid_request', { message: 'This connection was replaced by a newer one.', details: { reason: 'link_replaced' } });
    }
    if (state === 'gone') {
      throw new UncageError('invalid_request', { message: 'This connection is closed; connect again.', details: { reason: 'link_closed' } });
    }
    const replies: HubFrame[] = [];
    const link = requestLink(machine, body.linkId, replies);
    const processed: string[] = [];
    const retry: string[] = [];
    // Strictly in order: the first message that cannot be handled now stops the batch (it and
    // every later one are resent by the agent), so nothing is applied out of order.
    for (let i = 0; i < body.msgs.length; i++) {
      const m = body.msgs[i]!;
      const now = Date.now();
      const lease = m.msg.t === 'tool_call' ? ctx.toolLeaseMs : MESSAGE_LEASE_MS;
      const claim = (await store.claimInbox(machine.id, [m.id], { leaseUntil: iso(now + lease), now: iso(now) }))[m.id];
      if (claim === 'done') {
        processed.push(m.id);
        continue;
      }
      if (claim !== 'new') {
        retry.push(...body.msgs.slice(i).map((x) => x.id));
        break;
      }
      try {
        await machines.handleUpstream(link, m.msg);
      } catch (err) {
        // Left claimed: retried by the agent once the lease is over.
        logger.error({ err, machineId: machine.id, t: m.msg.t }, 'upstream message failed');
        retry.push(...body.msgs.slice(i).map((x) => x.id));
        break;
      }
      await store.completeInbox(machine.id, [m.id], iso(Date.now()));
      processed.push(m.id);
    }
    return json({ processed, retry, replies } satisfies HttpEventsResponse);
  }

  async function disconnect(req: Request): Promise<Response> {
    const machine = await authenticate(req);
    let linkId: unknown;
    try {
      linkId = (JSON.parse(await readText(req)) as { linkId?: unknown } | null)?.linkId;
    } catch {
      throw new UncageError('invalid_request', { message: 'The request body is not valid JSON.' });
    }
    if (typeof linkId !== 'string' || !LINK_ID.test(linkId)) throw new UncageError('invalid_request', { message: 'linkId is required.' });
    if ((await store.updateLink(machine.id, linkId, { at: iso(Date.now()) })) === 'current') {
      await store.closeLink(machine.id, linkId);
      await machines.clearHttp(machine.id);
      await machines.wake(machine.id);
    }
    return new Response(null, { status: 204 });
  }

  /** Handles `path` (below `basePath`) if it is an agent route; `null` otherwise. */
  async function handle(req: Request, url: URL, path: string): Promise<Response | null> {
    if (path !== '/agent' && !path.startsWith('/agent/')) return null;
    const method = req.method;
    if (path === '/agent') {
      if (method === 'GET' && (req.headers.get('upgrade') ?? '').toLowerCase() === 'websocket') return upgradeRefused(req);
      return null;
    }
    if (path === '/agent/info' && method === 'GET') return json(ctx.agentInfo());
    if (path === '/agent/connect' && method === 'POST') return connect(req);
    if (path === '/agent/stream' && method === 'GET') return stream(req, url);
    if (path === '/agent/events' && method === 'POST') return events(req);
    if (path === '/agent/disconnect' && method === 'POST') return disconnect(req);
    if (['/agent/info', '/agent/connect', '/agent/stream', '/agent/events', '/agent/disconnect'].includes(path)) {
      throw new UncageError('invalid_request', { message: `Method ${method} is not allowed for ${path}.` });
    }
    return null;
  }

  return { handle };
}
