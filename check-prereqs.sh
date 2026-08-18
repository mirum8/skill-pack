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

# gh has to be authenticated, not merely present: task-run resolves issue sources and
# opens PRs through it, and issues-fix gates its whole loop on `gh auth status` whenever
# the backlog is a GitHub one, so an unauthenticated gh fails later, not here. A run whose
# source is a markdown list needs none of it — this stays mandatory for the pack, not for
# every run.
if report gh gh "brew install gh" mandatory; then
  if ! gh auth status >/dev/null 2>&1; then
    missing_mandatory=$((missing_mandatory + 1))
    printf '  \033[31m✗\033[0m %-14s %-9s present but NOT authenticated — run: gh auth login\n' \
      "gh auth" mandatory
  else
    printf '  \033[32m✓\033[0m %-14s %-9s authenticated\n' "gh auth" mandatory
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
else
  echo "All prerequisites present."
fi
exit 0
