#!/usr/bin/env just --justfile

# Default command - show available commands
[private]
default:
    @just --list

# Test
test:
    bun test tests/*.test.ts

# Type check
typecheck:
    pnpm exec tsc --noEmit
    biome lint --max-diagnostics 1000

# Lint
lint:
    biome check .

# Format
format:
    biome format --write .

# Clean
clean:
    rm -rf dist .tsbuildinfo
