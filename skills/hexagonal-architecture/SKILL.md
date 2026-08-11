---
description: >-
  Hexagonal Lite — a module layout for multi-module Maven Spring Boot projects: one core
  module, adapters around it, dependencies pointing only inward, cross-module calls through
  inbound *UseCase and outbound port interfaces, ArchUnit-enforced. Core never imports adapter
  packages, tech SDKs, JPA or Spring Web; adapters own their tech types and map to core's plain
  records. Deliberately skips DDD tactical patterns, CQRS handler splits and speculative
  single-call-site ports — only the hexagonal parts that pay for themselves. Use on "where should
  this class live?", "can core import X?", "should I extract a UseCase interface?", or any
  question about ports, adapters, module boundaries or dependency direction.
---

# Hexagonal Lite Architecture (Java + Maven + Spring Boot)

A pragmatic take on hexagonal (ports & adapters) for Spring Boot backends built as Maven multi-module projects. The goal is clean module boundaries you can enforce in CI — nothing more. This skill deliberately does not layer DDD tactical patterns, CQRS handler splits, or ceremonial interfaces on top of the module structure. Keep what pays for itself; leave the rest out.

> **Do you need physical Maven modules at all?** This skill assumes you've decided they earn their cost. If you haven't: the same boundaries are enforceable inside a *single* module — same package layout — with the ArchUnit `onionArchitecture()` rule below, or with [Spring Modulith](https://docs.spring.io/spring-modulith/)'s `ApplicationModules.of(App.class).verify()`. Physical modules buy exactly two extra things: hard *compile-time* prevention (you can't import a non-dependency) and independent buildability. Reach for them when you need those — until then, package-by-feature plus a boundary test is lighter, and you can always split a stable boundary out into its own module later.

## The Core Idea

One central Maven module holds the domain and the **interfaces** for everything the domain needs from the outside world. Every other module is an **adapter** that either drives the core (inbound) or implements one of those interfaces (outbound). Adapters never know about each other. The single Spring Boot application context wires them together at runtime.

```
        ┌──────────────┐    ┌──────────────┐
        │  web-adapter │    │  cli-adapter │   (inbound — drive the core)
        └──────┬───────┘    └──────┬───────┘
               │                   │
               ▼                   ▼
        ┌─────────────────────────────────┐
        │              core               │   (domain + port interfaces)
        └─────────────────────────────────┘
               ▲                   ▲
               │                   │
        ┌──────┴───────┐    ┌──────┴───────┐
        │  jpa-adapter │    │ email-adapter│   (outbound — implement core's needs)
        └──────────────┘    └──────────────┘
```

## The Three Rules

### Rule 1: Star Dependency Graph (and Clear Boundaries)

- Every adapter module declares `core` in its `pom.xml`.
- No adapter declares another adapter as a dependency.
- `core` declares no other project module as a dependency.
- **Boundary:** `core` never imports a class from any adapter package. Each adapter never imports a class from a sibling adapter package. These are boundaries, not just dependency directions — violating them by dragging an adapter's types into core (or one adapter's DTO into another) breaks the architecture even if the pom still compiles.

When a developer thinks "I'll just import that class from the other adapter," that's the moment a port should be born.

### Rule 2: Cross-Module Calls Go Through Ports

When code in adapter A needs behavior from adapter B:

1. Define a Java interface in `core.port.out` describing what the **core** needs (in domain terms).
2. Implement it in the adapter that owns the technology (annotated with `@Component`, `@Service`, or `@Repository`).
3. Inject the interface anywhere it's used — Spring's component scan in the `app` module wires the implementation.

The interface lives in `core` because `core` is what describes the *need*. The implementation lives in the adapter because that's what owns the *technology*. The consumer of the port never knows which adapter (or which technology) fulfills it.

### Rule 3: Enforce It in the Build with ArchUnit

Architecture rules that aren't enforced rot within a quarter. Add an ArchUnit test in the `app` module (so it sees every class on the classpath) that fails Maven's `verify` phase if any boundary is broken.

ArchUnit ships a built-in `onionArchitecture()` rule that already encodes this whole style — it treats "onion" as a synonym for hexagonal / ports-and-adapters, keeps the domain free of every adapter, and bars adapters from depending on each other. Prefer it: one declarative block replaces a pile of hand-written per-adapter rules.

```java
@AnalyzeClasses(packages = "com.example", importOptions = ImportOption.DoNotIncludeTests.class)
class ArchitectureTest {

    @ArchTest
    static final ArchRule hexagonal = onionArchitecture()
        .domainModels("com.example.core..")            // domain records + port interfaces
        .domainServices("com.example.core.service..")  // *UseCase implementations
        .adapter("web",   "com.example.web..")
        .adapter("jpa",   "com.example.jpa..")
        .adapter("email", "com.example.email..");
        // adapters automatically may NOT depend on one another, and nothing
        // may leak back into the domain — no per-adapter copies needed.
}
```

Drop down to an explicit `noClasses()` rule only for a boundary the DSL can't express — for instance, keeping a specific tech package out of `core` entirely (the framework-free check `onionArchitecture()` doesn't cover, since it only knows about the adapters you named):

```java
@ArchTest
static final ArchRule core_isFrameworkFree = noClasses()
    .that().resideInAPackage("com.example.core..")
    .should().dependOnClassesThat().resideInAnyPackage(
        "jakarta.persistence..", "org.springframework.web..");
```

If the rule isn't testable in the build, it isn't a rule — it's a wish.

## What belongs on each side of the boundary

This is the single most frequently violated part of the style. Be explicit with yourself.

**Allowed in `core`:**
- JDK (`java.*`, `java.time`, `java.util`, etc.)
- `org.slf4j.Logger`
- Lombok annotations
- `jakarta.validation` annotations (`@NotNull`, `@Size`, etc.) — these are annotations, not I/O
- `spring-context` — `@Service`, `@Component`, `@RequiredArgsConstructor`-style constructor injection, `ApplicationEventPublisher`
- `spring-tx` — `@Transactional` on a use-case `@Service`. A declarative annotation, not I/O — same category as `@Service` and `jakarta.validation`. The use-case service is the transaction boundary (one use case = one unit of work).
- Your own domain records and port interfaces

**NOT allowed in `core`:**
- `jakarta.persistence.*` — JPA lives in the persistence adapter
- `org.springframework.web.*`, `HttpServletRequest`, `ResponseEntity` — web lives in the web adapter
- Third-party tech SDKs — Stripe, Telegram, OpenAI, Jedis, Kafka client, AWS SDK — all in their respective adapters
- Any adapter package (`com.example.web..`, `com.example.jpa..`, etc.)
- DTOs defined by adapters (request/response classes, JPA entities, SDK payloads)

**How types cross the boundary:** adapters own their tech-specific types and each adapter maps to and from `core`'s domain records in a `*Mapper` class sitting inside the adapter. Core never sees a `FooEntity`, a `FooRequest`, or a `FooSdkPayload`. This is the boundary — not a convention, a boundary.

## Maven Module Layout

Root `pom.xml` declares packaging `pom` and lists modules:

```xml
<modules>
    <module>core</module>
    <module>web-adapter</module>
    <module>jpa-adapter</module>
    <module>messaging-adapter</module>
    <module>app</module>
</modules>
```

Module structure:

```
core/
  pom.xml                                       # Lombok, slf4j, validation-api, spring-context
  src/main/java/com/example/
    <feature>/                                  # domain records/POJOs grouped by feature
    port/
      in/                                       # *UseCase interfaces called by inbound adapters
      out/                                      # Provider/Sender/Notifier interfaces, implemented outbound
    service/                                    # @Service classes implementing the *UseCase interfaces

web-adapter/                                    # inbound — @RestController / Thymeleaf controllers
  pom.xml                                       # core + spring-boot-starter-web
jpa-adapter/                                    # outbound — implements *Repository / *Provider ports
  pom.xml                                       # core + spring-boot-starter-data-jpa
messaging-adapter/                              # outbound — implements *Publisher / *Sender ports

app/
  pom.xml                                       # depends on every other module
  src/main/java/com/example/Application.java    # @SpringBootApplication — only main() in the project
  src/main/resources/application.yml
  src/test/java/.../ArchitectureTest.java       # ArchUnit tests run here
```

The `app` module is the **composition root**. It carries `@SpringBootApplication` and depends on every adapter — otherwise nothing would get wired into the context. Leaf modules carry no `@SpringBootApplication` and no `main()`.

### Why component scanning works across modules

Spring Boot's default `@SpringBootApplication` scans the package containing it. Put `Application.java` in a parent package (`com.example`) and every adapter under that package (`com.example.web`, `com.example.jpa`, etc.) gets picked up automatically — no manual `@ComponentScan` needed.

## Inbound Ports (`*UseCase`)

Interfaces in `core.port.in` representing **use cases the system supports**. Inbound adapters (controllers, schedulers, CLI) call these. The implementation lives in `core.service` annotated with `@Service`.

A `*UseCase` is not a DDD application service, not a CQRS command or query handler, not a mediator target — it's just a Java interface describing what an inbound caller can invoke. Keep it that simple.

Suffix: `*UseCase`.

```java
public interface CreateOrderUseCase {
    Order create(CreateOrderCommand command);
}

@Service
@RequiredArgsConstructor
class CreateOrderService implements CreateOrderUseCase {   // package-private — hidden behind the port
    private final OrderRepository orderRepository;          // outbound port

    @Override
    @Transactional                                          // the use case is the unit of work
    public Order create(CreateOrderCommand command) { ... }
}
```

### Is the inbound interface worth it? (it's the one to question)

Outbound ports are **non-negotiable**: the port lives in `core`, the adapter implements it, so the compile-time arrow points *inward* and `core` never sees the technology. That interface *inverts a dependency* — it earns its place every time.

The inbound `*UseCase` interface is different. A controller already depends inward on `core`; both the interface and its implementation live in `core`, so the interface **inverts nothing**. Its only payoffs are a named, documented entry point and a mock seam — which makes it the one interface in this style worth a second thought. The deciding factor is **visibility**:

- **Keep the `*UseCase` interface when the implementing `@Service` is package-private.** A package-private service can't be referenced from the web adapter's package at all, so the public `*UseCase` *is* the core's published API — the seam is real and the compiler enforces it. (That's why `CreateOrderService` above has no `public` modifier.)
- **Skip it when the service would be `public` anyway.** A controller depending on a public `*UseCase` over a public service buys nothing but indirection — let the controller call the `@Service` directly.

Default to **package-private service + interface**; reach for **public service + no interface** when a use case is trivial and you don't care about hiding it. Either way, the use-case service is the **transaction boundary** — put `@Transactional` there. One use case is one unit of work, and the core service is the only place that sees the whole use case; a transaction opened inside a single repository call in an adapter can't wrap a use case that touches several ports.

## Outbound Ports (`core.port.out`)

Interfaces representing **what the core needs from the outside world**. Outbound adapters implement these and register them as Spring beans.

**Name ports in domain vocabulary, not tech vocabulary** — a reader of `core` should understand what a port is *for* without ever opening an adapter. `EmailSender.send(EmailMessage)` is a port; `EmailSender.sendSmtp(SmtpRequest)` is a leaky abstraction.

The port interface in `core` is a plain Java interface with **no Spring annotations** (no `@Component`, no `@Repository`). Annotations belong on the implementation in the adapter.

Suffix by role — five that pull their weight:

| Suffix       | Role                                              | Example                          |
| ------------ | ------------------------------------------------- | -------------------------------- |
| `-Repository`| Read+write persistence, CRUD-shaped               | `OrderRepository`                |
| `-Provider`  | Read-side data access, often non-CRUD             | `OrderProvider`, `QuoteProvider` |
| `-Sender`    | Delivery of a message to an external channel      | `EmailSender`, `SmsSender`       |
| `-Notifier`  | Fire-and-forget side-effect                       | `AlertNotifier`                  |
| `-Service`   | A capability the core delegates to infrastructure | `LlmService`, `EncryptionService`|

Pick the one that describes *what the port does for the core*, not what technology backs it.

## Adapters

### Naming

- **Technology-prefixed** when multiple implementations exist or the technology matters at the call site: `TelegramMessageSender`, `JpaOrderRepository`.
- **`*Impl` suffix** when there's one obvious default and naming it after the technology would just be noise: `OrderProviderImpl`, `EncryptionServiceImpl`.

Pick one and apply it uniformly — don't bikeshed.

### JPA adapter pattern

Keep `@Entity` classes **inside the adapter**, never in `core`:

```
jpa-adapter/
  src/main/java/com/example/jpa/
    order/
      OrderEntity.java          # @Entity, @Table, @Column — JPA-only
      OrderJpaRepository.java   # interface extends JpaRepository<OrderEntity, UUID>
      OrderRepositoryImpl.java  # @Repository — implements core's OrderRepository port
      OrderEntityMapper.java    # concrete class: OrderEntity ↔ Order (domain record)
```

`core` defines `OrderRepository` (the port) and `Order` (the domain record). The adapter implements the port by delegating to Spring Data and mapping at the boundary. `OrderEntityMapper` is a **concrete class**, not an interface — there's no seam to justify one.

### Inbound adapter (web)

```
web-adapter/
  src/main/java/com/example/web/
    order/
      OrderController.java      # @RestController — depends on CreateOrderUseCase (port.in)
      CreateOrderRequest.java   # request DTO — adapter-local, never seen by core
      OrderResponse.java        # response DTO — mapped from domain Order
      OrderWebMapper.java       # concrete class: Request/Response ↔ domain types
```

The controller builds `ResponseEntity` and handles HTTP concerns — none of that leaks into core.

## Registry pattern

Sometimes one outbound port has many implementations and you need to dispatch to the right one at runtime (e.g., send a message over whichever channel the user registered with). Put the registry itself in `core` as a `@Component` that takes a `List<SomePort>` in its constructor — Spring will inject every implementation across all adapters.

```java
@Component
public class MessageSenderRegistry {
    private final Map<ChannelType, MessageSender> byChannel;

    public MessageSenderRegistry(List<MessageSender> senders) {
        this.byChannel = senders.stream()
            .collect(Collectors.toMap(MessageSender::channel, s -> s));
    }

    public MessageSender get(ChannelType channel) {
        return Optional.ofNullable(byChannel.get(channel))
            .orElseThrow(() -> new IllegalStateException("no sender for " + channel));
    }
}

public interface MessageSender {
    ChannelType channel();            // each impl declares its key
    void send(ChatMessage message);
}
```

One port, many adapters, routed at runtime. No service locator, no framework magic — just `List<T>` injection and a lookup map.

## When to Create a New Port

Three signals, in order of urgency:

1. **An adapter wants to import another adapter.** Stop. Define a port in `core.port.out` describing the need. Implement it in the source adapter.
2. **`core` is reaching for JPA, a third-party SDK, `@RestController`, `ResponseEntity`, or similar.** Move the framework dependency out to an adapter and define a port for the capability `core` needs.
3. **A `@Service` in `core.service` has three or more framework-flavored dependencies.** It's probably doing infrastructure work that belongs behind a port.

## When NOT to Create an Interface

The anti-bloat rules. Each has a reason, not just a prohibition:

- **DDD tactical markers** — no `AggregateRoot`, `ValueObject`, `DomainEvent`, or base entity interfaces. Hexagonal's module discipline doesn't require DDD. A domain type is just a Java `record` (or a Lombok `@Builder` class for wide payloads). Markers add ceremony without enabling anything the compiler or tests care about.
- **CQRS handler splits** — don't split a `ReportUseCase` into a `CreateReportCommandHandler` + `GetReportQueryHandler` hierarchy with separate command/query types and a mediator. One `*UseCase` interface with a handful of methods, or two focused `*UseCase` interfaces if they truly have different callers. The command-vs-query distinction belongs in method naming, not in a parallel type system.
- **Speculative / single-call-site ports** — an interface with one implementation called from one place is pure indirection. Wait for a real second caller or a real need to swap before extracting an interface.
- **An inbound `*UseCase` over a service you're not hiding** — unlike an outbound port, it inverts no dependency. If the implementing `@Service` is `public`, the interface buys only indirection; let the controller call the service directly. It pays for itself only when the service is package-private and the interface is the core's published API (see *Inbound Ports* above).
- **Adapter-internal interfaces** — inside an adapter, call concrete classes directly. `OrderEntityMapper`, `StripeSignatureValidator`, a request parser — these are not ports and earn no seams. Add an interface only when you hit a concrete mocking pain point you can't solve with a real instance and test data.
- **Pure functions and value-like records** — `Money.add(Money)`, `DateRange.overlaps(DateRange)`. No port needed.
- **Spring's `ApplicationEventPublisher`** for in-process events — it's a standard mechanism. Tests can use `@RecordApplicationEvents`.

## Common Patterns

### Inbound flow

```
HTTP request → @RestController (web-adapter) → CreateOrderCommand → CreateOrderUseCase (port.in)
            → CreateOrderService (core.service) → OrderRepository.save (port.out)
            → OrderRepositoryImpl (jpa-adapter) → returns Order → response DTO
```

### Cross-adapter via core

The `web-adapter` needs to send a message via the `messaging-adapter`:

```
@RestController                              ← web-adapter
  → MessageSender (port.out, in core)        ← interface in core
  → KafkaMessageSender (@Component)          ← implementation in messaging-adapter
```

The web adapter never has `messaging-adapter` in its `pom.xml`. Spring's component scan from `app` finds the `KafkaMessageSender` and injects it.

### Composition root

The `app` module:
- Pulls in every adapter as a Maven dependency.
- Holds `@SpringBootApplication`.
- Owns `application.yml`, profile config, framework-level beans.
- Is the only place `main()` lives.
- Hosts integration tests (`@SpringBootTest` or a `BaseIntegrationTest` extending Testcontainers).

Every other module stays unaware of the full system and can be tested with a slice of the context.

## Testing

The test strategy falls straight out of the boundaries — and the way you test a core service is the concrete payoff that justifies its outbound ports:

- **Core services** — plain unit tests. Substitute **fake or mock outbound ports** (`OrderRepository`, `EmailSender`) so the use case runs with no database and no network. *This is what the outbound interface buys you.*
- **Outbound adapters** (JPA, SDK) — integration tests against the real technology: Testcontainers for the JPA adapter, a sandbox or WireMock for an HTTP SDK. You're testing the mapping and the query, so use the real thing.
- **Inbound adapters** (web) — `@WebMvcTest` with the `*UseCase` (or service) mocked. You're testing HTTP wiring, serialization, and status codes — not business logic.
- **ArchUnit test** — lives in `app`, runs in `verify`, sees the whole classpath.

This gives a one-line test for "should this be a port?": **will I fake it in a core unit test, or is there a genuine second implementation?** If neither, don't add the interface.

## Anti-Patterns

- **A "common" or "shared-utils" module** between adapters. A leaf-to-leaf dependency wearing a disguise. Truly shared domain logic belongs in `core`. Shared technical glue either duplicates per adapter or lives in a separate library outside the project.
- **Port interface in an adapter.** Ports describe what `core` needs — they belong in `core`. An adapter's own internal interface is fine, just don't call it a port.
- **`@Entity` on a `core` class.** Ties `core` to JPA. Keep entities in the JPA adapter and map to plain `core` records at the boundary.
- **`ResponseEntity`, `HttpServletRequest`, or `@RestController` anywhere in `core`.** Web lives in web-adapter.
- **A third-party SDK type on a `core` signature.** The SDK belongs to one adapter; the port's signature speaks domain vocabulary.
- **`@Component` / `@Service` on a port interface.** Annotations belong on implementations.
- **Anemic ports mirroring the implementation 1:1.** Ports should be expressed in the language the *core* speaks.
- **DDD marker interfaces** — `AggregateRoot`, `ValueObject`, `DomainEvent` — ceremony without payoff under this style.
- **CQRS handler hierarchies** that split one use case into separate `CommandHandler` + `QueryHandler` interfaces with a mediator.
- **Adapter-internal interfaces that exist to satisfy a reflex** rather than a real seam — mapper interfaces, single-impl "validator" interfaces, etc.
- **`@SpringBootApplication` in more than one module.** Only `app` should have it.
- **`ApplicationContextAware` or `@Lazy` to break a cycle.** Almost always a signal that a port is misplaced — fix the design, don't work around the framework.
