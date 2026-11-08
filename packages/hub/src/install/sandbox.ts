/**
 * Test helper (not part of the build): runs a rendered install.sh exactly like `curl | bash` (the
 * script on stdin) inside a throwaway sandbox. HOME is a temp folder; PATH is
 * `<fakebin>:<usr/bin>:<sysbin>`, where sysbin only links a few harmless system tools and every
 * other command (`node`, `npm`, `brew`, `nvm`, `fnm`, `mise`, `asdf`, `volta`, `n`, `curl`, `unzip`,
 * `claude`, `codex`, `uncage`, `uname`) is a fake that appends `"$0 $*"` to `calls.log`. The
 * environment is built from scratch (no real NVM_DIR, FNM_DIR, VOLTA_HOME, …), and the process is
 * detached, so it has no controlling terminal: the real /dev/tty is never read. Nothing here
 * touches the real HOME or the network.
 */
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

export type FakeManager = 'nvm' | 'fnm' | 'mise' | 'asdf' | 'volta' | 'n';

export interface SandboxRunOptions {
  /** Lines typed at the prompts (`UNCAGE_TTY` points at a file with them). Ignored when `tty` is false. */
  answers?: string;
  /** false: no terminal at all (UNCAGE_TTY unset, detached process). Default true. */
  tty?: boolean;
  /** Node.js on PATH (`usr/bin/node` + `usr/bin/npm`, npm prefix `usr`), or null for none. Default '22.23.4'. */
  node?: string | null;
  /** A version manager the user already has. */
  manager?: FakeManager;
  /** `uname -s`. Default 'Darwin'. */
  uname?: 'Darwin' | 'Linux' | 'FreeBSD';
  /** `uname -m`. Default 'arm64'. */
  arch?: string;
  /** Homebrew on PATH. */
  brew?: boolean;
  /** `unzip` on PATH. Default true. */
  unzip?: boolean;
  /** Agents on PATH. Default ['claude']. */
  agents?: Array<'claude' | 'codex'>;
  /** `uncage runtimes --json` reports an available ACP agent. */
  acp?: boolean;
  /** The npm prefix (`usr`) is read-only. */
  npmReadOnly?: boolean;
  /** `npm install -g` fails. */
  npmFails?: boolean;
  /** `curl` fails (exit 22). */
  curlFails?: boolean;
  /** $SHELL. Default '/bin/zsh'. */
  shell?: string;
  /** Arguments after `bash -s --`. */
  args?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface SandboxResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const SYS_TOOLS = ['bash', 'env', 'uname', 'mkdir', 'cat', 'grep', 'sed', 'tr', 'head', 'tail', 'printf', 'chmod', 'rm', 'ln', 'dirname', 'basename', 'id', 'touch', 'mktemp', 'cut', 'sort', 'wc'];

/** Read-only queries the script makes to look around; `log()` leaves them out (`rawLog()` keeps them). */
const QUERY = /(^|\/)(node|npm) (--version|-v|-p|config get)|(^|\/)(nvm|fnm|mise|asdf|volta|n|brew) (--version|which|where|list|plugin list|exec|run|--prefix)\b|(^|\/)uncage runtimes|(^|\/)uname /;

function findOnPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const p = join(dir, name);
    if (dir && existsSync(p)) return p;
  }
  return null;
}

export interface Sandbox {
  dir: string;
  home: string;
  run(o?: SandboxRunOptions): Promise<SandboxResult>;
  /** Calls made by the last run, without read-only queries. */
  log(): string[];
  /** Every call made by the last run. */
  rawLog(): string[];
  read(pathInHome: string): string | null;
  cleanup(): void;
}

export function createSandbox(script: string): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'uncage-sb-'));
  const home = join(dir, 'home');
  const sysbin = join(dir, 'sysbin');
  const fakebin = join(dir, 'fakebin');
  const usr = join(dir, 'usr');
  const tpl = join(dir, 'tpl');
  const tmp = join(dir, 'tmp');
  const logFile = join(dir, 'calls.log');
  for (const d of [home, sysbin, tmp, tpl]) mkdirSync(d, { recursive: true });
  for (const t of SYS_TOOLS) {
    const real = findOnPath(t);
    if (real) symlinkSync(real, join(sysbin, t));
  }
  const bash = join(sysbin, 'bash');

  const fake = (path: string, body: string): void => {
    writeFileSync(path, `#!/usr/bin/env bash\nLOG='${logFile}'\nTPL='${tpl}'\nSB='${dir}'\necho "$0 $*" >> "$LOG"\n${body}\n`);
    chmodSync(path, 0o755);
  };

  // Templates the fakes copy when they "install" something. lib.sh: put_node <bindir> <version>.
  writeFileSync(
    join(tpl, 'lib.sh'),
    `put_node() { mkdir -p "$1"; cat "$TPL/node" > "$1/node"; cat "$TPL/npm" > "$1/npm"; chmod +x "$1/node" "$1/npm"; printf '%s' "$2" > "$1/.version"; }\n`,
  );
  fake(
    join(tpl, 'node'),
    `v=$(cat "$(dirname "$0")/.version")
case "\${1:-}" in
  --version|-v) echo "v$v" ;;
  -p) if [ "\${2:-}" = process.execPath ]; then echo "$0"; else echo "$v"; fi ;;
esac`,
  );
  fake(
    join(tpl, 'npm'),
    `if { : <&3; } 2>/dev/null; then echo "npm $*" >> "$SB/fd3-open"; fi
prefix=$(cd "$(dirname "$0")/.." && pwd)
if [ -f "$HOME/.npmrc" ]; then p=$(grep '^prefix=' "$HOME/.npmrc" | tail -n 1 | cut -d= -f2-); [ -n "$p" ] && prefix=$p; fi
case "\${1:-} \${2:-}" in
  "--version "*) echo 10.9.2 ;;
  "config get") echo "$prefix" ;;
  "config set") printf 'prefix=%s\\n' "$4" >> "$HOME/.npmrc" ;;
  "install -g")
    if [ -f "$SB/npm-fails" ]; then echo "npm error code E404 (fake failure)" >&2; exit 1; fi
    mkdir -p "$prefix/lib/node_modules" "$prefix/bin" 2>/dev/null
    if [ ! -w "$prefix/lib/node_modules" ] || [ ! -w "$prefix/bin" ]; then echo "npm error code EACCES" >&2; exit 243; fi
    v=\${3##*@}; v=\${v#^}; v=\${v#\\~}
    case "$v" in *.*.*) ;; *.*) v="$v.0" ;; *) v="$v.0.0" ;; esac
    mkdir -p "$prefix/lib/node_modules/@uncage/cli"
    cat "$TPL/uncage" > "$prefix/bin/uncage"; chmod +x "$prefix/bin/uncage"; printf '%s' "$v" > "$prefix/bin/.uncage-version" ;;
esac`,
  );
  fake(
    join(tpl, 'uncage'),
    `if { : <&3; } 2>/dev/null; then echo "uncage $*" >> "$SB/fd3-open"; fi
case "\${1:-}" in
  --version) cat "$(dirname "$0")/.uncage-version"; echo ;;
  runtimes) if [ -f "$SB/acp" ]; then echo '[{"id":"acp-gemini","status": "available"}]'; else echo "unknown command" >&2; exit 1; fi ;;
esac`,
  );
  // fnm: like the real one, the first install becomes the default (aliases/default). Without
  // FNM_DIR its data dir on macOS is "~/Library/Application Support/fnm" (a path with a space).
  fake(
    join(tpl, 'fnm'),
    `. "$TPL/lib.sh"
root=\${FNM_DIR:-}
if [ -z "$root" ]; then if [ "$(uname -s)" = Darwin ]; then root="$HOME/Library/Application Support/fnm"; else root="$HOME/.local/share/fnm"; fi; fi
d="$root/node-versions/v22.23.4/installation/bin"
case "\${1:-}" in
  install) put_node "$d" 22.23.4; if [ ! -e "$root/aliases/default" ]; then mkdir -p "$root/aliases"; echo 22.23.4 > "$root/aliases/default"; fi ;;
  default) mkdir -p "$root/aliases"; echo "$2" > "$root/aliases/default" ;;
  unalias) rm -f "$root/aliases/$2" ;;
  exec) [ -x "$d/node" ] || exit 1; shift 2; PATH="$d:$PATH" "$@" ;;
esac`,
  );
  // What `curl -fsSL https://fnm.vercel.app/install -o <file>` downloads.
  writeFileSync(
    join(tpl, 'fnm-installer'),
    `#!/usr/bin/env bash
echo "$0 $*" >> '${logFile}'
d=''
while [ $# -gt 0 ]; do case "$1" in --install-dir) d=$2; shift ;; esac; shift; done
mkdir -p "$d"; cat '${tpl}/fnm' > "$d/fnm"; chmod +x "$d/fnm"
`,
  );

  let lastLog: string[] = [];

  const writeFakes = (o: SandboxRunOptions): void => {
    rmSync(fakebin, { recursive: true, force: true });
    mkdirSync(fakebin, { recursive: true });
    rmSync(join(dir, 'npm-fails'), { force: true });
    rmSync(join(dir, 'acp'), { force: true });
    if (o.npmFails) writeFileSync(join(dir, 'npm-fails'), '');
    if (o.acp) writeFileSync(join(dir, 'acp'), '');
    fake(join(fakebin, 'uname'), `case "\${1:-}" in -m) echo '${o.arch ?? 'arm64'}' ;; *) echo '${o.uname ?? 'Darwin'}' ;; esac`);
    fake(join(fakebin, 'curl'), `${o.curlFails ? 'exit 22\n' : ''}out=''; url=''
while [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift ;; --proto) shift ;; -*) ;; *) url=$1 ;; esac; shift; done
[ "$url" = https://fnm.vercel.app/install ] && [ -n "$out" ] || exit 22
cat "$TPL/fnm-installer" > "$out"`);
    if (o.unzip !== false) fake(join(fakebin, 'unzip'), 'exit 0');
    for (const a of o.agents ?? ['claude']) fake(join(fakebin, a), 'exit 0');

    // Node on PATH: usr/bin (npm prefix usr, like /usr/local).
    const usrBin = join(usr, 'bin');
    if (existsSync(usr)) chmodSync(usr, 0o755);
    if (existsSync(usrBin)) chmodSync(usrBin, 0o755);
    if (existsSync(join(usr, 'lib/node_modules'))) chmodSync(join(usr, 'lib/node_modules'), 0o755);
    if (o.node !== null) {
      mkdirSync(join(usr, 'lib/node_modules'), { recursive: true });
      mkdirSync(usrBin, { recursive: true });
      writeFileSync(join(usrBin, 'node'), readFileSync(join(tpl, 'node')));
      writeFileSync(join(usrBin, 'npm'), readFileSync(join(tpl, 'npm')));
      chmodSync(join(usrBin, 'node'), 0o755);
      chmodSync(join(usrBin, 'npm'), 0o755);
      writeFileSync(join(usrBin, '.version'), o.node ?? '22.23.4');
      if (o.npmReadOnly) {
        chmodSync(join(usr, 'lib/node_modules'), 0o555);
        chmodSync(usrBin, 0o555);
        chmodSync(usr, 0o555);
      }
    } else {
      for (const f of ['node', 'npm', '.version']) rmSync(join(usrBin, f), { force: true });
    }

    if (o.brew) {
      fake(
        join(fakebin, 'brew'),
        `. "$TPL/lib.sh"
case "\${1:-}" in
  --prefix) echo "$SB/homebrew" ;;
  install) [ "\${2:-}" = node@22 ] && put_node "$SB/homebrew/opt/node@22/bin" 22.23.4 ;;
esac`,
      );
    }
    switch (o.manager) {
      case 'nvm':
        mkdirSync(join(home, '.nvm'), { recursive: true });
        writeFileSync(
          join(home, '.nvm/nvm.sh'),
          `TPL='${tpl}'
. "$TPL/lib.sh"
nvm() {
  echo "nvm $*" >> '${logFile}'
  local d="$NVM_DIR/versions/node/v22.23.4/bin"
  case "\${1:-}" in
    install) put_node "$d" 22.23.4; if [ ! -e "$NVM_DIR/alias/default" ]; then mkdir -p "$NVM_DIR/alias"; echo 22 > "$NVM_DIR/alias/default"; fi ;;
    alias) mkdir -p "$NVM_DIR/alias"; echo "$3" > "$NVM_DIR/alias/$2" ;;
    unalias) rm -f "$NVM_DIR/alias/$2" ;;
    which) if [ -x "$d/node" ]; then echo "$d/node"; else echo "N/A: version \\"$2\\" is not yet installed." ; return 1; fi ;;
  esac
}
`,
        );
        break;
      case 'fnm':
        writeFileSync(join(fakebin, 'fnm'), readFileSync(join(tpl, 'fnm')));
        chmodSync(join(fakebin, 'fnm'), 0o755);
        break;
      case 'mise':
        fake(
          join(fakebin, 'mise'),
          `. "$TPL/lib.sh"; d="$HOME/.local/share/mise/installs/node/22.23.4"
case "\${1:-}" in install) put_node "$d/bin" 22.23.4 ;; where) [ -x "$d/bin/node" ] && echo "$d" || exit 1 ;; esac`,
        );
        break;
      case 'asdf':
        fake(
          join(fakebin, 'asdf'),
          `. "$TPL/lib.sh"; d="$HOME/.asdf/installs/nodejs/22.23.4"
case "\${1:-} \${2:-}" in
  "plugin list") echo nodejs ;;
  "install nodejs") put_node "$d/bin" 22.23.4 ;;
  "list nodejs") [ -x "$d/bin/node" ] && echo "  22.23.4" ;;
  "where nodejs") echo "$d" ;;
esac`,
        );
        break;
      case 'volta':
        fake(
          join(fakebin, 'volta'),
          `. "$TPL/lib.sh"; d="$HOME/.volta/tools/image/node/22.23.4/bin"
# Like the real volta, \`run --node 22\` downloads Node.js when it is missing.
case "\${1:-}" in fetch | run) put_node "$d" 22.23.4 ;; esac`,
        );
        break;
      case 'n':
        fake(
          join(fakebin, 'n'),
          `. "$TPL/lib.sh"; d="$N_PREFIX/n/versions/node/22.23.4/bin"
case "\${1:-}" in download) put_node "$d" 22.23.4 ;; which) [ -x "$d/node" ] && echo "$d/node" || exit 1 ;; esac`,
        );
        break;
    }
  };

  return {
    dir,
    home,
    async run(o: SandboxRunOptions = {}) {
      writeFakes(o);
      writeFileSync(logFile, '');
      const tty = o.tty !== false;
      const answers = join(dir, 'answers');
      writeFileSync(answers, o.answers ?? '');
      const env: Record<string, string> = {
        HOME: home,
        PATH: [fakebin, join(usr, 'bin'), sysbin].join(':'),
        SHELL: o.shell ?? '/bin/zsh',
        TMPDIR: tmp,
        N_PREFIX: join(home, 'n-prefix'),
        ...(tty ? { UNCAGE_TTY: answers } : {}),
        ...o.env,
      };
      const child = spawn(bash, ['-s', '--', ...(o.args ?? [])], { env, cwd: home, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
      child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
      child.stdin.on('error', () => undefined);
      child.stdin.end(script);
      const code = await new Promise<number | null>((resolve) => {
        const timer = setTimeout(() => {
          try {
            process.kill(-child.pid!, 'SIGKILL');
          } catch {
            /* already gone */
          }
        }, o.timeoutMs ?? 20_000);
        child.on('close', (c) => {
          clearTimeout(timer);
          resolve(c);
        });
      });
      lastLog = readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
      return { code, stdout, stderr };
    },
    log: () => lastLog.filter((l) => !QUERY.test(l)),
    rawLog: () => [...lastLog],
    read(p: string) {
      const f = join(home, p);
      return existsSync(f) ? readFileSync(f, 'utf8') : null;
    },
    cleanup() {
      for (const p of [usr, join(usr, 'bin'), join(usr, 'lib/node_modules')]) if (existsSync(p)) chmodSync(p, 0o755);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
