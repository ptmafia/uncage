import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installScript, type InstallScriptExtension } from './render.js';
import { createSandbox, type FakeManager, type Sandbox } from './sandbox.js';

// Review Focus 8: every test runs the script piped on stdin (like `curl | bash`) in a sandbox HOME
// with fake binaries. Nothing touches the real HOME, the network or the real /dev/tty.
const SITE = 'https://site.test';
const render = (extend?: InstallScriptExtension) => installScript({ cliRange: '^0.3', siteUrl: SITE, ...(extend ? { extend } : {}) });

let boxes: Sandbox[] = [];
const sandbox = (extend?: InstallScriptExtension): Sandbox => {
  const sb = createSandbox(render(extend));
  boxes.push(sb);
  return sb;
};
afterEach(() => {
  for (const b of boxes) b.cleanup();
  boxes = [];
});

const INSTALL_OR_SETUP = /install|setup|default|alias|use -g|set -u|fetch|download|config set/;

describe.skipIf(process.platform === 'win32')('install.sh', { timeout: 90_000 }, () => {
  it('all ready: lists the checks, installs the CLI and runs setup after two Y', async () => {
    const sb = sandbox();
    const r = await sb.run({ answers: 'y\ny\n', node: '22.23.4', agents: ['claude'] });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Checking/);
    expect(r.stdout).toMatch(/✓ macOS arm64/);
    expect(r.stdout).toMatch(/✓ Node\.js 22\.23\.4/);
    expect(r.stdout).toMatch(/✓ npm 10\.9\.2, global folder writable/);
    expect(r.stdout).toMatch(/✓ Claude Code/);
    expect(r.stdout).toMatch(/· Codex not found/);
    expect(sb.log()).toEqual([expect.stringMatching(/npm install -g @uncage\/cli@\^0\.3$/), expect.stringMatching(/uncage setup https:\/\/site\.test$/)]);
  });

  it('idempotent: a second run with the CLI installed makes no install call', async () => {
    const sb = sandbox();
    expect((await sb.run({ answers: 'y\nn\n' })).code).toBe(0);
    const r = await sb.run({ answers: 'y\n' });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/✓ Uncage CLI 0\.3\.0/);
    expect(sb.log()).toEqual([expect.stringMatching(/uncage --version$/), expect.stringMatching(/uncage setup https:\/\/site\.test$/)]);
  });

  it('an installed CLI outside the range is reinstalled', async () => {
    const sb = sandbox();
    await sb.run({ answers: 'y\nn\n' });
    writeFileSync(join(sb.dir, 'usr/bin/.uncage-version'), '0.2.5');
    const r = await sb.run({ answers: 'y\nn\n' });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/✗ Uncage CLI 0\.2\.5 does not match \^0\.3/);
    expect(sb.log()).toContainEqual(expect.stringMatching(/npm install -g @uncage\/cli@\^0\.3$/));
  });

  it.each<[FakeManager, RegExp, RegExp | null]>([
    ['nvm', /^nvm install 22$/, /^nvm alias default 22$/],
    ['fnm', /fnm install 22$/, /fnm default 22$/],
    ['mise', /mise install node@22$/, /mise use -g node@22$/],
    ['asdf', /asdf install nodejs latest:22$/, /asdf set -u nodejs /],
    ['n', /\/n download 22$/, /\/n 22$/],
    // `volta install` also makes it the default, so the script only `fetch`es without a Y.
    ['volta', /volta fetch node@22$/, /volta install node@22$/],
  ])('missing Node with %s: installs 22 without touching the default on "n"', async (mgr, install, makeDefault) => {
    const sb = sandbox();
    const r = await sb.run({ manager: mgr, node: null, answers: 'y\nn\ny\nn\n', agents: ['claude'] });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/✗ Node\.js not found/);
    expect(sb.log().some((l) => install.test(l)), sb.log().join('\n')).toBe(true);
    if (makeDefault) expect(sb.log().some((l) => makeDefault.test(l))).toBe(false);
    expect(sb.log().find((l) => /install -g @uncage\/cli/.test(l))).toMatch(/\/v?22\.23\.4\/.*npm install/); // the new Node's npm, not PATH's
    expect(r.stdout).toContain(`${sb.home}/`); // prints the absolute uncage path
    expect(r.stdout).toMatch(/Node\.js 22 is not your default, so run the Uncage CLI with: PATH="/);
    expect(sb.log().find((l) => / setup /.test(l))).toBeUndefined();
  });

  it.each<[FakeManager, RegExp]>([
    ['nvm', /^nvm alias default 22$/],
    ['volta', /volta install node@22$/],
  ])('missing Node with %s: Y to the default question makes 22 the default', async (mgr, makeDefault) => {
    const sb = sandbox();
    const r = await sb.run({ manager: mgr, node: null, answers: 'y\ny\ny\nn\n' });
    expect(r.code, r.stderr).toBe(0);
    expect(sb.log().some((l) => makeDefault.test(l))).toBe(true);
    expect(sb.log().filter((l) => /unalias|default system/.test(l))).toEqual([]);
    expect(r.stdout).toMatch(/Node\.js 22 is now your default/);
  });

  // nvm and fnm make the first version they install the default by themselves.
  const aliasFile = { nvm: '.nvm/alias/default', fnm: 'Library/Application Support/fnm/aliases/default' } as const;
  it.each(['nvm', 'fnm'] as const)('%s: the default it sets by itself for its first Node is undone on "n"', async (mgr) => {
    const sb = sandbox();
    const r = await sb.run({ manager: mgr, node: null, answers: 'y\nn\nn\n' });
    expect(r.code, r.stderr).toBe(0);
    expect(sb.log()).toContainEqual(expect.stringMatching(new RegExp(`${mgr} unalias default$`)));
    expect(sb.read(aliasFile[mgr])).toBeNull();
    expect(r.stdout).toMatch(new RegExp(`Undid the default ${mgr} sets`));
    // An older Node on PATH: the default goes back to it ("system").
    const old = sandbox();
    const r2 = await old.run({ manager: mgr, node: '20.18.0', answers: 'y\nn\nn\n' });
    expect(r2.code, r2.stderr).toBe(0);
    expect(old.log()).toContainEqual(expect.stringMatching(mgr === 'nvm' ? /^nvm alias default system$/ : /fnm default system$/));
    expect(old.read(aliasFile[mgr])?.trim()).toBe('system');
    // --yes with an existing Node.js never keeps the automatic default either.
    const yes = sandbox();
    const r3 = await yes.run({ manager: mgr, node: '20.18.0', tty: false, args: ['--yes', '--no-setup'] });
    expect(r3.code, r3.stderr).toBe(0);
    expect(yes.read(aliasFile[mgr])?.trim()).toBe('system');
  });

  it.each(['nvm', 'fnm'] as const)('%s: an existing default alias is left alone', async (mgr) => {
    const sb = sandbox();
    mkdirSync(join(sb.home, aliasFile[mgr], '..'), { recursive: true });
    writeFileSync(join(sb.home, aliasFile[mgr]), '20\n');
    const r = await sb.run({ manager: mgr, node: null, answers: 'y\nn\nn\n' });
    expect(r.code, r.stderr).toBe(0);
    expect(sb.log().filter((l) => /unalias|default system|alias default|default 22/.test(l))).toEqual([]);
    expect(sb.read(aliasFile[mgr])).toBe('20\n');
  });

  it('paths with spaces (fnm on macOS: ~/Library/Application Support/fnm) are quoted in printed commands', async () => {
    const sb = sandbox();
    const r = await sb.run({ manager: 'fnm', node: null, answers: 'y\nn\ny\nn\n' });
    expect(r.code, r.stderr).toBe(0);
    const bin = `${sb.home}/Library/Application Support/fnm/node-versions/v22.23.4/installation/bin`;
    expect(sb.log()).toContainEqual(`${bin}/npm install -g @uncage/cli@^0.3`);
    expect(r.stdout).toContain(`PATH="${bin}:$PATH" "${bin}/uncage" setup https://site.test`);
    expect(r.stdout).toContain(`run the Uncage CLI with: PATH="${bin}:$PATH" "${bin}/uncage"`);
    // With setup: the binary at that path really runs.
    const r2 = await sb.run({ manager: 'fnm', node: null, answers: 'n\ny\n' });
    expect(r2.code, r2.stderr).toBe(0);
    expect(sb.log()).toContainEqual(`${bin}/uncage setup https://site.test`);
  });

  it('nvm: an unwritable npm folder inside nvm stops (no npm prefix, nvm refuses one)', async () => {
    const sb = sandbox();
    await sb.run({ manager: 'nvm', node: null, answers: 'y\nn\ny\nn\n' });
    const ver = join(sb.home, '.nvm/versions/node/v22.23.4');
    const ro = [join(ver, 'lib/node_modules'), join(ver, 'bin')];
    for (const d of ro) chmodSync(d, 0o555);
    try {
      const r = await sb.run({ manager: 'nvm', node: null, answers: 'n\ny\ny\n' });
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/belongs to nvm/);
      expect(sb.log().filter((l) => /config set|install -g/.test(l))).toEqual([]);
      expect(existsSync(join(sb.home, '.npmrc'))).toBe(false);
    } finally {
      for (const d of ro) chmodSync(d, 0o755);
    }
  });

  it('child processes never inherit the prompt descriptor (fd 3)', async () => {
    const sb = sandbox();
    const r = await sb.run({ answers: 'y\ny\n' });
    expect(r.code, r.stderr).toBe(0);
    expect(sb.log()).toContainEqual(expect.stringMatching(/uncage setup /));
    expect(existsSync(join(sb.dir, 'fd3-open'))).toBe(false);
  });

  it('a symlinked profile stays a symlink and no temp file is left', async () => {
    const sb = sandbox();
    mkdirSync(join(sb.home, 'dotfiles'));
    writeFileSync(join(sb.home, 'dotfiles/zshrc'), 'export KEEP=1\n');
    symlinkSync(join(sb.home, 'dotfiles/zshrc'), join(sb.home, '.zshrc'));
    const r = await sb.run({ brew: true, node: null, answers: 'y\ny\nn\n' });
    expect(r.code, r.stderr).toBe(0);
    expect(lstatSync(join(sb.home, '.zshrc')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(sb.home, 'dotfiles/zshrc'), 'utf8')).toMatch(/^export KEEP=1\n\n# >>> uncage >>>\n/);
    expect(readdirSync(sb.home).filter((f) => f.includes('uncage-tmp'))).toEqual([]);
  });

  it('a manager that already has Node 22 is used without installing again', async () => {
    const sb = sandbox();
    await sb.run({ manager: 'nvm', node: null, answers: 'y\nn\nn\n' });
    const r = await sb.run({ manager: 'nvm', node: null, answers: 'n\nn\nn\n' });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/✓ Node\.js 22 is already installed with nvm/);
    expect(sb.log().filter((l) => /nvm install/.test(l))).toEqual([]);
  });

  it('node 20 counts as missing (too old)', async () => {
    const sb = sandbox();
    const r = await sb.run({ manager: 'fnm', node: '20.18.0', answers: 'y\nn\ny\nn\n' });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/✗ Node\.js 20\.18\.0 is too old/);
    expect(sb.log().some((l) => /fnm install 22$/.test(l))).toBe(true);
    expect(sb.log().find((l) => /install -g @uncage\/cli/.test(l))).toMatch(/node-versions\/v22\.23\.4\/installation\/bin\/npm install/);
  });

  it('no manager, macOS with Homebrew: brew install node@22 and one PATH block', async () => {
    const sb = sandbox();
    const r1 = await sb.run({ brew: true, node: null, answers: 'y\ny\ny\nn\n' });
    expect(r1.code, r1.stderr).toBe(0);
    expect(sb.log()).toContainEqual(expect.stringMatching(/brew install node@22$/));
    expect(sb.log().find((l) => /install -g @uncage\/cli/.test(l))).toMatch(/homebrew\/opt\/node@22\/bin\/npm install/);
    // Second run: the keg is found (no reinstall), Y again rewrites the same block.
    const r2 = await sb.run({ brew: true, node: null, answers: 'y\nn\n' });
    expect(r2.code, r2.stderr).toBe(0);
    expect(sb.log().filter((l) => /brew install|npm install/.test(l))).toEqual([]);
    const zshrc = sb.read('.zshrc')!;
    expect(zshrc.split('# >>> uncage >>>').length - 1).toBe(1);
    expect(zshrc.split('/homebrew/opt/node@22/bin:$PATH"').length - 1).toBe(1);
    expect(zshrc).toContain('# <<< uncage <<<');
  });

  it('the PATH block is rewritten in place and keeps the rest of the profile', async () => {
    const sb = sandbox();
    writeFileSync(join(sb.home, '.bash_profile'), 'export A=1\n# >>> uncage >>>\nexport OLD=1\n# <<< uncage <<<\nexport B=2');
    const r = await sb.run({ brew: true, node: null, shell: '/bin/bash', answers: 'y\ny\nn\n' });
    expect(r.code, r.stderr).toBe(0);
    const p = sb.read('.bash_profile')!;
    expect(p).toMatch(/^export A=1\n# >>> uncage >>>\nexport OLD=1\nexport PATH=".*\/homebrew\/opt\/node@22\/bin:\$PATH"\n# <<< uncage <<<\nexport B=2\n$/);
  });

  it('no manager, macOS without Homebrew / Linux: fnm installer with --install-dir --skip-shell --force-no-brew; never apt, dnf or sudo', async () => {
    const sb = sandbox();
    const r = await sb.run({ uname: 'Linux', arch: 'x86_64', shell: '/bin/bash', node: null, answers: 'y\ny\ny\nn\n', agents: ['claude'] });
    expect(r.code, r.stderr).toBe(0);
    expect(sb.log().join('\n')).toMatch(/fnm-installer --install-dir .*\/\.local\/share\/fnm --skip-shell --force-no-brew/);
    expect(sb.log()).toContainEqual(expect.stringMatching(/curl --proto =https --tlsv1\.2 -fsSL https:\/\/fnm\.vercel\.app\/install -o /));
    expect(sb.log()).toContainEqual(expect.stringMatching(/\.local\/share\/fnm\/fnm install 22$/));
    expect(sb.log()).toContainEqual(expect.stringMatching(/\.local\/share\/fnm\/fnm default 22$/));
    expect(sb.rawLog().join('\n')).not.toMatch(/\b(sudo|apt|apt-get|dnf|yum|pacman|zypper)\b/);
    const bashrc = sb.read('.bashrc')!;
    expect(bashrc).toContain('export FNM_DIR="$HOME/.local/share/fnm"');
    expect(bashrc).toContain('eval "$(fnm env --shell bash)"');
    // macOS without Homebrew takes the same path.
    const mac = sandbox();
    const r2 = await mac.run({ node: null, answers: 'y\nn\ny\nn\n' });
    expect(r2.code, r2.stderr).toBe(0);
    expect(mac.log().join('\n')).toMatch(/fnm-installer --install-dir .*\/\.local\/share\/fnm --skip-shell --force-no-brew/);
  });

  it('a failed download exits 1 and removes its temp folder', async () => {
    const sb = sandbox();
    const r = await sb.run({ uname: 'Linux', node: null, curlFails: true, answers: 'y\n' });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/curl https:\/\/fnm\.vercel\.app\/install failed/);
    expect(readdirSync(join(sb.dir, 'tmp'))).toEqual([]);
  });

  it('Linux without unzip: stops with exit 1, the reason and the manual commands', async () => {
    const sb = sandbox();
    const r = await sb.run({ uname: 'Linux', node: null, unzip: false, answers: 'y\ny\ny\ny\n' });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/needs unzip/);
    expect(r.stderr).toContain('https://nodejs.org/en/download');
    expect(r.stderr).toMatch(/fnm\\?" install 22/);
    expect(sb.log()).toEqual([]);
  });

  it('npm global dir not writable: npm config set prefix ~/.npm-global and a PATH block (once after two runs)', async () => {
    const sb = sandbox();
    const r1 = await sb.run({ npmReadOnly: true, answers: 'y\ny\nn\n' });
    expect(r1.code, r1.stderr).toBe(0);
    expect(r1.stdout).toMatch(/global folder .* is not writable/);
    expect(sb.log()[0]).toMatch(new RegExp(`npm config set prefix ${sb.home}/\\.npm-global$`));
    expect(sb.log()[1]).toMatch(/npm install -g @uncage\/cli@\^0\.3$/);
    const r2 = await sb.run({ npmReadOnly: true, answers: 'n\n' });
    expect(r2.code, r2.stderr).toBe(0);
    expect(sb.log().filter((l) => /install|config set/.test(l))).toEqual([]);
    const zshrc = sb.read('.zshrc')!;
    expect(zshrc.split('# >>> uncage >>>').length - 1).toBe(1);
    expect(zshrc.split('export PATH="$HOME/.npm-global/bin:$PATH"').length - 1).toBe(1);
  });

  it('non-TTY without --yes: nothing installed, exit 2, missing items and manual commands listed, does not hang', async () => {
    const sb = sandbox();
    const r = await sb.run({ tty: false, node: null, timeoutMs: 10_000 }); // detached: no controlling terminal
    expect(r.code).toBe(2);
    expect(sb.log().filter((l) => INSTALL_OR_SETUP.test(l))).toEqual([]);
    expect(r.stdout).toMatch(/Node\.js ≥ 22/);
    expect(r.stdout).toMatch(/nvm install 22|brew install node@22|fnm/);
    expect(r.stdout).toContain('npm install -g "@uncage/cli@^0.3"');
    expect(r.stdout).toContain(`uncage setup ${SITE}`);
    expect(r.stdout).toContain('--yes');
    // With a manager, its own command is listed.
    const r2 = await sb.run({ tty: false, node: null, manager: 'nvm', timeoutMs: 10_000 });
    expect(r2.code).toBe(2);
    expect(r2.stdout).toContain('nvm install 22');
  });

  it('non-TTY with everything installed: prints the setup command and exits 0', async () => {
    const sb = sandbox();
    await sb.run({ answers: 'y\nn\n' });
    const r = await sb.run({ tty: false, timeoutMs: 10_000 });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`/usr/bin/uncage" setup ${SITE}`);
    expect(sb.log().filter((l) => / setup /.test(l))).toEqual([]);
  });

  it('answering n installs nothing', async () => {
    for (const o of [{ manager: 'nvm' as const, node: null }, { brew: true, node: null }, { node: null }, { npmReadOnly: true }, {}]) {
      const sb = sandbox();
      const r = await sb.run({ ...o, answers: 'n\nn\nn\nn\n' });
      expect(r.code, r.stderr).toBe(0);
      expect(sb.log().filter((l) => INSTALL_OR_SETUP.test(l))).toEqual([]);
      expect(r.stdout).toMatch(/Nothing else was changed/);
    }
  });

  it('end of input at a prompt counts as n', async () => {
    const sb = sandbox();
    const r = await sb.run({ node: null, manager: 'nvm', answers: '' });
    expect(r.code).toBe(0);
    expect(sb.log()).toEqual([]);
  });

  it('--yes (bash -s -- --yes) without a terminal installs everything; --no-setup skips setup', async () => {
    const sb = sandbox();
    const r = await sb.run({ tty: false, args: ['--yes'], node: null, manager: 'mise' });
    expect(r.code, r.stderr).toBe(0);
    expect(sb.log()).toEqual([
      expect.stringMatching(/mise install node@22$/),
      expect.stringMatching(/mise use -g node@22$/), // no Node at all before: --yes may set the default
      expect.stringMatching(/npm install -g @uncage\/cli@\^0\.3$/),
      expect.stringMatching(/uncage setup https:\/\/site\.test$/),
    ]);
    const old = sandbox();
    const r2 = await old.run({ tty: false, args: ['--yes', '--no-setup'], node: '20.1.0', manager: 'mise' });
    expect(r2.code, r2.stderr).toBe(0);
    expect(old.log()).toEqual([expect.stringMatching(/mise install node@22$/), expect.stringMatching(/npm install -g @uncage\/cli@\^0\.3$/)]);
    expect(r2.stdout).toMatch(/--yes never replaces an existing Node\.js/);
    const env = sandbox();
    const r3 = await env.run({ tty: false, env: { UNCAGE_YES: '1', UNCAGE_NO_SETUP: '1' } });
    expect(r3.code, r3.stderr).toBe(0);
    expect(env.log()).toEqual([expect.stringMatching(/npm install -g @uncage\/cli@\^0\.3$/)]);
  });

  it('no agent: prints the Claude Code install command and link, skips the setup prompt', async () => {
    const sb = sandbox();
    const r = await sb.run({ agents: [], answers: 'y\n' });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('curl -fsSL https://claude.ai/install.sh | bash');
    expect(r.stdout).toContain('https://code.claude.com/docs/en/setup');
    expect(r.stdout).toMatch(/run this command again/);
    expect(r.stdout).not.toMatch(/Connect this computer/);
    expect(sb.log().some((l) => / setup /.test(l))).toBe(false);
  });

  it('Codex alone, or an ACP agent known to the CLI, counts as an agent', async () => {
    const sb = sandbox();
    const r = await sb.run({ agents: ['codex'], answers: 'y\nn\n' });
    expect(r.stdout).toMatch(/✓ Codex/);
    expect(r.stdout).toMatch(/Connect this computer to https:\/\/site\.test now\?/);
    const acp = sandbox();
    const r2 = await acp.run({ agents: [], acp: true, answers: 'y\ny\n' });
    expect(r2.code, r2.stderr).toBe(0);
    expect(acp.log()).toContainEqual(expect.stringMatching(/uncage setup https:\/\/site\.test$/));
  });

  it('a failing npm install exits 1 with the reason and the manual command on stderr', async () => {
    const sb = sandbox();
    const r = await sb.run({ npmFails: true, answers: 'y\ny\n' });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/npm error code E404/);
    expect(r.stderr).toMatch(/uncage: npm install -g @uncage\/cli@\^0\.3 failed\./);
    expect(r.stderr).toMatch(/npm" install -g "@uncage\/cli@\^0\.3"/);
    expect(sb.log().some((l) => / setup /.test(l))).toBe(false);
  });

  it('a failing setup exits 1', async () => {
    const sb = sandbox();
    await sb.run({ answers: 'y\nn\n' });
    writeFileSync(join(sb.dir, 'usr/bin/uncage'), `#!/usr/bin/env bash\n[ "$1" = --version ] && echo 0.3.0 && exit 0\nexit 4\n`);
    const r = await sb.run({ answers: 'y\n' });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/uncage setup failed/);
  });

  it('UNCAGE_CLI_SPEC replaces the npm spec', async () => {
    const sb = sandbox();
    const r = await sb.run({ answers: 'y\nn\n', env: { UNCAGE_CLI_SPEC: '/tmp/uncage-cli-0.3.0.tgz' } });
    expect(r.code, r.stderr).toBe(0);
    expect(sb.log()[0]).toMatch(/npm install -g \/tmp\/uncage-cli-0\.3\.0\.tgz$/);
  });

  it.each([
    ['zh_CN.UTF-8', /检测/],
    ['ja_JP.UTF-8', /確認/],
    ['C', /Checking/],
  ])('LANG=%s picks the language; --lang wins', async (lang, re) => {
    const sb = sandbox();
    const r = await sb.run({ tty: false, env: { LANG: lang } });
    expect(r.stdout).toMatch(re);
    const r2 = await sb.run({ tty: false, env: { LANG: lang }, args: ['--lang', 'en'] });
    expect(r2.stdout).toMatch(/Checking/);
    const r3 = await sb.run({ tty: false, env: { LANG: 'C', UNCAGE_LANG: 'ja' } });
    expect(r3.stdout).toMatch(/確認/);
  });

  it('--help prints the usage and changes nothing; an unknown option exits 1', async () => {
    const sb = sandbox();
    const r = await sb.run({ args: ['--help'] });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/--no-setup/);
    expect(sb.rawLog()).toEqual([]);
    const bad = await sb.run({ args: ['--bogus'] });
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/unknown option --bogus/);
  });

  it('an unsupported OS or architecture exits 3', async () => {
    const sb = sandbox();
    expect((await sb.run({ uname: 'FreeBSD' })).code).toBe(3);
    const r = await sb.run({ arch: 'mips' });
    expect(r.code).toBe(3);
    expect(r.stderr).toMatch(/macOS and Linux/);
  });

  it('the developer extension runs after the CLI install', async () => {
    const sb = sandbox({ shAfterCli: 'echo "EXTRA-STEP $UNCAGE_SITE_URL"\necho "$UNCAGE_BIN" > "$HOME/ext-ran"' });
    const r = await sb.run({ answers: 'y\nn\n' });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(`EXTRA-STEP ${SITE}`);
    expect(r.stdout.indexOf('EXTRA-STEP')).toBeGreaterThan(r.stdout.indexOf("Running the website's extra install step..."));
    expect(r.stdout.indexOf("Running the website's extra install step...")).toBeGreaterThan(r.stdout.indexOf('Uncage CLI installed'));
    expect(sb.read('ext-ran')).toMatch(/usr\/bin\/uncage/);
    const failing = sandbox({ shAfterCli: 'exit 7' });
    const f = await failing.run({ answers: 'y\ny\n' });
    expect(f.code).toBe(1);
    expect(f.stderr).toMatch(/extra install step failed/);
    expect(failing.log().some((l) => / setup /.test(l))).toBe(false);
  });

  it('the developer agent help replaces the "no agent" text', async () => {
    const sb = sandbox({ agentHelp: { en: "Install Acme Agent: it's at https://acme.test/agent (100%)", ja: 'Acme Agent をインストール' } });
    const r = await sb.run({ agents: [], answers: 'y\n' });
    expect(r.stdout).toContain("Install Acme Agent: it's at https://acme.test/agent (100%)");
    expect(r.stdout).not.toContain('claude.ai/install.sh');
    const ja = await sb.run({ agents: [], env: { LANG: 'ja_JP.UTF-8' }, answers: '' });
    expect(ja.stdout).toContain('Acme Agent をインストール');
  });

  it('the script body is one main function called on the last line; bash -n passes; shellcheck -s bash passes when installed', () => {
    for (const s of [render(), render({ shAfterCli: 'echo hi\nif true; then echo ok; fi', agentHelp: { en: 'x' } })]) {
      const lines = s.trimEnd().split('\n');
      expect(lines[0]).toBe('#!/usr/bin/env bash');
      expect(lines.at(-1)).toBe('main "$@"');
      // Outside function bodies there are only comments, blank lines and `set -euo pipefail`.
      let depth = 0;
      let heredoc: string | null = null;
      const top: string[] = [];
      for (const line of lines.slice(1, -1)) {
        if (heredoc) {
          if (line === heredoc) heredoc = null;
          continue;
        }
        const h = /<<'?(\w+)'?/.exec(line);
        if (h && depth > 0) heredoc = h[1]!;
        if (depth === 0 && /^[a-z_]+\(\) \{ .* \}$/.test(line)) continue; // one-line function
        if (depth === 0 && /^[a-z_]+\(\) \{$/.test(line)) depth = 1;
        else if (depth === 1 && line === '}') depth = 0;
        else if (depth === 0 && line.trim() !== '' && !line.startsWith('#')) top.push(line);
      }
      expect(top).toEqual(['set -euo pipefail']);
      const dir = mkdtempSync(join(tmpdir(), 'uncage-sh-'));
      try {
        writeFileSync(join(dir, 'install.sh'), s);
        const n = spawnSync('bash', ['-n', join(dir, 'install.sh')], { encoding: 'utf8' });
        expect(n.status, n.stderr).toBe(0);
        const sc = spawnSync('shellcheck', ['-s', 'bash', join(dir, 'install.sh')], { encoding: 'utf8' });
        if (!sc.error) expect(sc.status, sc.stdout).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
