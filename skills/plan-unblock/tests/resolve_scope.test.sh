#!/usr/bin/env bash
# Behaviour tests for resolve_scope.py — the parser behind /r:plan-unblock and the `## Resolve
# first` gate in /r:plan-run.
#
#   bash skills/plan-unblock/tests/resolve_scope.test.sh
#
# Everything here guards one failure shape: a confident wrong answer about whether a human still
# owes something. This section had no parser at all until now — /r:plan-run read it as prose and
# gated on "anything unticked", while the template it reads writes bullets with nothing to tick —
# so every case below is a way the section could tell a build it was clear when it wasn't. There
# is no CI, and this suite is the only thing standing between an edit here and that.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
SCOPE="skills/plan-unblock/scripts/resolve_scope.py"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0

ok()  { pass=$((pass + 1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }

# jq is not a dependency of the pack, so read the JSON with python.
q() { python3 -c 'import json,sys; print(json.dumps(eval(sys.argv[1], {"d": json.load(sys.stdin)})))' "$1"; }

# Every fixture is a WHOLE plan. A plan is twenty lines and the defect under test is one of them;
# a shared base with an override would make each case's actual input something the reader has to
# reconstruct. KISS > DRY in tests.
plan() { cat > "$TMP/todo.md"; }

# run <name> <expected-exit> <args...> — captures stdout into $OUT
run() {
  local name=$1 want=$2; shift 2
  OUT=$(python3 "$SCOPE" "$@" 2>"$TMP/err"); local rc=$?
  if [[ $rc != "$want" ]]; then
    bad "$name" "exit $rc, wanted $want: $(head -c 300 "$TMP/err")"; return 1
  fi
  ok "$name"
}

# eq <name> <expr over d> <expected-json>
eq() {
  local got; got=$(printf '%s' "$OUT" | q "$2")
  [[ "$got" == "$3" ]] && ok "$1" || bad "$1" "$2 = $got, wanted $3"
}

echo "== the shape /r:spec-design writes today, and the one it will write =="
plan <<'EOF'
# Billing — Implementation Plan

## Resolve first
- **Debezium against RDS** — can it read our instance, or do we need a polling fallback?
  Owner: platform. Blocks: Phase 3. Timebox: one afternoon. Output: a line in the spec's Risks.
- [ ] **Sign the payments DPA** — the processor needs it before live traffic.
  Owner: legal. Blocks: Phase 2. Timebox: two weeks. Output: a countersigned PDF.
- [x] **Queue vs cron** — which drives retries?
  Owner: platform. Blocks: Phase 4. Output: a line in design.md.
  Resolved: 2026-09-03 — queue; cron cannot honour the 30s target. Alternative: cron.

## Waves
- Wave 0: Phase 1

## Milestone 1 — Ledger

### Phase 1 — Ledger schema
- [x] the migration exists
**Done when:** green.

### Phase 2 — Payouts
- [ ] a thing
**Done when:** green.

### Phase 3 — Debezium sink
- [ ] a thing
**Done when:** green.

### Phase 4 — Retry
- [ ] a thing
**Done when:** green.
EOF
run "a plan with the section parses"      0 "$TMP/todo.md" --outstanding
eq  "the section is found"                'd["hasSection"]' 'true'
eq  "three entries"                       'len(d["entries"])' '3'
# The legacy bullet cannot be ticked, so reading it as settled would close every pre-existing
# entry in every plan at once. Unresolved is the only reading that cannot unblock a build.
eq  "a plain bullet is OUTSTANDING"       'd["outstanding"]' '[1, 2]'
eq  "and is named as the legacy shape"    'd["legacyShape"]' '[1]'
eq  "a tick with a Resolved: line closes" 'd["entries"][2]["resolved"]' 'true'
eq  "the resolution is carried"           'd["entries"][2]["resolution"][:5]' '"2026-"'
eq  "Output: keeps its own full stop"     'd["entries"][0]["output"]' '"a line in the spec'"'"'s Risks"'
eq  "blocked phases are the open ones"    'd["blockedPhases"]' '[2, 3]'
eq  "the gate stops"                      'd["gate"]' '"stop"'

echo
echo "== who may close an entry is DERIVED, and an unknown one is a person's =="
eq  "an investigation is a decision"      'd["entries"][0]["kind"]' '"decision"'
eq  "a signature is a person's"           'd["entries"][1]["kind"]' '"person"'
plan <<'EOF'
# P
## Resolve first
- [ ] **Decide whether to sign the DPA** — legal wants an answer.
  Owner: platform. Blocks: Phase 1.
- [ ] **The thing about the stuff** — no pattern matches this.
  Owner: platform. Blocks: Phase 1.

### Phase 1 — A
- [ ] a thing
EOF
run "a decision-shaped signature parses"  0 "$TMP/todo.md" --outstanding
# "decide whether to sign" is a signature wearing a decision's grammar. Only one of the two
# readings can be closed by asking a model, so the tie goes to the person.
eq  "a signature wins over its grammar"   'd["entries"][0]["kind"]' '"person"'
eq  "no pattern at all is unclassified"   'd["entries"][1]["kind"]' '"unclassified"'

echo
echo "== an entry that says nothing about what it blocks stops EVERYTHING =="
plan <<'EOF'
# P
## Resolve first
- [ ] **No blocks line at all** — what does this guard?
  Owner: platform. Timebox: a day.

### Phase 1 — A
- [ ] a thing

### Phase 2 — B
- [ ] a thing
EOF
run "an entry with no Blocks: parses"     0 "$TMP/todo.md" --outstanding
# Nothing has ever validated this line, so entries in the wild carry prose or nothing. Reading
# that as "blocks no phases" puts the entry outside every --phases narrowing and lets a run sail
# past a blocker the parser itself could see was broken.
eq  "it blocks everything"                'd["blocksEverything"]' 'true'
eq  "and is reported as malformed"        '"no Blocks:" in d["entries"][0]["malformed"][0]' 'true'
eq  "so the gate stops"                   'd["gate"]' '"stop"'
run "and it stops a narrowed run too"     0 "$TMP/todo.md" --outstanding --phases 2
eq  "even one it names no phase in"       'd["gate"]' '"stop"'
plan <<'EOF'
# P
## Resolve first
- [ ] **Prose instead of a number** — Blocks: the payments work. Owner: platform.

### Phase 1 — A
- [ ] a thing
EOF
run "a Blocks: naming no phase parses"    0 "$TMP/todo.md" --outstanding
eq  "it blocks everything too"            'd["blocksEverything"]' 'true'

echo
echo "== a blocker on a phase already built is moot, not a trap =="
plan <<'EOF'
# P
## Resolve first
- [ ] **Stale blocker** — nobody ever closed this.
  Owner: platform. Blocks: Phase 1.

### Phase 1 — Already built
- [x] the thing
**Done when:** green.

### Phase 2 — Still open
- [ ] a thing
EOF
run "a stale blocker parses"              0 "$TMP/todo.md" --outstanding
eq  "the built phase is named moot"       'd["blockedPhasesBuilt"]' '[1]'
eq  "and drops out of the live set"       'd["blockedInScope"]' '[]'
eq  "so the gate clears"                  'd["gate"]' '"clear"'

echo
echo "== narrowing to a run list, which is the gate's carve-out =="
plan <<'EOF'
# P
## Resolve first
- [ ] **Blocks a late phase** — an open question.
  Owner: platform. Blocks: Phase 9.

### Phase 1 — A
- [ ] a thing

### Phase 9 — Z
- [ ] a thing
EOF
run "the whole plan stops"                0 "$TMP/todo.md" --outstanding
eq  "because Phase 9 is blocked"          'd["gate"]' '"stop"'
run "a run that skips Phase 9 clears"     0 "$TMP/todo.md" --outstanding --phases 1
eq  "the carve-out is computed"           'd["gate"]' '"clear"'
eq  "and says what is out of scope"       'd["blockedPhases"]' '[9]'

echo
echo "== an answer, not an error =="
plan <<'EOF'
# P
### Phase 1 — A
- [ ] a thing
EOF
run "a plan with no section exits 0"      0 "$TMP/todo.md" --outstanding
eq  "hasSection is the answer"            'd["hasSection"]' 'false'
eq  "nothing is outstanding"              'd["outstanding"]' '[]'
eq  "and the gate clears"                 'd["gate"]' '"clear"'
plan <<'EOF'
# P
## Resolve first

### Phase 1 — A
- [ ] a thing
EOF
run "an empty section exits 0"            0 "$TMP/todo.md" --outstanding
eq  "the section is present"              'd["hasSection"]' 'true'
eq  "with no entries"                     'd["entries"]' '[]'
# The section runs to the next heading of ANY level. Stopping only at `## ` would swallow every
# phase below a plan that has no milestone heading between the two.
eq  "the slice does not reach the phases" 'd["gate"]' '"clear"'

echo
echo "== --check is the half that can fail =="
plan <<'EOF'
# P
## Resolve first
- [ ] **Clean entry** — a real question.
  Owner: platform. Blocks: Phase 1. Timebox: a day. Output: a note.

### Phase 1 — A
- [ ] a thing
EOF
run "a clean section exits 0"             0 "$TMP/todo.md" --check
eq  "with no problems"                    'd["problems"]' '[]'
plan <<'EOF'
# P
## Resolve first
- **Legacy shape** — no checkbox, so it can never be closed.
  Owner: platform. Blocks: Phase 1.
- [x] **Ticked in silence** — somebody closed this and wrote nothing down.
  Owner: platform. Blocks: Phase 1.
- [ ] **Ghost** — names a phase this plan does not have.
  Owner: platform. Blocks: Phase 99.

### Phase 1 — A
- [ ] a thing
EOF
# check_todo.py exits 1 on any finding and /r:spec-design's Step 7 is a fix-and-re-run loop
# against that. A check that always exits 0 is not a gate, it is a report.
run "anything reported exits 1"           1 "$TMP/todo.md" --check
eq  "the legacy bullet is a problem"      'len([p for p in d["problems"] if "checkbox" in p])' '1'
eq  "a silent tick is a problem"          'len([p for p in d["problems"] if "Resolved:" in p])' '1'
eq  "a phase that is not there is too"    'd["unknownPhaseRefs"]' '[99]'
# --outstanding is the gate's half and must never fail its caller over plan quality.
run "the same plan still answers"         0 "$TMP/todo.md" --outstanding
plan <<'PLAN'
# P
## Resolve first
- [ ] **Nobody owns this** — an entry with no owner is one nobody will close.
  Blocks: Phase 1.

### Phase 1 — A
- [ ] a thing
PLAN
run "a missing Owner: exits 1"            1 "$TMP/todo.md" --check
eq  "and is reported by name"             'len([p for p in d["problems"] if "no Owner:" in p])' '1'

echo
echo "== headings, and text that only looks like a field =="
plan <<'EOF'
# P
## resolve first
- [ ] **Lowercase heading** — still the section.
  Owner: platform. Blocks: Phase 1.

### Phase 1 - A
- [ ] a thing
EOF
run "the heading is case-insensitive"     0 "$TMP/todo.md" --outstanding
eq  "and a hyphen phase heading is read" 'd["phases"]' '[1]'
eq  "so the block resolves"               'd["blockedPhases"]' '[1]'
plan <<'EOF'
# P
## Resolve first
- [ ] **Phase 3 of the rollout** — the name mentions a phase we must not read as an edge.
  Owner: platform. Blocks: Phase 1.

### Phase 1 — A
- [ ] a thing
EOF
run "a phase named in prose parses"       0 "$TMP/todo.md" --outstanding
# Only the Blocks: field is an edge. A number in the subject line is part of the subject.
eq  "only Blocks: makes an edge"          'd["blockedPhases"]' '[1]'

echo
echo "== usage errors are never a silent pass =="
run "no arguments"                        1
run "no such plan"                        1 "$TMP/nope.md" --outstanding
run "no mode given"                       1 "$TMP/todo.md"
run "--phases with nothing after it"      1 "$TMP/todo.md" --outstanding --phases

echo
printf '  %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]

echo
echo "== an unknown field terminates the one before it, instead of being eaten by it =="
# A field ends at the NEXT LABEL, and "label" cannot mean "label this script knows about".
# Observed: `Owner: … Blocks: nothing. Informs: Phases 32 and 33.` ran the Blocks slice to the end
# of the entry, and since Blocks is the load-bearing edge, the phase regex harvested 32 and 33 out
# of the *Informs* clause — reporting the entry as blocking exactly the phases its author had
# listed as merely informed. `gate` is the value /r:plan-run is told to obey without
# second-guessing, so this silently stopped a run on a lie about what was blocking it.
INF="$TMP/informs.md"
cat > "$INF" <<'EOF'
# Plan

## Resolve first

- [ ] **Does port-forwarding survive the cluster proxy?**
  *Owner: the author. Blocks: nothing. Informs: Phases 32 and 33.*

## Milestone 1

### Phase 32 — A thing
- [ ] do it

### Phase 33 — Another thing
- [ ] do it
EOF

out=$(python3 "$SCOPE" "$INF" --outstanding --phases 33 2>&1)
res=$(python3 - "$out" <<'PY'
import json, sys
d = json.loads(sys.argv[1])
e = d["entries"][0]
ok = not e.get("blocks") and any("Informs" in m for m in e.get("malformed", []))
print("yes" if ok else "no")
PY
)
[ "$res" = yes ] && ok "Blocks: stops at Informs:, and the unknown field is named" \
                 || bad "Blocks: stops at Informs:, and the unknown field is named" "$out"

# The other half, and it is a DIFFERENT failure: an entry that names no phase blocks the entire run
# list by design (spec-design/SKILL.md:337, design-contracts.md:78 — "nothing can tell what it was
# guarding"). What must never happen is the gate stopping a run while naming phases the author
# never blocked, because that reads as a specific, checked answer.
gate=$(python3 - "$out" <<'PY'
import json, sys
d = json.loads(sys.argv[1])
print(d.get("gate"), len(d.get("blockedPhases") or []))
PY
)
[ "$gate" = "stop 0" ] && ok "it still stops, but names NO phase — the fail-closed reason, not a fabricated edge" \
                       || bad "it still stops, but names NO phase — the fail-closed reason, not a fabricated edge" "gate=$gate"
