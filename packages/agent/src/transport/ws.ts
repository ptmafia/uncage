import { MAX_FRAME_BYTES, parseHubFrame, type AgentFrame, type HubFrame } from '@uncage/protocol';
import { UncageError } from '@uncage/core';
import { WebSocket } from 'ws';
import { agentWsUrl } from '../device.js';
import { FrameTooLargeError, isHubUnauthorized, type AgentLink, type DialOptions, type LinkEnd } from './types.js';

/** Close codes the hub uses (see @uncage/hub machines.ts). */
export const HUB_CLOSE = { revoked: 4401, replaced: 4409, upgrade: 4426, hubTooOld: 4505 } as const;

const byteLength = (s: string): number => Buffer.byteLength(s, 'utf8');

/** One WebSocket to the offered URL (default `<hub>/agent`; traditional mode): hello → welcome → frames until it closes. */
export function dialWs(o: DialOptions): AgentLink {
  const site = o.siteId;
  let welcomedAt = 0;
  let upgradeMin: string | undefined;
  let httpStatus: number | undefined;
  /** The refused upgrade's 401 carried the hub's own `unauthorized` error (the token is gone). */
  let hubRevoked = false;
  let finished = false;
  let resolveEnded!: (e: LinkEnd) => void;
  const ended = new Promise<LinkEnd>((r) => (resolveEnded = r));
  const finish = (r: Omit<LinkEnd, 'welcomed' | 'upMs'>) => {
    if (finished) return;
    finished = true;
    resolveEnded({ welcomed: welcomedAt > 0, upMs: welcomedAt ? Date.now() - welcomedAt : 0, ...r });
  };

  let ws: WebSocket | undefined;
  try {
    ws = new WebSocket(o.url ?? agentWsUrl(o.hubUrl), {
      headers: { authorization: `Bearer ${o.token}` },
      maxPayload: MAX_FRAME_BYTES,
      handshakeTimeout: 15_000,
    });
  } catch (err) {
    o.logger.error({ err, site }, 'cannot connect');
    finish({});
  }

  const rawSend = (f: AgentFrame): Promise<void> => {
    const raw = JSON.stringify(f);
    if (byteLength(raw) > MAX_FRAME_BYTES) return Promise.reject(new FrameTooLargeError(f.t));
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new UncageError('machine_offline'));
      ws.send(raw, (err) => (err ? reject(new UncageError('machine_offline', { message: `The connection to the website was lost: ${err.message}` })) : resolve()));
    });
  };

  if (ws) {
    const sock = ws;
    let idle: NodeJS.Timeout | undefined;
    const armIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        o.logger.warn({ site }, 'no frames from the hub; reconnecting');
        sock.terminate();
      }, o.timing.idleTimeoutMs);
      idle.unref();
    };
    sock.on('unexpected-response', (req, res) => {
      httpStatus = res.statusCode;
      let ended = false;
      const end = () => {
        if (ended) return;
        ended = true;
        req.destroy();
        sock.terminate();
      };
      if (res.statusCode !== 401) {
        res.resume();
        return end();
      }
      // A 401 means revoked only when it is the hub's own error body (a proxy's 401 is retried).
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        if (body.length < 64 * 1024) body += c;
      });
      res.on('end', () => {
        hubRevoked = isHubUnauthorized(body);
        end();
      });
      res.on('error', end);
      setTimeout(end, 5_000).unref();
    });
    sock.on('error', (err) => {
      if (httpStatus === undefined) o.logger.warn({ site, err: err.message }, 'connection error');
    });
    sock.on('open', () => {
      armIdle();
      void rawSend({ ...o.hello, transport: 'ws' }).catch(() => undefined);
    });
    sock.on('message', (data) => {
      armIdle();
      let frame: HubFrame;
      try {
        frame = parseHubFrame(data.toString());
      } catch (err) {
        o.logger.warn({ site, err: (err as Error).message }, 'malformed frame from hub');
        return;
      }
      if (frame.t === 'welcome') {
        if (welcomedAt) return;
        welcomedAt = Date.now();
        o.onWelcome({ machineId: frame.machineId, replies: [] });
        return;
      }
      if (frame.t === 'upgrade_required') {
        upgradeMin = frame.minAgentVersion;
        o.logger.warn({ site, minAgentVersion: frame.minAgentVersion }, 'the website requires a newer agent');
        return;
      }
      if (!welcomedAt) return;
      if (frame.t === 'ping') {
        void rawSend({ t: 'pong', at: frame.at }).catch(() => undefined);
        return;
      }
      o.onFrame(frame);
    });
    sock.on('close', (code, reason) => {
      clearTimeout(idle);
      if ((httpStatus === 401 && hubRevoked) || code === HUB_CLOSE.revoked) return finish({ stop: 'revoked' });
      if (httpStatus === 401) o.logger.warn({ site }, 'HTTP 401 that is not the hub refusing the token (a proxy or deployment protection in front of the site?); retrying');
      if (code === HUB_CLOSE.replaced) return finish({ stop: 'replaced' });
      if (code === HUB_CLOSE.upgrade || upgradeMin) return finish({ stop: 'upgrade', ...(upgradeMin ? { minAgentVersion: upgradeMin } : {}) });
      if (code === HUB_CLOSE.hubTooOld) o.logger.warn({ site }, 'this website runs an older hub than the agent supports');
      else if (httpStatus !== undefined && httpStatus !== 401) o.logger.warn({ site, status: httpStatus }, 'hub refused the connection');
      else o.logger.info({ site, code, reason: reason.toString().slice(0, 200) }, 'disconnected');
      finish({});
    });
  }

  return {
    kind: 'ws',
    ended,
    send(f) {
      if (!welcomedAt || finished) return Promise.reject(new UncageError('machine_offline'));
      return rawSend(f);
    },
    close() {
      const sock = ws;
      if (!sock) return;
      sock.close(1000, 'agent shutting down');
      setTimeout(() => sock.terminate(), 500).unref();
    },
  };
}
