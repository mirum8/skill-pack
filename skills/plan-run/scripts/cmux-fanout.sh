#!/usr/bin/env bash
#
# cmux-fanout.sh — run several /r:plan-run or /r:issues-fix units at once, one
# detached git worktree and one cmux workspace each, and join them honestly.
#
# The caller decides WHICH units are safe to run together; this script decides
# the two things a model must never decide by reading a screen: whether the
# tooling is actually there, and whether a unit is finished. Both fail by
# returning a confident wrong answer, and a wave reported as finished while one
# session sits on a prompt lands a branch nobody built.
#
# Each unit is a full interactive `claude` TUI, not a headless run, so the work
# stays watchable and a human can step in. An interactive session never exits
# and yields no status, so completion is REPORTED rather than observed, through
# two independent signals and never one:
#
#   1. the sentinel the child skill writes at CMUX_FANOUT_SENTINEL, on success
#      and on halt alike;
#   2. the marker on the branch it built -- the evidence that does not depend on
#      the child cooperating at all.
#
# Subcommands:
#
#   preflight              cmux present and reachable, primary tree, clean tree.
#                          Any failure exits non-zero NAMING which: --cmux was
#                          typed deliberately, so falling back to serial would
#                          quietly change what was asked for.
#   spawn --id U --dir P --base REF --prompt TEXT
#         [--marker-file F] [--marker-prefix S] [--orchestrator NAME]
#                          worktree add --detach, then a cmux workspace running
#                          `claude --permission-mode auto '<prompt>'`. Refuses a
#                          unit past the cap: MAX_UNITS comes from the config
#                          (`steps.fanout.maxUnits`) and is enforced here, where
#                          a caller cannot forget it.
#   wait [--id U]... [--timeout S]
#                          block until every live unit has a sentinel, then read
#                          it AND verify the marker. A timeout is a stop naming
#                          the stalled units, never "assume done".
#   status                 one line per unit: live | ok | failed | stalled.
#   cleanup --id U         close the workspace, remove the worktree, free a slot.
#                          Refuses a tree with uncommitted changes -- a unit that
#                          reported success and left a dirty tree did not finish,
#                          and removing it would remove the evidence.
#
# A linked worktree is a NEW PATH, and Claude Code's workspace trust is per path.
# So an interactive session started there opens on the trust dialog and never
# reaches its prompt -- every unit would stall, every time. spawn therefore
# copies the repo's own `hasTrustDialogAccepted` onto the worktree it just made,
# and preflight refuses when the repo itself is untrusted: a fan-out may inherit
# a decision the user already made about this code, never invent one.
#
# Exit codes: 0 fine · 1 a unit failed · 2 usage/git · 3 timeout · 4 preflight
#             refused · 127 a required binary is missing.
#
# Env: CMUX_FANOUT_TIMEOUT (default 14400s) · CMUX_FANOUT_POLL (default 10s).
#
set -euo pipefail

# The cap comes from `steps.fanout.maxUnits` in the config, resolved here rather
# than by either caller so a skill cannot forget it and there is one place to
# change it. The default it resolves to is 3: three full implement+review
# pipelines is already the machine's limit — implement alone measures 20.9M
# tokens and ~1022s per agent — and a wider wave thrashes rather than finishing
# sooner. Its stderr is NOT swallowed: the reader prints every substitution it
# made there, and a cap that quietly became something other than what the config
# says is exactly what this fan-out must not do. The fallback below catches only
# a pack with no lib/ beside it at all — an empty cap would make `-ge` succeed on
# every spawn, which is no cap.
PACK_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." 2>/dev/null && pwd || echo "")
# The same root as the physical path. The `Workflow` tool accepts a `scriptPath` only inside the
# session's cwd or a directory it was given, and it re-checks that AFTER resolving symlinks — so a
# pack reached through a symlinked ~/.claude passes the first check under the name it was called by
# and fails the second under its real one. A unit is handed both spellings for that reason; without
# them every unit reaches its implement step, is refused the canonical pipeline, and halts with a
# clean worktree, which is a whole wave that produced nothing.
PACK_ROOT_REAL=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." 2>/dev/null && pwd -P || echo "")
MAX_UNITS=$(python3 "$PACK_ROOT/lib/read-config.py" --step fanout --field maxUnits \
              --pack "$PACK_ROOT") || MAX_UNITS=""
case $MAX_UNITS in
  ''|*[!0-9]*) MAX_UNITS=3 ;;
esac

say()  { echo "cmux-fanout: $*" >&2; }
die()  { say "$*"; exit "${2:-2}"; }

require_bin() {
  command -v "$1" >/dev/null 2>&1 || {
    say "required command not found: $1"
    exit 127
  }
}
require_bin git

sub=${1:-}
[ -n "$sub" ] && shift || die "usage: cmux-fanout.sh <preflight|spawn|wait|status|cleanup> [...]"

git rev-parse --show-toplevel >/dev/null 2>&1 || die "not inside a git repo"
git_dir=$(cd "$(git rev-parse --git-dir)" && pwd)
common_dir=$(cd "$(git rev-parse --git-common-dir)" && pwd)
[ "$git_dir" = "$common_dir" ] && tree_mode=primary || tree_mode=worktree

# Keyed on the common dir, so every unit of one repo shares one registry however
# many worktrees are open, and two repos never see each other's units.
state="${TMPDIR:-/tmp}/cmux-fanout-$(printf '%s' "$common_dir" | shasum | cut -c1-12)"
mkdir -p "$state"

rec()      { printf '%s/%s.rec' "$state" "$1"; }
sentinel() { printf '%s/%s.sentinel' "$state" "$1"; }

# A unit is live from spawn until cleanup, not until its sentinel lands: a failed
# unit still holds a worktree on disk and a workspace on screen, so it still
# holds a slot. That is what makes `cleanup` the thing that frees one.
live_ids() {
  local f
  for f in "$state"/*.rec; do
    [ -e "$f" ] || continue
    basename "$f" .rec
  done
}
live_count() { live_ids | wc -l | tr -d ' '; }

field() { sed -n "s/^$2=//p" "$1" 2>/dev/null | head -1; }

# --- workspace trust ---------------------------------------------------------
# Claude Code records trust per project path in .claude.json. A worktree is a new
# path, so it inherits nothing -- which is why this is not optional plumbing.
claude_config() { printf '%s/.claude.json' "${CLAUDE_CONFIG_DIR:-$HOME}"; }

# A path can be recorded either as typed or as resolved -- /tmp and /var are
# symlinks on macOS -- and a session is trusted under whichever one it was
# launched with. So both spellings are read here and both are written below;
# checking one and writing the other is how this silently stops working.
repo_trusted() {
  python3 - "$(claude_config)" "$(git rev-parse --show-toplevel)" <<'PY'
import json, os, sys
try:
    p = json.load(open(sys.argv[1])).get("projects", {})
except Exception:
    sys.exit(1)
raw = sys.argv[2]
for k in {raw, os.path.realpath(raw)}:
    if p.get(k, {}).get("hasTrustDialogAccepted"):
        sys.exit(0)
sys.exit(1)
PY
}

trust_worktree() {
  # Re-read immediately before writing and rename into place: a live session may
  # be writing this file too, and a half-written config is worse than a prompt.
  python3 - "$(claude_config)" "$1" <<'PY'
import json, os, sys, tempfile
cfg, raw = sys.argv[1], sys.argv[2]
try:
    d = json.load(open(cfg))
except Exception:
    sys.exit(1)
projects = d.setdefault("projects", {})
for path in {os.path.abspath(raw), os.path.realpath(raw)}:
    projects.setdefault(path, {})["hasTrustDialogAccepted"] = True
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(cfg) or ".")
with os.fdopen(fd, "w") as f:
    json.dump(d, f, indent=2)
os.replace(tmp, cfg)
PY
}

# --- preflight ---------------------------------------------------------------
do_preflight() {
  local bad=0
  if ! command -v cmux >/dev/null 2>&1; then
    say "cmux is not on PATH — the fan-out cannot run. Install it, or re-run without --cmux."
    bad=1
  elif ! cmux ping >/dev/null 2>&1; then
    say "cmux is installed but not reachable (is the app running? try 'cmux ping')."
    bad=1
  fi
  if [ "$tree_mode" != primary ]; then
    say "this is a linked worktree — the fan-out orchestrates from the primary tree, which is the"
    say "only tree that can check out the base ref to land what the units build."
    bad=1
  fi
  if [ -n "$(git status --porcelain)" ]; then
    say "the working tree is dirty — commit or stash before spawning units off this base."
    bad=1
  fi
  if ! repo_trusted; then
    say "this repo has not been trusted in Claude Code, so a session started in a worktree of it"
    say "would open on the trust dialog and never read its prompt. Trust it once here, then re-run."
    bad=1
  fi
  [ "$bad" = 0 ] || exit 4
  echo "preflight ok (primary tree, clean, cmux reachable, $(live_count)/$MAX_UNITS units live)"
}

# --- spawn -------------------------------------------------------------------
do_spawn() {
  local id= dir= base= prompt= mfile= mprefix= orch=
  while [ $# -gt 0 ]; do
    case $1 in
      --id)            id=${2:-};      shift 2 ;;
      --dir)           dir=${2:-};     shift 2 ;;
      --base)          base=${2:-};    shift 2 ;;
      --prompt)        prompt=${2:-};  shift 2 ;;
      --marker-file)   mfile=${2:-};   shift 2 ;;
      --marker-prefix) mprefix=${2:-}; shift 2 ;;
      --orchestrator)  orch=${2:-};    shift 2 ;;
      *) die "spawn: unknown argument $1" ;;
    esac
  done
  [ -n "$id" ] && [ -n "$dir" ] && [ -n "$base" ] && [ -n "$prompt" ] \
    || die "spawn: --id, --dir, --base and --prompt are all required"
  case $id in *[!A-Za-z0-9._-]*) die "spawn: --id may only contain [A-Za-z0-9._-]" ;; esac
  [ -e "$(rec "$id")" ] && die "spawn: unit '$id' already exists — cleanup first"

  local n; n=$(live_count)
  [ "$n" -ge "$MAX_UNITS" ] && die "spawn: $n units already live, the cap is $MAX_UNITS — wait for one to finish, then cleanup it" 4

  require_bin cmux
  [ -e "$dir" ] && die "spawn: $dir already exists — remove the stale worktree first"

  git worktree add --detach "$dir" "$base" >/dev/null \
    || die "spawn: git worktree add --detach '$dir' '$base' failed"

  # Without this the session opens on the trust dialog instead of the prompt, and
  # the unit stalls until the wait times out — every time, on every unit.
  trust_worktree "$dir" || {
    git worktree remove --force "$dir" >/dev/null 2>&1 || true
    die "spawn: could not mark $dir as a trusted workspace — the session would stall on the trust dialog"
  }

  local sfile; sfile=$(sentinel "$id")
  rm -f "$sfile"

  local out ws
  # `claude <prompt>` starts a normal interactive session with the prompt already
  # running: the user can watch it, answer it, or take it over. -p would exit on
  # its own but hand back a transcript nobody is sitting in.
  # The unit is told who spawned it, so it can raise an alarm UPWARDS to a known
  # address. That direction needs no discovery -- which is the whole reason it is
  # the only messaging direction wired here.
  local orch_env=()
  [ -n "$orch" ] && orch_env=(--env "CMUX_FANOUT_ORCHESTRATOR=$orch")
  # Both spellings of the pack root, so the unit can run the canonical pipelines rather than
  # discovering at its implement step that it cannot reach them (see PACK_ROOT_REAL above).
  local add_dirs=""
  [ -n "$PACK_ROOT" ] && add_dirs=" --add-dir '$PACK_ROOT'"
  [ -n "$PACK_ROOT_REAL" ] && [ "$PACK_ROOT_REAL" != "$PACK_ROOT" ] \
    && add_dirs="$add_dirs --add-dir '$PACK_ROOT_REAL'"
  # The prompt goes BEFORE the directories, never after: `--add-dir <directories...>` is variadic,
  # so a positional that follows it is eaten as one more path and the session comes up empty --
  # `claude -p --add-dir /tmp 'x'` answers "Input must be provided", the prompt already gone. That
  # failure is invisible to everything downstream: a unit with no prompt runs no skill, so it never
  # halts and never writes a sentinel, and `wait` reads it as live until the 4h timeout.
  if ! out=$(CMUX_QUIET=1 cmux workspace create \
                --name "$id" --cwd "$dir" --focus false \
                --env "CMUX_FANOUT_SENTINEL=$sfile" ${orch_env[@]+"${orch_env[@]}"} \
                --command "claude --permission-mode auto '$prompt'$add_dirs" 2>&1); then
    git worktree remove --force "$dir" >/dev/null 2>&1 || true
    die "spawn: cmux workspace create failed: $out"
  fi
  ws=$(printf '%s\n' "$out" | sed -n 's/^OK[[:space:]]\{1,\}//p' | head -1)
  if [ -z "$ws" ]; then
    git worktree remove --force "$dir" >/dev/null 2>&1 || true
    die "spawn: cmux workspace create returned no workspace ref (got: $out)"
  fi
  # Resolve the ref to its UUID and close by that. `create` hands back a ref only,
  # and cleanup runs much later -- a UUID cannot be mistaken for another
  # workspace whatever has happened to the window in between, and closing the
  # wrong one is precisely the confident-wrong-answer this script exists to stop.
  local uuid
  # Matched by SHAPE, not by column: a selected row carries a leading '*' and a
  # plain one does not, so the UUID sits in a different field depending on which
  # workspace happens to be focused.
  uuid=$(CMUX_QUIET=1 cmux workspace list --id-format both 2>/dev/null \
           | grep -E "(^|[[:space:]])$ws([[:space:]]|$)" \
           | grep -oiE '[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}' | head -1)

  {
    printf 'id=%s\n' "$id"
    printf 'dir=%s\n' "$dir"
    printf 'base=%s\n' "$base"
    printf 'workspace=%s\n' "$ws"
    printf 'workspace_uuid=%s\n' "$uuid"
    printf 'sentinel=%s\n' "$sfile"
    printf 'marker_file=%s\n' "$mfile"
    printf 'marker_prefix=%s\n' "$mprefix"
    printf 'orchestrator=%s\n' "$orch"
  } > "$(rec "$id")"

  echo "$id workspace=$ws dir=$dir sentinel=$sfile"
}

# --- the two signals ---------------------------------------------------------
# A unit is finished only when its own report AND the repo agree. Either alone
# lies in a different direction: a sentinel can be written by a session that then
# failed to commit, and a missing marker can just mean the unit is still working.
unit_verdict() {
  local id=$1 r s st branch mfile mprefix
  r=$(rec "$id"); s=$(sentinel "$id")
  [ -e "$s" ] || { echo "live"; return; }
  st=$(field "$s" status)
  branch=$(field "$s" branch)
  if [ "$st" != ok ]; then
    echo "failed ${st:-no-status} $(field "$s" reason)"
    return
  fi
  if [ -z "$branch" ]; then
    echo "failed no-branch the sentinel reports success but names no branch"
    return
  fi
  mfile=$(field "$r" marker_file); mprefix=$(field "$r" marker_prefix)
  if [ -n "$mfile" ]; then
    if ! git show "$branch:$mfile" 2>/dev/null | grep -q -- "$mprefix$branch"; then
      echo "failed no-marker $branch carries no '$mprefix$branch' in $mfile — not landable"
      return
    fi
  fi
  echo "ok $branch"
}

# --- liveness ----------------------------------------------------------------
# A unit that dies hard -- the session crashes, the workspace is closed by hand,
# the machine sleeps -- writes no sentinel and sends no message, so it is
# indistinguishable from one that is thinking. Waiting it out costs the whole
# timeout, which is four hours by default, to learn something that was true in
# the first minute.
#
# Says "gone" ONLY on evidence: the listing succeeded, it named other workspaces,
# and this unit's UUID is not among them. cmux unreachable, an empty listing and
# a unit whose UUID was never captured all mean "cannot tell", because declaring
# every live unit dead because cmux hiccuped is the confident wrong answer this
# script exists to refuse.
workspace_gone() {
  local uuid=$1 out
  [ -n "$uuid" ] || return 1
  out=$(CMUX_QUIET=1 cmux workspace list --id-format both 2>/dev/null) || return 1
  [ -n "$out" ] || return 1
  grep -qi -- "$uuid" <<<"$out" && return 1
  return 0
}

# --- wait --------------------------------------------------------------------
do_wait() {
  local ids=() timeout=${CMUX_FANOUT_TIMEOUT:-14400} poll=${CMUX_FANOUT_POLL:-10}
  while [ $# -gt 0 ]; do
    case $1 in
      --id)      ids+=("${2:-}"); shift 2 ;;
      --timeout) timeout=${2:-};  shift 2 ;;
      *) die "wait: unknown argument $1" ;;
    esac
  done
  if [ ${#ids[@]} -eq 0 ]; then
    while IFS= read -r i; do [ -n "$i" ] && ids+=("$i"); done < <(live_ids)
  fi
  [ ${#ids[@]} -eq 0 ] && { echo "no live units"; return 0; }

  local id
  for id in "${ids[@]}"; do [ -e "$(rec "$id")" ] || die "wait: no such unit '$id'"; done

  local waited=0 pending
  while :; do
    pending=()
    for id in "${ids[@]}"; do
      [ -e "$(sentinel "$id")" ] || pending+=("$id")
    done
    [ ${#pending[@]} -eq 0 ] && break
    local dead=()
    for id in "${pending[@]}"; do
      workspace_gone "$(field "$(rec "$id")" workspace_uuid)" && dead+=("$id")
    done
    if [ ${#dead[@]} -gt 0 ]; then
      say "workspace gone with no sentinel: ${dead[*]}"
      say "the session died rather than stalled — there is nothing to answer and nothing to wait for."
      say "Their worktrees are left in place; whatever they committed is still on their branches."
      for id in "${ids[@]}"; do echo "$id $(unit_verdict "$id")"; done
      exit 1
    fi
    if [ "$waited" -ge "$timeout" ]; then
      say "timed out after ${timeout}s waiting for: ${pending[*]}"
      say "their workspaces are left OPEN — a stall is usually a question waiting for a human."
      say "Open one, answer it, then re-run wait; or cleanup the unit once it is resolved."
      for id in "${ids[@]}"; do echo "$id $(unit_verdict "$id")"; done
      exit 3
    fi
    sleep "$poll"
    waited=$((waited + poll))
  done

  local rc=0 v
  for id in "${ids[@]}"; do
    v=$(unit_verdict "$id")
    echo "$id $v"
    case $v in failed*) rc=1 ;; esac
  done
  return $rc
}

# --- status ------------------------------------------------------------------
do_status() {
  local id any=0
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    any=1
    echo "$id $(unit_verdict "$id") workspace=$(field "$(rec "$id")" workspace) dir=$(field "$(rec "$id")" dir)"
  done < <(live_ids)
  [ "$any" = 1 ] || echo "no live units"
  echo "$(live_count)/$MAX_UNITS slots in use"
}

# --- cleanup -----------------------------------------------------------------
do_cleanup() {
  local id=
  while [ $# -gt 0 ]; do
    case $1 in
      --id) id=${2:-}; shift 2 ;;
      *) die "cleanup: unknown argument $1" ;;
    esac
  done
  [ -n "$id" ] || die "cleanup: --id is required"
  local r; r=$(rec "$id")
  [ -e "$r" ] || die "cleanup: no such unit '$id'"

  local dir ws uuid; dir=$(field "$r" dir); ws=$(field "$r" workspace)
  uuid=$(field "$r" workspace_uuid); [ -n "$uuid" ] && ws=$uuid
  if [ -d "$dir" ] && [ -n "$(git -C "$dir" status --porcelain 2>/dev/null)" ]; then
    die "cleanup: $dir has uncommitted changes — '$id' did not finish, and removing it would remove the only record of what it was doing"
  fi
  [ -n "$ws" ] && CMUX_QUIET=1 cmux workspace close "$ws" >/dev/null 2>&1 || true
  [ -d "$dir" ] && git worktree remove "$dir" >/dev/null 2>&1 || true
  git worktree prune >/dev/null 2>&1 || true
  rm -f "$r" "$(sentinel "$id")"
  echo "$id cleaned ($(live_count)/$MAX_UNITS slots in use)"
}

case $sub in
  preflight) do_preflight "$@" ;;
  spawn)     do_spawn     "$@" ;;
  wait)      do_wait      "$@" ;;
  status)    do_status    "$@" ;;
  cleanup)   do_cleanup   "$@" ;;
  *) die "unknown subcommand '$sub' (preflight|spawn|wait|status|cleanup)" ;;
esac
