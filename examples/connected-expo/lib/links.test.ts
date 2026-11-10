import { describe, expect, it, vi } from 'vitest';
import { assetToFile, pickedFileName } from './attachments';
import { deviceCodeFromPath, sanitizeDeviceCode, sanitizeId } from './links';

describe('device links', () => {
  it('reads the code from every way the CLI QR / app links arrive', () => {
    expect(deviceCodeFromPath('/device?code=ABCD-EFGH')).toBe('ABCD-EFGH');
    expect(deviceCodeFromPath('https://demo.example.com/device?code=ABCD-EFGH')).toBe('ABCD-EFGH');
    expect(deviceCodeFromPath('uncagedemo://device?code=abcd-efgh')).toBe('abcd-efgh');
    expect(deviceCodeFromPath('exp://192.168.1.20:8081/--/device?code=ABCD-EFGH')).toBe('ABCD-EFGH');
    expect(deviceCodeFromPath('/device/?code=ABCD-EFGH&utm=1')).toBe('ABCD-EFGH');
  });

  it('ignores other paths and unsafe codes', () => {
    expect(deviceCodeFromPath('/chat/ses_1')).toBeUndefined();
    expect(deviceCodeFromPath('/devices?code=ABCD')).toBeUndefined();
    expect(deviceCodeFromPath('/device')).toBeUndefined();
    expect(deviceCodeFromPath('/device?code=<script>')).toBeUndefined();
    expect(deviceCodeFromPath(`/device?code=${'A'.repeat(40)}`)).toBeUndefined();
    expect(deviceCodeFromPath(`/device?code=A${'&x=1'.repeat(1000)}`)).toBeUndefined();
    expect(sanitizeDeviceCode(['ABCD-EFGH', 'x'])).toBe('ABCD-EFGH');
    expect(sanitizeDeviceCode(undefined)).toBeUndefined();
  });

  it('sanitizeId accepts session ids only', () => {
    expect(sanitizeId('ses_01JABC-x')).toBe('ses_01JABC-x');
    expect(sanitizeId('../x')).toBeUndefined();
    expect(sanitizeId('')).toBeUndefined();
  });
});

describe('picked photos', () => {
  it('names files with an extension that matches the type', () => {
    expect(pickedFileName({ uri: 'file:///a/IMG_1.HEIC', fileName: 'IMG_1.HEIC', mimeType: 'image/jpeg' })).toBe('IMG_1.jpg');
    expect(pickedFileName({ uri: 'file:///a/b.png', fileName: null, mimeType: 'image/png' }, 0, 42)).toBe('photo-42.png');
    expect(pickedFileName({ uri: 'file:///a/b.webp?x=1' }, 2, 42)).toBe('photo-42-2.webp');
    expect(pickedFileName({ uri: 'content://media/external/images/123', fileName: 'x/y.jpg' }, 0, 1)).toMatch(/^x_y\./);
  });

  it('reads the URI into a named Blob for useAttachments().add()', async () => {
    const f = vi.fn(async () => new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' })));
    const file = await assetToFile({ uri: 'file:///p.jpg', fileName: 'p.jpg', mimeType: 'image/jpeg' }, f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledWith('file:///p.jpg');
    expect(file.name).toBe('p.jpg');
    expect(file.size).toBe(3);
    expect(file.type).toBe('image/jpeg');
  });
});

describe('app.config cleartext hosts', () => {
  it('allows plain http only for loopback, private LAN and .local hosts', async () => {
    const { isPrivateHost } = await import('../app.config');
    for (const h of ['localhost', '127.0.0.1', '10.0.0.5', '172.16.1.1', '172.31.255.1', '192.168.1.20', '169.254.1.1', 'mac.local', '[::1]', '[fd12::1]']) {
      expect(isPrivateHost(h), h).toBe(true);
    }
    for (const h of ['example.com', '8.8.8.8', '172.32.0.1', '192.169.0.1', 'local.example.com', '[2001:db8::1]']) {
      expect(isPrivateHost(h), h).toBe(false);
    }
  });
});
