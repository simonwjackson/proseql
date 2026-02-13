# Update Operators

Demonstrates atomic, type-safe mutation operators for numeric fields, strings, arrays, and booleans.

## Features

- Number operators: $increment, $decrement, $multiply
- String operators: $append (suffix), $prepend (prefix)
- Array operators: $append (push), $prepend (unshift), $remove (filter)
- Boolean operators: $toggle (flip boolean state)
- Explicit $set for direct value assignment
- Combining multiple operators in a single update

## Run

```sh
bun run examples/update-operators/index.ts
```

## Key Concepts

Update operators provide atomic mutations without requiring read-modify-write cycles. Each operator is type-safe and operates on the appropriate field type. String and array types both support $append and $prepend with different semantics. Multiple operators can be combined in a single update call to modify different fields atomically. The $toggle operator flips boolean values, making it useful for feature flags and state management.
