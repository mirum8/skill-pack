# Bug Patterns — Security

Real-world production bug patterns — things that actually break, not theoretical concerns. Hunter focus: **Injection & Untrusted Input, Authentication & Authorization, Secrets & Credentials, Sensitive Data Exposure.**

## The bar

Report only what **this change newly introduces**, and only what you have **high confidence is actually exploitable** — a concrete path from something an attacker controls to something they shouldn't reach. Pre-existing weaknesses the diff merely moves past are somebody else's audit. A clean result is a real result: if the change touches none of these shapes, say so.

Name the attacker's input in every finding. If you cannot say what an attacker sends and what they get, you have a hardening suggestion, not a vulnerability — drop it.

## Injection & Untrusted Input

- **SQL / JPQL injection**: user input concatenated into a query string instead of bound as a parameter. Telltale signs: `"... WHERE name = '" + x + "'"`, `String.format` building SQL, `@Query` with a concatenated fragment, `createNativeQuery(sql + userInput)`, a dynamic `ORDER BY` / table name taken from a request field. Parameterized queries (`?`, `:name`, `setParameter`) are fine; a sort column validated against a fixed allow-list is fine. The fix is binding, or an allow-list where binding cannot apply.
- **Command injection**: user-controlled data reaching a shell or process launch. Telltale signs: `Runtime.exec("sh -c " + x)`, `ProcessBuilder` with a single string argument built by concatenation, an interpolated filename in a shell pipeline. Passing the arguments as separate array elements with no shell is fine.
- **Path traversal**: a user-controlled path segment used to open, write, or serve a file. Telltale signs: request parameter or uploaded filename joined onto a base directory, `new File(base, userInput)`, `Paths.get(dir, name)` with no canonicalization, `../` never rejected. The fix is to resolve the path and verify it still sits under the base directory, or to key the file by a server-side id instead.
- **XSS / unescaped output**: attacker-controlled text rendered as markup. Telltale signs: `th:utext` on anything that came from a user, `innerHTML` / `outerHTML` / `insertAdjacentHTML` assignment, `v-html`, `dangerouslySetInnerHTML`, building HTML by string concatenation in a controller, a URL from user input landing in `href`/`src` without a scheme check (`javascript:`). Auto-escaped `th:text` and framework-escaped interpolation are fine.
- **Template / expression injection**: user input reaching a template engine or expression evaluator as *template source* rather than as data — a SpEL expression, an EL fragment, `Velocity.evaluate(userString)`, a Thymeleaf fragment name taken from a request parameter.
- **Unsafe deserialization**: untrusted bytes fed to a deserializer that can instantiate arbitrary types. Telltale signs: Java `ObjectInputStream` on request data, Jackson with default typing (`enableDefaultTyping`, `@JsonTypeInfo(use = CLASS)`), YAML loaded with a constructor that resolves arbitrary classes. Plain JSON binding to a fixed DTO is fine.
- **XXE**: an XML parser built without disabling external entities and DTDs, then handed untrusted XML. Telltale signs: `DocumentBuilderFactory` / `SAXParserFactory` / `XMLInputFactory` constructed with no `setFeature` hardening.
- **Missing validation at a trust boundary**: a new endpoint, message consumer, or webhook that takes a field straight into a query, a file operation, an outbound URL, or an authorization decision without checking type, range, or ownership. Only flag when the unvalidated value actually reaches one of those sinks — a missing `@Size` on a display name is not this.
- **SSRF**: a user-supplied value deciding the **host or scheme** of an outbound request. A user-controlled path or query string appended to a fixed base URL is not SSRF.

## Authentication & Authorization

- **Missing auth check on a new endpoint**: a controller mapping added without the annotation, filter rule, or manual check its siblings carry. Telltale signs: a new `@GetMapping`/`@PostMapping` in a controller whose other methods have `@PreAuthorize`, a path added to a `permitAll()` matcher, an admin action reachable without a role check. Compare against the neighbouring endpoints — the deviation is the finding.
- **IDOR**: a resource fetched by an id taken from the request without verifying the caller owns it. Telltale signs: `findById(request.getId())` with no tenant/owner predicate, a sequential id in a path variable, an update that trusts the id in the body. The fix is to scope the query by the authenticated principal.
- **Privilege escalation through mass assignment**: a request DTO bound straight onto an entity where it can set a role, owner, price, or status field the caller should not control.
- **Broken authorization logic**: a check that passes when it should fail — an `||` that should be `&&`, a role compared with `contains` on a substring, an early `return true` on an unexpected input, a check applied to the wrong subject.
- **Session and CSRF handling**: a session id not rotated after login, a session-bearing cookie without `HttpOnly` / `Secure` / `SameSite` on a new cookie, CSRF protection disabled or a state-changing endpoint moved to `GET`.
- **Auth-relevant rate limiting**: a **new or newly-unprotected** credential-testing surface — login, password reset, OTP or token issue, invite redemption — with no attempt limit, lockout, or backoff. This is the one throughput concern this hunter owns, because the impact is credential compromise, not load. Rate limiting for capacity reasons is not this; see below.
- **Missing verification on a security-relevant token**: a signed token accepted without checking signature, expiry, audience, or issuer; a password-reset or email-confirmation token compared non-atomically, reusable after use, or guessable.

## Secrets & Credentials

- **Hardcoded credentials in source**: a password, API key, token, connection string, or private key literal committed in code, a template, or a checked-in config file. Telltale signs: a long opaque string beside a name like `key`, `token`, `secret`, `password`; a default admin password in a seeder; a real key in a test resource. This is a finding wherever it lands in the repository — the exclusion elsewhere is about secrets *at rest on a deployed host*, not about literals in the tree.
- **Weak or misused cryptography**: MD5/SHA-1 for a password or signature, a raw digest instead of a KDF (bcrypt/scrypt/Argon2/PBKDF2) for password storage, ECB mode, a fixed IV or salt, a key derived from a constant.
- **Predictable randomness in a security context**: `Random`, `Math.random()`, `UUID` derived from a timestamp, or a counter used to generate a token, reset code, session id, or nonce. `SecureRandom` is the fix; `Random` for non-security purposes is fine.
- **Certificate or host verification disabled**: a trust-all `TrustManager`, `HostnameVerifier` returning true, `verify = false` on an HTTP client, TLS verification switched off "for the test environment" in shared code.

## Sensitive Data Exposure

- **Secrets or PII in logs**: a token, password, full card or document number, or auth header written to a log line — including via a `toString()` on an entity that carries them, or a request/response body logged wholesale on a new endpoint.
- **Over-exposed API response**: a new endpoint or serializer returning fields the caller should not see — password hashes, internal ids or flags, another user's data, a full entity where a projection was intended. Telltale signs: an entity returned directly instead of a DTO, a `@JsonIgnore` dropped, a list endpoint that stopped filtering by tenant.
- **Error output leaking internals**: a stack trace, SQL fragment, file path, or upstream error body returned to the client; a new `@ExceptionHandler` that echoes `e.getMessage()` from a layer that embeds query text.
- **Enumeration through differing responses**: login, reset, or lookup that answers differently for "no such user" and "wrong password" — status, message, or timing.

## What NOT to report

This is an exploitability review, not a hardening audit.

- **Denial of service, resource exhaustion, and capacity rate limiting** — unbounded fetches, missing pagination, OOM, regex backtracking, thread-pool starvation. Real risks, owned by the `runtime-and-failures` hunter and `/r:code-scan`. The narrow exception is the credential-testing surface named above.
- **Pre-existing concerns the change did not introduce.** If the diff moves a line past an old weakness without changing its exposure, it is out of scope here.
- **Missing hardening with no concrete vulnerability** — an absent security header, a permissive CORS entry nothing sensitive sits behind, a "should also validate this" with no reachable sink. Code is not expected to implement every best practice.
- **Theoretical timing attacks and races** unless you can state the concrete window and what it wins.
- **Outdated third-party libraries and their CVEs** — a dependency-scanning job's work, not a diff review's.
- **Findings in documentation, markdown, or comments**, and **test-only files** — a credential in a test *resource* still counts, but test code exercising a weak path does not.
- **Secrets stored on a deployed host** (env files, mounted config, key material on disk) — handled outside this review. Literals in the source tree are in scope; see above.
