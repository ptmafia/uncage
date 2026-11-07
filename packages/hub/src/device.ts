import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { DeviceCodeResponse, DeviceTokenResponse } from '@uncage/protocol';
import type { HubStore } from './store/store.js';
import type { HubUser } from './types.js';

export const DEVICE_INTERVAL_SEC = 2;
export const DEVICE_EXPIRES_IN_SEC = 600;

/** No 0/O, 1/I/L, or vowel-ish lookalikes beyond what users can tell apart (31 symbols). */
export const USER_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** 32 random bytes, base64url (machine tokens, device codes). */
export const randomSecret = (): string => randomBytes(32).toString('base64url');

export function generateUserCode(): string {
  let s = '';
  for (let i = 0; i < 8; i++) s += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** `abcd efgh`, `ABCDEFGH`, ` abcd-efgh ` → `ABCD-EFGH`; anything else → `null`. */
export function normalizeUserCode(raw: string): string | null {
  const s = raw.toUpperCase().replace(/[\s-]/g, '');
  if (s.length !== 8 || [...s].some((c) => !USER_CODE_ALPHABET.includes(c))) return null;
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

export interface DeviceFlowDeps {
  store: HubStore;
  verificationUri: string;
  site: { id: string; name: string; url: string };
  /** Creates the machine for an approved code; resolves its id and (one-time) token. */
  createMachine(o: { userId: string; name?: string; os?: string }): Promise<{ machineId: string; machineToken: string }>;
  now?: () => number;
}

export type DeviceDecision = 'ok' | 'not_found' | 'expired';

const clipLabel = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, 100) : undefined;

/** OAuth-device-authorization-style pairing: the CLI polls, the signed-in user approves on the website. */
export function deviceFlow(d: DeviceFlowDeps) {
  const now = d.now ?? Date.now;
  const expired = (r: { expiresAt: string }) => Date.parse(r.expiresAt) <= now();

  async function decide(userCode: string, user: HubUser, to: 'approved' | 'denied'): Promise<DeviceDecision> {
    const code = normalizeUserCode(userCode);
    if (!code) return 'not_found';
    const rec = await d.store.findDeviceCodeByUserCode(sha256(code));
    if (!rec) return 'not_found';
    if (expired(rec)) return 'expired';
    if (rec.status !== 'pending') return 'not_found';
    const updated = await d.store.transitionDeviceCode(rec.deviceCodeHash, 'pending', to, { userId: user.id });
    return updated ? 'ok' : 'not_found';
  }

  return {
    async createCode(body: { name?: unknown; os?: unknown }): Promise<DeviceCodeResponse> {
      const deviceCode = randomSecret();
      // Retry on the (astronomically unlikely) user-code collision with a live code.
      for (let attempt = 0; ; attempt++) {
        const userCode = generateUserCode();
        const createdAt = new Date(now()).toISOString();
        const name = clipLabel(body.name);
        const os = clipLabel(body.os);
        try {
          await d.store.insertDeviceCode({
            deviceCodeHash: sha256(deviceCode),
            userCodeHash: sha256(userCode),
            status: 'pending',
            ...(name ? { name } : {}),
            ...(os ? { os } : {}),
            createdAt,
            expiresAt: new Date(now() + DEVICE_EXPIRES_IN_SEC * 1000).toISOString(),
          });
        } catch (e) {
          if (attempt < 3) continue;
          throw e;
        }
        const uri = new URL(d.verificationUri);
        uri.searchParams.set('code', userCode);
        return {
          deviceCode,
          userCode,
          verificationUri: uri.toString(),
          intervalSec: DEVICE_INTERVAL_SEC,
          expiresInSec: DEVICE_EXPIRES_IN_SEC,
        };
      }
    },

    /** One poll. `null` = unknown device code. The machine token is issued exactly once. */
    async poll(deviceCode: string): Promise<DeviceTokenResponse | null> {
      const hash = sha256(deviceCode);
      const rec = await d.store.getDeviceCode(hash);
      if (!rec) return null;
      if (rec.status === 'consumed') return { status: 'expired' };
      if (rec.status === 'denied') return { status: 'denied' };
      if (expired(rec)) return { status: 'expired' };
      if (rec.status === 'pending') return { status: 'pending' };
      const won = await d.store.transitionDeviceCode(hash, 'approved', 'consumed');
      if (!won?.userId) return { status: 'expired' };
      const m = await d.createMachine({ userId: won.userId, ...(won.name ? { name: won.name } : {}), ...(won.os ? { os: won.os } : {}) });
      return { status: 'ok', machineId: m.machineId, machineToken: m.machineToken, site: d.site };
    },

    approve: (userCode: string, user: HubUser) => decide(userCode, user, 'approved'),
    deny: (userCode: string, user: HubUser) => decide(userCode, user, 'denied'),

    async lookup(userCode: string): Promise<{ name?: string; os?: string; expiresAt: string } | null> {
      const code = normalizeUserCode(userCode);
      if (!code) return null;
      const rec = await d.store.findDeviceCodeByUserCode(sha256(code));
      if (!rec || rec.status !== 'pending' || expired(rec)) return null;
      return { ...(rec.name ? { name: rec.name } : {}), ...(rec.os ? { os: rec.os } : {}), expiresAt: rec.expiresAt };
    },
  };
}

export type DeviceFlow = ReturnType<typeof deviceFlow>;
