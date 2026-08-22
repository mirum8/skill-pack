#!/usr/bin/env bash
# Behaviour tests for check_spec.py — the mechanical gate Step 4 runs over a written spec.html.
#
#   bash skills/spec-brainstorm/tests/check_spec.test.sh
#
# What this protects: the checker is the only thing between a spec that reads well and a spec
# /r:spec-design cannot build phases against. Every problem it reports is one a human would have
# to find by reading, and a checker that silently stops reporting one looks exactly like a clean
# document. There is no CI, so this is the only thing standing between an edit and that.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
CHECK="skills/spec-brainstorm/scripts/check_spec.py"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0

ok()  { pass=$((pass + 1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }

# Every fixture is a WHOLE spec, written out in full rather than patched from a base. A spec is
# 20 lines and the defect under test is one of them; a shared base with an override would make
# each case's actual input something the reader has to reconstruct. KISS > DRY in tests.
spec()  { cat > "$TMP/spec.html"; }
notes() { cat > "$TMP/interview-notes.md"; }

# The coverage floor, fully settled. Every fixture below is about spec.html, so the notes are held
# clean and constant — a spec case that also tripped the interview checks would report two problems
# and the test could not say which check found which.
good_notes() {
  notes <<'EOF'
mode: full
scope: new-service

## Coverage
- users-and-job: answered (round 1) — finance ops staff, daily
- core-flow: answered (round 1) — request, review, transfer
- process: answered (round 2) — reviewed above 10k
- domain-model: answered (round 2) — payout, merchant, balance
- scale: answered (round 2) — under 1k payouts a day
- anti-scope: answered (round 3) — no multi-currency
- boundaries: answered (round 2) — one service
- api: answered (round 3) — REST over JSON
- stack-and-constraints: answered (round 1) — existing Spring stack
- integrations: answered (round 2) — the bank transfer API
- failure-behaviour: answered (round 3) — retry then hold
- stories-and-v1: answered (round 3) — merchant request ships first

## Answers
Round 1 — finance ops staff run this daily on the existing Spring stack.
Round 2 — a payout belongs to a merchant and draws down a balance; the bank transfer API moves it.
Round 2 — scale is under 1k payouts a day and the boundaries are one service.
Round 3 — REST over JSON, no multi-currency, the merchant request story ships first.
Round 3 — failure-behaviour is retry then hold for manual review.
EOF
}

run() { python3 "$CHECK" "$TMP" 2>&1; }

# says <name> <pattern> — the checker reports it
says() {
  local out; out=$(run)
  grep -qiE "$2" <<<"$out" && ok "$1" || bad "$1" "no match for /$2/ in:${out:0:400}"
}
# silent <name> <pattern> — the checker does NOT report it
silent() {
  local out; out=$(run)
  grep -qiE "$2" <<<"$out" && bad "$1" "unexpected /$2/ in:${out:0:400}" || ok "$1"
}
# exits <name> <expected-code>
exits() {
  run >/dev/null 2>&1; local rc=$?
  [[ $rc == "$2" ]] && ok "$1" || bad "$1" "exit $rc, wanted $2"
}

GOOD_SPEC='<h1>Payouts</h1>
<h2>Domain model</h2>
<p>A payout moves money from a merchant balance to a bank account.</p>
<h2>User stories</h2>
<h3>Merchant requests a payout</h3>
<p>Given a merchant with a positive balance, when they request a payout,
then a pending payout is created and the balance is reduced.</p>
<h3>Finance reviews a held payout</h3>
<p>Given a payout held for review, when finance approves it,
then it moves to pending and is queued for transfer.</p>
<h2>v1 scope</h2>
<p>v1 ships <strong>Merchant requests a payout</strong>. Deferred:
<strong>Finance reviews a held payout</strong>.</p>
<h2>Technology</h2>
<p>Spring Boot 3.3.4, PostgreSQL 16.4, Flyway 10.17.2.</p>
<h2>API</h2>
<p>POST /api/payouts returns 201.</p>'

echo "== a clean spec =="
good_notes
spec <<EOF
$GOOD_SPEC
EOF
silent "clean spec reports no problems" "problem"
exits   "clean spec exits 0" 0

echo
echo "== the story handles /r:spec-design builds phases against =="
good_notes
spec <<'EOF'
<h1>Payouts</h1>
<h2>Domain model</h2><p>A payout moves money.</p>
<h2>v1 scope</h2><p>v1 ships the first thing.</p>
<h2>Technology</h2><p>Spring Boot 3.3.4.</p>
EOF
says "a spec with no User stories section is reported" "user stor"

good_notes
spec <<'EOF'
<h1>Payouts</h1>
<h2>User stories</h2>
<p>Merchants can request payouts and finance can review them.</p>
<h2>v1 scope</h2><p>v1 ships payouts.</p>
<h2>Technology</h2><p>Spring Boot 3.3.4.</p>
EOF
says "stories written as prose with no <h3> handles are reported" "h3|story name"

good_notes
spec <<'EOF'
<h1>Payouts</h1>
<h2>User stories</h2>
<h3>Merchant requests a payout</h3>
<p>Given a balance, when they ask, then a payout is created.</p>
<h3>Merchant requests a payout</h3>
<p>Given a balance, when they ask again, then nothing happens.</p>
<h2>v1 scope</h2><p>v1 ships <strong>Merchant requests a payout</strong>.</p>
<h2>Technology</h2><p>Spring Boot 3.3.4.</p>
EOF
says "a duplicate story name is reported — a handle must be unique" "duplicate"

echo
echo "== a story with no acceptance criteria is a wish =="
good_notes
spec <<'EOF'
<h1>Payouts</h1>
<h2>User stories</h2>
<h3>Merchant requests a payout</h3>
<p>The merchant should be able to request a payout easily.</p>
<h2>v1 scope</h2><p>v1 ships <strong>Merchant requests a payout</strong>.</p>
<h2>Technology</h2><p>Spring Boot 3.3.4.</p>
EOF
says "a story with no Given/Then is reported" "acceptance criteria|wish"

echo
echo "== the v1 line has to name real stories =="
good_notes
spec <<'EOF'
<h1>Payouts</h1>
<h2>User stories</h2>
<h3>Merchant requests a payout</h3>
<p>Given a balance, when they ask, then a payout is created.</p>
<h2>Technology</h2><p>Spring Boot 3.3.4.</p>
EOF
says "a spec with no v1 section is reported" "v1"

good_notes
spec <<'EOF'
<h1>Payouts</h1>
<h2>User stories</h2>
<h3>Merchant requests a payout</h3>
<p>Given a balance, when they ask, then a payout is created.</p>
<h2>v1 scope</h2>
<p>v1 ships <strong>Bulk payout scheduling</strong> first.</p>
<h2>Technology</h2><p>Spring Boot 3.3.4.</p>
EOF
says "a v1 line naming a story nothing defines is reported" "no story defines|names no story"

echo
echo "== named technology carries a version =="
good_notes
spec <<'EOF'
<h1>Payouts</h1>
<h2>User stories</h2>
<h3>Merchant requests a payout</h3>
<p>Given a balance, when they ask, then a payout is created.</p>
<h2>v1 scope</h2><p>v1 ships <strong>Merchant requests a payout</strong>.</p>
<h2>Technology</h2>
<p>PostgreSQL holds the payouts. Every read and write goes through PostgreSQL directly.</p>
EOF
says "an unversioned technology is reported" "version"

echo
echo "== a missing spec.html is a problem, not a clean run =="
rm -f "$TMP/spec.html"
says  "a missing spec.html is reported" "missing"
exits "a missing spec.html exits non-zero" 1

echo
echo "== a path that is not a directory exits 2, distinctly from a failed check =="
python3 "$CHECK" "$TMP/nope" >/dev/null 2>&1; rc=$?
[[ $rc == 2 ]] && ok "a non-directory argument exits 2" \
               || bad "a non-directory argument exits 2" "exit $rc, wanted 2"

echo
printf '  %d passed, %d failed\n' "$pass" "$fail"
[[ $fail == 0 ]]
