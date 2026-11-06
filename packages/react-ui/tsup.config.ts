import { readdir, readFile, writeFile } from 'node:fs/promises';
import { defineConfig } from 'tsup';

/** Concatenates src/styles/*.css (tokens first) into dist/styles.css. */
async function buildStyles() {
  const dir = new URL('./src/styles/', import.meta.url);
  const files = (await readdir(dir))
    .filter((f) => f.endsWith('.css'))
    .sort((a, b) => (a === 'tokens.css' ? -1 : b === 'tokens.css' ? 1 : a.localeCompare(b)));
  const parts = await Promise.all(files.map(async (f) => `/* ${f} */\n${await readFile(new URL(f, dir), 'utf8')}`));
  await writeFile(new URL('./dist/styles.css', import.meta.url), parts.join('\n'));
}

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'es2022',
  onSuccess: buildStyles,
});
