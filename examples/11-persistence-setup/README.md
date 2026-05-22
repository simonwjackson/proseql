# Persistence Setup

Demonstrates three ways to wire Node file persistence in ProseQL, ordered from simplest to most configurable. The runnable example uses the source-oriented document-source config shape.

## Source-oriented config

Collections define schemas, relationships, indexes, hooks, migrations, and identity policy. Sources define where persistent documents live.

```typescript
const config = {
  collections: {
    users: {
      schema: UserPayloadSchema,
      id: { kind: "derivedFromKey", field: "id" },
      relationships: {},
    },
    posts: {
      schema: PostPayloadSchema,
      id: { kind: "derivedFromKey", field: "id" },
      relationships: {
        author: { type: "ref", target: "users", foreignKey: "authorId" },
      },
    },
  },
  sources: [
    {
      id: "content",
      kind: "documents",
      root: "./data/document-source",
      include: "**/*.yaml",
      format: "yaml",
      collections: "all",
      outbox: "generated.yaml",
    },
  ],
} as const
```

A matching YAML file can contain multiple collection sections:

```yaml
users:
  alice:
    name: Alice Johnson
    email: alice@example.com
    age: 28

posts:
  intro:
    title: Getting Started with Effect
    content: Effect is a powerful library for TypeScript...
    authorId: alice
```

With `id: { kind: "derivedFromKey", field: "id" }`, the object key is the runtime `id`; persisted payloads do not include a physical `id` field.

## Approaches

### A. `createNodeDatabase()` -- zero-config convenience

Codecs are inferred from source formats and file extensions. The returned Effect only requires `Scope`; storage and serialization are provided internally.

```typescript
const db = yield* createNodeDatabase(config, initialData, {
  writeDebounce: 50,
})
```

This is the recommended starting point for most projects.

### B. `makeNodePersistenceLayer()` -- explicit layer

Builds a `Layer` from your config (same inference logic), which you then `Effect.provide` yourself. Useful when you want to compose the persistence layer with other layers or pass extra codecs.

```typescript
const PersistenceLayer = makeNodePersistenceLayer(config)

const runnable = program.pipe(
  Effect.provide(PersistenceLayer),
  Effect.scoped,
)
```

### C. Manual `Layer.merge()` -- full control

Wire `NodeStorageLayer` and `makeSerializerLayer([...])` by hand. Choose this when you need custom codec options, plugin codecs, or a non-Node storage adapter.

```typescript
const ManualLayer = Layer.merge(
  NodeStorageLayer,
  makeSerializerLayer([yamlCodec()]),
)
```

## What the example does

1. Creates two collections (`users` and `posts`) backed by one YAML document source.
2. Inserts sample records -- each mutation triggers a debounced source save.
3. Runs a query through the normal collection API.
4. Flushes pending writes and prints the outbox path.

Existing records keep origin-file attribution, so updates and deletes rewrite the file where a record was loaded. Newly-created records have no origin and are written to the configured outbox. `flush()` is the durability boundary when you need persistence failures surfaced before exit.

Document sources are strict by default: duplicate `(collection, id)` records and unknown top-level collection keys fail database load. Use `unknownCollections: "preserve"` only when non-ProseQL top-level data must survive rewrites. YAML comments and exact formatting are not preserved after writes.

## Running

```bash
bun run examples/11-persistence-setup/index.ts
```

Output is written to `./data/document-source/generated.yaml`.
