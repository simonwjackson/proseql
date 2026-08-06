#!/usr/bin/env just --justfile

# Default command - show available commands
[private]
default:
    @just --list

# Test Korri-ready foundation paths (accepts optional args)
test *args:
    bun test \
        ./bench/runner.test.ts \
        ./packages/engine/tests/boundary-values.test.ts \
        ./packages/engine/tests/browser-entry.test.ts \
        ./packages/engine/tests/browser-persistence-concurrency.test.ts \
        ./packages/engine/tests/engine-u8.test.ts \
        ./packages/engine/tests/engine.test.ts \
        ./packages/engine/tests/loader.test.ts \
        ./packages/engine/tests/materialized-projection.test.ts \
        ./packages/effect/tests/effect.test.ts \
        ./packages/browser/tests/browser-entry.test.ts \
        ./packages/rpc/tests/rpc-group.test.ts \
        ./packages/rpc/tests/rpc-handlers.test.ts \
        ./packages/rpc/tests/rpc-streaming.test.ts \
        ./packages/rpc/tests/multi-collection-namespacing.test.ts \
        ./packages/rpc/tests/rpc-wire-contract.test.ts \
        ./scripts/verify-package-artifacts.test.ts \
        ./scripts/verify-packed-packages.test.ts \
        ./scripts/release-check-wiring.test.ts \
        packages/core/tests/database-effect.test.ts \
        packages/core/tests/database-source-config.test.ts \
        packages/core/tests/database-document-graph.test.ts \
        packages/core/tests/debounced-writer.test.ts \
        packages/core/tests/deep-merge.test.ts \
        packages/core/tests/derived-id.test.ts \
        packages/core/tests/document-graph-config.test.ts \
        packages/core/tests/document-graph-source.test.ts \
        packages/core/tests/file-watcher.test.ts \
        packages/core/tests/glob-match.test.ts \
        packages/core/tests/infer-codecs.test.ts \
        packages/core/tests/schema-validation.test.ts \
        packages/core/tests/schema-migrations.test.ts \
        packages/core/tests/serializer-service.test.ts \
        packages/core/tests/source-config.test.ts \
        packages/core/tests/transactions.test.ts \
        packages/node/tests/convenience.test.ts \
        packages/node/tests/derived-id-convenience.test.ts \
        packages/node/tests/document-graph.test.ts \
        packages/rest/tests/handlers.test.ts \
        packages/cli/tests/ \
        {{args}}

# Test core package only
test-core:
    bun test packages/core/tests/

# Test node package only
test-node:
    bun test packages/node/tests/

# Test effect adapter package only
test-effect:
    bun test packages/effect/tests/

# Test with coverage for all packages
coverage:
    bun test --coverage packages/*/tests/

# Test with coverage for core package only
coverage-core:
    bun test --coverage packages/core/tests/

# Test with coverage for node package only
coverage-node:
    bun test --coverage packages/node/tests/

# Type check
typecheck:
    bun run tsc --build

# Verify npm packages include required built artifacts and browser smoke coverage
verify-packages:
    bun run verify:packages

# Run the real-browser smoke suite against the built browser packages
browser-smoke:
    bun run verify:browser

# Capture and enforce fresh Chromium startup, memory, interaction, and WASM artifact budgets
browser-budget:
    rm -rf .artifacts/browser
    mkdir -p .artifacts/browser
    bun run bench/browser-runner.ts > .artifacts/browser/current.json
    bun run scripts/verify-package-artifacts.ts --u2-browser-budget-gate --current-report .artifacts/browser/current.json --output .artifacts/browser/evidence.json

# Run the first U9 parity corpus slice and emit a machine-readable report
parity-corpus:
    bun run packages/effect/scripts/run-corpus.mjs

# Run examples 01-16 where compatible and emit a machine-readable report
parity-examples:
    bun run packages/effect/scripts/run-examples.mjs

# Run the U9 parity gate end-to-end
parity-gate:
    bun run tsc --build
    (cd packages/effect && bun run typecheck:tests)
    bun test packages/effect/tests/
    bun run packages/effect/scripts/run-corpus.mjs
    bun run packages/effect/scripts/run-examples.mjs
    bun run packages/effect/scripts/validate-parity-reports.mjs

# Lint and format-check every coordinated release source, script, and manifest
lint:
    biome check --config-path=./biome.json \
        packages/{core,engine,node,rest,effect,cli,browser,rpc}/src \
        packages/{engine,effect}/scripts \
        scripts \
        package.json \
        packages/{core,engine,node,rest,effect,cli,browser,rpc}/package.json \
        packages/{core,engine,node,rest,effect,cli,browser,rpc}/tsconfig.json \
        tsconfig.json \
        tsconfig.base.json \
        biome.json \
        justfile \
        .github/workflows/ci.yml

# Format
format:
    biome format --write .

# Clean
clean:
    rm -rf packages/*/dist packages/*/*.tsbuildinfo *.tsbuildinfo dist/**/*.tsbuildinfo

# Build the publishable TypeScript packages and pinned production/profile WASM artifacts from clean source
build-release-artifacts:
    just clean
    bun run copy-license
    bun run --cwd packages/engine build:wasm
    bun run tsc --build
    chmod +x packages/cli/dist/main.js

# Non-destructive release readiness: never publishes, pushes, tags, or requires npm credentials
release-check:
    bun install --frozen-lockfile --ignore-scripts
    just lint
    just build-release-artifacts
    just typecheck
    just test
    just rust-format-check
    just rust-check
    just rust-test
    just rust-lint
    just rust-wasm-check
    just parity-gate
    rm -rf .artifacts/release-check
    mkdir -p .artifacts/release-check
    bun run scripts/verify-packed-packages.ts --skip-build --output .artifacts/release-check
    just browser-smoke
    just browser-budget

# Release a new version (auto-detects bump type, or pass patch/minor/major)
release *bump:
    bun run scripts/release.ts {{bump}}

# ── Rust engine (crates/) ────────────────────────────────────────────────────

# Type-check the Rust engine workspace
rust-check:
    cargo check --manifest-path crates/Cargo.toml

# Run the Rust engine test suite (includes conformance fixtures)
rust-test *args:
    cargo test --manifest-path crates/Cargo.toml {{args}}

# Lint the Rust engine workspace (Clippy)
rust-lint:
    cargo clippy --manifest-path crates/Cargo.toml --all-targets -- -D warnings

# Format the Rust engine workspace
rust-format:
    cargo fmt --manifest-path crates/Cargo.toml

# Verify Rust formatting without modifying source
rust-format-check:
    cargo fmt --manifest-path crates/Cargo.toml --all --check

# Check the WASM boundary crate for its production target
rust-wasm-check:
    cargo check --manifest-path crates/Cargo.toml -p proseql-wasm --target wasm32-unknown-unknown

# Build a release artifact for the Rust engine
rust-build:
    cargo build --release --manifest-path crates/Cargo.toml
