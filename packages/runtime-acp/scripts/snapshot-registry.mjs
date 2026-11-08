#!/usr/bin/env node
/* global fetch, Response */
// Refreshes src/registry-snapshot.json from the official ACP Registry (run: pnpm registry:snapshot).
// The registry and icons are downloaded into a fresh temporary directory, validated with the
// package's zod schemas (invalid entries are dropped), and only data is kept: nothing downloaded is
// ever executed. Icons are embedded as base64 data URIs so websites never fetch them.
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACP_REGISTRY_URL, downloadRegistrySnapshot } from '../dist/index.js';

const out = fileURLToPath(new URL('../src/registry-snapshot.json', import.meta.url));
const dir = await mkdtemp(join(tmpdir(), 'uncage-acp-registry-'));
const raw = join(dir, 'registry.json');

// Every download is also kept as a file in the fresh directory, for review.
const saving = async (url, init) => {
  const res = await fetch(url, init);
  const body = new Uint8Array(await res.arrayBuffer());
  const name = url === ACP_REGISTRY_URL ? 'registry.json' : `icon-${String(new URL(url).pathname.split('/').pop()).replace(/[^\w.-]/g, '_')}`;
  await writeFile(join(dir, name), body);
  return new Response(body, { status: res.status, headers: res.headers });
};

const doc = await downloadRegistrySnapshot({ fetch: saving });
const { skipped, ...snapshot } = doc;
await writeFile(out, `${JSON.stringify(snapshot, null, 1)}\n`);
const bytes = (await readFile(raw)).byteLength;
console.log(`ACP registry ${snapshot.version}: ${snapshot.agents.length} agents (${snapshot.agents.filter((a) => a.icon).length} icons) from ${bytes} bytes in ${dir}`);
if (skipped.length) console.log(`Skipped (failed validation): ${skipped.join(', ')}`);
console.log(`Wrote ${out}`);
