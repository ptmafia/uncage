#!/usr/bin/env node
// Static server for apps/site/dist that emulates Vercel `trailingSlash: true`:
// /x -> 308 /x/ when /x/index.html exists; files are served as-is; misses get the site's 404.html (status 404).
// Usage: node scripts/serve-web.mjs [--port 4321] [--dir apps/site/dist]
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const port = Number(opt('--port', process.env.PORT ?? 4321));
const dir = path.resolve(root, opt('--dir', 'apps/site/dist'));

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.pagefind': 'application/octet-stream',
};

const isFile = (p) => fs.existsSync(p) && fs.statSync(p).isFile();

function send(res, status, file, extra = {}) {
  const body = fs.readFileSync(file);
  res.writeHead(status, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'content-length': body.length, ...extra });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  const file = path.join(dir, pathname);
  if (file !== dir && !file.startsWith(dir + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  if (isFile(file)) return send(res, 200, file);
  if (isFile(path.join(file, 'index.html'))) {
    if (!pathname.endsWith('/')) {
      res.writeHead(308, { location: `${pathname}/${url.search}` }).end();
      return;
    }
    return send(res, 200, path.join(file, 'index.html'));
  }
  const notFound = path.join(dir, '404.html');
  if (isFile(notFound)) return send(res, 404, notFound);
  res.writeHead(404).end('Not found');
});

server.listen(port, () => console.log(`serve-web: ${path.relative(root, dir) || '.'} on http://localhost:${port}/ (trailingSlash: true)`));
