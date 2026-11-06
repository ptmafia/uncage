import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './fixtures.ts';

const examples = fileURLToPath(new URL('../../examples/', import.meta.url));

/** Recursively checks a build output for a string. */
function contains(dir: string, needle: string): boolean {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory() ? contains(p, needle) : readFileSync(p).includes(needle)) return true;
  }
  return false;
}

test('headless has no react-ui', async ({ example }) => {
  test.skip(example !== 'headless', 'build-time check; runs once');

  const pkg = JSON.parse(readFileSync(join(examples, 'react-headless-chat/package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    expect(Object.keys(pkg[field] ?? {})).not.toContain('@uncage/react-ui');
  }

  const headlessBuild = join(examples, 'react-headless-chat/.next');
  const defaultBuild = join(examples, 'nextjs-default-chat/.next');
  expect(existsSync(headlessBuild)).toBe(true);
  // Sanity: the scan does find react-ui's classes where they are expected.
  expect(contains(defaultBuild, 'uc-approval')).toBe(true);
  expect(contains(headlessBuild, 'uc-approval')).toBe(false);
});
