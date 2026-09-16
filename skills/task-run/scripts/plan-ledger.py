#!/usr/bin/env python3
"""The resume ledger in a task's plan file: which steps a stopped run finished, and whether the
working tree still holds what they produced.

A run of /r:task-run that stops midway leaves its plan at `.task-plans/<slug>.md` and its work
uncommitted on the feature branch. A later run adopts both, and has to decide what to skip. That
decision fails by returning a confident wrong answer in both directions — a slice called done over
files that changed since builds the rest of the task on work that is no longer there, and a tree
whose changes no step recorded read as clean builds on code nothing in the pipeline wrote or
checked — so it is made here, from hashes, and never by a model reading the tree.

The ledger lives in the plan's own header, beside `status:`, because the plan file is the one
artifact that travels with the work: it moves with the branch, it is deleted with the worktree, and
deleting it is already how a user forces a fresh plan. A record kept anywhere else outlives the
tree it describes and answers for the next one cut at the same path.

  reviewed: codex · 2 passes · 5 raised · 3 applied · 1 dropped · 2026-09-14T13:13Z
  slice backend: done sha256=3f2a1c9b0d12e4f5 files=["src/Svc.java","src/SvcTest.java"]
  build: green sha256=9b1e0c3a7d5f2e81
  review: done sha256=9b1e0c3a7d5f2e81

A slice's hash covers the files it claimed; a build or review hash covers the whole tree against
base. The tree never includes `.task-plans/`, so the plan's own edits — this ledger among them —
never break a match.

Every mode exits 0 and reports failure in its JSON, because bookkeeping must never fail the run
that calls it. The one exception is a usage error, exit 2.

Usage:
  plan-ledger.py read --plan PATH --base REF
  plan-ledger.py mark --plan PATH --base REF --key reviewed --note TEXT
  plan-ledger.py mark --plan PATH --base REF --key slice:LABEL --files [F ...]
  plan-ledger.py mark --plan PATH --base REF --key build|review
"""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
import re
import subprocess
import sys

PLANS_DIR = ".task-plans/"
HEADER_LINE = re.compile(r"^[A-Za-z][A-Za-z0-9 _.-]*:")
SLICE_LINE = re.compile(r"^slice ([A-Za-z0-9_.-]+): done sha256=([0-9a-f]{16}) files=(\[.*\])\s*$")
TREE_LINES = {
    "build": (re.compile(r"^build: green sha256=([0-9a-f]{16})\s*$"), "build: green"),
    "review": (re.compile(r"^review: done sha256=([0-9a-f]{16})\s*$"), "review: done"),
}
LABEL = re.compile(r"^[A-Za-z0-9_.-]+$")
STATUSES = ("reviewing", "implementing", "done")


class GitError(Exception):
    pass


def git(*args):
    r = subprocess.run(["git", *args], capture_output=True)
    if r.returncode != 0:
        raise GitError(r.stderr.decode(errors="replace").strip() or f"git {args[0]} failed")
    return r.stdout


def repo_root():
    return git("rev-parse", "--show-toplevel").decode().strip()


def tree(base):
    try:
        git("rev-parse", "--verify", "--quiet", f"{base}^{{commit}}")
    except GitError:
        raise GitError(f"base {base!r} is not a commit in this repo")
    names = git("diff", "--name-only", "-z", base).split(b"\0")
    names += git("ls-files", "--others", "--exclude-standard", "-z").split(b"\0")
    return sorted({n.decode() for n in names if n and not n.decode().startswith(PLANS_DIR)})


# A file that no longer exists hashes differently from one that is empty, so a claimed file deleted
# after its slice finished breaks the match rather than reading as unchanged.
def digest(root, paths):
    h = hashlib.sha256()
    for p in sorted(set(paths)):
        h.update(p.encode() + b"\0")
        try:
            with open(os.path.join(root, p), "rb") as fh:
                h.update(b"\1" + fh.read())
        except OSError:
            h.update(b"\2")
        h.update(b"\0")
    return h.hexdigest()[:16]


def split(text):
    lines = text.split("\n")
    n = 0
    while n < len(lines) and lines[n].strip() and HEADER_LINE.match(lines[n]):
        n += 1
    return lines[:n], lines[n:]


def parse(header):
    status, reviewed, slices, marks = "none", "", {}, {}
    for line in header:
        key, _, value = line.partition(":")
        if key == "status":
            v = value.split("#", 1)[0].strip()
            status = v if v in STATUSES else status
        elif key == "reviewed":
            reviewed = value.strip()
        elif (m := SLICE_LINE.match(line)):
            try:
                files = [f for f in json.loads(m.group(3)) if isinstance(f, str)]
            except ValueError:
                continue
            slices[m.group(1)] = (m.group(2), files)
        else:
            for name, (rx, _) in TREE_LINES.items():
                if (m := rx.match(line)):
                    marks[name] = m.group(1)
    return status, reviewed, slices, marks


def read(plan, base):
    out = {"planStatus": "none", "reviewed": "", "slices": [],
           "build": {"recorded": False, "matches": False}, "review": {"recorded": False, "matches": False},
           "tree": [], "unclaimed": [], "error": ""}
    header = []
    if os.path.isfile(plan):
        with open(plan, encoding="utf-8") as fh:
            header, _ = split(fh.read())
    out["planStatus"], out["reviewed"], slices, marks = parse(header)
    try:
        root = repo_root()
        files = tree(base)
    except GitError as exc:
        out["error"] = str(exc)
        return out
    out["tree"] = files

    # A slice claims its files whether or not they still match: a mismatched slice is re-run, and
    # its files are its own work to redo, not somebody else's to ask about. A build or review line
    # that still matches vouches for the whole tree, because the fixers after the slices edit files
    # no slice claimed, and those edits were built or reviewed with everything else.
    claimed = set()
    for label, (sha, fs) in slices.items():
        out["slices"].append({"label": label, "files": fs, "matches": digest(root, fs) == sha})
        claimed.update(fs)
    whole = digest(root, files)
    for name, sha in marks.items():
        out[name] = {"recorded": True, "matches": sha == whole}
        if sha == whole:
            claimed.update(files)
    out["unclaimed"] = [f for f in files if f not in claimed]
    return out


# Implementers report the files they changed in whatever form they saw them — a repo path, an
# absolute path, sometimes a bare file name. A claim that names no real path claims nothing, and the
# file it meant then reads as unclaimed on a resume, so a bare name is mapped to the one tree path
# it can only mean. An ambiguous name is kept as given: guessing between two files is the wrong
# answer this script exists not to give.
def resolve(root, files, base):
    try:
        in_tree = tree(base)
    except GitError:
        in_tree = []
    out = []
    # Compared through realpath, never abspath: `git rev-parse --show-toplevel` hands back a path
    # with every symlink resolved, and a caller reports whatever it was handed. On macOS a repo
    # under TMPDIR is /var/folders/... to the caller and /private/var/folders/... to git, so an
    # abspath comparison finds no common root, the path is left absolute, and the claim then
    # matches nothing — the slice reads as having claimed no files and every one of them resurfaces
    # as unclaimed. That is the fail-open direction: a resume redoes work a slice already did.
    real_root = os.path.realpath(root)
    for f in files:
        if os.path.isabs(f):
            real_f = os.path.realpath(f)
            try:
                inside = os.path.commonpath([real_root, real_f]) == real_root
            except ValueError:      # different drives, or a path this cannot be asked of
                inside = False
            if inside:
                f = os.path.relpath(real_f, real_root)
        if f in in_tree or os.path.exists(os.path.join(root, f)):
            out.append(f)
            continue
        hits = [t for t in in_tree if t.endswith("/" + f)]
        out.append(hits[0] if len(hits) == 1 else f)
    return sorted(set(out))


def mark(plan, base, key, note, files):
    if not os.path.isfile(plan):
        return {"written": False, "line": "", "error": f"{plan}: no such plan file"}
    kind, _, label = key.partition(":")
    try:
        if kind == "reviewed":
            stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
            line, prefix = f"reviewed: {' '.join((note or '').split())} · {stamp}", "reviewed:"
        elif kind == "slice":
            if not LABEL.match(label):
                return {"written": False, "line": "", "error": f"slice label {label!r} is not [A-Za-z0-9_.-]+"}
            root = repo_root()
            claimed = resolve(root, files or [], base)
            line = f"slice {label}: done sha256={digest(root, claimed)} files={json.dumps(claimed, separators=(',', ':'))}"
            prefix = f"slice {label}:"
        else:
            root = repo_root()
            line, prefix = f"{TREE_LINES[kind][1]} sha256={digest(root, tree(base))}", f"{kind}:"
    except GitError as exc:
        return {"written": False, "line": "", "error": str(exc)}

    # Slices finish in parallel and each marks its own line, so the read-modify-write is locked:
    # without it two marks landing together keep only the one that wrote last.
    with open(plan, "r+", encoding="utf-8") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        header, body = split(fh.read())
        header = [h for h in header if not h.startswith(prefix)] + [line]
        fh.seek(0)
        fh.write("\n".join(header + body))
        fh.truncate()
    return {"written": True, "line": line, "error": ""}


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("mode", choices=("read", "mark"))
    ap.add_argument("--plan", required=True)
    ap.add_argument("--base", required=True)
    ap.add_argument("--key")
    ap.add_argument("--note", default="")
    ap.add_argument("--files", nargs="*", default=[])
    args = ap.parse_args()

    if args.mode == "read":
        print(json.dumps(read(args.plan, args.base)))
        return
    if not args.key or not (args.key in ("reviewed", "build", "review") or args.key.startswith("slice:")):
        ap.error("--key must be reviewed, build, review or slice:<label>")
    print(json.dumps(mark(args.plan, args.base, args.key, args.note, args.files)))


if __name__ == "__main__":
    main()
