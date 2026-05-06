# Prompt: Investigate derived IDs / key-derived record identity in ProseQL

## Context

Korri is using ProseQL as a plain-text library database. The current ProseQL YAML output stores records keyed by entity id, while the record payload also contains the same `id` field:

```yaml
472c8ba3-c51c-45ed-8bab-fc560edd83ea:
  id: 472c8ba3-c51c-45ed-8bab-fc560edd83ea
  metadata:
    name: Default
```

This duplication is awkward for human-authored / human-reviewed plain-text data. In Korri, the runtime contract still wants records shaped like:

```ts
{
  id: string
  metadata?: ...
  userData?: ...
}
```

But the persisted YAML would ideally omit redundant `id` fields and derive them from the map key:

```yaml
472c8ba3-c51c-45ed-8bab-fc560edd83ea:
  metadata:
    name: Default
```

Then reads would rehydrate the runtime record as:

```ts
{
  id: "472c8ba3-c51c-45ed-8bab-fc560edd83ea",
  metadata: { name: "Default" }
}
```

## Task

Investigate the feasibility of supporting derived IDs in ProseQL.

Do **not** jump straight to implementation. First produce a clear feasibility assessment and proposed design.

## Questions to answer

1. How does ProseQL currently represent records internally?
   - Where is the entity key established?
   - Is `id` assumed to be physically present in the record object?
   - Which APIs rely on `record.id` vs the storage map key?

2. Could ProseQL support collection-level derived IDs?
   - Example config shape:
     ```ts
     games: {
       schema: GameRecordWithoutId,
       file: "games.yaml",
       id: { kind: "derivedFromKey", field: "id" }
     }
     ```
   - Or a simpler option:
     ```ts
     games: {
       schema: GameRecord,
       file: "games.yaml",
       deriveIdFromKey: true
     }
     ```

3. What should the TypeScript types look like?
   - Can callers still work with full records containing `id`?
   - Does the persisted schema need to differ from the public row schema?
   - Can `GenerateDatabaseWithPersistence<Config>` preserve good inference?

4. What are the serialization/deserialization implications?
   - On write: omit the derived field from the serialized payload.
   - On read: inject the key as the derived field before schema validation, or validate payload first then merge key?
   - How should conflicts be handled if the payload also contains `id`?

5. What are the migration implications?
   - Can existing files with duplicated `id` continue to load?
   - Should writes normalize them by omitting `id`?
   - Should this be opt-in only per collection?

6. What are the relationship / uniqueness implications?
   - If a collection derives `id`, do refs and foreign keys still work normally?
   - Do unique constraints inspect hydrated records or raw persisted payloads?

7. What is the smallest useful API for this feature?
   - Avoid over-generalizing into arbitrary computed fields unless necessary.
   - Prefer a focused solution for “record id comes from storage key”.

## Desired output

Please write a feasibility report with:

- Current behavior summary.
- Recommended API design.
- Type-level impact.
- Runtime read/write algorithm.
- Backwards compatibility plan.
- Test plan.
- Risks / edge cases.
- A concrete implementation outline, if feasible.

## Acceptance criteria for a future implementation

A future implementation should make this possible:

```ts
const GamePayload = Schema.Struct({
  metadata: Schema.optional(GameMetadata),
  userData: Schema.optional(GameUserData),
})

const db = yield* createNodeDatabase({
  games: {
    schema: GamePayload,
    file: "games.yaml",
    id: { kind: "derivedFromKey", field: "id" },
    relationships: {},
  },
})
```

The persisted YAML should be:

```yaml
472c8ba3-c51c-45ed-8bab-fc560edd83ea:
  metadata:
    name: Default
```

The runtime query result should be:

```ts
{
  id: "472c8ba3-c51c-45ed-8bab-fc560edd83ea",
  metadata: { name: "Default" }
}
```

Reads should also tolerate legacy files temporarily:

```yaml
472c8ba3-c51c-45ed-8bab-fc560edd83ea:
  id: 472c8ba3-c51c-45ed-8bab-fc560edd83ea
  metadata:
    name: Default
```

But the next write should normalize to the non-duplicated form.
