/**
 * Traditional mode: machine WebSockets on a Node HTTP server. Builds a `MachineLink` per socket
 * and feeds it to the hub's transport-neutral `MachineHub`; owns what only a socket has (the
 * upgrade, the hello timeout, ping/pong heartbeats, close codes).
 */
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { UncageError } from '@uncage/core/errors';
import { MAX_FRAME_BYTES, parseAgentFrame, type AgentFrame } from '@uncage/protocol';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { LINK_CLOSE, type LocalLink, type MachineHub } from '../machines.js';
import type { MachineRecord } from '../store/store.js';
import { HUB_INTERNALS, type Hub, type HubInternalsHandle } from '../types.js';
import { randomHex, unrefTimer } from '../web.js';

/** Close codes the hub uses on machine sockets. */
export const CLOSE = {
  ...LINK_CLOSE,
  /** Protocol violation (malformed frame, no hello first). */
  policy: 1008,
  helloTimeout: 4408,
  /** Agent too old (`upgrade_required` was sent first). */
  upgrade: 4426,
  /** Agent speaks a newer protocol than this hub. */
  hubTooOld: 4505,
  /** Missed heartbeats. */
  offline: 4000,
} as const;

const HELLO_TIMEOUT_MS = 10_000;
/** After sending a close frame to a retired socket, how long before the TCP connection is cut. */
export const CLOSE_GRACE_MS = 500;

/** Hubs with a WebSocket server attached (one at a time: one offered URL, one maintenance timer). */
const attached = new WeakSet<MachineHub>();

function internals(hub: Hub): HubInternalsHandle {
  const h = (hub as Partial<Hub>)[HUB_INTERNALS];
  if (!h) throw new Error('attachWebSocket: not a hub created by createHub');
  return h;
}

/**
 * Accepts machine WebSockets on `server` at `path` (default `<basePath>/agent`), the traditional
 * mode transport; agents are offered `ws` at `path` (before `http`) until detached. Also runs `hub.maintain()` every
 * `maintenance.intervalMs` (default 60 s) in this long-running process. Returns a function that stops accepting new sockets
 * (connected machines stay until `hub.close()`); `hub.close()` detaches too. One server per hub
 * at a time: a second call before detaching throws.
 *
 *   const server = app.listen(3000);
 *   attachWebSocket(hub, server);
 */
export function attachWebSocket(hub: Hub, server: Server, o: { path?: string } = {}): () => void {
  const h = internals(hub);
  const { machines, logger } = h;
  const path = o.path ?? `${h.basePath}/agent`;
  if (!path.startsWith('/')) throw new Error(`attachWebSocket: path must start with "/" (got "${path}")`);
  if (machines.isClosed) throw new Error('attachWebSocket: the hub is closed');
  if (attached.has(machines)) throw new Error('attachWebSocket: this hub already has a WebSocket server attached (call its detach function first)');
  attached.add(machines);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  let detached = false;

  const listener = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://hub').pathname;
    } catch {
      return;
    }
    if (pathname !== path) return; // someone else's upgrade (e.g. a dev server's HMR)
    // Detached or closing: a retryable 503, never 401 (the agent would take it for a revoked token).
    if (detached || machines.isClosed) {
      socket.end(
        `HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nRetry-After: 1\r\nConnection: close\r\n\r\n` +
          JSON.stringify({ error: new UncageError('internal_error', { message: 'The hub is shutting down; reconnect.', hint: 'Reconnect: another instance will serve the request.' }).toBody() }),
      );
      return;
    }
    const m = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '');
    (m?.[1] ? machines.authenticate(m[1]) : Promise.resolve(null))
      .then((machine) => {
        if (detached || machines.isClosed) {
          socket.end(`HTTP/1.1 503 Service Unavailable\r\nRetry-After: 1\r\nConnection: close\r\n\r\n`);
          return;
        }
        if (!machine) return refuseToken(req, socket);
        wss.handleUpgrade(req, socket, head, (ws) => onSocket(ws, machine, machines, h, logger));
      })
      .catch((err: unknown) => {
        logger.error({ err }, 'machine upgrade failed');
        socket.destroy();
      });
  };
  /** A missing or wrong token: counts against the `agent_auth` limit like HTTP; 429 once over it, else 401. */
  async function refuseToken(req: IncomingMessage, socket: Duplex): Promise<void> {
    try {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      const ip = req.socket.remoteAddress;
      await h.agentAuthFailed(new Request(`http://hub${req.url ?? '/'}`, { headers }), ip ? { clientIp: ip } : {});
    } catch (err) {
      if (err instanceof UncageError && err.code === 'rate_limited') {
        const retry = Number(err.details?.['retryAfterSec']) || 60;
        socket.end(
          `HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nRetry-After: ${retry}\r\nConnection: close\r\n\r\n` + JSON.stringify({ error: err.toBody() }),
        );
        return;
      }
      logger.error({ err }, 'counting a failed machine token failed');
    }
    socket.end(
      `HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n` +
        JSON.stringify({ error: new UncageError('unauthorized', { message: 'Missing or invalid machine token.', hint: 'Run `uncage setup <site>` again to pair this machine.' }).toBody() }),
    );
  }

  server.on('upgrade', listener);
  h.enableWebSocket({ path });

  // Long-running process: maintenance on a timer (same code path as FaaS; the lease keeps
  // several nodes to one run per interval).
  const sweep = setInterval(() => void hub.maintain().catch((err: unknown) => logger.error({ err }, 'maintenance failed')), h.maintenance.intervalMs);
  unrefTimer(sweep);

  const detach = () => {
    if (detached) return;
    detached = true;
    attached.delete(machines);
    h.disableWebSocket();
    clearInterval(sweep);
    server.off('upgrade', listener);
    wss.close();
  };
  machines.onClose(detach);
  return detach;
}

function onSocket(ws: WebSocket, machine: MachineRecord, machines: MachineHub, h: HubInternalsHandle, logger: HubInternalsHandle['logger']): void {
  const ac = new AbortController();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let helloSeen = false;
  let awaitingPong = false;
  let missed = 0;
  // `fail` is defined below; the timer only fires after this function returned.
  const helloTimer = setTimeout(() => fail(CLOSE.helloTimeout, 'hello timeout'), HELLO_TIMEOUT_MS);
  const stop = () => {
    ac.abort();
    clearTimeout(helloTimer);
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
  };
  const link: LocalLink = {
    kind: 'ws',
    linkId: randomHex(8),
    machine,
    signal: ac.signal,
    async send(f) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(f));
    },
    close(code, reason) {
      stop();
      closeSoon(ws, code, reason);
    },
  };
  /** Closes the socket and retires the link at once. */
  const fail = (code: number, reason: string) => {
    link.close(code, reason);
    machines.removeLocalLink(link);
  };
  machines.addLocalLink(link);

  /** Each tick: an unanswered previous ping counts as missed; `missedPings` in a row → offline. */
  const beat = () => {
    if (awaitingPong) missed++;
    if (missed >= h.heartbeat.missedPings) {
      logger.warn({ machineId: link.machine.id }, 'machine missed heartbeats; marking offline');
      stop();
      ws.terminate();
      machines.removeLocalLink(link);
      return;
    }
    awaitingPong = true;
    void link.send({ t: 'ping', at: Date.now() });
  };

  ws.on('error', () => undefined);
  ws.on('message', (data: RawData, isBinary: boolean) => {
    if (ac.signal.aborted || ws.readyState !== WebSocket.OPEN) return;
    let frame: AgentFrame;
    try {
      if (isBinary) throw new Error('binary frame');
      frame = parseAgentFrame(rawToString(data));
    } catch (err) {
      logger.warn({ machineId: machine.id, err: (err as Error).message }, 'malformed agent frame');
      fail(CLOSE.policy, 'malformed frame');
      return;
    }
    if (!helloSeen) {
      if (frame.t !== 'hello') {
        fail(CLOSE.policy, 'expected hello');
        return;
      }
      helloSeen = true;
      clearTimeout(helloTimer);
      machines
        .hello(link, frame)
        .then((r) => {
          if (r === 'ok') {
            if (!ac.signal.aborted) {
              heartbeat = setInterval(beat, h.heartbeat.pingIntervalMs);
              unrefTimer(heartbeat);
            }
            return;
          }
          if (r === 'upgrade') fail(CLOSE.upgrade, 'upgrade required');
          else if (r === 'hub_too_old') fail(CLOSE.hubTooOld, 'protocol not supported by this hub');
          else fail(CLOSE.revoked, 'revoked');
        })
        .catch((err: unknown) => {
          logger.error({ err, machineId: machine.id }, 'machine hello failed');
          fail(CLOSE.error, 'hub error');
        });
      return;
    }
    // Any frame proves the machine is alive.
    awaitingPong = false;
    missed = 0;
    machines.handleMessage(link, frame).catch((err: unknown) => logger.error({ err, machineId: machine.id }, 'agent frame failed'));
  });
  ws.on('close', () => {
    stop();
    machines.removeLocalLink(link);
  });
}

/** Sends a close frame and cuts the connection if the client does not answer within `CLOSE_GRACE_MS`. */
function closeSoon(ws: WebSocket, code: number, reason: string): void {
  if (ws.readyState === WebSocket.OPEN) ws.close(code, reason);
  if (ws.readyState === WebSocket.CLOSED) return;
  unrefTimer(setTimeout(() => ws.terminate(), CLOSE_GRACE_MS));
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}
