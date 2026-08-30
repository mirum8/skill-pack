# Building phases concurrently, one session each

A plan written by `/r:spec-design` carries a `**Depends on:**` edge on every leaf. Leaves that share
no dependency land in the same derived **wave**, and the checker guarantees a wave's members name no
file in common — those can be built at the same time.

This file is the mechanics: what to type, and why each part is not negotiable. The reasoning lives
in `SKILL.md`.

## The one git fact everything follows from

A linked worktree **cannot check out a branch the primary tree already holds**:

```
$ git worktree add ../billing-p5 main
fatal: 'main' is already used by worktree at '/…/billing'
```

So Step 3.6's `git checkout <base> && git merge --no-ff <branch>` cannot run from a second session.
Detaching is allowed, because it claims no ref:

```
$ git worktree add --detach ../billing-p5 main
Preparing worktree (detached HEAD 3f9a1c2)
```

From there `git checkout -b phase-<slug>` works normally, and two such worktrees commit to two
branches without touching each other. That is the basis of this mode: **concurrent sessions build
and commit; they never merge.**

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

`--dry-run` prints these lines filled in for every wave with more than one unbuilt leaf; `--cmux`
runs them instead.

## The same recipe, driven

`--cmux` is the automated form of the block above — same worktrees, same `--no-merge`, same `--land`,
same `--slice` preflight in front of all of it:

```sh
FAN="${CLAUDE_PLUGIN_ROOT}/skills/plan-run/scripts/cmux-fanout.sh"

"$FAN" preflight                                    # cmux reachable · primary tree · clean tree
"$FAN" spawn --id phase-5 --dir ../billing-p5 --base main \
       --marker-file docs/billing/todo.md --marker-prefix 'built: ' \
       --prompt "/r:plan-run docs/billing/todo.md --phases 5 --no-merge --yes"
"$FAN" wait                                         # blocks; exit 3 = a unit stalled, and is named
"$FAN" cleanup --id phase-5                         # closes the workspace, removes the worktree
```

`spawn` opens a cmux workspace holding a **full interactive `claude` session**, not `claude -p`: a
human can watch it, answer a prompt inside it or take it over — the reason the fan-out goes through
cmux rather than background processes.

**Workspace trust is per path, and a worktree is a new path.** Left alone, every unit would open on
the trust dialog and sit there until the wait timed out. So `spawn` copies the repo's own
`hasTrustDialogAccepted` onto the worktree it just created, and `preflight` refuses when the repo
itself carries no such decision: the fan-out inherits a judgement the user already made, never
makes one on their behalf.

An interactive session never exits, so **completion is reported, not observed**, and the report needs
two independent signals:

| signal | written by | catches |
|---|---|---|
| the sentinel at `CMUX_FANOUT_SENTINEL` | Step 3.6 / 3.7 of the child's own run | a session still working, and a run that halted |
| the `built: <branch>` marker on the branch | the child's tick, read by `wait` and by `--land` | a session that reported success and never committed |

Neither alone is enough: a sentinel can be written by a run that then failed to commit, and a
missing marker can just mean the unit is not done yet.

## The alarm channel

`spawn --orchestrator <name>` puts `CMUX_FANOUT_ORCHESTRATOR` in the unit's environment, so a unit
can `SendMessage` **upwards** to the session that spawned it. Downwards works too: `spawn` creates
the workspace with `--name "$id"`, and that orchestrator-chosen id is the name `SendMessage`
addresses. Ids repeat across projects, so disambiguate by the `[ref]` `ListAgents` prints beside a
row.

| a unit sends when | the orchestrator does |
|---|---|
| it is about to write a file outside its `Files:` | **record it** against that phase and reply "continue" — the declaration was written before the code existed, so this is the normal case, not a fault |
| …and a second unit reports the same file | **halt the wave**: two clean bases about to edit one file is the collision the preflight exists to prevent |
| it is blocked on something the plan can answer | answer it — the orchestrator holds the whole plan |
| a test it did not write is failing | it is a spec decision, not a phase decision — take it to a person |
| it is halting | act on the sentinel; the message is what saves the other units an hour |

Nothing else. Progress reports cost every other session a turn and turn a fan-out into a chat room.

**The union of the reported files is the wave's real footprint**, and only the orchestrator can hold
it: a unit sees one worktree. It accumulates while the wave is still running, the only window in
which a collision is cheap — the merge is hours too late to be told.

**Downwards carries two things: `stop`, and the answer to a question that unit asked.** Never work,
and never a correction to what it builds — a message from the orchestrator reads as authority, so
"ask, never drive" binds harder in this direction. It exists so a unit that lost a collision hears
about it in a minute rather than at the merge.

**A message never closes a unit.** `wait` blocks on the sentinel and landing needs the marker,
because a unit's own account is a claim and this pipeline lands evidence — a session can go idle
having *declined* its work, which is exactly what completion-by-message would bank as a success.
The orchestrator may answer and may ask read-only checks; it must not drive, and must not poll.

`cleanup` runs per unit **the moment that unit comes back ok**, not in a sweep at the end: a stale
worktree is what the next `spawn` collides with, a finished workspace still open looks like a
working one, and the freed slot admits the next leaf against the cap of three. **A failed or
stalled unit is deliberately not cleaned up** — its workspace and worktree are the only evidence of
what went wrong.

## Which tree am I in

```sh
[ "$(git rev-parse --git-dir)" != "$(git rev-parse --git-common-dir)" ]   # true => linked worktree
```

In the primary tree the two are equal (`.git`); in a linked worktree `--git-dir` points inside
`.git/worktrees/<name>`. `--no-merge` requires a linked worktree; `--land` requires the primary one.
Both refuse otherwise, because both failures are quiet: a `--no-merge` run in the primary tree
strands the user's checkout on a phase branch, and `--land` from a worktree cannot check out base.

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

It deliberately reports nothing about plan quality: a missing `Implements:` line is worth fixing,
not worth blocking three sessions about to start.

**If the checker cannot run, stop.** Everywhere else in this pack a missing tool is a named skip —
here it is a halt, because nothing else verifies the slice, and the failure it prevents is two
agents writing the same file at once.

## What the checker cannot know, and who asks instead

```sh
python3 "${CLAUDE_PLUGIN_ROOT}/skills/plan-run/scripts/footprint-warn.py" <plan> --slice 5,6 --base main
```

The refusals above all read the plan's `Files:` lines. Those are written before any code exists, so
they name the files a feature **carries** and never the ones it must touch to be **wired in**; in a
UI every feature wires in at the same few places. One phase declared three files and changed
eleven; the slice was cleared honestly and the wave would not merge.

This asks the other question — in the packages this slice lands in, what has every phase before it
actually touched — off git history rather than a prediction, so it needs no model and runs
unasked.

| exit | means | what to do |
|---|---|---|
| 0 | clean, or not enough history to judge — it says which | continue |
| 2 | a package is claimed by two leaves and its hub files are undeclared | serial: print and continue · `--cmux`: **stop** |
| 1 | usage or git trouble | a named skip; this improves the preflight, it is not the preflight |

`--cmux` is the strict one because that is where being wrong is expensive: serially it costs one
merge conflict, across a wave every hour the wave spent building.

Two answers to an exit 2, and the report names both: run one leaf per package at a time, or correct
the `Files:` lines from the code that now exists. Step 3.6 does the second for every phase it
commits, so this warning fades as the plan fills in.

## `--land`, and why it reads a marker

Branches are `phase-<slug>`, never `phase-<n>`, so the slug alone cannot say which phase a branch
built. The mapping is the marker the run wrote on the heading when it ticked the phase:

```sh
git branch --list 'phase-*' --format='%(refname:short)' |
while read -r b; do
  git merge-base --is-ancestor "$b" main && continue     # already landed
  git show "$b":docs/billing/todo.md | grep -n "built: $b"
done
```

Reading the plan **on that branch** needs no checkout, which matters because the primary tree is
holding base and must keep holding it.

**A branch with no marker is skipped and named in the report.** It is a halted run or an unrelated
branch matching the glob, and merging it would land work whose review never finished.

Then merge in **ascending phase order**, one at a time — a valid dependency order because the plan's
numbering is a topological sort of the graph, the rule `spec-design` enforces when it refuses a leaf
that depends on a higher-numbered one.

## Simulate the whole wave before merging any of it

`git merge-tree` answers "would this merge" without a working tree, an index or a checkout, so the
whole wave is testable in seconds:

```sh
sim=$(git rev-parse main)
for b in "${ordered[@]}"; do
  if ! out=$(git merge-tree --write-tree --name-only "$sim" "$b"); then
    echo "CONFLICT landing $b:"; sed -n '2,$p' <<<"$out"; exit 1   # line 1 is the tree oid
  fi
  sim=$(head -1 <<<"$out")                                        # merge the next one onto this
done
```

Carrying `sim` forward is the point: a branch that merges onto `main` may still conflict with the
branch landing before it, and pairwise checks against a fixed base never see that. **Merge nothing
until the loop finishes** — merging until the first conflict leaves a wave half-landed, and every
remaining branch faces a base the simulation never cleared.

## Build between merges

The merge loop runs the project's build after each merge and stops on red. A clean merge is not a
compiling tree: two phases can add the same package-level symbol in different files — no file
collides, both branches build alone, and the merged tree does not compile — and nothing else in the
pipeline looks at the merged tree before the next branch lands on it.

## The plan file

Every phase ticks it, so it is the one file every branch touches — which is why the wave collision
check excludes it. Git merges the ticks cleanly while separate phases occupy separate regions of the
document.

When two phases sit close enough that the regions overlap, the resolution is always **both sides'
ticks**: each branch ticked what it genuinely built and verified, and neither tick makes the other
untrue. Never resolve by taking one side wholesale — that silently un-ticks finished work, and the
next run offers that phase again.

## The reuse index is refreshed after the wave, never inside it

The other always-shared file, and the one the plan file's rule does **not** extend to. No unit writes
it: `/r:task-review` skips its refresh in a linked worktree, and this is where it is made good — one
`/r:reuse-index` from the primary tree after the last merge, as its own commit, skipped silently when
the project has no index.

The difference from the plan file is what makes both-sides wrong here. A tick is a fact the branch
owns, so a union of ticks is exactly true. The index is **derived** from the whole `.task-plans/`
corpus, so a unit regenerating it from a base without its wave-mates' plans rewrites the same rows
every other unit rewrites — the branches conflict on that one file every time, with no code conflict
beneath it, and unioning two derivations each computed against a partial corpus is only correct by
accident. The count column is not even defined under such a union. Only a pass over the landed corpus
entire can be right, which is why there is exactly one and it runs here.
