## Why

The test suite has ~1591 example-based tests that cover specific scenarios for CRUD, queries, indexes, transactions, and schema validation. These tests verify known inputs against known outputs, but they cannot explore the combinatorial space of possible inputs. An `$eq` filter on a string field works for the three hand-picked strings in the test — but does it hold for strings containing Unicode surrogates, empty strings, or strings that look like numbers? Does index consistency survive an arbitrary interleaving of create, update, and delete operations, not just the two sequences we happened to write?

Property-based testing closes this gap. Instead of asserting specific examples, it asserts invariants that must hold for any valid input, then generates hundreds of random inputs to try to falsify them. When a failure is found, the framework automatically shrinks the input to the smallest reproducing case. This is the standard technique for finding edge cases that human intuition misses.

The core abstractions — Schema encode/decode, where-clause filtering, sort ordering, index maintenance, CRUD semantics, transaction rollback — all have clear mathematical invariants that are straightforward to express as properties.

## What Changes

Add a `fast-check` dev dependency and a suite of property-based test files alongside the existing example-based tests. No production code changes. The new tests exercise existing public APIs with generated inputs, verifying invariants that the example-based tests implicitly assume but never prove universally.

Custom `Arbitrary` generators are introduced for the domain types: entities conforming to a given Schema, valid where clauses for a given entity shape, sort configurations, and sequences of CRUD operations. These generators form reusable infrastructure that future specs can build on.

## Capabilities

### New Capabilities

- **Schema round-trip property**: Verifies that any value passing Schema validation survives encode then decode without data loss, and that invalid values are always rejected (never silently corrupted).
- **Filter consistency property**: Verifies that query results are the exact subset of the collection matching the where clause — no false inclusions, no false exclusions.
- **Sort ordering property**: Verifies that sorted results satisfy the ordering invariant for every adjacent pair, and that sort is stable for equal elements.
- **Index consistency property**: Verifies that index-accelerated query results are identical to full-scan results after arbitrary sequences of mutations, and that index entries always match the actual data.
- **CRUD invariant properties**: Verifies create-then-findById round-trip, delete-removes-completely, and unique constraint enforcement under concurrent creates.
- **Transaction atomicity property**: Verifies that a failed transaction restores all collection states to their pre-transaction values, regardless of where in the operation sequence the failure occurs.
- **Generator infrastructure**: Reusable Arbitrary generators for entities, where clauses, and operation sequences, parameterized by Schema shape.

### Modified Capabilities

- None. All changes are additive test infrastructure. No production code is modified.

## Impact

- **Dependencies**: `fast-check` added as a dev dependency in the root `package.json`.
- **Test suite**: New property-based test files added under `packages/core/tests/`. The existing ~1591 tests are untouched.
- **CI time**: Property tests run 100 iterations per property by default. Expected to add 10-30 seconds to the test suite depending on generator complexity.
- **Production code**: No changes. Property tests consume the existing public API.
- **Breaking changes**: None. This is purely additive test infrastructure.
