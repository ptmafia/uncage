#!/usr/bin/env node
// Crawls apps/site/dist from the entry pages, following same-origin links and resources
// (directory -> index.html), and fails on any missing target. Checked: a/link/script/img/source/
// iframe href|src|srcset (so link rel=canonical and rel=alternate too) and meta og:image. Absolute
// URLs on the canonical origin (SITE_URL, default https://uncage-dev.vercel.app) count as internal.
// Other origins are ignored. Fragments (#...) are NOT verified, only the page they point into.
// Usage: node scripts/check-web-links.mjs [--dir apps/site/dist]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dir = path.resolve(root, args.includes('--dir') ? args[args.indexOf('--dir') + 1] : 'apps/site/dist');
const ORIGIN = 'https://site.invalid';
/** The canonical origin the builds write into absolute URLs (canonical, hreflang, og:image). */
const SITE_ORIGIN = new URL(process.env.SITE_URL || 'https://uncage-dev.vercel.app').origin;
const ENTRIES = ['/', '/zh/', '/ja/', '/docs/', '/docs/zh-cn/', '/docs/ja/', '/robots.txt', '/sitemap-index.xml', '/docs/sitemap-index.xml'];
const isInternal = (/** @type {URL} */ u) => u.origin === ORIGIN || u.origin === SITE_ORIGIN;

/** Resolves a URL path to a file in dist, or null. */
function resolveFile(pathname) {
  let p;
  try {
    p = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const file = path.join(dir, p);
  if (file !== dir && !file.startsWith(dir + path.sep)) return null;
  if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  const index = path.join(file, 'index.html');
  return fs.existsSync(index) ? index : null;
}

function extractUrls(html) {
  const urls = [];
  for (const m of html.matchAll(/<(?:a|link|script|img|source|iframe)\b[^>]*>/gi)) {
    for (const a of m[0].matchAll(/\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) urls.push(a[1] ?? a[2]);
    for (const a of m[0].matchAll(/\bsrcset\s*=\s*"([^"]*)"/gi)) for (const part of a[1].split(',')) urls.push(part.trim().split(/\s+/)[0]);
  }
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    if (!/\bproperty\s*=\s*["']og:image["']/i.test(m[0])) continue;
    const c = m[0].match(/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    if (c) urls.push(c[1] ?? c[2]);
  }
  return urls.filter(Boolean);
}

const queue = ENTRIES.map((e) => ({ url: e, from: '(entry)' }));
const seen = new Set();
const missing = [];
let pages = 0;

while (queue.length) {
  const { url, from } = queue.shift();
  const u = new URL(url, ORIGIN);
  if (!isInternal(u)) continue; // external
  const key = u.pathname;
  if (seen.has(key)) continue;
  seen.add(key);
  const file = resolveFile(u.pathname);
  if (!file) {
    missing.push(`${u.pathname}   (linked from ${from})`);
    continue;
  }
  if (!file.endsWith('.html')) continue;
  pages++;
  const base = new URL(u.pathname, ORIGIN);
  for (const raw of extractUrls(fs.readFileSync(file, 'utf8'))) {
    if (/^(mailto:|tel:|javascript:|data:|#)/i.test(raw)) continue;
    let next;
    try {
      next = new URL(raw, base);
    } catch {
      continue;
    }
    if (isInternal(next)) queue.push({ url: next.pathname, from: u.pathname });
  }
}

if (missing.length) {
  console.error(`check-web-links: ${missing.length} missing target(s):\n${missing.map((m) => `  ${m}`).join('\n')}`);
  process.exit(1);
}
console.log(`check-web-links: ok (${pages} pages, ${seen.size} internal targets, 0 missing)`);
