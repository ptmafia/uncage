#!/usr/bin/env node
// Crawls apps/site/dist from the entry pages, following same-origin links and resources
// (directory -> index.html), and fails on any missing target. External links are ignored.
// Usage: node scripts/check-web-links.mjs [--dir apps/site/dist]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dir = path.resolve(root, args.includes('--dir') ? args[args.indexOf('--dir') + 1] : 'apps/site/dist');
const ORIGIN = 'https://site.invalid';
const ENTRIES = ['/', '/zh/', '/ja/', '/docs/', '/docs/zh-cn/', '/docs/ja/'];

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
  return urls.filter(Boolean);
}

const queue = ENTRIES.map((e) => ({ url: e, from: '(entry)' }));
const seen = new Set();
const missing = [];
let pages = 0;

while (queue.length) {
  const { url, from } = queue.shift();
  const u = new URL(url, ORIGIN);
  if (u.origin !== ORIGIN) continue; // external
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
    if (next.origin === ORIGIN) queue.push({ url: next.pathname, from: u.pathname });
  }
}

if (missing.length) {
  console.error(`check-web-links: ${missing.length} missing target(s):\n${missing.map((m) => `  ${m}`).join('\n')}`);
  process.exit(1);
}
console.log(`check-web-links: ok (${pages} pages, ${seen.size} internal targets, 0 missing)`);
