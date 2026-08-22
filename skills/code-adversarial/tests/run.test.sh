#!/usr/bin/env bash
# Behaviour tests for run.sh — the exit-code contract callers bank a review on.
#
#   bash skills/code-adversarial/tests/run.test.sh
#
# No real Codex review is run. The companion is stubbed at the path the script resolves, because
# what is under test is the wrapper's judgement, not Codex's: which companion outputs count as a
# review that happened, and which exit code each outcome gets.
#
# Every caller in this pack branches on that contract. `0` is banked as "the review ran"; a run
# that produced nothing and still exits 0 is recorded as a clean review of a diff nobody read,
# which is the single failure the whole /r:code-adversarial design exists to prevent. There is no
# CI, so this is the only thing standing between an edit and that.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
RUN="$PWD/skills/code-adversarial/scripts/run.sh"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0

ok()  { pass=$((pass + 1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }

# The retry path sleeps 3s between attempts. The backoff is not what is being tested and three
# attempts would add 6s to every blocked case, so `sleep` is stubbed to return immediately.
STUB="$TMP/stub"; mkdir -p "$STUB"
printf '#!/bin/sh\nexit 0\n' > "$STUB/sleep"; chmod +x "$STUB/sleep"
export PATH="$STUB:$PATH"

# The script resolves its companion under $HOME, so a temp HOME is both how the stub is installed
# and how "the plugin is not installed" is simulated.
FAKE_HOME="$TMP/home"
COMPANION_DIR="$FAKE_HOME/.claude/plugins/marketplaces/openai-codex/plugins/codex/scripts"

# companion <<'JS' … — install a stub companion whose stdout/stderr/exit code the case controls.
companion() { mkdir -p "$COMPANION_DIR"; cat > "$COMPANION_DIR/codex-companion.mjs"; }
no_companion() { rm -rf "$FAKE_HOME/.claude"; }

# go <args…> — run the wrapper against the stub, capturing stdout, stderr and the exit code.
go() {
  HOME="$FAKE_HOME" bash "$RUN" "$@" >"$TMP/out" 2>"$TMP/err"
  echo $?
}

echo "== --help answers immediately and starts nothing =="
# Checked before the companion is even resolved: the companion folds an unrecognized flag into the
# review's focus text, so `--help` reaching it starts a REAL review that runs for minutes.
no_companion
rc=$(go --help)
[[ "$rc" == "0" ]] && ok "--help exits 0" || bad "--help exits 0" "exit $rc"
grep -q "run.sh — run the REAL Codex reviewer" "$TMP/out" \
  && ok "and prints usage on stdout" || bad "and prints usage on stdout" "$(head -3 "$TMP/out")"
# The skip path puts its marker on the FIRST line; the usage text merely mentions the marker while
# documenting it, so a whole-file grep would match the help itself.
head -1 "$TMP/out" | grep -q "^CODEX SKIPPED" \
  && bad "and does not fall through to the companion resolution" "reached the skip path" \
  || ok "and does not fall through to the companion resolution"

echo
echo "== the documented exit codes are the ones the script actually returns =="
# The usage text is a contract: a caller that branches on it and is wrong treats a skipped review
# as a clean one. Every code named there has a case below.
for code in 0 4; do
  grep -qE "(^| )$code = " "$TMP/out" \
    && ok "usage documents exit $code" || bad "usage documents exit $code" "$(grep -i 'exit codes' -A5 "$TMP/out")"
done
# 3 must NOT be documented as the missing-plugin code: the script exits 0 there, and a caller that
# branched on 3 would bank the skip as a clean review — the one outcome this wrapper exists to
# make impossible. Every real caller reads the CODEX SKIPPED marker instead.
grep -qE "3 = the (OpenAI )?Codex plugin is not installed" "$TMP/out" \
  && bad "usage does not promise an exit 3 the script never returns" "usage still names exit 3" \
  || ok "usage does not promise an exit 3 the script never returns"

echo
echo "== a missing Codex plugin is a NAMED SKIP, never a clean review =="
no_companion
rc=$(go)
# Deliberately 0, not a dedicated code: a missing OPTIONAL prerequisite must not read to a caller
# as a hard error that stops the run. The marker on the first stdout line is what separates it from
# a clean review, which is why every caller in the pack is told to read that line and not $?.
[[ "$rc" == "0" ]] && ok "a missing plugin exits 0 — an optional prerequisite is not a hard error" \
                   || bad "a missing plugin exits 0 — an optional prerequisite is not a hard error" "exit $rc"
head -1 "$TMP/out" | grep -q "^CODEX SKIPPED" \
  && ok "and the first stdout line carries the CODEX SKIPPED marker" \
  || bad "and the first stdout line carries the CODEX SKIPPED marker" "$(head -1 "$TMP/out")"
grep -q "Do NOT fake a review" "$TMP/err" \
  && ok "and tells the caller not to substitute an imitation" \
  || bad "and tells the caller not to substitute an imitation" "$(cat "$TMP/err")"

echo
echo "== an invalid --mode is rejected before anything runs =="
companion <<'JS'
console.log("# Codex adversarial review\n\nNo material findings.");
JS
rc=$(go --mode nonsense)
[[ "$rc" == "2" ]] && ok "an unknown --mode exits 2" || bad "an unknown --mode exits 2" "exit $rc"
grep -q "invalid --mode" "$TMP/err" && ok "and says which values are valid" \
                                    || bad "and says which values are valid" "$(cat "$TMP/err")"
rc=$(go --mode=review); [[ "$rc" == "0" ]] \
  && ok "--mode=review is accepted in the = form"  || bad "--mode=review is accepted in the = form" "exit $rc"
rc=$(go --mode adversarial-review); [[ "$rc" == "0" ]] \
  && ok "--mode adversarial-review is accepted"    || bad "--mode adversarial-review is accepted" "exit $rc"

echo
echo "== exit 0 requires POSITIVE evidence that a review happened =="
# The '# Codex ' header is emitted on every render path the companion has. Its absence proves
# nothing was rendered, whatever the exit code says — and unlike a blacklist of known-bad wording,
# that check cannot be evaded by phrasing nobody anticipated.
companion <<'JS'
console.log("# Codex adversarial review\n\n1. src/App.java:12 — unchecked cast.");
JS
rc=$(go)
[[ "$rc" == "0" ]] && ok "a rendered review exits 0" || bad "a rendered review exits 0" "exit $rc"
grep -q "unchecked cast" "$TMP/out" && ok "and the findings reach stdout" \
                                    || bad "and the findings reach stdout" "$(cat "$TMP/out")"

companion <<'JS'
process.exit(0);
JS
rc=$(go)
[[ "$rc" == "4" ]] && ok "exit 0 with EMPTY stdout is exit 4, not a clean review" \
                   || bad "exit 0 with EMPTY stdout is exit 4, not a clean review" "exit $rc"

companion <<'JS'
console.log("Verdict: approve. No material findings.");
JS
rc=$(go)
[[ "$rc" == "4" ]] && ok "a bare approving verdict with no '# Codex' header is exit 4" \
                   || bad "a bare approving verdict with no '# Codex' header is exit 4" "exit $rc"

echo
echo "== a rendered review that says it was blocked is still blocked =="
companion <<'JS'
console.log("# Codex adversarial review\n\nReview blocked: the diff could not be inspected.");
JS
rc=$(go)
[[ "$rc" == "4" ]] && ok "known blocked wording under a real header is exit 4" \
                   || bad "known blocked wording under a real header is exit 4" "exit $rc"
grep -q "BLOCKED" "$TMP/out" && ok "and stdout carries the greppable BLOCKED trailer" \
                             || bad "and stdout carries the greppable BLOCKED trailer" "$(tail -3 "$TMP/out")"

companion <<'JS'
console.log("# Codex adversarial review\n\nAll good.");
console.error("mktemp: failed to create file");
JS
rc=$(go)
[[ "$rc" == "4" ]] && ok "a hard failure on stderr downgrades an apparently-clean run to exit 4" \
                   || bad "a hard failure on stderr downgrades an apparently-clean run to exit 4" "exit $rc"

echo
echo "== a transient failure is retried; a permanent one surfaces immediately =="
# The distinction matters because they need opposite responses: a transient error clears on a
# re-run, while a permanent one (a bad flag, a companion that throws) repeats forever and must
# not be mislabelled as the environment's fault.
cat > "$TMP/count" <<<"0"
companion <<'JS'
import fs from "node:fs";
const p = process.env.WRAP_COUNT;
const n = Number(fs.readFileSync(p, "utf8").trim()) + 1;
fs.writeFileSync(p, String(n));
if (n < 3) { console.error("ECONNREFUSED: app-server closed"); process.exit(7); }
console.log("# Codex adversarial review\n\nNo material findings.");
JS
HOME="$FAKE_HOME" WRAP_COUNT="$TMP/count" bash "$RUN" >"$TMP/out" 2>"$TMP/err"; rc=$?
[[ "$rc" == "0" ]] && ok "a transient app-server error is retried until the review succeeds" \
                   || bad "a transient app-server error is retried until the review succeeds" \
                          "exit $rc: $(tail -3 "$TMP/err")"
[[ "$(cat "$TMP/count")" == "3" ]] && ok "and it took all three attempts" \
                                   || bad "and it took all three attempts" "$(cat "$TMP/count") attempts"

companion <<'JS'
console.error("SyntaxError: unexpected token");
process.exit(9);
JS
rc=$(go)
[[ "$rc" == "9" ]] && ok "a permanent companion failure surfaces its own exit code, not 4" \
                   || bad "a permanent companion failure surfaces its own exit code, not 4" "exit $rc"
grep -q "the wrapper itself failed" "$TMP/err" \
  && ok "and says plainly that stdout is not findings" \
  || bad "and says plainly that stdout is not findings" "$(cat "$TMP/err")"

echo
echo "== provenance says what the run examined, on both the clean and the blocked path =="
# "No material findings" is byte-identical whether Codex read every line or was handed a file list,
# so the verdict alone cannot be read as coverage.
companion <<'JS'
console.log("# Codex adversarial review\n\nNo material findings.");
JS
go >/dev/null
grep -qi "examined\|target\|context" "$TMP/out" \
  && ok "a clean review prints a provenance block" \
  || bad "a clean review prints a provenance block" "$(cat "$TMP/out")"

companion <<'JS'
process.exit(0);
JS
go >/dev/null
grep -qi "examined\|target\|context" "$TMP/out" \
  && ok "a blocked run prints one too, so its absence is never ambiguous" \
  || bad "a blocked run prints one too, so its absence is never ambiguous" "$(cat "$TMP/out")"

echo
printf '  %d passed, %d failed\n' "$pass" "$fail"
[[ $fail == 0 ]]
