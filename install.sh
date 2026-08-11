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

# Colour only on a real terminal. Everything the test suite and any pipe sees is
# plain text, so greps keep matching the words rather than the escape codes.
if [[ -t 1 && -z ${NO_COLOR:-} ]]; then
  B=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'
  RED=$'\033[31m'; CYAN=$'\033[36m'; R=$'\033[0m'
else
  B=''; DIM=''; GREEN=''; YELLOW=''; RED=''; CYAN=''; R=''
fi

STEP=0
step() { STEP=$((STEP + 1)); printf '\n%s[%d/4] %s%s\n' "$B" "$STEP" "$*" "$R"; }
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
  say "${CYAN}/r:${R} autocompletes sixteen skills."
fi
if [[ $PREREQ == ok ]]; then
  ok "prerequisites: ok"
else
  warn "prerequisites: incomplete — run ./check-prereqs.sh for the detail."
fi
(( DRY )) && printf '\n%sThis was a --dry-run. Nothing above was executed.%s\n' "$YELLOW" "$R"
echo
exit 0
