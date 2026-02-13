# Lifecycle Hooks

Demonstrates lifecycle hooks for transforming data and executing side effects during create, update, and delete operations.

## Features

- beforeCreate hooks for transforming data before insertion
- afterCreate hooks for side effects after entity creation
- beforeUpdate hooks for injecting fields during updates
- afterUpdate hooks for side effects with access to previous and current state
- afterDelete hooks for cleanup or logging on deletion
- onChange hooks that fire on any mutation type
- Hook rejection with HookError to prevent invalid operations

## Run

```sh
bun run examples/10-lifecycle-hooks/index.ts
```

## Key Concepts

Hooks are defined in the collection config as arrays of Effect-returning functions. Before hooks can transform data by returning a modified version. After hooks perform side effects and return `Effect.void`. The hook context provides the relevant data (entity, previous state, update object) along with metadata like collection name and operation type. Hooks can reject operations by returning `Effect.fail(new HookError({...}))`, preventing the mutation from completing.
