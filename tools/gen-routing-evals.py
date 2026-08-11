#!/usr/bin/env python3
"""Author the routing eval cases required by FR-11.

Every skill gets at least one `trigger` case (its intended phrasing must load
it) and one `neighbour-exclusion` case (its nearest neighbour's phrasing must
NOT). Those two are the only instrument the pack has for the failure it is most
exposed to: a description that drifts until it stops routing, which looks
exactly like a skill nobody needed.

Skills that already ship behaviour evals keep them; these are appended.
"""
import json
import os

# skill -> (trigger prompt, what should happen, neighbour, neighbour prompt, why it is the neighbour's)
CASES = {
    "claudemd-compact": (
        "my CLAUDE.md is 900 lines and half of it is out of date, can you sort it out",
        "claudemd-compact loads and compacts/de-stales the CLAUDE.md hierarchy, splitting "
        "detail into references and dropping rules the repo already enforces.",
        "claudemd-patch",
        "add my usual test-writing policy block to this project's CLAUDE.md",
        "Inserting the maintainer's standard reusable rule blocks is claudemd-patch's job; "
        "claudemd-compact must not load, because it reorganizes what is there rather than "
        "adding the standard blocks.",
    ),
    "claudemd-patch": (
        "bring this project's CLAUDE.md up to date with my usual rules",
        "claudemd-patch loads and inserts the standard Test-Writing Policy and Code "
        "Conventions blocks, plus the PreToolUse write-tests hook in .claude/settings.json.",
        "claudemd-compact",
        "this CLAUDE.md is way too long, trim it down and move the detail out",
        "Shrinking and reorganizing an existing CLAUDE.md is claudemd-compact's job; "
        "claudemd-patch must not load, because it adds fixed blocks rather than compacting.",
    ),
    "code-adversarial": (
        "run the codex adversarial review over this diff",
        "code-adversarial loads and runs the REAL Codex review through the wrapper script, "
        "returning its findings. It never substitutes an LLM imitation.",
        "code-bugs",
        "have a look through my changes and tell me if anything is broken",
        "A plain bug hunt over the diff is code-bugs' job; code-adversarial must not load, "
        "because it is specifically the wrapper around the external Codex tool.",
    ),
    "code-bugs": (
        "anything broken in the diff? check for N+1 queries too",
        "code-bugs loads and hunts real defects — wrong results, edge-case failures, "
        "N+1 queries, unbounded fetches — plus drift between the changes and the docs.",
        "code-quality",
        "is this method readable, or is the control flow too convoluted?",
        "Readability and idiom judgement is code-quality's job; code-bugs must not load, "
        "because nothing here is claimed to be broken.",
    ),
    "code-quality": (
        "is this readable? the naming feels off and I keep re-reading the loop",
        "code-quality loads and reports readability and idiom problems — confusing names, "
        "control flow you have to re-read, leaky abstractions. It reports and never edits.",
        "code-bugs",
        "this returns the wrong total when the cart is empty, find out what's broken",
        "A correctness defect is code-bugs' job; code-quality must not load, because it "
        "judges how code reads, not whether it works.",
    ),
    "code-refactor": (
        "clean up this method, it's doing five things at once",
        "code-refactor loads, writes a behaviour-locking test first, then restructures the "
        "method without changing what it does.",
        "code-quality",
        "review this class and tell me what a senior dev would find hard to follow",
        "A report with no edits is code-quality's job; code-refactor must not load, because "
        "nobody asked for the code to be changed.",
    ),
    "code-scan": (
        "run pmd and spotbugs over what I changed and fix what they find",
        "code-scan loads, runs PMD + SpotBugs/find-sec-bugs + Semgrep as local CLIs over the "
        "diff, then triages and fixes the findings. No server, no tokens.",
        "code-bugs",
        "read through my changes and spot the logic mistakes",
        "A judgement-based hunt is code-bugs' job; code-scan must not load, because it runs "
        "mechanical analyzers rather than reading for intent.",
    ),
    "gh-issues-fix": (
        "go through the open GitHub issues and fix the bugs",
        "gh-issues-fix loads, lists the open bug issues, verifies each still reproduces "
        "against the code, groups them by subsystem, and fixes the approved groups one at a time.",
        "task-run",
        "implement issue #42",
        "One known issue handed over directly is task-run's job; gh-issues-fix must not "
        "load, because there is no backlog to triage or group.",
    ),
    "git-commit": (
        "I'm done for now, commit my changes please",
        "git-commit loads and groups the working tree into separate logical Conventional "
        "Commits by functionality.",
        "task-run",
        "build the dark-mode toggle end to end and open a PR",
        "Running a whole unit of work through plan, implement, review and PR is task-run's "
        "job; git-commit must not load, because there is nothing to commit yet.",
    ),
    "hexagonal-architecture": (
        "where should this class live — core or the jpa adapter? and is core allowed to "
        "import the payment SDK?",
        "hexagonal-architecture loads and answers from the boundary rules: which module owns "
        "the class, that core never imports adapter packages or tech SDKs, and that the SDK "
        "type stays in its adapter behind an outbound port.",
        "code-refactor",
        "this OrderService is doing five things at once, split it up without changing behaviour",
        "Restructuring code behind a behaviour-locking test is code-refactor's job; "
        "hexagonal-architecture must not load, because nothing here asks where code belongs "
        "or what a module may import.",
    ),
    "spec-brainstorm": (
        "help me architect a service that syncs invoices to our accounting system",
        "spec-brainstorm loads, interviews for the missing decisions, researches prior art, "
        "and writes docs/<topic>/spec.html plus architecture.html.",
        "spec-plan",
        "turn the spec we wrote into a phased todo I can work through",
        "Turning a written spec into an ordered plan is spec-plan's job; spec-brainstorm "
        "must not load, because the specification already exists.",
    ),
    "spec-plan": (
        "break this spec into phases with a runnable done-when check for each",
        "spec-plan loads, reads the spec, and writes a phased todo.md with stable ids, real "
        "file paths and a check that can actually be run.",
        "spec-brainstorm",
        "I have an idea for a bot that watches our deploys — how should I build it?",
        "Designing something that has not been specified yet is spec-brainstorm's job; "
        "spec-plan must not load, because there is no spec to phase.",
    ),
    "task-review": (
        "/r:task-review",
        "task-review loads and runs the review pipeline over the current diff: parallel "
        "hunters, one fix phase, build with tests, mandatory static analysis, Codex end-verify.",
        "task-run",
        "implement the CSV export and ship it",
        "Building the change is task-run's job; task-review must not load, because there is "
        "no diff to review yet. task-review is reachable by name and from task-run's Step 5, "
        "but never fires on its own.",
    ),
    "task-run": (
        "run this task: add a dark-mode toggle to the settings page",
        "task-run loads, branches, plans, implements test-first, calls task-review, and "
        "opens a PR.",
        "task-review",
        "review the diff I already have and fix what it turns up",
        "Reviewing an existing diff is task-review's job; task-run must not load, because "
        "the work is already done.",
    ),
    "test-app-create": (
        "set up the /test-app skill for this repo",
        "test-app-create loads, detects the stack, and writes a tailored "
        ".claude/skills/test-app/SKILL.md plus its references/subagent-prompt.md.",
        "test-app",
        "test the app and check the checkout flow still works",
        "Actually exercising the running app is the generated test-app skill's job; "
        "test-app-create must not load, because it generates that skill rather than running it.",
    ),
    "tests-write": (
        "add a service method that applies a discount, with tests",
        "tests-write loads automatically and shapes the tests — Given/When/Then, AssertJ, "
        "JUnit 5, self-contained, hard-coded expectations.",
        "code-refactor",
        "this Kotlin class is too complex, split it up without changing behaviour",
        "Restructuring existing code is code-refactor's job. tests-write may inform the "
        "safety-net test but must not be what the request routes to.",
    ),
}

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for skill, (tp, texp, nb, np_, nexp) in CASES.items():
    d = os.path.join(REPO, "skills", skill, "evals")
    path = os.path.join(d, "evals.json")
    if os.path.exists(path):
        suite = json.load(open(path))
    else:
        os.makedirs(d, exist_ok=True)
        suite = {"skill_name": skill, "evals": []}
    next_id = max((e.get("id", -1) for e in suite["evals"]), default=-1) + 1
    suite["evals"] += [
        {"id": next_id, "name": "routing-triggers", "kind": "trigger",
         "prompt": tp, "expected_output": texp,
         "files": [], "fixture": None, "assertions": []},
        {"id": next_id + 1, "name": f"routing-excludes-{nb}", "kind": "neighbour-exclusion",
         "neighbour": nb, "prompt": np_, "expected_output": nexp,
         "files": [], "fixture": None, "assertions": []},
    ]
    json.dump(suite, open(path, "w"), indent=2, ensure_ascii=False)
    open(path, "a").write("\n")
    print(f"{skill:20} {len(suite['evals'])} evals")
