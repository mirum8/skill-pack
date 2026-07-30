# Bug Patterns — Logic & Flow

Real-world production bug patterns — things that actually break, not theoretical concerns. Hunter focus: **Wrong Business Logic, Implementation Mistakes, Broken Flows.**

## Wrong Business Logic

- **Wrong calculation**: arithmetic that produces incorrect results (wrong operator, wrong operand order, integer overflow, floating-point comparison with `==`)
- **Inverted condition**: `if` checks the opposite of what's needed — e.g., `if (isValid)` when it should be `if (!isValid)`
- **Off-by-one**: loop bounds, array indices, pagination offsets, date range boundaries
- **Wrong comparator**: sorting/filtering that uses wrong field, wrong direction, or breaks comparator contract (not transitive)
- **Missing state transition**: state machine that skips required intermediate states or allows illegal transitions
- **Wrong aggregation**: sum/count/avg computed over wrong dataset, missing grouping, counting duplicates
- **Boundary errors**: edge cases at 0, empty collections, null inputs, max values not handled

## Implementation Mistakes

- **Method does opposite of name**: `enable()` that disables, `add()` that removes, `isActive()` that returns inactive status
- **Copy-paste with wrong variable**: duplicated block where one reference wasn't updated — still uses the original variable
- **Swapped arguments**: `transfer(to, from)` instead of `transfer(from, to)`, especially with same-type parameters
- **Returning wrong value**: method computes correct result but returns a different variable, or returns the input unchanged
- **Updating wrong field**: setter/builder modifies a different field than intended
- **Missing negation**: `!` missing in boolean expression, causing opposite behavior
- **Wrong method called**: `list.remove(index)` vs `list.remove(object)`, `equals()` vs `==`, `map.get()` vs `map.getOrDefault()`
- **Incorrect string operations**: wrong `substring()` indices, `replace()` vs `replaceAll()`, missing `trim()`

## Broken Flows

- **Unreachable code**: code after unconditional `return`, `throw`, `break`, or `continue`
- **Dead branches**: conditions that are always true/false due to type constraints, previous checks, or logical impossibility
- **Early return skipping cleanup**: return/throw before `finally`-like cleanup in languages without `try-finally`, or before closing resources
- **Missing break in switch**: fall-through in switch/case that wasn't intentional
- **Infinite loop**: loop condition that can never become false, missing increment, break condition unreachable
- **Wrong exception handling order**: catching parent exception before child — specific handler never reached
- **Incomplete if-else chains**: missing `else` branch that should handle a valid case
