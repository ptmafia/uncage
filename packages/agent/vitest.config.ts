import { defineConfig } from 'vitest/config';

// Real hub + PGlite + WebSockets per test: generous timeouts for loaded CI machines.
export default defineConfig({ test: { include: ['src/**/*.test.ts'], testTimeout: 20_000, hookTimeout: 20_000 } });
