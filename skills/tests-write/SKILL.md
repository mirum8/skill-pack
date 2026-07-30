---
description: >-
  Modern best practices for writing Java/Kotlin tests (Given/When/Then, AssertJ, JUnit 5,
  self-contained tests, hard-coded expectations, helper functions, KISS > DRY). Consult this skill
  automatically and proactively — no explicit user request needed — for ANY task that produces or
  changes Java/Kotlin behavior that ought to be tested, not just tasks that name "tests". This
  includes: writing, generating, or modifying test code of any kind (unit, integration,
  bug-reproduction, refactor, added coverage); AND implementation work that should come with tests
  — adding or changing a service method, controller/endpoint, repository, validation, mapper, or
  business logic; reproducing or fixing a reported bug (write the failing test first); refactoring
  production code that needs a safety-net test. Whenever you are about to write or edit a
  Java/Kotlin .java/.kt file that carries logic, or the user asks to implement, build, add, fix,
  or change such code, load this skill FIRST and let it shape the tests. Bias strongly toward
  triggering. Skip it only for pure read/explain questions, build/dependency/config-only edits, or
  non-JVM languages.
---

# Writing Tests — Modern Java Best Practices

## Delegate the writing to a dedicated subagent

Writing tests is detailed, context-heavy work: exploring existing patterns, reading the code under test, drafting many test methods, running them, reading failures. Doing all of that inline bloats the main conversation and crowds out the larger task the tests belong to. So when you can, **hand the actual writing to a dedicated `java-backend-developer` subagent** and keep the orchestrating context lean.

**First — can you delegate?** You can only spawn a subagent if you have an Agent/Task subagent tool, and a subagent cannot spawn another subagent. So if you are yourself a subagent (this includes the case where you were spawned specifically to write these tests), you have no such tool — don't waste time searching for one. Skip straight to the Workflow below and write the tests yourself inline. This is also what prevents delegating in a loop.

**If you can delegate, do this:**

1. Do a light scope pass — what's the target (git diff, named files, or a bug report), and how many files/classes need tests?
2. Spawn the subagent(s):
   - **Single target (default):** one `java-backend-developer` subagent writes all the tests.
   - **Large target (many files/classes):** fan out — several `java-backend-developer` subagents in parallel, each owning one slice (e.g. one service plus its tests). Give them a shared one-line style note ("match the existing test conventions in `<module>`") so the slices stay consistent.
3. Each subagent prompt must include:
   - The exact target (files/classes/bug to cover).
   - "Load the `/r:tests-write` skill and follow it. You are the dedicated test-writing subagent — write the tests yourself, do NOT delegate further."
   - Any project context you already know (base test classes, Testcontainers setup, module path) so it doesn't re-discover it.
4. When the subagent(s) report back, relay the result: which tests were added, pass/fail, and any production bug they surfaced.

For a single trivial test, it's also fine to just write it inline — delegating would cost more than the work.

## Workflow

Applies whether you're the spawned subagent or — for a tiny task — writing inline.

1. Analyze the code to test (git diff, specified files, or bug report)
2. Explore existing test patterns, libraries, and base classes in the project
3. Write tests following the practices below and project conventions
4. Run the new tests
5. If tests fail: analyze the failure. If production code is incorrect, ask the user whether they want the bug fixed. Do NOT auto-fix production code without approval.

## Test Type Selection

| Code Type | Test Type | Reason |
|-----------|-----------|--------|
| REST Controllers/Endpoints | Integration | MockMvc/WebTestClient with Testcontainers |
| Service layer | Integration | Test real behavior with Testcontainers |
| Repository layer | Integration | Real database via Testcontainers |
| Complex business logic | Unit | Only for complicated algorithms with many edge cases |
| Simple/straightforward code | Skip | No value testing trivial logic |

Integration tests are the default. Unit tests are reserved for methods with complex algorithms, many branches, or intricate logic. Prefer testing complete vertical slices (HTTP → business logic → database) over isolating each class with mocks — this tests behavior, not implementation, and is robust against refactoring.

## Don't Mock the Integration

The whole point of an integration test is to verify that real components work together. If you spin up a full Spring context and a real database but `@MockitoBean` every interesting collaborator (the AI responder, the embedding service, the outbound sender), you've built a unit test wearing an integration-test costume. It will pass when the orchestration is broken and tell you nothing about whether the system actually works.

Rule of thumb: **mock only at true I/O boundaries** — third-party HTTP APIs, real LLM calls, the system clock — not internal collaborators between your own services.

When you must mock a collaborator that produces persistent state (e.g., `embedChunk` writes to `chunk_embeddings`), make the mock a side-effecting fake so downstream assertions stay observable:

```java
doAnswer(inv -> {
    UUID chunkId = inv.getArgument(0);
    jdbcTemplate.update("INSERT INTO chunk_embeddings (id, content, embedding) "
            + "VALUES (?::uuid, ?, ?::vector)", chunkId, "embedded", dummyVector());
    return null;
}).when(chunkEmbeddingService).embedChunk(any(), any(), any(), any(), any());
```

Now you can assert on the table state after the action runs, not just on whether the mock was called.

## Test Structure: Given / When / Then

Every test has three blocks separated by blank lines:

```java
@Test
void filterByCategory() {
    // given
    insertIntoDatabase(
        createProductWithCategory("1", "Office"),
        createProductWithCategory("2", "Office"),
        createProductWithCategory("3", "Hardware")
    );

    // when
    String responseJson = requestProductsByCategory("Office");

    // then
    assertThat(toDTOs(responseJson))
        .extracting(ProductDTO::getId)
        .containsOnly("1", "2");
}
```

Keep each block as short as possible using helper functions.

## Naming Conventions

Use `actual*` and `expected*` prefixes for variables in equality assertions — it clarifies intent and prevents mix-ups:

```java
ProductDTO actualProduct = requestProduct(1);
ProductDTO expectedProduct = new ProductDTO("1", List.of(State.ACTIVE));
assertThat(actualProduct).isEqualTo(expectedProduct);
```

## Fixed Data, Never Random

Random UUIDs, timestamps, or amounts make failures hard to reproduce. Always use fixed, deterministic values:

```java
Instant ts = Instant.ofEpochSecond(1550000001);
UUID uuid = UUID.fromString("00000000-0000-0000-a000-000000000001");
```

## Helper Functions — Use Them Heavily

Extract repetitive setup and assertion details into descriptively-named helpers. This is the primary mechanism for keeping tests concise and focused:

- Parameterize everything relevant to the test
- Use reasonable defaults for non-critical values
- Use varargs for inserting multiple items

```java
private ProductEntity createProductWithCategory(String id, String category) {
    return new ProductEntity(id, category, "defaultName", Instant.ofEpochSecond(1550000001));
}

private void insertIntoDatabase(ProductEntity... products) {
    Arrays.stream(products).forEach(p -> jdbcTemplate.insert(p));
}
```

## KISS > DRY

Don't extract values to variables if they're used once or twice. Inline values are shorter and easier to trace in failure messages:

```java
// prefer this
insertIntoDatabase(createProduct("4243", "Office"));

// over extracting every value
String id = "4243";
String category = "Office";
insertIntoDatabase(createProduct(id, category));
```

## One Test, One Behavior

Never extend an existing test to cover additional cases. Create separate, descriptively-named test methods. Each test documents a specific behavior and makes failures easy to diagnose:

```java
@Test void multipleProductsAreReturned() { }
@Test void filterByCategory() { }
@Test void filterByDateCreated() { }
```

## Assert Only What's Relevant

Don't assert everything possible. Each test checks only the behavior it's named for. Skip assertions already verified in other tests:

- One "mapping test" asserting all fields are correctly mapped
- Filtering tests checking only IDs
- Edge case tests checking only the specific calculated value

## Self-Contained Tests

### Reveal All Parameters

Helpers must expose values relevant to the test. Don't force readers to jump to function definitions:

```java
// bad — hides what matters
insertIntoDatabase(createProduct());
List<ProductDTO> products = requestProductsByCategory();

// good — relationship between data and query is visible
insertIntoDatabase(createProduct("1", "Office"));
List<ProductDTO> products = requestProductsByCategory("Office");
```

### No Shared Setup for Test Data

Keep all test data in the test method itself. Don't move insertions to `@Before`/`@BeforeEach`. Use helpers to make setup concise one-liners instead.

### Composition Over Inheritance

Don't build deep test class hierarchies. Compose small fixture components:

```java
public class MyTest {
    private JdbcTemplate template;
    private MockWebServer taxService;

    @BeforeAll
    void setup() throws IOException {
        this.template = new DatabaseFixture().startDatabaseAndCreateSchema();
        this.taxService = new MockWebServer();
        taxService.start();
    }
}
```

## Dumb Tests Are Powerful

### Never Reuse Production Code

Compare output against hard-coded expected values. If you reuse production mapping logic, bugs in that logic won't be caught:

```java
// bad — reuses production mapper
List<State> expectedStates = ProductionCode.mapToEnumList(isActive, isRejected);

// good — hard-coded expectation
assertThat(actualDTO.states).isEqualTo(List.of(State.ACTIVE, State.REJECTED));
```

### Minimize Test Logic

Tests should be input/output comparison. No loops, no conditionals, no complex assertion chains. Leverage AssertJ's rich API instead.

## AssertJ Over JUnit Assertions

AssertJ provides fluent, type-safe assertions with descriptive failure messages. Never use `assertTrue`/`assertFalse` — they produce cryptic output:

```java
// bad
assertTrue(actualList.contains(expected));
assertTrue(actualList.size() == 5);

// good
assertThat(actualList).contains(expected);
assertThat(actualList).hasSize(5);
```

### Chain assertions on the same subject

Repeating `assertThat(x)` per line is noise. Chain on the same subject — failure messages stay just as clear, and the test reads as one statement about one thing:

```java
// noisy
assertThat(actualList).contains(expected);
assertThat(actualList).hasSize(5);
assertThat(actualList).startsWith(first);

// clean
assertThat(actualList)
    .hasSize(5)
    .startsWith(first)
    .contains(expected);
```

Key AssertJ patterns — see `references/assertj-patterns.md` for a comprehensive catalog.

## JUnit 5 Features

### @Nested for Grouping

```java
class DesignControllerTest {
    @Nested class GetDesigns {
        @Test void allFieldsAreIncluded() { }
        @Test void limitParameter() { }
    }
    @Nested class DeleteDesign {
        @Test void designIsRemovedFromDb() { }
        @Test void return404OnInvalidId() { }
    }
}
```

### @ParameterizedTest for Variations

```java
@ParameterizedTest
@CsvSource({"1, 1, 2", "5, 3, 8", "10, -20, -10"})
void add(int a, int b, int expectedSum) {
    assertThat(calculator.add(a, b)).isEqualTo(expectedSum);
}
```

### @DisplayName for Readability

```java
@Test
@DisplayName("Design is removed from database")
void designIsRemoved() { }
```

## Remote Service Mocking

Use MockWebServer or WireMock for HTTP dependencies:

```java
serviceMock.enqueue(new MockResponse()
    .addHeader("Content-Type", "application/json")
    .setBody("{\"name\": \"Smartphone\"}"));
```

## Async Testing with Awaitility

Never use `Thread.sleep()`. Use Awaitility for polling assertions:

```java
await().atMost(Duration.ofSeconds(6))
    .pollInterval(Duration.ofSeconds(1))
    .untilAsserted(() ->
        assertThat(findInDatabase(1).getState()).isEqualTo(State.SUCCESS)
    );
```

## Mockito: Verify Behavior, Not Just Calls

A common failure mode is the verify-only test: stub some inputs, call the method, then `verify(mock).something()` and stop. These tests pass even if the method becomes a no-op in production, because they never check what the user (or the next layer) actually sees. They also break the moment you refactor — because they assert *how* the code works, not *what* it does.

The fix: assert on observable outcomes. Return values, persisted rows, exceptions thrown, messages sent. Use `verify` only when the side effect is the behavior (e.g., notification dispatch) — and even then, prefer to capture the argument and assert on its contents.

### Verify-and-assert, not verify-only

Combine `verify` (for side effects) with `assertThat` (for state and return values):

```java
// weak — passes even if the method secretly stops persisting anything
@Test
void register_savesUser() {
    service.register(request);
    verify(userRepository).save(any());
}

// strong — verifies the side effect happened AND the state is correct
@Test
void register_savesUserWithExpectedFields() {
    User actual = service.register(request);

    assertThat(actual.email()).isEqualTo("user@test.com");
    assertThat(actual.role()).isEqualTo(Role.TENANT_ADMIN);
    verify(featureService).assignDefaultFeatures(actual.tenantId());
}
```

### Capture, don't `any()`

When `verify` is needed, prefer `ArgumentCaptor` over `any()`. Capturing makes the test precise — it documents what the production code actually did, not just that it did *something*:

```java
// weak — passes even if the wrong conversation was forwarded
verify(aiResponder).respond(any(Conversation.class));

// strong — proves the right conversation was forwarded
ArgumentCaptor<Conversation> captor = ArgumentCaptor.forClass(Conversation.class);
verify(aiResponder).respond(captor.capture());
assertThat(captor.getValue().id()).isEqualTo(expectedConvId);
assertThat(captor.getValue().status()).isEqualTo(ConversationStatus.AI_HANDLING);
```

### "Did nothing" tests need full coverage

A test asserting "no work happened" must verify the *full* set of side effects didn't occur — not just one. Otherwise a future bug that swaps which side effect fires will pass:

```java
// weak — only asserts featureService wasn't called; misses other side effects
@Test
void respond_noLastMessage_doesNothing() {
    when(messageHelper.findLastCustomerMessage(conv)).thenReturn(null);
    aiResponder.respond(conv);
    verify(featureService, never()).getEnabledFeatureIds(any());
}

// strong — covers every observable side effect that should NOT happen
@Test
void respond_noLastMessage_doesNothing() {
    when(messageHelper.findLastCustomerMessage(conv)).thenReturn(null);
    aiResponder.respond(conv);

    verify(featureService, never()).getEnabledFeatureIds(any());
    verify(billingService, never()).checkBalance(any());
    verify(escalationHandler, never()).escalate(any(), any());
    verify(messageHelper, never()).sendResponse(any(), any());
    verify(messageHelper, never()).saveAndSendResponse(any(), any(), any(), any());
}
```

### Don't mock concrete values in matchers

Per the project rule: only use Mockito matchers (`any()`, `eq()`) when at least one argument is a matcher. Don't wrap concrete values in `eq(...)` when not needed:

```java
// noise
verify(repo).save(eq(entity));

// clean
verify(repo).save(entity);
```

## What NOT to Test

- Every possible input combination
- Trivial getters/setters
- Framework behavior (Spring, JPA internals)
- Third-party library internals
- **Pure delegation wrappers** — if a class is a one-line `delegate.x()` with no observable side effect, there's nothing meaningful to verify. Either delete the wrapper (often it's dead code or a port-fulfillment vestige) or, if it's load-bearing, write an integration test against the real delegate that proves the end-to-end behavior. A test asserting `verify(delegate).x()` only proves the wrapper compiles.

## Reflection in Tests Is a Smell

If your test reaches for `ReflectionTestUtils.setField(...)` or a custom reflection helper to populate fields, the entity is missing a test-friendly factory or builder. Fix the entity (add a Lombok `@Builder`, `@Setter`, or a `withId(...)` helper) rather than working around it in tests. Reflection couples tests to internal field names; a future rename will break them silently.

## Test Count Philosophy

Keep test count minimal — quality over quantity. Cover the happy path, one or two important edge cases, and error handling for critical failures only.
