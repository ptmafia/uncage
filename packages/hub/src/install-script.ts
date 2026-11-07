/** npm version ranges accepted for `cliVersionRange` (no shell metacharacters can get through). */
const RANGE = /^(latest|next|[\^~]?\d+(\.\d+){0,2}(-[0-9A-Za-z.]+)?)$/;

export function assertVersionRange(range: string): string {
  if (!RANGE.test(range)) throw new Error(`createHub: invalid cliVersionRange "${range}" (use e.g. ^0.2, ~0.2.1, 0.2.0 or latest)`);
  return range;
}

/** `^<major>.<minor>` of a version: `0.2.3` → `^0.2`. */
export function defaultCliRange(version: string): string {
  const m = /^(\d+)\.(\d+)/.exec(version);
  return m ? `^${m[1]}.${m[2]}` : 'latest';
}

/**
 * The installer served at `<basePath>/install.sh`. Fixed content: the only variable part is the
 * validated CLI version range. It never runs anything the website sends at run time.
 */
export function installScript(range: string): string {
  const r = assertVersionRange(range);
  return `#!/usr/bin/env bash
# Uncage installer: installs the Uncage CLI (@uncage/cli@${r}) so this computer can connect to a website.
# Review this script before running it. It does not download or run anything else.
set -euo pipefail

say() { printf '%s\\n' "$*"; }
fail() { printf 'uncage: %s\\n' "$*" >&2; exit 1; }

if [ "$(uname -s)" != "Darwin" ]; then
  fail "Uncage currently supports macOS only (this is $(uname -s))."
fi

if ! command -v node >/dev/null 2>&1; then
  fail "Node.js 22 or newer is required. Install it from https://nodejs.org (or: brew install node), then re-run this script."
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  fail "Node.js 22 or newer is required (found $(node -v)). Upgrade from https://nodejs.org (or: brew upgrade node), then re-run this script."
fi

if ! command -v npm >/dev/null 2>&1; then
  fail "npm was not found. Reinstall Node.js from https://nodejs.org, then re-run this script."
fi

if ! command -v claude >/dev/null 2>&1; then
  say "Claude Code was not found. Install it, then sign in, before your first run:"
  say "  npm install -g @anthropic-ai/claude-code && claude"
fi

say "Installing @uncage/cli@${r} ..."
if ! npm install -g "@uncage/cli@${r}"; then
  fail "npm install failed. If it was a permissions error, configure an npm prefix you own (https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally) and re-run."
fi

say ""
say "Uncage CLI installed: $(uncage --version 2>/dev/null || echo unknown)"
say "Next step: run the setup command shown on the website, e.g.  uncage setup <website-url>"
`;
}
