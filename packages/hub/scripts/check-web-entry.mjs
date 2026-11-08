#!/usr/bin/env node
/**
 * Fails the build when the root `@uncage/hub` bundle pulls in a Node built-in (directly or through
 * a dependency such as the `@uncage/core` barrel), so a Workers / Edge build cannot break only at
 * deploy time. Bundles dist/index.js (or the entry given as the first argument) the way a
 * workerd/browser bundler would and inspects it.
 */
import { builtinModules } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
const isBuiltin = (p) => p.startsWith('node:') || builtins.has(p) || builtins.has(p.split('/')[0]);

const NODE_GLOBALS = ['Buffer', 'process', 'require'];
const marker = (g) => `__uncage_node_global_${g}__`;
const entry = process.argv[2] ? resolve(process.argv[2]) : join(pkgDir, 'dist/index.js');

const offenders = new Set();
const result = await build({
  entryPoints: [entry],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
  conditions: ['workerd', 'worker', 'browser', 'import'],
  mainFields: ['module', 'main'],
  external: ['pg', 'ioredis'],
  metafile: true,
  logLevel: 'silent',
  // Free references to Node globals become markers; the same names inside strings, comments or
  // as local variables are left alone (e.g. the install script's `process.versions`).
  define: Object.fromEntries(NODE_GLOBALS.flatMap((g) => [[g, marker(g)], [`globalThis.${g}`, marker(g)]])),
  plugins: [
    {
      name: 'node-builtins',
      setup(b) {
        // Record (and keep external) every Node built-in import, with who imported it.
        b.onResolve({ filter: /.*/ }, (args) => {
          if (!isBuiltin(args.path)) return undefined;
          offenders.add(`${args.path} (imported by ${args.importer.replace(`${pkgDir}/`, '')})`);
          return { path: args.path, external: true };
        });
      },
    },
  ],
}).catch((err) => {
  console.error(`check-web-entry: bundling ${entry} failed:\n${err.message}`);
  process.exit(1);
});

for (const out of Object.values(result.metafile.outputs)) {
  for (const imp of out.imports) if (isBuiltin(imp.path)) offenders.add(imp.path);
}
// Any real reference to a Node global (`Buffer.x`, `Buffer(`, `new Buffer`, `instanceof Buffer`,
// `process?.x`, `process[x]`, `globalThis.process`, `require(`…) — not the words inside strings or
// comments. Only `typeof X` feature checks are allowed.
const code = result.outputFiles.map((f) => f.text).join('\n');
const globals = [];
for (const m of code.matchAll(/(typeof\s+)?__uncage_node_global_(\w+?)__(.{0,30})/g)) {
  if (m[1]) continue;
  globals.push(`${m[2]}${m[3].split('\n')[0]}`);
}

if (offenders.size > 0 || globals.length > 0) {
  console.error('check-web-entry: the root @uncage/hub entry must use Web-standard APIs only.');
  for (const o of offenders) console.error(`  Node built-in: ${o}`);
  for (const g of new Set(globals)) console.error(`  Node global: ${g}`);
  process.exit(1);
}
console.log(`check-web-entry: ${entry.replace(`${pkgDir}/`, '')} is Web-standard only`);
