# Ledger Format (.ledger)

## Status: Placeholder

## Overview

A stanza-based text format inspired by plain-text accounting (Ledger, hledger, Beancount). Each record is a visual "card" — a header line followed by indented field lines, separated by blank lines.

## Concept

```
book #1 "Dune"
  author    Frank Herbert
  year      1965
  genre     sci-fi

book #2 "Neuromancer"
  author    William Gibson
  year      1984
  genre     sci-fi
```

- Header line: collection type, ID, and a display field (e.g., title)
- Indented lines: field-value pairs with whitespace alignment
- Blank lines separate records
- Types are inferred from the schema (no inline type annotations)
- Diffs read naturally — changes are scoped to individual field lines within a stanza

## Key Design Questions

- How is the header line structured? Which field is "promoted" to the header?
- How are nested objects and arrays represented in the indented body?
- Should alignment be enforced or cosmetic?
- How are multi-line string values handled?
- What happens when the collection type name differs from the file context?

## Relationship to FormatCodec

Implements `FormatCodec` with extensions `["ledger"]`. The collection type name in the header line is cosmetic — the actual collection binding comes from the database config's `file` field.
