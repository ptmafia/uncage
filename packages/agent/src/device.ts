import {
  DeviceCodeResponseSchema,
  DeviceTokenResponseSchema,
  type DeviceCodeRequest,
  type DeviceCodeResponse,
  type DeviceTokenResponse,
} from '@uncage/protocol';

export const DEFAULT_HUB_PATH = '/api/uncage';

const isLoopback = (host: string): boolean => host === 'localhost' || host === '127.0.0.1' || host === '[::1]';

/**
 * `uncage setup <url>` input → hub base URL. No scheme → https. No path → `/api/uncage` is
 * appended. Plain http is only accepted for localhost / 127.0.0.1 (development).
 */
export function normalizeHubUrl(input: string): string {
  const raw = input.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new Error(`"${input}" is not a valid URL.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`"${input}" must be an https:// URL.`);
  if (url.protocol === 'http:' && !isLoopback(url.hostname)) {
    throw new Error(`Refusing plain http for ${url.hostname}: use https:// (http is only allowed for localhost).`);
  }
  if (url.username || url.password) throw new Error('The URL must not contain credentials.');
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path === '' ? DEFAULT_HUB_PATH : path}`;
}

/** `ws(s)://…/agent` for a hub base URL; refuses ws:// to anything but loopback. */
export function agentWsUrl(hubUrl: string): string {
  const url = new URL(hubUrl);
  if (url.protocol === 'http:' && !isLoopback(url.hostname)) throw new Error(`Refusing an insecure connection to ${url.hostname}.`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/agent`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

async function postJson(fetchFn: typeof fetch, url: string, body: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) {
    throw new Error(`Cannot reach ${new URL(url).origin}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new Error(`${url} did not return JSON (HTTP ${res.status}). Is this an Uncage website?`);
  }
  if (!res.ok) {
    const msg = (json as { message?: unknown } | null)?.message;
    throw new Error(`${url} returned HTTP ${res.status}${typeof msg === 'string' ? `: ${msg}` : ''}`);
  }
  return json;
}

export async function requestDeviceCode(fetchFn: typeof fetch, hubUrl: string, body: DeviceCodeRequest): Promise<DeviceCodeResponse> {
  const r = DeviceCodeResponseSchema.safeParse(await postJson(fetchFn, `${hubUrl}/device/code`, body));
  if (!r.success) throw new Error(`${hubUrl} sent an unexpected device code response.`);
  return r.data;
}

export type DeviceGrant = Extract<DeviceTokenResponse, { status: 'ok' }>;

/**
 * Polls `/device/token` every `intervalSec` (RFC 8628: `slow_down` adds 5 s) until the user
 * approves, denies, or the code expires.
 */
export async function pollDeviceToken(o: {
  fetch: typeof fetch;
  hubUrl: string;
  code: DeviceCodeResponse;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<DeviceGrant> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const deadline = now() + o.code.expiresInSec * 1000;
  let intervalMs = Math.max(1, o.code.intervalSec) * 1000;
  for (;;) {
    await sleep(intervalMs);
    if (now() > deadline) throw new Error('The code expired before it was approved. Run uncage setup again.');
    const r = DeviceTokenResponseSchema.safeParse(await postJson(o.fetch, `${o.hubUrl}/device/token`, { deviceCode: o.code.deviceCode }));
    if (!r.success) throw new Error(`${o.hubUrl} sent an unexpected token response.`);
    switch (r.data.status) {
      case 'ok':
        return r.data;
      case 'pending':
        continue;
      case 'slow_down':
        intervalMs += 5000;
        continue;
      case 'denied':
        throw new Error('The connection was denied on the website.');
      case 'expired':
        throw new Error('The code expired before it was approved. Run uncage setup again.');
    }
  }
}
