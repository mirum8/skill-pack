# Bug Patterns — Concurrency, Data & Performance

Real-world production bug patterns — things that actually break, not theoretical concerns. Hunter focus: **Data Corruption, Concurrency Issues, Resource & Connection Issues, Performance & Scalability.**

## Data Corruption

- **Partial update without transaction**: multiple DB writes where some succeed and some fail, leaving inconsistent data
- **Race condition on shared data**: two threads reading and writing same data without synchronization — lost updates
- **Incorrect merge logic**: combining two data sources where conflicts are resolved wrong or data is dropped
- **Lost updates**: read-modify-write without optimistic/pessimistic locking in concurrent environment
- **Wrong operation ordering**: operations executed in wrong sequence — e.g., delete before backup, publish before validate
- **Stale data usage**: cached value used after the source has changed, especially across transaction boundaries
- **Collection mutation during iteration**: modifying a list/map while iterating over it

## Concurrency Issues

- **Non-atomic read-modify-write**: `counter++` or `if (!map.contains(key)) map.put(key, value)` without synchronization
- **Shared mutable state**: field modified from multiple threads without volatile/synchronized/atomic
- **Incorrect double-checked locking**: missing `volatile` on lazily-initialized field, or wrong synchronization scope
- **Lock ordering deadlock**: two locks acquired in different order by different threads
- **Thread-unsafe collection**: `HashMap`, `ArrayList` used from multiple threads without synchronization
- **Race in check-then-act**: checking a condition and acting on it without holding a lock — condition can change between check and act
- **Synchronizing on wrong object**: `synchronized(localVariable)` or `synchronized(new Object())`

## Resource & Connection Issues

- **Unclosed resource in error path**: resource opened in `try` but not closed if exception thrown before reaching `close()` — no try-with-resources
- **Connection leak**: database/HTTP/network connection not returned to pool on error path
- **Pool exhaustion**: connections borrowed but not returned under all paths, eventually exhausting the pool
- **Resource leak in loop**: opening resources inside a loop without closing each one before the next iteration
- **Double close**: closing a resource that was already closed, potentially throwing and masking the original error

## Performance & Scalability (Production Impact)

Only flag performance issues that cause **real production impact** — pool exhaustion, timeouts, OOM, request latency that breaks SLAs. Skip micro-optimizations and "could be faster" suggestions.

### JPA / Hibernate

- **N+1 query**: parent entities fetched, then a lazy `@OneToMany` / `@ManyToOne` collection or association is accessed in a loop — each access triggers a separate query. Telltale signs: `findAll()` / `findById()` followed by `for (var x : parent.getChildren())`, mapping to DTO inside a loop, accessing `parent.getChild().getName()` after the parent was loaded without a fetch. The fix is `JOIN FETCH`, `@EntityGraph`, or `@BatchSize`.
- **Cartesian product from multiple `JOIN FETCH` on collections**: fetching two `@OneToMany` collections in one query multiplies rows (`MultipleBagFetchException` in Hibernate, or silently exploded result sets). Only one collection can be fetched per query unless using `@BatchSize` or two queries.
- **Unbounded `findAll()` / unbounded query**: repository method or JPQL/SQL with no `Pageable`, no `LIMIT`, no `WHERE` filter — loads the entire table into memory. Especially dangerous on tables that grow over time.
- **`save()` in a loop**: calling `repository.save(entity)` inside a `for` loop instead of `saveAll()` or batched insert — generates one INSERT/UPDATE per row, no batching. With `hibernate.jdbc.batch_size` set this is wasted; without it, it's catastrophic.
- **Eager fetch on collection**: `@OneToMany(fetch = FetchType.EAGER)` or `@ManyToMany(fetch = EAGER)` — every load of the parent pulls the entire collection, often unnecessary, and combined with another EAGER collection causes Cartesian products.
- **Lazy access outside transaction**: lazy field accessed after the `@Transactional` boundary closed — `LazyInitializationException` at runtime. Common when entities are returned from a service to a controller and the view layer touches a lazy collection.
- **Loading entities just to count / check existence**: `findAll().size()` instead of `count()`, `findById(id).isPresent()` instead of `existsById(id)` — fetches full rows when a single SQL aggregate would do.
- **Loading entities to delete by id**: `findById(id).ifPresent(repo::delete)` instead of `deleteById(id)` or `@Modifying @Query("delete ...")` — pulls the row in only to issue a DELETE.
- **Entity returned from API instead of DTO projection**: `@Query` returning the full entity when only 2-3 fields are used downstream — pulls every column and triggers lazy loading later. Projections (interface-based or DTO constructor) avoid both.
- **Missing index on filtered/joined column**: query filters or joins on a column with no index, on a table large enough to matter. Only flag when migration files / schema are visible and the column is clearly hot.

### General

- **DB call inside a loop that could be batched**: `for (id : ids) repo.findById(id)` instead of `findAllById(ids)`; same for HTTP calls, cache lookups, etc. — N round-trips where 1 would do.
- **O(n²) where O(n) was possible**: `list.contains(x)` inside a loop over another list (use `Set`); nested loops over the same large collection looking for matches; repeated `String` concatenation in a loop on large input.
- **Loading entire file/blob into memory**: `Files.readAllBytes()` / `IOUtils.toString()` on user-uploaded or unbounded-size input, instead of streaming. OOM under load or large inputs.
- **Unbounded in-memory cache / collection**: `static Map<K, V> cache = new HashMap<>()` with no eviction, no max size — grows forever, eventually OOM. Real cache (Caffeine, Guava) with size/TTL bounds is fine.
- **Blocking I/O in reactive / async context**: `Thread.sleep`, blocking JDBC, blocking HTTP client inside `Mono` / `Flux` / `CompletableFuture` chain — starves the event loop / thread pool.
- **Synchronous external call without timeout**: HTTP / DB / RPC call with no timeout configured — one slow dependency hangs every thread, exhausts the pool, takes down the service.
