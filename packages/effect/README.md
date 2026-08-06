# @proseql/effect

Effect-first ProseQL APIs over the Rust/WebAssembly engine.

This package keeps the public TypeScript contract from `@proseql/core`, executes queries and mutations through `@proseql/engine`, wraps Promise operations as `Effect` and reactive results as `Stream`, and reconstructs public tagged errors so `Effect.catchTag` works. Unexpected WASM failures remain defects rather than being disguised as expected database errors.

## Install

```sh
npm install @proseql/effect effect@4.0.0-beta.103
```

Effect is pinned exactly because this release is tested against `effect@4.0.0-beta.103`.

## Use

```ts
import { Effect, Schema, Stream } from "effect"
import { createEffectDatabase } from "@proseql/effect"

const config = {
  books: {
    schema: Schema.Struct({ id: Schema.String, title: Schema.String }),
    relationships: {},
  },
} as const

const program = Effect.gen(function* () {
  const db = yield* createEffectDatabase(config, { books: [] })
  yield* db.books.create({ id: "1", title: "Dune" })
  const books = yield* Stream.runCollect(db.books.query())
  yield* db.close()
  return Array.from(books)
})

const books = await Effect.runPromise(program)
```

Validation, not-found, storage, and other expected failures retain their ProseQL `_tag` and fields across the WASM boundary. Use normal Effect error operators such as `Effect.catchTag`.

## Browser loading

Browser applications may import `@proseql/effect/browser`, or install `@proseql/browser` for that browser-safe Effect entry point plus storage hosts. The browser entry loads the packaged browser WASM; the root entry loads the Node WASM. Neither path builds Rust at runtime.

## License

MIT
