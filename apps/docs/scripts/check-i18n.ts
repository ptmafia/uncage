/**
 * Parity check between the English help pages and their zh-cn / ja translations.
 *
 *   node scripts/check-i18n.ts [--allow-missing]      (from apps/docs)
 *
 * For every English page that is not English-only (see `isEnglishOnly` in src/nav.mjs: generated
 * `api/**`, the changelog, the CI guide):
 *   - the zh-cn and ja versions must exist;
 *   - the fenced code blocks must be identical to English, in the same order.
 * Differences are listed and the script exits 1. With --allow-missing (used while the translations
 * land) missing files and code-block mismatches in existing files are reported as warnings only.
 * Locale pages without an English counterpart are always errors.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEnglishOnly } from '../src/nav.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const docsDir = join(root, 'src/content/docs');
const locales = ['zh-cn', 'ja'];
const allowMissing = process.argv.includes('--allow-missing');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.mdx?$/.test(name) ? [p] : [];
  });
}

/** Fenced code blocks (``` or ~~~), including the info string, in order. */
export function codeBlocks(text: string): string[] {
  const blocks: string[] = [];
  let open: { fence: string; lines: string[] } | null = null;
  for (const line of text.split('\n')) {
    const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (!open) {
      if (m) open = { fence: m[1]!, lines: [line.trim()] };
    } else if (m && m[1]![0] === open.fence[0] && m[1]!.length >= open.fence.length && m[2]!.trim() === '') {
      blocks.push(open.lines.join('\n'));
      open = null;
    } else {
      open.lines.push(line);
    }
  }
  if (open) blocks.push(open.lines.join('\n'));
  return blocks;
}

const slugOfFile = (rel: string) => rel.replace(/\.mdx?$/, '');
const all = walk(docsDir).map((p) => relative(docsDir, p));
const isLocale = (rel: string) => locales.some((l) => rel.startsWith(`${l}/`));
const english = new Map(all.filter((r) => !isLocale(r)).map((r) => [slugOfFile(r), r]));

const errors: string[] = [];
const warnings: string[] = [];
const soft = allowMissing ? warnings : errors;
let checked = 0;

for (const [slug, rel] of english) {
  if (isEnglishOnly(slug) || slug === '404') continue;
  const enBlocks = codeBlocks(readFileSync(join(docsDir, rel), 'utf8'));
  for (const loc of locales) {
    const found = all.find((r) => slugOfFile(r) === `${loc}/${slug}`);
    if (!found) {
      soft.push(`missing: ${loc}/${slug} (English: ${rel})`);
      continue;
    }
    checked++;
    const blocks = codeBlocks(readFileSync(join(docsDir, found), 'utf8'));
    if (blocks.length !== enBlocks.length) {
      soft.push(`${found}: ${blocks.length} code blocks, English ${rel} has ${enBlocks.length}`);
      continue;
    }
    blocks.forEach((b, i) => {
      if (b !== enBlocks[i]) soft.push(`${found}: code block ${i + 1} differs from ${rel}`);
    });
  }
}

for (const rel of all.filter(isLocale)) {
  const slug = slugOfFile(rel).replace(/^[^/]+\//, '');
  if (!english.has(slug) && slug !== 'index') errors.push(`${rel}: no English page ${slug}`);
  else if (isEnglishOnly(slug)) errors.push(`${rel}: ${slug} is English-only, remove the translation`);
}

for (const w of warnings) console.warn(`warning: ${w}`);
for (const e of errors) console.error(`error: ${e}`);
console.log(`check-i18n: ${checked} translated pages compared, ${warnings.length} warnings, ${errors.length} errors${allowMissing ? ' (--allow-missing)' : ''}`);
process.exit(errors.length ? 1 : 0);
