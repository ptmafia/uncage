import { defineConfig } from '@playwright/test';

const PORT = 4417;

/** Runs against the production build served by `astro preview`, in the system Chrome (no browser download). */
export default defineConfig({
  testDir: 'tests',
  testMatch: '*.spec.ts',
  fullyParallel: true,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: `http://localhost:${PORT}`, channel: 'chrome' },
  webServer: {
    // --ignore-lock keeps `astro preview` in the foreground (it backgrounds itself when it detects an agent).
    command: `pnpm build && pnpm preview --port ${PORT} --ignore-lock`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
