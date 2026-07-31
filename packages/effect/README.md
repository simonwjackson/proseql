# @proseql/effect

Effect-first adapter over `@proseql/engine`.

- preserves the core TypeScript surface by re-exporting `@proseql/core`
- wraps Promise methods as `Effect` / `Stream`
- reconstructs core `Data.TaggedError` classes so `Effect.catchTag` works
- converts unexpected WASM defects into Effect defects
