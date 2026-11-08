#!/usr/bin/env node
/**
 * Fails the build when the root `@uncage/hub` bundle pulls in a Node built-in (directly or through
 * a dependency such as the `@uncage/core` barrel), so a Workers / Edge build cannot break only at
 * deploy time. Bundles dist/index.js the way a workerd/browser bundler would and inspects it.
 */
import { builtinModules } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
const isBuiltin = (p) => p.startsWith('node:') || builtins.has(p) || builtins.has(p.split('/')[0]);

const NODE_GLOBALS = ['Buffer', 'process', 'require'];
const marker = (g) => `__uncage_node_global_${g}__`;

const offenders = new Set();
const result = await build({
  entryPoints: [join(pkgDir, 'dist/index.js')],
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
  define: Object.fromEntries(NODE_GLOBALS.map((g) => [g, marker(g)])),
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
  console.error(`check-web-entry: bundling dist/index.js failed:\n${err.message}`);
  process.exit(1);
});

for (const out of Object.values(result.metafile.outputs)) {
  for (const imp of out.imports) if (isBuiltin(imp.path)) offenders.add(imp.path);
}
// `Buffer.`, `process.` and `require(` as real references (not inside strings or comments).
const code = result.outputFiles.map((f) => f.text).join('\n');
const used = code.match(/__uncage_node_global_(?:Buffer|process)__\.|__uncage_node_global_require__\(/g) ?? [];
const globals = [...new Set(used.map((m) => m.replace(/__uncage_node_global_(\w+?)__/, '$1')))];

if (offenders.size > 0 || globals.length > 0) {
  console.error('check-web-entry: the root @uncage/hub entry must use Web-standard APIs only.');
  for (const o of offenders) console.error(`  Node built-in: ${o}`);
  for (const g of globals) console.error(`  Node global: ${g}`);
  process.exit(1);
}
console.log('check-web-entry: dist/index.js is Web-standard only');
