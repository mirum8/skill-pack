#!/usr/bin/env python3
"""Append one review-run record to ~/.claude/review-stats.jsonl.

Reads a JSON object on stdin, stamps it with a timestamp and the repo it ran in,
and appends it as a single line. Nothing else — this is a sink, not a reporter.

Why a script instead of a shell redirect: the caller is a subagent holding a JSON
blob full of quotes, braces and non-ASCII finding text. Piping it on stdin avoids
shell-quoting it, which is the one way this could silently corrupt the file.

Two properties the rest of the pipeline depends on:

  * It NEVER fails the caller. Every error path exits 0 with a note on stderr. A
    statistics sink that can halt a code review is worse than no sink at all —
    the review is the product, this is bookkeeping about the review.
  * The append is ATOMIC for concurrent writers. post-task-review runs in parallel
    across git worktrees, so several processes can append at once. A single
    os.write() to an O_APPEND fd is atomic up to PIPE_BUF (4096 on macOS), so the
    record is capped below that and written in one syscall. Over the cap it is
    truncated (with a marker) rather than risking an interleaved line that would
    corrupt every reader downstream.

Usage:  echo '{"reviewed":true,...}' | record-run.py [--path FILE]
"""
import json
import os
import sys
from datetime import datetime, timezone

CAP = 4000  # under PIPE_BUF (4096) including the newline — see the atomicity note above
DEFAULT_PATH = os.path.expanduser("~/.claude/review-stats.jsonl")

# Which generation of the track set wrote this row. review-stats.py needs it to answer "did this
# track run?" for a store that spans a change to the track set — without it, a newly added track
# looks like it ran in every historical row and found nothing, which is exactly the false evidence
# that would get it retired. Bump this whenever a track is added, removed or merged, and add the
# matching entry to TRACK_REVS in review-stats.py.
#   1 — the original five hunters
#   2 — concurrency + silent-failures merged into runtime-and-failures
PIPELINE_REV = 2


def repo_name() -> str:
    """Best-effort repo identity: the git toplevel's basename, else the cwd's."""
    try:
        import subprocess
        out = subprocess.run(["git", "rev-parse", "--show-toplevel"],
                             capture_output=True, text=True, timeout=5)
        if out.returncode == 0 and out.stdout.strip():
            return os.path.basename(out.stdout.strip())
    except Exception:
        pass
    return os.path.basename(os.getcwd()) or "unknown"


def shrink(rec: dict) -> str:
    """Serialize compactly, dropping the fattest optional fields until it fits.

    Order matters: free-text lists go first because they are the only unbounded
    fields, and a count of them survives in the record either way.
    """
    line = json.dumps(rec, separators=(",", ":"), ensure_ascii=False)
    if len(line.encode()) <= CAP:
        return line
    for field in ("docDrift", "endVerifyFindings", "uiFindings", "profileReason"):
        if field in rec:
            rec[field] = f"<dropped: {len(rec[field])} item(s), record too large>" \
                if isinstance(rec[field], list) else "<dropped>"
            line = json.dumps(rec, separators=(",", ":"), ensure_ascii=False)
            if len(line.encode()) <= CAP:
                return line
    minimal = {k: rec.get(k) for k in ("ts", "repo", "kind", "profile", "pipeline") if k in rec}
    minimal["truncated"] = True
    return json.dumps(minimal, separators=(",", ":"), ensure_ascii=False)


def main() -> int:
    path = DEFAULT_PATH
    argv = sys.argv[1:]
    if "--path" in argv:
        i = argv.index("--path")
        if i + 1 < len(argv):
            path = os.path.expanduser(argv[i + 1])

    try:
        raw = sys.stdin.read()
        rec = json.loads(raw)
        if not isinstance(rec, dict):
            raise ValueError("top-level JSON must be an object")
    except Exception as exc:  # noqa: BLE001 — a bad record must not fail the review
        print(f"record-run: not recorded ({exc})", file=sys.stderr)
        return 0

    rec.setdefault("ts", datetime.now(timezone.utc).isoformat(timespec="seconds"))
    rec.setdefault("repo", repo_name())
    rec.setdefault("origin", "live")
    rec.setdefault("pipeline", PIPELINE_REV)

    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        line = shrink(rec) + "\n"
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
        try:
            os.write(fd, line.encode())  # one syscall — atomic under PIPE_BUF
        finally:
            os.close(fd)
        print(f"record-run: recorded to {path}", file=sys.stderr)
    except Exception as exc:  # noqa: BLE001
        print(f"record-run: not recorded ({exc})", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
