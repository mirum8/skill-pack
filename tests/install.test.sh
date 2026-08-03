#!/usr/bin/env bash
# Behaviour tests for install.sh (FR-6, FR-21).
#
#   bash tests/install.test.sh
#
# Every case runs against a throwaway HOME. The real ~/.claude is never touched,
# and the last check asserts that. install.sh both copies with --delete and
# edits settings.json, so testing it against a live home would be the one thing
# it must never do.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
REPO=$PWD
REAL_HOME=$HOME

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0

# Snapshot the real home before anything runs, so the last cases can prove it
# was untouched by comparison rather than by assertion. The pack may legitimately
# be installed there, so what is asserted is "unchanged", never "absent" — an
# earlier version asserted absence and started failing the moment the pack was
# installed for real, which is the check being wrong, not the suite.
cp "$REAL_HOME/.claude/settings.json" "$TMP/settings-before" 2>/dev/null || : > "$TMP/settings-before"
BAKS_BEFORE=$(ls "$REAL_HOME/.claude/" 2>/dev/null | grep -c 'settings.json.bak-')
realpack() {
  [[ -d "$REAL_HOME/.claude/skills/r" ]] || { echo absent; return; }
  find "$REAL_HOME/.claude/skills/r" -type f -exec shasum -a 256 {} + | sort | shasum -a 256
}
PACK_BEFORE=$(realpack)

ok()   { pass=$((pass + 1)); printf '  ok   %s\n' "$1"; }
bad()  { fail=$((fail + 1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }
is()   { [[ "$2" == "$3" ]] && ok "$1" || bad "$1" "got '$2', wanted '$3'"; }
has()  { [[ -e "$2" ]] && ok "$1" || bad "$1" "missing: $2"; }
hasnt(){ [[ ! -e "$2" ]] && ok "$1" || bad "$1" "should not exist: $2"; }

# A fresh scratch home whose settings.json ALWAYS carries the guard registration
# and at least one unrelated hook, so the deregistration cases are deterministic.
# Seeding it from the real settings.json alone was a mistake: once the real
# install had removed the registration, four checks silently stopped running and
# a mutant that skipped deregistration entirely went uncaught.
newhome() {
  local h="$TMP/home$1"
  rm -rf "$h"; mkdir -p "$h/.claude/skills"
  python3 - "$REAL_HOME/.claude/settings.json" "$h/.claude/settings.json" <<'PY'
import json, sys
try:
    cfg = json.load(open(sys.argv[1]))
except Exception:
    cfg = {}
hooks = cfg.setdefault("hooks", {})
hooks.setdefault("Stop", []).append(
    {"matcher": "*", "hooks": [{"type": "command", "command": "echo unrelated-hook"}]})
hooks.setdefault("PreToolUse", []).append({
    "matcher": "Workflow|Write|Edit",
    "hooks": [{"type": "command",
               "command": 'python3 "$HOME/.claude/skills/post-task-review/scripts/guard-workflow.py"',
               "timeout": 10}]})
json.dump(cfg, open(sys.argv[2], "w"), indent=2)
PY
  echo "$h"
}
run() { local h=$1; shift; HOME="$h" bash "$REPO/install.sh" "$@" 2>&1; }

echo "install.sh"

# --- 1. --dry-run executes nothing ------------------------------------------
H=$(newhome dry)
cp "$H/.claude/settings.json" "$TMP/seeded-settings"   # what it looked like going in
out=$(run "$H" --dry-run)
hasnt "--dry-run creates nothing"                  "$H/.claude/skills/r"
is    "--dry-run says so"                          "$(grep -c 'was a --dry-run' <<<"$out")" 1
is    "--dry-run still echoes the copy commands"   "$(grep -c 'rsync\|cp -R' <<<"$out")" 5
is    "--dry-run leaves settings.json alone" \
      "$(cmp -s "$H/.claude/settings.json" "$TMP/seeded-settings" && echo same || echo CHANGED)" same
is    "--dry-run writes no backup" \
      "$(ls "$H/.claude/" | grep -c 'settings.json.bak-')" 0

# --- 2. a fresh install -----------------------------------------------------
H=$(newhome fresh)
out=$(run "$H" --no-deps)
D="$H/.claude/skills/r"
has  "the manifest lands"                          "$D/.claude-plugin/plugin.json"
is   "fifteen skills land"                         "$(ls "$D/skills" | wc -l | tr -d ' ')" 15
is   "nine agents land"                            "$(ls "$D/agents" | wc -l | tr -d ' ')" 9
has  "the guard hook lands"                        "$D/hooks/guard-workflow.py"
has  "hooks.json lands"                            "$D/hooks/hooks.json"
has  "check-prereqs.sh lands"                      "$D/check-prereqs.sh"
is   "it says a restart is needed"                 "$(grep -c 'NEXT session' <<<"$out")" 1
is   "the payload is byte-identical to the repo" \
     "$(diff -r "$REPO/skills" "$D/skills" >/dev/null && echo same)" same

# --- 3. the payload is the payload, not the repo ----------------------------
hasnt "docs/ is not shipped"                       "$D/docs"
hasnt "tools/ is not shipped"                      "$D/tools"
hasnt "validate.sh is not shipped"                 "$D/validate.sh"
hasnt "the git history is not shipped"             "$D/.git"
hasnt "install.sh does not ship itself"            "$D/install.sh"

# --- 4. --no-deps skips provisioning ----------------------------------------
is   "--no-deps says it skipped"                   "$(grep -c 'skipped (--no-deps)' <<<"$out")" 1
is   "--no-deps runs no brew"                      "$(grep -c '\$ brew' <<<"$out")" 0
is   "--no-deps runs no npm"                       "$(grep -c '\$ npm' <<<"$out")" 0

# --- 5. the guard deregistration (FR-20) ------------------------------------
is "the global guard registration is removed" \
   "$(grep -c 'post-task-review/scripts/guard-workflow.py' "$H/.claude/settings.json")" 0
is "a backup is written first" \
   "$(ls "$H/.claude/" | grep -c 'settings.json.bak-')" 1
is "the backup still has the registration" \
   "$(grep -c 'post-task-review/scripts/guard-workflow.py' "$H"/.claude/settings.json.bak-*)" 1
is "settings.json is still valid JSON" \
   "$(python3 -c "import json;json.load(open('$H/.claude/settings.json'));print('ok')")" ok
is "the unrelated hook survives" \
   "$(grep -c 'unrelated-hook' "$H/.claude/settings.json")" 1

# --- 6. re-running updates in place -----------------------------------------
out=$(run "$H" --no-deps)
is   "a second run reports an update, not an install" "$(grep -c 'Updated in place' <<<"$out")" 1
is   "a second run names /reload-plugins"          "$(grep -c 'reload-plugins' <<<"$out")" 1
is   "fifteen skills, still"                       "$(ls "$D/skills" | wc -l | tr -d ' ')" 15
is   "the second guard removal is a no-op"         "$(grep -c 'nothing to remove' <<<"$out")" 1

# --- 7. the copy DELETES what the repo dropped ------------------------------
# The whole reason it is a copy and not a merge: a skill deleted from the repo
# has to disappear from the install, or the pack drifts a file at a time.
touch "$D/skills/ghost-skill.md"
mkdir -p "$D/skills/ghost-dir"
run "$H" --no-deps >/dev/null
hasnt "a stray file is deleted on the next install"  "$D/skills/ghost-skill.md"
hasnt "a stray directory is deleted too"             "$D/skills/ghost-dir"

# --- 8. it refuses to wipe something that is not this pack ------------------
H2=$(newhome stranger)
mkdir -p "$H2/.claude/skills/r"
echo 'do not delete me' > "$H2/.claude/skills/r/important.txt"
out=$(run "$H2" --no-deps); rc=$?
is   "refusing exits non-zero"                     "$rc" 1
is   "refusing says why"                           "$(grep -c 'REFUSING' <<<"$out")" 1
has  "the stranger's file survives"                "$H2/.claude/skills/r/important.txt"

# a directory holding some OTHER plugin is refused too
H3=$(newhome otherplugin)
mkdir -p "$H3/.claude/skills/r/.claude-plugin"
echo '{"name":"not-r"}' > "$H3/.claude/skills/r/.claude-plugin/plugin.json"
out=$(run "$H3" --no-deps); rc=$?
is   "a differently-named plugin is refused"       "$rc" 1
is   "and it says which check failed"              "$(grep -c 'not named' <<<"$out")" 1

# --- 9. the cp -R fallback works when rsync is absent -----------------------
H4=$(newhome norsync)
# A complete PATH minus rsync. Shadowing it is not enough — appending the real
# directories back would let `command -v rsync` find it again, which is exactly
# what this test got wrong the first time and why it passed while proving nothing.
mkdir -p "$TMP/nopath"
for d in /usr/bin /bin /usr/sbin /sbin /opt/homebrew/bin; do
  [[ -d $d ]] || continue
  for p in "$d"/*; do
    n=${p##*/}
    [[ $n == rsync || -e "$TMP/nopath/$n" ]] && continue
    ln -sf "$p" "$TMP/nopath/$n" 2>/dev/null
  done
done
is   "the no-rsync PATH really has no rsync" \
     "$(PATH="$TMP/nopath" command -v rsync >/dev/null 2>&1 && echo found || echo absent)" absent
out=$(HOME="$H4" PATH="$TMP/nopath" bash "$REPO/install.sh" --no-deps 2>&1)
is   "without rsync it falls back to cp -R"        "$(grep -c '\$ cp -R' <<<"$out")" 5
is   "and still lands fifteen skills"              "$(ls "$H4/.claude/skills/r/skills" | wc -l | tr -d ' ')" 15

# --- 10. argument handling --------------------------------------------------
H5=$(newhome args)
out=$(run "$H5" --nonsense); rc=$?
is   "an unknown option exits 2"                   "$rc" 2
hasnt "an unknown option installs nothing"         "$H5/.claude/skills/r"
out=$(run "$H5" --help); rc=$?
is   "--help exits 0"                              "$rc" 0
is   "--help explains the flags"                   "$(grep -c 'dry-run' <<<"$out")" 1
hasnt "--help installs nothing"                    "$H5/.claude/skills/r"

# --- 11. it stops if the pack was never built -------------------------------
BARE="$TMP/bare"; mkdir -p "$BARE"
cp "$REPO/install.sh" "$BARE/"; cp "$REPO/check-prereqs.sh" "$BARE/"
H6=$(newhome bare)
out=$(HOME="$H6" bash "$BARE/install.sh" --no-deps 2>&1); rc=$?
is   "an unbuilt repo exits non-zero"              "$rc" 1
is   "and says what is missing"                    "$(grep -c 'MISSING from the repo' <<<"$out")" 1

# --- 12. the installed copy is a working plugin -----------------------------
# The point of installing at all: the copy has to load, and the guard has to
# resolve its allow-list from the INSTALLED location, not the repo.
D="$H/.claude/skills/r"
if command -v claude >/dev/null 2>&1; then
  is "claude plugin validate passes on the installed copy" \
     "$(cd "$D" && claude plugin validate . 2>&1 | grep -c 'Validation passed')" 1
fi
canon="$D/skills/task-review/task-review.workflow.js"
rcx=$(CLAUDE_PLUGIN_ROOT="$D" python3 -c "
import json,sys;print(json.dumps({'tool_name':'Workflow','tool_input':{'scriptPath':'$canon'}}))" \
  | CLAUDE_PLUGIN_ROOT="$D" python3 "$D/hooks/guard-workflow.py" >/dev/null 2>&1; echo $?)
is   "the installed guard allows the installed pipeline" "$rcx" 0
# A fork has to exist on disk for the guard to read it — passing a scriptPath to
# a file that is not there is correctly treated as some other workflow, which is
# what this test asserted the first time round.
cp "$canon" "$TMP/fork.workflow.js"
rcx=$(python3 -c "
import json;print(json.dumps({'tool_name':'Workflow','tool_input':{'scriptPath':'$TMP/fork.workflow.js'}}))" \
  | CLAUDE_PLUGIN_ROOT="$D" python3 "$D/hooks/guard-workflow.py" >/dev/null 2>&1; echo $?)
is   "the installed guard refuses a forked scriptPath" "$rcx" 2
rcx=$(python3 -c "
import json;print(json.dumps({'tool_name':'Workflow','tool_input':{'script':open('$canon').read()}}))" \
  | CLAUDE_PLUGIN_ROOT="$D" python3 "$D/hooks/guard-workflow.py" >/dev/null 2>&1; echo $?)
is   "the installed guard refuses an inline fork"  "$rcx" 2

# --- 13. the real home was never touched ------------------------------------
is   "the real ~/.claude/skills/r is untouched" "$(realpack)" "$PACK_BEFORE"
is   "the real settings.json is byte-for-byte unchanged" \
     "$(cmp -s "$TMP/settings-before" "$REAL_HOME/.claude/settings.json" && echo same || echo CHANGED)" same
is   "no stray backup was left in the real home" \
     "$(ls "$REAL_HOME/.claude/" 2>/dev/null | grep -c 'settings.json.bak-')" "$BAKS_BEFORE"

printf '\n  %d passed, %d failed\n' "$pass" "$fail"
[[ "$fail" == 0 ]]
