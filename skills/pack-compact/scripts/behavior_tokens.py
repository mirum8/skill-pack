#!/usr/bin/env python3
"""The half of /r:pack-compact's gate that cannot be talked out of a verdict.

    behavior_tokens.py tokens        --before OLD --after NEW [NEW ...]
    behavior_tokens.py code-identical --before OLD --after NEW

A rewrite that silently dropped `--herdr`, a script path or a measured number returns a
confident clean report, and nothing downstream re-reads the prose to catch it. Two model
agents read the rewrite afterwards, but both of them can be persuaded; a set difference
cannot. So the hard, countable things are checked here first, and the judgement calls only
get asked once this has passed.

Both modes FAIL CLOSED: anything the tool cannot account for is reported as a difference,
never waved through. Exit 0 means nothing was lost, 1 means something was, 2 means the tool
could not run — and the caller treats 2 exactly like 1, because a check that did not happen
is not a check that passed.

`tokens` takes several --after files because extraction is a legal move: text that leaves
SKILL.md for references/ has not gone anywhere, so the union of the new files is what the
old file is measured against.

`code-identical` compares the two files with full-line comments and blank lines removed.
Only full-line comments count as comments, in every language. A trailing comment is treated
as code, so the gate fails if one changes — which is the conservative direction: the wrong
way round would be a stripper that mistakes code for a comment and then cannot see that
code change. The skill's rule follows from it: rewrite whole comment lines, leave trailing
comments alone.
"""
import argparse
import os
import re
import sys

COMMENT_LINE = re.compile(r"^\s*(?://|#|\*|/\*|<!--)")

# What counts as a hard token: something a run would behave differently without. Every pattern
# here is a thing that is copied, not composed — a flag, a path, an identifier, a number — which
# is why a set difference is meaningful for them and would not be for ordinary prose.
PATTERNS = [
    ("flag",     re.compile(r"--[a-z][a-z0-9-]{1,}")),
    ("skill",    re.compile(r"\br:[a-z][a-z0-9-]*")),
    ("path",     re.compile(r"\b(?:skills|agents|lib|hooks|tools|docs|\.config|\.claude-plugin)"
                            r"/[A-Za-z0-9_.\-/]*[A-Za-z0-9_]")),
    ("var",      re.compile(r"\$\{CLAUDE_[A-Z_]+\}")),
    ("file",     re.compile(r"\b[a-z0-9][a-z0-9_.\-]*\.(?:py|sh|mjs|js|json|ya?ml|md|html|sql)\b")),
    ("const",    re.compile(r"\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b")),
    ("key",      re.compile(r"`([a-z]+(?:[A-Z][A-Za-z0-9]*)+)`")),
    ("jsonkey",  re.compile(r'"([a-zA-Z][a-zA-Z0-9_]*)"\s*:')),
    ("number",   re.compile(r"\b\d[\d,]*(?:\.\d+)?\s?(?:%|KB|MB|GB|ms|s\b|k\b|M\b|B\b)?")),
]


def read(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return fh.read()
    except OSError as exc:
        sys.exit(f"behavior_tokens: cannot read {path}: {exc}")


def tokens_of(text):
    """Every hard token in `text`, as a set of (kind, value)."""
    found = set()
    for kind, pattern in PATTERNS:
        for match in pattern.finditer(text):
            value = match.group(1) if pattern.groups else match.group(0)
            value = value.strip().rstrip(".,;:)")
            if kind == "number":
                value = value.replace(",", "").replace(" ", "")
                if len(value.rstrip("%KMBGgibms")) < 2:
                    continue          # a bare one-digit number is prose, not a measurement
            if value:
                found.add((kind, value))
    return found


def strip_comments(text):
    """The file with whole comment lines and blank lines removed — what must not change."""
    kept = []
    for line in text.splitlines():
        if not line.strip():
            continue
        if COMMENT_LINE.match(line):
            continue
        kept.append(line.rstrip())
    return "\n".join(kept)


def cmd_tokens(before, after_paths):
    old = tokens_of(read(before))
    new = set()
    for path in after_paths:
        new |= tokens_of(read(path))
    lost = sorted(old - new)
    where = ", ".join(os.path.relpath(p) for p in after_paths)
    if not lost:
        print(f"behavior_tokens: {len(old)} hard tokens, all present in {where}")
        return 0
    print(f"behavior_tokens: {len(lost)} of {len(old)} hard tokens are gone from {where}\n")
    for kind, value in lost:
        print(f"  {kind:8} {value}")
    print("\nEach one is a flag, path, identifier or measured number the old file carried and\n"
          "the new one does not. Restore the file unless every line above is accounted for.")
    return 1


def cmd_code_identical(before, after):
    old, new = strip_comments(read(before)), strip_comments(read(after))
    if old == new:
        print(f"behavior_tokens: {os.path.relpath(after)} is comment-only — "
              f"{len(old.splitlines())} code lines byte-identical")
        return 0
    old_lines, new_lines = old.splitlines(), new.splitlines()
    print(f"behavior_tokens: executable content CHANGED in {os.path.relpath(after)} "
          f"({len(old_lines)} code lines before, {len(new_lines)} after)\n")
    import difflib
    shown = 0
    for line in difflib.unified_diff(old_lines, new_lines, "before", "after", lineterm="", n=1):
        if line.startswith(("+", "-")) and not line.startswith(("+++", "---")):
            print(f"  {line}")
            shown += 1
            if shown >= 40:
                print("  … truncated")
                break
    print("\nOnly comments may be rewritten in an executable file. Restore it.")
    return 1


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="mode", required=True)
    t = sub.add_parser("tokens", help="every hard token in --before must survive in --after")
    t.add_argument("--before", required=True)
    t.add_argument("--after", required=True, nargs="+")
    c = sub.add_parser("code-identical", help="--after may differ from --before only in comments")
    c.add_argument("--before", required=True)
    c.add_argument("--after", required=True)
    args = ap.parse_args()
    if args.mode == "tokens":
        return cmd_tokens(args.before, args.after)
    return cmd_code_identical(args.before, args.after)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as exc:                                    # noqa: BLE001
        print(f"behavior_tokens: {type(exc).__name__}: {exc}", file=sys.stderr)
        print("The check did not run. Treat that as a failure, not a pass.", file=sys.stderr)
        sys.exit(2)
