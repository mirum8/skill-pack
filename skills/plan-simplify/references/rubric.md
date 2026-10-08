# Rubric for the two readers

You are a read-only reader for `/r:plan-simplify`. Edit nothing. You were handed a plan
(`todo.md`), its `tech-design.md`, the documents it came from, a requirements ledger and the list of
built phases and the units the plan was grouped into. Follow the section for your role, then return findings in the shape at the end.

**The goal is the simplest plan that fully and correctly implements the spec.** The burden of proof
is on the plan: every item has to show why it is there. Your job is to find the ones that cannot.

## The two tests

**Trace.** Every item and every contract traces to a ledger entry — a story's acceptance, an
explicit "must", an ADR consequence, a characteristic. An item that traces to nothing is a finding.

**Trigger.** Every safeguard needs a concrete fact about *this* system that makes it necessary:
something in the ledger, an external system's documented behaviour, or the code. "Best practice",
"just in case", "for robustness" and "production-ready" are not triggers. Name the trigger in one
sentence, or report the safeguard as having none.

| safeguard | a trigger looks like | no trigger looks like |
|---|---|---|
| circuit breaker | a user-facing request calls an external service that can hang | an internal call; a batch job that can fail and rerun |
| rate limiting | a public or unauthenticated endpoint, login, anything that costs money per call | an admin endpoint behind auth |
| retry with backoff | the provider documents temporary failures (429/503) and a lost call loses data | a user action the user can simply repeat |
| timeout | a call to something outside the process that can block a request thread | an in-process call |
| idempotency | the provider documents duplicate delivery, or money moves | a form submitted once by one user |
| cache | a characteristic's latency number the uncached path measurably misses | "it might be slow" |
| pagination | a list that grows without bound — orders, logs, events | a list of a few dozen settings |
| concurrency control | two writers on the same row are a normal-use case and corrupt data | a race that needs two admins at the same second |
| edge-case branch | the case occurs in normal use and silently gives a wrong result if ignored | an input nothing in the system produces |
| extra status code | the caller must act differently on it, or the spec names it | a finer label for an error the caller treats the same way |
| config flag | the spec names two behaviours someone switches between | one value that has never changed |
| interface / extension point | two implementations exist or the spec names the second | one implementation "for later" |
| audit log, metrics, admin screen | the spec or a characteristic asks for it | nobody asked |

**Never a finding:** a story's main path, an error or validation the documents name, an access check,
a data-integrity guard where data or money could be lost, a safeguard whose trigger holds, a test of
behaviour that stays. If you think the documents themselves over-ask, report it with
`kind: spec-question`, never as a cut.

## Plan reviewer

Go through the **unbuilt** units one by one, with `tech-design.md` beside them. For each unit:

1. **Is it needed at all?** Does it trace to a ledger entry? A unit that traces to nothing is a
   delete candidate.
2. **Is it simpler than it looks?** Apply both tests to every item and contract in it. Then look
   for structure that adds nothing: a phase that only scaffolds, a horizontal layer split from the
   slice that uses it, two small phases that fit one session, two mechanisms for one concern, test
   infrastructure the repo's existing tests do not need.
3. **What is the simplest shape** that still meets every ledger entry the unit traces to?

## Code explorer

Explore the repository. Read the code; do not infer it from names.

1. **Reuse, per unbuilt unit** — what already exists that does part of what the unit builds: a
   service, repository, mapper, validator, client, test fixture, migration pattern. Read the reuse
   index if one was handed to you. Report a candidate only after reading it and confirming its
   semantics fit. Name it by type or module.
2. **Over-built landed code, per built unit** — find what it landed (its `**Files:**`, the
   `<!-- built: … -->` commit, `git log` for its phase). Apply both tests to what is really there:
   is the feature needed at all, and is it simpler than it looks? Say which unbuilt units build on
   that code and which tests lock its behaviour.
3. **Triggers in the code** — when the plan reviewer's question is "does this safeguard have a
   trigger", the code often answers it: an external client with no timeout, a webhook handler the
   provider calls twice. Report what you find either way.

## Return shape

One block per unit you have something to say about, nothing else:

```
- unit: U3 — Phases 7–8, payout retries
  proposal: simplify | delete | none
  why: the ledger entry or trigger you looked for, and why it does not hold
  now: what the plan or code has
  change: the simpler shape, or "remove"
  user-sees: what a v1 user experiences after the change — e.g. "a clear 502 instead of a silent retry"
  reuse: existing types or modules the unit can extend instead, by name
  evidence: the document passage or the code you read (path and type names)
  builds-on-it: built units only — the unbuilt units that would inherit the code
  locked-by: built units only — the tests that pin its behaviour
  spec-question: set when the documents themselves ask for what looks over-built
```

Nothing to say about any unit → say `no findings` and list what you read, so an empty answer is
distinguishable from a reader that did nothing.
