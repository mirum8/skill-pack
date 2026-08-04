---
description: >-
  Run the OpenAI Codex adversarial review over the current code diff and return its findings. Use
  this whenever a Codex adversarial/challenge review is needed but the model must invoke it ITSELF
  — e.g. as a step inside a Post-Task Completion Checklist, a parallel review subagent, or any
  automated routine. This is the model-invocable wrapper around the user-only
  `/codex:adversarial-review` slash command (which sets disable-model-invocation and therefore
  CANNOT be called via the Skill tool). Trigger on "run the codex adversarial review",
  "challenge-review this diff with codex", "adversarial review", or any checklist/agent step that
  calls for codex adversarial review. It runs the REAL Codex tool — never an LLM imitation of it.
  Report-only: it surfaces findings, it does not fix them.
allowed-tools: Bash, Read, Glob, Grep, BashOutput
---

# Adversarial Review (Codex)

Run a Codex review that **challenges the implementation approach and design choices** over the current diff, and return Codex's findings. This is a challenge review — it questions the chosen approach, design tradeoffs, and assumptions, not just a stricter pass over implementation defects.

This skill exists because the `/codex:adversarial-review` slash command is marked `disable-model-invocation: true` — it is user-only and a subagent/model cannot reach it through the Skill tool. The wrapper script here calls the **same** Codex companion the slash command wraps, so the real tool runs from automated contexts (checklists, parallel review subagents).

## How to run it

Invoke the bundled wrapper — it resolves the Codex companion script (preferring the stable marketplace path, falling back to the newest cached plugin version) and runs `r:code-adversarial` through it. Pass any flags/focus text straight through.

**Default — foreground `--wait`.** For any subagent, checklist step, or automated routine, run the review in the foreground and capture stdout in one shot. It's a single shot, the script's per-attempt timeout and retry loop apply, and there's nothing to poll:

```bash
${CLAUDE_SKILL_DIR}/scripts/run.sh" --wait
```

This is the documented default. Use it unless you have a specific reason not to. (`--help` prints usage and exits immediately without starting Codex — it never launches a review, so probing the script costs nothing.)

**Background — opt-in only.** Only use the background path when an interactive user explicitly wants a non-blocking run; do **not** use it from a subagent or unattended checklist. The reason is concrete: a detached `run_in_background` job is invisible to the harness's child-tracking, so an unattended orchestrator sees "came to rest / no live children" while Codex is *still running* and can wrongly conclude the run is parked — that false signal is how a working run gets killed (see run-task's *Reading subagent completion*). Run it foreground instead: it stays a live *Agent* child for the whole review and its return **is** the completion signal, so there's nothing to misread. If you do use the background path anyway, you MUST bound the polling: poll **at most 10 times or 10 minutes**, then treat the review as blocked and STOP — never poll indefinitely.

(`--background` is not a companion flag either — reviews always run foreground inside the companion, so what actually backgrounds this is the harness's `run_in_background: true` on the Bash call.)

```bash
${CLAUDE_SKILL_DIR}/scripts/run.sh" --background   # via run_in_background: true
# then, in later turns, check progress and fetch findings through the same companion:
node "<companion>" status            # the wrapper prints the companion path it used; reuse it
node "<companion>" result            # returns the review findings
# Hard bound: if status is still not done after 10 polls / 10 minutes,
# stop polling and treat it as blocked (same as exit 4).
```

### Scope flags (passed through to Codex)

- `--base <ref>` — review against a base ref.
- `--scope auto|working-tree|branch` — what to review (default `auto`).
- trailing free text — extra focus for the reviewer (e.g. `... --wait "focus on the new payment callback"`).

It does **not** support `--scope staged` / `--scope unstaged`.

### Reviewer mode (`--mode`)

By default the wrapper runs the **strict adversarial/challenge** review. Pass `--mode review` to run the **lighter built-in reviewer** instead — the same one the user-only `/codex:review` wraps. Use the light mode for a regression-only pass (e.g. an end-verify that just needs to catch breaks the fixes introduced, not re-challenge the whole approach); keep the default for a full challenge review. It's a per-invocation flag (not an env var) so concurrent runs can't clobber each other's mode. The flag is parsed out by the wrapper; everything else passes through to Codex.

The two modes are **different machines**, not two settings of one dial, and the difference decides what Codex actually has in front of it:

- **`r:code-adversarial`** is a prompt-driven Codex session (read-only sandbox, structured output). The wrapper's companion embeds the **diff text** in that prompt only when the change is **≤2 files and ≤256 KB**; anything bigger arrives as a *file list + shortstat* with an instruction to inspect the diff via read-only git commands. So on an ordinary multi-file diff, whether the code got read is Codex's own call — which is why a fast, bare `approve` on a large diff is worth a second look rather than trust.
- **`review`** calls Codex's native reviewer API with a target (`uncommittedChanges` or a base branch). Nothing is embedded; the reviewer fetches its own diff. It **rejects** trailing focus text with a hard error (not a silent ignore), so pass only `--base` / `--scope` with it.

Neither mode sets a model or a reasoning effort — both use the Codex CLI's configured defaults. `--wait` is accepted and forwarded but reviews always run in the foreground anyway; the flag is a no-op inside the companion.

```bash
${CLAUDE_SKILL_DIR}/scripts/run.sh" --mode review --wait
```

## What to do with the output

- **Return Codex's findings verbatim.** Do not paraphrase, summarize, or editorialize.
- **Report the provenance block too.** On exit `0` the wrapper appends a short `--- adversarial-review: what this run examined ---` block: reviewer mode, diff range, shortstat, whether the diff text was embedded or Codex had to fetch it itself, and the attempt/elapsed/output size. Those lines are **provenance, not findings** — never fold them into a findings list. Quote them alongside the verdict, especially when the verdict is clean: "approve, no findings" over an embedded 40-line diff and "approve, no findings" over a file list of 12 files are very different claims, and this block is the only thing that tells them apart.
- **Do not fix anything here.** This review is report-only. In a Post-Task Completion Checklist, the main agent merges these findings with the other reviewers and fixes the real ones in a separate step — this skill's single job is to surface what Codex found.
- **Record the run.** One line into the pack-wide store, after the findings are reported. Counts only, never finding text:

  ```bash
  python3 "${CLAUDE_PLUGIN_ROOT}/lib/record-run.py" <<'STATS_JSON'
  {"skill":"r:code-adversarial","outcome":"reviewed|skipped|blocked|failed","exit":0,"diffEmbedded":true,
   "findings":[{"track":"codex","severity":"major|minor","file":"src/Foo.java","line":88,
                "verdict":"unresolved","fixed":false,"description":"one short line, Codex's words"}]}
  STATS_JSON
  ```

  One entry per finding Codex returned, `verdict: "unresolved"` — this skill is report-only, so it adjudicates nothing and must not claim to. Whoever triages them later records the verdicts.

  `outcome` is the field that matters most: a skipped run (no Codex plugin) and a clean run both report zero findings, and only this distinguishes them. Record the skip — that is the whole point of naming it rather than faking a review. The script always exits `0`, so a lost record is a lost record and never a failed review; never retry it.

## Exit codes & failure handling

The wrapper distinguishes these outcomes:

- **`0`** — the review genuinely ran; its findings are on stdout. Exit `0` requires **positive evidence**, not just the absence of error wording: stdout must be non-empty and must carry the companion's `# Codex <label>` review header (emitted on every render path), and neither stream may carry a known "did not review" marker. A run that produced nothing cannot exit `0` — empty stdout is a block, not a clean review.
- **`0` with `CODEX SKIPPED:` as the first stdout line** — the OpenAI Codex plugin isn't installed. This is the pack's one **optional** prerequisite, so it is a **skip, not a failure**: return a skipped result, let the caller carry on with its other reviewers, and say plainly in the report that no Codex review ran and how to add the plugin. Retrying won't help — a missing plugin won't fix itself. **A skipped step must never decay into a faked one:** do not fake a review or substitute an LLM imitation, and never report the step as completed. A skipped step reported as a review is worse than no review at all.
- **`3`** — not returned for a missing plugin; retained only so an older caller that still maps it keeps treating it as not-run.
- **`4`** — Codex is installed but its run couldn't inspect the diff (its own tool calls were rejected by a transient Codex-runtime schema error, so it emitted a phantom "Review blocked" finding) or it timed out. The wrapper already **retried up to 3 times** before returning `4`, so don't retry again. The `Review blocked` text is **not** a finding — treat it as "the review did not run." A caller can degrade gracefully (e.g. continue with its other reviewers) or surface the block to the user; never pass the blocked-text on as a real finding.
- **any other non-zero code** — the wrapper itself failed (e.g. the Codex companion threw a permanent error, a bad flag, node missing). This is **not** a transient block and the output is **not** findings. STOP and surface the real failure to the user; do not treat stdout as review results and do not silently continue.
