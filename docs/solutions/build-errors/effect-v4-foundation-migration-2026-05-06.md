---
title: Effect v4 Foundation Package Migration
category: build-errors
module: Effect v4 migration
problem_type: build_error
component: tooling
severity: high
symptoms:
  - TypeScript build failed after moving proseql packages to effect@4.0.0-beta.60
  - Runtime tests failed on removed Effect 3 APIs such as Effect.either and Runtime.isFiberFailure
  - Stream.runCollect consumers crashed when treating returned arrays as Chunk values
root_cause: wrong_api
resolution_type: dependency_update
tags: [effect-v4, typescript, bun, migration, stream, scope, schema]
date: 2026-05-06
---

# Effect v4 Foundation Package Migration

## Problem

Moving ProseQL foundation packages (`@proseql/core`, `@proseql/node`, and REST support) to `effect@4.0.0-beta.60` broke typechecking and several runtime tests because the codebase still used Effect 3 API shapes. The hard readiness gate was getting the core/node foundation compiling and proving persistence, schema validation, migrations, transactions, and REST handlers still worked for Korri's server-side plain-text persistence use case.

## Symptoms

- `bunx tsc --build` failed across core, node, rest, and rpc after bumping `effect` to `4.0.0-beta.60`.
- Service tags using `Context.Tag` no longer matched the available API.
- Schema helpers such as `Schema.decodeUnknown` / `Schema.encode` no longer matched Effect v4 names.
- `Stream.runCollect` returned plain arrays in v4, while many tests and helpers still called `Chunk.toArray` / `Chunk.toReadonlyArray`.
- Forking with `Effect.forkScoped` introduced `Scope` requirements in places where tests created services outside an explicit scope.
- Effect v3 error helpers such as `Runtime.isFiberFailure`, `Cause.failureOption`, and `Effect.either` were removed or replaced.
- Node adapter retry logic failed because `Schedule.intersect` was removed.

## What Didn't Work

- Treating the migration as a search-and-replace only fixed type errors superficially. Several APIs changed behavior as well as names, especially stream collection and fiber start semantics.
- Replacing all previous `Effect.fork` calls with `Effect.forkScoped` made debounced writer tests fail with `Service not found: effect/Scope`. Some background work is intentionally detached or must be forked into an existing scope explicitly.
- Keeping FiberFailure extraction in REST and cursor tests failed because Effect v4 `runPromise` rejects with failed values directly for ordinary failures.
- Leaving old test helpers in place obscured real failures: many failures were test harness assumptions (`Effect.either`, `Chunk.toArray`) rather than product regressions.

## Solution

### 1. Move service tags to `Context.Service`

Effect v4 uses `Context.Service` for service definitions used by ProseQL's storage and serializer layers.

```ts
export const StorageAdapter = Context.Service<StorageAdapterShape>(
  "StorageAdapter",
);

export type StorageAdapter = StorageAdapterShape;
```

The same pattern applies to `SerializerRegistry`.

### 2. Use Effect v4 schema helpers

Schema decode/encode helpers now use the Effect-suffixed names:

```ts
const decode = Schema.decodeUnknownEffect(schema);
const encode = Schema.encodeEffect(schema);
```

Schema type annotations also needed to move toward `Schema.Codec` / `Schema.Top` where ProseQL code was modeling schemas that may encode/decode across different representations.

### 3. Treat `Stream.runCollect` as returning arrays

Effect v4's `Stream.runCollect` returns arrays in this version, so downstream code and tests should not pass its result through Chunk helpers.

Before:

```ts
const result = yield* Stream.runCollect(db.users.query());
return Chunk.toArray(result);
```

After:

```ts
const result = yield* Stream.runCollect(db.users.query());
return result;
```

This change also applies to `Effect.map(Chunk.toArray)` and `Effect.map(Chunk.toReadonlyArray)` in test helpers.

### 4. Be explicit about background fiber lifetime

Detached debounced writes should not require a caller-provided `Scope`:

```ts
const fiber = yield* Effect.forkDetach(
  Effect.gen(function* () {
    yield* Effect.sleep(delayMs);
    yield* save;
    yield* Ref.update(pending, (m) => {
      const next = new Map(m);
      next.delete(key);
      return next;
    });
  }),
  { startImmediately: true },
);
```

File watchers, by contrast, are scope-managed resources. For callback-driven watcher reloads, capture the current runtime context and run the debounced reload from the synchronous storage callback:

```ts
const runtimeContext = yield* Effect.context<StorageAdapter | SerializerRegistry | R>();

const scheduleReload = Effect.gen(function* () {
  const isActive = yield* Ref.get(active);
  if (!isActive) return;

  const existing = yield* Ref.get(pendingReload);
  if (existing !== null) {
    yield* Fiber.interrupt(existing);
  }

  const fiber = yield* Effect.forkIn(
    Effect.gen(function* () {
      yield* Effect.sleep(debounceMs);
      const newData = yield* loadData(config.filePath, config.schema);
      yield* Ref.set(config.ref, newData);
    }),
    scope,
    { startImmediately: true },
  );

  yield* Ref.set(pendingReload, fiber);
}).pipe(Effect.provide(runtimeContext));

storage.watch(config.filePath, () => {
  Effect.runFork(scheduleReload);
});
```

This avoids the race where a synchronous file-change callback fires before a background queue consumer is actively waiting.

### 5. Replace removed error and result helpers

Effect v4 replaces several v3 idioms:

```ts
// v3-style test handling
Effect.either(effect);

// v4
Effect.result(effect);
```

The result shape is also different:

```ts
if (result._tag === "Failure") {
  expect(result.failure._tag).toBe("ValidationError");
}
```

For REST handler error mapping, ordinary failed values from `Effect.runPromise` can be treated directly instead of unwrapping a FiberFailure:

```ts
const extractTaggedError = (error: unknown) => {
  if (error !== null && typeof error === "object" && "_tag" in error) {
    return error as { readonly _tag: string; [key: string]: unknown };
  }
  return null;
};
```

### 6. Update scheduling and Node type assumptions

`Schedule.intersect` is gone; use `Schedule.both`:

```ts
const retryPolicy = (config: Required<NodeAdapterConfig>) =>
  Schedule.exponential(`${config.baseDelay} millis`).pipe(
    Schedule.both(Schedule.recurs(config.maxRetries)),
  );
```

The workspace also needed Node types in the shared TypeScript config because `@proseql/node` imports `node:crypto`, `node:fs`, and `node:path`.

```json
{
  "compilerOptions": {
    "types": ["bun", "node"]
  }
}
```

## Why This Works

The migration succeeded once each Effect v4 change was handled at the semantic boundary where it mattered:

- Services use Effect v4's current `Context.Service` model, keeping layers and service lookup aligned.
- Schema validation uses v4's effectful decode/encode helpers, preserving typed validation errors.
- Stream tests and query helpers accept v4's collected array values instead of treating arrays as Chunks.
- Long-lived background work is split between detached debounce fibers and scoped watcher fibers, matching actual ownership semantics.
- REST and test error handling follow v4's direct failed-value behavior instead of depending on removed FiberFailure helpers.
- Node persistence retry policy uses the available v4 `Schedule.both` combinator.

The verified checkpoint was:

```bash
bunx tsc --build --pretty false
bun test \
  packages/core/tests/database-effect.test.ts \
  packages/core/tests/debounced-writer.test.ts \
  packages/core/tests/file-watcher.test.ts \
  packages/core/tests/schema-validation.test.ts \
  packages/core/tests/schema-migrations.test.ts \
  packages/core/tests/transactions.test.ts \
  packages/node/tests/convenience.test.ts \
  packages/rest/tests/handlers.test.ts
```

That targeted suite passed with 287 tests across core/node/rest foundation paths.

## Prevention

- Before writing or migrating Effect code, inspect the checked-out Effect source (`./effect/packages/effect/src/`) for the exact version's API signatures.
- During major Effect upgrades, separate product regressions from test harness regressions. Removed helpers like `Effect.either` and changed collection return types can create noisy failures unrelated to core behavior.
- Avoid replacing all fiber APIs uniformly. Choose between `forkDetach`, `forkScoped`, and `forkIn(scope)` based on ownership:
  - detached debounce timers that are explicitly flushed/interrupted can use `forkDetach`;
  - resources tied to database/file watcher lifetimes should use `forkScoped` or `forkIn` with an explicit scope.
- Keep targeted foundation tests that exercise persistence, file watching, schema validation, migrations, transactions, Node adapter convenience, and REST handlers. These provide a faster readiness signal than the full historical suite during a dependency migration.
- When `runPromise` error behavior changes, update boundary error extraction first so REST/API tests report real domain errors instead of wrapper failures.

## Related Issues

- Plan: `docs/plans/2026-05-06-001-feat-korri-foundation-hardening-plan.md`
- Commit: `5ffd9d2 feat: migrate foundation packages to Effect v4 beta`
- Important files touched:
  - `packages/core/src/storage/persistence-effect.ts`
  - `packages/core/src/storage/storage-service.ts`
  - `packages/core/src/serializers/serializer-service.ts`
  - `packages/core/src/validators/schema-validator.ts`
  - `packages/core/src/reactive/watch.ts`
  - `packages/node/src/node-adapter-layer.ts`
  - `packages/rest/src/error-mapping.ts`
