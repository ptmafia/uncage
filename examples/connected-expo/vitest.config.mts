import { defineConfig } from 'vitest/config';

// lib/ is plain TypeScript (platform pieces are injected), so it runs in Node.
export default defineConfig({ test: { include: ['lib/**/*.test.ts'], environment: 'node' } });
