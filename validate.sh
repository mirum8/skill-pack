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
echo "==> plugin manifest (claude plugin validate)"
if command -v claude >/dev/null 2>&1; then
  # Catches things no local check can: it is the loader's own view of the pack.
  # It is what found two agents whose frontmatter silently dropped every field.
  if out=$(claude plugin validate . 2>&1) && ! grep -qi 'validation failed' <<<"$out"; then
    printf '  %s\n' "$(grep -E '✔|✘' <<<"$out" | head -1)"
  else
    rc=1
    sed 's/^/  /' <<<"$out"
  fi
else
  echo "  skipped — the claude CLI is not on PATH"
fi

echo
echo "==> workflow guard"
if out=$(bash hooks/tests/guard.test.sh 2>&1); then
  printf '  ✓ %s\n' "$(tail -1 <<<"$out" | tr -s ' ')"
else
  rc=1
  sed 's/^/  /' <<<"$out"
fi

echo
echo "==> plan graph (edges, waves, collisions, --slice preflight)"
if out=$(bash skills/spec-design/tests/check_todo.test.sh 2>&1); then
  printf '  ✓ %s\n' "$(tail -1 <<<"$out" | tr -s ' ')"
else
  rc=1
  sed 's/^/  /' <<<"$out"
fi

echo
echo "==> bundled scripts"
# Every executable a skill ships, not just the two workflows. Each of these is a real binary or a
# real decision the pipelines trust without re-deriving — a scope that resolved to the wrong files,
# a review wrapper that banked a skip as clean, a worktree stack that collided with the main one.
# All of those fail by producing a plausible answer, so a passing pipeline is not evidence.
for t in skills/spec-brainstorm/tests/check_spec.test.sh \
         skills/reuse-index/tests/reuse-index.test.sh \
         skills/code-scan/tests/local-scan.test.sh \
         skills/code-adversarial/tests/run.test.sh \
         skills/task-review/tests/worktree-deploy.test.sh \
         skills/plan-run/tests/cmux-fanout.test.sh \
         skills/test-app-create/tests/tui-session.test.sh; do
  if out=$(bash "$t" 2>&1); then
    printf '  ✓ %-52s %s\n' "${t#skills/}" "$(tail -1 <<<"$out" | tr -s ' ')"
  else
    rc=1
    printf '  ✗ %s\n' "$t"
    grep -E '^  FAIL|^     |passed,' <<<"$out" | sed 's/^/    /'
  fi
done

echo
echo "==> stats store (sink, hook, reporter)"
if out=$(bash lib/tests/stats.test.sh 2>&1); then
  printf '  ✓ %s\n' "$(tail -1 <<<"$out" | tr -s ' ')"
else
  rc=1
  sed 's/^/  /' <<<"$out"
fi

echo
echo "==> install.sh"
# ~9s, the only slow step here — it installs the pack eight times over. Skip it
# with SKIP_INSTALL_TEST=1 when iterating on something else.
if [[ -n ${SKIP_INSTALL_TEST:-} ]]; then
  echo "  skipped (SKIP_INSTALL_TEST)"
elif out=$(bash tests/install.test.sh 2>&1); then
  printf '  ✓ %s\n' "$(tail -1 <<<"$out" | tr -s ' ')"
else
  rc=1
  grep -E '^  FAIL|^     |passed,' <<<"$out" | sed 's/^/  /'
fi

echo
if (( rc )); then
  echo "NOT ready to push."
else
  echo "Ready to push."
fi
exit $rc
