# Plugin System

## Overview

An extensibility system that allows third-party code to add custom serialization codecs, storage adapters, query operators, ID generators, and lifecycle behaviors without modifying proseql core. Plugins are composed via Effect Layers, keeping the core minimal while enabling a rich ecosystem.

## Requirements

### Requirement: Custom codec plugins

Third parties SHALL be able to register custom serialization formats.

#### Scenario: Register custom codec
- **GIVEN** a custom codec implementing `FormatCodec`:
  ```ts
  const csvCodec = (): FormatCodec => ({
    extensions: [".csv"],
    serialize: (data) => ...,
    deserialize: (content) => ...,
  })
  ```
- **WHEN** included in `makeSerializerLayer([jsonCodec(), csvCodec()])`
- **THEN** collections with `.csv` files SHALL use the custom codec

#### Scenario: Codec conflict
- **WHEN** two codecs claim the same extension
- **THEN** the last one registered SHALL win (with a console warning)

### Requirement: Custom storage adapter plugins

Third parties SHALL be able to provide alternative storage backends.

#### Scenario: S3 storage adapter
- **GIVEN** a custom adapter implementing `StorageAdapterShape`
- **WHEN** provided as a Layer to `createPersistentEffectDatabase`
- **THEN** all file operations SHALL be routed through the custom adapter

#### Scenario: Adapter composition
- **WHEN** a custom adapter is composed with the default serializer layer
- **THEN** both SHALL work together via standard Effect Layer composition

### Requirement: Custom query operator plugins

Third parties SHALL be able to register custom filter operators.

#### Scenario: Register custom operator
- **GIVEN** a custom operator:
  ```ts
  const regexOperator = {
    name: "$regex",
    types: ["string"],
    evaluate: (fieldValue: string, pattern: string) => new RegExp(pattern).test(fieldValue),
  }
  ```
- **WHEN** registered as a plugin
- **THEN** `where: { title: { $regex: "^The.*" } }` SHALL work in queries

#### Scenario: Operator type safety
- **WHEN** a custom operator is registered
- **THEN** TypeScript SHALL recognize the operator in where clause types
- **AND** the operator SHALL be constrained to its declared field types

### Requirement: Custom ID generator plugins

Third parties SHALL be able to provide custom ID generation strategies.

#### Scenario: Custom ID generator
- **GIVEN** a custom generator:
  ```ts
  const snowflakeId = {
    name: "snowflake",
    generate: () => generateSnowflakeId(),
  }
  ```
- **WHEN** registered as a plugin
- **THEN** collections MAY use `idGenerator: "snowflake"` in their config

### Requirement: Plugin lifecycle hooks

Plugins SHALL be able to register global lifecycle hooks that run across all collections.

#### Scenario: Audit logging plugin
- **GIVEN** a plugin that logs all mutations:
  ```ts
  const auditPlugin = {
    onChange: (ctx) => Effect.sync(() => auditLog.append(ctx)),
  }
  ```
- **WHEN** registered globally
- **THEN** the hook SHALL fire for mutations on ALL collections

#### Scenario: Hook ordering
- **WHEN** multiple plugins register hooks for the same lifecycle event
- **THEN** hooks SHALL execute in registration order
- **AND** collection-specific hooks SHALL run after global plugin hooks

### Requirement: Plugin registration API

Plugins SHALL be registered through a declarative configuration.

#### Scenario: Plugin config
- **GIVEN**:
  ```ts
  const db = createEffectDatabase(config, data, {
    plugins: [auditPlugin(), encryptionPlugin({ fields: ["email"] })],
  })
  ```
- **THEN** all plugins SHALL be initialized and active

#### Scenario: Plugin as Effect Layer
- **THEN** plugins MAY alternatively be composed as Effect Layers for maximum flexibility

### Requirement: Plugin discovery and validation

The system SHALL validate plugins at initialization time.

#### Scenario: Invalid plugin
- **WHEN** a plugin does not conform to the expected interface
- **THEN** initialization SHALL fail with a descriptive error

#### Scenario: Plugin dependencies
- **WHEN** a plugin declares a dependency on another plugin
- **THEN** the system SHALL verify the dependency is present
- **AND** initialization SHALL fail with a clear message if dependencies are missing

## Types

```typescript
interface ProseQLPlugin {
  readonly name: string
  readonly version?: string

  // Optional extension points
  readonly codecs?: ReadonlyArray<FormatCodec>
  readonly operators?: ReadonlyArray<CustomOperator>
  readonly idGenerators?: ReadonlyArray<CustomIdGenerator>
  readonly hooks?: GlobalHooksConfig
  readonly middleware?: ReadonlyArray<Middleware>

  // Initialization (runs once at database creation)
  readonly initialize?: () => Effect.Effect<void>
  // Cleanup (runs on database shutdown)
  readonly shutdown?: () => Effect.Effect<void>
}
```

## Out of Scope

- Plugin marketplace / registry
- Hot-reloading plugins at runtime
- Plugin sandboxing / security isolation
- Plugin configuration UI
