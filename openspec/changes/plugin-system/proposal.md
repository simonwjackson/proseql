## Why

proseql already has well-defined extension points -- `FormatCodec` for serialization, `StorageAdapterShape` for persistence backends, `HooksConfig` for lifecycle hooks -- but each is wired independently through different mechanisms. Adding a custom codec requires calling `makeSerializerLayer` with a modified array. Adding a storage adapter requires providing a different Layer. Adding hooks requires embedding them in per-collection config. There is no unified way to bundle related extensions into a cohesive unit (e.g., an "encryption plugin" that adds a codec, registers hooks, and provides a custom ID generator). Third parties cannot ship a single installable package that extends proseql in multiple dimensions at once.

The filter system is also closed: the set of operators (`$eq`, `$gt`, `$contains`, etc.) is hard-coded in `operators.ts` and `types.ts`. Users cannot add domain-specific operators like `$regex`, `$between`, or `$fuzzy` without forking core.

## What Changes

Introduce a `ProseQLPlugin` interface that bundles extension points into a single declarative object. A plugin can provide any combination of: custom codecs, custom storage adapters, custom query operators, custom ID generators, and global lifecycle hooks. Plugins are registered through the database factory options or composed as Effect Layers. At initialization, the system validates all plugins, merges their contributions into the appropriate registries, and resolves dependencies between plugins.

## Capabilities

### New Capabilities

- `ProseQLPlugin` interface: A declarative object with a `name`, optional `version`, and optional arrays of extension contributions (`codecs`, `operators`, `idGenerators`, `hooks`). Includes optional `initialize` and `shutdown` lifecycle Effects for plugin setup/teardown.
- Plugin registration via factory options: `createEffectDatabase(config, data, { plugins: [...] })` accepts an array of plugins and wires their contributions automatically.
- Custom query operators: Plugins can register new filter operators (e.g., `$regex`, `$between`) by providing a `CustomOperator` with a name, type constraints, and an evaluate function. The filter system dispatches to custom operators when the built-in set does not match.
- Custom ID generators: Plugins can register named ID generation strategies. Collections reference them by name in config (`idGenerator: "snowflake"`), and the factory resolves the generator from the plugin registry at init time.
- Global lifecycle hooks: Plugins can register hooks that fire across all collections, not just a single collection. Global plugin hooks execute before collection-specific hooks, in plugin registration order.
- Plugin validation: At init time, the system validates that each plugin conforms to the `ProseQLPlugin` interface, checks for operator name conflicts, verifies declared plugin dependencies are present, and fails with a descriptive `PluginError` if anything is wrong.
- Plugin as Effect Layers: For maximum composability, plugins can alternatively be expressed and composed as Effect Layers, integrating with the existing `StorageAdapter` and `SerializerRegistry` service pattern.

### Modified Capabilities

- `createEffectDatabase` / `createPersistentEffectDatabase`: Accepts an optional `plugins` array in a new options parameter. Plugin codecs are merged into the serializer layer. Plugin hooks are prepended to each collection's hook arrays. Plugin operators are registered in the filter system.
- `makeSerializerLayer`: Accepts codecs from plugins in addition to directly-provided codecs. Plugin codecs are appended (plugin codecs can override built-in codecs with a warning, matching the existing last-wins behavior).
- `matchesFilter` / `isFilterOperatorObject`: Extended to consult a custom operator registry when encountering an unknown operator key, rather than ignoring it.
- `buildCollection`: Merges global plugin hooks with collection-level hooks (global hooks run first). Resolves custom ID generators from the plugin registry when a collection specifies `idGenerator`.

## Impact

- **No breaking changes.** Plugins are opt-in. Databases with no plugins configured behave identically to today.
- **Factory functions** gain an optional `plugins` parameter. Internally they merge plugin contributions before building collections.
- **Type surface** grows: `ProseQLPlugin`, `CustomOperator`, `CustomIdGenerator`, `PluginError`, `PluginRegistry`. These are additive exports.
- **Filter system** gains a custom operator dispatch path. Built-in operators are checked first; custom operators are consulted only for unrecognized keys. No performance impact on existing queries.
- **Hook ordering** is extended: global plugin hooks run before collection-specific hooks, in plugin registration order. Within a plugin, hooks follow the existing chaining rules (before-hooks chain, after-hooks are fire-and-forget).
- **Serializer layer** construction may incorporate plugin codecs, but the existing `makeSerializerLayer` API remains unchanged for direct usage.
