---
title: "feat: Add read-only documentGraph overlay source to ProseQL core"
type: feat
status: completed
date: 2026-06-10
verify_command: "bunx tsc --build && bun test packages/core/tests/ packages/node/tests/ && biome check ."
---

# feat: Add read-only documentGraph overlay source to ProseQL core

## Summary

Introduce a new read-only `documentGraph` source kind in `@proseql/core` (wired through `@proseql/node`) that assembles one effective collection graph from an ordered set of directory roots. It discovers opt-in fragments by real glob patterns, decodes each by file extension through the active serializer registry, applies a pure `Result`-based decode transform, deep-merges fragments into one effective document, then validates and migrates the merged result. Graph-owned collections are read-only: every mutation fails loudly. Invalid initial config fails database creation; invalid watcher reloads keep the last-known-good graph.

---

## Problem Frame

ProseQL's existing `documents` source treats files as a persistence target: duplicates across files are errors, and each source is an independent write destination. A config-overlay consumer (the motivating case is Korri's config graph) needs the opposite shape — many physical fragments collapsing into one logical read model, where later fragments overlay earlier ones and nothing writes back. Forcing this onto the `documents` source would mean duplicate-record errors and mutations scheduling saves against every read source. The clean answer is a distinct, read-only overlay source kind. See origin handoff: `docs/handoffs/korri-config-graph-document-source-handoff.md`.

---

## Requirements

- R1. A `documentGraph` source loads from an ordered array of directory `roots` and merges discovered fragments into one effective map per declared collection.
- R2. Discovery is opt-in: an effective `include` glob is required for every root — satisfied either by a graph-level `include` or by a root-level `include` on that root. A config where the graph has no `include` and at least one root also has none fails normalization. Real glob semantics (recursive `**`, brace groups) are supported. `exclude` patterns are supported.
- R3. Root-level `include` overrides graph-level `include`; graph-level and root-level `exclude` combine.
- R4. Each matched file is decoded by its file extension via the active serializer registry, so one graph can mix YAML/JSON/TOML/etc.
- R5. A matched file with an extension not registered in the active serializer registry fails the load with a clear, path-attributed error.
- R6. A pure decode transform hook may reshape each decoded document, returning a `Result` (success → transformed document, failure → typed error). After the transform, the value must be a plain object or the load fails.
- R7. Unknown top-level collection keys are rejected per file, after the decode transform, before merge.
- R8. Fragments deep-merge in deterministic order (roots in configured order, then files lexically by normalized relative path within a root; later fragments win). Objects merge recursively; arrays, scalars, and `null` replace. No delete/tombstone semantics.
- R9. Per-collection migrations run per fragment using that fragment's own `_version`, bringing every fragment to the current schema version *before* merge. `_version` is fragment-local for migration purposes; the merged effective sections carry the current schema version. (This revises the challenge-session "migrate after merge" lean — see Key Technical Decisions — because `runMigrations` early-returns once `fileVersion >= targetVersion`, so merging mixed-version fragments first would leave older-version records unmigrated against the current schema.)
- R10. Final effective records are validated after merge; validation failure reports the collection, record id, and the set of contributing file paths (record-level provenance, internal only).
- R11. Graph-owned collections are read-only: `create`/`createMany`/`update`/`updateMany`/`delete`/`deleteMany`/`upsert`/`upsertMany` and the `*WithRelationships` variants fail with `OperationError` (`reason: "read-only-source"`) before mutating in-memory state, including inside `$transaction`. Because the transaction collection builder (`makeBuildCollectionForTx`) does not receive the append-only parameter, read-only status must be carried on the collection itself (a derived read-only flag available to both `buildCollection` and `makeBuildCollectionForTx`), not via the `appendOnlyConfig` parameter alone.
- R12. `initialData` provided for a graph-owned collection fails database creation.
- R13. A collection has exactly one source owner; a collection backed by both `documentGraph` and any other source fails config validation.
- R14. Missing roots fail the load unless the root is marked `optional: true`. Existing-but-empty roots and globs with zero matches are valid (empty contribution).
- R15. Invalid initial graph (bad file, failed transform, unknown collection, invalid effective record) fails database creation.
- R16. A watched valid file change rebuilds and replaces the active graph; an invalid reload keeps the last-known-good graph and is logged. Roots absent at startup are not detected later.
- R17. ProseQL exposes generic supported-document-extension metadata from the active serializer registry. No consumer-specific (e.g. Korri) discovery patterns or helpers are added.
- R18. v1 ships Core + Node. CLI support and graph lifecycle event APIs are deferred.

---

## Scope Boundaries

- The existing `documents` source kind, its duplicate-error semantics, origin tracking, and outbox write path are unchanged.
- No write path for `documentGraph`: no outbox, no copy-on-write, no origin write-back.
- No delete/tombstone marker syntax in fragments.
- No graph lifecycle event API (`config.ready` / `config.changed` / `config.invalid`); existing collection `watch()` reload notifications are sufficient.
- No field-level provenance; only record-level contributing-path provenance for error messages.
- No late-appearing root detection; no removable-media root design.
- No CLI command support for graph-backed collections in v1.
- No Korri-side work of any kind.

### Deferred to Follow-Up Work

- CLI support for `documentGraph` (read display in `collections`/`stats`, explicit rejection of mutation commands): separate PR.
- Writable graph policies (outbox / copy-on-write / origin write-back): separate design + PR.
- Graph lifecycle event API for daemon consumers: separate PR.
- `docs/solutions/` learning capturing the read-only overlay source pattern once shipped (origin plan already flagged this follow-up).

---

## Context & Research

### Relevant Code and Patterns

- `packages/core/src/storage/source-config.ts` — `DatabaseSourceConfig` discriminated union, `normalizeSourceConfig` (throws `SourceConfigError` synchronously), `collectionSourceOwners` uniqueness map, current hand-rolled `matchesPattern` (documented as a tiny non-glob subset — used by the `documents` source).
- `packages/core/src/storage/document-source.ts` — `loadDocumentSources` structure to mirror: `Effect.gen`, `StorageAdapter | SerializerRegistry` services, `deserializeDocument` extension dispatch, derived-id hydration via `packages/core/src/storage/derived-id.ts`, `_version`/migration handling in `loadCollectionSection`.
- `packages/core/src/storage/origin-index.ts` — `getOrigin`/`setOrigin`/`emptyOriginIndex` reusable for path attribution.
- `packages/core/src/factories/database-effect.ts` — `createPersistentEffectDatabase` wiring: source load at startup into `Ref`s, `documentSourceKeysByCollection`, `makeSaveEffect` keyed by `"source:<id>"`, `forbiddenOp` factory (mirrors append-only read-only blocking), `reloadDocumentSources` + watcher registration, `transactionLock` persistence skipping.
- `packages/core/src/storage/persistence-effect.ts` — `createDocumentSourceWatcher({ root, onReload })` (generic; captures runtime context before installing the sync callback; debounced reload).
- `packages/core/src/serializers/format-codec.ts` / `serializer-service.ts` — `SerializerRegistryShape` currently exposes only `serialize`/`deserialize` by extension, with no extension introspection; `makeSerializerLayer` builds an internal `extensionMap`.
- `packages/core/src/serializers/infer-codecs.ts` + `packages/node/src/` convenience layer — codec inference from source `format`/extensions for `makeNodePersistenceLayer`.
- `packages/core/src/utils/path.ts` — `normalizePath`, `getFileExtension`, `joinPath`.
- Tests to mirror: `packages/core/tests/document-source.test.ts`, `source-config.test.ts`, `database-source-config.test.ts`, `file-watcher.test.ts`; in-memory storage layer via `makeInMemoryStorageLayer(store)`; `writeDebounce: 60_000` to silence background writes in integration tests.

### Institutional Learnings

- `docs/solutions/build-errors/effect-v4-foundation-migration-2026-05-06.md` — Effect v4 idioms this work must follow:
  - `Result` (not `Either`) is the v4 bifunctor; `Effect.result` (not `Effect.either`) for error extraction. The agreed "Effect way" decode transform therefore returns `Result.Result<unknown, TransformError>`.
  - `Schema.decodeUnknownEffect` / `Schema.encodeEffect`; never `Schema.decodeUnknown` (v3 name).
  - Watcher fiber ownership: scoped watchers via `Effect.forkIn(scope)`, detached debounce timers via `Effect.forkDetach` — do **not** uniformly use `forkScoped` (breaks debounce tests with no Scope). Capture runtime context before installing the sync watch callback.
  - `Stream.runCollect` returns plain arrays in v4.
- `docs/plans/2026-05-21-001-feat-multi-collection-document-source-plan.md` — established the tagged-source-union extension point, `LoadedDocumentSources` return shape (`{ collections, origins, documents }`), source-id-keyed persistence, and the rule that read-only/unsupported operations should fail at config/factory time rather than silently at write time.

### External References

- `picomatch` — pure-JS, zero-dependency glob matcher. No glob library currently exists in any package; `@proseql/core` must stay runtime-agnostic (pure JS only), so `picomatch` is the chosen dependency for real glob semantics.

---

## Key Technical Decisions

- **Distinct `kind: "documentGraph"` source, new module.** Implement in a new `packages/core/src/storage/document-graph-source.ts` beside `document-source.ts`. Keeps overlay/read-model semantics separate from the writable persistence source instead of overloading `documents` with conditionals.
- **Decode transform returns `Result`, not `Either`.** This repo's Effect version renames `Either` to `Result`. Same pure, typed-failure contract agreed in challenge; the loader unwraps it at the seam with `Result.isFailure` and wraps failures with source/path context. Thrown exceptions are caught and reported as unexpected transform defects.
- **Add `picomatch` for graph glob matching via a dedicated `glob-match.ts` seam.** The `documentGraph` matcher is a new utility; the existing `matchesPattern` used by the `documents` source is left untouched to avoid changing that source's behavior (clean break is allowed but `documents` is out of scope here).
- **Add extension introspection to the serializer registry.** Extend `SerializerRegistryShape` with a way to enumerate registered extensions, powering both per-file codec dispatch decisions and the generic public extension-metadata helper. The public Effect accessor (`getSupportedExtensions`) lives alongside the `SerializerRegistry` tag in `serializer-service.ts` — not in a separate module — since it is a thin accessor over the new method (a standalone file would fail the deletion test). This is the single new public serializer API; it is product-agnostic.
- **Deep merge as a pure, separately-tested utility.** `packages/core/src/utils/deep-merge.ts`: objects merge recursively, arrays/scalars/null replace. Semantics live in the function, not in config branching.
- **Read-only via the existing `forbiddenOp` mechanism, but driven by a derived read-only flag, not the append-only parameter.** Reuse the append-only blocking structure (`forbiddenOp` with `reason: "read-only-source"`), but gate it on a read-only signal that both `buildCollection` and `makeBuildCollectionForTx` can see — a derived `readOnlyCollections` set threaded from `createPersistentEffectDatabase` into the transaction builder, or a read-only marker on the effective collection config. Gating on the 15th `appendOnlyConfig` parameter alone leaves `$transaction` mutations unblocked (the tx builder never forwards it). `afterMutation` is `undefined` for graph-owned collections, so no persistence is scheduled; the `"source:<id>"` save key resolves to `Effect.void`.
- **Reuse the generic document-source watcher, one per existing root.** `createDocumentSourceWatcher` already takes `{ root, onReload }`; register one per startup-present root, each calling a `reloadDocumentGraph(sourceId)` closure that rebuilds and, on failure, keeps last-known-good and logs (mirrors `reloadDocumentSources`).
- **Fail read-only/ownership/initialData violations early.** Ownership conflicts and `documentGraph`-on-collection + initialData are rejected at config normalization / factory construction, not at mutation time.
- **Migrate per fragment, before merge; validate after merge.** Migrations run on each fragment's sections using that fragment's `_version` so mixed-version fragments are each brought to the current schema version first. Merge then composes same-version shapes, and schema validation runs once on the effective records. This is the corrected ordering (R9) — the challenge session tentatively chose migrate-after-merge before the `runMigrations` early-return behavior was checked. Validation stays after merge so partial overlays that are only valid once combined still pass.
- **Register all codecs for `documentGraph` in Node inference; add no `formats?` config field.** A graph source is multi-format by definition, so `inferCodecsFromConfig` registers all base codecs for a `documentGraph` source (one `if` branch). This keeps the U4 config type stable and avoids fragile glob-suffix derivation; a narrowing hint can be a non-breaking follow-up if ever needed.
- **Guard existing `documents`-only code paths when widening the source union.** Widening `NormalizedDatabaseSourceConfig` makes `loadDocumentSources`, the existing watcher-registration loop, and `documentSourceKeysByCollection` see graph sources. Each gets a `kind === "documents"` guard so existing behavior is unchanged and the graph paths are handled separately.

---

## Open Questions

### Resolved During Planning

- **Either vs Result for the transform hook?** Resolved: `Result` — the v4 name for the same bifunctor (per Effect v4 migration learning).
- **Glob: extend the hand-rolled matcher or add a library?** Resolved: add `picomatch` behind a new `glob-match.ts` seam; leave `documents`' matcher untouched.
- **How does mixed-format-by-extension work given no registry introspection?** Resolved: extract extension via `getFileExtension`, dispatch through `serializer.deserialize(raw, ext)`; unsupported extensions surface `UnsupportedFormatError`. Add explicit introspection for the public metadata helper and friendly pre-checks.
- **How is read-only enforced without a new error class?** Resolved: reuse `OperationError` with `reason: "read-only-source"` through `forbiddenOp`, gated on a derived read-only flag visible to both `buildCollection` and `makeBuildCollectionForTx` (the append-only parameter alone does not reach the transaction builder).
- **Migrate before or after merge?** Resolved (revises challenge lean): migrate per fragment before merge; validate after merge. `runMigrations` early-returns once `fileVersion >= targetVersion`, so merge-first would skip migrating older-version fragments.
- **Does Node codec inference need a `formats?` config field?** Resolved: no. Register all base codecs for a `documentGraph` source in `inferCodecsFromConfig`; keep the config type stable.

### Deferred to Implementation

- Exact name/shape of the serializer extension-introspection method (`supportedExtensions()` vs a richer descriptor) and the accessor export name — choose once the registry types are open (accessor lives in `serializer-service.ts`).
- Whether `reloadDocumentGraph` can reuse `reloadDocumentSources`' index/search-rebuild block verbatim or needs a small shared helper — decide when editing the factory.
- Exact `DocumentGraphReloadContext`/transform-context field names — finalize against the loader's actual locals.
- Whether the derived read-only flag is best expressed as a `readOnlyCollections` set threaded into `makeBuildCollectionForTx` or a marker on the normalized collection config — decide when editing the factory; either must reach the transaction builder.

---

## Output Structure

    packages/core/src/
      storage/
        document-graph-source.ts        # new: load + merge + transform + validate
      utils/
        deep-merge.ts                   # new: pure overlay merge
        glob-match.ts                   # new: picomatch wrapper
      serializers/
        serializer-service.ts           # modify: extension introspection + getSupportedExtensions accessor
        format-codec.ts                 # modify: expose registered extensions
    packages/core/tests/
      deep-merge.test.ts                # new
      glob-match.test.ts                # new
      document-graph-source.test.ts     # new
      document-graph-config.test.ts     # new
      database-document-graph.test.ts   # new (integration + watcher)
    packages/node/tests/
      document-graph.test.ts            # new (real filesystem)

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```text
load(documentGraph):
  for each root in roots (configured order):
    if missing:
      optional? skip : fail
    discover files under root via listRecursive
    keep files matching effective include AND not effective exclude
    sort matched files lexically by normalized relative path
  ordered fragments = concat(per-root matched files in root order)

  for each fragment file (in order):
    raw   = storage.read(path)
    ext   = getFileExtension(path)
    parsed = serializer.deserialize(raw, ext)          # unsupported ext -> fail
    doc   = transform.decode(parsed, context)          # Result; Left -> fail
    require doc is a plain object                       # else fail
    reject unknown top-level collection keys            # per file, pre-merge
    record contributing path per (collection,id) seen   # internal provenance

    migrate fragment sections using fragment _version   # per fragment, BEFORE merge

  effective = deepMerge(migrated fragments in order)    # objects merge; arrays/scalars/null replace
  for each declared collection section in effective:
    decode + hydrate derived ids + validate             # AFTER merge; failure -> report collection,id,paths

  return { collections, provenance }                    # read-only; no origins-for-write
```

Read-only enforcement and reload (factory):

```text
createPersistentEffectDatabase:
  graph = loadDocumentGraph(config)        # invalid -> fail creation
  reject initialData for graph-owned collections
  build graph-owned collections with forbiddenOp(reason="read-only-source") on all mutations
  watcher per startup-present root -> reloadDocumentGraph(sourceId):
    rebuild; success -> swap refs + notify watch(); failure -> keep last good + log
```

---

## Implementation Units

### U1. Pure deep-merge overlay utility

**Goal:** Provide the deterministic overlay merge used to collapse fragments into one effective document.

**Requirements:** R8

**Dependencies:** None

**Files:**
- Create: `packages/core/src/utils/deep-merge.ts`
- Test: `packages/core/tests/deep-merge.test.ts`

**Approach:**
- Pure function merging an ordered list (or pair) of plain objects; later wins.
- Objects merge recursively; arrays, scalars, and `null` replace wholesale.
- Non-object inputs at a key replace; never mutate inputs (return new objects).

**Patterns to follow:**
- Plain pure util style in `packages/core/src/utils/` (e.g. `nested-path.ts`); no Effect dependency.

**Test scenarios:**
- Happy path: two objects with disjoint keys → union.
- Happy path: nested object + nested object → recursive merge, later scalar wins.
- Edge case: array + array → later array replaces (not concatenated/merged).
- Edge case: scalar overwritten by object and object overwritten by scalar.
- Edge case: `null` replaces a prior object value; later `null` wins.
- Edge case: empty list / single fragment → returns equivalent object; inputs not mutated.
- Edge case: three-fragment order — last fragment wins on conflicting leaf.

**Verification:**
- Merge semantics match R8 exactly; inputs are never mutated.

---

### U2. Glob matching seam via picomatch

**Goal:** Real glob include/exclude matching for graph discovery without disturbing the existing `documents` matcher.

**Requirements:** R2, R3

**Dependencies:** None

**Files:**
- Create: `packages/core/src/utils/glob-match.ts`
- Create: `packages/core/tests/glob-match.test.ts`
- Modify: `packages/core/package.json` (add `picomatch` dependency; add `@types/picomatch` dev dependency)

**Approach:**
- Thin wrapper exposing `isMatch(relativePath, pattern)` / `matchesAny(relativePath, patterns)` over `picomatch`.
- Match against normalized root-relative paths; never match outside the root.
- Decide and pin `picomatch` dot-handling explicitly (e.g. `{ dot: true }`) so dotfile matching is intentional rather than inheriting a default that diverges from user expectation; document the choice in the wrapper.
- Keep the wrapper pure and runtime-agnostic (pure JS only — no Node imports).

**Patterns to follow:**
- `relativeToRoot` / `normalizePath` usage in `packages/core/src/storage/source-config.ts` and `packages/core/src/utils/path.ts`.

**Test scenarios:**
- Happy path: `**/*.yaml` matches nested `a/b/c.yaml`, not `a/b/c.json`.
- Happy path: brace group `**/*.config.{json,yaml,toml}` matches each listed extension.
- Edge case: recursive `**` matches at depth 0 and depth N.
- Edge case: exclude pattern removes a path that include matched.
- Edge case: path escaping the root (`../x`) never matches.
- Edge case: empty pattern list → no match.
- Edge case: dotfile (`.config.yaml` / nested `.hidden/x.yaml`) matches per the pinned dot policy — asserts the intentional behavior.

**Verification:**
- `picomatch` resolves; brace + recursive patterns behave per R2; excludes subtract from includes per R3.

---

### U3. Serializer extension introspection + generic metadata helper

**Goal:** Expose which document extensions the active serializer registry can decode, and a product-agnostic public helper for it.

**Requirements:** R4, R5, R17

**Dependencies:** None

**Files:**
- Modify: `packages/core/src/serializers/serializer-service.ts` (add introspection to `SerializerRegistryShape`; export a `getSupportedExtensions` Effect accessor alongside the `SerializerRegistry` tag)
- Modify: `packages/core/src/serializers/format-codec.ts` (`makeSerializerLayer` + `mergeSerializerWithPluginCodecs` expose registered extensions)
- Modify: `packages/core/src/index.ts` (export the accessor + type)
- Test: extend `packages/core/tests/` serializer coverage (no standalone module/test — fold into the serializer-service suite)

**Approach:**
- Add a method to enumerate registered extensions (e.g. `supportedExtensions()`); implement in both `makeSerializerLayer` and `mergeSerializerWithPluginCodecs` so plugin codecs are included (active-registry semantics).
- Export a thin `getSupportedExtensions` Effect accessor from `serializer-service.ts` returning the registry's extensions in a stable, product-neutral shape. No basename/discovery-pattern policy — extensions only. No separate module (would fail the deletion test).

**Patterns to follow:**
- `SerializerRegistry` `Context.Service` shape; existing `extensionMap` construction in `format-codec.ts`.

**Test scenarios:**
- Happy path: registry built from base codecs lists all their extensions (json, yaml, yml, toml, …).
- Happy path: plugin/merged registry includes plugin-added extensions (active registry, not built-in only).
- Edge case: empty registry → empty extension list.
- Edge case: helper output is product-agnostic (no patterns/basenames), stable ordering.

**Verification:**
- Active-registry extensions are introspectable; the public helper returns extensions only and is exported from core.

---

### U4. documentGraph config types, normalization, and errors

**Goal:** Define the `documentGraph` config surface, normalize it, enforce ownership/optionality/include rules, and add typed errors.

**Requirements:** R1, R2, R3, R13, R14, R17

**Dependencies:** None (normalization validates include *presence/structure*, not glob matching; matching is U2, used by the loader U5)

**Files:**
- Modify: `packages/core/src/storage/source-config.ts` (add `DocumentGraphSourceConfig`, `NormalizedDocumentGraphSourceConfig`, extend the `DatabaseSourceConfig` + `NormalizedDatabaseSourceConfig` unions, add a `documentGraph` branch in `normalizeSourceConfig`)
- Modify: `packages/core/src/storage/document-source.ts` (add a `source.kind === "documents"` guard in `loadDocumentSources` so widening the normalized union does not break the documents loader)
- Modify: `packages/core/src/errors/source-errors.ts` (add `DocumentGraphSourceError` with a distinct field/variant for transform defects; extend the `SourceError` union)
- Modify: `packages/core/src/types/database-config-types.ts` (surface the new config in the public source union)
- Modify: `packages/core/src/index.ts` (export new config + error types)
- Test: `packages/core/tests/document-graph-config.test.ts`

**Approach:**
- Config shape (illustrative): `{ id, kind: "documentGraph", collections?, roots: [{ id?, root, optional?, include?, exclude? }], include?, exclude?, transform? }`. No `outbox`, no `format`. `collections` defaults to `"all"` when omitted.
- Normalize: resolve `collections: "all"`; require an effective include for every root — satisfied by graph-level `include` or that root's own `include`; fail when both are absent for any root (R2); root `include` overrides graph `include`; combine graph + root `exclude`; default `optional: false`.
- Reuse `collectionSourceOwners` to enforce one-owner-per-collection across all source kinds (R13); a graph + non-graph owner conflict fails.
- `DocumentGraphSourceError` carries `sourceId`, `path`, `message`, optional `collection`/`recordId`/`contributingPaths`, and a `cause`/kind distinguishing a transform-returned failure from an unexpected thrown transform defect.

**Execution note:** Start with failing normalization tests for the new ownership/include rules.

**Patterns to follow:**
- Existing `documents` normalization branch and `SourceConfigError` throws in `source-config.ts`; `Data.TaggedError` error style in `source-errors.ts`.

**Test scenarios:**
- Happy path: graph source targeting `"all"` normalizes roots in order with resolved include/exclude.
- Happy path: root-level `include` overrides graph-level include; excludes combine.
- Edge case: no include at graph level and a root without include → fails (explicit-include rule).
- Edge case: `optional` defaults to false; explicit `optional: true` preserved.
- Error path: a collection owned by both a `documentGraph` and a `documents` source → `SourceConfigError` naming both.
- Error path: graph source referencing an undeclared collection → fails with source id + collection.

**Verification:**
- Normalization output is fully resolved; ownership, include-required, and override/combine rules hold.

---

### U5. documentGraph loader: discover, transform, merge, validate

**Goal:** The core read-only deep module that turns ordered fragments into validated effective collection maps with internal provenance.

**Requirements:** R4, R5, R6, R7, R8, R9, R10, R14

**Dependencies:** U1, U2, U3, U4

**Files:**
- Create: `packages/core/src/storage/document-graph-source.ts`
- Modify: `packages/core/src/index.ts` (export `loadDocumentGraphSources` + loaded type)
- Test: `packages/core/tests/document-graph-source.test.ts`

**Approach:**
- `loadDocumentGraphSources(normalized): Effect<…, StorageAdapter | SerializerRegistry>` mirroring `loadDocumentSources` structure.
- Per root in order: existence check (missing → fail unless optional), `listRecursive`, filter by effective include/exclude (U2), sort lexically; concat across roots in root order.
- Per fragment: read; `getFileExtension`; `serializer.deserialize(raw, ext)` (unsupported ext → path-attributed fail, R5); apply pure transform → `Result` (failure → wrap with path; thrown → unexpected-defect wrap, R6); require plain object post-transform; reject unknown top-level keys per file (R7); run per-collection migrations on the fragment's sections using the fragment's own `_version` so the fragment is at current schema version (R9); track contributing paths per `(collection,id)`.
- Deep-merge the migrated fragments (U1); per collection decode + hydrate derived ids (reuse `derived-id.ts`) + validate (R10) on the effective record. Validation failure includes collection, record id, contributing paths. Migration runs before merge (not after) because `runMigrations` early-returns once `fileVersion >= targetVersion`, so a post-merge effective `_version` would skip migrating records contributed by older-version fragments.
- Empty roots / zero-match globs contribute nothing (R14). Empty graph yields empty collection maps.

**Execution note:** Test-first for the merge-then-validate pipeline and the per-file unknown-collection ordering.

**Patterns to follow:**
- `loadDocumentSources` / `loadDocumentFile` / `loadCollectionSection` in `document-source.ts`; `deserializeDocument` extension dispatch; `origin-index.ts` for path attribution; `Effect.result` + `Result.isFailure` for the transform seam.

**Test scenarios:**
- Happy path: two roots, later root overlays earlier root on a shared `(collection,id)`; deep-merge of nested objects; arrays replace.
- Happy path: lexically later file within one root overlays earlier file.
- Happy path: mixed formats — YAML + JSONC + TOML fragments compose into one graph with identical semantics.
- Happy path: a partial overlay invalid alone becomes valid after merging with a base record.
- Edge case: empty optional root, existing-but-empty root, and zero-match glob all yield empty contribution, no failure.
- Edge case: `_version` differs across fragments → each fragment is migrated to current version before merge (a `_version: 1` fragment and a `_version: 2` fragment both end at the current schema in the merged result); missing `_version` treated as 0.
- Error path: a record contributed only by an older-version fragment is fully migrated in the effective graph (guards against the merge-first regression).
- Error path: matched file with unregistered extension → fail naming the path.
- Error path: decode transform returns `Result` failure → fail naming the path; transform throws → unexpected-defect wrap.
- Error path: post-transform value is not an object (e.g. raw JSONL array) → fail naming the path.
- Error path: unknown top-level collection key in one fragment → fail per file, before merge.
- Error path: final effective record fails schema validation → error names collection, record id, and contributing file paths.
- Edge case: physical `id` field in a derived-id payload remains invalid (parity with `documents`).

**Verification:**
- Pipeline order is decode → transform → unknown-key check → per-fragment migrate → merge → validate; all R4–R10/R14 behaviors hold with path-attributed errors.

---

### U6. Wire documentGraph into the persistent database factory (read-only)

**Goal:** Load graph sources at startup, expose graph-owned collections as read-only, reject `initialData`, and ensure no writes are scheduled.

**Requirements:** R11, R12, R13, R15, R18

**Dependencies:** U5

**Files:**
- Modify: `packages/core/src/factories/database-effect.ts`
- Test: `packages/core/tests/database-document-graph.test.ts` (load + read-only + initialData rejection; reload in U7)

**Approach:**
- In `createPersistentEffectDatabase`, after normalization, call `loadDocumentGraphSources` alongside `loadDocumentSources`; merge results into the per-collection refs. Invalid load propagates as creation failure (R15).
- Derive a `readOnlyCollections` set from the normalized graph sources. Build graph-owned collections with `forbiddenOp(reason: "read-only-source")` on every mutation method and `afterMutation: undefined`. The `"source:<id>"` save key for a graph source resolves to `Effect.void`.
- **Thread `readOnlyCollections` into `makeBuildCollectionForTx`** so transaction-scoped collections also use `forbiddenOp`. The tx builder does not forward `appendOnlyConfig`, so read-only must travel as its own signal (R11) — verified by an explicit `$transaction` test.
- Guard the existing `documents`-only computations against the widened union: filter `documentSourceKeysByCollection` construction (around `database-effect.ts:2141`) to `kind === "documents"` so graph collections are not added there.
- Reject `initialData` for graph-owned collections before building refs (R12) — fail with a clear error.

**Execution note:** Start with a failing test asserting `create`/`update`/`delete` on a graph-owned collection reject before state changes.

**Patterns to follow:**
- `forbiddenOp` append-only blocking and `documentSourceKeysByCollection` construction in `database-effect.ts`; the existing `loadDocumentSources` startup block and `makeSaveEffect` `"source:"` branch.

**Test scenarios:**
- Happy path: graph-backed collections load merged data and are queryable (`query`, `findById`).
- Error path: `create`/`update`/`delete`/`upsert` (and `*Many`) on a graph-owned collection → `OperationError` with `reason: "read-only-source"`; in-memory data unchanged.
- Error path: mutation of a graph-owned collection inside `$transaction` fails at the operation, transaction does not commit a change.
- Error path: `initialData` supplied for a graph-owned collection → database creation fails with a clear message.
- Error path: invalid initial graph (bad fragment) → `createPersistentEffectDatabase` fails.
- Integration: no file writes occur on attempted mutation or on flush for graph sources (store unchanged; `writeDebounce: 60_000`).

**Verification:**
- Graph-owned collections are read everywhere and writable nowhere; invalid startup fails; no save is scheduled for graph sources.

---

### U7. Watcher reload with last-known-good

**Goal:** Rebuild the graph on watched changes; keep serving the previous valid graph when a reload is invalid.

**Requirements:** R16

**Dependencies:** U6

**Files:**
- Modify: `packages/core/src/factories/database-effect.ts` (`reloadDocumentGraph` closure + per-root watcher registration)
- Test: `packages/core/tests/database-document-graph.test.ts` (reload cases)

**Approach:**
- Filter the **existing** watcher-registration loop (around `database-effect.ts:2453`) to `kind === "documents"` so it no longer assumes every source has a single `root`; add a parallel graph loop that registers one `createDocumentSourceWatcher({ root, onReload: reloadDocumentGraph(sourceId) })` per startup-present root of each graph source.
- `reloadDocumentGraph` rebuilds via `loadDocumentGraphSources`; on success swaps the collection refs **and** rebuilds indexes/search indexes together so refs and indexes never diverge (mirror `reloadDocumentSources`), then publishes reload notifications to existing `watch()` subscribers; on failure, retains current refs/indexes untouched and logs (`Effect.catch` → `Effect.logWarning`), keeping last-known-good.
- Roots absent at startup are not watched (no late detection).

**Patterns to follow:**
- `reloadDocumentSources` + index/search rebuild block and watcher registration loop in `database-effect.ts`; Effect v4 watcher fiber-ownership rules from the migration learning (scoped watch fork, detached debounce; capture context before the sync callback).

**Test scenarios:**
- Integration: start valid → edit a fragment to new valid content → after debounce, queries reflect new data.
- Integration: start valid → edit a fragment to invalid content → after debounce, queries still return the last valid graph; a warning is logged.
- Integration: fix the previously-invalid fragment → queries reflect the corrected graph.
- Edge case: an optional root missing at startup is not picked up when it later appears (no late detection).

**Verification:**
- Valid reload replaces data and notifies watchers; invalid reload preserves last-known-good; absent-at-startup roots are not detected later.

---

### U8. Node codec inference and convenience wiring

**Goal:** Let `@proseql/node` load a `documentGraph` from the real filesystem with the right codecs registered, no manual codec assembly.

**Requirements:** R4, R18

**Dependencies:** U5, U6

**Files:**
- Modify: `packages/core/src/serializers/infer-codecs.ts` (handle `documentGraph` sources)
- Modify: `packages/node/src/` convenience layer (`makeNodePersistenceLayer` path)
- Test: `packages/node/tests/document-graph.test.ts`

**Approach:**
- Add a `documentGraph` branch to `inferCodecsFromConfig` that registers **all** base codecs for the source (a graph is multi-format by definition). The current `else` arm calls `addFormat(source.format ?? getFileExtension(source.file))`, which a graph source — having neither `format` nor `file` — would resolve to `""`, registering zero codecs and silently breaking loading. No `formats?` config field is added (keeps U4's type stable).
- Ensure real-filesystem discovery (`listRecursive`) and per-root watching work through `NodeStorageLayer`.

**Patterns to follow:**
- Existing `documents` handling in `infer-codecs.ts`; `makeNodePersistenceLayer` composition; Node integration test style in `packages/node/tests/`.

**Test scenarios:**
- Happy path: `createNodeDatabase` loads a `documentGraph` from nested real files across two roots without manually passing codecs.
- Happy path: mixed-format fragments (YAML + JSON) on disk compose correctly via inferred codecs.
- Error path: mutation attempt on a graph-backed collection rejects (read-only) end-to-end through Node.
- Edge case: optional missing root on disk → empty contribution, no failure.

**Verification:**
- Node users adopt `documentGraph` through the convenience API; codecs are inferred; read-only holds end-to-end.

---

### U9. Documentation for documentGraph (Core + Node)

**Goal:** Document the read-only overlay source: discovery, merge, transform, read-only semantics, and v1 limits.

**Requirements:** R6, R8, R10, R11, R16, R17, R18

**Dependencies:** U5, U6, U7, U8

**Files:**
- Modify: `packages/core/README.md`
- Modify: `packages/node/README.md`
- Modify: `README.md` (short mention so document sources docs don't imply graphs are unavailable)

**Approach:**
- Explain ordered roots, glob includes, mixed formats by extension, the pure `Result` decode transform, deep-merge overlay rules, per-fragment migration before merge with validation after merge, and read-only behavior (mutations fail).
- State v1 limits: invalid startup fails; invalid reload keeps last-known-good; missing roots fail unless optional; CLI and lifecycle events deferred; no delete syntax; provenance is internal.
- Keep examples product-neutral (e.g. `**/*.config.{yaml,json,toml}`), not Korri-specific.

**Patterns to follow:**
- Existing document-source sections in `packages/core/README.md` and `packages/node/README.md`.

**Test scenarios:**
- Test expectation: none — documentation only.

**Verification:**
- Core and Node READMEs describe `documentGraph` accurately with neutral examples; root README no longer implies overlays are unavailable.

---

## System-Wide Impact

- **Interaction graph:** New source kind touches config normalization, startup load, collection construction (`forbiddenOp`), persistence keying, and watcher registration in `database-effect.ts`. Serializer registry gains an introspection method consumed by the loader and the public helper.
- **Error propagation:** Loader failures are typed Effects propagated as creation failures (invalid startup). Reload failures are caught and logged, never propagated (last-known-good). Read-only mutations fail with `OperationError` before state change.
- **State lifecycle risks:** Reload must not race itself or a (non-existent) write path; reuse the generic debounced watcher and swap refs atomically. Last-known-good means refs are only replaced on successful rebuild.
- **API surface parity:** `documents` source semantics, errors, and write path are explicitly unchanged. The new serializer introspection method is additive.
- **Integration coverage:** Cross-layer behaviors proven by integration/Node tests — read-only enforcement end-to-end, mixed-format on-disk composition, watcher last-known-good, no-write-on-mutation.
- **Unchanged invariants:** Existing `documents`, `file`, `directory`, `appendOnly` source behaviors; existing serializer `serialize`/`deserialize` contract; derived-id hydration/validation rules.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `picomatch` behavior differs from the repo's prior hand-rolled matcher, surprising users | Confine `picomatch` to the new `glob-match.ts` used only by `documentGraph`; leave the `documents` matcher untouched; cover brace/recursive/exclude/escape cases in U2. |
| Serializer introspection change ripples into REST/RPC/browser packages | Keep the new method additive on `SerializerRegistryShape`; build it in both `makeSerializerLayer` and `mergeSerializerWithPluginCodecs`; run whole-repo `tsc --build`. |
| Read-only enforcement missed on a CRUD variant (e.g. `*WithRelationships`) lets a mutation through | Apply `forbiddenOp` to every mutation method and the transaction builder; U6 tests assert each variant rejects. |
| Watcher fiber-ownership mistake breaks debounce/tests | Follow Effect v4 migration learning: scoped watch fork, detached debounce, capture context before sync callback; reuse the generic watcher unchanged. |
| Migrating partial overlay fragments independently may hit transforms that assume complete records | U5 migrates per fragment *before* merge (required because `runMigrations` early-returns on `>= target`); covers differing `_version` across fragments and a record contributed only by an older-version fragment. If a transform genuinely cannot operate on a partial fragment, surface it as a path-attributed migration error rather than silently skipping. |
| Read-only enforcement passes in normal CRUD but leaks inside `$transaction` (tx builder does not forward the append-only parameter) | Carry read-only as a `readOnlyCollections` signal threaded into `makeBuildCollectionForTx`; U6 asserts the `$transaction` mutation path rejects explicitly. |
| Node codec inference from glob patterns is fragile | Prefer an explicit format/codec hint on the graph config over suffix derivation; decide in U8. |

---

## Sources & References

- Origin handoff: `docs/handoffs/korri-config-graph-document-source-handoff.md`
- Prior source-model plan: `docs/plans/2026-05-21-001-feat-multi-collection-document-source-plan.md`
- Effect v4 conventions: `docs/solutions/build-errors/effect-v4-foundation-migration-2026-05-06.md`
- Key code: `packages/core/src/storage/source-config.ts`, `packages/core/src/storage/document-source.ts`, `packages/core/src/factories/database-effect.ts`, `packages/core/src/storage/persistence-effect.ts`, `packages/core/src/serializers/format-codec.ts`
