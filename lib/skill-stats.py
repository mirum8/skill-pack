#!/usr/bin/env python3
"""Read the pack-wide stats store and answer: which skill, and which review track, earns its keep?

    skill-stats.py                   # print the summary
    skill-stats.py --review          # only the review-pipeline section
    skill-stats.py --import-jsonl    # copy the pre-SQLite JSONL archive in, once
    skill-stats.py --mine-items      # fill `items` from the workflow transcripts on disk
    skill-stats.py --backfill        # mine past review runs out of Claude Code transcripts, then print
    skill-stats.py --db FILE         # use a different store
    skill-stats.py --jsonl-path F    # use a different JSONL archive to import from
    skill-stats.py --json            # machine-readable rows

THE STORE
---------
~/.claude/skill-stats.db (SQLite, WAL). Four tables — `runs`, `findings`, `items`, `meta` — defined
in schema.sql, written by record-run.py, read here. Every run row keeps the caller's JSON verbatim
in `payload`, so this report can read fields no column exists for, and a skill can add one without
a migration.

~/.claude/skill-stats.jsonl is the append-only store that predates the db. It is never written now.
`--import-jsonl` copies its rows in once, deriving each run_id from a hash of the line it came
from, so a second import inserts nothing and the original file stays where it is.

WHAT THE NUMBERS CAN AND CANNOT TELL YOU
----------------------------------------
Runs are counted from `invoke` rows, which the hook writes once per invocation. `result` rows carry
what a skill found and are never counted as runs: the same run already produced an invoke row, and
counting both would double every number. Both carry `session_id`, which is what joins them.

`fixes by source` counts correctness items that survived triage (judged real and handed to a
fixer), attributed to the track that found them. `precision by track` is its other half, and the
more decisive one: a track that finds ten real things triage rejects scores zero for fixes just
like a track that finds nothing, and only the verdicts tell those two apart.

Three honesty caveats the summary repeats, because they decide whether a zero means anything:

  * A skill with no invoke rows was never OBSERVED, which is not the same as never used. The hook
    records from the moment it is installed; everything before that is invisible here.
  * Back-filled rows have NO attribution. Attribution was added on 2026-07-27; every
    run before it is recoverable only as aggregate counts. Those rows are marked
    origin=backfill and are excluded from the per-track table.
  * A track that did not RUN cannot find anything. `logic` scores zero on every
    standard-tier run because standard does not dispatch it — the per-track table
    therefore reports opportunities (runs where the track ran) alongside hits.

`implement depth` asks the one question the cost table cannot: whether the implementers can be run
cheaper. It buckets each implement run by the reasoning EFFORT mined off its items and prints what
the review found afterwards beside it, so a saving that merely moved work into fix-correctness and
end-verify-fix is visible as such. The review it pairs is a positional guess — same repo, the next
pipeline-invoked review inside 12h — because nothing records which run a review read.

The local-scan track is absent from that table by construction, not by scoring zero: it applies
its own fixes instead of handing them to triage, so no fix can be attributed to it. Its
yield is the separate self-fix line below the status counts.
"""
import argparse
import collections
import glob
import hashlib
import importlib.util
import json
import os
import re
import sqlite3
import sys
import uuid
from datetime import datetime, timedelta, timezone

DEFAULT_DB = os.path.expanduser("~/.claude/skill-stats.db")
JSONL_ARCHIVE = os.path.expanduser("~/.claude/skill-stats.jsonl")
LIB = os.path.dirname(os.path.abspath(__file__))


PROJECTS = os.path.expanduser("~/.claude/projects")
PACK = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# The task-review return object as it appears (JSON-escaped) inside a transcript line.
# Anchored on both ends so a partial match can't parse into a misleading half-record.
RETURN_RE = re.compile(r'\{"reviewed":true.*?"step9":"main-agent"\}')

# The two skills that identify themselves by `kind` rather than by name — every row the store held
# before it went pack-wide, and anything still sending the older payload.
KIND_SKILL = {"review": "r:task-review", "implement": "r:task-run"}

# Which tracks each tier actually dispatches — needed to turn "0 findings" into either
# "found nothing" or "never asked". Mirrors HUNTER_SET / codexMode / wantQuality.
#
# This is versioned because the track SET changes over time, and a store spanning the change would
# otherwise lie in both directions: a track retired last month looks like it "ran" in runs after it
# was gone, and a track added last week looks like it ran in every historical row and found nothing
# — which lands it straight in the "never produced a fix, consider retiring" list on evidence that
# does not exist. `record-run.py` stamps every new review row with PIPELINE_REV; rows written before
# the stamp existed have no key and resolve to rev 1.
#
# rev 1 — the original five hunters.
# rev 2 — `concurrency` + `silent-failures` merged into `runtime-and-failures` (they returned 0.25
#         and 0.12 fixes/run for two whole contexts re-reading the same diff).
# rev 3 — `security` became a pattern hunter over security.md instead of a wrapper around the
#         bundled /security-review. The membership below is IDENTICAL to rev 2 on purpose: no
#         track was added, removed or merged. The rev exists because the *tool* changed, and
#         without the boundary this hunter inherits 27 rev-1/2 runs at 0.00 fixes/run measured on
#         a tool that read a different changeset every time — the exact false evidence the
#         retirement list acts on.
# rev 4 — `docs` retired from this pipeline. It is still /r:code-bugs' Agent 5, so the track name
#         survives in the store and in SURFACED_ONLY below; what changed is that a review no
#         longer dispatches it, and rows from here on must not count as opportunities it had.
TRACK_REVS = {
    1: {
        "light":    set(),
        "standard": {"codex", "security", "docs"},
        "full":     {"codex", "security", "docs", "logic", "concurrency", "silent-failures"},
    },
    2: {
        "light":    set(),
        "standard": {"codex", "security", "docs"},
        "full":     {"codex", "security", "docs", "logic", "runtime-and-failures"},
    },
    3: {
        "light":    set(),
        "standard": {"codex", "security", "docs"},
        "full":     {"codex", "security", "docs", "logic", "runtime-and-failures"},
    },
    4: {
        "light":    set(),
        "standard": {"codex", "security"},
        "full":     {"codex", "security", "logic", "runtime-and-failures"},
    },
}
LATEST_REV = max(TRACK_REVS)

# Tracks the review SURFACES but never routes to a fixer, and the payload counter carrying what each
# one produced. A track in here cannot appear in `fixedBySource` at all, so "never produced a fix"
# measures nothing about it: doc drift resolves to update-doc / update-code / confirm-intent, which
# is the USER's call, so the pipeline reports it and stops. Reading that structural zero as a dead
# track is measuring the metric rather than the tool — and it is the retirement list below that
# would act on it, recommending the deletion of a hunter doing exactly its job, on every run,
# forever. Per-finding rows carry the same fact as verdict='unresolved'; this counter is what the
# runs recorded before those rows existed, and the only evidence most stored runs have.
SURFACED_ONLY = {"docs": "docDriftCount"}

# A review names a dead track in the CALLER's vocabulary, which is not this table's. The hunter
# fan-out is reported under ONE name — the scan's, or the security hunter's alone at a tier where
# that hunter is all the scan has left — while the tier dispatches its members separately and
# scores them separately. Expanding the alias is what makes a scan that never ran subtract from
# every hunter it stood for; without it the subtraction quietly covers only `codex` and `docs` and
# misses the most expensive thing that can fail here. Which hunters a name stood for is a TIER
# question, so these are intersected with the row's own tier rather than applied whole. Both
# revisions' member names are listed for the same reason: the intersection is what decides, so a
# name belonging to the other rev simply drops out.
#
# The keys are strings ANOTHER file emits. `lib/tests/stats.test.sh` checks them against it — a
# rename there would otherwise stop the subtraction silently, with no error and no empty column.
HUNTER_ALIASES = {
    "find-bugs": {"logic", "runtime-and-failures", "concurrency", "silent-failures", "security"},
    "security hunter": {"security"},
}


def drifted_names(row):
    """The hunter names inside `tracksDrifted`, whose entries read `find-bugs (security)`.

    A drifted track ran its tool and got a real report about the WRONG changeset, so for a
    denominator it is exactly a track that did not run: it had no chance to find anything in this
    diff. Counting it as an opportunity is what made `security` read as 26 dispatches with 0 fixes
    and land on the retirement list, when it had never been pointed at the diff at all.

    The parenthetical is the authority when present, because it names the hunter that drifted
    rather than the track that contains it; below full tier the track is already named for its one
    hunter and there is no parenthetical to read."""
    out = []
    for entry in row.get("tracksDrifted") or []:
        if not isinstance(entry, str):
            continue
        inner = re.search(r"\(([^)]*)\)", entry)
        if inner:
            out.extend(h.strip() for h in inner.group(1).split(",") if h.strip())
        else:
            out.append(entry.strip())
    return out


def missed_tracks(row):
    """The tracks this row dispatched on paper and never actually ran — a per-diff gate closed
    (`tracksSkipped`), the tool failed (`tracksBlocked`), or it ran and read a different changeset
    (`tracksDrifted`). The three are different in meaning and are reported apart, but they are the
    same thing to a denominator: the track had no chance to produce a fix on THIS diff, so counting
    the run as an opportunity divides its yield by a diff it never saw.

    A name that maps to nothing is left alone rather than guessed at. That leaves the denominator
    too generous, which under-states the track — the safe direction, because the number is read to
    decide what to delete."""
    tier = tier_tracks(row)
    out = set()
    for name in (list(row.get("tracksSkipped") or [])
                 + list(row.get("tracksBlocked") or [])
                 + drifted_names(row)):
        if name in tier:
            out.add(name)
        else:
            out |= HUNTER_ALIASES.get(name, set()) & tier
    return out


def sink():
    """The writer, imported rather than reimplemented — one definition of the INSERT and of the
    column list, so a schema change cannot land in the sink and miss the importers here."""
    spec = importlib.util.spec_from_file_location("record_run", os.path.join(LIB, "record-run.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def tier_tracks(row):
    """The tracks this row's tier dispatched, as of the pipeline revision that wrote it."""
    rev = row.get("pipeline")
    if not isinstance(rev, int) or rev not in TRACK_REVS:
        rev = 1 if rev is None else LATEST_REV
    return TRACK_REVS[rev].get(row.get("profile") or "", set())


def packed_skills():
    """The r:-prefixed names of the skills that ship in this pack, read from the pack itself.

    Read rather than listed so a renamed or added skill cannot silently drop out of the
    never-observed line — which is the one place a missing name reads as good news.
    """
    d = os.path.join(PACK, "skills")
    if not os.path.isdir(d):
        return set()
    return {"r:" + n for n in os.listdir(d) if os.path.isdir(os.path.join(d, n))}


def normalise(row):
    """Give an archived or mined row the fields every reader keys on.

    This is the IMPORT path's stamping — rows that already happened, read off disk. The sink's own
    normalise() stamps a LIVE run and deliberately differs: it fills repo, session and changeset
    from the current environment, which would be a lie about a row mined from an archive.

    `origin` is set here rather than left to the column default because passing an explicit NULL
    overrides a DEFAULT and the column is NOT NULL, so a row without it is rejected — silently, if
    the insert says `OR IGNORE`. That is why the inserts below name the one conflict they mean to
    ignore.
    """
    row.setdefault("event", "result")
    row.setdefault("origin", "live")
    if "skill" not in row and row.get("kind") in KIND_SKILL:
        row["skill"] = KIND_SKILL[row["kind"]]
    return row


def connect(db, create=True):
    if not create and not os.path.exists(db):
        return None
    return sink().connect(db)


def load(db):
    """Every run as a plain dict — the stored `payload` merged under the stamped columns.

    Reading rows back into the shape they were written in is what lets the report below stay
    exactly as it was: the review analysis reads two dozen fields that will never be columns,
    and none of them had to be re-expressed as SQL to move the store.
    """
    con = connect(db, create=False)
    if con is None:
        return []
    try:
        con.row_factory = sqlite3.Row
        rows = []
        for r in con.execute("SELECT * FROM runs ORDER BY ts"):
            d = dict(r)
            payload = d.pop("payload", None)
            if payload:
                try:
                    d = {**json.loads(payload), **{k: v for k, v in d.items() if v is not None}}
                except Exception:
                    pass
            rows.append(d)
        return rows
    finally:
        con.close()


def import_jsonl(db, archive):
    """Copy the pre-SQLite JSONL archive into the db, once.

    Each row's run_id is derived from a hash of the line it came from, so the primary key makes a
    second import a no-op — there is no separate bookkeeping to keep in step. The archive is read
    and left exactly where it is: this is a copy, never a move.
    """
    if not os.path.exists(archive):
        print(f"import: nothing at {archive}\n")
        return
    mod = sink()
    con = connect(db)
    added = skipped = 0
    try:
        with con:
            for line in open(archive, encoding="utf-8", errors="replace"):
                line = line.strip()
                if not line:
                    continue
                try:
                    row = normalise(json.loads(line))
                except Exception:
                    continue
                row["run_id"] = str(uuid.uuid5(uuid.NAMESPACE_URL, "skill-stats/" + line))
                row.setdefault("ts", "")
                # `event` is whatever the row already said. The archive spans the arrival of the
                # hook, so it holds real `invoke` rows too — forcing everything to `result` would
                # erase the only invocations recorded before the db existed.
                row.setdefault("event", "result")
                row["store"] = "jsonl-archive"
                cur = con.execute(
                    f"INSERT INTO runs ({','.join(mod.RUN_COLUMNS)}) "
                    f"VALUES ({','.join('?' * len(mod.RUN_COLUMNS))}) "
                    f"ON CONFLICT(run_id) DO NOTHING",
                    tuple(json.dumps(row, separators=(",", ":"), ensure_ascii=False)
                          if c == "payload" else row.get(c) for c in mod.RUN_COLUMNS))
                if cur.rowcount:
                    added += 1
                else:
                    skipped += 1
    finally:
        con.close()
    print(f"import: {added} row(s) copied from {archive}, {skipped} already there "
          f"(the archive is unchanged)\n")


def backfill(path, known_bfids):
    """Recover pre-instrumentation review runs from transcripts. Idempotent: each recovered
    record carries a content hash, and one already in either store is skipped."""
    existing = set(known_bfids)
    already = len(existing)
    # `found` counts raw matches, which over-counts: one return object is echoed across several
    # transcript lines (queue-operation, user, assistant). `unique` is the real run count.
    found, unique, out = 0, set(), []
    for fn in sorted(glob.glob(os.path.join(PROJECTS, "*", "*.jsonl"))):
        try:
            mtime = datetime.fromtimestamp(os.path.getmtime(fn), timezone.utc)
        except OSError:
            mtime = None
        project = os.path.basename(os.path.dirname(fn))
        with open(fn, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                if "tracksBlocked" not in line:
                    continue
                try:
                    blob = json.dumps(json.loads(line))
                except Exception:
                    continue
                for m in RETURN_RE.finditer(blob.replace('\\"', '"').replace("\\\\", "\\")):
                    raw = m.group(0)
                    try:
                        d = json.loads(raw)
                    except Exception:
                        continue
                    found += 1
                    bfid = hashlib.md5(raw.encode()).hexdigest()
                    unique.add(bfid)
                    if bfid in existing:
                        continue
                    existing.add(bfid)
                    fixed = d.get("fixed") or {}
                    out.append({
                        "ts": mtime.isoformat(timespec="seconds") if mtime else None,
                        "tsApprox": True,          # the transcript's mtime, not the run's clock
                        "origin": "backfill",
                        # Mined from a past transcript, so it is by definition a rev-1 run. Stated
                        # rather than left to the default so a later rev bump can't reinterpret it.
                        "pipeline": 1,
                        "bfid": bfid,
                        "kind": "review",
                        "skill": "r:task-review",
                        # An outcome, not an observed invocation: the hook did not exist when this
                        # ran, so it must not be counted as a run.
                        "event": "result",
                        "repo": project.split("-")[-1] or project,
                        # Pre-tier runs carry `trivial` instead of `profile`.
                        "profile": d.get("profile") or ("light" if d.get("trivial") else None),
                        "tracksBlocked": d.get("tracksBlocked") or [],
                        "fixedCorrectness": fixed.get("correctness"),
                        "fixedReadability": fixed.get("readability"),
                        "docDriftCount": len(d.get("docDrift") or []),
                        "endVerify": d.get("endVerify"),
                        "localScan": d.get("localScan"),
                        "build": d.get("build"),
                        # Carried only when the mined return object actually had it. Writing an
                        # explicit null for older transcripts would claim "no scan completed" for
                        # runs where one did — the key's ABSENCE is what says "not measured here".
                        **({"scanChangedCode": d["scanChangedCode"]}
                           if "scanChangedCode" in d else {}),
                        # deliberately NO fixedBySource — it did not exist yet, and an empty
                        # dict here would read as "every track found nothing"
                    })
    if out:
        mod = sink()
        con = connect(path)
        try:
            with con:
                for r in out:
                    # Derived from the content hash, so the primary key alone makes a re-run a
                    # no-op — the same property the JSONL import relies on.
                    r["run_id"] = str(uuid.uuid5(uuid.NAMESPACE_URL, "backfill/" + r["bfid"]))
                    con.execute(
                        f"INSERT INTO runs ({','.join(mod.RUN_COLUMNS)}) "
                        f"VALUES ({','.join('?' * len(mod.RUN_COLUMNS))}) "
                        f"ON CONFLICT(run_id) DO NOTHING",
                        tuple(json.dumps(r, separators=(",", ":"), ensure_ascii=False)
                              if c == "payload" else r.get(c) for c in mod.RUN_COLUMNS))
        finally:
            con.close()
    print(f"backfill: {found} transcript match(es) → {len(unique)} distinct run(s); "
          f"{len(out)} inserted, {len(unique) - len(out)} already in the store "
          f"(store held {already} back-filled row(s))\n")


def pct(n, d):
    return f"{100 * n / d:.0f}%" if d else "—"


def summarize_skills(rows):
    """The pack-wide half: who runs, where, and by which route."""
    invokes = [r for r in rows if r.get("event") == "invoke"]
    results = [r for r in rows if r.get("event") != "invoke"]

    print(f"SKILL INVOCATIONS  {len(invokes)}   ({len(results)} outcome row(s) alongside)")
    print()

    if not invokes:
        print("no invocation rows yet — hooks/record-skill-run.py records from the moment it is")
        print("installed, so an empty table here means the hook has not run, not that nothing has.")
        print()
    else:
        by_skill = collections.Counter(r.get("skill") or "<unattributed>" for r in invokes)
        vias = collections.defaultdict(collections.Counter)
        for r in invokes:
            vias[r.get("skill") or "<unattributed>"][r.get("via") or "?"] += 1
        print("runs by skill")
        for name, n in by_skill.most_common():
            route = " · ".join(f"{k} {v}" for k, v in sorted(vias[name].items()))
            print(f"  {name:<24}{n:>5}   {route}")
        print()

        by_repo = collections.Counter(r.get("repo") or "unknown" for r in invokes)
        print("runs by repo")
        for name, n in by_repo.most_common(10):
            print(f"  {name:<24}{n:>5}")
        if len(by_repo) > 10:
            print(f"  … and {len(by_repo) - 10} more")
        print()

    packed = packed_skills()
    if packed:
        # Judged on EVERY row, not just invoke rows. A skill that wrote an outcome plainly ran,
        # and calling it unobserved on the line above the table listing its outcomes is the false
        # zero this store exists to prevent — the one that retires a skill on evidence of nothing.
        dark = sorted(packed - {r.get("skill") for r in rows})
        outcome_only = sorted(({r.get("skill") for r in results} & packed)
                              - {r.get("skill") for r in invokes})
        if dark:
            print(f"never observed ({len(dark)}/{len(packed)}): {', '.join(dark)}")
            print("  (no row of any kind — that is 'not measured', not 'not useful')")
            print()
        if outcome_only:
            print(f"ran, but with no invocation recorded: {', '.join(outcome_only)}")
            print("  (the skill reported an outcome that no invoke row accounts for — the hook was")
            print("   not yet live, or the run arrived by a route it did not yet watch. Its runs")
            print("   are real, its run COUNT is not, so read the outcome table for these)")
            print()

    # Outcome rows are the only place a skill says what it FOUND. Which fields mean what is the
    # skill's business, so this reports the shape it can see — how many rows, from whom — and
    # leaves interpretation to the per-skill sections below.
    if results:
        by_skill = collections.Counter(r.get("skill") or "<unattributed>" for r in results)
        print("outcome rows by skill   (never counted as runs — see the header)")
        for name, n in by_skill.most_common():
            print(f"  {name:<24}{n:>5}")
        print()


def summarize_reviews(rows):
    reviews = [r for r in rows if r.get("kind") == "review"]
    impls = [r for r in rows if r.get("kind") == "implement"]
    if not reviews and not impls:
        print("no review or implement rows yet.")
        return
    live = [r for r in reviews if r.get("origin") != "backfill"]
    back = [r for r in reviews if r.get("origin") == "backfill"]

    print(f"REVIEW RUNS  {len(reviews)}   ({len(live)} instrumented · {len(back)} back-filled)")
    if impls:
        print(f"IMPLEMENT RUNS  {len(impls)}")
    print()

    # A forced tier is what someone TYPED, not what the classifier decided. Mixing the two makes
    # the distribution look like evidence about classification when it isn't — so they're split.
    # Back-filled rows have no profileForced field at all, so they can't be vouched for either.
    # Mutually exclusive, most-specific first: a back-filled row we've since confirmed was forced
    # counts as forced, not as unknown provenance.
    classified, forced, unknown = [], [], []
    for r in reviews:
        if r.get("profileForced"):
            forced.append(r)
        elif r.get("origin") == "backfill" or "profileForced" not in r:
            unknown.append(r)
        else:
            classified.append(r)

    print("tier distribution")
    for label, group in (("classified", classified), ("forced by a flag", forced),
                         ("provenance unknown (back-filled)", unknown)):
        if not group:
            continue
        c = collections.Counter(r.get("profile") or "<none>" for r in group)
        line = " · ".join(f"{k} {v}" for k, v in
                          sorted(c.items(), key=lambda kv: ("light standard full <none>".split()
                                                            .index(kv[0]) if kv[0] in
                                                            "light standard full <none>".split() else 9)))
        print(f"  {label:<34}{len(group):>4}   {line}")
    if not classified:
        print("  -> nothing here measures the classifier yet: every row is forced or back-filled.")
    print()

    direct = [r for r in reviews if r.get("invokedBy") == "direct"]
    if direct:
        print(f"note: {len(direct)} run(s) were invoked directly rather than by /r:task-run. Some of")
        print("those are RE-reviews of an already-fixed diff — their findings are not comparable")
        print("to a first pass, and this store cannot tell which. Weigh them accordingly.\n")

    # ---- the table this whole thing exists for -----------------------------
    print("fixes by source track   (instrumented runs only — back-filled runs have no attribution)")
    if not live:
        print("  no instrumented runs yet. Attribution starts accruing from the next review.")
    else:
        hits = collections.Counter()
        for r in live:
            for k, v in (r.get("fixedBySource") or {}).items():
                hits[k] += v
        # A track can only score on a run that dispatched it. The tier says which tracks were in
        # play; missed_tracks() says which of those never actually ran on THIS diff — a per-diff
        # gate closed it (the security hunter's `securitySurface`) or its tool failed. Count either
        # as an opportunity and the track's fixes-per-run is divided by runs it never saw.
        opps = collections.Counter()
        for r in live:
            missed = missed_tracks(r)
            for t in tier_tracks(r):
                # `+= 0` on purpose: a track whose gate closed on every run still gets a ROW, at
                # zero. Dropping it from the table would hide the one track nothing can be said
                # about behind the same blank as a track that does not exist — and this table is
                # read to decide what to delete.
                opps[t] += 0 if t in missed else 1
            if r.get("endVerify") in ("passed", "findings-unresolved"):
                opps["end-verify"] += 1
        # What the surfaced-only tracks handed the user, for the line under the table.
        surfaced = collections.Counter()
        for r in live:
            for t, key in SURFACED_ONLY.items():
                n = r.get(key)
                if isinstance(n, int):
                    surfaced[t] += n
        names = sorted(set(hits) | set(opps), key=lambda k: (-hits[k], k))
        print(f"  {'track':<16}{'fixes':>7}{'runs it ran in':>16}{'fixes/run':>12}")
        for t in names:
            # `n/a` rather than 0.00: the column does not apply to a track whose findings never
            # reach a fixer, and a printed zero is read as a yield.
            rate = ("n/a" if t in SURFACED_ONLY
                    else f"{hits[t] / opps[t]:.2f}" if opps[t] else "—")
            print(f"  {t:<16}{hits[t]:>7}{opps[t]:>16}{rate:>12}")
        for t in sorted(SURFACED_ONLY):
            if opps[t]:
                print(f"\n  {t}: {surfaced[t]} item(s) surfaced over {opps[t]} run(s), and 0 fixed BY")
                print("  DESIGN — the pipeline hands these to you rather than acting on them, so this")
                print("  track can never score above. It is not a retirement candidate; to judge it,")
                print("  read what it surfaced.")
        dark = [t for t in names
                if opps[t] >= 5 and hits[t] == 0 and t not in SURFACED_ONLY]
        if dark:
            print(f"\n  ran >=5 times and never produced a fix: {', '.join(dark)}")
            print("  (candidates for retirement — confirm the sample is big enough first)")
            # A denominator is only as good as the record of what did not run. A row missing
            # either field counts every tier track as an opportunity, including ones a per-diff
            # gate closed or a failed tool never reached — so for those runs the figure above is an
            # upper bound and the fixes-per-run a lower one. Said out loud rather than left to be
            # discovered: the whole point of this list is that somebody acts on it.
            blind = sum(1 for r in live
                        if "tracksSkipped" not in r or "tracksBlocked" not in r)
            if blind:
                print(f"  {blind}/{len(live)} of the runs behind these figures predate the record of")
                print("  what did NOT run, so their denominators still count tracks a per-diff gate")
                print("  closed or a failed tool never reached. Treat each as an upper bound.")
    print()

    blocked = collections.Counter()
    for r in reviews:
        for t in r.get("tracksBlocked") or []:
            blocked[t] += 1
    if blocked:
        print("blocked tracks  (the tool did not run — these runs certified less than they look)")
        for t, n in blocked.most_common():
            print(f"  {t:<26}{n:>4}")
        print()

    # Reported apart from `blocked` because the two need opposite fixes, and because this one is
    # the easier to miss: the tool ran, returned a real report, and reviewed a changeset nobody
    # asked about. Nothing in the run looks wrong.
    drifted = collections.Counter()
    for r in reviews:
        for t in r.get("tracksDrifted") or []:
            drifted[t] += 1
    if drifted:
        print("drifted tracks  (the tool RAN and read a different changeset — a clean report about")
        print("                 code this review never certified; make it read the right thing,")
        print("                 re-running it unchanged reproduces the same wrong-diff result)")
        for t, n in drifted.most_common():
            print(f"  {t:<26}{n:>4}")
        print()

    for field, title in (("endVerify", "end-verify outcome"),
                         ("localScan", "local-scan status"),
                         ("build", "build")):
        c = collections.Counter(r.get(field) for r in reviews if r.get(field))
        if c:
            print(f"{title}: " + " · ".join(f"{k} {v}" for k, v in c.most_common()))

    # The one yield number local-scan can produce. It never appears in `fixes by source` because it
    # applies its OWN fixes rather than handing them to the triage fix-list — so a zero there says
    # nothing about it, exactly like the docs hunter. What it can say is how often the scan rewrote
    # the code, which is also the expensive branch (it owes a rebuild and forces an end-verify).
    #
    # `in` and not `.get()`: a MISSING key is a row written before the field existed, and null is a
    # run where no scan completed. Neither is a scan that found nothing, and counting either as one
    # would manufacture the quiet-tool verdict this table exists to avoid.
    measured = [r for r in reviews
                if "scanChangedCode" in r and r["scanChangedCode"] is not None]
    if measured:
        hit = sum(1 for r in measured if r["scanChangedCode"])
        line = (f"local-scan self-fixed the code in {hit}/{len(measured)} "
                f"completed scan(s) ({pct(hit, len(measured))})")
        older = sum(1 for r in reviews
                    if "scanChangedCode" not in r and r.get("localScan"))
        if older:
            line += f"; {older} earlier row(s) predate the field"
        print(line)
    print()

    if impls:
        print("implement side")
        it = collections.Counter(r.get("profile") or "<none>" for r in impls)
        print("  tiers: " + " · ".join(f"{k} {v}" for k, v in it.most_common()))
        forced = sum(1 for r in impls if r.get("profileForced"))
        esc = sum(1 for r in impls if r.get("profileEscalated"))
        print(f"  forced by a flag: {forced}/{len(impls)}   escalated by riskFlags: {esc}/{len(impls)}")
        ap = sum(r.get("planApplied") or 0 for r in impls)
        dr = sum(r.get("planDropped") or 0 for r in impls)
        if ap or dr:
            print(f"  plan review: {ap} finding(s) folded in, {dr} judged false-positive")
        print()

    if back and not live:
        print("NOTE: every row here is back-filled, so the per-track table is empty by")
        print("construction. It fills in as instrumented reviews accumulate.")


# ---------------------------------------------------------------- implement depth ---
# `implement` is the pack's most expensive step, and the reasoning EFFORT its agents run at is a
# real lever on that cost — so whether a cheaper implementer buys the saving or merely moves the
# work downstream into fix-correctness and end-verify-fix has to be measured rather than argued.
#
# Nothing is recorded for this. `items.effort` is mined off disk with the rest of the item row, so
# the comparison reaches every run already made, the high-effort baseline included — which is the
# whole reason it can answer the question at all rather than starting a count from today.
#
# Two things it cannot see, both named in the output rather than left for the reader to assume:
#   * A run that stops early — the plan judged wrong, the build still red after three attempts —
#     never reaches the sink, so it leaves items behind and no run row. It is counted in the cost
#     columns and cannot be paired, so a depth that raises the STOP rate shows up here as reviews
#     going missing, not as worse reviews.
#   * The pairing is positional: a review has no field naming the implement run it reviewed, so it
#     is matched by repo and time. A pair is a strong guess, not a recorded fact.
PAIR_WINDOW = timedelta(hours=12)
EFFORT_ORDER = ("low", "medium", "high", "xhigh", "mixed", "unrecorded")
# The review's own record of having been driven by the pipeline. A review invoked DIRECTLY is
# usually a re-review of an already-fixed diff — the section above says so — and pairing one to an
# implement run would credit that run with a second pass's findings.
PIPELINE_CALLERS = {"run-task", "task-run", "r:task-run"}


def _when(row):
    """A row's timestamp as an aware datetime, or None. Naive stamps are read as UTC — every
    writer stamps UTC, and a mixed comparison raises rather than sorting wrongly."""
    try:
        t = datetime.fromisoformat(str(row.get("ts")).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def impl_depth_groups(db):
    """One entry per workflow run that dispatched implementers: its effort, cost and build-fixes."""
    con = connect(db, create=False)
    if con is None:
        return {}
    try:
        groups = {}
        for wf, rid, label, effort, tok, ms in con.execute(
                "SELECT wf_run_id, run_id, label, effort, "
                "       COALESCE(tokens_in,0)+COALESCE(tokens_out,0)+COALESCE(tokens_cache,0), "
                "       COALESCE(duration_ms,0) "
                "FROM items WHERE label IN ('implement','build-fix')"):
            g = groups.setdefault(wf, {"efforts": set(), "run_id": None, "agents": 0,
                                       "tokens": 0, "ms": 0, "buildFixes": 0})
            if rid:
                g["run_id"] = rid
            # A build-fix is the same agent at the same depth editing the code it just wrote, so it
            # is an OUTCOME of the depth, not a sample of it: counted, never bucketed.
            if label == "build-fix":
                g["buildFixes"] += 1
                continue
            g["efforts"].add(effort)
            g["agents"] += 1
            g["tokens"] += tok or 0
            g["ms"] += ms or 0
        for g in groups.values():
            named = {e for e in g["efforts"] if e}
            g["effort"] = ("unrecorded" if not named else
                           named.pop() if len(named) == 1 else "mixed")
        return {wf: g for wf, g in groups.items() if g["agents"]}
    finally:
        con.close()


def pair_reviews(impls, reviews):
    """Match each implement run to the review that followed it: same repo, next in time, inside the
    window, each review claimed once. Returns {run_id: review}."""
    free = sorted((r for r in reviews
                   if _when(r) and r.get("invokedBy") in PIPELINE_CALLERS
                   and r.get("origin") != "backfill"),
                  key=_when)
    taken, pairs = set(), {}
    for imp in sorted((i for i in impls if _when(i)), key=_when):
        at = _when(imp)
        for r in free:
            if id(r) in taken or r.get("repo") != imp.get("repo"):
                continue
            gap = _when(r) - at
            if gap < timedelta(0):
                continue
            if gap > PAIR_WINDOW:
                break
            taken.add(id(r))
            pairs[imp.get("run_id")] = r
            break
    return pairs


def summarize_impl_depth(db, rows):
    """Cost and downstream yield per implementer depth — the answer to 'can we run them cheaper?'"""
    groups = impl_depth_groups(db)
    if not groups:
        return
    impls = {r.get("run_id"): r for r in rows if r.get("kind") == "implement" and r.get("run_id")}
    pairs = pair_reviews(list(impls.values()), [r for r in rows if r.get("kind") == "review"])

    buckets = {}
    for g in groups.values():
        b = buckets.setdefault(g["effort"], {"runs": 0, "agents": 0, "tokens": 0, "ms": 0,
                                             "buildFixes": 0, "tiers": collections.Counter(),
                                             "reviews": []})
        b["runs"] += 1
        b["agents"] += g["agents"]
        b["tokens"] += g["tokens"]
        b["ms"] += g["ms"]
        b["buildFixes"] += g["buildFixes"]
        run = impls.get(g["run_id"])
        if run:
            b["tiers"][run.get("profile") or "<none>"] += 1
            review = pairs.get(g["run_id"])
            if review:
                b["reviews"].append(review)

    order = [e for e in EFFORT_ORDER if e in buckets]
    print("implement depth   (effort is mined from the items — the pipeline records nothing extra)")
    print(f"  {'effort':<12}{'runs':>6}{'agents':>8}{'avg Mtok':>10}{'avg secs':>10}"
          f"{'build-fix/run':>15}   tiers")
    for e in order:
        b = buckets[e]
        tiers = " · ".join(f"{k} {v}" for k, v in b["tiers"].most_common()) or "—"
        print(f"  {e:<12}{b['runs']:>6}{b['agents']:>8}"
              f"{b['tokens'] / b['agents'] / 1_000_000:>10.1f}"
              f"{b['ms'] / b['agents'] / 1000:>10.0f}"
              f"{b['buildFixes'] / b['runs']:>15.2f}   {tiers}")

    print()
    print(f"  what the review found next   (same repo, within {int(PAIR_WINDOW.total_seconds() // 3600)}h, "
          f"pipeline-invoked reviews only)")
    print(f"  {'effort':<12}{'paired':>8}{'correctness/run':>17}{'readability/run':>17}"
          f"{'end-verify passed':>20}")
    for e in order:
        rev = buckets[e]["reviews"]
        if not rev:
            print(f"  {e:<12}{0:>8}{'—':>17}{'—':>17}{'—':>20}")
            continue
        cor = sum(r.get("fixedCorrectness") or 0 for r in rev) / len(rev)
        rea = sum(r.get("fixedReadability") or 0 for r in rev) / len(rev)
        ev = [r for r in rev if r.get("endVerify")]
        passed = sum(1 for r in ev if r.get("endVerify") == "passed")
        print(f"  {e:<12}{len(rev):>8}{cor:>17.2f}{rea:>17.2f}"
              f"{(f'{passed}/{len(ev)}' if ev else '—'):>20}")

    total = sum(b["runs"] for b in buckets.values())
    unpaired = total - sum(len(b["reviews"]) for b in buckets.values())
    print()
    print(f"  {unpaired} of {total} implement run(s) have no review beside them: a run that")
    print("  stopped early never reaches the sink, and a review invoked directly is a re-review of")
    print("  an already-fixed diff rather than a first read of this one.")
    thin = [e for e in order if e not in ("mixed", "unrecorded") and buckets[e]["runs"] < 10]
    if thin:
        print("  Thin sample (<10 runs): " + ", ".join(thin) +
              " — read these as a direction to keep watching, not a verdict.")
    print()

# -------------------------------------------------------------------- plan depth ---
# The planning half costs MORE per run than the implementation it feeds — measured per run that
# reaches a plan: judges 11.0M tokens, planner 10.3M, explorers 7.5M, plan-fix 3.9M, ~39M in all
# against the implementers' 33.1M, and ~97% of it cache reads rather than output. So the same
# question the table above asks of the implementers is worth asking here, and it is asked the same
# way: bucket the runs by the depth they ran at, and print what the review found afterwards beside
# it, because a cheaper planner that pushes work into fix-correctness has moved cost, not saved it.
#
# The one thing it does NOT do is mine the effort off the items. It cannot: the planner's items come
# back at xhigh while the shipped row asks for high, because a subagent reports the tier it resolved
# to rather than the one it was dispatched with. The pipeline records the resolved row instead
# (planModel/planEffort, and the judges' beside it), so a run is bucketed by the setting somebody
# chose. Runs made before that field existed have nothing to bucket on and are named `unrecorded`
# rather than folded into a tier they may not have run at.
PLAN_LABELS = ("explore", "planner", "plan-light", "plan-write", "plan-check",
               "codex-plan-review", "judge", "cite", "plan-fix")
# The rubrics the Codex plan review tags its findings with. Only these tracks come from the plan
# review; every other track in the store belongs to /r:task-review.
PLAN_TRACKS = ("coverage", "grounding", "test-adequacy", "simplicity", "risk", "ui-design")


def plan_depth_groups(db):
    """One entry per workflow run that planned: its planning cost and how many readers it took."""
    con = connect(db, create=False)
    if con is None:
        return {}
    try:
        groups = {}
        for wf, rid, label, tok, ms in con.execute(
                "SELECT wf_run_id, run_id, label, "
                "       COALESCE(tokens_in,0)+COALESCE(tokens_out,0)+COALESCE(tokens_cache,0), "
                "       COALESCE(duration_ms,0) FROM items WHERE label IS NOT NULL"):
            step = str(label).split("#")[0]
            if step not in PLAN_LABELS:
                continue
            g = groups.setdefault(wf, {"run_id": None, "tokens": 0, "ms": 0,
                                       "planned": False, "batches": 0, "cites": 0})
            if rid:
                g["run_id"] = rid
            g["tokens"] += tok or 0
            g["ms"] += ms or 0
            if step in ("planner", "plan-light"):
                g["planned"] = True
            # The two triage lanes, counted apart: batches/run is the number the batching change is
            # read on, and the citation share is what says whether the cheap lane is reaching work.
            if step == "judge":
                g["batches"] += 1
            elif step == "cite":
                g["batches"] += 1
                g["cites"] += 1
        return {wf: g for wf, g in groups.items() if g["planned"]}
    finally:
        con.close()


def plan_findings(db):
    """{run_id: (confirmed, dismissed, unresolved)} over the plan review's own rubrics."""
    con = connect(db, create=False)
    if con is None:
        return {}
    try:
        out = collections.defaultdict(collections.Counter)
        marks = ",".join("?" * len(PLAN_TRACKS))
        for rid, verdict, n in con.execute(
                f"SELECT run_id, COALESCE(verdict,'unresolved'), COUNT(*) FROM findings "
                f"WHERE track IN ({marks}) GROUP BY run_id, verdict", PLAN_TRACKS):
            out[rid][verdict] += n
        return out
    finally:
        con.close()


def summarize_plan_depth(db, rows):
    """Cost and yield per PLANNING depth — the same question, asked of the pipeline's other half."""
    groups = plan_depth_groups(db)
    if not groups:
        return
    impls = {r.get("run_id"): r for r in rows if r.get("kind") == "implement" and r.get("run_id")}
    pairs = pair_reviews(list(impls.values()), [r for r in rows if r.get("kind") == "review"])
    found = plan_findings(db)

    buckets = {}
    for g in groups.values():
        run = impls.get(g["run_id"]) or {}
        model, effort = run.get("planModel"), run.get("planEffort")
        key = f"{model}/{effort}" if model and effort else "unrecorded"
        b = buckets.setdefault(key, {"runs": 0, "tokens": 0, "ms": 0, "batches": 0, "cites": 0,
                                     "conf": 0, "dism": 0, "unres": 0, "reviews": [],
                                     "judges": collections.Counter()})
        b["runs"] += 1
        b["tokens"] += g["tokens"]
        b["ms"] += g["ms"]
        b["batches"] += g["batches"]
        b["cites"] += g["cites"]
        if run.get("judgeModel") and run.get("judgeEffort"):
            b["judges"][f"{run['judgeModel']}/{run['judgeEffort']}"] += 1
        f = found.get(g["run_id"])
        if f:
            b["conf"] += f["confirmed"]
            b["dism"] += f["dismissed"]
            b["unres"] += f["unresolved"]
        review = pairs.get(g["run_id"])
        if review:
            b["reviews"].append(review)

    order = sorted(buckets, key=lambda k: (k == "unrecorded", -buckets[k]["runs"]))
    print("plan depth   (the row the run RECORDED — the items report the tier they resolved to)")
    print(f"  {'planner':<16}{'runs':>6}{'plan Mtok':>11}{'plan secs':>11}"
          f"{'batches/run':>13}{'cited%':>8}{'raised/run':>12}{'confirmed':>11}   judges")
    for k in order:
        b = buckets[k]
        raised = b["conf"] + b["dism"] + b["unres"]
        judged = b["conf"] + b["dism"]
        # Only judged findings count toward precision: an unresolved one says nobody decided, and
        # folding it into either column would invent the judgement that is missing.
        prec = f"{b['conf'] / judged:.0%}" if judged else "—"
        cited = f"{b['cites'] / b['batches']:.0%}" if b["batches"] else "—"
        judges = " · ".join(f"{m} {n}" for m, n in b["judges"].most_common()) or "—"
        print(f"  {k:<16}{b['runs']:>6}{b['tokens'] / b['runs'] / 1_000_000:>11.1f}"
              f"{b['ms'] / b['runs'] / 1000:>11.0f}{b['batches'] / b['runs']:>13.1f}"
              f"{cited:>8}{raised / b['runs']:>12.1f}{prec:>11}   {judges}")

    print()
    print(f"  what the review found next   (same repo, within {int(PAIR_WINDOW.total_seconds() // 3600)}h, "
          f"pipeline-invoked reviews only)")
    print(f"  {'planner':<16}{'paired':>8}{'correctness/run':>17}{'readability/run':>17}")
    for k in order:
        rev = buckets[k]["reviews"]
        if not rev:
            print(f"  {k:<16}{0:>8}{'—':>17}{'—':>17}")
            continue
        cor = sum(r.get("fixedCorrectness") or 0 for r in rev) / len(rev)
        rea = sum(r.get("fixedReadability") or 0 for r in rev) / len(rev)
        print(f"  {k:<16}{len(rev):>8}{cor:>17.2f}{rea:>17.2f}")
    print()
    print("  A cheaper planner that pushes work into fix-correctness has moved cost, not saved it —")
    print("  read both halves. `batches/run` and `cited%` are the triage split: a citation lane that")
    print("  reaches nothing costs the same as no lane at all.")
    thin = [k for k in order if k != "unrecorded" and buckets[k]["runs"] < 10]
    if thin:
        print("  Thin sample (<10 runs): " + ", ".join(thin) +
              " — a direction to keep watching, not a verdict.")
    print()


# Where Claude Code persists one workflow run: a journal of every item's return value, plus a full
# transcript and a metadata file per agent. Nothing in the pack has to record any of this — mining
# it costs the pipelines nothing at run time and reaches every run already on disk.
WF_GLOB = os.path.join(PROJECTS, "*", "*", "subagents", "workflows", "wf_*")
PROMPT_CAP, RESULT_CAP = 4000, 16000
# record-run.py prints this, and the stats step's prompt tells the agent to return that line
# verbatim — so it lands in the journal and names the run the whole directory belongs to.
RUN_ID_RE = re.compile(r"recorded run ([0-9a-f-]{36})")

ITEM_COLUMNS = ("run_id", "wf_run_id", "agent_id", "agent_type", "label", "model", "effort",
                "prompt_chars", "prompt_sha", "prompt", "result", "result_chars",
                "tokens_in", "tokens_out", "tokens_cache", "started_at", "ended_at",
                "duration_ms", "transcript_path")


# Claude Code persists a subagent's agentType but not the workflow LABEL, so cost rolls up per
# agent type unless the label is recovered — and one type covers many steps: `general-purpose`
# alone spans the codex pass, triage, local-scan, the UI deploy and the sink, which averages the
# expensive steps into the cheap ones and hides the only number worth acting on.
#
# The label is therefore recovered from the PROMPT, and the prefixes are read out of the workflow
# scripts themselves rather than kept in a table here. A reworded prompt then updates the mapping
# with the wording, and the failure mode of a rename is an unlabelled row — visible, and counted in
# the report — rather than a confidently wrong one.
LABEL_SIG_MIN = 28   # shorter chunks start matching more than one dispatch site
INTERP = "\x00"     # where a `${…}` stood: the static text around it is what identifies a step
# `label:` up to the first string in its value, so a step chosen by a ternary
# (`label: attempt === 1 ? 'branch' : 'branch-retry'`) is read as the step it names first rather
# than skipped. Bounded to the property's own value: it may not reach past a comma into the next.
LABEL_RE = re.compile(r"""label:\s*[^,}\n]*?[`'"]([^`'"]*)""")
# The pre-pack skill names, frozen. History was written by scripts that used them, and without this
# every run before the rename classifies as unlabelled.
LABEL_ALIASES = {"post-task-review": "task-review", "run-task-implement": "task-run",
                 "run-task": "task-run", "find-bugs": "code-bugs", "local-scan": "code-scan",
                 "refactor": "code-refactor", "write-tests": "tests-write",
                 "adversarial-review": "code-adversarial"}


def _label_norm(text):
    """Compare prompts on their words alone — whitespace, punctuation, the `r:` prefix and the
    pre-pack skill names all differ across the history without changing which step ran."""
    t = (text or "").lower().replace("r:", "")
    for old, new in LABEL_ALIASES.items():
        t = t.replace(old, new)
    return re.sub(r"[^a-z0-9]+", "", t)


def _skip_string(src, i, quote):
    """The index just past a '…' or "…" string whose opening quote sat at i-1."""
    while i < len(src):
        if src[i] == "\\":
            i += 2
        elif src[i] == quote:
            return i + 1
        else:
            i += 1
    return i


# A regex literal is the one token in a script that looks like nothing else: `/([^\s"'`,]+)/`
# carries a quote and a backtick as ordinary characters, and a scanner with no notion of regexes
# reads that quote as opening a string and swallows everything up to the next one. That is not a
# cosmetic miss — it takes every prompt in the swallowed region out of the classifier, and a step
# whose prompts go unread costs its cost, effort and depth on every run it ever made. Whether a `/`
# opens a regex or divides is decided by the token before it, the same rule every JS tokeniser uses.
REGEX_PREV = set("(,=:[!&|?{};+-*%^~<>")
REGEX_KEYWORDS = ("return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
                  "case", "do", "else", "yield", "await")


def _regex_here(src, i):
    """Does the `/` at i open a regex literal rather than divide?"""
    j = i - 1
    while j >= 0 and src[j] in " \t\r\n":
        j -= 1
    if j < 0 or src[j] in REGEX_PREV:
        return True
    k = j
    while k >= 0 and (src[k].isalnum() or src[k] in "_$"):
        k -= 1
    return src[k + 1:j + 1] in REGEX_KEYWORDS


def _skip_regex(src, i):
    """The index just past the regex literal whose opening `/` sits at i.

    A newline ends the scan where it stands: a regex never spans one, so a `/` this heuristic read
    as an opening bracket when it was a division sign costs a line rather than the rest of the file.
    """
    i += 1
    klass = False
    while i < len(src):
        c = src[i]
        if c == "\\":
            i += 2
        elif c == "\n":
            return i
        elif c == "[":
            klass, i = True, i + 1
        elif c == "]":
            klass, i = False, i + 1
        elif c == "/" and not klass:
            i += 1
            while i < len(src) and src[i].isalpha():
                i += 1
            return i
        else:
            i += 1
    return i


def _skip_expr(src, i):
    """The index just past the `}` closing a brace that opened at i-1."""
    depth = 1
    while i < len(src) and depth:
        c = src[i]
        if c == "{":
            depth += 1
            i += 1
        elif c == "}":
            depth -= 1
            i += 1
        elif c in "'\"":
            i = _skip_string(src, i + 1, c)
        elif c == "`":
            i = _scan_template(src, i + 1)[1]
        elif c == "/" and src[i + 1:i + 2] == "/":
            j = src.find("\n", i)
            i = len(src) if j < 0 else j + 1
        elif c == "/" and src[i + 1:i + 2] == "*":
            j = src.find("*/", i)
            i = len(src) if j < 0 else j + 2
        elif c == "/" and _regex_here(src, i):
            i = _skip_regex(src, i)
        else:
            i += 1
    return i


def _scan_template(src, i):
    """(text, index just past the closing backtick) for the template literal opened at i-1.

    Hand-scanned rather than matched with a regex, because a prompt holds both escaped backticks
    (\\`mvn package\\`) and nested `${… `…` …}` interpolations. Stopping at the first backtick
    truncates a prompt to its opening words — "Run the build " — which is too short to name a step,
    so the whole dispatch falls out of the report.
    """
    out, n = [], len(src)
    while i < n:
        c = src[i]
        if c == "\\":
            out.append(src[i + 1:i + 2])
            i += 2
        elif c == "`":
            return "".join(out), i + 1
        elif c == "$" and src[i + 1:i + 2] == "{":
            out.append(INTERP)
            i = _skip_expr(src, i + 2)
        else:
            out.append(c)
            i += 1
    return "".join(out), n


def _template_literals(src):
    """[(start, end, text)] for every template literal in a script, in source order."""
    lits, i, n = [], 0, len(src)
    while i < n:
        c = src[i]
        if c == "/" and src[i + 1:i + 2] == "/":
            j = src.find("\n", i)
            i = n if j < 0 else j + 1
        elif c == "/" and src[i + 1:i + 2] == "*":
            j = src.find("*/", i)
            i = n if j < 0 else j + 2
        elif c == "/" and _regex_here(src, i):
            i = _skip_regex(src, i)
        elif c in "'\"":
            i = _skip_string(src, i + 1, c)
        elif c == "`":
            text, end = _scan_template(src, i + 1)
            lits.append((i, end, text))
            i = end
        else:
            i += 1
    return lits


def _step(raw):
    """The step a `label:` names. `end-verify#${pass}`, `implement:${a.label}` and the docs-only
    `find-bugs:docs` are one step each, not one per run and not one per track — the sub-track is
    already in `agent_type`, and splitting a step by it leaves every slice too small to read."""
    return re.sub(r"[#$:].*", "", raw).rstrip("-") or raw


def _label_after(window):
    """The step named by the opts object that follows a prompt argument, or None.

    The window must OPEN with that object — a literal followed by anything else is not a prompt
    being dispatched — and the search stops at the object's own closing brace, so a label can never
    be lifted off the call below: a step name borrowed from a neighbour is precisely the
    confidently-wrong answer this scheme exists to avoid. The brace is what bounds it, not the next
    literal: a `label:` whose value is itself a template starts one a single character in.
    """
    text = re.sub(r"/\*.*?\*/|//[^\n]*", "", window[:800], flags=re.S)
    if not re.match(r"\s*,\s*\{", text):
        return None
    opts = text.index("{")
    m = LABEL_RE.search(text[opts:_skip_expr(text, opts + 1)])
    return _step(m.group(1)) if m else None


# One dispatch, two steps: `agent(cond ? citePrompt(b) : judgePrompt(b), { label })`, where `label`
# is itself `cond ? 'cite' : 'judge'`. The branches are paired by the CONDITION TEXT, never by
# position — two ternaries that happen to sit near each other say nothing, and a step name awarded
# on ordering alone is the confidently-wrong answer this whole scheme exists to avoid.
TERNARY_DISPATCH = re.compile(
    r"\bagent\(\s*(?P<cond>[^?()\n]+?)\s*\?\s*(?P<a>[A-Za-z_$][\w$]*)\s*\([^()]*\)\s*"
    r":\s*(?P<b>[A-Za-z_$][\w$]*)\s*\([^()]*\)\s*,")


def _ternary_steps(src, at, cond):
    """('cite', 'judge') for the `label` computed above `at` by a ternary on the SAME condition."""
    pat = (r"label\s*=\s*`?\$?\{?\s*" + re.escape(cond.strip()) +
           r"\s*\?\s*['\"`]([\w:-]+)['\"`]\s*:\s*['\"`]([\w:-]+)['\"`]")
    hits = list(re.finditer(pat, src[:at]))
    return (_step(hits[-1].group(1)), _step(hits[-1].group(2))) if hits else None


def _builder_labels(src):
    """{name: step} for a dispatch whose prompt is a named builder — `agent(implBrief(a), {…})`.

    The prompt is then a literal elsewhere in the file, under that builder's own definition.
    """
    out = {}
    for m in re.finditer(r"\bagent\(\s*([A-Za-z_$][\w$]*)\s*(?:\([^()]*\))?\s*,", src):
        label = _label_after(src[m.end() - 1:])
        if label:
            out.setdefault(m.group(1), set()).add(label)
    for m in TERNARY_DISPATCH.finditer(src):
        steps = _ternary_steps(src, m.start(), m.group("cond"))
        if steps:
            out.setdefault(m.group("a"), set()).add(steps[0])
            out.setdefault(m.group("b"), set()).add(steps[1])
    # A builder dispatched under two different steps names neither of them.
    return {n: next(iter(l)) for n, l in out.items() if len(l) == 1}


def _builder_spans(src, lits):
    """[(start, end, step)] over each named builder's definition, so the literals inside it are
    claimed by the step that dispatches it."""
    inside = lambda p: any(s < p < e for s, e, _ in lits)
    # Where each non-blank line starts, and how deep it sits. A builder is bounded by the next line
    # at its own indentation or shallower — the one rule that reads a top-level builder and one
    # nested inside a phase alike. Bounding on column 0 only would hand every nested builder the
    # whole rest of the file, which is worse than not reading it: its step would then claim every
    # literal after it.
    starts = [(m.start(), len(m.group(1))) for m in re.finditer(r"^([ \t]*)(?=\S)", src, re.M)
              if not inside(m.start())]
    spans = []
    for name, label in _builder_labels(src).items():
        m = re.search(r"^([ \t]*)(?:const|let|var|function|async function)\s+" + re.escape(name)
                      + r"\b", src, re.M)
        if m:
            depth = len(m.group(1))
            end = next((p for p, d in starts if p > m.start() and d <= depth), len(src))
            spans.append((m.start(), end, label))
    return spans


def label_signatures(paths):
    """[(normalised literal chunk, label)] for every prompt a pipeline dispatches, longest first.

    A prompt reaches its agent in one of three shapes, and all three are read here: the literal
    handed straight to the call (`agent(`…`, { label })`), the literal held as a `prompt:` beside
    its own `label:` in a table of tracks, and the literal under a named builder that the call
    passes by name. A shape none of the three recognise contributes no signature, and its runs stay
    unlabelled — which the report counts and prints.

    A chunk two steps share is dropped rather than awarded to whichever sorted first.
    """
    sigs = {}
    for path in paths:
        try:
            src = open(path, encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        lits = _template_literals(src)
        spans = _builder_spans(src, lits)
        for k, (start, end, text) in enumerate(lits):
            label = _label_after(src[end:])
            if not label:
                head = src[lits[k - 1][1] if k else 0:start]
                if re.search(r"\bprompt:\s*$", head):
                    # A track table pairs the two the other way round: `{ label: …, prompt: `…` }`.
                    hits = list(LABEL_RE.finditer(head))
                    label = _step(hits[-1].group(1)) if hits else None
            if not label:
                label = next((lb for s, e, lb in spans if s <= start < e), None)
            if not label:
                continue
            # Split on the inline code spans too, not just the interpolations: `\`mvn package\``
            # is the half of a sentence most likely to be reworded, and the static prose on either
            # side of it identifies the step on its own.
            for chunk in re.split(r"[%s`]" % INTERP, text):
                n = _label_norm(chunk)
                if len(n) >= LABEL_SIG_MIN:
                    sigs.setdefault(n[:90], set()).add(label)
    return sorted(((s, next(iter(l))) for s, l in sigs.items() if len(l) == 1),
                  key=lambda s: -len(s[0]))


def classify(prompt, sigs):
    """The label whose longest literal chunk this prompt contains, or None. Never a guess: an
    unrecognised prompt stays unlabelled and shows up as such."""
    n = _label_norm(prompt)
    for sig, label in sigs:
        if sig in n:
            return label
    return None


def _text(content):
    """A message's content as text, whether it arrived as a string or as content blocks."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(c.get("text", "") for c in content
                         if isinstance(c, dict) and c.get("type") == "text")
    return ""


def _read_agent(path):
    """(prompt, model, effort, tokens_in, tokens_out, tokens_cache, started, ended) for one agent."""
    prompt, model, effort = "", None, None
    tin = tout = tcache = 0
    started = ended = None
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            try:
                e = json.loads(line)
            except Exception:
                continue
            ts = e.get("timestamp")
            if ts:
                started = started or ts
                ended = ts
            m = e.get("message") or {}
            if not prompt and e.get("type") == "user" and m.get("role") == "user":
                prompt = _text(m.get("content"))
            model = model or m.get("model")
            effort = effort or e.get("effort")
            u = m.get("usage") or {}
            tin += u.get("input_tokens") or 0
            tout += u.get("output_tokens") or 0
            tcache += (u.get("cache_read_input_tokens") or 0) + \
                      (u.get("cache_creation_input_tokens") or 0)
    return prompt, model, effort, tin, tout, tcache, started, ended


# Fields the sink stamps on. Stripped before comparing a stored run against the payload quoted in a
# stats item's prompt, which is the row as the workflow built it — before any of these existed.
STAMPED = {"ts", "repo", "origin", "event", "skill", "pipeline", "mid", "store", "run_id",
           "session_id", "commit_sha", "files_changed", "lines_added", "lines_removed",
           "bfid", "tsApprox", "findings"}


def _signature(row):
    return json.dumps({k: v for k, v in sorted(row.items()) if k not in STAMPED},
                      separators=(",", ":"), ensure_ascii=False, default=str)


def _stats_payload(prompt):
    """The JSON row quoted inside a stats item's prompt, or None.

    This is how a workflow run recorded BEFORE record-run.py echoed its run_id still finds its row:
    the prompt carries the payload verbatim, so the same signature identifies both ends.
    """
    m = re.search(r"<<'(?:PTR|RTI)_STATS_JSON'\s*\n(\{.*?\})\s*\n", prompt or "", re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(1))
    except Exception:
        return None


def _millis(a, b):
    try:
        fmt = "%Y-%m-%dT%H:%M:%S.%f%z"
        s = datetime.strptime(a.replace("Z", "+0000"), fmt)
        e = datetime.strptime(b.replace("Z", "+0000"), fmt)
        return int((e - s).total_seconds() * 1000)
    except Exception:
        return None


def mine_items(db, label_sources=()):
    """Fill `items` from the workflow transcripts on disk.

    Idempotent through `items.agent_id UNIQUE`: an agent already mined is skipped, so this can be
    re-run after every session without bookkeeping. `prompt` and `result` are capped and
    `transcript_path` is kept, so the full text is always one read away — that is what keeps the db
    in kilobytes per run rather than the megabytes the transcripts themselves occupy.
    """
    dirs = sorted(glob.glob(WF_GLOB))
    if not dirs:
        print(f"mine-items: no workflow transcripts under {PROJECTS}\n")
        return
    # The shipped pipelines by default. Extra sources exist for history: a run recorded before the
    # pack was built came from scripts that are no longer here, and only they can name its steps.
    label_sigs = label_signatures(list(label_sources)
                                  or sorted(glob.glob(os.path.join(PACK, "skills", "*", "*.workflow.js"))))
    con = connect(db)
    # Signature -> run_id, for the runs recorded before record-run.py echoed its id. Built once;
    # a signature shared by two runs is dropped rather than guessed at.
    sigs, dupes = {}, set()
    for r in load(db):
        s = _signature(r)
        if s in sigs:
            dupes.add(s)
        sigs[s] = r.get("run_id")
    for s in dupes:
        sigs.pop(s, None)
    added = skipped = runs_linked = linked_by_sig = 0
    try:
        for d in dirs:
            results = {}
            jpath = os.path.join(d, "journal.jsonl")
            if os.path.exists(jpath):
                for line in open(jpath, encoding="utf-8", errors="replace"):
                    try:
                        e = json.loads(line)
                    except Exception:
                        continue
                    if e.get("type") == "result" and e.get("agentId"):
                        results[e["agentId"]] = e.get("result")
            # The stats item's own return value names the run this whole directory belongs to.
            run_id = None
            for r in results.values():
                m = RUN_ID_RE.search(r if isinstance(r, str) else json.dumps(r))
                if m:
                    run_id = m.group(1)
                    break
            if run_id:
                runs_linked += 1
            wf = os.path.basename(d)
            agents = sorted(glob.glob(os.path.join(d, "agent-*.jsonl")))
            if not run_id:
                # No echoed id: fall back to the payload quoted in the stats item's own prompt.
                for ap in agents:
                    # The whole first line, never a fixed-size head: the marker and the payload both
                    # sit in that one prompt, and a slice of it is neither valid JSON nor a reliable
                    # place to look for the marker. Parse defensively for the same reason every other
                    # read here does -- one unparseable transcript must cost its own link, not the
                    # entire mining pass, which is how ten days of items go missing while the report
                    # prints `unrecorded` as though the pipeline had stopped recording.
                    with open(ap, encoding="utf-8", errors="replace") as fh:
                        first = fh.readline()
                    if "_STATS_JSON" not in first:
                        continue
                    try:
                        content = (json.loads(first).get("message") or {}).get("content")
                    except Exception:
                        break
                    p = _stats_payload(_text(content))
                    if p and _signature(p) in sigs:
                        run_id = sigs[_signature(p)]
                        linked_by_sig += 1
                    break
            for ap in agents:
                agent_id = os.path.basename(ap)[len("agent-"):-len(".jsonl")]
                agent_type = None
                mp = ap[:-len(".jsonl")] + ".meta.json"
                if os.path.exists(mp):
                    try:
                        agent_type = json.load(open(mp)).get("agentType")
                    except Exception:
                        pass
                prompt, model, effort, tin, tout, tcache, started, ended = _read_agent(ap)
                res = results.get(agent_id)
                res = res if isinstance(res, str) else (json.dumps(res, ensure_ascii=False)
                                                        if res is not None else None)
                row = {
                    "run_id": run_id, "wf_run_id": wf, "agent_id": agent_id,
                    "agent_type": agent_type, "label": classify(prompt, label_sigs),
                    "model": model, "effort": effort,
                    "prompt_chars": len(prompt), "prompt": prompt[:PROMPT_CAP],
                    "prompt_sha": hashlib.sha256(prompt.encode()).hexdigest()[:16] if prompt else None,
                    "result": res[:RESULT_CAP] if res else None,
                    "result_chars": len(res) if res else 0,
                    "tokens_in": tin, "tokens_out": tout, "tokens_cache": tcache,
                    "started_at": started, "ended_at": ended,
                    "duration_ms": _millis(started, ended) if started and ended else None,
                    "transcript_path": ap,
                }
                with con:
                    cur = con.execute(
                        f"INSERT INTO items ({','.join(ITEM_COLUMNS)}) "
                        f"VALUES ({','.join('?' * len(ITEM_COLUMNS))}) "
                        f"ON CONFLICT(agent_id) DO NOTHING",
                        tuple(row[c] for c in ITEM_COLUMNS))
                added += bool(cur.rowcount)
                skipped += not cur.rowcount
    finally:
        con.close()
    # Rows mined before the classifier existed, or by a run whose scripts have since been
    # reworded, still carry no label — relabelling here means a signature added later reaches
    # history without re-reading half a gigabyte of transcripts.
    #
    # A row that already HAS a label is corrected only when the stored one is a step these same
    # sources can write. That one is this classifier's own earlier answer, so a disagreement is it
    # having got better. A label outside their vocabulary was written from somewhere else — a
    # `--label-source` run over the scripts of the day — and this pass has nothing to say about it.
    vocab = {label for _, label in label_sigs}
    con2 = connect(db)
    relabelled = corrected = 0
    try:
        with con2:
            known = " OR label IN (%s)" % ",".join("?" * len(vocab)) if vocab else ""
            for iid, old, prompt in con2.execute(
                    "SELECT id, label, prompt FROM items "
                    "WHERE prompt IS NOT NULL AND (label IS NULL%s)" % known,
                    sorted(vocab)).fetchall():
                lab = classify(prompt, label_sigs)
                if not lab or lab == old:
                    continue
                con2.execute("UPDATE items SET label=? WHERE id=?", (lab, iid))
                if old is None:
                    relabelled += 1
                else:
                    corrected += 1
        unlabelled = con2.execute("SELECT COUNT(*) FROM items WHERE label IS NULL").fetchone()[0]
    finally:
        con2.close()
    print(f"mine-items: {len(dirs)} workflow run(s) on disk; {added} item(s) inserted, "
          f"{skipped} already there; {runs_linked} linked by echoed run_id, "
          f"{linked_by_sig} by quoted payload; {relabelled} relabelled, "
          f"{corrected} corrected, {unlabelled} still unlabelled\n")


def summarize_findings(db):
    """Precision per track, and where the findings land. The half `fixes by source` cannot see."""
    con = connect(db, create=False)
    if con is None:
        return
    try:
        rows = con.execute(
            "SELECT COALESCE(track,'<unattributed>') t, verdict, COUNT(*) n "
            "FROM findings GROUP BY t, verdict").fetchall()
        if not rows:
            return
        by = collections.defaultdict(collections.Counter)
        for t, v, n in rows:
            by[t][v or "unresolved"] += n
        print("precision by track   (a verdict is triage's judgement, not the hunter's claim)")
        print(f"  {'track':<22}{'confirmed':>10}{'dismissed':>11}{'unresolved':>12}{'precision':>11}")
        for t in sorted(by, key=lambda k: -by[k]["confirmed"]):
            c, d, u = by[t]["confirmed"], by[t]["dismissed"], by[t]["unresolved"]
            # Only judged findings count: an unresolved one says the run never reached a verdict,
            # and folding it into either column would invent the judgement that is missing.
            rate = f"{c / (c + d):.0%}" if (c + d) else "—"
            print(f"  {t:<22}{c:>10}{d:>11}{u:>12}{rate:>11}")
        noisy = [t for t in by if by[t]["dismissed"] >= 5 and by[t]["confirmed"] == 0]
        if noisy:
            print(f"\n  judged >=5 times and never right: {', '.join(noisy)}")
            print("  (a track can be retired for being WRONG, not only for being quiet)")
        print()

        # The plan review's findings are triaged by TWO instruments two orders of magnitude apart
        # in cost — a haiku lookup against the line a finding cites, or a full judge — so the one
        # precision number above describes neither. Split them. Rows written before the lanes
        # existed carry no category and are printed apart rather than folded into either: they were
        # all judged, but saying so here would make the judge lane look larger than it is measured.
        marks = ",".join("?" * len(PLAN_TRACKS))
        lanes = con.execute(
            f"SELECT track, category, COALESCE(verdict,'unresolved'), COUNT(*) FROM findings "
            f"WHERE track IN ({marks}) GROUP BY track, category, verdict", PLAN_TRACKS).fetchall()
        split = collections.defaultdict(collections.Counter)
        for t, cat, v, n in lanes:
            split[(t, cat or "<pre-lane>")][v] += n
        if any(cat != "<pre-lane>" for _, cat in split):
            print("plan triage by lane   (a lookup against the cited line, or a full judge)")
            print(f"  {'rubric':<18}{'lane':<12}{'confirmed':>10}{'dismissed':>11}{'precision':>11}")
            for (t, cat) in sorted(split, key=lambda k: (k[0], k[1])):
                c, d = split[(t, cat)]["confirmed"], split[(t, cat)]["dismissed"]
                rate = f"{c / (c + d):.0%}" if (c + d) else "—"
                print(f"  {t:<18}{cat:<12}{c:>10}{d:>11}{rate:>11}")
            print("  A citation lane materially below the judge lane on the same rubric is the")
            print("  wrong lane for it — move the rubric back, rather than tuning its prompt.")
            print()

        hot = con.execute(
            "SELECT file, COUNT(*) n FROM findings WHERE file IS NOT NULL AND file != '' "
            "GROUP BY file ORDER BY n DESC LIMIT 8").fetchall()
        if hot:
            print("finding hotspots")
            for f, n in hot:
                print(f"  {n:>4}  {f}")
            print()
    finally:
        con.close()


def summarize_cost(db):
    """What a run actually spent, from the workflow transcripts rather than the scripts' constants."""
    con = connect(db, create=False)
    if con is None:
        return
    try:
        tot = con.execute(
            "SELECT COUNT(*), SUM(tokens_in), SUM(tokens_out), SUM(duration_ms) FROM items"
        ).fetchone()
        if not tot or not tot[0]:
            return
        n, tin, tout, dur = tot
        print(f"workflow items  {n}   "
              f"{(tin or 0) / 1000:.0f}k in · {(tout or 0) / 1000:.0f}k out · "
              f"{(dur or 0) / 3_600_000:.1f}h agent time")
        # Grouped by the pipeline STEP, not the agent type: one type covers many steps, and
        # averaging an expensive fixer into a cheap echo hides the only number worth acting on.
        rows = con.execute(
            "SELECT label k, COUNT(*) n, SUM(tokens_in + tokens_out + tokens_cache) tk, "
            "       AVG(duration_ms) d "
            "FROM items WHERE label IS NOT NULL GROUP BY k ORDER BY tk DESC LIMIT 12").fetchall()
        if rows:
            # The effort each step ran at, beside its cost. A step whose pinned depth was changed
            # reads as two tiers here for as long as history holds both, which is what makes the
            # change visible at all: the tokens and seconds columns average the old runs into the
            # new ones, and a re-tiered step that looks unchanged is usually one whose new runs are
            # still a handful against months of old ones.
            efforts = collections.defaultdict(collections.Counter)
            for k, e in con.execute("SELECT label, effort FROM items "
                                    "WHERE label IS NOT NULL AND effort IS NOT NULL"):
                efforts[k][e] += 1
            print(f"  {'step':<26}{'runs':>6}{'tokens':>14}{'avg secs':>10}   effort")
            for k, cnt, tk, d in rows:
                mix = " · ".join(f"{e} {n}" for e, n in efforts[k].most_common()) or "—"
                print(f"  {k:<26}{cnt:>6}{(tk or 0):>14,}{(d or 0) / 1000:>10.0f}   {mix}")
        # Said out loud rather than left as a shortfall in the table above. The label is recovered
        # from the prompt, so a run recorded by a script the pack no longer ships classifies as
        # nothing — that is missing attribution, not a step that cost nothing.
        #
        # Split by provenance, because one total buries the number worth acting on under the number
        # that means nothing. An unlabelled item sitting in a workflow run that DID produce pipeline
        # steps is one of ours in a prompt shape the classifier cannot read — the expensive kind,
        # since it costs its step on every run it ever made. An unlabelled item in a run with no
        # pipeline step at all belongs to somebody else's workflow (any ad-hoc script put through
        # the Workflow tool in any repo lands in the same store) and was never ours to label. The
        # second dwarfs the first, so an undivided total reads as a large regression at all times
        # and therefore reports nothing at all.
        dark, ours = con.execute(
            "SELECT COUNT(*), COUNT(CASE WHEN wf_run_id IN "
            "  (SELECT wf_run_id FROM items WHERE label IS NOT NULL) THEN 1 END) "
            "FROM items WHERE label IS NULL").fetchone()
        if dark:
            print(f"\n  {dark} item(s) carry no step label. {ours} of them sit in a workflow run that")
            print("  DID produce pipeline steps — those are the ones to chase: a prompt shape the")
            print("  classifier cannot read costs its step every run it ever made. The other")
            print(f"  {dark - ours} come from workflow runs with no pipeline step at all, which are not")
            print("  this pack's. Pass --label-source <script> to classify runs recorded by an older")
            print("  or foreign workflow.")
        print()
    finally:
        con.close()


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", default=DEFAULT_DB)
    ap.add_argument("--jsonl-path", default=JSONL_ARCHIVE,
                    help="the append-only store that predates the db; read on import, never written")
    ap.add_argument("--import-jsonl", action="store_true",
                    help="copy the JSONL archive's rows into the db (idempotent, run once)")
    ap.add_argument("--mine-items", action="store_true",
                    help="fill `items` from the workflow transcripts under ~/.claude/projects")
    ap.add_argument("--label-source", action="append", default=[], metavar="SCRIPT",
                    help="extra *.workflow.js to read step labels from (repeatable) — use it to "
                         "classify runs recorded by a script the pack no longer ships")
    ap.add_argument("--backfill", action="store_true",
                    help="mine past review runs out of ~/.claude/projects transcripts first")
    ap.add_argument("--review", action="store_true",
                    help="print only the review-pipeline section")
    ap.add_argument("--json", action="store_true", help="dump the rows instead of a summary")
    args = ap.parse_args()

    db = os.path.expanduser(args.db)

    if args.import_jsonl:
        import_jsonl(db, os.path.expanduser(args.jsonl_path))
    if args.backfill:
        backfill(db, {r["bfid"] for r in load(db) if r.get("bfid")})
    if args.mine_items:
        mine_items(db, args.label_source)

    rows = load(db)
    if not rows:
        print(f"no records yet in {db}")
        print("run any /r: skill, or pass --import-jsonl / --backfill to recover past runs.")
        return 0
    if args.json:
        print(json.dumps(rows, indent=2, ensure_ascii=False))
        return 0
    if not args.review:
        summarize_skills(rows)
        summarize_findings(db)
        summarize_cost(db)
        print("=" * 72)
        print()
    summarize_reviews(rows)
    summarize_impl_depth(db, rows)
    summarize_plan_depth(db, rows)
    return 0


if __name__ == "__main__":
    sys.exit(main())
