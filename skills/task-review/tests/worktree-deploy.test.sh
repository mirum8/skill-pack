#!/usr/bin/env bash
# Behaviour tests for worktree-deploy.sh — the two things it decides that nothing else re-checks.
#
#   bash skills/task-review/tests/worktree-deploy.test.sh
#
# Nothing here starts a container. Docker and lsof are stubbed on PATH, because what is under test
# is not the deploy: it is (1) the location decision, which the script's whole contract hangs on —
# behaviour is decided by WHERE it runs, never by who calls it — and (2) the compose rewrite that
# makes a worktree stack safe to run beside the main one.
#
# Both fail silently in the same direction. A worktree misread as main deploys onto the main stack's
# port with the main stack's container names, and the UI step then verifies the wrong application
# while reporting success; a rewrite that misses one field lets two concurrent reviews share a
# container, a tag or a database. There is no CI, so this is the only thing standing between an
# edit and that.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
WTD="$PWD/skills/task-review/scripts/worktree-deploy.sh"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0

ok()  { pass=$((pass + 1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }

# The script require_bin's docker and lsof at load time, before any subcommand branches. Stubbing
# them is what lets `mode` be tested at all; neither stub is ever called by `mode`.
STUB="$TMP/stub"; mkdir -p "$STUB"
printf '#!/bin/sh\n[ "$1" = compose ] && [ "$2" = version ] && exit 0\nexit 0\n' > "$STUB/docker"
printf '#!/bin/sh\nexit 1\n' > "$STUB/lsof"
chmod +x "$STUB/docker" "$STUB/lsof"
export PATH="$STUB:$PATH"

echo "== the location decision =="
MAIN="$TMP/main"
mkdir -p "$MAIN" && cd "$MAIN"
git init -q -b main
git config user.email t@example.com; git config user.name test
echo x > f && git add -A && git commit -qm base

got=$(bash "$WTD" mode 2>&1)
[[ "$got" == "main" ]] && ok "the primary working tree reports mode 'main'" \
                       || bad "the primary working tree reports mode 'main'" "got: $got"

git worktree add -q --detach "$TMP/wt" HEAD
cd "$TMP/wt"
got=$(bash "$WTD" mode 2>&1)
[[ "$got" == "worktree" ]] && ok "a linked worktree reports mode 'worktree'" \
                           || bad "a linked worktree reports mode 'worktree'" "got: $got"

cd "$TMP"
got=$(bash "$WTD" mode 2>&1); rc=$?
[[ $rc == 2 ]] && ok "outside a git repo it exits 2 rather than guessing a mode" \
               || bad "outside a git repo it exits 2 rather than guessing a mode" "exit $rc: $got"

echo
echo "== main mode is a pass-through, and teardown there touches nothing =="
cd "$MAIN"
got=$(bash "$WTD" base-url "http://localhost:8080" 2>&1)
[[ "$got" == "http://localhost:8080" ]] && ok "base-url echoes the project default in main" \
                                        || bad "base-url echoes the project default in main" "got: $got"
bash "$WTD" teardown >/dev/null 2>&1
[[ $? == 0 ]] && ok "teardown in main is a no-op that exits 0" \
              || bad "teardown in main is a no-op that exits 0" ""

echo
echo "== the compose rewrite: everything that must be unique per worktree =="
# The rewrite is the embedded python program, extracted from the shipped script so an edit to it
# is an edit to what runs here. Reimplementing it in the test would only assert the test's copy.
python3 - "$WTD" > "$TMP/rewrite.py" <<'PY'
import re, sys
src = open(sys.argv[1]).read()
m = re.search(r"python3 - <<'PY'\n(.*?)\nPY\n", src, re.S)
if not m:
    sys.exit("could not extract the embedded rewrite program from worktree-deploy.sh")
print(m.group(1))
PY

cat > "$TMP/in.json" <<'EOF'
{
  "name": "myapp",
  "services": {
    "app": {
      "build": ".",
      "image": "app:local",
      "container_name": "myapp-app",
      "ports": [{"target": 8080, "published": "8080", "protocol": "tcp", "mode": "ingress"}]
    },
    "db": {
      "image": "postgres:16",
      "container_name": "myapp-db",
      "ports": ["5432:5432"]
    },
    "cache": {"image": "redis:7", "ports": ["6379:6379"]}
  },
  "volumes": {"pgdata": {}, "shared-assets": {"external": true}}
}
EOF

IN="$TMP/in.json" OUT="$TMP/out.json" EXT_VOLS_OUT="$TMP/ext" WT_ID="wt-abc123" \
  python3 "$TMP/rewrite.py" > "$TMP/app-name" 2>"$TMP/rw-err"
rc=$?
if [[ $rc != 0 ]]; then
  bad "the rewrite runs over a representative compose config" "$(cat "$TMP/rw-err")"
else
  ok "the rewrite runs over a representative compose config"

  # says <name> <python expression over `d` (the rewritten config)> <expected>
  says() {
    local got; got=$(python3 -c '
import json,sys
d=json.load(open(sys.argv[1]))
print(eval(sys.argv[2]))' "$TMP/out.json" "$2")
    [[ "$got" == "$3" ]] && ok "$1" || bad "$1" "$2 = $got, wanted $3"
  }

  [[ "$(cat "$TMP/app-name")" == "app" ]] \
    && ok "the app service is detected by its build: section" \
    || bad "the app service is detected by its build: section" "$(cat "$TMP/app-name")"

  says "every container_name is suffixed, so two worktrees never share a container" \
       "d['services']['app']['container_name']" "myapp-app-wt-abc123"
  says "including supporting services" \
       "d['services']['db']['container_name']" "myapp-db-wt-abc123"

  says "a locally-built image gets its own tag, never the shared one" \
       "d['services']['app']['image']" "app:local-wt-abc123"
  says "a pulled image is left alone — it is not this worktree's to retag" \
       "d['services']['db']['image']" "postgres:16"

  # published "0" is what makes this race-free: Docker assigns the port atomically on `up -d` and
  # the script reads it back, so two worktrees cannot check-then-use the same free port.
  says "the app port is republished as 0 for Docker to assign" \
       "d['services']['app']['ports'][0]['published']" "0"
  says "on the same container port" \
       "d['services']['app']['ports'][0]['target']" "8080"

  says "a supporting service's fixed host port is dropped entirely" \
       "d['services']['db']['ports']" "['5432']"
  says "for every supporting service, not just the named ones" \
       "d['services']['cache']['ports']" "['6379']"

  says "the compose project name is dropped so the caller's -p wins" \
       "'name' in d" "False"

  # `down -v` would wipe an external volume that the MAIN stack is also using.
  [[ "$(cat "$TMP/ext")" == "shared-assets" ]] \
    && ok "external volumes are recorded so teardown does not wipe shared data" \
    || bad "external volumes are recorded so teardown does not wipe shared data" "$(cat "$TMP/ext")"
fi

echo
echo "== the rewrite refuses to guess rather than publishing the wrong service =="
cat > "$TMP/nobuild.json" <<'EOF'
{"services": {"db": {"image": "postgres:16", "ports": ["5432:5432"]}}}
EOF
IN="$TMP/nobuild.json" OUT="$TMP/out2.json" EXT_VOLS_OUT="$TMP/ext2" WT_ID="wt-x" \
  python3 "$TMP/rewrite.py" >/dev/null 2>"$TMP/err2"; rc=$?
[[ $rc == 3 ]] && ok "a config with no build: service exits 3 and names APP_SERVICE" \
               || bad "a config with no build: service exits 3 and names APP_SERVICE" "exit $rc"
grep -q "APP_SERVICE" "$TMP/err2" && ok "and says which knob to set" \
                                  || bad "and says which knob to set" "$(cat "$TMP/err2")"

cat > "$TMP/noport.json" <<'EOF'
{"services": {"app": {"build": ".", "image": "app:local"}}}
EOF
IN="$TMP/noport.json" OUT="$TMP/out3.json" EXT_VOLS_OUT="$TMP/ext3" WT_ID="wt-x" \
  python3 "$TMP/rewrite.py" >/dev/null 2>"$TMP/err3"; rc=$?
[[ $rc == 3 ]] && ok "an app service with no ports exits 3" \
               || bad "an app service with no ports exits 3" "exit $rc"
grep -q "APP_CONTAINER_PORT" "$TMP/err3" && ok "and names APP_CONTAINER_PORT" \
                                         || bad "and names APP_CONTAINER_PORT" "$(cat "$TMP/err3")"

echo
echo "== APP_SERVICE and APP_CONTAINER_PORT override detection =="
IN="$TMP/nobuild.json" OUT="$TMP/out4.json" EXT_VOLS_OUT="$TMP/ext4" WT_ID="wt-y" \
  APP_SERVICE=db APP_CONTAINER_PORT=5432 python3 "$TMP/rewrite.py" >"$TMP/name4" 2>&1; rc=$?
[[ $rc == 0 ]] && ok "an explicit APP_SERVICE makes an undetectable config work" \
               || bad "an explicit APP_SERVICE makes an undetectable config work" "$(cat "$TMP/name4")"
got=$(python3 -c "
import json;d=json.load(open('$TMP/out4.json'))
print(d['services']['db']['ports'][0]['published'])" 2>/dev/null)
[[ "$got" == "0" ]] && ok "and that service gets the ephemeral published port" \
                    || bad "and that service gets the ephemeral published port" "got $got"

echo
echo "== an unknown subcommand is a usage error, never a silent success =="
cd "$MAIN"
bash "$WTD" nonsense >/dev/null 2>"$TMP/usage"; rc=$?
[[ $rc != 0 ]] && ok "an unknown subcommand exits non-zero" \
               || bad "an unknown subcommand exits non-zero" "exit 0"
grep -q "usage:" "$TMP/usage" && ok "and prints usage" || bad "and prints usage" "$(cat "$TMP/usage")"

cd "$MAIN" && git worktree remove --force "$TMP/wt" >/dev/null 2>&1

echo
printf '  %d passed, %d failed\n' "$pass" "$fail"
[[ $fail == 0 ]]
