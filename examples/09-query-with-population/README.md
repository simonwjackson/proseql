# Query with Population

Demonstrates the Stream-based query pipeline with filtering, sorting, pagination, field selection, and relationship population.

## Features

- Filter queries with where clauses including complex operators like `$or` and `$startsWith`
- Sort results by one or more fields in ascending or descending order
- Paginate results using limit and offset
- Select specific fields to return using array syntax
- Populate ref relationships to resolve foreign key references
- Populate inverse relationships to fetch related collections
- Nested population for multi-level relationship resolution

## Run

```sh
bun run examples/09-query-with-population/index.ts
```

## Key Concepts

Queries return Effect streams that can be consumed with `.runPromise` for convenience or `Stream.runCollect` for Effect-native code. Relationships are defined in the config with `type: "ref"` for foreign key lookups or `type: "inverse"` for reverse lookups. The `populate` option resolves relationships and injects them into the result, supporting nested population like `{ author: { company: true } }` to traverse multiple levels.
