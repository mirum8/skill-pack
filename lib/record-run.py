#!/usr/bin/env python3
"""Record one run into ~/.claude/skill-stats.db — the pack-wide stats store.

Reads a JSON object on stdin, stamps it, and writes it as one `runs` row plus one `findings`
row per finding, in a single transaction. Nothing else — this is a sink, not a reporter.
`lib/skill-stats.py` reads it back.

Every skill in the pack writes here, which is why it lives in lib/ rather than inside one
skill's scripts/: a store owned by one skill stays that skill's store.

Why a script instead of a shell redirect: the caller is a subagent holding a JSON blob full of
quotes, braces and non-ASCII finding text. Piping it on stdin avoids shell-quoting it, which is
the one way this could silently corrupt the record.

THE ONE PROMISE EVERY CALLER LEANS ON: it never fails the caller. Every error path exits 0 with
a note on stderr. A statistics sink that can halt a code review is worse than no sink at all —
the work is the product, this is bookkeeping about the work. There is no fallback store: a row
that cannot be written is lost, and the reason is printed.

Concurrency is real — task-review runs in parallel across git worktrees — and is handled by WAL
plus a busy timeout rather than by keeping records small. Measured: 8 concurrent writers × 50
inserts wrote 400/400 rows.

Two row shapes share `runs`, told apart by `event`:

  * event=invoke — one per skill invocation, written by hooks/record-skill-run.py. This is what
    run COUNTS come from.
  * event=result — an outcome a skill reports about itself, carrying its findings. Never counted
    as a run, because the same run already produced an invoke row.

Usage:  echo '{"skill":"r:code-bugs","findings":[…]}' | record-run.py [--db FILE]
"""
import json
import os
import sqlite3
import subprocess
import sys
import uuid
from datetime import datetime, timezone

DEFAULT_DB = os.path.expanduser("~/.claude/skill-stats.db")
SCHEMA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "schema.sql")

# Long enough that a parallel worktree review waits rather than losing its row, short enough that
# a wedged writer cannot stall the caller for a visible fraction of a review.
BUSY_TIMEOUT_MS = 10_000

# A backstop, not the budget. Callers trim harder at the source — a workflow keeps its finding
# titles near 200 characters because the whole payload travels inside an agent prompt — and this
# only catches a caller that did not.
DESC_CAP = 400

# Which generation of the review track set wrote this row. skill-stats.py needs it to answer "did
# this track run?" for a store that spans a change to the track set — without it, a newly added
# track looks like it ran in every historical row and found nothing, which is exactly the false
# evidence that would get it retired. Bump this whenever a track is added, removed or merged, and
# add the matching entry to TRACK_REVS in skill-stats.py.
#   1 — the original five hunters
#   2 — concurrency + silent-failures merged into runtime-and-failures
PIPELINE_REV = 2

# The two skills that identify themselves by `kind` rather than by name — every row the store held
# before it went pack-wide, and anything still sending the older payload.
KIND_SKILL = {"review": "r:task-review", "implement": "r:task-run"}

RUN_COLUMNS = ("run_id", "ts", "repo", "skill", "event", "via", "origin", "session_id",
               "kind", "profile", "profile_forced", "invoked_by", "commit_sha",
               "files_changed", "lines_added", "lines_removed", "payload")
FINDING_COLUMNS = ("run_id", "track", "category", "severity", "file", "line",
                   "verdict", "fixed", "description")


def git(*args, cwd=None):
    try:
        out = subprocess.run(["git", *args], capture_output=True, text=True, timeout=5, cwd=cwd)
        return out.stdout.strip() if out.returncode == 0 else ""
    except Exception:
        return ""


def repo_name() -> str:
    """Best-effort repo identity: the git toplevel's basename, else the cwd's."""
    top = git("rev-parse", "--show-toplevel")
    return os.path.basename(top) if top else (os.path.basename(os.getcwd()) or "unknown")


def changeset():
    """(commit_sha, files, added, removed) for the working tree, best effort.

    Filled only when the caller did not say. A skill that knows what it reviewed — a commit range,
    a fixed file list — is a better source than the tree as it looks now, which a fix step may
    already have changed.
    """
    sha = git("rev-parse", "HEAD")
    files = added = removed = None
    numstat = git("diff", "HEAD", "--numstat")
    if numstat:
        rows = [r.split("\t") for r in numstat.splitlines() if r]
        files = len(rows)
        added = sum(int(r[0]) for r in rows if r[0].isdigit())
        removed = sum(int(r[1]) for r in rows if len(r) > 1 and r[1].isdigit())
    return sha or None, files, added, removed


def connect(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    con = sqlite3.connect(path, timeout=BUSY_TIMEOUT_MS / 1000)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS}")
    con.execute("PRAGMA foreign_keys=ON")
    with open(SCHEMA, encoding="utf-8") as fh:
        con.executescript(fh.read())
    return con


def normalise(rec: dict) -> dict:
    """Stamp the fields every reader keys on. Mutates and returns the record."""
    rec.setdefault("ts", datetime.now(timezone.utc).isoformat(timespec="seconds"))
    rec.setdefault("run_id", str(uuid.uuid4()))
    rec.setdefault("event", "result")
    rec.setdefault("origin", "live")
    rec.setdefault("repo", repo_name())
    if "skill" not in rec and rec.get("kind") in KIND_SKILL:
        rec["skill"] = KIND_SKILL[rec["kind"]]
    # The session this ran in. Exposed to every tool process, and the hook passes its own; it is
    # what joins an invoke row to its result row and points at the transcript on disk.
    if not rec.get("session_id"):
        sid = os.environ.get("CLAUDE_CODE_SESSION_ID")
        if sid:
            rec["session_id"] = sid
    # Only review rows carry it: the number names a generation of the REVIEW track set, and on a
    # commit or scan row it would answer a question those rows cannot be asked. A review row
    # WITHOUT it resolves to rev 1 in the reporter, which would credit today's tracks with the
    # opportunities of a track set retired months ago.
    if rec.get("kind") == "review":
        rec.setdefault("pipeline", PIPELINE_REV)
    if rec.get("event") == "result" and "commit_sha" not in rec:
        sha, files, added, removed = changeset()
        rec.setdefault("commit_sha", sha)
        rec.setdefault("files_changed", files)
        rec.setdefault("lines_added", added)
        rec.setdefault("lines_removed", removed)
    return rec


def finding_rows(rec):
    """One tuple per finding. Unknown fields are dropped, not guessed — a finding with no verdict
    reads as `unresolved`, which is a different claim from `dismissed` and must stay one."""
    out = []
    for f in rec.get("findings") or []:
        if not isinstance(f, dict):
            f = {"description": str(f)}
        line = f.get("line")
        desc = str(f.get("description") or f.get("what") or f.get("item") or "")[:DESC_CAP]
        out.append((
            rec["run_id"],
            f.get("track") or f.get("source"),
            f.get("category"),
            f.get("severity"),
            f.get("file"),
            int(line) if isinstance(line, (int, float)) or str(line).isdigit() else None,
            f.get("verdict") or "unresolved",
            1 if f.get("fixed") else 0,
            desc,
        ))
    return out


def write(rec: dict, db: str) -> str:
    """Insert the run and its findings in one transaction. Returns the run_id."""
    con = connect(db)
    try:
        with con:
            con.execute(
                f"INSERT INTO runs ({','.join(RUN_COLUMNS)}) "
                f"VALUES ({','.join('?' * len(RUN_COLUMNS))})",
                tuple(json.dumps(rec, separators=(",", ":"), ensure_ascii=False)
                      if c == "payload" else rec.get(c) for c in RUN_COLUMNS))
            rows = finding_rows(rec)
            if rows:
                con.executemany(
                    f"INSERT INTO findings ({','.join(FINDING_COLUMNS)}) "
                    f"VALUES ({','.join('?' * len(FINDING_COLUMNS))})", rows)
        return rec["run_id"]
    finally:
        con.close()


def main() -> int:
    db = DEFAULT_DB
    argv = sys.argv[1:]
    if "--db" in argv:
        i = argv.index("--db")
        if i + 1 < len(argv):
            db = os.path.expanduser(argv[i + 1])

    try:
        rec = json.loads(sys.stdin.read())
        if not isinstance(rec, dict):
            raise ValueError("top-level JSON must be an object")
    except Exception as exc:  # noqa: BLE001 — a bad record must not fail the caller
        print(f"record-run: not recorded ({exc})", file=sys.stderr)
        return 0

    try:
        normalise(rec)
        run_id = write(rec, db)
        n = len(rec.get("findings") or [])
        # The run_id is printed because the stats step's prompt tells the agent to return this line
        # verbatim, which lands it in the workflow journal — that is what lets --mine-items attribute
        # a whole workflow directory to this run without guessing from timestamps.
        print(f"record-run: recorded run {run_id} ({n} finding(s)) to {db}", file=sys.stderr)
    except Exception as exc:  # noqa: BLE001
        print(f"record-run: not recorded ({exc})", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
