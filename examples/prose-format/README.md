# Prose Format

Demonstrates the prose file format -- data that reads like English. Prose files are self-describing: the `@prose` directive in the file contains the template, so the codec learns it automatically on load.

## Features

- Self-describing `.prose` files with `@prose` directive
- Template-less `proseCodec()` that learns from the file
- Explicit template option: `proseCodec({ template: '...' })`
- Format override: prose data inside a `.md` file with `format: "prose"`
- `createNodeDatabase()` convenience API with auto-inferred codecs

## Run

```sh
bun run examples/prose-format/index.ts
```

## Key Concepts

The `@prose` directive on the first line of a `.prose` file defines the template pattern. Field placeholders use `{fieldName}` syntax mixed with literal text. When `proseCodec()` is created without a template, it learns the pattern from the first decoded file.

The `createNodeDatabase()` function infers the correct codec from the `.prose` file extension, so no manual codec wiring is needed.

For files with a non-`.prose` extension that contain prose data, use `format: "prose"` in the collection config to override the inferred codec.
