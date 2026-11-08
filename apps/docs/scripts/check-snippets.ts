/**
 * Type-checks every TypeScript code sample on the help site against the workspace packages.
 *
 *   node scripts/check-snippets.ts        (from apps/docs; needs `pnpm build` of the packages first)
 *
 * Every ```ts / ```tsx block in src/content/docs (the generated api/ folder excluded) is checked,
 * unless its fence has the word `nocheck` (```ts nocheck), which is meant for fragments that are
 * not a whole file. Blocks of one page form one small project: a block with `title="lib/tools.ts"`
 * is written to that path, so the page's files can import each other by relative path exactly as
 * the reader will. Untitled blocks become `snippet-<n>.ts(x)`. Everything is compiled in one `tsc`
 * run (strict, bundler resolution, React JSX) and errors are reported as `page.md:line`.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const docsDir = join(root, 'src/content/docs');
const outDir = join(root, '.snippets');

interface Block {
  page: string;
  /** 1-based line of the first code line in the page. */
  line: number;
  lang: 'ts' | 'tsx';
  file: string;
  code: string;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return relative(docsDir, p) === 'api' ? [] : walk(p);
    return /\.mdx?$/.test(name) ? [p] : [];
  });
}

const FENCE = /^(\s*)(`{3,}|~{3,})(\S*)(.*)$/;

export function extractBlocks(page: string, text: string): Block[] {
  const lines = text.split('\n');
  const blocks: Block[] = [];
  let n = 0;
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE.exec(lines[i]!);
    if (!open) continue;
    const [, indent, fence, lang, meta] = open as unknown as [string, string, string, string, string];
    let j = i + 1;
    while (j < lines.length && !(lines[j]!.trim().startsWith(fence) && lines[j]!.trim().replace(/[`~]/g, '') === '')) j++;
    const body = lines.slice(i + 1, j).map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l));
    if ((lang === 'ts' || lang === 'tsx') && !/\bnocheck\b/.test(meta)) {
      n++;
      const title = /title="([^"]+)"/.exec(meta)?.[1];
      const named = title?.split(/\s+/)[0];
      const file = named && /\.(ts|tsx)$/.test(named) ? named : `snippet-${n}.${lang}`;
      blocks.push({ page, line: i + 2, lang, file, code: body.join('\n') });
    }
    i = j;
  }
  return blocks;
}

function main(): number {
  const pages = walk(docsDir);
  const blocks = pages.flatMap((p) => extractBlocks(relative(docsDir, p), readFileSync(p, 'utf8')));
  if (blocks.length === 0) {
    console.error('check-snippets: no TypeScript blocks found (wrong directory?)');
    return 1;
  }

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const origin = new Map<string, Block>();
  const seen = new Set<string>();
  for (const b of blocks) {
    const projectDir = b.page.replace(/\.mdx?$/, '').replace(/[^a-zA-Z0-9/_-]/g, '_');
    const target = join(outDir, projectDir, b.file);
    if (!target.startsWith(join(outDir, projectDir))) throw new Error(`${b.page}:${b.line}: title escapes the page project`);
    if (seen.has(target)) {
      console.error(`${b.page}:${b.line}: two blocks on this page are both titled "${b.file}". Give each file its own title.`);
      return 1;
    }
    seen.add(target);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${b.code}\n`);
    origin.set(relative(outDir, target), b);
  }
  writeFileSync(
    join(outDir, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2023',
          lib: ['ES2023', 'DOM', 'DOM.Iterable'],
          module: 'ESNext',
          moduleResolution: 'bundler',
          moduleDetection: 'force',
          jsx: 'react-jsx',
          strict: true,
          noUncheckedIndexedAccess: true,
          allowImportingTsExtensions: true,
          isolatedModules: true,
          esModuleInterop: true,
          skipLibCheck: true,
          noEmit: true,
          types: ['node'],
        },
        include: ['**/*.ts', '**/*.tsx'],
      },
      null,
      2,
    ),
  );

  const tsc = join(root, 'node_modules/.bin/tsc');
  const r = spawnSync(tsc, ['-p', join(outDir, 'tsconfig.json'), '--pretty', 'false'], { encoding: 'utf8' });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.status === 0) {
    console.log(`check-snippets: ${blocks.length} TypeScript blocks on ${new Set(blocks.map((b) => b.page)).size} pages type-check.`);
    return 0;
  }
  // `.snippets/guides/x/lib/a.ts(12,5): error TS…` → `guides/x.md:<page line> (lib/a.ts): error TS…`
  const mapped = output
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      const m = /^(.+?)\((\d+),(\d+)\): (.*)$/.exec(l);
      if (!m) return l;
      const b = origin.get(relative(outDir, resolve(outDir, m[1]!)));
      if (!b) return l;
      return `${b.page}:${b.line + Number(m[2]) - 1}:${m[3]} (${b.file}): ${m[4]}`;
    });
  console.error(mapped.join('\n'));
  console.error(`\ncheck-snippets: type errors in the samples above (${blocks.length} blocks checked).`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
