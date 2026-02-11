## Why

Every CRUD operation runs as a closed pipeline: validate with Zod, mutate the in-memory array, optionally persist. There is no way for consumer code to intercept, transform, or react to these mutations. This forces business logic -- computed fields, audit trails, cross-field validation, side effects -- to live outside the database layer, duplicated across every call site.

The persistence layer (`wrapWithPersistence`) already wraps mutations with post-save behavior, proving the pattern works. But it is hard-coded and internal. Consumers cannot participate.

## What Changes

Introduce a hook registration system at the collection level. Hooks are async functions that run at defined points in the CRUD lifecycle. They receive a context object describing the operation and can transform data (before-hooks) or react to completed mutations (after-hooks). Hook registration happens in the database config, keeping it co-located with schemas and relationships.

## Capabilities

### New Capabilities

- `beforeCreate`: Transform or reject data before a record is inserted. Enables computed fields (e.g., slugs, timestamps), cross-field validation, and conditional defaults that Zod schemas cannot express.
- `afterCreate`: React after a record is successfully inserted. Enables audit logging, cache invalidation, and triggering downstream side effects.
- `beforeUpdate`: Transform or reject update payloads before they are applied. Enables enforcing invariants (e.g., "status cannot go backwards"), normalizing input, and injecting fields like `updatedBy`.
- `afterUpdate`: React after a record is successfully updated. Receives both the previous and current state for diffing. Enables change tracking, notifications, and sync triggers.
- `beforeDelete`: Intercept or reject delete operations before execution. Enables soft-delete policies, archival logic, and referential integrity checks beyond what the relationship system enforces.
- `afterDelete`: React after a record is removed. Enables cleanup of external resources, audit trails, and cascading side effects outside the relationship graph.
- `onChange`: Subscribe to all mutations on a collection with a single callback. Receives the operation type and affected records. Enables reactive UI updates, event sourcing, and generic logging without registering individual hooks.

### Modified Capabilities

- `createDatabase`: Accepts an optional `hooks` map per collection in the config, alongside `schema` and `relationships`.
- `createCrudMethods` / `createCrudMethodsWithRelationships`: Internally wraps each operation to invoke registered hooks at the appropriate lifecycle point. The existing persistence wrapping composes with hooks rather than replacing them.

## Impact

- **No breaking changes.** Hooks are opt-in. Existing databases with no hooks configured behave identically.
- **CRUD factory functions** gain a hooks parameter and internal wrapping logic, similar to the existing persistence wrapper.
- **Type surface** grows: new types for hook context objects, hook functions, and the hooks config map. These are additive.
- **Execution order** must be defined and documented: before-hooks run in registration order, the mutation executes, then after-hooks and onChange run. A before-hook returning an error short-circuits the operation.
- **Performance** consideration: hooks are async, adding overhead per operation. This is acceptable for an in-memory database where I/O (file persistence) already dominates latency.
