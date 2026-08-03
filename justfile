#!/usr/bin/env just --justfile

# Default command - show available commands
[private]
default:
    @just --list

# Test Korri-ready foundation paths (accepts optional args)
test *args:
    bun test \
        ./bench/runner.test.ts \
        ./packages/engine/tests/loader.test.ts \
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
    bunx tsc --build

# Verify npm packages include required built artifacts and browser smoke coverage
verify-packages:
    bun run verify:packages

# Run the real-browser smoke suite against the built browser packages
browser-smoke:
    bun run verify:browser

# Run the first U9 parity corpus slice and emit a machine-readable report
parity-corpus:
    bun run packages/effect/scripts/run-corpus.mjs

# Run examples 01-16 where compatible and emit a machine-readable report
parity-examples:
    bun run packages/effect/scripts/run-examples.mjs

# Run the U9 parity gate end-to-end
parity-gate:
    bunx tsc --build
    (cd packages/effect && bun run typecheck:tests)
    bun test packages/effect/tests/
    bun run packages/effect/scripts/run-corpus.mjs
    bun run packages/effect/scripts/run-examples.mjs
    bun run packages/effect/scripts/validate-parity-reports.mjs

# Lint Korri-ready foundation paths
lint:
    biome check \
        packages/core/src \
        packages/node/src \
        packages/rest/src \
        package.json \
        packages/core/package.json \
        packages/node/package.json \
        packages/rest/package.json \
        tsconfig.json \
        tsconfig.base.json \
        justfile

# Format
format:
    biome format --write .

# Clean
clean:
    rm -rf packages/*/dist packages/*/*.tsbuildinfo *.tsbuildinfo dist/**/*.tsbuildinfo

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

# Build a release artifact for the Rust engine
rust-build:
    cargo build --release --manifest-path crates/Cargo.toml
