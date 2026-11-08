import { describe, expect, it } from 'vitest';
import { MachineInfoSchema } from './connected.js';
import { RuntimeInfoSchema } from './domain.js';
import { isImageDataUri, MAX_RUNTIME_ICON_BYTES, RuntimeIconSchema, sanitizeRuntimeIcon } from './icon.js';

const svg = (body = '<path d="M0 0h16v16z"/>') => `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`).toString('base64')}`;
const png = 'data:image/png;base64,iVBORw0KGgo=';

describe('runtime icons', () => {
  it('accepts base64 svg and png data URIs only', () => {
    expect(isImageDataUri(svg())).toBe(true);
    expect(isImageDataUri(png)).toBe(true);
    expect(isImageDataUri('data:text/html;base64,PHNjcmlwdD4=')).toBe(false);
    expect(isImageDataUri('javascript:alert(1)')).toBe(false);
    expect(isImageDataUri('https://cdn.example.com/icon.svg')).toBe(false);
    expect(isImageDataUri('data:image/svg+xml;utf8,<svg/>')).toBe(false);
    expect(isImageDataUri('data:image/svg+xml;base64,"onload=x')).toBe(false);
  });

  it('caps each icon at 16 KiB', () => {
    const big = `data:image/png;base64,${'A'.repeat(MAX_RUNTIME_ICON_BYTES)}`;
    expect(MAX_RUNTIME_ICON_BYTES).toBe(16 * 1024);
    expect(RuntimeIconSchema.safeParse({ light: big }).success).toBe(false);
    expect(sanitizeRuntimeIcon({ light: big })).toBeUndefined();
    // An oversized dark variant is dropped, the light one kept.
    expect(sanitizeRuntimeIcon({ light: png, dark: big })).toEqual({ light: png });
    expect(sanitizeRuntimeIcon({ light: 'javascript:alert(1)', dark: png })).toBeUndefined();
    expect(sanitizeRuntimeIcon(undefined)).toBeUndefined();
  });

  it('RuntimeInfo carries an optional icon; a bad icon is dropped, never failing the machine record', () => {
    const base = { id: 'acp-gemini', displayName: 'Gemini CLI (ACP)', status: 'available' as const };
    expect(RuntimeInfoSchema.parse({ ...base, icon: { light: svg(), dark: png } }).icon).toEqual({ light: svg(), dark: png });
    expect(RuntimeInfoSchema.parse(base).icon).toBeUndefined();
    const bad = RuntimeInfoSchema.safeParse({ ...base, icon: { light: 'javascript:alert(1)' } });
    expect(bad.success && bad.data.icon).toBeUndefined();
    const m = MachineInfoSchema.safeParse({
      id: 'm1', name: 'mac', os: 'darwin', online: true, lastSeenAt: new Date().toISOString(), agentVersion: '0.3.0', agentOutdated: false, transport: null,
      runtimes: [{ ...base, icon: { light: `data:image/png;base64,${'A'.repeat(20_000)}` } }],
    });
    expect(m.success).toBe(true);
  });
});
