# Building phases concurrently, one session each

A plan written by `/r:spec-design` carries a `**Depends on:**` edge on every leaf. Leaves that share
no dependency land in the same derived **wave**, and the checker guarantees a wave's members name no
file in common. Those are the leaves that can be built at the same time.

This file is the mechanics. The reasoning lives in `SKILL.md`; what is here is what to type and why
each part is not negotiable.

## The one git fact everything follows from

A linked worktree **cannot check out a branch the primary tree already holds**:

```
$ git worktree add ../billing-p5 main
fatal: 'main' is already used by worktree at '/…/billing'
```

So `git checkout <base> && git merge --no-ff <branch>` — Step 3.6's finish — simply cannot run from
a second session. Detaching is allowed, because it claims no ref:

```
$ git worktree add --detach ../billing-p5 main
Preparing worktree (detached HEAD 3f9a1c2)
```

From there `git checkout -b phase-<slug>` works normally, and two such worktrees commit to two
branches without touching each other. That is the whole basis of this mode: **concurrent sessions
build and commit; they never merge.**

## The recipe

```sh
# once per phase in the wave, each in its own terminal
git worktree add --detach ../billing-p5 main
cd ../billing-p5
/r:plan-run docs/billing/todo.md --phases 5 --no-merge

# after they all finish, from the PRIMARY tree
cd ../billing
/r:plan-run docs/billing/todo.md --land

# then, once landed
git worktree remove ../billing-p5
```

`--dry-run` prints these lines filled in for every wave that has more than one unbuilt leaf.

## Which tree am I in

```sh
[ "$(git rev-parse --git-dir)" != "$(git rev-parse --git-common-dir)" ]   # true => linked worktree
```

In the primary tree the two are equal (`.git`); in a linked worktree `--git-dir` points inside
`.git/worktrees/<name>`. `--no-merge` requires a linked worktree; `--land` requires the primary one.
Both refuse otherwise, because both failures are quiet: a `--no-merge` run in the primary tree
strands the user's own checkout on a phase branch, and `--land` from a worktree cannot check out
base at all.

## Why the preflight refuses things

```sh
python3 "${CLAUDE_PLUGIN_ROOT}/skills/spec-design/scripts/check_todo.py" <plan> --slice 5,6
```

Three refusals, each a real collision:

| refusal | what would happen without it |
|---|---|
| a dependency is not built yet | the phase builds on code that does not exist on base |
| a dependency is **inside the same slice** | two sessions build one on top of the other, concurrently |
| two slice members share a file | both edit it from different bases; whichever lands second conflicts or silently reverts the first |

It deliberately reports nothing about plan quality. A missing `Implements:` line is worth fixing, and
is not worth blocking three sessions that are about to start.

**If the checker cannot run, stop.** Everywhere else in this pack a missing tool is a named skip and
the run continues — here it is a halt, because nothing else verifies the slice, and the failure it
prevents is two agents writing the same file at once.

## `--land`, and why it reads a marker

Branches are `phase-<slug>`, never `phase-<n>`, so the slug alone cannot say which phase a branch
built. The mapping comes from the marker the run wrote on the heading when it ticked the phase:

```sh
git branch --list 'phase-*' --format='%(refname:short)' |
while read -r b; do
  git merge-base --is-ancestor "$b" main && continue     # already landed
  git show "$b":docs/billing/todo.md | grep -n "built: $b"
done
```

Reading the plan **on that branch** works without checking anything out, which matters because the
primary tree is holding base and must keep holding it.

**A branch with no marker is skipped and named in the report.** It is a halted run or an unrelated
branch matching the glob — and merging it would land work whose review never finished.

Then merge in **ascending phase order**, one at a time. That is a valid dependency order because the
plan's numbering is a topological sort of the graph — the rule `spec-design` enforces when it refuses
a leaf that depends on a higher-numbered one.

## The plan file

Every phase ticks it, so it is the one file every branch touches — which is why the wave collision
check excludes it. In practice git merges the ticks cleanly: separate phases occupy separate regions
of the document, and a textual merge handles them.

When two phases sit close enough that the regions overlap, the resolution is always **both sides'
ticks**. Each branch ticked what it genuinely built and verified, and neither tick makes the other
untrue. Never resolve by taking one side wholesale — that silently un-ticks finished work, and the
next run offers that phase again.
