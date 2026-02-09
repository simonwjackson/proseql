## Context

This is a TypeScript in-memory database library that persists to human-readable plain text files (JSON/YAML/MessagePack). Its core value proposition is type-safe queries and relationship population over files the user owns and can read directly.

The current implementation uses:
- **Zod** for one-way schema validation
- **AsyncIterable** for query results
- **Hand-rolled Result<T, E>** tagged union errors for CRUD
- **Mutable arrays behind closures** for in-memory state
- **Manual debounce/watcher management** for persistence
- **A monolithic 130-line query closure** in `database.ts`

The type system is at its limit: 792 lines of conditional types, 5+ `as unknown as` casts, skipped type tests. Adding features (aggregations, transactions, cursor pagination) on this foundation would compound these problems.

The migration replaces all runtime layers with Effect equivalents while preserving the same user-facing semantics: define a config, get a typed database, query with filters/population/selection, persist to files.

## Goals / Non-Goals

**Goals:**
- Replace Zod with Effect Schema for bidirectional encode/decode
- Replace AsyncIterable with Effect Stream for composable query pipelines
- Replace hand-rolled Result with Effect's typed error channel
- Replace mutable array closures with Ref for atomic state
- Replace manual persistence wiring with Effect Service/Layer
- Simplify the type system by leveraging pipe composition instead of deeply nested conditional types
- Maintain the same functional capabilities: CRUD, filtering, sorting, selection, population, persistence
- Maintain the project identity: plain text files are the database

**Non-Goals:**
- Adding new features (aggregations, indexing, etc.) — those are separate changes
- Changing the on-disk file format — existing JSON/YAML files remain compatible
- Supporting incremental/mixed adoption — this is a clean cut from Zod to Effect
- Building an Effect-native consumer API that requires deep Effect knowledge — provide `runSync`/`runPromise` escape hatches for consumers who don't use Effect

## Decisions

### 1. Schema: Effect Schema with `Schema.Struct` (not `Schema.Class`)

**Choice**: Use `Schema.Struct` for entity schemas, not `Schema.Class`.

**Rationale**: The library's data comes from plain text files. Users define the shape of their data — they don't need class instances with methods. `Schema.Struct` gives bidirectional encode/decode without the overhead of class instantiation. The current Zod schemas are structural (not class-based), so this is a direct replacement.

**Alternative considered**: `Schema.Class` — adds Equal trait, custom methods, but introduces class instantiation on every decode. Unnecessary for a data store where entities are plain objects.

```typescript
// Current (Zod)
const UserSchema = z.object({ id: z.string(), name: z.string(), age: z.number() })

// New (Effect Schema)
const UserSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.NonEmptyString,
  age: Schema.Number,
})
```

The `Schema<Type, Encoded, Context>` triple gives us:
- `Type`: the runtime type (what queries return)
- `Encoded`: the on-disk type (what files contain)
- `Context`: dependencies needed for decode/encode (typically `never`)

This directly solves the persistence round-trip problem — `Schema.decodeUnknown` for loading files, `Schema.encode` for saving.

### 2. Query pipeline: Effect Stream with composable stages

**Choice**: Each query stage (filter, populate, sort, select, paginate) is an independent `Stream` combinator.

**Rationale**: The current monolith (`database.ts:240-387`) does filter → populate → sort → offset/limit → select in one closure. Adding aggregation or cursor pagination means branching inside this closure. With Stream, each stage is a separate pipe step — new capabilities plug in without modifying existing stages.

```typescript
// Composable pipeline
const query = (config: QueryConfig) =>
  Ref.get(collectionRef).pipe(
    Effect.map(Stream.fromIterable),
    Effect.flatMap(stream =>
      stream.pipe(
        applyFilter(config.where),       // Stream<T> → Stream<T>
        applyPopulate(config.populate),   // Stream<T> → Stream<T & Populated>
        applySort(config.sort),           // Stream<T> → Stream<T>
        applyPaginate(config),            // Stream<T> → Stream<T>
        applySelect(config.select),       // Stream<T> → Stream<Selected>
      )
    )
  )
```

**Alternative considered**: Keep AsyncIterable with generator composition. This avoids the Effect dependency for queries but doesn't give typed errors, backpressure, or resource management. The query path currently has NO error model — Stream's error channel fixes this.

### 3. State: `Ref<ReadonlyMap<string, T>>` per collection

**Choice**: Each collection's data lives in a `Ref` holding an immutable `ReadonlyMap<string, T>` keyed by entity ID.

**Rationale**:
- `Ref` provides atomic read/write — no more `getCollectionData()`/`setCollectionData()` closure pairs
- `ReadonlyMap` gives O(1) ID lookups (the current array storage is O(n) for `findById`)
- Immutable updates prevent mutation bugs and enable snapshot-based transactions later
- Change detection is trivial: compare references

**Alternative considered**: `SynchronizedRef` — adds serialized effectful updates but costs more. Regular `Ref` with `Ref.update` is sufficient since we're single-process.

**Alternative considered**: Keep arrays. Arrays are simpler but O(n) for ID lookup, mutation-prone, and don't compose with Effect's atomic update model.

### 4. Errors: Tagged errors extending `Data.TaggedError`

**Choice**: Each error type extends `Data.TaggedError` from Effect. The error channel (`E` in `Effect<A, E, R>`) carries a union of possible errors.

**Rationale**: Replaces the hand-rolled `Result<T, CrudError>` pattern and the tagged union in `crud-errors.ts`. Effect's error channel is:
- Automatically propagated (no manual `isErr()` checking)
- Composable (errors from sub-operations merge into the parent)
- Typed per-operation (create can fail with `ValidationError | DuplicateKeyError`, query can fail with `PopulationError | CollectionNotFoundError`)

```typescript
class NotFoundError extends Data.TaggedError("NotFoundError")<{
  readonly collection: string
  readonly id: string
}> {}

class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly issues: ReadonlyArray<Schema.ParseIssue>
}> {}

// Query errors (NEW — currently silent)
class DanglingReferenceError extends Data.TaggedError("DanglingReferenceError")<{
  readonly collection: string
  readonly field: string
  readonly targetId: string
}> {}
```

### 5. Persistence: Effect Services with Layer composition

**Choice**: `StorageAdapter` and `SerializerRegistry` become Effect Services. The database factory takes a `Layer` for its dependencies.

**Rationale**: The current `PersistenceContext` bundles adapter + serializers + debounce config into a manual struct passed through constructors. Effect Layers provide:
- Compile-time dependency checking (missing services = type error)
- Testability (swap real filesystem for in-memory layer)
- Composition (combine storage + serialization + config into one layer)

```typescript
// Service definitions
class StorageAdapter extends Context.Tag("StorageAdapter")<
  StorageAdapter,
  { read: (path: string) => Effect<string, StorageError>; ... }
>() {}

class SerializerRegistry extends Context.Tag("SerializerRegistry")<
  SerializerRegistry,
  { serialize: (data: unknown, ext: string) => Effect<string, SerializationError>; ... }
>() {}

// Layer composition
const PersistenceLayer = Layer.merge(
  NodeStorageLayer,
  JsonSerializerLayer,
)

// Database creation
const db = createDatabase(config).pipe(
  Effect.provide(PersistenceLayer),
  Effect.runPromise,
)
```

### 6. Consumer API: Effect-native with `runPromise` convenience

**Choice**: The core API returns `Effect` and `Stream`. A thin convenience layer provides `runPromise`/`runSync` wrappers for consumers who don't use Effect.

**Rationale**: The library is Effect-native internally. Forcing consumers to learn Effect is a barrier. Providing both preserves the current developer experience while allowing Effect-native consumers to compose naturally.

```typescript
// Effect-native (for Effect consumers)
const users = db.users.query({ where: { age: { $gt: 18 } } })
// users: Stream<User, QueryError, DatabaseEnv>

// Convenience (for non-Effect consumers)
const users = await db.users.query({ where: { age: { $gt: 18 } } }).runPromise
// users: User[]
```

### 7. Migration order: bottom-up by module

**Choice**: Migrate in this order:
1. Errors (standalone, no dependencies)
2. Schema definitions (standalone)
3. State management / Ref (depends on schemas)
4. Storage services (standalone)
5. Query operations (filter, sort, select — each independently, using Stream)
6. Population (depends on state + query)
7. CRUD operations (depends on state + schema + errors)
8. Database factory (depends on everything above)
9. Tests (rewrite alongside each module)

**Rationale**: Bottom-up minimizes the "everything is broken at once" phase. Each module can be migrated, tested, and verified independently. The factory is last because it wires everything together.

## Risks / Trade-offs

**[Effect learning curve]** → Consumers unfamiliar with Effect face a steeper onboarding. Mitigation: provide `runPromise` convenience API and examples that don't require Effect knowledge.

**[Bundle size increase]** → Effect is not small (~50KB+ min+gzip for core). Mitigation: tree-shaking helps; for a server-side/CLI database library, bundle size is less critical than for a browser widget.

**[Zod ecosystem loss]** → Zod has broader ecosystem integration (form libraries, API validators, etc.). Mitigation: Effect Schema provides `Schema.equivalence` and can interop with JSON Schema. For consumers who need Zod, a thin adapter layer could convert schemas.

**[All-or-nothing migration]** → No incremental path. Everything changes at once. Mitigation: the bottom-up migration order keeps individual PRs testable. The existing test suite (24 files) provides a behavioral specification to verify against.

**[Stream overhead for simple queries]** → `Stream.fromIterable` then `Stream.runCollect` for a simple filter is more ceremony than `array.filter()`. Mitigation: for collections under ~1000 items (the typical case for file-based databases), the overhead is negligible. The composability benefit pays off when features like aggregation and cursor pagination are added.

**[ReadonlyMap vs Array on-disk format]** → Internal state is `ReadonlyMap<string, T>` but files store `{ id: {...}, id: {...} }` objects. Mitigation: the serialization layer already handles this transform (arrayToObject/objectToArray in transforms.ts). With Effect Schema encode/decode, this becomes a schema-level concern.

## Open Questions

1. **Should `findById` be a first-class method?** With `ReadonlyMap` state, it's O(1). It could be `db.users.findById("abc")` returning `Effect<User | null, NotFoundError>`. This is the most common read operation and currently requires a full query.

2. **Should the convenience API (`runPromise` wrappers) live in the core package or a separate `@db/compat` package?** Separate package keeps the core pure-Effect. Same package reduces friction.

3. **How should relationship definitions interact with Effect Schema?** Currently relationships are config-level (`{ type: "ref", target: "companies" }`). Should they be expressible in the schema itself (e.g., `Schema.Ref("companies")`)? This would make the schema the single source of truth, but adds complexity to the schema layer.
