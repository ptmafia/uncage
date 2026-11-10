import { isIP } from 'node:net';
import { domainToUnicode } from 'node:url';
import { DEFAULT_HUB_PATH } from '@uncage/agent';
import { getDomain, getDomainWithoutSuffix } from 'tldts';

export type IdentityWarning = 'idn' | 'ip' | 'path' | 'first_time' | 'lookalike';

/** Who a site is, as shown in the connect confirmation. */
export interface SiteIdentity {
  /** `https://app.example.com` (punycode host, port when not the default). */
  origin: string;
  /** The full hub URL that will be paired with (`https://app.example.com/api/uncage`): shown in the dialog. */
  url: string;
  /** The domain its owner registered (`example.com`), from the Public Suffix List; the host itself for IPs / localhost. */
  registrableDomain: string;
  /** The host as the URL parser normalizes it: punycode for IDN, dotted decimal for IPv4. */
  displayHost: string;
  warnings: IdentityWarning[];
  /** The connected domain this one looks like (with `lookalike`). */
  lookalikeOf?: string;
}

// Private suffixes too (vercel.app, github.io, …): every project there is its own owner.
const PSL = { allowPrivateDomains: true } as const;

const bareHost = (host: string): string => host.replace(/^\[(.*)\]$/, '$1');

/** `app.example.com` → `example.com`; IPs, `localhost` and unknown suffixes → the host itself. */
export function registrableDomain(host: string): string {
  const h = bareHost(host.toLowerCase());
  if (isIP(h)) return h;
  return getDomain(h, PSL) ?? h;
}

/** The registrable label (`example` of `example.co.uk`), Unicode for IDN. */
function registrableLabel(domain: string): string {
  const label = isIP(domain) ? domain : (getDomainWithoutSuffix(domain, PSL) ?? domain.split('.')[0] ?? domain);
  return domainToUnicode(label) || label;
}

/**
 * Characters that look alike, mapped to one Latin form: digits, Cyrillic and Greek letters, a few
 * Latin letters. Multi-letter sequences (rn → m, vv → w) are applied first.
 */
const SEQUENCES: Array<[RegExp, string]> = [
  [/rn/g, 'm'],
  [/vv/g, 'w'],
  [/cl/g, 'd'],
];
const CHARS: Record<string, string> = {
  // digits and Latin
  '0': 'o',
  '1': 'l',
  i: 'l',
  '|': 'l',
  '3': 'e',
  '5': 's',
  '8': 'b',
  ı: 'l',
  ɩ: 'l',
  ɑ: 'a',
  ɡ: 'g',
  // Cyrillic
  а: 'a',
  в: 'b',
  е: 'e',
  ё: 'e',
  һ: 'h',
  і: 'l',
  ї: 'l',
  ј: 'j',
  к: 'k',
  ӏ: 'l',
  м: 'm',
  н: 'h',
  о: 'o',
  р: 'p',
  с: 'c',
  т: 't',
  у: 'y',
  х: 'x',
  ѕ: 's',
  ԁ: 'd',
  ԛ: 'q',
  ԝ: 'w',
  ү: 'y',
  // Greek
  α: 'a',
  β: 'b',
  ε: 'e',
  η: 'n',
  ι: 'l',
  κ: 'k',
  ν: 'v',
  ο: 'o',
  ρ: 'p',
  τ: 't',
  υ: 'u',
  χ: 'x',
  ω: 'w',
};

/** The confusable skeleton of a label: lower case, NFKC, accents dropped, look-alike characters unified. */
export function skeleton(label: string): string {
  let s = label
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
  s = [...s].map((c) => CHARS[c] ?? c).join('');
  for (const [re, to] of SEQUENCES) s = s.replace(re, to);
  return s.replace(/-/g, '');
}

/** Labels shorter than this are look-alikes only with an identical skeleton (no edit distance). */
const MIN_FUZZY_LABEL = 4;

/** Levenshtein distance (insert, delete, substitute; each 1). */
export function editDistance(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[y.length]!;
}

/**
 * The identity of the site at `url` and what should make the user look twice: an IDN (punycode)
 * host, a raw IP, a path other than the root or the default `/api/uncage` (on a shared origin a
 * path can belong to someone else than the domain's owner), a registrable domain this computer never connected to (`known` = the registrable
 * domains of the sites in agent.yaml), and one that looks like a known one (same confusable
 * skeleton, or edit distance ≤ 2 when both registrable labels have 4 characters or more).
 */
export function siteIdentity(url: string, known: string[]): SiteIdentity {
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  const domain = registrableDomain(host);
  const ip = isIP(bareHost(host)) !== 0;
  const warnings: IdentityWarning[] = [];
  if (!ip && host.split('.').some((l) => l.startsWith('xn--'))) warnings.push('idn');
  if (ip) warnings.push('ip');
  const path = u.pathname.replace(/\/+$/, '');
  if (path !== '' && path !== DEFAULT_HUB_PATH) warnings.push('path');
  const knownSet = new Set(known.map((k) => k.toLowerCase()));
  let lookalikeOf: string | undefined;
  if (!knownSet.has(domain)) {
    warnings.push('first_time');
    if (!ip) {
      const label = registrableLabel(domain);
      const sk = skeleton(label);
      lookalikeOf = [...knownSet].find((k) => {
        if (isIP(bareHost(k))) return false;
        const other = registrableLabel(k);
        if (skeleton(other) === sk) return true;
        // Short labels are all within a few edits of each other (x vs t, abc vs xyz): only an
        // identical skeleton counts there, or the warning would fire for unrelated sites.
        if ([...label].length < MIN_FUZZY_LABEL || [...other].length < MIN_FUZZY_LABEL) return false;
        return editDistance(label, other) <= 2 || editDistance(sk, skeleton(other)) <= 2;
      });
      if (lookalikeOf) warnings.push('lookalike');
    }
  }
  return { origin: u.origin, url: `${u.origin}${path}`, registrableDomain: domain, displayHost: host, warnings, ...(lookalikeOf ? { lookalikeOf } : {}) };
}
