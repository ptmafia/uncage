import { defineConfig } from 'vitest/config';

/**
 * `unit` always runs (in-process: PGlite, ioredis-mock). `docker` runs only with
 * UNCAGE_DOCKER_TESTS=1: it starts redis:7-alpine and postgres:16-alpine with `docker run` on
 * random host ports and runs the store / cluster contracts and the two-node scenario against them.
 */
const docker = process.env.UNCAGE_DOCKER_TESTS === '1';

export default defineConfig({
  test: {
    // Every test file boots PGlite (WASM) several times; under `turbo run test` (all packages at
    // once) unbounded workers starve other packages' first-PGlite tests past their 5 s timeout.
    maxWorkers: 3,
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.docker.test.ts'],
          // Cold PGlite starts can take several seconds under load: do not flake.
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
                globalSetup: ['./src/docker-setup.ts'],
                testTimeout: 60_000,
                hookTimeout: 240_000,
              },
            },
          ]
        : []),
    ],
  },
});
