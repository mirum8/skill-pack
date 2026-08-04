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
from datetime import datetime, timezone

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
}
LATEST_REV = max(TRACK_REVS)


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
            print("  (the skill reported an outcome while the hook was not yet live — its runs")
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
        # A track can only score on a run that dispatched it.
        opps = collections.Counter()
        for r in live:
            for t in tier_tracks(r):
                opps[t] += 1
            if r.get("endVerify") in ("passed", "findings-unresolved"):
                opps["end-verify"] += 1
        names = sorted(set(hits) | set(opps), key=lambda k: (-hits[k], k))
        print(f"  {'track':<16}{'fixes':>7}{'runs it ran in':>16}{'fixes/run':>12}")
        for t in names:
            rate = f"{hits[t] / opps[t]:.2f}" if opps[t] else "—"
            print(f"  {t:<16}{hits[t]:>7}{opps[t]:>16}{rate:>12}")
        dark = [t for t in names if opps[t] >= 5 and hits[t] == 0]
        if dark:
            print(f"\n  ran >=5 times and never produced a fix: {', '.join(dark)}")
            print("  (candidates for retirement — confirm the sample is big enough first)")
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


def mine_items(db):
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
                    with open(ap, encoding="utf-8", errors="replace") as fh:
                        head = fh.read(6000)
                    if "_STATS_JSON" not in head:
                        continue
                    p = _stats_payload(_text((json.loads(head.splitlines()[0]).get("message")
                                              or {}).get("content")))
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
                    "agent_type": agent_type, "label": None, "model": model, "effort": effort,
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
    print(f"mine-items: {len(dirs)} workflow run(s) on disk; {added} item(s) inserted, "
          f"{skipped} already there; {runs_linked} linked by echoed run_id, "
          f"{linked_by_sig} by quoted payload\n")


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
        rows = con.execute(
            "SELECT COALESCE(label, agent_type, '?') k, COUNT(*) n, "
            "       SUM(tokens_in + tokens_out) tk, AVG(duration_ms) d "
            "FROM items GROUP BY k ORDER BY tk DESC LIMIT 12").fetchall()
        print(f"  {'item':<26}{'runs':>6}{'tokens':>12}{'avg secs':>10}")
        for k, cnt, tk, d in rows:
            print(f"  {k:<26}{cnt:>6}{(tk or 0):>12,}{(d or 0) / 1000:>10.0f}")
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
        mine_items(db)

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
    return 0


if __name__ == "__main__":
    sys.exit(main())
