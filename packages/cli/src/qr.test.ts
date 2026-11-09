import { describe, expect, it } from 'vitest';
import jsQR from 'jsqr';
import { renderQr } from './qr.js';
import { runSetup } from './setup.js';

/** Turn the half-block rendering back into a pixel bitmap and decode it. */
function decode(rendered: string): string | undefined {
  // eslint-disable-next-line no-control-regex
  const lines = rendered.replace(/\x1b\[[0-9;]*m/g, '').split('\n');
  const scale = 4;
  const rows: boolean[][] = [];
  for (const line of lines) {
    const top: boolean[] = [];
    const bottom: boolean[] = [];
    for (const ch of line) {
      top.push(ch === '▀' || ch === '█');
      bottom.push(ch === '▄' || ch === '█');
    }
    rows.push(top, bottom);
  }
  const w = rows[0]!.length * scale;
  const h = rows.length * scale;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = rows[Math.floor(y / scale)]![Math.floor(x / scale)] ? 0 : 255;
      data.set([v, v, v, 255], (y * w + x) * 4);
    }
  return jsQR(data, w, h)?.data;
}

describe('renderQr', () => {
  it('renders a decodable QR for the verification URL', () => {
    const url = 'https://app.example.com/device?code=ABCD-1234';
    const out = renderQr(url);
    expect(out).toMatch(/[▀▄█]/);
    expect(decode(out)).toBe(url);
  });
});

function fakeHub() {
  let polls = 0;
  const f = (async (input: Request | string | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/device/code') || url.includes('/device/code')) {
      return Response.json({
        deviceCode: 'dc',
        userCode: 'ABCD-1234',
        verificationUri: 'https://hub.example.com/device?code=ABCD-1234',
        expiresInSec: 600,
        intervalSec: 1,
      });
    }
    polls++;
    return Response.json({
      status: 'ok',
      machineId: 'm1',
      machineToken: 't',
      site: { id: 's', name: 'Site', url: 'https://hub.example.com' },
      transports: [{ kind: 'http', url: 'https://hub.example.com/agent' }],
    });
  }) as typeof fetch;
  return { f, polls: () => polls };
}

describe('uncage setup QR', () => {
  async function run(opts: { isTTY: boolean; noQr?: boolean }) {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const home = await mkdtemp(join(tmpdir(), 'uncage-qr-'));
    const lines: string[] = [];
    await runSetup({
      url: 'https://hub.example.com',
      home,
      fetch: fakeHub().f,
      exec: async () => ({ code: 0, stdout: '', stderr: '' }) as never,
      out: (l) => lines.push(l),
      noDaemon: true,
      noBrowser: true,
      sleep: async () => {},
      isTTY: opts.isTTY,
      ...(opts.noQr !== undefined ? { noQr: opts.noQr } : {}),
    });
    return lines.join('\n');
  }

  it('setup prints QR only on a TTY', async () => {
    expect(await run({ isTTY: true })).toMatch(/[▀▄█]/);
    expect(await run({ isTTY: false })).not.toMatch(/[▀▄█]/);
  });

  it('--no-qr suppresses it', async () => {
    expect(await run({ isTTY: true, noQr: true })).not.toMatch(/[▀▄█]/);
  });
});
