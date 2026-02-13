# Reactive Queries

Demonstrates live query results that automatically update when mutations occur using Effect streams.

## Features

- Watch query results with `watch()` for filtered, sorted collections
- Watch individual entities with `watchById()` for single-entity tracking
- Automatic stream emissions on matching mutations
- Scoped stream lifecycle with automatic cleanup
- Background fiber execution for concurrent watching and mutating

## Run

```sh
bun run examples/15-reactive-queries/index.ts
```

## Key Concepts

The `watch()` method returns an `Effect` stream that emits the full query result set whenever a mutation affects matching entities. The `watchById()` method emits the entity on creation/update and `null` on deletion. Streams are scoped resources that clean up automatically when the scope ends. The example uses `Effect.fork` to run watchers in background fibers while performing mutations in the foreground.
