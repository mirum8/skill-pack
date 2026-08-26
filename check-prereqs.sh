#!/usr/bin/env bash
# FR-15 — report every external prerequisite as mandatory or optional.
#
#   ./check-prereqs.sh
#
# Exits non-zero ONLY when a mandatory one is missing.
#
# This does not replace the checks the skills already do at the point of use —
# code-scan/scripts/check-tools.sh names each analyzer and says which categories
# go uncovered, issues-fix gates on `gh auth status` when its source is GitHub,
# code-adversarial's wrapper reports a skip when the Codex plugin is absent. Those
# are better than any install-time check, because they fire when it matters and can say what
# coverage was lost. This aggregates them to answer the one question they cannot
# answer between them: will this pack work on this machine at all?
set -uo pipefail

missing_mandatory=0
missing_optional=0
gh_ready=0

# $1 label  $2 command to probe  $3 install line  $4 mandatory|optional
report() {
  local label=$1 probe=$2 install=$3 tier=$4
  if command -v "$probe" >/dev/null 2>&1; then
    printf '  \033[32m✓\033[0m %-14s %-9s %s\n' "$label" "$tier" "$(command -v "$probe")"
    return 0
  fi
  if [[ $tier == mandatory ]]; then
    missing_mandatory=$((missing_mandatory + 1))
    printf '  \033[31m✗\033[0m %-14s %-9s MISSING — install with: %s\n' "$label" "$tier" "$install"
  else
    missing_optional=$((missing_optional + 1))
    printf '  \033[33m!\033[0m %-14s %-9s absent — add with: %s\n' "$label" "$tier" "$install"
  fi
  return 1
}

echo "r skill pack — prerequisites"
echo

report pmd           pmd           "brew install pmd"                 mandatory
report spotbugs      spotbugs      "brew install spotbugs"            mandatory
report semgrep       semgrep       "brew install semgrep"             mandatory
report python3       python3       "brew install python"              mandatory
report node          node          "brew install node"                mandatory
report agent-browser agent-browser "npm i -g agent-browser && agent-browser install" mandatory

# tmux is optional because a terminal app is a minority of projects and its absence costs exactly
# one track, named. The CLI half of that track does not need it either: argv, exit codes,
# stdout/stderr separation, piping and signals are plain shell and deterministic without a
# terminal. Only two checks go with it — --help wrapping, and any isatty-dependent branch.
report tmux          tmux          "brew install tmux"                optional
# cmux is optional because it buys wall-clock, never coverage: --cmux drives the fan-out that
# /r:plan-run and /r:issues-fix already describe, and without it both run the serial path they run
# today and lose nothing they would otherwise have found. It is a stop rather than a skip only when
# --cmux was actually typed, because there the user asked for the thing that is missing.
report cmux          cmux          "brew install cmux"                optional

# gh is optional because GitHub is one source among several, not the floor: task-run also
# runs from a todo phase, a list item or free text and finishes with a local `--skip-pr`
# merge, and issues-fix falls back to the list file at the repo root whenever there is no
# GitHub remote or no authenticated gh. What its absence costs is named rather than worked
# around — issue sources, `gh pr create`, and closing issues on merge.
#
# Authentication is checked at the same tier, not a stricter one: gh present but logged out
# reaches exactly as far as gh absent, and both fail at the point of use rather than here.
if report gh gh "brew install gh" optional; then
  if ! gh auth status >/dev/null 2>&1; then
    missing_optional=$((missing_optional + 1))
    printf '  \033[33m!\033[0m %-14s %-9s present but NOT authenticated — run: gh auth login\n' \
      "gh auth" optional
  else
    gh_ready=1
    printf '  \033[32m✓\033[0m %-14s %-9s authenticated\n' "gh auth" optional
  fi
fi

# The codex plugin is not a binary on PATH — it is a Claude Code plugin, so its
# companion script is what tells us it is installed. This is the same lookup
# code-adversarial's wrapper does.
codex_companion() {
  local m="$HOME/.claude/plugins/marketplaces/openai-codex/plugins/codex/scripts/codex-companion.mjs"
  [[ -f $m ]] && { echo "$m"; return 0; }
  local c
  c=$(ls -1d "$HOME"/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs 2>/dev/null | sort -V | tail -n1)
  [[ -n ${c:-} && -f ${c:-} ]] && { echo "$c"; return 0; }
  return 1
}
if found=$(codex_companion); then
  printf '  \033[32m✓\033[0m %-14s %-9s %s\n' "codex plugin" optional "$found"
else
  missing_optional=$((missing_optional + 1))
  printf '  \033[33m!\033[0m %-14s %-9s absent — add with: /plugin marketplace add openai-codex, then /plugin install codex@openai-codex\n' \
    "codex plugin" optional
fi

echo
if (( missing_mandatory )); then
  echo "$missing_mandatory mandatory prerequisite(s) missing. The pipeline cannot run honestly"
  echo "without them: task-review calls code-scan on every tier and treats it as required, and"
  echo "UI verification goes through agent-browser. Install them, or run ./install.sh, which does."
  exit 1
fi

if (( missing_optional )); then
  echo "All mandatory prerequisites present. $missing_optional optional one(s) absent — the"
  echo "affected step is recorded as SKIPPED and the run continues (FR-22). It is never faked."
  if ! command -v tmux >/dev/null 2>&1; then
    echo
    echo "Without tmux, a project whose /test-app declares a terminal UI cannot be verified: the"
    echo "TUI checks are recorded as NOT RUN and named, and task-review reports that track blocked"
    echo "rather than clean. Web and command-line projects are unaffected."
  fi
  if (( ! gh_ready )); then
    echo
    echo "Without a usable gh, GitHub is simply not one of the sources. task-run runs from a todo"
    echo "phase, a list item or free text and finishes by merging the feature branch, and issues-fix"
    echo "reads the list file at the repo root. Only issue sources, gh pr create and issue-closing"
    echo "are unavailable, and each is reported as such rather than improvised."
  fi
else
  echo "All prerequisites present."
fi
exit 0
