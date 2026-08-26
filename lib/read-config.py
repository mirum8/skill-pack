#!/usr/bin/env python3
"""Resolve the pack's settings for one step and print them as JSON.

The pack's only configuration mechanism. A project file overrides the shipped defaults key by
key, and anything neither file answers falls back to values built in here:

  1. <repo>/.config/skill-pack.yaml    the user's edit point, outside the install target
  2. <pack>/.config/defaults.yaml      shipped; ./install.sh rewrites it on every run
  3. the SPEC table below              every setting the pack reads, and its built-in value

It lives in lib/ rather than inside one skill's scripts/ for the same reason record-run.py does:
every skill will eventually read settings, and a reader owned by one skill stays that skill's
reader.

THE PROMISE, same as the stats sink's: it never fails the caller. A missing file, an unreadable
line, an unknown key and a value outside its enum all resolve to the fallback and add a line to
`notes` naming what was substituted and why. A caller that cannot read a setting still runs — it
just runs on a value it can see in its own log. `--check` is the one mode that exits non-zero,
and it exists so validate.py can refuse to ship a defaults file this reader would reject.

Workflow scripts have no filesystem access, so the caller is a subagent running this script and
returning its stdout under a schema. That is why the output is one line of JSON on stdout with
everything the caller needs to explain itself — the resolved values, which files contributed, and
every substitution made along the way.

YAML here is a deliberate subset: nested mappings by indentation, scalar values, `#` comments,
optionally quoted strings. No PyYAML dependency and one code path, so the behaviour under test is
the behaviour in the field. Lists, multi-line scalars, anchors and flow style are not read; a line
the parser cannot place becomes a note rather than a silent drop.

Usage:  read-config.py [--step implement|fanout] [--repo DIR] [--pack DIR]
        read-config.py --step fanout --field maxUnits     # one bare scalar, for shell callers
        read-config.py --check FILE
"""
import argparse
import glob
import json
import os
import sys

PACK_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

PROVIDERS = ("claude", "codex")
EFFORTS = ("low", "medium", "high", "xhigh", "max")
# Only meaningful for the claude provider. A codex model name is validated by the Codex CLI, not
# here — pinning its model list in this file would go stale the week it changes.
CLAUDE_MODELS = ("fable", "opus", "sonnet", "haiku")

# Every setting the pack reads, with what it falls back to. This table IS the vocabulary: a key
# outside it is named and ignored rather than carried, so a typo cannot reach a caller looking like
# a value. `implement`'s row is kept in step with IMPL_RUN in task-run-implement.workflow.js and
# `fanout`'s with MAX_UNITS in plan-run/scripts/cmux-fanout.sh — those are the same values
# expressed for the case where this script cannot be reached at all.
SPEC = {
    "implement": {
        "provider": {"default": "claude", "enum": PROVIDERS},
        # Validated against the Claude models only when the provider is claude; see resolve().
        "model": {"default": "opus"},
        "effort": {"default": "medium", "enum": EFFORTS},
        # Read only under `provider: codex`, and always a Claude subagent — this is the WRAPPER
        # that shells out to the Codex CLI and collects the run, not the writer. It is tuned apart
        # from the writer because the two do different work: the brief is passed through verbatim,
        # but the wrapper owns the background-collect protocol that produced false blocks on #82
        # and #55, and then reads the working tree to decide filesChanged, testEvidence and
        # blockedOn. `low` is the tempting mistake — a wrapper that gives up early does not save
        # 20s, it halts the run over work Codex actually finished.
        "wrapperModel": {"default": "sonnet", "enum": CLAUDE_MODELS},
        "wrapperEffort": {"default": "medium", "enum": EFFORTS},
    },
    # Shared by /r:plan-run and /r:issues-fix, which drive one fan-out script between them — so the
    # cap is one setting, not one per skill. The range rejects 0, negatives and a slipped digit; it
    # is NOT a recommendation. Three full implement+review pipelines is already the machine's limit
    # (implement alone measures 20.9M tokens and ~1022s per agent), and a wave that spawns more
    # thrashes rather than finishing sooner. Raising it is a measurement, not a default.
    "fanout": {
        "maxUnits": {"default": "3", "int": (1, 16)},
    },
}

# The two paths check-prereqs.sh already looks in. The plugin is not a binary on PATH — it is a
# Claude Code plugin, installed either from the marketplace or unpacked into the version cache.
COMPANION = "scripts/codex-companion.mjs"


def codex_present(home=None):
    home = home or os.path.expanduser("~")
    direct = os.path.join(home, ".claude/plugins/marketplaces/openai-codex/plugins/codex", COMPANION)
    if os.path.isfile(direct):
        return direct
    cached = sorted(glob.glob(os.path.join(home, ".claude/plugins/cache/openai-codex/codex/*", COMPANION)))
    return cached[-1] if cached else ""


# ------------------------------------------------------------------ the parser ---
def parse(text):
    """Return (tree, problems). Indentation-nested mappings of scalars, nothing else."""
    tree, problems = {}, []
    stack = [(-1, tree)]
    for n, raw in enumerate(text.splitlines(), 1):
        line = raw.split("#", 1)[0].rstrip() if not raw.lstrip().startswith("#") else ""
        if not line.strip():
            continue
        indent = len(line) - len(line.lstrip(" "))
        if "\t" in line[:indent]:
            problems.append(f"line {n}: tabs are not indentation in YAML — use spaces")
            continue
        if ":" not in line:
            problems.append(f"line {n}: {line.strip()!r} is not a `key: value` or `key:` line")
            continue
        while stack and indent <= stack[-1][0]:
            stack.pop()
        if not stack:
            problems.append(f"line {n}: indentation does not sit under any key")
            continue
        key, _, value = line.strip().partition(":")
        key, value = key.strip(), value.strip()
        if value.startswith(("'", '"')) and value.endswith(value[0]) and len(value) > 1:
            value = value[1:-1]
        parent = stack[-1][1]
        if not isinstance(parent, dict):
            problems.append(f"line {n}: {key!r} is nested under a value, not a mapping")
            continue
        if value:
            parent[key] = value
        else:
            child = {}
            parent[key] = child
            stack.append((indent, child))
    return tree, problems


def read(path, notes):
    """Load one file into a flat {key: value} for the requested step, or {} with a note."""
    if not path or not os.path.isfile(path):
        return {}, False
    try:
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
    except OSError as exc:
        notes.append(f"{path}: could not be read ({exc.strerror}) — ignoring it")
        return {}, False
    tree, problems = parse(text)
    for p in problems:
        notes.append(f"{path}: {p}")
    return tree, True


def flatten(tree, step, path, notes):
    """Pull steps.<step> out of a parsed tree, naming every key nobody reads."""
    steps = tree.get("steps")
    if steps is None:
        for k in tree:
            notes.append(f"{path}: top-level {k!r} is not a key this pack reads — ignoring it")
        return {}
    if not isinstance(steps, dict):
        notes.append(f"{path}: `steps` must be a mapping — ignoring the file")
        return {}
    for k in tree:
        if k != "steps":
            notes.append(f"{path}: top-level {k!r} is not a key this pack reads — ignoring it")
    block = steps.get(step)
    if block is None:
        return {}
    if not isinstance(block, dict):
        notes.append(f"{path}: `steps.{step}` must be a mapping — ignoring it")
        return {}
    keys = SPEC.get(step, {})
    out = {}
    for k, v in block.items():
        if k not in keys:
            notes.append(f"{path}: `steps.{step}.{k}` is not a setting this pack reads — ignoring it")
        elif not isinstance(v, str):
            notes.append(f"{path}: `steps.{step}.{k}` must be a scalar — ignoring it")
        else:
            out[k] = v
    return out


# ------------------------------------------------------------- the resolution ---
def resolve(step="implement", repo=None, pack=None, home=None):
    if step not in SPEC:
        return {"step": step, "sources": [],
                "notes": [f"{step!r} is not a step this pack has settings for — "
                          f"known steps are {', '.join(sorted(SPEC))}"]}
    spec = SPEC[step]
    notes, sources = [], []
    fallback = {k: v["default"] for k, v in spec.items()}

    layers = []
    for path in (os.path.join(pack or PACK_ROOT, ".config/defaults.yaml"),
                 os.path.join(repo or os.getcwd(), ".config/skill-pack.yaml")):
        tree, found = read(path, notes)
        if found:
            sources.append(path)
            layers.append((path, flatten(tree, step, path, notes)))
    if not sources:
        notes.append("no .config file found — using the built-in defaults")

    # Later layers win key by key, so a project file naming one setting inherits the rest.
    values, origin = dict(fallback), {}
    for path, layer in layers:
        for k, v in layer.items():
            values[k], origin[k] = v, path

    def bad(key, why):
        notes.append(f"{origin.get(key, 'built-in')}: `steps.{step}.{key}` {why} — using {fallback[key]!r}")
        values[key] = fallback[key]

    for key, rule in spec.items():
        if "enum" in rule and values[key] not in rule["enum"]:
            bad(key, f"{values[key]!r} is not one of {'|'.join(rule['enum'])}")
        elif "int" in rule:
            lo, hi = rule["int"]
            try:
                n = int(str(values[key]).strip())
            except ValueError:
                bad(key, f"{values[key]!r} is not a whole number")
                continue
            if not lo <= n <= hi:
                bad(key, f"{n} is outside {lo}..{hi}")
            else:
                values[key] = str(n)

    if spec.get("provider") and values["provider"] == "codex" and not codex_present(home):
        # Every field moves together. Handing a Claude subagent a codex model name breaks the
        # dispatch outright, and carrying the codex effort across would re-tier the Claude path
        # by accident — so the fallback is the whole built-in row, and it says so.
        notes.append(
            f"`steps.{step}.provider` is 'codex' but the Codex plugin is not installed — falling back to "
            f"provider {fallback['provider']!r}, model {fallback['model']!r}, effort {fallback['effort']!r}. "
            "Install it with: /plugin marketplace add openai-codex, then /plugin install codex@openai-codex")
        # Only the writer's three fields move. The wrapper keys describe an agent that is not
        # dispatched at all on claude, so resetting them would discard a setting for no reason and
        # make the returned row disagree with the file the user is looking at.
        values.update({k: fallback[k] for k in ("provider", "model", "effort")})
    elif spec.get("provider") and values["provider"] == "claude" and values["model"] not in CLAUDE_MODELS:
        bad("model", f"{values['model']!r} is not one of {'|'.join(CLAUDE_MODELS)}")

    return {"step": step, **values, "sources": sources, "notes": notes}


def check(path):
    """Parse one file strictly, EVERY step of it. The only mode that can fail — validate.py's gate.

    Every step in SPEC is walked rather than just `implement`: a defaults file whose unchecked half
    the reader would reject falls through to the built-in row on every run, which reads from the
    outside exactly like a setting that works.
    """
    if not os.path.isfile(path):
        print(f"{path}: no such file", file=sys.stderr)
        return 1
    with open(path, encoding="utf-8") as fh:
        tree, problems = parse(fh.read())
    for step, spec in SPEC.items():
        notes = []
        values = flatten(tree, step, path, notes)
        for k, v in values.items():
            rule = spec[k]
            if "enum" in rule and v not in rule["enum"]:
                problems.append(f"steps.{step}.{k} {v!r} is not one of {'|'.join(rule['enum'])}")
            elif "int" in rule:
                lo, hi = rule["int"]
                if not (v.strip().lstrip("-").isdigit() and lo <= int(v) <= hi):
                    problems.append(f"steps.{step}.{k} {v!r} is not a whole number in {lo}..{hi}")
            elif k == "model" and values.get("provider", spec["provider"]["default"]) == "claude" \
                    and v not in CLAUDE_MODELS:
                problems.append(f"steps.{step}.model {v!r} is not one of {'|'.join(CLAUDE_MODELS)}")
        # `flatten` reports unknown TOP-LEVEL keys once per step it is called for; keep one copy.
        problems += [n for n in notes if n not in problems]
    for p in problems:
        print(f"{path}: {p}", file=sys.stderr)
    return 1 if problems else 0


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--step", default="implement")
    ap.add_argument("--repo", default=None, help="project root holding .config/skill-pack.yaml")
    ap.add_argument("--pack", default=None, help="pack root holding .config/defaults.yaml")
    ap.add_argument("--check", metavar="FILE", default=None, help="validate one file; exits non-zero")
    # For shell callers, which want one scalar rather than a JSON document they would have to
    # parse with a tool the script cannot assume is installed. Notes still go to stderr, so a
    # substitution is visible in the caller's log rather than swallowed by the narrower output.
    ap.add_argument("--field", default=None, help="print one resolved value on stdout, bare")
    args = ap.parse_args()

    if args.check:
        sys.exit(check(args.check))
    try:
        out = resolve(args.step, args.repo, args.pack)
    except Exception as exc:  # never fail the caller — an unreadable setting is not a failed run
        out = {"step": args.step, **{k: v["default"] for k, v in SPEC.get(args.step, {}).items()},
               "sources": [],
               "notes": [f"the config reader itself failed ({exc}) — using the built-in defaults"]}

    if args.field:
        for n in out.get("notes", []):
            print(f"read-config: {n}", file=sys.stderr)
        if args.field not in out:
            print(f"read-config: no such setting: steps.{args.step}.{args.field}", file=sys.stderr)
            sys.exit(0)
        print(out[args.field])
        sys.exit(0)
    print(json.dumps(out))
    sys.exit(0)


if __name__ == "__main__":
    main()
