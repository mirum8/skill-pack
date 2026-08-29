# Patterns & heuristics for CLAUDE.md compaction

Read this while inventorying and deciding where each piece of content should go.

1. Destination rubric
2. Staleness heuristics — the evidence gate for deletion
3. Redundancy and conflict heuristics — the four layers
4. Common smells checklist

Worked before/after examples for every transformation are in `rewrites.md`.

---

## 1. Destination rubric

Two questions decide almost everything: *does the model need telling at all?*
(SKILL.md's keep test), and if so, *how often and how widely does it apply?*

| Content | Destination | Why |
|---|---|---|
| Build / test / run / lint commands | **Root** | Needed constantly, cheap, and not always guessable from the build file. |
| One-line architecture / module map | **Root** | Orients every task — keep it a map, not a tour. |
| Conventions that shape most edits | **Root** | Applied on nearly every change; frame as intent, not prohibition. |
| Critical gotchas ("this dir is generated", "never point this at prod") | **Root** | Rare to need, expensive to miss — the highest-value content in the file. |
| "Load skill X when doing Y" pointers | **Root** | Routes work and costs almost nothing. |
| Rules scoped to one module or subdirectory | **Nested `module/CLAUDE.md`** | Loads only when working there. |
| Deep dives, long procedures, exhaustive lists, troubleshooting | **Reference** (plain link) | Rarely needed; expensive to keep always-on. |
| A procedure with its own trigger and steps | **Skill** | Invocable, and carries its own progressive disclosure. |
| Prose restating a spec that code already encodes | **Point at the code** | A test suite or a function can't drift; a prose copy will. |
| Decision logs, dated notes, "we chose X because Y" | **Memory** | Session memory, not an instruction. |
| Universal rule repeated from the user's global file | **Flag for global** | Belongs in `~/.claude/CLAUDE.md`; suggest it, don't move it. |
| Facts derivable from the repo or the build files | **Cut** | The model can just read them — §3. |
| Rules restating the harness or an installed skill | **Cut** | Already in context — §3. |
| Rigid prohibitions guarding a decision the model makes well on its own | **Soften** | Restate as intent — see `rewrites.md`. |
| Guidance the codebase contradicts | **Prune** (evidence + approval) | Actively misleads — §2. |

Rule of thumb: long *and* only read for one kind of task → reference. Short
*and* shapes most edits → root. Neither → it probably shouldn't exist at all.

The three disclosure rows — nested `CLAUDE.md`, reference, skill — are the
default for anything long and the tie-break whenever you're torn: they can't
lose a rule, so they need no evidence. In doubt between disclosing and cutting,
disclose. Give the pointer a trigger ("read this before touching X"), or the
model will never know to follow it.

---

## 2. Staleness heuristics — the evidence gate for deletion

Deletion runs on evidence, not impression. For each factual claim, confirm it
against the repo:

- **Paths, scripts, directories** — does it exist? (`run ./scripts/seed.sh`,
  "see `core/Foo.java`", "the `billing` module"). Missing → stale candidate.
- **Commands** — does the build/test/run command match `package.json` scripts,
  `pom.xml`, `build.gradle`, `Makefile`, `justfile`, or a real script?
  Renamed or removed → stale candidate.
- **Symbols** — does a named class, function, or endpoint still exist? Grep it.
- **Conventions the code contradicts** — "all dates are UTC strings" but the code
  uses `Instant`; "we don't use Lombok" but `@Data` is everywhere. This one is
  ambiguous: the rule may be aspirational rather than dead, so flag and ask.

The last case splits, and the halves get opposite treatment. Ask whether the
sentence **describes** or **prescribes**:

- **Describes** ("the schema has a `user_tokens` table", "we're on Gradle 8") —
  a claim about how things are. If the code refutes it, it's wrong: correct it,
  or prune it if the corrected version would be redundant anyway.
- **Prescribes** ("all domain models use `@Value`", "never throw across module
  boundaries") — a claim about how things *should* be. Divergent code doesn't
  disprove it; it may be debt the rule exists to fix. Flag and ask.

The tell: if the divergence would be reported as a bug, the rule is being
violated, not dead. A sentence phrased as description but treated as policy
("all domain models use `@Value`" where 79 files use `record`) is the hard case
— surface it as a question and offer the corrected wording.

**Confident enough to prune** — a referenced path, script, module, or symbol that
doesn't exist, or a command the build config has renamed. These are objective,
and the only things `--auto` may delete.

**Flag and keep** — a convention that only *seems* contradicted, and anything you
couldn't verify either way. Surface it as a question, **not a deletion**.

Present removal evidence one line each, claim plus why:

```
Removed (stale):
- "Run ./scripts/build.sh before committing" — no scripts/build.sh in repo (build is `mvn package`).
- Section "Redis cache layer" — no redis dependency or RedisConfig found; appears removed.
- "billing module owns invoices" — no billing/ directory exists.
```

---

## 3. Redundancy and conflict heuristics — the five layers

A rule in CLAUDE.md competes with five other sources of instruction. Compare
against each:

1. **The repo itself** — the file tree, build files, and code. Anything readable
   there doesn't need restating: "this is a Spring Boot project", "tests live in
   `src/test/java`", "we use Maven".
2. **The harness** — your own system prompt is in context, so check directly.
   Projects routinely re-state what the harness already instructs ("read a file
   before editing it", "prefer the dedicated tools over shell commands", "don't
   create branches unasked").
3. **The user's global `~/.claude/CLAUDE.md`** — loaded on every turn in every
   project, so a project copy of a global rule is pure duplication. Check both
   directions: a global rule can also be *wrong here* ("use the maven-deps MCP
   for versions" in a Gradle-only repo). You can't edit the global file, but the
   project can say explicitly that it overrides — worth proposing.
4. **Installed skills** — `~/.claude/skills/*/SKILL.md` plus any project-local
   `.claude/skills/`. A CLAUDE.md that restates a skill's contents wastes
   context and drifts out of sync with it.
5. **The project's own referenced docs** — `ui-design.md`, `spec.md`, an
   architecture doc. Where the worst drift lives: both copies are edited by
   hand and neither knows about the other.

Layer 5 is the one exception to the rule below: those docs **don't auto-load**,
so cutting the CLAUDE.md copy of something only `ui-design.md` says would stop
it loading at all. When CLAUDE.md and a project doc overlap, don't cut — pick an
**owner**, leave the other pointing at it, and say which is which. When they
disagree, the code decides, and the loser is corrected rather than deleted.

Each comparison lands on one of three verdicts:

- **Duplicated** → cut the project copy. Same rule, same scope, same force,
  already stated somewhere **that also loads** — layers 1–4. Nothing is lost.
- **Reinforced** → keep. The project narrows a general rule to something specific
  and checkable ("write tests" globally vs "every repository method needs an
  integration test against Testcontainers" here); the specific version carries
  the information.
- **Contradicted** → surface it, don't resolve it. Which of two disagreeing
  instructions is right is the user's call. Present both, with their locations.

SKILL.md's two guards — a stated preference isn't over-constraint, and a hook
plus its prose coexist by design — apply before you call anything duplicated.

---

## 4. Common smells checklist

**Volume smells**

- **Duplication** — the same rule in root *and* a nested file. Keep one home.
- **Stale build commands** — the single most common rot; verify every time.
- **References to deleted files, modules, or scripts** — prune with evidence.
- **Giant inline code blocks** — a full class or config dump. Extract, or cut to
  the essential lines plus a pointer.
- **Exhaustive enumerations** — "every endpoint", "every env var". Rarely needed
  all at once; move to a reference.
- **Module detail in root** — anything that only matters inside one subdirectory.
- **Always-on `@imports`** — convert to plain on-demand references.

**Constraint smells**

- **Restating the repo** — the stack, the directory layout, the test framework:
  all readable from the file tree and build files.
- **Restating the harness** — rules the model already follows without being told.
- **Restating a skill** — a procedure duplicated from an installed skill's
  SKILL.md, free to drift out of sync with it.
- **Prohibition stacks** — a list of banned constructs where one sentence of
  intent would generalize better and fight the user less.
- **Examples doing a spec's job** — a worked example pinned in always-on context
  to define behavior that a test or a real function already defines.
- **Decision logs** — "2026-03: we moved off Redis because…". History, not an
  instruction; it belongs in memory.
- **Procedures that want to be a skill** — a multi-step routine with a clear
  trigger, sitting inline and loading on every unrelated turn.
- **A second source of truth** — the same ladder, scope list, or convention
  maintained in both CLAUDE.md and a project doc, drifting apart. Pick an owner
  (§3, layer 5); don't blind-cut.
- **Contradictions** — two rules that disagree, in the same file or across
  layers. Surface both and let the user pick.
