# Property-Based Testing — Design

## Architecture

### New Modules

**`core/tests/property/generators.ts`** — Custom `Arbitrary` generators for the domain types. `entityArbitrary(schema)` generates valid entities from an Effect Schema definition. `whereClauseArbitrary(schema)` generates valid where clauses by inspecting the schema's field types and selecting appropriate operators (`$eq`, `$gt`, `$lt`, `$in`, etc.) with values of the correct type. `operationSequenceArbitrary(schema)` generates sequences of `{ op: "create" | "update" | "delete", payload }` objects for stateful testing. `sortConfigArbitrary(schema)` generates valid sort configurations (field name + direction) from schema fields.

**`core/tests/property/schema-roundtrip.test.ts`** — Property tests for Schema encode/decode invariants. Tests that `decode(encode(value))` is deeply equal to `value` for any valid entity, and that `decode` rejects values not matching the Schema.

**`core/tests/property/filter-consistency.test.ts`** — Property tests for filter correctness. Seeds a collection with arbitrary entities, runs a query with an arbitrary where clause, then manually checks every entity against the where clause to verify the result is the exact matching subset.

**`core/tests/property/sort-ordering.test.ts`** — Property tests for sort invariants. Seeds a collection with arbitrary entities, runs a sorted query, then checks the ordering invariant for every adjacent pair. Also tests stability by verifying consistent ordering of equal elements.

**`core/tests/property/index-consistency.test.ts`** — Property tests for index correctness. Creates a collection with indexes, applies an arbitrary sequence of create/update/delete operations, then verifies that index-accelerated queries produce identical results to full-scan queries, and that all index entries map to existing entities.

**`core/tests/property/crud-invariants.test.ts`** — Property tests for CRUD semantics. Tests create-then-findById round-trip, delete-removes-completely, and unique constraint enforcement under arbitrary inputs.

**`core/tests/property/transaction-atomicity.test.ts`** — Property tests for transaction rollback. Runs an arbitrary operation sequence inside a transaction, forces failure at an arbitrary point, then verifies all collection states match the pre-transaction snapshot.

## Key Decisions

### fast-check as the framework

`fast-check` is the most mature property-based testing library in the JavaScript ecosystem. It integrates with any test runner — including `bun test` — since it doesn't require special test hooks; you call `fc.assert(fc.property(...))` inside a normal `test()` block. It provides built-in shrinking, reproducible seeds via `seed`/`path` reporting, and a rich combinator API for building custom generators. No alternative offers comparable maturity.

### Custom Arbitrary generators for domain types

The built-in `fc.record` and `fc.string` generators produce structurally valid JavaScript objects, but they don't know about Effect Schema constraints, proseql where clause grammar, or CRUD operation semantics. Custom generators are necessary to produce inputs that are valid enough to exercise the code paths we care about — you can't test filter consistency if the where clause references fields that don't exist in the schema. The generators live in a shared `generators.ts` module so all property test files reuse them.

### Test organization: separate property test files alongside example tests

Property tests live in `packages/core/tests/property/` rather than being mixed into the existing test files. This keeps property tests — which are slower and have different failure modes (shrunk counterexamples) — clearly separated from the fast, deterministic example-based tests. Both are discovered by `bun test packages/core/tests/` since bun recurses into subdirectories.

### Number of runs per property: 100 default, configurable

100 runs per property balances coverage against CI speed. `fast-check` uses `numRuns` to control this. We set 100 as the default via a shared constant in `generators.ts`. For local exploration, developers can override via `FC_NUM_RUNS` environment variable or per-property `numRuns` option. 100 runs across ~20 properties adds roughly 10-30 seconds.

### Generator strategy for where clauses

The where clause generator inspects the schema to determine which fields exist and their types. For each field, it selects a random operator that is valid for that type: numeric fields get `$eq`, `$gt`, `$gte`, `$lt`, `$lte`, `$ne`, `$in`; string fields get `$eq`, `$ne`, `$in`, `$contains`, `$startsWith`, `$endsWith`; boolean fields get `$eq`, `$ne`. Values are generated from the same type as the field. The generator produces both single-field and multi-field where clauses, and occasionally produces empty where clauses to test the "return all" path.

## File Layout

```
packages/core/
  tests/
    property/
      generators.ts                    (new — entityArbitrary, whereClauseArbitrary, operationSequenceArbitrary, sortConfigArbitrary)
      schema-roundtrip.test.ts         (new — Schema encode/decode properties)
      filter-consistency.test.ts       (new — filter subset and exclusion properties)
      sort-ordering.test.ts            (new — sort invariant and stability properties)
      index-consistency.test.ts        (new — index vs full-scan agreement properties)
      crud-invariants.test.ts          (new — create/find, delete, unique constraint properties)
      transaction-atomicity.test.ts    (new — rollback restores state properties)
```
