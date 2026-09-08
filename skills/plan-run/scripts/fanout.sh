#!/usr/bin/env bash
#
# fanout.sh — run several /r:plan-run or /r:issues-fix units at once, one
# detached git worktree and one herdr workspace each, and join them honestly.
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
#   1. the sentinel the child skill writes at FANOUT_SENTINEL, on success
#      and on halt alike;
#   2. the marker on the branch it built -- the evidence that does not depend on
#      the child cooperating at all.
#
# Subcommands:
#
#   preflight              herdr present and reachable, primary tree, clean tree.
#                          Any failure exits non-zero NAMING which: --herdr was
#                          typed deliberately, so falling back to serial would
#                          quietly change what was asked for.
#   spawn --id U --dir P --base REF --prompt TEXT
#         [--marker-file F] [--marker-prefix S] [--orchestrator NAME]
#                          worktree add --detach, then a herdr workspace whose
#                          root pane runs `claude --permission-mode auto`, with
#                          the prompt DELIVERED SEPARATELY by `agent prompt`.
#                          Refuses a unit past the cap: MAX_UNITS comes from the
#                          config (`steps.fanout.maxUnits`) and is enforced here,
#                          where a caller cannot forget it.
#   wait [--id U]... [--any] [--timeout S]
#                          block until every live unit has a sentinel, then read
#                          it AND verify the marker. A timeout is a stop naming
#                          the stalled units, never "assume done".
#                          --any returns as soon as ONE of them comes back and
#                          reports only that unit, so the caller can cleanup and
#                          refill the slot while the rest are still working --
#                          the difference between a rolling window and batches
#                          waiting on the slowest. A verdict is handed back once;
#                          a failed unit is deliberately left standing, and
#                          without that it would be re-reported forever.
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
# a decision the user already made about this code, never invent one. herdr's own
# `--trust-repository` is GIT trust and does not touch this; adopting it would
# look like it solved the trust problem and would not have.
#
# The herdr calls, and the contract each rests on. Errors arrive as JSON on
# STDERR with exit 1, usage errors exit 2, and success is JSON on stdout -- which
# is what `hd` below turns into an error CODE the callers branch on, rather than
# a row missing from a listing:
#
#   workspace create   --cwd --label --env --no-focus -> .result.workspace.workspace_id
#                      and .result.root_pane.pane_id. herdr has no --command and
#                      no --name, so the session is started INTO the root pane.
#   pane process-info  is the pane a shell that will run what I send it.
#   pane run           the one handshake, never a retry.
#   agent start        brings claude up and returns only once herdr has DETECTED
#                      it and considers it interactive-ready.
#   agent prompt       delivers the prompt as text typed into the running agent,
#                      so it is never an argv element and no shell ever parses it.
#   pane get/agent get the two liveness probes; their not-found CODES are the
#                      evidence, and a closed pane id is never reused.
#   workspace close    by workspace_id.
#
# Exit codes: 0 fine · 1 a unit failed · 2 usage/git/cleanup refused · 3 timeout ·
#             4 preflight refused · 127 a required binary is missing.
#
# Env: FANOUT_TIMEOUT (default 14400s) · FANOUT_POLL (default 10s).
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

say()  { echo "fanout: $*" >&2; }
die()  { say "$*"; exit "${2:-2}"; }

require_bin() {
  command -v "$1" >/dev/null 2>&1 || {
    say "required command not found: $1"
    exit 127
  }
}
require_bin git

sub=${1:-}
[ -n "$sub" ] && shift || die "usage: fanout.sh <preflight|spawn|wait|status|cleanup> [...]"

git rev-parse --show-toplevel >/dev/null 2>&1 || die "not inside a git repo"
git_dir=$(cd "$(git rev-parse --git-dir)" && pwd)
common_dir=$(cd "$(git rev-parse --git-common-dir)" && pwd)
[ "$git_dir" = "$common_dir" ] && tree_mode=primary || tree_mode=worktree

# Keyed on the common dir, so every unit of one repo shares one registry however
# many worktrees are open, and two repos never see each other's units.
state="${TMPDIR:-/tmp}/fanout-$(printf '%s' "$common_dir" | shasum | cut -c1-12)"
mkdir -p "$state"
# The handshake below interpolates a state path into a shell command line sent to
# the unit's pane. Every part of that path is constrained -- the hash is hex and
# `--id` is checked against [A-Za-z0-9._-] -- EXCEPT whatever TMPDIR happens to
# be. A TMPDIR with a space in it is the one way that line becomes a quoting bug
# again, so refuse it out loud rather than re-introduce an escaper to survive it.
case $state in
  *[!A-Za-z0-9._/-]*) die "the state directory '$state' contains a character this script will not put on a command line — set TMPDIR to a path matching [A-Za-z0-9._/-]" ;;
esac

rec()      { printf '%s/%s.rec' "$state" "$1"; }
sentinel() { printf '%s/%s.sentinel' "$state" "$1"; }
# Written by the CHILD, before it execs claude. See `started` in spawn below.
startmark() { printf '%s/%s.started' "$state" "$1"; }

# There is no shell quoter here, and that is the design rather than an omission.
#
# The prompt is a DOCUMENTED input that callers compose as free prose, and prose about a checklist
# quotes the checklist. Any form that puts it on a command line has to escape it, and an escaper is
# a thing that can be got wrong again: an observed spawn hit `<port>`, which zsh read as an input
# redirection, and the child sat at a `quote>` continuation prompt forever. Nothing caught it -- a
# shell WAS running, so `status` said live for twenty minutes and `wait` would have blocked on a
# sentinel nobody was going to write.
#
# So the prompt never reaches a command line at all. `agent start` brings claude up with FLAGS only
# and `agent prompt` types the prompt into the running agent, which is measured to arrive
# byte-identical -- `$HOME` included, unexpanded, which is the proof that no shell parsed it. Do not
# "save a call" by passing it after `--`: that hands the text to herdr's own command-line
# construction, which is the one thing this script cannot verify from outside. It also retires the
# `--add-dir` ordering hazard, because there is no longer a positional for a variadic flag to eat.

# Every herdr call goes through here, because the thing callers branch on is the error CODE and it
# arrives on stderr while the answer arrives on stdout. Sets HD_OUT (stdout), HD_MSG and HD_CODE
# (parsed from the error JSON); returns herdr's own status -- 1 for a server error, 2 for a usage
# error. An unparseable stderr leaves HD_CODE empty, which every caller treats as "cannot tell"
# rather than as any particular failure.
HD_OUT=; HD_MSG=; HD_CODE=
hd() {
  local err rc=0
  err=$(mktemp "$state/.hd.XXXXXX")
  HD_OUT=$(herdr "$@" 2>"$err") || rc=$?
  HD_MSG=$(cat "$err"); rm -f "$err"
  HD_CODE=$(printf '%s' "$HD_MSG" | python3 -c 'import sys,json
try: print(json.load(sys.stdin)["error"]["code"])
except Exception: pass' 2>/dev/null)
  return $rc
}

# Pull one nested field out of HD_OUT. Absent or unparseable prints nothing, so a caller testing
# for emptiness gets "herdr did not tell me" and never a stale or guessed value.
hd_field() {
  printf '%s' "$HD_OUT" | python3 -c 'import sys,json
try:
    v=json.load(sys.stdin)
    for k in sys.argv[1:]: v=v[k]
    print(v)
except Exception: pass' "$@" 2>/dev/null
}

# herdr agent names are [a-z][a-z0-9_-]{0,31} and unique across the whole SERVER, not per repo. Two
# repos fanning out `phase-1` at the same time would collide, and the second `agent start` is a hard
# refusal. So the name is scoped by the repo it belongs to, and RECORDED in the unit's rec rather
# than recomputed later -- cleanup and the liveness probe must address the agent this spawn actually
# named, whatever the unit id looked like.
repo_tag=$(printf '%s' "$common_dir" | shasum | cut -c1-6)
agent_name() {
  printf 'u%s-%s' "$repo_tag" "$(printf '%s' "$1" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9_-' '-')" | cut -c1-32
}

# Closing is idempotent by intent: a workspace that is already gone is a slot that is already free.
# The one failure that must NOT be smoothed over is a group close -- it would take the primary
# workspace and every linked-worktree workspace with it, which under a fan-out is the orchestrator's
# own window and this unit's wave-mates. herdr 0.9.0's CLI has no --group flag to reach for anyway,
# and its own skill forbids adding one as a bypass. A cleanup that cannot free a slot says so.
close_workspace() {                 # close_workspace <workspace_id>; 0 = closed or already gone
  local ws=$1
  [ -n "$ws" ] || return 0
  hd workspace close "$ws" && return 0
  case $HD_CODE in
    workspace_not_found) return 0 ;;
    workspace_group_close_required)
      say "herdr will not close $ws on its own (workspace_group_close_required): $HD_MSG"
      say "close it from herdr, then re-run cleanup. This script does not pass --group."
      return 1 ;;
    *) say "herdr workspace close $ws failed (${HD_CODE:-no code}): $HD_MSG"; return 1 ;;
  esac
}
# Written by `wait --any` when it hands a unit's verdict back, and removed with
# the unit by `cleanup`. It exists because the caller is REQUIRED to leave a
# failed unit standing -- workspace open, worktree in place, since that state is
# the only evidence of what went wrong -- so a failed unit keeps its rec, stays
# live, and would be handed back by every later `--any` call, forever, while its
# wave-mates finished unseen. Tracking it here rather than asking the caller to
# narrow the set by hand is the same choice the rest of this script makes: a
# judgement that fails by looping silently belongs in the script.
reported() { printf '%s/%s.reported' "$state" "$1"; }

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

# --- test-app fixtures -------------------------------------------------------
# `git worktree add` checks out TRACKED files only, and the generated /test-app skill keeps
# the things it needs to reach a live target -- a kubeconfig, a cluster env file, the
# credentials file -- on gitignored paths. `r:test-app-create` is what put them there: it
# writes `test_creds.txt` and adds it to the project's .gitignore itself. So a unit's tree
# holds the skill and not what the skill reads, and its UI verification is blocked on every
# unit of every credentialed project -- which subtracts from the merge gate, on every run,
# without ever looking like a fan-out problem.
#
# Copy them, but NOT every ignored file under the skill: most of them are that skill's own
# accumulated OUTPUT -- captured frames and screenshots from earlier runs, 169 of 172 on the
# project this was found on. Copying those hands a unit a predecessor's captured screen to
# read as this run's evidence, which is the same confident-wrong-answer this script exists
# to stop.
#
# The discriminator is the skill's own tracked text: an ignored file whose basename is named
# by one of the skill directory's TRACKED files is an input the skill reads; one nothing
# names is something it wrote. Ask the skill, rather than guessing from the layout -- a
# project invents its own fixture paths (`cluster/kubeconfig.yaml` is not a name this pack
# could have known), so any pack-side list of names would be a guess that silently misses.
#
# Every file is named out loud, copied or not. A fan-out that quietly restored a capability
# is as hard to reason about as one that quietly lost it, and a fixture that could NOT be
# copied is exactly what the unit needs to hear before it discovers an unexplained missing
# file mid-review.
copy_test_app_fixtures() {
  local dir=$1 skill=.claude/skills/test-app
  [ -d "$skill" ] || return 0

  local tracked; tracked=$(git ls-files -- "$skill/" 2>/dev/null) || return 0
  [ -n "$tracked" ] || return 0

  local ignored; ignored=$(git ls-files --others --ignored --exclude-standard -- "$skill/" 2>/dev/null)
  [ -n "$ignored" ] || return 0

  local f base copied=0 failed=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    [ -f "$f" ] || continue
    base=${f##*/}
    printf '%s\n' "$tracked" | tr '\n' '\0' \
      | xargs -0 grep -qF -- "$base" 2>/dev/null || continue
    if mkdir -p "$dir/${f%/*}" 2>/dev/null && cp -p "$f" "$dir/$f" 2>/dev/null; then
      copied=$((copied + 1)); say "spawn: copied test-app fixture '$f' into the unit tree (gitignored, so the checkout has none)"
    else
      failed=$((failed + 1)); say "spawn: could NOT copy test-app fixture '$f' — this unit's runtime verification is DEGRADED and will block, not pass"
    fi
  done <<EOF
$ignored
EOF
  [ "$copied" = 0 ] && [ "$failed" = 0 ] && return 0
  return 0
}

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
  # `herdr status` is the tempting gate and it is the wrong one: it EXITS 0 with no server running,
  # so gating on it passes here and fails at every spawn instead -- the same confident wrong answer,
  # moved one step later where it costs more. `workspace list` is the exact call `unit_gone`,
  # `status` and `spawn` all depend on, so a probe that passes has tested the path that matters
  # rather than a proxy for it. `herdr status` still earns a place as DIAGNOSTICS underneath.
  #
  # HERDR_ENV=1 is deliberately NOT required. herdr's own skill gates on it to stop a model reaching
  # into a session it is not part of; this script creates its own workspaces, records their handles
  # in its own repo-keyed registry and closes only what it made. An orchestrator legitimately runs
  # from a plain terminal while the server is up, and refusing that would refuse a working fan-out.
  if ! command -v herdr >/dev/null 2>&1; then
    say "herdr is not on PATH — the fan-out cannot run. Install it (https://herdr.dev), or re-run without --herdr."
    bad=1
  elif ! hd workspace list; then
    say "herdr is installed but not reachable (${HD_CODE:-no error code}): $HD_MSG"
    say "the fan-out needs a running herdr server. \`herdr status\` reports:"
    herdr status 2>&1 | sed 's/^/  /' >&2
    bad=1
  elif [ -z "$(hd_field result workspaces)" ] && [ "$(hd_field result type)" != workspace_list ]; then
    say "herdr answered, but not with a workspace list — refusing to guess what it meant: $(printf '%s' "$HD_OUT" | head -c 200)"
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
  # A NAMED SKIP, never a refusal. herdr's per-unit agent state comes from Claude Code's own hook,
  # and without it the sidebar shows units without saying what they are doing. Completion is decided
  # by the sentinel and the branch marker and never by agent_status, so a missing hook costs
  # legibility and nothing else -- which is exactly the case for saying so and continuing.
  # Captured first and matched from a here-string, never piped into `grep -q`. Under `pipefail` that
  # pipe reports the WRITER's death, and `grep -q` exits the moment it matches: herdr lists a dozen
  # integrations, `claude` sits third, so the remaining lines hit a closed pipe, herdr dies of
  # SIGPIPE (141), and the pipeline fails ON A MATCH. The skip then fires on every single run,
  # telling the user to install something already installed -- the kind of false alarm that trains a
  # reader to ignore the line that will one day be real.
  local integ; integ=$(herdr integration status 2>/dev/null) || integ=
  grep -q '^claude: current' <<<"$integ" \
    || say "preflight: herdr's claude integration is not installed, so the sidebar will not show unit agent state. Units still spawn, are waited on and are closed normally — completion rests on the sentinel and the branch marker. \`herdr integration install claude\` fixes the display."
  echo "preflight ok (primary tree, clean, herdr reachable at ${HERDR_SOCKET_PATH:-the default session socket}, $(live_count)/$MAX_UNITS units live)"
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

  # --dir is canonicalised ONCE, here, before anything consumes it, because its three consumers
  # resolve a relative path against three different directories. `git worktree add` and
  # `trust_worktree` resolve against this script's cwd; herdr resolves `workspace create --cwd`
  # against the SERVER's. So `--dir ../repo-g1` builds and trusts the worktree at the right path
  # while the workspace opens at the server's cwd -- a path Claude Code has no trust decision for,
  # so the session lands on the trust dialog, never reaches its prompt, and `agent start` times out
  # as agent_not_ready. Every diagnostic upstream reads healthy, which makes it look like a herdr
  # fault rather than an argument-handling one. An absolute value also keeps the recorded `dir=`
  # meaningful for `cleanup` and `--land`, which run later and may run from elsewhere.
  # The PARENT is resolved physically because it exists and the unit's own directory does not yet;
  # a lexical collapse of `..` would be wrong wherever the caller's cwd runs through a symlink.
  local dparent
  dparent=$(cd "$(dirname "$dir")" 2>/dev/null && pwd -P) || dparent=
  [ -n "$dparent" ] || die "spawn: --dir '$dir' has no existing parent directory to hold the worktree"
  dir="$dparent/$(basename "$dir")"
  [ -e "$(rec "$id")" ] && die "spawn: unit '$id' already exists — cleanup first"

  local n; n=$(live_count)
  [ "$n" -ge "$MAX_UNITS" ] && die "spawn: $n units already live, the cap is $MAX_UNITS — wait for one to finish, then cleanup it" 4

  # A marker file git cannot read is a gate that can never pass. `unit_verdict`
  # reads the marker with `git show "<branch>:<file>"`, so a backlog on an ignored
  # or simply untracked path -- a repo that gitignores its issues directory is the
  # ordinary case -- returns `no-marker` for a unit that fixed, reviewed and
  # committed its group cleanly, and that reads as a broken fix rather than as a
  # missing file. Drop the marker here instead: the sentinel and the branch are then
  # the whole signal, exactly as they already are for a GitHub source that has no
  # backlog file at all. Say it out loud, because a gate that quietly weakened
  # itself is indistinguishable from one that held.
  if [ -n "$mfile" ] && ! git cat-file -e "$base:$mfile" 2>/dev/null; then
    say "spawn: '$mfile' is not tracked at $base — no branch can carry a marker in it, so unit '$id' is verified by its sentinel and branch alone"
    mfile=; mprefix=
  fi

  require_bin herdr
  [ -e "$dir" ] && die "spawn: $dir already exists — remove the stale worktree first"

  # The unit loads the INSTALLED pack, while this script runs from whichever root the orchestrator
  # reached it by. A spawner and a SKILL.md that disagree about the sentinel variable produce a wave
  # of units that never report and a `wait` that reads every one of them as live until the four-hour
  # timeout -- four hours to learn that ./install.sh was not re-run. Check it here, where it costs a
  # second and names the fix.
  if [ -n "$PACK_ROOT" ] && [ -f "$PACK_ROOT/skills/plan-run/SKILL.md" ] \
     && ! grep -q FANOUT_SENTINEL "$PACK_ROOT/skills/plan-run/SKILL.md"; then
    die "spawn: the pack at $PACK_ROOT does not name FANOUT_SENTINEL, so its units would never report. Run ./install.sh." 4
  fi

  local aname; aname=$(agent_name "$id")
  case $aname in
    [a-z]*) : ;;
    *) die "spawn: '--id $id' yields the herdr agent name '$aname', which must match [a-z][a-z0-9_-]{0,31} — start the id with a letter" ;;
  esac
  # Truncation at 32 chars can make two long ids collide inside one repo, and a live name belonging
  # to somebody else's wave is worse still. Refuse rather than address an agent this spawn did not
  # start: silently taking over a live session is the worst outcome available here.
  if hd agent get "$aname"; then
    die "spawn: the herdr agent name '$aname' is already live — another unit or another fan-out holds it; use a shorter or more distinct --id"
  fi

  git worktree add --detach "$dir" "$base" >/dev/null \
    || die "spawn: git worktree add --detach '$dir' '$base' failed"

  copy_test_app_fixtures "$dir"

  # Without this the session opens on the trust dialog instead of the prompt, and
  # the unit stalls until the wait times out — every time, on every unit.
  trust_worktree "$dir" || {
    git worktree remove --force "$dir" >/dev/null 2>&1 || true
    die "spawn: could not mark $dir as a trusted workspace — the session would stall on the trust dialog"
  }

  local sfile; sfile=$(sentinel "$id")
  rm -f "$sfile"
  local startf; startf=$(startmark "$id")
  rm -f "$startf"

  local ws pane
  # The unit is told who spawned it, so it can raise an alarm UPWARDS to a known
  # address. That direction needs no discovery -- which is the whole reason it is
  # the only messaging direction wired here.
  local envs=(--env "FANOUT_SENTINEL=$sfile")
  [ -n "$orch" ] && envs+=(--env "FANOUT_ORCHESTRATOR=$orch")
  if ! hd workspace create --cwd "$dir" --label "$id" "${envs[@]}" --no-focus; then
    git worktree remove --force "$dir" >/dev/null 2>&1 || true
    die "spawn: herdr workspace create failed (${HD_CODE:-no code}): $HD_MSG"
  fi
  ws=$(hd_field result workspace workspace_id)
  pane=$(hd_field result root_pane pane_id)
  if [ -z "$ws" ] || [ -z "$pane" ]; then
    git worktree remove --force "$dir" >/dev/null 2>&1 || true
    die "spawn: herdr workspace create named no workspace or no root pane (got: $(printf '%s' "$HD_OUT" | head -c 200))"
  fi

  # A pane that EXISTS is not a shell that RUNS COMMANDS. Text sent to a pty before the shell is
  # reading it is at best queued behind its startup and at worst redrawn away by the line editor,
  # and `agent start` has the same precondition -- it requires the pane to be at an interactive
  # prompt. Every one of those failures leaves a LIVE PANE behind, which is the one shape `status`
  # cannot tell from a working unit. So the shell is waited for on evidence: a shell pid exists and
  # nothing but that shell holds the foreground. Measured at 85ms on herdr 0.9.0, so 15s is not a
  # budget anything healthy comes near.
  local waited=0
  while [ "$waited" -lt 15 ]; do
    hd pane process-info --pane "$pane" && printf '%s' "$HD_OUT" | python3 -c 'import sys,json
p=json.load(sys.stdin)["result"]["process_info"]
sp=p.get("shell_pid")
fg=[x for x in p.get("foreground_processes",[]) if x.get("pid")!=sp]
sys.exit(0 if sp and not fg else 1)' 2>/dev/null && break
    sleep 1; waited=$((waited + 1))
  done

  # ONE handshake, never a retry loop. A second `pane run` issued because the first looked lost is
  # text that arrives late and gets typed into the agent that started in between -- a wave whose
  # units each hold a stray line of shell in their prompt box. The child writes this marker itself,
  # so what it proves is independent of herdr's view of itself: this pane is a shell that runs what
  # I send it.
  hd pane run "$pane" "printf ok > $startf" || true
  waited=0
  while [ ! -f "$startf" ] && [ "$waited" -lt 15 ]; do sleep 1; waited=$((waited + 1)); done
  if [ ! -f "$startf" ]; then
    # Rolling back means calling herdr again, and `hd` sets HD_CODE/HD_MSG globally -- so anything
    # still needed from the failure is read off before the rollback overwrites it.
    close_workspace "$ws" || say "spawn: workspace $ws is still open and will now point at a removed directory — close it by hand"
    git worktree remove --force "$dir" >/dev/null 2>&1 || true
    die "spawn: unit '$id' has a pane but no shell that runs commands — the handshake never landed within ${waited}s. Its pane is live, so a status check would have called this unit healthy; refusing to report it as spawned."
  fi

  # Flags only. The prompt is delivered separately below, and must never appear here -- see the note
  # where shq used to be. Both spellings of the pack root, so the unit can run the canonical
  # pipelines rather than discovering at its implement step that it cannot reach them.
  local cargs=(--permission-mode auto)
  [ -n "$PACK_ROOT" ] && cargs+=(--add-dir "$PACK_ROOT")
  [ -n "$PACK_ROOT_REAL" ] && [ "$PACK_ROOT_REAL" != "$PACK_ROOT" ] && cargs+=(--add-dir "$PACK_ROOT_REAL")
  # `claude` interactive, never -p: -p would exit on its own and hand back a transcript nobody is
  # sitting in, and the whole point of a unit is that it stays watchable and can be taken over.
  # agent start returns only once herdr has DETECTED claude and considers it interactive-ready,
  # which is a stronger claim than the handshake above and is why both are kept.
  if ! hd agent start "$aname" --kind claude --pane "$pane" --timeout 120000 -- "${cargs[@]}"; then
    local why="(${HD_CODE:-no code}): $HD_MSG"   # read BEFORE the rollback's own hd calls clear it
    close_workspace "$ws" || say "spawn: workspace $ws is still open — close it by hand"
    git worktree remove --force "$dir" >/dev/null 2>&1 || true
    die "spawn: unit '$id' never started — herdr could not bring claude up in $pane $why"
  fi

  # NAMED, not enforced: herdr's readiness contract reads a terminal, while a foreground process
  # called claude is a fact about the machine. A shim or a wrapper is not proof of failure, but
  # silence about the disagreement would be.
  #
  # Read `argv0`, not `name`. herdr's `name` is the process's own TITLE, and Claude Code sets that
  # to its bare version string -- a healthy unit reports {"argv0":"claude","name":"2.1.263"}, so a
  # test on `name` alone fires this warning on every spawn of every wave. `name` is kept as the
  # second half of an `or` because a build that does not retitle itself still answers there.
  hd pane process-info --pane "$pane" \
    && printf '%s' "$HD_OUT" | python3 -c 'import sys,json
p=json.load(sys.stdin)["result"]["process_info"]
sys.exit(0 if any(x.get("argv0")=="claude" or x.get("name")=="claude" for x in p.get("foreground_processes",[])) else 1)' 2>/dev/null \
    || say "spawn: '$id' started per herdr, but no claude process holds $pane's foreground — watch this unit"

  # The prompt, as text typed into a running agent. Never retried: herdr documents that a timeout or
  # agent_prompt_stalled does NOT prove the prompt was undelivered, so a retry can double-send into
  # a session that already has the work. No --wait either -- completion here is the sentinel and the
  # marker, and waiting on an observed state would put a screen-derived judgement back in the path.
  if ! hd agent prompt "$aname" "$prompt"; then
    local why="(${HD_CODE:-no code}): $HD_MSG"   # read BEFORE the rollback's own hd calls clear it
    close_workspace "$ws" || say "spawn: workspace $ws is still open — close it by hand"
    git worktree remove --force "$dir" >/dev/null 2>&1 || true
    die "spawn: unit '$id' came up but would not take its prompt $why"
  fi

  {
    printf 'id=%s\n' "$id"
    printf 'dir=%s\n' "$dir"
    printf 'base=%s\n' "$base"
    printf 'workspace=%s\n' "$ws"
    printf 'pane=%s\n' "$pane"
    printf 'agent=%s\n' "$aname"
    printf 'sentinel=%s\n' "$sfile"
    printf 'started=%s\n' "$startf"
    printf 'marker_file=%s\n' "$mfile"
    printf 'marker_prefix=%s\n' "$mprefix"
    printf 'orchestrator=%s\n' "$orch"
  } > "$(rec "$id")"

  echo "$id workspace=$ws pane=$pane agent=$aname dir=$dir sentinel=$sfile"
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
# Says "gone" ONLY on evidence, and gets two kinds of it that herdr answers directly rather than by
# absence from a listing:
#
#   * a closed PANE id is never reused, so `pane get` answering pane_not_found is proof that THIS
#     pane is gone, not merely that an id stopped resolving. Workspace ids are not what liveness is
#     decided on -- they are kept for `close` and for the report.
#   * an AGENT name is cleared when its agent exits, so agent_not_found over a LIVE pane catches the
#     case a workspace-level probe cannot see: claude died and left the shell standing. That unit is
#     not thinking, and waiting it out costs the whole four-hour timeout to learn something that was
#     true in the first minute.
#
# Everything else is "cannot tell": the server down, an unparseable answer, an error code this
# script does not know, a unit whose pane or agent was never recorded. Declaring a whole wave dead
# because herdr hiccuped is the confident wrong answer this script exists to refuse.
unit_gone() {                       # unit_gone <pane_id> <agent_name>
  local pane=$1 aname=$2
  [ -n "$pane" ] || return 1
  if ! hd pane get "$pane"; then
    [ "$HD_CODE" = pane_not_found ] && return 0
    return 1
  fi
  [ -n "$aname" ] || return 1
  if ! hd agent get "$aname"; then
    [ "$HD_CODE" = agent_not_found ] && return 0
    return 1
  fi
  return 1
}

# --- wait --------------------------------------------------------------------
# Two shapes, and the difference is what the caller can do next.
#
#   wait          blocks until EVERY unit in the set has a sentinel, then reports
#                 all of them. Right for a wave being landed as a unit.
#   wait --any    blocks until AT LEAST ONE unit in the set comes back, reports
#                 exactly those, and returns. This is what makes the window
#                 actually roll: the caller cleans that unit up, spawns the next
#                 queued one into the freed slot, and calls again -- rather than
#                 holding three slots hostage to the slowest of the three. There
#                 is no way to build it out of the other subcommands, because the
#                 only alternative is polling `status`, and deciding "is it done
#                 yet" by re-reading a report on a timer is precisely the
#                 confident-wrong-answer shape this script exists to remove from
#                 the caller.
do_wait() {
  local ids=() timeout=${FANOUT_TIMEOUT:-14400} poll=${FANOUT_POLL:-10} any=0
  while [ $# -gt 0 ]; do
    case $1 in
      --id)      ids+=("${2:-}"); shift 2 ;;
      --any)     any=1;           shift   ;;
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

  local waited=0 pending ready
  while :; do
    pending=(); ready=()
    for id in "${ids[@]}"; do
      if [ -e "$(sentinel "$id")" ]; then
        if [ "$any" = 1 ] && [ ! -e "$(reported "$id")" ]; then ready+=("$id"); fi
      else
        pending+=("$id")
      fi
    done
    if [ "$any" = 1 ]; then
      # Good news already in hand is delivered before anything else is judged: a
      # unit that finished is not made less finished by a wave-mate whose session
      # died, and that one is still there to be caught on the next call.
      if [ ${#ready[@]} -gt 0 ]; then
        local arc=0 av
        for id in "${ready[@]}"; do
          : > "$(reported "$id")"
          av=$(unit_verdict "$id")
          echo "$id $av"
          case $av in failed*) arc=1 ;; esac
        done
        return $arc
      fi
      # Nothing pending and nothing unreported: every unit in the set has already
      # been handed back once. Say so and return rather than blocking for four
      # hours on units that are not going to change -- a caller that lost its
      # place recovers with `status`, which reports regardless of this flag.
      if [ ${#pending[@]} -eq 0 ]; then
        echo "no unreported units — every unit in the set has already been handed back; cleanup the ones that are done, or read status"
        return 0
      fi
    else
      [ ${#pending[@]} -eq 0 ] && break
    fi
    local dead=() r
    for id in "${pending[@]}"; do
      r=$(rec "$id")
      unit_gone "$(field "$r" pane)" "$(field "$r" agent)" && dead+=("$id")
    done
    if [ ${#dead[@]} -gt 0 ]; then
      say "session gone with no sentinel: ${dead[*]}"
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
  local id any=0 r
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    any=1
    r=$(rec "$id")
    echo "$id $(unit_verdict "$id") workspace=$(field "$r" workspace) agent=$(field "$r" agent) dir=$(field "$r" dir)"
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

  local dir ws; dir=$(field "$r" dir); ws=$(field "$r" workspace)
  if [ -d "$dir" ] && [ -n "$(git -C "$dir" status --porcelain 2>/dev/null)" ]; then
    die "cleanup: $dir has uncommitted changes — '$id' did not finish, and removing it would remove the only record of what it was doing"
  fi
  # The close comes FIRST and a failure stops here, before the worktree or the rec is touched. A
  # slot that could not be freed must not be reported as freed, and the rec is what `status` and the
  # cap read to know the unit is still holding one.
  close_workspace "$ws" || die "cleanup: '$id' still holds its slot — its worktree and rec are left in place"
  [ -d "$dir" ] && git worktree remove "$dir" >/dev/null 2>&1 || true
  git worktree prune >/dev/null 2>&1 || true
  rm -f "$r" "$(sentinel "$id")" "$(reported "$id")"
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
