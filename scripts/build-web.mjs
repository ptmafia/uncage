#!/usr/bin/env node
// Builds the one static deployment: the site (apps/site) with the help site (apps/docs) copied under /docs.
// Output: apps/site/dist (Vercel `outputDirectory`). Usage: node scripts/build-web.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(cmd, args) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    console.error(`build-web: \`${cmd} ${args.join(' ')}\` failed (${r.status ?? r.signal})`);
    process.exit(r.status ?? 1);
  }
}

// Workspace packages both sites depend on (not the example apps).
run('pnpm', ['exec', 'turbo', 'run', 'build', '--filter=docs^...', '--filter=site^...']);
run('pnpm', ['--filter', 'docs', 'build']);
run('pnpm', ['--filter', 'site', 'build']);

const docsDist = path.join(root, 'apps/docs/dist');
const siteDist = path.join(root, 'apps/site/dist');
const target = path.join(siteDist, 'docs');
fs.rmSync(target, { recursive: true, force: true });
fs.cpSync(docsDist, target, { recursive: true });

if (!fs.existsSync(path.join(target, 'index.html'))) {
  console.error(`build-web: ${path.relative(root, target)}/index.html is missing after the copy`);
  process.exit(1);
}
console.log(`\nbuild-web: ${path.relative(root, docsDist)} -> ${path.relative(root, target)}; output ready in ${path.relative(root, siteDist)}`);
