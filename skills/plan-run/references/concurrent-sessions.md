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

`--dry-run` prints these lines filled in for every wave that has more than one unbuilt leaf, and
`--cmux` runs them instead of printing them.

## The same recipe, driven

`--cmux` is the automated form of the block above — same worktrees, same `--no-merge`, same `--land`,
same `--slice` preflight in front of all of it. What it removes is the typing and the watching:

```sh
FAN="${CLAUDE_PLUGIN_ROOT}/skills/plan-run/scripts/cmux-fanout.sh"

"$FAN" preflight                                    # cmux reachable · primary tree · clean tree
"$FAN" spawn --id phase-5 --dir ../billing-p5 --base main \
       --marker-file docs/billing/todo.md --marker-prefix 'built: ' \
       --prompt "/r:plan-run docs/billing/todo.md --phases 5 --no-merge --yes"
"$FAN" wait                                         # blocks; exit 3 = a unit stalled, and is named
"$FAN" cleanup --id phase-5                         # closes the workspace, removes the worktree
```

`spawn` opens a cmux workspace holding a **full interactive `claude` session**, not `claude -p`. The
session is watchable and a human can answer a prompt inside it or take it over — which is the whole
reason the fan-out goes through cmux rather than through background processes.

**Workspace trust is per path, and a worktree is a new path.** Left alone, every unit would open on
the trust dialog and sit there until the wait timed out — not sometimes, every time. So `spawn`
copies the repo's own `hasTrustDialogAccepted` onto the worktree it just created, and `preflight`
refuses when the repo itself carries no such decision. The fan-out inherits a judgement the user
already made about this code; it never makes one on their behalf.

An interactive session never exits, so **completion is reported, not observed**, and the report needs
two independent signals:

| signal | written by | catches |
|---|---|---|
| the sentinel at `CMUX_FANOUT_SENTINEL` | Step 3.6 / 3.7 of the child's own run | a session still working, and a run that halted |
| the `built: <branch>` marker on the branch | the child's tick, read by `wait` and by `--land` | a session that reported success and never committed |

Neither alone is enough. A sentinel can be written by a run that then failed to commit; a missing
marker can just mean the unit is not done yet.

## The alarm channel

`spawn --orchestrator <name>` puts `CMUX_FANOUT_ORCHESTRATOR` in the unit's environment, so a unit
can `SendMessage` **upwards** to the session that spawned it. Only that direction is wired, and the
reason is discovery: a unit knows exactly who spawned it, while addressing a unit from the
orchestrator means prefix-matching an unpredictable session name (`cmuxtest-p1-81`) against every
session on the machine.

| a unit sends when | the orchestrator does |
|---|---|
| the slice is wrong — it needs a file outside its `Files:` | **halt the wave** and fix the plan's edges; this is the collision the preflight exists to prevent |
| it is blocked on something the plan can answer | answer it — the orchestrator holds the whole plan |
| it is halting | act on the sentinel; the message is what saves the other units an hour |

Nothing else. Progress reports cost every other session a turn and turn a fan-out into a chat room.

**A message never closes a unit.** `wait` blocks on the sentinel and landing needs the marker,
because a unit's own account of how it went is a claim and this pipeline lands evidence — a session
can go idle having *declined* its work, which is exactly what completion-by-message would bank as a
success. The orchestrator may answer and may ask read-only checks; it must not drive, and must not
poll.

`cleanup` runs per unit **the moment that unit comes back ok**, not in a sweep at the end: a stale
worktree is what the next `spawn` collides with, a finished workspace still open is indistinguishable
in the sidebar from a working one, and the freed slot is what admits the next leaf against the cap of
three. **A failed or stalled unit is deliberately not cleaned up** — its workspace and worktree are
the only thing that has anything to say about what went wrong.

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
