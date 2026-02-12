## 1. Types

- [x] 1.1 Create `core/plugins/plugin-types.ts` with `ProseQLPlugin` interface: `name: string`, `version?: string`, optional `codecs: ReadonlyArray<FormatCodec>`, `operators: ReadonlyArray<CustomOperator>`, `idGenerators: ReadonlyArray<CustomIdGenerator>`, `hooks: GlobalHooksConfig`, `dependencies?: ReadonlyArray<string>`, `initialize?: () => Effect.Effect<void>`, `shutdown?: () => Effect.Effect<void>`
- [x] 1.2 Define `CustomOperator` interface: `name: string` (must start with `$`), `types: ReadonlyArray<"string" | "number" | "boolean" | "array">`, `evaluate: (fieldValue: unknown, operand: unknown) => boolean`
- [x] 1.3 Define `CustomIdGenerator` interface: `name: string`, `generate: () => string`
- [x] 1.4 Define `GlobalHooksConfig` type: same shape as `HooksConfig<Record<string, unknown>>` (untyped, since global hooks span all collections)
- [x] 1.5 Define `PluginRegistry` interface: resolved internal state holding `codecs: ReadonlyArray<FormatCodec>`, `operators: Map<string, CustomOperator>`, `idGenerators: Map<string, CustomIdGenerator>`, `globalHooks: GlobalHooksConfig`
- [x] 1.6 Create `core/errors/plugin-errors.ts` with `PluginError`: `Data.TaggedError("PluginError")<{ plugin: string, reason: string, message: string }>`
- [x] 1.7 Add `readonly idGenerator?: string` to `CollectionConfig` in `core/types/database-config-types.ts`
- [x] 1.8 Export new types and `PluginError` from `core/index.ts`

## 2. Plugin Validation

- [x] 2.1 Create `core/plugins/plugin-validation.ts` with `validatePlugin(plugin)`: verify `name` is a non-empty string, `codecs` entries have `name`/`extensions`/`encode`/`decode`, `operators` entries have `name` starting with `$` and an `evaluate` function, `idGenerators` entries have `name` and `generate`. Return `Effect<void, PluginError>`.
- [x] 2.2 Implement `validateOperatorConflicts(plugins)`: check that no two plugins register operators with the same name. Also check that no custom operator conflicts with a built-in operator name (`$eq`, `$ne`, `$in`, `$nin`, `$gt`, `$gte`, `$lt`, `$lte`, `$startsWith`, `$endsWith`, `$contains`, `$all`, `$size`). Fail with `PluginError` listing the conflict.
- [x] 2.3 Implement `validateDependencies(plugins)`: for each plugin with `dependencies`, verify every dependency name appears in the plugin array. Fail with `PluginError` listing missing dependencies.

## 3. Plugin Registry

- [x] 3.1 Create `core/plugins/plugin-registry.ts` with `buildPluginRegistry(plugins)`: validate all plugins (2.1-2.3), merge codecs (append in registration order), merge operators into a `Map`, merge ID generators into a `Map`, merge global hooks (concatenate arrays in registration order). Return `Effect<PluginRegistry, PluginError>`.
- [x] 3.2 Handle empty/undefined plugin arrays: return an empty `PluginRegistry` (no codecs, no operators, no generators, empty hooks).

## 4. Codec Plugin Integration

- [x] 4.1 Modify `makeSerializerLayer` in `core/serializers/format-codec.ts` to accept an optional second parameter `pluginCodecs: ReadonlyArray<FormatCodec>`. Append plugin codecs after the base codecs (plugin codecs can override base codecs for the same extension, with the existing console.warn on duplicates).
- [x] 4.2 In `createPersistentEffectDatabase`, when plugins provide codecs, pass them to `makeSerializerLayer` or merge them into the serializer layer construction.

## 5. Custom Operator Integration

- [x] 5.1 Add an optional `customOperators?: Map<string, CustomOperator>` parameter to `matchesFilter` in `core/types/operators.ts`. When a `$`-prefixed key is not recognized as a built-in operator, look it up in the custom operators map and call `evaluate(fieldValue, operand)`.
- [x] 5.2 Extend `isFilterOperatorObject` to recognize custom operator keys (any `$`-prefixed key present in the custom operators map).
- [x] 5.3 Modify `applyFilter` in `core/operations/query/filter-stream.ts` to accept and pass through the custom operators map to `matchesFilter`.
- [x] 5.4 Thread the custom operators map from `buildCollection` through to query operations.

## 6. ID Generator Integration

- [x] 6.1 In `create` (`core/operations/crud/create.ts`), when the collection config specifies `idGenerator` and the input has no `id` field, look up the generator by name from the resolved ID generator map and call `generate()` to produce the ID.
- [x] 6.2 Pass the ID generator map from `buildCollection` to `create` and `createMany`.
- [x] 6.3 Validate at init time that any `idGenerator` name referenced in a collection config exists in the plugin registry. Fail with `PluginError` if not found.

## 7. Global Lifecycle Hooks

- [x] 7.1 Create `core/plugins/plugin-hooks.ts` with `mergeGlobalHooks(globalHooks, collectionHooks)`: for each hook type (`beforeCreate`, `afterCreate`, etc.), concatenate the global hooks array before the collection hooks array. Return the merged `HooksConfig<T>`.
- [x] 7.2 In `buildCollection`, call `mergeGlobalHooks` with the plugin registry's global hooks and the collection's own hooks. Pass the merged result to CRUD operations.
- [x] 7.3 Handle type narrowing: global hooks are `HooksConfig<Record<string, unknown>>`, collection hooks are `HooksConfig<T>`. The merged result must be `HooksConfig<T>` with global hooks cast appropriately.

## 8. Factory Integration

- [x] 8.1 Add optional `options?: { plugins?: ReadonlyArray<ProseQLPlugin> }` parameter to `createEffectDatabase`.
- [x] 8.2 Add optional `options?: { plugins?: ReadonlyArray<ProseQLPlugin> }` parameter to `createPersistentEffectDatabase` (extend existing `persistenceConfig` or add alongside).
- [x] 8.3 At init time (before building collections): call `buildPluginRegistry(plugins)`, run each plugin's `initialize()` Effect, merge plugin codecs into serializer construction, store resolved operator and ID generator maps for collection building.
- [x] 8.4 Register plugin `shutdown()` Effects as scope finalizers (run during database teardown, after flush).
- [x] 8.5 Add `PluginError` to the error channel of `createEffectDatabase` and `createPersistentEffectDatabase`.

## 9. Tests — Plugin Registration

- [x] 9.1 Create `tests/plugin-system.test.ts` with test helpers: minimal plugin factory, database with plugins
- [x] 9.2 Test registering a plugin with no contributions (name only) succeeds
- [x] 9.3 Test registering multiple plugins succeeds, all contributions are merged
- [x] 9.4 Test plugin initialize() runs during database creation
- [x] 9.5 Test plugin with missing name fails with PluginError
- [x] 9.6 Test plugin with malformed operator (missing evaluate) fails with PluginError

## 10. Tests — Plugin Validation

- [x] 10.1 Test operator name conflict between two plugins fails with PluginError
- [x] 10.2 Test operator name conflicting with built-in operator fails with PluginError
- [x] 10.3 Test missing dependency fails with PluginError listing the missing plugin
- [x] 10.4 Test satisfied dependency passes validation
- [x] 10.5 Test invalid codec (missing encode/decode) fails with PluginError

## 11. Tests — Custom Codecs

- [x] 11.1 Test plugin codec registers for new extension, collection with that extension serializes/deserializes correctly
- [x] 11.2 Test plugin codec overrides built-in extension (last wins), warning is logged
- [x] 11.3 Test multiple plugins providing codecs, all extensions are available

## 12. Tests — Custom Operators

- [x] 12.1 Test custom `$regex` operator: `where: { title: { $regex: "^The.*" } }` matches correctly
- [x] 12.2 Test custom operator with type constraint: operator declared for `"string"` only, applied to string field works, applied to number field is ignored
- [x] 12.3 Test multiple custom operators from different plugins work in same query
- [x] 12.4 Test custom operator combined with built-in operators in same where clause

## 13. Tests — Custom ID Generators

- [ ] 13.1 Test collection with `idGenerator: "custom"` uses plugin generator when no id provided
- [ ] 13.2 Test collection with `idGenerator: "custom"` still uses provided id when explicit
- [ ] 13.3 Test referencing non-existent idGenerator name fails at init with PluginError
- [ ] 13.4 Test createMany uses generator per entity

## 14. Tests — Global Hooks

- [ ] 14.1 Test global beforeCreate hook fires for all collections
- [ ] 14.2 Test global afterCreate hook fires for all collections
- [ ] 14.3 Test global hooks run before collection-specific hooks (ordering)
- [ ] 14.4 Test multiple plugins' global hooks run in plugin registration order
- [ ] 14.5 Test global onChange hook fires for create/update/delete across collections

## 15. Tests — Integration

- [ ] 15.1 Test full plugin providing codecs + operators + hooks + ID generator together
- [ ] 15.2 Test plugin with persistent database (createPersistentEffectDatabase)
- [ ] 15.3 Test plugin shutdown() runs during scope finalization
- [ ] 15.4 Test database with no plugins behaves identically to current behavior (regression)

## 16. Cleanup

- [ ] 16.1 Run full test suite (`bun test`) to verify no regressions
- [ ] 16.2 Run type check (`bunx tsc --noEmit`) to verify no type errors
- [ ] 16.3 Run lint (`biome check .`) to verify no lint errors
