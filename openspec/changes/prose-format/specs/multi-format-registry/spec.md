## MODIFIED Requirements

### Requirement: Preset Layers

Pre-built combinations for convenience:

```typescript
// All 9 built-in text formats (was 7, adding prose and jsonl)
const AllTextFormatsLayer: Layer.Layer<SerializerRegistry>

// JSON + YAML (backward-compatible default)
const DefaultSerializerLayer: Layer.Layer<SerializerRegistry>
```

Note: `AllTextFormatsLayer` cannot include `proseCodec()` by default because it requires a `template` constructor argument. Instead, `AllTextFormatsLayer` SHALL continue to include all schema-agnostic codecs. The `proseCodec()` SHALL be registered by users via `makeSerializerLayer` or the plugin system with their collection-specific template.

#### Scenario: AllTextFormatsLayer does not include prose by default
- **WHEN** `AllTextFormatsLayer` is constructed
- **THEN** it dispatches all schema-agnostic formats (json, yaml, toml, json5, jsonc, hjson, toon, jsonl) but does NOT handle the `prose` extension

#### Scenario: User registers prose codec alongside AllTextFormatsLayer
- **WHEN** a user creates `makeSerializerLayer([...allTextCodecs, proseCodec({ template: '...' })])`
- **THEN** the `prose` extension dispatches to the user-configured prose codec and all other extensions work normally
