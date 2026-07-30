#!/usr/bin/env bash
# FR-17 — run before every push.
#
#   ./validate.sh [--refresh-drift-baseline]
#
# The static checks, then the two packed test suites and the guard's behaviour
# tests. Exits non-zero naming every failure.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

rc=0

echo "==> static checks"
python3 tools/validate.py "$@" || rc=1

echo
echo "==> workflow control-flow tests"
for t in skills/task-run/tests/control-flow.test.mjs skills/task-review/tests/control-flow.test.mjs; do
  if out=$(node --test "$t" 2>&1); then
    printf '  ✓ %-52s %s\n' "$t" "$(grep -E '^ℹ pass' <<<"$out" | tr -s ' ')"
  else
    rc=1
    printf '  ✗ %s\n' "$t"
    grep -E '^✖|^ℹ (pass|fail)' <<<"$out" | sed 's/^/      /'
  fi
done

echo
echo "==> workflow guard"
if out=$(bash hooks/tests/guard.test.sh 2>&1); then
  printf '  ✓ %s\n' "$(tail -1 <<<"$out" | tr -s ' ')"
else
  rc=1
  sed 's/^/  /' <<<"$out"
fi

echo
if (( rc )); then
  echo "NOT ready to push."
else
  echo "Ready to push."
fi
exit $rc
