#!/usr/bin/env bash
# FR-6 / FR-21 — install the r skill pack.
#
#   ./install.sh [--dry-run] [--no-deps]
#
# Four things happen, in this order:
#   1. copy the pack payload into ~/.claude/skills/r, overwriting
#   2. provision the mandatory prerequisites (skip with --no-deps)
#   3. remove the superseded global workflow-guard registration
#   4. say what has to happen next
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

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --no-deps) DEPS=0 ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

run() {
  printf '  $ %s\n' "$*"
  (( DRY )) || "$@"
}

# The payload only. docs/, tools/, validate.sh and .git stay in the repo — the
# install needs what Claude Code loads, nothing else.
PAYLOAD=(.claude-plugin skills agents hooks check-prereqs.sh)

echo "==> 1. copy the pack into $DEST"
if [[ -e $DEST && ! -f $DEST/.claude-plugin/plugin.json ]]; then
  echo "  REFUSING: $DEST exists but is not a previous install of this pack." >&2
  echo "  The copy would delete whatever is in it. Move it aside first." >&2
  exit 1
fi
if [[ -e $DEST ]] && ! grep -q '"name"[[:space:]]*:[[:space:]]*"r"' "$DEST/.claude-plugin/plugin.json" 2>/dev/null; then
  echo "  REFUSING: $DEST holds a plugin that is not named \"r\"." >&2
  exit 1
fi

UPDATE=0
[[ -e $DEST ]] && UPDATE=1

run mkdir -p "$DEST"
for item in "${PAYLOAD[@]}"; do
  if [[ ! -e "$REPO/$item" ]]; then
    echo "  MISSING from the repo: $item — build the pack first (tools/build-pack.py)." >&2
    exit 1
  fi
  if command -v rsync >/dev/null 2>&1; then
    run rsync -a --delete "$REPO/$item" "$DEST/"
  else
    run rm -rf "$DEST/$item"
    run cp -R "$REPO/$item" "$DEST/"
  fi
done

echo "==> 2. mandatory prerequisites"
if (( DEPS )); then
  MISSING_BREW=()
  for tool in pmd spotbugs semgrep; do
    command -v "$tool" >/dev/null 2>&1 || MISSING_BREW+=("$tool")
  done
  if (( ${#MISSING_BREW[@]} )); then
    if command -v brew >/dev/null 2>&1; then
      run brew install "${MISSING_BREW[@]}"
    else
      echo "  Homebrew is not installed, so ${MISSING_BREW[*]} cannot be provisioned here." >&2
      echo "  Install them however this machine provisions software, then re-run with --no-deps." >&2
    fi
  else
    echo "  pmd, spotbugs, semgrep already present"
  fi

  if command -v agent-browser >/dev/null 2>&1; then
    echo "  agent-browser already present"
  elif command -v npm >/dev/null 2>&1; then
    run npm i -g agent-browser
    run agent-browser install
  else
    echo "  npm is not installed, so agent-browser cannot be provisioned here." >&2
  fi
else
  echo "  skipped (--no-deps)"
fi

echo "==> 3. superseded global guard registration"
# The pack ships its own copy of the workflow guard, wired from hooks/hooks.json
# and allow-listing $CLAUDE_PLUGIN_ROOT. A second copy registered globally still
# hard-codes two ~/.claude/skills paths and blocks by content, so it would keep
# refusing the packed pipelines no matter what the packed guard permits — they
# could neither run nor be built.
if [[ -f $SETTINGS ]] && grep -q 'post-task-review/scripts/guard-workflow.py' "$SETTINGS"; then
  if (( DRY )); then
    echo "  $ python3 - (remove the guard-workflow.py PreToolUse hook from $SETTINGS)"
    echo "  $ cp $SETTINGS $SETTINGS.bak-<timestamp>"
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
print(f"  removed {removed} global guard registration(s); a .bak was written alongside")
PY
  fi
else
  echo "  none registered — nothing to remove"
fi

echo "==> 4. next"
"$REPO/check-prereqs.sh" >/dev/null 2>&1 && PREREQ=ok || PREREQ=incomplete
if (( UPDATE )); then
  echo "  Updated in place. SKILL.md edits are live immediately; anything else —"
  echo "  agents/, hooks/, .mcp.json — needs /reload-plugins."
else
  echo "  Installed. Nothing loads until the NEXT session: skills-dir plugins are"
  echo "  discovered at session start, never mid-session. Restart, then check that"
  echo "  /plugin lists  r@skills-dir  and that /r: autocompletes fifteen skills."
fi
echo "  Prerequisites: $PREREQ (run ./check-prereqs.sh for the detail)."
(( DRY )) && echo "  This was a --dry-run. Nothing above was executed."
exit 0
