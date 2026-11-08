#!/usr/bin/env bash
# Uncage installer for macOS and Linux. It connects this computer to @@SITE_URL@@.
#
#   curl -fsSL <site>/api/uncage/install.sh | bash               # asks [Y/n] before every change
#   curl -fsSL <site>/api/uncage/install.sh | bash -s -- --yes   # confirms every install step
#
# What it does, in order: checks this computer; installs Node.js 22 when it is missing or too old
# (with your own version manager when you have one: nvm, fnm, mise, asdf, volta or n; otherwise
# Homebrew on macOS, else fnm in your home folder) without changing your default Node.js unless you
# say Y; moves npm's global folder to ~/.npm-global when it is not writable; installs the CLI with
#   npm install -g "@uncage/cli@@@CLI_RANGE@@"
# finds the AI coding agents you already have; and offers to run `uncage setup`.
# It never uses sudo, never runs a system package manager and never asks for admin rights.
# Options: --yes (-y), --no-setup, --lang en|zh|ja, --help. Env: UNCAGE_YES=1, UNCAGE_NO_SETUP=1,
# UNCAGE_LANG. Exit codes: 0 done, 1 a step failed, 2 needs a terminal to confirm, 3 unsupported.
# The whole script is functions; nothing runs until the last line, so a cut-off download does nothing.
set -euo pipefail

uncage_config() {
  CLI_RANGE='@@CLI_RANGE@@'
  CLI_SPEC='@uncage/cli@@@CLI_RANGE@@'
  SITE_URL='@@SITE_URL@@'
  NODE_MAJOR=22
  FNM_INSTALL_URL='https://fnm.vercel.app/install'
  NODE_DOWNLOAD_URL='https://nodejs.org/en/download'
  OWN_FNM_DIR="$HOME/.local/share/fnm"
  NPM_GLOBAL="$HOME/.npm-global"
  BLOCK_START='# >>> uncage >>>'
  BLOCK_END='# <<< uncage <<<'
}

# @@MESSAGES@@

# @@EXTENSION@@

# ---- output -----------------------------------------------------------------------------------

say() {
  uncage_msg "$1"
  shift
  # shellcheck disable=SC2059 # the format comes from the message table
  printf -- "$M\n" "$@"
}

warn() {
  uncage_msg "$1"
  shift
  # shellcheck disable=SC2059
  printf -- "$M\n" "$@" >&2
}

# Prints each line of $1 indented (a manual command to run).
cmd_line() {
  local l
  while IFS= read -r l; do printf '    %s\n' "$l"; done <<CMDS
$1
CMDS
}
cmd_line_err() { cmd_line "$1" >&2; }

# A step failed: the reason, the commands to run by hand, exit 1.
fail_step() {
  local what=$1
  shift
  warn step_failed "$what"
  if [ $# -gt 0 ]; then
    warn manual_fix
    local c
    for c in "$@"; do cmd_line_err "$c"; done
  fi
  exit 1
}

# ---- arguments, language, terminal ------------------------------------------------------------

is_true() {
  case "${1:-}" in 1 | true | TRUE | yes | YES | y | Y) return 0 ;; *) return 1 ;; esac
}

parse_args() {
  YES=0
  NO_SETUP=0
  SHOW_HELP=0
  UNKNOWN_OPT=''
  LANG_OPT="${UNCAGE_LANG:-}"
  if is_true "${UNCAGE_YES:-}"; then YES=1; fi
  if is_true "${UNCAGE_NO_SETUP:-}"; then NO_SETUP=1; fi
  while [ $# -gt 0 ]; do
    case "$1" in
      -y | --yes) YES=1 ;;
      --no-setup) NO_SETUP=1 ;;
      --lang)
        shift
        LANG_OPT="${1:-}"
        ;;
      --lang=*) LANG_OPT="${1#--lang=}" ;;
      -h | --help) SHOW_HELP=1 ;;
      *) if [ -z "$UNKNOWN_OPT" ]; then UNKNOWN_OPT="$1"; fi ;;
    esac
    [ $# -gt 0 ] && shift
  done
}

# --lang > UNCAGE_LANG > LC_ALL / LC_MESSAGES / LANG (zh*, ja*) > en
pick_lang() {
  local l="$LANG_OPT"
  if [ -z "$l" ]; then l="${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}"; fi
  case "$l" in
    zh*) UL=zh ;;
    ja*) UL=ja ;;
    *) UL=en ;;
  esac
}

# Answers come from the terminal (stdin is this script under `curl | bash`). UNCAGE_TTY is a test hook.
tty_available() {
  [ "$TTY_OPEN" = 1 ] && return 0
  { : <"$UNCAGE_TTY_PATH"; } 2>/dev/null
}

open_tty() {
  [ "$TTY_OPEN" = 1 ] && return 0
  if tty_available; then
    exec 3<"$UNCAGE_TTY_PATH"
    TTY_OPEN=1
    return 0
  fi
  return 1
}

# ask <message key> [args...]: 0 for yes. An empty answer is yes; end of input is no.
ask() {
  local key=$1
  shift
  uncage_msg "$key"
  # shellcheck disable=SC2059
  printf -- "$M [Y/n] " "$@"
  if [ "$YES" = 1 ]; then
    printf 'Y (--yes)\n'
    return 0
  fi
  if ! open_tty; then
    printf '\n'
    return 1
  fi
  local ans=''
  if ! IFS= read -r ans <&3; then
    printf '\n'
    return 1
  fi
  case "$ans" in
    '' | y | Y | yes | Yes | YES) return 0 ;;
    *) return 1 ;;
  esac
}

# ---- small helpers ----------------------------------------------------------------------------

find_cmd() { command -v "$1" 2>/dev/null || true; }

is_number() {
  case "${1:-}" in '' | *[!0-9]*) return 1 ;; *) return 0 ;; esac
}

dirname_of() {
  local p=$1
  case "$p" in */*) p="${p%/*}" ;; *) p=. ;; esac
  [ -z "$p" ] && p=/
  printf '%s' "$p"
}

# True when $1 (or its nearest existing parent) is writable.
dir_writable() {
  local d=$1
  while [ ! -e "$d" ]; do
    local up=''
    up="$(dirname_of "$d")"
    [ "$up" = "$d" ] && return 1
    d=$up
  done
  [ -w "$d" ]
}

# Paths under $HOME are written as "$HOME/…" in shell profiles.
home_rel() {
  case "$1" in
    "$HOME"/*) printf '%s' "\$HOME/${1#"$HOME"/}" ;;
    *) printf '%s' "$1" ;;
  esac
}

safe_path() {
  case "$1" in *[\"\$\`\\]*) return 1 ;; *) return 0 ;; esac
}

# Runs a command with the chosen Node first on PATH (npm and uncage start with `env node`).
with_node() { PATH="$NODE_BIN:$PATH" "$@" 3<&-; }

semver_of() {
  local re='([0-9]+)\.([0-9]+)\.([0-9]+)'
  if [[ "$1" =~ $re ]]; then
    printf '%s.%s.%s' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}"
  fi
}

# Does installed version $1 satisfy the major.minor of CLI_RANGE?
range_ok() {
  local v=$1 r="$CLI_RANGE" op=''
  case "$r" in latest | next) return 0 ;; esac
  case "$r" in
    ^*) op='^' r="${r#^}" ;;
    '~'*) op='~' r="${r#\~}" ;;
  esac
  local rmaj="${r%%.*}" rest='' rmin=''
  rest="${r#"$rmaj"}"
  rest="${rest#.}"
  rmin="${rest%%.*}"
  rmin="${rmin%%-*}"
  local vmaj="${v%%.*}" vrest='' vmin=''
  vrest="${v#*.}"
  vmin="${vrest%%.*}"
  if ! is_number "$rmaj" || ! is_number "$vmaj" || ! is_number "$vmin"; then return 1; fi
  [ "$vmaj" -eq "$rmaj" ] || return 1
  is_number "$rmin" || return 0
  if [ "$op" = '^' ] && [ "$rmaj" -gt 0 ]; then
    [ "$vmin" -ge "$rmin" ]
  else
    [ "$vmin" -eq "$rmin" ]
  fi
}

# ---- step 1: checks ---------------------------------------------------------------------------

detect_platform() {
  OS_RAW="$(uname -s 2>/dev/null || true)"
  ARCH_RAW="$(uname -m 2>/dev/null || true)"
  case "$OS_RAW" in
    Darwin) OS=macos OS_NAME=macOS ;;
    Linux) OS=linux OS_NAME=Linux ;;
    *) OS='' OS_NAME="$OS_RAW" ;;
  esac
  case "$ARCH_RAW" in
    x86_64 | amd64) ARCH=x64 ;;
    arm64 | aarch64) ARCH=arm64 ;;
    *) ARCH='' ;;
  esac
  if [ -z "$OS" ] || [ -z "$ARCH" ]; then
    warn os_unsupported "$OS_RAW" "$ARCH_RAW"
    exit 3
  fi
}

# Sets NODE_VER for the node binary $1 ('' when it does not run).
node_version() {
  local out=''
  out="$("$1" --version 2>/dev/null </dev/null 3<&- || true)"
  NODE_VER="$(semver_of "$out")"
}

node_major_ok() {
  local major="${1%%.*}"
  is_number "$major" && [ "$major" -ge "$NODE_MAJOR" ]
}

# Uses node $1: sets NODE, NODE_BIN, NPM, NPM_PREFIX, NPM_WRITABLE.
use_node() {
  NODE=$1
  NODE_BIN="$(dirname_of "$NODE")"
  NPM=''
  if [ -x "$NODE_BIN/npm" ]; then NPM="$NODE_BIN/npm"; else NPM="$(find_cmd npm)"; fi
  NPM_VER=''
  NPM_PREFIX=''
  NPM_WRITABLE=0
  [ -n "$NPM" ] || return 0
  NPM_VER="$(with_node "$NPM" --version 2>/dev/null </dev/null 3<&- || true)"
  NPM_PREFIX="$(with_node "$NPM" config get prefix 2>/dev/null </dev/null 3<&- || true)"
  if [ -n "$NPM_PREFIX" ] && dir_writable "$NPM_PREFIX/lib/node_modules" && dir_writable "$NPM_PREFIX/bin"; then
    NPM_WRITABLE=1
  fi
}

# Sets UNCAGE (absolute path or '') and CLI_VER for the chosen npm prefix.
detect_cli() {
  UNCAGE=''
  CLI_VER=''
  local c=''
  if [ -n "$NPM_PREFIX" ] && [ -x "$NPM_PREFIX/bin/uncage" ]; then
    c="$NPM_PREFIX/bin/uncage"
  else
    c="$(find_cmd uncage)"
  fi
  [ -n "$c" ] || return 0
  UNCAGE=$c
  local out=''
  out="$(with_node "$UNCAGE" --version 2>/dev/null </dev/null 3<&- || true)"
  CLI_VER="$(semver_of "$out")"
}

cli_ok() { [ -n "$UNCAGE" ] && [ -n "$CLI_VER" ] && range_ok "$CLI_VER"; }

detect_agents() {
  CLAUDE="$(find_cmd claude)"
  if [ -z "$CLAUDE" ]; then
    local p
    for p in "$HOME/.local/bin/claude" "$HOME/.claude/local/claude"; do
      if [ -x "$p" ]; then CLAUDE=$p && break; fi
    done
  fi
  CODEX="$(find_cmd codex)"
}

# Version managers, in order of preference. Only PATH and $HOME are searched.
detect_manager() {
  MGR=''
  MGR_LABEL=''
  FNM=''
  FNM_OWN=0
  NVM_SH=''
  BREW="$(find_cmd brew)"
  local nvm_dir="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$nvm_dir/nvm.sh" ]; then
    NVM_SH="$nvm_dir/nvm.sh"
  elif [ -n "$BREW" ]; then
    local bp=''
    bp="$("$BREW" --prefix 2>/dev/null </dev/null 3<&- || true)"
    if [ -n "$bp" ] && [ -s "$bp/opt/nvm/nvm.sh" ]; then NVM_SH="$bp/opt/nvm/nvm.sh"; fi
  fi
  if [ -n "$NVM_SH" ]; then
    MGR=nvm MGR_LABEL=nvm
    export NVM_DIR="$nvm_dir"
    return 0
  fi
  FNM="$(find_cmd fnm)"
  if [ -z "$FNM" ] && [ -x "$OWN_FNM_DIR/fnm" ]; then
    FNM="$OWN_FNM_DIR/fnm"
    FNM_OWN=1
    export FNM_DIR="$OWN_FNM_DIR"
  fi
  if [ -n "$FNM" ]; then
    MGR=fnm MGR_LABEL=fnm
    return 0
  fi
  MISE="$(find_cmd mise)"
  if [ -z "$MISE" ] && [ -x "$HOME/.local/bin/mise" ]; then MISE="$HOME/.local/bin/mise"; fi
  if [ -n "$MISE" ]; then
    MGR=mise MGR_LABEL=mise
    return 0
  fi
  ASDF="$(find_cmd asdf)"
  if [ -n "$ASDF" ]; then
    MGR=asdf MGR_LABEL=asdf
    return 0
  fi
  # volta is unmaintained: an existing install is used, never installed by this script.
  VOLTA="$(find_cmd volta)"
  if [ -z "$VOLTA" ] && [ -x "${VOLTA_HOME:-$HOME/.volta}/bin/volta" ]; then VOLTA="${VOLTA_HOME:-$HOME/.volta}/bin/volta"; fi
  if [ -n "$VOLTA" ]; then
    MGR=volta MGR_LABEL=volta
    return 0
  fi
  # n installs into N_PREFIX (default /usr/local); only used when that needs no admin rights.
  N_CMD="$(find_cmd n)"
  if [ -n "$N_CMD" ] && dir_writable "${N_PREFIX:-/usr/local}/n/versions"; then
    MGR=n MGR_LABEL=n
    return 0
  fi
}

detect() {
  detect_platform
  PATH_NODE="$(find_cmd node)"
  PATH_NODE_VER=''
  NODE_OK=0
  NODE=''
  NODE_BIN=''
  NPM=''
  NPM_VER=''
  NPM_PREFIX=''
  NPM_WRITABLE=0
  UNCAGE=''
  CLI_VER=''
  NODE_IS_DEFAULT=1
  INSTALLED_NOW=0
  HAD_DEFAULT=1
  if [ -n "$PATH_NODE" ]; then
    node_version "$PATH_NODE"
    PATH_NODE_VER=$NODE_VER
    if node_major_ok "$PATH_NODE_VER"; then
      use_node "$PATH_NODE"
      [ -n "$NPM" ] && NODE_OK=1
    fi
  fi
  if [ "$NODE_OK" = 1 ]; then detect_cli; fi
  detect_agents
  detect_manager
}

print_checks() {
  say checking
  say os_ok "$OS_NAME" "$ARCH"
  if [ "$NODE_OK" = 1 ]; then
    say node_ok "$PATH_NODE_VER" "$PATH_NODE"
    if [ "$NPM_WRITABLE" = 1 ]; then
      say npm_ok "$NPM_VER" "$NPM_PREFIX"
    else
      say npm_not_writable "$NPM_VER" "$NPM_PREFIX"
    fi
    if cli_ok; then
      say cli_ok "$CLI_VER" "$UNCAGE"
    elif [ -n "$UNCAGE" ]; then
      say cli_old "${CLI_VER:-?}" "$CLI_RANGE"
    else
      say cli_missing
    fi
  else
    if [ -z "$PATH_NODE" ] || [ -z "$PATH_NODE_VER" ]; then
      say node_missing
    elif ! node_major_ok "$PATH_NODE_VER"; then
      say node_old "$PATH_NODE_VER"
    else
      say npm_missing
    fi
    say later
  fi
  if [ -n "$CLAUDE" ]; then say agent_ok 'Claude Code' "$CLAUDE"; else say agent_missing 'Claude Code'; fi
  if [ -n "$CODEX" ]; then say agent_ok 'Codex' "$CODEX"; else say agent_missing 'Codex'; fi
  printf '\n'
}

# ---- manual commands (no terminal, or a declined / failed step) -------------------------------

node_manual_cmds() {
  case "$MGR" in
    nvm) printf '%s\n' "nvm install $NODE_MAJOR" ;;
    fnm) printf '%s\n' "fnm install $NODE_MAJOR" ;;
    mise) printf '%s\n' "mise install node@$NODE_MAJOR" ;;
    asdf) printf '%s\n' "asdf install nodejs latest:$NODE_MAJOR" ;;
    volta) printf '%s\n' "volta install node@$NODE_MAJOR" ;;
    n) printf '%s\n' "n $NODE_MAJOR" ;;
    *)
      if [ "$OS" = macos ] && [ -n "$BREW" ]; then
        printf '%s\n' "brew install node@$NODE_MAJOR"
      else
        printf '%s\n' "curl -fsSL $FNM_INSTALL_URL | bash" "fnm install $NODE_MAJOR"
      fi
      ;;
  esac
}

print_cmds() {
  local line
  while IFS= read -r line; do cmd_line "$line"; done
}

# No terminal and no --yes: list what is missing and how to do it by hand; change nothing.
gate_without_terminal() {
  local need=0
  [ "$NODE_OK" = 1 ] || need=1
  if [ "$NODE_OK" = 1 ]; then
    [ "$NPM_WRITABLE" = 1 ] || need=1
    cli_ok || need=1
  fi
  [ "$need" = 1 ] || return 0
  [ "$YES" = 1 ] && return 0
  tty_available && return 0
  say needs_confirm
  if [ "$NODE_OK" != 1 ]; then
    say item_node
    node_manual_cmds | print_cmds
  fi
  if [ "$NODE_OK" = 1 ] && [ "$NPM_WRITABLE" != 1 ]; then
    say item_npm
    cmd_line "npm config set prefix \"\$HOME/.npm-global\""
    cmd_line "export PATH=\"\$HOME/.npm-global/bin:\$PATH\""
  fi
  if [ "$NODE_OK" != 1 ] || ! cli_ok; then
    say item_cli "$CLI_SPEC"
    cmd_line "npm install -g \"$CLI_SPEC\""
  fi
  say item_setup
  cmd_line "uncage setup $SITE_URL"
  say rerun_yes
  exit 2
}

# ---- shell profile: one marked block, rewritten in place ---------------------------------------

profile_file() {
  case "${SHELL##*/}" in
    zsh) printf '%s' "${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash) if [ "$OS" = macos ]; then printf '%s' "$HOME/.bash_profile"; else printf '%s' "$HOME/.bashrc"; fi ;;
    fish) printf '' ;;
    *) printf '%s' "$HOME/.profile" ;;
  esac
}

# add_profile_lines <line>...: merges the lines into the uncage block (each line once).
add_profile_lines() {
  local file=''
  file="$(profile_file)"
  local l
  if [ -z "$file" ]; then
    say path_fish
    for l in "$@"; do cmd_line "$l"; done
    return 0
  fi
  local nl=$'\n' before='' block='' after='' state=0 line=''
  if [ -f "$file" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      case "$state:$line" in
        "0:$BLOCK_START") state=1 ;;
        "1:$BLOCK_END") state=2 ;;
        0:*) before="$before$line$nl" ;;
        1:*) block="$block$line$nl" ;;
        *) after="$after$line$nl" ;;
      esac
    done <"$file"
  fi
  for l in "$@"; do
    case "$nl$block" in
      *"$nl$l$nl"*) ;;
      *) block="$block$l$nl" ;;
    esac
  done
  if [ "$state" = 0 ] && [ -n "$before" ]; then before="$before$nl"; fi
  mkdir -p "$(dirname_of "$file")"
  # The whole new content goes to a temp file first, then `cat` rewrites the same file (a
  # symlinked profile stays a symlink, and an interrupted write never leaves it half-written).
  local tmpf="$file.uncage-tmp.$$"
  printf '%s%s\n%s%s\n%s' "$before" "$BLOCK_START" "$block" "$BLOCK_END" "$after" >"$tmpf"
  cat "$tmpf" >"$file"
  rm -f "$tmpf"
  say path_added "$file"
}

path_line() {
  local d=''
  d="$(home_rel "$1")"
  # shellcheck disable=SC2016 # $PATH is expanded by the shell profile, not here
  printf 'export PATH="%s:$PATH"' "$d"
}

# ---- step 2: Node.js 22 -----------------------------------------------------------------------

nvm_run() {
  mkdir -p "$NVM_DIR"
  set +euo pipefail
  # shellcheck disable=SC1090
  . "$NVM_SH" --no-use
  nvm "$@"
  local rc=$?
  set -euo pipefail
  return $rc
}

# nvm and fnm make the first version they install the default by themselves. The alias file
# tells whether a default existed before this run.
fnm_dir() {
  if [ -n "${FNM_DIR:-}" ]; then
    printf '%s' "$FNM_DIR"
  elif [ -d "$HOME/.fnm" ]; then
    printf '%s' "$HOME/.fnm"
  elif [ -n "${XDG_DATA_HOME:-}" ]; then
    printf '%s' "$XDG_DATA_HOME/fnm"
  elif [ "$OS" = macos ]; then
    printf '%s' "$HOME/Library/Application Support/fnm"
  else
    printf '%s' "$HOME/.local/share/fnm"
  fi
}

has_default_alias() {
  local a=''
  case "$MGR" in
    nvm) a="$NVM_DIR/alias/default" ;;
    fnm) a="$(fnm_dir)/aliases/default" ;;
    *) return 0 ;;
  esac
  [ -e "$a" ] || [ -L "$a" ]
}

# Call right before installing Node with the manager.
record_default() {
  INSTALLED_NOW=1
  HAD_DEFAULT=1
  if ! has_default_alias; then HAD_DEFAULT=0; fi
}

# The user kept their default: undo the default nvm / fnm created by themselves.
restore_default() {
  if [ "$INSTALLED_NOW" != 1 ] || [ "$HAD_DEFAULT" != 0 ] || ! has_default_alias; then return 0; fi
  local how=unalias
  [ -n "$PATH_NODE" ] && how=system
  case "$MGR:$how" in
    nvm:system) nvm_run alias default system </dev/null 3<&- || fail_step "nvm alias default system" "nvm alias default system" ;;
    nvm:unalias) nvm_run unalias default </dev/null 3<&- || fail_step "nvm unalias default" "nvm unalias default" ;;
    fnm:system) "$FNM" default system </dev/null 3<&- || fail_step "fnm default system" "fnm default system" ;;
    fnm:unalias) "$FNM" unalias default </dev/null 3<&- || fail_step "fnm unalias default" "fnm unalias default" ;;
    *) return 0 ;;
  esac
  say default_restored "$MGR_LABEL"
}

mgr_install() {
  record_default
  case "$MGR" in
    nvm) nvm_run install "$NODE_MAJOR" </dev/null 3<&- ;;
    fnm) "$FNM" install "$NODE_MAJOR" </dev/null 3<&- ;;
    mise) "$MISE" install "node@$NODE_MAJOR" </dev/null 3<&- ;;
    asdf)
      local plugins=''
      plugins="$("$ASDF" plugin list 2>/dev/null </dev/null 3<&- || true)"
      case $'\n'"$plugins"$'\n' in
        *$'\n'nodejs$'\n'*) ;;
        *) "$ASDF" plugin add nodejs </dev/null 3<&- ;;
      esac
      "$ASDF" install nodejs "latest:$NODE_MAJOR" </dev/null 3<&-
      ;;
    # `volta install` would also make it the default: fetch only, `install` after a Y.
    volta) "$VOLTA" fetch "node@$NODE_MAJOR" </dev/null 3<&- ;;
    n) "$N_CMD" download "$NODE_MAJOR" </dev/null 3<&- ;;
  esac
}

# Sets NEW_NODE to the manager's Node 22 binary without activating it.
mgr_node_path() {
  NEW_NODE=''
  local p='' d=''
  case "$MGR" in
    nvm) p="$(nvm_run which "$NODE_MAJOR" 2>/dev/null || true)" ;;
    fnm) p="$("$FNM" exec "--using=$NODE_MAJOR" node -p process.execPath 2>/dev/null </dev/null 3<&- || true)" ;;
    mise)
      d="$("$MISE" where "node@$NODE_MAJOR" 2>/dev/null </dev/null 3<&- || true)"
      [ -n "$d" ] && p="$d/bin/node"
      ;;
    asdf)
      local list='' line=''
      ASDF_VER=''
      list="$("$ASDF" list nodejs "$NODE_MAJOR" 2>/dev/null </dev/null 3<&- || true)"
      while IFS= read -r line; do
        line="${line//[ *]/}"
        case "$line" in "$NODE_MAJOR".*) ASDF_VER=$line ;; esac
      done <<EOF
$list
EOF
      if [ -n "$ASDF_VER" ]; then
        d="$("$ASDF" where nodejs "$ASDF_VER" 2>/dev/null </dev/null 3<&- || true)"
        [ -n "$d" ] && p="$d/bin/node"
      fi
      ;;
    volta) p="$("$VOLTA" run --node "$NODE_MAJOR" node -p process.execPath 2>/dev/null </dev/null 3<&- || true)" ;;
    n) p="$("$N_CMD" which "$NODE_MAJOR" 2>/dev/null </dev/null 3<&- || true)" ;;
  esac
  p="${p%%$'\n'*}"
  if [ -n "$p" ] && [ -x "$p" ]; then
    node_version "$p"
    if node_major_ok "$NODE_VER"; then NEW_NODE=$p; fi
  fi
  [ -n "$NEW_NODE" ]
}

mgr_make_default() {
  case "$MGR" in
    nvm) nvm_run alias default "$NODE_MAJOR" </dev/null 3<&- ;;
    fnm)
      "$FNM" default "$NODE_MAJOR" </dev/null 3<&-
      if [ "$FNM_OWN" = 1 ]; then own_fnm_profile; fi
      ;;
    mise) "$MISE" use -g "node@$NODE_MAJOR" </dev/null 3<&- ;;
    asdf) "$ASDF" set -u nodejs "$ASDF_VER" </dev/null 3<&- || "$ASDF" global nodejs "$ASDF_VER" </dev/null 3<&- ;;
    volta) "$VOLTA" install "node@$NODE_MAJOR" </dev/null 3<&- ;;
    n) "$N_CMD" "$NODE_MAJOR" </dev/null 3<&- ;;
    brew) add_profile_lines "$(path_line "$NEW_NODE_BIN")" ;;
  esac
}

own_fnm_profile() {
  local d=''
  d="$(home_rel "$OWN_FNM_DIR")"
  if [ "${SHELL##*/}" = fish ]; then
    add_profile_lines "set -gx FNM_DIR \"$d\"" "fish_add_path \"$d\"" 'fnm env --shell fish | source'
    return 0
  fi
  local sh=bash
  [ "${SHELL##*/}" = zsh ] && sh=zsh
  add_profile_lines "export FNM_DIR=\"$d\"" "$(path_line "$OWN_FNM_DIR")" "eval \"\$(fnm env --shell $sh)\""
}

decline_node() {
  say node_required
  node_manual_cmds | print_cmds
  exit 0
}

install_own_fnm() {
  if [ "$OS" = linux ] && [ -z "$(find_cmd unzip)" ]; then
    warn need_unzip
    warn node_manual_other "$NODE_DOWNLOAD_URL"
    cmd_line_err "curl -fsSL $FNM_INSTALL_URL | bash -s -- --install-dir \"\$HOME/.local/share/fnm\" --skip-shell"
    cmd_line_err "\"\$HOME/.local/share/fnm/fnm\" install $NODE_MAJOR"
    exit 1
  fi
  if [ -z "$(find_cmd curl)" ]; then
    warn need_curl
    warn node_manual_other "$NODE_DOWNLOAD_URL"
    exit 1
  fi
  ask ask_node_fnm "$(home_rel "$OWN_FNM_DIR")" || decline_node
  UNCAGE_TMP="$(mktemp -d "${TMPDIR:-/tmp}/uncage-install.XXXXXX")"
  trap 'rm -rf "$UNCAGE_TMP"' EXIT
  local tmp="$UNCAGE_TMP"
  # Downloaded to a file first: a cut-off download never runs half a script.
  curl --proto '=https' --tlsv1.2 -fsSL "$FNM_INSTALL_URL" -o "$tmp/fnm-installer" </dev/null 3<&- ||
    fail_step "curl $FNM_INSTALL_URL" "curl -fsSL $FNM_INSTALL_URL | bash -s -- --install-dir \"\$HOME/.local/share/fnm\" --skip-shell --force-no-brew"
  bash "$tmp/fnm-installer" --install-dir "$OWN_FNM_DIR" --skip-shell --force-no-brew </dev/null 3<&- ||
    fail_step "fnm install" "curl -fsSL $FNM_INSTALL_URL | bash -s -- --install-dir \"\$HOME/.local/share/fnm\" --skip-shell --force-no-brew"
  rm -rf "$tmp"
  trap - EXIT
  [ -x "$OWN_FNM_DIR/fnm" ] || fail_step "fnm install" "curl -fsSL $FNM_INSTALL_URL | bash"
  MGR=fnm MGR_LABEL=fnm FNM="$OWN_FNM_DIR/fnm" FNM_OWN=1
  export FNM_DIR="$OWN_FNM_DIR"
  record_default
  "$FNM" install "$NODE_MAJOR" </dev/null 3<&- || fail_step "fnm install $NODE_MAJOR" "\"\$HOME/.local/share/fnm/fnm\" install $NODE_MAJOR"
}

step_node() {
  [ "$NODE_OK" = 1 ] && return 0
  NEW_NODE=''
  if [ -n "$MGR" ]; then
    if mgr_node_path; then
      say node_found_mgr "$MGR_LABEL" "$NEW_NODE"
    else
      ask ask_node_mgr "$MGR_LABEL" || decline_node
      mgr_install || fail_step "$MGR_LABEL install" "$(node_manual_cmds)"
      mgr_node_path || fail_step "$MGR_LABEL install" "$(node_manual_cmds)"
      say node_installed "$NODE_VER" "$NEW_NODE"
    fi
  elif [ "$OS" = macos ] && [ -n "$BREW" ]; then
    MGR=brew MGR_LABEL=Homebrew
    local bp=''
    bp="$("$BREW" --prefix 2>/dev/null </dev/null 3<&- || true)"
    local keg="$bp/opt/node@$NODE_MAJOR/bin/node"
    if [ -n "$bp" ] && [ -x "$keg" ]; then
      say node_found_mgr Homebrew "$keg"
    else
      ask ask_node_brew || decline_node
      "$BREW" install "node@$NODE_MAJOR" </dev/null 3<&- || fail_step "brew install node@$NODE_MAJOR" "brew install node@$NODE_MAJOR"
      [ -x "$keg" ] || fail_step "brew install node@$NODE_MAJOR" "brew install node@$NODE_MAJOR"
    fi
    node_version "$keg"
    NEW_NODE=$keg
    say node_installed "$NODE_VER" "$NEW_NODE"
  else
    install_own_fnm
    mgr_node_path || fail_step "fnm install $NODE_MAJOR" "\"\$HOME/.local/share/fnm/fnm\" install $NODE_MAJOR"
    say node_installed "$NODE_VER" "$NEW_NODE"
  fi
  NEW_NODE_BIN="$(dirname_of "$NEW_NODE")"
  if [ "$MGR" = brew ] && ! safe_path "$NEW_NODE_BIN"; then MGR=brew-manual; fi
  # Changing the default needs its own Y. Under --yes only when there was no Node.js at all.
  local make_default=1
  if [ "$YES" = 1 ] && [ -n "$PATH_NODE" ]; then
    make_default=0
    say default_kept_yes
  elif ! ask ask_default; then
    make_default=0
  fi
  if [ "$make_default" = 1 ] && [ "$MGR" != brew-manual ]; then
    mgr_make_default || fail_step "$MGR_LABEL default" "$(node_manual_cmds)"
    say default_done
  else
    NODE_IS_DEFAULT=0
    restore_default
    say default_kept "$NEW_NODE"
  fi
  use_node "$NEW_NODE"
  [ -n "$NPM" ] || fail_step npm "$(node_manual_cmds)"
  NODE_OK=1
  detect_cli
}

# ---- step 3: npm global folder ----------------------------------------------------------------

step_npm_prefix() {
  [ "$NPM_WRITABLE" = 1 ] && return 0
  # nvm refuses to work with a `prefix` in ~/.npmrc: never set one for an nvm Node.
  if [ "$MGR" = nvm ]; then
    case "$NODE" in
      "$NVM_DIR"/*)
        warn nvm_prefix "$NPM_PREFIX"
        exit 1
        ;;
    esac
  fi
  if ! ask ask_npm_prefix "$NPM_PREFIX" "$(home_rel "$NPM_GLOBAL")"; then
    say declined
    cmd_line "npm config set prefix \"\$HOME/.npm-global\""
    cmd_line "npm install -g \"$CLI_SPEC\""
    exit 0
  fi
  mkdir -p "$NPM_GLOBAL/bin" "$NPM_GLOBAL/lib"
  with_node "$NPM" config set prefix "$NPM_GLOBAL" </dev/null 3<&- || fail_step "npm config set prefix" "npm config set prefix \"\$HOME/.npm-global\""
  NPM_PREFIX="$NPM_GLOBAL"
  NPM_WRITABLE=1
  say npm_prefix_done "$NPM_GLOBAL"
  add_profile_lines "$(path_line "$NPM_GLOBAL/bin")"
  detect_cli
}

# ---- step 4: the Uncage CLI -------------------------------------------------------------------

step_cli() {
  local spec="${UNCAGE_CLI_SPEC:-$CLI_SPEC}"
  if cli_ok; then
    say cli_skip "$CLI_VER" "$UNCAGE"
    return 0
  fi
  if ! ask ask_cli "$spec"; then
    say declined
    cmd_line "npm install -g \"$spec\""
    exit 0
  fi
  with_node "$NPM" install -g "$spec" </dev/null 3<&- || fail_step "npm install -g $spec" "PATH=\"$NODE_BIN:\$PATH\" \"$NPM\" install -g \"$spec\""
  UNCAGE=''
  if [ -x "$NPM_PREFIX/bin/uncage" ]; then UNCAGE="$NPM_PREFIX/bin/uncage"; else UNCAGE="$(find_cmd uncage)"; fi
  [ -n "$UNCAGE" ] || fail_step "npm install -g $spec" "PATH=\"$NODE_BIN:\$PATH\" \"$NPM\" install -g \"$spec\""
  say cli_installed "$UNCAGE"
}

# ---- the site's own step (HubOptions.installScript.shAfterCli) ---------------------------------

run_extension() {
  [ -n "$UNCAGE_EXT" ] || return 0
  say extension_running
  if ! (
    export PATH="$NODE_BIN:$PATH" UNCAGE_BIN="$UNCAGE" UNCAGE_NODE="$NODE" UNCAGE_SITE_URL="$SITE_URL"
    eval "$UNCAGE_EXT"
  ) </dev/null 3<&-; then
    uncage_msg extension_step
    fail_step "$M"
  fi
}

# ---- step 5: agents, then step 6: setup -------------------------------------------------------

# ACP agents count too, once the CLI knows them (`uncage runtimes --json`, when it exists).
acp_available() {
  local out=''
  out="$(with_node "$UNCAGE" runtimes --json 2>/dev/null </dev/null 3<&- || true)"
  local re='"status"[[:space:]]*:[[:space:]]*"available"'
  [[ "$out" =~ $re ]]
}

print_where() {
  if [ "$NODE_IS_DEFAULT" = 1 ]; then
    say uncage_path "\"$UNCAGE\""
  else
    say not_default_hint "$NODE_BIN" "\"$UNCAGE\""
  fi
}

step_setup() {
  if [ -z "$CLAUDE" ] && [ -z "$CODEX" ] && ! acp_available; then
    printf '\n'
    say no_agent
    print_where
    exit 0
  fi
  local setup_cmd="\"$UNCAGE\" setup $SITE_URL"
  if [ "$NODE_IS_DEFAULT" != 1 ]; then setup_cmd="PATH=\"$NODE_BIN:\$PATH\" $setup_cmd"; fi
  if [ "$NO_SETUP" = 1 ]; then
    print_where
    say setup_later "$setup_cmd"
    exit 0
  fi
  if [ "$YES" != 1 ] && ! tty_available; then
    print_where
    say setup_later "$setup_cmd"
    exit 0
  fi
  if ! ask ask_setup "$SITE_URL"; then
    print_where
    say setup_later "$setup_cmd"
    exit 0
  fi
  if [ "$TTY_OPEN" = 1 ]; then
    with_node "$UNCAGE" setup "$SITE_URL" <&3 3<&- || fail_step "uncage setup" "$setup_cmd"
  else
    with_node "$UNCAGE" setup "$SITE_URL" </dev/null 3<&- || fail_step "uncage setup" "$setup_cmd"
  fi
  print_where
  say done
}

main() {
  uncage_config
  uncage_extension
  UNCAGE_TTY_PATH="${UNCAGE_TTY:-/dev/tty}"
  TTY_OPEN=0
  parse_args "$@"
  pick_lang
  if [ "$SHOW_HELP" = 1 ]; then
    say help
    exit 0
  fi
  if [ -n "$UNKNOWN_OPT" ]; then
    warn unknown_option "$UNKNOWN_OPT"
    exit 1
  fi
  detect
  print_checks
  gate_without_terminal
  step_node
  step_npm_prefix
  step_cli
  run_extension
  step_setup
}

main "$@"
