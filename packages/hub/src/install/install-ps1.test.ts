import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INSTALL_MESSAGES, INSTALL_MESSAGES_PS1 } from './messages.js';
import { installScript, installScriptPs1, type InstallScriptExtension } from './render.js';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SITE = 'https://site.test';
const opts = { cliRange: '^0.3', siteUrl: SITE };
const GUARD = 'if ($PSCommandPath) { exit $uncageState.Code } else { $global:LASTEXITCODE = $uncageState.Code; Remove-Variable -Name uncageState, Yes, NoSetup, Lang -ErrorAction SilentlyContinue }';
const render = (extend?: InstallScriptExtension) => installScriptPs1({ ...opts, ...(extend ? { extend } : {}) });

const has = (cmd: string): boolean => spawnSync(cmd, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8', timeout: 60_000 }).status === 0;
const isWin = process.platform === 'win32';

/** A PowerShell to run things with: `argv` turns pwsh arguments into a command line. */
interface PsHost {
  name: string;
  argv(args: string[], env: Record<string, string>, mounts: string[]): [string, string[]];
}
const nativeHost = (cmd: string): PsHost => ({ name: cmd, argv: (args) => [cmd, args] });

/**
 * Without a native pwsh, a local Docker image with pwsh runs the same scripts
 * (UNCAGE_PWSH_DOCKER_IMAGE, default mcr.microsoft.com/powershell:latest). The tests never pull:
 * the image must already exist and match this machine's architecture (amd64 images crash under
 * emulation on arm64 Macs; build an arm64 one from the pwsh linux-arm64 tarball there).
 */
function dockerHost(): PsHost | null {
  const image = process.env.UNCAGE_PWSH_DOCKER_IMAGE ?? 'mcr.microsoft.com/powershell:latest';
  const r = spawnSync('docker', ['image', 'inspect', '-f', '{{.Architecture}}', image], { encoding: 'utf8', timeout: 30_000 });
  const arch = process.arch === 'x64' ? 'amd64' : process.arch;
  if (r.status !== 0 || r.stdout.trim() !== arch) return null;
  return {
    name: `docker ${image}`,
    argv: (args, env, mounts) => [
      'docker',
      ['run', '--rm', ...mounts.flatMap((m) => ['-v', `${m}:${m}`]), ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), image, 'pwsh', ...args],
    ],
  };
}

/** PowerShell hosts here: Windows PowerShell 5.1 (Windows), pwsh 7 (native, else Docker). */
const hosts: PsHost[] = [
  ...(isWin && has('powershell.exe') ? [nativeHost('powershell.exe')] : []),
  ...(has('pwsh') ? [nativeHost('pwsh')] : isWin ? [] : [dockerHost()].filter((h): h is PsHost => h !== null)),
];

/** Decoded message tables embedded in a rendered install.ps1: locale → key → text. */
function ps1Tables(s: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  let locale = '';
  for (const line of s.split('\n')) {
    const l = /^ {2}'(en|zh|ja)' = @\{$/.exec(line);
    if (l) {
      locale = l[1]!;
      out[locale] = {};
      continue;
    }
    const m = /^ {4}'([a-z_]+)' = '([A-Za-z0-9+/=]*)'$/.exec(line);
    if (m && locale) out[locale]![m[1]!] = Buffer.from(m[2]!, 'base64').toString('utf8');
  }
  return out;
}

/** Message keys of each locale's `uncage_msg_<l>` function in a rendered install.sh. */
function shKeys(s: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const l of ['en', 'zh', 'ja']) {
    const body = s.slice(s.indexOf(`uncage_msg_${l}() {`));
    const fn = body.slice(0, body.indexOf('\n}\n'));
    out[l] = [...fn.matchAll(/^ {4}([a-z_]+)\) M=/gm)].map((m) => m[1]!).sort();
  }
  return out;
}

/**
 * Bracket balance outside strings and comments, for the subset of PowerShell install.ps1 uses
 * (single- and double-quoted strings, `#` comments, no here-strings). A cheap guard on machines
 * without PowerShell; the real parser runs below wherever a PowerShell host exists.
 */
function bracketErrors(s: string): string[] {
  const errors: string[] = [];
  const stack: Array<{ c: string; line: number }> = [];
  const pairs: Record<string, string> = { ')': '(', '}': '{', ']': '[' };
  let line = 1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '\n') line++;
    else if (c === '#') {
      while (i < s.length && s[i] !== '\n') i++;
      i--;
    } else if (c === "'") {
      i++;
      while (i < s.length && !(s[i] === "'" && s[i + 1] !== "'")) {
        if (s[i] === "'") i++;
        if (s[i] === '\n') line++;
        i++;
      }
    } else if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '`') i++;
        if (s[i] === '\n') line++;
        i++;
      }
    } else if ('({['.includes(c)) stack.push({ c, line });
    else if (')}]'.includes(c)) {
      const top = stack.pop();
      if (!top || top.c !== pairs[c]) errors.push(`line ${line}: unexpected ${c}${top ? ` (open ${top.c} from line ${top.line})` : ''}`);
    }
  }
  for (const o of stack) errors.push(`line ${o.line}: ${o.c} never closed`);
  return errors;
}

describe('install.ps1 (static, every OS)', () => {
  it('install.ps1 is ASCII-only and embeds the URL in a single-quoted literal', () => {
    const s = render({ agentHelp: { en: 'Get an agent', zh: '先安装一个助手', ja: 'エージェントを入れてください' }, ps1AfterCli: "Write-Host 'hi'" });
    // eslint-disable-next-line no-control-regex
    expect(s).toMatch(/^[\x00-\x7f]*$/);
    expect(s).toContain(`$U.SiteUrl = '${SITE}'`);
    expect(s).toContain("$U.CliRange = '^0.3'");
    expect(s).toContain("$U.CliSpec = '@uncage/cli@^0.3'");
    expect(s).toContain('npm install -g "@uncage/cli@^0.3"');
    expect(s).not.toContain('@@');
    // Everything else the site URL appears in is a comment.
    for (const line of s.split('\n').filter((l) => l.includes(SITE))) expect(line.startsWith('#') || line.includes(`'${SITE}'`), line).toBe(true);
  });

  it('install.ps1 uses no PowerShell 7-only syntax and no exit outside the -File guard', () => {
    const s = installScriptPs1(opts);
    expect(s).not.toMatch(/\?\?|\s&&\s|\s\|\|\s|-Parallel|\$PSStyle/);
    expect(s.match(/\bexit\b/g)).toHaveLength(1);
    expect(s.trimEnd().split('\n').at(-1)).toBe(GUARD);
    // PowerShell 7 makes $IsWindows / $IsLinux / $IsMacOS read-only.
    expect(s).not.toMatch(/\$(IsWindows|IsLinux|IsMacOS)\s*=/i);
    expect(s).toContain('param([switch]$Yes, [switch]$NoSetup, [string]$Lang)');
  });

  it('install.ps1 brackets balance outside strings and comments', () => {
    expect(bracketErrors(render({ ps1AfterCli: "Write-Host '{ ( ['\nexit 0" }))).toEqual([]);
    expect(bracketErrors('a { "}" \'{\' # }\n}')).toEqual([]);
    expect(bracketErrors('a { (')).toHaveLength(2);
  });

  it('install.ps1 never installs Node with winget (UAC) and never elevates', () => {
    const s = installScriptPs1(opts);
    expect(s).not.toMatch(/OpenJS\.NodeJS|RunAs|Start-Process[^\n]*-Verb/);
    expect(s).not.toMatch(/\.msi\b/i);
    expect(s).toContain('Schniz.fnm');
    expect(s).toContain("'--id', 'Schniz.fnm', '-e', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements'");
    expect(s).toContain('https://github.com/Schniz/fnm/releases/latest/download/fnm-windows.zip');
    expect(s).toContain('[Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12');
    // nvm-windows switching needs admin rights: never run.
    expect(s).not.toMatch(/'use'/);
    // The user Path goes through the registry (or the test file), never $PROFILE.
    expect(s).not.toMatch(/Add-Content[^\n]*\$PROFILE|Set-Content[^\n]*\$PROFILE/);
  });

  it('install.ps1 calls uncage.cmd, not the uncage.ps1 shim', () => {
    const s = installScriptPs1(opts);
    expect(s).toContain("Join-Path $U.NpmPrefix 'uncage.cmd'");
    expect(s).toContain("Find-UCmd 'uncage.cmd'");
    expect(s).not.toContain('uncage.ps1');
    expect(s).not.toMatch(/Find-UCmd 'uncage'/);
    // npm runs as `node npm-cli.js`, so cmd.exe never sees (and drops) the ^ of the range.
    expect(s).toContain("'node_modules\\npm\\bin\\npm-cli.js'");
    expect(s).not.toMatch(/npm\.cmd'\)|Find-UCmd 'npm'/);
  });

  it('both scripts carry the same message keys and the same exit codes', () => {
    const sh = installScript(opts);
    const ps1 = installScriptPs1(opts);
    const tables = ps1Tables(ps1);
    const keys = shKeys(sh);
    for (const l of ['en', 'zh', 'ja']) {
      expect(Object.keys(tables[l] ?? {}).sort(), l).toEqual(keys[l]);
      expect(keys[l], l).toEqual(Object.keys(INSTALL_MESSAGES.en).sort());
    }
    const codes = (s: string) => /Exit codes: ([^\n]+)/.exec(s)?.[1];
    expect(codes(ps1)).toBe(codes(sh));
    expect(codes(sh)).toBe('0 done, 1 a step failed, 2 needs a terminal to confirm, 3 unsupported.');
    const shExits = new Set([...sh.matchAll(/\bexit (\d)/g)].map((m) => m[1]));
    const ps1Exits = new Set([...ps1.matchAll(/Stop-Uncage (\d)/g)].map((m) => m[1]));
    expect([...ps1Exits].sort()).toEqual([...shExits].sort());
    expect([...ps1Exits].sort()).toEqual(['0', '1', '2', '3']);
  });

  it('every message key install.ps1 uses exists', () => {
    const s = installScriptPs1(opts);
    const body = s.slice(s.indexOf('# ---- output'));
    const used = new Set([...body.matchAll(/\b(?:Say|Warn|Ask|Get-UMsg) '([a-z_]+)'/g)].map((m) => m[1]!));
    expect(used.size).toBeGreaterThan(40);
    for (const k of used) expect(Object.keys(INSTALL_MESSAGES.en), k).toContain(k);
  });

  it('messages are .NET format strings with the Windows wording laid over, decoded as UTF-8', () => {
    const t = ps1Tables(render());
    expect(t.en!.checking).toBe('Checking this computer...');
    expect(t.zh!.checking).toBe(INSTALL_MESSAGES.zh.checking);
    expect(t.en!.node_ok).toBe('✓ Node.js {0} ({1})');
    expect(t.ja!.cli_old).toBe('✗ Uncage CLI {0} は {1} に一致しません');
    expect(t.en!.no_agent).toBe(INSTALL_MESSAGES_PS1.en.no_agent);
    expect(t.en!.not_default_hint).toBe('Node.js 22 is not your default, so run the Uncage CLI with: $env:Path = {0} + $env:Path; & {1}');
    expect(t.zh!.os_unsupported).toContain('Windows');
    const custom = ps1Tables(render({ agentHelp: { en: 'Install {an} agent: 100%', zh: '先安装一个助手' } }));
    expect(custom.en!.no_agent).toBe('Install {{an}} agent: 100%');
    expect(custom.zh!.no_agent).toBe('先安装一个助手');
    expect(custom.ja!.no_agent).toBe('Install {{an}} agent: 100%');
  });

  it('the Windows wording has the same keys and placeholders in every locale', () => {
    const count = (v: string) => (v.match(/%[s%]/g) ?? []).filter((p) => p === '%s').length;
    const keys = Object.keys(INSTALL_MESSAGES_PS1.en).sort();
    for (const l of ['en', 'zh', 'ja'] as const) {
      expect(Object.keys(INSTALL_MESSAGES_PS1[l]).sort()).toEqual(keys);
      for (const [k, v] of Object.entries(INSTALL_MESSAGES_PS1[l])) {
        expect(count(v), `${l}.${k}`).toBe(count(INSTALL_MESSAGES.en[k as keyof typeof INSTALL_MESSAGES.en]));
        expect(v.replace(/%[s%]/g, ''), `${l}.${k}`).not.toMatch(/%/);
        expect(v, `${l}.${k}`).not.toMatch(/[\\\0]/);
      }
    }
  });

  it('the extension is one single-quoted literal, inserted after the values (its text stays literal)', () => {
    const s = render({ ps1AfterCli: "Write-Host 'it''s' \"@@SITE_URL@@ @@CLI_RANGE@@\" $env:UNCAGE_BIN\r\nexit 3" });
    expect(s).toContain(`$UncageExt = 'Write-Host ''it''''s'' "@@SITE_URL@@ @@CLI_RANGE@@" $env:UNCAGE_BIN\nexit 3'`);
    expect(s).toContain(`$U.SiteUrl = '${SITE}'`);
    expect(render()).toContain("$UncageExt = ''");
  });

  it('install.ps1 only varies by range, site URL and extension', () => {
    const a = installScriptPs1({ cliRange: '~0.3.1', siteUrl: 'https://a.test/hub' });
    expect(a.split('~0.3.1').join('^0.3').split('https://a.test/hub').join(SITE)).toBe(installScriptPs1(opts));
    expect(() => installScriptPs1({ cliRange: '1; calc', siteUrl: SITE })).toThrow(/cliVersionRange/);
    expect(() => installScriptPs1({ cliRange: '^0.3', siteUrl: "https://a.test/'x" })).toThrow(/site URL/);
    expect(() => installScriptPs1({ ...opts, extend: { ps1AfterCli: 'Write-Host "é"' } })).toThrow(/ps1AfterCli/);
  });

  it.runIf(hosts.length > 0)('install.ps1 and the test scripts parse in every PowerShell here', { timeout: 120_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'uncage-ps1-parse-'));
    try {
      const file = join(dir, 'install.ps1');
      writeFileSync(file, render({ ps1AfterCli: 'Write-Host hi' }));
      const files = [file, join(pkgDir, 'test/install-ps1/run.ps1'), join(pkgDir, 'test/install-ps1/fakes.ps1')];
      const cmd = [
        '$bad = 0',
        `foreach ($f in @(${files.map((f) => `'${f}'`).join(', ')})) {`,
        '  $errs = $null; $tokens = $null',
        '  [void][System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$tokens, [ref]$errs)',
        '  foreach ($e in $errs) { Write-Output ($f + ": " + $e.Extent.StartLineNumber + ": " + $e.Message); $bad++ }',
        '}',
        'exit $bad',
      ].join('\n');
      for (const h of hosts) {
        const [exe, args] = h.argv(['-NoProfile', '-NonInteractive', '-Command', cmd], {}, [dir, pkgDir]);
        const r = spawnSync(exe, args, { encoding: 'utf8', timeout: 120_000 });
        expect(r.status, `${h.name}: ${r.stdout}${r.stderr}`).toBe(0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const SCENARIOS = [
  'all-ready',
  'idempotent',
  'nvm-windows',
  'fnm',
  'volta',
  'winget-fnm',
  'zip-fnm',
  'npm-prefix',
  'non-interactive',
  'answer-n',
  'yes',
  'no-agent',
  'npm-fails',
  'lang-zh',
  'lang-ja',
  'extension',
] as const;

// On Windows the fakes are .cmd files and the scenarios run under Windows PowerShell 5.1 and pwsh 7
// (the CI `platform (windows-latest)` job). Elsewhere pwsh (native, or Docker) runs them with bash
// fakes while the script believes it is on Windows: the same logic, minus cmd.exe and the registry.
// UNCAGE_PS1_LOG_DIR keeps one log per scenario and shell (CI uploads it when a run fails).
const logDir = join(pkgDir, 'test-results/install-ps1');
describe.runIf(hosts.length > 0)('install.ps1 scenarios', { timeout: 180_000 }, () => {
  let dir = '';
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'uncage-ps1-'));
    writeFileSync(join(dir, 'install.ps1'), render());
    writeFileSync(
      join(dir, 'install-ext.ps1'),
      render({ ps1AfterCli: "Set-Content -LiteralPath (Join-Path $env:USERPROFILE 'extension.txt') -Value ($env:UNCAGE_BIN + '|' + $env:UNCAGE_SITE_URL)\nexit 0" }),
    );
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const runPs1Scenario = (h: PsHost, name: string) =>
    new Promise<{ code: number | null; output: string }>((resolve) => {
      const env = { UNCAGE_PS1_LOG_DIR: logDir };
      const [exe, args] = h.argv(
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(pkgDir, 'test/install-ps1/run.ps1'), '-Scenario', name, '-ScriptDir', dir],
        env,
        [dir, pkgDir],
      );
      const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
      let output = '';
      child.stdout.on('data', (d: Buffer) => (output += d.toString('utf8')));
      child.stderr.on('data', (d: Buffer) => (output += d.toString('utf8')));
      child.on('close', (code) => resolve({ code, output }));
    });

  describe.each(hosts.map((h) => [h.name, h] as const))('%s', (_name, h) => {
    it.each(SCENARIOS)('install.ps1 scenario %s', async (name) => {
      const r = await runPs1Scenario(h, name);
      // Printed in full so a CI log shows it without the artifact.
      if (r.code !== 0) console.log(`--- install.ps1 scenario ${name} (${h.name}) failed ---\n${r.output}`);
      expect(r.code, r.output).toBe(0);
      expect(r.output).toContain(`PASS ${name}`);
    });
  });
});
