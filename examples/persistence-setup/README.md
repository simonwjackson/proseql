# Persistence Setup

Demonstrates three ways to wire file persistence in ProseQL, ordered from
simplest to most configurable.

## Approaches

### A. `createNodeDatabase()` -- zero-config convenience

Codecs are inferred from the `file` extensions in your config. The returned
Effect only requires `Scope`; storage and serialization are provided internally.

```typescript
const db = yield* createNodeDatabase(config, initialData, {
  writeDebounce: 50,
})
```

This is the recommended starting point for most projects.

### B. `makeNodePersistenceLayer()` -- explicit layer

Builds a `Layer` from your config (same inference logic), which you then
`Effect.provide` yourself. Useful when you want to compose the persistence
layer with other layers or pass extra codecs.

```typescript
const PersistenceLayer = makeNodePersistenceLayer(config)

const runnable = program.pipe(
  Effect.provide(PersistenceLayer),
  Effect.scoped,
)
```

### C. Manual `Layer.merge()` -- full control

Wire `NodeStorageLayer` and `makeSerializerLayer([...])` by hand. Choose this
when you need custom codec options, plugin codecs, or a non-Node storage
adapter.

```typescript
const ManualLayer = Layer.merge(
  NodeStorageLayer,
  makeSerializerLayer([jsonCodec()]),
)
```

## What the example does

1. Creates two collections (`users` and `posts`) persisted to JSON files.
2. Inserts sample records -- each mutation triggers a debounced write.
3. Runs a populated query (posts with their authors).
4. Flushes pending writes and prints the file paths.

## Running

```bash
bun run examples/persistence-setup/index.ts
```

Output files are written to `./data/users.json` and `./data/posts.json`.
