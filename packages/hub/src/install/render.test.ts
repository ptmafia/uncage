import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INSTALL_MESSAGES } from './messages.js';
import { assertInstallExtension, assertScriptUrl, assertVersionRange, defaultCliRange, installScript } from './render.js';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '../..');
const placeholders = (s: string) => (s.match(/%[s%]/g) ?? []).filter((p) => p === '%s').length;

describe('install messages', () => {
  it('every message key exists in en, zh and ja', () => {
    const keys = Object.keys(INSTALL_MESSAGES.en).sort();
    for (const l of ['zh', 'ja'] as const) {
      expect(Object.keys(INSTALL_MESSAGES[l]).sort()).toEqual(keys);
      for (const k of keys) {
        const v = INSTALL_MESSAGES[l][k as keyof typeof INSTALL_MESSAGES.en];
        expect(v.trim(), `${l}.${k}`).not.toBe('');
        expect(placeholders(v), `${l}.${k}`).toBe(placeholders(INSTALL_MESSAGES.en[k as keyof typeof INSTALL_MESSAGES.en]));
      }
    }
  });

  it('messages are valid printf formats (only %s and %%, no backslashes, no NUL)', () => {
    for (const table of Object.values(INSTALL_MESSAGES)) {
      for (const [k, v] of Object.entries(table)) {
        expect(v.replace(/%[s%]/g, ''), k).not.toMatch(/%/);
        expect(v, k).not.toMatch(/[\\\0]/);
      }
    }
  });

  it('every message key the script uses exists, and every message is used', () => {
    const sh = installScript({ cliRange: '^0.3', siteUrl: 'https://site.test' });
    const body = sh.slice(sh.indexOf('# ---- output'));
    const used = new Set([...body.matchAll(/\b(?:say|warn|ask|uncage_msg) ([a-z_]+)/g)].map((m) => m[1]!));
    expect([...used].sort()).toEqual(Object.keys(INSTALL_MESSAGES.en).sort());
  });
});

describe('render', () => {
  it('a site URL with a quote, $, backtick or space is refused; http only for loopback', () => {
    for (const u of ["https://a.test/'x", 'https://a.test/$x', 'https://a.test/`x`', 'https://a.test/a b', 'http://a.test', 'https://a.test/"x', 'https://a.test/;x', 'https://a.test/\nx', 'https://a.test/a\\b', 'https://u@a.test', 'https://a.test?x=1', 'https://a.test:99999', 'ftp://a.test', 'https://[2001:db8::1]', 'https://a.test/%2e']) {
      expect(() => assertScriptUrl(u), u).toThrow(/site URL/);
    }
    for (const u of ['https://a.test', 'https://a.test:8443/api/uncage', 'https://a-b.c.test/x_y~z/', 'http://localhost:3000', 'http://127.0.0.1:4000', 'http://[::1]:3000']) {
      expect(assertScriptUrl(u)).toBe(u);
    }
  });

  it('version ranges: unchanged rule and default', () => {
    for (const r of ['^0.3', '~0.2.1', '0.3.0', 'latest', 'next', '1.0.0-beta.1']) expect(assertVersionRange(r)).toBe(r);
    for (const r of ['1; rm -rf /', '$(x)', '>=0.3', '']) expect(() => assertVersionRange(r)).toThrow(/cliVersionRange/);
    expect(defaultCliRange('0.3.2')).toBe('^0.3');
    expect(defaultCliRange('x')).toBe('latest');
  });

  it('extensions are validated (size, NUL, heredoc delimiter, ASCII PowerShell, one-line agent help)', () => {
    const big = 'x'.repeat(16 * 1024 + 1);
    for (const e of [
      { shAfterCli: big },
      { shAfterCli: 'a\0b' },
      { shAfterCli: 'echo\nUNCAGE_EXTENSION_EOF\necho pwned' },
      { ps1AfterCli: 'Write-Host "é"' },
      { ps1AfterCli: big },
      { agentHelp: { en: '' } },
      { agentHelp: { en: 'a\nb' } },
      { agentHelp: { en: 'ok', zh: 'x'.repeat(501) } },
      { agentHelp: { en: 'ok', fr: 'non' } as never },
    ]) {
      expect(() => assertInstallExtension(e), JSON.stringify(e).slice(0, 80)).toThrow(/installScript\./);
    }
    expect(assertInstallExtension({ shAfterCli: 'echo hi', ps1AfterCli: 'Write-Host hi', agentHelp: { en: 'x', ja: 'y' } })).toBeTruthy();
  });

  it('the rendered script embeds exactly the three values, and quotes are inert', () => {
    const s = installScript({
      cliRange: '~0.3.1',
      siteUrl: 'https://a.test/hub',
      extend: { agentHelp: { en: "it's 100% $(not run) `nope` \\n" } },
    });
    expect(s).toContain("CLI_RANGE='~0.3.1'");
    expect(s).toContain("SITE_URL='https://a.test/hub'");
    expect(s).toContain('npm install -g "@uncage/cli@~0.3.1"');
    expect(s).toContain("no_agent) M='it'\\''s 100%% $(not run) `nope` \\\\n' ;;");
    expect(s).not.toContain('@@');
  });

  it('the values are substituted before the extension is inserted (its text stays literal)', () => {
    const s = installScript({ cliRange: '^0.3', siteUrl: 'https://a.test', extend: { shAfterCli: 'echo "@@SITE_URL@@ @@CLI_RANGE@@"' } });
    expect(s).toContain('echo "@@SITE_URL@@ @@CLI_RANGE@@"');
    expect(s).toContain("SITE_URL='https://a.test'");
  });

  it('embedded.ts matches the assets (run pnpm --filter @uncage/hub embed:installers)', () => {
    const r = spawnSync(process.execPath, ['scripts/embed-installers.mjs', '--check'], { cwd: pkgDir, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
  });
});
