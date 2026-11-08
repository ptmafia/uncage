#!/bin/bash
# The Linux full chain, run as a normal user on a computer without Node. Prints `CHAIN <step>`
# markers that linux-chain.docker.test.ts reads; the test approves the device code it prints
# (`CHAIN code XXXX-XXXX`) through the hub's published port.
set -euo pipefail
HUB=http://127.0.0.1:3000
API=$HUB/api/uncage
mark() { printf 'CHAIN %s\n' "$*"; }
die() { printf 'CHAIN FAIL %s\n' "$*"; exit 1; }
json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const v=JSON.parse(s);console.log($1)})"; }

for _ in $(seq 1 240); do curl -fsS "$API/install.sh" -o /dev/null 2> /dev/null && break; sleep 0.5; done
if command -v node > /dev/null; then die "node already on PATH"; fi
mark "no node, hub reachable"

# 1. The one command, as the website shows it (non-interactive: --yes; the CLI from the local tarball).
set +e
curl -fsSL "$API/install.sh" | UNCAGE_CLI_SPEC=/pkgs/uncage-cli.tgz bash -s -- --yes --no-setup
code=$?
set -e
[ "$code" = 0 ] || die "install.sh exited $code"
NODE="$(find "$HOME" -path '*node-versions/v22*/installation/bin/node' -type f 2> /dev/null | head -1)"
[ -n "$NODE" ] || die "no fnm Node 22 under $HOME"
export PATH="$(dirname "$NODE"):$PATH"
UNCAGE="$(command -v uncage)" || die "uncage not on the Node 22 prefix"
mark "installed node $("$NODE" --version) at $NODE; uncage at $UNCAGE"
grep -q 'uncage >>>' "$HOME/.bashrc" && mark "PATH block in .bashrc"

ver="$(uncage --version)"
[ "$(printf '%s\n' "$ver" | sed -n 2p)" = "node $("$NODE" --version) ($NODE)" ] || die "--version line 2: $ver"
mark "version $(printf '%s' "$ver" | tr '\n' '|')"

# 2. setup with device approval (the test approves the code).
uncage setup "$HUB" --no-browser --no-daemon > /tmp/setup.log 2>&1 &
setup_pid=$!
user_code=''
for _ in $(seq 1 120); do
  user_code="$(grep -oE 'code:[[:space:]]+[A-Z0-9]{4}-[A-Z0-9]{4}' /tmp/setup.log | grep -oE '[A-Z0-9]{4}-[A-Z0-9]{4}' | head -1 || true)"
  [ -n "$user_code" ] && break
  sleep 0.5
done
[ -n "$user_code" ] || { cat /tmp/setup.log; die "no device code"; }
mark "code $user_code"
wait "$setup_pid" || { cat /tmp/setup.log; die "setup failed"; }
grep -q 'Connected to' /tmp/setup.log || die "setup did not connect"
mark "setup connected"

# 3. The agent online, a codex run (testkit fake app-server behind `codex` on PATH).
uncage agent --log-file /tmp/agent.log &
agent_pid=$!
online=''
for _ in $(seq 1 120); do
  online="$(curl -fsS -H 'x-user: u1' "$API/machines" | json "v.some(m=>m.online)" || true)"
  [ "$online" = true ] && break
  sleep 0.5
done
[ "$online" = true ] || { cat /tmp/agent.log; die "agent never came online"; }
runtimes="$(curl -fsS -H 'x-user: u1' "$API/machines" | json "v[0].runtimes.map(r=>r.id+':'+r.status).join(',')")"
mark "agent online ($runtimes)"
session="$(curl -fsS -X POST -H 'x-user: u1' -H 'content-type: application/json' -d '{"runtime":"codex"}' "$API/sessions" | json "v.id")"
curl -fsS -X POST -H 'x-user: u1' -H 'content-type: application/json' -H 'idempotency-key: chain-1' \
  -d '{"prompt":"simple hello from the chain"}' "$API/sessions/$session/runs" > /dev/null
result=''
for _ in $(seq 1 120); do
  result="$(curl -fsS -H 'x-user: u1' -H 'accept: application/json' "$API/sessions/$session/events?after=0" |
    json "(v.find(e=>e.type==='run.completed'||e.type==='run.failed')||{}).type+'|'+v.filter(e=>e.type==='message.completed').map(e=>e.payload.text).join(' ')" || true)"
  case "$result" in run.*) break ;; esac
  sleep 0.5
done
mark "run $result"
case "$result" in "run.completed|Hello from fake Codex.") ;; *) cat /tmp/agent.log; die "codex run: $result" ;; esac
kill "$agent_pid" 2> /dev/null || true
wait "$agent_pid" 2> /dev/null || true

# 4. No user systemd in this container: install falls back to the foreground, with the hint.
out="$(uncage agent install 2>&1)" || die "agent install exited $?: $out"
printf '%s\n' "$out"
case "$out" in *"Run it in the foreground"*) mark "agent install: foreground fallback" ;; *) die "agent install: $out" ;; esac
uncage agent status
mark OK
