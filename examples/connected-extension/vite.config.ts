import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

/** `HUB_ORIGIN` (build env): the site's origin, no path. Default: the connected-demo's dev server. */
const hubOrigin = (() => {
  const raw = process.env.HUB_ORIGIN?.trim() || 'http://localhost:3200';
  const url = new URL(raw);
  if (url.pathname !== '/' || url.search || url.hash || url.username) throw new Error(`HUB_ORIGIN must be an origin like https://example.com, got ${raw}`);
  return url.origin;
})();

/** Emits manifest.json with the hub's origin as the one host permission. */
function manifest(): Plugin {
  return {
    name: 'uncage-extension-manifest',
    generateBundle() {
      const source = readFileSync(new URL('./manifest.json', import.meta.url), 'utf8').replaceAll('__HUB_ORIGIN__', hubOrigin);
      this.emitFile({ type: 'asset', fileName: 'manifest.json', source });
    },
  };
}

export default defineConfig({
  base: './',
  define: { __HUB_ORIGIN__: JSON.stringify(hubOrigin) },
  plugins: [manifest()],
  build: {
    target: 'chrome116',
    chunkSizeWarningLimit: 1500,
    rollupOptions: { input: 'panel.html', onwarn: (w, next) => (w.code === 'MODULE_LEVEL_DIRECTIVE' ? undefined : next(w)) },
  },
});
