import { defineConfig } from 'vitest/config';

/**
 * `unit` always runs. Cold PGlite (WASM) starts can take several seconds on a loaded CI machine or
 * under `turbo run test` (every package at once): generous timeouts so they do not flake.
 * `docker` runs only with UNCAGE_DOCKER_TESTS=1: the Linux full chain (install.sh → Node 22 via fnm →
 * setup → agent → a codex run) and the systemd user service, in local Docker images.
 */
const docker = process.env.UNCAGE_DOCKER_TESTS === '1';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.docker.test.ts'],
          testTimeout: 20_000,
          hookTimeout: 20_000,
        },
      },
      ...(docker
        ? [
            {
              test: {
                name: 'docker',
                include: ['src/**/*.docker.test.ts'],
                testTimeout: 900_000,
                hookTimeout: 1_800_000,
              },
            },
          ]
        : []),
    ],
  },
});
