#!/usr/bin/env bash
# Behaviour tests for fanout.sh — the decisions nothing downstream re-checks.
#
#   bash skills/plan-run/tests/fanout.test.sh
#
# No herdr server is contacted and no agent is run: herdr is stubbed on PATH, because what is under
# test is not the fan-out itself but the three judgements the script exists to make, each of which
# fails by returning a confident wrong answer.
#
#   1. Is the tooling actually there. --herdr is typed deliberately, so a missing or unreachable
#      herdr that quietly degraded to a serial run would hand back a different thing than was asked
#      for, with nothing in the report saying so.
#   2. Is a unit finished. An interactive session never exits, so completion is reported rather than
#      observed — and a wave read as finished while one session sits on a prompt lands a branch
#      nobody built. That is why a sentinel alone is not enough and the marker on the branch is
#      checked too.
#   3. How many units are live. The cap is what keeps a wide wave from thrashing, and a caller that
#      forgot it would only find out by watching the machine.
#
# And one thing that is not a judgement but is fatal without it: a worktree is a new path, so Claude
# Code's per-path workspace trust does not follow it. A session started there opens on the trust
# dialog and never reads its prompt, so every unit would stall — which is why the trust cases below
# matter as much as the rest. CLAUDE_CONFIG_DIR points at a throwaway config throughout; the user's
# own ~/.claude.json is never read or written by this suite.
#
# What a stub CANNOT prove is what herdr itself does with what it is handed. Those answers come from
# measuring the real binary, and they are recorded here so a future editor can tell a design
# constraint from a guess:
#
#   MEASURED against herdr 0.9.0 on 2026-09-08, in a throwaway `herdr --session` on its own socket:
#     * An idle shell reports foreground_processes holding EXACTLY the shell itself (pid ==
#       shell_pid), not an empty list. The readiness predicate must accept that shape.
#     * workspace create -> idle shell took 85ms, so the 15s budget is not one anything healthy nears.
#     * `agent prompt` delivers text BYTE-IDENTICAL through a real claude: don't / <port> /
#       "the box" / an em dash / $HOME UNEXPANDED / backticks / 100%. $HOME surviving is the proof
#       that no shell parses the prompt. `pane send-text` separately round-tripped 82 bytes with a
#       zero-byte diff.
#     * `agent start` returned in 3.8s with interactive_ready=true, and echoes the argv it ran.
#     * Workspace ids are NOT reused (close w2, create -> w3). Pane ids are documented never to be.
#     * Closing a workspace releases its agent name -> agent_not_found.
#     * A workspace whose --cwd is a linked worktree reports NO .worktree field, so
#       workspace_group_close_required cannot fire for a plain create. Its handling is defensive.
#     * Errors are JSON on STDERR with exit 1; usage errors exit 2; `pane read` prints PLAIN TEXT.
#     * `herdr status` EXITS 0 with no server running, which is why it can never be the gate.
#
# There is no CI, so this suite is the only thing standing between an edit and any of that.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
PACK=$PWD          # the pack root; $REPO below is a throwaway git repo, not this one
FAN="$PACK/skills/plan-run/scripts/fanout.sh"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0

ok()  { pass=$((pass + 1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }

STUB="$TMP/stub"; mkdir -p "$STUB"
# A real `claude` is on PATH in a developer's shell, and `agent start` would find it -- so it is
# shadowed here. Without this the suite launches live interactive sessions.
cat > "$STUB/claude" <<'CLAUDE_EOF'
#!/bin/sh
exit 0
CLAUDE_EOF
chmod +x "$STUB/claude"

# A herdr that keeps just enough state to answer the questions the script asks: which workspaces and
# panes exist, and which agent names are live. It honours herdr's own conventions, because those ARE
# the contract under test -- JSON answers on stdout, JSON errors on STDERR with exit 1, usage errors
# exit 2. A stub that answered errors on stdout would make every not-found probe pass by accident.
#
# `pane run` executes its command through a shell for the same reason the whole handshake exists: a
# line broken by bad quoting must fail here exactly as it fails for real.
#
# `agent start` records its post-`--` argv ONE ARGUMENT PER LINE. That is the only thing that can
# tell a correctly passed argument from text that merely appears somewhere in a command string, and
# it is what lets the suite assert that the prompt is NOT among those arguments.
cat > "$STUB/herdr" <<'STUB_EOF'
#!/bin/sh
echo "$*" >> "$HERDR_STUB_LOG"
S=$HERDR_STUB_STATE; mkdir -p "$S"
err() { printf '{"error":{"code":"%s","message":"%s"},"id":"stub"}\n' "$1" "${2:-stub error}" >&2; exit 1; }
case "$1 $2" in
  "status "*|"status")   echo "server:"; echo "  status: running"; exit 0 ;;
  "integration status")  [ "${HERDR_STUB_NO_INTEGRATION:-0}" = 0 ] || { echo "claude: not installed"; exit 0; }
                         echo "claude: current (v9)"; exit 0 ;;
  "workspace list")      [ "${HERDR_STUB_LIST_FAIL:-0}" = 0 ] || err server_not_running "no server"
                         [ "${HERDR_STUB_LIST_GARBAGE:-0}" = 0 ] || { echo "not json at all"; exit 0; }
                         out=""; for f in "$S"/ws.*; do
                           [ -e "$f" ] || continue
                           w=${f##*/ws.}
                           [ -n "$out" ] && out="$out,"
                           out="$out{\"workspace_id\":\"$w\",\"label\":\"$(cat "$f")\"}"
                         done
                         echo "{\"result\":{\"type\":\"workspace_list\",\"workspaces\":[$out]}}"; exit 0 ;;
  "workspace create")    [ "${HERDR_STUB_CREATE_FAIL:-0}" = 0 ] || err internal_error "create refused"
                         n=$(( $(cat "$HERDR_STUB_SEQ" 2>/dev/null || echo 0) + 1 ))
                         echo "$n" > "$HERDR_STUB_SEQ"
                         label=""; prev=""
                         for a in "$@"; do
                           case $prev in --label) label=$a ;; esac
                           prev=$a
                         done
                         echo "$label" > "$S/ws.w$n"; echo "w$n" > "$S/pane.w$n:p1"
                         [ "${HERDR_STUB_CREATE_NO_PANE:-0}" = 0 ] || { echo '{"result":{"workspace":{"workspace_id":"w'"$n"'"}}}'; exit 0; }
                         printf '{"result":{"type":"workspace_created","workspace":{"workspace_id":"w%s","label":"%s"},"tab":{"tab_id":"w%s:t1"},"root_pane":{"pane_id":"w%s:p1"}}}\n' "$n" "$label" "$n" "$n"
                         exit 0 ;;
  "workspace close")     [ -e "$S/ws.$3" ] || err workspace_not_found "workspace $3 not found"
                         [ "${HERDR_STUB_CLOSE_GROUP:-0}" = 0 ] || err workspace_group_close_required "linked worktrees"
                         rm -f "$S/ws.$3"
                         for f in "$S"/pane."$3":*; do [ -e "$f" ] && rm -f "$f"; done
                         for f in "$S"/agent.*; do
                           [ -e "$f" ] || continue
                           case "$(cat "$f")" in "$3":*) rm -f "$f" ;; esac
                         done
                         echo '{"result":{"type":"ok"}}'; exit 0 ;;
  "pane get")            [ "$3" = "${HERDR_STUB_PANE_GONE:-}" ] && err pane_not_found "pane $3 not found"
                         [ -e "$S/pane.$3" ] || err pane_not_found "pane $3 not found"
                         echo '{"result":{"pane":{"pane_id":"'"$3"'"}}}'; exit 0 ;;
  "pane process-info")   p=$4
                         fg='{"pid":100,"name":"bash","argv":["/bin/bash"]}'
                         [ "${HERDR_STUB_NEVER_IDLE:-0}" = 0 ] || fg='{"pid":100,"name":"bash"},{"pid":200,"name":"vim"}'
                         [ -e "$S/agentpane.$p" ] && [ "${HERDR_STUB_NO_CLAUDE:-0}" = 0 ] \
                           && fg='{"pid":100,"name":"bash"},{"pid":300,"name":"claude"}'
                         printf '{"result":{"type":"pane_process_info","process_info":{"pane_id":"%s","shell_pid":100,"foreground_processes":[%s]}}}\n' "$p" "$fg"
                         exit 0 ;;
  "pane run")            [ "${HERDR_STUB_NO_START:-0}" = 0 ] && sh -c "$4" >/dev/null 2>&1
                         echo '{"result":{"type":"ok"}}'; exit 0 ;;
  "agent get")           [ "$3" = "${HERDR_STUB_AGENT_GONE:-}" ] && err agent_not_found "agent target $3 not found"
                         [ -e "$S/agent.$3" ] || err agent_not_found "agent target $3 not found"
                         echo '{"result":{"agent":{"name":"'"$3"'"}}}'; exit 0 ;;
  "agent start")         [ -z "${HERDR_STUB_START_FAIL:-}" ] || err "$HERDR_STUB_START_FAIL" "start refused"
                         name=$3; pane=""; prev=""; seen=0
                         : > "${HERDR_CLAUDE_ARGV:-/dev/null}"
                         for a in "$@"; do
                           if [ "$seen" = 1 ]; then printf '%s\n' "$a" >> "${HERDR_CLAUDE_ARGV:-/dev/null}"; fi
                           [ "$a" = "--" ] && seen=1
                           case $prev in --pane) pane=$a ;; esac
                           prev=$a
                         done
                         echo "$pane" > "$S/agent.$name"; : > "$S/agentpane.$pane"
                         echo '{"result":{"type":"agent_started","agent":{"name":"'"$name"'","interactive_ready":true}}}'
                         exit 0 ;;
  "agent prompt")        [ -z "${HERDR_STUB_PROMPT_FAIL:-}" ] || err "$HERDR_STUB_PROMPT_FAIL" "prompt refused"
                         [ -e "$S/agent.$3" ] || err agent_not_found "agent target $3 not found"
                         printf '%s' "$4" > "${HERDR_PROMPT_TEXT:-/dev/null}"
                         echo '{"result":{"type":"agent_prompted"}}'; exit 0 ;;
esac
printf '{"error":{"code":"usage","message":"unknown"},"id":"stub"}\n' >&2
exit 2
STUB_EOF
chmod +x "$STUB/herdr"
export PATH="$STUB:$PATH"
export HERDR_STUB_LOG="$TMP/herdr.log" HERDR_STUB_SEQ="$TMP/herdr.seq" HERDR_STUB_STATE="$TMP/herdrstate"
export HERDR_CLAUDE_ARGV="$TMP/claude.argv" HERDR_PROMPT_TEXT="$TMP/prompt.txt"
export FANOUT_POLL=1

# A private state root per test file, so a developer's real fan-out is never touched and a rerun
# never inherits the last run's units.
export TMPDIR="$TMP"

# A throwaway Claude config, so the trust plumbing is exercised without touching the user's.
export CLAUDE_CONFIG_DIR="$TMP/cfg"; mkdir -p "$CLAUDE_CONFIG_DIR"
trust_repo() { python3 -c "
import json,sys,os
p=os.path.join(os.environ['CLAUDE_CONFIG_DIR'],'.claude.json')
d=json.load(open(p)) if os.path.exists(p) else {}
d.setdefault('projects',{}).setdefault(os.path.realpath(sys.argv[1]),{})['hasTrustDialogAccepted']=bool(int(sys.argv[2]))
json.dump(d,open(p,'w'))" "$1" "${2:-1}"; }
trusted() { python3 -c "
import json,sys,os
p=os.path.join(os.environ['CLAUDE_CONFIG_DIR'],'.claude.json')
d=json.load(open(p))
sys.exit(0 if d.get('projects',{}).get(os.path.realpath(sys.argv[1]),{}).get('hasTrustDialogAccepted') else 1)" "$1"; }

REPO="$TMP/repo"
mkdir -p "$REPO" && cd "$REPO"
git init -q -b main
git config user.email t@example.com; git config user.name test
printf 'a\n' > todo.md && git add -A && git commit -qm base

# The child's half of the contract, faked: land a commit on a branch, then write the sentinel the
# way plan-run's --no-merge step will. Nothing here runs claude.
finish_unit() {   # finish_unit <id> <dir> <branch> <status> [--no-marker]
  local id=$1 dir=$2 br=$3 st=$4 marker=${5:-marker}
  ( cd "$dir" && git checkout -q -b "$br"
    if [ "$marker" = marker ]; then printf 'a\n<!-- built: %s -->\n' "$br" > todo.md
    else printf 'a\nno marker here\n' > todo.md; fi
    git add -A && git commit -qm "$br" ) >/dev/null 2>&1
  local s; s=$(sed -n 's/^sentinel=//p' "$TMP"/fanout-*/"$id".rec)
  { printf 'status=%s\n' "$st"; printf 'branch=%s\n' "$br"; } > "$s"
}

echo "== preflight refuses rather than degrading to serial =="
cd "$REPO"
out=$("$FAN" preflight 2>&1); rc=$?
[[ $rc != 0 ]] && ok "an untrusted repo refuses — its units would stall on the trust dialog" \
               || bad "an untrusted repo refuses — its units would stall on the trust dialog" "exit 0"
grep -q "trust dialog" <<<"$out" && ok "and says so, rather than inventing trust the user never gave" \
                                 || bad "and says so, rather than inventing trust the user never gave" "$out"

trust_repo "$REPO"
out=$("$FAN" preflight 2>&1); rc=$?
[[ $rc == 0 ]] && ok "a clean primary tree with herdr reachable passes preflight" \
               || bad "a clean primary tree with herdr reachable passes preflight" "exit $rc: $out"

# A PATH holding neither the stub nor a real installation — the machine running this suite may
# well have herdr, and the case under test is a machine that does not.
out=$(PATH="/usr/bin:/bin" "$FAN" preflight 2>&1); rc=$?
[[ $rc != 0 ]] && ok "herdr absent exits non-zero" || bad "herdr absent exits non-zero" "exit 0"
grep -q "not on PATH" <<<"$out" && ok "and says herdr is missing rather than falling back" \
                                || bad "and says herdr is missing rather than falling back" "$out"

# `herdr status` EXITS 0 with no server running, so a gate built on it passes here and fails at
# every spawn instead — the same confident wrong answer, moved somewhere it costs more. The stub's
# `status` always succeeds, exactly like the real one, so if preflight ever starts believing it
# instead of `workspace list`, this case is what notices.
out=$(HERDR_STUB_LIST_FAIL=1 "$FAN" preflight 2>&1); rc=$?
[[ $rc != 0 ]] && ok "herdr installed but unreachable exits non-zero, though status says otherwise" \
               || bad "herdr installed but unreachable exits non-zero, though status says otherwise" "exit 0"
grep -q "not reachable" <<<"$out" && ok "and distinguishes unreachable from missing" \
                                  || bad "and distinguishes unreachable from missing" "$out"
out=$(HERDR_STUB_LIST_GARBAGE=1 "$FAN" preflight 2>&1); rc=$?
[[ $rc != 0 ]] && ok "an answer that is not a workspace list refuses rather than guessing" \
               || bad "an answer that is not a workspace list refuses rather than guessing" "exit $rc"
# herdr's own skill gates on HERDR_ENV to stop a model reaching into a session it is not part of.
# This script only ever touches what it created, and an orchestrator legitimately runs from a plain
# terminal while the server is up, so requiring it would refuse a working fan-out.
out=$(env -u HERDR_ENV "$FAN" preflight 2>&1); rc=$?
[[ $rc == 0 ]] && ok "preflight does not require HERDR_ENV — an orchestrator may sit outside a pane" \
               || bad "preflight does not require HERDR_ENV — an orchestrator may sit outside a pane" "exit $rc: $out"
# A missing status hook is a NAMED SKIP, never a refusal: completion rests on the sentinel and the
# branch marker, so what is lost is sidebar legibility and nothing else.
out=$(HERDR_STUB_NO_INTEGRATION=1 "$FAN" preflight 2>&1); rc=$?
[[ $rc == 0 ]] && ok "a missing claude integration is named, not fatal" \
               || bad "a missing claude integration is named, not fatal" "exit $rc: $out"
grep -q "integration install claude" <<<"$out" \
  && ok "and the message names the fix" || bad "and the message names the fix" "$out"

git worktree add -q --detach "$TMP/probe" HEAD
out=$(cd "$TMP/probe" && "$FAN" preflight 2>&1); rc=$?
[[ $rc != 0 ]] && ok "a linked worktree cannot orchestrate — preflight refuses" \
               || bad "a linked worktree cannot orchestrate — preflight refuses" "exit 0"
git worktree remove --force "$TMP/probe" >/dev/null 2>&1

printf 'dirty\n' > scratch.txt
out=$("$FAN" preflight 2>&1); rc=$?
[[ $rc != 0 ]] && ok "a dirty tree refuses — units would branch off uncommitted work" \
               || bad "a dirty tree refuses — units would branch off uncommitted work" "exit 0"
rm -f scratch.txt

echo
echo "== spawn builds the worktree and a watchable interactive session =="
# Exact-line matching against the recorded argv, not a substring of a command string: a broken
# argument splits across entries or vanishes, while its text still shows up in a flat log either way.
argv_has() { grep -qxF -- "$1" "$HERDR_CLAUDE_ARGV"; }
P1_PROMPT='/r:plan-run todo.md --phases 1 --no-merge --yes'
out=$("$FAN" spawn --id p1 --dir "$TMP/wt-p1" --base main \
        --prompt "$P1_PROMPT" \
        --marker-file todo.md --marker-prefix 'built: ' --orchestrator 'orch-99' 2>&1); rc=$?
[[ $rc == 0 ]] && ok "spawn exits 0" || bad "spawn exits 0" "exit $rc: $out"
[[ -d "$TMP/wt-p1" ]] && ok "and creates the detached worktree" \
                      || bad "and creates the detached worktree" "$TMP/wt-p1 missing"
grep -qE "workspace=w[0-9]+" <<<"$out" && ok "and reports the workspace id it got back" \
                                       || bad "and reports the workspace id it got back" "$out"
grep -qE "pane=w[0-9]+:p[0-9]+" <<<"$out" && ok "and the pane, which is what liveness is decided on" \
                                          || bad "and the pane, which is what liveness is decided on" "$out"
grep -q "agent=" <<<"$out" && ok "and the agent name, which is what cleanup must address" \
                           || bad "and the agent name, which is what cleanup must address" "$out"
argv_has "--permission-mode" && argv_has "auto" \
  && ok "the session runs under --permission-mode auto" \
  || bad "the session runs under --permission-mode auto" "$(cat "$HERDR_CLAUDE_ARGV")"
argv_has "-p" \
  && bad "the session is an interactive TUI, never headless -p" "$(cat "$HERDR_CLAUDE_ARGV")" \
  || ok "the session is an interactive TUI, never headless -p"
grep -q "FANOUT_SENTINEL=" "$HERDR_STUB_LOG" \
  && ok "and is handed the sentinel path it must write" \
  || bad "and is handed the sentinel path it must write" "$(cat "$HERDR_STUB_LOG")"
# Without this the unit reaches its implement step and is refused the canonical pipeline, because
# the Workflow tool only accepts a scriptPath under the cwd or a directory the session was given.
# It fails late and quietly: the worktree is clean, so the wave looks merely unproductive.
argv_has "--add-dir" && argv_has "$PACK" \
  && ok "and is given the pack root, so it can run the canonical pipelines" \
  || bad "and is given the pack root, so it can run the canonical pipelines" "$(cat "$HERDR_CLAUDE_ARGV")"
# THE regression this design exists to prevent. The prompt is documented free prose, so it quotes
# things; put it on a command line and an escaper has to survive every apostrophe and angle bracket
# forever. It is delivered by `agent prompt` instead, which means it must appear NOWHERE in the
# arguments handed to claude -- and a positional reintroduced "to save a call" would also be eaten
# by the variadic --add-dir, coming up as a session with no prompt that never halts and never
# sentinels, which `wait` reads as live for four hours.
argv_has "$P1_PROMPT" \
  && bad "the prompt is NOT an argv element — no shell ever parses it" "$(cat "$HERDR_CLAUDE_ARGV")" \
  || ok "the prompt is NOT an argv element — no shell ever parses it"
[[ "$(cat "$HERDR_PROMPT_TEXT")" == "$P1_PROMPT" ]] \
  && ok "it is delivered by agent prompt instead, byte for byte" \
  || bad "it is delivered by agent prompt instead, byte for byte" "$(cat "$HERDR_PROMPT_TEXT")"
trusted "$TMP/wt-p1" && ok "the new worktree inherits the repo's workspace trust" \
                     || bad "the new worktree inherits the repo's workspace trust" "not marked trusted"
# The unit is told who spawned it, so an alarm goes UPWARDS to a known address. Downwards there is
# no address the multiplexer can supply: SendMessage addresses a session by Claude Code's own name
# for it, which is unrelated to any herdr label, workspace, pane or agent handle.
grep -q "FANOUT_ORCHESTRATOR=orch-99" "$HERDR_STUB_LOG" \
  && ok "and is told the orchestrator's name, so it can raise an alarm upwards" \
  || bad "and is told the orchestrator's name, so it can raise an alarm upwards" "$(cat "$HERDR_STUB_LOG")"
: > "$HERDR_STUB_LOG"
"$FAN" spawn --id pnoorch --dir "$TMP/wt-pnoorch" --base main --prompt x >/dev/null 2>&1
grep -q "FANOUT_ORCHESTRATOR" "$HERDR_STUB_LOG" \
  && bad "omitting --orchestrator leaves the variable unset, never empty" "$(cat "$HERDR_STUB_LOG")" \
  || ok "omitting --orchestrator leaves the variable unset, never empty"
"$FAN" cleanup --id pnoorch >/dev/null 2>&1

# A pack reached through a symlink — the shipped layout, where ~/.claude is one — passes the tool's
# pre-resolution check under the name it was called by and fails the post-resolution one under its
# real path. So both spellings go across, and the link is built here rather than assumed: this repo
# is not itself behind one, and a case that only fires on someone else's machine tests nothing.
: > "$HERDR_STUB_LOG"
ln -s "$PACK" "$TMP/packlink"
"$TMP/packlink/skills/plan-run/scripts/fanout.sh" \
  spawn --id plink --dir "$TMP/wt-plink" --base main --prompt x >/dev/null 2>&1
PACK_REAL=$(cd "$PACK" && pwd -P)
argv_has "$TMP/packlink" \
  && ok "a pack reached through a symlink sends the path it was called by" \
  || bad "a pack reached through a symlink sends the path it was called by" "$(cat "$HERDR_CLAUDE_ARGV")"
argv_has "$PACK_REAL" \
  && ok "and its resolved path too — the tool re-checks after resolving" \
  || bad "and its resolved path too — the tool re-checks after resolving" "$(cat "$HERDR_CLAUDE_ARGV")"
"$FAN" cleanup --id plink >/dev/null 2>&1


out=$("$FAN" spawn --id p1 --dir "$TMP/wt-dup" --base main --prompt x 2>&1); rc=$?
[[ $rc != 0 ]] && ok "a duplicate id is refused rather than overwriting a live unit" \
               || bad "a duplicate id is refused rather than overwriting a live unit" "exit 0"

: > "$HERDR_STUB_LOG"
out=$(HERDR_STUB_CREATE_NO_PANE=1 "$FAN" spawn --id px --dir "$TMP/wt-px" --base main --prompt x 2>&1); rc=$?
[[ $rc != 0 ]] && ok "a create that names no root pane is a failure, not a unit with nowhere to start" \
               || bad "a create that names no root pane is a failure, not a unit with nowhere to start" "exit 0"
[[ ! -d "$TMP/wt-px" ]] && ok "and its half-made worktree is rolled back" \
                        || bad "and its half-made worktree is rolled back" "$TMP/wt-px survived"

echo "== the cap is enforced where a caller cannot forget it =="
# The cap is a SETTING now (`steps.fanout.maxUnits`), so the spawn counts below are only meaningful
# if this checkout resolves the shipped 3. Say so rather than failing four cases with an off-by-one
# that reads like a broken script.
CAP=$(cd "$PACK" && python3 lib/read-config.py --step fanout --field maxUnits 2>/dev/null)
[[ $CAP == 3 ]] && ok "this checkout resolves the shipped cap of 3" \
                || bad "this checkout resolves the shipped cap of 3" \
                       "resolved '$CAP' — a .config/skill-pack.yaml in this repo would do that, and the counts below assume 3"
"$FAN" spawn --id p2 --dir "$TMP/wt-p2" --base main --prompt x \
       --marker-file todo.md --marker-prefix 'built: ' >/dev/null 2>&1
"$FAN" spawn --id p3 --dir "$TMP/wt-p3" --base main --prompt x \
       --marker-file todo.md --marker-prefix 'built: ' >/dev/null 2>&1
out=$("$FAN" spawn --id p4 --dir "$TMP/wt-p4" --base main --prompt x 2>&1); rc=$?
[[ $rc != 0 ]] && ok "a fourth live unit is refused" || bad "a fourth live unit is refused" "exit 0"
grep -q "the cap is $CAP" <<<"$out" && ok "and the message names the cap" \
                                    || bad "and the message names the cap" "$out"
[[ ! -d "$TMP/wt-p4" ]] && ok "and no worktree is left behind by the refusal" \
                        || bad "and no worktree is left behind by the refusal" "$TMP/wt-p4 exists"

echo
echo "== a finished unit is taken down, and that is what frees the slot =="
finish_unit p3 "$TMP/wt-p3" phase-three ok
out=$("$FAN" cleanup --id p3 2>&1); rc=$?
[[ $rc == 0 ]] && ok "cleanup on a finished unit exits 0" || bad "cleanup on a finished unit exits 0" "$out"
[[ ! -d "$TMP/wt-p3" ]] && ok "and removes its worktree" || bad "and removes its worktree" "still there"
grep -q "workspace close" "$HERDR_STUB_LOG" && ok "and closes its workspace" \
                                           || bad "and closes its workspace" "$(cat "$HERDR_STUB_LOG")"
# By the workspace id it recorded at spawn, and only that one. Cleanup runs long after spawn, so a
# close aimed at anything derived later could take down a workspace this unit never owned.
grep -qE "workspace close w[0-9]+" "$HERDR_STUB_LOG" \
  && ok "closing it by the workspace id it recorded at spawn" \
  || bad "closing it by the workspace id it recorded at spawn" "$(cat "$HERDR_STUB_LOG")"
[[ $(grep -c "workspace close" "$HERDR_STUB_LOG") == 1 ]] \
  && ok "exactly one close, so no other workspace is ever a candidate" \
  || bad "exactly one close, so no other workspace is ever a candidate" "$(grep -c "workspace close" "$HERDR_STUB_LOG") closes"
grep -q -- "--group" "$HERDR_STUB_LOG" \
  && bad "and never --group, which would take the whole wave with it" "$(cat "$HERDR_STUB_LOG")" \
  || ok "and never --group, which would take the whole wave with it"
out=$("$FAN" spawn --id p4 --dir "$TMP/wt-p4" --base main --prompt x \
        --marker-file todo.md --marker-prefix 'built: ' 2>&1); rc=$?
[[ $rc == 0 ]] && ok "the freed slot admits exactly one more unit" \
               || bad "the freed slot admits exactly one more unit" "exit $rc: $out"
out=$("$FAN" spawn --id p5 --dir "$TMP/wt-p5" --base main --prompt x 2>&1); rc=$?
[[ $rc != 0 ]] && ok "and only one — the fifth is still refused" \
               || bad "and only one — the fifth is still refused" "exit 0"

printf 'uncommitted\n' > "$TMP/wt-p4/scratch.txt"
out=$("$FAN" cleanup --id p4 2>&1); rc=$?
[[ $rc != 0 ]] && ok "cleanup refuses a worktree with uncommitted changes" \
               || bad "cleanup refuses a worktree with uncommitted changes" "exit 0"
[[ -d "$TMP/wt-p4" ]] && ok "and leaves the evidence in place" \
                      || bad "and leaves the evidence in place" "removed anyway"
rm -f "$TMP/wt-p4/scratch.txt"
"$FAN" cleanup --id p4 >/dev/null 2>&1

echo
echo "== a unit is finished only when its report AND the repo agree =="
finish_unit p1 "$TMP/wt-p1" phase-one ok
out=$("$FAN" wait --id p1 --timeout 5 2>&1); rc=$?
[[ $rc == 0 ]] && ok "a success sentinel on a marked branch reports ok" \
               || bad "a success sentinel on a marked branch reports ok" "exit $rc: $out"
grep -q "^p1 ok phase-one" <<<"$out" && ok "and names the branch to land" \
                                     || bad "and names the branch to land" "$out"

finish_unit p2 "$TMP/wt-p2" phase-two ok no-marker
out=$("$FAN" wait --id p2 --timeout 5 2>&1); rc=$?
[[ $rc == 1 ]] && ok "a success sentinel on an UNMARKED branch is not landable" \
               || bad "a success sentinel on an UNMARKED branch is not landable" "exit $rc: $out"
grep -q "no-marker" <<<"$out" && ok "and says the marker is what is missing" \
                              || bad "and says the marker is what is missing" "$out"

sfile=$(sed -n 's/^sentinel=//p' "$TMP"/fanout-*/p2.rec)
{ printf 'status=halted\n'; printf 'branch=phase-two\n'; printf 'reason=build red\n'; } > "$sfile"
out=$("$FAN" wait --id p2 --timeout 5 2>&1); rc=$?
[[ $rc == 1 ]] && ok "a failure sentinel reports failed" || bad "a failure sentinel reports failed" "exit $rc: $out"
grep -q "build red" <<<"$out" && ok "and carries the child's own reason through" \
                              || bad "and carries the child's own reason through" "$out"

{ printf 'status=ok\n'; } > "$sfile"
out=$("$FAN" wait --id p2 --timeout 5 2>&1); rc=$?
[[ $rc == 1 ]] && ok "a success sentinel naming no branch is failed, not assumed" \
               || bad "a success sentinel naming no branch is failed, not assumed" "exit $rc: $out"

echo
echo "== a marker git cannot read is dropped at spawn, not failed at wait =="
# The repro: a repo that gitignores its backlog directory. `unit_verdict` reads the
# marker with `git show "<branch>:<file>"`, which for an untracked path fails on every
# branch -- so without the guard a unit that fixed, reviewed and committed its group
# cleanly comes back `no-marker`, reading as a broken fix rather than a missing file.
( cd "$REPO" && printf '/issues/\n' > .gitignore && mkdir -p issues \
  && printf -- '- [ ] a\n' > issues/backlog.md \
  && git add .gitignore && git commit -qm ignore-issues ) >/dev/null 2>&1
cd "$REPO"
git cat-file -e "main:issues/backlog.md" 2>/dev/null \
  && bad "the fixture's backlog really is untracked" "git can read it" \
  || ok "the fixture's backlog really is untracked"

out=$("$FAN" spawn --id pu --dir "$TMP/wt-pu" --base main --prompt x \
        --marker-file issues/backlog.md --marker-prefix 'built: ' 2>&1); rc=$?
[[ $rc == 0 ]] && ok "spawn still exits 0 — an untracked backlog is not a stop" \
               || bad "spawn still exits 0 — an untracked backlog is not a stop" "exit $rc: $out"
grep -q "not tracked" <<<"$out" \
  && ok "and names the weakened gate rather than dropping it silently" \
  || bad "and names the weakened gate rather than dropping it silently" "$out"
grep -q "^marker_file=$" "$TMP"/fanout-*/pu.rec \
  && ok "and records no marker file for the unit" \
  || bad "and records no marker file for the unit" "$(cat "$TMP"/fanout-*/pu.rec)"

finish_unit pu "$TMP/wt-pu" untracked-backlog ok no-marker
out=$("$FAN" wait --id pu --timeout 5 2>&1); rc=$?
[[ $rc == 0 ]] && ok "a clean unit under an untracked backlog lands on its sentinel and branch" \
               || bad "a clean unit under an untracked backlog lands on its sentinel and branch" "exit $rc: $out"
grep -q "^pu ok untracked-backlog" <<<"$out" && ok "and names the branch to land" \
                                             || bad "and names the branch to land" "$out"
"$FAN" cleanup --id pu >/dev/null 2>&1

echo
echo "== a missing sentinel times out; it never reads as done =="
"$FAN" cleanup --id p2 >/dev/null 2>&1
"$FAN" spawn --id p6 --dir "$TMP/wt-p6" --base main --prompt x \
       --marker-file todo.md --marker-prefix 'built: ' >/dev/null 2>&1
: > "$HERDR_STUB_LOG"
out=$("$FAN" wait --id p6 --timeout 2 2>&1); rc=$?
[[ $rc == 3 ]] && ok "a unit that never reports times out with exit 3" \
               || bad "a unit that never reports times out with exit 3" "exit $rc: $out"
grep -q "p6" <<<"$out" && ok "and names the stalled unit" || bad "and names the stalled unit" "$out"
grep -q "workspace close" "$HERDR_STUB_LOG" \
  && bad "a stalled unit's workspace is left open for a human" "$(cat "$HERDR_STUB_LOG")" \
  || ok "a stalled unit's workspace is left open for a human"
[[ -d "$TMP/wt-p6" ]] && ok "and its worktree survives the timeout" \
                      || bad "and its worktree survives the timeout" "removed"

out=$("$FAN" status 2>&1)
grep -q "^p6 live" <<<"$out" && ok "status reports it live rather than finished" \
                             || bad "status reports it live rather than finished" "$out"

echo
echo "== a unit whose session died is not waited out =="
# p6 is still live and still has no sentinel. Liveness is decided on the two handles herdr answers
# DIRECTLY, by error code rather than by a row missing from a listing: a closed pane id is never
# reused, so pane_not_found is proof this pane is gone; and an agent name is released when its agent
# exits, so agent_not_found over a live pane catches claude dying and leaving the shell standing.
P6_PANE=$(sed -n 's/^pane=//p' "$TMP"/fanout-*/p6.rec)
P6_AGENT=$(sed -n 's/^agent=//p' "$TMP"/fanout-*/p6.rec)
out=$(HERDR_STUB_PANE_GONE="$P6_PANE" "$FAN" wait --id p6 --timeout 60 2>&1); rc=$?
[[ $rc == 1 ]] && ok "a vanished pane fails fast instead of timing out" \
               || bad "a vanished pane fails fast instead of timing out" "exit $rc: $out"
grep -q "session gone" <<<"$out" && ok "and says the session died rather than stalled" \
                                 || bad "and says the session died rather than stalled" "$out"
[[ -d "$TMP/wt-p6" ]] && ok "and its worktree survives, holding whatever it committed" \
                      || bad "and its worktree survives, holding whatever it committed" "removed"

# The case a workspace-level probe cannot see at all: the pane is alive, but claude exited and left
# the shell sitting there. Waiting that out costs the whole four-hour timeout to learn something
# that was true in the first minute.
out=$(HERDR_STUB_AGENT_GONE="$P6_AGENT" "$FAN" wait --id p6 --timeout 60 2>&1); rc=$?
[[ $rc == 1 ]] && ok "claude exiting under a live pane is gone, not live" \
               || bad "claude exiting under a live pane is gone, not live" "exit $rc: $out"

# The ways the answer is "cannot tell". All must keep waiting: declaring every live unit dead
# because herdr hiccuped is the confident wrong answer, and it would abandon a whole wave.
out=$(HERDR_STUB_LIST_FAIL=1 "$FAN" wait --id p6 --timeout 2 2>&1); rc=$?
[[ $rc == 3 ]] && ok "herdr unreachable is 'cannot tell', so the wait stands" \
               || bad "herdr unreachable is 'cannot tell', so the wait stands" "exit $rc: $out"
out=$(HERDR_STUB_LIST_GARBAGE=1 "$FAN" wait --id p6 --timeout 2 2>&1); rc=$?
[[ $rc == 3 ]] && ok "an answer it cannot parse is 'cannot tell' too" \
               || bad "an answer it cannot parse is 'cannot tell' too" "exit $rc: $out"

echo
echo "== --any rolls the window instead of waiting on the slowest =="
# A wave is a rolling window only if the caller can be told about the FIRST unit back rather than
# the last. Bare `wait` blocks until every unit in the set has a sentinel, which is batches waiting
# on the slowest; `--any` is what lets the freed slot admit the next queued leaf while the rest are
# still working. It cannot be built from the other subcommands: the alternative is polling `status`
# on a timer, which is deciding "is it done yet" by re-reading a report — exactly the shape this
# script exists to keep away from the caller.
while IFS= read -r line; do
  case $line in *workspace=*) "$FAN" cleanup --id "${line%% *}" >/dev/null 2>&1 ;; esac
done < <("$FAN" status 2>/dev/null)
for u in a1 a2 a3; do
  "$FAN" spawn --id "$u" --dir "$TMP/wt-$u" --base main --prompt x \
         --marker-file todo.md --marker-prefix 'built: ' >/dev/null 2>&1
done

finish_unit a2 "$TMP/wt-a2" phase-a2 ok
out=$("$FAN" wait --any --timeout 3 2>&1); rc=$?
[[ $rc == 0 ]] && ok "--any returns on the first unit back, with two still working" \
               || bad "--any returns on the first unit back, with two still working" "exit $rc: $out"
grep -q "^a2 ok phase-a2" <<<"$out" && ok "and names exactly that unit, ready to land and cleanup" \
                                    || bad "and names exactly that unit, ready to land and cleanup" "$out"
grep -qE "^(a1|a3) " <<<"$out" && bad "and says nothing about the units still working" "$out" \
                               || ok "and says nothing about the units still working"

out=$("$FAN" wait --timeout 2 2>&1); rc=$?
[[ $rc == 3 ]] && ok "bare wait over the same set still blocks on the slowest — the two shapes differ" \
               || bad "bare wait over the same set still blocks on the slowest — the two shapes differ" "exit $rc: $out"
out=$("$FAN" wait --any --id a1 --id a3 --timeout 2 2>&1); rc=$?
[[ $rc == 3 ]] && ok "--any honours an explicit --id set rather than always scanning every live unit" \
               || bad "--any honours an explicit --id set rather than always scanning every live unit" "exit $rc: $out"

# The trap the once-only rule exists for. A failed unit is REQUIRED to be left standing — workspace
# open, worktree in place, since that state is the only evidence of what went wrong — so it keeps
# its rec and stays live. Handed back on every later call, it would starve its wave-mates forever:
# a loop that never ends and never says why.
finish_unit a1 "$TMP/wt-a1" phase-a1 halted
out=$("$FAN" wait --any --timeout 3 2>&1); rc=$?
[[ $rc == 1 ]] && ok "a failed unit comes back through --any as failed, not as ok" \
               || bad "a failed unit comes back through --any as failed, not as ok" "exit $rc: $out"
grep -q "^a1 failed" <<<"$out" && ok "and is named" || bad "and is named" "$out"
out=$("$FAN" wait --any --timeout 2 2>&1); rc=$?
[[ $rc == 3 ]] && ok "and is not handed back twice — the wait moves on to the unit still working" \
               || bad "and is not handed back twice — the wait moves on to the unit still working" "exit $rc: $out"
grep -q "a3" <<<"$out" && ok "naming that one, while the failed unit stays standing" \
                       || bad "naming that one, while the failed unit stays standing" "$out"
[[ -d "$TMP/wt-a1" ]] && ok "a reported failure is still left standing for a human" \
                      || bad "a reported failure is still left standing for a human" "removed"

# What the whole flag is for: cleanup the unit --any named, and the slot it frees takes the next.
"$FAN" cleanup --id a2 >/dev/null 2>&1
out=$("$FAN" spawn --id a4 --dir "$TMP/wt-a4" --base main --prompt x 2>&1); rc=$?
[[ $rc == 0 ]] && ok "the slot freed by cleaning up that unit admits the next while the rest work" \
               || bad "the slot freed by cleaning up that unit admits the next while the rest work" "exit $rc: $out"

# Nothing pending and nothing unreported is not a wait, it is an answer. Blocking four hours over
# units that cannot change would be indistinguishable from a stall.
finish_unit a3 "$TMP/wt-a3" phase-a3 ok
finish_unit a4 "$TMP/wt-a4" phase-a4 ok
out=$("$FAN" wait --any --timeout 5 2>&1); rc=$?
grep -q "^a3 " <<<"$out" && grep -q "^a4 " <<<"$out" \
  && ok "two units back in one tick are both handed over, not one and a re-wait" \
  || bad "two units back in one tick are both handed over, not one and a re-wait" "$out"
out=$("$FAN" wait --any --timeout 5 2>&1); rc=$?
[[ $rc == 0 ]] && ok "with everything already handed back, --any returns instead of blocking" \
               || bad "with everything already handed back, --any returns instead of blocking" "exit $rc: $out"
grep -q "no unreported units" <<<"$out" \
  && ok "and says why, so a caller that lost its place reads status rather than hanging" \
  || bad "and says why, so a caller that lost its place reads status rather than hanging" "$out"

# The mark is the unit's, not the id's: cleanup takes it away with everything else, so an id reused
# later is a new unit rather than a silently pre-reported one.
"$FAN" cleanup --id a3 >/dev/null 2>&1
"$FAN" spawn --id a3 --dir "$TMP/wt-a3" --base main --prompt x >/dev/null 2>&1
finish_unit a3 "$TMP/wt-a3" phase-a3-again ok
out=$("$FAN" wait --any --id a3 --timeout 3 2>&1); rc=$?
grep -q "^a3 ok phase-a3-again" <<<"$out" \
  && ok "cleanup clears the once-only mark, so a reused id reports again" \
  || bad "cleanup clears the once-only mark, so a reused id reports again" "exit $rc: $out"

for u in a1 a3 a4; do "$FAN" cleanup --id "$u" >/dev/null 2>&1; done

echo
echo "== usage errors are never a silent success =="
out=$("$FAN" nonsense 2>&1); rc=$?
[[ $rc != 0 ]] && ok "an unknown subcommand exits non-zero" \
               || bad "an unknown subcommand exits non-zero" "exit 0"
out=$("$FAN" spawn --id only 2>&1); rc=$?
[[ $rc != 0 ]] && ok "spawn without its required arguments exits non-zero" \
               || bad "spawn without its required arguments exits non-zero" "exit 0"
out=$("$FAN" wait --id nosuch --timeout 2 2>&1); rc=$?
[[ $rc != 0 ]] && ok "waiting on a unit that was never spawned exits non-zero" \
               || bad "waiting on a unit that was never spawned exits non-zero" "exit 0"
out=$("$FAN" cleanup --id nosuch 2>&1); rc=$?
[[ $rc != 0 ]] && ok "cleaning up a unit that was never spawned exits non-zero" \
               || bad "cleaning up a unit that was never spawned exits non-zero" "exit 0"

echo
echo "== the cap comes from the config, and a bad one never becomes no cap =="
# The script compares with `-ge`, so an empty cap would let every spawn through and cap nothing.
# That is the failure this block exists for — a cap that reads as "unlimited" looks like a working
# fan-out right up until the machine thrashes.
CAPREPO="$TMP/caprepo"; mkdir -p "$CAPREPO/.config"
git -C "$CAPREPO" init -q 2>/dev/null
capof() { (cd "$CAPREPO" && "$FAN" status 2>/dev/null | sed -n 's|.*/\([0-9]*\) slots in use|\1|p'); }
printf 'steps:\n  fanout:\n    maxUnits: 5\n' > "$CAPREPO/.config/skill-pack.yaml"
[[ $(capof) == 5 ]] && ok "a project config raises the cap" \
                    || bad "a project config raises the cap" "got '$(capof)'"
printf 'steps:\n  fanout:\n    maxUnits: 1\n' > "$CAPREPO/.config/skill-pack.yaml"
[[ $(capof) == 1 ]] && ok "and can lower it to a serial wave" \
                    || bad "and can lower it to a serial wave" "got '$(capof)'"
for junk in '' 'many' '0' '-2' '400'; do
  printf 'steps:\n  fanout:\n    maxUnits: %s\n' "$junk" > "$CAPREPO/.config/skill-pack.yaml"
  [[ $(capof) == 3 ]] && ok "a cap of '${junk:-<empty>}' falls back to the shipped 3" \
                      || bad "a cap of '${junk:-<empty>}' falls back to the shipped 3" "got '$(capof)'"
done
rm -f "$CAPREPO/.config/skill-pack.yaml"
[[ $(capof) == 3 ]] && ok "and no project file at all resolves the shipped cap" \
                    || bad "and no project file at all resolves the shipped cap" "got '$(capof)'"

echo
echo "== a unit's tree gets the test-app fixtures, and only the fixtures =="
# `git worktree add` checks out TRACKED files only, and the generated /test-app skill keeps what it
# needs to reach a live target on gitignored paths -- `r:test-app-create` writes test_creds.txt and
# gitignores it itself. Without the copy, the unit holds the skill and not what the skill reads, so
# its UI verification blocks on every unit of every credentialed project and subtracts from the
# merge gate without ever looking like a fan-out problem.
#
# The other half is what must NOT be copied: the same directory accumulates that skill's own
# captured frames, and handing a unit a predecessor's screen to read as this run's evidence is the
# confident-wrong-answer this script exists to stop. So both directions are asserted here -- a test
# that only checked the fixture arrived would pass a script that copied all 172 files.
FX="$TMP/fxrepo"; mkdir -p "$FX/.claude/skills/test-app/cluster" "$FX/.claude/skills/test-app/e2e/frames"
git -C "$FX" init -q; git -C "$FX" config user.email t@t; git -C "$FX" config user.name t
printf 'kubeconfig at cluster/kubeconfig.yaml, creds at test_creds.txt\n' > "$FX/.claude/skills/test-app/SKILL.md"
printf 'apiVersion: v1\n'  > "$FX/.claude/skills/test-app/cluster/kubeconfig.yaml"
printf 'u=admin\n'         > "$FX/.claude/skills/test-app/test_creds.txt"
printf 'stale screen\n'    > "$FX/.claude/skills/test-app/e2e/frames/geom-80x24.txt"
printf '.claude/skills/test-app/cluster/\n.claude/skills/test-app/test_creds.txt\n.claude/skills/test-app/e2e/frames/\n' > "$FX/.gitignore"
printf 'a\n' > "$FX/todo.md"
git -C "$FX" add -A >/dev/null; git -C "$FX" commit -qm base
FXBASE=$(git -C "$FX" rev-parse HEAD)
trust_repo "$FX"

out=$(cd "$FX" && PATH="$STUB:$PATH" "$FAN" spawn \
        --id fx --dir "$TMP/wt-fx" --base "$FXBASE" --prompt 'go' 2>&1)

[ -f "$TMP/wt-fx/.claude/skills/test-app/cluster/kubeconfig.yaml" ] \
  && ok "the gitignored kubeconfig the skill names is in the unit tree" \
  || bad "the gitignored kubeconfig the skill names is in the unit tree" "$out"
[ -f "$TMP/wt-fx/.claude/skills/test-app/test_creds.txt" ] \
  && ok "and so is the credentials file" \
  || bad "and so is the credentials file" "$out"
[ -f "$TMP/wt-fx/.claude/skills/test-app/e2e/frames/geom-80x24.txt" ] \
  && bad "a previous run's captured frame is NOT copied" "geom-80x24.txt was copied into the unit tree" \
  || ok "a previous run's captured frame is NOT copied"
grep -q "copied test-app fixture '.claude/skills/test-app/test_creds.txt'" <<<"$out" \
  && ok "and every copied fixture is named out loud" \
  || bad "and every copied fixture is named out loud" "$out"

cd "$FX" && git worktree remove --force "$TMP/wt-fx" >/dev/null 2>&1
cd "$REPO"

echo
echo "== a prompt is passed to the child intact, apostrophes and all =="
# The prompt is a DOCUMENTED input and callers are told to compose free prose; prose about a
# checklist quotes the checklist. Any form that puts it on a command line needs an escaper, and an
# escaper is a thing that can be got wrong again -- an observed spawn hit `<port>`, zsh read it as
# an input redirection, and the child sat at a `quote>` prompt forever. Nothing caught it: a shell
# WAS running, so `status` said live for twenty minutes and `wait` would have blocked on a sentinel
# nobody was going to write.
#
# So the prompt is delivered by `agent prompt` and is never an argument at all. That is what this
# case guards: the nasty text must arrive whole AND must appear nowhere in claude's argv. Measured
# against the real binary, `agent prompt` delivers it byte-identical -- $HOME included, unexpanded,
# which is the proof no shell parses it -- and that is the half a stub cannot check for itself.
QREPO="$TMP/qrepo"; mkdir -p "$QREPO"
git -C "$QREPO" init -q -b main; git -C "$QREPO" config user.email t@t; git -C "$QREPO" config user.name t
printf 'a\n' > "$QREPO/todo.md"; git -C "$QREPO" add -A >/dev/null; git -C "$QREPO" commit -qm base
QBASE=$(git -C "$QREPO" rev-parse HEAD); trust_repo "$QREPO"

NASTY=$(cat <<'NASTY_EOF'
don't drop this: open <port> and check "the box" — it's Phase 33 $HOME `id` 100%
NASTY_EOF
)
rm -f "$HERDR_CLAUDE_ARGV" "$HERDR_PROMPT_TEXT"
out=$(cd "$QREPO" && PATH="$STUB:$PATH" "$FAN" spawn \
        --id q1 --dir "$TMP/wt-q1" --base "$QBASE" --prompt "$NASTY" 2>&1); rc=$?

[ "$rc" = 0 ] && ok "a prompt full of quotes and angle brackets spawns cleanly" \
              || bad "a prompt full of quotes and angle brackets spawns cleanly" "rc=$rc $out"
[ "$(cat "$HERDR_PROMPT_TEXT" 2>/dev/null)" = "$NASTY" ] \
  && ok "and agent prompt receives it as ONE argument, byte for byte" \
  || bad "and agent prompt receives it as ONE argument, byte for byte" "got: $(cat "$HERDR_PROMPT_TEXT" 2>/dev/null)"
grep -qF -- "$NASTY" "$HERDR_CLAUDE_ARGV" 2>/dev/null \
  && bad "and it never reaches claude's argv, where a shell would have parsed it" "$(cat "$HERDR_CLAUDE_ARGV")" \
  || ok "and it never reaches claude's argv, where a shell would have parsed it"
grep -qx -- '--permission-mode' "$HERDR_CLAUDE_ARGV" \
  && ok "while the flags that DO belong there are still their own arguments" \
  || bad "while the flags that DO belong there are still their own arguments" "$(cat "$HERDR_CLAUDE_ARGV" 2>/dev/null)"
[ -f "$TMP"/fanout-*/q1.started ] \
  && ok "and the child recorded that it actually started" \
  || bad "and the child recorded that it actually started" "no start marker"

echo
echo "== a pane that exists is not a shell that runs commands =="
# A workspace that CREATED is not a session that STARTED, and `agent start` has the same
# precondition the handshake does -- the pane must be at an interactive prompt. Every failure shape
# leaves a LIVE PANE behind, which is the one thing `status` cannot tell from a working unit.
out=$(cd "$QREPO" && HERDR_STUB_NO_START=1 PATH="$STUB:$PATH" "$FAN" spawn \
        --id q2 --dir "$TMP/wt-q2" --base "$QBASE" --prompt 'plain' 2>&1); rc=$?
[ "$rc" != 0 ] && ok "spawn fails when the handshake never lands" \
               || bad "spawn fails when the handshake never lands" "rc=$rc $out"
grep -q "no shell that runs commands" <<<"$out" \
  && ok "and says so, rather than a generic error" \
  || bad "and says so, rather than a generic error" "$out"
[ -e "$TMP/wt-q2" ] \
  && bad "and the worktree is cleaned up, not left behind" "$TMP/wt-q2 still exists" \
  || ok "and the worktree is cleaned up, not left behind"
[ -e "$(ls -d "$TMP"/fanout-*/q2.rec 2>/dev/null)" ] \
  && bad "and no unit record is written for a unit that never ran" "q2.rec exists" \
  || ok "and no unit record is written for a unit that never ran"

# THE case that proves the readiness gate is real rather than survived by luck. A pane that never
# goes idle must stop the spawn BEFORE `agent start` is ever called -- a script that merely waited
# and pressed on would still call it, and would still pass every assertion above.
: > "$HERDR_STUB_LOG"
out=$(cd "$QREPO" && HERDR_STUB_NEVER_IDLE=1 HERDR_STUB_NO_START=1 PATH="$STUB:$PATH" "$FAN" spawn \
        --id q3 --dir "$TMP/wt-q3" --base "$QBASE" --prompt 'plain' 2>&1); rc=$?
[ "$rc" != 0 ] && ok "a pane that never reaches a prompt refuses the spawn" \
               || bad "a pane that never reaches a prompt refuses the spawn" "rc=$rc"
grep -q "agent start" "$HERDR_STUB_LOG" \
  && bad "and agent start is never reached — asserted by its ABSENCE from the call log" "$(cat "$HERDR_STUB_LOG")" \
  || ok "and agent start is never reached — asserted by its ABSENCE from the call log"
grep -q "workspace close" "$HERDR_STUB_LOG" \
  && ok "and the workspace it opened is closed again, leaving nothing on screen" \
  || bad "and the workspace it opened is closed again, leaving nothing on screen" "$(cat "$HERDR_STUB_LOG")"

# One handshake, never a retry. A second `pane run` sent because the first looked lost is text that
# arrives late and is typed into the agent that started in between -- a unit holding a stray line of
# shell in its prompt box, which is invisible on the happy path.
: > "$HERDR_STUB_LOG"
(cd "$QREPO" && PATH="$STUB:$PATH" "$FAN" spawn \
   --id q4 --dir "$TMP/wt-q4" --base "$QBASE" --prompt 'plain' >/dev/null 2>&1)
[[ $(grep -c "^pane run" "$HERDR_STUB_LOG") == 1 ]] \
  && ok "exactly one handshake is sent to the pane" \
  || bad "exactly one handshake is sent to the pane" "$(grep -c "^pane run" "$HERDR_STUB_LOG") pane runs"
(cd "$QREPO" && "$FAN" cleanup --id q4 >/dev/null 2>&1)

echo
echo "== a unit that comes up but will not take its prompt is not reported as spawned =="
# herdr documents that a timeout or agent_prompt_stalled does NOT prove the prompt was undelivered,
# so this must never be retried -- a retry can double-send into a session that already has the work.
for code in agent_prompt_stalled timeout agent_blocked; do
  : > "$HERDR_STUB_LOG"
  out=$(cd "$QREPO" && HERDR_STUB_PROMPT_FAIL="$code" PATH="$STUB:$PATH" "$FAN" spawn \
          --id "qp" --dir "$TMP/wt-qp" --base "$QBASE" --prompt 'plain' 2>&1); rc=$?
  [ "$rc" != 0 ] && ok "$code is a spawn failure, not a live unit" \
                 || bad "$code is a spawn failure, not a live unit" "rc=$rc"
  [[ $(grep -c "^agent prompt" "$HERDR_STUB_LOG") == 1 ]] \
    && ok "and the prompt is never re-sent after $code" \
    || bad "and the prompt is never re-sent after $code" "$(grep -c "^agent prompt" "$HERDR_STUB_LOG") attempts"
  grep -q "workspace close" "$HERDR_STUB_LOG" \
    && ok "and its workspace is closed rather than orphaned ($code)" \
    || bad "and its workspace is closed rather than orphaned ($code)" "$(cat "$HERDR_STUB_LOG")"
  [ -e "$TMP/wt-qp" ] && bad "and its worktree is rolled back ($code)" "survived" \
                      || ok "and its worktree is rolled back ($code)"
done

echo
echo "== an agent that cannot start takes nothing with it =="
for code in agent_not_ready timeout agent_name_in_use; do
  : > "$HERDR_STUB_LOG"
  out=$(cd "$QREPO" && HERDR_STUB_START_FAIL="$code" PATH="$STUB:$PATH" "$FAN" spawn \
          --id "qs" --dir "$TMP/wt-qs" --base "$QBASE" --prompt 'plain' 2>&1); rc=$?
  [ "$rc" != 0 ] && ok "$code refuses the spawn" || bad "$code refuses the spawn" "rc=$rc"
  grep -q "$code" <<<"$out" && ok "and the message names the code herdr gave ($code)" \
                            || bad "and the message names the code herdr gave ($code)" "$out"
  grep -q "workspace close" "$HERDR_STUB_LOG" \
    && ok "and closes the workspace it opened ($code)" \
    || bad "and closes the workspace it opened ($code)" "$(cat "$HERDR_STUB_LOG")"
  [ -e "$TMP/wt-qs" ] && bad "and rolls back the worktree ($code)" "survived" \
                      || ok "and rolls back the worktree ($code)"
done

echo
echo "== the herdr agent name is derived, recorded, and never taken from someone else =="
# Names are [a-z][a-z0-9_-]{0,31} and unique across the whole SERVER, not per repo -- two repos
# fanning out `phase-1` at once would collide, and the second start is a hard refusal.
(cd "$QREPO" && PATH="$STUB:$PATH" "$FAN" spawn --id P1.x --dir "$TMP/wt-qn" --base "$QBASE" --prompt p >/dev/null 2>&1)
aname=$(sed -n 's/^agent=//p' "$TMP"/fanout-*/P1.x.rec 2>/dev/null)
[[ $aname =~ ^[a-z][a-z0-9_-]{0,31}$ ]] \
  && ok "an id with uppercase and dots still yields a legal herdr agent name" \
  || bad "an id with uppercase and dots still yields a legal herdr agent name" "got '$aname'"
[[ ${#aname} -le 32 ]] && ok "and one within herdr's 32-character limit" \
                       || bad "and one within herdr's 32-character limit" "${#aname} chars"
# Recorded, not recomputed: cleanup and the liveness probe must address the agent THIS spawn named.
grep -q "^agent=$aname$" "$TMP"/fanout-*/P1.x.rec \
  && ok "and it is recorded in the unit's rec rather than derived again later" \
  || bad "and it is recorded in the unit's rec rather than derived again later" "not recorded"
# A live name belonging to another wave must never be taken over: that is a spawn silently driving
# somebody else's session, which is the worst outcome available here.
# `P1.x` and `p1-x` are different unit ids that derive to the SAME herdr agent name, which is the
# collision the dup-id check cannot see.
out=$(cd "$QREPO" && PATH="$STUB:$PATH" "$FAN" spawn --id p1-x --dir "$TMP/wt-qn2" --base "$QBASE" --prompt p 2>&1); rc=$?
[ "$rc" != 0 ] && ok "a derived name that is already live is refused, never reused" \
               || bad "a derived name that is already live is refused, never reused" "rc=$rc"
(cd "$QREPO" && "$FAN" cleanup --id P1.x >/dev/null 2>&1)

echo
echo "== a state path this script cannot put on a command line is refused =="
# The handshake interpolates the state path into a shell command. Every part of it is constrained
# except TMPDIR, so a TMPDIR with a space is the one way that line becomes a quoting bug again.
mkdir -p "$TMP/with space"
out=$(cd "$QREPO" && TMPDIR="$TMP/with space" PATH="$STUB:$PATH" "$FAN" status 2>&1); rc=$?
[ "$rc" != 0 ] && ok "a TMPDIR with a space is refused out loud, not escaped around" \
               || bad "a TMPDIR with a space is refused out loud, not escaped around" "rc=$rc: $out"

cd "$QREPO" && git worktree remove --force "$TMP/wt-q1" >/dev/null 2>&1
cd "$REPO"

cd "$REPO" && git worktree remove --force "$TMP/wt-p6" >/dev/null 2>&1
cd "$REPO" && git worktree remove --force "$TMP/wt-p1" >/dev/null 2>&1

echo
printf '  %d passed, %d failed\n' "$pass" "$fail"
[[ $fail == 0 ]]
