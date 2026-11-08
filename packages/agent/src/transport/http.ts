import { randomBytes } from 'node:crypto';
import { UncageError } from '@uncage/core';
import {
  HttpConnectResponseSchema,
  HttpEventsResponseSchema,
  MAX_HTTP_BODY_BYTES,
  parseStreamLine,
  type AgentFrame,
  type HttpEventsResponse,
  type HubFrame,
  type StreamLine,
} from '@uncage/protocol';
import { agentHttpUrl } from '../device.js';
import { backoffDelay, FrameTooLargeError, type AgentLink, type DialOptions, type LinkEnd } from './types.js';

/**
 * Room for the `POST /agent/events` envelope around the messages (`linkId`, `ack`, `busy`, the
 * array brackets): a body is the envelope plus each `{id,msg}` and a comma.
 */
const ENVELOPE_BYTES = 256;
/** Largest single upstream message (`{id,msg}` JSON). */
export const MAX_UPSTREAM_MESSAGE_BYTES = MAX_HTTP_BODY_BYTES - ENVELOPE_BYTES;
/** Messages per POST (the hub's schema allows 500). */
const MAX_BATCH = 500;
/** First upstream retry delay; doubles up to `httpRetryMaxMs`. */
const RETRY_MIN_MS = 500;
/**
 * An upstream message not processed within this long is given up (the hub keeps its dedupe rows
 * for 24 h; a resend must stay far inside that window).
 */
const GIVE_UP_MS = 10 * 60_000;

const byteLength = (s: string): number => Buffer.byteLength(s, 'utf8');

/** A fresh idempotent upstream id (`up_` + 22 base64url chars). */
export const newUpstreamId = (): string => `up_${randomBytes(16).toString('base64url')}`;

interface Item {
  id: string;
  msg: AgentFrame;
  json: string;
  bytes: number;
  firstAt: number;
  resolve(): void;
  reject(e: unknown): void;
}

type PostResult =
  | { k: 'ok'; body: HttpEventsResponse }
  | { k: 'transient'; why: string }
  | { k: 'drop'; error: Error }
  | { k: 'end'; end: Omit<LinkEnd, 'welcomed' | 'upMs'> };

/** What a non-2xx answer means for the link. */
async function classify(res: Response): Promise<
  | { k: 'end'; end: Omit<LinkEnd, 'welcomed' | 'upMs'>; reason?: string }
  | { k: 'transient'; why: string }
  | { k: 'fatal'; why: string; reason?: string }
> {
  type ErrorJson = { minAgentVersion?: unknown; message?: unknown; details?: { reason?: unknown } } | null;
  let body: ErrorJson = null;
  try {
    body = (await res.json()) as ErrorJson;
  } catch {
    // not JSON
  }
  const reason = typeof body?.details?.reason === 'string' ? body.details.reason : undefined;
  const why = `HTTP ${res.status}${typeof body?.message === 'string' ? `: ${body.message}` : ''}`;
  if (res.status === 401) return { k: 'end', end: { stop: 'revoked' } };
  if (res.status === 426) {
    return { k: 'end', end: { stop: 'upgrade', ...(typeof body?.minAgentVersion === 'string' ? { minAgentVersion: body.minAgentVersion } : {}) } };
  }
  if (res.status === 400 && reason === 'link_replaced') return { k: 'end', end: { stop: 'replaced' }, reason };
  if (res.status === 400 && reason === 'link_closed') return { k: 'end', end: {}, reason };
  if (res.status === 408 || res.status === 425 || res.status === 429 || res.status >= 500) return { k: 'transient', why };
  return { k: 'fatal', why, ...(reason ? { reason } : {}) };
}

/** Lines of an NDJSON body. */
async function* ndjson(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim() !== '') yield line;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

/**
 * One HTTP streaming link (FaaS mode): `POST /agent/connect` once, then
 * - downstream: `GET /agent/stream?link&cursor` reopened with `cursor.get()` — at once after a
 *   `rotate` or a stream that delivered lines, with backoff otherwise. A `seq <= cursor` is skipped;
 *   the cursor advances when a frame is dispatched and is acknowledged on the next request.
 * - upstream: one serialized queue packed into bodies ≤ `MAX_HTTP_BODY_BYTES`; each `tool_call` in its
 *   own parallel POST. Every message keeps its `up_` id until the hub lists it as processed (the
 *   hub dedupes), `retry` ids are re-sent after backoff.
 * 401 → `revoked`, 400 `link_replaced` (or a `replaced` line) → `replaced`, 426 → `upgrade`, 400
 * `link_closed` → the link ends (the site connects again).
 */
export function dialHttp(o: DialOptions): AgentLink {
  const site = o.siteId;
  const log = o.logger;
  const ac = new AbortController();
  const auth = { authorization: `Bearer ${o.token}` };
  let base: string;
  let linkId: string | undefined;
  let welcomedAt = 0;
  /** Last time any stream line arrived (or the welcome). */
  let lastLineAt = 0;
  let finished = false;
  let resolveEnded!: (e: LinkEnd) => void;
  const ended = new Promise<LinkEnd>((r) => (resolveEnded = r));
  const queue: Item[] = [];
  const calls = new Set<Item>();
  let wakeUpstream: (() => void) | undefined;

  const finish = (r: Omit<LinkEnd, 'welcomed' | 'upMs'>, after: Promise<unknown> = Promise.resolve()): void => {
    if (finished) return;
    finished = true;
    const upMs = welcomedAt ? Date.now() - welcomedAt : 0;
    ac.abort();
    const lost = new UncageError('machine_offline', { message: 'The connection to the website was lost.' });
    for (const it of [...queue, ...calls]) it.reject(lost);
    queue.length = 0;
    calls.clear();
    wakeUpstream?.();
    // Rejections settle first (replication rewinds what was not processed), then the link ends.
    void after.finally(() => setTimeout(() => resolveEnded({ welcomed: welcomedAt > 0, upMs, ...r }), 0));
  };

  const retryDelay = (attempt: number): number =>
    Math.round(Math.min(o.timing.httpRetryMaxMs, RETRY_MIN_MS * 2 ** Math.min(attempt, 20)) * (0.75 + Math.random() * 0.25));

  async function post(items: Item[]): Promise<PostResult> {
    const body = `{"linkId":${JSON.stringify(linkId)},"ack":${o.cursor.get()},"busy":${o.busy()},"msgs":[${items.map((i) => i.json).join(',')}]}`;
    let res: Response;
    try {
      res = await o.fetch(`${base}/events`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body, signal: ac.signal });
    } catch (err) {
      return { k: 'transient', why: (err as Error).message };
    }
    if (res.status === 200) {
      try {
        return { k: 'ok', body: HttpEventsResponseSchema.parse(await res.json()) };
      } catch (err) {
        return { k: 'transient', why: `unexpected events response: ${(err as Error).message}` };
      }
    }
    const c = await classify(res);
    if (c.k === 'end') return c;
    if (c.k === 'transient') return c;
    return { k: 'drop', error: new Error(`The website refused the message (${c.why}).`) };
  }

  const dispatchReplies = (replies: HubFrame[]) => {
    for (const f of replies) {
      if (finished) return;
      try {
        o.onFrame(f);
      } catch (err) {
        log.error({ err, site }, 'hub frame handler failed');
      }
    }
  };

  /** Drops items that have waited longer than the resend window. True if something was dropped. */
  const expire = (items: Item[]): boolean => {
    const now = Date.now();
    let dropped = false;
    for (const it of items) {
      if (now - it.firstAt <= GIVE_UP_MS) continue;
      log.error({ site, t: it.msg.t }, 'upstream message not accepted by the website in time; giving up');
      it.reject(new UncageError('machine_offline', { message: 'The website did not accept the message in time.' }));
      const i = queue.indexOf(it);
      if (i >= 0) queue.splice(i, 1);
      calls.delete(it);
      dropped = true;
    }
    return dropped;
  };

  async function upstreamLoop(): Promise<void> {
    let attempt = 0;
    /** After a refused batch: send one message per POST for this many messages (isolates the bad one). */
    let solo = 0;
    while (!finished) {
      if (queue.length === 0) {
        await new Promise<void>((r) => (wakeUpstream = r));
        wakeUpstream = undefined;
        continue;
      }
      const batch: Item[] = [];
      let size = ENVELOPE_BYTES;
      for (const it of queue) {
        if (batch.length >= (solo > 0 ? 1 : MAX_BATCH) || (batch.length > 0 && size + it.bytes + 1 > MAX_HTTP_BODY_BYTES)) break;
        batch.push(it);
        size += it.bytes + 1;
      }
      const r = await post(batch);
      if (finished) return;
      if (r.k === 'end') return finish(r.end);
      if (r.k === 'drop') {
        if (batch.length > 1) {
          solo = batch.length;
          continue;
        }
        log.error({ site, t: batch[0]!.msg.t, err: r.error.message }, 'upstream message refused');
        queue.splice(queue.indexOf(batch[0]!), 1);
        batch[0]!.reject(r.error);
        solo = Math.max(0, solo - 1);
        continue;
      }
      if (r.k === 'ok') {
        dispatchReplies(r.body.replies);
        if (finished) return;
        const done = new Set(r.body.processed);
        for (const it of batch) {
          if (!done.has(it.id)) continue;
          const i = queue.indexOf(it);
          if (i >= 0) queue.splice(i, 1);
          it.resolve();
          if (solo > 0) solo--;
        }
        if (batch.every((it) => done.has(it.id))) {
          attempt = 0;
          continue;
        }
      } else log.info({ site, why: r.why }, 'upstream POST failed; retrying');
      if (expire(batch)) continue;
      await sleep(retryDelay(attempt++), ac.signal);
    }
  }

  async function callLoop(it: Item): Promise<void> {
    calls.add(it);
    let attempt = 0;
    while (!finished && calls.has(it)) {
      const r = await post([it]);
      if (finished) return;
      if (r.k === 'end') return finish(r.end);
      if (r.k === 'drop') {
        calls.delete(it);
        return it.reject(r.error);
      }
      if (r.k === 'ok') {
        dispatchReplies(r.body.replies);
        if (finished) return;
        if (r.body.processed.includes(it.id)) {
          calls.delete(it);
          return it.resolve();
        }
      }
      // `retry`: the call still runs on the hub (or the POST failed): ask again, slower each time.
      if (expire([it])) return;
      await sleep(retryDelay(attempt++), ac.signal);
    }
  }

  async function streamLoop(): Promise<void> {
    let attempt = 0;
    while (!finished) {
      let lines = 0;
      let ctl: string | undefined;
      const sac = new AbortController();
      const abort = () => sac.abort();
      ac.signal.addEventListener('abort', abort, { once: true });
      let idle: NodeJS.Timeout | undefined;
      const arm = () => {
        clearTimeout(idle);
        idle = setTimeout(() => {
          log.warn({ site }, 'no data on the website stream; reopening it');
          sac.abort();
        }, o.timing.idleTimeoutMs);
        idle.unref();
      };
      try {
        arm();
        const res = await o.fetch(`${base}/stream?link=${linkId}&cursor=${o.cursor.get()}`, { headers: auth, signal: sac.signal });
        if (res.status !== 200) {
          const c = await classify(res);
          if (c.k === 'end') return finish(c.end);
          throw new Error(`stream ${c.why}`);
        }
        if (!res.body) throw new Error('stream without a body');
        for await (const line of ndjson(res.body)) {
          arm();
          lines++;
          lastLineAt = Date.now();
          let raw: unknown;
          try {
            raw = JSON.parse(line);
          } catch {
            log.warn({ site }, 'malformed line on the website stream');
            continue;
          }
          if (raw !== null && typeof raw === 'object' && 'ctl' in raw) {
            const c = (raw as { ctl: unknown }).ctl;
            if (c === 'rotate' || c === 'replaced' || c === 'revoked') {
              ctl = c;
              break;
            }
            continue; // `ping`, or a control line from a newer hub
          }
          let parsed: StreamLine;
          try {
            parsed = parseStreamLine(line);
          } catch (err) {
            // A frame this agent cannot read (e.g. from a newer hub): skip it, never stall on it.
            const seq = (raw as { seq?: unknown } | null)?.seq;
            if (typeof seq === 'number' && Number.isInteger(seq) && seq > o.cursor.get()) o.cursor.set(seq);
            log.warn({ site, err: (err as Error).message }, 'unreadable frame on the website stream; skipped');
            continue;
          }
          if (!('seq' in parsed) || parsed.seq <= o.cursor.get()) continue;
          try {
            o.onFrame(parsed.msg);
          } catch (err) {
            log.error({ err, site }, 'hub frame handler failed');
          }
          o.cursor.set(parsed.seq);
          if (finished) return;
        }
      } catch (err) {
        if (!finished && !sac.signal.aborted) log.info({ site, err: (err as Error).message }, 'website stream interrupted');
      } finally {
        clearTimeout(idle);
        sac.abort();
        ac.signal.removeEventListener('abort', abort);
      }
      if (finished) return;
      if (ctl === 'replaced') return finish({ stop: 'replaced' });
      if (ctl === 'revoked') return finish({ stop: 'revoked' });
      if (ctl === 'rotate') {
        log.info({ site, cursor: o.cursor.get() }, 'http stream rotated');
        attempt = 0;
        continue;
      }
      if (lines > 0) {
        attempt = 0;
        continue;
      }
      // Nothing arrived for too long: give the link up (the site connects again, maybe elsewhere).
      if (Date.now() - lastLineAt > o.timing.idleTimeoutMs) {
        log.warn({ site }, 'lost the website stream; reconnecting');
        return finish({});
      }
      await sleep(backoffDelay(attempt++, o.timing), ac.signal);
    }
  }

  async function run(): Promise<void> {
    try {
      base = agentHttpUrl(o.hubUrl);
    } catch (err) {
      log.error({ err, site }, 'cannot connect');
      return finish({});
    }
    let res: Response;
    try {
      res = await o.fetch(`${base}/connect`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ ...o.hello, transport: 'http' }),
        signal: ac.signal,
      });
    } catch (err) {
      if (!finished) log.warn({ site, err: (err as Error).message }, 'connection error');
      return finish({});
    }
    if (finished) return;
    if (res.status !== 200) {
      const c = await classify(res);
      if (c.k === 'end') {
        if (c.end.stop === 'upgrade') log.warn({ site, minAgentVersion: c.end.minAgentVersion }, 'the website requires a newer agent');
        return finish(c.end);
      }
      if (c.k === 'fatal' && c.reason === 'hub_too_old') log.warn({ site }, 'this website runs an older hub than the agent supports');
      else log.warn({ site, status: res.status }, 'hub refused the connection');
      return finish({});
    }
    let welcome;
    try {
      welcome = HttpConnectResponseSchema.parse(await res.json());
    } catch (err) {
      log.warn({ site, err: (err as Error).message }, 'unexpected connect response from the website');
      return finish({});
    }
    if (finished) return;
    if (welcome.t === 'upgrade_required') return finish({ stop: 'upgrade', minAgentVersion: welcome.minAgentVersion });
    linkId = welcome.linkId;
    if (welcome.cursor > o.cursor.get()) o.cursor.set(welcome.cursor);
    welcomedAt = lastLineAt = Date.now();
    o.onWelcome({ machineId: welcome.machineId, replies: welcome.replies });
    if (finished) return;
    void upstreamLoop().catch((err: unknown) => {
      log.error({ err, site }, 'upstream failed');
      finish({});
    });
    await streamLoop();
  }
  void run().catch((err: unknown) => {
    log.error({ err, site }, 'http link failed');
    finish({});
  });

  return {
    kind: 'http',
    ended,
    send(f) {
      if (finished || !linkId) return Promise.reject(new UncageError('machine_offline'));
      // The stream replaces ping/pong; connect replaces hello.
      if (f.t === 'pong' || f.t === 'hello') return Promise.resolve();
      const id = newUpstreamId();
      const json = JSON.stringify({ id, msg: f });
      const bytes = byteLength(json);
      if (bytes > MAX_UPSTREAM_MESSAGE_BYTES) return Promise.reject(new FrameTooLargeError(f.t));
      return new Promise<void>((resolve, reject) => {
        const it: Item = { id, msg: f, json, bytes, firstAt: Date.now(), resolve, reject };
        if (f.t === 'tool_call') void callLoop(it);
        else {
          queue.push(it);
          wakeUpstream?.();
        }
      });
    },
    close() {
      if (finished) return;
      const id = linkId;
      const bye = id
        ? o
            .fetch(`${base}/disconnect`, {
              method: 'POST',
              headers: { ...auth, 'content-type': 'application/json' },
              body: JSON.stringify({ linkId: id }),
              signal: AbortSignal.timeout(2000),
            })
            .then((r) => r.body?.cancel())
            .catch(() => undefined)
        : Promise.resolve();
      finish({}, bye);
    },
  };
}
