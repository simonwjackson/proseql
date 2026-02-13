## Context

ProseQL is a monorepo with 6 published packages. Only `@proseql/browser` has a README. The root `README.md` (1114 lines) covers the full API surface — schema, CRUD, queries, persistence, codecs, plugins — mixing core concepts with Node-specific file I/O. npm visitors landing on any package other than browser see no documentation.

## Goals / Non-Goals

**Goals:**
- Every package on npm has a self-contained README with install, API overview, and examples
- Root README becomes a concise landing page that routes to packages
- Content ownership is clear: each piece of documentation lives in exactly one place
- No duplication of API docs between root and package READMEs

**Non-Goals:**
- API reference generation (typedoc, etc.)
- Changelog or migration guide
- Restructuring the actual package code

## Decisions

### 1. Content split: root as landing page, core gets the API docs

The root README currently documents the core API. Moving that content to `packages/core/README.md` and slimming the root to a landing page means:
- npm visitors to `@proseql/core` see full docs
- GitHub visitors see a concise overview with links to packages
- No content duplication

**Alternative considered:** Duplicate the full README in both root and core. Rejected — maintenance burden, guaranteed drift.

### 2. Persistence content split between core and node

Codecs (JSON, YAML, TOML, prose, etc.) are runtime-agnostic and live in `@proseql/core`. File I/O, `createNodeDatabase`, `makeNodePersistenceLayer`, and debounced writes are Node-specific.

- **Core README** covers: codec registration (`makeSerializerLayer`, `AllTextFormatsLayer`), format table, prose codec API, in-memory usage
- **Node README** covers: `createNodeDatabase`, `makeNodePersistenceLayer`, manual layer wiring, file persistence lifecycle, `flush()`, append-only JSONL

### 3. README structure convention

All package READMEs follow the same structure:
1. Package name + one-line description
2. Install
3. Quick start (minimal working example)
4. API sections (package-specific)
5. License line

### 4. Browser README stays as-is

The existing `packages/browser/README.md` already follows the target structure and covers all browser-specific content. No changes needed.

## Risks / Trade-offs

- **[Content may go stale]** → Package READMEs are closer to the code they document, making it more likely they get updated alongside code changes. Better than the current state where the root README is far from the implementation.
- **[Root README becomes less self-contained]** → Intentional trade-off. GitHub visitors can follow links; npm visitors get focused docs for the package they installed.
- **[CLI/REST/RPC packages are less mature]** → Their READMEs will be shorter, reflecting actual API surface. Better than nothing.
