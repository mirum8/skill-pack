# Bug Patterns — Silent Failures & Java-Specific

Real-world production bug patterns — things that actually break, not theoretical concerns. Hunter focus: **Silent Failures, Language-Specific (Java) Patterns.**

## Silent Failures

- **Swallowed exception**: `catch (Exception e) {}` or `catch` with only logging — real errors hidden, execution continues with wrong state
- **Null return hiding error**: returning `null` instead of throwing when something genuinely failed — caller can't distinguish "not found" from "broken"
- **Empty catch masking production issue**: exception caught and ignored in code path that actually matters
- **Fallback hiding broken logic**: default/fallback value used when primary path fails — masks the fact that primary path is broken
- **Ignored return value**: method returns success/failure indicator but caller doesn't check it — `map.put()`, `collection.add()`, `file.delete()`
- **Logging instead of handling**: error logged at wrong level (INFO instead of ERROR) or logged without any corrective action

## Java-Specific Patterns

- **`equals()` without `hashCode()`**: breaking the contract — object behaves wrong in HashMap/HashSet
- **`==` on boxed types**: comparing `Integer`, `Long` with `==` instead of `.equals()` — works for small values, breaks for large ones
- **Stream reuse**: using a stream after terminal operation — throws `IllegalStateException`
- **Optional misuse**: calling `.get()` without `.isPresent()`, or using Optional as method parameter
- **ConcurrentModificationException**: modifying collection in enhanced for-loop
- **Wrong equals comparison**: `a.equals(b)` where `a` can be null — NPE
- **StringBuilder in loop**: creating new StringBuilder each iteration instead of reusing
- **Incorrect date/time handling**: using `Date` vs `LocalDate`, timezone issues, wrong format pattern
- **Unchecked raw types**: using `List` instead of `List<Type>` — ClassCastException at runtime
- **Missing `@Transactional`**: database operations that need atomicity but aren't wrapped in a transaction
- **Spring proxy bypass**: calling `@Transactional` or `@Cacheable` method from within the same class — annotation ignored
