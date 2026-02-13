# Aggregation

Demonstrates scalar aggregation operations (count, sum, min, max, avg), filtered aggregation with where clauses, and groupBy for categorical analysis.

## Features

- Scalar aggregation: count, sum, min, max, avg
- Filtered aggregation with where clauses
- GroupBy for categorical breakdowns
- Combining groupBy with count, sum, and avg
- Multiple aggregation metrics in a single query

## Run

```sh
bun run examples/aggregation/index.ts
```

## Key Concepts

Aggregation operations compute summary statistics across collections. Scalar aggregation returns a single result object with requested metrics. The where option filters records before aggregation, enabling conditional statistics. GroupBy partitions data by field values and computes metrics for each group, returning an array of results. Multiple aggregation functions can be combined in a single query for efficient analysis.
