import { defineConfig } from 'vitest/config';

// Cold PGlite (WASM) starts can take several seconds on a loaded CI machine or under
// `turbo run test` (every package at once): generous timeouts so they do not flake.
export default defineConfig({ test: { include: ['src/**/*.test.ts'], testTimeout: 20_000, hookTimeout: 20_000 } });
