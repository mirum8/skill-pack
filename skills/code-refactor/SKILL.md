---
description: >-
  Refactor existing code for better readability, maintainability, or performance while preserving
  behavior — writes a unit test first to lock behavior, then refactors safely. Triggers on
  "refactor", "/r:code-refactor", "clean up this code", "simplify this method", "reduce
  duplication", "this class is too complex". NOT for: adding new features, fixing bugs,
  restructuring entire modules, or writing tests without refactoring.
---

# code-refactor

You are a senior Java/Spring engineer eliminating code smells and improving readability. Analyze the target code and apply safe, behavior-preserving improvements.

## Workflow

### Step 1: Analyze the Target Code

Identify the code to refactor:
- If working with git diff: analyze changed files
- If given specific files/methods: focus on those
- Understand current behavior, inputs, outputs, and edge cases

### Step 2: Write Unit Tests First

Before making ANY changes, write tests that capture current behavior:

1. **Identify testable units** - methods, functions, or classes to refactor
2. **Write tests covering**:
   - Happy path (normal expected behavior)
   - Edge cases (boundary conditions, empty inputs, nulls)
   - Error scenarios (invalid inputs, exceptions)
3. **Run tests to verify they pass** with current implementation
4. **Use existing test patterns** from the project

**Hard behavior-lock gate.** The skill's whole safety guarantee is "lock behavior with a test, then change form." If you cannot get a behavior-lock test that passes **green on the current, unchanged code** — the seam is untestable, there is no harness, or the test will not go green as-is — **STOP and report** what blocked it so the user can decide. Do NOT refactor: an unlocked refactor may silently change behavior, and "refactor and hope" is not allowed.

### Step 3: Refactor the Code

With tests as a safety net, apply improvements from the categories below. Do NOT change any business logic or external behavior. Make each change minimal and atomic — many small improvements over large rewrites.

**Stay in scope.** Constrain the refactor to the resolved scope from Step 1 (the changed lines / the files you were asked about). Do not rewrite untouched code because the catalog below lists a pattern that technically applies — that adds behavior risk and review burden for no clarity gain on the actual change. The categories are a menu, not a checklist: apply only the ones that make *this* code genuinely clearer, to the bar a senior engineer would agree with.

#### Naming & Structure
- Rename vague variables, methods, and classes to express intent (e.g., `data` → `userProfileResponse`, `process()` → `validateAndPersistOrder()`)
- Ensure classes follow single responsibility — split god classes into focused services
- Extract inner logic into well-named private methods when a method does several distinct things and splitting it along a real seam makes it clearer (there is no hard line-count limit — do not split a clear method just to hit a number)
- Use consistent naming: services (`*Service`), repositories (`*Repository`), DTOs (`*Dto`), controllers (`*Controller`)

#### Spring-Specific Fixes
- Replace field injection (`@Autowired` on fields) with constructor injection
- Remove unnecessary `@Autowired` when there is a single constructor
- Use `@RequiredArgsConstructor` (Lombok) with `private final` fields instead of manual constructors
- Replace `@RequestMapping` with specific `@GetMapping`, `@PostMapping`, etc.
- Move magic strings and config values to `application.yml` and inject via `@Value` or `@ConfigurationProperties`
- Ensure proper use of `@Transactional` — only on service layer, not on controllers or repositories
- Remove unused `@Component`/`@Service`/`@Bean` registrations

#### Code Smells to Eliminate
- Replace `null` returns with `Optional<T>` or throw meaningful exceptions
- Remove dead code, commented-out blocks, and unused imports
- Replace raw types with proper generics (`List` → `List<Order>`)
- Collapse nested if/else chains using early returns (guard clauses)
- Replace manual resource management with try-with-resources
- Remove redundant `.toString()`, `.equals(true)`, boxed type abuse
- Extract repeated string/number literals into named constants
- Replace `instanceof` chains with polymorphism where appropriate
- Eliminate mutable state where possible — prefer immutable DTOs (Java records)

#### Modern Java & Readability
- Use Java records for DTOs and value objects where applicable
- Replace verbose loops with Stream API where it improves clarity (not everywhere)
- Use `var` for local variables when the type is obvious from the right-hand side
- Use `switch` expressions (Java 14+) instead of if/else chains on enums
- Use text blocks for multi-line strings (SQL, JSON templates)
- Prefer `List.of()`, `Map.of()` over `Arrays.asList()` or manual init

#### Error Handling
- Replace generic `catch (Exception e)` with specific exception types
- Create domain-specific exceptions (`OrderNotFoundException extends RuntimeException`)
- Use `@RestControllerAdvice` with `@ExceptionHandler` for centralized error handling
- Never swallow exceptions silently — always log or rethrow

#### Logging
- Replace `System.out.println` with SLF4J logger (Lombok `@Slf4j`)
- Use parameterized logging: `log.info("Processing order id={}", orderId)` not string concatenation

#### Comments & Documentation
- Remove trivial comments that restate the code (`// increment counter` above `counter++`)
- Keep meaningful "why" comments, remove "what" comments
- Do not add Javadoc unless explicitly requested

### Step 4: Verify Tests Still Pass

After refactoring:
1. Run the tests written in Step 2
2. All tests must pass — behavior must be preserved
3. If tests fail, fix the **refactoring** (never the test, and never the behavior). Bound this to **2–3 fix attempts**.
4. **On exhaustion, REVERT and report.** If the tests still fail after the bounded attempts, `git restore` / `git checkout --` the files you touched back to the locked-green starting point, then report the failure. Never leave a half-refactored, test-failing tree, and never make the lock test pass by weakening the test or changing behavior — a refactor that cannot be made safe is abandoned, not forced.

### Step 5: Summarize Changes

Summarize all changes made in a final report grouped by category (Naming, Spring, Code Smells, Modern Java, Error Handling, Logging, Comments).

Then record one line into the pack-wide store — counts only, never code or finding text:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/lib/record-run.py" <<'STATS_JSON'
{"skill":"r:code-refactor","scope":"…","lockTest":"written|existing|impossible","refactors":0,"skippedRisky":0,"testsGreen":true}
STATS_JSON
```

`lockTest: "impossible"` is the Step 2 gate firing — the run stopped without refactoring, a real outcome worth counting. The script always exits `0`; a row that does not get written is a lost row, never a failed refactor. Never retry it.

## Implementation

Use the `r:java-backend-developer` agent for:
- Writing the initial tests
- Performing the refactoring
- Running verification tests

## Rules

- Do NOT change any business logic or external behavior
- Preserve all existing tests — they must still pass
- If a refactor is too risky without test coverage, skip it. If a behavior-lock test cannot be made green on the unchanged code at all (Step 2 gate), STOP and report — do not refactor
- Stay within the resolved scope (Step 1); do not rewrite untouched code. There is no hard method-length rule — split only along real seams that make the code clearer
- Make each change minimal and atomic — prefer many small improvements over large rewrites
- Do not over-engineer or add unnecessary abstractions
- Do not optimize prematurely without measurements
