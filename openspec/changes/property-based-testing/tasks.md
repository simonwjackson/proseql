## 1. Dependencies

- [x] 1.1 Add `fast-check` as a dev dependency in the root `package.json` and run `bun install`
- [x] 1.2 Verify `fast-check` imports resolve correctly in a trivial test file under `packages/core/tests/`

## 2. Generator Infrastructure

- [x] 2.1 Create `packages/core/tests/property/generators.ts` with shared constants: `DEFAULT_NUM_RUNS = 100`, helper to read `FC_NUM_RUNS` env override
- [x] 2.2 Implement `entityArbitrary(schema)`: given an Effect Schema, produce an `fc.Arbitrary` that generates valid entities with an auto-generated `id` field and fields matching the schema's types (string, number, boolean, optional, arrays)
- [x] 2.3 Implement `whereClauseArbitrary(schema)`: inspect schema fields and types, generate valid where clauses with type-appropriate operators (`$eq`, `$gt`, `$lt`, `$in`, `$contains`, `$startsWith`, etc.), including empty where clauses
- [x] 2.4 Implement `sortConfigArbitrary(schema)`: generate valid sort configurations by picking a field name from the schema and a direction (`asc` or `desc`)
- [ ] 2.5 Implement `operationSequenceArbitrary(schema)`: generate arrays of `{ op: "create" | "update" | "delete", payload }` objects with valid entities and IDs for update/delete referencing previously created IDs
- [ ] 2.6 Write unit tests for the generators themselves: verify generated entities pass Schema decode, verify generated where clauses have valid structure

## 3. Schema Round-Trip Properties

- [ ] 3.1 Create `packages/core/tests/property/schema-roundtrip.test.ts`
- [ ] 3.2 Property: any value produced by `entityArbitrary` survives `Schema.encode` then `Schema.decode` and is deeply equal to the original
- [ ] 3.3 Property: a randomly mutated entity (wrong field types, missing required fields) is rejected by `Schema.decode` with a validation error, never silently accepted

## 4. Filter Consistency Properties

- [ ] 4.1 Create `packages/core/tests/property/filter-consistency.test.ts`
- [ ] 4.2 Property: seed a collection with arbitrary entities, query with an arbitrary where clause, then manually evaluate the where clause against every entity — the query result is the exact matching subset (no false inclusions, no false exclusions)
- [ ] 4.3 Property: query with an empty where clause returns all entities in the collection
- [ ] 4.4 Implement a reference `matchesWhere(entity, whereClause)` function that evaluates where clauses in plain JS for use as the test oracle

## 5. Sort Ordering Properties

- [ ] 5.1 Create `packages/core/tests/property/sort-ordering.test.ts`
- [ ] 5.2 Property: for any collection and sort configuration, every adjacent pair `(a, b)` in the sorted result satisfies `a[field] <= b[field]` (asc) or `a[field] >= b[field]` (desc)
- [ ] 5.3 Property: entities with duplicate sort key values maintain consistent relative ordering across repeated runs with the same seed (sort stability)

## 6. Index Consistency Properties

- [ ] 6.1 Create `packages/core/tests/property/index-consistency.test.ts`
- [ ] 6.2 Property: create a collection with indexes, apply an arbitrary operation sequence, then run a query on the indexed field — the index-accelerated result is identical to a full-scan result (same entities, same order)
- [ ] 6.3 Property: after an arbitrary operation sequence, every entity in the collection appears in exactly the correct index buckets, and no index bucket contains IDs of non-existent entities

## 7. CRUD Invariant Properties

- [ ] 7.1 Create `packages/core/tests/property/crud-invariants.test.ts`
- [ ] 7.2 Property: for any valid entity, `create` then `findById` returns a value deeply equal to the created entity
- [ ] 7.3 Property: for any existing entity, `delete` then `findById` fails with `NotFoundError`, and `query` does not include the entity
- [ ] 7.4 Property: given a unique constraint on a field, creating multiple entities with the same unique value results in exactly one success and the rest failing with `UniqueConstraintError`

## 8. Transaction Atomicity Properties

- [ ] 8.1 Create `packages/core/tests/property/transaction-atomicity.test.ts`
- [ ] 8.2 Property: snapshot collection state before a transaction, execute an arbitrary operation sequence inside the transaction, force failure at a random point, verify all collection states are identical to the pre-transaction snapshot
- [ ] 8.3 Property: a transaction that completes without failure applies all mutations (post-transaction state reflects every operation in the sequence)

## 9. Cleanup

- [ ] 9.1 Run full test suite (`bun test`) to verify no regressions in the existing ~1591 tests
- [ ] 9.2 Run type check (`bunx tsc --noEmit`) to verify no type errors
- [ ] 9.3 Run lint (`biome check .`) to verify property test files pass lint
