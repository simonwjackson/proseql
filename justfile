#!/usr/bin/env just --justfile

# Default command - show available commands
[private]
default:
    @just --list

# Test all packages (accepts optional args)
test *args:
    bun test packages/*/tests/ {{args}}

# Test core package only
test-core:
    bun test packages/core/tests/

# Test node package only
test-node:
    bun test packages/node/tests/

# Type check
typecheck:
    bunx tsc --build

# Lint
lint:
    biome check .

# Format
format:
    biome format --write .

# Clean
clean:
    rm -rf packages/*/dist packages/*/.tsbuildinfo
