import { describe, expect, it } from 'vitest';
import { editDistance, registrableDomain, siteIdentity, skeleton } from './site-identity.js';

describe('siteIdentity', () => {
  it('shows the registrable domain (Public Suffix List, private suffixes included) and the origin', () => {
    const i = siteIdentity('https://app.example.com/api/uncage', ['example.com']);
    expect(i).toEqual({ origin: 'https://app.example.com', registrableDomain: 'example.com', displayHost: 'app.example.com', warnings: [] });
    expect(siteIdentity('https://shop.a.b.co.uk/x', []).registrableDomain).toBe('b.co.uk');
    // vercel.app is a private public suffix: each project is its own registrable domain.
    expect(siteIdentity('https://evil.vercel.app', ['good.vercel.app']).registrableDomain).toBe('evil.vercel.app');
  });

  it('flags a domain never connected before', () => {
    expect(siteIdentity('https://example.com', []).warnings).toEqual(['first_time']);
    expect(siteIdentity('https://example.com', ['other-site.org']).warnings).toEqual(['first_time']);
  });

  it('flags idn (xn--) hosts and shows the punycode form', () => {
    const i = siteIdentity('https://bücher.de', []);
    expect(i.displayHost).toBe('xn--bcher-kva.de');
    expect(i.registrableDomain).toBe('xn--bcher-kva.de');
    expect(i.warnings).toContain('idn');
    expect(siteIdentity('https://xn--bcher-kva.de', []).warnings).toContain('idn');
  });

  it('flags raw IP hosts (v4, v6, odd IPv4 spellings)', () => {
    expect(siteIdentity('https://203.0.113.9', []).warnings).toEqual(['ip', 'first_time']);
    expect(siteIdentity('https://[2001:db8::1]:8443', []).warnings).toEqual(['ip', 'first_time']);
    const odd = siteIdentity('https://0xcb.0.113.9', []);
    expect(odd.displayHost).toBe('203.0.113.9');
    expect(odd.warnings).toContain('ip');
    expect(siteIdentity('http://127.0.0.1:3000', ['127.0.0.1']).warnings).toEqual(['ip']);
  });

  it('flags lookalike (examp1e.com vs example.com) by skeleton or edit distance <= 2', () => {
    const i = siteIdentity('https://examp1e.com', ['example.com']);
    expect(i.warnings).toEqual(['first_time', 'lookalike']);
    expect(i.lookalikeOf).toBe('example.com');
    expect(siteIdentity('https://exarnple.com', ['example.com']).lookalikeOf).toBe('example.com'); // rn → m
    expect(siteIdentity('https://example.co', ['example.com']).lookalikeOf).toBe('example.com'); // same label, other suffix
    expect(siteIdentity('https://exampel.com', ['example.com']).lookalikeOf).toBe('example.com'); // distance 2
    expect(siteIdentity('https://paypal-secure-login.com', ['paypal.com']).warnings).toEqual(['first_time']); // distance > 2
    expect(siteIdentity('https://unrelated.com', ['example.com']).lookalikeOf).toBeUndefined();
  });

  it('flags IDN homographs of a known domain (Cyrillic а) as idn + lookalike', () => {
    const i = siteIdentity('https://exаmple.com', ['example.com']); // Cyrillic а (U+0430)
    expect(i.displayHost).toMatch(/^xn--/);
    expect(i.warnings).toEqual(['idn', 'first_time', 'lookalike']);
    expect(i.lookalikeOf).toBe('example.com');
    expect(siteIdentity('https://аррӏе.com', ['apple.com']).lookalikeOf).toBe('apple.com');
  });

  it('a known domain is never its own lookalike; a subdomain of a known domain is not first time', () => {
    expect(siteIdentity('https://example.com', ['example.com']).warnings).toEqual([]);
    expect(siteIdentity('https://new.example.com', ['example.com']).warnings).toEqual([]);
  });

  it('localhost has itself as registrable domain', () => {
    expect(siteIdentity('http://localhost:3000/api/uncage', []).registrableDomain).toBe('localhost');
    expect(registrableDomain('localhost')).toBe('localhost');
  });
});

describe('skeleton / editDistance', () => {
  it('maps common Latin homoglyphs, digits and Cyrillic / Greek letters to one skeleton', () => {
    expect(skeleton('examp1e')).toBe(skeleton('example'));
    expect(skeleton('g00gle')).toBe(skeleton('google'));
    expect(skeleton('rnicrosoft')).toBe(skeleton('microsoft'));
    expect(skeleton('раураl')).toBe(skeleton('paypal')); // Cyrillic р а у
    expect(skeleton('ехаmрlе')).toBe(skeleton('example'));
    expect(skeleton('exämple')).toBe(skeleton('example')); // diacritics
    expect(skeleton('vvikipedia')).toBe(skeleton('wikipedia'));
    expect(skeleton('github')).not.toBe(skeleton('gitlab'));
  });

  it('computes Levenshtein distance', () => {
    expect(editDistance('example', 'example')).toBe(0);
    expect(editDistance('example', 'exampel')).toBe(2);
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance('', 'abc')).toBe(3);
  });
});
