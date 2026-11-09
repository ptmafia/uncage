import { describe, expect, it, vi } from 'vitest';
import { describePush, registerForPush, sendPushToken, sessionIdFromNotification, type NotificationsApi, type PushEnv } from './push';

type FetchFn = (u: RequestInfo | URL, i?: RequestInit) => Promise<Response>;

const env = (over: Partial<PushEnv> = {}): PushEnv => ({ isDevice: true, isExpoGo: false, platform: 'android', projectId: 'proj-1', ...over });

function fakeNotifications(o: { granted?: boolean; grantOnAsk?: boolean } = {}) {
  return {
    getPermissionsAsync: vi.fn(async () => ({ granted: o.granted ?? false })),
    requestPermissionsAsync: vi.fn(async () => ({ granted: o.grantOnAsk ?? true })),
    getExpoPushTokenAsync: vi.fn<NotificationsApi['getExpoPushTokenAsync']>(async () => ({ data: 'ExponentPushToken[abc]' })),
    setNotificationChannelAsync: vi.fn(async () => null),
  } satisfies NotificationsApi;
}

const ok = () => vi.fn<FetchFn>(async () => new Response(null, { status: 204 }));

describe('registerForPush', () => {
  it('asks permission, gets the Expo token and POSTs it with the bearer', async () => {
    const n = fakeNotifications();
    const f = ok();
    const r = await registerForPush({ notifications: n, env: env(), siteUrl: 'https://s.example', token: 'app-tok', fetch: f as unknown as typeof fetch });
    expect(r).toEqual({ status: 'registered', token: 'ExponentPushToken[abc]' });
    expect(n.setNotificationChannelAsync).toHaveBeenCalledWith('default', expect.objectContaining({ importance: 4 }));
    expect(n.requestPermissionsAsync).toHaveBeenCalled();
    expect(n.getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: 'proj-1' });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('https://s.example/api/app/push-token');
    expect(init!.method).toBe('POST');
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer app-tok');
    expect(JSON.parse(String(init!.body))).toEqual({ token: 'ExponentPushToken[abc]' });
  });

  it('does not ask again when already granted; no Android channel on iOS', async () => {
    const n = fakeNotifications({ granted: true });
    await registerForPush({ notifications: n, env: env({ platform: 'ios' }), siteUrl: 'https://s', token: 't', fetch: ok() as unknown as typeof fetch });
    expect(n.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(n.setNotificationChannelAsync).not.toHaveBeenCalled();
  });

  it('is unsupported in Expo Go, on simulators and without an EAS project id (nothing sent)', async () => {
    for (const [e, reason] of [
      [env({ isExpoGo: true }), 'expo-go'],
      [env({ isDevice: false }), 'simulator'],
      [env({ projectId: undefined }), 'no-project-id'],
    ] as const) {
      const n = fakeNotifications();
      const f = ok();
      expect(await registerForPush({ notifications: n, env: e, siteUrl: 'https://s', token: 't', fetch: f as unknown as typeof fetch })).toEqual({
        status: 'unsupported',
        reason,
      });
      expect(n.getPermissionsAsync).not.toHaveBeenCalled();
      expect(f).not.toHaveBeenCalled();
    }
  });

  it('reports a denied permission and a refused registration', async () => {
    const f = ok();
    const denied = await registerForPush({
      notifications: fakeNotifications({ grantOnAsk: false }),
      env: env(),
      siteUrl: 'https://s',
      token: 't',
      fetch: f as unknown as typeof fetch,
    });
    expect(denied).toEqual({ status: 'denied' });
    expect(f).not.toHaveBeenCalled();

    const refuse = vi.fn(async () => new Response('{}', { status: 401 }));
    const failed = await registerForPush({ notifications: fakeNotifications(), env: env(), siteUrl: 'https://s', token: 't', fetch: refuse as unknown as typeof fetch });
    expect(failed).toEqual({ status: 'failed', message: 'The site refused the push token (401).' });
  });
});

describe('push helpers', () => {
  it('sendPushToken DELETE unregisters on sign-out', async () => {
    const f = ok();
    await sendPushToken(f as unknown as typeof fetch, 'https://s', 'app', 'ExponentPushToken[abc]', 'DELETE');
    expect(f.mock.calls[0]![1]!.method).toBe('DELETE');
    expect(JSON.parse(String(f.mock.calls[0]![1]!.body))).toEqual({ token: 'ExponentPushToken[abc]' });
  });

  it('sessionIdFromNotification reads data.sessionId from the hub notifier and rejects anything else', () => {
    expect(sessionIdFromNotification({ sessionId: 'ses_01J', kind: 'approval' })).toBe('ses_01J');
    expect(sessionIdFromNotification({ sessionId: '../../x' })).toBeUndefined();
    expect(sessionIdFromNotification({ sessionId: 1 })).toBeUndefined();
    expect(sessionIdFromNotification(null)).toBeUndefined();
    expect(sessionIdFromNotification('ses_1')).toBeUndefined();
  });

  it('describePush explains each state', () => {
    expect(describePush({ status: 'registered', token: 'x' })).toMatch(/on$/);
    expect(describePush({ status: 'unsupported', reason: 'expo-go' })).toMatch(/development build/);
    expect(describePush(undefined)).toMatch(/checking/);
  });
});
