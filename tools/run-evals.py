#!/usr/bin/env python3
"""Run the pack's routing eval suites — the instrument for descriptions that stop routing.

    python3 tools/run-evals.py [--skill NAME] [--runs N] [--model M] [--jobs N]
                               [--max-cost-usd USD] [--dry-run] [--json PATH]

`validate.sh` proves every skill HAS an eval suite. This runs the part of one a script can
judge, so it is deliberately not part of that gate: it costs real model calls.

WHAT IT RUNS. Only the two mechanical case kinds:

  trigger              this prompt must load this skill
  neighbour-exclusion  the neighbour's phrasing must NOT load this skill

Everything else in a suite — the behaviour cases with fixtures and free-text assertions — is
skipped and named. Those need a spec.html fixture and a judge; pretending a script scored them
would be worse than not running them.

HOW IT MEASURES. One `claude -p` per run, with `--plugin-dir` pointing at THIS REPO, so what is
under test is the working copy rather than whatever `install.sh` last published. The pack's
skills really are registered that way — the init event lists all of them — so a skill that does
not fire did not fire, rather than never being offered.

A skill loads by two disjoint routes and only one of them is routing:

  * the model calls the `Skill` tool          <- what a trigger case is about
  * the user types `/r:<name>`                <- expands in the CLI, no tool call, not routing

So detection is a `Skill` tool_use naming `r:<skill>`, and nothing else counts.

THREE THINGS THAT MAKE A NUMBER FROM THIS MISLEADING, all of them measured, none of them fixable
here:

  * The model decides. Haiku almost never reaches for a skill; a bigger model reaches more often.
    A pass rate is a statement about one model, so the report names it.
  * Routing is stochastic, so one run is one sample. --runs is the whole answer to that, and the
    report prints the rate rather than a verdict when it is neither 0 nor 1.
  * The prompt runs in an empty scratch directory. A case whose phrasing assumes a real
    codebase ("is this readable?") gives the model nothing to work with, and asking for the code
    is then the CORRECT answer, not a routing failure. Those cases are worth reading, not
    trusting.

STATS ARE REDIRECTED, AND THIS IS NOT OPTIONAL. `hooks/record-skill-run.py` fires on every skill
invocation and writes an `invoke` row. Left alone, a full run would write dozens of synthetic
rows into ~/.claude/skill-stats.db — the store the repo's own convention says to read before
changing anything — and they would be indistinguishable from real use. So every child process
gets CLAUDE_SKILL_STATS_DB pointed at a throwaway file, which the hook already honours.

WHAT A RUN COSTS. Model calls, and on a subscription that means QUOTA, not money. The CLI reports
`total_cost_usd` on every run and it is an API-EQUIVALENT valuation — what these tokens would have
cost at API rates — not a charge. With an OAuth/subscription login nothing is billed per token, so
that figure is printed here labelled as equivalent and never as money spent. It becomes a real
charge only when ANTHROPIC_API_KEY is set, which is what --max-cost-usd is for; the run is
otherwise bounded by --runs and the case count, both of which are printed before anything starts.

Exit 0 when every runnable case passes, 1 otherwise, 2 when the cost ceiling aborted the run.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKILLS = os.path.join(REPO, "skills")
ROUTING_KINDS = {"trigger", "neighbour-exclusion"}
# Enough turns for the model to decide and act once; short enough that a skill which DOES fire
# cannot get far. Combined with a throwaway cwd and no Write/Edit, a fired skill is inert.
MAX_TURNS = 3
BLOCKED = ["Write", "Edit", "NotebookEdit"]


def frontmatter_flag(skill):
    """True when the skill carries disable-model-invocation, i.e. the router never sees it.

    Read from the file rather than a list here, so a skill that gains or loses the flag changes
    this with the edit. A `trigger` case for such a skill is untestable BY DESIGN — its
    description is not in context, so no prompt can route to it — and reporting that as a
    failure would be reporting the flag working.
    """
    path = os.path.join(SKILLS, skill, "SKILL.md")
    try:
        with open(path, encoding="utf-8") as fh:
            text = fh.read(4000)
    except OSError:
        return False
    head = text.split("---", 2)[1] if text.startswith("---") else ""
    for line in head.splitlines():
        if line.strip().startswith("disable-model-invocation:"):
            return line.split(":", 1)[1].strip().lower() in {"true", "yes", "on", "1"}
    return False


def load_cases(only=None):
    cases, skipped = [], []
    for skill in sorted(os.listdir(SKILLS)):
        if only and skill != only:
            continue
        path = os.path.join(SKILLS, skill, "evals", "evals.json")
        if not os.path.isfile(path):
            continue
        try:
            suite = json.load(open(path, encoding="utf-8"))
        except json.JSONDecodeError as exc:
            skipped.append((skill, "-", f"evals.json does not parse: {exc}"))
            continue
        no_route = frontmatter_flag(skill)
        for case in suite.get("evals", []):
            name = case.get("name", f"id-{case.get('id')}")
            kind = case.get("kind")
            if kind not in ROUTING_KINDS:
                skipped.append((skill, name, "behaviour case — needs its fixture and a judge"))
                continue
            if kind == "trigger" and no_route:
                skipped.append((skill, name,
                                "disable-model-invocation: true — not routable by design"))
                continue
            if not case.get("prompt"):
                skipped.append((skill, name, "no prompt"))
                continue
            cases.append({"skill": skill, "name": name, "kind": kind,
                          "neighbour": case.get("neighbour"), "prompt": case["prompt"]})
    return cases, skipped


def one_run(prompt, model, stats_db):
    """One `claude -p`. Returns (skills_fired, cost_usd, error_or_None)."""
    cmd = ["claude", "-p", prompt,
           "--plugin-dir", REPO,
           "--output-format", "stream-json", "--verbose",
           "--max-turns", str(MAX_TURNS),
           "--disallowed-tools", *BLOCKED]
    if model:
        cmd += ["--model", model]
    env = {**os.environ, "CLAUDE_SKILL_STATS_DB": stats_db}
    workdir = tempfile.mkdtemp(prefix="eval-")
    try:
        proc = subprocess.run(cmd, cwd=workdir, env=env, capture_output=True,
                              text=True, timeout=300)
    except subprocess.TimeoutExpired:
        return set(), 0.0, "timed out after 300s"
    except FileNotFoundError:
        return set(), 0.0, "the `claude` CLI is not on PATH"
    finally:
        shutil.rmtree(workdir, ignore_errors=True)

    fired, cost, err = set(), 0.0, None
    for line in proc.stdout.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") == "assistant":
            for block in event.get("message", {}).get("content", []):
                if block.get("type") == "tool_use" and block.get("name") == "Skill":
                    # The input key has moved before; match the value wherever it sits rather
                    # than naming one field and silently scoring every case as "did not fire".
                    blob = json.dumps(block.get("input") or {})
                    for token in blob.replace('"', " ").replace(":", " ").split():
                        if token.startswith("r:"):
                            fired.add(token)
        elif event.get("type") == "result":
            cost = event.get("total_cost_usd") or 0.0
            if event.get("is_error"):
                err = str(event.get("result"))[:200]
    if not proc.stdout.strip():
        err = err or (proc.stderr.strip()[:200] or "no output")
    return fired, cost, err


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--skill")
    ap.add_argument("--runs", type=int, default=1,
                    help="samples per case; routing is stochastic, 1 is one sample (default: 1)")
    ap.add_argument("--model", help="passed to `claude --model`; omitted = the CLI default")
    ap.add_argument("--jobs", type=int, default=4)
    ap.add_argument("--max-cost-usd", type=float,
                    help="abort past this API-EQUIVALENT total. Only a real charge when "
                         "ANTHROPIC_API_KEY is set; on a subscription this is a call brake, "
                         "not a budget")
    ap.add_argument("--dry-run", action="store_true", help="list what would run, and stop")
    ap.add_argument("--json", dest="json_path")
    args = ap.parse_args()

    cases, skipped = load_cases(args.skill)
    if not cases and not skipped:
        print("no eval suites found")
        return 1

    billed_now = bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))
    print(f"{len(cases)} routing case(s) × {args.runs} run(s) = {len(cases) * args.runs} model call(s)"
          f"   model: {args.model or 'CLI default'}"
          f"   ({'API key — billed per token' if billed_now else 'subscription — quota, not money'})")
    if skipped:
        print(f"{len(skipped)} case(s) not run:")
        for skill, name, why in skipped:
            print(f"  - {skill}/{name}: {why}")
    if args.dry_run:
        print("\n--dry-run: nothing was called.")
        for c in cases:
            print(f"  {c['kind']:20} {c['skill']}/{c['name']}")
        return 0

    stats_db = os.path.join(tempfile.mkdtemp(prefix="eval-stats-"), "throwaway.db")
    spent, results, aborted = 0.0, [], False

    def execute(case):
        fired_runs, cost, errors = [], 0.0, []
        for _ in range(args.runs):
            fired, c, err = one_run(case["prompt"], args.model, stats_db)
            fired_runs.append(fired)
            cost += c
            if err:
                errors.append(err)
        want = f"r:{case['skill']}"
        hits = sum(1 for f in fired_runs if want in f)
        passes = hits if case["kind"] == "trigger" else args.runs - hits
        other = sorted({s for f in fired_runs for s in f if s != want})
        return {**case, "hits": hits, "passes": passes, "runs": args.runs,
                "cost": cost, "errors": errors, "also_fired": other}

    with ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
        for res in pool.map(execute, cases):
            spent += res["cost"]
            results.append(res)
            rate = res["passes"] / res["runs"]
            mark = "ok  " if rate == 1 else ("FAIL" if rate == 0 else "flaky")
            detail = ""
            if res["kind"] == "trigger":
                detail = f"fired {res['hits']}/{res['runs']}"
            else:
                detail = f"wrongly fired {res['hits']}/{res['runs']}"
            if res["also_fired"]:
                detail += f" · also: {', '.join(res['also_fired'])}"
            if res["errors"]:
                detail += f" · error: {res['errors'][0]}"
            print(f"  {mark} {res['skill']}/{res['name']:38} {detail}")
            if args.max_cost_usd and spent >= args.max_cost_usd:
                aborted = True
                break

    failed = [r for r in results if r["passes"] < r["runs"]]
    billed = bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))
    calls = sum(r["runs"] for r in results)
    money = f"${spent:.2f} billed" if billed else (
        f"${spent:.2f} API-equivalent — NOT billed, this login is a subscription")
    print(f"\n{len(results) - len(failed)}/{len(results)} case(s) fully passed"
          f"   {calls} model call(s) · {money}")
    if aborted:
        print(f"ABORTED at the ${args.max_cost_usd:.2f} ceiling — results above are partial.")
    if failed:
        print("\nnot passing:")
        for r in failed:
            print(f"  {r['skill']}/{r['name']} ({r['kind']}) — {r['passes']}/{r['runs']}")
        print("\nA routing case run here has no codebase around it. Where the prompt assumes one "
              "\n(\"is this readable?\"), asking for the code is the right answer and not a routing "
              "\nfailure — read the case before editing a description to chase it.")
    if args.json_path:
        with open(args.json_path, "w", encoding="utf-8") as fh:
            json.dump({"model": args.model, "runs": args.runs, "cost_usd": spent,
                       "results": results, "skipped": skipped}, fh, indent=2)
        print(f"\nwrote {args.json_path}")
    shutil.rmtree(os.path.dirname(stats_db), ignore_errors=True)
    return 2 if aborted else (1 if failed else 0)


if __name__ == "__main__":
    sys.exit(main())
