import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { fakeAcpPath } from '@uncage/testkit';
import { afterEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(process.platform === 'win32')('agent process groups', () => {
  it('a forced process.exit() leaves no agent and no grandchild behind (exit hook kills the groups)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uncage-acp-exit-'));
    dirs.push(dir);
    const agent = join(dir, 'agent');
    // The agent starts a long-running grandchild, then becomes the fake ACP agent (same pid).
    await writeFile(agent, `#!/bin/sh\necho $$ > "${dir}/leader.pid"\nsleep 60 &\necho $! > "${dir}/child.pid"\nexec "${process.execPath}" "${fakeAcpPath}"\n`);
    await chmod(agent, 0o755);
    const lib = pathToFileURL(join(import.meta.dirname, '..', 'node_modules', '.cache', 'uncage-acp-test', 'process.js')).href;
    const script = join(dir, 'main.mjs');
    await writeFile(
      script,
      `import { startAcpProcess } from ${JSON.stringify(lib)};
const p = await startAcpProcess({
  command: [${JSON.stringify(agent)}],
  env: process.env,
  initTimeoutMs: 10000,
  handlers: { onUpdate() {}, onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) },
});
console.log('initialized', p.init.protocolVersion);
// No dispose, no kill: exit right away.
process.exit(0);
`,
    );
    const { stdout } = await run(process.execPath, [script], { timeout: 20_000 });
    expect(stdout).toContain('initialized 1');
    const leader = Number(await readFile(join(dir, 'leader.pid'), 'utf8'));
    const child = Number(await readFile(join(dir, 'child.pid'), 'utf8'));
    for (let i = 0; i < 40 && (alive(leader) || alive(child)); i++) await new Promise((r) => setTimeout(r, 50));
    expect(alive(leader)).toBe(false);
    expect(alive(child)).toBe(false);
  });
});
