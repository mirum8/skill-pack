#!/usr/bin/env python3
"""Resolve the pack's settings for one step and print them as JSON.

The pack's only configuration mechanism. A project file overrides the shipped defaults key by
key, and anything neither file answers falls back to values built in here:

  1. <repo>/.config/skill-pack.yaml    the user's edit point, outside the install target
  2. <pack>/.config/defaults.yaml      shipped; ./install.sh rewrites it on every run
  3. the FALLBACK table below          claude / opus / medium

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

Usage:  read-config.py [--step implement] [--repo DIR] [--pack DIR]
        read-config.py --check FILE
"""
import argparse
import glob
import json
import os
import sys

PACK_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# The last resort, and also where `provider: codex` lands when Codex is not installed. Kept in
# step with IMPL_RUN in skills/task-run/task-run-implement.workflow.js, which is the same values
# expressed for the case where this script could not be reached at all.
FALLBACK = {"implement": {"provider": "claude", "model": "opus", "effort": "medium"}}

PROVIDERS = ("claude", "codex")
EFFORTS = ("low", "medium", "high", "xhigh", "max")
# Only meaningful for the claude provider. A codex model name is validated by the Codex CLI, not
# here — pinning its model list in this file would go stale the week it changes.
CLAUDE_MODELS = ("fable", "opus", "sonnet", "haiku")

KEYS = ("provider", "model", "effort")

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
    out = {}
    for k, v in block.items():
        if k not in KEYS:
            notes.append(f"{path}: `steps.{step}.{k}` is not a setting this pack reads — ignoring it")
        elif not isinstance(v, str):
            notes.append(f"{path}: `steps.{step}.{k}` must be a scalar — ignoring it")
        else:
            out[k] = v
    return out


# ------------------------------------------------------------- the resolution ---
def resolve(step="implement", repo=None, pack=None, home=None):
    notes, sources = [], []
    fallback = dict(FALLBACK.get(step, FALLBACK["implement"]))

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

    if values["provider"] not in PROVIDERS:
        bad("provider", f"{values['provider']!r} is not one of {'|'.join(PROVIDERS)}")
    if values["effort"] not in EFFORTS:
        bad("effort", f"{values['effort']!r} is not one of {'|'.join(EFFORTS)}")

    if values["provider"] == "codex" and not codex_present(home):
        # Every field moves together. Handing a Claude subagent a codex model name breaks the
        # dispatch outright, and carrying the codex effort across would re-tier the Claude path
        # by accident — so the fallback is the whole built-in row, and it says so.
        notes.append(
            f"`steps.{step}.provider` is 'codex' but the Codex plugin is not installed — falling back to "
            f"provider {fallback['provider']!r}, model {fallback['model']!r}, effort {fallback['effort']!r}. "
            "Install it with: /plugin marketplace add openai-codex, then /plugin install codex@openai-codex")
        values = dict(fallback)
    elif values["provider"] == "claude" and values["model"] not in CLAUDE_MODELS:
        bad("model", f"{values['model']!r} is not one of {'|'.join(CLAUDE_MODELS)}")

    return {"step": step, **{k: values[k] for k in KEYS}, "sources": sources, "notes": notes}


def check(path):
    """Parse one file strictly. The only mode that can fail — validate.py's gate."""
    if not os.path.isfile(path):
        print(f"{path}: no such file", file=sys.stderr)
        return 1
    with open(path, encoding="utf-8") as fh:
        tree, problems = parse(fh.read())
    notes = []
    values = flatten(tree, "implement", path, notes)
    for k, v in values.items():
        if k == "provider" and v not in PROVIDERS:
            problems.append(f"provider {v!r} is not one of {'|'.join(PROVIDERS)}")
        if k == "effort" and v not in EFFORTS:
            problems.append(f"effort {v!r} is not one of {'|'.join(EFFORTS)}")
        if k == "model" and values.get("provider") == "claude" and v not in CLAUDE_MODELS:
            problems.append(f"model {v!r} is not one of {'|'.join(CLAUDE_MODELS)}")
    problems += notes
    for p in problems:
        print(f"{path}: {p}", file=sys.stderr)
    return 1 if problems else 0


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--step", default="implement")
    ap.add_argument("--repo", default=None, help="project root holding .config/skill-pack.yaml")
    ap.add_argument("--pack", default=None, help="pack root holding .config/defaults.yaml")
    ap.add_argument("--check", metavar="FILE", default=None, help="validate one file; exits non-zero")
    args = ap.parse_args()

    if args.check:
        sys.exit(check(args.check))
    try:
        out = resolve(args.step, args.repo, args.pack)
    except Exception as exc:  # never fail the caller — an unreadable setting is not a failed run
        out = {"step": args.step, **FALLBACK["implement"], "sources": [],
               "notes": [f"the config reader itself failed ({exc}) — using the built-in defaults"]}
    print(json.dumps(out))
    sys.exit(0)


if __name__ == "__main__":
    main()
