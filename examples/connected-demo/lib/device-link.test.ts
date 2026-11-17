import { describe, expect, it } from 'vitest';
import { deviceLinkParam } from './device-link.ts';

describe('deviceLinkParam', () => {
  it('accepts exactly one well-formed code', () => {
    expect(deviceLinkParam('ABCD-EFGH')).toEqual({ code: 'ABCD-EFGH', invalid: false });
    expect(deviceLinkParam('abcdefgh')).toEqual({ code: 'abcdefgh', invalid: false });
    expect(deviceLinkParam(undefined)).toEqual({ code: '', invalid: false });
    expect(deviceLinkParam('')).toEqual({ code: '', invalid: false });
  });

  it('a repeated ?code= (array) is an invalid link, not a crash', () => {
    expect(deviceLinkParam(['ABCD-EFGH', 'WXYZ-2345'])).toEqual({ code: '', invalid: true });
    expect(deviceLinkParam(['ABCD-EFGH'])).toEqual({ code: '', invalid: true });
  });

  it('padded or interleaved codes are invalid links', () => {
    for (const bad of ['ABCD-EFGH----', 'AB-CD-EF-GH', 'ABCD EFGH', 'ABCD--EFGH']) expect(deviceLinkParam(bad), bad).toEqual({ code: '', invalid: true });
  });
});
