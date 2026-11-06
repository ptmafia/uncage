import { fileURLToPath } from 'node:url';

/** Absolute path of the built fake `codex app-server` (`dist/fake-codex.js`); run it with `node`. */
export const fakeCodexPath: string = fileURLToPath(new URL('./fake-codex.js', import.meta.url));
