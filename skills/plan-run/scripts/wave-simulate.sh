#!/usr/bin/env bash
# Dry-merge a whole wave onto base, in landing order, before any of it is merged.
#
#     wave-simulate.sh <base> <branch>...
#
# Run it inside the repo, branches in ascending phase order. Exit 0 when every branch merges clean,
# 2 when one conflicts (the branch and its conflicted files are printed), 1 on usage or git trouble.
#
# Each branch merges onto the result of the one before it, because a branch that merges onto base
# alone can still conflict with the wave-mate landing ahead of it. What carries forward is a COMMIT
# with both parents, never merge-tree's tree: the next merge-tree needs a commit to find a merge
# base, and the second parent is what lets a branch cut from its wave-mate simulate as the real
# `--no-ff` sequence would merge it.
#
# merge-tree exits 1 both on a conflict and when it could not run at all, so the exit status is
# not the verdict. A conflict is exit 1 WITH conflicted file names; anything else is an error and
# is never reported as a conflict, since a false conflict stops a clean wave with nothing merged.
#
# It writes only unreachable objects — no ref, index, working tree or MERGE_HEAD — so the caller
# merges nothing until the whole wave passes.
set -euo pipefail

if (( $# < 2 )); then
  echo "usage: wave-simulate.sh <base> <branch>..." >&2
  exit 1
fi

base=$1; shift
if ! sim=$(git rev-parse --verify -q "$base^{commit}"); then
  echo "wave-simulate: base '$base' does not resolve to a commit" >&2
  exit 1
fi

export GIT_AUTHOR_NAME=wave-simulate GIT_AUTHOR_EMAIL=wave-simulate@localhost
export GIT_COMMITTER_NAME=wave-simulate GIT_COMMITTER_EMAIL=wave-simulate@localhost

err=$(mktemp); trap 'rm -f "$err"' EXIT

for b in "$@"; do
  rc=0
  out=$(git merge-tree --write-tree --name-only "$sim" "$b" 2>"$err") || rc=$?

  if (( rc == 0 )); then
    tree=$(head -n1 <<<"$out")
    if ! sim=$(git commit-tree "$tree" -p "$sim" -p "$b" -m "wave-simulate $b" 2>"$err"); then
      echo "wave-simulate: the simulation could not run for $b:" >&2
      cat "$err" >&2
      exit 1
    fi
    continue
  fi

  names=""
  if (( rc == 1 )); then
    names=$(awk 'NR == 1 { next } /^$/ { exit } { print }' <<<"$out")
  fi

  if [[ -n $names ]]; then
    echo "CONFLICT $b:"
    printf '%s\n' "$names"
    exit 2
  fi

  echo "wave-simulate: the simulation could not run for $b (git exit $rc):" >&2
  cat "$err" >&2
  exit 1
done

echo "clean: $# branches onto $base"
