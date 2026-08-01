---
title: "refactor: Optimize the browser WASM engine"
type: refactor
status: active
date: 2026-07-31
deepened: 2026-07-31
---

# refactor: Optimize the browser WASM engine

## Summary

Make the Rust/WASM implementation practical as proseQL's single browser engine by establishing reproducible cross-engine measurements, reducing avoidable boundary work, replacing whole-state mutation and transaction bookkeeping with deltas, and enforcing browser performance budgets without changing public TypeScript behavior.

---

## Problem Frame

The Rust/WASM engine is functionally ready for browser use, but the first paired benchmark run found a geometric-mean throughput of 7.6% of the TypeScript engine across 51 engine-facing cases: roughly 13.2× slower overall. Ordinary indexed and unindexed reads were commonly 5–29× slower, single writes 27–46× slower, function-predicate bulk mutations 546–1,087× slower, and the three-operation transaction 326× slower. One complex nested query reached parity, showing that Rust computation itself is not uniformly the limiting factor.

The current binding sends JSON strings through WASM and recursively transforms every value to preserve `undefined`. Mutations also rebuild indexes and clone reactive state, while the JavaScript transaction facade copies the full database across the boundary multiple times. The existing benchmark harness only selects the TypeScript factory directly, mutates fixtures across samples, and retains database instances for the lifetime of a full run; the initial Rust comparison therefore required an ad hoc factory substitution and suite isolation. Optimization needs a durable, apples-to-apples measurement surface before changing these high-risk paths.

---

## Requirements

- R1. At 10,000 records per collection, every required read/query benchmark must deliver at least 50% of the paired TypeScript engine throughput (no more than 2× slower).
- R2. At 10,000 records per collection, every required write and transaction benchmark must deliver at least 20% of the paired TypeScript engine throughput (no more than 5× slower).
- R3. The p95 wall-clock latency of normal browser interactions must stay below 50 ms: single-ID read, paginated query returning at most 100 records, single create/update/delete, declarative bulk mutation of approximately 100 records, function-predicate bulk mutation of approximately 100 records, and a three-operation transaction.
- R4. The 100,000-record workload remains throughput-non-blocking but safety-blocking: in a fresh process its peak WASM memory may not exceed 110% of the U1 pre-optimization 100,000-record baseline, and repeating the bounded workload after the first high-water mark may grow WASM memory by no more than 5%; crashes, missing results, and retained database handles fail the gate.
- R5. The public Promise-first, Effect, and browser APIs and their TypeScript inference must remain unchanged.
- R6. Observable semantics must remain unchanged, including insertion and sort order, `undefined`/`null`/missing distinctions, exact tagged error payloads, validation, hooks, callback order, transaction rollback, immediate transaction hook timing, transaction change-event coercion, partial relationship side effects, persistence, and reactive cleanup.
- R7. Performance results must be reproducible and machine-readable, separating TypeScript execution, WASM boundary encoding/transfer/decoding, Rust engine execution, callback overhead, initialization, actual p50/p95/p99 values computed from raw samples, JavaScript heap, WASM linear-memory high-water marks, bundle size, and browser startup. A blocking case requires at least 30 measured samples per engine.
- R8. The optimized production build must not materially regress browser delivery: compressed WASM size may not increase by more than 5%, cold startup p95 may not increase by more than 10%, fresh-process WASM linear-memory peak may not increase by more than 5%, and post-GC retained JavaScript heap may not increase by more than 5% where the browser exposes a reliable measurement. Warm-state throughput and cold startup are reported and gated separately.
- R9. The existing parity gate, Rust conformance suites, Node/Bun package checks, and real-browser persistence/reactivity smoke tests must remain green throughout the optimization.
- R10. The browser continues to ship one supported runtime engine: Rust/WASM. No TypeScript fallback or engine-selection API is introduced for consumers.

The blocking workload manifest is fixed by this plan; U1 encodes it without weakening or reclassifying cases:

| Category | Required benchmark cases | Gate |
|---|---|---|
| CRUD writes | `create (single)`, `createMany (batch of 100)`, `update (single)`, `updateMany (batch ~100)` in both declarative and function-predicate forms, `delete (single)`, `deleteMany (batch ~100)` in both forms, `upsert (create path)`, `upsert (update path)` | R2; the named normal interactions also satisfy R3 |
| Filters | equality, range, and compound `$and` queries at 10,000 records | R1; paginated/≤100-result variants satisfy R3 |
| Sorts | single-field ascending/descending and multi-field two-/three-key sorts | R1 |
| Population | single ref, inverse, nested two-level, multiple refs, and nested three-level | R1 |
| Selection | one field, two fields, three fields, most fields, no projection, and selection with a filter | R1 |
| Pagination | beginning, middle, end, 100-row page, sorted page, and filtered page | R1; ≤100-result cases satisfy R3 |
| Combined queries | filter/sort/select/page; filter/sort/populate/select/page; nested populate/sort/page; complex filter/multi-populate/sort/select/page | R1 |
| Scaling reads | `findById`, unindexed filter, and indexed filter at 100, 1,000, and 10,000 records | R1; 10,000-record `findById` satisfies R3 |
| Transactions | direct create/update/delete and the equivalent three-operation `$transaction` | R2; transaction satisfies R3 |
| Persistence | debounced coalescing of 100 mutations and one explicit flush | R2 |
| Callback characterization | computed field, custom predicate/operator, locale collator, and one before/after hook workload | Non-regression characterization; U7 becomes blocking only if required to meet R1–R3 |
| Stress | scaling reads plus one single write and one three-operation transaction at 100,000 records | R4 only |

---

## Scope Boundaries

- No new database features or public query/callback DSL.
- No weakening of validation, uniqueness, foreign-key, transaction, hook, persistence, or reactive guarantees for benchmark gains.
- No permanent second browser engine and no consumer-visible transport selector.
- No napi-rs addon; this work targets the browser WASM path. Node/Bun benefit only where they share the same binding.
- No worker, `SharedArrayBuffer`, or cross-origin-isolation requirement. The engine must continue working on ordinary browser origins.
- No storage-format migration. Boundary sentinels are an internal wire concern; persisted records remain engine-independent.
- The 100,000-record stress workload is characterized and protected from catastrophic failure, but the 2×/5× throughput targets apply at 10,000 records.

### Deferred to Follow-Up Work

- Native Rust/Android benchmarking and korrid-specific optimization: separate work in the korri integration track.
- Columnar result formats, an expression DSL for replacing JavaScript callbacks, and worker-thread execution: reconsider only if the bounded transport and callback changes in this plan cannot meet the browser target.
- General reentrancy redesign for hooks that synchronously call the same database: preserve the existing supported contract here and capture broader callback reentrancy as separate correctness work if characterization exposes a reachable panic.

---

## Context & Research

### Relevant Code and Patterns

- `packages/engine/src/database.ts` owns the Promise-first facade, JSON dispatch, temporary transaction runtime, persistence snapshots, and callback registration. `EngineRuntime.invoke` currently adds a microtask around an otherwise synchronous WASM dispatch.
- `packages/engine/src/boundary-values.ts` recursively encodes and decodes `undefined` plus reserved-key collisions on every command and result.
- `crates/proseql-wasm/src/bridge.rs`, `crates/proseql-wasm/src/runtime.rs`, and `crates/proseql-wasm/src/command.rs` define the internal string-based command/response ABI and panic-to-defect boundary.
- `crates/proseql-engine/src/collection.rs` rebuilds all declared indexes after successful mutations; batch operations already amortize this to one rebuild per batch.
- `crates/proseql-engine/src/relationships/mod.rs` uses whole-collection snapshots on several mutation paths to preserve foreign-key rollback semantics.
- `crates/proseql-engine/src/reactive/mod.rs` clones snapshots of every collection after writes, including when only one collection changed.
- `crates/proseql-engine/src/transactions/mod.rs` snapshots all collections at transaction start and again before each mutation to discover changed collections.
- `packages/effect/src/database.ts` emulates function-predicate `updateMany` and `deleteMany` by querying, filtering in JavaScript, and issuing one WASM mutation per matching row; the relationship variant already demonstrates the safer query/filter/ID-set/bulk-command pattern.
- `bench/` provides deterministic tinybench fixtures, JSON reports, scaling sizes, and transaction-overhead reporting, but currently binds directly to `@proseql/core` and lacks resource teardown and paired-engine ratio gates.
- `packages/browser/tests/browser-smoke.mjs` and its Vite/plain-module fixtures are the existing real-browser execution pattern.

### Institutional Learnings

- TypeScript types remain the contract and Rust implements the semantics; an optimization that changes visible behavior is a correctness regression.
- Update paths must retain schema decoding rather than replacing it with validation-only shortcuts because transforms and TypeScript parity depend on repeated decode behavior.
- Bulk operations already rebuild indexes once per batch; optimize incremental maintenance without decomposing a batch into single operations.
- Hook and callback order, transaction hook timing, transaction-wide `Update` notifications, and documented partial relationship artifacts are authoritative even when they are counterintuitive.
- The phase-two corpus currently executes 79 applicable files with 2,353 passing assertions; the 18 skipped files are internal primitives or compile-time-only suites covered elsewhere.

### External References

- wasm-bindgen arbitrary-data guidance recommends measuring JSON strings against `serde-wasm-bindgen`; either can be faster depending on payload and browser: https://wasm-bindgen.github.io/wasm-bindgen/reference/arbitrary-data-with-serde.html
- `serde-wasm-bindgen` supports native JavaScript values and a JSON-compatible serializer, but its `undefined`/`null` mappings require explicit parity tests: https://docs.rs/serde-wasm-bindgen/latest/serde_wasm_bindgen/
- wasm-bindgen string parameters incur UTF-8 encoding, copying, allocation, and return decoding: https://rustwasm.github.io/docs/wasm-bindgen/reference/types/str.html
- Cargo release-profile controls and the Rust/WASM size guide establish LTO, codegen-unit, panic, and profiling-build trade-offs: https://doc.rust-lang.org/cargo/reference/profiles.html and https://rustwasm.github.io/docs/book/reference/code-size.html
- Binaryen optimization must run on the post-bindgen `*_bg.wasm` artifact and be measured for speed as well as size: https://rustwasm.github.io/docs/wasm-bindgen/reference/optimize-size.html
- Browser wall-clock and memory measurements use `performance.now()`, DevTools/Memory Inspector, and best-effort memory APIs without requiring cross-origin isolation: https://developer.mozilla.org/en-US/docs/Web/API/Performance/now and https://developer.chrome.com/docs/devtools/memory-inspector

---

## Key Technical Decisions

- **The comparison baseline is the direct `@proseql/core` Effect API; it is not wrapped by `@proseql/effect`.** The Rust path uses `@proseql/effect`, because that is its supported parity surface. U1 re-establishes every starting ratio with this permanent harness; the ad hoc 546–1,087× predicate figures remain problem evidence, not post-U1 acceptance baselines.
- **Thresholds apply per required case, not only to an aggregate score.** Geometric means remain useful summaries, but they cannot hide a catastrophic bulk-write or transaction outlier.
- **Measurement precedes each structural optimization.** Every implementation unit records encode, WASM call, decode, engine, callback, memory, and artifact deltas so the next change attacks the measured dominant cost.
- **The internal WASM ABI may change; public APIs may not.** One internal boundary-value codec owns command inputs, responses, watch delivery, registered callbacks, `undefined`/collision handling, and tagged errors. Candidate transports are exercised behind a benchmark-only selector beneath that codec, and production ends with one transport.
- **Transport selection is bounded and deterministic.** Compare an optimized JSON fast path with direct native JavaScript values first. A candidate must pass parity and a second confirmation run. If both meet every target within 5% of one another, choose the simpler/smaller implementation; if their wins split by payload class, a hybrid small-value/bulk-result path is allowed only when its aggregate complexity is lower than a general byte protocol. Add a byte buffer only when neither candidate reaches the read target.
- **Function predicates stay public and scalar.** Internally, the Effect adapter resolves them once in JavaScript and sends one ID-set bulk mutation rather than issuing one WASM write per matching entity. User callback order and thrown errors remain unchanged.
- **Mutation bookkeeping uses one shared change-set seam.** Every low-level entity insertion, replacement, patch, and removal—including trusted relationship cascade helpers—records collection, before/after image, insertion position, and index/reactive deltas. Ordinary mutations use the change set for rollback and synchronization; U6 extends the same seam into a transaction journal. Repeated schema decode and constraint checks remain intact.
- **Transactions become stateful internal sessions.** The JS callback may still await arbitrary Effects between operations. WASM retains a single-writer transaction session and an undo journal, each operation observes prior transaction writes, hooks run at their current time, commit emits the current collection-level `Update` behavior, and rollback replays deltas without copying the database through JavaScript.
- **Persistence and reload work is serialized behind an active transaction.** Background reload, debounce flush, and close coordinate with the session rather than committing stale state or dropping a live transaction.
- **Callback batching is internal and conditional.** Public callback signatures do not change. Computed/predicate callback contexts may be delivered to a JavaScript wrapper in batches only if callback profiling remains a target blocker after the core transport work.
- **Compiler flags are not treated as the solution.** A measured WASM-specific release profile and post-bindgen Binaryen pass land early, but architectural work continues until the runtime targets pass.
- **CI uses paired medians with adequate samples.** Three interleaved TypeScript/WASM trials on the same runner reduce shared-host noise, and each blocking case auto-scales its measurement window to at least 30 samples per engine. R1/R2 measure warmed steady state; a separate fresh-Chromium gate enforces cold startup, the 50 ms interaction budget, and separate JS-heap/WASM-memory budgets.
- **Parity checksums operate on decoded application values.** Canonical hashing sorts object keys while representing explicit `undefined`, missing keys, `null`, array holes, and reserved sentinel-shaped objects as distinct values; wire bytes are never used as the semantic checksum.

---

## Open Questions

### Resolved During Planning

- **What is optimized enough?** At 10,000 records: reads/queries within 2×, writes/transactions within 5×, and normal browser interaction p95 below 50 ms.
- **What is the comparison engine?** The existing TypeScript runtime exposed by `@proseql/core`.
- **Should the TypeScript browser engine remain as a fallback?** No; the browser supports one Rust/WASM engine.
- **Are hooks excluded from correctness?** No. Hook behavior remains parity-gated. Hook-free interactions define the primary 50 ms UI budget, while representative hook/computed/collator workloads are separately characterized and must not regress.
- **Does transaction optimization permit collecting all operations before execution?** No. Existing callbacks may await and branch on earlier transaction results, so the implementation uses a stateful session rather than an upfront operation batch.
- **Can transaction event types become more precise?** No. Preserve the existing collection-level `Update` event artifact for compatibility.
- **Can schema validation be skipped on hot update paths?** No. Repeated decode behavior is part of parity.

### Deferred to Implementation

- **Which production transport wins?** Select optimized JSON, direct native JavaScript values, or a large-result byte buffer from measured browser results after U1 and U2; this cannot be decided responsibly from generic wasm-bindgen guidance.
- **Does callback batching need to ship?** Implement U7 only when callback-heavy browser measurements miss the stated budgets after U3–U6.
- **Which release profile minimizes total user cost?** Compare speed- and size-oriented profiles plus Binaryen levels; select from runtime, compressed size, and startup evidence rather than a fixed compiler folklore setting.

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```mermaid
flowchart LR
    A[Paired TypeScript and WASM workload] --> B[Stage timings and memory]
    B --> C{Dominant cost}
    C -->|Build/runtime overhead| D[WASM release and Promise path]
    C -->|Transfer| E[Measured transport candidates]
    C -->|Mutation state work| F[Delta indexes and reactive state]
    C -->|Bulk adapter fan-out| G[One ID-set bulk command]
    F --> H[Undo journal]
    E --> I[Stateful transaction session]
    G --> I
    H --> I
    I --> J{Targets pass?}
    J -->|Callback cases still fail| K[Internal callback batching]
    J -->|Yes| L[Browser and CI performance gate]
    K --> L
```

Implementation dependencies:

```mermaid
flowchart LR
    U1 --> U2 --> U3
    U1 --> U4
    U1 --> U5
    U3 --> U6
    U4 --> U6
    U5 --> U6
    U3 --> U7
    U6 --> U7
    U2 --> U8
    U3 --> U8
    U4 --> U8
    U5 --> U8
    U6 --> U8
    U7 --> U8
```

---

## Implementation Units

### U1. Establish the paired performance contract

**Goal:** Replace the ad hoc comparison with deterministic TypeScript-versus-Rust/WASM measurements that identify where time and memory are spent and encode the accepted budgets.

**Requirements:** R1, R2, R3, R4, R7, R8

**Dependencies:** None

**Files:**
- Modify: `bench/utils.ts`
- Modify: `bench/runner.ts`
- Modify: `bench/crud.bench.ts`
- Modify: `bench/query-pipeline.bench.ts`
- Modify: `bench/scaling.bench.ts`
- Modify: `bench/transactions.bench.ts`
- Create: `bench/engines.ts`
- Create: `bench/comparison.ts`
- Create: `bench/performance-contract.ts`
- Create: `bench/browser-runner.ts`
- Create: `bench/baselines/browser-wasm.json`
- Test: `bench/runner.test.ts`
- Test: `bench/performance-contract.test.ts`
- Test: `packages/browser/tests/browser-performance.test.ts`

**Approach:**
- Define one engine-neutral workload contract and two factories: TypeScript via `@proseql/core` and Rust/WASM via `@proseql/effect`.
- Use tinybench's untimed per-sample cleanup to reverse creates/createMany batches and restore the exact 10,000-record cardinality before the next sample; validate the reset checksum before timing resumes.
- Extend benchmark modules with an explicit asynchronous teardown contract. The runner invokes teardown in a `finally` path, closes every captured database, and runs high-memory scaling sizes in isolated processes.
- Split declarative filters from function-predicate compatibility cases; both remain required, but their costs are attributed separately. Re-measure all starting ratios with the permanent direct-core versus Rust/Effect pairing.
- Compute percentiles from sorted raw latency samples rather than interpolating p75/p99. Auto-scale each engine/case measurement window until it has at least 30 measured samples, with a bounded timeout that reports an insufficient-samples failure.
- Record paired per-case throughput and p50/p95/p99 latency, initialization, encoded payload/result sizes, boundary stage timing, callback counts, WASM linear-memory high-water mark, retained JS heap where available, compressed artifact size, and browser cold start.
- Compare behavior using the canonical decoded-value checksum defined in Key Technical Decisions, not JSON wire bytes.
- Use deterministic fixtures at 100, 1,000, and 10,000 records for blocking results. Run 100,000 records separately as stress-only evidence and capture its fresh-process peak plus repeated-workload high-water growth.
- Store the current pre-optimization WASM results as a comparison baseline and encode the fixed workload manifest plus final TypeScript ratios as the release contract.

**Execution note:** Characterize the current engines and make the benchmark tests fail on the agreed targets before changing runtime code.

**Patterns to follow:**
- Existing deterministic generators and JSON result formatting in `bench/generators.ts`, `bench/utils.ts`, and `bench/runner.ts`.
- Existing Chromium/Vite harness in `packages/browser/tests/browser-smoke.mjs`.

**Test scenarios:**
- Happy path: identical seed, schema, initial data, and operation sequence produce paired results for both engines with matching result checksums.
- Happy path: each required 10,000-record case is classified as read/query or write/transaction and evaluated against its own 2× or 5× threshold.
- Edge case: mutable create/delete suites keep collection cardinality within a fixed bound across warmup and measured iterations.
- Edge case: 100,000-record stress cases execute in isolated processes and do not affect blocking ratios.
- Error path: a task error, fewer than 30 samples, missing percentile data, missing engine result, or decoded-value checksum mismatch fails the run rather than being omitted from JSON output.
- Integration: module teardown runs after success and failure, releases database handles between suites, and does not reproduce the multi-gigabyte retained-handle growth seen by the first all-suite WASM run.
- Integration: real Chromium reports p95 wall-clock latency for the named normal interactions, not only Bun timing.

**Verification:**
- A clean checkout can produce one machine-readable paired report without source rewriting.
- The report pinpoints boundary, engine, callback, initialization, and memory costs and fails against the accepted budgets before optimization begins.

---

### U2. Optimize the WASM build and synchronous dispatch wrapper

**Goal:** Remove low-risk compiler, artifact, and Promise-wrapper overhead while preserving the Promise-first rejection contract.

**Requirements:** R3, R5, R8, R9

**Dependencies:** U1

**Files:**
- Modify: `crates/Cargo.toml`
- Modify: `flake.nix`
- Modify: `packages/engine/scripts/build-wasm.mjs`
- Modify: `packages/engine/src/database.ts`
- Modify: `packages/engine/src/loader.ts`
- Modify: `scripts/verify-package-artifacts.ts`
- Test: `packages/engine/tests/engine-u8.test.ts`
- Test: `packages/engine/tests/package-conformance.test.ts`
- Test: `packages/browser/tests/browser-entry.test.ts`

**Approach:**
- Add a WASM-specific production profile rather than changing native release behavior. Compare speed- and size-oriented optimization settings, LTO, codegen units, and abort behavior using U1 evidence.
- Pin the wasm32 Rust target, linker, matching wasm-bindgen CLI, Binaryen, and Chromium/Playwright inputs in the repository environment; remove ad hoc installer/version drift from clean-checkout gates.
- Run Binaryen only on post-bindgen browser and Node artifacts; retain a named profiling artifact separately from stripped production output.
- Replace the extra scheduled microtask around synchronous dispatch with immediate execution wrapped into an already-settled Promise, converting synchronous throws into Promise rejection so callers never observe a synchronous exception.
- Record final raw/compressed WASM size, compile/instantiate time, and runtime deltas; select the profile that satisfies runtime targets without crossing the size/startup budgets.

**Test scenarios:**
- Happy path: successful collection calls still return Promises and preserve asynchronous consumption semantics.
- Error path: malformed input and tagged engine errors reject the returned Promise and never throw before a Promise is returned.
- Edge case: a callback-triggered defect remains a distinct `WasmEngineDefectError` after wrapper changes.
- Integration: browser and Node artifacts are post-processed, load through their published subpaths, and match the pinned wasm-bindgen version.
- Integration: production artifacts omit profiling-only names while profiling builds remain readable in browser tooling.

**Verification:**
- U1 attributes the gain to build or wrapper changes, package artifact checks pass, and size/startup stay within R8.

---

### U3. Replace the string boundary with the fastest parity-safe transport

**Goal:** Reduce encode, copy, parse, and recursive sentinel costs enough for read/query cases to reach the 2× target without changing visible values.

**Requirements:** R1, R3, R5, R6, R7, R8, R9

**Dependencies:** U1, U2

**Files:**
- Modify: `crates/proseql-wasm/Cargo.toml`
- Modify: `crates/proseql-wasm/src/bridge.rs`
- Modify: `crates/proseql-wasm/src/runtime.rs`
- Modify: `crates/proseql-wasm/src/types.rs`
- Modify: `packages/engine/src/loader.ts`
- Modify: `packages/engine/src/browser-wasm.d.ts`
- Modify: `packages/engine/src/boundary-values.ts`
- Modify: `packages/engine/src/database.ts`
- Test: `crates/proseql-wasm/src/lib.rs`
- Test: `packages/engine/tests/boundary-values.test.ts`
- Test: `packages/engine/tests/engine-u8.test.ts`
- Test: `packages/browser/tests/browser-performance.test.ts`

**Approach:**
- Introduce one internal boundary-value representation capable of preserving explicit `undefined` before choosing how it is carried; `serde_json::Value` alone is not the parity contract.
- Instrument and compare three bounded candidates against representative single-record and 10,000-record results: a sentinel-aware JSON fast path, direct native JavaScript values through serde, and—only if needed—a byte-buffer response for large arrays.
- Apply the selected codec consistently to command inputs/responses, watch payloads, lifecycle/computed/operator callbacks, migrations, and errors; no secondary string-only callback boundary remains accidentally unmeasured.
- Preserve the existing bridge response categories and panic-to-defect containment independently of transport.
- Preserve collision-free recursive `undefined`, `null`, missing fields, reserved sentinel-shaped user objects, Unicode, non-finite rejection, large numbers within the supported contract, and exact error payloads.
- Keep the old and candidate paths available only to tests during evaluation. Remove the losing path and benchmark selector before the unit is complete.
- If a byte buffer is required, confine it to bulk results, recreate typed-array views after every allocating call, and retain the ordinary value path for small commands; no view may outlive the dispatch that created it.

**Test scenarios:**
- Happy path: primitive, nested object, array, and large query results round-trip identically through every candidate during evaluation.
- Edge case: explicit `undefined`, missing keys, `null`, and user objects containing every reserved sentinel key remain distinguishable.
- Edge case: a WASM memory growth between two bulk calls cannot invalidate data already returned to JavaScript.
- Error path: serialization failure and panic become the same typed error/defect payload as before, without leaking a raw `JsValue` exception.
- Integration: watch callbacks, hooks, custom operators, migrations, and storage reload use the selected transport consistently.
- Performance: every required read/query case at 10,000 records reaches at least 50% of paired TypeScript throughput and applicable normal reads stay below 50 ms p95.

**Verification:**
- Production has one transport, all boundary conformance tests and parity reports remain exact, and R1/R3/R8 pass in Chromium and Bun.
- The U2 release-profile matrix is revalidated against the promoted U3 transport; any selected profile change is reflected in final size/startup evidence.

---

### U4. Collapse function-predicate bulk mutations into one engine command

**Goal:** Remove the one-WASM-write-per-match adapter behavior responsible for the largest bulk update/delete outliers.

**Requirements:** R2, R3, R5, R6, R9

**Dependencies:** U1

**Files:**
- Modify: `packages/effect/src/database.ts`
- Modify: `packages/engine/src/database.ts`
- Test: `packages/effect/tests/effect.test.ts`
- Test: `packages/effect/tests/transaction-contract.test.ts`
- Test: `packages/engine/tests/engine-u8.test.ts`
- Test: `bench/crud.bench.ts`

**Approach:**
- Mirror the existing relationship-delete compatibility pattern: query once, evaluate the scalar predicate in JavaScript in stable collection order, apply limit semantics, and issue one declarative ID-set `updateMany` or `deleteMany` command.
- Keep predicate exceptions in the Effect error/defect channel exactly as before and perform no write when predicate evaluation fails.
- Preserve returned entity ordering, soft-delete behavior, hooks, timestamps, validation, and atomic failure behavior by letting the Rust bulk operation remain authoritative.
- Apply the same path inside transaction facades without introducing an implicit nested transaction.

**Test scenarios:**
- Happy path: a function predicate matching approximately 100 of 10,000 rows causes one query and one bulk mutation while returning the same count/entities as TypeScript.
- Edge case: predicates matching zero or all records, explicit limits, soft deletes, and stable result ordering match existing behavior.
- Error path: a predicate throwing midway performs no writes and surfaces the same failure classification.
- Error path: validation, uniqueness, foreign-key, or hook failure leaves the bulk mutation in its current atomic/partial state.
- Integration: the path works both outside and inside `$transaction`, with persistence scheduled once and watch delivery deduplicated.
- Performance: required function-predicate update/delete cases reach at least 20% of paired TypeScript throughput and stay below 50 ms p95.

**Verification:**
- Benchmark command counts prove per-row dispatch is gone; behavior and type parity remain green. Pre-U3 ratios are diagnostic because transport may still dominate; the binding R2 decision is made after U3–U6 are combined.

---

### U5. Make Rust mutation bookkeeping proportional to the change

**Goal:** Remove whole-collection index, rollback, and reactive cloning from ordinary writes while preserving exact mutation semantics.

**Requirements:** R2, R3, R6, R9

**Dependencies:** U1

**Files:**
- Modify: `crates/proseql-engine/src/collection.rs`
- Modify: `crates/proseql-engine/src/query/indexes.rs`
- Modify: `crates/proseql-engine/src/query/search.rs`
- Modify: `crates/proseql-engine/src/relationships/mod.rs`
- Modify: `crates/proseql-engine/src/relationships/helpers.rs`
- Modify: `crates/proseql-engine/src/reactive/mod.rs`
- Test: `crates/proseql-engine/tests/crud_conformance.rs`
- Test: `crates/proseql-engine/tests/query_conformance.rs`
- Test: `crates/proseql-engine/tests/relationship_conformance.rs`
- Test: `crates/proseql-engine/tests/reactive_conformance.rs`
- Test: `bench/crud.bench.ts`

**Approach:**
- Introduce the shared change-set contract first. Every state primitive records collection, entity before/after image, insertion position, and index/reactive delta; `patch_raw` and `delete_raw` used by cascades participate exactly like normal replacements/removals.
- Give query indexes delta operations for insert, replace, and remove while retaining a full rebuild for trusted loads, recovery, restore-state, and assertion checks. Batch operations apply all state changes and then their index deltas without rebuilding unrelated entries.
- Replace whole-collection rollback snapshots on single/bulk relationship-aware mutations with before-images for affected entities and explicit restoration of insertion position when required.
- Track collection revision/change information directly rather than discovering ordinary mutations by deep snapshot comparison. Retain `TransactionContext::run_mutation`'s existing per-step snapshots until U6 replaces them with the shared journal; U5 must not create an interval where changed collections are untracked.
- Synchronize only changed reactive collections. Avoid maintaining cloned snapshots when no subscription requires them; establish the current snapshot when a watch is acquired and update it by deltas thereafter.
- Keep validation/decode, unique checks, callback timing, search tokenization, index ordering, timestamp behavior, and partial relationship artifacts unchanged.

**Test scenarios:**
- Happy path: create/update/delete and every batch variant update equality, compound, and search indexes incrementally and queries return the same ordered rows as a forced rebuild.
- Edge case: changing an indexed value removes the old posting and adds the new posting; unchanged values do not duplicate postings.
- Edge case: deleting then recreating an entity preserves the TypeScript insertion-order artifact expected by each operation.
- Edge case: cascade hard-delete through `delete_raw` removes every equality/search posting; cascade soft patch through `patch_raw` replaces affected postings without stale indexed results.
- Error path: validation, uniqueness, FK, and hook failures restore affected entities and indexes without restoring partial side effects that currently survive.
- Integration: writes with no subscriptions avoid reactive snapshot cloning; acquiring a watch later emits the complete immediate snapshot; subscribed writes still deduplicate and debounce correctly.
- Integration: reload, migration, and rollback paths may use full rebuilds and produce the same final indexes as incremental operations.
- Performance: required single and declarative bulk writes reach the 5× target at 10,000 records without weakening checks.

**Verification:**
- Differential tests compare incremental indexes/reactive state with canonical rebuilds. Rust-side and command-count gains are visible after U5; final binding R2/R3 is evaluated after U3–U6 combine.

---

### U6. Move transactions into stateful WASM sessions with undo journaling

**Goal:** Preserve arbitrary asynchronous transaction callbacks while eliminating full-database transfers, temporary database handles, and per-operation deep snapshots.

**Requirements:** R2, R3, R5, R6, R8, R9

**Dependencies:** U3, U4, U5

**Files:**
- Modify: `crates/proseql-engine/src/transactions/mod.rs`
- Modify: `crates/proseql-engine/src/relationships/mod.rs`
- Modify: `crates/proseql-wasm/src/runtime.rs`
- Modify: `crates/proseql-wasm/src/command.rs`
- Modify: `crates/proseql-wasm/src/types.rs`
- Modify: `packages/engine/src/loader.ts`
- Modify: `packages/engine/src/database.ts`
- Modify: `packages/effect/src/database.ts`
- Test: `crates/proseql-engine/tests/transactions_conformance.rs`
- Test: `crates/proseql-wasm/src/lib.rs`
- Test: `packages/engine/tests/engine-u8.test.ts`
- Test: `packages/effect/tests/transaction-contract.test.ts`
- Test: `bench/transactions.bench.ts`

**Approach:**
- Add internal begin/step/commit/rollback sessions keyed by an opaque handle. The session is owned runtime state rather than the existing borrowed `TransactionContext<'a>`, which cannot survive across asynchronous JavaScript turns. Enforce the existing single-writer/nested-transaction guard throughout the session.
- Extend U5's change sets into a journal of low-level sub-mutations. Each entry records its own collection, entity before-image, insertion position, and reversible index delta, including relationship target collections touched through trusted raw helpers.
- Preserve operation-level partial artifacts: an operation that returns a Restrict/FK error does not automatically replay successful earlier sub-mutations when current semantics leave them visible; an eventual transaction rollback replays every session entry in reverse. The touched-collection set is the union of all journal entries, including net-zero and relationship-target writes.
- Replace both the transaction-start full snapshot and `run_mutation`'s per-operation full snapshots. Rollback replays entity and index deltas; commit discards the journal after validation and schedules persistence once per touched collection.
- Route transaction-facade reads and writes directly to the active session. Remove the `dumpAll` → temporary database → `dumpAll` → `commitSnapshotTransaction` path from normal transactions.
- Preserve immediate defaults, generators, before/after/onChange hooks, swallowed post-hook failures, arbitrary Effect failures, manual commit/rollback guards, and the collection-level `Update` event emitted for every touched collection at commit.
- Keep the reactive hub on its pre-session snapshot during individual steps. Commit synchronizes touched collections once before event delivery; rollback synchronizes after journal replay and emits no events, so external watches never observe intermediate state.
- Queue background reload and every debounced persistence lane behind the active transaction; a timer firing mid-session must not read partial state. `close()` stops new work, waits for the transaction callback to settle, then flushes and drops.
- Give the Effect adapter a scope/interruption finalizer so every opened session commits or rolls back and releases exactly once, including callback defects, interruption, abandoned Promises, manual finalization, and close races.

**Test scenarios:**
- Happy path: an async callback creates, reads its write, awaits an external Promise/Effect, updates, deletes, and commits with one persistence schedule and one collection-level change notification.
- Happy path: transactions spanning related collections journal and commit every touched entity while preserving relationship mutation order.
- Edge case: manual commit or rollback makes the context inactive; a second call returns the canonical guard error.
- Edge case: nested/concurrent transaction attempts fail with current `TransactionError` payloads.
- Error path: callback failure, explicit rollback, validation/FK/hook failure, interruption, and close during an active callback restore all journaled database state and indexes while preserving external hook side effects already emitted.
- Error path: a caught Restrict/FK operation failure may still commit documented earlier cascade/set-null artifacts; a later full transaction rollback restores those same artifacts across every touched target collection.
- Integration: a debounce timer firing 100 ms into a 200 ms transaction callback cannot persist partial session state; storage reload also waits, and close drains transaction plus persistence work safely.
- Integration: relationship operations derive commit persistence/events from journal-touched owner and target collections rather than the Effect facade's owner-only bookkeeping.
- Performance: the three-operation transaction reaches at least 20% of paired TypeScript throughput and stays below 50 ms p95 at 10,000 records.

**Verification:**
- No full database crosses the boundary during `$transaction`; no borrowed transaction context is stored across turns; temporary database handles and per-step snapshots are absent; rollback differential tests and R2/R3 pass.

---

### U7. Batch callback-heavy evaluation only when measurements require it

**Goal:** Meet callback-bearing browser budgets without changing user callback signatures or observable invocation order.

**Requirements:** R3, R5, R6, R9

**Dependencies:** U3, U6

**Files:**
- Modify: `crates/proseql-engine/src/callbacks.rs`
- Modify: `crates/proseql-engine/src/query/pipeline.rs`
- Modify: `crates/proseql-engine/src/query/sort.rs`
- Modify: `crates/proseql-wasm/src/callbacks.rs`
- Modify: `packages/engine/src/database.ts`
- Test: `crates/proseql-engine/tests/query_conformance.rs`
- Test: `crates/proseql-wasm/src/lib.rs`
- Test: `packages/engine/tests/engine-u8.test.ts`
- Test: `bench/query-pipeline.bench.ts`

**Approach:**
- First characterize computed fields, custom predicates/operators, collators, and lifecycle hooks separately. Skip production changes when they are not blocking stated budgets.
- Where batching is required, register an internal array-oriented wrapper that invokes the existing scalar user callback sequentially in JavaScript and returns ordered results in one bridge exchange.
- Restrict batching to stages whose complete inputs are known without changing inter-item state: computed projections and pure query predicates first. Do not batch lifecycle hooks when earlier hook transformations or side effects affect later items.
- Preserve exception position, callback count/order, locale collation, computed/select/populate order, and typed hook/operator failures.

**Execution note:** This unit is conditional. Record a no-change verification outcome when post-U6 callback scenarios already meet their characterized budgets; that verified no-op satisfies U7's dependency edge into U8.

**Test scenarios:**
- Happy path: batched computed/predicate evaluation returns the same values and invokes the user callback in stable row order.
- Edge case: callbacks returning `undefined`, sentinel-shaped objects, or mixed result types preserve exact values.
- Error path: the first throwing callback stops at the same row and surfaces the same typed failure/defect as scalar execution.
- Integration: selection, population, sorting, pagination, and watches observe the same computed-field order after batching.
- Integration: locale collator behavior remains identical; no bytewise fallback is used in parity benchmarks.
- Performance: representative callback-bearing query results improve without causing any required core benchmark to regress past its target.

**Verification:**
- Callback traces are byte-for-byte/order equivalent to scalar mode, or the unit documents that no production batching was needed.

---

### U8. Enforce browser performance and parity in CI

**Goal:** Turn the achieved performance, memory, bundle, startup, and correctness targets into durable release gates and documentation.

**Requirements:** R1–R10

**Dependencies:** U2, U3, U4, U5, U6, U7

**Files:**
- Modify: `justfile`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `scripts/verify-package-artifacts.ts`
- Create: `bench/reports/README.md`
- Create: `packages/browser/tests/browser-performance.mjs`
- Test: `bench/performance-contract.test.ts`
- Test: `packages/browser/tests/browser-performance.test.ts`
- Modify: `packages/engine/README.md`
- Modify: `packages/browser/README.md`

**Approach:**
- Add the `wasm-performance-gate` recipe named by plan frontmatter. It builds optimized WASM from the pinned repository toolchain, runs Rust and package correctness checks, executes three interleaved paired benchmark trials with at least 30 raw samples per engine for each blocking case, validates the fixed workload manifest and per-case ratios, and runs the real-Chromium interaction budget.
- Isolate suites/processes so handles and WASM linear memory from one workload cannot contaminate another. Treat task errors, missing measurements, checksum differences, or xpasses/xfails that change unexpectedly as gate failures.
- Upload paired JSON, browser timing, memory, artifact-size, and parity reports on every CI result. Keep npm/package publishing absent.
- Document the target dataset, required cases, stress-only cases, hardware/runner caveats, baseline-update policy, and how to investigate a regression.
- Verify production package graphs still contain no Node built-ins on browser entrypoints and only the chosen transport artifacts ship.

**Test scenarios:**
- Happy path: three noisy paired trials use their median and empirically computed percentiles, passing when every required read/query case is within 2×, every required write/transaction case is within 5×, and normal interaction p95 is below 50 ms.
- Edge case: a 100,000-record stress slowdown is reported but does not fail unless it crashes, leaks handles, or grows memory without bound.
- Error path: one catastrophically slow case cannot be hidden by a passing geometric mean.
- Error path: missing browser results, artifact size regression, startup regression, memory leak, parity mismatch, or benchmark task failure blocks the gate.
- Integration: CI runs Cargo tests/fmt/Clippy/WASM target checks, package tests/typechecks/artifact verification, parity corpus, and Chromium performance in the intended dependency order.

**Verification:**
- The complete gate passes from a clean checkout; reports prove every requirement; package publishing remains disabled.

---

## System-Wide Impact

- **Interaction graph:** Public TypeScript/Effect calls still enter the same database facade, but the internal transport, mutation deltas, transaction lifecycle, reactive snapshots, persistence scheduling, and callback grouping all participate in performance. The benchmark layer observes each seam separately.
- **Error propagation:** Transport changes must reconstruct the same tagged errors; panic containment remains at the Rust boundary; predicate and callback failures stay in their current Effect failure/defect channels; transaction session failures always roll back and release the session.
- **State lifecycle risks:** The shared change-set/journal must see trusted raw relationship helpers as well as ordinary CRUD, reverse entity and index deltas together, retain documented operation-level partial artifacts, and derive touched collections from every sub-mutation. Reactive hubs stay pre-session until one commit sync; persistence/reload/close wait behind the session. Missing any seam can corrupt state or expose an intermediate transaction.
- **API surface parity:** `@proseql/engine`, `@proseql/effect`, and `@proseql/browser` retain signatures and inference. The WASM ABI is internal and may evolve only with synchronized Rust, loader, browser declaration, and package-artifact changes.
- **Integration coverage:** Unit tests cannot prove browser TextEncoder/serde/JsValue performance, WASM memory growth, IndexedDB interaction, callback reentry timing, or Vite/plain-module artifact loading; real Chromium remains required.
- **Unchanged invariants:** TypeScript types remain single-sourced in `@proseql/core`; persisted formats and bytes remain compatible; insertion order and stable sorting remain observable; no Node imports enter browser graphs; no registry publication resumes.

---

## Dependencies / Prerequisites

- The completed Rust engine, WASM binding, Effect adapter, browser storage hosts, and phase-two parity reports on `main`.
- A browser-capable CI environment with Chromium and the current Vite/plain-module smoke fixtures.
- Pinned wasm-bindgen crate and CLI versions; any serde or Binaryen addition must be reproducible through Nix and package builds.
- The pre-optimization paired report produced by U1 and the accepted 2×/5×/50 ms targets in this plan.

---

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|---|---:|---:|---|
| Boundary transport changes `undefined`, `null`, missing, or tagged errors | High | High | Candidate parity matrix, reserved-key collision fixtures, one promoted production path, full corpus gate |
| Undo journal misses a relationship or batch side effect | Medium | High | Instrument mutation primitives, reverse-order differential rollback tests, complex cascade/connect scenarios |
| Incremental indexes drift from canonical rebuilds | Medium | High | Differential assertions after randomized mutation sequences and forced-rebuild comparison |
| Performance CI is noisy on shared runners | High | Medium | Interleaved paired trials, at least 30 raw samples per case, empirical percentiles, median ratios, and separate warm-throughput/cold-start gates |
| Benchmark fixtures drift in size or leak handles | High | High | Untimed exact-state cleanup, module teardown in `finally`, isolated stress processes, canonical decoded-value checksums |
| Compiler size optimization hurts runtime | Medium | Medium | Benchmark profile matrix; select from runtime, compressed size, and startup together |
| Direct JsValue serde is slower than native JSON for wide objects | Medium | Medium | Bounded candidate measurement; retain optimized JSON if it wins |
| Large-result byte views become stale after WASM memory growth | Medium | High | Use only if required; dispatch-scoped views; recreate views after allocation; memory-growth tests |
| Stateful async transaction blocks reload/close indefinitely | Low | High | Owned session state, Effect interruption finalizer, exactly-once rollback/release, queued persistence/reload, close coordination tests |
| Raw cascade helpers bypass journal or index deltas | Medium | High | Shared low-level change-set seam, owner/target collection differential rollback, forced-rebuild index comparison |
| Callback batching changes side-effect order | Medium | High | Restrict to pure evaluation stages and compare scalar callback traces exactly |
| Scope expands into a new binary protocol or query engine | Medium | Medium | Promote the simplest transport meeting targets; defer columnar/worker/DSL work |

---

## Success Metrics

- All required 10,000-record read/query cases individually achieve Rust/WASM throughput ≥50% of paired TypeScript.
- All required 10,000-record write/transaction cases individually achieve Rust/WASM throughput ≥20% of paired TypeScript.
- Named normal interactions complete below 50 ms p95 in real Chromium.
- The 100,000-record stress suite completes without crash or retained handles; fresh-process peak stays within 110% of its U1 baseline and repeated-workload WASM high-water growth stays within 5% after the first run.
- Production compressed WASM size grows no more than 5%, cold startup p95 no more than 10%, fresh-process WASM peak no more than 5%, and post-GC retained JS heap no more than 5% against U1 baseline where measurable.
- The 79 applicable corpus files remain 100% passing with zero xfails; 2,353 assertions or their intentionally expanded successor all pass.
- Rust tests, formatting, Clippy, wasm32 checks, Node/Bun tests, package verification, and browser persistence/reactivity tests remain green.
- The production browser graph contains one Rust/WASM engine transport and no TypeScript runtime fallback.

---

## Alternative Approaches Considered

- **Keep TypeScript as the browser default:** rejected because it permanently creates two engines and doubles semantic maintenance; the confirmed goal is one Rust/WASM browser engine.
- **Add napi-rs:** not applicable to browsers and does not address the browser target.
- **Compiler flags only:** useful but insufficient against 27–1,087× hot-path gaps caused by boundary fan-out and state copying.
- **Upfront transaction operation batching:** rejected because transaction callbacks may await arbitrary Effects and branch on prior operation results.
- **SharedArrayBuffer/worker engine:** potentially valuable for main-thread responsiveness but would impose deployment headers and a new concurrency model; excluded from this target.
- **Immediately adopt a custom binary protocol:** rejected as the first move because official guidance shows native JSON may outperform field-by-field serde in some browsers. Measure bounded candidates first.
- **Relax parity or skip validation:** rejected because semantic equivalence is the engine's primary contract.

---

## Documentation / Operational Notes

- Performance reports must identify browser/runtime version, CPU environment, artifact hash, dataset, indexes, callbacks, trial count, and whether a result is blocking or stress-only.
- Baselines update only with reviewed evidence explaining an intentional threshold or fixture change; an optimization may improve the stored pre-optimization comparison without weakening the TypeScript-relative contract.
- Keep profiling and production artifacts distinct so function names aid investigation without inflating shipped WASM.
- Package publishing remains disabled; this plan changes CI verification only.

---

## Sources & References

- Related conversion plan: `work/items/active/01KYR2GFF49SRGMH4Q9MV1F2TS-rust-engine-conversion/plan.md`
- Current boundary: `packages/engine/src/boundary-values.ts`, `crates/proseql-wasm/src/bridge.rs`
- Current transaction paths: `packages/engine/src/database.ts`, `crates/proseql-engine/src/transactions/mod.rs`
- Current benchmarks: `bench/runner.ts`, `bench/crud.bench.ts`, `bench/transactions.bench.ts`
- wasm-bindgen serde guidance: https://wasm-bindgen.github.io/wasm-bindgen/reference/arbitrary-data-with-serde.html
- wasm-bindgen string ABI: https://rustwasm.github.io/docs/wasm-bindgen/reference/types/str.html
- serde-wasm-bindgen: https://docs.rs/serde-wasm-bindgen/latest/serde_wasm_bindgen/
- Cargo profiles: https://doc.rust-lang.org/cargo/reference/profiles.html
- Binaryen optimization: https://rustwasm.github.io/docs/wasm-bindgen/reference/optimize-size.html
- Chrome Memory Inspector: https://developer.chrome.com/docs/devtools/memory-inspector
