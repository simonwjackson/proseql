# Plugin System — Design

## Architecture

### New Modules

**`core/plugins/plugin-types.ts`** — All plugin-related types: `ProseQLPlugin` interface, `CustomOperator` interface (name, types, evaluate), `CustomIdGenerator` interface (name, generate), `PluginRegistry` (resolved internal registry holding merged codecs, operators, generators, hooks). Also re-exports `FormatCodec` and `HooksConfig` for plugin authors.

**`core/plugins/plugin-registry.ts`** — `buildPluginRegistry(plugins)`: iterates over the plugin array, validates each plugin, detects conflicts (duplicate operator names, missing dependencies), merges contributions into a single `PluginRegistry`. Returns an `Effect<PluginRegistry, PluginError>`.

**`core/plugins/plugin-validation.ts`** — `validatePlugin(plugin)`: checks that a plugin conforms to `ProseQLPlugin` (has `name`, contributions are well-formed). `validateDependencies(plugins)`: checks that all declared dependencies are present in the array. `validateOperatorConflicts(plugins)`: checks that no two plugins register the same operator name. All return `Effect<void, PluginError>`.

**`core/plugins/plugin-hooks.ts`** — `mergeGlobalHooks(pluginHooks, collectionHooks)`: takes the global hooks from all plugins and a collection's own hooks, returns a merged `HooksConfig` where global hooks come first. Handles the generic-to-specific type narrowing (global hooks are `HooksConfig<Record<string, unknown>>`, collection hooks are `HooksConfig<T>`).

**`core/errors/plugin-errors.ts`** — `PluginError`: `Data.TaggedError("PluginError")<{ plugin, reason, message }>`. Used for validation failures, dependency errors, and operator conflicts.

### Modified Modules

**`core/types/database-config-types.ts`** — `CollectionConfig` gains `readonly idGenerator?: string` for referencing a named ID generator from plugins.

**`core/factories/database-effect.ts`** — `createEffectDatabase` and `createPersistentEffectDatabase` accept an optional `plugins` parameter. On init: build plugin registry, merge plugin codecs into serializer layer, merge global hooks into each collection, pass operator registry and ID generators to collection builders. `buildCollection` receives the resolved operator registry and ID generator map.

**`core/serializers/format-codec.ts`** — `makeSerializerLayer` accepts an optional second parameter for plugin codecs, appending them to the codec array (last wins on extension conflicts, same as today).

**`core/types/operators.ts`** — `matchesFilter` gains an optional `customOperators` parameter (a `Map<string, CustomOperator>`). When an operator key is not recognized as built-in, it consults the custom operator map. `isFilterOperatorObject` is extended to accept custom operator keys.

**`core/operations/query/filter-stream.ts`** — `applyFilter` passes the custom operator registry through to `matchesFilter`.

**`core/operations/crud/create.ts`** — When `idGenerator` is configured for the collection and no `id` is provided in the input, the create operation uses the resolved generator to produce an ID.

**`core/index.ts`** — Exports new types and the `PluginError` class.

## Key Decisions

### Plugins as Effect Layers (composable, testable)

Plugins map naturally to Effect Layers because the existing extension points (StorageAdapter, SerializerRegistry) are already Effect services. A plugin that provides a custom storage adapter is literally a Layer. The `ProseQLPlugin` interface is a convenience wrapper that the factory decomposes into Layers internally. Advanced users can skip `ProseQLPlugin` and compose Layers directly.

### ProseQLPlugin interface

A single declarative object rather than multiple registration calls. This makes plugins inspectable (you can log what a plugin provides), testable (validate a plugin object without creating a database), and discoverable (a plugin's capabilities are visible from its type).

### Plugin validation at init time

All validation happens during `createEffectDatabase` / `createPersistentEffectDatabase`, before any collections are built. This ensures fast failure with clear error messages rather than runtime surprises. Validation includes: interface conformance, operator name uniqueness, dependency resolution, and codec extension conflicts.

### Operator registration extending the filter system

Custom operators are dispatched through the same `matchesFilter` function that handles built-in operators. Built-in operators are checked first (no performance regression). Custom operators are stored in a `Map<string, CustomOperator>` and consulted only for unrecognized `$`-prefixed keys. This avoids forking the filter pipeline.

### Hook ordering (global plugin hooks before collection hooks)

Global plugin hooks run before collection-specific hooks because they represent cross-cutting concerns (audit logging, encryption) that should see data before collection-specific transformations. Within the global hooks, ordering follows plugin registration order. This is consistent with middleware patterns in web frameworks.

### Custom ID generators are named and referenced by string

Rather than passing a generator function directly in collection config, collections reference generators by name (`idGenerator: "snowflake"`). The plugin registry resolves the name to a generator at init time. This keeps collection config serializable and makes it clear which plugin provides the generator.

### PluginError is a distinct tagged error

Separate from `HookError` and `ValidationError` because plugin failures are a different category: they happen at init time, not during CRUD operations. Having a distinct error type makes it easy to catch and report plugin configuration problems.

### Plugin initialize/shutdown are optional lifecycle Effects

Plugins can optionally provide `initialize` (runs once during database creation, after validation) and `shutdown` (runs during scope finalization) Effects. These enable plugins that need to set up external resources (connections, caches) or clean them up.

## File Layout

```
core/
  plugins/
    plugin-types.ts            (new — ProseQLPlugin, CustomOperator, CustomIdGenerator, PluginRegistry)
    plugin-registry.ts         (new — buildPluginRegistry, mergePluginCodecs)
    plugin-validation.ts       (new — validatePlugin, validateDependencies, validateOperatorConflicts)
    plugin-hooks.ts            (new — mergeGlobalHooks)
  errors/
    plugin-errors.ts           (new — PluginError)
    crud-errors.ts             (modified — import PluginError into CrudError union if needed)
  types/
    database-config-types.ts   (modified — add idGenerator to CollectionConfig)
    operators.ts               (modified — custom operator dispatch in matchesFilter)
  serializers/
    format-codec.ts            (modified — accept plugin codecs in makeSerializerLayer)
  operations/
    query/
      filter-stream.ts         (modified — pass custom operators to matchesFilter)
    crud/
      create.ts                (modified — custom ID generation)
  factories/
    database-effect.ts         (modified — plugin init, merge, pass to buildCollection)
  index.ts                     (modified — export new types and PluginError)
tests/
  plugin-system.test.ts        (new — full test suite)
```
