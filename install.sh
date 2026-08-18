#!/usr/bin/env bash
# FR-6 / FR-21 — install the r skill pack.
#
#   ./install.sh [--dry-run] [--no-deps] [--keep-originals]
#
# Five things happen, in this order:
#   1. copy the pack payload into ~/.claude/skills/r, overwriting
#   2. provision the mandatory prerequisites (skip with --no-deps)
#   3. remove the superseded global workflow-guard registration
#   4. retire the superseded flat originals (skip with --keep-originals)
#   5. say what has to happen next
#
# It COPIES rather than symlinks. A plain directory holding
# .claude-plugin/plugin.json is the documented skills-dir plugin case; whether
# plugin discovery follows a symlinked entry is documented neither way, and it
# fails identically to a malformed manifest — a namespace that is simply not
# there. The cost is that this repo and the install are two copies: edit here,
# then re-run this script to publish.
#
# Nothing in the pack is executed at install time. Step 2 fetches ordinary
# public tooling through brew and npm, and every command is echoed before it
# runs; --dry-run shows them without executing, --no-deps skips them entirely.
set -uo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DEST="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}/r"
SETTINGS="$HOME/.claude/settings.json"
DRY=0
DEPS=1
RETIRE=1

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --no-deps) DEPS=0 ;;
    --keep-originals) RETIRE=0 ;;
    -h|--help) sed -n '2,21p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# Colour only on a real terminal. Everything the test suite and any pipe sees is
# plain text, so greps keep matching the words rather than the escape codes.
if [[ -t 1 && -z ${NO_COLOR:-} ]]; then
  B=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'
  RED=$'\033[31m'; CYAN=$'\033[36m'; R=$'\033[0m'
else
  B=''; DIM=''; GREEN=''; YELLOW=''; RED=''; CYAN=''; R=''
fi

STEP=0
step() { STEP=$((STEP + 1)); printf '\n%s[%d/5] %s%s\n' "$B" "$STEP" "$*" "$R"; }
say()  { printf '      %s\n' "$*"; }
ok()   { printf '      %s✓%s %s\n' "$GREEN" "$R" "$*"; }
note() { printf '      %s·%s %s\n' "$DIM" "$R" "$*"; }
warn() { printf '      %s!%s %s\n' "$YELLOW" "$R" "$*" >&2; }
die()  { printf '      %s✗ %s%s\n' "$RED" "$*" "$R" >&2; }

run() {
  printf '      %s$ %s%s\n' "$DIM" "$*" "$R"
  (( DRY )) || "$@"
}

printf '%sr skill pack%s %s→%s %s\n' "$B" "$R" "$DIM" "$R" "$DEST"
(( DRY )) && printf '%sdry run — every command is shown, none is executed%s\n' "$YELLOW" "$R"

# The payload only. docs/, tools/, validate.sh and .git stay in the repo — the
# install needs what Claude Code loads, nothing else.
PAYLOAD=(.claude-plugin skills agents hooks lib check-prereqs.sh)

step "copy the pack"
if [[ -e $DEST && ! -f $DEST/.claude-plugin/plugin.json ]]; then
  die "REFUSING: $DEST exists but is not a previous install of this pack."
  say "The copy would delete whatever is in it. Move it aside first." >&2
  exit 1
fi
if [[ -e $DEST ]] && ! grep -q '"name"[[:space:]]*:[[:space:]]*"r"' "$DEST/.claude-plugin/plugin.json" 2>/dev/null; then
  die "REFUSING: $DEST holds a plugin that is not named \"r\"."
  exit 1
fi

UPDATE=0
[[ -e $DEST ]] && UPDATE=1

run mkdir -p "$DEST"
for item in "${PAYLOAD[@]}"; do
  if [[ ! -e "$REPO/$item" ]]; then
    die "MISSING from the repo: $item — build the pack first (tools/build-pack.py)."
    exit 1
  fi
  # __pycache__ is excluded because running any packed python — the stats sink, the hooks —
  # leaves one behind in the REPO, and copying it would ship a build artefact that the repo
  # itself gitignores.
  if command -v rsync >/dev/null 2>&1; then
    run rsync -a --delete --exclude __pycache__ "$REPO/$item" "$DEST/"
  else
    run rm -rf "$DEST/$item"
    run cp -R "$REPO/$item" "$DEST/"
    run find "$DEST/$item" -name __pycache__ -type d -prune -exec rm -rf {} +
  fi
done
ok "${#PAYLOAD[@]} items copied: ${PAYLOAD[*]}"

step "mandatory prerequisites"
if (( DEPS )); then
  MISSING_BREW=()
  for tool in pmd spotbugs semgrep; do
    command -v "$tool" >/dev/null 2>&1 || MISSING_BREW+=("$tool")
  done
  if (( ${#MISSING_BREW[@]} )); then
    if command -v brew >/dev/null 2>&1; then
      run brew install "${MISSING_BREW[@]}"
    else
      warn "Homebrew is not installed, so ${MISSING_BREW[*]} cannot be provisioned here."
      say  "Install them however this machine provisions software, then re-run with --no-deps." >&2
    fi
  else
    ok "pmd, spotbugs, semgrep already present"
  fi

  if command -v agent-browser >/dev/null 2>&1; then
    ok "agent-browser already present"
  elif command -v npm >/dev/null 2>&1; then
    run npm i -g agent-browser
    run agent-browser install
  else
    warn "npm is not installed, so agent-browser cannot be provisioned here."
  fi
else
  note "skipped (--no-deps)"
fi

step "superseded global guard registration"
# The pack ships its own copy of the workflow guard, wired from hooks/hooks.json
# and allow-listing $CLAUDE_PLUGIN_ROOT. A second copy registered globally still
# hard-codes two ~/.claude/skills paths and blocks by content, so it would keep
# refusing the packed pipelines no matter what the packed guard permits — they
# could neither run nor be built.
if [[ -f $SETTINGS ]] && grep -q 'post-task-review/scripts/guard-workflow.py' "$SETTINGS"; then
  if (( DRY )); then
    printf '      %s$ %s%s\n' "$DIM" "cp $SETTINGS $SETTINGS.bak-<timestamp>" "$R"
    printf '      %s$ %s%s\n' "$DIM" "python3 - (remove the guard-workflow.py PreToolUse hook from $SETTINGS)" "$R"
  else
    cp "$SETTINGS" "$SETTINGS.bak-$(date +%Y%m%d%H%M%S)"
    python3 - "$SETTINGS" <<'PY'
import json, sys
path = sys.argv[1]
cfg = json.load(open(path))
hooks = cfg.get("hooks", {})
removed = 0
for event, entries in list(hooks.items()):
    kept_entries = []
    for entry in entries:
        kept = [h for h in entry.get("hooks", [])
                if "post-task-review/scripts/guard-workflow.py" not in (h.get("command") or "")]
        removed += len(entry.get("hooks", [])) - len(kept)
        if kept:
            kept_entries.append({**entry, "hooks": kept})
    if kept_entries:
        hooks[event] = kept_entries
    else:
        del hooks[event]
json.dump(cfg, open(path, "w"), indent=2)
open(path, "a").write("\n")
print(f"      removed {removed} global guard registration(s); a .bak was written alongside")
PY
  fi
else
  note "none registered — nothing to remove"
fi

step "superseded flat originals"
# R-4 / ADR-13. The pack renames every skill it carries (run-task -> task-run, find-bugs ->
# code-bugs, …) and installs them under one namespaced root. The pre-pack originals keep their old
# FLAT names in the roots below, so while they survive every packed skill has a twin: an edit can
# land in the wrong copy, and the old bare name still resolves to the OLD behaviour — which is the
# more visible half, because a renamed skill that is "fully replaced" is not replaced at all while
# its ancestor still answers. Publishing the pack without retiring them is what leaves R-4 open, so
# this belongs to installing rather than to a chore someone remembers later.
#
# Both lists come from tools/rename_rules.py, the same table validate.py checks the result against,
# so a skill added to the pack is retired from the old roots by that one edit rather than by two
# that can drift apart. If the table cannot be read, retire NOTHING and say so: a delete loop
# running on an empty list of names is the one outcome here that is worse than doing nothing.
if (( RETIRE )); then
  ORIG_NAMES=$(python3 -c 'import sys; sys.path.insert(0, sys.argv[1]); import rename_rules as R; print("\n".join(sorted(R.RENAME)))' "$REPO/tools" 2>/dev/null)
  ORIG_ROOTS=$(python3 -c 'import sys; sys.path.insert(0, sys.argv[1]); import rename_rules as R; print("\n".join(R.ORIGINAL_ROOTS))' "$REPO/tools" 2>/dev/null)
  if [[ -z $ORIG_NAMES || -z $ORIG_ROOTS ]]; then
    warn "could not read tools/rename_rules.py — nothing was retired."
    say  "Re-run from a full checkout, or pass --keep-originals to stop being asked." >&2
  else
    DEST_REAL=$(cd "$DEST" 2>/dev/null && pwd -P)
    RETIRED=0
    while IFS= read -r root; do
      base="${root/#\~/$HOME}"
      [[ -d $base ]] || continue
      while IFS= read -r name; do
        victim="$base/$name"
        [[ -d $victim ]] || continue
        # Two guards, and both have a job. SKILL.md keeps a same-named directory that is not a
        # skill at all out of the loop; the realpath test keeps the pack we have just written out
        # of it, since one root is the very directory the pack installs into.
        [[ -f "$victim/SKILL.md" ]] || continue
        victim_real=$(cd "$victim" && pwd -P)
        # Compare on path BOUNDARIES, never as a bare string prefix: the pack installs to
        # .../skills/r, and "r" is a prefix of "run-task" and "refactor" — two real originals that
        # a `== "$DEST_REAL"*` test silently spares while reporting success.
        [[ -n $DEST_REAL && ( $victim_real == "$DEST_REAL" || $victim_real == "$DEST_REAL"/* ) ]] && continue
        run rm -rf "$victim"
        RETIRED=$((RETIRED + 1))
      done <<< "$ORIG_NAMES"
    done <<< "$ORIG_ROOTS"
    if (( RETIRED )); then
      ok "$RETIRED superseded original(s) retired — the pack is now the only copy"
    else
      note "none found — the pack is already the only copy"
    fi
  fi
else
  note "skipped (--keep-originals) — the old flat names still resolve to the old skills"
fi

step "next"
"$REPO/check-prereqs.sh" >/dev/null 2>&1 && PREREQ=ok || PREREQ=incomplete
if (( UPDATE )); then
  ok  "Updated in place."
  say "SKILL.md edits are live immediately; anything else — agents/, hooks/,"
  say ".mcp.json — needs ${CYAN}/reload-plugins${R}."
else
  ok  "Installed — but nothing loads until the NEXT session."
  say "Skills-dir plugins are discovered at session start, never mid-session."
  say "Restart, then check that ${CYAN}/plugin${R} lists ${CYAN}r@skills-dir${R} and that"
  say "${CYAN}/r:${R} autocompletes seventeen skills."
fi
if [[ $PREREQ == ok ]]; then
  ok "prerequisites: ok"
else
  warn "prerequisites: incomplete — run ./check-prereqs.sh for the detail."
fi
(( DRY )) && printf '\n%sThis was a --dry-run. Nothing above was executed.%s\n' "$YELLOW" "$R"
echo
exit 0
