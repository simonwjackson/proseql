# Filtering and Selection

Demonstrates all query operators using the database API including comparison, string matching, set operators, array operators, logical operators, field selection, and multi-field sorting.

## Features

- Comparison operators: $eq (implicit), $ne, $gt, $gte, $lt, $lte
- String operators: $startsWith, $endsWith, $contains
- Set operators: $in, $nin
- Array operators: $contains, $all, $size
- Logical operators: $or, $and, $not (with nested conditions)
- Field selection for partial document retrieval
- Multi-field sorting with mixed ascending/descending order

## Run

```sh
bun run examples/02-filtering-and-selection/index.ts
```

## Key Concepts

This example demonstrates the full query API surface for filtering and selecting data. Comparison operators work on numeric fields, string operators provide pattern matching capabilities, and array operators enable querying collections. Logical operators can be nested to build complex queries. The select option returns partial documents containing only specified fields, and multi-field sorting allows ordering by multiple criteria with independent sort directions.
