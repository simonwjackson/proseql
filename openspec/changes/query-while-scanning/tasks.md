# Query-while-scanning work

## 1. Track A — measured contract

- [x] Read #12, #13, the source brief and CLAUDE.md; record the exact base SHA, machine rules, unchanged semantics, measurement definitions and approval boundary.

## 2. Track B — Stage 0 harness (blocked by Track A)

- [ ] Add isolated Rust SQLite/scanner/native harnesses, deterministic month/hash fixtures, sparse indexes, exact duplicate checks, equivalence tests and one flake task; build and measure only on yari with bounded scopes and cold-cache evidence.

## 3. Track C — report and stop (blocked by Track B)

- [ ] Commit raw results and SQLite/native/scanner tables, measured floors, level-2 recommendation, architecture, stages 1–6 with effort/costs, hard semantics, Celeron limits and user decisions; clean owned yari data and stop without implementing production changes.

## 4. Track D — verification (blocked by Track B + C)

- [ ] Run focused tests, static checks, formatting and lint on yari, exercise the one-task real path, check production-source identity, review evidence limitations and report all remaining gaps to the parent; do not run the full combined suite or push.
