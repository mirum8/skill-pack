#!/usr/bin/env bash
# Behaviour tests for change_impact.py — what a requirement change touches in a plan that is partly
# built, and whether it is safe to re-plan now.
#
#   bash skills/spec-design/tests/change_impact.test.sh
#
# Both answers fail by being confidently wrong: a partly built leaf read as unbuilt is re-planned
# over landed work, and a phase finished on a branch nobody merged is invisible from the base
# plan. So every stop is asserted, and so is every case that must NOT stop.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
IMPACT="$PWD/skills/spec-design/scripts/change_impact.py"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0

ok()  { pass=$((pass + 1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }

R="$TMP/repo"; D="$R/docs/billing"
mkdir -p "$D"
git -C "$R" init -q -b main
git -C "$R" config user.email t@t; git -C "$R" config user.name t
git -C "$R" commit -q --allow-empty -m init

plan()  { cat > "$D/todo.md"; }
notes() { cat > "$D/interview-notes.md"; }
draft() { cat > "$TMP/draft.md"; }

# has <name> <python-expression over j> — the JSON report satisfies it
has() {
  local out; out=$(python3 "$IMPACT" "$D/todo.md" --notes "$D/interview-notes.md" 2>&1)
  python3 -c "import json,sys; j=json.loads(sys.argv[1]); sys.exit(0 if ($2) else 1)" "$out" \
    && ok "$1" || bad "$1" "not ($2) in:${out:0:600}"
}

plan <<'EOF'
# Billing
### Phase 1 — Approval flow <!-- built: phase-approval-flow -->
**Implements:** Approve an invoice
**Depends on:** —
- [x] the author approves an invoice
**Done when:** `mvn test` is green.

### Phase 2 — Self-approval
**Implements:** Self-approve small invoices
**Depends on:** Phase 1
- [x] small invoices approve themselves
- [ ] the author sees a notice
**Done when:** `mvn test` is green.

### Phase 3 — Reports
**Implements:** Export a statement
**Depends on:** Phase 1
- [ ] export a statement as CSV
**Done when:** `mvn test` is green.
EOF

echo "== a pending change that touches a built leaf =="
notes <<'EOF'
status: generated

## Changes
### 2026-10-12 — Finance approves invoices
- Why: audit found authors approving their own spend
- Stories: changed "Approve an invoice"
- ADRs: ADR-9 supersedes ADR-4
EOF
has "the change is pending" "j['pending'] == ['2026-10-12 — Finance approves invoices']"
has "the built leaf is named, as built" \
  "[(l['phase'], l['state']) for i in j['impact'] if i['story'] == 'Approve an invoice' for l in i['leaves']] == [(1, 'built')]"
has "the effect is recorded" "[i['effect'] for i in j['impact']] == ['changed']"
has "nothing stops it" "j['stops'] == []"

echo
echo "== a change touching a PARTLY built leaf stops =="
notes <<'EOF'
## Changes
### 2026-10-12 — Finance approves invoices
- Why: audit
- Stories: changed "Approve an invoice"; retired "Self-approve small invoices"
EOF
has "the leaf reads as partly built" \
  "[l['state'] for i in j['impact'] if i['story'] == 'Self-approve small invoices' for l in i['leaves']] == ['partly']"
has "and it is a stop that names the phase" "any('Phase 2' in s for s in j['stops'])"

echo
echo "== a partly built leaf the change does NOT touch is not a stop =="
notes <<'EOF'
## Changes
### 2026-10-12 — Statements are PDF
- Why: the bank wants PDF
- Stories: changed "Export a statement"
EOF
has "nothing stops it" "j['stops'] == []"
has "the unbuilt leaf reads as unbuilt" \
  "[l['state'] for i in j['impact'] for l in i['leaves']] == ['unbuilt']"

echo
echo "== an added story touches no leaf =="
notes <<'EOF'
## Changes
### 2026-10-12 — Rejections escalate
- Why: finance wants a second look
- Stories: added "Escalate a rejected invoice"
EOF
has "it is listed with no leaves" \
  "[(i['story'], i['effect'], i['leaves']) for i in j['impact']] == [('Escalate a rejected invoice', 'added', [])]"

echo
echo "== an applied change is not pending =="
notes <<'EOF'
## Changes
### 2026-10-01 — Statements are CSV
- Why: first cut
- Stories: changed "Export a statement"

### 2026-10-12 — Finance approves invoices
- Why: audit
- Stories: changed "Approve an invoice"
EOF
sed -i.bak '1a\
<!-- changes: 2026-10-01 — Statements are CSV -->' "$D/todo.md"
has "only the new one is pending" "j['pending'] == ['2026-10-12 — Finance approves invoices']"
has "and only its stories are in the impact" "[i['story'] for i in j['impact']] == ['Approve an invoice']"
mv "$D/todo.md.bak" "$D/todo.md"

echo
echo "== an entry that cannot be read stops, never skips =="
notes <<'EOF'
## Changes
### Finance approves invoices
- Why: audit
- Stories: changed "Approve an invoice"

### 2026-10-12 — No reason given
- Stories: changed "Approve an invoice"

### 2026-10-13 — Unquoted
- Why: x
- Stories: changed Approve an invoice
EOF
has "a heading with no date is a stop" "any('no date' in s for s in j['stops'])"
has "a missing Why is a stop" "any(\"'Why:'\" in s for s in j['stops'])"
has "an unquoted story is a stop" "any('Unquoted' in s and 'quoted' in s for s in j['stops'])"

echo
echo "== no notes file, or no Changes section, means nothing pending =="
rm -f "$D/interview-notes.md"
out=$(python3 "$IMPACT" "$D/todo.md" --notes "$D/interview-notes.md" 2>&1)
python3 -c "import json,sys; j=json.loads(sys.argv[1]); sys.exit(0 if j['pending']==[] and j['stops']==[] and any('interview-notes' in n for n in j['notes']) else 1)" "$out" \
  && ok "missing notes is said, not silent" || bad "missing notes is said, not silent" "$out"

echo
echo "== --stories: the impact before any record exists =="
out=$(python3 "$IMPACT" "$D/todo.md" --stories "Self-approve small invoices" "Export a statement" 2>&1)
python3 -c "
import json,sys; j=json.loads(sys.argv[1])
st={i['story']: [l['state'] for l in i['leaves']] for i in j['impact']}
sys.exit(0 if st=={'Self-approve small invoices':['partly'],'Export a statement':['unbuilt']} and any('Phase 2' in s for s in j['stops']) else 1)" "$out" \
  && ok "states and the stop come back" || bad "states and the stop come back" "$out"

echo
echo "== an unmerged phase branch stops, whether finished or halted =="
notes <<'EOF'
## Changes
### 2026-10-12 — Statements are PDF
- Why: the bank wants PDF
- Stories: changed "Export a statement"
EOF
git -C "$R" add -A; git -C "$R" commit -q -m plan
git -C "$R" checkout -q -b phase-reports
sed -i.bak 's/^### Phase 3 — Reports$/### Phase 3 — Reports <!-- built: phase-reports -->/' "$D/todo.md"; rm "$D/todo.md.bak"
git -C "$R" commit -q -am "phase 3"
git -C "$R" checkout -q main
git -C "$R" branch -q phase-half-done
git -C "$R" checkout -q phase-half-done
git -C "$R" commit -q --allow-empty -m wip
git -C "$R" checkout -q main
has "a finished branch nobody landed is a stop" \
  "any(b['branch'] == 'phase-reports' and b['state'] == 'finished-not-landed' for b in j['branches']) and any('phase-reports' in s for s in j['stops'])"
has "a halted branch is a stop" \
  "any(b['branch'] == 'phase-half-done' and b['state'] == 'halted' for b in j['branches']) and any('phase-half-done' in s for s in j['stops'])"
git -C "$R" merge -q --no-edit phase-reports
git -C "$R" branch -q -D phase-half-done
has "a landed branch is not" "j['branches'] == [] and j['stops'] == []"

echo
echo "== outside a git repository, branches are not checked — and it says so =="
NR="$TMP/plain"; mkdir -p "$NR"; cp "$D/todo.md" "$D/interview-notes.md" "$NR/"
out=$(cd "$TMP" && python3 "$IMPACT" "$NR/todo.md" --notes "$NR/interview-notes.md" 2>&1)
python3 -c "import json,sys; j=json.loads(sys.argv[1]); sys.exit(0 if any('git' in n for n in j['notes']) else 1)" "$out" \
  && ok "is named in the notes" || bad "is named in the notes" "$out"

# ---------------------------------------------------------------------------------------------
# --check-plan: spec-design's gate on a draft. Every built leaf of a changed or retired story is
# reworked by a later leaf, and the draft records the change as applied.
# ---------------------------------------------------------------------------------------------
plan <<'EOF'
# Billing
### Phase 1 — Approval flow <!-- built: phase-approval-flow -->
**Implements:** Approve an invoice
**Depends on:** —
- [x] the author approves an invoice
**Done when:** `mvn test` is green.

### Phase 2 — Self-approval <!-- built: phase-self-approval -->
**Implements:** Self-approve small invoices
**Depends on:** Phase 1
- [x] small invoices approve themselves
**Done when:** `mvn test` is green.
EOF
notes <<'EOF'
## Changes
### 2026-10-12 — Finance approves invoices
- Why: audit
- Stories: changed "Approve an invoice"; retired "Self-approve small invoices"
EOF
check() {
  local out; out=$(python3 "$IMPACT" "$D/todo.md" --notes "$D/interview-notes.md" --check-plan "$TMP/draft.md" 2>&1); local rc=$?
  if [[ $rc == "$2" ]] && grep -qiE "$3" <<<"$out"; then ok "$1"; else bad "$1" "exit $rc, wanted $2, /$3/ in:${out:0:600}"; fi
}

echo
echo "== --check-plan: a draft that reworks and removes both =="
draft <<'EOF'
# Billing
<!-- changes: 2026-10-12 — Finance approves invoices -->
### Phase 1 — Approval flow <!-- built: phase-approval-flow -->
**Implements:** Approve an invoice
**Depends on:** —
- [x] the author approves an invoice
**Done when:** `mvn test` is green.

### Phase 2 — Self-approval <!-- built: phase-self-approval -->
**Implements:** Self-approve small invoices
**Depends on:** Phase 1
- [x] small invoices approve themselves
**Done when:** `mvn test` is green.

### Phase 3 — Finance approves invoices
**Implements:** Approve an invoice
**Reworks:** Phase 1
**Depends on:** Phase 1
- [ ] finance approves; the author cannot
**Done when:** `mvn test -Dtest=ApprovalTest` is green.

### Phase 4 — Remove self-approval
**Implements:** Self-approve small invoices
**Reworks:** Phase 2
**Depends on:** Phase 2
- [ ] delete the self-approval path and its tests
**Done when:** `grep -r selfApprove src/` finds nothing and `mvn test` is green.
EOF
check "is clean" 0 "clean"

echo
echo "== --check-plan: a built leaf of a retired story with no removal =="
draft <<'EOF'
# Billing
<!-- changes: 2026-10-12 — Finance approves invoices -->
### Phase 1 — Approval flow <!-- built: phase-approval-flow -->
**Implements:** Approve an invoice
**Depends on:** —
- [x] the author approves an invoice
**Done when:** `mvn test` is green.

### Phase 2 — Self-approval <!-- built: phase-self-approval -->
**Implements:** Self-approve small invoices
**Depends on:** Phase 1
- [x] small invoices approve themselves
**Done when:** `mvn test` is green.

### Phase 3 — Finance approves invoices
**Implements:** Approve an invoice
**Reworks:** Phase 1
**Depends on:** Phase 1
- [ ] finance approves; the author cannot
**Done when:** `mvn test` is green.
EOF
check "is reported, naming the phase and the story" 1 "Phase 2.*Self-approve small invoices.*no leaf reworks it"

echo
echo "== --check-plan: a rework leaf that cites another story does not count =="
draft <<'EOF'
# Billing
<!-- changes: 2026-10-12 — Finance approves invoices -->
### Phase 1 — Approval flow <!-- built: phase-approval-flow -->
**Implements:** Approve an invoice
**Depends on:** —
- [x] the author approves an invoice
**Done when:** `mvn test` is green.

### Phase 2 — Self-approval <!-- built: phase-self-approval -->
**Implements:** Self-approve small invoices
**Depends on:** Phase 1
- [x] small invoices approve themselves
**Done when:** `mvn test` is green.

### Phase 3 — Approval tweaks
**Implements:** Approve an invoice
**Reworks:** Phase 1, Phase 2
**Depends on:** Phase 1, Phase 2
- [ ] finance approves
**Done when:** `mvn test` is green.
EOF
check "is reported" 1 "Phase 2.*Self-approve small invoices.*no leaf reworks it"

echo
echo "== --check-plan: a draft that does not record the change as applied =="
draft <<'EOF'
# Billing
### Phase 1 — Approval flow <!-- built: phase-approval-flow -->
**Implements:** Approve an invoice
**Depends on:** —
- [x] the author approves an invoice
**Done when:** `mvn test` is green.

### Phase 2 — Self-approval <!-- built: phase-self-approval -->
**Implements:** Self-approve small invoices
**Depends on:** Phase 1
- [x] small invoices approve themselves
**Done when:** `mvn test` is green.

### Phase 3 — Finance approves invoices
**Implements:** Approve an invoice
**Reworks:** Phase 1
**Depends on:** Phase 1
- [ ] finance approves
**Done when:** `mvn test` is green.

### Phase 4 — Remove self-approval
**Implements:** Self-approve small invoices
**Reworks:** Phase 2
**Depends on:** Phase 2
- [ ] delete the self-approval path
**Done when:** `mvn test` is green.
EOF
check "is reported" 1 "does not record .*2026-10-12 — Finance approves invoices.* as applied"

echo
echo "== --check-plan: a stop still stands =="
notes <<'EOF'
## Changes
### 2026-10-12 — Finance approves invoices
- Stories: changed "Approve an invoice"
EOF
check "a broken record fails the check" 1 "'Why:'"

echo
printf '  %d passed, %d failed\n' "$pass" "$fail"
[[ $fail == 0 ]]
