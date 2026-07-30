#!/usr/bin/env bash
# Report which local analyzers are present and how to install the rest.
# Exit 1 if python3 is missing (the orchestrator can't run) or no analyzer is
# available; exit 0 only when python3 plus at least one analyzer are present.

set -u

present=0
report() {
  local tool="$1" install="$2"
  if command -v "$tool" >/dev/null 2>&1; then
    printf "  ✓ %-9s %s\n" "$tool" "$($tool --version 2>/dev/null | head -1)"
    present=$((present + 1))
  else
    printf "  ✗ %-9s missing — install with: %s\n" "$tool" "$install"
  fi
}

echo "Local analyzers:"
report pmd      "brew install pmd"
report spotbugs "brew install spotbugs"
report semgrep  "brew install semgrep   # or: pipx install semgrep"

echo
if ! command -v python3 >/dev/null 2>&1; then
  echo "  ✗ python3 missing — required to run the orchestrator; cannot proceed"
  exit 1
fi

if [[ $present -eq 0 ]]; then
  echo "No analyzers installed. Install at least one (all three recommended): brew install pmd spotbugs semgrep"
  exit 1
fi
[[ $present -lt 3 ]] && echo "Note: running with a subset — missing tools' categories won't be covered."
exit 0
